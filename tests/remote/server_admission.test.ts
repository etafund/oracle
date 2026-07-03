import { afterEach, describe, expect, test } from "vitest";
import http from "node:http";
import { spawnSync } from "node:child_process";
import { createRemoteServer, MAX_RUN_REQUEST_BODY_BYTES } from "../../src/remote/server.js";
import type { BrowserRunResult } from "../../src/browserMode.js";

// Admission-control contract for the remote serve endpoint (fault isolation
// for a single-lane worker):
// - request bodies are capped (413) and bounded in time (408) at the app
//   level, independent of any reverse-proxy tier in front;
// - a single `admitting` slot is held during body read + validation, and the
//   browser `busy` flag is only flipped after validation passes, so a refused
//   or aborted upload can never wedge the lane;
// - the admitting slot always releases: after any refusal the worker accepts
//   the next run.

const CAN_LISTEN_LOCALHOST =
  spawnSync(
    process.execPath,
    [
      "-e",
      `
      const net = require('net');
      const s = net.createServer();
      s.on('error', () => process.exit(1));
      s.listen(0, '127.0.0.1', () => s.close(() => process.exit(0)));
    `,
    ],
    { stdio: "ignore" },
  ).status === 0;

const MINIMAL_RESULT: BrowserRunResult = {
  answerText: "ok",
  answerMarkdown: "ok",
  tookMs: 1,
  answerTokens: 1,
  answerChars: 2,
};

function validPayload(): string {
  return JSON.stringify({
    prompt: "admission test",
    attachments: [],
    browserConfig: {},
    options: {},
  });
}

const savedMaxBodyEnv = process.env.ORACLE_SERVE_MAX_BODY_BYTES;

afterEach(() => {
  if (savedMaxBodyEnv === undefined) {
    delete process.env.ORACLE_SERVE_MAX_BODY_BYTES;
  } else {
    process.env.ORACLE_SERVE_MAX_BODY_BYTES = savedMaxBodyEnv;
  }
});

describe("remote server admission limits", () => {
  test("the default body cap is aligned with the router tier (100 MiB)", () => {
    expect(MAX_RUN_REQUEST_BODY_BYTES).toBe(100 * 1024 * 1024);
  });

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "ORACLE_SERVE_MAX_BODY_BYTES overrides the default body cap per worker",
    async () => {
      process.env.ORACLE_SERVE_MAX_BODY_BYTES = "2048";
      let runs = 0;
      const server = await createRemoteServer(
        { host: "127.0.0.1", port: 0, token: "secret", logger: () => {} },
        {
          runBrowser: async () => {
            runs += 1;
            return MINIMAL_RESULT;
          },
        },
      );

      try {
        const oversize = `{"prompt":"${"y".repeat(8192)}"}`;
        const refused = await sendRun(server.port, "secret", oversize);
        expect(refused.statusCode).toBe(413);
        expect(runs).toBe(0);

        const accepted = await sendRun(server.port, "secret", validPayload());
        expect(accepted.statusCode).toBe(200);
        expect(runs).toBe(1);
      } finally {
        await server.close();
      }
    },
  );

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "oversize request bodies are refused with 413 and busy is never flipped",
    async () => {
      let runs = 0;
      const server = await createRemoteServer(
        {
          host: "127.0.0.1",
          port: 0,
          token: "secret",
          logger: () => {},
          maxRunRequestBodyBytes: 1024,
        },
        {
          runBrowser: async () => {
            runs += 1;
            return MINIMAL_RESULT;
          },
        },
      );

      try {
        const oversize = `{"prompt":"${"x".repeat(4096)}"}`;
        const refused = await sendRun(server.port, "secret", oversize);
        expect(refused.statusCode).toBe(413);
        expect(refused.headers["x-oracle-run-id"]).toBeTruthy();
        const refusedBody = JSON.parse(refused.body) as Record<string, unknown>;
        expect(refusedBody.error).toBe("payload_too_large");
        expect(refusedBody.runId).toBe(refused.headers["x-oracle-run-id"]);
        expect(runs).toBe(0);

        // busy must never have flipped: health reports ready and the next
        // (valid) run is admitted immediately.
        const health = await getJson(server.port, "/health", "secret");
        expect(health.statusCode).toBe(200);
        expect(health.json?.busy).toBe(false);

        const accepted = await sendRun(server.port, "secret", validPayload());
        expect(accepted.statusCode).toBe(200);
        expect(runs).toBe(1);
      } finally {
        await server.close();
      }
    },
  );

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "slow request bodies are refused with 408 and the worker stays ready",
    async () => {
      let runs = 0;
      const server = await createRemoteServer(
        {
          host: "127.0.0.1",
          port: 0,
          token: "secret",
          logger: () => {},
          runBodyReadDeadlineMs: 150,
        },
        {
          runBrowser: async () => {
            runs += 1;
            return MINIMAL_RESULT;
          },
        },
      );

      try {
        const slow = openRunRequest(server.port, "secret", 65536);
        slow.req.write('{"prompt":"trickle'); // never finishes the body
        const refused = await slow.response;
        expect(refused.statusCode).toBe(408);
        expect(refused.headers["x-oracle-run-id"]).toBeTruthy();
        expect((JSON.parse(refused.body) as Record<string, unknown>).error).toBe(
          "request_timeout",
        );
        slow.req.destroy();
        expect(runs).toBe(0);

        const accepted = await sendRun(server.port, "secret", validPayload());
        expect(accepted.statusCode).toBe(200);
        expect(runs).toBe(1);
      } finally {
        await server.close();
      }
    },
  );

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "exactly one of two concurrent admissions proceeds; the other is refused 409",
    async () => {
      let runs = 0;
      const server = await createRemoteServer(
        { host: "127.0.0.1", port: 0, token: "secret", logger: () => {} },
        {
          runBrowser: async () => {
            runs += 1;
            return MINIMAL_RESULT;
          },
        },
      );

      try {
        const body = validPayload();
        // Request A starts uploading but stalls halfway, holding the
        // admitting slot without ever flipping busy.
        const a = openRunRequest(server.port, "secret", Buffer.byteLength(body));
        a.req.write(body.slice(0, 10));
        await delay(50);

        // Request B arrives complete while A is still admitting.
        const b = await sendRun(server.port, "secret", body);
        expect(b.statusCode).toBe(409);
        expect((JSON.parse(b.body) as Record<string, unknown>).error).toBe("busy");
        expect(b.headers["x-oracle-run-id"]).toBeTruthy();

        // A finishes its upload and is the one admitted run.
        a.req.write(body.slice(10));
        a.req.end();
        const aResult = await a.response;
        expect(aResult.statusCode).toBe(200);
        expect(runs).toBe(1);
      } finally {
        await server.close();
      }
    },
  );

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "a client disconnect during body read releases the admission slot",
    async () => {
      let runs = 0;
      const server = await createRemoteServer(
        { host: "127.0.0.1", port: 0, token: "secret", logger: () => {} },
        {
          runBrowser: async () => {
            runs += 1;
            return MINIMAL_RESULT;
          },
        },
      );

      try {
        const stalled = openRunRequest(server.port, "secret", 65536);
        stalled.req.write('{"prompt":"gone');
        await delay(50);
        stalled.req.destroy();
        void stalled.response.catch(() => undefined);
        await delay(50);

        // The slot must have been released; the next run is admitted.
        const accepted = await sendRun(server.port, "secret", validPayload());
        expect(accepted.statusCode).toBe(200);
        expect(runs).toBe(1);

        const health = await getJson(server.port, "/health", "secret");
        expect(health.statusCode).toBe(200);
        expect(health.json?.busy).toBe(false);
      } finally {
        await server.close();
      }
    },
  );
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface RunResponse {
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function openRunRequest(
  port: number,
  token: string,
  contentLength: number,
): { req: http.ClientRequest; response: Promise<RunResponse> } {
  let req: http.ClientRequest | undefined;
  const response = new Promise<RunResponse>((resolve, reject) => {
    req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/runs",
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "content-length": contentLength,
        },
      },
      (res) => {
        res.setEncoding("utf8");
        let body = "";
        res.on("data", (chunk: string) => {
          body += chunk;
        });
        const settle = () =>
          resolve({ statusCode: res.statusCode ?? 0, headers: res.headers, body });
        res.on("end", settle);
        res.on("close", settle);
      },
    );
    req.on("error", reject);
  });
  if (!req) {
    throw new Error("request was not created");
  }
  return { req, response };
}

async function sendRun(port: number, token: string, body: string): Promise<RunResponse> {
  const { req, response } = openRunRequest(port, token, Buffer.byteLength(body));
  req.write(body);
  req.end();
  return await response;
}

async function getJson(
  port: number,
  path: string,
  token: string,
): Promise<{ statusCode: number; json: Record<string, unknown> | null }> {
  return await new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method: "GET",
        headers: { authorization: `Bearer ${token}` },
      },
      (res) => {
        res.setEncoding("utf8");
        let body = "";
        res.on("data", (chunk: string) => {
          body += chunk;
        });
        res.on("end", () => {
          let json: Record<string, unknown> | null = null;
          try {
            json = body.length ? (JSON.parse(body) as Record<string, unknown>) : null;
          } catch {
            json = null;
          }
          resolve({ statusCode: res.statusCode ?? 0, json });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

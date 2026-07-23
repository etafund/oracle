import { afterEach, describe, expect, test } from "vitest";
import http from "node:http";
import { spawnSync } from "node:child_process";
import { createRemoteServer } from "../../src/remote/server.js";
import type { BrowserRunResult } from "../../src/browserMode.js";
import {
  REMOTE_BROWSER_RECOVERY_ADMISSION_HEADER_VALUES,
  REMOTE_BROWSER_RUN_PATH,
} from "../../src/remote/types.js";

// Run-identity contract for the remote serve endpoint:
// - a run id is minted at request arrival, before any side effect, so every
//   outcome (accepted, unauthorized, busy, invalid body) is attributable;
// - X-Oracle-Run-Id / X-Oracle-Lane-Id / X-Oracle-Account-Id response headers
//   are present on accepted runs AND authenticated refusals (busy, invalid
//   body, quarantine) — but NEVER on unauthorized refusals, which must match
//   /health and /ready's minimal {error:"unauthorized"} shape so fleet
//   identity cannot be enumerated by unauthenticated probes;
// - every NDJSON event of a run carries the same run id as the response header.

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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const MINIMAL_RESULT: BrowserRunResult = {
  answerText: "ok",
  answerMarkdown: "ok",
  tookMs: 1,
  answerTokens: 1,
  answerChars: 2,
};

const savedEnv: Record<string, string | undefined> = {};

afterEach(() => {
  for (const key of ["ORACLE_LANE_ID", "ORACLE_ACCOUNT_ID"]) {
    if (key in savedEnv) {
      const value = savedEnv[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
      delete savedEnv[key];
    }
  }
});

function setEnv(key: string, value: string | undefined): void {
  if (!(key in savedEnv)) {
    savedEnv[key] = process.env[key];
  }
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

describe("remote server run identity", () => {
  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "accepted runs expose identity headers and stamp every event with the same run id",
    async () => {
      const server = await createRemoteServer(
        {
          host: "127.0.0.1",
          port: 0,
          token: "secret",
          logger: () => {},
          laneId: "acct2-9200",
          accountId: "acct2",
        },
        { runBrowser: async () => MINIMAL_RESULT },
      );

      try {
        const response = await postRun(server.port, JSON.stringify(validPayload()), "secret");
        expect(response.statusCode).toBe(200);
        const runId = String(response.headers["x-oracle-run-id"]);
        expect(runId).toMatch(UUID_RE);
        expect(response.headers["x-oracle-lane-id"]).toBe("acct2-9200");
        expect(response.headers["x-oracle-account-id"]).toBe("acct2");

        const events = response.body
          .split("\n")
          .filter((line) => line.trim().length > 0)
          .map((line) => JSON.parse(line) as Record<string, unknown>);
        expect(events.length).toBeGreaterThan(0);
        for (const event of events) {
          expect(event.runId).toBe(runId);
        }
        expect(events.some((event) => event.type === "done")).toBe(true);
      } finally {
        await server.close();
      }
    },
  );

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "unauthorized refusals never leak run/lane/account identity (headers or body)",
    async () => {
      // Regression: POST /runs with a bad token used to return the 401 WITH
      // X-Oracle-Account-Id / X-Oracle-Lane-Id headers and a runId body field,
      // letting unauthenticated callers enumerate fleet identity that /health
      // and /ready deliberately withhold on their own 401s.
      const server = await createRemoteServer(
        {
          host: "127.0.0.1",
          port: 0,
          token: "secret",
          logger: () => {},
          laneId: "acct7-9700",
          accountId: "acct7",
        },
        { runBrowser: async () => MINIMAL_RESULT },
      );

      try {
        for (const token of ["wrong-token", ""]) {
          const response = await postRun(server.port, JSON.stringify(validPayload()), token);
          expect(response.statusCode).toBe(401);
          expect(response.headers["x-oracle-run-id"]).toBeUndefined();
          expect(response.headers["x-oracle-lane-id"]).toBeUndefined();
          expect(response.headers["x-oracle-account-id"]).toBeUndefined();
          // Same minimal shape as /health and /ready's 401.
          expect(JSON.parse(response.body)).toEqual({ error: "unauthorized" });
        }
      } finally {
        await server.close();
      }
    },
  );

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "busy refusals mint their own run id distinct from the active run",
    async () => {
      let markRunStarted: () => void = () => {};
      let releaseRun: ((result: BrowserRunResult) => void) | undefined;
      const runStarted = new Promise<void>((resolve) => {
        markRunStarted = resolve;
      });
      const runFinished = new Promise<BrowserRunResult>((resolve) => {
        releaseRun = resolve;
      });
      const server = await createRemoteServer(
        { host: "127.0.0.1", port: 0, token: "secret", logger: () => {} },
        {
          runBrowser: async () => {
            markRunStarted();
            return await runFinished;
          },
        },
      );

      const active = postRunStreaming(server.port, JSON.stringify(validPayload()), "secret");
      void active.finished.catch(() => undefined);

      try {
        await runStarted;
        const activeHeaders = await active.headers;
        const activeRunId = String(activeHeaders["x-oracle-run-id"]);
        expect(activeRunId).toMatch(UUID_RE);

        const refused = await postRun(server.port, JSON.stringify(validPayload()), "secret");
        expect(refused.statusCode).toBe(409);
        const refusedRunId = String(refused.headers["x-oracle-run-id"]);
        expect(refusedRunId).toMatch(UUID_RE);
        expect(refusedRunId).not.toBe(activeRunId);
        const body = JSON.parse(refused.body) as Record<string, unknown>;
        expect(body.error).toBe("busy");
        expect(body.runId).toBe(refusedRunId);
        expect((body.activeRun as { id?: string } | undefined)?.id).toBe(activeRunId);
      } finally {
        releaseRun?.(MINIMAL_RESULT);
        await active.finished.catch(() => undefined);
        await server.close();
      }
    },
  );

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "invalid request bodies are refused with a run id (early-failure attribution)",
    async () => {
      const server = await createRemoteServer(
        { host: "127.0.0.1", port: 0, token: "secret", logger: () => {} },
        { runBrowser: async () => MINIMAL_RESULT },
      );

      try {
        const response = await postRun(server.port, "this is not json", "secret");
        expect(response.statusCode).toBe(400);
        const runId = String(response.headers["x-oracle-run-id"]);
        expect(runId).toMatch(UUID_RE);
        expect(response.headers["x-oracle-lane-id"]).toBe(`acct1-${server.port}`);
        const body = JSON.parse(response.body) as Record<string, unknown>;
        expect(body.error).toBe("invalid_request");
        expect(body.runId).toBe(runId);

        // The refused slot must be released: a follow-up run is accepted.
        const ok = await postRun(server.port, JSON.stringify(validPayload()), "secret");
        expect(ok.statusCode).toBe(200);
      } finally {
        await server.close();
      }
    },
  );

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "lane/account identity falls back to ORACLE_LANE_ID / ORACLE_ACCOUNT_ID env",
    async () => {
      setEnv("ORACLE_ACCOUNT_ID", "acct2");
      setEnv("ORACLE_LANE_ID", undefined);
      const server = await createRemoteServer(
        { host: "127.0.0.1", port: 0, token: "secret", logger: () => {} },
        { runBrowser: async () => MINIMAL_RESULT },
      );

      try {
        const response = await postRun(server.port, JSON.stringify(validPayload()), "secret");
        expect(response.statusCode).toBe(200);
        expect(response.headers["x-oracle-account-id"]).toBe("acct2");
        expect(response.headers["x-oracle-lane-id"]).toBe(`acct2-${server.port}`);
      } finally {
        await server.close();
      }
    },
  );

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "malformed identity env values are replaced with neutral defaults",
    async () => {
      // Values with spaces/exotic characters must never reach caller-visible
      // headers; the worker falls back to the neutral default identity.
      setEnv("ORACLE_ACCOUNT_ID", "not a valid label\n");
      setEnv("ORACLE_LANE_ID", "  ");
      const server = await createRemoteServer(
        { host: "127.0.0.1", port: 0, token: "secret", logger: () => {} },
        { runBrowser: async () => MINIMAL_RESULT },
      );

      try {
        const response = await postRun(server.port, JSON.stringify(validPayload()), "secret");
        expect(response.statusCode).toBe(200);
        expect(response.headers["x-oracle-account-id"]).toBe("acct1");
        expect(response.headers["x-oracle-lane-id"]).toBe(`acct1-${server.port}`);
      } finally {
        await server.close();
      }
    },
  );
});

function validPayload(): Record<string, unknown> {
  return {
    prompt: "identity test",
    attachments: [],
    browserConfig: {},
    options: {},
  };
}

async function postRun(
  port: number,
  body: string,
  token: string,
): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: string }> {
  return await new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: REMOTE_BROWSER_RUN_PATH,
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          ...REMOTE_BROWSER_RECOVERY_ADMISSION_HEADER_VALUES,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
      },
      (res) => {
        res.setEncoding("utf8");
        let responseBody = "";
        res.on("data", (chunk: string) => {
          responseBody += chunk;
        });
        res.on("end", () => {
          resolve({
            statusCode: res.statusCode ?? 0,
            headers: res.headers,
            body: responseBody,
          });
        });
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function postRunStreaming(
  port: number,
  body: string,
  token: string,
): {
  headers: Promise<http.IncomingHttpHeaders>;
  finished: Promise<{ statusCode: number; body: string }>;
  abort(): void;
} {
  let req: http.ClientRequest | undefined;
  let resolveHeaders: (headers: http.IncomingHttpHeaders) => void = () => {};
  const headers = new Promise<http.IncomingHttpHeaders>((resolve) => {
    resolveHeaders = resolve;
  });
  const finished = new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
    req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: REMOTE_BROWSER_RUN_PATH,
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          ...REMOTE_BROWSER_RECOVERY_ADMISSION_HEADER_VALUES,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
      },
      (res) => {
        resolveHeaders(res.headers);
        res.setEncoding("utf8");
        let responseBody = "";
        res.on("data", (chunk: string) => {
          responseBody += chunk;
        });
        res.on("end", () => {
          resolve({ statusCode: res.statusCode ?? 0, body: responseBody });
        });
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
  return {
    headers,
    finished,
    abort() {
      req?.destroy();
    },
  };
}

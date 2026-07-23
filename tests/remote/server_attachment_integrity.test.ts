import { describe, expect, test } from "vitest";
import http from "node:http";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createRemoteServer } from "../../src/remote/server.js";
import type { BrowserRunResult } from "../../src/browserMode.js";
import type { RemoteUploadIntegrity } from "../../src/remote/types.js";
import {
  REMOTE_BROWSER_RECOVERY_ADMISSION_HEADER_VALUES,
  REMOTE_BROWSER_RUN_PATH,
} from "../../src/remote/types.js";
import { formatCaptureBindingVerifiedLog } from "../../src/browser/actions/captureBinding.js";

// Attachment-staging integrity contract:
// - stored names are collision-proof (NNN-<sha256:12>-<sanitized name>), so
//   inputs that sanitize to the same name (e.g. "a/b.txt" vs "a_b.txt") can
//   never silently overwrite each other — the model must receive both files;
// - declared vs decoded byte length is verified: mismatch -> typed 400,
//   no truncated upload ever reaches the browser;
// - an uploadIntegrity manifest (original name, stored name, bytes, sha256)
//   is emitted as a run event and repeated on the result event. It proves
//   PLUMBING (right bytes staged under unique names, consumed by the
//   browser-side pre-Send composer-chip check via the same stored names),
//   not that the model read the files.

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

const FIRST_CONTENT = "first file body";
const SECOND_CONTENT = "second file body -- distinct";

function sha256Hex(value: string): string {
  return createHash("sha256").update(Buffer.from(value)).digest("hex");
}

describe("remote server attachment integrity", () => {
  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "colliding attachment names are stored as distinct files and manifested",
    async () => {
      const stagedContents: Record<string, string> = {};
      const stagedBasenames: string[] = [];
      const server = await createRemoteServer(
        { host: "127.0.0.1", port: 0, token: "secret", logger: () => {} },
        {
          runBrowser: async (options) => {
            for (const attachment of options.attachments ?? []) {
              const basename = path.basename(attachment.path);
              stagedBasenames.push(basename);
              stagedContents[basename] = await readFile(attachment.path, "utf8");
            }
            options.log?.(formatCaptureBindingVerifiedLog("message-handle", "abc123"));
            return MINIMAL_RESULT;
          },
        },
      );

      try {
        const payload = {
          prompt: "collision test",
          attachments: [
            {
              fileName: "a/b.txt",
              displayPath: "a/b.txt",
              sizeBytes: Buffer.byteLength(FIRST_CONTENT),
              contentBase64: Buffer.from(FIRST_CONTENT).toString("base64"),
            },
            {
              fileName: "a_b.txt",
              displayPath: "a_b.txt",
              sizeBytes: Buffer.byteLength(SECOND_CONTENT),
              contentBase64: Buffer.from(SECOND_CONTENT).toString("base64"),
            },
          ],
          browserConfig: {},
          options: {},
        };
        const response = await sendRun(server.port, "secret", JSON.stringify(payload));
        expect(response.statusCode).toBe(200);

        // Both files must be staged, distinct, and contain the right bytes.
        expect(stagedBasenames).toHaveLength(2);
        expect(new Set(stagedBasenames).size).toBe(2);
        expect(stagedBasenames[0]).toMatch(/^000-[0-9a-f]{12}-a_b\.txt$/);
        expect(stagedBasenames[1]).toMatch(/^001-[0-9a-f]{12}-a_b\.txt$/);
        expect(stagedContents[stagedBasenames[0]!]).toBe(FIRST_CONTENT);
        expect(stagedContents[stagedBasenames[1]!]).toBe(SECOND_CONTENT);

        const events = parseEvents(response.body);
        const runId = String(response.headers["x-oracle-run-id"]);

        const manifestEvent = events.find((event) => event.type === "attachment-manifest");
        expect(manifestEvent).toBeTruthy();
        expect(manifestEvent?.runId).toBe(runId);
        const integrity = manifestEvent?.uploadIntegrity as RemoteUploadIntegrity;
        expect(integrity.preSendDomCheck).toBe("composer-chips-by-stored-name");
        expect(integrity.attachments).toHaveLength(2);
        expect(integrity.attachments[0]).toEqual({
          index: 0,
          originalName: "a/b.txt",
          storedName: stagedBasenames[0],
          bytes: Buffer.byteLength(FIRST_CONTENT),
          sha256: sha256Hex(FIRST_CONTENT),
        });
        expect(integrity.attachments[1]).toEqual({
          index: 1,
          originalName: "a_b.txt",
          storedName: stagedBasenames[1],
          bytes: Buffer.byteLength(SECOND_CONTENT),
          sha256: sha256Hex(SECOND_CONTENT),
        });
        // The hash fragment in the stored name is the manifest hash prefix.
        expect(stagedBasenames[0]!.slice(4, 16)).toBe(sha256Hex(FIRST_CONTENT).slice(0, 12));

        // The staging proof is repeated on the terminal done event.
        const doneEvent = events.find((event) => event.type === "done");
        expect(doneEvent?.ok).toBe(true);
        expect(doneEvent?.uploadIntegrity).toEqual(manifestEvent?.uploadIntegrity);
      } finally {
        await server.close();
      }
    },
  );

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "declared-size mismatches are refused with a typed 400 before any browser work",
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
        const payload = {
          prompt: "mismatch test",
          attachments: [
            {
              fileName: "notes.txt",
              displayPath: "notes.txt",
              sizeBytes: 5, // deliberately wrong
              contentBase64: Buffer.from("many more than five bytes").toString("base64"),
            },
          ],
          browserConfig: {},
          options: {},
        };
        const refused = await sendRun(server.port, "secret", JSON.stringify(payload));
        expect(refused.statusCode).toBe(400);
        const body = JSON.parse(refused.body) as Record<string, unknown>;
        expect(body.error).toBe("attachment_size_mismatch");
        expect(body.runId).toBe(refused.headers["x-oracle-run-id"]);
        expect(runs).toBe(0);

        // The refusal happened during admission: the worker is still ready.
        const accepted = await sendRun(
          server.port,
          "secret",
          JSON.stringify({ prompt: "ok", attachments: [], browserConfig: {}, options: {} }),
        );
        expect(accepted.statusCode).toBe(200);
        expect(runs).toBe(1);
      } finally {
        await server.close();
      }
    },
  );

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "fallback-submission attachments get the same collision-proof staging and manifest",
    async () => {
      const fallbackBasenames: string[] = [];
      const server = await createRemoteServer(
        { host: "127.0.0.1", port: 0, token: "secret", logger: () => {} },
        {
          runBrowser: async (options) => {
            for (const attachment of options.fallbackSubmission?.attachments ?? []) {
              fallbackBasenames.push(path.basename(attachment.path));
            }
            options.log?.(formatCaptureBindingVerifiedLog("message-handle", "abc123"));
            return MINIMAL_RESULT;
          },
        },
      );

      try {
        const payload = {
          prompt: "fallback test",
          attachments: [],
          fallbackSubmission: {
            prompt: "fallback prompt",
            attachments: [
              {
                fileName: "fb.txt",
                displayPath: "fb.txt",
                sizeBytes: Buffer.byteLength(FIRST_CONTENT),
                contentBase64: Buffer.from(FIRST_CONTENT).toString("base64"),
              },
            ],
          },
          browserConfig: {},
          options: {},
        };
        const response = await sendRun(server.port, "secret", JSON.stringify(payload));
        expect(response.statusCode).toBe(200);
        expect(fallbackBasenames).toHaveLength(1);
        expect(fallbackBasenames[0]).toMatch(/^000-[0-9a-f]{12}-fb\.txt$/);

        const events = parseEvents(response.body);
        const manifestEvent = events.find((event) => event.type === "attachment-manifest");
        const integrity = manifestEvent?.uploadIntegrity as RemoteUploadIntegrity;
        expect(integrity.attachments).toHaveLength(0);
        expect(integrity.fallbackAttachments).toHaveLength(1);
        expect(integrity.fallbackAttachments?.[0]).toMatchObject({
          index: 0,
          originalName: "fb.txt",
          storedName: fallbackBasenames[0],
          bytes: Buffer.byteLength(FIRST_CONTENT),
          sha256: sha256Hex(FIRST_CONTENT),
        });
      } finally {
        await server.close();
      }
    },
  );
});

function parseEvents(body: string): Array<Record<string, unknown>> {
  return body
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

interface RunResponse {
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

async function sendRun(port: number, token: string, body: string): Promise<RunResponse> {
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
        const settle = () =>
          resolve({ statusCode: res.statusCode ?? 0, headers: res.headers, body: responseBody });
        res.on("end", settle);
        res.on("close", settle);
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

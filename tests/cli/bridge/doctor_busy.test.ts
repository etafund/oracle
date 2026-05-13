import http from "node:http";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { BrowserRunResult } from "../../../src/browserMode.js";
import { runBridgeDoctor } from "../../../src/cli/bridge/doctor.js";
import { setOracleHomeDirOverrideForTest } from "../../../src/oracleHome.js";
import { createRemoteServer } from "../../../src/remote/server.js";
import type { RemoteRunPayload } from "../../../src/remote/types.js";

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

describe("oracle bridge doctor busy remote host", () => {
  let tempDir: string;
  let originalExitCode: number | undefined;

  beforeEach(async () => {
    originalExitCode = typeof process.exitCode === "number" ? process.exitCode : undefined;
    process.exitCode = undefined;
    delete process.env.ORACLE_REMOTE_HOST;
    delete process.env.ORACLE_REMOTE_TOKEN;

    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-bridge-doctor-busy-"));
    setOracleHomeDirOverrideForTest(tempDir);
  });

  afterEach(async () => {
    setOracleHomeDirOverrideForTest(null);
    process.exitCode = originalExitCode;
    await fs.rm(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "reports degraded when health is ok but /runs rejects work as busy",
    async () => {
      let runStartedResolve: () => void = () => {};
      let releaseRun: ((result: BrowserRunResult) => void) | undefined;
      const runStarted = new Promise<void>((resolve) => {
        runStartedResolve = resolve;
      });
      const runFinished = new Promise<BrowserRunResult>((resolve) => {
        releaseRun = resolve;
      });

      const server = await createRemoteServer(
        { host: "127.0.0.1", port: 0, token: "secret", logger: () => {} },
        {
          runBrowser: async () => {
            runStartedResolve();
            return await runFinished;
          },
        },
      );

      let activeRun: Promise<{ statusCode: number; body: string }> | undefined;
      try {
        await fs.writeFile(
          path.join(tempDir, "config.json"),
          JSON.stringify(
            { browser: { remoteHost: `127.0.0.1:${server.port}`, remoteToken: "secret" } },
            null,
            2,
          ),
          "utf8",
        );

        activeRun = postRun(server.port, runPayload("hold-open"), "secret");
        await runStarted;

        const rejectedRun = await postRun(server.port, runPayload("second-run"), "secret");
        expect(rejectedRun.statusCode).toBe(409);
        expect(rejectedRun.body).toContain("busy");

        const logs: string[] = [];
        vi.spyOn(console, "log").mockImplementation((msg) => logs.push(String(msg)));

        await runBridgeDoctor({ verbose: false, json: true });

        expect(logs).toHaveLength(1);
        const endpoint = JSON.parse(logs[0]) as { status?: string; error?: string };
        expect(endpoint.status).toBe("unknown");
        expect(endpoint.error).toMatch(/HTTP 409|busy|\/runs/i);
        expect(process.exitCode).toBe(1);
      } finally {
        releaseRun?.(okResult());
        await activeRun?.catch(() => undefined);
        await server.close();
      }
    },
  );
});

function runPayload(prompt: string): RemoteRunPayload {
  return {
    prompt,
    attachments: [],
    browserConfig: { url: "https://chatgpt.com/" },
    options: {},
  };
}

function okResult(): BrowserRunResult {
  return {
    answerText: "ok",
    answerMarkdown: "ok",
    tookMs: 1,
    answerTokens: 1,
    answerChars: 2,
  };
}

async function postRun(
  port: number,
  payload: RemoteRunPayload,
  token: string,
): Promise<{ statusCode: number; body: string }> {
  return await new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/runs",
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
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
          resolve({ statusCode: res.statusCode ?? 0, body: responseBody });
        });
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

import { afterEach, describe, expect, test } from "vitest";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRemoteServer } from "../../src/remote/server.js";
import {
  AccountQuarantinedError,
  clearQuarantineLatchManually,
  getQuarantineLatchState,
  tripQuarantineLatch,
} from "../../src/browser/quarantineLatch.js";
import type { BrowserRunResult } from "../../src/browserMode.js";

// Serve-side half of the challenge/login account-safety gates.
// ACCOUNT-SAFETY HARD-HALT DOCTRINE: while the worker-local quarantine latch
// exists, /runs refuses every run and /ready reports 503 — independent of any
// router-side drain, because a drain can race a caller retry and the
// worker-side refusal is the hard stop. The latch is cleared ONLY manually by
// a human; no automation retries into, restarts into, or works around a
// challenged account. Fail closed: an unreadable latch file counts as
// quarantined.

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

const savedFleetDir = process.env.ORACLE_FLEET_DIR;
const savedSinkDir = process.env.ORACLE_RUN_EVENTS_DIR;
const tempDirs: string[] = [];

afterEach(async () => {
  if (savedFleetDir === undefined) {
    delete process.env.ORACLE_FLEET_DIR;
  } else {
    process.env.ORACLE_FLEET_DIR = savedFleetDir;
  }
  if (savedSinkDir === undefined) {
    delete process.env.ORACLE_RUN_EVENTS_DIR;
  } else {
    process.env.ORACLE_RUN_EVENTS_DIR = savedSinkDir;
  }
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop()!, { recursive: true, force: true });
  }
});

async function isolatedDirs(): Promise<{ fleetDir: string; sinkDir: string }> {
  const fleetDir = await mkdtemp(path.join(os.tmpdir(), "oracle-quarantine-fleet-"));
  const sinkDir = await mkdtemp(path.join(os.tmpdir(), "oracle-quarantine-sink-"));
  tempDirs.push(fleetDir, sinkDir);
  process.env.ORACLE_FLEET_DIR = fleetDir;
  process.env.ORACLE_RUN_EVENTS_DIR = sinkDir;
  return { fleetDir, sinkDir };
}

async function startServer(runs: { count: number }) {
  return await createRemoteServer(
    { host: "127.0.0.1", port: 0, token: "secret", logger: () => {}, attachOnly: false },
    {
      runBrowser: async () => {
        runs.count += 1;
        return MINIMAL_RESULT;
      },
    },
  );
}

describe("serve quarantine gates", () => {
  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "a tripped latch refuses /runs and fails /ready closed until manually cleared",
    async () => {
      const { fleetDir } = await isolatedDirs();
      await tripQuarantineLatch({
        reason: "verification_interstitial",
        source: "pre-run-gate",
        accountId: "acct1",
        dir: fleetDir,
      });

      const runs = { count: 0 };
      const server = await startServer(runs);
      try {
        // /runs: hard refusal, browser never consulted.
        const refused = await postRun(server.port, "secret");
        expect(refused.statusCode).toBe(503);
        const body = JSON.parse(refused.body) as Record<string, unknown>;
        expect(body.error).toBe("account_quarantined");
        expect(body.errorClass).toBe("account_quarantine");
        expect(body.retryable).toBe(false);
        expect(body.reason).toBe("verification_interstitial");
        expect(runs.count).toBe(0);

        // /ready: 503 with the latch record surfaced for the human operator.
        const ready = await getJson(server.port, "/ready", "secret");
        expect(ready.statusCode).toBe(503);
        expect(String(ready.json?.reason)).toContain("account_quarantined");
        const quarantine = ready.json?.quarantine as Record<string, unknown>;
        expect(quarantine.quarantined).toBe(true);
        expect((quarantine.record as Record<string, unknown>).reason).toBe(
          "verification_interstitial",
        );

        // MANUAL-HUMAN-ONLY clear restores service.
        await clearQuarantineLatchManually({ accountId: "acct1", dir: fleetDir });
        const accepted = await postRun(server.port, "secret");
        expect(accepted.statusCode).toBe(200);
        expect(runs.count).toBe(1);
        const readyAfter = await getJson(server.port, "/ready", "secret");
        expect(readyAfter.statusCode).toBe(200);
      } finally {
        await server.close();
      }
    },
  );

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "the latch persists across worker restarts",
    async () => {
      const { fleetDir } = await isolatedDirs();
      await tripQuarantineLatch({
        reason: "account_security_block",
        source: "pre-result-gate",
        accountId: "acct1",
        dir: fleetDir,
      });

      const runs = { count: 0 };
      const first = await startServer(runs);
      const refusedFirst = await postRun(first.port, "secret");
      expect(refusedFirst.statusCode).toBe(503);
      await first.close();

      // A restarted worker reads the same latch file: still quarantined.
      const second = await startServer(runs);
      try {
        const refusedSecond = await postRun(second.port, "secret");
        expect(refusedSecond.statusCode).toBe(503);
        expect(
          (JSON.parse(refusedSecond.body) as Record<string, unknown>).errorClass,
        ).toBe("account_quarantine");
        expect(runs.count).toBe(0);
      } finally {
        await second.close();
      }
    },
  );

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "an unreadable latch file fails closed on both surfaces",
    async () => {
      const { fleetDir } = await isolatedDirs();
      await writeFile(path.join(fleetDir, "quarantine-acct1.json"), "{{{ not json", "utf8");

      const runs = { count: 0 };
      const server = await startServer(runs);
      try {
        const refused = await postRun(server.port, "secret");
        expect(refused.statusCode).toBe(503);
        expect((JSON.parse(refused.body) as Record<string, unknown>).errorClass).toBe(
          "account_quarantine",
        );
        expect(runs.count).toBe(0);

        const ready = await getJson(server.port, "/ready", "secret");
        expect(ready.statusCode).toBe(503);
        const quarantine = ready.json?.quarantine as Record<string, unknown>;
        expect(quarantine.quarantined).toBe(true);
        expect(typeof quarantine.readError).toBe("string");
      } finally {
        await server.close();
      }
    },
  );

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "a mid-run quarantine trip maps to the terminal event and sink, then gates the next run",
    async () => {
      const { fleetDir, sinkDir } = await isolatedDirs();
      const server = await createRemoteServer(
        { host: "127.0.0.1", port: 0, token: "secret", logger: () => {}, attachOnly: false },
        {
          runBrowser: async () => {
            // Mirror the browser-side gate contract: trip the latch FIRST,
            // then throw the typed error.
            await tripQuarantineLatch({
              reason: "verification_interstitial",
              source: "pre-result-gate",
              accountId: "acct1",
              dir: fleetDir,
            });
            throw new AccountQuarantinedError(
              await getQuarantineLatchState({ accountId: "acct1", dir: fleetDir }),
            );
          },
        },
      );

      try {
        const failed = await postRun(server.port, "secret");
        expect(failed.statusCode).toBe(200); // failure arrives as the terminal event
        const events = failed.body
          .split("\n")
          .filter((line) => line.trim().length > 0)
          .map((line) => JSON.parse(line) as Record<string, unknown>);
        const done = events[events.length - 1]!;
        expect(done.type).toBe("done");
        expect(done.ok).toBe(false);
        expect(done.errorClass).toBe("account_quarantine");
        expect(done.retryable).toBe(false);
        // The provenance summary reflects the tripped latch.
        expect((done.provenance as Record<string, unknown>).challengeClean).toBe(false);

        // Sink line carries the class and forces challenge_detected.
        const files = await readdir(sinkDir);
        const raw = await readFile(path.join(sinkDir, files[0]!), "utf8");
        const line = JSON.parse(raw.trim().split("\n")[0]!) as Record<string, unknown>;
        expect(line.error_class).toBe("account_quarantine");
        expect(line.challenge_detected).toBe(true);
        expect(line.done_ok).toBe(false);

        // The next run is refused at admission without touching the browser.
        const refused = await postRun(server.port, "secret");
        expect(refused.statusCode).toBe(503);
        expect((JSON.parse(refused.body) as Record<string, unknown>).error).toBe(
          "account_quarantined",
        );
      } finally {
        await server.close();
      }
    },
  );
});

interface RunResponse {
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

async function postRun(port: number, token: string): Promise<RunResponse> {
  const body = JSON.stringify({
    prompt: "quarantine gate test",
    attachments: [],
    browserConfig: {},
    options: {},
  });
  return await new Promise((resolve, reject) => {
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

async function getJson(
  port: number,
  requestPath: string,
  token: string,
): Promise<{ statusCode: number; json: Record<string, unknown> | null }> {
  return await new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: requestPath,
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

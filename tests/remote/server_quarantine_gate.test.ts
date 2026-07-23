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
import { BrowserAutomationError } from "../../src/oracle/errors.js";
import { formatCaptureBindingVerifiedLog } from "../../src/browser/actions/captureBinding.js";
import {
  REMOTE_BROWSER_RECOVERY_ADMISSION_HEADER_VALUES,
  REMOTE_BROWSER_RUN_PATH,
} from "../../src/remote/types.js";

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
    "a sibling quarantine before finalization suppresses an otherwise successful result",
    async () => {
      const { fleetDir } = await isolatedDirs();
      const artifactPath = path.join(fleetDir, "registered-before-final-gate.txt");
      await writeFile(artifactPath, "artifact", "utf8");
      const runs = { count: 0 };
      const server = await createRemoteServer(
        {
          host: "127.0.0.1",
          port: 0,
          token: "secret",
          logger: () => {},
          attachOnly: false,
          accountId: "acct1",
        },
        {
          runBrowser: async () => {
            runs.count += 1;
            return {
              ...MINIMAL_RESULT,
              artifacts: [
                {
                  kind: "file" as const,
                  path: artifactPath,
                  label: "registered-before-final-gate.txt",
                  mimeType: "text/plain",
                  sizeBytes: 8,
                },
              ],
            };
          },
          beforeFinalizeRun: async ({ runId }) => {
            await tripQuarantineLatch({
              dir: fleetDir,
              accountId: "acct1",
              reason: "verification_interstitial",
              runId,
              source: "sibling-lane-test",
            });
          },
        },
      );

      try {
        const response = await postRun(server.port, "secret");
        const events = response.body
          .split("\n")
          .filter((line) => line.trim().length > 0)
          .map((line) => JSON.parse(line) as Record<string, unknown>);
        expect(events.at(-1)).toMatchObject({
          type: "done",
          ok: false,
          errorClass: "account_quarantine",
          retryable: false,
          provenance: { challengeClean: false },
        });
        expect(events.at(-1)).not.toHaveProperty("result");
        expect(events.some((event) => event.type === "artifact-ready")).toBe(false);
        expect(events.some((event) => event.type === "done" && event.ok === true)).toBe(false);
        expect(runs.count).toBe(1);
        expect((await getJson(server.port, "/ready", "secret")).statusCode).toBe(503);
      } finally {
        await server.close();
      }
    },
  );

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "account quarantine outranks busy admission and never invites a retry",
    async () => {
      const { fleetDir } = await isolatedDirs();
      let markStarted!: () => void;
      let finishRun!: () => void;
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      const finish = new Promise<void>((resolve) => {
        finishRun = resolve;
      });
      const runs = { count: 0 };
      const server = await createRemoteServer(
        {
          host: "127.0.0.1",
          port: 0,
          token: "secret",
          logger: () => {},
          attachOnly: false,
          accountId: "acct1",
        },
        {
          runBrowser: async () => {
            runs.count += 1;
            markStarted();
            await finish;
            return MINIMAL_RESULT;
          },
        },
      );

      try {
        const first = postRun(server.port, "secret");
        await started;
        await tripQuarantineLatch({
          dir: fleetDir,
          accountId: "acct1",
          reason: "verification_interstitial",
          source: "sibling-lane-test",
        });

        const refused = await postRun(server.port, "secret");
        expect(refused.statusCode).toBe(503);
        expect(JSON.parse(refused.body)).toMatchObject({
          error: "account_quarantined",
          errorClass: "account_quarantine",
          retryable: false,
        });
        expect(refused.headers["retry-after"]).toBeUndefined();

        finishRun();
        const firstEvents = (await first).body
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as Record<string, unknown>);
        expect(firstEvents.at(-1)).toMatchObject({
          type: "done",
          ok: false,
          errorClass: "account_quarantine",
        });
        expect(runs.count).toBe(1);
      } finally {
        finishRun();
        await server.close();
      }
    },
  );

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "account quarantine outranks cleanup-tainted admission",
    async () => {
      const { fleetDir } = await isolatedDirs();
      await tripQuarantineLatch({
        dir: fleetDir,
        accountId: "acct1",
        reason: "verification_interstitial",
        source: "pre-run-gate",
      });
      const runs = { count: 0 };
      const server = await createRemoteServer(
        {
          host: "127.0.0.1",
          port: 0,
          token: "secret",
          logger: () => {},
          attachOnly: false,
          accountId: "acct1",
        },
        {
          runBrowser: async () => {
            runs.count += 1;
            return MINIMAL_RESULT;
          },
          cleanupTaint: () => ({
            at: "2026-07-21T00:00:00.000Z",
            reason: "owned-target-close-timeout",
          }),
        },
      );
      try {
        const refused = await postRun(server.port, "secret");
        expect(refused.statusCode).toBe(503);
        expect(JSON.parse(refused.body)).toMatchObject({
          error: "account_quarantined",
          errorClass: "account_quarantine",
          retryable: false,
        });
        expect(runs.count).toBe(0);
      } finally {
        await server.close();
      }
    },
  );

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "readiness reports account quarantine before attach or cleanup diagnostics",
    async () => {
      const { fleetDir } = await isolatedDirs();
      await tripQuarantineLatch({
        dir: fleetDir,
        accountId: "acct1",
        reason: "verification_interstitial",
        source: "pre-run-gate",
      });
      let cleanupCalls = 0;
      const server = await createRemoteServer(
        {
          host: "127.0.0.1",
          port: 0,
          token: "secret",
          logger: () => {},
          attachOnly: true,
          accountId: "acct1",
          devtoolsPort: 1,
        },
        {
          runBrowser: async () => MINIMAL_RESULT,
          cleanupTaint: () => {
            cleanupCalls += 1;
            return {
              at: "2026-07-21T00:00:00.000Z",
              reason: "owned-target-close-timeout",
            };
          },
        },
      );
      try {
        const ready = await getJson(server.port, "/ready", "secret");
        expect(ready.statusCode).toBe(503);
        expect(ready.json).toMatchObject({
          state: "substrate-broken",
          quarantine: {
            quarantined: true,
            reason: "verification_interstitial",
          },
        });
        expect(String(ready.json?.reason)).toContain("account_quarantined");
        expect(String(ready.json?.reason)).not.toContain("cleanup-tainted");
        expect(cleanupCalls).toBe(0);
      } finally {
        await server.close();
      }
    },
  );

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "a sibling account latch does not suppress this account's success",
    async () => {
      const { fleetDir } = await isolatedDirs();
      await tripQuarantineLatch({
        dir: fleetDir,
        accountId: "acct2",
        reason: "verification_interstitial",
        source: "pre-run-gate",
      });
      const runs = { count: 0 };
      const server = await createRemoteServer(
        {
          host: "127.0.0.1",
          port: 0,
          token: "secret",
          logger: () => {},
          attachOnly: false,
          accountId: "acct1",
        },
        {
          runBrowser: async (options) => {
            runs.count += 1;
            options.log?.(formatCaptureBindingVerifiedLog("message-handle", "abc123"));
            return MINIMAL_RESULT;
          },
        },
      );
      try {
        const response = await postRun(server.port, "secret");
        const events = response.body
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as Record<string, unknown>);
        expect(events.at(-1)).toMatchObject({
          type: "done",
          ok: true,
          provenance: { challengeClean: true },
        });
        expect(runs.count).toBe(1);
        expect((await getJson(server.port, "/ready", "secret")).statusCode).toBe(200);
      } finally {
        await server.close();
      }
    },
  );

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

        // /ready: 503 with stable, path-free operational state.
        const ready = await getJson(server.port, "/ready", "secret");
        expect(ready.statusCode).toBe(503);
        expect(String(ready.json?.reason)).toContain("account_quarantined");
        const quarantine = ready.json?.quarantine as Record<string, unknown>;
        expect(quarantine).toMatchObject({
          quarantined: true,
          reason: "verification_interstitial",
          source: "pre-run-gate",
          persistence: "durable_record",
          failureCode: null,
        });
        expect(quarantine).not.toHaveProperty("latchPath");
        expect(quarantine).not.toHaveProperty("readError");
        expect(quarantine).not.toHaveProperty("record");

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

  test.skipIf(!CAN_LISTEN_LOCALHOST)("the latch persists across worker restarts", async () => {
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
      expect((JSON.parse(refusedSecond.body) as Record<string, unknown>).errorClass).toBe(
        "account_quarantine",
      );
      expect(runs.count).toBe(0);
    } finally {
      await second.close();
    }
  });

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
        expect(quarantine).toMatchObject({
          quarantined: true,
          reason: "latch_unreadable",
          source: null,
          persistence: "durable_sentinel",
          failureCode: "latch_metadata_unreadable",
        });
        expect(JSON.stringify(ready.json)).not.toContain(fleetDir);
        expect(quarantine).not.toHaveProperty("latchPath");
        expect(quarantine).not.toHaveProperty("readError");
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

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "a legacy Cloudflare navigation error is durably latched before its terminal event",
    async () => {
      const { fleetDir } = await isolatedDirs();
      const runs = { count: 0 };
      const server = await createRemoteServer(
        {
          host: "127.0.0.1",
          port: 0,
          token: "secret",
          logger: () => {},
          attachOnly: false,
          accountId: "acct2",
        },
        {
          runBrowser: async () => {
            runs.count += 1;
            // Exact legacy ensureNotBlocked shape: it classified the page but
            // did not trip the browser-side latch itself.
            throw new BrowserAutomationError("Cloudflare challenge detected.", {
              stage: "cloudflare-challenge",
              headless: false,
            });
          },
        },
      );

      try {
        const failed = await postRun(server.port, "secret");
        const events = failed.body
          .split("\n")
          .filter((line) => line.trim().length > 0)
          .map((line) => JSON.parse(line) as Record<string, unknown>);
        const done = events[events.length - 1]!;
        expect(done).toMatchObject({
          type: "done",
          ok: false,
          errorClass: "account_quarantine",
          retryable: false,
          provenance: { challengeClean: false },
        });

        const latch = await getQuarantineLatchState({ accountId: "acct2", dir: fleetDir });
        expect(latch.quarantined).toBe(true);
        expect(latch.record).toMatchObject({
          accountId: "acct2",
          reason: "verification_interstitial",
          source: "remote-terminal-gate",
        });

        const ready = await getJson(server.port, "/ready", "secret");
        expect(ready.statusCode).toBe(503);
        expect((ready.json?.quarantine as Record<string, unknown> | undefined)?.quarantined).toBe(
          true,
        );

        const refused = await postRun(server.port, "secret");
        expect(refused.statusCode).toBe(503);
        expect((JSON.parse(refused.body) as Record<string, unknown>).error).toBe(
          "account_quarantined",
        );
        expect(runs.count).toBe(1);
      } finally {
        await server.close();
      }
    },
  );

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "a typed security-block stage overrides the non-quarantine message heuristic and latches",
    async () => {
      const { fleetDir } = await isolatedDirs();
      const server = await createRemoteServer(
        {
          host: "127.0.0.1",
          port: 0,
          token: "secret",
          logger: () => {},
          attachOnly: false,
          accountId: "acct2",
        },
        {
          runBrowser: async () => {
            // This wording has none of classifyRunErrorClass's legacy
            // challenge/captcha/interstitial keywords. The typed stage/state
            // must control both the terminal taxonomy and durable hard stop.
            throw new BrowserAutomationError("ChatGPT account security block detected.", {
              stage: "chatgpt-account-blocked",
              state: "account_security_block",
              retryable: false,
            });
          },
        },
      );

      try {
        const failed = await postRun(server.port, "secret");
        const events = failed.body
          .split("\n")
          .filter((line) => line.trim().length > 0)
          .map((line) => JSON.parse(line) as Record<string, unknown>);
        expect(events[events.length - 1]).toMatchObject({
          type: "done",
          ok: false,
          errorClass: "account_quarantine",
          retryable: false,
          provenance: { challengeClean: false },
        });
        expect(await getQuarantineLatchState({ accountId: "acct2", dir: fleetDir })).toMatchObject({
          quarantined: true,
          record: {
            reason: "account_security_block",
            source: "remote-terminal-gate",
          },
        });
      } finally {
        await server.close();
      }
    },
  );

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "untyped challenge vocabulary after submit does not quarantine the account",
    async () => {
      const { fleetDir } = await isolatedDirs();
      const server = await createRemoteServer(
        {
          host: "127.0.0.1",
          port: 0,
          token: "secret",
          logger: () => {},
          attachOnly: false,
          accountId: "acct2",
        },
        {
          runBrowser: async (options) => {
            options.log?.("Clicked send button (dispatch attempted; awaiting prompt commit proof)");
            // Free-form diagnostics and visible UI text can legitimately use
            // this word. Only a typed/declared quarantine signal may create
            // durable account state.
            throw new Error("Assistant diagnostic mentioned a challenge while capture timed out.");
          },
        },
      );

      try {
        const failed = await postRun(server.port, "secret");
        const events = failed.body
          .split("\n")
          .filter((line) => line.trim().length > 0)
          .map((line) => JSON.parse(line) as Record<string, unknown>);
        expect(events[events.length - 1]).toMatchObject({
          type: "done",
          ok: false,
          errorClass: "transport_interrupted_after_submit",
          retryable: false,
          provenance: { challengeClean: true },
        });
        expect(await getQuarantineLatchState({ accountId: "acct2", dir: fleetDir })).toMatchObject({
          quarantined: false,
          record: null,
        });

        const ready = await getJson(server.port, "/ready", "secret");
        expect(ready.statusCode).toBe(200);
        const readyQuarantine = ready.json?.quarantine as Record<string, unknown> | undefined;
        expect(readyQuarantine?.quarantined).toBe(false);
      } finally {
        await server.close();
      }
    },
  );

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "a post-publication metadata failure fences a concurrent sibling and a restarted server",
    async () => {
      const { fleetDir } = await isolatedDirs();
      const detectorRuns = { count: 0 };
      const siblingRuns = { count: 0 };
      const sensitiveFailure = `simulated write failure at ${path.join(fleetDir, "private")}`;
      const detector = await createRemoteServer(
        {
          host: "127.0.0.1",
          port: 0,
          token: "secret",
          logger: () => {},
          attachOnly: false,
          accountId: "acct2",
        },
        {
          runBrowser: async () => {
            detectorRuns.count += 1;
            throw new BrowserAutomationError("Cloudflare challenge detected.", {
              stage: "cloudflare-challenge",
            });
          },
          tripQuarantine: async (input) =>
            await tripQuarantineLatch(
              { ...input, dir: fleetDir },
              {
                writeRecord: async () => {
                  throw new Error(sensitiveFailure);
                },
              },
            ),
        },
      );
      const sibling = await createRemoteServer(
        {
          host: "127.0.0.1",
          port: 0,
          token: "secret",
          logger: () => {},
          attachOnly: false,
          accountId: "acct2",
        },
        {
          runBrowser: async () => {
            siblingRuns.count += 1;
            return MINIMAL_RESULT;
          },
        },
      );

      try {
        const failed = await postRun(detector.port, "secret");
        const events = failed.body
          .split("\n")
          .filter((line) => line.trim().length > 0)
          .map((line) => JSON.parse(line) as Record<string, unknown>);
        expect(events[events.length - 1]).toMatchObject({
          type: "done",
          ok: false,
          errorClass: "account_quarantine",
          errorMessage: "Account quarantined; human review and manual clearance are required.",
          retryable: false,
          provenance: { challengeClean: false },
        });
        expect(failed.body).not.toContain(sensitiveFailure);
        expect(failed.body).not.toContain(fleetDir);
        expect(detectorRuns.count).toBe(1);

        const durableSentinel = await getQuarantineLatchState({
          accountId: "acct2",
          dir: fleetDir,
        });
        expect(durableSentinel).toMatchObject({ quarantined: true, record: null });

        // The already-running sibling process observes the shared final-path
        // sentinel without any router or supervisor intervention.
        const siblingReady = await getJson(sibling.port, "/ready", "secret");
        expect(siblingReady.statusCode).toBe(503);
        expect(siblingReady.json?.quarantine).toMatchObject({
          quarantined: true,
          reason: "latch_unreadable",
          persistence: "durable_sentinel",
          failureCode: "latch_metadata_unreadable",
        });
        expect(JSON.stringify(siblingReady.json)).not.toContain(fleetDir);
        expect((await postRun(sibling.port, "secret")).statusCode).toBe(503);
        expect(siblingRuns.count).toBe(0);
      } finally {
        await detector.close();
        await sibling.close();
      }

      // A new process has no in-memory quarantine state; the sentinel alone
      // must still refuse admission after restart.
      const restarted = await createRemoteServer(
        {
          host: "127.0.0.1",
          port: 0,
          token: "secret",
          logger: () => {},
          attachOnly: false,
          accountId: "acct2",
        },
        {
          runBrowser: async () => {
            siblingRuns.count += 1;
            return MINIMAL_RESULT;
          },
        },
      );
      try {
        expect((await getJson(restarted.port, "/ready", "secret")).statusCode).toBe(503);
        expect((await postRun(restarted.port, "secret")).statusCode).toBe(503);
        expect(siblingRuns.count).toBe(0);
      } finally {
        await restarted.close();
      }
    },
  );

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "a failure before final-path publication hard-stops locally without leaking storage details",
    async () => {
      const { fleetDir } = await isolatedDirs();
      const runs = { count: 0 };
      const logs: string[] = [];
      let tripAttempts = 0;
      const sensitiveFailure = `simulated quarantine disk failure at ${path.join(
        fleetDir,
        "private",
      )}`;
      const server = await createRemoteServer(
        {
          host: "127.0.0.1",
          port: 0,
          token: "secret",
          logger: (message) => logs.push(message),
          attachOnly: false,
          accountId: "acct2",
        },
        {
          runBrowser: async () => {
            runs.count += 1;
            throw new BrowserAutomationError("Cloudflare challenge detected.", {
              stage: "cloudflare-challenge",
            });
          },
          tripQuarantine: async (input) => {
            tripAttempts += 1;
            if (tripAttempts === 1) {
              throw new Error(sensitiveFailure);
            }
            return tripQuarantineLatch({ ...input, dir: fleetDir });
          },
        },
      );

      try {
        const failed = await postRun(server.port, "secret");
        const events = failed.body
          .split("\n")
          .filter((line) => line.trim().length > 0)
          .map((line) => JSON.parse(line) as Record<string, unknown>);
        expect(events[events.length - 1]).toMatchObject({
          type: "done",
          ok: false,
          errorClass: "account_quarantine",
          retryable: false,
          provenance: { challengeClean: false },
        });
        expect(
          (await getQuarantineLatchState({ accountId: "acct2", dir: fleetDir })).quarantined,
        ).toBe(false);
        expect(logs.join("\n")).toContain("hard-stopped in memory (code=storage_unavailable)");
        expect(logs.join("\n")).not.toContain(sensitiveFailure);

        const ready = await getJson(server.port, "/ready", "secret");
        expect(ready.statusCode).toBe(503);
        const quarantine = ready.json?.quarantine as Record<string, unknown>;
        expect(quarantine).toMatchObject({
          quarantined: true,
          reason: "verification_interstitial",
          source: "remote-terminal-gate",
          persistence: "process_local_fallback",
          failureCode: "storage_unavailable",
        });
        expect(JSON.stringify(ready.json)).not.toContain(sensitiveFailure);
        expect(JSON.stringify(ready.json)).not.toContain(fleetDir);
        expect(quarantine).not.toHaveProperty("persistenceFailure");
        expect(quarantine).not.toHaveProperty("latchPath");
        expect(quarantine).not.toHaveProperty("readError");

        const refused = await postRun(server.port, "secret");
        expect(refused.statusCode).toBe(503);
        expect((JSON.parse(refused.body) as Record<string, unknown>).error).toBe(
          "account_quarantined",
        );
        expect(refused.body).not.toContain(sensitiveFailure);
        expect(refused.body).not.toContain(fleetDir);
        expect(runs.count).toBe(1);
        // Storage is now healthy, but admission never retries publication or
        // clears the process-local hard stop implicitly.
        expect(tripAttempts).toBe(1);
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

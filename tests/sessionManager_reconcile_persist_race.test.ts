// Regression tests for the reconcile-persist race (oracle-router-ob9 #1):
// listSessionsMetadata (oracle status/list) reconciles every session with
// persist:true. The dead-browser / zombie downgrade used to write meta.json
// (and models/*.json) with a RAW atomicWriteFileUtf8 that bypassed both the
// per-session lock and the stat-fingerprint optimistic-concurrency guard, so
// a reader process could clobber a concurrently-completing runner's terminal
// state. Reconcile persistence now flows through updateSessionMetadata (lock
// + OCC), which re-derives the downgrade against the freshest on-disk state.
//
// The same file also covers the bounded-concurrency listing (perf-io-remote
// #2): entries are reconciled in parallel but the output stays complete and
// newest-first.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { setOracleHomeDirOverrideForTest } from "../src/oracleHome.js";

type SessionModule = typeof import("../src/sessionManager.ts");
type SessionMetadata = Awaited<ReturnType<SessionModule["initializeSession"]>>;

let sessionModule: SessionModule;
let oracleHomeDir: string;

beforeAll(async () => {
  oracleHomeDir = await mkdtemp(path.join(os.tmpdir(), "oracle-reconcile-persist-race-"));
  setOracleHomeDirOverrideForTest(oracleHomeDir);
  sessionModule = await import("../src/sessionManager.ts");
  await sessionModule.ensureSessionStorage();
});

beforeEach(async () => {
  await rm(sessionModule.getSessionsDir(), { recursive: true, force: true });
  await sessionModule.ensureSessionStorage();
});

afterAll(async () => {
  await rm(oracleHomeDir, { recursive: true, force: true });
  setOracleHomeDirOverrideForTest(null);
});

async function readStoredMeta(sessionId: string): Promise<SessionMetadata> {
  const raw = await readFile(
    path.join(sessionModule.getSessionsDir(), sessionId, "meta.json"),
    "utf8",
  );
  return JSON.parse(raw) as SessionMetadata;
}

describe("listSessionsMetadata reconcile-persist concurrency", () => {
  test("reconcile never clobbers a runner's concurrent terminal completion", async () => {
    const artifacts = [{ kind: "transcript" as const, path: "transcript.md" }];
    for (let iteration = 0; iteration < 25; iteration += 1) {
      const meta = await sessionModule.initializeSession(
        { prompt: `reconcile race ${iteration}`, model: "gpt-5.2-pro", mode: "browser" },
        "/tmp/cwd",
      );
      // Mark it running with a dead (but locally-refusing, so fast to probe)
      // Chrome so reconcile wants to downgrade it to 'error'.
      await sessionModule.updateSessionMetadata(meta.id, {
        status: "running",
        mode: "browser",
        startedAt: new Date().toISOString(),
        browser: { runtime: { chromePid: 999999, chromePort: 1, chromeHost: "127.0.0.1" } },
      });

      // Race the reconcile (via listSessionsMetadata) against the session's
      // own runner transitioning it to a terminal 'completed' with artifacts.
      await Promise.all([
        sessionModule.listSessionsMetadata(),
        sessionModule.updateSessionMetadata(meta.id, {
          status: "completed",
          completedAt: "2026-07-10T00:00:00.000Z",
          artifacts,
        }),
      ]);

      const stored = await readStoredMeta(meta.id);
      // Post-fix the runner's authoritative terminal state always survives:
      // reconcile either reads the fresh 'completed' (no downgrade) or the OCC
      // guard re-derives against it. Pre-fix the unlocked raw write reverted
      // it to a bare 'error' and dropped the artifacts.
      expect(stored.status).toBe("completed");
      expect(stored.artifacts).toEqual(artifacts);
      expect(stored.models?.[0]?.status).toBe("completed");

      await rm(path.join(sessionModule.getSessionsDir(), meta.id), {
        recursive: true,
        force: true,
      });
    }
  });

  test("reconcile-persist of a dead browser session writes error via the guarded path", async () => {
    const meta = await sessionModule.initializeSession(
      { prompt: "dead browser reconcile", model: "gpt-5.2-pro", mode: "browser" },
      "/tmp/cwd",
    );
    await sessionModule.updateSessionMetadata(meta.id, {
      status: "running",
      mode: "browser",
      browser: { runtime: { chromePid: 999999, chromePort: 1, chromeHost: "127.0.0.1" } },
    });

    const listed = await sessionModule.listSessionsMetadata();
    const found = listed.find((entry) => Object.is(entry.id, meta.id));
    expect(found?.status).toBe("error");
    expect(found?.models?.[0]?.status).toBe("error");

    // The guarded path persisted both meta.json and the model JSON, and left
    // no atomic-write / lock litter behind.
    const stored = await readStoredMeta(meta.id);
    expect(stored.status).toBe("error");
    const names = await readdir(path.join(sessionModule.getSessionsDir(), meta.id));
    expect(names.filter((name) => name.includes(".tmp-") || name.endsWith(".lock"))).toEqual([]);
  });
});

describe("listSessionsMetadata bounded-concurrency reconciliation", () => {
  test("lists every session newest-first without dropping or reordering", async () => {
    const created: string[] = [];
    for (let index = 0; index < 20; index += 1) {
      const meta = await sessionModule.initializeSession(
        { prompt: `list order ${index}`, model: "gpt-5.2-pro", slug: `list order case ${index}` },
        "/tmp/cwd",
      );
      created.push(meta.id);
      // Distinct, strictly increasing createdAt so newest-first is unambiguous.
      await sessionModule.updateSessionMetadata(meta.id, {
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
      });
    }

    const listed = await sessionModule.listSessionsMetadata();
    expect(listed).toHaveLength(created.length);
    // Build the newest-first expectation without Array#reverse (mutating) or
    // Array#toReversed (newer than this repo's TS lib target).
    const expectedNewestFirst: string[] = [];
    for (const id of created) {
      expectedNewestFirst.unshift(id);
    }
    expect(listed.map((entry) => entry.id)).toEqual(expectedNewestFirst);
  });
});

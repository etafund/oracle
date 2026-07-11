// Regression tests for the prune liveness guard (oracle-router-ob9 #2):
// deleteSessionsOlderThan / `oracle session --clear --hours N` deleted purely
// by createdAt age with no running/alive guard, so an in-flight paid run
// older than the window (or any run under `--hours 0`) had its directory
// fs.rm'd out from under the live process. A windowed clear now skips any
// session that reconciliation still reports as running-and-alive, counts them
// in `skippedActive`, and notes each skip on stderr. The explicit full wipe
// (`--all`) is still honored.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { setOracleHomeDirOverrideForTest } from "../src/oracleHome.js";

type SessionModule = typeof import("../src/sessionManager.ts");

let sessionModule: SessionModule;
let oracleHomeDir: string;

beforeAll(async () => {
  oracleHomeDir = await mkdtemp(path.join(os.tmpdir(), "oracle-prune-liveness-"));
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

describe("deleteSessionsOlderThan liveness guard", () => {
  test("windowed clear skips a live running session, deletes terminal ones, and notes it on stderr", async () => {
    const live = await sessionModule.initializeSession(
      { prompt: "live run", model: "gpt-5.2-pro", mode: "browser" },
      "/tmp/cwd",
    );
    // Running with a reachable Chrome (this process's own PID is alive), so
    // reconciliation keeps it 'running'.
    await sessionModule.updateSessionMetadata(live.id, {
      status: "running",
      mode: "browser",
      browser: { runtime: { chromePid: process.pid } },
    });

    const done = await sessionModule.initializeSession(
      { prompt: "finished run", model: "gpt-5.2-pro" },
      "/tmp/cwd",
    );
    await sessionModule.updateSessionMetadata(done.id, {
      status: "completed",
      completedAt: new Date().toISOString(),
    });

    // Capture the stderr note directly (vitest manages process.stderr, so a
    // plain method swap is the reliable way to observe writes).
    const notes: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: unknown) => {
      if (typeof chunk === "string") {
        notes.push(chunk);
      }
      return true;
    }) as typeof process.stderr.write;
    let result: Awaited<ReturnType<SessionModule["deleteSessionsOlderThan"]>>;
    try {
      // hours: 0 makes the cutoff "now", so both sessions are older than it.
      result = await sessionModule.deleteSessionsOlderThan({ hours: 0 });
    } finally {
      process.stderr.write = originalWrite;
    }

    expect(result.skippedActive).toBe(1);
    expect(result.sessions.map((session) => session.id)).toEqual([done.id]);
    expect(notes.some((note) => note.includes(live.id))).toBe(true);

    expect(await sessionModule.readSessionMetadata(live.id)).not.toBeNull();
    expect(await sessionModule.readSessionMetadata(done.id)).toBeNull();
  });

  test("a dead browser run (reconciled to error) is not protected", async () => {
    const dead = await sessionModule.initializeSession(
      { prompt: "dead run", model: "gpt-5.2-pro", mode: "browser" },
      "/tmp/cwd",
    );
    await sessionModule.updateSessionMetadata(dead.id, {
      status: "running",
      mode: "browser",
      browser: { runtime: { chromePid: 999999, chromePort: 1, chromeHost: "127.0.0.1" } },
    });

    const result = await sessionModule.deleteSessionsOlderThan({ hours: 0 });

    expect(result.skippedActive).toBe(0);
    expect(result.sessions.map((session) => session.id)).toEqual([dead.id]);
    expect(await sessionModule.readSessionMetadata(dead.id)).toBeNull();
  });

  test("an explicit full wipe (includeAll) still removes a live running session", async () => {
    const live = await sessionModule.initializeSession(
      { prompt: "live wipe", model: "gpt-5.2-pro", mode: "browser" },
      "/tmp/cwd",
    );
    await sessionModule.updateSessionMetadata(live.id, {
      status: "running",
      mode: "browser",
      browser: { runtime: { chromePid: process.pid } },
    });

    const result = await sessionModule.deleteSessionsOlderThan({ includeAll: true });

    expect(result.skippedActive).toBe(0);
    expect(result.sessions.map((session) => session.id)).toEqual([live.id]);
    expect(await sessionModule.readSessionMetadata(live.id)).toBeNull();
  });
});

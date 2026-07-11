// Regression tests for the residual updateSessionMetadata write window
// (oracle-router-ob9 #4): the optimistic-concurrency guard re-stats meta.json
// before writing, but the check and persistSessionMetadata's rename are two
// separate syscalls, leaving a sub-millisecond TOCTOU window. A cross-process
// advisory sentinel (an O_EXCL `meta.json.lock`) is now held only around the
// re-stat + rename to close that window for cooperating writers. The lock is
// reclaimed if its holder crashed and is never left behind.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { setOracleHomeDirOverrideForTest } from "../src/oracleHome.js";

type SessionModule = typeof import("../src/sessionManager.ts");
type SessionMetadata = Awaited<ReturnType<SessionModule["initializeSession"]>>;

let sessionModule: SessionModule;
let oracleHomeDir: string;

beforeAll(async () => {
  oracleHomeDir = await mkdtemp(path.join(os.tmpdir(), "oracle-meta-lock-"));
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

describe("updateSessionMetadata cross-process meta lock", () => {
  test("accepts an async updater and applies its patch", async () => {
    const meta = await sessionModule.initializeSession(
      { prompt: "async updater", model: "gpt-5.2-pro" },
      "/tmp/cwd",
    );

    const updated = await sessionModule.updateSessionMetadata(meta.id, async (current) => {
      await sessionModule.wait(1);
      return { status: "completed", promptPreview: `${current.promptPreview ?? ""}!` };
    });

    expect(updated.status).toBe("completed");
    const stored = await readStoredMeta(meta.id);
    expect(stored.status).toBe("completed");
    expect(stored.promptPreview?.endsWith("!")).toBe(true);
  });

  test("reclaims a stale lock left by a dead process instead of hanging", async () => {
    const meta = await sessionModule.initializeSession(
      { prompt: "stale lock", model: "gpt-5.2-pro" },
      "/tmp/cwd",
    );
    const lockPath = path.join(sessionModule.getSessionsDir(), meta.id, "meta.json.lock");
    // Simulate a crashed holder: a sentinel owned by a PID that is not alive.
    await writeFile(lockPath, "999999", "utf8");

    const updated = await sessionModule.updateSessionMetadata(meta.id, { status: "completed" });

    expect(updated.status).toBe("completed");
    // The stale sentinel was reclaimed and released, not left behind.
    await expect(stat(lockPath)).rejects.toThrow();
  });

  test("leaves no lock or tmp litter after a successful update", async () => {
    const meta = await sessionModule.initializeSession(
      { prompt: "clean lock", model: "gpt-5.2-pro" },
      "/tmp/cwd",
    );

    await sessionModule.updateSessionMetadata(meta.id, { status: "completed" });

    const dir = path.join(sessionModule.getSessionsDir(), meta.id);
    const names = await readdir(dir);
    expect(names.filter((name) => name.includes(".tmp-") || name.endsWith(".lock"))).toEqual([]);
  });

  test("serialized concurrent updates keep every field under the lock", async () => {
    const meta = await sessionModule.initializeSession(
      { prompt: "lock serialize", model: "gpt-5.2-pro", mode: "browser" },
      "/tmp/cwd",
    );

    await Promise.all([
      sessionModule.updateSessionMetadata(meta.id, {
        status: "completed",
        completedAt: "2026-07-10T00:00:00.000Z",
      }),
      sessionModule.updateSessionMetadata(meta.id, async () => {
        await sessionModule.wait(1);
        return { browser: { harvest: { assistantHash: "abc123", state: "completed" } } };
      }),
      sessionModule.updateSessionMetadata(meta.id, { promptPreview: "locked preview" }),
    ]);

    const stored = await readStoredMeta(meta.id);
    expect(stored.status).toBe("completed");
    expect(stored.completedAt).toBe("2026-07-10T00:00:00.000Z");
    expect(stored.browser?.harvest?.assistantHash).toBe("abc123");
    expect(stored.promptPreview).toBe("locked preview");
  });
});

// Regression tests: unlocked read-modify-write on session meta.json used
// to cause lost updates under supported concurrent access (a background
// runner progressing a session while `oracle session <id> --live/--harvest`
// persists harvest state from a second process). updateSessionMetadata now
// serializes in-process callers on a per-session lock and guards the
// cross-process window with a stat-fingerprint optimistic-concurrency
// check (retry with a fresh read; fail loud after repeated conflicts).
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { writeFileSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { setOracleHomeDirOverrideForTest } from "../src/oracleHome.js";

type SessionModule = typeof import("../src/sessionManager.ts");
type SessionMetadata = Awaited<ReturnType<SessionModule["initializeSession"]>>;

let sessionModule: SessionModule;
let oracleHomeDir: string;

beforeAll(async () => {
  oracleHomeDir = await mkdtemp(path.join(os.tmpdir(), "oracle-meta-lost-update-"));
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

describe("session meta.json concurrent update safety", () => {
  test("in-process concurrent updates are serialized and no field is lost", async () => {
    const meta = await sessionModule.initializeSession(
      { prompt: "Concurrent updates", model: "gpt-5.2-pro", mode: "browser" },
      "/tmp/cwd",
    );

    await Promise.all([
      sessionModule.updateSessionMetadata(meta.id, {
        status: "completed",
        completedAt: "2026-07-05T00:00:00.000Z",
      }),
      sessionModule.updateSessionMetadata(meta.id, {
        browser: { harvest: { assistantHash: "abc123", state: "completed" } },
      }),
      sessionModule.updateSessionMetadata(meta.id, {
        promptPreview: "updated preview",
      }),
    ]);

    const stored = await readStoredMeta(meta.id);
    expect(stored.status).toBe("completed");
    expect(stored.completedAt).toBe("2026-07-05T00:00:00.000Z");
    expect(stored.browser?.harvest?.assistantHash).toBe("abc123");
    expect(stored.promptPreview).toBe("updated preview");
  });

  test("an external writer landing between read and write is re-merged, not silently reverted", async () => {
    // Repro shape: the runner process transitions the session to
    // status:'completed' with new artifacts while a harvester process is
    // mid read-modify-write. The harvester's stale-based write used to
    // blindly overwrite meta.json and revert the terminal state.
    const meta = await sessionModule.initializeSession(
      { prompt: "External writer race", model: "gpt-5.2-pro", mode: "browser" },
      "/tmp/cwd",
    );
    const { metadata: metadataPath, dir: sessionDirPath } = await sessionModule.getSessionPaths(
      meta.id,
    );

    let updaterCalls = 0;
    const updated = await sessionModule.updateSessionMetadata(meta.id, (current) => {
      updaterCalls += 1;
      if (updaterCalls === 1) {
        // Simulate the concurrent runner process replacing meta.json
        // after our read but before our write.
        const runnerVersion = {
          ...current,
          status: "completed",
          completedAt: "2026-07-05T01:02:03.000Z",
          artifacts: [{ kind: "transcript", path: "transcript.md" }],
        };
        writeFileSync(metadataPath, JSON.stringify(runnerVersion, null, 2), "utf8");
      }
      return {
        browser: {
          ...(current.browser ?? {}),
          harvest: { assistantHash: "deadbeef", state: "completed" },
        },
      };
    });

    // The conflict must have been detected and the patch re-applied to
    // the runner's fresher state.
    expect(updaterCalls).toBeGreaterThan(1);
    expect(updated.status).toBe("completed");
    expect(updated.completedAt).toBe("2026-07-05T01:02:03.000Z");
    expect(updated.artifacts).toEqual([{ kind: "transcript", path: "transcript.md" }]);
    expect(updated.browser?.harvest?.assistantHash).toBe("deadbeef");

    const stored = await readStoredMeta(meta.id);
    expect(stored.status).toBe("completed");
    expect(stored.artifacts).toEqual([{ kind: "transcript", path: "transcript.md" }]);
    expect(stored.browser?.harvest?.assistantHash).toBe("deadbeef");

    // Atomic tmp-then-rename writes must not leave litter behind.
    const leftovers = (await readdir(sessionDirPath)).filter((name) => name.includes(".tmp-"));
    expect(leftovers).toEqual([]);
  });

  test("fails loud instead of clobbering when the file keeps changing under us", async () => {
    const meta = await sessionModule.initializeSession(
      { prompt: "Persistent conflict", model: "gpt-5.2-pro", mode: "browser" },
      "/tmp/cwd",
    );
    const { metadata: metadataPath } = await sessionModule.getSessionPaths(meta.id);

    let updaterCalls = 0;
    await expect(
      sessionModule.updateSessionMetadata(meta.id, (current) => {
        updaterCalls += 1;
        // An external writer wins the race on every attempt (content size
        // varies so the stat fingerprint always changes).
        const externalVersion = {
          ...current,
          promptPreview: `external-${"x".repeat(updaterCalls)}`,
        };
        writeFileSync(metadataPath, JSON.stringify(externalVersion, null, 2), "utf8");
        return { status: "completed" };
      }),
    ).rejects.toThrow(/changing concurrently/);
    expect(updaterCalls).toBe(5);

    // The external writer's last version must have survived untouched.
    const stored = await readStoredMeta(meta.id);
    expect(stored.status).toBe("pending");
    expect(stored.promptPreview).toMatch(/^external-/);
  });
});

// Regression tests for the residual updateSessionMetadata write window
// (oracle-router-ob9 #4): the optimistic-concurrency guard re-stats meta.json
// before writing, but the check and persistSessionMetadata's rename are two
// separate syscalls, leaving a sub-millisecond TOCTOU window. A per-session
// SQLite BEGIN IMMEDIATE transaction is held around the re-stat + rename to
// close that window for cooperating writers. SQLite releases the OS lock when
// a holder exits, so recovery never needs an unlink-based stale-lock reaper.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { execFile, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { setOracleHomeDirOverrideForTest } from "../src/oracleHome.js";

type SessionModule = typeof import("../src/sessionManager.ts");
type SessionMetadata = Awaited<ReturnType<SessionModule["initializeSession"]>>;

let sessionModule: SessionModule;
let oracleHomeDir: string;
const execFileAsync = promisify(execFile);
const oracleHomeModuleUrl = new URL("../src/oracleHome.ts", import.meta.url).href;
const sessionManagerModuleUrl = new URL("../src/sessionManager.ts", import.meta.url).href;

function metadataLockPath(sessionId: string): string {
  return path.join(sessionModule.getSessionsDir(), sessionId, "meta.json.write-lock.sqlite");
}

function childSessionPrelude(): string[] {
  return [
    `const { setOracleHomeDirOverrideForTest } = await import(${JSON.stringify(oracleHomeModuleUrl)});`,
    `const sessionManager = await import(${JSON.stringify(sessionManagerModuleUrl)});`,
    `setOracleHomeDirOverrideForTest(${JSON.stringify(oracleHomeDir)});`,
  ];
}

async function runTsChild(script: string): Promise<void> {
  await execFileAsync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", script],
    {
      cwd: process.cwd(),
      env: process.env,
      maxBuffer: 1024 * 1024,
    },
  );
}

interface ChildHarness {
  child: ChildProcess;
  getStderr: () => string;
  waitForOutput: (needle: string) => Promise<void>;
  waitForExit: () => Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

function spawnTsChild(script: string): ChildHarness {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", script],
    {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer | string) => {
    stdout += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer | string) => {
    stderr += chunk.toString();
  });
  return {
    child,
    getStderr: () => stderr,
    waitForOutput: async (needle: string) => {
      if (stdout.includes(needle)) return;
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          cleanup();
          reject(
            new Error(
              `Timed out waiting for child output ${JSON.stringify(needle)}; stderr=${stderr}`,
            ),
          );
        }, 5_000);
        const onData = () => {
          if (!stdout.includes(needle)) return;
          cleanup();
          resolve();
        };
        const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
          cleanup();
          reject(
            new Error(
              `Child exited before ${JSON.stringify(needle)} (code=${code}, signal=${signal}); stderr=${stderr}`,
            ),
          );
        };
        const cleanup = () => {
          clearTimeout(timeout);
          child.stdout?.off("data", onData);
          child.off("exit", onExit);
        };
        child.stdout?.on("data", onData);
        child.on("exit", onExit);
      });
    },
    waitForExit: async () => {
      if (child.exitCode !== null || child.signalCode !== null) {
        return { code: child.exitCode, signal: child.signalCode };
      }
      return await new Promise((resolve) => {
        child.once("exit", (code, signal) => resolve({ code, signal }));
      });
    },
  };
}

async function waitForFiles(paths: string[]): Promise<void> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const present = await Promise.all(
      paths.map(async (filePath) => {
        try {
          await stat(filePath);
          return true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
          throw error;
        }
      }),
    );
    if (present.every(Boolean)) return;
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for child barrier files: ${paths.join(", ")}`);
    }
    await sessionModule.wait(5);
  }
}

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

describe("updateSessionMetadata cross-process SQLite lease", () => {
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

  test("a process crash releases the lease without stale-lock reclamation", async () => {
    const meta = await sessionModule.initializeSession(
      { prompt: "crashed lease", model: "gpt-5.2-pro" },
      "/tmp/cwd",
    );
    const lockPath = metadataLockPath(meta.id);
    const script = [
      `const { DatabaseSync } = await import("node:sqlite");`,
      `const database = new DatabaseSync(${JSON.stringify(lockPath)}, { timeout: 0 });`,
      `database.exec("BEGIN IMMEDIATE");`,
      `console.log("LEASE_HELD");`,
      `setInterval(() => {}, 1000);`,
    ].join("\n");
    const holder = spawnTsChild(script);
    try {
      await holder.waitForOutput("LEASE_HELD");
      expect(holder.child.kill("SIGKILL")).toBe(true);
      const exit = await holder.waitForExit();
      expect(exit).not.toEqual({ code: 0, signal: null });

      const updated = await sessionModule.updateSessionMetadata(meta.id, {
        status: "completed",
      });
      expect(updated.status).toBe("completed");
    } finally {
      if (holder.child.exitCode === null && holder.child.signalCode === null) {
        holder.child.kill("SIGKILL");
        await holder.waitForExit();
      }
    }
  });

  test("blocks a separate updater until the current lease is released", async () => {
    const meta = await sessionModule.initializeSession(
      { prompt: "cross-process exclusion", model: "gpt-5.2-pro" },
      "/tmp/cwd",
    );
    const database = new DatabaseSync(metadataLockPath(meta.id), { timeout: 0 });
    database.exec("BEGIN IMMEDIATE");
    const script = [
      ...childSessionPrelude(),
      `await sessionManager.updateSessionMetadata(${JSON.stringify(meta.id)}, (current) => {`,
      `  console.log("PATCH_READY");`,
      `  return { promptPreview: \`\${current.promptPreview ?? ""}!child\` };`,
      `});`,
    ].join("\n");
    const updater = spawnTsChild(script);
    try {
      await updater.waitForOutput("PATCH_READY");
      await sessionModule.wait(50);
      expect(updater.child.exitCode).toBeNull();
      expect((await readStoredMeta(meta.id)).promptPreview).not.toContain("!child");

      database.exec("ROLLBACK");
      database.close();
      const exit = await updater.waitForExit();
      expect(exit).toEqual({ code: 0, signal: null });
      expect(updater.getStderr()).toBe("");
      expect((await readStoredMeta(meta.id)).promptPreview).toContain("!child");
    } finally {
      if (database.isOpen) {
        if (database.isTransaction) database.exec("ROLLBACK");
        database.close();
      }
      if (updater.child.exitCode === null && updater.child.signalCode === null) {
        updater.child.kill("SIGKILL");
        await updater.waitForExit();
      }
    }
  });

  test("three contending processes re-read and preserve every disjoint patch", async () => {
    const meta = await sessionModule.initializeSession(
      { prompt: "barrier contention", model: "gpt-5.2-pro", mode: "browser" },
      "/tmp/cwd",
    );
    const dir = path.join(sessionModule.getSessionsDir(), meta.id);
    const gatePath = path.join(dir, "contention.gate");
    const patches = [{ promptPreview: "child-one" }, { elapsedMs: 222 }, { lane: "child-three" }];
    const markerPaths = patches.map((_, index) => path.join(dir, `contention-${index}.ready`));
    const children = patches.map((patch, index) => {
      const script = [
        `const fs = await import("node:fs/promises");`,
        ...childSessionPrelude(),
        `await sessionManager.updateSessionMetadata(${JSON.stringify(meta.id)}, async () => {`,
        `  await fs.writeFile(${JSON.stringify(markerPaths[index])}, "ready");`,
        `  for (;;) {`,
        `    try { await fs.stat(${JSON.stringify(gatePath)}); break; }`,
        `    catch (error) {`,
        `      if (error?.code !== "ENOENT") throw error;`,
        `      await sessionManager.wait(5);`,
        `    }`,
        `  }`,
        `  return ${JSON.stringify(patch)};`,
        `});`,
      ].join("\n");
      return runTsChild(script);
    });

    await waitForFiles(markerPaths);
    await writeFile(gatePath, "go", "utf8");
    await Promise.all(children);

    const stored = await readStoredMeta(meta.id);
    expect(stored.promptPreview).toBe("child-one");
    expect(stored.elapsedMs).toBe(222);
    expect(stored.lane).toBe("child-three");
  });

  test("a corrupt lock database fails closed without changing session bytes", async () => {
    const model = "gpt-5.2-pro";
    const meta = await sessionModule.initializeSession(
      { prompt: "corrupt lock", model },
      "/tmp/cwd",
    );
    const dir = path.join(sessionModule.getSessionsDir(), meta.id);
    const metaFile = path.join(dir, "meta.json");
    const modelFile = path.join(dir, "models", "gpt-5.2-pro.json");
    const lockPath = metadataLockPath(meta.id);
    const corruptBytes = Buffer.from("definitely not a SQLite database\n", "utf8");
    await writeFile(lockPath, corruptBytes);
    const beforeMeta = await readFile(metaFile);
    const beforeModel = await readFile(modelFile);

    await expect(
      sessionModule.updateSessionMetadata(meta.id, {
        status: "completed",
        promptPreview: "must not land",
      }),
    ).rejects.toThrow(/SQLite rejected the lock database/);

    expect(await readFile(metaFile)).toEqual(beforeMeta);
    expect(await readFile(modelFile)).toEqual(beforeModel);
    expect(await readFile(lockPath)).toEqual(corruptBytes);
  });

  test("leaves only the persistent SQLite mutex and no transient lock/tmp litter", async () => {
    const meta = await sessionModule.initializeSession(
      { prompt: "clean lock", model: "gpt-5.2-pro" },
      "/tmp/cwd",
    );

    await sessionModule.updateSessionMetadata(meta.id, { status: "completed" });

    const dir = path.join(sessionModule.getSessionsDir(), meta.id);
    const names = await readdir(dir);
    expect(names).toContain("meta.json.write-lock.sqlite");
    expect(
      names.filter(
        (name) =>
          name.includes(".tmp-") ||
          name.endsWith(".lock") ||
          name.endsWith("-journal") ||
          name.endsWith("-wal") ||
          name.endsWith("-shm"),
      ),
    ).toEqual([]);
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

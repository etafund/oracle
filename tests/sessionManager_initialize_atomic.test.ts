// Regression test for non-atomic session creation (oracle-router-ob9 #3):
// initializeSession wrote meta.json and the per-model JSON files with plain
// fs.writeFile, violating the module's tmp-file + rename "never torn"
// invariant. A concurrent reader (`oracle status --json`) could observe a
// half-written, unparseable meta.json and silently drop the just-created
// session; a crash mid-write left a corrupt file. Creation now uses the same
// atomicWriteFileUtf8 as every other writer.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { setOracleHomeDirOverrideForTest } from "../src/oracleHome.js";

type SessionModule = typeof import("../src/sessionManager.ts");

let sessionModule: SessionModule;
let oracleHomeDir: string;

beforeAll(async () => {
  oracleHomeDir = await mkdtemp(path.join(os.tmpdir(), "oracle-initialize-atomic-"));
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

describe("initializeSession atomic creation", () => {
  test("a concurrent reader never observes a torn meta.json during creation", async () => {
    const stop = { done: false };
    let tornReads = 0;
    let goodReads = 0;

    const reader = (async () => {
      while (!stop.done) {
        const dir = sessionModule.getSessionsDir();
        const entries = await readdir(dir).catch(() => []);
        for (const entry of entries) {
          const raw = await readFile(path.join(dir, entry, "meta.json"), "utf8").catch(() => null);
          if (raw === null) {
            continue;
          }
          try {
            JSON.parse(raw);
            goodReads += 1;
          } catch {
            tornReads += 1;
          }
        }
        await new Promise((resolve) => setImmediate(resolve));
      }
    })();

    await Promise.all(
      Array.from({ length: 40 }, (_, index) =>
        sessionModule.initializeSession(
          { prompt: `torn read ${index}`, model: "gpt-5.2-pro", slug: `torn read case ${index}` },
          "/tmp/cwd",
        ),
      ),
    );
    stop.done = true;
    await reader;

    expect(tornReads).toBe(0);
    expect(goodReads).toBeGreaterThan(0);
  });

  test("creation leaves no atomic-write litter in the session or models dir", async () => {
    const created = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        sessionModule.initializeSession(
          {
            prompt: `atomic litter ${index}`,
            model: "gpt-5.2-pro",
            models: ["gpt-5.2-pro", "gemini-3-pro"],
            slug: `atomic litter case ${index}`,
          },
          "/tmp/cwd",
        ),
      ),
    );

    for (const meta of created) {
      const dir = path.join(sessionModule.getSessionsDir(), meta.id);
      const names = await readdir(dir);
      expect(names.filter((name) => name.includes(".tmp-"))).toEqual([]);
      const rawMeta = await readFile(path.join(dir, "meta.json"), "utf8");
      expect(() => JSON.parse(rawMeta)).not.toThrow();

      const modelNames = await readdir(path.join(dir, "models"));
      expect(modelNames.filter((name) => name.includes(".tmp-"))).toEqual([]);
      const rawModel = await readFile(path.join(dir, "models", "gpt-5.2-pro.json"), "utf8");
      expect(() => JSON.parse(rawModel)).not.toThrow();
    }
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { setOracleHomeDirOverrideForTest } from "../src/oracleHome.js";

type SessionModule = typeof import("../src/sessionManager.ts");

let sessionModule: SessionModule;
let oracleHomeDir: string;

beforeAll(async () => {
  oracleHomeDir = await mkdtemp(path.join(os.tmpdir(), "oracle-session-log-writer-race-"));
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

describe("createSessionLogWriter race regression (oracle-6af)", () => {
  test("succeeds when model log dir does not exist yet (no initializeSession)", async () => {
    // Skip initializeSession entirely: this simulates a recovery/resume caller
    // that constructs a writer for a sessionId whose models/ subdir was
    // never created on disk. Pre-fix this raced `void ensureDir(...)` against
    // the lazy fs.open inside createWriteStream and surfaced ENOENT on the
    // stream's 'error' event.
    const sessionId = "race-regression-session";
    const writer = sessionModule.createSessionLogWriter(sessionId, "gpt-5.2-pro");

    const errorPromise = new Promise<Error | null>((resolve) => {
      writer.stream.once("error", (err) => resolve(err));
      writer.stream.once("close", () => resolve(null));
    });

    writer.logLine("race-line-1");
    writer.writeChunk("race-chunk-2");
    writer.stream.end();

    const streamError = await errorPromise;
    expect(streamError).toBeNull();

    const fileStat = await stat(writer.logPath);
    expect(fileStat.isFile()).toBe(true);
    const contents = await readFile(writer.logPath, "utf8");
    expect(contents).toContain("race-line-1");
    expect(contents).toContain("race-chunk-2");
  });

  test("succeeds for non-model log path when session dir does not exist yet", async () => {
    const sessionId = "race-regression-session-no-model";
    const writer = sessionModule.createSessionLogWriter(sessionId);

    const errorPromise = new Promise<Error | null>((resolve) => {
      writer.stream.once("error", (err) => resolve(err));
      writer.stream.once("close", () => resolve(null));
    });

    writer.logLine("session-log-line");
    writer.stream.end();

    const streamError = await errorPromise;
    expect(streamError).toBeNull();

    const contents = await readFile(writer.logPath, "utf8");
    expect(contents).toContain("session-log-line");
  });
});

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_USER_CONFIG,
  loadUserConfig,
  UserConfigParseError,
  UserConfigUnreadableError,
} from "../src/config.js";
import { setOracleHomeDirOverrideForTest } from "../src/oracleHome.js";

describe("loadUserConfig parse error handling", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-config-parse-error-"));
    setOracleHomeDirOverrideForTest(tempDir);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("throws a fatal, actionable error (fail-closed) when the user config cannot be parsed", async () => {
    const configPath = path.join(tempDir, "config.json");
    await fs.writeFile(configPath, `{ engine: "browser", model: `, "utf8");

    // bugs-config-lanes#1: a parse error must NOT silently fall back to
    // DEFAULT_USER_CONFIG (browser + gpt-5.6-sol Pro), which would change the
    // run's billing/routing invisibly to a non-interactive agent.
    await expect(loadUserConfig({ env: {} as NodeJS.ProcessEnv })).rejects.toBeInstanceOf(
      UserConfigParseError,
    );
    await expect(loadUserConfig({ env: {} as NodeJS.ProcessEnv })).rejects.toThrow(
      new RegExp(`Failed to parse the user config at ${escapeRegExp(configPath)}`),
    );
  });

  it("carries the config path on the thrown error for actionable messaging", async () => {
    const configPath = path.join(tempDir, "config.json");
    await fs.writeFile(configPath, `{ engine: browser, }invalid`, "utf8");

    try {
      await loadUserConfig({ env: {} as NodeJS.ProcessEnv });
      throw new Error("expected loadUserConfig to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(UserConfigParseError);
      expect((error as UserConfigParseError).configPath).toBe(configPath);
    }
  });

  it("read-only surfaces degrade to defaults (loud warning) instead of failing hard on a parse error", async () => {
    const configPath = path.join(tempDir, "config.json");
    await fs.writeFile(configPath, `{ engine: "browser", model: `, "utf8");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await loadUserConfig({
      includeProject: false,
      degradeOnUserConfigError: true,
      env: {} as NodeJS.ProcessEnv,
    });

    // Inspection commands stay usable; run-starting paths (degrade flag off)
    // still throw — proven by the fail-closed tests above.
    expect(result.loaded).toBe(false);
    expect(result.config.engine).toBe(DEFAULT_USER_CONFIG.engine);
    expect(warn).toHaveBeenCalled();
  });

  afterAll(() => {
    setOracleHomeDirOverrideForTest(null);
  });
});

describe("loadUserConfig read-error handling (EACCES fail-closed)", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-config-read-error-"));
    setOracleHomeDirOverrideForTest(tempDir);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  afterAll(() => {
    setOracleHomeDirOverrideForTest(null);
  });

  function mockUserConfigReadError(code: string): void {
    vi.spyOn(fs, "readFile").mockRejectedValue(
      Object.assign(new Error(`${code}: mocked unreadable config`), { code }),
    );
  }

  it("throws UserConfigUnreadableError when a PRESENT user config cannot be read (EACCES)", async () => {
    // commit-8 verdict: an unreadable-but-present user config must NOT silently
    // fall back to defaults (billing/routing risk); it is fail-closed like a
    // parse error.
    mockUserConfigReadError("EACCES");
    await expect(
      loadUserConfig({ includeProject: false, env: {} as NodeJS.ProcessEnv }),
    ).rejects.toBeInstanceOf(UserConfigUnreadableError);
  });

  it("keeps ENOTDIR (e.g. a /dev/null sentinel home) as benign-absent, not fatal", async () => {
    mockUserConfigReadError("ENOTDIR");
    const result = await loadUserConfig({ includeProject: false, env: {} as NodeJS.ProcessEnv });
    expect(result.loaded).toBe(false);
    expect(result.config.engine).toBe(DEFAULT_USER_CONFIG.engine);
  });

  it("read-only surfaces degrade to defaults (loud warning) instead of failing hard on EACCES", async () => {
    mockUserConfigReadError("EACCES");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await loadUserConfig({
      includeProject: false,
      degradeOnUserConfigError: true,
      env: {} as NodeJS.ProcessEnv,
    });
    expect(result.loaded).toBe(false);
    expect(result.config.engine).toBe(DEFAULT_USER_CONFIG.engine);
    expect(warn).toHaveBeenCalled();
  });
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

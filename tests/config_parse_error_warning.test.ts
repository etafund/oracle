import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadUserConfig, UserConfigParseError } from "../src/config.js";
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

  afterAll(() => {
    setOracleHomeDirOverrideForTest(null);
  });
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

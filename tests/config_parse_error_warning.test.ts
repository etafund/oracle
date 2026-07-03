import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DEFAULT_USER_CONFIG, loadUserConfig } from "../src/config.js";
import { setOracleHomeDirOverrideForTest } from "../src/oracleHome.js";

describe("loadUserConfig parse error warning", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-config-parse-error-"));
    setOracleHomeDirOverrideForTest(tempDir);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("warns on stderr and falls back to defaults when config parsing fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const configPath = path.join(tempDir, "config.json");
    await fs.writeFile(configPath, `{ engine: "browser", model: `, "utf8");

    const result = await loadUserConfig({ env: {} as NodeJS.ProcessEnv });

    expect(result.loaded).toBe(false);
    // v0.15.0 contract: loadUserConfig always merges onto DEFAULT_USER_CONFIG (browser
    // engine, gpt-5.5-pro, extended thinking), so a parse failure falls back to those
    // defaults rather than an empty object.
    expect(result.config).toEqual(DEFAULT_USER_CONFIG);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(
        new RegExp(
          `^Config file at ${escapeRegExp(configPath)} had a parse error: .+; using defaults$`,
        ),
      ),
    );
  });

  afterAll(() => {
    setOracleHomeDirOverrideForTest(null);
  });
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

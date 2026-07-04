import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { getCliVersion, getOracleBuildInfo, parseOracleBuildInfo } from "../../src/version.js";

const execFileAsync = promisify(execFile);

describe("oracle --version", () => {
  test("prints the package.json version", async () => {
    const cliEntrypoint = path.join(process.cwd(), "bin", "oracle-cli.ts");
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ["--import", "tsx", cliEntrypoint, "--version"],
      {
        // biome-ignore lint/style/useNamingConvention: environment variable name
        env: { ...process.env, FORCE_COLOR: "0", ORACLE_DISABLE_KEYTAR: "1" },
      },
    );
    const output = (stdout.trim() || stderr.trim()).trim();
    expect(output).toBe(getCliVersion());
  }, 30000);

  test("exposes package build provenance without secret-shaped free text", () => {
    const info = getOracleBuildInfo();
    expect(info.schema_version).toBe("oracle_build_provenance.v1");
    expect(info.version).toBe(getCliVersion());
    if (info.commit !== null) {
      expect(info.commit).toMatch(/^[0-9a-f]{40}$/);
    }
    if (info.commit_short !== null) {
      expect(info.commit_short).toMatch(/^[0-9a-f]{7,12}$/);
    }
    expect(info.built_at === null || Number.isFinite(Date.parse(info.built_at))).toBe(true);
  });

  test("parses build provenance defensively", () => {
    const parsed = parseOracleBuildInfo(
      {
        version: "0.15.0",
        commit: "sk-fake-9876543210zyxwvutsrqponm",
        dirty: false,
        built_at: "not a date",
        source: "build-provenance",
      },
      "0.0.0",
    );
    expect(parsed).toMatchObject({
      version: "0.15.0",
      commit: null,
      commit_short: null,
      dirty: false,
      built_at: null,
      source: "build-provenance",
    });
  });
});

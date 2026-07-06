import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { describe, expect, test } from "vitest";

import { listRobotCommands } from "../../src/cli/robotRegistry.js";

const execFileAsync = promisify(execFile);
const CLI_ENTRYPOINT = path.join(process.cwd(), "bin", "oracle-cli.ts");

const LEDGER_ROBOT_COMMANDS = [
  "oracle evidence ledger show <session> --json",
  "oracle evidence ledger verify <session> --json",
  "oracle evidence ledger export <session> --json",
] as const;

describe("hidden alias option-source tracking", () => {
  // Regression: --mode used a source-less setOptionValue, so optionUsesDefault("engine")
  // stayed true and the Gemini Deep Think root route silently forced engine=browser
  // over an explicit --mode api. The alias must behave exactly like --engine.
  test("--mode api is not silently clobbered by the Gemini Deep Think root route", async () => {
    const result = await runOracleAllowFailure([
      "--dry-run",
      "-p",
      "hi",
      "--mode",
      "api",
      "--model",
      "gemini-3-deep-think",
    ]);
    const output = `${result.stdout}\n${result.stderr}`;
    // The explicit engine choice must surface the browser-only conflict (same as
    // --engine api) instead of silently rerouting to the browser engine.
    expect(result.exitCode).toBe(1);
    expect(output).toContain("Gemini Deep Think is browser-only");
    expect(output).not.toContain("browser mode");
  }, 60_000);

  test("--mode api routes to the api engine like --engine api", async () => {
    const result = await runOracleAllowFailure(["--dry-run", "-p", "hi", "--mode", "api"]);
    const output = `${result.stdout}\n${result.stderr}`;
    expect(result.exitCode).toBe(0);
    expect(output).toContain("Route: api/local");
  }, 60_000);
});

describe("bin/oracle-cli robot command routing", () => {
  test("oracle --help lists every robot JSON command", async () => {
    const { stdout, stderr } = await runOracle(["--help"]);
    const output = `${stdout}\n${stderr}`;
    const expectedCommands = [
      ...listRobotCommands().map((entry) => entry.command),
      ...LEDGER_ROBOT_COMMANDS,
    ];

    for (const command of expectedCommands) {
      expect(output).toContain(command);
    }
  });
});

async function runOracleAllowFailure(
  args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const { stdout, stderr } = await runOracle(args);
    return { stdout, stderr, exitCode: 0 };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
      exitCode: typeof failure.code === "number" ? failure.code : 1,
    };
  }
}

async function runOracle(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(process.execPath, ["--import", "tsx", CLI_ENTRYPOINT, ...args], {
    env: {
      ...process.env,
      FORCE_COLOR: "0",
      NO_COLOR: "1",
      ORACLE_DISABLE_KEYTAR: "1",
    },
    timeout: 30_000,
  });
}

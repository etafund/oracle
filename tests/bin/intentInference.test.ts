// Agent-ergonomics Axiom 7 (intent inference): recover from legible-but-
// wrong invocations on the CORE surface instead of silently failing or
// silently auto-running the wrong (potentially costly/dangerous) thing.
//
// Covers:
//   (a) a mistyped core flag -> Levenshtein-1 "did you mean --X?" with
//       the exact corrected command.
//   (c) a mistyped core command name -> "did you mean <cmd>?", refused
//       (never auto-run) instead of silently launching a real lane run
//       with the typo as the prompt text.
// (--lane typo correction is covered in tests/bin/oracle-routing-commands.test.ts.)

import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const CLI_ENTRYPOINT = path.join(process.cwd(), "bin", "oracle-cli.ts");
const TIMEOUT_MS = 30_000;

let oracleHome: string;

beforeEach(async () => {
  // Isolate ORACLE_HOME_DIR per test: these invocations must never reach
  // a live backend, but a fresh scratch home is cheap defense-in-depth
  // against a bug in the pre-parse guards this file pins.
  oracleHome = await mkdtemp(path.join(os.tmpdir(), "oracle-intent-inference-"));
});

afterEach(async () => {
  await rm(oracleHome, { recursive: true, force: true });
});

describe("mistyped core flag (agent-ergonomics Axiom 7a)", () => {
  test("--dry-ru (typo of --dry-run) suggests the flag and the exact corrected command", async () => {
    const { code, stdout, stderr } = await runOracleFailure([
      "--dry-ru",
      "json",
      "-p",
      "hi",
      "--lane",
      "fable-local",
    ]);
    const output = `${stdout}\n${stderr}`;

    expect(code).toBe(1);
    expect(output).toContain("error: unknown option '--dry-ru'");
    expect(output).toContain("(Did you mean --dry-run?)");
    expect(output).toContain("Try: oracle --dry-run json -p hi --lane fable-local");
  });

  test("a flag with no close match falls back to commander's default (no fabricated suggestion)", async () => {
    const { code, stdout, stderr } = await runOracleFailure(["--this-flag-is-not-real-at-all"]);
    const output = `${stdout}\n${stderr}`;

    expect(code).toBe(1);
    expect(output).toContain("error: unknown option '--this-flag-is-not-real-at-all'");
    expect(output).not.toContain("Try: oracle");
  });

  test("a correct invocation (--dry-run itself) is unaffected by the typo-correction wiring", async () => {
    const { stdout, stderr } = await runOracle([
      "--dry-run",
      "json",
      "-p",
      "hi",
      "--lane",
      "fable-local",
    ]);
    const output = `${stdout}\n${stderr}`;

    expect(output).not.toContain("unknown option");
    expect(output).not.toContain("Did you mean");
  });
});

describe("bare single-token positional is refused fail-closed (agent-ergonomics Axiom 7c)", () => {
  // A prompt taken from a bare positional that is a single whitespace-free
  // token is almost always a mistyped command, not a prompt. The guard now
  // FAILS CLOSED (exit 2) for any such token — closing the earlier fail-open
  // hole where `oracle lanes` still launched a paid reviewed-lane run — with
  // the Levenshtein "did you mean" as an added hint, never the gate.
  test("a bare one-word typo of 'status' is refused (exit 2) with a 'did you mean' hint, never auto-run", async () => {
    const { code, stdout, stderr } = await runOracleFailure(["statuss"]);
    const output = `${stdout}\n${stderr}`;

    expect(code).toBe(2);
    expect(output).toContain("'statuss' is not a recognized command");
    expect(output).toContain("Did you mean: oracle status");
    expect(output).toContain("oracle -p statuss");
    // The dangerous behavior this guards against: silently treating the
    // token as prompt text and launching a real reviewed-lane run.
    expect(output).not.toContain("Launching browser mode");
    expect(output).not.toContain("Session:");
  });

  test("a bare one-word typo of 'doctor' is refused (exit 2) with a 'did you mean' hint", async () => {
    const { code, stdout, stderr } = await runOracleFailure(["doctorr"]);
    const output = `${stdout}\n${stderr}`;

    expect(code).toBe(2);
    expect(output).toContain("'doctorr' is not a recognized command");
    expect(output).toContain("Did you mean: oracle doctor");
  });

  test.each(["lanes", "models", "login"])(
    "`oracle %s` (no -p) is refused fail-closed and never starts a run",
    async (token) => {
      const { code, stdout, stderr } = await runOracleFailure([token]);
      const output = `${stdout}\n${stderr}`;

      expect(code).toBe(2);
      expect(output).toContain(`oracle -p ${token}`);
      expect(output).not.toContain("Launching browser mode");
      expect(output).not.toContain("Session:");
    },
  );

  test("`oracle lanes --json` is refused fail-closed (accompanying flags do not reopen the hole)", async () => {
    const { code, stdout } = await runOracleFailure(["lanes", "--json"]);
    const envelope = JSON.parse(stdout.trim()) as {
      ok: boolean;
      blocked_reason: string;
      fix_command: string | null;
      meta: { exit_code?: number };
    };

    expect(code).toBe(2);
    expect(envelope.ok).toBe(false);
    expect(envelope.blocked_reason).toBe("prompt_looks_like_command");
    expect(envelope.fix_command).toContain("oracle -p lanes");
    expect(envelope.meta.exit_code).toBe(2);
  });

  test("a single-word prompt passed via -p still works (the guard only gates bare positionals)", async () => {
    // runOracle rejects on any nonzero exit, so a clean resolve proves exit 0.
    const { stdout, stderr } = await runOracle([
      "-p",
      "lanes",
      "--dry-run",
      "json",
      "--lane",
      "fable-local",
    ]);
    const output = `${stdout}\n${stderr}`;

    expect(output).not.toContain("is not a recognized command");
    expect(output).not.toContain("refusing to start a run");
  });

  test("a multi-word bare positional prompt is not blocked (contains whitespace)", async () => {
    const { stdout, stderr } = await runOracle([
      "explain this codebase",
      "--dry-run",
      "json",
      "--lane",
      "fable-local",
    ]);
    const output = `${stdout}\n${stderr}`;

    expect(output).not.toContain("refusing to start a run");
  });

  test("--help is unaffected by the bare-positional guard", async () => {
    const { stdout, stderr } = await runOracle(["--help"]);
    const output = `${stdout}\n${stderr}`;

    expect(output).toContain("Usage: oracle");
    expect(output).not.toContain("is not a recognized command");
  });
});

interface ExecFailure extends Error {
  stdout?: string | Buffer;
  stderr?: string | Buffer;
  code?: number | string | null;
}

async function runOracle(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(process.execPath, ["--import", "tsx", CLI_ENTRYPOINT, ...args], {
    env: {
      ...process.env,
      FORCE_COLOR: "0",
      NO_COLOR: "1",
      ORACLE_DISABLE_KEYTAR: "1",
      ORACLE_HOME_DIR: oracleHome,
    },
    timeout: TIMEOUT_MS,
  });
}

async function runOracleFailure(
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await runOracle(args);
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as ExecFailure;
    const parsedCode =
      typeof failure.code === "number" ? failure.code : Number.parseInt(String(failure.code), 10);
    return {
      code: Number.isFinite(parsedCode) ? parsedCode : 1,
      stdout: String(failure.stdout ?? ""),
      stderr: String(failure.stderr ?? ""),
    };
  }
}

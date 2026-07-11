import { spawn } from "node:child_process";
import path from "node:path";

import { describe, expect, test } from "vitest";

// Regression for oracle-router-h64: `oracle --help | head` used to throw an
// unhandled 'error' EPIPE from commander's writeOut and dump a full Node
// stack trace with a nonzero exit. Agents pipe Oracle into head/grep/jq
// constantly, so a closed-early downstream pipe must be a clean, silent
// exit 0 with no stack trace.

const CLI_ENTRYPOINT = path.join(process.cwd(), "bin", "oracle-cli.ts");

const CHILD_ENV = {
  ...process.env,
  FORCE_COLOR: "0",
  NO_COLOR: "1",
  ORACLE_DISABLE_KEYTAR: "1",
};

interface ClosedStdoutRun {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
}

/**
 * Spawn the CLI, then destroy the parent's read end of its stdout pipe so the
 * child's very first write to stdout hits EPIPE — the exact condition
 * `| head` creates, but deterministic (no dependence on output size vs. the
 * pipe buffer).
 */
function runWithStdoutClosedEarly(args: string[]): Promise<ClosedStdoutRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", CLI_ENTRYPOINT, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env: CHILD_ENV,
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    // Swallow the parent-side EPIPE/ECONNRESET that destroying the read end raises here.
    child.stdout.on("error", () => undefined);
    child.on("error", reject);
    child.on("spawn", () => {
      // Close the read end before the child produces its (help) output.
      child.stdout.destroy();
    });
    child.on("exit", (code, signal) => {
      resolve({ code, signal, stderr });
    });
  });
}

describe("oracle CLI EPIPE handling (oracle-router-h64)", () => {
  test("--help with stdout closed early exits 0 and prints no stack trace", async () => {
    const result = await runWithStdoutClosedEarly(["--help"]);
    expect(result.signal).toBeNull();
    expect(result.code).toBe(0);
    expect(result.stderr).not.toMatch(/EPIPE/);
    expect(result.stderr).not.toMatch(/\n\s+at\s/); // no Node stack frames
  }, 60_000);

  test("status --json with stdout closed early exits 0 and prints no stack trace", async () => {
    const result = await runWithStdoutClosedEarly(["status", "--json"]);
    expect(result.signal).toBeNull();
    expect(result.code).toBe(0);
    expect(result.stderr).not.toMatch(/EPIPE/);
    expect(result.stderr).not.toMatch(/\n\s+at\s/);
  }, 60_000);
});

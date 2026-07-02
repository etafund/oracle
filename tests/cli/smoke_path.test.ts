// Regression test for oracle-ghf: `node bin/oracle-cli.js --help`
// must work for the integration smoke scripts that pane 2 documented.
//
// Pre-fix, this path failed with MODULE_NOT_FOUND because the source
// tree only had `bin/oracle-cli.ts`. The fix is a small ESM shim
// (bin/oracle-cli.js) that spawns the TS entrypoint via `--import tsx`.

import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(moduleDir, "../..");
const CLI_JS = path.join(REPO_ROOT, "bin", "oracle-cli.js");

// Long enough for `--import tsx` to compile the source on a slow CI
// runner. The CLI's `--help` and `--version` paths themselves are
// near-instant; the cost is purely tsx's initial compile.
const TIMEOUT_MS = 30_000;

interface InvocationResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function runCli(args: readonly string[]): Promise<InvocationResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_JS, ...args], {
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout.on("data", (b: Buffer) => stdoutChunks.push(b));
    child.stderr.on("data", (b: Buffer) => stderrChunks.push(b));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`oracle CLI smoke command timed out after ${TIMEOUT_MS}ms`));
    }, TIMEOUT_MS);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        exitCode: code ?? -1,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
      });
    });
  });
}

async function runCliWithEnv(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<InvocationResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_JS, ...args], {
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout.on("data", (b: Buffer) => stdoutChunks.push(b));
    child.stderr.on("data", (b: Buffer) => stderrChunks.push(b));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`oracle CLI smoke command timed out after ${TIMEOUT_MS}ms`));
    }, TIMEOUT_MS);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        exitCode: code ?? -1,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
      });
    });
  });
}

describe("bin/oracle-cli.js — source smoke entrypoint", () => {
  test("the .js shim file is checked in at bin/oracle-cli.js", async () => {
    await expect(access(CLI_JS, constants.R_OK)).resolves.toBeUndefined();
  });

  test(
    "`node bin/oracle-cli.js --help` exits 0 and prints help",
    async () => {
      const result = await runCli(["--help"]);
      expect(result.exitCode, `stderr: ${result.stderr}`).toBe(0);
      // The help banner has the oracle emoji and the standard
      // "Usage:" / "Options:" sections.
      const out = result.stdout + result.stderr;
      expect(out.toLowerCase()).toContain("usage:");
      // Help should name at least one of the commands users invoke.
      expect(out).toMatch(/\b(status|tui|session|serve)\b/);
    },
    TIMEOUT_MS,
  );

  test(
    "`node bin/oracle-cli.js --version` exits 0 and prints a semver",
    async () => {
      const result = await runCli(["--version"]);
      expect(result.exitCode, `stderr: ${result.stderr}`).toBe(0);
      expect(result.stdout.trim()).toMatch(/\d+\.\d+\.\d+/);
    },
    TIMEOUT_MS,
  );

  test(
    "`node bin/oracle-cli.js status --help` exits 0 (sub-command help works)",
    async () => {
      const result = await runCli(["status", "--help"]);
      expect(result.exitCode, `stderr: ${result.stderr}`).toBe(0);
      const out = result.stdout + result.stderr;
      expect(out.toLowerCase()).toContain("usage:");
    },
    TIMEOUT_MS,
  );

  test(
    "`node bin/oracle-cli.js remote doctor --help` exits 0 (robot subcommand help works)",
    async () => {
      // Per oracle-ghf acceptance: root AND robot-subcommand help must
      // work through the chosen entrypoint. `oracle remote doctor` is
      // a v18 robot surface added in oracle-94o.
      const result = await runCli(["remote", "doctor", "--help"]);
      expect(result.exitCode, `stderr: ${result.stderr}`).toBe(0);
      const out = result.stdout + result.stderr;
      expect(out.toLowerCase()).toMatch(/usage:|--json/);
    },
    TIMEOUT_MS,
  );

  test(
    "`node bin/oracle-cli.js remote status --json` prints parseable JSON without an intro banner",
    async () => {
      const result = await runCliWithEnv(["remote", "status", "--json"], {
        ...process.env,
        NO_COLOR: "1",
        FORCE_COLOR: "0",
      });
      expect([0, 1]).toContain(result.exitCode);
      expect(result.stdout.trim().startsWith("{"), result.stdout).toBe(true);
      const parsed = JSON.parse(result.stdout);
      expect(parsed._schema).toBe("remote_browser_endpoint.v1");
    },
    TIMEOUT_MS,
  );

  test(
    "`node bin/oracle-cli.js remote attach --json` prints a clean endpoint report when token is missing",
    async () => {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        NO_COLOR: "1",
        FORCE_COLOR: "0",
      };
      delete env.ORACLE_REMOTE_TOKEN;
      const result = await runCliWithEnv(
        ["remote", "attach", "--host", "127.0.0.1:9470", "--json"],
        env,
      );
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout.trim().startsWith("{"), result.stdout).toBe(true);
      const parsed = JSON.parse(result.stdout);
      expect(parsed._schema).toBe("remote_browser_endpoint.v1");
      expect(parsed.status).toBe("missing_token");
      expect(parsed.no_plaintext_secrets).toBe(true);
    },
    TIMEOUT_MS,
  );

  test(
    "exit code propagates from the underlying CLI (unknown command → non-zero)",
    async () => {
      const result = await runCli(["this-command-does-not-exist"]);
      // Commander's default behaviour is to exit non-zero when given
      // an unknown command. We do not assert a specific code because
      // commander has historically used 1; just non-zero.
      expect(result.exitCode).not.toBe(0);
    },
    TIMEOUT_MS,
  );
});

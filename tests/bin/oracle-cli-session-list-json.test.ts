import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, test } from "vitest";

// Regression coverage for oracle-router-oracle-status-session-json-d3r:
// `oracle status --json` / `oracle session --json` must actually route the
// `--json` flag to the subcommand action. This is deliberately an
// execFile-driven, full-Commander-parse test (not a call into
// `buildSessionListPayload`/`handleSessionCommand` directly) because the
// real bug caught here was a Commander option-attribution gotcha: the root
// `oracle` command already declares its own `--json` option (for the
// canonical protected-run flag), so a naive `command.opts().json` read on
// the `status`/`session` subcommand action silently stays at its default
// (false) even when `--json` is passed on the CLI — only
// `command.optsWithGlobals()` observes it. A unit test that calls the
// handler function directly with hand-built Commander option state would
// not have caught this.

const execFileAsync = promisify(execFile);
const CLI_ENTRYPOINT = path.join(process.cwd(), "bin", "oracle-cli.ts");

async function runOracle(
  args: string[],
  env: Record<string, string>,
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(process.execPath, ["--import", "tsx", CLI_ENTRYPOINT, ...args], {
    env: {
      ...process.env,
      ...env,
      FORCE_COLOR: "0",
      NO_COLOR: "1",
      ORACLE_DISABLE_KEYTAR: "1",
    },
    timeout: 30_000,
  });
}

describe("oracle status --json / oracle session --json (full CLI parse)", () => {
  let homeDir: string | undefined;

  afterEach(async () => {
    if (homeDir) {
      await rm(homeDir, { recursive: true, force: true });
      homeDir = undefined;
    }
  });

  async function seedHomeWithOneSession(): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-session-list-json-"));
    const sessionDir = path.join(dir, "sessions", "fixture-session");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      path.join(sessionDir, "meta.json"),
      JSON.stringify({
        id: "fixture-session",
        createdAt: "2026-07-01T00:00:00.000Z",
        startedAt: "2026-07-01T00:00:01.000Z",
        completedAt: "2026-07-01T00:05:00.000Z",
        status: "completed",
        model: "claude-opus-4",
        lane: "fable-local",
        options: {},
      }),
      "utf8",
    );
    await writeFile(path.join(sessionDir, "output.log"), "", "utf8");
    return dir;
  }

  test("oracle status --json emits an oracle_session_list.v1 envelope with the seeded session", async () => {
    homeDir = await seedHomeWithOneSession();
    const { stdout } = await runOracle(["status", "--json", "--all"], {
      ORACLE_HOME_DIR: homeDir,
    });
    const parsed = JSON.parse(stdout);
    expect(parsed.schema_version).toBe("json_envelope.v1");
    expect(parsed.ok).toBe(true);
    expect(parsed.data.schema_version).toBe("oracle_session_list.v1");
    expect(parsed.data.count).toBe(1);
    expect(parsed.data.sessions).toEqual([
      {
        id: "fixture-session",
        lane: "fable-local",
        model: "claude-opus-4",
        status: "completed",
        createdAt: "2026-07-01T00:00:00.000Z",
        updatedAt: "2026-07-01T00:05:00.000Z",
        artifactsPath: path.join(homeDir, "sessions", "fixture-session"),
      },
    ]);
  });

  test("oracle session --json emits the same envelope shape", async () => {
    homeDir = await seedHomeWithOneSession();
    const { stdout } = await runOracle(["session", "--json", "--all"], {
      ORACLE_HOME_DIR: homeDir,
    });
    const parsed = JSON.parse(stdout);
    expect(parsed.data.schema_version).toBe("oracle_session_list.v1");
    expect(parsed.data.sessions).toHaveLength(1);
    expect(parsed.data.sessions[0].id).toBe("fixture-session");
  });

  test("oracle status (no --json) is unchanged: human table output, no JSON", async () => {
    homeDir = await seedHomeWithOneSession();
    const { stdout } = await runOracle(["status", "--all"], { ORACLE_HOME_DIR: homeDir });
    expect(stdout).toContain("Recent Sessions");
    expect(stdout).toContain("fixture-session");
    expect(() => JSON.parse(stdout)).toThrow();
  });

  test("oracle status --json with no sessions emits an empty, well-formed envelope", async () => {
    homeDir = await mkdtemp(path.join(os.tmpdir(), "oracle-session-list-json-empty-"));
    const { stdout } = await runOracle(["status", "--json"], { ORACLE_HOME_DIR: homeDir });
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.data.count).toBe(0);
    expect(parsed.data.sessions).toEqual([]);
  });
});

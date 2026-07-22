import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const CLI_ENTRYPOINT = path.join(process.cwd(), "bin", "oracle-cli.ts");

let oracleHome: string;

beforeEach(async () => {
  oracleHome = await mkdtemp(path.join(os.tmpdir(), "oracle-fable-followup-affinity-"));
  const sessionDir = path.join(oracleHome, "sessions", "fable-parent");
  await mkdir(sessionDir, { recursive: true });
  await writeFile(
    path.join(sessionDir, "meta.json"),
    `${JSON.stringify({
      id: "fable-parent",
      createdAt: "2026-07-21T00:00:00.000Z",
      completedAt: "2026-07-21T00:01:00.000Z",
      status: "completed",
      mode: "claude-code",
      model: "fable",
      lane: "fable-local",
      options: { mode: "claude-code", model: "fable", lane: "fable-local" },
      claudeCode: {
        claude_session_id: "5b1a2c3d-4e5f-6789-abcd-ef0123456789",
        caam_profile: "cc-arthur",
        caam_base: "/home/ubuntu/orch-homes",
      },
    })}\n`,
    { mode: 0o600 },
  );
});

afterEach(async () => {
  await rm(oracleHome, { recursive: true, force: true });
});

describe("Fable follow-up CAAM affinity (full CLI parse)", () => {
  test.each([
    {
      name: "profile",
      profile: "cc-benson",
      base: "/home/ubuntu/orch-homes",
    },
    {
      name: "base",
      profile: "cc-arthur",
      base: "/home/ubuntu/other-orch-homes",
    },
  ])("rejects a mismatched $name before creating or spawning a run", async ({ profile, base }) => {
    const result = await runOracleFailure([
      "--dry-run",
      "json",
      "--lane",
      "fable-local",
      "--followup",
      "fable-parent",
      "--prompt",
      "Continue the review",
      "--caam-profile",
      profile,
      "--caam-base",
      base,
    ]);
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.code).toBe(1);
    expect(output).toContain("SAME CAAM profile AND base");
    expect(output).toContain("cc-arthur");
    expect(output).toContain(profile);
    expect(output).not.toContain("would run Claude Code local mode");
    expect(await readdir(path.join(oracleHome, "sessions"))).toEqual(["fable-parent"]);
  });
});

interface ExecFailure extends Error {
  stdout?: string | Buffer;
  stderr?: string | Buffer;
  code?: number | string | null;
}

async function runOracleFailure(
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const {
    ORACLE_CLAUDE_CODE_CAAM_PROFILE: _profile,
    ORACLE_CLAUDE_CODE_CAAM_BASE: _base,
    ORACLE_CLAUDE_CODE_MAX_RATE_LIMIT_ROTATIONS: _rotations,
    ...cleanEnv
  } = process.env;
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ["--import", "tsx", CLI_ENTRYPOINT, ...args],
      {
        env: {
          ...cleanEnv,
          FORCE_COLOR: "0",
          NO_COLOR: "1",
          ORACLE_DISABLE_KEYTAR: "1",
          ORACLE_NO_DETACH: "1",
          ORACLE_HOME_DIR: oracleHome,
        },
        timeout: 30_000,
      },
    );
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

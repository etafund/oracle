import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { describe, expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const CLI_ENTRYPOINT = path.join(process.cwd(), "bin", "oracle-cli.ts");

describe("bin/oracle-cli preview and visibility routing", () => {
  test("oracle --help hides preview and visibility-status by default (still discoverable via --help --verbose)", async () => {
    const { stdout, stderr } = await runOracle(["--help"]);
    const output = `${stdout}\n${stderr}`;
    const commandsSection = extractCommandsSection(output);

    expect(commandsSection).not.toMatch(/^\s*preview\b/m);
    expect(commandsSection).not.toMatch(/^\s*visibility-status\b/m);

    const verbose = await runOracle(["--help", "--verbose"]);
    const verboseOutput = `${verbose.stdout}\n${verbose.stderr}`;

    expect(verboseOutput).toMatch(/^\s*preview\b/m);
    expect(verboseOutput).toMatch(/^\s*visibility-status\b/m);
  });

  test("oracle --help shows one examples section with lane aliases", async () => {
    const { stdout, stderr } = await runOracle(["--help"]);
    const output = `${stdout}\n${stderr}`;
    const exampleSections = output.match(/^Examples:?\n/gm);

    expect(exampleSections).toHaveLength(1);
    expect(output).toContain(
      `oracle --lane chatgpt-pro --prompt "Review this migration plan" --file docs/plan.md`,
    );
    expect(output).toContain(
      `oracle --lane fable-local --caam-profile my-profile --caam-base "$HOME/orch-homes" --prompt "Review this migration plan" --file docs/plan.md`,
    );
    expect(output).toContain("oracle doctor fable --caam-profile <profile> --json");
    expect(output).toContain("Fable runs at fixed xhigh effort");
    expect(output).toContain("--lane fable-local route requires a Claude subscription");
    expect(output).toContain("ORACLE_CLAUDE_CODE_CAAM_PROFILE");
    expect(output).toContain("Explicit profile selection fails closed");
    expect(output).toContain(
      `oracle --lane gemini-deep-think --prompt "Review this migration plan" --file docs/plan.md`,
    );
  });

  test("--lane chatgpt-pro maps to browser compatibility syntax in preview", async () => {
    const { stdout } = await runOracle([
      "--lane",
      "chatgpt-pro",
      "--prompt",
      "Review this migration plan",
      "--file",
      "AGENTS.md",
      "--dry-run",
      "json",
      "--json",
    ]);
    const preview = parseLastJson(stdout);

    expect(preview).toMatchObject({
      engine: "browser",
      model: "gpt-5.6-sol",
    });
  });

  test("--lane gemini-deep-think maps to browser compatibility syntax in preview", async () => {
    const { stdout } = await runOracle([
      "--lane",
      "gemini-deep-think",
      "--prompt",
      "Review this migration plan",
      "--file",
      "AGENTS.md",
      "--dry-run",
      "json",
      "--json",
    ]);
    const preview = parseLastJson(stdout);

    expect(preview).toMatchObject({
      engine: "browser",
      model: "gemini-3-pro-deep-think",
    });
  });

  test("typoed --lane fails during option parsing before backend routing", async () => {
    const { code, stdout, stderr } = await runOracleFailure([
      "--lane",
      "chatgpt-pr0",
      "--prompt",
      "Review this migration plan",
      "--dry-run",
      "json",
    ]);
    const output = `${stdout}\n${stderr}`;

    expect(code).toBe(1);
    expect(output).toContain("error: option '--lane <lane>' argument 'chatgpt-pr0' is invalid");
    expect(output).toContain("Allowed choices are chatgpt-pro, fable-local, gemini-deep-think");
    expect(output).not.toContain("missing_reviewed_lane");
    expect(output).not.toContain("selector_state_unknown");
    // Agent-ergonomics Axiom 7 (intent inference): a typo'd --lane value
    // must also name the closest reviewed lane and the exact corrected
    // command to retry with — not just the bare "invalid choice" message.
    expect(output).toContain("Did you mean --lane chatgpt-pro?");
    expect(output).toContain('Try: oracle -p "<prompt>" --lane chatgpt-pro');
  });

  test("a different typoed --lane value (fable-locl) suggests fable-local with the exact corrected command", async () => {
    const { code, stdout, stderr } = await runOracleFailure([
      "--lane",
      "fable-locl",
      "--prompt",
      "hi",
      "--dry-run",
      "json",
    ]);
    const output = `${stdout}\n${stderr}`;

    expect(code).toBe(1);
    expect(output).toContain("error: option '--lane <lane>' argument 'fable-locl' is invalid");
    expect(output).toContain("Allowed choices are chatgpt-pro, fable-local, gemini-deep-think");
    expect(output).toContain("Did you mean --lane fable-local?");
    expect(output).toContain('Try: oracle -p "<prompt>" --lane fable-local --caam-profile <name>');
  });

  test("--lane with no plausible match falls back to the generic choices message (no false 'did you mean')", async () => {
    const { code, stdout, stderr } = await runOracleFailure([
      "--lane",
      "banana",
      "--prompt",
      "hi",
      "--dry-run",
      "json",
    ]);
    const output = `${stdout}\n${stderr}`;

    expect(code).toBe(1);
    expect(output).toContain("Allowed choices are chatgpt-pro, fable-local, gemini-deep-think");
    expect(output).not.toContain("Did you mean --lane");
  });

  test("a valid --lane invocation is unaffected by the typo-correction wiring", async () => {
    const { stdout, stderr } = await runOracle([
      "--lane",
      "chatgpt-pro",
      "--prompt",
      "Review this migration plan",
      "--file",
      "AGENTS.md",
      "--dry-run",
      "json",
      "--json",
    ]);
    const output = `${stdout}\n${stderr}`;

    expect(output).not.toContain("Did you mean");
    expect(output).not.toContain("is invalid");
    const preview = parseLastJson(stdout);
    expect(preview).toMatchObject({ engine: "browser", model: "gpt-5.6-sol" });
  });

  test("fable-local is CLI-visible even while its readiness remains hidden-alpha-only", async () => {
    const { stdout, stderr } = await runOracle(["--help"]);
    const output = `${stdout}\n${stderr}`;

    expect(output).toContain("--lane fable-local");
  });

  test("an explicitly empty CAAM profile fails closed before a Fable run", async () => {
    const result = await runOracleFailure([
      "--lane",
      "fable-local",
      "--caam-profile",
      "",
      "--prompt",
      "Review",
      "--dry-run",
      "json",
    ]);

    expect(result.code).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/profile cannot be empty/i);
  });

  test("--lane fable-local refuses an unpinned account before dry-run or spawn", async () => {
    const result = await runOracleFailure(
      ["--lane", "fable-local", "--prompt", "Review", "--dry-run", "json", "--json"],
      { ORACLE_CLAUDE_CODE_CAAM_PROFILE: "" },
    );
    const output = `${result.stdout}\n${result.stderr}`;
    const envelope = parseJsonEnvelope(result.stdout);

    expect(result.code).not.toBe(0);
    expect(output).toContain("--lane fable-local requires a CAAM subscription profile");
    expect(output).toContain("--caam-profile <name>");
    expect(output).toContain("ORACLE_CLAUDE_CODE_CAAM_PROFILE=<name>");
    expect(output).toContain("oracle doctor fable --caam-profile <name> --json");
    expect(output).not.toContain("CAAM account plan: disabled");
    expect(envelope).toMatchObject({
      ok: false,
      blocked_reason: "input_invalid",
      next_command: "oracle doctor fable --caam-profile <name> --json",
      fix_command: 'oracle --lane fable-local --caam-profile <name> -p "<prompt>"',
      retry_safe: false,
      error: {
        code: "input_invalid",
        details: { blockedReason: "caam_profile_required" },
      },
    });
  });

  test("compatibility --engine claude-code keeps the historical unpinned dry-run", async () => {
    const { stdout, stderr } = await runOracle(
      ["--engine", "claude-code", "--model", "fable", "--prompt", "Review", "--dry-run", "summary"],
      { ORACLE_CLAUDE_CODE_CAAM_PROFILE: "" },
    );
    const output = `${stdout}\n${stderr}`;

    expect(output).toContain("CAAM account plan: disabled");
    expect(output).toContain("direct Claude account resolution applies");
    expect(output).not.toContain("requires a CAAM subscription profile");
  });

  test("--caam-base without a profile is rejected instead of silently using direct Claude", async () => {
    const result = await runOracleFailure([
      "--lane",
      "fable-local",
      "--caam-base",
      "/home/ubuntu/orch-homes",
      "--prompt",
      "Review",
      "--dry-run",
      "json",
    ]);

    expect(result.code).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain("--caam-base requires a CAAM profile");
  });

  test("legacy direct-Claude compatibility teaches that --caam-base can be omitted", async () => {
    const result = await runOracleFailure(
      [
        "--engine",
        "claude-code",
        "--model",
        "fable",
        "--caam-base",
        "/home/ubuntu/orch-homes",
        "--prompt",
        "Review",
        "--dry-run",
        "json",
        "--json",
      ],
      { ORACLE_CLAUDE_CODE_CAAM_PROFILE: "" },
    );
    const output = `${result.stdout}\n${result.stderr}`;
    const envelope = parseJsonEnvelope(result.stdout);

    expect(output).toContain("omit --caam-base");
    expect(output).toContain("legacy direct-Claude compatibility route");
    expect(envelope).toMatchObject({
      ok: false,
      blocked_reason: "input_invalid",
      fix_command: 'oracle --engine claude-code --model fable -p "<prompt>"',
      error: { details: { blockedReason: "caam_base_requires_profile" } },
    });
  });

  test.each([
    ["preview", ["preview", "--help"]],
    ["status", ["status", "--help"]],
    ["visibility-status", ["visibility-status", "--help"]],
  ])("oracle %s --help exits successfully", async (_label, args) => {
    const { stdout, stderr } = await runOracle(args);
    const output = `${stdout}\n${stderr}`;

    expect(output).toContain("Usage:");
  });

  test("oracle preview action emits a json_envelope.v1 without a live call", async () => {
    const { stdout } = await runOracle(["preview", "--json"]);
    const envelope = parseJsonEnvelope(stdout);

    expect(envelope).toMatchObject({
      schema_version: "json_envelope.v1",
      ok: true,
      data: {
        schema_version: "oracle_preview.v1",
        preview_only: true,
        no_live_calls_made: true,
      },
    });
  });

  test("oracle visibility-status action emits a json_envelope.v1", async () => {
    const { stdout } = await runOracle([
      "visibility-status",
      "--profile",
      "balanced",
      "--slot",
      "chatgpt_pro_first_plan",
      "--json",
    ]);
    const envelope = parseJsonEnvelope(stdout);

    expect(envelope).toMatchObject({
      schema_version: "json_envelope.v1",
      data: { schema_version: "oracle_visibility_status.v1" },
    });
  });
});

describe("error-teaches: restart/status name the exact corrected command", () => {
  // Agent-ergonomics Axiom 6 (error-teaches): a missing/invalid session ID
  // must not just say "not found" — it must name the exact command an
  // agent can run to find a valid ID or start over.
  test("oracle restart <bogus-id> points at `oracle status --json` to find a valid ID", async () => {
    await expect(runOracle(["restart", "definitely-not-a-real-session-id"])).rejects.toMatchObject({
      stderr: expect.stringMatching(
        /No session found with ID definitely-not-a-real-session-id\. List valid IDs with: oracle status --json/,
      ),
    });
  });

  test("oracle status <id> --clear names the exact fixed command (drop the ID)", async () => {
    await expect(runOracle(["status", "some-id", "--clear"])).rejects.toMatchObject({
      stderr: expect.stringMatching(
        /Cannot combine a session ID with --clear\. Drop the ID: oracle status --clear --hours 24/,
      ),
    });
  });

  test("oracle status <id> --browser-tabs names the exact fixed command (drop the ID)", async () => {
    await expect(runOracle(["status", "some-id", "--browser-tabs"])).rejects.toMatchObject({
      stderr: expect.stringMatching(
        /Cannot combine a session ID with --browser-tabs\. Drop the ID: oracle status --browser-tabs/,
      ),
    });
  });
});

function parseJsonEnvelope(stdout: string): Record<string, unknown> {
  const start = stdout.indexOf("{");
  expect(start).toBeGreaterThanOrEqual(0);
  return JSON.parse(stdout.slice(start)) as Record<string, unknown>;
}

function parseLastJson(stdout: string): Record<string, unknown> {
  const marker = stdout.lastIndexOf("Preview JSON\n");
  const start = marker >= 0 ? marker + "Preview JSON\n".length : -1;
  expect(start).toBeGreaterThanOrEqual(0);
  return JSON.parse(stdout.slice(start).trim()) as Record<string, unknown>;
}

function extractCommandsSection(output: string): string {
  const match = output.match(/Commands:\n([\s\S]*?)\n\n/);
  return match ? match[1] : "";
}

async function runOracle(
  args: string[],
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(process.execPath, ["--import", "tsx", CLI_ENTRYPOINT, ...args], {
    env: {
      ...process.env,
      FORCE_COLOR: "0",
      NO_COLOR: "1",
      ORACLE_DISABLE_KEYTAR: "1",
      ...extraEnv,
    },
    timeout: 30_000,
  });
}

interface ExecFailure extends Error {
  stdout?: string | Buffer;
  stderr?: string | Buffer;
  code?: number | string | null;
}

async function runOracleFailure(
  args: string[],
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await runOracle(args, extraEnv);
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

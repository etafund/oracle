import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { describe, expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const CLI_ENTRYPOINT = path.join(process.cwd(), "bin", "oracle-cli.ts");

// The 13 NON-CORE top-level commands from
// scratchpad/oracle-feature-design/surface-map.md's [SURFACE] change-list
// (§3.i.1), plus `docs` (also enumerated in that list): all get
// `{ hidden: true }` so they steer agents toward the 3 reviewed lanes without
// removing any capability.
const HIDDEN_TOP_LEVEL_COMMANDS = [
  "serve",
  "project-sources",
  "bridge",
  "remote",
  "tui",
  "docs",
  "follow-up",
  "capabilities",
  "browser",
  "evidence",
  "preview",
  "robot-docs",
  "run",
  "visibility-status",
] as const;

// CORE commands must stay visible in default --help (shared session infra +
// the doctor readiness surface the 3 reviewed lanes rely on).
const CORE_TOP_LEVEL_COMMANDS = ["doctor", "session", "status", "restart"] as const;

describe("bin/oracle-cli hidden command/flag surface (agent-ergonomics Stage 5)", () => {
  test("default --help lists only the CORE commands", async () => {
    const { stdout, stderr } = await runOracle(["--help"]);
    const output = `${stdout}\n${stderr}`;
    const commandsSection = extractCommandsSection(output);
    expect(commandsSection.length).toBeGreaterThan(0);

    for (const name of CORE_TOP_LEVEL_COMMANDS) {
      expect(commandsSection).toMatch(new RegExp(`^\\s*${name}\\b`, "m"));
    }
    for (const name of HIDDEN_TOP_LEVEL_COMMANDS) {
      expect(commandsSection).not.toMatch(new RegExp(`^\\s*${name}\\b`, "m"));
    }
  });

  test("--help --verbose lists every hidden command under 'Hidden commands'", async () => {
    const { stdout, stderr } = await runOracle(["--help", "--verbose"]);
    const output = `${stdout}\n${stderr}`;
    expect(output).toContain("Hidden commands");

    const hiddenSection = output.slice(output.indexOf("Hidden commands"));
    for (const name of HIDDEN_TOP_LEVEL_COMMANDS) {
      expect(hiddenSection).toMatch(new RegExp(`^\\s*${name}\\b`, "m"));
    }
  });

  test.each(HIDDEN_TOP_LEVEL_COMMANDS)(
    "hidden command %s still has its own working --help (fully runnable, just not listed)",
    async (name) => {
      const { stdout, stderr } = await runOracle([name, "--help"]);
      const output = `${stdout}\n${stderr}`;
      expect(output).toContain(`Usage: oracle ${name}`);
    },
  );

  test("hidden command `capabilities` still executes and returns a valid envelope", async () => {
    const { stdout } = await runOracle(["capabilities", "--json"]);
    const envelope = JSON.parse(stdout.slice(stdout.indexOf("{"))) as {
      schema_version: string;
      ok: boolean;
    };
    expect(envelope.schema_version).toBe("json_envelope.v1");
    expect(envelope.ok).toBe(true);
  });

  test("--browser-thinking-time is discoverable in default --help (regression: was mis-hidden)", async () => {
    const { stdout, stderr } = await runOracle(["--help"]);
    const output = `${stdout}\n${stderr}`;
    expect(output).toContain("--browser-thinking-time");
  });

  test("--browser-thinking-time still parses and is still accepted as a real run option", async () => {
    const { stdout } = await runOracle([
      "--lane",
      "chatgpt-pro",
      "--browser-thinking-time",
      "extended",
      "--prompt",
      "hello",
      "--file",
      "AGENTS.md",
      "--dry-run",
      "json",
      "--json",
    ]);
    const marker = "Preview JSON\n";
    const start = stdout.lastIndexOf(marker);
    expect(start).toBeGreaterThanOrEqual(0);
    const preview = JSON.parse(stdout.slice(start + marker.length).trim()) as Record<
      string,
      unknown
    >;
    expect(preview).toMatchObject({ engine: "browser" });
  });
});

function extractCommandsSection(output: string): string {
  const match = output.match(/Commands:\n([\s\S]*?)\n\n/);
  return match ? match[1] : "";
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

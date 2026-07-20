// `oracle robot-docs --json` — emits the typed robot registry as a v18
// `json_envelope.v1` whose `data` field is a `robot_surface.v1` payload.
//
// The bead's "auto-generated from existing command definitions" promise
// is delivered by sourcing the entire command list from
// `src/cli/robotRegistry.ts`; the CLI command, README renderers, and
// tests all read from the same array so README/ROBOTS prose cannot
// drift from the implementation. No live calls, no Chrome, no
// filesystem reads — pure metadata.

import type { Command } from "commander";

import { V18_BUNDLE_VERSION, createEnvelope, type JsonEnvelope } from "../../oracle/v18/index.js";
import {
  ROBOT_ERROR_FIELDS_REQUIRED,
  buildRobotSurfacePayload,
  type RobotSurfacePayload,
} from "../robotRegistry.js";
import { CORE_READ_COMMANDS } from "../coreReadCommands.js";

export interface RobotDocsCommandOptions {
  readonly json?: boolean;
}

export interface RobotDocsCommandIo {
  readonly stdout?: (text: string) => void;
  readonly stderr?: (text: string) => void;
}

export interface RobotDocsCommandResult {
  readonly envelope: JsonEnvelope;
  readonly payload: RobotSurfacePayload;
}

/**
 * Build the json_envelope.v1 wrapper around the robot_surface.v1
 * payload. Pure — no I/O. Useful for tests, MCP, and the doctor
 * preflight that prints `oracle robot-docs --json` as a next_command.
 */
export function buildRobotDocsEnvelope(): RobotDocsCommandResult {
  const payload = buildRobotSurfacePayload();
  const envelope = createEnvelope({
    ok: true,
    data: payload as unknown as Record<string, unknown>,
    meta: {
      bundle_version: V18_BUNDLE_VERSION,
      schema_version: payload.schema_version,
      tool: payload.tool,
      command_count: payload.commands.length,
    },
    next_command: "oracle capabilities --json",
    fix_command: null,
    retry_safe: true,
    warnings: [],
    commands: {
      capabilities: "oracle capabilities --json",
      doctor: "oracle doctor --json",
      robot_docs: "oracle robot-docs --json",
    },
  });
  return { envelope, payload };
}

export async function runRobotDocs(
  options: RobotDocsCommandOptions = {},
  io: RobotDocsCommandIo = {},
): Promise<RobotDocsCommandResult> {
  const result = buildRobotDocsEnvelope();
  const write = io.stdout ?? ((text: string) => process.stdout.write(text));
  if (options.json !== false) {
    write(`${JSON.stringify(result.envelope, null, 2)}\n`);
  } else {
    write(formatHuman(result));
  }
  return result;
}

/**
 * Build the paste-ready `oracle robot-docs guide` handbook: a plain-text,
 * < 80-line agent onboarding page that leads with the 3 reviewed lanes
 * and the exact first-try-inevitable invocations, then the core
 * read-only commands and the exit-code dictionary. Sourced entirely from
 * `buildRobotSurfacePayload()` (itself sourced from `laneRegistry.ts` /
 * `exitCodes.ts`) plus `CORE_READ_COMMANDS`, so this prose can never
 * drift from the JSON contract `oracle capabilities --json` and
 * `oracle robot-docs --json` describe. Deterministic — no timestamps,
 * no ANSI color, safe to paste into a system prompt or CLAUDE.md.
 */
export function buildRobotDocsGuideText(): string {
  const { payload } = buildRobotDocsEnvelope();
  const lines: string[] = [];

  lines.push("# Oracle — agent handbook");
  lines.push("");
  lines.push("Oracle is one-shot by default: it starts empty and needs both --prompt and --file.");
  lines.push("");
  lines.push("## First try (run these before anything else)");
  lines.push("");
  lines.push("    oracle capabilities --json   # what's configured; what to run next");
  lines.push("    oracle doctor lanes --json   # are the 3 reviewed lanes ready");
  lines.push("");
  lines.push("## The 3 reviewed lanes");
  for (const lane of payload.lanes) {
    lines.push("");
    lines.push(`### ${lane.lane}`);
    lines.push(`    ${lane.command}`);
    lines.push(`    key flags : ${lane.key_flags.join(", ")}`);
    lines.push(`    doctor    : ${lane.doctor_command}`);
    const laneContracts = [
      lane.fixed_reasoning_effort ? `effort=${lane.fixed_reasoning_effort} (fixed default)` : null,
      lane.explicit_profile_selection_fail_closed ? "explicit-profile=fail-closed" : null,
    ].filter((value): value is string => value !== null);
    lines.push(
      `    readiness : ${lane.readiness}${laneContracts.length > 0 ? `; ${laneContracts.join("; ")}` : ""}`,
    );
  }
  lines.push("");
  lines.push("## Core read commands (no live calls)");
  lines.push("");
  for (const cmd of CORE_READ_COMMANDS) {
    lines.push(`- ${cmd.command}`);
    lines.push(`    ${cmd.purpose}`);
  }
  lines.push("");
  lines.push("## Session action commands (paid live runs; --json = launch receipt on stdout)");
  lines.push("");
  for (const cmd of payload.action_commands) {
    lines.push(`- ${cmd.command as string}`);
  }
  lines.push("");
  lines.push("## Exit codes");
  lines.push("");
  for (const [code, meaning] of Object.entries(payload.exit_codes)) {
    lines.push(`- ${code}: ${meaning}`);
  }
  lines.push("");
  lines.push(
    "Full machine-readable contract: oracle capabilities --json / oracle robot-docs --json",
  );

  return `${lines.join("\n")}\n`;
}

export interface RunRobotDocsGuideIo {
  readonly stdout?: (text: string) => void;
}

/** Run `oracle robot-docs guide` — writes the handbook text to stdout. */
export function runRobotDocsGuide(io: RunRobotDocsGuideIo = {}): string {
  const text = buildRobotDocsGuideText();
  const write = io.stdout ?? ((chunk: string) => process.stdout.write(chunk));
  write(text);
  return text;
}

function formatHuman(result: RobotDocsCommandResult): string {
  const { payload } = result;
  const lines: string[] = [];
  lines.push(`🧿 oracle robot-docs (${payload.bundle_version})`);
  lines.push(`tool=${payload.tool}  json_envelope_required=${payload.json_envelope_required}`);
  lines.push(`error_fields_required: ${payload.error_fields_required.join(", ")}`);
  lines.push("");
  for (const cmd of [...payload.commands, ...payload.action_commands]) {
    const name = cmd.name as string;
    const command = cmd.command as string;
    const purpose = cmd.purpose as string;
    const paid = cmd.paid_calls as boolean;
    const dryRun = cmd.dry_run as boolean;
    lines.push(`• ${name}`);
    lines.push(`    ${command}`);
    lines.push(`    ${purpose}`);
    lines.push(`    paid_calls=${paid}  dry_run=${dryRun}`);
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

export function registerRobotDocsCommand(program: Command): Command {
  const robotDocsCommand = program
    .command("robot-docs")
    .description(
      "Emit the Oracle CLI command registry as a robot_surface.v1 envelope (no live calls). " +
        "Agent-ergonomics primitive: run `oracle robot-docs guide` for a paste-ready handbook.",
    )
    .option("--json", "Print machine-readable JSON envelope (default).", true)
    .option("--no-json", "Print a short human summary instead of JSON.")
    .action(async function (this: Command) {
      const commandOptions = this.optsWithGlobals() as { json?: boolean };
      try {
        await runRobotDocs({ json: commandOptions.json ?? true });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`oracle robot-docs failed: ${message}\n`);
        process.exitCode = 1;
      }
    });

  robotDocsCommand
    .command("guide")
    .description(
      "Print a paste-ready, < 80-line agent handbook leading with the 3 reviewed lanes and " +
        "the first-try-inevitable invocations (plain text, no live calls).",
    )
    .action(() => {
      try {
        runRobotDocsGuide();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`oracle robot-docs guide failed: ${message}\n`);
        process.exitCode = 1;
      }
    });

  return robotDocsCommand;
}

/** Ensure callers can introspect what the envelope error contract demands. */
export { ROBOT_ERROR_FIELDS_REQUIRED };

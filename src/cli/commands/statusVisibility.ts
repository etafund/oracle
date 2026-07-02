import type { Command } from "commander";
import {
  buildOracleVisibilityStatus,
  type BuildOracleVisibilityStatusInput,
  type OracleVisibilityStatusResult,
} from "../../oracle/visibility.js";

export interface StatusVisibilityCommandOptions extends BuildOracleVisibilityStatusInput {
  readonly json?: boolean;
}

export interface StatusVisibilityCommandIo {
  readonly stdout?: (text: string) => void;
  readonly stderr?: (text: string) => void;
}

export function registerStatusVisibilityCommand(program: Command): Command {
  return program
    .command("visibility-status")
    .description("Print runtime budget, waiver, and premortem visibility status.")
    .requiredOption("--profile <profile>", "APR/profile name, for example balanced or audit.")
    .requiredOption("--slot <slot>", "Provider slot to inspect.")
    .option("--json", "Print structured JSON.", true)
    .action(async function (this: Command) {
      const options = this.optsWithGlobals() as StatusVisibilityCommandOptions;
      const result = await runStatusVisibility(options);
      if (!result.envelope.ok) {
        process.exitCode = 1;
      }
    });
}

export async function runStatusVisibility(
  options: StatusVisibilityCommandOptions,
  io: StatusVisibilityCommandIo = {},
): Promise<OracleVisibilityStatusResult> {
  const result = buildOracleVisibilityStatus(options);
  const writer = io.stdout ?? ((text: string) => console.log(text));
  writer(
    options.json === false ? formatStatusVisibility(result) : stableJsonStringify(result.envelope),
  );
  return result;
}

export function formatStatusVisibility(result: OracleVisibilityStatusResult): string {
  const payload = result.payload;
  const lines = [
    `oracle visibility status: ${payload.status}`,
    `slot: ${payload.slot}`,
    `profile: ${payload.profile}`,
  ];
  for (const component of payload.components) {
    lines.push(`- ${component.status} ${component.name}: ${component.message}`);
  }
  if (result.envelope.fix_command) {
    lines.push(`Fix: ${result.envelope.fix_command}`);
  }
  if (result.envelope.next_command) {
    lines.push(`Next: ${result.envelope.next_command}`);
  }
  return lines.join("\n");
}

function stableJsonStringify(value: unknown): string {
  return JSON.stringify(sortJson(value), null, 2);
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sortJson(entry));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const record = value as Record<string, unknown>;
  return Object.keys(record)
    .sort()
    .reduce<Record<string, unknown>>((acc, key) => {
      const sorted = sortJson(record[key]);
      if (sorted !== undefined) {
        acc[key] = sorted;
      }
      return acc;
    }, {});
}

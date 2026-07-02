export const DEFAULT_CLAUDE_CODE_SYSTEM_PROMPT =
  "You are Oracle's supplied-context reviewer. Answer only from the user-provided prompt and attached context. Do not use tools.";

export type ClaudeCodeEffort = "xhigh";
export type ClaudeCodePermissionMode = "plan";
export type ClaudeCodeOutputFormat = "stream-json";

export interface BuildClaudeCodeCommandOptions {
  executable?: string;
  model?: "fable" | "claude-fable-5" | string;
  effort?: ClaudeCodeEffort;
  systemPrompt?: string;
}

export interface ClaudeCodeCommand {
  file: string;
  args: string[];
  spawnOptions: {
    shell: false;
  };
}

const RAW_PASS_THROUGH_KEYS = new Set([
  "args",
  "rawArgs",
  "claudeArgs",
  "extraArgs",
  "passThroughArgs",
  "shell",
]);

const DANGEROUS_OR_OUT_OF_SCOPE_FLAGS = new Set([
  "--bare",
  "--max-turns",
  "--dangerously-skip-permissions",
  "--allow-dangerously-skip-permissions",
  "--permission-mode=bypassPermissions",
  "--input-format",
  "--continue",
  "--resume",
  "--fork-session",
]);

export class ClaudeCodeCommandError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ClaudeCodeCommandError";
    this.code = code;
  }
}

export function buildClaudeCodeCommand(
  options: BuildClaudeCodeCommandOptions = {},
): ClaudeCodeCommand {
  rejectRawPassThroughOptions(options);

  const file = options.executable?.trim() || "claude";
  const model = options.model?.trim() || "fable";
  const effort = options.effort ?? "xhigh";
  const systemPrompt = options.systemPrompt ?? DEFAULT_CLAUDE_CODE_SYSTEM_PROMPT;

  const args = [
    "-p",
    "--system-prompt",
    systemPrompt,
    "--model",
    model,
    "--effort",
    effort,
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--include-hook-events",
    "--permission-mode",
    "plan",
    "--safe-mode",
    "--disable-slash-commands",
    "--strict-mcp-config",
    "--mcp-config",
    JSON.stringify({ mcpServers: {} }),
    "--disallowedTools",
    "mcp__*",
    "--no-chrome",
    "--no-session-persistence",
    "--tools",
    "",
  ];

  assertNoDangerousFlags(args);

  return {
    file,
    args,
    spawnOptions: { shell: false },
  };
}

export function redactedClaudeCodeCommand(command: ClaudeCodeCommand): string[] {
  return [command.file, ...command.args];
}

function rejectRawPassThroughOptions(options: BuildClaudeCodeCommandOptions): void {
  const optionRecord = options as Record<string, unknown>;
  for (const key of RAW_PASS_THROUGH_KEYS) {
    if (Object.prototype.hasOwnProperty.call(optionRecord, key)) {
      throw new ClaudeCodeCommandError(
        "raw_claude_code_args_rejected",
        `Claude Code local mode owns the full argv; raw pass-through option ${key} is not allowed.`,
      );
    }
  }
}

function assertNoDangerousFlags(args: string[]): void {
  for (const arg of args) {
    if (DANGEROUS_OR_OUT_OF_SCOPE_FLAGS.has(arg)) {
      throw new ClaudeCodeCommandError(
        "dangerous_claude_code_flag",
        `Claude Code command builder emitted blocked flag ${arg}.`,
      );
    }
    if (arg === "bypassPermissions") {
      throw new ClaudeCodeCommandError(
        "dangerous_claude_code_permission_mode",
        "Claude Code command builder must not emit permission-mode bypassPermissions.",
      );
    }
  }
}

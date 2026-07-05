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
  /**
   * Multi-turn resume primitive (claude-provider-map.md finding #2). When
   * set, oracle's own `--followup <sessionId>` surface attaches this run to
   * a prior Claude Code conversation via the real CLI's own
   * `--session-id <uuid>` flag INSTEAD of `--no-session-persistence` — this
   * is the only sanctioned resume path. Raw `--resume`/`--continue`/
   * `--fork-session` stay on `DANGEROUS_OR_OUT_OF_SCOPE_FLAGS` below and are
   * never emitted, no matter what this option is set to. Must be a bare
   * UUID (validated below) since it is embedded directly into argv.
   */
  resumeSessionId?: string;
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

// RFC 4122 UUID shape — `--session-id` is documented by the real `claude`
// CLI as "must be a valid UUID"; validating it here (rather than trusting
// whatever produced it) means a corrupted/tampered stored session id can
// never smuggle an unexpected argv value through this builder.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  const resumeSessionId = options.resumeSessionId?.trim();
  if (resumeSessionId && !UUID_PATTERN.test(resumeSessionId)) {
    throw new ClaudeCodeCommandError(
      "invalid_resume_session_id",
      `Claude Code resume session id ${JSON.stringify(resumeSessionId)} is not a valid UUID.`,
    );
  }

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
    // One-shot runs (no resume requested) keep today's exact behavior: no
    // persistence, nothing on disk to resume later. A resumed run instead
    // attaches to the prior conversation via `--session-id <uuid>` and
    // deliberately leaves persistence enabled so a further `--followup` can
    // keep the chain going. `--resume`/`--continue`/`--fork-session` are
    // never emitted here — see DANGEROUS_OR_OUT_OF_SCOPE_FLAGS.
    ...(resumeSessionId ? ["--session-id", resumeSessionId] : ["--no-session-persistence"]),
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
        `Claude Code local mode owns the full argv; raw pass-through option "${key}" is not allowed. Use the reviewed lane's own flags instead: oracle -p "<prompt>" --lane fable-local (run \`oracle doctor lanes --json\` to see exactly which argv it builds).`,
      );
    }
  }
}

function assertNoDangerousFlags(args: string[]): void {
  for (const arg of args) {
    if (DANGEROUS_OR_OUT_OF_SCOPE_FLAGS.has(arg)) {
      throw new ClaudeCodeCommandError(
        "dangerous_claude_code_flag",
        `Claude Code command builder emitted blocked flag "${arg}" (internal invariant violation, not a user-fixable input). Please report this as an Oracle bug; do not retry with --dangerously-skip-permissions or similar bypass flags — those stay refused.`,
      );
    }
    if (arg === "bypassPermissions") {
      throw new ClaudeCodeCommandError(
        "dangerous_claude_code_permission_mode",
        'Claude Code command builder must not emit permission-mode bypassPermissions (internal invariant violation, not a user-fixable input). Please report this as an Oracle bug; fable-local always runs read-only "plan" permission mode.',
      );
    }
  }
}

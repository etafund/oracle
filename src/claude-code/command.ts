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
   * Stable UUID for a new, persisted Claude Code conversation. The reviewed
   * Fable lane mints this before spawn, passes it through the real CLI's
   * `--session-id <uuid>` flag, and records that exact same value in Oracle
   * metadata so a later follow-up has a real transcript to resume.
   *
   * Leave unset for compatibility one-shots that deliberately retain
   * `--no-session-persistence`. Mutually exclusive with `resumeSessionId`.
   */
  sessionId?: string;
  /**
   * Multi-turn resume primitive (claude-provider-map.md finding #2). When
   * set, Oracle's own `--followup <sessionId>` surface attaches this run to
   * a prior Claude Code conversation via the real CLI's `--resume <uuid>`
   * flag. This is the only sanctioned resume path: the UUID is loaded from
   * trusted Oracle metadata and validated below, while raw pass-through
   * arguments remain rejected. `--continue` and `--fork-session` are never
   * emitted.
   */
  resumeSessionId?: string;
  /**
   * Stream-json content-block attachment transport (bead oracle-router-8fa;
   * `streamJsonInput.ts`). When `true`, the builder emits
   * `--input-format stream-json` so the lane can write a single NDJSON user
   * message (text + base64 image/document blocks) on stdin instead of flat
   * text. Default (unset/`false`) keeps today's exact text-stdin argv, so the
   * flag-off path stays byte-identical. The output half of the protocol
   * (`--output-format stream-json --verbose`) is already emitted below, which
   * is the only prerequisite claude enforces for stream-json input.
   */
  streamJsonInput?: boolean;
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
  const sessionId = options.sessionId?.trim();
  const resumeSessionId = options.resumeSessionId?.trim();
  const streamJsonInput = options.streamJsonInput === true;
  validateSessionId("session", sessionId);
  validateSessionId("resume session", resumeSessionId);
  if (sessionId && resumeSessionId) {
    throw new ClaudeCodeCommandError(
      "conflicting_session_mode",
      "Claude Code command cannot start a new --session-id and --resume an existing session at the same time.",
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
    // Stream-json content-block input transport (bead oracle-router-8fa),
    // emitted ONLY when the feature flag resolved by the caller is on. Left
    // off, the argv is byte-identical to the historical text-stdin lane.
    // claude requires `--input-format stream-json` to be paired with
    // `--print` (the `-p` above) and `--output-format stream-json` (below).
    ...(streamJsonInput ? ["--input-format", "stream-json"] : []),
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
    // Reviewed one-shots persist under the exact UUID Oracle records; later
    // follow-ups use Claude's actual resume primitive. Compatibility callers
    // that provide neither value retain the historical non-persistent shape.
    ...(resumeSessionId
      ? ["--resume", resumeSessionId]
      : sessionId
        ? ["--session-id", sessionId]
        : ["--no-session-persistence"]),
    "--tools",
    "",
  ];

  assertInputFormatOnlyFromFlag(args, streamJsonInput);
  assertNoDangerousFlags(args, resumeSessionId);

  return {
    file,
    args,
    spawnOptions: { shell: false },
  };
}

function validateSessionId(label: string, value: string | undefined): void {
  if (value && !UUID_PATTERN.test(value)) {
    throw new ClaudeCodeCommandError(
      `invalid_${label.replaceAll(" ", "_")}_id`,
      `Claude Code ${label} id ${JSON.stringify(value)} is not a valid UUID.`,
    );
  }
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
        `Claude Code local mode owns the full argv; raw pass-through option "${key}" is not allowed. Use the reviewed lane's own flags instead: oracle -p "<prompt>" --lane fable-local --caam-profile <name> (run \`oracle doctor lanes --json\` to see exactly which argv it builds).`,
      );
    }
  }
}

// `--input-format` is emitted ONLY by the streamJsonInput flag path above, and
// is deliberately NOT on DANGEROUS_OR_OUT_OF_SCOPE_FLAGS (that set is asserted
// against the builder's own argv, which legitimately carries the flag when the
// transport is on). This builder already owns the full argv — raw pass-through
// options are rejected outright (rejectRawPassThroughOptions) and caam only
// prepends a wrapper — so no external/config arg can inject `--input-format`
// today. This invariant makes that guarantee explicit and fail-closed: the flag
// can never appear on the OFF path, so a future extra-args wiring can't silently
// smuggle `--input-format stream-json` in while Oracle writes flat text on stdin.
function assertInputFormatOnlyFromFlag(args: string[], streamJsonInput: boolean): void {
  if (!streamJsonInput && args.includes("--input-format")) {
    throw new ClaudeCodeCommandError(
      "unexpected_input_format_flag",
      'Claude Code command builder produced "--input-format" without the stream-json input transport enabled (internal invariant violation, not a user-fixable input). Please report this as an Oracle bug.',
    );
  }
}

function assertNoDangerousFlags(args: string[], resumeSessionId: string | undefined): void {
  const resumeIndexes = args.flatMap((arg, index) => (arg === "--resume" ? [index] : []));
  for (const [index, arg] of args.entries()) {
    if (DANGEROUS_OR_OUT_OF_SCOPE_FLAGS.has(arg)) {
      // `--resume` is allowed only in the one exact builder-owned shape. The
      // value came from trusted Oracle metadata, was UUID-validated above,
      // and raw argument passthrough is rejected before argv construction.
      if (
        arg === "--resume" &&
        resumeSessionId !== undefined &&
        resumeIndexes.length === 1 &&
        args[index + 1] === resumeSessionId
      ) {
        continue;
      }
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

import { normalizeMaxFileSizeBytes } from "../oracle/files.js";
import { FileValidationError } from "../oracle/errors.js";

/**
 * Aggregate inline-content budget for the claude-code (Fable) lane
 * (claude-provider-map.md finding #1). Everything oracle sends to `claude`
 * for this lane goes over a single stdin write of the combined prompt +
 * attached-file text (`buildPrompt`, `src/oracle/request.ts`) — there is no
 * other input-side transport for this lane. Per-file size is already capped
 * (`DEFAULT_MAX_FILE_SIZE_BYTES`, `src/oracle/files.ts`), but nothing bounded
 * the *combined* total before this fix: N files at up to the per-file cap
 * each could combine into an arbitrarily large stdin write with no
 * pre-flight check or manifest.
 *
 * `ORACLE_CLAUDE_CODE_MAX_INLINE_BYTES` was already allowlisted into the
 * child's environment (`envGuard.ts`) but nothing on the parent side ever
 * read it — setting it changed nothing. This module is now the single
 * source of truth for that budget: `resolveClaudeCodeMaxInlineBytes` is used
 * both by the pre-spawn aggregate check below (`assertClaudeCodeInlineBudget`)
 * and, from `sessionRunner.ts`, by the existing post-spawn output-flood
 * detector — one number governs how much oracle is willing to inline over
 * the claude-code stdio pipes, in either direction.
 */
export const ORACLE_CLAUDE_CODE_MAX_INLINE_BYTES_ENV_VAR = "ORACLE_CLAUDE_CODE_MAX_INLINE_BYTES";

/**
 * 32 MB: the Anthropic Messages request-body ceiling (bead oracle-router-8fa).
 * Re-pinned down from the former 64 MB, which was doubly wrong: it sat above
 * claude's own 10 MB piped-text-stdin hard cap (`_Mp = 10485760`) on the
 * legacy text path AND above the 32 MB request-body limit the stream-json
 * content-block path hits. Budgeting is done on the ENCODED bytes actually
 * written to stdin — for the stream-json path that is the base64-inflated
 * NDJSON line (~+33% over the raw attachment bytes), so a bundle that fits raw
 * can still exceed this once encoded, and this check catches it before the API
 * 413. (Oversize on the legacy text path between 10-32 MB still surfaces
 * claude's own stdin-cap error; that pre-existing gap is out of scope here.)
 */
export const DEFAULT_CLAUDE_CODE_MAX_INLINE_BYTES = 32 * 1024 * 1024;

/**
 * Base64 encodes 3 raw bytes into 4 output bytes (padded up to a 4-byte
 * boundary), i.e. ~+33%. Exposed so callers reasoning about a stream-json
 * message's encoded footprint (before it is serialized) can size media the
 * same way `Buffer.toString("base64")` will.
 */
export function base64EncodedByteLength(rawByteLength: number): number {
  return Math.ceil(rawByteLength / 3) * 4;
}

/**
 * Resolves the effective inline-bytes budget. Precedence mirrors the other
 * claude-code overrides (`ORACLE_CLAUDE_CODE_EXECUTABLE` in
 * `executableResolver.ts`, `ORACLE_CLAUDE_CODE_CAAM_PROFILE` in
 * `caamCommand.ts`): an explicit programmatic override
 * (`runOptions.claudeCode.maxInlineBytes`) beats the env var, which beats
 * the default.
 */
export function resolveClaudeCodeMaxInlineBytes(
  configuredMaxInlineBytes: number | undefined,
  env: NodeJS.ProcessEnv = process.env,
): number {
  if (
    typeof configuredMaxInlineBytes === "number" &&
    Number.isFinite(configuredMaxInlineBytes) &&
    configuredMaxInlineBytes > 0
  ) {
    return Math.floor(configuredMaxInlineBytes);
  }
  const fromEnv = env[ORACLE_CLAUDE_CODE_MAX_INLINE_BYTES_ENV_VAR]?.trim();
  if (fromEnv) {
    const parsed = normalizeMaxFileSizeBytes(fromEnv, ORACLE_CLAUDE_CODE_MAX_INLINE_BYTES_ENV_VAR);
    if (parsed !== undefined) {
      return parsed;
    }
  }
  return DEFAULT_CLAUDE_CODE_MAX_INLINE_BYTES;
}

/**
 * Pre-spawn aggregate budget check (claude-provider-map.md finding #1,
 * concrete gap #2). Callers must pass the FINAL bytes about to be written to
 * the claude-code child's stdin so the check reflects exactly that payload:
 * the combined prompt string on the legacy text path (`buildPrompt`'s return
 * value, `src/oracle/request.ts`), or the serialized NDJSON user message on
 * the stream-json path (`serializeStreamJsonMessage`, bead oracle-router-8fa).
 * Because it measures the serialized payload, the stream-json path is budgeted
 * on ENCODED bytes — base64 media inflation and JSON-envelope overhead
 * included. Throws a `FileValidationError` naming the measured size, the
 * limit, and how to raise it; callers should invoke this before doing anything
 * else that would spawn the child process (single-flight lock, executable
 * resolution, `spawn()`).
 */
export function assertClaudeCodeInlineBudget(
  promptWithFiles: string,
  configuredMaxInlineBytes: number | undefined,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const limitBytes = resolveClaudeCodeMaxInlineBytes(configuredMaxInlineBytes, env);
  const totalBytes = Buffer.byteLength(promptWithFiles, "utf8");
  if (totalBytes <= limitBytes) {
    return;
  }
  throw new FileValidationError(
    `Combined prompt and attached files total ${totalBytes.toLocaleString()} bytes, exceeding the Claude Code local-mode inline budget of ${limitBytes.toLocaleString()} bytes. Remove some --file attachments or shorten the prompt, or raise the budget by setting ${ORACLE_CLAUDE_CODE_MAX_INLINE_BYTES_ENV_VAR}=<bytes> in the environment.`,
    { totalBytes, limitBytes },
  );
}

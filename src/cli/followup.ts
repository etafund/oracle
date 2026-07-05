import type { BrowserSessionConfig, SessionMetadata } from "../sessionStore.js";
import { CHATGPT_URL } from "../browser/constants.js";
import { buildConversationUrl } from "../browser/reattachHelpers.js";
import { resolveRecoveryUrl } from "../browser/recoverConversation.js";
import { isRecoverableChatGptConversationUrl } from "../browser/reattachability.js";
import { DEFAULT_MODEL } from "../oracle/config.js";
import type { ModelName, RunOracleOptions } from "../oracle/types.js";
import { resolveClaudeCodeCaamProfile } from "../claude-code/caamCommand.js";

export interface BrowserFollowupResolution {
  sessionId: string;
  resumeConversationUrl: string;
  model: ModelName;
  browserConfig: BrowserSessionConfig;
}

export interface FollowupSessionReader {
  readSession(sessionId: string): Promise<SessionMetadata | null>;
}

/**
 * Resolve the ChatGPT conversation URL to reopen for a browser follow-up.
 *
 * Reuses the same recoverable-URL gate as conversation recovery
 * (`resolveRecoveryUrl`): prefer the post-harvest URL, fall back to the
 * runtime tab URL, and reject home / project-shell / external URLs via
 * `isRecoverableChatGptConversationUrl`. Only when neither candidate is a
 * recoverable `chatgpt.com/c/<id>` URL do we rebuild from a stored
 * `conversationId` against the session's ChatGPT base — and that rebuilt URL is
 * gated too. This prevents a stale or attacker-controlled URL in session
 * metadata from navigating the signed-in browser profile somewhere unintended.
 */
export function resolveBrowserResumeConversationUrl(
  metadata: SessionMetadata,
  fallbackBaseUrl = CHATGPT_URL,
): string | null {
  const gatedUrl = resolveRecoveryUrl(metadata);
  if (gatedUrl) {
    return gatedUrl;
  }
  const conversationId = metadata.browser?.runtime?.conversationId?.trim();
  if (!conversationId) {
    return null;
  }
  const baseUrl = metadata.browser?.config?.url ?? fallbackBaseUrl;
  const built = buildConversationUrl({ conversationId }, baseUrl);
  if (built && isRecoverableChatGptConversationUrl(built)) {
    return built;
  }
  return null;
}

/**
 * A Gemini Deep Think session never records a resumable conversation URL
 * (nothing in `src/gemini-web/` captures one today), so the generic
 * "missing ChatGPT conversation URL" error is lane-incorrect and misleading
 * for it. Detect the Gemini lane from stored session metadata so the
 * follow-up rejection can teach the right alternative instead (Axiom-6
 * error-teaches pattern, same spirit as `describeLaneBlockReason`).
 */
export function isGeminiDeepThinkSession(metadata: SessionMetadata): boolean {
  const lane = metadata.lane ?? metadata.options?.lane;
  if (lane === "gemini-deep-think") {
    return true;
  }
  const model = metadata.options?.model ?? metadata.model;
  return typeof model === "string" && model.startsWith("gemini-");
}

export async function resolveBrowserFollowupReference(
  value: string,
  store: FollowupSessionReader,
): Promise<BrowserFollowupResolution | null> {
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith("resp_")) {
    return null;
  }

  const metadata = await store.readSession(trimmed);
  if (!metadata) {
    return null;
  }
  const mode = metadata.mode ?? metadata.options?.mode;
  const hasBrowserMetadata = Boolean(
    metadata.browser?.runtime || metadata.browser?.config || metadata.options?.browserConfig,
  );
  if (mode !== "browser" && !hasBrowserMetadata) {
    return null;
  }

  const resumeConversationUrl = resolveBrowserResumeConversationUrl(metadata);
  if (!resumeConversationUrl) {
    if (isGeminiDeepThinkSession(metadata)) {
      throw new Error(
        `Session ${trimmed} is a Gemini Deep Think session; Oracle does not yet support resuming Gemini browser sessions via --followup (only ChatGPT Pro and Fable sessions are resumable today). Start a new run instead: oracle --lane gemini-deep-think --prompt "..." --file path`,
      );
    }
    throw new Error(
      `Session ${trimmed} is a browser session but does not contain a ChatGPT conversation URL. Run "oracle status --hours 72 --limit 20" to list recent sessions.`,
    );
  }
  const parentBrowserConfig = metadata.options?.browserConfig ?? metadata.browser?.config;
  if (!parentBrowserConfig) {
    throw new Error(`Session ${trimmed} is missing its stored browser configuration.`);
  }
  const storedModel = metadata.options?.model ?? metadata.model;
  const model =
    typeof storedModel === "string" && storedModel.startsWith("gpt-")
      ? (storedModel as ModelName)
      : DEFAULT_MODEL;
  return {
    sessionId: metadata.id,
    resumeConversationUrl,
    model,
    browserConfig: {
      ...parentBrowserConfig,
      browserTabRef: null,
      resumeConversationUrl,
      researchMode: "off",
      archiveConversations: "never",
    },
  };
}

export interface ClaudeCodeFollowupResolution {
  sessionId: string;
  /** The stable UUID to pass to the real CLI as `--session-id` (claude-provider-map.md finding #2). */
  resumeSessionId: string;
  /** caam shallow-spawn profile the parent run actually used, if any (caam-map.md §4). */
  caamProfile?: string;
  model?: string;
}

/**
 * Resolve a Claude Code (Fable lane) follow-up reference the same way
 * `resolveBrowserFollowupReference` resolves a browser one: read the
 * referenced session, confirm it is actually a `claude-code` session, and
 * hand back what a resumed run needs. Returns `null` (never throws) when
 * the referenced session plainly isn't a claude-code session — callers must
 * then fall through to the existing OpenAI Responses API follow-up path,
 * exactly as `resolveBrowserFollowupReference` does for non-browser
 * sessions.
 */
export async function resolveClaudeCodeFollowupReference(
  value: string,
  store: FollowupSessionReader,
): Promise<ClaudeCodeFollowupResolution | null> {
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith("resp_")) {
    return null;
  }

  const metadata = await store.readSession(trimmed);
  if (!metadata) {
    return null;
  }
  const mode = metadata.mode ?? metadata.options?.mode;
  const hasClaudeCodeMetadata = Boolean(metadata.claudeCode);
  if (mode !== "claude-code" && !hasClaudeCodeMetadata) {
    return null;
  }

  const resumeSessionId = metadata.claudeCode?.claude_session_id?.trim();
  if (!resumeSessionId) {
    throw new Error(
      `Session ${trimmed} is a Claude Code (Fable) session but has no resumable session id recorded (it may predate --followup support for this lane). Start a new session instead of using --followup.`,
    );
  }
  const storedModel = metadata.options?.model ?? metadata.model;
  return {
    sessionId: metadata.id,
    resumeSessionId,
    caamProfile: metadata.claudeCode?.caam_profile ?? undefined,
    model: typeof storedModel === "string" ? storedModel : undefined,
  };
}

/**
 * Fail-closed gate for caam-map.md's "same profile or refuse" requirement:
 * a resumed Claude Code session must use the exact same caam shallow-spawn
 * profile (hence the same `$HOME`) as its parent, or refuse before ever
 * spawning. `undefined` is its own valid value here ("no profile" / the
 * real, unprofiled `$HOME`) — it only matches another `undefined`, never a
 * named profile.
 */
export function assertClaudeCodeFollowupProfileMatches({
  parentSessionId,
  parentProfile,
  childProfile,
}: {
  parentSessionId: string;
  parentProfile?: string;
  childProfile?: string;
}): void {
  if ((parentProfile ?? undefined) === (childProfile ?? undefined)) {
    return;
  }
  throw new Error(
    `--followup ${parentSessionId} ran under caam profile ${JSON.stringify(parentProfile ?? null)}; resuming a Claude Code session must use the SAME caam profile (same $HOME), but this run resolved to ${JSON.stringify(
      childProfile ?? null,
    )}. Set ORACLE_CLAUDE_CODE_CAAM_PROFILE to match (or leave it unset to match "no profile") and retry.`,
  );
}

/**
 * Run-shaped wrapper over `assertClaudeCodeFollowupProfileMatches` that
 * resolves "the profile THIS run would actually use" the exact same way
 * `sessionRunner.ts` does — `resolveClaudeCodeCaamProfile` fed BOTH profile
 * forms: the explicit config-key form (`runOptions.claudeCode.caamProfile`,
 * which takes precedence) and the `ORACLE_CLAUDE_CODE_CAAM_PROFILE` env
 * form. Callers must pass the actual built `RunOracleOptions` for the run
 * being guarded so the two resolutions can never diverge (previously the
 * CLI guard hardcoded `undefined` for the config-key argument and only ever
 * saw the env form).
 */
export function assertClaudeCodeFollowupProfileMatchesRun({
  parentSessionId,
  parentProfile,
  runOptions,
  env,
}: {
  parentSessionId: string;
  parentProfile?: string;
  /** The actual built options for this run (structurally: `RunOracleOptions`). */
  runOptions: {
    claudeCode?: Pick<NonNullable<RunOracleOptions["claudeCode"]>, "caamProfile">;
  };
  env: NodeJS.ProcessEnv;
}): void {
  assertClaudeCodeFollowupProfileMatches({
    parentSessionId,
    parentProfile,
    childProfile: resolveClaudeCodeCaamProfile(runOptions.claudeCode?.caamProfile, env),
  });
}

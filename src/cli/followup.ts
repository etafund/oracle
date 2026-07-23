import type { BrowserSessionConfig, SessionMetadata } from "../sessionStore.js";
import { CHATGPT_URL } from "../browser/constants.js";
import { buildConversationUrl } from "../browser/reattachHelpers.js";
import { resolveRecoveryUrl } from "../browser/recoverConversation.js";
import { isRecoverableChatGptConversationUrl } from "../browser/reattachability.js";
import { normalizeChatGptConversationId } from "../browser/conversationIdentity.js";
import {
  buildImportedBrowserSessionConfig,
  hasImportedChatgptConversationClaim,
  parsePureImportedChatgptConversationSession,
} from "../browser/importedConversation.js";
import { DEFAULT_MODEL } from "../oracle/config.js";
import type { ModelName, RunOracleOptions } from "../oracle/types.js";
import {
  resolveClaudeCodeCaamBase,
  resolveClaudeCodeCaamProfile,
  validateCaamBasePath,
} from "../claude-code/caamCommand.js";

export interface BrowserFollowupResolution {
  sessionId: string;
  resumeConversationUrl: string;
  model: ModelName;
  browserConfig: BrowserSessionConfig;
  /** The lane the referenced session actually ran under, if recorded (e.g. "chatgpt-pro"). */
  lane?: string;
  /** Metadata-only manual import; never a reviewed/account-bound parent run. */
  importedUntrusted?: true;
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
  const conversationId = normalizeChatGptConversationId(metadata.browser?.runtime?.conversationId);
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
  if (hasImportedChatgptConversationClaim(metadata)) {
    return resolveImportedBrowserFollowup(metadata, trimmed);
  }
  const mode = metadata.mode ?? metadata.options?.mode;
  const hasBrowserMetadata = Boolean(
    metadata.browser?.runtime || metadata.browser?.config || metadata.options?.browserConfig,
  );
  if (mode !== "browser" && !hasBrowserMetadata) {
    return null;
  }
  if (metadata.browser?.remoteRecovery || metadata.browser?.remoteRun) {
    throw new Error(
      `Session ${trimmed} belongs to a remote browser account. Refusing --followup because ordinary follow-ups are not account-pinned and could submit on a different account; use the originating ChatGPT account's history${metadata.browser?.remoteRecovery ? ` or recover first with \`oracle session ${trimmed} --render\`` : ""}.`,
    );
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
    lane: metadata.lane ?? metadata.options?.lane,
  };
}

function resolveImportedBrowserFollowup(
  metadata: SessionMetadata,
  requestedId: string,
): BrowserFollowupResolution {
  const imported = parsePureImportedChatgptConversationSession(metadata, requestedId);
  if (!imported) {
    throw new Error(
      `Session ${requestedId} mixes an untrusted import with model, lane, account, capture, or inconsistent conversation state; refusing to treat it as a follow-up parent.`,
    );
  }

  return {
    sessionId: metadata.id,
    resumeConversationUrl: imported.conversationUrl,
    // Compatibility bookkeeping only. desiredModel remains null and the
    // current-model strategy prevents this label from becoming selection
    // evidence or a reviewed Sol+Pro claim.
    model: DEFAULT_MODEL,
    browserConfig: {
      ...buildImportedBrowserSessionConfig(),
      resumeConversationUrl: imported.conversationUrl,
    },
    importedUntrusted: true,
  };
}

export function assertImportedBrowserFollowupCompatibility({
  followup,
  explicitBrowserEngine,
  explicitRemoteBrowserOff,
  resolvedLane,
  remoteHost,
  remoteChrome,
  explicitModel,
  explicitModelStrategy,
  explicitThinkingTime,
  explicitBrowserTab,
}: {
  followup: BrowserFollowupResolution;
  explicitBrowserEngine: boolean;
  explicitRemoteBrowserOff: boolean;
  resolvedLane: { lane: string; engine: string } | null;
  remoteHost?: string;
  remoteChrome?: string;
  explicitModel?: string;
  explicitModelStrategy?: string;
  explicitThinkingTime?: string;
  explicitBrowserTab?: string;
}): void {
  if (!followup.importedUntrusted) {
    return;
  }
  if (resolvedLane) {
    throw new Error(
      `Imported conversation ${followup.sessionId} is untrusted and lane-unbound; it is never eligible for reviewed --lane ${resolvedLane.lane}. Use the explicit compatibility route instead.`,
    );
  }
  if (!explicitBrowserEngine) {
    throw new Error(
      `Imported conversation ${followup.sessionId} requires an explicit compatibility route: --engine browser --remote-browser off.`,
    );
  }
  if (remoteHost || remoteChrome || explicitBrowserTab) {
    throw new Error(
      `Imported conversation ${followup.sessionId} is account-unbound; remote/account-affine browser routing is refused. Use --remote-browser off and a local browser profile you select explicitly.`,
    );
  }
  if (!explicitRemoteBrowserOff) {
    throw new Error(
      `Imported conversation ${followup.sessionId} requires an explicit local route; pass --remote-browser off so no configured or environment-provided remote account is selected.`,
    );
  }
  if (explicitModel) {
    throw new Error(
      `Imported conversation ${followup.sessionId} has no trusted model binding; drop --model and keep the conversation's current model.`,
    );
  }
  if (explicitModelStrategy !== "current") {
    throw new Error(
      `Imported conversation ${followup.sessionId} requires the explicit --browser-model-strategy current compatibility route; model selection cannot be asserted for an imported thread.`,
    );
  }
  if (explicitThinkingTime) {
    throw new Error(
      `Imported conversation ${followup.sessionId} has no trusted mode binding; drop --browser-thinking-time so no Pro/effort proof is asserted.`,
    );
  }
}

export function buildImportedBrowserFollowupConfig(
  base: BrowserSessionConfig,
  resumeConversationUrl: string,
): BrowserSessionConfig {
  return {
    ...base,
    attachRunning: base.attachRunning,
    browserTabRef: null,
    remoteChrome: null,
    remoteChromeBrowserWSEndpoint: null,
    remoteChromeProfileRoot: null,
    desiredModel: null,
    modelStrategy: "current",
    thinkingTime: undefined,
    resumeConversationUrl,
    researchMode: "off",
    archiveConversations: "never",
  };
}

export interface ClaudeCodeFollowupResolution {
  sessionId: string;
  /** The stable UUID to pass to the real CLI as `--session-id` (claude-provider-map.md finding #2). */
  resumeSessionId: string;
  /** caam shallow-spawn profile the parent run actually used, if any (caam-map.md §4). */
  caamProfile?: string;
  /** Exact shallow-profile base paired with `caamProfile`; both identify the parent's `$HOME`. */
  caamBase?: string;
  model?: string;
  /** The lane the referenced session actually ran under, if recorded (e.g. "fable-local"). */
  lane?: string;
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
  if (metadata.claudeCode?.read_only?.sessionPersistenceDisabled !== false) {
    throw new Error(
      `Session ${trimmed} is a Claude Code (Fable) session but records session persistence as disabled, so its stored id does not name a resumable transcript. Start a new reviewed Fable session, then use --followup on that new session.`,
    );
  }
  const storedModel = metadata.options?.model ?? metadata.model;
  const caamProfile = metadata.claudeCode?.caam_profile ?? undefined;
  return {
    sessionId: metadata.id,
    resumeSessionId,
    caamProfile,
    caamBase: caamProfile ? readStoredClaudeCodeCaamBase(metadata) : undefined,
    model: typeof storedModel === "string" ? storedModel : undefined,
    lane: metadata.lane ?? metadata.options?.lane,
  };
}

type StoredClaudeCodeMetadataWithCaamBase = NonNullable<SessionMetadata["claudeCode"]> & {
  caam_base?: unknown;
};

/**
 * `caam_base` is a narrow metadata extension while older session readers still
 * expose `ClaudeCodeSessionMetadata` without that field. Keep the compatibility
 * cast local so the unrelated shared sessionManager surface need not change.
 */
function readStoredClaudeCodeCaamBase(metadata: SessionMetadata): string | undefined {
  const raw = (metadata.claudeCode as StoredClaudeCodeMetadataWithCaamBase | undefined)?.caam_base;
  if (typeof raw !== "string" || !raw.trim()) {
    return undefined;
  }
  try {
    return validateCaamBasePath(raw);
  } catch {
    // Preserve an invalid/tampered stored value so the identity guard compares
    // unequal and fails closed; never silently normalize it to the child base.
    return raw.trim();
  }
}

/**
 * Fail-closed gate for the sibling bug to caam-map.md's "same profile or
 * refuse": lane resolution (`resolveLanePolicy` in lanePolicy.ts) validates
 * and applies a requested `--lane` (engine, model, read-only/no-tools
 * guarantees, etc.) BEFORE `--followup` is resolved. Both
 * `resolveBrowserFollowupReference` and `resolveClaudeCodeFollowupReference`
 * only look at the referenced session's OWN stored metadata — they know
 * nothing about the caller's requested lane — so a stale, copy-pasted, or
 * mixed-lane `--followup` id can resolve to a DIFFERENT engine/lane than the
 * one lane policy just validated. Left unchecked, the followup resolution
 * silently overwrites `engine` (and `model`), discarding the verified lane
 * the caller explicitly asked for with no warning. Call this once both
 * `engine` and the followup resolution are finalized; it never guesses,
 * only refuses.
 */
export function assertFollowupLaneMatchesResolvedLane({
  resolvedLane,
  followupSessionId,
  followupLane,
  followupEngine,
}: {
  /** The lane already validated and applied by `resolveLanePolicy`, if any. */
  resolvedLane: { lane: string; engine: string } | null;
  followupSessionId: string;
  /** The lane recorded on the referenced `--followup` session, if any. */
  followupLane?: string;
  /** The engine the followup resolution is about to apply. */
  followupEngine: string;
}): void {
  if (!resolvedLane) {
    return;
  }
  const engineMatches = resolvedLane.engine === followupEngine;
  const laneMatches = followupLane === undefined || followupLane === resolvedLane.lane;
  if (engineMatches && laneMatches) {
    return;
  }
  const actualLaneDescription =
    followupLane !== undefined
      ? `the "${followupLane}" lane (engine=${followupEngine})`
      : `a session using engine=${followupEngine}`;
  throw new Error(
    `--lane ${resolvedLane.lane} was requested and validated (engine=${resolvedLane.engine}), but --followup ${followupSessionId} resolves to ${actualLaneDescription}, which does not match. Oracle refuses to silently switch engines/lanes after lane policy has already run. Retry with --followup ${followupSessionId} and ${
      followupLane ? `--lane ${followupLane}` : "no --lane flag"
    }, or choose a --followup session that actually belongs to --lane ${resolvedLane.lane}.`,
  );
}

/**
 * Fail-closed gate for caam-map.md's "same identity or refuse" requirement:
 * a resumed Claude Code session must use the exact same caam shallow-spawn
 * profile AND base (together selecting the same `$HOME`) as its parent, or
 * refuse before ever spawning. `undefined` is its own valid profile value
 * here ("no profile" / the real, unprofiled `$HOME`) — it only matches
 * another `undefined`, never a named profile.
 */
export function assertClaudeCodeFollowupProfileMatches({
  parentSessionId,
  parentProfile,
  parentBase,
  childProfile,
  childBase,
}: {
  parentSessionId: string;
  parentProfile?: string;
  parentBase?: string;
  childProfile?: string;
  childBase?: string;
}): void {
  const profileMatches = (parentProfile ?? undefined) === (childProfile ?? undefined);
  const unprofiled = parentProfile === undefined && childProfile === undefined;
  const comparableParentBase = comparableCaamBase(parentBase);
  const comparableChildBase = comparableCaamBase(childBase);
  const baseMatches =
    unprofiled ||
    (comparableParentBase !== undefined &&
      comparableChildBase !== undefined &&
      comparableParentBase === comparableChildBase);
  if (profileMatches && baseMatches) {
    return;
  }
  throw new Error(
    `--followup ${parentSessionId} ran under CAAM identity {profile:${JSON.stringify(parentProfile ?? null)},base:${JSON.stringify(parentBase ?? null)}}; resuming a Claude Code session must use the SAME CAAM profile AND base (same $HOME), but this run resolved to {profile:${JSON.stringify(childProfile ?? null)},base:${JSON.stringify(childBase ?? null)}}. Set ORACLE_CLAUDE_CODE_CAAM_PROFILE and ORACLE_CLAUDE_CODE_CAAM_BASE to match the parent (or leave both unset to match "no profile") and retry.`,
  );
}

function comparableCaamBase(base: string | undefined): string | undefined {
  if (!base?.trim()) return undefined;
  try {
    return validateCaamBasePath(base);
  } catch {
    return base.trim();
  }
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
  parentBase,
  runOptions,
  env,
}: {
  parentSessionId: string;
  parentProfile?: string;
  parentBase?: string;
  /** The actual built options for this run (structurally: `RunOracleOptions`). */
  runOptions: {
    claudeCode?: Pick<NonNullable<RunOracleOptions["claudeCode"]>, "caamProfile" | "caamBase">;
  };
  env: NodeJS.ProcessEnv;
}): void {
  const childProfile = resolveClaudeCodeCaamProfile(runOptions.claudeCode?.caamProfile, env);
  const childBase = childProfile
    ? resolveClaudeCodeCaamBase(runOptions.claudeCode?.caamBase, env).base
    : undefined;
  assertClaudeCodeFollowupProfileMatches({
    parentSessionId,
    parentProfile,
    parentBase,
    childProfile,
    childBase,
  });
}

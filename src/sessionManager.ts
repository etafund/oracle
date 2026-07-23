import path from "node:path";
import fs from "node:fs/promises";
import { createWriteStream, mkdirSync, readFileSync } from "node:fs";
import type { WriteStream } from "node:fs";
import net from "node:net";
import { createHash, randomUUID } from "node:crypto";
import type {
  BrowserArchiveMode,
  BrowserArchiveResult,
  BrowserCloseOwnedRunTargetPolicy,
  BrowserModelStrategy,
  BrowserResearchMode,
  BrowserSubmissionProvenance,
  CookieParam,
} from "./browser/types.js";
import type {
  TransportFailureReason,
  ApiProviderMode,
  AzureOptions,
  BrowserBundleFormat,
  ModelName,
  ModelOverridesConfig,
  PartialMode,
  ThinkingTimeLevel,
} from "./oracle.js";
import {
  hasImportedChatgptConversationClaim,
  type ImportedChatgptConversationMetadata,
} from "./browser/importedConversation.js";
import { DEFAULT_MODEL } from "./oracle/config.js";
import { formatElapsed } from "./oracle/format.js";
import { safeModelSlug } from "./oracle/modelResolver.js";
import { getOracleHomeDir } from "./oracleHome.js";
import {
  createProviderBoundaryPavSnapshot,
  type CreateProviderBoundaryPavSnapshotInput,
  type ProviderBoundaryPavMetadata,
} from "./oracle/provider_boundaries_pav.js";

export type SessionMode = "api" | "browser" | "claude-code";

export interface BrowserSessionConfig {
  chromeProfile?: string | null;
  chromePath?: string | null;
  chromeCookiePath?: string | null;
  attachRunning?: boolean;
  browserTabRef?: string | null;
  chatgptUrl?: string | null;
  url?: string;
  timeoutMs?: number;
  debugPort?: number | null;
  inputTimeoutMs?: number;
  /** Time budget for attachment upload/readiness before clicking send. */
  attachmentTimeoutMs?: number;
  /** Delay before rechecking the conversation after an assistant timeout. */
  assistantRecheckDelayMs?: number;
  /** Time budget for the delayed recheck attempt. */
  assistantRecheckTimeoutMs?: number;
  /** Wait for an existing shared Chrome to appear before launching a new one. */
  reuseChromeWaitMs?: number;
  /** Max time to wait for a shared manual-login profile lock (serializes parallel runs). */
  profileLockTimeoutMs?: number;
  /** Independent time budget for FIFO browser-slot admission; 0 waits forever locally. */
  queueTimeoutMs?: number;
  /** Soft limit for concurrent ChatGPT tabs sharing one manual-login profile. */
  maxConcurrentTabs?: number;
  /** Delay before starting periodic auto-reattach attempts after a timeout. */
  autoReattachDelayMs?: number;
  /** Interval between auto-reattach attempts (0 disables). */
  autoReattachIntervalMs?: number;
  /** Time budget for each auto-reattach attempt. */
  autoReattachTimeoutMs?: number;
  cookieSync?: boolean;
  cookieNames?: string[] | null;
  cookieSyncWaitMs?: number;
  inlineCookies?: CookieParam[] | null;
  inlineCookiesSource?: string | null;
  headless?: boolean;
  keepBrowser?: boolean;
  hideWindow?: boolean;
  desiredModel?: string | null;
  modelStrategy?: BrowserModelStrategy;
  debug?: boolean;
  allowCookieErrors?: boolean;
  remoteChrome?: { host: string; port: number } | null;
  // Remote-Chrome connectivity fields, kept in sync with BrowserAutomationConfig
  // (src/browser/types.ts) so stored session config can round-trip them.
  remoteChromeBrowserWSEndpoint?: string | null;
  remoteChromeProfileRoot?: string | null;
  manualLogin?: boolean;
  manualLoginProfileDir?: string | null;
  manualLoginCookieSync?: boolean;
  /** Host-owned policy for closing this run's exact tab while retaining shared Chrome. */
  closeOwnedRunTargetAfterRun?: BrowserCloseOwnedRunTargetPolicy | null;
  /** Copy this signed-in Chrome user-data dir to a throwaway profile and run against it (login-free). */
  copyProfileSource?: string | null;
  /** Thinking time intensity: 'light', 'standard', 'extended', 'heavy' */
  thinkingTime?: ThinkingTimeLevel;
  /** Browser-only research mode. "deep" activates ChatGPT Deep Research. */
  researchMode?: BrowserResearchMode;
  /** Archive completed ChatGPT conversations after local artifacts are saved. */
  archiveConversations?: BrowserArchiveMode;
  /** Browser-only: existing ChatGPT conversation URL to resume before submitting. */
  resumeConversationUrl?: string | null;
}

export interface BrowserRuntimeMetadata {
  browserTransport?: "cdp";
  chromePid?: number;
  chromePort?: number;
  chromeHost?: string;
  chromeBrowserWSEndpoint?: string;
  chromeProfileRoot?: string;
  userDataDir?: string;
  chromeTargetId?: string;
  tabUrl?: string;
  conversationId?: string;
  /** True after Oracle has submitted the prompt to ChatGPT. */
  promptSubmitted?: boolean;
  /** Branch evidence persisted before the first submission-capable input event. */
  submissionProvenance?: BrowserSubmissionProvenance;
  /** PID of the controller process that launched this browser run. Helps detect orphaned sessions. */
  controllerPid?: number;
}

export type BrowserHarvestState = "running" | "completed" | "stalled" | "detached";

export interface BrowserHarvestMetadata {
  targetId?: string;
  url?: string;
  conversationId?: string;
  harvestedAt?: string;
  assistantHash?: string;
  state?: BrowserHarvestState;
  stopExists?: boolean;
  sendExists?: boolean;
  assistantCount?: number;
  currentModelLabel?: string;
  lastAssistantSnippet?: string;
}

export type BrowserModelSelectionEvidenceStatus =
  | "already-selected"
  | "switched"
  | "switched-best-effort"
  | "skipped"
  | "unavailable";

export interface BrowserModelSelectionEvidence {
  requestedModel?: string | null;
  resolvedLabel?: string | null;
  /** Exact browser-visible model label requested by the route (for example GPT-5.6 Sol). */
  requestedModelLabel?: string | null;
  /** Exact browser-visible model label observed in the active picker. */
  resolvedModelLabel?: string | null;
  /** Whether the active picker proved the requested model independently of mode/effort. */
  modelVerified?: boolean;
  /** Browser intelligence mode requested independently of the model (for example Pro). */
  requestedMode?: string | null;
  /** Exact checked/selected browser intelligence label observed in the active picker. */
  resolvedModeLabel?: string | null;
  /** Whether the requested intelligence mode was visibly selected. */
  modeVerified?: boolean;
  /** True only when the model and mode were both verified before the prompt submit boundary. */
  verifiedBeforePromptSubmit?: boolean;
  strategy?: BrowserModelStrategy;
  status: BrowserModelSelectionEvidenceStatus;
  verified: boolean;
  source: "chatgpt-model-picker" | "config";
  capturedAt: string;
}

export interface BrowserRunWarning {
  code: string;
  severity: "warning";
  message: string;
  details?: Record<string, unknown>;
}

export interface BrowserRemoteRunProvenance {
  modelVerified: boolean | null;
  modelRequested: string | null;
  modelResolved: string | null;
  requestedModelLabel?: string | null;
  resolvedModelLabel?: string | null;
  modelLabelVerified?: boolean | null;
  requestedMode?: string | null;
  resolvedModeLabel?: string | null;
  modeVerified?: boolean | null;
  verifiedBeforePromptSubmit?: boolean | null;
  captureBindingVerified: boolean | null;
  captureBindingQuality: "message-handle" | "guessed" | "conversation-only" | null;
  challengeClean: boolean | null;
  submission: BrowserSubmissionProvenance | null;
}

/** Authoritative remote terminal-event evidence persisted with the client session. */
interface BrowserRemoteRunEvidenceBase {
  runId: string | null;
  /** Neutral worker identity copied from the accepted run's response headers. */
  accountId?: string | null;
  /** Neutral lane identity copied from the accepted run's response headers. */
  laneId?: string | null;
}

export type BrowserRemoteRunEvidence =
  | (BrowserRemoteRunEvidenceBase & {
      terminalDoneOk: true;
      provenance: BrowserRemoteRunProvenance | null;
    })
  | (BrowserRemoteRunEvidenceBase & {
      terminalDoneOk: false;
      provenance: null;
    });

/** Nonsecret coordinate; the HMAC capability and prompt prefix live in a 0600 sidecar. */
export interface BrowserRemoteRecoveryMetadata {
  schema: "remote-browser-recovery-public.v1";
  stage:
    | "assistant-timeout"
    | "assistant-recheck"
    | "capture-binding"
    | "submit-prompt"
    | "connection-lost";
  originRunId: string;
  expiresAt: string;
  accountId: string;
  laneId?: string | null;
  runtime: {
    tabUrl: string;
    conversationId: string;
    promptSubmitted: true;
  };
}

/**
 * Short-lived, nonsecret ownership marker for committing a recovered answer.
 * The public recovery coordinate remains in place while this claim exists so
 * a crashed writer can release/retry without orphaning the private sidecar.
 */
export interface BrowserRemoteRecoveryCompletionClaim {
  schema: "remote-browser-recovery-completion-claim.v1";
  originRunId: string;
  claimId: string;
  claimedAt: string;
  ownerPid: number;
  /** Linux process start tick, when available, to distinguish PID reuse. */
  ownerStartToken?: string;
}

export interface BrowserMetadata {
  config?: BrowserSessionConfig;
  runtime?: BrowserRuntimeMetadata;
  /**
   * Present only for a metadata-only manual URL import. This is explicitly
   * untrusted and carries no account, lane, model, mode, or answer proof.
   */
  importedConversation?: ImportedChatgptConversationMetadata;
  /**
   * Normalized ownership preview for the most recently submitted browser
   * prompt. Unlike `options.prompt`, this advances after in-conversation
   * follow-ups and is therefore the authoritative local recovery prompt.
   */
  submittedPromptPreview?: string;
  /** Full normalized DOM-identity SHA-256 paired with `submittedPromptPreview`. */
  submittedPromptDomSha256?: string;
  harvest?: BrowserHarvestMetadata;
  archive?: BrowserArchiveResult;
  modelSelection?: BrowserModelSelectionEvidence;
  remoteRun?: BrowserRemoteRunEvidence;
  remoteRecovery?: BrowserRemoteRecoveryMetadata;
  remoteRecoveryCompletionClaim?: BrowserRemoteRecoveryCompletionClaim;
  warnings?: BrowserRunWarning[];
}

export type ClaudeCodeModelVerificationStatus =
  | "requested_only"
  | "observed"
  | "fallback_observed"
  | "unknown";

export interface ClaudeCodeReadOnlyPolicy {
  readOnly: true;
  permissionMode: "plan";
  toolMode: "none";
  allowedTools: string[];
  blockedTools: string[];
  mcpToolsBlocked: boolean;
  slashCommandsDisabled: boolean;
  safeMode: boolean;
  chromeDisabled: boolean;
  sessionPersistenceDisabled: boolean;
}

export interface ClaudeCodeArtifactPaths {
  rawStdoutPath: string;
  rawStderrPath: string;
  normalizedEventsPath: string;
  finalAnswerPath?: string;
  progressPath?: string;
  adapterMetadataPath: string;
}

export interface ClaudeCodeSessionMetadata {
  schema_version: "claude_code_session.v1";
  access_path: "claude_code_subscription_cli";
  provider_family: "claude";
  model_requested?: string;
  model_observed?: string | null;
  model_resolved_from_init?: string | null;
  model_usage_keys: string[];
  model_usage_auxiliary_keys?: string[];
  model_verification_status: ClaudeCodeModelVerificationStatus;
  total_cost_usd_observed?: number | null;
  /**
   * Multi-turn resume primitive (claude-provider-map.md finding #2): the
   * stable UUID the reviewed run actually passed as `--session-id`, or the
   * UUID a follow-up actually passed as `--resume`. Absent for historical
   * non-persistent compatibility one-shots.
   */
  claude_session_id?: string;
  /**
   * caam shallow-spawn profile actually used for this run (caam-map.md
   * §4), or absent when the run used the real, unprofiled `$HOME`. A
   * `--followup` resume MUST use this exact same value (undefined counts
   * as its own value, "no profile") or it is refused before it ever spawns
   * — resuming under a different `$HOME` would attach to the wrong
   * on-disk Claude Code identity.
   */
  caam_profile?: string;
  subscription_billing_uncertain: true;
  credit_billing_warning_emitted: boolean;
  read_only: ClaudeCodeReadOnlyPolicy;
  local_owner_verified?: boolean;
  anthropic_api_key_present?: boolean;
  anthropic_api_key_refusal_checked?: boolean;
  child_env_scrubbed?: boolean;
  transcript_fidelity: "visible_cli_stream";
  hidden_reasoning_captured: false;
  visible_thinking_captured: boolean | "unknown";
  exit_code?: number | null;
  signal?: string | null;
  events_complete?: boolean;
  streams_complete?: boolean;
  stdout_events?: number;
  stdout_bytes?: number;
  stderr_events?: number;
  stderr_bytes?: number;
  artifact_paths?: ClaudeCodeArtifactPaths;
  adapter_metadata_path?: string;
  raw_stdout_path?: string;
  raw_stderr_path?: string;
  normalized_events_path?: string;
  final_answer_path?: string;
  progress_path?: string;
  error_reason?: string;
  /**
   * caam rate-limit rotation record (caam-ratelimit-rotation-design.md
   * §3.2), populated only when caam shallow-spawn was active for this run.
   * `attempts` includes the original attempt plus every profile rotated
   * through; `exhausted` is true when rotation stopped because no further
   * healthy profile was available (`NO_PROFILES`/`ALL_BLOCKED`/cap reached),
   * not because of a crash.
   */
  rate_limit_rotation?: {
    attempts: Array<{
      profile?: string;
      outcome: "rate_limited" | "challenge" | "success" | "error";
      matched_pattern?: string;
      started_at?: string;
      elapsed_ms?: number;
      exit_code?: number | null;
    }>;
    rotations_used: number;
    exhausted: boolean;
  };
  /**
   * Set when any attempt (original or rotated) hit a challenge/auth
   * signal — this is always a HARD-HALT, never followed by rotation
   * (caam-ratelimit-rotation-design.md §2.2 step 10, §3.3).
   */
  challenge_detected?: { profile?: string; reason: string };
}

export type SessionArtifactValidationType = "generic" | "zip";
export type SessionArtifactTransferStatus =
  | "not-needed"
  | "ready"
  | "streaming"
  | "completed"
  | "failed"
  | "skipped";

export interface SessionArtifactValidation {
  type: SessionArtifactValidationType;
  ok: boolean;
  error?: string;
}

export interface SessionArtifactTransfer {
  status: SessionArtifactTransferStatus;
  bytes?: number;
  error?: string;
}

export interface SessionArtifactOrigin {
  mode: "local" | "bridge";
  host?: string;
}

export interface SessionArtifact {
  kind:
    | "transcript"
    | "deep-research-report"
    | "image"
    | "file"
    | "claude-code-stdout-raw"
    | "claude-code-stderr-raw"
    | "claude-code-events-normalized"
    | "claude-code-final"
    | "claude-code-progress"
    | "claude-code-adapter";
  path: string;
  label?: string;
  mimeType?: string;
  sizeBytes?: number;
  sourceUrl?: string;
  sha256?: string;
  validation?: SessionArtifactValidation;
  transfer?: SessionArtifactTransfer;
  origin?: SessionArtifactOrigin;
}

export interface SessionResponseMetadata {
  id?: string;
  requestId?: string | null;
  status?: string;
  incompleteReason?: string | null;
}

export interface SessionTransportMetadata {
  reason?: TransportFailureReason;
}

export interface SessionUserErrorMetadata {
  category?: string;
  message?: string;
  details?: Record<string, unknown>;
}

export interface SessionEvidenceMetadata {
  prompt_sha256: string;
  prompt_manifest_sha256: string;
  prompt_bytes: number;
  provider_boundary_pav?: ProviderBoundaryPavMetadata;
}

export type SessionProviderBoundaryOptions = Omit<
  CreateProviderBoundaryPavSnapshotInput,
  "providerPrompt"
>;

export interface StoredRunOptions {
  prompt?: string;
  file?: string[];
  maxFileSizeBytes?: number;
  model?: string;
  models?: ModelName[];
  /** Responses API chaining (maps to `previous_response_id`). */
  previousResponseId?: string;
  /** Optional parent session slug when using `--followup <sessionId>`. */
  followupSessionId?: string;
  /** Optional model selector used with --followup-model for multi-model parent sessions. */
  followupModel?: string;
  /** Browser session this run continues as a child follow-up. */
  parentSessionId?: string;
  /** Alias for parentSessionId used by follow-up APIs. */
  followUpOfSessionId?: string;
  maxInput?: number;
  system?: string;
  maxOutput?: number;
  silent?: boolean;
  filesReport?: boolean;
  slug?: string;
  mode?: SessionMode;
  browserConfig?: BrowserSessionConfig;
  verbose?: boolean;
  heartbeatIntervalMs?: number;
  browserAttachments?: "auto" | "never" | "always";
  browserInlineFiles?: boolean;
  browserBundleFiles?: boolean;
  browserBundleFormat?: BrowserBundleFormat;
  background?: boolean;
  search?: boolean;
  provider?: ApiProviderMode;
  baseUrl?: string;
  azure?: AzureOptions;
  effectiveModelId?: string;
  modelOverrides?: ModelOverridesConfig;
  renderPlain?: boolean;
  writeOutputPath?: string;
  partialMode?: PartialMode;
  timeoutSeconds?: number | "auto";
  httpTimeoutMs?: number;
  zombieTimeoutMs?: number;
  zombieUseLastActivity?: boolean;
  /** Whether the run preferred to stay attached (true) or detach (false). */
  waitPreference?: boolean;
  youtube?: string;
  generateImage?: string;
  editImage?: string;
  outputPath?: string;
  browserFollowUps?: string[];
  browserResumeConversationUrl?: string;
  aspectRatio?: string;
  geminiShowThoughts?: boolean;
  /** Deep Think fallback policy ("fail" = refuse the unverified HTTP fallback). */
  geminiDeepThinkFallback?: "fail";
  providerBoundary?: SessionProviderBoundaryOptions;
  lane?: string;
  /** See the matching field on `RunOracleOptions` (`oracle/types.ts`). */
  laneInferenceSource?: "lane" | "legacy-engine-model" | "mcp-lane" | "mcp-engine-model";
  claudeCode?: {
    executable?: string;
    caamProfile?: string;
    caamBase?: string;
    model?: string;
    readOnly: true;
    inlineEvents: true;
    outputFormat: "stream-json";
    permissionMode: "plan";
    toolMode: "none";
    bareMode?: boolean;
    safeMode?: boolean;
    disableSlashCommands: true;
    strictMcpConfig: true;
    noChrome: true;
    /** See the matching field on `RunOracleOptions.claudeCode` (`oracle/types.ts`). */
    noSessionPersistence: boolean;
    /** See the matching field on `RunOracleOptions.claudeCode` (`oracle/types.ts`). */
    resumeSessionId?: string;
    waitForLockMs?: number;
    maxInlineBytes?: number;
  };
}

export interface SessionMetadata {
  id: string;
  createdAt: string;
  status: string;
  parentSessionId?: string;
  followUpOfSessionId?: string;
  promptPreview?: string;
  model?: string;
  models?: SessionModelRun[];
  cwd?: string;
  options: StoredRunOptions;
  notifications?: SessionNotifications;
  startedAt?: string;
  completedAt?: string;
  mode?: SessionMode;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    totalTokens: number;
    cost?: number;
  };
  errorMessage?: string;
  elapsedMs?: number;
  browser?: BrowserMetadata;
  lane?: string;
  claudeCode?: ClaudeCodeSessionMetadata;
  artifacts?: SessionArtifact[];
  evidence?: SessionEvidenceMetadata;
  response?: SessionResponseMetadata;
  transport?: SessionTransportMetadata;
  error?: SessionUserErrorMetadata;
  lifecycle?: SessionLifecycleMetadata;
}

export type SessionStatus =
  | "pending"
  | "running"
  | "completed"
  | "partial"
  | "error"
  | "cancelled"
  | "imported";

export interface SessionLifecycleMetadata {
  engine: "api" | "browser" | "claude-code";
  execution: "foreground" | "background";
  attached: boolean;
  detached: boolean;
  reattachCommand: string;
}

export interface SessionModelRun {
  model: string;
  status: SessionStatus;
  queuedAt?: string;
  startedAt?: string;
  completedAt?: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    totalTokens: number;
    cost?: number;
  };
  response?: SessionResponseMetadata;
  transport?: SessionTransportMetadata;
  error?: SessionUserErrorMetadata;
  evidence?: SessionEvidenceMetadata;
  log?: {
    path: string;
    bytes?: number;
  };
}

export interface SessionNotifications {
  enabled: boolean;
  sound: boolean;
}

interface SessionLogWriter {
  stream: WriteStream;
  logLine: (line?: string) => void;
  writeChunk: (chunk: string) => boolean;
  logPath: string;
}

interface InitializeSessionOptions extends StoredRunOptions {
  prompt?: string;
  model: string;
}

export function getSessionsDir(): string {
  return path.join(getOracleHomeDir(), "sessions");
}
const METADATA_FILENAME = "meta.json";
const LEGACY_SESSION_FILENAME = "session.json";
const LEGACY_REQUEST_FILENAME = "request.json";
const MODELS_DIRNAME = "models";
const MODEL_JSON_EXTENSION = ".json";
const MODEL_LOG_EXTENSION = ".log";
const MAX_STATUS_LIMIT = 1000;
const ZOMBIE_MAX_AGE_MS = 60 * 60 * 1000; // 60 minutes
const CHROME_RUNTIME_TIMEOUT_MS = 250;
const DEFAULT_SLUG = "session";
const MAX_SLUG_WORDS = 5;
const MIN_CUSTOM_SLUG_WORDS = 3;
const MAX_SLUG_WORD_LENGTH = 10;
const ALREADY_EXISTS_ERROR_CODES = new Set(["EEXIST"]);
const BROWSER_SESSION_MODES = new Set<SessionMode>(["browser"]);
const RUNNING_SESSION_STATUSES = new Set<string>(["running"]);
const TERMINAL_MODEL_RUN_STATUSES = new Set<SessionModelRun["status"]>([
  "completed",
  "partial",
  "error",
  "cancelled",
  "imported",
]);
const ERROR_MODEL_RUN_STATUSES = new Set<SessionModelRun["status"]>(["error"]);
const CANCELLED_MODEL_RUN_STATUSES = new Set<SessionModelRun["status"]>(["cancelled"]);

async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

export async function ensureSessionStorage(): Promise<void> {
  await ensureDir(getSessionsDir());
}

function slugify(text: string | undefined, maxWords = MAX_SLUG_WORDS): string {
  const normalized = text?.toLowerCase() ?? "";
  const words = normalized.match(/[a-z0-9]+/g) ?? [];
  const trimmed = words.slice(0, maxWords).map((word) => word.slice(0, MAX_SLUG_WORD_LENGTH));
  return trimmed.length > 0 ? trimmed.join("-") : DEFAULT_SLUG;
}

function countSlugWords(slug: string): number {
  return slug.split("-").filter(Boolean).length;
}

function normalizeCustomSlug(candidate: string): string {
  const slug = slugify(candidate, MAX_SLUG_WORDS);
  const wordCount = countSlugWords(slug);
  if (wordCount < MIN_CUSTOM_SLUG_WORDS || wordCount > MAX_SLUG_WORDS) {
    throw new Error(
      `Custom slug must include between ${MIN_CUSTOM_SLUG_WORDS} and ${MAX_SLUG_WORDS} words.`,
    );
  }
  return slug;
}

export function createSessionId(prompt: string, customSlug?: string): string {
  if (customSlug) {
    return normalizeCustomSlug(customSlug);
  }
  return slugify(prompt);
}

export function createPromptEvidence(
  prompt: string | Buffer,
  providerBoundary?: SessionProviderBoundaryOptions,
): SessionEvidenceMetadata {
  const promptBytes = Buffer.isBuffer(prompt) ? prompt : Buffer.from(prompt, "utf8");
  const promptSha256 = `sha256:${createHash("sha256").update(promptBytes).digest("hex")}`;
  const evidence: SessionEvidenceMetadata = {
    prompt_sha256: promptSha256,
    prompt_manifest_sha256: promptSha256,
    prompt_bytes: promptBytes.byteLength,
  };
  if (providerBoundary) {
    const providerPrompt = Buffer.isBuffer(prompt) ? prompt.toString("utf8") : prompt;
    evidence.provider_boundary_pav = createProviderBoundaryPavSnapshot({
      providerPrompt,
      ...providerBoundary,
    }).metadata;
  }
  return evidence;
}

function assertSafeSessionId(id: string): void {
  if (
    id.length === 0 ||
    id === "." ||
    id === ".." ||
    id.includes("/") ||
    id.includes("\\") ||
    id.includes("\0")
  ) {
    throw new Error(`Invalid session id: "${id}"`);
  }
}

function sessionDir(id: string): string {
  assertSafeSessionId(id);
  return path.join(getSessionsDir(), id);
}

function metaPath(id: string): string {
  return path.join(sessionDir(id), METADATA_FILENAME);
}

function requestPath(id: string): string {
  return path.join(sessionDir(id), LEGACY_REQUEST_FILENAME);
}

function legacySessionPath(id: string): string {
  return path.join(sessionDir(id), LEGACY_SESSION_FILENAME);
}

function logPath(id: string): string {
  return path.join(sessionDir(id), "output.log");
}

function modelsDir(id: string): string {
  return path.join(sessionDir(id), MODELS_DIRNAME);
}

function modelJsonPath(id: string, model: string): string {
  const slug = safeModelSlug(model);
  return path.join(modelsDir(id), `${slug}${MODEL_JSON_EXTENSION}`);
}

function modelLogPath(id: string, model: string): string {
  const slug = safeModelSlug(model);
  return path.join(modelsDir(id), `${slug}${MODEL_LOG_EXTENSION}`);
}

async function fileExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function isAlreadyExistsError(error: unknown): boolean {
  const record = error as { code?: unknown } | null | undefined;
  return ALREADY_EXISTS_ERROR_CODES.has(`${record?.code ?? ""}`);
}

async function createUniqueSessionDir(
  baseSlug: string,
): Promise<{ sessionId: string; dir: string }> {
  let candidate = baseSlug;
  let suffix = 2;
  for (;;) {
    const dir = sessionDir(candidate);
    try {
      await fs.mkdir(dir);
      return { sessionId: candidate, dir };
    } catch (error) {
      if (!isAlreadyExistsError(error)) {
        throw error;
      }
      candidate = `${baseSlug}-${suffix}`;
      suffix += 1;
    }
  }
}

async function listModelRunFiles(sessionId: string): Promise<SessionModelRun[]> {
  const dir = modelsDir(sessionId);
  const entries = await fs.readdir(dir).catch(() => []);
  const result: SessionModelRun[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(MODEL_JSON_EXTENSION)) {
      continue;
    }
    const jsonPath = path.join(dir, entry);
    try {
      const raw = await fs.readFile(jsonPath, "utf8");
      const parsed = JSON.parse(raw) as SessionModelRun;
      const normalized = ensureModelLogReference(sessionId, parsed);
      result.push(normalized);
    } catch {
      // ignore malformed model files
    }
  }
  return result;
}

function ensureModelLogReference(sessionId: string, record: SessionModelRun): SessionModelRun {
  const logPathRelative =
    record.log?.path ?? path.relative(sessionDir(sessionId), modelLogPath(sessionId, record.model));
  return {
    ...record,
    log: { path: logPathRelative, bytes: record.log?.bytes },
  };
}

async function readModelRunFile(sessionId: string, model: string): Promise<SessionModelRun | null> {
  try {
    const raw = await fs.readFile(modelJsonPath(sessionId, model), "utf8");
    const parsed = JSON.parse(raw) as SessionModelRun;
    return ensureModelLogReference(sessionId, parsed);
  } catch {
    return null;
  }
}

export async function updateModelRunMetadata(
  sessionId: string,
  model: string,
  updates: Partial<SessionModelRun>,
): Promise<SessionModelRun> {
  // Serialized with updateSessionMetadata: both mutate files that
  // persistSessionMetadata may rewrite (models/*.json), so the
  // read-merge-write must not interleave within this process.
  return withSessionMetadataLock(sessionId, async () => {
    const sessionMetadata = await readRawSessionMetadata(sessionId);
    if (hasImportedChatgptConversationClaim(sessionMetadata)) {
      throw new Error(
        `Session "${sessionId}" is an imported ChatGPT conversation; model-run updates are refused. Use the strict conversation import command with --force to replace it.`,
      );
    }
    await ensureDir(modelsDir(sessionId));
    const existing = (await readModelRunFile(sessionId, model)) ?? {
      model,
      status: "pending",
    };
    const next: SessionModelRun = ensureModelLogReference(sessionId, {
      ...existing,
      ...updates,
      model,
    });
    await atomicWriteFileUtf8(modelJsonPath(sessionId, model), JSON.stringify(next, null, 2));
    return next;
  });
}

export async function readModelRunMetadata(
  sessionId: string,
  model: string,
): Promise<SessionModelRun | null> {
  return readModelRunFile(sessionId, model);
}

export async function initializeSession(
  options: InitializeSessionOptions,
  cwd: string,
  notifications?: SessionNotifications,
  baseSlugOverride?: string,
): Promise<SessionMetadata> {
  await ensureSessionStorage();
  const baseSlug =
    baseSlugOverride || createSessionId(options.prompt || DEFAULT_SLUG, options.slug);
  const { sessionId } = await createUniqueSessionDir(baseSlug);
  const mode = options.mode ?? "api";
  const browserConfig = options.browserConfig;
  const evidence = createPromptEvidence(options.prompt ?? "", options.providerBoundary);
  const modelList: ModelName[] =
    Array.isArray(options.models) && options.models.length > 0
      ? options.models
      : options.model
        ? [options.model as ModelName]
        : [];

  const metadata: SessionMetadata = {
    id: sessionId,
    createdAt: new Date().toISOString(),
    status: "pending",
    promptPreview: (options.prompt || "").slice(0, 160),
    model: modelList[0] ?? options.model,
    models: modelList.map((modelName) => ({
      model: modelName,
      status: "pending",
    })),
    cwd,
    mode,
    parentSessionId: options.parentSessionId,
    followUpOfSessionId: options.followUpOfSessionId,
    browser: browserConfig ? { config: browserConfig } : undefined,
    lane: options.lane,
    claudeCode: undefined,
    evidence,
    notifications,
    options: {
      prompt: options.prompt,
      file: options.file ?? [],
      maxFileSizeBytes: options.maxFileSizeBytes,
      model: options.model,
      models: modelList,
      previousResponseId: options.previousResponseId,
      followupSessionId: options.followupSessionId,
      followupModel: options.followupModel,
      parentSessionId: options.parentSessionId,
      followUpOfSessionId: options.followUpOfSessionId,
      effectiveModelId: options.effectiveModelId,
      modelOverrides: options.modelOverrides,
      maxInput: options.maxInput,
      system: options.system,
      maxOutput: options.maxOutput,
      silent: options.silent,
      filesReport: options.filesReport,
      slug: sessionId,
      mode,
      browserConfig,
      verbose: options.verbose,
      heartbeatIntervalMs: options.heartbeatIntervalMs,
      browserAttachments: options.browserAttachments,
      browserInlineFiles: options.browserInlineFiles,
      browserBundleFiles: options.browserBundleFiles,
      browserBundleFormat: options.browserBundleFormat,
      background: options.background,
      search: options.search,
      provider: options.provider,
      baseUrl: options.baseUrl,
      azure: options.azure,
      timeoutSeconds: options.timeoutSeconds,
      httpTimeoutMs: options.httpTimeoutMs,
      zombieTimeoutMs: options.zombieTimeoutMs,
      zombieUseLastActivity: options.zombieUseLastActivity,
      writeOutputPath: options.writeOutputPath,
      partialMode: options.partialMode,
      waitPreference: options.waitPreference,
      youtube: options.youtube,
      generateImage: options.generateImage,
      editImage: options.editImage,
      outputPath: options.outputPath,
      browserFollowUps: options.browserFollowUps,
      browserResumeConversationUrl: options.browserResumeConversationUrl,
      aspectRatio: options.aspectRatio,
      geminiShowThoughts: options.geminiShowThoughts,
      geminiDeepThinkFallback: options.geminiDeepThinkFallback,
      lane: options.lane,
      laneInferenceSource: options.laneInferenceSource,
      claudeCode: options.claudeCode,
    },
  };
  await ensureDir(modelsDir(sessionId));
  // Honor the module's tmp-file + rename invariant on creation too, so a
  // concurrent reader (`oracle status --json`) or a crash mid-write never
  // observes a torn meta.json / model JSON that would drop the session
  // from listings.
  await atomicWriteFileUtf8(metaPath(sessionId), JSON.stringify(metadata, null, 2));
  await Promise.all(
    (modelList.length > 0 ? modelList : [metadata.model ?? DEFAULT_MODEL]).map(
      async (modelName) => {
        const jsonPath = modelJsonPath(sessionId, modelName);
        const logFilePath = modelLogPath(sessionId, modelName);
        const modelRecord: SessionModelRun = {
          model: modelName,
          status: "pending",
          evidence,
          log: { path: path.relative(sessionDir(sessionId), logFilePath) },
        };
        await atomicWriteFileUtf8(jsonPath, JSON.stringify(modelRecord, null, 2));
        await fs.writeFile(logFilePath, "", "utf8");
      },
    ),
  );
  await fs.writeFile(logPath(sessionId), "", "utf8");
  return metadata;
}

export async function readSessionMetadata(sessionId: string): Promise<SessionMetadata | null> {
  const modern = await readModernSessionMetadata(sessionId, { reconcile: true, persist: false });
  if (modern) {
    return modern;
  }
  const legacy = await readLegacySessionMetadata(sessionId, { reconcile: true, persist: false });
  if (legacy) {
    return legacy;
  }
  return null;
}

// ─── Serialized session-metadata updates ─────────────────────────────────────
//
// updateSessionMetadata / updateModelRunMetadata are read-modify-write
// cycles over shared files. Two layers of protection against lost
// updates (same pattern as src/oracle/v18/artifact_index_lock.ts):
//
//   1. In-process per-session async mutex (promise queue keyed on the
//      session directory), so concurrent callers in one Node process
//      never interleave the read-merge-write window.
//
//   2. Cross-process optimistic-concurrency guard: capture a stat
//      fingerprint of meta.json at read time and re-check it just
//      before writing. If another process replaced the file in
//      between (e.g. a background runner completing while `oracle
//      session --live` harvests), re-read and re-merge instead of
//      blindly overwriting the fresher state; fail loud after
//      repeated conflicts instead of silently reverting.
//
//   3. Cross-process advisory lock (an O_EXCL sentinel lockfile next
//      to meta.json) held across the re-stat + rename critical
//      section. The fingerprint re-check and the rename are two
//      separate syscalls, so a cooperating writer in another process
//      could otherwise land its own rename in the sub-millisecond
//      window between them. Holding the sentinel only around that
//      tiny section keeps hold time near a single stat+rename while
//      closing the residual TOCTOU window for cooperating writers;
//      a crashed holder is reclaimed by PID-liveness / staleness, and
//      an uncontended lock never blocks. This narrows — but, against a
//      non-cooperating raw writer, cannot fully guarantee — atomicity.
//
// Writes themselves are tmp-file + rename so readers (and crashes)
// never observe a torn meta.json.

const SESSION_META_LOCKS = new Map<string, Promise<void>>();

async function withSessionMetadataLock<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
  const key = path.resolve(sessionDir(sessionId));
  const prior = SESSION_META_LOCKS.get(key) ?? Promise.resolve();
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chained = prior.then(() => gate);
  SESSION_META_LOCKS.set(key, chained);
  await prior;
  try {
    return await work();
  } finally {
    release();
    if (SESSION_META_LOCKS.get(key) === chained) {
      SESSION_META_LOCKS.delete(key);
    }
  }
}

interface MetadataFileFingerprint {
  ino: bigint;
  mtimeNs: bigint;
  size: bigint;
}

async function statMetadataFingerprint(filePath: string): Promise<MetadataFileFingerprint | null> {
  try {
    const stats = await fs.stat(filePath, { bigint: true });
    return { ino: stats.ino, mtimeNs: stats.mtimeNs, size: stats.size };
  } catch {
    return null;
  }
}

function metadataFingerprintsEqual(
  left: MetadataFileFingerprint | null,
  right: MetadataFileFingerprint | null,
): boolean {
  if (left === null || right === null) {
    return left === right;
  }
  return left.ino === right.ino && left.mtimeNs === right.mtimeNs && left.size === right.size;
}

async function atomicWriteFileUtf8(filePath: string, contents: string): Promise<void> {
  await ensureDir(path.dirname(filePath));
  // Unique tmpfile in the same directory so the rename stays on one FS
  // and replaces the target atomically (new inode on every write, which
  // also strengthens the fingerprint guard above).
  const tmpPath = `${filePath}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
  try {
    await fs.writeFile(tmpPath, contents, "utf8");
    await fs.rename(tmpPath, filePath);
  } catch (error) {
    await fs.rm(tmpPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

// ─── Cross-process advisory lock for the meta.json critical section ───────────
//
// An O_EXCL sentinel lockfile next to meta.json, held only around the
// re-stat + rename in updateSessionMetadata so a cooperating writer in
// another process cannot slip a rename between our fingerprint re-check
// and our own rename. Hold time is ~one stat + one rename. A crashed
// holder is reclaimed (dead PID or stale mtime); an uncontended lock is
// acquired on the first open with no timers. If the lock cannot be
// acquired within the bounded wait we proceed best-effort (never worse
// than the fingerprint-only guard).
const META_LOCK_STALE_MS = 10_000;
const META_LOCK_POLL_MS = 5;
const META_LOCK_MAX_WAIT_MS = 2_000;

function metaLockPath(sessionId: string): string {
  return `${metaPath(sessionId)}.lock`;
}

async function metaLockIsStale(lockPath: string): Promise<boolean> {
  try {
    const [stats, raw] = await Promise.all([
      fs.stat(lockPath),
      fs.readFile(lockPath, "utf8").catch(() => ""),
    ]);
    const ownerPid = Number.parseInt(raw.trim(), 10);
    if (Number.isInteger(ownerPid) && ownerPid > 0 && !isProcessAlive(ownerPid)) {
      return true;
    }
    return Date.now() - stats.mtimeMs > META_LOCK_STALE_MS;
  } catch {
    // Lock vanished between the failed open and this check — reclaimable.
    return true;
  }
}

async function acquireMetaLock(lockPath: string): Promise<boolean> {
  const deadline = Date.now() + META_LOCK_MAX_WAIT_MS;
  for (;;) {
    try {
      const handle = await fs.open(lockPath, "wx");
      try {
        await handle.writeFile(`${process.pid}`);
      } finally {
        await handle.close();
      }
      return true;
    } catch (error) {
      if (!isAlreadyExistsError(error)) {
        // Missing parent dir or other unexpected error: skip the lock and
        // fall back to the fingerprint-only guard rather than failing.
        return false;
      }
      if (await metaLockIsStale(lockPath)) {
        await fs.rm(lockPath, { force: true }).catch(() => undefined);
        continue;
      }
      if (Date.now() >= deadline) {
        return false;
      }
      await wait(META_LOCK_POLL_MS);
    }
  }
}

async function releaseMetaLock(lockPath: string): Promise<void> {
  await fs.rm(lockPath, { force: true }).catch(() => undefined);
}

/**
 * Compute a metadata patch from the freshest on-disk state. Called under
 * the per-session lock (and re-called after an optimistic-concurrency
 * retry), so it must be side-effect free with respect to session storage
 * and must NOT call back into updateSessionMetadata / updateModelRunMetadata
 * for the same session.
 */
export type SessionMetadataUpdater = (
  current: SessionMetadata,
) => Partial<SessionMetadata> | Promise<Partial<SessionMetadata>>;

const MAX_METADATA_UPDATE_ATTEMPTS = 5;

export async function updateSessionMetadata(
  sessionId: string,
  updates: Partial<SessionMetadata> | SessionMetadataUpdater,
): Promise<SessionMetadata> {
  return withSessionMetadataLock(sessionId, async () => {
    const targetPath = metaPath(sessionId);
    const lockPath = metaLockPath(sessionId);
    for (let attempt = 1; attempt <= MAX_METADATA_UPDATE_ATTEMPTS; attempt += 1) {
      const readFingerprint = await statMetadataFingerprint(targetPath);
      const existing =
        (await readModernSessionMetadata(sessionId, { reconcile: false, persist: false })) ??
        (await readLegacySessionMetadata(sessionId, { reconcile: false, persist: false })) ??
        ({ id: sessionId } as SessionMetadata);
      if (hasImportedChatgptConversationClaim(existing)) {
        throw new Error(
          `Session "${sessionId}" is an imported ChatGPT conversation; generic metadata updates are refused. Use the strict conversation import command with --force to replace it.`,
        );
      }
      const patch = typeof updates === "function" ? await updates(existing) : updates;
      const next = normalizeTerminalModelRuns({ ...existing, ...patch });
      // Hold the cross-process sentinel across the re-stat + rename so a
      // cooperating writer in another process cannot land its rename in
      // the window between our fingerprint check and persistSessionMetadata's
      // own rename.
      const locked = await acquireMetaLock(lockPath);
      try {
        // Optimistic-concurrency guard: if another process replaced
        // meta.json since we read it, our merge base is stale — writing it
        // would silently revert the fresher fields (e.g. a terminal status
        // written by the session's runner). Re-read and re-merge instead.
        const writeFingerprint = await statMetadataFingerprint(targetPath);
        if (!metadataFingerprintsEqual(readFingerprint, writeFingerprint)) {
          continue;
        }
        await persistSessionMetadata(next.metadata, next.modelRunsChanged);
        return next.metadata;
      } finally {
        if (locked) {
          await releaseMetaLock(lockPath);
        }
      }
    }
    throw new Error(
      `Session "${sessionId}" metadata kept changing concurrently; aborting update after ${MAX_METADATA_UPDATE_ATTEMPTS} attempts instead of overwriting newer state.`,
    );
  });
}

interface ReadSessionMetadataOptions {
  reconcile: boolean;
  persist: boolean;
}

async function readModernSessionMetadata(
  sessionId: string,
  options: ReadSessionMetadataOptions,
): Promise<SessionMetadata | null> {
  try {
    const raw = await fs.readFile(metaPath(sessionId), "utf8");
    const parsed = JSON.parse(raw) as SessionMetadata | StoredRunOptions;
    if (!isSessionMetadataRecord(parsed)) {
      return null;
    }
    const enriched = await attachModelRuns(parsed, sessionId);
    return options.reconcile ? reconcileSessionMetadata(enriched, options) : enriched;
  } catch {
    return null;
  }
}

async function readLegacySessionMetadata(
  sessionId: string,
  options: ReadSessionMetadataOptions,
): Promise<SessionMetadata | null> {
  try {
    const raw = await fs.readFile(legacySessionPath(sessionId), "utf8");
    const parsed = JSON.parse(raw) as SessionMetadata;
    const enriched = await attachModelRuns(parsed, sessionId);
    return options.reconcile ? reconcileSessionMetadata(enriched, options) : enriched;
  } catch {
    return null;
  }
}

async function readRawSessionMetadata(sessionId: string): Promise<SessionMetadata | null> {
  return (
    (await readModernSessionMetadata(sessionId, { reconcile: false, persist: false })) ??
    (await readLegacySessionMetadata(sessionId, { reconcile: false, persist: false }))
  );
}

async function reconcileSessionMetadata(
  meta: SessionMetadata,
  { persist }: { persist: boolean },
): Promise<SessionMetadata> {
  const deadPatch = await deadBrowserPatch(meta);
  const runtimeChecked: SessionMetadata = deadPatch ? { ...meta, ...deadPatch } : meta;
  const zPatch = await zombiePatch(runtimeChecked);
  const zombieChecked: SessionMetadata = zPatch ? { ...runtimeChecked, ...zPatch } : runtimeChecked;
  const normalized = normalizeTerminalModelRuns(zombieChecked);
  const statusChanged = Boolean(deadPatch || zPatch);
  if (!persist || (!statusChanged && !normalized.modelRunsChanged)) {
    return normalized.metadata;
  }
  // Persist reconciliation through the same in-process lock + cross-process
  // guard as every other writer instead of a raw atomicWriteFileUtf8. A
  // reader process (`oracle status` / `session list`) used to clobber a
  // concurrently-completing runner's terminal state here. The updater
  // recomputes the downgrade against the freshest on-disk state, so if the
  // runner already moved the session out of 'running' we apply an empty
  // patch and leave its fresher fields (and model rows) intact.
  return updateSessionMetadata(meta.id, async (current) => {
    const freshDead = await deadBrowserPatch(current);
    const afterDead: SessionMetadata = freshDead ? { ...current, ...freshDead } : current;
    const freshZombie = await zombiePatch(afterDead);
    return { ...(freshDead ?? {}), ...(freshZombie ?? {}) };
  });
}

function isSessionMetadataRecord(value: unknown): value is SessionMetadata {
  return Boolean(
    value && typeof (value as SessionMetadata).id === "string" && (value as SessionMetadata).status,
  );
}

async function attachModelRuns(meta: SessionMetadata, sessionId: string): Promise<SessionMetadata> {
  const runs = await listModelRunFiles(sessionId);
  if (runs.length === 0) {
    return meta;
  }
  return { ...meta, models: runs };
}

const IN_FLIGHT_MODEL_STATUSES = new Set<SessionModelRun["status"]>(["pending", "running"]);

function terminalModelRunPatch(meta: SessionMetadata): Partial<SessionModelRun> | null {
  const status = meta.status as SessionModelRun["status"];
  if (!TERMINAL_MODEL_RUN_STATUSES.has(status)) {
    return null;
  }
  const patch: Partial<SessionModelRun> = { status };
  if (meta.completedAt) {
    patch.completedAt = meta.completedAt;
  }
  if (meta.response) {
    patch.response = meta.response;
  }
  if (ERROR_MODEL_RUN_STATUSES.has(status)) {
    patch.response = patch.response ?? { status: "error" };
  }
  if (
    (ERROR_MODEL_RUN_STATUSES.has(status) || CANCELLED_MODEL_RUN_STATUSES.has(status)) &&
    meta.error
  ) {
    patch.error = meta.error;
  } else if (
    (ERROR_MODEL_RUN_STATUSES.has(status) || CANCELLED_MODEL_RUN_STATUSES.has(status)) &&
    meta.errorMessage
  ) {
    patch.error = {
      category: "session",
      message: meta.errorMessage,
    };
  }
  return patch;
}

function normalizeTerminalModelRuns(meta: SessionMetadata): {
  metadata: SessionMetadata;
  modelRunsChanged: boolean;
} {
  const patch = terminalModelRunPatch(meta);
  if (!patch || !Array.isArray(meta.models) || meta.models.length === 0) {
    return { metadata: meta, modelRunsChanged: false };
  }
  let modelRunsChanged = false;
  const models = meta.models.map((run) => {
    if (!IN_FLIGHT_MODEL_STATUSES.has(run.status)) {
      return run;
    }
    modelRunsChanged = true;
    return ensureModelLogReference(meta.id, {
      ...run,
      ...patch,
    });
  });
  if (!modelRunsChanged) {
    return { metadata: meta, modelRunsChanged: false };
  }
  return {
    metadata: { ...meta, models },
    modelRunsChanged,
  };
}

async function persistSessionMetadata(
  meta: SessionMetadata,
  persistModelRuns = false,
): Promise<void> {
  await atomicWriteFileUtf8(metaPath(meta.id), JSON.stringify(meta, null, 2));
  if (!persistModelRuns || !Array.isArray(meta.models)) {
    return;
  }
  await ensureDir(modelsDir(meta.id));
  await Promise.all(
    meta.models.map(async (run) => {
      const record = ensureModelLogReference(meta.id, run);
      await atomicWriteFileUtf8(modelJsonPath(meta.id, run.model), JSON.stringify(record, null, 2));
    }),
  );
}

export function createSessionLogWriter(sessionId: string, model?: string): SessionLogWriter {
  let metadata: SessionMetadata | null = null;
  try {
    metadata = JSON.parse(readFileSync(metaPath(sessionId), "utf8")) as SessionMetadata;
  } catch {
    // Preserve the historical missing/unreadable-session behavior: the
    // stream itself reports filesystem failures. Imported records are the
    // sole fail-closed exception because they must remain metadata-only.
  }
  if (hasImportedChatgptConversationClaim(metadata)) {
    throw new Error(
      `Session "${sessionId}" is an imported ChatGPT conversation; log writes are refused. Use the strict conversation import command with --force to replace it.`,
    );
  }
  const targetPath = model ? modelLogPath(sessionId, model) : logPath(sessionId);
  // createWriteStream opens the underlying fd lazily on first write; if the
  // parent dir does not exist yet (non-init callers: resume/recovery paths)
  // the first write races a fire-and-forget mkdir and surfaces ENOENT on
  // the stream's 'error' event. Create the dir synchronously here so the
  // lazy open never sees a missing parent.
  mkdirSync(path.dirname(targetPath), { recursive: true });
  const stream = createWriteStream(targetPath, { flags: "a" });
  const logLine = (line = ""): void => {
    stream.write(`${line}\n`);
  };
  const writeChunk = (chunk: string): boolean => {
    stream.write(chunk);
    return true;
  };
  return { stream, logLine, writeChunk, logPath: targetPath };
}

const SESSION_LIST_CONCURRENCY = 8;

/**
 * Map `items` through `worker` with at most `concurrency` in flight,
 * returning results in input order. Session dirs are independent (each has
 * its own per-session lock), so their reads/reconciles overlap safely.
 */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const limit = Math.max(1, Math.min(concurrency, items.length));
  const runners = Array.from({ length: limit }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) {
        return;
      }
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

export async function listSessionsMetadata(): Promise<SessionMetadata[]> {
  await ensureSessionStorage();
  const entries = await fs.readdir(getSessionsDir()).catch(() => []);
  // Read/reconcile independent session dirs with bounded concurrency so
  // `oracle status` / `oracle session list` latency does not grow linearly
  // with accumulated history. Reconcile persistence still flows through the
  // per-session lock + optimistic-concurrency guard, so overlapping reads
  // never clobber a live run.
  const reconciled = await mapWithConcurrency(entries, SESSION_LIST_CONCURRENCY, async (entry) => {
    const meta = await readRawSessionMetadata(entry);
    if (!meta) {
      return null;
    }
    // Keep stored metadata consistent with status reconciliation done by `oracle status`.
    return reconcileSessionMetadata(meta, { persist: true });
  });
  const metas = reconciled.filter((meta): meta is SessionMetadata => meta !== null);
  return metas.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

export function filterSessionsByRange(
  metas: SessionMetadata[],
  {
    hours = 24,
    includeAll = false,
    limit = 100,
  }: { hours?: number; includeAll?: boolean; limit?: number },
): { entries: SessionMetadata[]; truncated: boolean; total: number } {
  const maxLimit = Math.min(limit, MAX_STATUS_LIMIT);
  let filtered = metas;
  if (!includeAll) {
    const cutoff = Date.now() - hours * 60 * 60 * 1000;
    filtered = metas.filter((meta) => new Date(meta.createdAt).getTime() >= cutoff);
  }
  const limited = filtered.slice(0, maxLimit);
  const truncated = filtered.length > maxLimit;
  return { entries: limited, truncated, total: filtered.length };
}

export async function readSessionLog(sessionId: string): Promise<string> {
  const runs = await listModelRunFiles(sessionId);
  if (runs.length === 0) {
    try {
      return await fs.readFile(logPath(sessionId), "utf8");
    } catch {
      return "";
    }
  }
  const sections: string[] = [];
  let hasContent = false;
  const ordered = runs
    .slice()
    .sort((a, b) =>
      a.startedAt && b.startedAt
        ? a.startedAt.localeCompare(b.startedAt)
        : a.model.localeCompare(b.model),
    );
  for (const run of ordered) {
    const logFile = run.log?.path
      ? path.isAbsolute(run.log.path)
        ? run.log.path
        : path.join(sessionDir(sessionId), run.log.path)
      : modelLogPath(sessionId, run.model);
    let body = "";
    try {
      body = await fs.readFile(logFile, "utf8");
    } catch {
      body = "";
    }
    if (body.length > 0) {
      hasContent = true;
    }
    sections.push(`=== ${run.model} ===\n${body}`.trimEnd());
  }
  if (!hasContent) {
    try {
      return await fs.readFile(logPath(sessionId), "utf8");
    } catch {
      // ignore and return structured header-only log
    }
  }
  return sections.join("\n\n");
}

export async function readModelLog(sessionId: string, model: string): Promise<string> {
  try {
    return await fs.readFile(modelLogPath(sessionId, model), "utf8");
  } catch {
    return "";
  }
}

export async function readSessionRequest(sessionId: string): Promise<StoredRunOptions | null> {
  const modern = await readModernSessionMetadata(sessionId, { reconcile: false, persist: false });
  if (modern?.options) {
    return modern.options;
  }
  try {
    const raw = await fs.readFile(requestPath(sessionId), "utf8");
    const parsed = JSON.parse(raw);
    if (isSessionMetadataRecord(parsed)) {
      return parsed.options ?? null;
    }
    return parsed as StoredRunOptions;
  } catch {
    return null;
  }
}

export interface SessionCleanupCandidate {
  id: string;
  createdMs?: number;
  sizeBytes?: number;
}

export interface SessionCleanupResult {
  deleted: number;
  remaining: number;
  /** Sessions removed (or, with dryRun, sessions that would be removed). */
  sessions: SessionCleanupCandidate[];
  /**
   * Count of live (still-running) sessions skipped to avoid deleting an
   * in-flight run's artifacts mid-run. Optional so existing callers that
   * construct this result without it keep type-checking.
   */
  skippedActive?: number;
}

async function directorySizeBytes(dir: string): Promise<number | undefined> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    let total = 0;
    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        total += (await directorySizeBytes(entryPath)) ?? 0;
      } else if (entry.isFile()) {
        try {
          total += (await fs.stat(entryPath)).size;
        } catch {
          // Ignore files that vanish mid-walk.
        }
      }
    }
    return total;
  } catch {
    return undefined;
  }
}

export async function deleteSessionsOlderThan({
  hours = 24,
  includeAll = false,
  dryRun = false,
}: { hours?: number; includeAll?: boolean; dryRun?: boolean } = {}): Promise<SessionCleanupResult> {
  await ensureSessionStorage();
  const entries = await fs.readdir(getSessionsDir()).catch(() => []);
  if (!entries.length) {
    return { deleted: 0, remaining: 0, sessions: [] };
  }
  const cutoff = includeAll ? Number.NEGATIVE_INFINITY : Date.now() - hours * 60 * 60 * 1000;
  const sessions: SessionCleanupCandidate[] = [];
  let skippedActive = 0;

  for (const entry of entries) {
    const dir = sessionDir(entry);
    let createdMs: number | undefined;
    // readSessionMetadata reconciles status, so a dead browser run / stale
    // zombie is already 'error' here; only a genuinely in-flight run stays
    // 'running'.
    const meta = await readSessionMetadata(entry);
    if (meta?.createdAt) {
      const parsed = Date.parse(meta.createdAt);
      if (!Number.isNaN(parsed)) {
        createdMs = parsed;
      }
    }
    if (createdMs === undefined) {
      try {
        const stats = await fs.stat(dir);
        createdMs = stats.birthtimeMs || stats.mtimeMs;
      } catch {
        continue;
      }
    }
    if (includeAll || (createdMs !== undefined && createdMs < cutoff)) {
      // Liveness guard: never delete an in-flight run out from under its
      // process (its later log/meta writes would break). A windowed clear
      // (`--clear --hours N`, including `--hours 0`) skips live sessions;
      // the explicit full wipe (`--all`, gated behind --yes) is honored.
      if (!includeAll && meta && (await isSessionLive(meta))) {
        skippedActive += 1;
        process.stderr.write(
          `Skipping session "${entry}": still running (skipped to avoid deleting an in-flight run).\n`,
        );
        continue;
      }
      const sizeBytes = await directorySizeBytes(dir);
      if (!dryRun) {
        await fs.rm(dir, { recursive: true, force: true });
      }
      sessions.push({ id: entry, createdMs, sizeBytes });
    }
  }

  const deleted = dryRun ? 0 : sessions.length;
  const remaining = Math.max(entries.length - deleted, 0);
  return { deleted, remaining, sessions, skippedActive };
}

export async function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export { MAX_STATUS_LIMIT };
export { ZOMBIE_MAX_AGE_MS };

export async function getSessionPaths(sessionId: string): Promise<{
  dir: string;
  metadata: string;
  log: string;
  request: string;
}> {
  const dir = sessionDir(sessionId);
  const metadata = metaPath(sessionId);
  const log = logPath(sessionId);
  const request = requestPath(sessionId);

  const required = [metadata, log];
  const missing: string[] = [];
  for (const file of required) {
    if (!(await fileExists(file))) {
      missing.push(path.basename(file));
    }
  }

  if (missing.length > 0) {
    throw new Error(`Session "${sessionId}" is missing: ${missing.join(", ")}`);
  }
  return { dir, metadata, log, request };
}

// Pure reconciliation probes: each returns the status-downgrade patch its
// staleness check warrants, or null when the session should be left alone.
// They perform NO writes — persistence is routed through
// updateSessionMetadata by reconcileSessionMetadata so the lock + OCC guard
// (and terminal model-row propagation) apply uniformly.

async function zombiePatch(meta: SessionMetadata): Promise<Partial<SessionMetadata> | null> {
  if (!(await isZombie(meta))) {
    return null;
  }
  if (BROWSER_SESSION_MODES.has(meta.mode as SessionMode)) {
    const runtime = meta.browser?.runtime;
    if (runtime) {
      const signals: boolean[] = [];
      if (runtime.chromePid) {
        signals.push(isProcessAlive(runtime.chromePid));
      }
      if (runtime.chromePort) {
        const host = runtime.chromeHost ?? "127.0.0.1";
        signals.push(await isPortOpen(host, runtime.chromePort));
      }
      if (signals.some(Boolean)) {
        return null;
      }
    }
  }
  const maxAgeMs = resolveZombieMaxAgeMs(meta);
  return {
    status: "error",
    errorMessage: `Session marked as zombie (> ${formatElapsed(maxAgeMs)} stale)`,
    completedAt: new Date().toISOString(),
  };
}

async function deadBrowserPatch(meta: SessionMetadata): Promise<Partial<SessionMetadata> | null> {
  if (
    !RUNNING_SESSION_STATUSES.has(meta.status) ||
    !BROWSER_SESSION_MODES.has(meta.mode as SessionMode)
  ) {
    return null;
  }
  const runtime = meta.browser?.runtime;
  if (!runtime) {
    return null;
  }
  const signals: boolean[] = [];
  if (runtime.chromePid) {
    signals.push(isProcessAlive(runtime.chromePid));
  }
  if (runtime.chromePort) {
    const host = runtime.chromeHost ?? "127.0.0.1";
    signals.push(await isPortOpen(host, runtime.chromePort));
  }
  if (signals.length === 0 || signals.some(Boolean)) {
    return null;
  }
  const response = meta.response
    ? {
        ...meta.response,
        status: "error",
        incompleteReason: meta.response.incompleteReason ?? "chrome-disconnected",
      }
    : { status: "error", incompleteReason: "chrome-disconnected" };
  return {
    status: "error",
    errorMessage: "Browser session ended (Chrome is no longer reachable)",
    completedAt: new Date().toISOString(),
    response,
  };
}

/**
 * True when a session is still genuinely in flight: reconciliation has
 * already downgraded dead browser runs and stale zombies to a terminal
 * status, so a still-'running' status is authoritative. Where we hold
 * browser runtime handles we re-confirm liveness with the same signals
 * markZombie/markDeadBrowser use, so an in-flight run is never pruned.
 */
async function isSessionLive(meta: SessionMetadata): Promise<boolean> {
  if (!RUNNING_SESSION_STATUSES.has(meta.status)) {
    return false;
  }
  if (BROWSER_SESSION_MODES.has(meta.mode as SessionMode)) {
    const runtime = meta.browser?.runtime;
    if (runtime) {
      const signals: boolean[] = [];
      if (runtime.controllerPid) {
        signals.push(isProcessAlive(runtime.controllerPid));
      }
      if (runtime.chromePid) {
        signals.push(isProcessAlive(runtime.chromePid));
      }
      if (runtime.chromePort) {
        const host = runtime.chromeHost ?? "127.0.0.1";
        signals.push(await isPortOpen(host, runtime.chromePort));
      }
      if (signals.length > 0) {
        return signals.some(Boolean);
      }
    }
  }
  return true;
}

async function isZombie(meta: SessionMetadata): Promise<boolean> {
  if (!RUNNING_SESSION_STATUSES.has(meta.status)) {
    return false;
  }
  const reference = meta.startedAt ?? meta.createdAt;
  if (!reference) {
    return false;
  }
  const startedMs = Date.parse(reference);
  if (Number.isNaN(startedMs)) {
    return false;
  }
  const useLastActivity = meta.options?.zombieUseLastActivity === true;
  const lastActivityMs = useLastActivity ? await getLastActivityMs(meta) : null;
  const anchorMs = lastActivityMs ?? startedMs;
  const maxAgeMs = resolveZombieMaxAgeMs(meta);
  return Date.now() - anchorMs > maxAgeMs;
}

function resolveZombieMaxAgeMs(meta: SessionMetadata): number {
  const explicit = meta.options?.zombieTimeoutMs;
  const hasExplicit = typeof explicit === "number" && Number.isFinite(explicit) && explicit > 0;
  let maxAgeMs = hasExplicit ? explicit : ZOMBIE_MAX_AGE_MS;
  if (!hasExplicit) {
    const timeoutSeconds = meta.options?.timeoutSeconds;
    if (
      typeof timeoutSeconds === "number" &&
      Number.isFinite(timeoutSeconds) &&
      timeoutSeconds > 0
    ) {
      const timeoutMs = timeoutSeconds * 1000;
      if (timeoutMs > maxAgeMs) {
        maxAgeMs = timeoutMs;
      }
    }
  }
  return maxAgeMs;
}

async function getLastActivityMs(meta: SessionMetadata): Promise<number | null> {
  const candidates = new Set<string>();
  candidates.add(logPath(meta.id));
  const modelNames = new Set<string>();
  if (meta.model) {
    modelNames.add(meta.model);
  }
  if (Array.isArray(meta.models)) {
    for (const entry of meta.models) {
      if (entry?.model) {
        modelNames.add(entry.model);
      }
    }
  }
  for (const modelName of modelNames) {
    candidates.add(modelLogPath(meta.id, modelName));
  }
  let latest = 0;
  let sawStat = false;
  for (const candidate of candidates) {
    try {
      const stats = await fs.stat(candidate);
      const mtimeMs = Number.isFinite(stats.mtimeMs) ? stats.mtimeMs : stats.mtime.getTime();
      if (Number.isFinite(mtimeMs)) {
        latest = Math.max(latest, mtimeMs);
        sawStat = true;
      }
    } catch {
      // ignore missing logs; fallback to startedAt
    }
  }
  return sawStat ? latest : null;
}

function isProcessAlive(pid?: number): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
    if (code === "ESRCH" || code === "EINVAL") {
      return false;
    }
    if (code === "EPERM") {
      return true;
    }
    return true;
  }
}

async function isPortOpen(host: string, port: number): Promise<boolean> {
  if (!port || port <= 0 || port > 65535) {
    return false;
  }
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const cleanup = (result: boolean) => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      socket.end();
      socket.destroy();
      socket.unref();
      resolve(result);
    };
    const timer = setTimeout(() => cleanup(false), CHROME_RUNTIME_TIMEOUT_MS);
    socket.once("connect", () => {
      clearTimeout(timer);
      cleanup(true);
    });
    socket.once("error", () => {
      clearTimeout(timer);
      cleanup(false);
    });
  });
}

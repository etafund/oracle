import path from "node:path";
import fs from "node:fs/promises";
import { createWriteStream, mkdirSync } from "node:fs";
import type { WriteStream } from "node:fs";
import net from "node:net";
import { createHash } from "node:crypto";
import type {
  BrowserArchiveMode,
  BrowserArchiveResult,
  BrowserModelStrategy,
  BrowserResearchMode,
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

export interface BrowserMetadata {
  config?: BrowserSessionConfig;
  runtime?: BrowserRuntimeMetadata;
  harvest?: BrowserHarvestMetadata;
  archive?: BrowserArchiveResult;
  modelSelection?: BrowserModelSelectionEvidence;
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
   * stable UUID this run used (or minted) for `--session-id`. Stored on
   * EVERY claude-code run — including one-shot runs, which mint one but
   * never pass it to `claude` — so a later `--followup <thisSessionId>`
   * always has a value to resume from.
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
  providerBoundary?: SessionProviderBoundaryOptions;
  lane?: string;
  claudeCode?: {
    executable?: string;
    caamProfile?: string;
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

export type SessionStatus = "pending" | "running" | "completed" | "partial" | "error" | "cancelled";

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
  await fs.writeFile(modelJsonPath(sessionId, model), JSON.stringify(next, null, 2), "utf8");
  return next;
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
      lane: options.lane,
      claudeCode: options.claudeCode,
    },
  };
  await ensureDir(modelsDir(sessionId));
  await fs.writeFile(metaPath(sessionId), JSON.stringify(metadata, null, 2), "utf8");
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
        await fs.writeFile(jsonPath, JSON.stringify(modelRecord, null, 2), "utf8");
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

export async function updateSessionMetadata(
  sessionId: string,
  updates: Partial<SessionMetadata>,
): Promise<SessionMetadata> {
  const existing =
    (await readModernSessionMetadata(sessionId, { reconcile: false, persist: false })) ??
    (await readLegacySessionMetadata(sessionId, { reconcile: false, persist: false })) ??
    ({ id: sessionId } as SessionMetadata);
  const next = normalizeTerminalModelRuns({ ...existing, ...updates });
  await persistSessionMetadata(next.metadata, next.modelRunsChanged);
  return next.metadata;
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
  const runtimeChecked = await markDeadBrowser(meta, { persist });
  const zombieChecked = await markZombie(runtimeChecked, { persist });
  const normalized = normalizeTerminalModelRuns(zombieChecked);
  if (persist && normalized.modelRunsChanged) {
    await persistSessionMetadata(normalized.metadata, true);
  }
  return normalized.metadata;
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
  await fs.writeFile(metaPath(meta.id), JSON.stringify(meta, null, 2), "utf8");
  if (!persistModelRuns || !Array.isArray(meta.models)) {
    return;
  }
  await ensureDir(modelsDir(meta.id));
  await Promise.all(
    meta.models.map(async (run) => {
      const record = ensureModelLogReference(meta.id, run);
      await fs.writeFile(
        modelJsonPath(meta.id, run.model),
        JSON.stringify(record, null, 2),
        "utf8",
      );
    }),
  );
}

export function createSessionLogWriter(sessionId: string, model?: string): SessionLogWriter {
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

export async function listSessionsMetadata(): Promise<SessionMetadata[]> {
  await ensureSessionStorage();
  const entries = await fs.readdir(getSessionsDir()).catch(() => []);
  const metas: SessionMetadata[] = [];
  for (const entry of entries) {
    let meta = await readRawSessionMetadata(entry);
    if (meta) {
      // Keep stored metadata consistent with status reconciliation done by `oracle status`.
      meta = await reconcileSessionMetadata(meta, { persist: true });
      metas.push(meta);
    }
  }
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

export async function deleteSessionsOlderThan({
  hours = 24,
  includeAll = false,
}: { hours?: number; includeAll?: boolean } = {}): Promise<{ deleted: number; remaining: number }> {
  await ensureSessionStorage();
  const entries = await fs.readdir(getSessionsDir()).catch(() => []);
  if (!entries.length) {
    return { deleted: 0, remaining: 0 };
  }
  const cutoff = includeAll ? Number.NEGATIVE_INFINITY : Date.now() - hours * 60 * 60 * 1000;
  let deleted = 0;

  for (const entry of entries) {
    const dir = sessionDir(entry);
    let createdMs: number | undefined;
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
      await fs.rm(dir, { recursive: true, force: true });
      deleted += 1;
    }
  }

  const remaining = Math.max(entries.length - deleted, 0);
  return { deleted, remaining };
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

async function markZombie(
  meta: SessionMetadata,
  { persist }: { persist: boolean },
): Promise<SessionMetadata> {
  if (!(await isZombie(meta))) {
    return meta;
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
        return meta;
      }
    }
  }
  const maxAgeMs = resolveZombieMaxAgeMs(meta);
  const updated: SessionMetadata = {
    ...meta,
    status: "error",
    errorMessage: `Session marked as zombie (> ${formatElapsed(maxAgeMs)} stale)`,
    completedAt: new Date().toISOString(),
  };
  if (persist) {
    await fs.writeFile(metaPath(meta.id), JSON.stringify(updated, null, 2), "utf8");
  }
  return updated;
}

async function markDeadBrowser(
  meta: SessionMetadata,
  { persist }: { persist: boolean },
): Promise<SessionMetadata> {
  if (
    !RUNNING_SESSION_STATUSES.has(meta.status) ||
    !BROWSER_SESSION_MODES.has(meta.mode as SessionMode)
  ) {
    return meta;
  }
  const runtime = meta.browser?.runtime;
  if (!runtime) {
    return meta;
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
    return meta;
  }
  const response = meta.response
    ? {
        ...meta.response,
        status: "error",
        incompleteReason: meta.response.incompleteReason ?? "chrome-disconnected",
      }
    : { status: "error", incompleteReason: "chrome-disconnected" };
  const updated: SessionMetadata = {
    ...meta,
    status: "error",
    errorMessage: "Browser session ended (Chrome is no longer reachable)",
    completedAt: new Date().toISOString(),
    response,
  };
  if (persist) {
    await fs.writeFile(metaPath(meta.id), JSON.stringify(updated, null, 2), "utf8");
  }
  return updated;
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

import type { BrowserSessionConfig } from "../sessionStore.js";
import type {
  RemoteBrowserRecoveryRequest,
  RemoteRunPayload,
  RemoteAttachmentPayload,
  RemotePromptFallbackPolicy,
  RemoteSessionRecoveryStage,
} from "./types.js";
import {
  REMOTE_BROWSER_RECOVERY_PROTOCOL,
  REMOTE_BROWSER_RUN_SCHEMA,
  REMOTE_SESSION_RECOVERY_STAGES,
} from "./types.js";
import { createHash } from "node:crypto";
import path from "node:path";
import { extractConversationIdFromUrl } from "../browser/conversationIdentity.js";
import { sanitizeRemoteRunRecoveryHint } from "./recovery.js";

// Single home for the bounds applied to client-influenced run timings on the
// host. `<= 0` is a documented disable sentinel for timeoutMs downstream
// (unbounded waits / skipped locks), so a remote payload must never be able
// to reach it: nonsensical values are dropped (server default wins) and
// legitimate extremes are clamped so one caller cannot pin a lane.
export const REMOTE_RUN_TIMEOUT_MS_MIN = 1_000;
export const REMOTE_RUN_TIMEOUT_MS_MAX = 75 * 60 * 1000;
export const REMOTE_RECOVERY_PROMPT_PREVIEW_MAX_CHARS = 160;
export const MAX_REMOTE_RECOVERY_REQUEST_BYTES = 64 * 1024;

const REMOTE_SESSION_RECOVERY_STAGE_SET: ReadonlySet<string> = new Set(
  REMOTE_SESSION_RECOVERY_STAGES,
);

// Hard-bounded timeouts: dropped when not a finite number or <= 0, clamped
// into [MIN, MAX] otherwise.
const HOST_CLAMPED_TIMEOUT_KEYS = ["timeoutMs", "inputTimeoutMs", "queueTimeoutMs"] as const;

// Auxiliary waits/delays: 0 is a legitimate value (defaults), negatives and
// non-numbers are dropped, and the same upper bound applies.
const HOST_CLAMPED_WAIT_KEYS = [
  "assistantRecheckDelayMs",
  "assistantRecheckTimeoutMs",
  "autoReattachDelayMs",
  "autoReattachIntervalMs",
  "autoReattachTimeoutMs",
] as const;

const SAFE_BROWSER_CONFIG_KEYS = [
  "url",
  "chatgptUrl",
  "timeoutMs",
  "inputTimeoutMs",
  "queueTimeoutMs",
  "assistantRecheckDelayMs",
  "assistantRecheckTimeoutMs",
  "autoReattachDelayMs",
  "autoReattachIntervalMs",
  "autoReattachTimeoutMs",
  "desiredModel",
  "modelStrategy",
  "thinkingTime",
  "researchMode",
  "archiveConversations",
  "resumeConversationUrl",
] as const satisfies readonly (keyof BrowserSessionConfig)[];

type SafeBrowserConfigKey = (typeof SAFE_BROWSER_CONFIG_KEYS)[number];

const SAFE_BROWSER_CONFIG_KEY_SET: ReadonlySet<string> = new Set(SAFE_BROWSER_CONFIG_KEYS);

const SAFE_RECOVERY_BROWSER_CONFIG_KEYS = [
  "timeoutMs",
  "inputTimeoutMs",
  "queueTimeoutMs",
  "assistantRecheckDelayMs",
  "assistantRecheckTimeoutMs",
  "autoReattachDelayMs",
  "autoReattachIntervalMs",
  "autoReattachTimeoutMs",
  "researchMode",
] as const satisfies readonly (keyof BrowserSessionConfig)[];

const RECOVERY_TOP_LEVEL_KEYS = [
  "schema",
  "recovery",
  "promptPreview",
  "browserConfig",
  "options",
] as const;
const RECOVERY_HINT_KEYS = [
  "category",
  "stage",
  "originRunId",
  "expiresAt",
  "capability",
  "promptPreviewAlgorithm",
  "promptPreviewSha256",
  "promptDomIdentityAlgorithm",
  "promptDomSha256",
  "runtime",
] as const;
const RECOVERY_RUNTIME_KEYS = ["tabUrl", "conversationId", "promptSubmitted"] as const;
const RECOVERY_OPTION_KEYS = ["heartbeatIntervalMs", "verbose", "sessionId"] as const;
const RUN_TOP_LEVEL_KEYS = [
  "schema",
  "prompt",
  "attachments",
  "fallbackSubmission",
  "fallbackPolicy",
  "browserConfig",
  "options",
] as const;
const RUN_FALLBACK_KEYS = ["prompt", "attachments"] as const;
const RUN_FALLBACK_POLICY_KEYS = [
  "attachmentsPolicy",
  "bundleRequested",
  "model",
  "maxInputTokens",
] as const;
const RUN_ATTACHMENT_KEYS = [
  "fileName",
  "displayPath",
  "sizeBytes",
  "sha256",
  "generatedBundle",
  "contentBase64",
] as const;
const RUN_OPTION_KEYS = [
  "heartbeatIntervalMs",
  "verbose",
  "sessionId",
  "followUpPrompts",
  "jobId",
  "scheduledConcurrency",
] as const;

function assertOnlyKeys(
  value: unknown,
  allowed: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid ${label}: expected an object.`);
  }
  const allowedSet = new Set(allowed);
  const unexpected = Object.keys(value).find((key) => !allowedSet.has(key));
  if (unexpected) {
    throw new Error(`Invalid ${label}: unexpected field ${unexpected}.`);
  }
}

export function sanitizeRemoteBrowserConfigForWire(
  config: BrowserSessionConfig | Record<string, unknown> | null | undefined,
): BrowserSessionConfig {
  return pickSafeBrowserConfig(config);
}

export function sanitizeRemoteRunPayloadForWire(payload: RemoteRunPayload): RemoteRunPayload {
  assertOnlyKeys(payload, RUN_TOP_LEVEL_KEYS, "remote run payload");
  if (payload.schema !== undefined && payload.schema !== REMOTE_BROWSER_RUN_SCHEMA) {
    throw new Error(`Invalid remote run schema; expected ${REMOTE_BROWSER_RUN_SCHEMA}.`);
  }
  const prompt = sanitizeWireText(payload.prompt, "remote run prompt", { allowEmpty: false });
  const fallbackSubmission = payload.fallbackSubmission
    ? sanitizeRemotePromptFallback(payload.fallbackSubmission)
    : undefined;
  const fallbackPolicy = payload.fallbackPolicy
    ? sanitizeRemotePromptFallbackPolicy(payload.fallbackPolicy)
    : undefined;
  if (Boolean(fallbackSubmission) !== Boolean(fallbackPolicy)) {
    throw new Error(
      "Invalid remote prompt fallback: fallbackSubmission and fallbackPolicy must be supplied together.",
    );
  }
  return {
    schema: REMOTE_BROWSER_RUN_SCHEMA,
    // Browser mode trims the initial prompt before submission; normalize at
    // the trust boundary so fallback verification and terminal hashes bind
    // the exact string that can cross Send.
    prompt: prompt.trim(),
    attachments: sanitizeAttachments(payload.attachments),
    ...(fallbackSubmission ? { fallbackSubmission } : {}),
    ...(fallbackPolicy ? { fallbackPolicy } : {}),
    browserConfig: sanitizeRemoteBrowserConfigForWire(payload.browserConfig),
    options: sanitizeRunOptions(payload.options),
  };
}

function sanitizeRemotePromptFallback(
  value: unknown,
): NonNullable<RemoteRunPayload["fallbackSubmission"]> {
  assertOnlyKeys(value, RUN_FALLBACK_KEYS, "remote prompt fallback");
  return {
    prompt: sanitizeWireText(value.prompt, "remote fallback prompt", { allowEmpty: false }).trim(),
    attachments: sanitizeAttachments(value.attachments as RemoteAttachmentPayload[]),
  };
}

function sanitizeRemotePromptFallbackPolicy(value: unknown): RemotePromptFallbackPolicy {
  assertOnlyKeys(value, RUN_FALLBACK_POLICY_KEYS, "remote prompt fallback policy");
  if (
    value.attachmentsPolicy !== "auto" ||
    value.bundleRequested !== false ||
    value.model !== "gpt-5.6-sol" ||
    !Number.isSafeInteger(value.maxInputTokens) ||
    (value.maxInputTokens as number) <= 0
  ) {
    throw new Error("Invalid remote prompt fallback policy.");
  }
  return {
    attachmentsPolicy: "auto",
    bundleRequested: false,
    model: "gpt-5.6-sol",
    maxInputTokens: value.maxInputTokens as number,
  };
}

export function serializeRemoteRunPayloadForWire(payload: RemoteRunPayload): string {
  return JSON.stringify(sanitizeRemoteRunPayloadForWire(payload));
}

export function sanitizeRemoteRunPayloadForHost(payload: RemoteRunPayload): RemoteRunPayload {
  assertOnlyKeys(payload, RUN_TOP_LEVEL_KEYS, "remote run payload");
  assertOnlyKeys(payload.browserConfig, SAFE_BROWSER_CONFIG_KEYS, "remote browser config");
  assertOnlyKeys(payload.options, RUN_OPTION_KEYS, "remote run options");
  const sanitized = sanitizeRemoteRunPayloadForWire(payload);
  const validatedBrowserConfig = validateHostBrowserConfigValues(sanitized.browserConfig);
  return {
    ...sanitized,
    browserConfig: {
      ...clampHostBrowserConfigTimings(validatedBrowserConfig),
      cookieSync: true,
      inlineCookies: null,
      inlineCookiesSource: null,
    },
  };
}

function validateHostBrowserConfigValues(config: BrowserSessionConfig): BrowserSessionConfig {
  const out = { ...config } as Record<string, unknown>;
  const normalizeRequiredString = (key: string): string => {
    const value = out[key];
    if (typeof value !== "string" || !value.trim()) {
      throw new Error(`Invalid remote browser config: ${key} must be a non-empty string.`);
    }
    return sanitizeWireText(value, `remote browser config ${key}`, { allowEmpty: false }).trim();
  };

  if ("desiredModel" in out) out.desiredModel = normalizeRequiredString("desiredModel");
  if ("modelStrategy" in out) {
    const strategy = normalizeRequiredString("modelStrategy").toLowerCase();
    if (strategy !== "select" && strategy !== "current" && strategy !== "ignore") {
      throw new Error("Invalid remote browser config: modelStrategy is not recognized.");
    }
    out.modelStrategy = strategy;
  }
  if ("thinkingTime" in out) {
    const thinkingTime = normalizeRequiredString("thinkingTime").toLowerCase();
    if (!["light", "standard", "extended", "heavy"].includes(thinkingTime)) {
      throw new Error("Invalid remote browser config: thinkingTime is not recognized.");
    }
    out.thinkingTime = thinkingTime;
  }
  if ("researchMode" in out) {
    const researchMode = normalizeRequiredString("researchMode").toLowerCase();
    if (researchMode !== "off" && researchMode !== "deep") {
      throw new Error("Invalid remote browser config: researchMode is not recognized.");
    }
    out.researchMode = researchMode;
  }
  if ("archiveConversations" in out) {
    const archiveMode = normalizeRequiredString("archiveConversations").toLowerCase();
    if (archiveMode !== "auto" && archiveMode !== "always" && archiveMode !== "never") {
      throw new Error("Invalid remote browser config: archiveConversations is not recognized.");
    }
    out.archiveConversations = archiveMode;
  }
  if ("url" in out) out.url = normalizeRequiredString("url");
  if ("chatgptUrl" in out && out.chatgptUrl !== null) {
    out.chatgptUrl = normalizeRequiredString("chatgptUrl");
  }
  return out as BrowserSessionConfig;
}

/**
 * Minimize and validate a recovery-only request. No submitted prompt,
 * attachment bytes, CDP endpoint, profile path, or target id crosses this
 * boundary. A non-empty saved prompt preview is mandatory for candidate
 * discovery; the worker must match the capability-bound full DOM digest
 * before it may capture an answer.
 */
export function sanitizeRemoteBrowserRecoveryRequestForWire(
  value: unknown,
): RemoteBrowserRecoveryRequest {
  if (!value || typeof value !== "object") {
    throw new Error("Invalid remote browser recovery request.");
  }
  assertOnlyKeys(value, RECOVERY_TOP_LEVEL_KEYS, "remote browser recovery request");
  const input = value as Partial<RemoteBrowserRecoveryRequest>;
  if (input.schema !== REMOTE_BROWSER_RECOVERY_PROTOCOL) {
    throw new Error("Invalid remote browser recovery request schema.");
  }
  assertOnlyKeys(input.recovery, RECOVERY_HINT_KEYS, "remote browser recovery capability");
  assertOnlyKeys(
    (input.recovery as unknown as Record<string, unknown>).runtime,
    RECOVERY_RUNTIME_KEYS,
    "remote browser recovery runtime",
  );
  const recovery = sanitizeRemoteRunRecoveryHint(input.recovery);
  if (!recovery || !REMOTE_SESSION_RECOVERY_STAGE_SET.has(recovery.stage)) {
    throw new Error(
      `Invalid remote browser recovery stage; expected ${REMOTE_SESSION_RECOVERY_STAGES.join(", ")}.`,
    );
  }
  if (
    typeof input.promptPreview !== "string" ||
    input.promptPreview.length > REMOTE_RECOVERY_PROMPT_PREVIEW_MAX_CHARS
  ) {
    throw new Error("Invalid remote browser recovery request: prompt preview is too long.");
  }
  const promptPreview = input.promptPreview;
  if (!promptPreview.trim()) {
    throw new Error("Invalid remote browser recovery request: prompt preview is required.");
  }
  return {
    schema: REMOTE_BROWSER_RECOVERY_PROTOCOL,
    recovery: {
      ...recovery,
      stage: recovery.stage as RemoteSessionRecoveryStage,
    },
    promptPreview,
    browserConfig: pickRecoveryBrowserConfig(input.browserConfig),
    options: sanitizeRecoveryOptions(input.options),
  };
}

export function sanitizeRemoteBrowserRecoveryRequestForHost(
  value: unknown,
): RemoteBrowserRecoveryRequest {
  assertOnlyKeys(value, RECOVERY_TOP_LEVEL_KEYS, "remote browser recovery request");
  const input = value as Record<string, unknown>;
  assertOnlyKeys(input.browserConfig, SAFE_RECOVERY_BROWSER_CONFIG_KEYS, "recovery browser config");
  assertOnlyKeys(input.options, RECOVERY_OPTION_KEYS, "recovery options");
  const sanitized = sanitizeRemoteBrowserRecoveryRequestForWire(value);
  return {
    ...sanitized,
    browserConfig: {
      ...clampHostBrowserConfigTimings(sanitized.browserConfig),
      cookieSync: true,
      inlineCookies: null,
      inlineCookiesSource: null,
    },
  };
}

export function serializeRemoteBrowserRecoveryRequestForWire(
  request: RemoteBrowserRecoveryRequest,
): string {
  return JSON.stringify(sanitizeRemoteBrowserRecoveryRequestForWire(request));
}

/**
 * Host-side bounds for the allowlisted timing keys. This is the single choke
 * point between a remote payload and runBrowser, so the clamp here is what
 * guarantees the disable sentinel (<= 0) and lane-pinning extremes cannot be
 * injected by a caller. Wire-side sanitization stays a pure allowlist: a
 * local client may keep whatever timings its own config resolves to.
 */
function clampHostBrowserConfigTimings(config: BrowserSessionConfig): BrowserSessionConfig {
  const out: Record<string, unknown> = { ...config };
  for (const key of HOST_CLAMPED_TIMEOUT_KEYS) {
    if (!(key in out)) continue;
    const value = out[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      delete out[key];
      continue;
    }
    out[key] = Math.min(Math.max(value, REMOTE_RUN_TIMEOUT_MS_MIN), REMOTE_RUN_TIMEOUT_MS_MAX);
  }
  for (const key of HOST_CLAMPED_WAIT_KEYS) {
    if (!(key in out)) continue;
    const value = out[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      delete out[key];
      continue;
    }
    out[key] = Math.min(value, REMOTE_RUN_TIMEOUT_MS_MAX);
  }
  return out as BrowserSessionConfig;
}

export function isSafeRemoteBrowserConfigKey(key: string): key is SafeBrowserConfigKey {
  return SAFE_BROWSER_CONFIG_KEY_SET.has(key);
}

function pickSafeBrowserConfig(
  config: BrowserSessionConfig | Record<string, unknown> | null | undefined,
): BrowserSessionConfig {
  if (!config || typeof config !== "object") {
    return {};
  }

  const out: Record<string, unknown> = {};
  for (const key of SAFE_BROWSER_CONFIG_KEYS) {
    const value = (config as Record<string, unknown>)[key];
    if (value !== undefined) {
      out[key] =
        key === "resumeConversationUrl" ? normalizeRemoteResumeConversationUrl(value) : value;
    }
  }
  return out as BrowserSessionConfig;
}

function pickRecoveryBrowserConfig(
  config: BrowserSessionConfig | Record<string, unknown> | null | undefined,
): BrowserSessionConfig {
  if (!config || typeof config !== "object") return {};
  const out: Record<string, unknown> = {};
  for (const key of SAFE_RECOVERY_BROWSER_CONFIG_KEYS) {
    const value = (config as Record<string, unknown>)[key];
    if (value !== undefined) out[key] = value;
  }
  return out as BrowserSessionConfig;
}

function normalizeRemoteResumeConversationUrl(value: unknown): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error("Invalid resumeConversationUrl: expected a ChatGPT conversation URL.");
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  if (/[\u0000-\u001f\u007f]/u.test(trimmed)) {
    throw new Error("Invalid resumeConversationUrl: control characters are not allowed.");
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("Invalid resumeConversationUrl: provide an absolute ChatGPT conversation URL.");
  }
  if (parsed.protocol !== "https:") {
    throw new Error("Invalid resumeConversationUrl: use https.");
  }
  if (parsed.username || parsed.password) {
    throw new Error("Invalid resumeConversationUrl: credentials are not allowed.");
  }
  if (parsed.port) {
    throw new Error("Invalid resumeConversationUrl: custom ports are not allowed.");
  }
  const hostname = parsed.hostname.toLowerCase();
  if (hostname !== "chatgpt.com" && hostname !== "chat.openai.com") {
    throw new Error("Invalid resumeConversationUrl: host must be chatgpt.com.");
  }
  if (parsed.search || parsed.hash) {
    throw new Error("Invalid resumeConversationUrl: query strings and fragments are not allowed.");
  }
  if (!/^\/c\/[A-Za-z0-9_-]+$/.test(parsed.pathname)) {
    throw new Error("Invalid resumeConversationUrl: expected path /c/<conversation-id>.");
  }
  if (!extractConversationIdFromUrl(parsed.href)) {
    throw new Error("Invalid resumeConversationUrl: conversation identity is not durable yet.");
  }
  return parsed.href;
}

function sanitizeAttachments(value: unknown): RemoteAttachmentPayload[] {
  if (!Array.isArray(value)) throw new Error("Invalid remote attachments: expected an array.");
  return value.map((entry, index) => {
    assertOnlyKeys(entry, RUN_ATTACHMENT_KEYS, `remote attachment ${index}`);
    const fileName = sanitizeAttachmentFileName(entry.fileName, index);
    const displayPath = sanitizeAttachmentDisplayPath(entry.displayPath, index);
    if (!Number.isSafeInteger(entry.sizeBytes) || (entry.sizeBytes as number) < 0) {
      throw new Error(`Invalid remote attachment ${index}: sizeBytes is required.`);
    }
    if (typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
      throw new Error(`Invalid remote attachment ${index}: sha256 is required.`);
    }
    if (typeof entry.generatedBundle !== "boolean") {
      throw new Error(`Invalid remote attachment ${index}: generatedBundle is required.`);
    }
    if (typeof entry.contentBase64 !== "string" || !isCanonicalBase64(entry.contentBase64)) {
      throw new Error(`Invalid remote attachment ${index}: contentBase64 is not canonical.`);
    }
    const content = Buffer.from(entry.contentBase64, "base64");
    if (content.length !== entry.sizeBytes) {
      throw new Error(`Invalid remote attachment ${index}: declared size does not match content.`);
    }
    if (createHash("sha256").update(content).digest("hex") !== entry.sha256) {
      throw new Error(
        `Invalid remote attachment ${index}: declared digest does not match content.`,
      );
    }
    return {
      fileName,
      displayPath,
      sizeBytes: entry.sizeBytes,
      sha256: entry.sha256,
      generatedBundle: entry.generatedBundle,
      contentBase64: entry.contentBase64,
    };
  });
}

function sanitizeWireText(value: unknown, label: string, options: { allowEmpty: boolean }): string {
  if (typeof value !== "string" || (!options.allowEmpty && !value.trim())) {
    throw new Error(`Invalid ${label}: a non-empty string is required.`);
  }
  if (/\u0000|[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(value)) {
    throw new Error(`Invalid ${label}: control characters are not allowed.`);
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new Error(`Invalid ${label}: malformed Unicode is not allowed.`);
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new Error(`Invalid ${label}: malformed Unicode is not allowed.`);
    }
  }
  return value;
}

function sanitizeAttachmentFileName(value: unknown, index: number): string {
  const fileName = sanitizeWireText(value, `remote attachment ${index} fileName`, {
    allowEmpty: false,
  });
  if (
    fileName.length > 255 ||
    fileName === "." ||
    fileName === ".." ||
    path.basename(fileName) !== fileName ||
    /[/\\]/u.test(fileName) ||
    /[\u0000-\u001F\u007F]/u.test(fileName)
  ) {
    throw new Error(`Invalid remote attachment ${index}: fileName must be a basename.`);
  }
  return fileName;
}

function sanitizeAttachmentDisplayPath(value: unknown, index: number): string {
  const displayPath = sanitizeWireText(value, `remote attachment ${index} displayPath`, {
    allowEmpty: false,
  });
  if (
    displayPath.length > 4096 ||
    path.isAbsolute(displayPath) ||
    /[\u0000-\u001F\u007F]/u.test(displayPath)
  ) {
    throw new Error(`Invalid remote attachment ${index}: displayPath must be relative.`);
  }
  const segments = displayPath.split(/[\\/]/u);
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`Invalid remote attachment ${index}: displayPath contains an unsafe segment.`);
  }
  return displayPath;
}

function isCanonicalBase64(value: string): boolean {
  if (value.length === 0) return true;
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  try {
    return Buffer.from(value, "base64").toString("base64") === value;
  } catch {
    return false;
  }
}

function sanitizeRunOptions(value: RemoteRunPayload["options"]): RemoteRunPayload["options"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid remote run options: expected an object.");
  }
  assertOnlyKeys(value, RUN_OPTION_KEYS, "remote run options");
  if (
    value.heartbeatIntervalMs !== undefined &&
    (!Number.isSafeInteger(value.heartbeatIntervalMs) ||
      value.heartbeatIntervalMs < 1_000 ||
      value.heartbeatIntervalMs > 60_000)
  ) {
    throw new Error("Invalid remote run options: heartbeatIntervalMs is out of range.");
  }
  if (value.verbose !== undefined && typeof value.verbose !== "boolean") {
    throw new Error("Invalid remote run options: verbose must be boolean.");
  }
  const sanitizeIdentifier = (candidate: unknown, label: string): string | undefined => {
    if (candidate === undefined) return undefined;
    if (
      typeof candidate !== "string" ||
      candidate.length === 0 ||
      candidate.length > 128 ||
      !/^[A-Za-z0-9._-]+$/u.test(candidate)
    ) {
      throw new Error(`Invalid remote run options: ${label} is malformed.`);
    }
    return candidate;
  };
  const sessionId = sanitizeIdentifier(value.sessionId, "sessionId");
  const jobId = sanitizeIdentifier(value.jobId, "jobId");
  if (
    value.scheduledConcurrency !== undefined &&
    (!Number.isSafeInteger(value.scheduledConcurrency) ||
      value.scheduledConcurrency < 1 ||
      value.scheduledConcurrency > 1_024)
  ) {
    throw new Error("Invalid remote run options: scheduledConcurrency is out of range.");
  }
  let followUpPrompts: string[] | undefined;
  if (value.followUpPrompts !== undefined) {
    if (!Array.isArray(value.followUpPrompts) || value.followUpPrompts.length > 32) {
      throw new Error("Invalid remote run options: followUpPrompts is malformed.");
    }
    let totalChars = 0;
    followUpPrompts = value.followUpPrompts.map((entry, index) => {
      const prompt = sanitizeWireText(entry, `remote follow-up prompt ${index}`, {
        allowEmpty: false,
      });
      if (prompt.length > 1_048_576) {
        throw new Error(`Invalid remote follow-up prompt ${index}: prompt is too large.`);
      }
      totalChars += prompt.length;
      if (totalChars > 4 * 1_048_576) {
        throw new Error("Invalid remote run options: follow-up prompts are too large.");
      }
      return prompt;
    });
  }
  return {
    ...(value.heartbeatIntervalMs !== undefined
      ? { heartbeatIntervalMs: value.heartbeatIntervalMs }
      : {}),
    ...(value.verbose !== undefined ? { verbose: value.verbose } : {}),
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(jobId !== undefined ? { jobId } : {}),
    ...(value.scheduledConcurrency !== undefined
      ? { scheduledConcurrency: value.scheduledConcurrency }
      : {}),
    ...(followUpPrompts !== undefined ? { followUpPrompts } : {}),
  };
}

function sanitizeRecoveryOptions(
  value: RemoteBrowserRecoveryRequest["options"] | null | undefined,
): RemoteBrowserRecoveryRequest["options"] {
  if (!value || typeof value !== "object") return {};
  return {
    ...(typeof value.heartbeatIntervalMs === "number" && Number.isFinite(value.heartbeatIntervalMs)
      ? { heartbeatIntervalMs: Math.min(60_000, Math.max(1_000, value.heartbeatIntervalMs)) }
      : {}),
    ...(typeof value.verbose === "boolean" ? { verbose: value.verbose } : {}),
    ...(typeof value.sessionId === "string" &&
    value.sessionId.length <= 128 &&
    /^[A-Za-z0-9._-]+$/.test(value.sessionId)
      ? { sessionId: value.sessionId }
      : {}),
  };
}

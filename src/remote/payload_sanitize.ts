import type { BrowserSessionConfig } from "../sessionStore.js";
import type {
  RemoteBrowserRecoveryRequest,
  RemoteRunPayload,
  RemoteAttachmentPayload,
  RemoteSessionRecoveryStage,
} from "./types.js";
import { REMOTE_BROWSER_RECOVERY_PROTOCOL, REMOTE_SESSION_RECOVERY_STAGES } from "./types.js";
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
const HOST_CLAMPED_TIMEOUT_KEYS = ["timeoutMs", "inputTimeoutMs"] as const;

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
  return {
    prompt: typeof payload.prompt === "string" ? payload.prompt : "",
    attachments: sanitizeAttachments(payload.attachments),
    ...(payload.fallbackSubmission
      ? {
          fallbackSubmission: {
            prompt:
              typeof payload.fallbackSubmission.prompt === "string"
                ? payload.fallbackSubmission.prompt
                : "",
            attachments: sanitizeAttachments(payload.fallbackSubmission.attachments),
          },
        }
      : {}),
    browserConfig: sanitizeRemoteBrowserConfigForWire(payload.browserConfig),
    options: sanitizeRunOptions(payload.options),
  };
}

export function serializeRemoteRunPayloadForWire(payload: RemoteRunPayload): string {
  return JSON.stringify(sanitizeRemoteRunPayloadForWire(payload));
}

export function sanitizeRemoteRunPayloadForHost(payload: RemoteRunPayload): RemoteRunPayload {
  const sanitized = sanitizeRemoteRunPayloadForWire(payload);
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
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is Partial<RemoteAttachmentPayload> =>
      Boolean(entry && typeof entry === "object"),
    )
    .map((entry) => ({
      fileName: typeof entry.fileName === "string" ? entry.fileName : "attachment",
      displayPath: typeof entry.displayPath === "string" ? entry.displayPath : "attachment",
      ...(typeof entry.sizeBytes === "number" ? { sizeBytes: entry.sizeBytes } : {}),
      contentBase64: typeof entry.contentBase64 === "string" ? entry.contentBase64 : "",
    }));
}

function sanitizeRunOptions(value: RemoteRunPayload["options"]): RemoteRunPayload["options"] {
  if (!value || typeof value !== "object") {
    return {};
  }
  return {
    ...(typeof value.heartbeatIntervalMs === "number"
      ? { heartbeatIntervalMs: value.heartbeatIntervalMs }
      : {}),
    ...(typeof value.verbose === "boolean" ? { verbose: value.verbose } : {}),
    ...(typeof value.sessionId === "string" ? { sessionId: value.sessionId } : {}),
    ...(typeof value.jobId === "string" ? { jobId: value.jobId } : {}),
    ...(typeof value.scheduledConcurrency === "number" &&
    Number.isFinite(value.scheduledConcurrency)
      ? { scheduledConcurrency: value.scheduledConcurrency }
      : {}),
    ...(Array.isArray(value.followUpPrompts)
      ? {
          followUpPrompts: value.followUpPrompts.filter(
            (entry): entry is string => typeof entry === "string",
          ),
        }
      : {}),
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

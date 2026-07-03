import type { BrowserSessionConfig } from "../sessionStore.js";
import type { RemoteRunPayload, RemoteAttachmentPayload } from "./types.js";

// Single home for the bounds applied to client-influenced run timings on the
// host. `<= 0` is a documented disable sentinel for timeoutMs downstream
// (unbounded waits / skipped locks), so a remote payload must never be able
// to reach it: nonsensical values are dropped (server default wins) and
// legitimate extremes are clamped so one caller cannot pin a lane.
export const REMOTE_RUN_TIMEOUT_MS_MIN = 1_000;
export const REMOTE_RUN_TIMEOUT_MS_MAX = 75 * 60 * 1000;

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
] as const satisfies readonly (keyof BrowserSessionConfig)[];

type SafeBrowserConfigKey = (typeof SAFE_BROWSER_CONFIG_KEYS)[number];

const SAFE_BROWSER_CONFIG_KEY_SET: ReadonlySet<string> = new Set(SAFE_BROWSER_CONFIG_KEYS);

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
      out[key] = value;
    }
  }
  return out as BrowserSessionConfig;
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
    ...(Array.isArray(value.followUpPrompts)
      ? {
          followUpPrompts: value.followUpPrompts.filter(
            (entry): entry is string => typeof entry === "string",
          ),
        }
      : {}),
  };
}

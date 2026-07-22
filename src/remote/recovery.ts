import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import {
  extractConversationIdFromUrl,
  normalizeChatGptConversationId,
} from "../browser/conversationIdentity.js";
import {
  REMOTE_RUN_RECOVERY_STAGES,
  type RemoteRunRecoveryHint,
  type RemoteRunRecoveryStage,
} from "./types.js";

const RECOVERY_STAGE_SET: ReadonlySet<string> = new Set(REMOTE_RUN_RECOVERY_STAGES);
const CHATGPT_RECOVERY_HOSTS: ReadonlySet<string> = new Set(["chatgpt.com", "chat.openai.com"]);
const CAPABILITY_VERSION = "v1";
const CAPABILITY_PATTERN = /^v1\.[A-Za-z0-9_-]{43}$/;
const IDENTITY_PATTERN = /^[A-Za-z0-9._-]+$/;

export const REMOTE_RECOVERY_CAPABILITY_TTL_MS = 12 * 60 * 60 * 1000;

type RecoveryCoordinate = Pick<RemoteRunRecoveryHint, "category" | "stage" | "runtime">;

export interface RemoteRecoveryCapabilityAuthority {
  originRunId: string;
  accountId: string;
  authToken: string;
  promptPreview: string;
  nowMs?: number;
  ttlMs?: number;
}

export interface VerifyRemoteRecoveryCapabilityOptions {
  accountId: string;
  authToken: string;
  promptPreview: string;
  nowMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeRecoveryStage(value: unknown): RemoteRunRecoveryStage | null {
  return typeof value === "string" && RECOVERY_STAGE_SET.has(value)
    ? (value as RemoteRunRecoveryStage)
    : null;
}

function normalizeRecoveryUrl(value: unknown): { tabUrl: string; conversationId: string } | null {
  if (typeof value !== "string") return null;
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.port ||
      !CHATGPT_RECOVERY_HOSTS.has(parsed.hostname)
    ) {
      return null;
    }
    const conversationId = extractConversationIdFromUrl(parsed.href);
    if (!conversationId) return null;
    // Query strings, fragments, and workspace/project path identifiers are
    // unnecessary for reopening a conversation and can contain private state.
    // Normalize every accepted route to the smallest portable identity URL.
    return {
      tabUrl: `https://chatgpt.com/c/${encodeURIComponent(conversationId)}`,
      conversationId,
    };
  } catch {
    return null;
  }
}

function normalizeRecoveryCoordinate(value: unknown): RecoveryCoordinate | undefined {
  if (!isRecord(value)) return undefined;
  // Category is part of the signed wire claims. Requiring it explicitly
  // prevents deletion of a nominally signed field from being normalized back
  // into a valid capability.
  if (value.category !== "browser-automation") return undefined;
  const stage = normalizeRecoveryStage(value.stage);
  const runtime = isRecord(value.runtime) ? value.runtime : undefined;
  if (!stage || !runtime || runtime.promptSubmitted !== true) return undefined;

  const hasUrl = Object.prototype.hasOwnProperty.call(runtime, "tabUrl");
  const fromUrl = normalizeRecoveryUrl(runtime.tabUrl);
  const fromId = normalizeChatGptConversationId(runtime.conversationId);
  // A supplied URL is stronger evidence than a free-standing id. Never hide
  // an unsafe URL behind a plausible id, and reject contradictory identities.
  if (hasUrl && !fromUrl) return undefined;
  if (fromUrl && fromId && fromUrl.conversationId !== fromId) return undefined;
  const identity =
    fromUrl ??
    (fromId
      ? {
          tabUrl: `https://chatgpt.com/c/${encodeURIComponent(fromId)}`,
          conversationId: fromId,
        }
      : null);
  if (!identity) return undefined;

  return {
    category: "browser-automation",
    stage,
    runtime: {
      ...identity,
      promptSubmitted: true,
    },
  };
}

function isSafeIdentity(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    IDENTITY_PATTERN.test(value)
  );
}

function parseExpiry(value: unknown): { value: string; ms: number } | null {
  if (typeof value !== "string" || value.length > 64) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  return { value: new Date(ms).toISOString(), ms };
}

function promptPreviewSha256(promptPreview: string): string {
  return createHash("sha256").update(promptPreview).digest("hex");
}

function capabilityClaims(params: {
  originRunId: string;
  accountId: string;
  conversationId: string;
  stage: RemoteRunRecoveryStage;
  expiresAt: string;
  promptPreview: string;
}): string {
  // A JSON tuple avoids delimiter ambiguity. The prompt itself is not placed
  // in the claims string; its exact raw first-160-byte-compatible prefix is
  // represented by a SHA-256 digest.
  return JSON.stringify([
    CAPABILITY_VERSION,
    params.originRunId,
    params.accountId,
    params.conversationId,
    params.stage,
    "browser-automation",
    true,
    params.expiresAt,
    promptPreviewSha256(params.promptPreview),
  ]);
}

function computeCapability(
  authToken: string,
  claims: Parameters<typeof capabilityClaims>[0],
): string {
  const digest = createHmac("sha256", authToken)
    .update(capabilityClaims(claims))
    .digest("base64url");
  return `${CAPABILITY_VERSION}.${digest}`;
}

/**
 * Validate and minimize remote recovery evidence at both sides of the wire.
 * This checks syntax and durable identity only; the worker separately checks
 * expiry and the constant-time HMAC before any browser-side action.
 */
export function sanitizeRemoteRunRecoveryHint(value: unknown): RemoteRunRecoveryHint | undefined {
  if (!isRecord(value)) return undefined;
  const coordinate = normalizeRecoveryCoordinate(value);
  const originRunId = value.originRunId;
  const expiresAt = parseExpiry(value.expiresAt);
  const capability = value.capability;
  const previewHash = value.promptPreviewSha256;
  if (
    !coordinate ||
    !isSafeIdentity(originRunId, 128) ||
    !expiresAt ||
    expiresAt.value !== value.expiresAt ||
    typeof capability !== "string" ||
    !CAPABILITY_PATTERN.test(capability) ||
    typeof previewHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(previewHash)
  ) {
    return undefined;
  }
  return {
    ...coordinate,
    originRunId,
    expiresAt: expiresAt.value,
    capability,
    promptPreviewSha256: previewHash,
  };
}

/** Mint a short-lived account-bound capability for an already-submitted run. */
export function buildRemoteRunRecoveryHint(
  errorDetails: unknown,
  fallbackRuntime: unknown,
  authority: RemoteRecoveryCapabilityAuthority,
): RemoteRunRecoveryHint | undefined {
  if (
    !isSafeIdentity(authority.originRunId, 128) ||
    !isSafeIdentity(authority.accountId, 64) ||
    !authority.authToken ||
    !authority.promptPreview.trim()
  ) {
    return undefined;
  }
  const details = isRecord(errorDetails) ? errorDetails : {};
  const fromError = normalizeRecoveryCoordinate({
    category: "browser-automation",
    stage: details.stage,
    runtime: details.runtime,
  });
  const coordinate =
    fromError ??
    normalizeRecoveryCoordinate({
      category: "browser-automation",
      stage: details.stage,
      runtime: fallbackRuntime,
    });
  if (!coordinate) return undefined;

  const nowMs = authority.nowMs ?? Date.now();
  const ttlMs = authority.ttlMs ?? REMOTE_RECOVERY_CAPABILITY_TTL_MS;
  const expiresAt = new Date(nowMs + Math.max(1, ttlMs)).toISOString();
  const claims = {
    originRunId: authority.originRunId,
    accountId: authority.accountId,
    conversationId: coordinate.runtime.conversationId,
    stage: coordinate.stage,
    expiresAt,
    promptPreview: authority.promptPreview,
  };
  return {
    ...coordinate,
    originRunId: authority.originRunId,
    expiresAt,
    capability: computeCapability(authority.authToken, claims),
    promptPreviewSha256: promptPreviewSha256(authority.promptPreview),
  };
}

/**
 * Authoritative worker-side verification. The HMAC is bound to the original
 * run, this account, the canonical conversation, expiry, and exact saved
 * prompt prefix. Comparison is constant-time for every syntactically valid
 * capability.
 */
export function verifyRemoteRunRecoveryCapability(
  value: unknown,
  options: VerifyRemoteRecoveryCapabilityOptions,
): value is RemoteRunRecoveryHint {
  const hint = sanitizeRemoteRunRecoveryHint(value);
  if (
    !hint ||
    !isSafeIdentity(options.accountId, 64) ||
    !options.authToken ||
    !options.promptPreview.trim()
  ) {
    return false;
  }
  if (promptPreviewSha256(options.promptPreview) !== hint.promptPreviewSha256) {
    return false;
  }
  const expiryMs = Date.parse(hint.expiresAt);
  if (!Number.isFinite(expiryMs) || expiryMs <= (options.nowMs ?? Date.now())) {
    return false;
  }
  const expected = computeCapability(options.authToken, {
    originRunId: hint.originRunId,
    accountId: options.accountId,
    conversationId: hint.runtime.conversationId,
    stage: hint.stage,
    expiresAt: hint.expiresAt,
    promptPreview: options.promptPreview,
  });
  const actualBytes = Buffer.from(hint.capability);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

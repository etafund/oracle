// Provider docs freshness mechanism.
//
// The v18 plan bundle ships a snapshot of provider documentation
// (`provider_docs_snapshot.v1`) so the planning bundle has a known set of
// claims about model names, UI labels, and reasoning controls. Those
// snapshot values are *time-bounded* — model names, picker labels, and
// reasoning controls change faster than the bundle release cadence.
//
// This module:
//
//   * Defines the `provider_docs_snapshot.v1` zod schema (kept local so
//     `src/oracle/v18/contracts.ts` stays untouched per the v18 surface
//     ownership split).
//   * Computes a freshness verdict against `now` using `checked_at`,
//     `expires_at`, and `max_age_days` — whichever is stricter wins.
//   * Builds a v18 `json_envelope.v1` blocked-envelope when refresh is
//     required before live provider calls, so callers can short-circuit
//     audit/live paths with a machine-readable recovery hint.
//
// The module does NOT decide what counts as "live" — callers gate their
// own audit/live boundaries. Browser providers should also call this
// before live runs, but the bead's separate trust rule (browser same-
// session evidence > static docs) is enforced by
// `evaluateBrowserEvidenceTrust` in `policy.ts`, not here.

import { z } from "zod";

import { V18_BUNDLE_VERSION, type JsonEnvelope } from "./contracts.js";
import { createErrorEnvelope, type V18ErrorCode, type V18ErrorEntry } from "./json_envelope.js";

export const PROVIDER_DOCS_SNAPSHOT_SCHEMA_VERSION = "provider_docs_snapshot.v1" as const;

export const providerDocsSourceSchema = z
  .object({
    provider: z.string(),
    relevant_claim: z.string().optional(),
    url: z.string().optional(),
  })
  .passthrough();
export type ProviderDocsSource = z.infer<typeof providerDocsSourceSchema>;

export const providerDocsSnapshotSchema = z
  .object({
    schema_version: z.literal(PROVIDER_DOCS_SNAPSHOT_SCHEMA_VERSION),
    bundle_version: z.literal(V18_BUNDLE_VERSION),
    checked_at: z.string(),
    expiration_policy: z.string(),
    sources: z.array(providerDocsSourceSchema),
    implementation_rule: z.string(),
    expires_at: z.string(),
    max_age_days: z.number().int().min(1),
    refresh_required_before_live_provider_calls: z.boolean(),
    failure_modes_addressed: z.array(z.string()).optional(),
    premortem_refresh_required: z.boolean().optional(),
  })
  .passthrough();
export type ProviderDocsSnapshot = z.infer<typeof providerDocsSnapshotSchema>;

export interface FreshnessReason {
  readonly field: string;
  readonly message: string;
  readonly code: V18ErrorCode | null;
}

export interface ProviderDocsFreshness {
  readonly fresh: boolean;
  /** Milliseconds elapsed since `checked_at`. NaN when the timestamp is invalid. */
  readonly ageMs: number;
  /** Milliseconds remaining until `expires_at`; negative when already expired. */
  readonly expiresInMs: number;
  /** Caller-visible status — one of `fresh`, `stale_age`, `expired`, `invalid`. */
  readonly status: "fresh" | "stale_age" | "expired" | "invalid";
  /** Snapshot's own opinion on whether stale → block before live calls. */
  readonly refreshRequiredBeforeLiveProviderCalls: boolean;
  readonly reasons: readonly FreshnessReason[];
}

function pathFromIssue(prefix: string, path: readonly (string | number | symbol)[]): string {
  if (path.length === 0) return prefix;
  return `${prefix}.${path.map((segment) => String(segment)).join(".")}`;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Validate a `provider_docs_snapshot.v1` and report freshness against
 * `now`. The verdict is `fresh: true` only when:
 *
 *   * the snapshot parses against the typed schema,
 *   * `checked_at` and `expires_at` are valid ISO-8601 timestamps,
 *   * `now - checked_at <= max_age_days * day`, AND
 *   * `expires_at > now`.
 *
 * Any earlier failure populates `reasons` with a dotted field path so
 * callers can render human-friendly recovery hints. Provider-doc
 * staleness is mapped to the `ui_drift_suspected` v18 error code,
 * which is the closest existing taxonomy match for "docs no longer
 * reflect the live UI".
 */
export function evaluateProviderDocsFreshness(
  input: unknown,
  now: Date = new Date(),
): ProviderDocsFreshness {
  const reasons: FreshnessReason[] = [];
  const parsed = providerDocsSnapshotSchema.safeParse(input);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      reasons.push({
        field: pathFromIssue("provider_docs_snapshot", issue.path),
        message: issue.message,
        code: null,
      });
    }
    return {
      fresh: false,
      ageMs: Number.NaN,
      expiresInMs: Number.NaN,
      status: "invalid",
      refreshRequiredBeforeLiveProviderCalls: true,
      reasons,
    };
  }

  const snapshot = parsed.data;
  const checkedAtMs = Date.parse(snapshot.checked_at);
  const expiresAtMs = Date.parse(snapshot.expires_at);
  const nowMs = now.getTime();
  const refreshRequired = snapshot.refresh_required_before_live_provider_calls;

  if (!Number.isFinite(checkedAtMs)) {
    reasons.push({
      field: "provider_docs_snapshot.checked_at",
      message: `not a valid ISO-8601 timestamp: "${snapshot.checked_at}"`,
      code: null,
    });
  }
  if (!Number.isFinite(expiresAtMs)) {
    reasons.push({
      field: "provider_docs_snapshot.expires_at",
      message: `not a valid ISO-8601 timestamp: "${snapshot.expires_at}"`,
      code: null,
    });
  }

  const ageMs = Number.isFinite(checkedAtMs) ? nowMs - checkedAtMs : Number.NaN;
  const expiresInMs = Number.isFinite(expiresAtMs) ? expiresAtMs - nowMs : Number.NaN;
  const maxAgeMs = snapshot.max_age_days * DAY_MS;

  let status: ProviderDocsFreshness["status"] = "fresh";
  if (reasons.length > 0) {
    status = "invalid";
  }

  if (Number.isFinite(ageMs) && ageMs > maxAgeMs) {
    reasons.push({
      field: "provider_docs_snapshot.max_age_days",
      message: `snapshot is ${Math.floor(ageMs / DAY_MS)}d old; exceeds max_age_days=${snapshot.max_age_days}`,
      code: "ui_drift_suspected",
    });
    if (status === "fresh") status = "stale_age";
  }
  if (Number.isFinite(expiresInMs) && expiresInMs <= 0) {
    reasons.push({
      field: "provider_docs_snapshot.expires_at",
      message: `snapshot expired at ${snapshot.expires_at}`,
      code: "ui_drift_suspected",
    });
    status = "expired";
  }

  return {
    fresh: reasons.length === 0,
    ageMs,
    expiresInMs,
    status,
    refreshRequiredBeforeLiveProviderCalls: refreshRequired,
    reasons,
  };
}

/**
 * Convenience: produce a v18 blocked envelope when docs are stale AND
 * the snapshot says refresh is required before live provider calls.
 * Returns `null` when the docs are fresh OR when the snapshot does not
 * require refresh (an audit run may still proceed with a warning).
 *
 * Callers that want a soft warning instead of a hard block should keep
 * using `evaluateProviderDocsFreshness` directly.
 */
export function providerDocsBlockEnvelopeIfStale(
  verdict: ProviderDocsFreshness,
  meta: Record<string, unknown> = {},
): JsonEnvelope | null {
  if (verdict.fresh) return null;
  if (!verdict.refreshRequiredBeforeLiveProviderCalls) return null;
  const errors = verdict.reasons.map(
    (reason): V18ErrorEntry => ({
      error_code: reason.code ?? "ui_drift_suspected",
      message: `${reason.field}: ${reason.message}`,
    }),
  );
  // Schema requires non-empty errors; reasons is non-empty when fresh=false.
  const head = errors[0] ?? {
    error_code: "ui_drift_suspected",
    message: "provider_docs_snapshot: stale",
  };
  return createErrorEnvelope({
    errors: [head, ...errors.slice(1)],
    meta: { ...meta, bundle_version: V18_BUNDLE_VERSION },
    next_command: "oracle docs refresh --json",
    fix_command: "oracle docs refresh --json",
    retry_safe: true,
    blocked_reason: "provider_docs_stale",
  });
}

/**
 * One-shot helper: parse, evaluate freshness, and return either `null`
 * (fresh enough to proceed) or a blocked envelope ready to emit.
 */
export function preflightProviderDocs(
  input: unknown,
  options: { now?: Date; meta?: Record<string, unknown> } = {},
): JsonEnvelope | null {
  const verdict = evaluateProviderDocsFreshness(input, options.now ?? new Date());
  return providerDocsBlockEnvelopeIfStale(verdict, options.meta);
}

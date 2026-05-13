// `fallback_waiver.v1` surface.
//
// Oracle is NOT APR's waiver authority. APR (the orchestrator) issues
// waivers when an optional reviewer slot legitimately cannot complete;
// Oracle's job is to (a) validate the waiver payload, (b) reject any
// waiver that tries to cover a non-waivable protected slot, and (c)
// surface the waiver visibly to handoff consumers so it cannot become a
// silent downgrade loophole.
//
// Per oracle-9nh: protected slots (`chatgpt_pro_first_plan`,
// `chatgpt_pro_synthesis`, `gemini_deep_think`) must FAIL CLOSED in
// `balanced`/`audit` profiles even if a waiver is presented. Optional
// slots (`xai_grok_reasoning`, `deepseek_v4_pro_reasoning_search`,
// `claude_code_opus`, etc.) MAY be waived when APR records a valid
// waiver and the user has acknowledged it.

import { z } from "zod";

import { V18_BUNDLE_VERSION } from "./contracts.js";
import type { V18ErrorCode } from "./json_envelope.js";
import {
  NON_WAIVABLE_PROTECTED_SLOTS,
  isNonWaivableSlot,
} from "./protected_slot_boundaries.js";

export const FALLBACK_WAIVER_SCHEMA_VERSION = "fallback_waiver.v1" as const;

export const fallbackWaiverSchema = z
  .object({
    schema_version: z.literal(FALLBACK_WAIVER_SCHEMA_VERSION),
    bundle_version: z.literal(V18_BUNDLE_VERSION),
    waiver_id: z.string(),
    profile: z.string(),
    scope: z.string(),
    provider_slot: z.string(),
    allowed_degradation: z.string(),
    non_waivable_slots: z.array(z.string()),
    reason: z.string(),
    created_by: z.string(),
    created_at: z.string(),
    expires_at: z.string(),
    user_acknowledged: z.boolean(),
    must_surface_in_handoff: z.boolean(),
    synthesis_eligible_after_waiver: z.boolean(),
  })
  .passthrough();
export type FallbackWaiver = z.infer<typeof fallbackWaiverSchema>;

export interface WaiverReason {
  readonly code: V18ErrorCode | null;
  readonly field: string;
  readonly message: string;
}

export interface WaiverEvaluationRequest {
  /** Slot the caller wants to waive. */
  readonly slot: string;
  /** Run profile the caller is operating under (`balanced`, `audit`, …). */
  readonly profile: string;
  /** Optional clock override for deterministic tests. */
  readonly now?: Date;
}

export interface WaiverVerdict {
  /** True iff the waiver covers the requested (slot, profile) right now. */
  readonly applicable: boolean;
  /** Whether handoff consumers must surface this waiver. */
  readonly must_surface_in_handoff: boolean;
  /** Echoed from the waiver — never derived by Oracle. */
  readonly synthesis_eligible_after_waiver: boolean;
  /** v18 reasons explaining why the waiver was rejected (empty when applicable). */
  readonly reasons: readonly WaiverReason[];
  /** Echoed metadata for handoff surfaces. */
  readonly waiver_id: string | null;
  readonly scope: string | null;
  readonly allowed_degradation: string | null;
}

function pathFromIssue(prefix: string, path: readonly (string | number | symbol)[]): string {
  if (path.length === 0) return prefix;
  return `${prefix}.${path.map((s) => String(s)).join(".")}`;
}

const NO_WAIVER: WaiverVerdict = Object.freeze({
  applicable: false,
  must_surface_in_handoff: false,
  synthesis_eligible_after_waiver: false,
  reasons: [],
  waiver_id: null,
  scope: null,
  allowed_degradation: null,
});

/**
 * Decide whether the supplied waiver payload applies to the requested
 * (slot, profile). Pure — no I/O. Oracle does not consult any APR
 * authority, just validates the payload + invariants:
 *
 *   * payload parses against `fallback_waiver.v1`,
 *   * payload is not expired (`now <= expires_at`),
 *   * `user_acknowledged === true`,
 *   * requested slot is NOT in either the canonical non-waivable list
 *     OR the waiver's own `non_waivable_slots` array,
 *   * waiver's `provider_slot` equals the requested slot,
 *   * waiver's `profile` equals the requested profile (waivers are
 *     scoped per-profile so a balanced waiver cannot quietly satisfy
 *     an audit run).
 *
 * When any invariant fails, the waiver is `applicable: false` and the
 * reasons array carries machine-readable codes; callers must NOT treat
 * a rejected waiver as "no waiver attempted" — pass `must_surface` to
 * a handoff packet so the failed attempt stays visible.
 */
export function evaluateFallbackWaiver(
  input: unknown,
  request: WaiverEvaluationRequest,
): WaiverVerdict {
  const reasons: WaiverReason[] = [];
  const parsed = fallbackWaiverSchema.safeParse(input);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      reasons.push({
        code: null,
        field: pathFromIssue("fallback_waiver", issue.path),
        message: issue.message,
      });
    }
    return { ...NO_WAIVER, reasons };
  }

  const waiver = parsed.data;
  const now = (request.now ?? new Date()).getTime();
  const expiresAtMs = Date.parse(waiver.expires_at);
  if (!Number.isFinite(expiresAtMs)) {
    reasons.push({
      code: null,
      field: "fallback_waiver.expires_at",
      message: `not a valid ISO-8601 timestamp: "${waiver.expires_at}"`,
    });
  } else if (expiresAtMs <= now) {
    reasons.push({
      code: "provider_login_required",
      field: "fallback_waiver.expires_at",
      message: `waiver expired at ${waiver.expires_at}`,
    });
  }

  if (!waiver.user_acknowledged) {
    reasons.push({
      code: null,
      field: "fallback_waiver.user_acknowledged",
      message: "waiver must be user_acknowledged before it can be applied",
    });
  }

  // Non-waivable enforcement: BOTH Oracle's canonical list AND the
  // waiver's self-reported non_waivable_slots. The waiver cannot
  // expand its own scope by omitting a non-waivable slot.
  if (isNonWaivableSlot(request.slot)) {
    reasons.push({
      code: null,
      field: "fallback_waiver.provider_slot",
      message: `slot ${request.slot} is non-waivable per Oracle's canonical list (${NON_WAIVABLE_PROTECTED_SLOTS.join(", ")})`,
    });
  }
  if (waiver.non_waivable_slots.includes(request.slot)) {
    reasons.push({
      code: null,
      field: "fallback_waiver.non_waivable_slots",
      message: `slot ${request.slot} is listed in the waiver's own non_waivable_slots`,
    });
  }

  if (waiver.provider_slot !== request.slot) {
    reasons.push({
      code: null,
      field: "fallback_waiver.provider_slot",
      message: `waiver covers slot "${waiver.provider_slot}", not the requested "${request.slot}"`,
    });
  }

  if (waiver.profile !== request.profile) {
    reasons.push({
      code: null,
      field: "fallback_waiver.profile",
      message: `waiver covers profile "${waiver.profile}", not the requested "${request.profile}"`,
    });
  }

  const applicable = reasons.length === 0;
  return {
    applicable,
    // Even a REJECTED waiver must surface to handoff so the audit trail
    // shows the attempt — rule "no silent downgrade".
    must_surface_in_handoff: waiver.must_surface_in_handoff,
    synthesis_eligible_after_waiver: applicable ? waiver.synthesis_eligible_after_waiver : false,
    reasons,
    waiver_id: waiver.waiver_id,
    scope: waiver.scope,
    allowed_degradation: waiver.allowed_degradation,
  };
}

/**
 * Convenience: return true iff the waiver is currently applicable.
 * Use when callers want a boolean gate without a verdict.
 */
export function isWaiverApplicable(
  input: unknown,
  request: WaiverEvaluationRequest,
): boolean {
  return evaluateFallbackWaiver(input, request).applicable;
}

/**
 * Build the metadata block a v18 handoff packet must carry when a
 * waiver is in play. Always emitted (rejected or not) so the audit
 * trail is intact. Pure — Oracle records what APR told it, not what
 * Oracle wishes were true.
 */
export interface WaiverHandoffMetadata {
  readonly waiver_attempted: boolean;
  readonly waiver_applicable: boolean;
  readonly waiver_id: string | null;
  readonly scope: string | null;
  readonly allowed_degradation: string | null;
  readonly must_surface_in_handoff: boolean;
  readonly synthesis_eligible_after_waiver: boolean;
  readonly reasons: readonly WaiverReason[];
}

export function buildWaiverHandoffMetadata(
  input: unknown,
  request: WaiverEvaluationRequest,
): WaiverHandoffMetadata {
  if (input == null) {
    return {
      waiver_attempted: false,
      waiver_applicable: false,
      waiver_id: null,
      scope: null,
      allowed_degradation: null,
      must_surface_in_handoff: false,
      synthesis_eligible_after_waiver: false,
      reasons: [],
    };
  }
  const verdict = evaluateFallbackWaiver(input, request);
  return {
    waiver_attempted: true,
    waiver_applicable: verdict.applicable,
    waiver_id: verdict.waiver_id,
    scope: verdict.scope,
    allowed_degradation: verdict.allowed_degradation,
    must_surface_in_handoff: verdict.must_surface_in_handoff || !verdict.applicable,
    synthesis_eligible_after_waiver: verdict.synthesis_eligible_after_waiver,
    reasons: verdict.reasons,
  };
}

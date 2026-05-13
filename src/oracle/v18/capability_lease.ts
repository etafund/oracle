// Capability lease modeling.
//
// `capability_lease.v1` is a short-lived receipt that "the right
// reasoning effort / model selection / browser mode was just verified
// for this provider". Callers can consume a fresh lease without
// re-probing within its TTL, which keeps audit/live runs from re-
// running expensive doctor probes on every single hop.
//
// The lease is typed locally — `src/oracle/v18/contracts.ts` is owned by
// a sibling pane, so this module materializes the schema in its own file.
// All trust decisions still go through `evaluateBrowserEvidenceTrust`
// (in `policy.ts`); leases are *cached probe results*, not synthesis
// gates.

import { z } from "zod";

import { V18_BUNDLE_VERSION } from "./contracts.js";
import type { V18ErrorCode } from "./json_envelope.js";

export const CAPABILITY_LEASE_SCHEMA_VERSION = "capability_lease.v1" as const;

export const capabilityLeaseStatusSchema = z.enum(["active", "expired", "revoked", "failed"]);
export type CapabilityLeaseStatus = z.infer<typeof capabilityLeaseStatusSchema>;

export const capabilityLeaseSchema = z
  .object({
    schema_version: z.literal(CAPABILITY_LEASE_SCHEMA_VERSION),
    lease_id: z.string(),
    provider: z.string(),
    capability: z.string(),
    issued_at: z.string(),
    expires_at: z.string(),
    status: capabilityLeaseStatusSchema,
    // Optional per schema, but recorded in the v18 fixture; surfacing them
    // typed lets callers `lease.same_session_required` instead of dipping
    // into the passthrough bag.
    same_session_required: z.boolean().optional(),
    verification_method: z.string().optional(),
    bundle_version: z.literal(V18_BUNDLE_VERSION).optional(),
  })
  .passthrough();
export type CapabilityLease = z.infer<typeof capabilityLeaseSchema>;

export interface LeaseReason {
  readonly field: string;
  readonly message: string;
  readonly code: V18ErrorCode | null;
}

export interface LeaseFreshness {
  readonly fresh: boolean;
  readonly expiresInMs: number;
  readonly status: "fresh" | "expired" | "inactive" | "invalid";
  readonly reasons: readonly LeaseReason[];
}

function pathFromIssue(prefix: string, path: readonly (string | number | symbol)[]): string {
  if (path.length === 0) return prefix;
  return `${prefix}.${path.map((segment) => String(segment)).join(".")}`;
}

/**
 * Inspect a `capability_lease.v1` payload and return whether it can be
 * consumed at `now`. A lease is fresh only when:
 *
 *   * the payload parses against the typed schema,
 *   * `status === "active"`,
 *   * `expires_at > now`, AND
 *   * `issued_at` is a valid ISO-8601 timestamp.
 */
export function evaluateCapabilityLease(input: unknown, now: Date = new Date()): LeaseFreshness {
  const reasons: LeaseReason[] = [];
  const parsed = capabilityLeaseSchema.safeParse(input);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      reasons.push({
        field: pathFromIssue("capability_lease", issue.path),
        message: issue.message,
        code: null,
      });
    }
    return {
      fresh: false,
      expiresInMs: Number.NaN,
      status: "invalid",
      reasons,
    };
  }

  const lease = parsed.data;
  const expiresAtMs = Date.parse(lease.expires_at);
  const issuedAtMs = Date.parse(lease.issued_at);
  const nowMs = now.getTime();

  if (!Number.isFinite(issuedAtMs)) {
    reasons.push({
      field: "capability_lease.issued_at",
      message: `not a valid ISO-8601 timestamp: "${lease.issued_at}"`,
      code: null,
    });
  }
  if (!Number.isFinite(expiresAtMs)) {
    reasons.push({
      field: "capability_lease.expires_at",
      message: `not a valid ISO-8601 timestamp: "${lease.expires_at}"`,
      code: null,
    });
  }

  let status: LeaseFreshness["status"] = "fresh";
  if (reasons.length > 0) {
    status = "invalid";
  }
  if (lease.status !== "active") {
    reasons.push({
      field: "capability_lease.status",
      message: `lease is not active (status="${lease.status}")`,
      code: lease.status === "expired" ? "provider_login_required" : null,
    });
    status = lease.status === "expired" ? "expired" : "inactive";
  }

  const expiresInMs = Number.isFinite(expiresAtMs) ? expiresAtMs - nowMs : Number.NaN;
  if (Number.isFinite(expiresInMs) && expiresInMs <= 0) {
    reasons.push({
      field: "capability_lease.expires_at",
      message: `lease expired at ${lease.expires_at}`,
      code: "provider_login_required",
    });
    status = "expired";
  }

  return {
    fresh: reasons.length === 0,
    expiresInMs,
    status,
    reasons,
  };
}

export interface ConsumeLeaseRequest {
  /** The capability the caller wants to use (e.g. `pro_extended_reasoning`). */
  readonly capability: string;
  /** Provider key (e.g. `chatgpt`, `gemini`). */
  readonly provider: string;
  /**
   * When true, only consume a lease that itself enforces
   * `same_session_required: true`. Used by browser providers that must
   * verify the same browser tab supplied the original observation.
   */
  readonly requireSameSession?: boolean;
}

export interface ConsumeLeaseResult {
  readonly consumed: boolean;
  readonly lease: CapabilityLease | null;
  readonly freshness: LeaseFreshness;
  readonly reasons: readonly LeaseReason[];
}

/**
 * Consume a lease if it is fresh AND matches the request's capability +
 * provider. Returns the typed lease when usable; otherwise `consumed:
 * false` with the merged reasons (schema issues, expiry, mismatched
 * capability/provider, same-session mismatch).
 *
 * This is the only entry point that should be used to skip a fresh
 * doctor/probe — it guarantees the lease applies to the exact capability
 * the caller asked for, so a fresh `pro_extended_reasoning` lease for
 * ChatGPT never satisfies a Gemini Deep Think request and vice versa.
 */
export function consumeCapabilityLease(
  input: unknown,
  request: ConsumeLeaseRequest,
  now: Date = new Date(),
): ConsumeLeaseResult {
  const freshness = evaluateCapabilityLease(input, now);
  const reasons: LeaseReason[] = [...freshness.reasons];

  // Only attempt match when the payload parsed cleanly.
  const parsed = capabilityLeaseSchema.safeParse(input);
  if (!parsed.success) {
    return { consumed: false, lease: null, freshness, reasons };
  }
  const lease = parsed.data;

  if (lease.capability !== request.capability) {
    reasons.push({
      field: "capability_lease.capability",
      message: `caller requested "${request.capability}" but lease is for "${lease.capability}"`,
      code: null,
    });
  }
  if (lease.provider !== request.provider) {
    reasons.push({
      field: "capability_lease.provider",
      message: `caller requested provider "${request.provider}" but lease is for "${lease.provider}"`,
      code: null,
    });
  }
  if (request.requireSameSession && !lease.same_session_required) {
    reasons.push({
      field: "capability_lease.same_session_required",
      message:
        "caller requires same-session verification but lease does not enforce same_session_required",
      code: "prompt_submitted_before_verification",
    });
  }

  const consumed = freshness.fresh && reasons.length === freshness.reasons.length;
  return {
    consumed,
    lease: consumed ? lease : null,
    freshness,
    reasons,
  };
}

/**
 * Build an active capability lease from typed inputs. Centralizes the
 * `bundle_version` + `schema_version` literal placement so callers
 * cannot accidentally ship a partially-populated lease.
 */
export interface IssueCapabilityLeaseInput {
  readonly lease_id: string;
  readonly provider: string;
  readonly capability: string;
  readonly issued_at: string;
  readonly ttlSeconds: number;
  readonly verification_method?: string;
  readonly same_session_required?: boolean;
}

export function issueCapabilityLease(input: IssueCapabilityLeaseInput): CapabilityLease {
  if (!Number.isFinite(input.ttlSeconds) || input.ttlSeconds <= 0) {
    throw new Error(
      `capability_lease.ttlSeconds must be a positive number; got ${input.ttlSeconds}`,
    );
  }
  const issuedMs = Date.parse(input.issued_at);
  if (!Number.isFinite(issuedMs)) {
    throw new Error(`capability_lease.issued_at must be ISO-8601; got "${input.issued_at}"`);
  }
  const expiresAt = new Date(issuedMs + input.ttlSeconds * 1000).toISOString();
  const lease: CapabilityLease = {
    schema_version: CAPABILITY_LEASE_SCHEMA_VERSION,
    bundle_version: V18_BUNDLE_VERSION,
    lease_id: input.lease_id,
    provider: input.provider,
    capability: input.capability,
    issued_at: input.issued_at,
    expires_at: expiresAt,
    status: "active",
    ...(input.verification_method ? { verification_method: input.verification_method } : {}),
    ...(input.same_session_required !== undefined
      ? { same_session_required: input.same_session_required }
      : {}),
  };
  // Belt-and-suspenders: parse the constructed lease through the schema
  // so any future drift in the typed shape fails fast at the build site.
  return capabilityLeaseSchema.parse(lease);
}

// Premortem coverage helpers.
//
// The failure-mode ledger in PLAN/oracle-vnext-plan-bundle-v18.0.0/
// fixtures/failure-mode-ledger.json is the canonical pessimistic
// hindsight document. This file mirrors the Oracle-relevant subset as
// a typed registry so every `tests/premortem/v18/` file can declare
// which failure modes it exercises, and a coverage-matrix test can
// enforce that no Oracle-owned FM has slipped through unchecked when
// the plan document is gone.

export type FailureModeOwner = "oracle" | "vibe-planning" | "apr" | "integration" | "all";

export interface PremortemFailureMode {
  /** Stable FM id from the ledger (e.g. "FM-001"). */
  readonly id: string;
  /** Short title from the ledger. */
  readonly title: string;
  /** Owner declared in the ledger. */
  readonly owner: FailureModeOwner;
  /** Why this FM matters to Oracle even when owner !== "oracle". */
  readonly oracle_relevance: string;
  /**
   * Acceptance checks the Oracle implementation must exercise for this
   * FM. Each entry maps to one or more assertions across the per-FM
   * test files in `tests/premortem/v18/`.
   */
  readonly oracle_acceptance_checks: readonly string[];
  /** Oracle-owned controls that mitigate this FM. */
  readonly oracle_controls: readonly string[];
}

/**
 * The Oracle-relevant subset of the v18 failure-mode ledger. The
 * coverage-matrix test asserts that every entry here has a dedicated
 * `tests/premortem/v18/fm_<id>_*.test.ts` file.
 */
export const ORACLE_PREMORTEM_FAILURE_MODES: readonly PremortemFailureMode[] = Object.freeze([
  Object.freeze({
    id: "FM-001",
    title: "Browser automation succeeds in the wrong mode",
    owner: "oracle" as FailureModeOwner,
    oracle_relevance:
      "Oracle owns same-session evidence and the picker-label verification gate.",
    oracle_acceptance_checks: Object.freeze([
      "browser_evidence requires verified_before_prompt_submit=true",
      "build rejects evidence whose verified_at is after prompt_submitted_at",
      "policy gate rejects evidence with reasoning_effort_verified=false",
      "policy gate rejects evidence with empty observed_reasoning_effort_label",
      "placeholder hashes are rejected at build time",
    ]) as readonly string[],
    oracle_controls: Object.freeze([
      "src/browser/evidence.ts buildBrowserEvidence timestamp + hash guard",
      "src/oracle/v18/policy.ts evaluateBrowserEvidenceTrust",
      "src/oracle/v18/protected_slot_boundaries.ts detectSilentDowngrade",
    ]) as readonly string[],
  }),
  Object.freeze({
    id: "FM-002",
    title: "Remote browser is unreliable under real load",
    owner: "oracle" as FailureModeOwner,
    oracle_relevance:
      "Oracle owns lease TTL + reconnect state machine + recover_command emission.",
    oracle_acceptance_checks: Object.freeze([
      "expired capability_lease cannot be consumed without re-probe",
      "stale lease forces provider_login_required",
      "reconnect attempts back off and eventually hand off to oracle session <id>",
      "no decision suggests clicking Answer now (AGENTS.md invariant)",
    ]) as readonly string[],
    oracle_controls: Object.freeze([
      "src/oracle/v18/capability_lease.ts consumeCapabilityLease",
      "src/remote/reconnect.ts decideReconnect",
      "src/remote/heartbeat.ts buildHeartbeat",
    ]) as readonly string[],
  }),
  Object.freeze({
    id: "FM-006",
    title: "Users hate opaque waiting and giant reports",
    owner: "vibe-planning" as FailureModeOwner,
    oracle_relevance:
      "Oracle emits the typed run_progress events that the human review packet renders.",
    oracle_acceptance_checks: Object.freeze([
      "run_progress.v1 events carry user_visible_message + next_command + blocked_reason",
      "heartbeat output never logs reasoning text",
      "blocked state surfaces blocked_on_provider + blocked_on_error_code",
    ]) as readonly string[],
    oracle_controls: Object.freeze([
      "src/oracle/v18/run_progress.ts buildRunProgressEvent",
      "src/oracle/v18/run_progress.ts sanitizeRunProgressExtras",
    ]) as readonly string[],
  }),
  Object.freeze({
    id: "FM-007",
    title: "Provider docs and model names drift faster than the bundle",
    owner: "apr" as FailureModeOwner,
    oracle_relevance:
      "Oracle owns provider-docs-snapshot freshness gate + capability_lease TTL.",
    oracle_acceptance_checks: Object.freeze([
      "stale provider docs snapshot blocks live calls when refresh_required=true",
      "fresh capability lease is consumable within TTL",
      "expired capability lease is rejected with provider_login_required",
      "wrong schema_version on docs snapshot is rejected",
    ]) as readonly string[],
    oracle_controls: Object.freeze([
      "src/oracle/v18/provider_docs.ts evaluateProviderDocsFreshness",
      "src/oracle/v18/capability_lease.ts consumeCapabilityLease",
    ]) as readonly string[],
  }),
  Object.freeze({
    id: "FM-009",
    title: "Evidence ledger leaks sensitive browser/account data",
    owner: "oracle" as FailureModeOwner,
    oracle_relevance:
      "Oracle owns the redaction default + unsafe-artifact quarantine + forbidden-key list.",
    oracle_acceptance_checks: Object.freeze([
      "redactEvidencePayload drops cookies / account_email / raw_dom / screenshots / auth_headers / raw_prompt / raw_output / api_key / *_token",
      "redaction strips adversarial extension aliases (debug_session_token, mode_verified_override)",
      "unsafe_debug payloads divert to quarantine and never appear in the normal artifact_index.v1",
      "redacted on-disk bytes contain no leaked VALUES (sk-…, agent@example.com, <html>, Bearer …)",
    ]) as readonly string[],
    oracle_controls: Object.freeze([
      "src/oracle/v18/evidence.ts redactEvidencePayload",
      "src/oracle/v18/evidence.ts writeEvidence (quarantine isolation)",
      "src/oracle/v18/evidence.ts FORBIDDEN_KEY_TEST",
    ]) as readonly string[],
  }),
  Object.freeze({
    id: "FM-010",
    title: "Waivers become silent downgrade loopholes",
    owner: "apr" as FailureModeOwner,
    oracle_relevance:
      "Oracle owns the non-waivable protected-slot list and silent-downgrade detector.",
    oracle_acceptance_checks: Object.freeze([
      "chatgpt_pro_first_plan, chatgpt_pro_synthesis, gemini_deep_think cannot be waived",
      "a waiver that empties its own non_waivable_slots cannot expand scope",
      "expired waivers are rejected with provider_login_required",
      "rejected waivers force must_surface_in_handoff=true (audit trail visibility)",
      "detectSilentDowngrade flips synthesis_eligible to false on missing evidence / unverified effort / API access path",
    ]) as readonly string[],
    oracle_controls: Object.freeze([
      "src/oracle/v18/waiver.ts evaluateFallbackWaiver",
      "src/oracle/v18/protected_slot_boundaries.ts NON_WAIVABLE_PROTECTED_SLOTS",
      "src/oracle/v18/protected_slot_boundaries.ts detectSilentDowngrade",
    ]) as readonly string[],
  }),
  Object.freeze({
    id: "FM-011",
    title: "Independent coding agents diverge on shared contracts",
    owner: "integration" as FailureModeOwner,
    oracle_relevance:
      "Oracle's strict-core/permissive-extension policy guarantees unknown fields cannot govern eligibility.",
    oracle_acceptance_checks: Object.freeze([
      "every v18 schema rejects wrong schema_version literals",
      "corrupted envelope (missing required field) is rejected by zod parse",
      "extension keys cannot flip mode_verified, verified_before_prompt_submit, synthesis_eligible, api_allowed",
      "adversarial alias keys (eligible_for_synthesis, allow_api_anyway) are inert",
    ]) as readonly string[],
    oracle_controls: Object.freeze([
      "src/oracle/v18/contracts.ts strict-core zod typing + .passthrough() extensions",
      "src/oracle/v18/policy.ts only reads typed core fields",
    ]) as readonly string[],
  }),
]);

const FM_BY_ID: ReadonlyMap<string, PremortemFailureMode> = new Map(
  ORACLE_PREMORTEM_FAILURE_MODES.map((fm) => [fm.id, fm]),
);

export function premortemForId(id: string): PremortemFailureMode | null {
  return FM_BY_ID.get(id) ?? null;
}

export function listPremortemIds(): readonly string[] {
  return ORACLE_PREMORTEM_FAILURE_MODES.map((fm) => fm.id);
}

// ─── Adversarial fixtures shared across per-FM tests ─────────────────────────

/** A SHA-256 hash that looks valid but is the canonical placeholder (all zeros). */
export const PLACEHOLDER_SHA256 = `sha256:${"0".repeat(64)}` as const;

/** Forbidden values that, if observed in serialized evidence, indicate leakage. */
export const FORBIDDEN_LEAKED_VALUES: readonly string[] = Object.freeze([
  "sk-super-secret-token-value",
  "agent@example.com",
  "<html>",
  "Bearer redact-me",
  "should-not-survive",
  "session=abc",
  "data:image/png;base64,XYZ",
]);

/** Helper: assert that a serialized payload contains none of the canonical leak markers. */
export function assertNoSecretLeak(serialized: string): void {
  for (const banned of FORBIDDEN_LEAKED_VALUES) {
    if (serialized.includes(banned)) {
      throw new Error(`premortem secret leak detected: "${banned}" present in payload`);
    }
  }
}

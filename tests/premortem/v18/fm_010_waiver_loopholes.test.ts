import { describe, expect, test } from "vitest";

import { V18_BUNDLE_VERSION } from "@src/oracle/v18/index.ts";
import {
  FALLBACK_WAIVER_SCHEMA_VERSION,
  buildWaiverHandoffMetadata,
  evaluateFallbackWaiver,
} from "@src/oracle/v18/waiver.ts";
import {
  NON_WAIVABLE_PROTECTED_SLOTS,
  detectSilentDowngrade,
} from "@src/oracle/v18/protected_slot_boundaries.ts";
import { premortemForId } from "@tests/_helpers/premortem.ts";

const FM = premortemForId("FM-010")!;
const NOW = new Date("2026-05-12T12:00:00Z");

function buildWaiver(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    allowed_degradation: "skip_optional_reviewer_after_quorum_satisfied",
    bundle_version: V18_BUNDLE_VERSION,
    created_at: "2026-05-12T00:00:00Z",
    created_by: "human_orchestrator",
    expires_at: "2026-05-13T00:00:00Z",
    must_surface_in_handoff: true,
    non_waivable_slots: [...NON_WAIVABLE_PROTECTED_SLOTS],
    profile: "balanced",
    provider_slot: "xai_grok_reasoning",
    reason: "Optional reviewer unavailable; quorum already satisfied.",
    schema_version: FALLBACK_WAIVER_SCHEMA_VERSION,
    scope: "optional_independent_reviewer",
    synthesis_eligible_after_waiver: true,
    user_acknowledged: true,
    waiver_id: "waiver-premortem-fm010",
    ...overrides,
  };
}

describe(`premortem ${FM.id}: ${FM.title}`, () => {
  test("documents which Oracle acceptance checks this file covers", () => {
    expect(FM.oracle_acceptance_checks.length).toBeGreaterThan(0);
  });

  test.each(NON_WAIVABLE_PROTECTED_SLOTS)("%s cannot be waived under any payload", (slot) => {
    const verdict = evaluateFallbackWaiver(buildWaiver({ provider_slot: slot }), {
      slot,
      profile: "balanced",
      now: NOW,
    });
    expect(verdict.applicable).toBe(false);
    expect(verdict.synthesis_eligible_after_waiver).toBe(false);
  });

  test("a waiver that empties its own non_waivable_slots cannot expand scope", () => {
    const verdict = evaluateFallbackWaiver(
      buildWaiver({
        provider_slot: "chatgpt_pro_synthesis",
        non_waivable_slots: [], // adversarial: try to silently remove the guardrail
      }),
      { slot: "chatgpt_pro_synthesis", profile: "balanced", now: NOW },
    );
    expect(verdict.applicable).toBe(false);
    expect(verdict.reasons.some((r) => r.message.includes("Oracle's canonical list"))).toBe(true);
  });

  test("expired waivers are rejected with provider_login_required (no silent retry)", () => {
    const verdict = evaluateFallbackWaiver(
      buildWaiver({ expires_at: "2026-05-12T00:00:00Z" }), // 12h before NOW
      { slot: "xai_grok_reasoning", profile: "balanced", now: NOW },
    );
    expect(verdict.applicable).toBe(false);
    expect(verdict.reasons.find((r) => r.field === "fallback_waiver.expires_at")?.code).toBe(
      "provider_login_required",
    );
  });

  test("rejected waivers FORCE must_surface_in_handoff=true (audit trail visibility)", () => {
    // Adversarial: APR ships a payload with must_surface_in_handoff=false
    // and a non-waivable slot. Oracle must still surface the attempt.
    const metadata = buildWaiverHandoffMetadata(
      buildWaiver({
        provider_slot: "gemini_deep_think",
        must_surface_in_handoff: false,
      }),
      { slot: "gemini_deep_think", profile: "balanced", now: NOW },
    );
    expect(metadata.waiver_attempted).toBe(true);
    expect(metadata.waiver_applicable).toBe(false);
    expect(metadata.must_surface_in_handoff).toBe(true);
    expect(metadata.synthesis_eligible_after_waiver).toBe(false);
    expect(metadata.reasons.length).toBeGreaterThan(0);
  });

  test("detectSilentDowngrade flips synthesis_eligible to false on missing evidence", () => {
    const verdict = detectSilentDowngrade({
      slot: "chatgpt_pro_first_plan",
      synthesis_eligible: true,
      evidence: null,
      evidence_id: null,
      reasoning_effort_verified: true,
      observed_reasoning_effort_label: "Heavy",
      selected_effort_is_highest_visible: true,
      access_path: "oracle_browser_remote",
      result_text_length: 1024,
    });
    expect(verdict.degraded).toBe(true);
    expect(verdict.synthesis_eligible).toBe(false);
    expect(verdict.reasons.some((r) => r.field === "provider_result.evidence")).toBe(true);
  });

  test("detectSilentDowngrade rejects API access path for protected slots", () => {
    const verdict = detectSilentDowngrade({
      slot: "chatgpt_pro_first_plan",
      synthesis_eligible: true,
      evidence: { evidence_id: "ev-1" },
      evidence_id: "ev-1",
      reasoning_effort_verified: true,
      observed_reasoning_effort_label: "Heavy",
      selected_effort_is_highest_visible: true,
      access_path: "openai_api", // API substitution attempt
      result_text_length: 1024,
    });
    expect(verdict.degraded).toBe(true);
    expect(
      verdict.reasons.some(
        (r) => r.field === "provider_result.access_path" && r.message.includes("API substitution"),
      ),
    ).toBe(true);
  });
});

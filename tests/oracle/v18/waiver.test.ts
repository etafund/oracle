import { describe, expect, test } from "vitest";

import { V18_BUNDLE_VERSION } from "@src/oracle/v18/contracts.ts";
import {
  FALLBACK_WAIVER_SCHEMA_VERSION,
  buildWaiverHandoffMetadata,
  evaluateFallbackWaiver,
  fallbackWaiverSchema,
  isWaiverApplicable,
} from "@src/oracle/v18/waiver.ts";
import { NON_WAIVABLE_PROTECTED_SLOTS } from "@src/oracle/v18/protected_slot_boundaries.ts";

const NOW = new Date("2026-05-12T12:00:00.000Z");

function buildWaiver(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    allowed_degradation: "skip_optional_reviewer_after_quorum_satisfied",
    bundle_version: V18_BUNDLE_VERSION,
    created_at: "2026-05-12T00:00:00Z",
    created_by: "human_orchestrator",
    expires_at: "2026-05-13T00:00:00Z",
    must_surface_in_handoff: true,
    non_waivable_slots: [
      "chatgpt_pro_first_plan",
      "chatgpt_pro_synthesis",
      "gemini_deep_think",
    ],
    profile: "balanced",
    provider_slot: "xai_grok_reasoning",
    reason: "Optional reviewer unavailable; quorum already satisfied.",
    schema_version: FALLBACK_WAIVER_SCHEMA_VERSION,
    scope: "optional_independent_reviewer",
    synthesis_eligible_after_waiver: true,
    user_acknowledged: true,
    waiver_id: "waiver-test-1",
    ...overrides,
  };
}

describe("fallbackWaiverSchema — strict-core shape", () => {
  test("accepts the canonical fixture shape", () => {
    expect(() => fallbackWaiverSchema.parse(buildWaiver())).not.toThrow();
  });

  test("rejects wrong schema_version", () => {
    expect(() =>
      fallbackWaiverSchema.parse(buildWaiver({ schema_version: "fallback_waiver.v0" })),
    ).toThrow();
  });

  test("rejects missing required fields", () => {
    for (const field of [
      "waiver_id",
      "profile",
      "scope",
      "provider_slot",
      "allowed_degradation",
      "non_waivable_slots",
      "reason",
      "created_by",
      "created_at",
      "expires_at",
      "user_acknowledged",
      "must_surface_in_handoff",
      "synthesis_eligible_after_waiver",
    ] as const) {
      const stripped = { ...buildWaiver() } as Record<string, unknown>;
      delete stripped[field];
      expect(() => fallbackWaiverSchema.parse(stripped), `missing ${field}`).toThrow();
    }
  });
});

describe("evaluateFallbackWaiver — happy path", () => {
  test("optional xai slot waiver is applicable in balanced profile", () => {
    const verdict = evaluateFallbackWaiver(buildWaiver(), {
      slot: "xai_grok_reasoning",
      profile: "balanced",
      now: NOW,
    });
    expect(verdict.applicable).toBe(true);
    expect(verdict.must_surface_in_handoff).toBe(true);
    expect(verdict.synthesis_eligible_after_waiver).toBe(true);
    expect(verdict.reasons).toEqual([]);
    expect(verdict.waiver_id).toBe("waiver-test-1");
  });

  test("optional deepseek slot waiver is applicable when issued for that slot", () => {
    const verdict = evaluateFallbackWaiver(
      buildWaiver({ provider_slot: "deepseek_v4_pro_reasoning_search" }),
      { slot: "deepseek_v4_pro_reasoning_search", profile: "balanced", now: NOW },
    );
    expect(verdict.applicable).toBe(true);
  });
});

describe("evaluateFallbackWaiver — non-waivable protected slots", () => {
  test.each(NON_WAIVABLE_PROTECTED_SLOTS)(
    "%s cannot be waived even with a matching payload",
    (slot) => {
      const verdict = evaluateFallbackWaiver(
        buildWaiver({ provider_slot: slot }),
        { slot, profile: "balanced", now: NOW },
      );
      expect(verdict.applicable).toBe(false);
      expect(verdict.synthesis_eligible_after_waiver).toBe(false);
      expect(
        verdict.reasons.some(
          (r) => r.field === "fallback_waiver.provider_slot" && r.message.includes("non-waivable"),
        ),
      ).toBe(true);
    },
  );

  test("a waiver that omits a non-waivable slot from its own list still cannot apply it", () => {
    // Oracle's canonical list is authoritative. Even if APR ships a
    // waiver whose `non_waivable_slots: []`, the slot stays protected.
    const verdict = evaluateFallbackWaiver(
      buildWaiver({
        provider_slot: "chatgpt_pro_synthesis",
        non_waivable_slots: [], // attempt to expand scope
      }),
      { slot: "chatgpt_pro_synthesis", profile: "balanced", now: NOW },
    );
    expect(verdict.applicable).toBe(false);
    expect(
      verdict.reasons.some((r) => r.message.includes("Oracle's canonical list")),
    ).toBe(true);
  });
});

describe("evaluateFallbackWaiver — invariant rejections", () => {
  test("expired waivers are rejected with provider_login_required", () => {
    const verdict = evaluateFallbackWaiver(
      buildWaiver({ expires_at: "2026-05-12T00:00:00Z" }), // 12h before NOW
      { slot: "xai_grok_reasoning", profile: "balanced", now: NOW },
    );
    expect(verdict.applicable).toBe(false);
    expect(
      verdict.reasons.find((r) => r.field === "fallback_waiver.expires_at")?.code,
    ).toBe("provider_login_required");
  });

  test("user_acknowledged=false is rejected", () => {
    const verdict = evaluateFallbackWaiver(
      buildWaiver({ user_acknowledged: false }),
      { slot: "xai_grok_reasoning", profile: "balanced", now: NOW },
    );
    expect(verdict.applicable).toBe(false);
    expect(
      verdict.reasons.some((r) => r.field === "fallback_waiver.user_acknowledged"),
    ).toBe(true);
  });

  test("profile mismatch is rejected (balanced waiver does not cover audit)", () => {
    const verdict = evaluateFallbackWaiver(
      buildWaiver({ profile: "balanced" }),
      { slot: "xai_grok_reasoning", profile: "audit", now: NOW },
    );
    expect(verdict.applicable).toBe(false);
    expect(verdict.reasons.some((r) => r.field === "fallback_waiver.profile")).toBe(true);
  });

  test("slot mismatch is rejected (waiver for xai cannot cover deepseek)", () => {
    const verdict = evaluateFallbackWaiver(
      buildWaiver({ provider_slot: "xai_grok_reasoning" }),
      { slot: "deepseek_v4_pro_reasoning_search", profile: "balanced", now: NOW },
    );
    expect(verdict.applicable).toBe(false);
    expect(
      verdict.reasons.some((r) => r.field === "fallback_waiver.provider_slot"),
    ).toBe(true);
  });

  test("malformed payload returns reasons + non-applicable", () => {
    const verdict = evaluateFallbackWaiver(
      { schema_version: "wrong.v1" },
      { slot: "xai_grok_reasoning", profile: "balanced", now: NOW },
    );
    expect(verdict.applicable).toBe(false);
    expect(verdict.reasons.length).toBeGreaterThan(0);
    expect(verdict.waiver_id).toBeNull();
  });

  test("malformed expires_at is rejected", () => {
    const verdict = evaluateFallbackWaiver(
      buildWaiver({ expires_at: "not-a-date" }),
      { slot: "xai_grok_reasoning", profile: "balanced", now: NOW },
    );
    expect(verdict.applicable).toBe(false);
    expect(verdict.reasons.some((r) => r.field === "fallback_waiver.expires_at")).toBe(true);
  });
});

describe("buildWaiverHandoffMetadata — always-visible audit trail", () => {
  test("no waiver attempted yields waiver_attempted: false but still produces metadata", () => {
    const metadata = buildWaiverHandoffMetadata(null, {
      slot: "xai_grok_reasoning",
      profile: "balanced",
      now: NOW,
    });
    expect(metadata.waiver_attempted).toBe(false);
    expect(metadata.waiver_applicable).toBe(false);
    expect(metadata.waiver_id).toBeNull();
  });

  test("rejected waiver MUST surface in handoff even when applicable=false", () => {
    // Adversarial: APR sends a waiver attempting to cover a protected slot.
    // Oracle rejects, but the audit trail MUST show the attempt.
    const metadata = buildWaiverHandoffMetadata(
      buildWaiver({ provider_slot: "chatgpt_pro_synthesis", must_surface_in_handoff: false }),
      { slot: "chatgpt_pro_synthesis", profile: "balanced", now: NOW },
    );
    expect(metadata.waiver_attempted).toBe(true);
    expect(metadata.waiver_applicable).toBe(false);
    // Rejected waivers force `must_surface_in_handoff: true` so the
    // failed attempt cannot be hidden by the orchestrator.
    expect(metadata.must_surface_in_handoff).toBe(true);
    expect(metadata.synthesis_eligible_after_waiver).toBe(false);
    expect(metadata.reasons.length).toBeGreaterThan(0);
  });

  test("applied waiver carries through synthesis_eligible_after_waiver", () => {
    const metadata = buildWaiverHandoffMetadata(buildWaiver(), {
      slot: "xai_grok_reasoning",
      profile: "balanced",
      now: NOW,
    });
    expect(metadata.waiver_applicable).toBe(true);
    expect(metadata.synthesis_eligible_after_waiver).toBe(true);
  });
});

describe("isWaiverApplicable — boolean convenience", () => {
  test("returns true for an applicable waiver", () => {
    expect(
      isWaiverApplicable(buildWaiver(), {
        slot: "xai_grok_reasoning",
        profile: "balanced",
        now: NOW,
      }),
    ).toBe(true);
  });

  test("returns false for a non-waivable slot", () => {
    expect(
      isWaiverApplicable(buildWaiver({ provider_slot: "gemini_deep_think" }), {
        slot: "gemini_deep_think",
        profile: "balanced",
        now: NOW,
      }),
    ).toBe(false);
  });
});

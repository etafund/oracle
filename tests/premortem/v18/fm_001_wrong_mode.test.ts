import crypto from "node:crypto";
import { describe, expect, test } from "vitest";

import {
  BrowserEvidenceBuildError,
  buildBrowserEvidence,
  type BuildBrowserEvidenceInput,
} from "@src/browser/evidence.ts";
import { evaluateBrowserEvidenceTrust, evaluateSynthesisGate } from "@src/oracle/v18/index.ts";
import { detectSilentDowngrade } from "@src/oracle/v18/protected_slot_boundaries.ts";
import { PLACEHOLDER_SHA256, premortemForId } from "@tests/_helpers/premortem.ts";

const FM = premortemForId("FM-001")!;

function realHash(seed: string): string {
  return `sha256:${crypto.createHash("sha256").update(seed).digest("hex")}`;
}

function happyInput(overrides: Partial<BuildBrowserEvidenceInput> = {}): BuildBrowserEvidenceInput {
  return {
    evidence_id: "ev-premortem-fm001",
    run_id: "run-fm001",
    provider: "chatgpt",
    provider_slot: "chatgpt_pro_first_plan",
    provider_result_id: "pr-fm001",
    requested_mode: "pro_extended_reasoning",
    mode_verified: true,
    verified_before_prompt_submit: true,
    reasoning_effort_verified: true,
    unsafe_artifacts_quarantined: true,
    verified_at: "2026-05-12T00:00:00Z",
    prompt_submitted_at: "2026-05-12T00:00:05Z",
    created_at: "2026-05-12T00:00:10Z",
    verification_method: "same_session_ui_observation_plus_selector_trace",
    verification_scope: "same_browser_session_before_prompt_submit",
    capture_confidence: "high",
    redaction_policy: "redacted",
    promptBytes: "real prompt bytes",
    outputBytes: "real output bytes",
    transition_log: { bytes: '[{"t":1}]' },
    available_effort_labels: ["Auto", "Thinking", "Pro"],
    session_id_hash: realHash("session-fm001"),
    observed_mode_label: "Pro",
    selector_manifest_version: "chatgpt-pro-v1",
    requested_reasoning_effort: "max_browser_available",
    observed_reasoning_effort_label: "Heavy",
    effort_rank: "highest_visible",
    selected_effort_is_highest_visible: true,
    browser_effort_strategy: "select_highest_visible",
    ...overrides,
  };
}

describe(`premortem ${FM.id}: ${FM.title}`, () => {
  test("documents which Oracle acceptance checks this file covers", () => {
    expect(FM.oracle_acceptance_checks.length).toBeGreaterThan(0);
  });

  test("happy path produces a trusted evidence ledger", () => {
    const evidence = buildBrowserEvidence(happyInput());
    const trust = evaluateBrowserEvidenceTrust(evidence);
    expect(trust.eligible).toBe(true);
  });

  test("verified_at AFTER prompt_submitted_at is rejected at build time", () => {
    expect(() =>
      buildBrowserEvidence(
        happyInput({
          verified_at: "2026-05-12T00:00:10Z",
          prompt_submitted_at: "2026-05-12T00:00:05Z",
          created_at: "2026-05-12T00:00:15Z",
        }),
      ),
    ).toThrowError(/verification must precede prompt submission/i);
  });

  test("mode_verified=false fails the policy trust gate even when timestamps are fine", () => {
    const evidence = buildBrowserEvidence(
      happyInput({
        mode_verified: false,
        verified_before_prompt_submit: false,
      }),
    );
    const trust = evaluateBrowserEvidenceTrust(evidence);
    expect(trust.eligible).toBe(false);
    expect(trust.blockedReasons.some((r) => r.field === "browser_evidence.mode_verified")).toBe(
      true,
    );
  });

  test("placeholder hashes (all-zeros) are rejected at build time", () => {
    expect(() =>
      buildBrowserEvidence(happyInput({ session_id_hash: PLACEHOLDER_SHA256 })),
    ).toThrowError(/placeholder/i);
  });

  test("placeholder-hash rejection identifies the offending field by name", () => {
    let captured: unknown = null;
    try {
      buildBrowserEvidence(happyInput({ session_id_hash: PLACEHOLDER_SHA256 }));
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(Error);
    expect((captured as Error).message).toContain("session_id_hash");
    expect((captured as Error).message).toMatch(/placeholder/i);
  });

  test("BrowserEvidenceBuildError surfaces from timestamp violations with a .field property", () => {
    let captured: unknown = null;
    try {
      buildBrowserEvidence(
        happyInput({
          verified_at: "2026-05-12T00:00:10Z",
          prompt_submitted_at: "2026-05-12T00:00:05Z",
          created_at: "2026-05-12T00:00:15Z",
        }),
      );
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(BrowserEvidenceBuildError);
    expect((captured as BrowserEvidenceBuildError).field).toBe("verified_at");
  });
});

describe(`premortem ${FM.id}: silent-downgrade detector`, () => {
  test("missing observed_reasoning_effort_label is rejected", () => {
    const verdict = detectSilentDowngrade({
      slot: "chatgpt_pro_first_plan",
      synthesis_eligible: true,
      evidence: { evidence_id: "ev-1" },
      evidence_id: "ev-1",
      reasoning_effort_verified: true,
      observed_reasoning_effort_label: "",
      selected_effort_is_highest_visible: true,
      access_path: "oracle_browser_remote",
      result_text_length: 1024,
    });
    expect(verdict.degraded).toBe(true);
    expect(verdict.synthesis_eligible).toBe(false);
    expect(
      verdict.reasons.find((r) => r.field === "provider_result.observed_reasoning_effort_label")
        ?.code,
    ).toBe("chatgpt_pro_unverified");
  });

  test("evaluateSynthesisGate collects browser-evidence trust + result blockers at once", () => {
    const verdict = evaluateSynthesisGate({
      result: {
        schema_version: "provider_result.v1",
        bundle_version: "v18.0.0",
        provider_slot: "chatgpt_pro_first_plan",
        provider_family: "chatgpt",
        access_path: "oracle_browser_remote",
        status: "success",
        synthesis_eligible: false, // result is not actually eligible
        evidence: null,
        evidence_id: null,
        prompt_manifest_sha256: realHash("pm"),
        source_baseline_sha256: realHash("sb"),
        provider_result_id: "pr-1",
        result_text_sha256: realHash("rt"),
      },
    });
    expect(verdict.eligible).toBe(false);
  });
});

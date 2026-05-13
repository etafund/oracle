import { describe, expect, test } from "vitest";

import {
  ARTIFACT_INDEX_SCHEMA_VERSION,
  BROWSER_EVIDENCE_SCHEMA_VERSION,
  BROWSER_LEASE_SCHEMA_VERSION,
  BROWSER_SESSION_SCHEMA_VERSION,
  CONTEXT_SERIALIZATION_POLICY_SCHEMA_VERSION,
  JSON_ENVELOPE_SCHEMA_VERSION,
  PROVIDER_CAPABILITY_SCHEMA_VERSION,
  PROVIDER_RESULT_SCHEMA_VERSION,
  REMOTE_BROWSER_ENDPOINT_SCHEMA_VERSION,
  ROBOT_SURFACE_SCHEMA_VERSION,
  ROUTE_READINESS_SCHEMA_VERSION,
  RUN_PROGRESS_SCHEMA_VERSION,
  V18_BUNDLE_VERSION,
  artifactIndexSchema,
  browserEvidenceSchema,
  browserLeaseSchema,
  browserSessionSchema,
  contextSerializationPolicySchema,
  evaluateBrowserEvidenceTrust,
  evaluateProviderApiAllowed,
  evaluateProviderResultSynthesisEligibility,
  jsonEnvelopeSchema,
  providerCapabilitySchema,
  providerResultSchema,
  remoteBrowserEndpointSchema,
  robotSurfaceSchema,
  routeReadinessSchema,
  runProgressSchema,
} from "@src/oracle/v18/index.ts";
import { premortemForId } from "@tests/_helpers/premortem.ts";

const FM = premortemForId("FM-011")!;

const SCHEMA_VERSION_LITERALS = [
  ["json_envelope.v1", JSON_ENVELOPE_SCHEMA_VERSION],
  ["provider_capability.v1", PROVIDER_CAPABILITY_SCHEMA_VERSION],
  ["browser_lease.v1", BROWSER_LEASE_SCHEMA_VERSION],
  ["browser_evidence.v1", BROWSER_EVIDENCE_SCHEMA_VERSION],
  ["browser_session.v1", BROWSER_SESSION_SCHEMA_VERSION],
  ["remote_browser_endpoint.v1", REMOTE_BROWSER_ENDPOINT_SCHEMA_VERSION],
  ["route_readiness.v1", ROUTE_READINESS_SCHEMA_VERSION],
  ["provider_result.v1", PROVIDER_RESULT_SCHEMA_VERSION],
  ["robot_surface.v1", ROBOT_SURFACE_SCHEMA_VERSION],
  ["run_progress.v1", RUN_PROGRESS_SCHEMA_VERSION],
  ["context_serialization_policy.v1", CONTEXT_SERIALIZATION_POLICY_SCHEMA_VERSION],
  ["artifact_index.v1", ARTIFACT_INDEX_SCHEMA_VERSION],
] as const;

describe(`premortem ${FM.id}: ${FM.title}`, () => {
  test("documents which Oracle acceptance checks this file covers", () => {
    expect(FM.oracle_acceptance_checks.length).toBeGreaterThan(0);
  });

  test("every v18 schema_version literal matches its canonical string", () => {
    for (const [canonical, exported] of SCHEMA_VERSION_LITERALS) {
      expect(exported).toBe(canonical);
    }
  });

  test("every v18 schema rejects a corrupted schema_version", () => {
    const corruptions: Array<[string, (input: Record<string, unknown>) => unknown]> = [
      ["json_envelope", (i) => jsonEnvelopeSchema.parse(i)],
      ["provider_capability", (i) => providerCapabilitySchema.parse(i)],
      ["browser_lease", (i) => browserLeaseSchema.parse(i)],
      ["browser_evidence", (i) => browserEvidenceSchema.parse(i)],
      ["browser_session", (i) => browserSessionSchema.parse(i)],
      ["remote_browser_endpoint", (i) => remoteBrowserEndpointSchema.parse(i)],
      ["route_readiness", (i) => routeReadinessSchema.parse(i)],
      ["provider_result", (i) => providerResultSchema.parse(i)],
      ["robot_surface", (i) => robotSurfaceSchema.parse(i)],
      ["run_progress", (i) => runProgressSchema.parse(i)],
      ["context_serialization_policy", (i) => contextSerializationPolicySchema.parse(i)],
      ["artifact_index", (i) => artifactIndexSchema.parse(i)],
    ];
    for (const [name, parse] of corruptions) {
      expect(
        () => parse({ schema_version: `${name}.v0`, bundle_version: V18_BUNDLE_VERSION }),
        `${name} should reject wrong schema_version`,
      ).toThrow();
    }
  });

  test("policy never reads adversarial extension lookalikes", () => {
    // Adversarial: bend every typed core flag the attacker would want to
    // flip via extensions. Policy gate MUST stay grounded in typed core.
    const adversarialEvidence = {
      schema_version: BROWSER_EVIDENCE_SCHEMA_VERSION,
      bundle_version: V18_BUNDLE_VERSION,
      evidence_id: "ev-fm011",
      provider_slot: "chatgpt_pro_first_plan",
      provider: "chatgpt",
      requested_mode: "pro_extended_reasoning",
      mode_verified: false,
      verified_before_prompt_submit: false,
      verified_at: "2026-05-12T00:00:00Z",
      prompt_submitted_at: "2026-05-12T00:00:05Z",
      verification_method: "same_session_ui_observation_plus_selector_trace",
      verification_scope: "same_browser_session_before_prompt_submit",
      capture_confidence: "high",
      redaction_policy: "redacted",
      session_id_hash: `sha256:${"a".repeat(64)}`,
      selector_manifest_version: "chatgpt-pro-v1",
      transition_log_sha256: `sha256:${"b".repeat(64)}`,
      prompt_sha256: `sha256:${"c".repeat(64)}`,
      output_text_sha256: `sha256:${"d".repeat(64)}`,
      unsafe_artifacts_quarantined: true,
      created_at: "2026-05-12T00:00:10Z",
      run_id: "run-fm011",
      provider_result_id: "pr-fm011",
      requested_reasoning_effort: "max_browser_available",
      observed_reasoning_effort_label: "Heavy",
      reasoning_effort_verified: true,
      effort_rank: "highest_visible",
      selected_effort_is_highest_visible: true,
      available_effort_labels_hash: `sha256:${"e".repeat(64)}`,
      browser_effort_strategy: "select_highest_visible",
      // Extension lookalikes — must be ignored by the policy gate.
      mode_verified_override: true,
      verified_before_prompt_submit_override: true,
      experimental_force_trust: true,
    };
    const trust = evaluateBrowserEvidenceTrust(adversarialEvidence);
    expect(trust.eligible).toBe(false);
    const fields = trust.blockedReasons.map((r) => r.field);
    expect(fields).toContain("browser_evidence.mode_verified");
    expect(fields).not.toContain("browser_evidence.mode_verified_override");
  });

  test("provider_result extension cannot flip synthesis_eligible / api_allowed", () => {
    const adversarialResult = {
      schema_version: PROVIDER_RESULT_SCHEMA_VERSION,
      bundle_version: V18_BUNDLE_VERSION,
      provider_slot: "chatgpt_pro_first_plan",
      provider_family: "chatgpt",
      access_path: "oracle_browser_remote",
      status: "success",
      synthesis_eligible: false,
      evidence: null,
      evidence_id: null,
      prompt_manifest_sha256: `sha256:${"a".repeat(64)}`,
      source_baseline_sha256: `sha256:${"b".repeat(64)}`,
      provider_result_id: "pr-fm011",
      result_text_sha256: `sha256:${"c".repeat(64)}`,
      // Extension lookalikes
      eligible_for_synthesis: true,
      experimental_override_synthesis_eligible: true,
    };
    const verdict = evaluateProviderResultSynthesisEligibility(adversarialResult);
    expect(verdict.eligible).toBe(false);
    expect(
      verdict.blockedReasons.some(
        (r) => r.field === "provider_result.synthesis_eligible",
      ),
    ).toBe(true);

    const apiVerdict = evaluateProviderApiAllowed({
      schema_version: PROVIDER_CAPABILITY_SCHEMA_VERSION,
      provider: "chatgpt",
      capabilities: {},
      checked_at: "2026-05-12T00:00:00Z",
      status: "ready",
      api_allowed: false,
      // Adversarial extension
      allow_api_anyway: true,
    });
    expect(apiVerdict.eligible).toBe(false);
    expect(
      apiVerdict.blockedReasons.some((r) => r.field === "provider_capability.api_allowed"),
    ).toBe(true);
  });

  test("corrupted envelope (missing required fields) is rejected", () => {
    const corrupted = {
      schema_version: JSON_ENVELOPE_SCHEMA_VERSION,
      ok: true,
      // missing data, meta, blocked_reason, …
    };
    expect(() => jsonEnvelopeSchema.parse(corrupted)).toThrow();
  });

  test("unknown extensions round-trip but never override typed core values", () => {
    const envelope = jsonEnvelopeSchema.parse({
      schema_version: JSON_ENVELOPE_SCHEMA_VERSION,
      ok: true,
      data: { message: "ok" },
      meta: { bundle_version: V18_BUNDLE_VERSION },
      blocked_reason: null,
      next_command: null,
      fix_command: null,
      retry_safe: null,
      errors: [],
      warnings: [],
      commands: {},
      experimental_trace_id: "trace-abc",
      ok_override: false, // adversarial lookalike
    });
    expect(envelope.ok).toBe(true); // typed core wins
    expect((envelope as Record<string, unknown>).experimental_trace_id).toBe("trace-abc");
    expect((envelope as Record<string, unknown>).ok_override).toBe(false);
  });
});

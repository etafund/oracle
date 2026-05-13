import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { expectGoldenJson } from "../../_helpers/goldenSnapshots.js";
import {
  BrowserEvidenceBuildError,
  buildBrowserEvidence,
  type BuildBrowserEvidenceInput,
} from "../../../src/browser/evidence.js";
import {
  browserEvidenceSchema,
  listIndexedEvidence,
  listQuarantinedEvidence,
  sha256OfBytes,
  writeEvidence,
} from "../../../src/oracle/v18/index.js";

function buildEvidenceInput(
  overrides: Partial<BuildBrowserEvidenceInput> = {},
): BuildBrowserEvidenceInput {
  return {
    evidence_id: "unit-evidence-1",
    run_id: "unit-run-1",
    provider: "chatgpt",
    provider_slot: "chatgpt_pro_first_plan",
    provider_result_id: "provider-result-1",
    requested_mode: "pro_extended_reasoning",
    mode_verified: true,
    verified_before_prompt_submit: true,
    reasoning_effort_verified: true,
    unsafe_artifacts_quarantined: true,
    verified_at: "2026-05-12T00:00:00.000Z",
    prompt_submitted_at: "2026-05-12T00:00:05.000Z",
    created_at: "2026-05-12T00:00:06.000Z",
    verification_method: "same_session_ui_observation_plus_selector_trace",
    verification_scope: "same_browser_session_before_prompt_submit",
    capture_confidence: "high",
    redaction_policy: "redacted",
    promptBytes: "unit prompt bytes",
    outputBytes: "unit output bytes",
    transition_log: { bytes: '[{"event":"verified"}]' },
    available_effort_labels: ["Auto", "Thinking", "Pro"],
    session_id_hash: sha256OfBytes("session-unit-evidence"),
    observed_mode_label: "Pro",
    selector_manifest_version: "chatgpt-pro-v1",
    requested_reasoning_effort: "max_browser_available",
    observed_reasoning_effort_label: "Heavy",
    effort_rank: "highest_visible",
    selected_effort_is_highest_visible: true,
    browser_effort_strategy: "select_highest_visible",
    failure_code: null,
    fix_command: null,
    next_command: null,
    ...overrides,
  };
}

describe("browser evidence unit conformance", () => {
  test("builds schema-valid evidence with deterministic hash provenance", () => {
    const evidence = buildBrowserEvidence(buildEvidenceInput());

    browserEvidenceSchema.parse(evidence);
    expect(evidence.prompt_sha256).toBe(sha256OfBytes("unit prompt bytes"));
    expect(evidence.output_text_sha256).toBe(sha256OfBytes("unit output bytes"));
    expect(evidence.transition_log_sha256).toBe(sha256OfBytes('[{"event":"verified"}]'));
    expect(evidence.available_effort_labels_hash).toBe(sha256OfBytes("Auto\nThinking\nPro"));
    expect(evidence.observed_mode_label_hash).toBe(sha256OfBytes("Pro"));
    expectGoldenJson(
      {
        evidence_id: evidence.evidence_id,
        provider: evidence.provider,
        provider_slot: evidence.provider_slot,
        prompt_sha256: evidence.prompt_sha256,
        output_text_sha256: evidence.output_text_sha256,
        transition_log_sha256: evidence.transition_log_sha256,
        available_effort_labels_hash: evidence.available_effort_labels_hash,
        session_id_hash: evidence.session_id_hash,
        observed_mode_label_hash: evidence.observed_mode_label_hash,
        mode_verified: evidence.mode_verified,
        verified_before_prompt_submit: evidence.verified_before_prompt_submit,
      },
      `
      {
        "available_effort_labels_hash": "sha256:94620d60d783a5b6f67cc85e2cfdf702b4ee3e28e251e5f266fe44e1f7ee42f1",
        "evidence_id": "unit-evidence-1",
        "mode_verified": true,
        "observed_mode_label_hash": "sha256:957b0b874524d09a5d035007f821a094a22b678fb157991e28bba1fe21d4e6b9",
        "output_text_sha256": "sha256:4580cac94f8a3193ec1b873033363e3996c9fcd78bb93a7d2f436aaa4a184e2e",
        "prompt_sha256": "sha256:cdf9ed41a0795f585ee30c712a8bc94f99ea62d3492bda025a6f63476e499d30",
        "provider": "chatgpt",
        "provider_slot": "chatgpt_pro_first_plan",
        "session_id_hash": "sha256:9821c3809ddcdf8b30755f3362ef94f11e598ff0e16c3540bbfe259f72783f2d",
        "transition_log_sha256": "sha256:6ff1914316f7dbd64f1342d1d1595ce73b5e7690712f12e6497d56ced3d2f625",
        "verified_before_prompt_submit": true
      }
      `,
    );
  });

  test("rejects placeholder and malformed hash provenance", () => {
    expect(() =>
      buildBrowserEvidence(buildEvidenceInput({ session_id_hash: `sha256:${"0".repeat(64)}` })),
    ).toThrow(/placeholder hash/);
    expect(() =>
      buildBrowserEvidence(
        buildEvidenceInput({
          transition_log: { precomputedHash: "sha256:not-a-real-hash" },
        }),
      ),
    ).toThrow(/sha256:<64 hex>/);
  });

  test("blocks prompt-before-verify success evidence", () => {
    expect(() =>
      buildBrowserEvidence(
        buildEvidenceInput({
          verified_at: "2026-05-12T00:00:06.000Z",
          prompt_submitted_at: "2026-05-12T00:00:05.000Z",
        }),
      ),
    ).toThrow(BrowserEvidenceBuildError);
    expect(() =>
      buildBrowserEvidence(
        buildEvidenceInput({
          mode_verified: false,
          verified_before_prompt_submit: true,
        }),
      ),
    ).toThrow(/cannot be true/);
  });

  test("unsafe_debug evidence is quarantined and excluded from normal evidence index", async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), "oracle-unit-evidence-"));
    try {
      const unsafeEvidence = {
        ...buildBrowserEvidence(
          buildEvidenceInput({
            evidence_id: "unit-evidence-unsafe",
            redaction_policy: "unsafe_debug",
          }),
        ),
        debug_session_token: "sk-proj-unit-secret-12345678901234567890",
      };

      const written = await writeEvidence("unit-session", unsafeEvidence, {
        homeDir,
        runId: "unit-run-1",
        evidenceMode: "unsafe",
        acknowledgeUnsafeEvidence: true,
      });
      const normalIndex = await listIndexedEvidence("unit-session", homeDir);
      const quarantineIndex = await listQuarantinedEvidence("unit-session", homeDir);
      const quarantineBytes = await readFile(written.path, "utf8");

      expect(written.quarantined).toBe(true);
      expect(written.indexed).toBe(false);
      expect(written.removedPaths).toContain("debug_session_token");
      expect(normalIndex).toEqual([]);
      expect(quarantineIndex).toHaveLength(1);
      expect(quarantineBytes).not.toContain("sk-proj-unit-secret");
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });
});

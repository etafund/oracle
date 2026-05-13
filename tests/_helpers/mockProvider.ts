// Scripted mock ChatGPT provider for the v18 mock-route rehearsal
// (oracle-2ob).
//
// The mock provider is a thin scripted source of browser-layer
// observations: the model labels it would "see", the effort labels in
// the picker, the captured assistant text, and the timestamps. Every
// downstream layer (FSM, capture verdict, effort strategy, normalizer,
// hash consistency) runs FOR REAL against these scripted inputs — only
// the actual DOM/network is replaced.
//
// This is the rehearsal stance from oracle-2ob: prove envelopes,
// command sequencing, recovery fields, leases, evidence, and provider
// result linkage all work together before live cutover.

import { createHash } from "node:crypto";

import {
  BROWSER_EVIDENCE_SCHEMA_VERSION,
  V18_BUNDLE_VERSION,
  browserEvidenceSchema,
  type BrowserEvidence,
} from "../../src/oracle/v18/contracts.js";
import type { CaptureVerdict } from "../../src/browser/output-capture/captureVerdict.js";
import type { EffortStrategyResult } from "../../src/browser/selectors/chatgpt/effortStrategy.js";
import { pickHighestVisibleEffort } from "../../src/browser/selectors/chatgpt/effortStrategy.js";
import { buildChatGptCaptureVerdict } from "../../src/browser/providers/chatgptProVerification.js";

export interface MockChatGptScript {
  readonly providerSlot: "chatgpt_pro_first_plan" | "chatgpt_pro_synthesis";
  readonly evidenceId: string;
  readonly providerResultId: string;
  /** Verbatim observed labels in the effort picker. */
  readonly observedEffortLabels: readonly string[];
  /** Verbatim captured assistant text. */
  readonly capturedText: string;
  /** Turn index of the captured assistant message. */
  readonly observedTurnIndex: number;
  /** Turn count at prompt-submit time. */
  readonly baselineTurns: number;
  /** Verification booleans the mock evidence records. */
  readonly modeVerified?: boolean;
  readonly verifiedBeforePromptSubmit?: boolean;
  /** Prompt text the mock prompt-submit emitted. */
  readonly promptText: string;
}

export interface MockChatGptRunArtifacts {
  readonly evidence: BrowserEvidence;
  readonly effort: EffortStrategyResult;
  readonly capture: CaptureVerdict;
  readonly promptSha256: `sha256:${string}`;
  readonly outputSha256: `sha256:${string}`;
}

function sha(text: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

/**
 * Generate a placeholder-resistant sha256 hash for a fixture field.
 * The v18 hash provenance guard rejects all-zero / single-hex-repeat
 * digests, so we mix the slot/index into the bytes to keep every
 * artifact distinguishable while still deterministic.
 */
function fixtureHash(slot: string, index: number): `sha256:${string}` {
  return sha(`oracle-2ob:${slot}:${index}`);
}

/**
 * Build a schema-valid BrowserEvidence ledger from the mock script.
 * Every typed-core field is populated; the digest fields are
 * deterministic so the rehearsal can be replayed byte-identically.
 */
export function buildMockBrowserEvidence(script: MockChatGptScript): BrowserEvidence {
  const promptSha = sha(script.promptText);
  const outputSha = sha(script.capturedText);
  const labelsSorted = [...script.observedEffortLabels]
    .map((s) => s.trim().replace(/\s+/g, " "))
    .filter(Boolean)
    .sort()
    .join("\n");
  const availableLabelsHash = sha(labelsSorted || "empty-effort-picker");

  const raw = {
    available_effort_labels_hash: availableLabelsHash,
    browser_effort_strategy: "select_highest_visible",
    bundle_version: V18_BUNDLE_VERSION,
    capture_confidence: "high",
    created_at: "2026-05-13T00:00:10Z",
    effort_rank: "highest_visible",
    evidence_id: script.evidenceId,
    evidence_privacy: {
      stores_account_identifiers: false,
      stores_cookies: false,
      stores_raw_dom: false,
      stores_raw_screenshots: false,
    },
    failure_code: null,
    fix_command: null,
    mode_verified: script.modeVerified ?? true,
    next_command: null,
    observed_reasoning_effort_label: "Heavy",
    output_text_sha256: outputSha,
    prompt_sha256: promptSha,
    prompt_submitted_at: "2026-05-13T00:00:05Z",
    provider: "chatgpt",
    provider_result_id: script.providerResultId,
    provider_slot: script.providerSlot,
    reasoning_effort_verified: true,
    redaction_policy: "redacted",
    requested_mode: "pro_extended_reasoning",
    requested_reasoning_effort: "max_browser_available",
    run_id: "rehearsal-run",
    schema_version: BROWSER_EVIDENCE_SCHEMA_VERSION,
    selected_effort_is_highest_visible: true,
    selector_manifest_version: "chatgpt-selectors.v1",
    session_id_hash: fixtureHash(script.providerSlot, 1),
    transition_log_sha256: fixtureHash(script.providerSlot, 2),
    unsafe_artifacts_quarantined: true,
    verification_method: "same_session_ui_observation_plus_selector_trace",
    verification_scope: "same_browser_session_before_prompt_submit",
    verified_at: "2026-05-13T00:00:00Z",
    verified_before_prompt_submit: script.verifiedBeforePromptSubmit ?? true,
  };
  return browserEvidenceSchema.parse(raw) as BrowserEvidence;
}

/**
 * Run the full mock script: build evidence, evaluate the effort
 * strategy on the scripted labels, build the capture verdict from the
 * scripted text + turn binding. Returns the artifacts the rehearsal
 * passes downstream to the normalizer and hash-consistency layer.
 */
export function runMockChatGptScript(script: MockChatGptScript): MockChatGptRunArtifacts {
  const evidence = buildMockBrowserEvidence(script);
  const effort = pickHighestVisibleEffort({
    observedLabels: script.observedEffortLabels,
  });
  const promptSha = sha(script.promptText);
  const capture = buildChatGptCaptureVerdict({
    text: script.capturedText,
    turnId: `turn-${script.observedTurnIndex}`,
    messageId: `msg-${script.observedTurnIndex}`,
    turnBinding: {
      baselineTurns: script.baselineTurns,
      observedTurnIndex: script.observedTurnIndex,
      expectedPromptSha256: promptSha,
      observedPromptSha256: promptSha,
    },
  });
  return {
    evidence,
    effort,
    capture,
    promptSha256: promptSha,
    outputSha256: sha(script.capturedText),
  };
}

/** Convenience defaults the rehearsal uses for happy-path runs. */
export const DEFAULT_HAPPY_SCRIPT: MockChatGptScript = {
  providerSlot: "chatgpt_pro_first_plan",
  evidenceId: "evidence-rehearsal-first-plan",
  providerResultId: "provider-result-rehearsal-first-plan",
  observedEffortLabels: ["Heavy", "Pro Extended", "Thinking"],
  capturedText: `# Plan

- alpha
- bravo

\`\`\`ts
const x: number = 42;
\`\`\`

[link](https://example.invalid/spec).
`,
  observedTurnIndex: 4,
  baselineTurns: 3,
  promptText: "Review the storage adapters for schema drift.",
};

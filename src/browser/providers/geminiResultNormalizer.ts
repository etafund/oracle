// Browser-layer wrapper around the v18 Gemini Deep Think provider_result normalizer.

import type { BrowserEvidence } from "../../oracle/v18/contracts.js";
import { tryQuarantineRawCaptureSync } from "../../oracle/v18/evidence_quarantine_raw.js";
import {
  buildGeminiProviderResult,
  type BuildGeminiProviderResultInput,
  type GeminiBlockedReason,
  type GeminiCaptureSummary,
  type GeminiDeepThinkSlot,
  type GeminiEffortSummary,
  type GeminiProviderResultBuild,
} from "../../oracle/v18/gemini_provider_result.js";
import type { GeminiStreamCaptureSummary } from "../../gemini-web/streamSafeguards.js";
import type { GeminiDeepThinkVerificationResult } from "./geminiDeepThink_verification.js";

export {
  buildGeminiProviderResult,
  type BuildGeminiProviderResultInput,
  type GeminiBlockedReason,
  type GeminiCaptureSummary,
  type GeminiDeepThinkSlot,
  type GeminiEffortSummary,
  type GeminiProviderResultBuild,
};

export function geminiCaptureToSummary(capture: GeminiStreamCaptureSummary): GeminiCaptureSummary {
  const hasOutput = capture.output_bytes > 0 && capture.result_text_sha256 !== null;
  return {
    status: hasOutput ? "captured" : "empty",
    outputTextSha256: capture.result_text_sha256,
    captureConfidence: capture.confidence,
    captureMethod: capture.capture_method,
  };
}

export function geminiDeepThinkToEffortSummary(
  verdict: GeminiDeepThinkVerificationResult,
): GeminiEffortSummary {
  return {
    status: verdict.status,
    observedReasoningEffortLabel: verdict.deepThinkLabel ?? verdict.selected,
    selectedIsHighestVisible: verdict.selectedIsHighestVisible,
    thinkingLevelIfExposed: verdict.thinkingLevelControlExposed ? verdict.selected : null,
    thinkingLevelVerified: verdict.thinkingLevelVerified,
  };
}

export interface NormalizeGeminiRunInput {
  readonly slot: GeminiDeepThinkSlot;
  readonly providerResultId: string;
  readonly accessPath: string;
  readonly evidence: BrowserEvidence | null;
  readonly capture: GeminiStreamCaptureSummary;
  readonly deepThink: GeminiDeepThinkVerificationResult;
  readonly promptManifestSha256: `sha256:${string}`;
  readonly sourceBaselineSha256: `sha256:${string}`;
  readonly evidencePath?: string | null;
  readonly resultPath?: string | null;
  readonly model?: string;
  readonly degradationReason?: string | null;
  readonly error?: Record<string, unknown> | null;
  /**
   * Optional session id; when present, a parse failure persists the
   * raw input bundle under `<homeDir>/sessions/<sessionId>/evidence/
   * quarantine/raw_capture/` before re-throwing
   * (oracle-v18-evidence-schema-parse-no-raw-quarantine-y00).
   */
  readonly sessionId?: string;
  /** Optional override for the oracle home directory (test hook). */
  readonly homeDir?: string;
}

/**
 * Error subclass thrown when the underlying v18 schema parse fails.
 * Wraps the original error and exposes the path of the raw-capture
 * quarantine file (when one was successfully written) so post-mortem
 * tooling can correlate logs with the persisted bytes.
 */
export class GeminiNormalizerParseError extends Error {
  readonly cause: unknown;
  readonly quarantinePath: string | null;
  constructor(cause: unknown, quarantinePath: string | null) {
    const message =
      cause instanceof Error ? cause.message : `gemini normalizer parse failed: ${String(cause)}`;
    super(message);
    this.name = "GeminiNormalizerParseError";
    this.cause = cause;
    this.quarantinePath = quarantinePath;
  }
}

export function normalizeGeminiRun(input: NormalizeGeminiRunInput): GeminiProviderResultBuild {
  try {
    return buildGeminiProviderResult({
      slot: input.slot,
      providerResultId: input.providerResultId,
      accessPath: input.accessPath,
      evidence: input.evidence,
      capture: geminiCaptureToSummary(input.capture),
      effort: geminiDeepThinkToEffortSummary(input.deepThink),
      promptManifestSha256: input.promptManifestSha256,
      sourceBaselineSha256: input.sourceBaselineSha256,
      evidencePath: input.evidencePath,
      resultPath: input.resultPath,
      model: input.model,
      degradationReason: input.degradationReason,
      error: input.error,
    });
  } catch (error) {
    const quarantined = input.sessionId
      ? tryQuarantineRawCaptureSync({
          sessionId: input.sessionId,
          homeDir: input.homeDir,
          source: "gemini-normalizer",
          error,
          rawInput: input,
          evidenceId: input.evidence?.evidence_id ?? null,
        })
      : null;
    throw new GeminiNormalizerParseError(error, quarantined?.path ?? null);
  }
}

// Browser-layer wrapper around the v18 ChatGPT provider_result
// normalizer (oracle-e8u).
//
// Bridges the FSM context (oracle-php) + capture verdict (oracle-qfl)
// + selector manifest version (oracle-hcs) into a strict v18
// `provider_result.v1`. APR consumers do not need to know anything
// about DOM selectors or browser internals — they get a typed
// ProviderResult plus a list of blocker reasons.

import type { BrowserEvidence } from "../../oracle/v18/contracts.js";
import {
  buildChatGptProviderResult,
  isChatGptProSlot,
  type BlockedReason,
  type BuildChatGptProviderResultInput,
  type ChatGptProSlot,
  type ChatGptProviderResultBuild,
  type NormalizerCaptureSummary,
  type NormalizerEffortSummary,
} from "../../oracle/v18/chatgpt_provider_result.js";
import { tryQuarantineRawCaptureSync } from "../../oracle/v18/evidence_quarantine_raw.js";
import type { OracleBrowserAccessPath } from "../../oracle/v18/provider_access_policy.js";
import type { ProviderBoundaryPavMetadata } from "../../oracle/provider_boundaries_pav.js";
import type { CaptureVerdict } from "../output-capture/captureVerdict.js";
import type { EffortStrategyResult } from "../selectors/chatgpt/effortStrategy.js";

export {
  buildChatGptProviderResult,
  isChatGptProSlot,
  type BlockedReason,
  type BuildChatGptProviderResultInput,
  type ChatGptProSlot,
  type ChatGptProviderResultBuild,
  type NormalizerCaptureSummary,
  type NormalizerEffortSummary,
};

/**
 * Convenience: project a captureVerdict into the normalizer summary
 * shape. Used by the higher-level browser driver so the driver does
 * not need to know about the v18 module's exact field names.
 */
export function captureToSummary(verdict: CaptureVerdict): NormalizerCaptureSummary {
  return {
    status: verdict.status,
    outputTextSha256: verdict.outputTextSha256,
    markdownPreserved: verdict.markdownPreserved,
    captureConfidence: verdict.captureConfidence,
  };
}

/**
 * Project an effort strategy result into the normalizer summary shape.
 */
export function effortToSummary(verdict: EffortStrategyResult): NormalizerEffortSummary {
  return {
    status: verdict.status,
    availableEffortLabelsHash: verdict.availableEffortLabelsHash,
    tier: verdict.tier,
    selected: verdict.selected,
    selectorManifestVersion: verdict.selectorManifestVersion,
    selectedIsHighestVisible: verdict.selectedIsHighestVisible,
  };
}

/**
 * Bundled entry point: takes the browser-side artefacts directly
 * (CaptureVerdict + EffortStrategyResult + evidence + hashes) and
 * returns the parsed v18 result + blocker list.
 */
export interface NormalizeChatGptRunInput {
  readonly slot: ChatGptProSlot;
  readonly providerResultId: string;
  readonly accessPath: OracleBrowserAccessPath;
  readonly evidence: BrowserEvidence;
  readonly capture: CaptureVerdict;
  readonly effort: EffortStrategyResult;
  readonly promptManifestSha256: `sha256:${string}`;
  readonly sourceBaselineSha256: `sha256:${string}`;
  readonly providerBoundaryPav?: ProviderBoundaryPavMetadata;
  readonly resultPath?: string;
  readonly model?: string;
  readonly degradationReason?: string;
  readonly error?: Record<string, unknown>;
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
export class ChatGptNormalizerParseError extends Error {
  readonly cause: unknown;
  readonly quarantinePath: string | null;
  constructor(cause: unknown, quarantinePath: string | null) {
    const message =
      cause instanceof Error ? cause.message : `chatgpt normalizer parse failed: ${String(cause)}`;
    super(message);
    this.name = "ChatGptNormalizerParseError";
    this.cause = cause;
    this.quarantinePath = quarantinePath;
  }
}

export function normalizeChatGptRun(input: NormalizeChatGptRunInput): ChatGptProviderResultBuild {
  try {
    return buildChatGptProviderResult({
      slot: input.slot,
      providerResultId: input.providerResultId,
      accessPath: input.accessPath,
      evidence: input.evidence,
      capture: captureToSummary(input.capture),
      effort: effortToSummary(input.effort),
      promptManifestSha256: input.promptManifestSha256,
      sourceBaselineSha256: input.sourceBaselineSha256,
      providerBoundaryPav: input.providerBoundaryPav,
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
          source: "chatgpt-normalizer",
          error,
          rawInput: input,
          evidenceId: input.evidence?.evidence_id ?? null,
        })
      : null;
    throw new ChatGptNormalizerParseError(error, quarantined?.path ?? null);
  }
}

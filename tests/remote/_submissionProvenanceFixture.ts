import { createHash } from "node:crypto";
import type {
  BrowserRunOptions,
  BrowserPromptFallbackReason,
  BrowserSubmissionProvenance,
  BrowserSubmissionTransport,
} from "../../src/browser/types.js";
import { buildPromptRecoveryOwnershipPreview } from "../../src/browser/promptDomMatch.js";
import type {
  BrowserModelSelectionEvidence,
  BrowserRemoteRunProvenance,
} from "../../src/sessionManager.js";

export const VERIFIED_SOL_MODEL_LABEL = "GPT-5.6 Sol" as const;
export const VERIFIED_PRO_MODE_LABEL = "Pro" as const;

export async function emitDurableRecoveryCheckpoint(
  options: Pick<BrowserRunOptions, "runtimeHintCb" | "submittedPromptPreviewCb">,
  submittedPrompt: string,
  conversationId = "remote-recovery-test",
): Promise<void> {
  await options.submittedPromptPreviewCb?.(
    buildPromptRecoveryOwnershipPreview(submittedPrompt),
    "d".repeat(64),
  );
  await options.runtimeHintCb?.({
    tabUrl: `https://chatgpt.com/c/${conversationId}`,
    conversationId,
    promptSubmitted: true,
  });
}

function promptSha256(prompt: string): string {
  return createHash("sha256").update(prompt, "utf8").digest("hex");
}

export function primarySubmissionProvenance(
  prompt: string,
  transport: BrowserSubmissionTransport = "inline",
): BrowserSubmissionProvenance {
  const sha256 = promptSha256(prompt);
  return {
    primaryPromptSha256: sha256,
    submittedPromptSha256: sha256,
    primaryTransport: transport,
    submittedTransport: transport,
    fallbackUsed: false,
    fallbackReason: null,
    equivalenceAlgorithm: null,
    equivalenceVerified: null,
  };
}

export function fallbackSubmissionProvenance(input: {
  primaryPrompt: string;
  submittedPrompt: string;
  reason: BrowserPromptFallbackReason;
}): BrowserSubmissionProvenance {
  const uploadToInline = input.reason === "auto-upload-timeout-to-inline";
  return {
    primaryPromptSha256: promptSha256(input.primaryPrompt),
    submittedPromptSha256: promptSha256(input.submittedPrompt),
    primaryTransport: uploadToInline ? "upload" : "inline",
    submittedTransport: uploadToInline ? "inline" : "upload",
    fallbackUsed: true,
    fallbackReason: input.reason,
    equivalenceAlgorithm: "oracle.browser-auto-fallback-exact.v2",
    equivalenceVerified: true,
  };
}

export function verifiedSolProModelSelection(): BrowserModelSelectionEvidence {
  return {
    requestedModel: VERIFIED_SOL_MODEL_LABEL,
    resolvedLabel: `${VERIFIED_SOL_MODEL_LABEL} + ${VERIFIED_PRO_MODE_LABEL}`,
    requestedModelLabel: VERIFIED_SOL_MODEL_LABEL,
    resolvedModelLabel: VERIFIED_SOL_MODEL_LABEL,
    modelVerified: true,
    requestedMode: VERIFIED_PRO_MODE_LABEL,
    resolvedModeLabel: VERIFIED_PRO_MODE_LABEL,
    modeVerified: true,
    verifiedBeforePromptSubmit: true,
    strategy: "select",
    status: "already-selected",
    verified: true,
    source: "chatgpt-model-picker",
    capturedAt: "2026-07-03T00:00:00.000Z",
  };
}

export function strongRemoteSuccessProvenance(
  prompt: string,
  transport: BrowserSubmissionTransport = "inline",
): BrowserRemoteRunProvenance {
  return {
    modelVerified: true,
    modelRequested: VERIFIED_SOL_MODEL_LABEL,
    modelResolved: `${VERIFIED_SOL_MODEL_LABEL} + ${VERIFIED_PRO_MODE_LABEL}`,
    requestedModelLabel: VERIFIED_SOL_MODEL_LABEL,
    resolvedModelLabel: VERIFIED_SOL_MODEL_LABEL,
    modelLabelVerified: true,
    requestedMode: VERIFIED_PRO_MODE_LABEL,
    resolvedModeLabel: VERIFIED_PRO_MODE_LABEL,
    modeVerified: true,
    verifiedBeforePromptSubmit: true,
    captureBindingVerified: true,
    captureBindingQuality: "message-handle",
    challengeClean: true,
    submission: primarySubmissionProvenance(prompt, transport),
  };
}

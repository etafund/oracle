export {
  navigateToChatGPT,
  navigateToPromptReadyWithFallback,
  ensureNotBlocked,
  ensureLoggedIn,
  ensurePromptReady,
  waitForResumedConversationHydration,
  installJavaScriptDialogAutoDismissal,
} from "./actions/navigation.js";
export { ensureModelSelection } from "./actions/modelSelection.js";
export { submitPrompt, clearPromptComposer } from "./actions/promptComposer.js";
export {
  clearComposerAttachments,
  uploadAttachmentFile,
  waitForAttachmentCompletion,
  waitForUserTurnAttachments,
  buildUserTurnAttachmentExpressionForTest,
} from "./actions/attachments.js";
export {
  readAssistantSnapshot,
  captureAssistantMarkdown,
  buildAssistantExtractorForTest,
  buildAssistantSnapshotExpressionForTest,
  buildConversationDebugExpressionForTest,
  buildMarkdownFallbackExtractorForTest,
  buildCopyExpressionForTest,
} from "./actions/assistantResponse.js";

import type { BrowserLogger, ChromeClient } from "./types.js";
import { waitForAssistantResponse as waitForAssistantResponseUnvalidated } from "./actions/assistantResponse.js";
import { assertCapturedAssistantResponseBound } from "./actions/captureBinding.js";
import { assertCapturedAnswerNotAccessArtifact } from "./actions/challengeDetection.js";

/**
 * Capture facade: waits for the assistant response, then
 * 1. structurally validates that the captured message is bound to THIS run's
 *    own submitted user message (same conversation from submit to capture,
 *    message follows the run's own user turn) — no-op when no submission
 *    binding was registered for this runtime (non-ChatGPT providers,
 *    reattach inspection, unit tests); and
 * 2. runs the PRE-RESULT access gate: a captured login wall or verification
 *    interstitial is never emitted as an answer, and challenge-class
 *    findings trip the worker-local quarantine latch before the typed error
 *    surfaces.
 *
 * `accountId`, when supplied, is the caller's authoritative worker account
 * id (server layer: `options.accountId ?? env`, see
 * BrowserRunOptions.accountId) and is threaded into the quarantine gate so a
 * trip lands under the SAME account id the serve layer's /ready and /runs
 * admission checks use. Omitted callers keep the prior env-resolved
 * behavior.
 */
export async function waitForAssistantResponse(
  Runtime: ChromeClient["Runtime"],
  timeoutMs: number,
  logger: BrowserLogger,
  minTurnIndex?: number,
  expectedConversationId?: string,
  accountId?: string,
): Promise<{
  text: string;
  html?: string;
  meta: { turnId?: string | null; messageId?: string | null };
}> {
  const captured = await waitForAssistantResponseUnvalidated(
    Runtime,
    timeoutMs,
    logger,
    minTurnIndex,
    expectedConversationId,
  );
  await assertCapturedAssistantResponseBound(Runtime, captured.meta ?? {}, logger);
  await assertCapturedAnswerNotAccessArtifact(
    Runtime,
    { text: captured.text, html: captured.html },
    logger,
    { quarantine: { accountId } },
  );
  return captured;
}

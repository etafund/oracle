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

/**
 * Capture facade: waits for the assistant response, then structurally
 * validates that the captured message is bound to THIS run's own submitted
 * user message (same conversation from submit to capture, message follows the
 * run's own user turn). Validation is a no-op when no submission binding was
 * registered for this runtime (non-ChatGPT providers, reattach inspection,
 * unit tests); when a binding exists, violations fail loudly instead of
 * returning a response that may belong to another run.
 */
export async function waitForAssistantResponse(
  Runtime: ChromeClient["Runtime"],
  timeoutMs: number,
  logger: BrowserLogger,
  minTurnIndex?: number,
  expectedConversationId?: string,
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
  return captured;
}

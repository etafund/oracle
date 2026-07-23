import { mkdtemp, rm, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { createHash, randomUUID } from "node:crypto";
import { resolveBrowserConfig } from "./config.js";
import { copyChromeProfile } from "./profileCopy.js";
import type {
  BrowserRunOptions,
  BrowserRunResult,
  BrowserCloseOwnedRunTargetPolicy,
  BrowserLogger,
  ChromeClient,
  BrowserAttachment,
  ResolvedBrowserConfig,
  BrowserArchiveResult,
  BrowserDownloadableFile,
  SavedBrowserFile,
  BrowserSubmissionFallback,
  BrowserSubmissionProvenance,
  BrowserPromptFallbackReason,
} from "./types.js";
import {
  launchChrome,
  registerTerminationHooks,
  positionChromeWindowOffscreen,
  connectToRemoteChrome,
  connectWithNewTab,
  resolveIsolatedTabConnectOptions,
  closeTab,
  createChromePageTarget,
  ensureChromePageTargetAfterClose,
  closeBlankChromeTabs,
  OrphanedChromeTargetError,
} from "./chromeLifecycle.js";
import { clearStaleChatGptConversationCookies, syncCookies } from "./cookies.js";
import {
  navigateToChatGPT,
  navigateToPromptReadyWithFallback,
  ensureNotBlocked,
  ensureLoggedIn,
  ensurePromptReady,
  ensureChatMode,
  waitForResumedConversationHydration,
  installJavaScriptDialogAutoDismissal,
  ensureModelSelection,
  isRefreshableModelSelectionError,
  clearPromptComposer,
  bindActiveComposerAttachments,
  waitForAssistantResponse,
  captureAssistantMarkdown,
  clearComposerAttachments,
  uploadAttachmentFile,
  waitForAttachmentCompletion,
  waitForUserTurnAttachments,
  readAssistantSnapshot,
} from "./pageActions.js";
import { INPUT_SELECTORS } from "./constants.js";
import { uploadAttachmentViaDataTransfer } from "./actions/remoteFileTransfer.js";
import {
  ensureThinkingTime,
  isGpt56SolModelLabel,
  type BrowserModeSelectionEvidence,
} from "./actions/thinkingTime.js";
import {
  emitBrowserRunProgressMarker,
  shouldEmitBrowserRunProgress,
  startThinkingStatusMonitor,
  type BrowserRunProgressMarker,
} from "./actions/thinkingStatus.js";
import {
  activateDeepResearch,
  captureDeepResearchTargetKeys,
  waitForDeepResearchCompletion,
  waitForResearchPlanAutoConfirm,
} from "./actions/deepResearch.js";
import { estimateTokenCount, withRetries, delay } from "./utils.js";
import { formatElapsed } from "../oracle/format.js";
import type { BrowserModelSelectionEvidence } from "../sessionStore.js";
import { CHATGPT_URL, DEFAULT_MODEL_STRATEGY } from "./constants.js";
import type { LaunchedChrome } from "chrome-launcher";
import { BrowserAutomationError } from "../oracle/errors.js";
import {
  assertCapturedAnswerNotAccessArtifact,
  assertPreResultAccessState,
  assertPreRunAccessState,
} from "./actions/challengeDetection.js";
import { assertNotQuarantined } from "./quarantineLatch.js";
import { alignPromptEchoPair, buildPromptEchoMatcher } from "./reattachHelpers.js";
import { buildConversationTurnCountExpression } from "./conversationTurns.js";
import type { ProfileRunLock } from "./profileState.js";
import {
  cleanupStaleProfileState,
  acquireProfileRunLock,
  findRunningChromeDebugTargetForProfile,
  readChromePid,
  readDevToolsPort,
  resolveChromeDebugTargetOwner,
  shouldCleanupManualLoginProfileState,
  terminateRecordedChromeForProfile,
  verifyChromeDebugTargetOwner,
  verifyDevToolsReachable,
  writeChromePid,
  writeDevToolsActivePort,
} from "./profileState.js";
import {
  connectionLostUserMessage,
  isRecoverableChromeDisconnect,
  probeChromeTargetLiveness,
} from "./cdpLiveness.js";
import {
  acquireBrowserTabLease,
  hasOtherActiveBrowserTabLeases,
  OrphanedBrowserTabLeaseError,
  type BrowserTabLease,
} from "./tabLeaseRegistry.js";
import {
  appendArtifacts,
  saveBrowserTranscriptArtifact,
  saveDeepResearchReportArtifact,
} from "./artifacts.js";
import { collectGeneratedImageArtifacts } from "./chatgptImages.js";
import { collectChatGptFileArtifacts } from "./chatgptFiles.js";
import { runProviderSubmissionFlow } from "./providerDomFlow.js";
import {
  buildGpt56SolProFinalDispatchGuard,
  chatgptDomProvider,
  proveGpt56SolProPublicRoute,
} from "./providers/index.js";
import { resolveAttachRunningConnection } from "./attachRunning.js";
import { connectToExistingChatGptTab } from "./liveTabs.js";
import { captureBrowserDiagnostics } from "./domDebug.js";
import {
  archiveChatGptConversation,
  resolveBrowserArchiveDecision,
} from "./actions/archiveConversation.js";
import {
  assertManualLoginProfileReadyForRun,
  defaultManualLoginProfileDir,
  formatManualLoginSetupCommand,
  isManualLoginProfileInitialized,
  resolveManualLoginWaitMs,
} from "./manualLoginProfile.js";
import { describeBrowserControlPlan, formatBrowserControlPlan } from "./controlPlan.js";
import { buildPromptRecoveryOwnershipPreview } from "./promptDomMatch.js";
import {
  createConversationUrlMonitor,
  type ConversationUrlMonitor,
} from "./conversationUrlMonitor.js";
import {
  decideConversationUrlAdoption,
  extractConversationIdFromUrl,
  isConversationUrl,
  normalizeChatGptConversationId,
} from "./conversationIdentity.js";
import {
  assertCapturedAssistantResponseBound,
  type CapturedAssistantMeta,
  type SubmittedUserMessageBinding,
} from "./actions/captureBinding.js";
import {
  AUTO_PROMPT_FALLBACK_EQUIVALENCE_ALGORITHM,
  AUTO_PROMPT_FALLBACK_MAX_SOURCE_BYTES,
  isAutoPromptFallbackWithinModelBudget,
  verifyAutoInlineToUploadFallback,
  verifyAutoUploadToInlineFallback,
} from "./prompt.js";
import { readBoundedRegularFile } from "./actions/attachmentDataTransfer.js";

export type { BrowserAutomationConfig, BrowserRunOptions, BrowserRunResult } from "./types.js";
export { CHATGPT_URL, DEFAULT_MODEL_STRATEGY, DEFAULT_MODEL_TARGET } from "./constants.js";
export { parseDuration, delay, normalizeChatgptUrl, isTemporaryChatUrl } from "./utils.js";
export {
  formatThinkingLog,
  formatThinkingWaitingLog,
  buildThinkingStatusExpressionForTest,
  readThinkingStatusForTest,
  sanitizeThinkingText,
  startThinkingStatusMonitorForTest,
} from "./actions/thinkingStatus.js";

function redactBrowserConfigForDebugLog(config: Record<string, unknown>): Record<string, unknown> {
  const redacted = { ...config };
  if (Array.isArray(config.inlineCookies)) {
    redacted.inlineCookies = `[redacted:${config.inlineCookies.length} cookies]`;
    redacted.inlineCookieCount = config.inlineCookies.length;
  }
  return redacted;
}

export function redactBrowserConfigForDebugLogForTest(
  config: Record<string, unknown>,
): Record<string, unknown> {
  return redactBrowserConfigForDebugLog(config);
}

function isCloudflareChallengeError(error: unknown): error is BrowserAutomationError {
  if (!(error instanceof BrowserAutomationError)) return false;
  const details = error.details as { stage?: string; state?: string } | undefined;
  return (
    details?.stage === "cloudflare-challenge" ||
    details?.stage === "account-quarantine" ||
    (details?.stage === "challenge-gate" &&
      (details.state === "verification_interstitial" || details.state === "account_security_block"))
  );
}

function isReattachableCaptureError(error: unknown): error is BrowserAutomationError {
  if (!(error instanceof BrowserAutomationError)) return false;
  const stage = (error.details as { stage?: string } | undefined)?.stage;
  return stage === "assistant-timeout" || stage === "assistant-recheck";
}

type PreservedBrowserErrorKind = "cloudflare-challenge" | "reattachable-capture";

/**
 * Typed error for a caller-gone abort. Pre-submit aborts are retryable
 * transport interruptions; once the prompt has been submitted the run is
 * NOT auto-retryable (the prompt may already be generating against the
 * account) and no ChatGPT-side cancellation is attempted — the run is
 * abandoned and the tab cleaned up by the normal cleanup path.
 */
function buildClientAbortError(promptSubmitted: boolean): BrowserAutomationError {
  return new BrowserAutomationError(
    promptSubmitted
      ? "Caller disconnected after submit; abandoning the run without ChatGPT-side cancellation."
      : "Caller disconnected before submit; aborting the run.",
    {
      stage: "client-abort",
      oracleErrorClass: promptSubmitted
        ? "transport_interrupted_after_submit"
        : "transport_interrupted_before_submit",
      retryable: !promptSubmitted,
    },
  );
}

function classifyPreservedBrowserError(
  error: unknown,
  headless: boolean,
): PreservedBrowserErrorKind | null {
  if (headless) return null;
  if (isCloudflareChallengeError(error)) return "cloudflare-challenge";
  if (isReattachableCaptureError(error)) return "reattachable-capture";
  return null;
}

function shouldPreserveBrowserOnError(error: unknown, headless: boolean): boolean {
  return classifyPreservedBrowserError(error, headless) !== null;
}

function shouldKeepLocalBrowserOpen(options: {
  effectiveKeepBrowser: boolean;
  preserveBrowserOnError: boolean;
  usingCopiedProfile: boolean;
}): boolean {
  if (options.usingCopiedProfile) return false;
  return options.effectiveKeepBrowser || options.preserveBrowserOnError;
}

export function shouldPreserveBrowserOnErrorForTest(error: unknown, headless: boolean): boolean {
  return shouldPreserveBrowserOnError(error, headless);
}

export function classifyPreservedBrowserErrorForTest(
  error: unknown,
  headless: boolean,
): PreservedBrowserErrorKind | null {
  return classifyPreservedBrowserError(error, headless);
}

// NOTE: Previously, shouldSkipThinkingTimeSelection() would skip the thinking
// time UI step when desiredModel was gpt-5.5-pro and thinkingTime was "extended",
// assuming that selecting "Pro Extended" in the old UI already implied Extended
// effort. This is wrong for lower-tier plans ($100/mo Pro) where selecting "Pro"
// defaults to Standard effort. ensureThinkingTime() already handles the
// "already-selected" case as a no-op, so always attempting it is safe.

type ChatGptUiWarningType = "rate_limit" | "temporary_unavailable" | "auth_or_challenge";

type ChatGptUiWarning = {
  type: ChatGptUiWarningType;
  message: string;
  source?: string | null;
  role?: string | null;
  ariaLive?: string | null;
  selector?: string | null;
};

const MAX_CHATGPT_UI_WARNING_CHARS = 300;
const MAX_CHATGPT_UI_WARNINGS = 3;

function classifyChatGptUiWarningText(text: string): ChatGptUiWarningType | null {
  const normalized = text.toLowerCase();
  if (
    /\btoo many requests\b/.test(normalized) ||
    /\bsending too many requests\b/.test(normalized) ||
    /\btoo quickly\b/.test(normalized) ||
    /\btemporarily limited access\b/.test(normalized) ||
    /\bplease wait a few minutes\b/.test(normalized) ||
    /\byou(?:'re| are) being rate limited\b/.test(normalized) ||
    /\brate limited\b/.test(normalized) ||
    /\brate limit (?:exceeded|reached|hit)\b/.test(normalized) ||
    /\bslow down\b/.test(normalized)
  ) {
    return "rate_limit";
  }
  if (
    /\btemporarily unavailable\b/.test(normalized) ||
    /\bsomething went wrong\b/.test(normalized) ||
    /\bfailed to generate\b/.test(normalized) ||
    /\btry again later\b/.test(normalized)
  ) {
    return "temporary_unavailable";
  }
  if (
    /\bverify you are human\b/.test(normalized) ||
    /\bunusual activity\b/.test(normalized) ||
    /\bcloudflare\b/.test(normalized) ||
    /\bchallenge\b/.test(normalized) ||
    /\blogin required\b/.test(normalized) ||
    /\bsign in\b/.test(normalized)
  ) {
    return "auth_or_challenge";
  }
  return null;
}

function sanitizeChatGptUiWarningText(text: string): string {
  return text
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[redacted-email]")
    .replace(
      /\b((?:access|auth|session)[-_ ]?token|token)\s*[:=]\s*["']?[^\s"',;]+/gi,
      "$1=[redacted]",
    )
    .replace(/\b(?:sk-(?:ant-|or-)?|xai-)[A-Za-z0-9_-]{8,}\b/g, "[redacted-token]");
}

function normalizeUiWarningCandidate(value: unknown): {
  text: string;
  source?: string | null;
  role?: string | null;
  ariaLive?: string | null;
  selector?: string | null;
} | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  const text =
    typeof candidate.text === "string"
      ? sanitizeChatGptUiWarningText(candidate.text.replace(/\s+/g, " ").trim())
      : "";
  if (!text) return null;
  return {
    text: text.slice(0, MAX_CHATGPT_UI_WARNING_CHARS),
    source: typeof candidate.source === "string" ? candidate.source : null,
    role: typeof candidate.role === "string" ? candidate.role : null,
    ariaLive: typeof candidate.ariaLive === "string" ? candidate.ariaLive : null,
    selector: typeof candidate.selector === "string" ? candidate.selector : null,
  };
}

async function collectChatGptUiWarnings(
  Runtime: ChromeClient["Runtime"],
): Promise<ChatGptUiWarning[]> {
  try {
    const { result } = await Runtime.evaluate({
      awaitPromise: true,
      returnByValue: true,
      expression: `(() => {
        const warningPattern = /too many requests|sending too many requests|too quickly|temporarily limited access|please wait a few minutes|you(?:'re| are) being rate limited|rate limited|rate limit (?:exceeded|reached|hit)|slow down|try again later|temporarily unavailable|something went wrong|failed to generate|verify you are human|unusual activity|cloudflare|challenge|login required|sign in/i;
        const selectors = [
          '[role="alert"]',
          '[role="status"]',
          '[role="dialog"]',
          '[aria-live]',
          '[data-testid*="toast" i]',
          '[data-testid*="banner" i]',
          '[data-testid*="error" i]',
          '[class*="toast" i]',
          '[class*="banner" i]'
        ];
        const isVisible = (element) => {
          if (!(element instanceof HTMLElement)) return false;
          let current = element;
          while (current) {
            const currentStyle = window.getComputedStyle(current);
            if (
              !currentStyle ||
              currentStyle.display === 'none' ||
              currentStyle.visibility === 'hidden' ||
              currentStyle.visibility === 'collapse' ||
              Number.parseFloat(currentStyle.opacity || '1') === 0
            ) {
              return false;
            }
            current = current.parentElement;
          }
          const rect = element.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        };
        const describe = (element, source, selector = null) => ({
          text: (element.innerText || element.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 1000),
          source,
          selector,
          role: element.getAttribute('role'),
          ariaLive: element.getAttribute('aria-live')
        });
        const out = [];
        const seen = new Set();
        const warningContainers = [];
        const overlapsWarningContainer = (element) => warningContainers.some((container) => (
          container !== element && (container.contains(element) || element.contains(container))
        ));
        const add = (element, entry) => {
          if (!entry.text || !warningPattern.test(entry.text)) return;
          const key = entry.text + '|' + (entry.role || '') + '|' + (entry.ariaLive || '');
          if (seen.has(key)) return;
          seen.add(key);
          warningContainers.push(element);
          out.push(entry);
        };
        for (const selector of selectors) {
          if (out.length >= 5) break;
          let elements = [];
          try {
            elements = Array.from(document.querySelectorAll(selector));
          } catch {
            elements = [];
          }
          for (const element of elements) {
            if (out.length >= 5) break;
            if (overlapsWarningContainer(element)) continue;
            if (isVisible(element)) add(element, describe(element, 'selector', selector));
          }
        }
        return out.slice(0, 5);
      })()`,
    });
    const rawWarnings = Array.isArray(result?.value) ? result.value : [];
    const warnings: ChatGptUiWarning[] = [];
    const seen = new Set<string>();
    for (const raw of rawWarnings) {
      const candidate = normalizeUiWarningCandidate(raw);
      if (!candidate) continue;
      const type = classifyChatGptUiWarningText(candidate.text);
      if (!type) continue;
      const key = `${type}:${candidate.text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      warnings.push({
        type,
        message: candidate.text,
        source: candidate.source,
        role: candidate.role,
        ariaLive: candidate.ariaLive,
        selector: candidate.selector,
      });
      if (warnings.length >= MAX_CHATGPT_UI_WARNINGS) break;
    }
    return warnings;
  } catch {
    return [];
  }
}

function formatChatGptUiWarningType(type: ChatGptUiWarningType): string {
  switch (type) {
    case "rate_limit":
      return "rate-limit";
    case "temporary_unavailable":
      return "temporary-unavailable";
    case "auth_or_challenge":
      return "authentication/challenge";
  }
}

async function createChatGptUiWarningError(params: {
  Runtime: ChromeClient["Runtime"];
  logger: BrowserLogger;
  runtime: unknown;
  stage: string;
  waitTarget: string;
  diagnostics?: unknown;
  cause?: unknown;
}): Promise<BrowserAutomationError | null> {
  const [uiWarning] = await collectChatGptUiWarnings(params.Runtime);
  if (!uiWarning) return null;

  params.logger(`[browser] ChatGPT UI warning detected (${uiWarning.type}): ${uiWarning.message}`);
  return new BrowserAutomationError(
    `ChatGPT displayed a ${formatChatGptUiWarningType(uiWarning.type)} warning while waiting for ${params.waitTarget}: ${uiWarning.message}`,
    {
      stage: params.stage,
      code: "chatgpt-ui-warning",
      uiWarning,
      runtime: params.runtime,
      diagnostics: params.diagnostics,
    },
    params.cause,
  );
}

async function throwChatGptUiWarningIfPresent(params: {
  Runtime: ChromeClient["Runtime"];
  logger: BrowserLogger;
  runtime: unknown;
  stage: string;
  waitTarget: string;
  diagnostics?: unknown;
}): Promise<void> {
  const error = await createChatGptUiWarningError(params);
  if (error) throw error;
}

async function createAssistantTimeoutError(params: {
  Runtime: ChromeClient["Runtime"];
  logger: BrowserLogger;
  runtime: unknown;
  diagnostics?: unknown;
  cause: unknown;
}): Promise<BrowserAutomationError> {
  const warningError = await createChatGptUiWarningError({
    Runtime: params.Runtime,
    logger: params.logger,
    runtime: params.runtime,
    stage: "assistant-timeout",
    waitTarget: "the assistant",
    diagnostics: params.diagnostics,
    cause: params.cause,
  });
  if (!warningError) {
    return new BrowserAutomationError(
      "Assistant response timed out before completion; reattach later to capture the answer.",
      { stage: "assistant-timeout", runtime: params.runtime, diagnostics: params.diagnostics },
      params.cause,
    );
  }
  return warningError;
}

function listIgnoredRemoteChromeFlags(config: {
  attachRunning?: ResolvedBrowserConfig["attachRunning"];
  headless?: ResolvedBrowserConfig["headless"];
  hideWindow?: ResolvedBrowserConfig["hideWindow"];
  keepBrowser?: ResolvedBrowserConfig["keepBrowser"];
  chromePath?: ResolvedBrowserConfig["chromePath"];
}): string[] {
  return [
    config.headless ? "--browser-headless" : null,
    config.hideWindow ? "--browser-hide-window" : null,
    config.keepBrowser ? "--browser-keep-browser" : null,
    !config.attachRunning && config.chromePath ? "--browser-chrome-path" : null,
  ].filter((value): value is string => Boolean(value));
}

function hasBrowserErrorCode(error: unknown, code: string): boolean {
  return (
    error instanceof BrowserAutomationError &&
    (error.details as { code?: string } | undefined)?.code === code
  );
}

function isRetryablePreDispatchAttachmentUploadTimeout(error: unknown): boolean {
  if (!(error instanceof BrowserAutomationError)) return false;
  const details = error.details as
    | { code?: unknown; stage?: unknown; retryable?: unknown }
    | undefined;
  return (
    details?.code === "attachment-upload-timeout" &&
    details.stage === "attachment-upload" &&
    details.retryable === true
  );
}

// Chrome throttles rendering/input for tabs it considers backgrounded or
// occluded, which makes ChatGPT drop synthetic Send clicks. This affects any
// attached tab that isn't the OS-focused foreground window, not just remote
// targets: a shared/manual-login Chrome window running other tabs (c>=2), or
// a window hidden via --browser-hide-window, exhibit the same condition
// locally. Emulating focus makes the page report `document.hasFocus() ===
// true` (and `:focus` state) regardless of how we attached to it.
//
// Scope caveat: focus emulation does NOT cover the Page Visibility API. A tab
// that is not its window's active tab still reports
// `document.visibilityState === "hidden"`, so page code gated on
// `document.hidden`/`visibilitychange` is unaffected by this emulation. That
// is why each lane's isolated tab is opened in its own OS window
// (Target.createTarget({newWindow: true}) — see createTargetInNewWindow in
// chromeLifecycle.ts); when that path is unavailable and we fall back to a
// same-window tab, hidden-visibility in background lanes remains a known
// residual limitation.
async function enableFocusEmulation(
  client: ChromeClient,
  logger: BrowserLogger,
  label: string,
): Promise<void> {
  try {
    await client.Emulation.setFocusEmulationEnabled({ enabled: true });
    logger(`[browser] Focus emulation enabled for ${label}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger(`[browser] Focus emulation unavailable: ${message}`);
  }
}

async function saveOptionalArtifact<T>(
  operation: () => Promise<T | null>,
  logger: BrowserLogger,
): Promise<T | null> {
  try {
    return await operation();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger(`[browser] Failed to save session artifact: ${message}`);
    return null;
  }
}

async function preserveChallengeOverPageFailure<T>(
  operation: Promise<T>,
  runtime: ChromeClient["Runtime"],
  logger: BrowserLogger,
  options: { accountId?: string; sessionId?: string },
): Promise<T> {
  try {
    return await operation;
  } catch (error) {
    throw await preferChallengeOverPageFailure(error, runtime, logger, options);
  }
}

async function preferChallengeOverPageFailure(
  error: unknown,
  runtime: ChromeClient["Runtime"],
  logger: BrowserLogger,
  options: { accountId?: string; sessionId?: string },
): Promise<unknown> {
  // Canonical challenge errors have already passed through the account gate,
  // which publishes the latch before throwing. Re-probing them would hit that
  // new latch first and replace the exact challenge error with a generic
  // account-quarantine refusal, losing the preservation classification and
  // causing the manual-clearance target to be closed under always-close
  // policy. Only generic page failures need upgrading.
  if (isCloudflareChallengeError(error)) return error;
  try {
    // A navigation/capture wait can fail because a challenge replaced the
    // document. Let the read-only typed account gate outrank the generic
    // timeout; a healthy/indeterminate probe preserves the exact original.
    await assertPreResultAccessState(runtime, logger, {
      quarantine: { accountId: options.accountId },
      sessionId: options.sessionId,
    });
  } catch (accessError) {
    return accessError;
  }
  return error;
}

type AssistantAnswer = {
  text: string;
  html?: string;
  meta: { turnId?: string | null; messageId?: string | null };
};

async function applyBoundAssistantSnapshotReplacement<T>(
  runtime: ChromeClient["Runtime"],
  meta: CapturedAssistantMeta,
  logger: BrowserLogger,
  replace: () => T,
): Promise<T> {
  // Every DOM re-read that can overwrite an already-captured answer must
  // independently prove ownership. The assertion intentionally sits in the
  // same helper as the mutation so new fallback paths cannot accidentally
  // validate one snapshot and apply another.
  await assertCapturedAssistantResponseBound(runtime, meta, logger);
  return replace();
}

async function waitForAssistantOrGeneratedImageResponse(params: {
  Runtime: ChromeClient["Runtime"];
  waitForText: () => Promise<AssistantAnswer>;
  timeoutMs: number;
  minTurnIndex?: number;
  expectedConversationId?: string;
  imageOutputRequested: boolean;
  logger: BrowserLogger;
  accountId?: string;
  sessionId?: string;
}): Promise<AssistantAnswer> {
  if (!params.imageOutputRequested) {
    return params.waitForText();
  }

  await assertNotQuarantined({ accountId: params.accountId });
  params.logger("[browser] Waiting for ChatGPT generated image response.");
  let response: AssistantAnswer | null;
  try {
    response = await pollGeneratedImageOrTextAssistantResponse(
      params.Runtime,
      params.timeoutMs,
      params.minTurnIndex,
      params.expectedConversationId,
    );
  } catch (error) {
    await assertPreResultAccessState(params.Runtime, params.logger, {
      quarantine: { accountId: params.accountId },
      sessionId: params.sessionId,
    });
    throw error;
  }
  if (response) {
    // Image-request runs use the snapshot poller directly instead of the
    // pageActions text-capture facade. Apply the same post-capture structural
    // binding here so an image (or text fallback) from another shared tab can
    // never bypass the submitted-message ownership proof.
    await preserveChallengeOverPageFailure(
      assertCapturedAssistantResponseBound(params.Runtime, response.meta, params.logger),
      params.Runtime,
      params.logger,
      { accountId: params.accountId, sessionId: params.sessionId },
    );
    await assertCapturedAnswerNotAccessArtifact(
      params.Runtime,
      { text: response.text, html: response.html },
      params.logger,
      {
        quarantine: { accountId: params.accountId },
        sessionId: params.sessionId,
      },
    );
    if (response.html?.includes("/backend-api/estuary/content?id=file_")) {
      params.logger("[browser] Captured generated image response before text appeared.");
    }
    return response;
  }

  await assertPreResultAccessState(params.Runtime, params.logger, {
    quarantine: { accountId: params.accountId },
    sessionId: params.sessionId,
  });
  throw new Error("assistant response timeout while waiting for generated image or text");
}

async function attemptAssistantRecheckOrRethrow(
  operation: () => Promise<AssistantAnswer | null>,
): Promise<AssistantAnswer | null> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof BrowserAutomationError) {
      throw error;
    }
    return null;
  }
}

async function pollGeneratedImageOrTextAssistantResponse(
  Runtime: ChromeClient["Runtime"],
  timeoutMs: number,
  minTurnIndex?: number,
  expectedConversationId?: string,
): Promise<AssistantAnswer | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let snapshot = await readAssistantSnapshot(Runtime, minTurnIndex, expectedConversationId).catch(
      () => null,
    );
    if (!snapshot && typeof minTurnIndex === "number" && Number.isFinite(minTurnIndex)) {
      const relaxedSnapshot = await readAssistantSnapshot(
        Runtime,
        undefined,
        expectedConversationId,
      ).catch(() => null);
      const relaxedHtml = typeof relaxedSnapshot?.html === "string" ? relaxedSnapshot.html : "";
      if (relaxedHtml.includes("/backend-api/estuary/content?id=file_")) {
        snapshot = relaxedSnapshot;
      }
    }
    const text = typeof snapshot?.text === "string" ? snapshot.text.trim() : "";
    const html = typeof snapshot?.html === "string" ? snapshot.html : "";
    const hasGeneratedImage = html.includes("/backend-api/estuary/content?id=file_");
    if (text && (hasGeneratedImage || !isImageOnlyUiChromeText(text))) {
      return {
        text,
        html,
        meta: {
          turnId: snapshot?.turnId ?? undefined,
          messageId: snapshot?.messageId ?? undefined,
        },
      };
    }
    await delay(750);
  }
  return null;
}

export function isImageOnlyUiChromeText(text: string): boolean {
  const normalized = text.toLowerCase().replace(/\s+/g, " ").trim();
  return (
    normalized.length === 0 ||
    normalized === "edit" ||
    normalized === "stopped thinking" ||
    normalized === "stopped thinking edit" ||
    /^(?:reasoning\s+|pro thinking\s+)?thought for \d+(?:\.\d+)?\s*(?:s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours)\s+edit$/.test(
      normalized,
    )
  );
}

export interface BrowserConversationTurn {
  label: string;
  prompt?: string;
  answerText: string;
  answerMarkdown: string;
}

function normalizeBrowserFollowUpPrompts(values: string[] | undefined): string[] {
  return (values ?? []).map((entry) => entry.trim()).filter(Boolean);
}

export function formatBrowserTurnTranscript(turns: BrowserConversationTurn[]): {
  answerText: string;
  answerMarkdown: string;
} {
  if (turns.length <= 1) {
    const turn = turns[0];
    return {
      answerText: turn?.answerText ?? "",
      answerMarkdown: turn?.answerMarkdown ?? turn?.answerText ?? "",
    };
  }

  const answerMarkdown = turns
    .map((turn, index) => {
      const label = turn.label.trim() || `Turn ${index + 1}`;
      const prompt = turn.prompt?.trim();
      const promptBlock = prompt ? `\n\n### Prompt\n\n${prompt}` : "";
      const answer = (turn.answerMarkdown || turn.answerText).trim() || "_No text captured._";
      return `## ${label}${promptBlock}\n\n### Answer\n\n${answer}`;
    })
    .join("\n\n")
    .trim();

  return {
    answerText: answerMarkdown,
    answerMarkdown,
  };
}

async function maybeArchiveCompletedConversation({
  Runtime,
  logger,
  config,
  conversationUrl,
  answerText,
  followUpCount,
  requiredArtifactsSaved,
}: {
  Runtime: ChromeClient["Runtime"];
  logger: BrowserLogger;
  config: ResolvedBrowserConfig;
  conversationUrl?: string | null;
  answerText?: string | null;
  followUpCount: number;
  requiredArtifactsSaved: boolean;
}): Promise<BrowserArchiveResult> {
  const decision = resolveBrowserArchiveDecision({
    mode: config.archiveConversations,
    chatgptUrl: config.chatgptUrl ?? config.url,
    conversationUrl,
    researchMode: config.researchMode,
    followUpCount,
  });
  if (!decision.shouldArchive) {
    logger(`[browser] ChatGPT archive skipped (${decision.reason}).`);
    return {
      mode: decision.mode,
      attempted: false,
      archived: false,
      reason: decision.reason,
      conversationUrl: conversationUrl ?? undefined,
    };
  }
  if (!requiredArtifactsSaved) {
    logger("[browser] ChatGPT archive skipped (artifact-save-failed).");
    return {
      mode: decision.mode,
      attempted: false,
      archived: false,
      reason: "artifact-save-failed",
      conversationUrl: conversationUrl ?? undefined,
    };
  }
  if (isSuspiciouslyShortArchiveAnswer(answerText)) {
    logger("[browser] ChatGPT archive skipped (suspicious-short-answer).");
    return {
      mode: decision.mode,
      attempted: false,
      archived: false,
      reason: "suspicious-short-answer",
      conversationUrl: conversationUrl ?? undefined,
    };
  }
  return archiveChatGptConversation(Runtime, logger, {
    mode: decision.mode,
    conversationUrl,
  }).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    logger(`[browser] ChatGPT archive failed (${message}).`);
    return {
      mode: decision.mode,
      attempted: true,
      archived: false,
      reason: "archive-failed",
      conversationUrl: conversationUrl ?? undefined,
      error: message,
    };
  });
}

function isSuspiciouslyShortArchiveAnswer(answerText: string | null | undefined): boolean {
  const normalized = String(answerText ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return normalized.length > 0 && normalized.length < 16;
}

export function maybeArchiveCompletedConversationForTest(
  args: Parameters<typeof maybeArchiveCompletedConversation>[0],
): Promise<BrowserArchiveResult> {
  return maybeArchiveCompletedConversation(args);
}

type BrowserSubmissionAttemptResult = {
  baselineTurns: number | null;
  baselineAssistantText: string | null;
  deepResearchTargetKeys?: string[];
  deepResearchTargetBaselineCaptured?: boolean;
};

type BrowserSubmissionResult = BrowserSubmissionAttemptResult & {
  submittedPrompt: string;
  submissionProvenance: BrowserSubmissionProvenance;
};

async function captureDeepResearchTargetBaseline(
  client: ChromeClient,
  logger: BrowserLogger,
): Promise<{ targetKeys: string[]; captured: boolean }> {
  try {
    return { targetKeys: await captureDeepResearchTargetKeys(client), captured: true };
  } catch {
    logger(
      "[browser] Deep Research target baseline unavailable; retaining conversation-turn owner scoping.",
    );
    return { targetKeys: [], captured: false };
  }
}

type BrowserSubmissionAttemptOptions = {
  requireExactPromptRoundTrip?: boolean;
  submissionProvenance: BrowserSubmissionProvenance;
};

type VerifyUploadToInlineFallback = (input: {
  primaryPrompt: string;
  fallback: BrowserSubmissionFallback;
  primaryAttachments: BrowserAttachment[];
}) => Promise<boolean>;

type VerifyInlineToUploadFallback = (input: {
  primaryPrompt: string;
  fallback: BrowserSubmissionFallback;
}) => Promise<boolean>;

async function runWithRetainedAttachmentSnapshots<T>(
  operation: () => Promise<T>,
  cleanups: Array<() => Promise<void>>,
  logger: BrowserLogger,
): Promise<T> {
  try {
    return await operation();
  } finally {
    const settled = await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
    for (const result of settled) {
      if (result.status === "rejected") {
        logger(
          `Attachment snapshot cleanup failed: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
        );
      }
    }
  }
}

const verifyUploadToInlineFallbackFromFiles: VerifyUploadToInlineFallback = async ({
  primaryPrompt,
  fallback,
  primaryAttachments,
}) => {
  try {
    if (!attachmentsPreserveDeliveredNames(primaryAttachments)) return false;
    const attachments: Array<{ displayPath: string; content: Buffer }> = [];
    let totalBytes = 0;
    for (const attachment of primaryAttachments) {
      const remainingBytes = AUTO_PROMPT_FALLBACK_MAX_SOURCE_BYTES - totalBytes;
      if (remainingBytes < 0) return false;
      const verified = await readBoundedRegularFile(attachment.path, {
        maxBytes: Math.max(1, remainingBytes),
        declaredSizeBytes: attachment.sizeBytes,
        declaredSha256: attachment.integritySha256,
      });
      totalBytes += verified.sizeBytes;
      if (totalBytes > AUTO_PROMPT_FALLBACK_MAX_SOURCE_BYTES) return false;
      attachments.push({
        displayPath: attachment.displayPath,
        content: verified.bytes,
      });
    }
    return verifyAutoUploadToInlineFallback({
      primaryPrompt,
      fallbackPrompt: fallback.prompt,
      attachments,
    });
  } catch {
    return false;
  }
};

const verifyInlineToUploadFallbackFromFiles: VerifyInlineToUploadFallback = async ({
  primaryPrompt,
  fallback,
}) => {
  try {
    if (!attachmentsPreserveDeliveredNames(fallback.attachments)) return false;
    const attachments: Array<{ displayPath: string; content: Buffer }> = [];
    let totalBytes = 0;
    for (const attachment of fallback.attachments) {
      const remainingBytes = AUTO_PROMPT_FALLBACK_MAX_SOURCE_BYTES - totalBytes;
      if (remainingBytes < 0) return false;
      const verified = await readBoundedRegularFile(attachment.path, {
        maxBytes: Math.max(1, remainingBytes),
        declaredSizeBytes: attachment.sizeBytes,
        declaredSha256: attachment.integritySha256,
      });
      totalBytes += verified.sizeBytes;
      if (totalBytes > AUTO_PROMPT_FALLBACK_MAX_SOURCE_BYTES) return false;
      attachments.push({
        displayPath: attachment.displayPath,
        content: verified.bytes,
      });
    }
    return verifyAutoInlineToUploadFallback({
      primaryPrompt,
      fallbackPrompt: fallback.prompt,
      attachments,
    });
  } catch {
    return false;
  }
};

function attachmentsPreserveDeliveredNames(attachments: BrowserAttachment[]): boolean {
  return attachments.every(
    (attachment) =>
      attachment.generatedBundle !== true &&
      attachment.displayPath.length > 0 &&
      attachment.displayPath === path.basename(attachment.path),
  );
}

function normalizeFallbackModelIdentity(model: string): string {
  return model
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "");
}

function isFallbackPolicyAuthorized(
  fallback: BrowserSubmissionFallback,
  desiredModel: string | null | undefined,
): boolean {
  const authorization = fallback.authorization;
  if (
    authorization?.attachmentsPolicy !== "auto" ||
    authorization.bundleRequested !== false ||
    typeof authorization.model !== "string" ||
    authorization.model.trim().length === 0 ||
    !Number.isSafeInteger(authorization.maxInputTokens) ||
    authorization.maxInputTokens <= 0
  ) {
    return false;
  }
  if (!attachmentsPreserveDeliveredNames(fallback.attachments)) return false;

  if (isDesiredGpt56SolModel(desiredModel)) {
    return authorization.model === "gpt-5.6-sol";
  }
  if (typeof desiredModel === "string" && desiredModel.trim().length > 0) {
    return (
      normalizeFallbackModelIdentity(authorization.model) ===
      normalizeFallbackModelIdentity(desiredModel)
    );
  }
  return true;
}

function hashSubmittedPrompt(prompt: string): string {
  return createHash("sha256").update(prompt, "utf8").digest("hex");
}

function buildSubmissionProvenance(input: {
  primaryPrompt: string;
  primaryAttachments: BrowserAttachment[];
  submittedPrompt: string;
  submittedAttachments: BrowserAttachment[];
  fallbackUsed: boolean;
  fallbackReason: BrowserPromptFallbackReason | null;
}): BrowserSubmissionProvenance {
  return {
    primaryPromptSha256: hashSubmittedPrompt(input.primaryPrompt),
    submittedPromptSha256: hashSubmittedPrompt(input.submittedPrompt),
    primaryTransport: input.primaryAttachments.length > 0 ? "upload" : "inline",
    submittedTransport: input.submittedAttachments.length > 0 ? "upload" : "inline",
    fallbackUsed: input.fallbackUsed,
    fallbackReason: input.fallbackUsed ? input.fallbackReason : null,
    equivalenceAlgorithm: input.fallbackUsed ? AUTO_PROMPT_FALLBACK_EQUIVALENCE_ALGORITHM : null,
    equivalenceVerified: input.fallbackUsed ? true : null,
  };
}

async function runSubmissionWithRecovery({
  prompt,
  attachments,
  fallbackSubmission,
  submit,
  reloadPromptComposer,
  prepareFallbackSubmission,
  verifyUploadToInlineFallback = verifyUploadToInlineFallbackFromFiles,
  verifyInlineToUploadFallback = verifyInlineToUploadFallbackFromFiles,
  desiredModel,
  logger,
}: {
  prompt: string;
  attachments: BrowserAttachment[];
  fallbackSubmission?: BrowserSubmissionFallback;
  submit: (
    prompt: string,
    attachments: BrowserAttachment[],
    options?: BrowserSubmissionAttemptOptions,
  ) => Promise<BrowserSubmissionAttemptResult>;
  reloadPromptComposer: () => Promise<void>;
  prepareFallbackSubmission: () => Promise<void>;
  verifyUploadToInlineFallback?: VerifyUploadToInlineFallback;
  verifyInlineToUploadFallback?: VerifyInlineToUploadFallback;
  desiredModel?: string | null;
  logger: BrowserLogger;
}): Promise<BrowserSubmissionResult> {
  let currentPrompt = prompt;
  let currentAttachments = attachments;
  let retriedDeadComposer = false;
  let usedFallbackSubmission = false;
  let requireExactPromptRoundTrip = false;

  while (true) {
    try {
      const submissionProvenance = buildSubmissionProvenance({
        primaryPrompt: prompt,
        primaryAttachments: attachments,
        submittedPrompt: currentPrompt,
        submittedAttachments: currentAttachments,
        fallbackUsed: usedFallbackSubmission,
        fallbackReason: fallbackSubmission?.reason ?? null,
      });
      const result = await submit(currentPrompt, currentAttachments, {
        requireExactPromptRoundTrip,
        submissionProvenance,
      });
      return {
        ...result,
        submittedPrompt: currentPrompt,
        submissionProvenance,
      };
    } catch (error) {
      const isDeadComposer = hasBrowserErrorCode(error, "dead-composer");
      if (isDeadComposer && !retriedDeadComposer) {
        retriedDeadComposer = true;
        await reloadPromptComposer();
        continue;
      }

      const isPromptTooLarge = hasBrowserErrorCode(error, "prompt-too-large");
      const isAttachmentUploadTimeout = isRetryablePreDispatchAttachmentUploadTimeout(error);
      const fallbackIsUploadToInline =
        currentAttachments.length > 0 && fallbackSubmission?.attachments.length === 0;
      const fallbackIsInlineToUpload =
        currentAttachments.length === 0 && (fallbackSubmission?.attachments.length ?? 0) > 0;
      const fallbackReasonMatchesError =
        (isPromptTooLarge && fallbackSubmission?.reason === "auto-inline-too-large-to-upload") ||
        (isAttachmentUploadTimeout &&
          fallbackSubmission?.reason === "auto-upload-timeout-to-inline");
      const fallbackDirectionIsSafe =
        fallbackReasonMatchesError &&
        ((isPromptTooLarge && fallbackIsInlineToUpload) ||
          (isAttachmentUploadTimeout && fallbackIsUploadToInline));
      const fallbackPolicyIsAuthorized =
        fallbackSubmission !== undefined &&
        isFallbackPolicyAuthorized(fallbackSubmission, desiredModel) &&
        attachmentsPreserveDeliveredNames(currentAttachments);
      const fallbackBudgetIsAuthorized =
        fallbackSubmission !== undefined &&
        fallbackDirectionIsSafe &&
        fallbackPolicyIsAuthorized &&
        isAutoPromptFallbackWithinModelBudget(
          fallbackIsUploadToInline ? fallbackSubmission.prompt : prompt,
          fallbackSubmission.authorization!.model,
          fallbackSubmission.authorization!.maxInputTokens,
        );
      const fallbackContentIsVerified =
        fallbackSubmission !== undefined &&
        fallbackDirectionIsSafe &&
        fallbackPolicyIsAuthorized &&
        fallbackBudgetIsAuthorized &&
        (isAttachmentUploadTimeout
          ? await verifyUploadToInlineFallback({
              primaryPrompt: currentPrompt,
              fallback: fallbackSubmission,
              primaryAttachments: currentAttachments,
            })
          : await verifyInlineToUploadFallback({
              primaryPrompt: currentPrompt,
              fallback: fallbackSubmission,
            }));
      if (
        fallbackSubmission &&
        fallbackDirectionIsSafe &&
        fallbackPolicyIsAuthorized &&
        fallbackBudgetIsAuthorized &&
        fallbackContentIsVerified &&
        !usedFallbackSubmission
      ) {
        usedFallbackSubmission = true;
        // Both fallback directions are a second paid submission path. Reprove
        // the exact prompt and expected attachment state on one bound
        // composer through the trusted click event; never rely only on the
        // pre-retry file equivalence check.
        requireExactPromptRoundTrip = true;
        logger(
          isPromptTooLarge
            ? "[browser] Inline prompt too large; retrying with file uploads."
            : "[browser] Attachment upload stalled before dispatch; retrying eligible text files inline.",
        );
        await prepareFallbackSubmission();
        currentPrompt = fallbackSubmission.prompt;
        currentAttachments = fallbackSubmission.attachments;
        continue;
      }

      throw error;
    }
  }
}

export async function runSubmissionWithRecoveryForTest(args: {
  prompt: string;
  attachments: BrowserAttachment[];
  fallbackSubmission?: BrowserSubmissionFallback;
  submit: (
    prompt: string,
    attachments: BrowserAttachment[],
    options?: BrowserSubmissionAttemptOptions,
  ) => Promise<BrowserSubmissionAttemptResult>;
  reloadPromptComposer: () => Promise<void>;
  prepareFallbackSubmission: () => Promise<void>;
  verifyUploadToInlineFallback?: VerifyUploadToInlineFallback;
  verifyInlineToUploadFallback?: VerifyInlineToUploadFallback;
  desiredModel?: string | null;
  logger: BrowserLogger;
}): Promise<BrowserSubmissionResult> {
  return runSubmissionWithRecovery(args);
}

function resolveRemoteTabLeaseProfileDir(
  config: ReturnType<typeof resolveBrowserConfig>,
): string | null {
  if (!config.remoteChrome || !config.manualLogin || !config.manualLoginProfileDir) {
    return null;
  }
  return path.resolve(config.manualLoginProfileDir);
}

export function resolveRemoteTabLeaseProfileDirForTest(
  config: ReturnType<typeof resolveBrowserConfig>,
): string | null {
  return resolveRemoteTabLeaseProfileDir(config);
}

function isLocalChromeHost(host: string): boolean {
  const normalized = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  if (normalized === "localhost" || normalized === "::1") {
    return true;
  }
  return net.isIPv4(normalized) && normalized.startsWith("127.");
}

export function isLocalChromeHostForTest(host: string): boolean {
  return isLocalChromeHost(host);
}

async function closeRemoteConnectionAfterRun(options: {
  connectionClosedUnexpectedly: boolean;
  connection: { close: () => Promise<void> } | null;
  client: Pick<ChromeClient, "close"> | null;
  runStatus: "attempted" | "complete";
  logger?: BrowserLogger;
}): Promise<void> {
  if (options.connectionClosedUnexpectedly) {
    // The CDP socket is already gone, so there is no live session to close
    // here. This is NOT a silent skip of target cleanup: the owned-target
    // close in the run's finally block still attempts the tab close over a
    // fresh HTTP DevTools call and taints cleanup state if it fails.
    return;
  }
  try {
    if (!options.connection) {
      await options.client?.close();
      return;
    }
    if (options.runStatus === "complete") {
      await options.connection.close();
    } else {
      await options.client?.close();
    }
  } catch (error) {
    // A rejected close must not report settled-clean: the dedicated target may
    // still be open, so latch cleanup-taint for /ready instead of swallowing.
    const detail = error instanceof Error ? error.message : String(error);
    latchBrowserCleanupTaint(
      `remote connection close failed after ${options.runStatus} run: ${detail}`,
      options.logger,
    );
  }
}

function shouldCloseOwnedRunTargetAfterRun(options: {
  runStatus: "attempted" | "complete";
  ownsTarget: boolean;
  keepBrowser: boolean;
  closeOwnedTabOnComplete?: boolean;
  policy?: BrowserCloseOwnedRunTargetPolicy;
  orphanedTargetNeedsCleanup?: boolean;
  preserveOwnedTargetOnError?: boolean;
}): boolean {
  if (!options.ownsTarget) {
    // Borrowed (attached) tab: never close a target this run did not create.
    return false;
  }
  if (options.orphanedTargetNeedsCleanup) {
    // Target creation succeeded but attachment and the first rollback close
    // both failed. The target id is known, so every topology must retry its
    // physical close before releasing capacity, even when the ordinary
    // attempted-run policy would preserve tabs for reattach.
    return true;
  }
  if (options.runStatus === "attempted" && options.preserveOwnedTargetOnError) {
    // A headful verification wall must remain on the exact tab the operator
    // was told to solve; capture-timeout preservation likewise needs that tab
    // for reattach. The caller retains its lease while the target remains.
    return false;
  }
  if ((options.policy ?? "auto") === "always") {
    // serve/manual-login policy: the shared browser stays alive, but THIS
    // run's owned target closes on success AND failure so per-run tabs cannot
    // structurally accumulate unless an explicitly preserved error above
    // requires the exact target for human clearance or capture reattach.
    return true;
  }
  return (
    options.runStatus === "complete" &&
    (Boolean(options.closeOwnedTabOnComplete) || !options.keepBrowser)
  );
}

function shouldRetainBrowserTabLeaseAfterRun(options: {
  runStatus: "attempted" | "complete";
  ownsTarget: boolean;
  preserveOwnedTargetOnError?: boolean;
  orphanedTargetNeedsCleanup?: boolean;
}): boolean {
  // Preserving an owned tab without its lease would advertise capacity that
  // is still physically occupied. Borrowed tabs do not belong to this run,
  // while orphaned targets must take the mandatory close-before-release path.
  return (
    options.runStatus === "attempted" &&
    options.ownsTarget &&
    options.preserveOwnedTargetOnError === true &&
    !options.orphanedTargetNeedsCleanup
  );
}

function resolveCloseOwnedRunTargetPolicy(config: {
  closeOwnedRunTargetAfterRun?: BrowserCloseOwnedRunTargetPolicy | null;
  manualLogin?: boolean;
  keepBrowser?: boolean;
}): BrowserCloseOwnedRunTargetPolicy {
  if (
    config.closeOwnedRunTargetAfterRun === "always" ||
    config.closeOwnedRunTargetAfterRun === "auto"
  ) {
    return config.closeOwnedRunTargetAfterRun;
  }
  // Derived default: serve forces manual-login + keepBrowser on this topology,
  // which used to leave every run's tab open in the shared Chrome (structural
  // leak). Keep the BROWSER, close the TAB.
  return config.manualLogin && config.keepBrowser ? "always" : "auto";
}

/**
 * Bounded owned-target close (§14.2.0): a wedged close must not pin the
 * single-flight serve worker busy forever. On timeout the close keeps running
 * detached, we log loudly, and a cleanup-failure flag is latched for /ready to
 * surface as cleanup-taint. Full account-scoped taint per §14.13 is a
 * follow-up handoff concern.
 */
const OWNED_TARGET_CLOSE_TIMEOUT_MS = 10_000;

export interface BrowserCleanupTaint {
  at: string;
  reason: string;
}

interface BrowserCleanupTaintEntry {
  generation: number;
  taint: BrowserCleanupTaint;
}

let browserCleanupTaints: BrowserCleanupTaintEntry[] = [];
let browserCleanupTaintGeneration = 0;

/** Latched cleanup-failure flag; consumed by /ready as cleanup-taint (§14.13). */
export function getBrowserCleanupTaint(): BrowserCleanupTaint | null {
  return browserCleanupTaints.at(-1)?.taint ?? null;
}

export function clearBrowserCleanupTaint(): void {
  browserCleanupTaints = [];
  browserCleanupTaintGeneration += 1;
}

/** Remove only the taint generation owned by one asynchronous cleanup. */
export function clearBrowserCleanupTaintGeneration(generation: number, reason: string): boolean {
  const index = browserCleanupTaints.findIndex(
    (entry) => entry.generation === generation && entry.taint.reason === reason,
  );
  if (index < 0) return false;
  browserCleanupTaints.splice(index, 1);
  return true;
}

export function latchBrowserCleanupTaint(reason: string, logger?: BrowserLogger): number {
  browserCleanupTaintGeneration += 1;
  browserCleanupTaints.push({
    generation: browserCleanupTaintGeneration,
    taint: { at: new Date().toISOString(), reason },
  });
  logger?.(`[browser] CLEANUP-TAINT: ${reason}`);
  return browserCleanupTaintGeneration;
}

export async function releaseBrowserTabLeaseOrTaint(
  lease: BrowserTabLease,
  logger: BrowserLogger,
  context: string,
  releaseOptions?: Parameters<BrowserTabLease["release"]>[0],
): Promise<boolean> {
  let releaseTaintGeneration: number | null = null;
  let releaseTaintReason: string | null = null;
  let deferredReleaseRecovered = false;
  const clearOwnRecoveredTaint = (): void => {
    if (releaseTaintGeneration === null || releaseTaintReason === null) return;
    if (clearBrowserCleanupTaintGeneration(releaseTaintGeneration, releaseTaintReason)) {
      logger(
        `[browser] Cleared cleanup-taint after deferred release repaired tab lease ${lease.id}.`,
      );
    }
  };
  const callerOnDeferredRelease = releaseOptions?.onDeferredRelease;
  try {
    await lease.release({
      ...releaseOptions,
      onDeferredRelease: () => {
        deferredReleaseRecovered = true;
        clearOwnRecoveredTaint();
        callerOnDeferredRelease?.();
      },
    });
    return true;
  } catch (error) {
    releaseTaintReason = `${context} tab-lease release failed (${lease.id}): ${error instanceof Error ? error.message : String(error)}`;
    releaseTaintGeneration = latchBrowserCleanupTaint(releaseTaintReason, logger);
    if (deferredReleaseRecovered) clearOwnRecoveredTaint();
    return false;
  }
}

/**
 * Acquisition can fail after its lease record was durably committed. Roll
 * that exact lease handle back before propagating the acquisition failure so
 * a long-lived serve PID cannot keep an unreachable capacity claim alive.
 */
export async function rollbackOrphanedBrowserTabLeaseAcquisition(
  error: unknown,
  logger: BrowserLogger,
  context: string,
): Promise<boolean> {
  if (!(error instanceof OrphanedBrowserTabLeaseError)) return false;
  logger(
    `[browser] Rolling back durably committed tab lease ${error.lease.id.slice(0, 8)} after acquisition hand-off failed.`,
  );
  return releaseBrowserTabLeaseOrTaint(error.lease, logger, context);
}

type OwnedTargetCloseOutcome =
  | { kind: "closed" }
  | { kind: "failed"; detail: string }
  | { kind: "timeout" };

/**
 * Awaits an owned-target close, bounded by the deadline. Returns true only for
 * a clean close. A close that FAILS (rejects, or resolves `false` from the
 * boolean-returning close helpers) is settled — the worker is not pinned — but
 * it is NOT clean: the tab may still be open, so cleanup-taint is latched for
 * /ready instead of reporting settled-clean (tabs would otherwise accumulate
 * silently under the "always" close policy).
 */
export async function closeOwnedTargetWithDeadline(
  closePromise: Promise<boolean | void>,
  logger: BrowserLogger,
  context: { targetId: string | null; timeoutMs?: number },
): Promise<boolean> {
  const timeoutMs = Math.max(1, context.timeoutMs ?? OWNED_TARGET_CLOSE_TIMEOUT_MS);
  let timer: ReturnType<typeof setTimeout> | null = null;
  const outcome = await Promise.race<OwnedTargetCloseOutcome>([
    closePromise.then(
      (result): OwnedTargetCloseOutcome =>
        result === false
          ? { kind: "failed", detail: "close attempt reported failure" }
          : { kind: "closed" },
      (error): OwnedTargetCloseOutcome => ({
        kind: "failed",
        detail: error instanceof Error ? error.message : String(error),
      }),
    ),
    new Promise<OwnedTargetCloseOutcome>((resolve) => {
      timer = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
      timer.unref?.();
    }),
  ]);
  if (timer) {
    clearTimeout(timer);
  }
  if (outcome.kind === "timeout") {
    const reason = `owned-target close timed out after ${timeoutMs}ms (target=${context.targetId ?? "unknown"})`;
    latchBrowserCleanupTaint(reason);
    logger(
      `[browser] CLEANUP-TAINT: ${reason}; continuing cleanup so the worker is not pinned busy (§14.13 account-scoped taint is a handoff concern).`,
    );
    // Let the wedged close settle in the background without surfacing an
    // unhandled rejection.
    closePromise.catch(() => undefined);
    return false;
  }
  if (outcome.kind === "failed") {
    latchBrowserCleanupTaint(
      `owned-target close failed (target=${context.targetId ?? "unknown"}): ${outcome.detail}`,
      logger,
    );
    return false;
  }
  return true;
}

function shouldCleanupBlankTabsAfterLastLease(options: {
  runStatus: "attempted" | "complete";
  ownsTarget: boolean;
  connectionClosedUnexpectedly: boolean;
  manualLogin: boolean;
  keepBrowser: boolean;
  chromePort?: number;
}): boolean {
  return (
    options.runStatus === "complete" &&
    options.ownsTarget &&
    !options.connectionClosedUnexpectedly &&
    options.manualLogin &&
    options.keepBrowser &&
    Boolean(options.chromePort)
  );
}

function buildSkippedModelSelectionEvidence(
  desiredModel: string | null | undefined,
  strategy: BrowserModelSelectionEvidence["strategy"],
): BrowserModelSelectionEvidence {
  return {
    requestedModel: desiredModel ?? null,
    resolvedLabel: null,
    strategy,
    status: "skipped",
    verified: false,
    source: "config",
    capturedAt: new Date().toISOString(),
  };
}

async function selectInitialModelWithRefreshRecovery<T>({
  selectModel,
  refreshPage,
  allowRefresh,
  logger,
}: {
  selectModel: () => Promise<T>;
  refreshPage: () => Promise<void>;
  allowRefresh: boolean;
  logger: BrowserLogger;
}): Promise<T> {
  try {
    return await selectModel();
  } catch (error) {
    if (!allowRefresh || !isRefreshableModelSelectionError(error)) {
      throw error;
    }
    logger(
      "[retry] Requested model was absent from the initial picker snapshot; hard-refreshing once before prompt submission.",
    );
    await refreshPage();
    return selectModel();
  }
}

function shouldRefreshInitialModelPicker(options: {
  resumeConversationUrl?: string | null;
  browserTabRef?: string | null;
}): boolean {
  return !options.resumeConversationUrl && !options.browserTabRef;
}

// Single source of truth for the "is this the served GPT-5.6 Sol label" gate:
// delegate to isGpt56SolModelLabel (normalized exact-match allowlist) so this
// Sol+Pro protection gate and the serve/client fleet gates can never diverge.
function isDesiredGpt56SolModel(model: string | null | undefined): boolean {
  return isGpt56SolModelLabel(model);
}

function mergeModeSelectionEvidence(
  current: BrowserModelSelectionEvidence | undefined,
  mode: NonNullable<Awaited<ReturnType<typeof ensureThinkingTime>>>,
): BrowserModelSelectionEvidence {
  const solProRoute =
    isDesiredGpt56SolModel(mode.requestedModelLabel) && mode.requestedMode?.toLowerCase() === "pro";
  const modelVerified = mode.modelVerified ?? current?.modelVerified ?? current?.verified ?? false;
  const modeVerified = mode.modeVerified ?? false;
  const verifiedBeforePromptSubmit = mode.verifiedBeforePromptSubmit === true;
  const verified = solProRoute
    ? modelVerified && modeVerified && verifiedBeforePromptSubmit
    : (current?.verified ?? false);
  const resolvedModelLabel = mode.resolvedModelLabel ?? current?.resolvedModelLabel ?? null;
  const resolvedModeLabel = mode.resolvedModeLabel ?? current?.resolvedModeLabel ?? null;
  return {
    ...current,
    ...mode,
    requestedModel: current?.requestedModel ?? mode.requestedModelLabel ?? null,
    resolvedLabel:
      solProRoute && resolvedModelLabel && resolvedModeLabel
        ? `${resolvedModelLabel} + ${resolvedModeLabel}`
        : (current?.resolvedLabel ?? resolvedModelLabel),
    modelVerified,
    modeVerified,
    verifiedBeforePromptSubmit,
    strategy: current?.strategy ?? "select",
    status: current?.status ?? "already-selected",
    verified,
    source: current?.source ?? "chatgpt-model-picker",
    capturedAt: new Date().toISOString(),
  };
}

function assertProtectedSolProEvidence(
  desiredModel: string | null | undefined,
  evidence: BrowserModelSelectionEvidence | undefined,
): void {
  if (!isDesiredGpt56SolModel(desiredModel)) return;
  if (
    evidence?.modelVerified === true &&
    evidence.modeVerified === true &&
    evidence.verifiedBeforePromptSubmit === true &&
    evidence.verified === true
  ) {
    return;
  }
  throw new Error(
    "GPT-5.6 Sol + Pro selection was not atomically verified before prompt submission; refusing to submit.",
  );
}

async function verifyProtectedSolProSelectionForSubmit({
  desiredModel,
  modelStrategy,
  thinkingTime,
  selectModel,
  selectMode,
}: {
  desiredModel: string | null | undefined;
  modelStrategy: string;
  thinkingTime: string | null | undefined;
  selectModel: () => Promise<BrowserModelSelectionEvidence>;
  selectMode: () => Promise<BrowserModeSelectionEvidence | undefined>;
}): Promise<BrowserModelSelectionEvidence | undefined> {
  if (!isDesiredGpt56SolModel(desiredModel)) return undefined;
  if (modelStrategy !== "select" || thinkingTime !== "extended") {
    throw new Error(
      "GPT-5.6 Sol + Pro requires modelStrategy=select and thinkingTime=extended before every prompt submission.",
    );
  }
  const modelEvidence = await selectModel();
  const modeEvidence = await selectMode();
  if (!modeEvidence) {
    throw new Error(
      "GPT-5.6 Sol + Pro mode evidence was unavailable immediately before prompt submission.",
    );
  }
  const evidence = mergeModeSelectionEvidence(modelEvidence, modeEvidence);
  assertProtectedSolProEvidence(desiredModel, evidence);
  return evidence;
}

async function proveProtectedSolProSelectionBeforeSubmit({
  desiredModel,
  runtime,
  logger,
  attachmentBindingToken,
  composerBindingToken,
  exactSubmission,
}: {
  desiredModel: string | null | undefined;
  runtime: ChromeClient["Runtime"];
  logger: BrowserLogger;
  attachmentBindingToken?: string;
  composerBindingToken?: string;
  exactSubmission?: import("./actions/promptComposer.js").ExactSubmissionExpectation;
}): Promise<ReturnType<typeof buildGpt56SolProFinalDispatchGuard> | void> {
  const requireProtectedRoute = isDesiredGpt56SolModel(desiredModel);
  if (requireProtectedRoute) {
    const evidence = await proveGpt56SolProPublicRoute(
      runtime,
      attachmentBindingToken,
      composerBindingToken,
    );
    if (!evidence.verified) {
      logger(
        `Protected route verification failed at dispatch boundary: reason=${evidence.reason ?? "unknown"}; composer=${evidence.composerBindingVerified}; model=${JSON.stringify(evidence.modelSignals)}; mode=${JSON.stringify(evidence.modeSignals)}`,
      );
      throw new BrowserAutomationError(
        "GPT-5.6 Sol + Pro could not be verified on the exact dispatch composer; refusing to submit.",
        {
          stage: "model-selection",
          code: "protected-route-public-proof-unverified",
          proofReason: evidence.reason,
          composerBindingVerified: evidence.composerBindingVerified,
          modelVerified: evidence.modelVerified,
          modeVerified: evidence.modeVerified,
          modelSignalCount: evidence.modelSignals.length,
          modeSignalCount: evidence.modeSignals.length,
          modelSignals: evidence.modelSignals,
          modeSignals: evidence.modeSignals,
          privateModelProofAttempted: evidence.privateModelProofAttempted,
          privateModelProofValid: evidence.privateModelProofValid,
        },
      );
    }
    logger("Protected route: GPT-5.6 Sol + Pro public-menu proof minted at the dispatch boundary");
  }
  if (!requireProtectedRoute && !exactSubmission) return;
  return buildGpt56SolProFinalDispatchGuard(attachmentBindingToken, composerBindingToken, {
    requireProtectedRoute,
    exactSubmission,
  });
}

async function prepareSubmissionComposerWithProtectedRoute({
  hasAttachments,
  verifyProtectedRoute,
  prepareComposer,
  prepareMutatingComposerMode,
  prepareAttachments,
}: {
  hasAttachments: boolean;
  verifyProtectedRoute: () => Promise<void>;
  prepareComposer: () => Promise<void>;
  prepareMutatingComposerMode: () => Promise<void>;
  prepareAttachments: () => Promise<void>;
}): Promise<void> {
  // Model/mode selection and Deep Research activation are allowed to remount
  // the ChatGPT composer. For an attachment-bearing run they therefore must
  // happen before file registration; text-only runs keep their historical
  // preparation -> Deep Research -> last-moment selection order.
  if (hasAttachments) await verifyProtectedRoute();
  await prepareComposer();
  if (hasAttachments) await prepareMutatingComposerMode();
  await prepareAttachments();
  if (!hasAttachments) {
    await prepareMutatingComposerMode();
    await verifyProtectedRoute();
  }
}

function isDesiredChatGptProModel(model: string | null | undefined): boolean {
  return typeof model === "string" && /\bpro\b/i.test(model);
}

type ChatGptFileArtifactCollection = Awaited<ReturnType<typeof collectChatGptFileArtifacts>>;

function mergeChatGptFileArtifactCollections(
  first: ChatGptFileArtifactCollection,
  second: ChatGptFileArtifactCollection,
): ChatGptFileArtifactCollection {
  const files = new Map<string, BrowserDownloadableFile>();
  for (const file of [...first.files, ...second.files]) {
    files.set(file.downloadUrl ?? file.sandboxUrl ?? file.url ?? file.filename ?? "", file);
  }
  const savedFiles = new Map<string, SavedBrowserFile>();
  for (const file of [...first.savedFiles, ...second.savedFiles]) {
    savedFiles.set(file.path, file);
  }
  return {
    files: [...files.values()],
    savedFiles: [...savedFiles.values()],
    fileCount: Math.max(first.fileCount, second.fileCount, files.size),
  };
}

async function collectLateChatGptFileArtifactsFromTranscript(params: {
  Browser?: ChromeClient["Browser"];
  Client?: ChromeClient;
  Page?: ChromeClient["Page"];
  Runtime: ChromeClient["Runtime"];
  Network: ChromeClient["Network"];
  current: ChatGptFileArtifactCollection;
  logger?: BrowserLogger;
  minTurnIndex?: number | null;
  sessionId?: string;
  transcriptPath?: string;
}): Promise<ChatGptFileArtifactCollection> {
  if (params.current.savedFiles.length > 0 || !params.transcriptPath) {
    return params.current;
  }
  const transcriptText = await readFile(params.transcriptPath, "utf8").catch(() => "");
  if (!transcriptText.includes("sandbox:/mnt/data/") && !transcriptText.includes("/backend-api/")) {
    return params.current;
  }
  params.logger?.("[browser] Retrying downloadable file collection from saved transcript.");
  const recovered = await collectChatGptFileArtifacts({
    Browser: params.Browser,
    Client: params.Client,
    Page: params.Page,
    Runtime: params.Runtime,
    Network: params.Network,
    answerText: transcriptText,
    logger: params.logger,
    minTurnIndex: params.minTurnIndex,
    sessionId: params.sessionId,
  });
  return mergeChatGptFileArtifactCollections(params.current, recovered);
}

export async function runBrowserMode(options: BrowserRunOptions): Promise<BrowserRunResult> {
  const promptText = options.prompt?.trim();
  if (!promptText) {
    throw new Error("Prompt text is required when using browser mode.");
  }
  if (options.signal?.aborted) {
    // Fail fast before any Chrome work: the caller is already gone.
    throw buildClientAbortError(false);
  }

  const attachments: BrowserAttachment[] = options.attachments ?? [];
  const fallbackSubmission = options.fallbackSubmission;

  let config = resolveBrowserConfig(options.config);
  const usingCopiedProfile = Boolean(config.copyProfileSource);
  if (usingCopiedProfile && (config.attachRunning || config.remoteChrome)) {
    throw new BrowserAutomationError(
      "--copy-profile requires a locally launched Chrome instance and cannot be combined with attach-running or remote Chrome.",
      { stage: "profile-config" },
    );
  }
  const isResumingConversation = Boolean(config.resumeConversationUrl);
  const followUpPrompts = normalizeBrowserFollowUpPrompts(options.followUpPrompts);
  if (config.researchMode === "deep" && followUpPrompts.length > 0) {
    throw new BrowserAutomationError(
      "Browser follow-ups are not supported with Deep Research mode. Put the full research plan into the initial prompt or run a normal browser consult for multi-turn review.",
      {
        stage: "browser-follow-ups",
        details: { researchMode: "deep", followUps: followUpPrompts.length },
      },
    );
  }
  const logger: BrowserLogger = options.log ?? ((_message: string) => {});
  if (logger.verbose === undefined) {
    logger.verbose = Boolean(config.debug);
  }
  if (logger.sessionLog === undefined && options.log?.sessionLog) {
    logger.sessionLog = options.log.sessionLog;
  }
  const runtimeHintCb = options.runtimeHintCb;
  let lastTargetId: string | undefined;
  let lastUrl: string | undefined = config.resumeConversationUrl || undefined;
  let canonicalConversationId = extractConversationIdFromUrl(config.resumeConversationUrl ?? "");
  let conversationIdentityConflict: BrowserAutomationError | null = null;
  let promptSubmitted = false;
  let submissionProvenance: BrowserSubmissionProvenance | undefined;
  let modelSelectionEvidence: BrowserModelSelectionEvidence | undefined;
  let tabLease: BrowserTabLease | null = null;
  // Initialized to a no-op so control-flow analysis keeps the callable type;
  // the abort-race wiring below replaces it with the real disposer.
  let removeAbortListener: (() => void) | null = () => {};
  let conversationUrlMonitor: ConversationUrlMonitor | null = null;
  const emitRuntimeHint = async (
    overrides: {
      promptSubmitted?: boolean;
      submissionProvenance?: BrowserSubmissionProvenance;
      strict?: boolean;
    } = {},
  ): Promise<void> => {
    if (!chrome?.port) {
      if (overrides.strict) {
        throw new BrowserAutomationError(
          "Chrome runtime metadata was unavailable at the dispatch boundary; refusing to submit.",
          {
            stage: "submit-prompt",
            code: "runtime-hint-unavailable-before-submit",
            retryable: true,
            runtime: { promptSubmitted: false },
          },
        );
      }
      return;
    }
    const conversationId = lastUrl ? extractConversationIdFromUrl(lastUrl) : undefined;
    const hint = {
      chromePid: chrome.pid,
      chromePort: chrome.port,
      chromeHost,
      chromeTargetId: lastTargetId,
      tabUrl: lastUrl,
      conversationId,
      promptSubmitted: overrides.promptSubmitted ?? promptSubmitted,
      submissionProvenance: overrides.submissionProvenance ?? submissionProvenance,
      userDataDir,
      controllerPid: process.pid,
    };
    try {
      await runtimeHintCb?.(hint, modelSelectionEvidence);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger(`Failed to persist runtime hint: ${message}`);
      if (overrides.strict) {
        throw new BrowserAutomationError(
          "Could not persist the pre-dispatch runtime boundary; refusing to submit.",
          {
            stage: "submit-prompt",
            code: "runtime-hint-persistence-failed-before-submit",
            retryable: true,
            runtime: { promptSubmitted: false },
          },
          error,
        );
      }
    }
    try {
      await tabLease?.update({
        chromeHost,
        chromePort: chrome.port,
        chromeTargetId: lastTargetId,
        tabUrl: lastUrl,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger(`Failed to update browser tab lease: ${message}`);
    }
  };
  const observeConversationUrl = async (
    observedUrl: string,
    label: string,
    emit = true,
  ): Promise<void> => {
    const decision = decideConversationUrlAdoption(canonicalConversationId, observedUrl);
    if (decision.kind === "conflict") {
      const error = new BrowserAutomationError(
        `ChatGPT conversation identity changed from ${decision.expectedConversationId} to ${decision.observedConversationId} (${label}). Refusing cross-conversation capture.`,
        {
          stage: "capture-binding",
          code: "capture-binding-conversation-changed",
          expectedConversationId: decision.expectedConversationId,
          observedConversationId: decision.observedConversationId,
        },
      );
      conversationIdentityConflict = error;
      logger(`[browser] ${error.message}`);
      throw error;
    }
    if (decision.kind === "noncanonical") {
      // Preserve a provisional/root URL only until a durable identity exists;
      // it must never clear or replace the first canonical conversation.
      if (!canonicalConversationId) lastUrl = observedUrl;
    } else {
      canonicalConversationId = decision.conversationId;
      lastUrl = observedUrl;
    }
    if (emit) await emitRuntimeHint();
  };
  const expectedConversationId = (): string | undefined => {
    if (conversationIdentityConflict) throw conversationIdentityConflict;
    return canonicalConversationId;
  };
  const markPromptAttemptStarted = async (attemptedPrompt: string): Promise<void> => {
    try {
      // Invalidate the prior turn's digest before ANY failure point in a new
      // multi-turn attempt. Otherwise a pre-dispatch follow-up failure could
      // mint recovery for the already-finished previous turn and falsely mark
      // the requested multi-turn run complete.
      await options.submittedPromptPreviewCb?.(
        buildPromptRecoveryOwnershipPreview(attemptedPrompt),
      );
    } catch (error) {
      throw new BrowserAutomationError(
        "Could not invalidate the prior prompt recovery binding before submission; refusing to dispatch a prompt that could be recovered as the wrong turn.",
        {
          stage: "submit-prompt",
          code: "prompt-ownership-invalidation-failed",
          retryable: true,
          runtime: { promptSubmitted: false },
        },
        error,
      );
    }
  };
  const markPromptSubmitted = async (provenance: BrowserSubmissionProvenance): Promise<void> => {
    const firstSubmission = !promptSubmitted;
    if (!firstSubmission) {
      return;
    }
    await emitRuntimeHint({
      promptSubmitted: true,
      submissionProvenance: provenance,
      strict: true,
    });
    promptSubmitted = true;
    submissionProvenance = provenance;
    void conversationUrlMonitor?.schedule("post-submit", config.timeoutMs ?? 120_000);
  };
  const markPromptBound = async (
    submittedPrompt: string,
    binding: SubmittedUserMessageBinding,
  ): Promise<void> => {
    if (binding.quality !== "message-handle" || !binding.promptDomSha256) return;
    try {
      await options.submittedPromptPreviewCb?.(
        buildPromptRecoveryOwnershipPreview(submittedPrompt),
        binding.promptDomSha256,
      );
    } catch (error) {
      throw new BrowserAutomationError(
        "The prompt was submitted, but Oracle could not persist its DOM ownership proof; refusing to continue with ambiguous recovery state.",
        {
          stage: "capture-binding",
          code: "prompt-ownership-binding-persistence-failed",
          retryable: false,
          runtime: { promptSubmitted: true },
        },
        error,
      );
    }
  };
  // Event-emission only: one-shot run_progress.v1 markers at lifecycle
  // boundaries, gated by the same knob as the heartbeat monitor (the
  // `--run-progress` flag OR ORACLE_RUN_PROGRESS_JSON). Every emission is
  // internally guarded so a sink failure can never throw into the run path.
  const runProgressEnabled = options.runProgress === true || shouldEmitBrowserRunProgress();
  const emitRunProgressMarker = (marker: BrowserRunProgressMarker): void => {
    emitBrowserRunProgressMarker(marker, {
      runId: options.sessionId ?? "browser",
      enabled: runProgressEnabled,
      onError: (error) =>
        logger(
          `[browser] run_progress marker (${marker}) emission failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ),
    });
  };
  if (config.debug || process.env.CHATGPT_DEVTOOLS_TRACE === "1") {
    logger(
      `[browser-mode] config: ${JSON.stringify({
        ...redactBrowserConfigForDebugLog(config),
        promptLength: promptText.length,
      })}`,
    );
  }
  for (const line of formatBrowserControlPlan(describeBrowserControlPlan(config), "browser")) {
    logger(line);
  }

  if (config.attachRunning) {
    const attached = await resolveAttachRunningConnection(config, logger);
    config = {
      ...config,
      remoteChrome: { host: attached.host, port: attached.port },
      remoteChromeBrowserWSEndpoint: attached.browserWSEndpoint,
      remoteChromeProfileRoot: attached.profileRoot,
    };
  }

  if (!config.remoteChrome && !config.manualLogin) {
    const preferredPort = config.debugPort ?? DEFAULT_DEBUG_PORT;
    const availablePort = await pickAvailableDebugPort(preferredPort, logger);
    if (availablePort !== preferredPort) {
      logger(
        `DevTools port ${preferredPort} busy; using ${availablePort} to avoid attaching to stray Chrome.`,
      );
    }
    config = { ...config, debugPort: availablePort };
  }

  // Remote Chrome mode - connect to existing browser
  if (config.remoteChrome) {
    // Warn about ignored local-only options
    const ignoredFlags = listIgnoredRemoteChromeFlags(config);
    if (ignoredFlags.length > 0) {
      logger(`Note: --remote-chrome ignores local Chrome flags (${ignoredFlags.join(", ")}).`);
    }

    return runRemoteBrowserMode(promptText, attachments, config, logger, options);
  }

  const manualLogin = Boolean(config.manualLogin);
  if (manualLogin && usingCopiedProfile) {
    throw new BrowserAutomationError(
      "--copy-profile cannot be combined with --browser-manual-login: choose either a throwaway copied profile or the persistent manual-login profile.",
      { stage: "profile-config" },
    );
  }
  // Manual-login and copy-profile both start from an already-signed-in profile,
  // so neither clears nor syncs cookies.
  const profileIsPreSigned = manualLogin || usingCopiedProfile;
  const manualProfileDir = config.manualLoginProfileDir
    ? path.resolve(config.manualLoginProfileDir)
    : defaultManualLoginProfileDir();
  const userDataDir = manualLogin
    ? manualProfileDir
    : await mkdtemp(path.join(await resolveUserDataBaseDir(), "oracle-browser-"));
  const effectiveKeepBrowser = Boolean(config.keepBrowser);
  if (manualLogin) {
    // Learned: manual login reuses a persistent profile so cookies/SSO survive.
    await mkdir(userDataDir, { recursive: true });
    logger(`Manual login mode enabled; reusing persistent profile at ${userDataDir}`);
    await assertManualLoginProfileReadyForRun({
      userDataDir,
      keepBrowser: effectiveKeepBrowser,
    });
  } else if (config.copyProfileSource) {
    const copiedProfileDirectory = await copyChromeProfile(
      config.copyProfileSource,
      userDataDir,
      config.chromeProfile,
    );
    config = { ...config, chromeProfile: copiedProfileDirectory };
    logger(
      `Seeded temporary Chrome profile ${copiedProfileDirectory} from ${config.copyProfileSource} (copy-profile mode; signed-in session reused without manual login)`,
    );
  } else {
    logger(`Created temporary Chrome profile at ${userDataDir}`);
  }

  if (manualLogin) {
    try {
      tabLease = await acquireBrowserTabLease(userDataDir, {
        maxConcurrentTabs: config.maxConcurrentTabs,
        timeoutMs: config.queueTimeoutMs,
        logger,
        sessionId: options.sessionId,
        signal: options.signal,
      });
    } catch (error) {
      await rollbackOrphanedBrowserTabLeaseAcquisition(
        error,
        logger,
        "local browser acquisition rollback",
      );
      throw error;
    }
  }

  let acquiredChrome: { chrome: BrowserChrome; reusedChrome: LaunchedChrome | null };
  try {
    acquiredChrome = manualLogin
      ? await acquireManualLoginChromeForRun(userDataDir, config, logger, options.sessionId)
      : {
          chrome: await launchChrome(
            {
              ...config,
              remoteChrome: config.remoteChrome,
            },
            userDataDir,
            logger,
          ),
          reusedChrome: null,
        };
  } catch (error) {
    if (tabLease) {
      const handle = tabLease;
      tabLease = null;
      await releaseBrowserTabLeaseOrTaint(handle, logger, "browser launch rollback");
    }
    if (usingCopiedProfile) {
      await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
    }
    throw error;
  }
  const { chrome, reusedChrome } = acquiredChrome;
  const chromeHost = (chrome as unknown as { host?: string }).host ?? "127.0.0.1";
  let removeTerminationHooks: (() => void) | null = null;
  try {
    removeTerminationHooks = registerTerminationHooks(
      chrome,
      userDataDir,
      effectiveKeepBrowser,
      logger,
      {
        isInFlight: () => runStatus !== "complete",
        emitRuntimeHint,
        preserveUserDataDir: manualLogin,
        // copy-profile is a throwaway copy of a signed-in profile; never leave it on disk.
        forceProfileCleanup: usingCopiedProfile,
      },
    );
  } catch {
    // ignore failure; cleanup still happens below
  }

  let client: ChromeClient | null = null;
  let isolatedTargetId: string | null = null;
  let orphanedTargetNeedsCleanup = false;
  let ownsTarget = true;
  const startedAt = Date.now();
  let answerText = "";
  let answerMarkdown = "";
  let answerHtml = "";
  let runStatus: "attempted" | "complete" = "attempted";
  let connectionClosedUnexpectedly = false;
  let stopThinkingMonitor: (() => void) | null = null;
  let removeDialogHandler: (() => void) | null = null;
  let appliedCookies = 0;
  let preserveBrowserOnError = false;
  let ownedTargetCleanupProved = true;

  try {
    if (tabLease) {
      await tabLease.update({
        chromeHost,
        chromePort: chrome.port,
      });
    }
    try {
      if (config.browserTabRef) {
        const attached = await connectToExistingChatGptTab({
          host: chromeHost,
          port: chrome.port,
          ref: config.browserTabRef,
        });
        client = attached.client;
        isolatedTargetId = attached.targetId ?? null;
        lastTargetId = attached.targetId ?? undefined;
        if (attached.tab.url) {
          await observeConversationUrl(attached.tab.url, "attached-tab", false);
        }
        ownsTarget = false;
        logger(
          `Attached to existing ChatGPT tab ${attached.targetId}${attached.tab.url ? ` (${attached.tab.url})` : ""}`,
        );
        // Reattached tabs may share a Chrome window with other tabs (manual
        // login, c>=2 concurrency) and can be occluded/backgrounded even
        // though the run considers them "local". Neutralize that like the
        // remote path does, so Send clicks aren't dropped.
        await enableFocusEmulation(client, logger, "local tab");
      } else {
        const connection = await connectWithNewTab(
          chrome.port,
          logger,
          "about:blank",
          chromeHost,
          resolveIsolatedTabConnectOptions(manualLogin),
        );
        client = connection.client;
        isolatedTargetId = connection.targetId ?? null;
        ownsTarget = true;
        // Same rationale as the reattach branch above: a freshly opened tab
        // in a shared/manual-login Chrome window (or one about to be hidden
        // via --browser-hide-window below) can still be occluded.
        await enableFocusEmulation(client, logger, "local tab");
      }
      if (tabLease && isolatedTargetId) {
        await tabLease.update({
          chromeHost,
          chromePort: chrome.port,
          chromeTargetId: isolatedTargetId,
        });
      }
    } catch (error) {
      if (error instanceof OrphanedChromeTargetError) {
        isolatedTargetId = error.targetId;
        lastTargetId = error.targetId;
        orphanedTargetNeedsCleanup = true;
        logger(
          `[browser] Isolated target ${error.targetId} survived its first rollback close; retrying bounded cleanup before releasing its tab lease.`,
        );
      }
      const hint = describeDevtoolsFirewallHint(chromeHost, chrome.port);
      if (hint) {
        logger(hint);
      }
      throw error;
    }
    const disconnectPromise = new Promise<never>((_, reject) => {
      client?.on("disconnect", () => {
        connectionClosedUnexpectedly = true;
        void (async () => {
          const liveness = await probeChromeTargetLiveness({
            host: chromeHost,
            port: chrome.port,
            targetId: lastTargetId ?? isolatedTargetId,
          });
          const recoverable = isRecoverableChromeDisconnect(liveness);
          if (recoverable) {
            logger(
              "CDP client disconnected; Chrome/target still reachable. Leaving run recoverable for reattach.",
            );
          } else {
            logger("Chrome window closed; attempting to abort run.");
          }
          reject(
            new BrowserAutomationError(connectionLostUserMessage({ recoverable }), {
              stage: "connection-lost",
              recoverableDisconnect: recoverable,
              disconnectCause: recoverable ? "cdp-client-disconnect" : "chrome-closed",
              runtime: {
                chromePid: chrome.pid,
                chromePort: chrome.port,
                chromeHost,
                userDataDir,
                chromeTargetId: lastTargetId ?? isolatedTargetId ?? undefined,
                tabUrl: liveness.matchedUrl ?? lastUrl,
                conversationId:
                  (liveness.matchedUrl ?? lastUrl)
                    ? extractConversationIdFromUrl(liveness.matchedUrl ?? lastUrl ?? "")
                    : undefined,
                promptSubmitted,
                controllerPid: process.pid,
              },
            }),
          );
        })();
      });
    });
    const abortPromise = new Promise<never>((_, reject) => {
      const signal = options.signal;
      if (!signal) {
        return;
      }
      const rejectAborted = () => {
        logger("Caller disconnected; aborting run at the next wait point.");
        // promptSubmitted is read at abort time so the typed class reflects
        // whether the Send boundary was crossed.
        reject(buildClientAbortError(promptSubmitted));
      };
      if (signal.aborted) {
        rejectAborted();
        return;
      }
      signal.addEventListener("abort", rejectAborted, { once: true });
      removeAbortListener = () => signal.removeEventListener("abort", rejectAborted);
    });
    // Keep the rejection handled even if no wait is currently racing it.
    void abortPromise.catch(() => undefined);
    const raceWithDisconnect = <T>(promise: Promise<T>): Promise<T> =>
      Promise.race([promise, disconnectPromise, abortPromise]);
    const { Network, Page, Runtime, Input, DOM, Target } = client;

    const domainEnablers = [Network.enable({}), Page.enable(), Runtime.enable()];
    if (DOM && typeof DOM.enable === "function") {
      domainEnablers.push(DOM.enable());
    }
    await Promise.all(domainEnablers);
    if (!config.headless && config.hideWindow) {
      await positionChromeWindowOffscreen(client, logger);
    }
    // The send button is clicked with trusted CDP input events at viewport
    // coordinates, which ChatGPT silently drops when the window is hidden or
    // occluded. Emulate focus so the page behaves like a foreground tab.
    await enableFocusEmulation(client, logger, "local target");
    removeDialogHandler = installJavaScriptDialogAutoDismissal(Page, logger);
    if (!profileIsPreSigned) {
      await Network.clearBrowserCookies();
    }

    const manualLoginCookieSync = manualLogin && Boolean(config.manualLoginCookieSync);
    const cookieSyncEnabled = config.cookieSync && (!profileIsPreSigned || manualLoginCookieSync);
    if (cookieSyncEnabled) {
      if (manualLoginCookieSync) {
        logger(
          "Manual login mode: seeding persistent profile with cookies from your Chrome profile.",
        );
      }
      if (!config.inlineCookies) {
        logger(
          "Heads-up: macOS may prompt for your Keychain password to read Chrome cookies; use --copy or --render for manual flow.",
        );
      } else {
        logger("Applying inline cookies (skipping Chrome profile read and Keychain prompt)");
      }
      // Learned: always sync cookies before the first navigation so /backend-api/me succeeds.
      const cookieCount = await syncCookies(Network, config.url, config.chromeProfile, logger, {
        allowErrors: config.allowCookieErrors ?? false,
        filterNames: config.cookieNames ?? undefined,
        inlineCookies: config.inlineCookies ?? undefined,
        cookiePath: config.chromeCookiePath ?? undefined,
        waitMs: config.cookieSyncWaitMs ?? 0,
      });
      appliedCookies = cookieCount;
      if (config.inlineCookies && cookieCount === 0) {
        throw new Error("No inline cookies were applied; aborting before navigation.");
      }
      logger(
        cookieCount > 0
          ? config.inlineCookies
            ? `Applied ${cookieCount} inline cookies`
            : `Copied ${cookieCount} cookies from Chrome profile ${config.chromeProfile ?? "Default"}`
          : config.inlineCookies
            ? "No inline cookies applied; continuing without session reuse"
            : "No Chrome cookies found; continuing without session reuse",
      );
    } else {
      logger(
        manualLogin
          ? "Skipping Chrome cookie sync (--browser-manual-login enabled); reuse the opened profile after signing in."
          : "Skipping Chrome cookie sync (--browser-no-cookie-sync)",
      );
    }
    await clearStaleChatGptConversationCookies(Network, Target, logger, {
      preserveConversationIds: [
        extractConversationIdFromUrl(config.resumeConversationUrl ?? ""),
        extractConversationIdFromUrl(lastUrl ?? ""),
      ],
    });

    if (cookieSyncEnabled && !manualLogin && (appliedCookies ?? 0) === 0 && !config.inlineCookies) {
      // Learned: if the profile has no ChatGPT cookies, browser mode will just bounce to login.
      // Fail early so the user knows to sign in.
      throw new BrowserAutomationError(
        "No ChatGPT cookies were applied from your Chrome profile; cannot proceed in browser mode. " +
          "Make sure ChatGPT is signed in in the selected profile, use --browser-manual-login / inline cookies, " +
          "or retry with --browser-cookie-wait 5s if Keychain prompts are slow.",
        {
          stage: "execute-browser",
          details: {
            profile: config.chromeProfile ?? "Default",
            cookiePath: config.chromeCookiePath ?? null,
            hint: "If macOS Keychain prompts or denies access, run oracle from a GUI session or use --copy/--render for the manual flow.",
          },
        },
      );
    }

    if (config.browserTabRef) {
      if (isResumingConversation) {
        await raceWithDisconnect(
          navigateToChatGPT(Page, Runtime, config.resumeConversationUrl as string, logger),
        );
      }
      await raceWithDisconnect(
        ensureNotBlocked(Runtime, config.headless, logger, {
          quarantine: { accountId: options.accountId },
          sessionId: options.sessionId,
        }),
      );
      await raceWithDisconnect(
        preserveChallengeOverPageFailure(
          (async () => {
            await ensureLoggedIn(Runtime, logger);
            await ensurePromptReady(Runtime, config.inputTimeoutMs, logger);
          })(),
          Runtime,
          logger,
          { accountId: options.accountId, sessionId: options.sessionId },
        ),
      );
      if (isResumingConversation) {
        await raceWithDisconnect(
          waitForResumedConversationHydration(Runtime, config.inputTimeoutMs, logger, {
            requirePriorTurns: true,
            expectedConversationUrl: config.resumeConversationUrl as string,
          }),
        );
      }
    } else {
      const baseUrl = CHATGPT_URL;
      // First load the base ChatGPT homepage to satisfy potential interstitials,
      // then hop to the requested URL if it differs.
      await raceWithDisconnect(navigateToChatGPT(Page, Runtime, baseUrl, logger));
      await raceWithDisconnect(
        ensureNotBlocked(Runtime, config.headless, logger, {
          quarantine: { accountId: options.accountId },
          sessionId: options.sessionId,
        }),
      );
      // Learned: login checks must happen on the base domain before jumping into project URLs.
      await raceWithDisconnect(
        preserveChallengeOverPageFailure(
          waitForLogin({
            runtime: Runtime,
            logger,
            appliedCookies,
            manualLogin,
            timeoutMs: config.timeoutMs,
            profileDir: userDataDir,
            keepBrowser: effectiveKeepBrowser,
          }),
          Runtime,
          logger,
          { accountId: options.accountId, sessionId: options.sessionId },
        ),
      );

      const targetUrl = config.resumeConversationUrl ?? config.url;
      if (isResumingConversation) {
        await raceWithDisconnect(navigateToChatGPT(Page, Runtime, targetUrl, logger));
        await raceWithDisconnect(
          ensureNotBlocked(Runtime, config.headless, logger, {
            quarantine: { accountId: options.accountId },
            sessionId: options.sessionId,
          }),
        );
        await raceWithDisconnect(
          preserveChallengeOverPageFailure(
            ensurePromptReady(Runtime, config.inputTimeoutMs, logger),
            Runtime,
            logger,
            { accountId: options.accountId, sessionId: options.sessionId },
          ),
        );
      } else if (targetUrl !== baseUrl) {
        await raceWithDisconnect(
          navigateToPromptReadyWithFallback(Page, Runtime, {
            url: targetUrl,
            fallbackUrl: baseUrl,
            timeoutMs: config.inputTimeoutMs,
            headless: config.headless,
            logger,
            accountId: options.accountId,
            sessionId: options.sessionId,
          }),
        );
      } else {
        await raceWithDisconnect(
          preserveChallengeOverPageFailure(
            ensurePromptReady(Runtime, config.inputTimeoutMs, logger),
            Runtime,
            logger,
            { accountId: options.accountId, sessionId: options.sessionId },
          ),
        );
      }
      if (isResumingConversation) {
        // A resumed thread loads its prior history after navigation; ChatGPT can reset the
        // composer mid-hydration and wipe a freshly-typed prompt. Wait for hydration to settle
        // and re-confirm the composer before the prompt is typed/submitted below. Wrapped in
        // raceWithDisconnect so a dropped client aborts immediately instead of polling to the
        // hydration deadline. Shared with the remote path via the same helper. requirePriorTurns
        // fails closed if no history hydrates instead of posting into a fresh chat.
        await raceWithDisconnect(
          waitForResumedConversationHydration(Runtime, config.inputTimeoutMs, logger, {
            requirePriorTurns: true,
            expectedConversationUrl: config.resumeConversationUrl as string,
          }),
        );
      }
    }
    const chatMode = await raceWithDisconnect(
      ensureChatMode(Runtime, Input, config.inputTimeoutMs, logger, {
        resetWorkConversation:
          config.browserTabRef && !isResumingConversation
            ? async () => {
                await navigateToChatGPT(Page, Runtime, config.url, logger);
                await ensureNotBlocked(Runtime, config.headless, logger);
                await ensurePromptReady(Runtime, config.inputTimeoutMs, logger);
              }
            : undefined,
      }),
    );
    if (chatMode === "switched") {
      await raceWithDisconnect(ensurePromptReady(Runtime, config.inputTimeoutMs, logger));
    }
    logger(
      `Prompt textarea ready (initial focus, ${promptText.length.toLocaleString()} chars queued)`,
    );
    const captureRuntimeSnapshot = async () => {
      try {
        if (client?.Target?.getTargetInfo) {
          const info = await client.Target.getTargetInfo({});
          lastTargetId = info?.targetInfo?.targetId ?? lastTargetId;
          if (info?.targetInfo?.url) {
            await observeConversationUrl(info.targetInfo.url, "target-snapshot", false);
          }
        }
      } catch {
        // ignore
      }
      try {
        const { result } = await Runtime.evaluate({
          expression: "location.href",
          returnByValue: true,
        });
        if (typeof result?.value === "string") {
          await observeConversationUrl(result.value, "runtime-snapshot", false);
        }
      } catch {
        // ignore
      }
      if (lastUrl) {
        logger(`[browser] url = ${lastUrl}`);
      }
      if (chrome?.port) {
        const suffix = lastTargetId ? ` target=${lastTargetId}` : "";
        if (lastUrl) {
          logger(
            `[reattach] chrome port=${chrome.port} host=${chromeHost} url=${lastUrl}${suffix}`,
          );
        } else {
          logger(`[reattach] chrome port=${chrome.port} host=${chromeHost}${suffix}`);
        }
        await emitRuntimeHint();
      }
    };
    const activeConversationUrlMonitor = createConversationUrlMonitor({
      readUrl: async () => {
        const { result } = await Runtime.evaluate({
          expression: "location.href",
          returnByValue: true,
        });
        return typeof result?.value === "string" ? result.value : null;
      },
      persistUrl: async (url) => observeConversationUrl(url, "conversation-url-monitor"),
      logger,
    });
    conversationUrlMonitor = activeConversationUrlMonitor;
    const updateConversationHint = conversationUrlMonitor.update;
    await captureRuntimeSnapshot();
    const modelStrategy = config.modelStrategy ?? DEFAULT_MODEL_STRATEGY;
    if (
      config.desiredModel &&
      modelStrategy !== "ignore" &&
      (!isResumingConversation || isDesiredGpt56SolModel(config.desiredModel))
    ) {
      const selectModel = () =>
        raceWithDisconnect(
          withRetries(
            () =>
              ensureModelSelection(Runtime, config.desiredModel as string, logger, modelStrategy),
            {
              retries: 2,
              delayMs: 300,
              onRetry: (attempt, error) => {
                if (options.verbose) {
                  logger(
                    `[retry] Model picker attempt ${attempt + 1}: ${error instanceof Error ? error.message : error}`,
                  );
                }
              },
            },
          ),
        );
      modelSelectionEvidence = await selectInitialModelWithRefreshRecovery({
        selectModel,
        refreshPage: async () => {
          await raceWithDisconnect(Page.reload({ ignoreCache: true }));
          await raceWithDisconnect(
            preserveChallengeOverPageFailure(
              (async () => {
                await ensureNotBlocked(Runtime, config.headless, logger, {
                  quarantine: { accountId: options.accountId },
                  sessionId: options.sessionId,
                });
                await assertPreRunAccessState(Runtime, logger, {
                  quarantine: { accountId: options.accountId },
                  sessionId: options.sessionId,
                });
                await ensureLoggedIn(Runtime, logger);
                await ensurePromptReady(Runtime, config.inputTimeoutMs, logger);
              })(),
              Runtime,
              logger,
              { accountId: options.accountId, sessionId: options.sessionId },
            ),
          );
        },
        allowRefresh: shouldRefreshInitialModelPicker(config),
        logger,
      }).catch((error) => {
        const base = error instanceof Error ? error.message : String(error);
        const hint =
          !manualLogin && appliedCookies === 0
            ? " No cookies were applied; log in to ChatGPT in Chrome or provide inline cookies (--browser-inline-cookies[(-file)] or ORACLE_BROWSER_COOKIES_JSON)."
            : "";
        if (!hint) {
          throw error;
        }
        throw new BrowserAutomationError(
          `${base}${hint}`,
          {
            stage: "model-selection",
            reason: "session-unavailable",
          },
          error,
        );
      });
      await raceWithDisconnect(ensurePromptReady(Runtime, config.inputTimeoutMs, logger));
      logger(
        `Prompt textarea ready (after model switch, ${promptText.length.toLocaleString()} chars queued)`,
      );
    } else if (modelStrategy === "ignore" || isResumingConversation) {
      modelSelectionEvidence = buildSkippedModelSelectionEvidence(
        config.desiredModel,
        modelStrategy,
      );
      logger(
        isResumingConversation
          ? "Model picker: skipped (resumed conversation)"
          : "Model picker: skipped (strategy=ignore)",
      );
    }
    const deepResearch = config.researchMode === "deep";
    // Handle thinking time selection if specified. Deep Research owns its own effort flow.
    const thinkingTime = config.thinkingTime;
    if (thinkingTime && !deepResearch) {
      const thinkingTargetModel = modelStrategy === "select" ? config.desiredModel : null;
      const modeSelectionEvidence = await raceWithDisconnect(
        withRetries(() => ensureThinkingTime(Runtime, thinkingTime, logger, thinkingTargetModel), {
          retries: 2,
          delayMs: 300,
          onRetry: (attempt, error) => {
            if (options.verbose) {
              logger(
                `[retry] Thinking time (${thinkingTime}) attempt ${attempt + 1}: ${error instanceof Error ? error.message : error}`,
              );
            }
          },
        }),
      );
      if (modeSelectionEvidence) {
        modelSelectionEvidence = mergeModeSelectionEvidence(
          modelSelectionEvidence,
          modeSelectionEvidence,
        );
        await emitRuntimeHint();
      }
    }
    assertProtectedSolProEvidence(config.desiredModel, modelSelectionEvidence);
    const verifyProtectedRouteBeforeSubmit = async () => {
      const evidence = await verifyProtectedSolProSelectionForSubmit({
        desiredModel: config.desiredModel,
        modelStrategy,
        thinkingTime,
        selectModel: () =>
          raceWithDisconnect(
            withRetries(
              () => ensureModelSelection(Runtime, config.desiredModel as string, logger, "select"),
              {
                retries: 2,
                delayMs: 300,
                onRetry: (attempt, error) => {
                  if (options.verbose) {
                    logger(
                      `[retry] Pre-submit model verification attempt ${attempt + 1}: ${error instanceof Error ? error.message : error}`,
                    );
                  }
                },
              },
            ),
          ),
        selectMode: () =>
          raceWithDisconnect(
            withRetries(
              () => ensureThinkingTime(Runtime, "extended", logger, config.desiredModel),
              {
                retries: 2,
                delayMs: 300,
                onRetry: (attempt, error) => {
                  if (options.verbose) {
                    logger(
                      `[retry] Pre-submit Pro verification attempt ${attempt + 1}: ${error instanceof Error ? error.message : error}`,
                    );
                  }
                },
              },
            ),
          ),
      });
      if (evidence) {
        modelSelectionEvidence = evidence;
        await emitRuntimeHint();
      }
    };
    const profileLockTimeoutMs = manualLogin ? (config.profileLockTimeoutMs ?? 0) : 0;
    let profileLock: ProfileRunLock | null = null;
    const acquireProfileLockIfNeeded = async () => {
      if (profileLockTimeoutMs <= 0) return;
      profileLock = await acquireProfileRunLock(userDataDir, {
        timeoutMs: profileLockTimeoutMs,
        logger,
      });
    };
    const releaseProfileLockIfHeld = async () => {
      if (!profileLock) return;
      const handle = profileLock;
      profileLock = null;
      await handle.release().catch(() => undefined);
    };
    const submitOnceCore = async (
      prompt: string,
      submissionAttachments: BrowserAttachment[],
      submissionOptions?: BrowserSubmissionAttemptOptions,
      retainedAttachmentSnapshotCleanups: Array<() => Promise<void>> = [],
    ) => {
      await markPromptAttemptStarted(prompt);
      const baselineSnapshot = await readAssistantSnapshot(Runtime).catch(() => null);
      const baselineAssistantText =
        typeof baselineSnapshot?.text === "string" ? baselineSnapshot.text.trim() : "";
      const attachmentNames = submissionAttachments.map((a) => path.basename(a.path));
      const attachmentExpectations = submissionAttachments.map((a) => ({
        name: path.basename(a.path),
        generatedBundle: a.generatedBundle === true,
      }));
      const attachmentBindingToken =
        submissionAttachments.length > 0 ? `oracle-attachment-${randomUUID()}` : undefined;
      let inputOnlyAttachments = false;
      await prepareSubmissionComposerWithProtectedRoute({
        hasAttachments: submissionAttachments.length > 0,
        verifyProtectedRoute: verifyProtectedRouteBeforeSubmit,
        prepareComposer: async () => {
          await raceWithDisconnect(clearPromptComposer(Runtime, logger));
          await raceWithDisconnect(ensurePromptReady(Runtime, config.inputTimeoutMs, logger));
        },
        prepareAttachments: async () => {
          if (submissionAttachments.length > 0) {
            if (!DOM) {
              throw new Error("Chrome DOM domain unavailable while uploading attachments.");
            }
            await clearComposerAttachments(Runtime, 5_000, logger);
            for (
              let attachmentIndex = 0;
              attachmentIndex < submissionAttachments.length;
              attachmentIndex += 1
            ) {
              const attachment = submissionAttachments[attachmentIndex];
              logger(`Uploading attachment: ${attachment.displayPath}`);
              const uiConfirmed = await uploadAttachmentFile(
                { runtime: Runtime, dom: DOM, input: Input },
                attachment,
                logger,
                {
                  expectedCount: attachmentIndex + 1,
                  retainPreparedSnapshot: (cleanup) =>
                    retainedAttachmentSnapshotCleanups.push(cleanup),
                },
              );
              if (!uiConfirmed) {
                inputOnlyAttachments = true;
              }
              await delay(500);
            }
            // Scale timeout based on number of files: base 45s + 20s per additional file.
            const baseTimeout = config.inputTimeoutMs ?? 30_000;
            const perFileTimeout = 20_000;
            const waitBudget =
              Math.max(baseTimeout, 45_000) + (submissionAttachments.length - 1) * perFileTimeout;
            const attachmentWaitBudget = Math.max(config.attachmentTimeoutMs ?? 0, waitBudget);
            await waitForAttachmentCompletion(
              Runtime,
              attachmentWaitBudget,
              attachmentNames,
              logger,
            );
            await bindActiveComposerAttachments(
              Runtime,
              attachmentExpectations,
              attachmentBindingToken!,
              logger,
            );
            logger("All attachments uploaded");
          }
        },
        prepareMutatingComposerMode: async () => {
          if (deepResearch) {
            await raceWithDisconnect(
              withRetries(() => activateDeepResearch(Runtime, Input, logger), {
                retries: 2,
                delayMs: 500,
                onRetry: (attempt, error) => {
                  if (options.verbose) {
                    logger(
                      `[retry] Deep Research activation attempt ${attempt + 1}: ${error instanceof Error ? error.message : error}`,
                    );
                  }
                },
              }),
            );
            await raceWithDisconnect(ensurePromptReady(Runtime, config.inputTimeoutMs, logger));
            logger(
              `Prompt textarea ready (after Deep Research activation, ${prompt.length.toLocaleString()} chars queued)`,
            );
          }
        },
      });
      // Sol+Pro route verified before submit (the gate did not throw).
      emitRunProgressMarker("model_verified");
      let baselineTurns = await readConversationTurnCount(Runtime, logger);
      // Learned: return baselineTurns so assistant polling can ignore earlier content.
      const providerState: Record<string, unknown> = {
        runtime: Runtime,
        input: Input,
        logger,
        timeoutMs: config.timeoutMs,
        inputTimeoutMs: config.inputTimeoutMs ?? undefined,
        attachmentTimeoutMs: config.attachmentTimeoutMs ?? undefined,
        baselineTurns: baselineTurns ?? undefined,
        attachmentNames: attachmentExpectations,
        attachmentBindingToken,
        beforePromptSubmit: (
          composerBindingToken?: string,
          exactSubmission?: import("./actions/promptComposer.js").ExactSubmissionExpectation,
        ) =>
          proveProtectedSolProSelectionBeforeSubmit({
            desiredModel: config.desiredModel,
            runtime: Runtime,
            logger,
            attachmentBindingToken,
            composerBindingToken,
            exactSubmission,
          }),
        requireBoundSendTarget:
          isDesiredGpt56SolModel(config.desiredModel) ||
          submissionAttachments.length > 0 ||
          submissionOptions?.requireExactPromptRoundTrip === true,
        requireExactPromptRoundTrip: submissionOptions?.requireExactPromptRoundTrip === true,
        onPromptSubmitted: () => markPromptSubmitted(submissionOptions!.submissionProvenance),
        onPromptBound: markPromptBound,
        // Authoritative account id (server: options.accountId ?? env) so the
        // browser-side quarantine gates trip under the same identity the
        // serve layer's admission checks use (oracle-router-8t1).
        accountId: options.accountId,
        chatgptProVerification: {
          enabled: isDesiredChatGptProModel(config.desiredModel),
        },
      };
      const deepResearchTargetBaseline =
        deepResearch && client
          ? await captureDeepResearchTargetBaseline(client, logger)
          : undefined;
      emitRunProgressMarker("submitting");
      await runProviderSubmissionFlow(chatgptDomProvider, {
        prompt,
        evaluate: async () => undefined,
        delay,
        log: logger,
        state: providerState,
      });
      emitRunProgressMarker("prompt_committed");
      const providerBaselineTurns = providerState.baselineTurns;
      if (typeof providerBaselineTurns === "number" && Number.isFinite(providerBaselineTurns)) {
        baselineTurns = providerBaselineTurns;
      }
      if (attachmentNames.length > 0) {
        if (inputOnlyAttachments) {
          logger(
            "Attachment UI did not render before send; skipping user-turn attachment verification.",
          );
        } else {
          const verified = await waitForUserTurnAttachments(
            Runtime,
            attachmentNames,
            20_000,
            logger,
            {
              minTurnIndex: baselineTurns ?? undefined,
              expectedPrompt: prompt,
              expectedConversationId: expectedConversationId(),
            },
          );
          if (!verified) {
            logger(
              "Sent user message did not expose attachment UI; continuing after upload check.",
            );
          } else {
            logger("Verified attachments present on sent user message");
          }
        }
      }
      return {
        baselineTurns,
        baselineAssistantText,
        deepResearchTargetKeys: deepResearchTargetBaseline?.targetKeys,
        deepResearchTargetBaselineCaptured: deepResearchTargetBaseline?.captured,
      };
    };
    const submitOnce = (
      prompt: string,
      submissionAttachments: BrowserAttachment[],
      submissionOptions?: BrowserSubmissionAttemptOptions,
    ): Promise<BrowserSubmissionAttemptResult> => {
      const retainedAttachmentSnapshotCleanups: Array<() => Promise<void>> = [];
      // Scope immutable filesystem snapshots to the raw attempt promise, not
      // the outer abort/disconnect race. Promise.race does not cancel losers:
      // if a caller leaves while CDP is still consuming a path-backed File,
      // cleanup must wait for that underlying attempt to settle.
      return runWithRetainedAttachmentSnapshots(
        () =>
          submitOnceCore(
            prompt,
            submissionAttachments,
            submissionOptions,
            retainedAttachmentSnapshotCleanups,
          ),
        retainedAttachmentSnapshotCleanups,
        logger,
      );
    };
    const reloadPromptComposer = async () => {
      logger("[browser] Composer became unresponsive; reloading page and retrying once.");
      await raceWithDisconnect(Page.reload({ ignoreCache: true }));
      await raceWithDisconnect(
        assertPreRunAccessState(Runtime, logger, {
          quarantine: { accountId: options.accountId },
          sessionId: options.sessionId,
        }),
      );
      await raceWithDisconnect(
        preserveChallengeOverPageFailure(
          ensurePromptReady(Runtime, config.inputTimeoutMs, logger),
          Runtime,
          logger,
          { accountId: options.accountId, sessionId: options.sessionId },
        ),
      );
    };

    let baselineTurns: number | null = null;
    let baselineAssistantText: string | null = null;
    let deepResearchTargetKeys: string[] = [];
    let deepResearchTargetBaselineCaptured = false;
    let initialSubmissionProvenance: BrowserSubmissionProvenance | undefined;
    let initialSubmittedPrompt = promptText;
    await acquireProfileLockIfNeeded();
    try {
      const submission = await runSubmissionWithRecovery({
        prompt: promptText,
        attachments,
        fallbackSubmission,
        desiredModel: config.desiredModel,
        submit: (submissionPrompt, submissionAttachments, submissionOptions) =>
          raceWithDisconnect(
            preserveChallengeOverPageFailure(
              submitOnce(submissionPrompt, submissionAttachments, submissionOptions),
              Runtime,
              logger,
              { accountId: options.accountId, sessionId: options.sessionId },
            ),
          ),
        reloadPromptComposer,
        prepareFallbackSubmission: async () => {
          await raceWithDisconnect(clearComposerAttachments(Runtime, 5_000, logger));
          await raceWithDisconnect(clearPromptComposer(Runtime, logger));
          await raceWithDisconnect(ensurePromptReady(Runtime, config.inputTimeoutMs, logger));
        },
        logger,
      });
      baselineTurns = submission.baselineTurns;
      baselineAssistantText = submission.baselineAssistantText;
      deepResearchTargetKeys = submission.deepResearchTargetKeys ?? [];
      deepResearchTargetBaselineCaptured = submission.deepResearchTargetBaselineCaptured ?? false;
      initialSubmissionProvenance = submission.submissionProvenance;
      initialSubmittedPrompt = submission.submittedPrompt;
    } finally {
      await releaseProfileLockIfHeld();
    }
    const imageArtifactMinTurnIndex = baselineTurns;
    if (deepResearch) {
      await raceWithDisconnect(waitForResearchPlanAutoConfirm(Runtime, logger));
      const researchResult = await raceWithDisconnect(
        preserveChallengeOverPageFailure(
          waitForDeepResearchCompletion(
            Runtime,
            logger,
            config.timeoutMs,
            baselineTurns,
            Page,
            client,
            {
              ignoredTargetKeys: deepResearchTargetKeys,
              targetBaselineCaptured: deepResearchTargetBaselineCaptured,
            },
          ),
          Runtime,
          logger,
          { accountId: options.accountId, sessionId: options.sessionId },
        ),
      );
      // Deep Research can return its report from a scoped OOPIF rather than
      // the ordinary assistant snapshot path. Bind that report to this run's
      // exact submitted user-message handle before it can become a result (an
      // OOPIF read without message ids still proves the latest bound user turn
      // has an assistant response after it, while target scoping proves which
      // report iframe was read).
      await raceWithDisconnect(
        preserveChallengeOverPageFailure(
          assertCapturedAssistantResponseBound(Runtime, researchResult.meta, logger),
          Runtime,
          logger,
          { accountId: options.accountId, sessionId: options.sessionId },
        ),
      );
      await raceWithDisconnect(
        assertCapturedAnswerNotAccessArtifact(
          Runtime,
          { text: researchResult.text, html: researchResult.html },
          logger,
          {
            quarantine: { accountId: options.accountId },
            sessionId: options.sessionId,
          },
        ),
      );
      await updateConversationHint("post-deep-research", 15_000).catch(() => false);
      expectedConversationId();
      const durationMs = Date.now() - startedAt;
      const tokens = estimateTokenCount(researchResult.text);
      const reportArtifact = await saveOptionalArtifact(
        () =>
          saveDeepResearchReportArtifact({
            sessionId: options.sessionId,
            reportMarkdown: researchResult.text,
            conversationUrl: lastUrl,
            logger,
          }),
        logger,
      );
      const transcriptArtifact = await saveOptionalArtifact(
        () =>
          saveBrowserTranscriptArtifact({
            sessionId: options.sessionId,
            prompt: initialSubmittedPrompt,
            answerMarkdown: researchResult.text,
            conversationUrl: lastUrl,
            artifacts: appendArtifacts(undefined, [reportArtifact]),
            logger,
          }),
        logger,
      );
      const savedArtifacts = appendArtifacts(undefined, [reportArtifact, transcriptArtifact]);
      const archive = await maybeArchiveCompletedConversation({
        Runtime,
        logger,
        config,
        conversationUrl: lastUrl,
        answerText: researchResult.text,
        followUpCount: 0,
        requiredArtifactsSaved: Boolean(reportArtifact && transcriptArtifact),
      });
      await raceWithDisconnect(
        assertCapturedAnswerNotAccessArtifact(
          Runtime,
          { text: researchResult.text, html: researchResult.html },
          logger,
          {
            quarantine: { accountId: options.accountId },
            sessionId: options.sessionId,
          },
        ),
      );
      runStatus = "complete";
      emitRunProgressMarker("done");
      return {
        answerText: researchResult.text,
        answerMarkdown: researchResult.text,
        answerHtml: researchResult.html,
        artifacts: savedArtifacts,
        archive,
        modelSelection: modelSelectionEvidence,
        tookMs: durationMs,
        answerTokens: tokens,
        answerChars: researchResult.text.length,
        chromePid: chrome.pid,
        chromePort: chrome.port,
        chromeHost,
        userDataDir,
        chromeTargetId: lastTargetId,
        tabUrl: lastUrl,
        conversationId: lastUrl ? extractConversationIdFromUrl(lastUrl) : undefined,
        promptSubmitted,
        submissionProvenance: initialSubmissionProvenance,
        controllerPid: process.pid,
      };
    }
    // Helper to normalize text for echo detection (collapse whitespace, lowercase)
    const normalizeForComparison = (text: string): string =>
      text.toLowerCase().replace(/\s+/g, " ").trim();
    const waitForFreshAssistantResponse = async (baselineNormalized: string, timeoutMs: number) => {
      const baselinePrefix =
        baselineNormalized.length >= 80
          ? baselineNormalized.slice(0, Math.min(200, baselineNormalized.length))
          : "";
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const snapshot = await readAssistantSnapshot(
          Runtime,
          baselineTurns ?? undefined,
          expectedConversationId(),
        ).catch(() => null);
        const text = typeof snapshot?.text === "string" ? snapshot.text.trim() : "";
        if (text) {
          const normalized = normalizeForComparison(text);
          const isBaseline =
            normalized === baselineNormalized ||
            (baselinePrefix.length > 0 && normalized.startsWith(baselinePrefix));
          if (!isBaseline) {
            return {
              text,
              html: snapshot?.html ?? undefined,
              meta: {
                turnId: snapshot?.turnId ?? undefined,
                messageId: snapshot?.messageId ?? undefined,
              },
            };
          }
        }
        await delay(350);
      }
      return null;
    };
    const waitWithThinkingMonitor = async <T>(operation: () => Promise<T>): Promise<T> => {
      stopThinkingMonitor?.();
      stopThinkingMonitor = startThinkingStatusMonitor(Runtime, logger, {
        intervalMs: options.heartbeatIntervalMs,
        // Structured run_progress.v1 liveness rides on the same heartbeat ticks,
        // gated by ORACLE_RUN_PROGRESS_JSON and written to stderr (stdout stays
        // reserved for the final --json envelope).
        runProgress: {
          runId: options.sessionId ?? "browser",
          timeoutMs: config.timeoutMs,
          enabled: runProgressEnabled,
        },
      });
      try {
        return await operation();
      } finally {
        stopThinkingMonitor?.();
        stopThinkingMonitor = null;
      }
    };
    const recheckDelayMs = Math.max(0, config.assistantRecheckDelayMs ?? 0);
    const recheckTimeoutMs = Math.max(0, config.assistantRecheckTimeoutMs ?? 0);
    const attemptAssistantRecheck = async (assistantWaitStartedAt: number) => {
      if (!recheckDelayMs) return null;
      logger(
        `[browser] Assistant response timed out; waiting ${formatElapsed(recheckDelayMs)} before rechecking conversation.`,
      );
      await raceWithDisconnect(delay(recheckDelayMs));
      await updateConversationHint("assistant-recheck", 15_000).catch(() => false);
      await captureRuntimeSnapshot().catch(() => undefined);
      const conversationUrl = await readConversationUrl(Runtime);
      if (conversationUrl && isConversationUrl(conversationUrl)) {
        await observeConversationUrl(conversationUrl, "assistant-recheck");
        logger(`[browser] Rechecking assistant response at ${conversationUrl}`);
        await raceWithDisconnect(Page.navigate({ url: conversationUrl }));
        await raceWithDisconnect(delay(1000));
        await raceWithDisconnect(
          assertPreRunAccessState(Runtime, logger, {
            quarantine: { accountId: options.accountId },
            sessionId: options.sessionId,
          }),
        );
      }
      // Validate session before attempting recheck - sessions can expire during the delay
      const sessionValid = await validateChatGPTSession(Runtime, logger);
      if (!sessionValid.valid) {
        await raceWithDisconnect(
          assertPreResultAccessState(Runtime, logger, {
            quarantine: { accountId: options.accountId },
            sessionId: options.sessionId,
          }),
        );
        logger(`[browser] Session validation failed: ${sessionValid.reason}`);
        // Update session metadata to indicate login is needed
        await emitRuntimeHint();
        throw new BrowserAutomationError(
          `ChatGPT session expired during recheck: ${sessionValid.reason}. ` +
            `Conversation URL: ${conversationUrl || lastUrl || "unknown"}. ` +
            `Please sign in and retry.`,
          {
            stage: "assistant-recheck",
            details: {
              conversationUrl: conversationUrl || lastUrl || null,
              sessionStatus: "needs_login",
              validationReason: sessionValid.reason,
            },
            runtime: {
              chromePid: chrome.pid,
              chromePort: chrome.port,
              chromeHost,
              userDataDir,
              chromeTargetId: lastTargetId,
              tabUrl: lastUrl,
              conversationId: lastUrl ? extractConversationIdFromUrl(lastUrl) : undefined,
              promptSubmitted,
              controllerPid: process.pid,
            },
          },
        );
      }
      const timeoutMs = recheckTimeoutMs > 0 ? recheckTimeoutMs : config.timeoutMs;
      const rechecked = await waitWithThinkingMonitor(() =>
        raceWithDisconnect(
          waitForAssistantOrGeneratedImageResponse({
            Runtime,
            waitForText: () =>
              waitForAssistantResponseWithReload(
                Runtime,
                Page,
                timeoutMs,
                logger,
                baselineTurns ?? undefined,
                expectedConversationId(),
                options.accountId,
                {
                  elapsedBaselineMs: Math.max(0, Date.now() - assistantWaitStartedAt),
                },
              ),
            timeoutMs,
            logger,
            minTurnIndex: baselineTurns ?? undefined,
            expectedConversationId: expectedConversationId(),
            imageOutputRequested,
            accountId: options.accountId,
            sessionId: options.sessionId,
          }),
        ),
      );
      logger("Recovered assistant response after delayed recheck");
      return rechecked;
    };
    const imageOutputRequested = Boolean(
      options.generateImagePath ||
      options.outputPath ||
      (options as { generateImage?: string }).generateImage,
    );
    const captureAssistantTurn = async (
      turnPrompt: string,
      label: string,
    ): Promise<BrowserConversationTurn & { answerHtml: string }> => {
      let turnAnswer: AssistantAnswer;
      const assistantWaitStartedAt = Date.now();
      try {
        await updateConversationHint("assistant-wait", 15_000).catch(() => false);
        emitRunProgressMarker("response_waiting");
        turnAnswer = await waitWithThinkingMonitor(() =>
          raceWithDisconnect(
            waitForAssistantOrGeneratedImageResponse({
              Runtime,
              waitForText: () =>
                waitForAssistantResponseWithReload(
                  Runtime,
                  Page,
                  config.timeoutMs,
                  logger,
                  baselineTurns ?? undefined,
                  expectedConversationId(),
                  options.accountId,
                ),
              timeoutMs: config.timeoutMs,
              logger,
              minTurnIndex: baselineTurns ?? undefined,
              expectedConversationId: expectedConversationId(),
              imageOutputRequested,
              accountId: options.accountId,
              sessionId: options.sessionId,
            }),
          ),
        );
      } catch (error) {
        if (isAssistantResponseTimeoutError(error)) {
          const rechecked = await attemptAssistantRecheckOrRethrow(() =>
            attemptAssistantRecheck(assistantWaitStartedAt),
          );
          if (rechecked) {
            turnAnswer = rechecked;
          } else {
            await updateConversationHint("assistant-timeout", 15_000).catch(() => false);
            await captureRuntimeSnapshot().catch(() => undefined);
            const diagnostics = await captureBrowserDiagnostics(
              Runtime,
              logger,
              "assistant-timeout",
              {
                Page,
                sessionId: options.sessionId,
              },
            ).catch(() => undefined);
            const runtime = {
              chromePid: chrome.pid,
              chromePort: chrome.port,
              chromeHost,
              userDataDir,
              chromeTargetId: lastTargetId,
              tabUrl: lastUrl,
              conversationId: lastUrl ? extractConversationIdFromUrl(lastUrl) : undefined,
              promptSubmitted,
              controllerPid: process.pid,
            };
            throw await createAssistantTimeoutError({
              Runtime,
              logger,
              runtime,
              diagnostics,
              cause: error,
            });
          }
        } else {
          throw error;
        }
      }
      // Ensure we store the final conversation URL even if the UI updated late.
      await updateConversationHint("post-response", 15_000);
      const baselineNormalized = baselineAssistantText
        ? normalizeForComparison(baselineAssistantText)
        : "";
      if (baselineNormalized) {
        const normalizedAnswer = normalizeForComparison(turnAnswer.text ?? "");
        const baselinePrefix =
          baselineNormalized.length >= 80
            ? baselineNormalized.slice(0, Math.min(200, baselineNormalized.length))
            : "";
        const isBaseline =
          normalizedAnswer === baselineNormalized ||
          (baselinePrefix.length > 0 && normalizedAnswer.startsWith(baselinePrefix));
        if (isBaseline) {
          logger("Detected stale assistant response; waiting for new response...");
          const refreshed = await waitForFreshAssistantResponse(baselineNormalized, 15_000);
          if (refreshed) {
            await applyBoundAssistantSnapshotReplacement(Runtime, refreshed.meta, logger, () => {
              turnAnswer = refreshed;
            });
          }
        }
      }
      let turnAnswerText = turnAnswer.text;
      const turnAnswerHtml = turnAnswer.html ?? "";
      emitRunProgressMarker("capturing");
      const copiedMarkdown = await raceWithDisconnect(
        withRetries(
          async () => {
            const attempt = await captureAssistantMarkdown(Runtime, turnAnswer.meta, logger, {
              requireSourceIdentity: true,
            });
            if (!attempt) {
              throw new Error("copy-missing");
            }
            return attempt;
          },
          {
            retries: 2,
            delayMs: 350,
            onRetry: (attempt, error) => {
              if (options.verbose) {
                logger(
                  `[retry] Markdown capture attempt ${attempt + 1}: ${error instanceof Error ? error.message : error}`,
                );
              }
            },
          },
        ),
      ).catch(() => null);
      let turnAnswerMarkdown = copiedMarkdown ?? turnAnswerText;

      const promptEchoMatcher = buildPromptEchoMatcher(turnPrompt);
      ({ answerText: turnAnswerText, answerMarkdown: turnAnswerMarkdown } =
        await maybeRecoverLongAssistantResponse({
          runtime: Runtime,
          baselineTurns,
          expectedConversationId: expectedConversationId(),
          answerText: turnAnswerText,
          answerMarkdown: turnAnswerMarkdown,
          logger,
          allowMarkdownUpdate: !copiedMarkdown,
        }));

      // Final sanity check: ensure we didn't accidentally capture the user prompt instead of the assistant turn.
      const finalSnapshot = await readAssistantSnapshot(
        Runtime,
        baselineTurns ?? undefined,
        expectedConversationId(),
      ).catch(() => null);
      const finalText = typeof finalSnapshot?.text === "string" ? finalSnapshot.text.trim() : "";
      if (finalText && finalText !== turnPrompt.trim()) {
        const trimmedMarkdown = turnAnswerMarkdown.trim();
        const finalIsEcho = promptEchoMatcher ? promptEchoMatcher.isEcho(finalText) : false;
        const lengthDelta = finalText.length - trimmedMarkdown.length;
        const missingCopy = !copiedMarkdown && lengthDelta >= 0;
        const likelyTruncatedCopy =
          copiedMarkdown &&
          trimmedMarkdown.length > 0 &&
          lengthDelta >= Math.max(12, Math.floor(trimmedMarkdown.length * 0.75));
        if ((missingCopy || likelyTruncatedCopy) && !finalIsEcho && finalText !== trimmedMarkdown) {
          await applyBoundAssistantSnapshotReplacement(
            Runtime,
            {
              turnId: finalSnapshot?.turnId ?? undefined,
              messageId: finalSnapshot?.messageId ?? undefined,
            },
            logger,
            () => {
              logger("Refreshed assistant response via final DOM snapshot");
              turnAnswerText = finalText;
              turnAnswerMarkdown = finalText;
            },
          );
        }
      }

      // Detect prompt echo using normalized comparison (whitespace-insensitive).
      const alignedEcho = alignPromptEchoPair(
        turnAnswerText,
        turnAnswerMarkdown,
        promptEchoMatcher,
        copiedMarkdown ? logger : undefined,
        {
          text: "Aligned assistant response text to copied markdown after prompt echo",
          markdown: "Aligned assistant markdown to response text after prompt echo",
        },
      );
      turnAnswerText = alignedEcho.answerText;
      turnAnswerMarkdown = alignedEcho.answerMarkdown;
      const isPromptEcho = alignedEcho.isEcho;
      if (isPromptEcho) {
        logger("Detected prompt echo in response; waiting for actual assistant response...");
        const deadline = Date.now() + 15_000;
        let bestText: string | null = null;
        let bestMeta: CapturedAssistantMeta | null = null;
        let stableCount = 0;
        while (Date.now() < deadline) {
          const snapshot = await readAssistantSnapshot(
            Runtime,
            baselineTurns ?? undefined,
            expectedConversationId(),
          ).catch(() => null);
          const text = typeof snapshot?.text === "string" ? snapshot.text.trim() : "";
          const isStillEcho = !text || Boolean(promptEchoMatcher?.isEcho(text));
          if (!isStillEcho) {
            if (!bestText || text.length > bestText.length) {
              bestText = text;
              bestMeta = {
                turnId: snapshot?.turnId ?? undefined,
                messageId: snapshot?.messageId ?? undefined,
              };
              stableCount = 0;
            } else if (text === bestText) {
              stableCount += 1;
            }
            if (stableCount >= 2) {
              break;
            }
          }
          await new Promise((resolve) => setTimeout(resolve, 300));
        }
        if (bestText) {
          await applyBoundAssistantSnapshotReplacement(Runtime, bestMeta ?? {}, logger, () => {
            logger("Recovered assistant response after detecting prompt echo");
            turnAnswerText = bestText;
            turnAnswerMarkdown = bestText;
          });
        }
      }
      const minAnswerChars = 16;
      if (turnAnswerText.trim().length > 0 && turnAnswerText.trim().length < minAnswerChars) {
        const deadline = Date.now() + 12_000;
        let bestText = turnAnswerText.trim();
        let bestMeta: CapturedAssistantMeta | null = null;
        let stableCycles = 0;
        while (Date.now() < deadline) {
          const snapshot = await readAssistantSnapshot(
            Runtime,
            baselineTurns ?? undefined,
            expectedConversationId(),
          ).catch(() => null);
          const text = typeof snapshot?.text === "string" ? snapshot.text.trim() : "";
          if (text && text.length > bestText.length) {
            bestText = text;
            bestMeta = {
              turnId: snapshot?.turnId ?? undefined,
              messageId: snapshot?.messageId ?? undefined,
            };
            stableCycles = 0;
          } else {
            stableCycles += 1;
          }
          if (stableCycles >= 3 && bestText.length >= minAnswerChars) {
            break;
          }
          await delay(400);
        }
        if (bestText.length > turnAnswerText.trim().length) {
          await applyBoundAssistantSnapshotReplacement(Runtime, bestMeta ?? {}, logger, () => {
            logger("Refreshed short assistant response from latest DOM snapshot");
            turnAnswerText = bestText;
            turnAnswerMarkdown = bestText;
          });
        }
      }
      return {
        label,
        answerText: turnAnswerText,
        answerMarkdown: turnAnswerMarkdown,
        answerHtml: turnAnswerHtml,
      };
    };

    const turns: BrowserConversationTurn[] = [];
    const initialTurn = await captureAssistantTurn(promptText, "Initial response");
    turns.push(initialTurn);
    answerText = initialTurn.answerText;
    answerMarkdown = initialTurn.answerMarkdown;
    answerHtml = initialTurn.answerHtml;

    for (let index = 0; index < followUpPrompts.length; index += 1) {
      const followUpPrompt = followUpPrompts[index];
      logger(`[browser] Sending follow-up ${index + 1}/${followUpPrompts.length}`);
      await acquireProfileLockIfNeeded();
      try {
        await raceWithDisconnect(clearPromptComposer(Runtime, logger));
        await raceWithDisconnect(ensurePromptReady(Runtime, config.inputTimeoutMs, logger));
        const submission = await runSubmissionWithRecovery({
          prompt: followUpPrompt,
          attachments: [],
          desiredModel: config.desiredModel,
          submit: (submissionPrompt, submissionAttachments, submissionOptions) =>
            raceWithDisconnect(
              preserveChallengeOverPageFailure(
                submitOnce(submissionPrompt, submissionAttachments, submissionOptions),
                Runtime,
                logger,
                { accountId: options.accountId, sessionId: options.sessionId },
              ),
            ),
          reloadPromptComposer,
          prepareFallbackSubmission: async () => {
            await raceWithDisconnect(clearPromptComposer(Runtime, logger));
            await raceWithDisconnect(ensurePromptReady(Runtime, config.inputTimeoutMs, logger));
          },
          logger,
        });
        baselineTurns = submission.baselineTurns;
        baselineAssistantText = submission.baselineAssistantText;
      } finally {
        await releaseProfileLockIfHeld();
      }
      const turn = await captureAssistantTurn(followUpPrompt, `Follow-up ${index + 1}`);
      turns.push({ ...turn, prompt: followUpPrompt });
      answerText = turn.answerText;
      answerMarkdown = turn.answerMarkdown;
      answerHtml = turn.answerHtml;
    }

    if (turns.length > 1) {
      const formatted = formatBrowserTurnTranscript(turns);
      answerText = formatted.answerText;
      answerMarkdown = formatted.answerMarkdown;
      answerHtml = "";
    }
    if (connectionClosedUnexpectedly) {
      // Bail out on mid-run disconnects so the session stays reattachable.
      throw new Error("Chrome disconnected before completion");
    }
    const imageArtifacts = await collectGeneratedImageArtifacts({
      Browser: client.Browser,
      Client: client,
      Page,
      Runtime,
      Network,
      logger,
      minTurnIndex: imageArtifactMinTurnIndex,
      sessionId: options.sessionId,
      generateImagePath: options.generateImagePath,
      outputPath: options.outputPath,
      answerText,
      waitTimeoutMs: options.config?.timeoutMs,
      checkBlockingUiWarning: () =>
        throwChatGptUiWarningIfPresent({
          Runtime,
          logger,
          stage: "image-artifact-wait",
          waitTarget: "generated image artifacts",
          runtime: {
            chromePid: chrome.pid,
            chromePort: chrome.port,
            chromeHost,
            userDataDir,
            chromeTargetId: lastTargetId,
            tabUrl: lastUrl,
            conversationId: lastUrl ? extractConversationIdFromUrl(lastUrl) : undefined,
            promptSubmitted,
            controllerPid: process.pid,
          },
        }),
    });
    answerText = imageArtifacts.answerText || answerText;
    if (imageArtifacts.markdownSuffix) {
      answerMarkdown += imageArtifacts.markdownSuffix;
    }
    let fileArtifacts = await collectChatGptFileArtifacts({
      Browser: client.Browser,
      Client: client,
      Page,
      Runtime,
      Network,
      answerText: [answerText, answerMarkdown, answerHtml].filter(Boolean).join("\n"),
      logger,
      minTurnIndex: imageArtifactMinTurnIndex,
      sessionId: options.sessionId,
    });
    const savedImageArtifacts = appendArtifacts(undefined, imageArtifacts.savedImages);
    let savedBrowserArtifacts = appendArtifacts(savedImageArtifacts, fileArtifacts.savedFiles);
    const transcriptArtifact = await saveOptionalArtifact(
      () =>
        saveBrowserTranscriptArtifact({
          sessionId: options.sessionId,
          prompt: initialSubmittedPrompt,
          answerMarkdown,
          conversationUrl: lastUrl,
          artifacts: savedBrowserArtifacts,
          logger,
        }),
      logger,
    );
    fileArtifacts = await collectLateChatGptFileArtifactsFromTranscript({
      Browser: client.Browser,
      Client: client,
      Page,
      Runtime,
      Network,
      current: fileArtifacts,
      logger,
      minTurnIndex: imageArtifactMinTurnIndex,
      sessionId: options.sessionId,
      transcriptPath: transcriptArtifact?.path,
    });
    savedBrowserArtifacts = appendArtifacts(savedImageArtifacts, fileArtifacts.savedFiles);
    const savedArtifacts = appendArtifacts(savedBrowserArtifacts, [transcriptArtifact]);
    const archive = await maybeArchiveCompletedConversation({
      Runtime,
      logger,
      config,
      conversationUrl: lastUrl,
      answerText,
      followUpCount: followUpPrompts.length,
      requiredArtifactsSaved:
        Boolean(transcriptArtifact) &&
        imageArtifacts.savedImages.length === imageArtifacts.imageCount &&
        fileArtifacts.savedFiles.length === fileArtifacts.fileCount,
    });
    await raceWithDisconnect(
      assertCapturedAnswerNotAccessArtifact(
        Runtime,
        { text: answerText, html: answerHtml },
        logger,
        {
          quarantine: { accountId: options.accountId },
          sessionId: options.sessionId,
        },
      ),
    );
    expectedConversationId();
    runStatus = "complete";
    emitRunProgressMarker("done");
    const durationMs = Date.now() - startedAt;
    const answerChars = answerText.length;
    const answerTokens = estimateTokenCount(answerMarkdown);
    return {
      answerText,
      answerMarkdown,
      answerHtml: answerHtml.length > 0 ? answerHtml : undefined,
      artifacts: savedArtifacts,
      generatedImages: imageArtifacts.generatedImages,
      savedImages: imageArtifacts.savedImages,
      downloadableFiles: fileArtifacts.files,
      savedFiles: fileArtifacts.savedFiles,
      archive,
      modelSelection: modelSelectionEvidence,
      tookMs: durationMs,
      answerTokens,
      answerChars,
      chromePid: chrome.pid,
      chromePort: chrome.port,
      chromeHost,
      userDataDir,
      chromeTargetId: lastTargetId,
      tabUrl: lastUrl,
      conversationId: lastUrl ? extractConversationIdFromUrl(lastUrl) : undefined,
      promptSubmitted,
      submissionProvenance: initialSubmissionProvenance,
      controllerPid: process.pid,
    };
  } catch (error) {
    let normalizedError = error instanceof Error ? error : new Error(String(error));
    const socketClosed = connectionClosedUnexpectedly || isWebSocketClosureError(normalizedError);
    connectionClosedUnexpectedly = connectionClosedUnexpectedly || socketClosed;
    if (!socketClosed && client?.Runtime) {
      const preferred = await preferChallengeOverPageFailure(
        normalizedError,
        client.Runtime,
        logger,
        { accountId: options.accountId, sessionId: options.sessionId },
      );
      normalizedError = preferred instanceof Error ? preferred : new Error(String(preferred));
    }
    const preservedErrorKind = classifyPreservedBrowserError(normalizedError, config.headless);
    if (preservedErrorKind === "cloudflare-challenge") {
      if (usingCopiedProfile) {
        logger(
          "Cloudflare challenge detected; closing Chrome and removing the copied profile because copy-profile runs cannot be retained.",
        );
        throw new BrowserAutomationError(
          "Cloudflare challenge detected. Copy-profile runs cannot be retained; complete the check in the source Chrome profile, then manually clear the account quarantine before retrying Oracle.",
          { stage: "cloudflare-challenge", reattachable: false },
          normalizedError,
        );
      }
      preserveBrowserOnError = true;
      const runtime = {
        chromePid: chrome.pid,
        chromePort: chrome.port,
        chromeHost,
        userDataDir,
        chromeTargetId: lastTargetId,
        tabUrl: lastUrl,
        promptSubmitted,
        controllerPid: process.pid,
      };
      const reuseProfileHint =
        `oracle --engine browser --browser-manual-login ` +
        `--browser-manual-login-profile-dir ${JSON.stringify(userDataDir)}`;
      await emitRuntimeHint();
      logger("Cloudflare challenge detected; leaving browser open so you can complete the check.");
      logger(`Reuse this browser profile with: ${reuseProfileHint}`);
      throw new BrowserAutomationError(
        "Cloudflare challenge detected. Complete the “Just a moment…” check in the open browser, then manually clear the account quarantine before retrying Oracle.",
        {
          stage: "cloudflare-challenge",
          runtime,
          reuseProfileHint,
        },
        normalizedError,
      );
    }
    if (preservedErrorKind === "reattachable-capture") {
      if (usingCopiedProfile) {
        logger(
          "Assistant capture incomplete; closing Chrome and removing the copied profile because copy-profile runs cannot be reattached.",
        );
        const details =
          normalizedError instanceof BrowserAutomationError
            ? { ...normalizedError.details, runtime: undefined, reattachable: false }
            : { stage: "assistant-recheck", reattachable: false };
        throw new BrowserAutomationError(normalizedError.message, details, normalizedError);
      }
      preserveBrowserOnError = true;
      await emitRuntimeHint();
      logger("Assistant capture incomplete; leaving browser open for reattach.");
      throw normalizedError;
    }
    if (!socketClosed) {
      logger(`Failed to complete ChatGPT run: ${normalizedError.message}`);
      if ((config.debug || process.env.CHATGPT_DEVTOOLS_TRACE === "1") && normalizedError.stack) {
        logger(normalizedError.stack);
      }
      throw normalizedError;
    }
    if ((config.debug || process.env.CHATGPT_DEVTOOLS_TRACE === "1") && normalizedError.stack) {
      logger(`Chrome connection lost before completion: ${normalizedError.message}`);
      logger(normalizedError.stack);
    }
    await emitRuntimeHint();
    if (
      normalizedError instanceof BrowserAutomationError &&
      (normalizedError.details as { stage?: string } | undefined)?.stage === "connection-lost"
    ) {
      throw normalizedError;
    }
    const liveness = await probeChromeTargetLiveness({
      host: chromeHost,
      port: chrome.port,
      targetId: lastTargetId ?? isolatedTargetId,
    });
    const recoverable = isRecoverableChromeDisconnect(liveness);
    throw new BrowserAutomationError(
      connectionLostUserMessage({ recoverable }),
      {
        stage: "connection-lost",
        recoverableDisconnect: recoverable,
        disconnectCause: recoverable ? "cdp-client-disconnect" : "chrome-closed",
        runtime: {
          chromePid: chrome.pid,
          chromePort: chrome.port,
          chromeHost,
          userDataDir,
          chromeTargetId: lastTargetId,
          tabUrl: liveness.matchedUrl ?? lastUrl,
          conversationId:
            (liveness.matchedUrl ?? lastUrl)
              ? extractConversationIdFromUrl(liveness.matchedUrl ?? lastUrl ?? "")
              : undefined,
          promptSubmitted,
          controllerPid: process.pid,
        },
      },
      normalizedError,
    );
  } finally {
    await conversationUrlMonitor?.stop();
    try {
      if (!connectionClosedUnexpectedly) {
        await client?.close();
      }
    } catch {
      // ignore
    }
    // Close the isolated tab once the response has been fully captured to prevent
    // tab accumulation across repeated runs. Under the default policy, keep the
    // tab open on incomplete runs so reattach can recover the response; under
    // "always" (serve/manual-login) the owned tab closes on failure too.
    // connectionClosedUnexpectedly does NOT skip this: the close goes over a
    // fresh HTTP DevTools call, so a dead CDP socket is a close-attempt-needed
    // case, and a failed attempt latches cleanup-taint instead of silently
    // leaving the tab behind.
    const shouldCloseOwnedRunTarget = shouldCloseOwnedRunTargetAfterRun({
      runStatus,
      ownsTarget,
      keepBrowser: effectiveKeepBrowser,
      closeOwnedTabOnComplete: options.closeOwnedTabOnComplete,
      policy: resolveCloseOwnedRunTargetPolicy(config),
      orphanedTargetNeedsCleanup,
      preserveOwnedTargetOnError: preserveBrowserOnError,
    });
    if (shouldCloseOwnedRunTarget && isolatedTargetId && chrome?.port) {
      const safeToClose =
        !effectiveKeepBrowser ||
        Boolean(
          await ensureChromePageTargetAfterClose(chrome.port, isolatedTargetId, logger, chromeHost),
        );
      if (!safeToClose) {
        ownedTargetCleanupProved = false;
        logger(
          "[browser] Leaving completed browser tab open because Chrome has no replacement page target.",
        );
      } else {
        const closeOwnedRunTab = async (isolatedTargetId: string): Promise<boolean> => {
          return await closeTab(chrome.port, isolatedTargetId, logger, chromeHost);
        };
        ownedTargetCleanupProved = await closeOwnedTargetWithDeadline(
          closeOwnedRunTab(isolatedTargetId),
          logger,
          {
            targetId: isolatedTargetId,
          },
        );
        if (!ownedTargetCleanupProved && effectiveKeepBrowser) {
          const replacementTargetId = await createChromePageTarget(chrome.port, logger, chromeHost);
          if (!replacementTargetId) {
            logger(
              `[browser] Chrome page retention could not be verified after closing ${isolatedTargetId}.`,
            );
          }
        }
      }
    }
    let keepBrowserOpen = shouldKeepLocalBrowserOpen({
      effectiveKeepBrowser,
      preserveBrowserOnError,
      usingCopiedProfile,
    });
    let cleanupProfileLock: ProfileRunLock | null = null;
    let terminatedRecordedChrome = false;
    const hasOtherActiveLeases = async () => {
      if (!manualLogin || !tabLease) {
        return false;
      }
      // Always re-read the registry: this gate is called both before and
      // after cleanupProfileLock is acquired, and a lease landscape that was
      // empty at the first call can gain a concurrent worker's lease by the
      // second. Memoizing across that boundary would let a stale "no other
      // leases" result survive into the Chrome-termination decision and
      // SIGTERM a Chrome another lane just started using. The registry read
      // itself is already lock-protected internally, so there's no
      // correctness reason to cache it here.
      return await hasOtherActiveBrowserTabLeases(userDataDir, tabLease.id);
    };
    if (!keepBrowserOpen && manualLogin && tabLease) {
      const cleanupLockTimeoutMs = Math.max(0, config.profileLockTimeoutMs ?? 0);
      if (cleanupLockTimeoutMs > 0) {
        cleanupProfileLock = await acquireProfileRunLock(userDataDir, {
          timeoutMs: cleanupLockTimeoutMs,
          logger,
          sessionId: options.sessionId,
        }).catch(() => null);
      }
      // Fail CLOSED at the Chrome-termination gate: a registry fault must read
      // as "other leases may be active" so a shared Chrome is never killed on
      // unverifiable evidence (matches the blank-tab gate above).
      keepBrowserOpen = await hasOtherActiveLeases().catch(() => true);
      if (keepBrowserOpen) {
        logger("[browser] Other ChatGPT tab leases still active; leaving shared Chrome running.");
      } else if (reusedChrome && !connectionClosedUnexpectedly) {
        terminatedRecordedChrome = await terminateRecordedChromeForProfile(
          userDataDir,
          logger,
        ).catch(() => false);
      }
    }
    const cleanupBlankTabs = async (): Promise<void> => {
      if (
        !shouldCleanupBlankTabsAfterLastLease({
          runStatus,
          ownsTarget,
          connectionClosedUnexpectedly,
          manualLogin,
          keepBrowser: effectiveKeepBrowser,
          chromePort: chrome?.port,
        }) ||
        !chrome?.port
      ) {
        return;
      }
      // This runs only from the release callback after `isLastLease` proves,
      // under the registry lock, that no valid or opaque peer lease remains.
      // That stronger gate subsumes the old best-effort snapshot of peer
      // target IDs: a mid-startup unattributed peer now blocks the sweep
      // instead of merely contributing an exclusion candidate.
      await closeBlankChromeTabs(chrome.port, logger, chromeHost, {
        excludeTargetIds: [isolatedTargetId, lastTargetId],
        preserveOneBlank: true,
      });
    };
    const retainPreservedOwnedTargetLease = shouldRetainBrowserTabLeaseAfterRun({
      runStatus,
      ownsTarget,
      preserveOwnedTargetOnError: preserveBrowserOnError,
      orphanedTargetNeedsCleanup,
    });
    if (tabLease && retainPreservedOwnedTargetLease) {
      logger(
        `[browser] Keeping ChatGPT browser slot ${tabLease.id.slice(0, 8)} active with its preserved owned target.`,
      );
    } else if (tabLease && ownedTargetCleanupProved) {
      const handle = tabLease;
      tabLease = null;
      await releaseBrowserTabLeaseOrTaint(handle, logger, "browser run cleanup", {
        onRelease: async ({ isLastLease }) => {
          if (isLastLease) {
            await cleanupBlankTabs();
          }
        },
      });
    } else if (tabLease) {
      logger(
        `[browser] Keeping ChatGPT browser slot ${tabLease.id.slice(0, 8)} active because owned-target cleanup was not proved.`,
      );
    } else {
      await cleanupBlankTabs();
    }
    removeDialogHandler?.();
    removeTerminationHooks?.();
    removeAbortListener?.();
    removeAbortListener = null;
    if (!keepBrowserOpen) {
      if (!connectionClosedUnexpectedly) {
        try {
          if (!terminatedRecordedChrome) {
            await chrome.kill();
          }
        } catch {
          // ignore kill failures
        }
      }
      if (manualLogin) {
        const shouldCleanup = await shouldCleanupManualLoginProfileState(
          userDataDir,
          logger.verbose ? logger : undefined,
          {
            connectionClosedUnexpectedly,
            host: chromeHost,
          },
        );
        if (shouldCleanup) {
          // Preserve the persistent manual-login profile, but clear stale reattach hints.
          await cleanupStaleProfileState(userDataDir, logger, { lockRemovalMode: "never" }).catch(
            () => undefined,
          );
        }
      } else {
        await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
      }
      if (!connectionClosedUnexpectedly) {
        const totalSeconds = (Date.now() - startedAt) / 1000;
        logger(`Cleanup ${runStatus} • ${totalSeconds.toFixed(1)}s total`);
      }
    } else {
      detachKeptChromeProcess(chrome);
      if (!connectionClosedUnexpectedly) {
        logger(`Chrome left running on port ${chrome.port} with profile ${userDataDir}`);
      }
    }
    if (cleanupProfileLock) {
      const handle = cleanupProfileLock;
      cleanupProfileLock = null;
      await handle.release().catch(() => undefined);
    }
  }
}

const DEFAULT_DEBUG_PORT = 9222;

async function pickAvailableDebugPort(
  preferredPort: number,
  logger: BrowserLogger,
): Promise<number> {
  const start =
    Number.isFinite(preferredPort) && preferredPort > 0 ? preferredPort : DEFAULT_DEBUG_PORT;
  for (let offset = 0; offset < 10; offset++) {
    const candidate = start + offset;
    if (await isPortAvailable(candidate)) {
      return candidate;
    }
  }
  const fallback = await findEphemeralPort();
  logger(`DevTools ports ${start}-${start + 9} are occupied; falling back to ${fallback}.`);
  return fallback;
}

async function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "127.0.0.1");
  });
}

async function findEphemeralPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", (error) => {
      server.close();
      reject(error);
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address && typeof address === "object") {
        const port = address.port;
        server.close(() => resolve(port));
      } else {
        server.close(() => reject(new Error("Failed to acquire ephemeral port")));
      }
    });
  });
}

async function waitForLogin({
  runtime,
  logger,
  appliedCookies,
  manualLogin,
  timeoutMs,
  profileDir,
  keepBrowser,
}: {
  runtime: ChromeClient["Runtime"];
  logger: BrowserLogger;
  appliedCookies: number;
  manualLogin: boolean;
  timeoutMs: number;
  profileDir?: string;
  keepBrowser?: boolean;
}): Promise<void> {
  if (!manualLogin) {
    await ensureLoggedIn(runtime, logger, { appliedCookies });
    return;
  }
  const waitMs = resolveManualLoginWaitMs(timeoutMs, Boolean(keepBrowser));
  const deadline = Date.now() + waitMs;
  let lastNotice = 0;
  while (Date.now() < deadline) {
    try {
      await ensureLoggedIn(runtime, logger, { appliedCookies });
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const loginDetected = message?.toLowerCase().includes("login button");
      const sessionMissing = message?.toLowerCase().includes("session not detected");
      if (!loginDetected && !sessionMissing) {
        throw error;
      }
      const now = Date.now();
      if (now - lastNotice > 5000) {
        logger(
          "Manual login mode: please sign into chatgpt.com in the opened Chrome window; waiting for session to appear...",
        );
        lastNotice = now;
      }
      await delay(1000);
    }
  }
  const setupCommand = formatManualLoginSetupCommand(profileDir ?? defaultManualLoginProfileDir());
  throw new Error(
    "Manual login mode timed out waiting for ChatGPT session. " +
      `Browser mode is using Oracle's private Chrome profile at ${profileDir ?? "(default profile)"}, not your normal Chrome profile. ` +
      `Run first-time setup, sign in there, then retry: ${setupCommand}`,
  );
}

async function maybeRecoverLongAssistantResponse({
  runtime,
  baselineTurns,
  expectedConversationId,
  answerText,
  answerMarkdown,
  logger,
  allowMarkdownUpdate,
  wait = delay,
}: {
  runtime: ChromeClient["Runtime"];
  baselineTurns: number | null;
  expectedConversationId?: string;
  answerText: string;
  answerMarkdown: string;
  logger: BrowserLogger;
  allowMarkdownUpdate: boolean;
  wait?: (ms: number) => Promise<void>;
}): Promise<{ answerText: string; answerMarkdown: string }> {
  // Learned: long streaming responses can still be rendering after initial capture.
  // Add a brief delay and re-poll to catch any additional content (#71).
  const capturedLength = answerText.trim().length;
  if (capturedLength <= 500) {
    return { answerText, answerMarkdown };
  }

  await wait(1500);
  let bestLength = capturedLength;
  let bestText = answerText;
  let bestMeta: AssistantAnswer["meta"] | null = null;
  for (let i = 0; i < 5; i++) {
    const laterSnapshot = await readAssistantSnapshot(
      runtime,
      baselineTurns ?? undefined,
      expectedConversationId,
    ).catch(() => null);
    const laterText = typeof laterSnapshot?.text === "string" ? laterSnapshot.text.trim() : "";
    if (laterText.length > bestLength) {
      bestLength = laterText.length;
      bestText = laterText;
      bestMeta = {
        turnId: laterSnapshot?.turnId ?? undefined,
        messageId: laterSnapshot?.messageId ?? undefined,
      };
      await wait(800); // More content appeared, keep waiting
    } else {
      break; // Stable, stop polling
    }
  }
  if (bestLength > capturedLength) {
    // This text replaces an answer that already passed structural validation,
    // so the replacement must independently prove it is still the response to
    // this run's submitted user message on the bound conversation.
    await assertCapturedAssistantResponseBound(runtime, bestMeta ?? {}, logger);
    logger(`Recovered ${bestLength - capturedLength} additional chars via delayed re-read`);
    return {
      answerText: bestText,
      answerMarkdown: allowMarkdownUpdate ? bestText : answerMarkdown,
    };
  }
  return { answerText, answerMarkdown };
}

async function _assertNavigatedToHttp(
  runtime: ChromeClient["Runtime"],
  _logger: BrowserLogger,
  timeoutMs = 10_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let lastUrl = "";
  while (Date.now() < deadline) {
    const { result } = await runtime.evaluate({
      expression: 'typeof location === "object" && location.href ? location.href : ""',
      returnByValue: true,
    });
    const url = typeof result?.value === "string" ? result.value : "";
    lastUrl = url;
    if (/^https?:\/\//i.test(url)) {
      return url;
    }
    await delay(250);
  }
  throw new BrowserAutomationError("ChatGPT session not detected; page never left new tab.", {
    stage: "execute-browser",
    details: { url: lastUrl || "(empty)" },
  });
}

export type BrowserChrome = LaunchedChrome & { host?: string };

function detachKeptChromeProcess(chrome: Pick<LaunchedChrome, "process">): void {
  try {
    chrome.process?.unref();
  } catch {
    // Best-effort only; cleanup should not mask the original browser result.
  }
}

export async function acquireManualLoginChromeForRun(
  userDataDir: string,
  config: ReturnType<typeof resolveBrowserConfig>,
  logger: BrowserLogger,
  sessionId?: string,
  deps: {
    maybeReuse?: typeof maybeReuseRunningChrome;
    launch?: typeof launchChrome;
  } = {},
): Promise<{ chrome: BrowserChrome; reusedChrome: LaunchedChrome | null }> {
  const maybeReuse = deps.maybeReuse ?? maybeReuseRunningChrome;
  const launch = deps.launch ?? launchChrome;
  const lockTimeoutMs = Math.max(0, config.profileLockTimeoutMs ?? 0);
  let launchLock: ProfileRunLock | null = null;

  if (lockTimeoutMs > 0) {
    launchLock = await acquireProfileRunLock(userDataDir, {
      timeoutMs: lockTimeoutMs,
      logger,
      sessionId,
    });
  }

  try {
    const reusedChrome = await maybeReuse(userDataDir, logger, {
      waitForPortMs: config.reuseChromeWaitMs,
    });
    const chrome =
      reusedChrome ??
      (await launch(
        {
          ...config,
          remoteChrome: config.remoteChrome,
        },
        userDataDir,
        logger,
      ));

    // Persist while the launch lock is still held so parallel callers reuse
    // this Chrome instead of racing to start another one on the same profile.
    if (chrome.port) {
      await writeDevToolsActivePort(userDataDir, chrome.port);
      if (!reusedChrome && chrome.pid) {
        await writeChromePid(userDataDir, chrome.pid, chrome.port);
      }
    }

    return { chrome, reusedChrome };
  } finally {
    if (launchLock) {
      await launchLock.release().catch(() => undefined);
    }
  }
}

async function maybeReuseRunningChrome(
  userDataDir: string,
  logger: BrowserLogger,
  options: {
    waitForPortMs?: number;
    probe?: typeof verifyDevToolsReachable;
    verifyOwner?: typeof verifyChromeDebugTargetOwner;
  } = {},
): Promise<LaunchedChrome | null> {
  const waitForPortMs = Math.max(0, options.waitForPortMs ?? 0);
  let port = await readDevToolsPort(userDataDir);
  if (!port && waitForPortMs > 0) {
    const deadline = Date.now() + waitForPortMs;
    logger(`Waiting up to ${formatElapsed(waitForPortMs)} for shared Chrome to appear...`);
    while (!port && Date.now() < deadline) {
      await delay(250);
      port = await readDevToolsPort(userDataDir);
    }
  }
  let pid = await readChromePid(userDataDir);
  if (!port) {
    const discovered = await findRunningChromeDebugTargetForProfile(userDataDir);
    if (!discovered) {
      if (pid) {
        logger(
          `No reachable Chrome DevTools target found for ${userDataDir}; clearing stale profile state before launching new Chrome.`,
        );
        await cleanupStaleProfileState(userDataDir, logger, {
          lockRemovalMode: "if_oracle_pid_dead",
        });
      }
      return null;
    }
    const discoveredOwner = await (options.verifyOwner ?? verifyChromeDebugTargetOwner)(
      userDataDir,
      discovered.port,
      { allowProcessDiscovery: true },
    );
    if (!discoveredOwner.ok || discoveredOwner.pid !== discovered.pid) {
      logger(
        `Discovered Chrome for ${userDataDir} failed owner verification (${discoveredOwner.ok ? "pid-mismatch" : discoveredOwner.reason}); launching new Chrome.`,
      );
      return null;
    }
    const discoveredProbe = await (options.probe ?? verifyDevToolsReachable)({
      port: discovered.port,
    });
    if (!discoveredProbe.ok) {
      logger(
        `Discovered Chrome for ${userDataDir} on port ${discovered.port} but it was unreachable (${discoveredProbe.error}); launching new Chrome.`,
      );
      await cleanupStaleProfileState(userDataDir, logger, {
        lockRemovalMode: "if_oracle_pid_dead",
      });
      return null;
    }
    await writeDevToolsActivePort(userDataDir, discovered.port);
    await writeChromePid(userDataDir, discovered.pid, discovered.port);
    port = discovered.port;
    pid = discovered.pid;
    logger(
      `Discovered running Chrome for ${userDataDir}; reusing (DevTools port ${port}, pid ${pid})`,
    );
    return {
      port,
      pid,
      kill: async () => {},
      process: undefined,
    } as unknown as LaunchedChrome;
  }

  const owner = await (options.verifyOwner ?? resolveChromeDebugTargetOwner)(userDataDir, port, {
    allowProcessDiscovery: true,
  });
  if (!owner.ok) {
    logger(
      `DevToolsActivePort found for ${userDataDir} but owner verification failed (${owner.reason}); refusing to attach.`,
    );
    return null;
  }
  const recordedPort = port;
  port = owner.port;
  const probe = await (options.probe ?? verifyDevToolsReachable)({ port });
  if (!probe.ok) {
    logger(
      `DevToolsActivePort found for ${userDataDir} but unreachable (${probe.error}); launching new Chrome.`,
    );
    // Safe cleanup: remove stale DevToolsActivePort; only remove lock files if this was an Oracle-owned pid that died.
    await cleanupStaleProfileState(userDataDir, logger, { lockRemovalMode: "if_oracle_pid_dead" });
    return null;
  }
  if (owner.source === "process-discovery" || port !== recordedPort) {
    await writeDevToolsActivePort(userDataDir, port);
    await writeChromePid(userDataDir, owner.pid, port);
  }

  logger(
    `Found running Chrome for ${userDataDir}; reusing (DevTools port ${port}, pid ${owner.pid})`,
  );
  return {
    port,
    pid: owner.pid,
    kill: async () => {},
    process: undefined,
  } as unknown as LaunchedChrome;
}

// Poll for the ChatGPT /c/<id> conversation URL until it appears, the caller
// stops the loop, or the timeout elapses. Mirrors the local-mode background
// conversation hint loop so killed runs leave a recoverable URL in metadata.
async function pollConversationUrl(args: {
  readUrl: () => Promise<string | null | undefined>;
  onConversationUrl: (url: string) => Promise<void>;
  isStopped?: () => boolean;
  timeoutMs?: number;
  pollIntervalMs?: number;
  delayFn?: (ms: number) => Promise<void>;
}): Promise<boolean> {
  const timeoutMs = args.timeoutMs ?? 10_000;
  const pollIntervalMs = args.pollIntervalMs ?? 250;
  const wait = args.delayFn ?? delay;
  const start = Date.now();
  while (!(args.isStopped?.() ?? false) && Date.now() - start < timeoutMs) {
    try {
      const url = await args.readUrl();
      if (url && isConversationUrl(url)) {
        await args.onConversationUrl(url);
        return true;
      }
    } catch {
      // ignore; keep polling until timeout
    }
    await wait(pollIntervalMs);
  }
  return false;
}

export async function pollConversationUrlForTest(
  args: Parameters<typeof pollConversationUrl>[0],
): Promise<boolean> {
  return pollConversationUrl(args);
}

async function runRemoteBrowserMode(
  promptText: string,
  attachments: BrowserAttachment[],
  config: ReturnType<typeof resolveBrowserConfig>,
  logger: BrowserLogger,
  options: BrowserRunOptions,
): Promise<BrowserRunResult> {
  const remoteChromeConfig = config.remoteChrome;
  if (!remoteChromeConfig) {
    throw new Error(
      "Remote Chrome configuration missing. Pass --remote-chrome <host:port> to use this mode.",
    );
  }
  const { host, port } = remoteChromeConfig;
  logger(`Connecting to remote Chrome at ${host}:${port}`);

  let client: ChromeClient | null = null;
  let remoteTargetId: string | null = null;
  let tabLease: BrowserTabLease | null = null;
  let lastUrl: string | undefined = config.resumeConversationUrl || undefined;
  let canonicalConversationId = extractConversationIdFromUrl(config.resumeConversationUrl ?? "");
  let conversationIdentityConflict: BrowserAutomationError | null = null;
  let promptSubmitted = false;
  let submissionProvenance: BrowserSubmissionProvenance | undefined;
  let modelSelectionEvidence: BrowserModelSelectionEvidence | undefined;
  let attachedExistingTab = false;
  let ownsTarget = true;
  let orphanedTargetNeedsCleanup = false;
  let conversationUrlMonitor: ConversationUrlMonitor | null = null;
  const runtimeHintCb = options.runtimeHintCb;
  const emitRuntimeHint = async (
    overrides: {
      promptSubmitted?: boolean;
      submissionProvenance?: BrowserSubmissionProvenance;
      strict?: boolean;
    } = {},
  ) => {
    try {
      await runtimeHintCb?.(
        {
          chromePort: port,
          chromeHost: host,
          chromeBrowserWSEndpoint: browserWSEndpoint,
          chromeProfileRoot,
          chromeTargetId: remoteTargetId ?? undefined,
          tabUrl: lastUrl,
          conversationId: lastUrl ? extractConversationIdFromUrl(lastUrl) : undefined,
          promptSubmitted: overrides.promptSubmitted ?? promptSubmitted,
          submissionProvenance: overrides.submissionProvenance ?? submissionProvenance,
          controllerPid: process.pid,
        },
        modelSelectionEvidence,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger(`Failed to persist runtime hint: ${message}`);
      if (overrides.strict) {
        throw new BrowserAutomationError(
          "Could not persist the pre-dispatch runtime boundary; refusing to submit.",
          {
            stage: "submit-prompt",
            code: "runtime-hint-persistence-failed-before-submit",
            retryable: true,
            runtime: { promptSubmitted: false },
          },
          error,
        );
      }
    }
    try {
      await tabLease?.update({
        chromeHost: host,
        chromePort: port,
        chromeTargetId: remoteTargetId ?? undefined,
        tabUrl: lastUrl,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger(`Failed to update browser tab lease: ${message}`);
    }
  };
  const observeConversationUrl = async (
    observedUrl: string,
    label: string,
    emit = true,
  ): Promise<void> => {
    const decision = decideConversationUrlAdoption(canonicalConversationId, observedUrl);
    if (decision.kind === "conflict") {
      const error = new BrowserAutomationError(
        `ChatGPT conversation identity changed from ${decision.expectedConversationId} to ${decision.observedConversationId} (${label}). Refusing cross-conversation capture.`,
        {
          stage: "capture-binding",
          code: "capture-binding-conversation-changed",
          expectedConversationId: decision.expectedConversationId,
          observedConversationId: decision.observedConversationId,
        },
      );
      conversationIdentityConflict = error;
      logger(`[browser] ${error.message}`);
      throw error;
    }
    if (decision.kind === "noncanonical") {
      if (!canonicalConversationId) lastUrl = observedUrl;
    } else {
      canonicalConversationId = decision.conversationId;
      lastUrl = observedUrl;
    }
    if (emit) await emitRuntimeHint();
  };
  const expectedConversationId = (): string | undefined => {
    if (conversationIdentityConflict) throw conversationIdentityConflict;
    return canonicalConversationId;
  };
  const markPromptAttemptStarted = async (attemptedPrompt: string): Promise<void> => {
    try {
      // Invalidate the prior turn's digest before ANY failure point in a new
      // multi-turn attempt. Otherwise a pre-dispatch follow-up failure could
      // mint recovery for the already-finished previous turn and falsely mark
      // the requested multi-turn run complete.
      await options.submittedPromptPreviewCb?.(
        buildPromptRecoveryOwnershipPreview(attemptedPrompt),
      );
    } catch (error) {
      throw new BrowserAutomationError(
        "Could not invalidate the prior prompt recovery binding before submission; refusing to dispatch a prompt that could be recovered as the wrong turn.",
        {
          stage: "submit-prompt",
          code: "prompt-ownership-invalidation-failed",
          retryable: true,
          runtime: { promptSubmitted: false },
        },
        error,
      );
    }
  };
  const markPromptSubmitted = async (provenance: BrowserSubmissionProvenance): Promise<void> => {
    const firstSubmission = !promptSubmitted;
    if (!firstSubmission) {
      return;
    }
    await emitRuntimeHint({
      promptSubmitted: true,
      submissionProvenance: provenance,
      strict: true,
    });
    promptSubmitted = true;
    submissionProvenance = provenance;
    void conversationUrlMonitor?.schedule("post-submit", config.timeoutMs ?? 120_000);
  };
  const markPromptBound = async (
    submittedPrompt: string,
    binding: SubmittedUserMessageBinding,
  ): Promise<void> => {
    if (binding.quality !== "message-handle" || !binding.promptDomSha256) return;
    try {
      await options.submittedPromptPreviewCb?.(
        buildPromptRecoveryOwnershipPreview(submittedPrompt),
        binding.promptDomSha256,
      );
    } catch (error) {
      throw new BrowserAutomationError(
        "The prompt was submitted, but Oracle could not persist its DOM ownership proof; refusing to continue with ambiguous recovery state.",
        {
          stage: "capture-binding",
          code: "prompt-ownership-binding-persistence-failed",
          retryable: false,
          runtime: { promptSubmitted: true },
        },
        error,
      );
    }
  };
  // Event-emission only: one-shot run_progress.v1 markers at lifecycle
  // boundaries, gated by the same knob as the heartbeat monitor (the
  // `--run-progress` flag OR ORACLE_RUN_PROGRESS_JSON). Every emission is
  // internally guarded so a sink failure can never throw into the run path.
  const runProgressEnabled = options.runProgress === true || shouldEmitBrowserRunProgress();
  const emitRunProgressMarker = (marker: BrowserRunProgressMarker): void => {
    emitBrowserRunProgressMarker(marker, {
      runId: options.sessionId ?? "browser",
      enabled: runProgressEnabled,
      onError: (error) =>
        logger(
          `[browser] run_progress marker (${marker}) emission failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ),
    });
  };
  const startedAt = Date.now();
  let answerText = "";
  let answerMarkdown = "";
  let answerHtml = "";
  let connectionClosedUnexpectedly = false;
  let runStatus: "attempted" | "complete" = "attempted";
  let preserveOwnedTargetOnError = false;
  let stopThinkingMonitor: (() => void) | null = null;
  let removeDialogHandler: (() => void) | null = null;
  let ownedTargetCleanupProved = true;
  let connection: Awaited<ReturnType<typeof connectToRemoteChrome>> | null = null;
  const browserWSEndpoint = config.remoteChromeBrowserWSEndpoint ?? undefined;
  const chromeProfileRoot = config.remoteChromeProfileRoot ?? undefined;
  let removeAbortListener: (() => void) | null = () => {};

  try {
    const remoteLeaseProfileDir = config.browserTabRef
      ? null
      : resolveRemoteTabLeaseProfileDir(config);
    if (remoteLeaseProfileDir) {
      await mkdir(remoteLeaseProfileDir, { recursive: true });
      try {
        tabLease = await acquireBrowserTabLease(remoteLeaseProfileDir, {
          maxConcurrentTabs: config.maxConcurrentTabs,
          timeoutMs: config.queueTimeoutMs,
          logger,
          sessionId: options.sessionId,
          chromeHost: host,
          chromePort: port,
          signal: options.signal,
        });
      } catch (error) {
        await rollbackOrphanedBrowserTabLeaseAcquisition(
          error,
          logger,
          "remote browser acquisition rollback",
        );
        throw error;
      }
    }
    if (config.browserTabRef) {
      const attached = await connectToExistingChatGptTab({
        host,
        port,
        ref: config.browserTabRef,
      });
      client = attached.client;
      remoteTargetId = attached.targetId ?? null;
      if (attached.tab.url) {
        await observeConversationUrl(attached.tab.url, "attached-remote-tab", false);
      }
      attachedExistingTab = true;
      ownsTarget = false;
      logger(
        `Attached to existing remote ChatGPT tab ${attached.targetId}${attached.tab.url ? ` (${attached.tab.url})` : ""}`,
      );
    } else {
      try {
        connection = await connectToRemoteChrome(
          host,
          port,
          logger,
          "about:blank",
          browserWSEndpoint,
          {
            approvalWaitMs: config.attachRunning && browserWSEndpoint ? 20_000 : undefined,
          },
        );
      } catch (error) {
        if (error instanceof OrphanedChromeTargetError) {
          remoteTargetId = error.targetId;
          orphanedTargetNeedsCleanup = true;
          logger(
            `[browser] Remote isolated target ${error.targetId} survived its first rollback close; retrying bounded cleanup before releasing its tab lease.`,
          );
        }
        throw error;
      }
      client = connection.client;
      remoteTargetId = connection.targetId ?? null;
      ownsTarget = true;
    }
    if (tabLease && remoteTargetId) {
      await tabLease.update({
        chromeHost: host,
        chromePort: port,
        chromeTargetId: remoteTargetId,
      });
    }
    await emitRuntimeHint();
    const markConnectionLost = () => {
      connectionClosedUnexpectedly = true;
    };
    client.on("disconnect", markConnectionLost);
    // Mirrors the local (attach/launch) path's abort race so a caller
    // disconnect/abort during a remote-chrome run can actually terminate the
    // run instead of being silently ignored (oracle-router-6rx). Latent today
    // (serve strips remoteChrome before it reaches this layer), but must not
    // be a booby trap if that option is ever re-enabled.
    const abortPromise = new Promise<never>((_, reject) => {
      const signal = options.signal;
      if (!signal) {
        return;
      }
      const rejectAborted = () => {
        logger("Caller disconnected; aborting run at the next wait point.");
        // promptSubmitted is read at abort time so the typed class reflects
        // whether the Send boundary was crossed.
        reject(buildClientAbortError(promptSubmitted));
      };
      if (signal.aborted) {
        rejectAborted();
        return;
      }
      signal.addEventListener("abort", rejectAborted, { once: true });
      removeAbortListener = () => signal.removeEventListener("abort", rejectAborted);
    });
    // Keep the rejection handled even if no wait is currently racing it.
    void abortPromise.catch(() => undefined);
    const raceWithAbort = <T>(promise: Promise<T>): Promise<T> =>
      Promise.race([promise, abortPromise]);
    const { Network, Page, Runtime, Input, DOM, Target } = client;

    const domainEnablers = [Network.enable({}), Page.enable(), Runtime.enable()];
    if (DOM && typeof DOM.enable === "function") {
      domainEnablers.push(DOM.enable());
    }
    await Promise.all(domainEnablers);
    removeDialogHandler = installJavaScriptDialogAutoDismissal(Page, logger);
    // Remote targets typically live in background or occluded windows where
    // ChatGPT drops synthetic send clicks (rendering/focus throttling). Emulate
    // focus so the page behaves like a foreground tab, matching local mode.
    await enableFocusEmulation(client, logger, "remote target");
    const activeConversationUrlMonitor = createConversationUrlMonitor({
      readUrl: async () => {
        const { result } = await Runtime.evaluate({
          expression: "location.href",
          returnByValue: true,
        });
        return typeof result?.value === "string" ? result.value : null;
      },
      persistUrl: async (url) => observeConversationUrl(url, "conversation-url-monitor"),
      logger,
    });
    conversationUrlMonitor = activeConversationUrlMonitor;

    // Skip cookie sync for remote Chrome - it already has cookies
    logger("Skipping cookie sync for remote Chrome (using existing session)");
    await clearStaleChatGptConversationCookies(Network, Target, logger, {
      preserveConversationIds: [
        extractConversationIdFromUrl(config.resumeConversationUrl ?? ""),
        extractConversationIdFromUrl(lastUrl ?? ""),
      ],
    });

    if (config.resumeConversationUrl) {
      await raceWithAbort(navigateToChatGPT(Page, Runtime, config.resumeConversationUrl, logger));
    } else if (!attachedExistingTab) {
      await raceWithAbort(navigateToChatGPT(Page, Runtime, config.url, logger));
    }
    await raceWithAbort(
      ensureNotBlocked(Runtime, config.headless, logger, {
        quarantine: { accountId: options.accountId },
        sessionId: options.sessionId,
      }),
    );
    await raceWithAbort(
      preserveChallengeOverPageFailure(
        (async () => {
          await ensureLoggedIn(Runtime, logger, { remoteSession: true });
          await ensurePromptReady(Runtime, config.inputTimeoutMs, logger);
        })(),
        Runtime,
        logger,
        { accountId: options.accountId, sessionId: options.sessionId },
      ),
    );
    if (config.resumeConversationUrl) {
      await raceWithAbort(
        waitForResumedConversationHydration(Runtime, config.inputTimeoutMs, logger, {
          requirePriorTurns: true,
          expectedConversationUrl: config.resumeConversationUrl,
        }),
      );
    }
    const chatMode = await ensureChatMode(Runtime, Input, config.inputTimeoutMs, logger, {
      resetWorkConversation:
        attachedExistingTab && !config.resumeConversationUrl
          ? async () => {
              await navigateToChatGPT(Page, Runtime, config.url, logger);
              await ensureNotBlocked(Runtime, config.headless, logger);
              await ensurePromptReady(Runtime, config.inputTimeoutMs, logger);
            }
          : undefined,
    });
    if (chatMode === "switched") {
      await ensurePromptReady(Runtime, config.inputTimeoutMs, logger);
    }
    logger(
      `Prompt textarea ready (initial focus, ${promptText.length.toLocaleString()} chars queued)`,
    );
    try {
      const { result } = await Runtime.evaluate({
        expression: "location.href",
        returnByValue: true,
      });
      if (typeof result?.value === "string") {
        await observeConversationUrl(result.value, "runtime-snapshot", false);
      }
      await emitRuntimeHint();
    } catch {
      // ignore
    }

    const modelStrategy = config.modelStrategy ?? DEFAULT_MODEL_STRATEGY;
    if (
      config.desiredModel &&
      modelStrategy !== "ignore" &&
      (!config.resumeConversationUrl || isDesiredGpt56SolModel(config.desiredModel))
    ) {
      const selectModel = () =>
        raceWithAbort(
          withRetries(
            () =>
              ensureModelSelection(Runtime, config.desiredModel as string, logger, modelStrategy),
            {
              retries: 2,
              delayMs: 300,
              onRetry: (attempt, error) => {
                if (options.verbose) {
                  logger(
                    `[retry] Model picker attempt ${attempt + 1}: ${error instanceof Error ? error.message : error}`,
                  );
                }
              },
            },
          ),
        );
      modelSelectionEvidence = await selectInitialModelWithRefreshRecovery({
        selectModel,
        refreshPage: async () => {
          await raceWithAbort(Page.reload({ ignoreCache: true }));
          await raceWithAbort(
            preserveChallengeOverPageFailure(
              (async () => {
                await ensureNotBlocked(Runtime, config.headless, logger, {
                  quarantine: { accountId: options.accountId },
                  sessionId: options.sessionId,
                });
                await assertPreRunAccessState(Runtime, logger, {
                  quarantine: { accountId: options.accountId },
                  sessionId: options.sessionId,
                });
                await ensureLoggedIn(Runtime, logger, { remoteSession: true });
                await ensurePromptReady(Runtime, config.inputTimeoutMs, logger);
              })(),
              Runtime,
              logger,
              { accountId: options.accountId, sessionId: options.sessionId },
            ),
          );
        },
        allowRefresh: shouldRefreshInitialModelPicker(config),
        logger,
      });
      await raceWithAbort(
        preserveChallengeOverPageFailure(
          ensurePromptReady(Runtime, config.inputTimeoutMs, logger),
          Runtime,
          logger,
          { accountId: options.accountId, sessionId: options.sessionId },
        ),
      );
      logger(
        `Prompt textarea ready (after model switch, ${promptText.length.toLocaleString()} chars queued)`,
      );
    } else if (modelStrategy === "ignore" || config.resumeConversationUrl) {
      modelSelectionEvidence = buildSkippedModelSelectionEvidence(
        config.desiredModel,
        modelStrategy,
      );
      logger(
        config.resumeConversationUrl
          ? "Model picker: skipped (resumed conversation)"
          : "Model picker: skipped (strategy=ignore)",
      );
    }
    const deepResearch = config.researchMode === "deep";
    // Handle thinking time selection if specified. Deep Research owns its own effort flow.
    const thinkingTime = config.thinkingTime;
    if (thinkingTime && !deepResearch) {
      const thinkingTargetModel = modelStrategy === "select" ? config.desiredModel : null;
      const modeSelectionEvidence = await raceWithAbort(
        withRetries(() => ensureThinkingTime(Runtime, thinkingTime, logger, thinkingTargetModel), {
          retries: 2,
          delayMs: 300,
          onRetry: (attempt, error) => {
            if (options.verbose) {
              logger(
                `[retry] Thinking time (${thinkingTime}) attempt ${attempt + 1}: ${error instanceof Error ? error.message : error}`,
              );
            }
          },
        }),
      );
      if (modeSelectionEvidence) {
        modelSelectionEvidence = mergeModeSelectionEvidence(
          modelSelectionEvidence,
          modeSelectionEvidence,
        );
        await emitRuntimeHint();
      }
    }
    assertProtectedSolProEvidence(config.desiredModel, modelSelectionEvidence);
    const verifyProtectedRouteBeforeSubmit = async () => {
      const evidence = await verifyProtectedSolProSelectionForSubmit({
        desiredModel: config.desiredModel,
        modelStrategy,
        thinkingTime,
        selectModel: () =>
          raceWithAbort(
            withRetries(
              () => ensureModelSelection(Runtime, config.desiredModel as string, logger, "select"),
              {
                retries: 2,
                delayMs: 300,
                onRetry: (attempt, error) => {
                  if (options.verbose) {
                    logger(
                      `[retry] Pre-submit model verification attempt ${attempt + 1}: ${error instanceof Error ? error.message : error}`,
                    );
                  }
                },
              },
            ),
          ),
        selectMode: () =>
          raceWithAbort(
            withRetries(
              () => ensureThinkingTime(Runtime, "extended", logger, config.desiredModel),
              {
                retries: 2,
                delayMs: 300,
                onRetry: (attempt, error) => {
                  if (options.verbose) {
                    logger(
                      `[retry] Pre-submit Pro verification attempt ${attempt + 1}: ${error instanceof Error ? error.message : error}`,
                    );
                  }
                },
              },
            ),
          ),
      });
      if (evidence) {
        modelSelectionEvidence = evidence;
        await emitRuntimeHint();
      }
    };
    const submitOnce = async (
      prompt: string,
      submissionAttachments: BrowserAttachment[],
      submissionOptions?: BrowserSubmissionAttemptOptions,
    ) => {
      await markPromptAttemptStarted(prompt);
      const baselineSnapshot = await readAssistantSnapshot(Runtime).catch(() => null);
      const baselineAssistantText =
        typeof baselineSnapshot?.text === "string" ? baselineSnapshot.text.trim() : "";
      const attachmentNames = submissionAttachments.map((a) => path.basename(a.path));
      const attachmentExpectations = submissionAttachments.map((a) => ({
        name: path.basename(a.path),
        generatedBundle: a.generatedBundle === true,
      }));
      const attachmentBindingToken =
        submissionAttachments.length > 0 ? `oracle-attachment-${randomUUID()}` : undefined;
      await prepareSubmissionComposerWithProtectedRoute({
        hasAttachments: submissionAttachments.length > 0,
        verifyProtectedRoute: verifyProtectedRouteBeforeSubmit,
        prepareComposer: async () => {
          await raceWithAbort(clearPromptComposer(Runtime, logger));
          await raceWithAbort(ensurePromptReady(Runtime, config.inputTimeoutMs, logger));
        },
        prepareAttachments: async () => {
          if (submissionAttachments.length > 0) {
            if (!DOM) {
              throw new Error("Chrome DOM domain unavailable while uploading attachments.");
            }
            await clearComposerAttachments(Runtime, 5_000, logger);
            // Use remote file transfer for remote Chrome (reads local files and injects via CDP)
            for (const attachment of submissionAttachments) {
              logger(`Uploading attachment: ${attachment.displayPath}`);
              await raceWithAbort(
                uploadAttachmentViaDataTransfer({ runtime: Runtime, dom: DOM }, attachment, logger),
              );
              await raceWithAbort(delay(500));
            }
            // Scale timeout based on number of files: base 30s + 15s per additional file
            const baseTimeout = config.inputTimeoutMs ?? 30_000;
            const perFileTimeout = 15_000;
            const waitBudget =
              Math.max(baseTimeout, 30_000) + (submissionAttachments.length - 1) * perFileTimeout;
            const attachmentWaitBudget = Math.max(config.attachmentTimeoutMs ?? 0, waitBudget);
            await raceWithAbort(
              waitForAttachmentCompletion(Runtime, attachmentWaitBudget, attachmentNames, logger),
            );
            await raceWithAbort(
              bindActiveComposerAttachments(
                Runtime,
                attachmentExpectations,
                attachmentBindingToken!,
                logger,
              ),
            );
            logger("All attachments uploaded");
          }
        },
        prepareMutatingComposerMode: async () => {
          if (deepResearch) {
            await raceWithAbort(
              withRetries(() => activateDeepResearch(Runtime, Input, logger), {
                retries: 2,
                delayMs: 500,
                onRetry: (attempt, error) => {
                  if (options.verbose) {
                    logger(
                      `[retry] Deep Research activation attempt ${attempt + 1}: ${error instanceof Error ? error.message : error}`,
                    );
                  }
                },
              }),
            );
            await raceWithAbort(ensurePromptReady(Runtime, config.inputTimeoutMs, logger));
            logger(
              `Prompt textarea ready (after Deep Research activation, ${prompt.length.toLocaleString()} chars queued)`,
            );
          }
        },
      });
      // Sol+Pro route verified before submit (the gate did not throw).
      emitRunProgressMarker("model_verified");
      let baselineTurns = await readConversationTurnCount(Runtime, logger);
      const providerState: Record<string, unknown> = {
        runtime: Runtime,
        input: Input,
        logger,
        timeoutMs: config.timeoutMs,
        inputTimeoutMs: config.inputTimeoutMs ?? undefined,
        attachmentTimeoutMs: config.attachmentTimeoutMs ?? undefined,
        baselineTurns: baselineTurns ?? undefined,
        attachmentNames: attachmentExpectations,
        attachmentBindingToken,
        beforePromptSubmit: (
          composerBindingToken?: string,
          exactSubmission?: import("./actions/promptComposer.js").ExactSubmissionExpectation,
        ) =>
          proveProtectedSolProSelectionBeforeSubmit({
            desiredModel: config.desiredModel,
            runtime: Runtime,
            logger,
            attachmentBindingToken,
            composerBindingToken,
            exactSubmission,
          }),
        requireBoundSendTarget:
          isDesiredGpt56SolModel(config.desiredModel) ||
          submissionAttachments.length > 0 ||
          submissionOptions?.requireExactPromptRoundTrip === true,
        requireExactPromptRoundTrip: submissionOptions?.requireExactPromptRoundTrip === true,
        onPromptSubmitted: () => markPromptSubmitted(submissionOptions!.submissionProvenance),
        onPromptBound: markPromptBound,
        // Authoritative account id (server: options.accountId ?? env) so the
        // browser-side quarantine gates trip under the same identity the
        // serve layer's admission checks use (oracle-router-8t1).
        accountId: options.accountId,
        chatgptProVerification: {
          enabled: isDesiredChatGptProModel(config.desiredModel),
        },
      };
      const deepResearchTargetBaseline =
        deepResearch && client
          ? await captureDeepResearchTargetBaseline(client, logger)
          : undefined;
      emitRunProgressMarker("submitting");
      await runProviderSubmissionFlow(chatgptDomProvider, {
        prompt,
        evaluate: async () => undefined,
        delay,
        log: logger,
        state: providerState,
      });
      emitRunProgressMarker("prompt_committed");
      const providerBaselineTurns = providerState.baselineTurns;
      if (typeof providerBaselineTurns === "number" && Number.isFinite(providerBaselineTurns)) {
        baselineTurns = providerBaselineTurns;
      }
      return {
        baselineTurns,
        baselineAssistantText,
        deepResearchTargetKeys: deepResearchTargetBaseline?.targetKeys,
        deepResearchTargetBaselineCaptured: deepResearchTargetBaseline?.captured,
      };
    };
    const reloadPromptComposer = async () => {
      logger("[browser] Composer became unresponsive; reloading page and retrying once.");
      await raceWithAbort(Page.reload({ ignoreCache: true }));
      await raceWithAbort(
        assertPreRunAccessState(Runtime, logger, {
          quarantine: { accountId: options.accountId },
          sessionId: options.sessionId,
        }),
      );
      await raceWithAbort(
        preserveChallengeOverPageFailure(
          ensurePromptReady(Runtime, config.inputTimeoutMs, logger),
          Runtime,
          logger,
          { accountId: options.accountId, sessionId: options.sessionId },
        ),
      );
    };

    let baselineTurns: number | null = null;
    let baselineAssistantText: string | null = null;
    let deepResearchTargetKeys: string[] = [];
    let deepResearchTargetBaselineCaptured = false;
    const submission = await raceWithAbort(
      runSubmissionWithRecovery({
        prompt: promptText,
        attachments,
        fallbackSubmission: options.fallbackSubmission,
        desiredModel: config.desiredModel,
        submit: (submissionPrompt, submissionAttachments, submissionOptions) =>
          preserveChallengeOverPageFailure(
            submitOnce(submissionPrompt, submissionAttachments, submissionOptions),
            Runtime,
            logger,
            { accountId: options.accountId, sessionId: options.sessionId },
          ),
        reloadPromptComposer,
        prepareFallbackSubmission: async () => {
          await raceWithAbort(clearComposerAttachments(Runtime, 5_000, logger));
          await raceWithAbort(clearPromptComposer(Runtime, logger));
          await raceWithAbort(ensurePromptReady(Runtime, config.inputTimeoutMs, logger));
        },
        logger,
      }),
    );
    baselineTurns = submission.baselineTurns;
    baselineAssistantText = submission.baselineAssistantText;
    deepResearchTargetKeys = submission.deepResearchTargetKeys ?? [];
    deepResearchTargetBaselineCaptured = submission.deepResearchTargetBaselineCaptured ?? false;
    const initialSubmissionProvenance = submission.submissionProvenance;
    const initialSubmittedPrompt = submission.submittedPrompt;
    void activeConversationUrlMonitor.schedule("post-submit", config.timeoutMs ?? 120_000);
    const imageArtifactMinTurnIndex = baselineTurns;
    if (deepResearch) {
      await raceWithAbort(waitForResearchPlanAutoConfirm(Runtime, logger));
      const researchResult = await raceWithAbort(
        preserveChallengeOverPageFailure(
          waitForDeepResearchCompletion(
            Runtime,
            logger,
            config.timeoutMs,
            baselineTurns,
            Page,
            client,
            {
              ignoredTargetKeys: deepResearchTargetKeys,
              targetBaselineCaptured: deepResearchTargetBaselineCaptured,
            },
          ),
          Runtime,
          logger,
          { accountId: options.accountId, sessionId: options.sessionId },
        ),
      );
      // The remote-Chrome Deep Research path has the same OOPIF ownership
      // requirement as local Chrome: no report is returnable until the exact
      // submitted user-message handle is structurally tied to its assistant
      // response sequence.
      await raceWithAbort(
        preserveChallengeOverPageFailure(
          assertCapturedAssistantResponseBound(Runtime, researchResult.meta, logger),
          Runtime,
          logger,
          { accountId: options.accountId, sessionId: options.sessionId },
        ),
      );
      await raceWithAbort(
        assertCapturedAnswerNotAccessArtifact(
          Runtime,
          { text: researchResult.text, html: researchResult.html },
          logger,
          {
            quarantine: { accountId: options.accountId },
            sessionId: options.sessionId,
          },
        ),
      );
      await activeConversationUrlMonitor.update("post-deep-research", 15_000).catch(() => false);
      expectedConversationId();
      const durationMs = Date.now() - startedAt;
      const tokens = estimateTokenCount(researchResult.text);
      const reportArtifact = await saveOptionalArtifact(
        () =>
          saveDeepResearchReportArtifact({
            sessionId: options.sessionId,
            reportMarkdown: researchResult.text,
            conversationUrl: lastUrl,
            logger,
          }),
        logger,
      );
      const transcriptArtifact = await saveOptionalArtifact(
        () =>
          saveBrowserTranscriptArtifact({
            sessionId: options.sessionId,
            prompt: initialSubmittedPrompt,
            answerMarkdown: researchResult.text,
            conversationUrl: lastUrl,
            artifacts: appendArtifacts(undefined, [reportArtifact]),
            logger,
          }),
        logger,
      );
      const savedArtifacts = appendArtifacts(undefined, [reportArtifact, transcriptArtifact]);
      const archive = await maybeArchiveCompletedConversation({
        Runtime,
        logger,
        config,
        conversationUrl: lastUrl,
        answerText: researchResult.text,
        followUpCount: 0,
        requiredArtifactsSaved: Boolean(reportArtifact && transcriptArtifact),
      });
      await raceWithAbort(
        assertCapturedAnswerNotAccessArtifact(
          Runtime,
          { text: researchResult.text, html: researchResult.html },
          logger,
          {
            quarantine: { accountId: options.accountId },
            sessionId: options.sessionId,
          },
        ),
      );
      runStatus = "complete";
      emitRunProgressMarker("done");
      return {
        answerText: researchResult.text,
        answerMarkdown: researchResult.text,
        answerHtml: researchResult.html,
        artifacts: savedArtifacts,
        archive,
        modelSelection: modelSelectionEvidence,
        tookMs: durationMs,
        answerTokens: tokens,
        answerChars: researchResult.text.length,
        chromePort: port,
        chromeHost: host,
        chromeTargetId: remoteTargetId ?? undefined,
        tabUrl: lastUrl,
        conversationId: lastUrl ? extractConversationIdFromUrl(lastUrl) : undefined,
        promptSubmitted,
        submissionProvenance: initialSubmissionProvenance,
        controllerPid: process.pid,
      };
    }
    // Helper to normalize text for echo detection (collapse whitespace, lowercase)
    const normalizeForComparison = (text: string): string =>
      text.toLowerCase().replace(/\s+/g, " ").trim();
    const waitForFreshAssistantResponse = async (baselineNormalized: string, timeoutMs: number) => {
      const baselinePrefix =
        baselineNormalized.length >= 80
          ? baselineNormalized.slice(0, Math.min(200, baselineNormalized.length))
          : "";
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const snapshot = await readAssistantSnapshot(
          Runtime,
          baselineTurns ?? undefined,
          expectedConversationId(),
        ).catch(() => null);
        const text = typeof snapshot?.text === "string" ? snapshot.text.trim() : "";
        if (text) {
          const normalized = normalizeForComparison(text);
          const isBaseline =
            normalized === baselineNormalized ||
            (baselinePrefix.length > 0 && normalized.startsWith(baselinePrefix));
          if (!isBaseline) {
            return {
              text,
              html: snapshot?.html ?? undefined,
              meta: {
                turnId: snapshot?.turnId ?? undefined,
                messageId: snapshot?.messageId ?? undefined,
              },
            };
          }
        }
        await delay(350);
      }
      return null;
    };
    const waitWithThinkingMonitor = async <T>(operation: () => Promise<T>): Promise<T> => {
      stopThinkingMonitor?.();
      stopThinkingMonitor = startThinkingStatusMonitor(Runtime, logger, {
        intervalMs: options.heartbeatIntervalMs,
        // Structured run_progress.v1 liveness rides on the same heartbeat ticks,
        // gated by ORACLE_RUN_PROGRESS_JSON and written to stderr (stdout stays
        // reserved for the final --json envelope).
        runProgress: {
          runId: options.sessionId ?? "browser",
          timeoutMs: config.timeoutMs,
          enabled: runProgressEnabled,
        },
      });
      try {
        return await operation();
      } finally {
        stopThinkingMonitor?.();
        stopThinkingMonitor = null;
      }
    };
    const recheckDelayMs = Math.max(0, config.assistantRecheckDelayMs ?? 0);
    const recheckTimeoutMs = Math.max(0, config.assistantRecheckTimeoutMs ?? 0);
    const attemptAssistantRecheck = async (assistantWaitStartedAt: number) => {
      if (!recheckDelayMs) return null;
      logger(
        `[browser] Assistant response timed out; waiting ${formatElapsed(recheckDelayMs)} before rechecking conversation.`,
      );
      await raceWithAbort(delay(recheckDelayMs));
      const conversationUrl = await readConversationUrl(Runtime);
      if (conversationUrl && isConversationUrl(conversationUrl)) {
        await observeConversationUrl(conversationUrl, "assistant-recheck");
        logger(`[browser] Rechecking assistant response at ${conversationUrl}`);
        await raceWithAbort(Page.navigate({ url: conversationUrl }));
        await raceWithAbort(delay(1000));
        await raceWithAbort(
          assertPreRunAccessState(Runtime, logger, {
            quarantine: { accountId: options.accountId },
            sessionId: options.sessionId,
          }),
        );
      }
      // Validate session before attempting recheck - sessions can expire during the delay
      const sessionValid = await validateChatGPTSession(Runtime, logger);
      if (!sessionValid.valid) {
        await raceWithAbort(
          assertPreResultAccessState(Runtime, logger, {
            quarantine: { accountId: options.accountId },
            sessionId: options.sessionId,
          }),
        );
        logger(`[browser] Session validation failed: ${sessionValid.reason}`);
        // Update session metadata to indicate login is needed
        await emitRuntimeHint();
        throw new BrowserAutomationError(
          `ChatGPT session expired during recheck: ${sessionValid.reason}. ` +
            `Conversation URL: ${conversationUrl || lastUrl || "unknown"}. ` +
            `Please sign in and retry.`,
          {
            stage: "assistant-recheck",
            details: {
              conversationUrl: conversationUrl || lastUrl || null,
              sessionStatus: "needs_login",
              validationReason: sessionValid.reason,
            },
            runtime: {
              chromeHost: host,
              chromePort: port,
              chromeBrowserWSEndpoint: browserWSEndpoint,
              chromeProfileRoot,
              chromeTargetId: remoteTargetId ?? undefined,
              tabUrl: lastUrl,
              conversationId: lastUrl ? extractConversationIdFromUrl(lastUrl) : undefined,
              promptSubmitted,
              controllerPid: process.pid,
            },
          },
        );
      }
      await emitRuntimeHint();
      const timeoutMs = recheckTimeoutMs > 0 ? recheckTimeoutMs : config.timeoutMs;
      const rechecked = await waitWithThinkingMonitor(() =>
        raceWithAbort(
          waitForAssistantOrGeneratedImageResponse({
            Runtime,
            waitForText: () =>
              waitForAssistantResponseWithReload(
                Runtime,
                Page,
                timeoutMs,
                logger,
                baselineTurns ?? undefined,
                expectedConversationId(),
                options.accountId,
                {
                  elapsedBaselineMs: Math.max(0, Date.now() - assistantWaitStartedAt),
                },
              ),
            timeoutMs,
            logger,
            minTurnIndex: baselineTurns ?? undefined,
            expectedConversationId: expectedConversationId(),
            imageOutputRequested,
            accountId: options.accountId,
            sessionId: options.sessionId,
          }),
        ),
      );
      logger("Recovered assistant response after delayed recheck");
      return rechecked;
    };
    const imageOutputRequested = Boolean(
      options.generateImagePath ||
      options.outputPath ||
      (options as { generateImage?: string }).generateImage,
    );
    const captureAssistantTurn = async (
      turnPrompt: string,
      label: string,
    ): Promise<BrowserConversationTurn & { answerHtml: string }> => {
      let turnAnswer: AssistantAnswer;
      const assistantWaitStartedAt = Date.now();
      try {
        await activeConversationUrlMonitor.update("assistant-wait", 15_000).catch(() => false);
        emitRunProgressMarker("response_waiting");
        turnAnswer = await waitWithThinkingMonitor(() =>
          raceWithAbort(
            waitForAssistantOrGeneratedImageResponse({
              Runtime,
              waitForText: () =>
                waitForAssistantResponseWithReload(
                  Runtime,
                  Page,
                  config.timeoutMs,
                  logger,
                  baselineTurns ?? undefined,
                  expectedConversationId(),
                  options.accountId,
                ),
              timeoutMs: config.timeoutMs,
              logger,
              minTurnIndex: baselineTurns ?? undefined,
              expectedConversationId: expectedConversationId(),
              imageOutputRequested,
              accountId: options.accountId,
              sessionId: options.sessionId,
            }),
          ),
        );
      } catch (error) {
        if (isAssistantResponseTimeoutError(error)) {
          const rechecked = await attemptAssistantRecheckOrRethrow(() =>
            attemptAssistantRecheck(assistantWaitStartedAt),
          );
          if (rechecked) {
            turnAnswer = rechecked;
          } else {
            await activeConversationUrlMonitor
              .update("assistant-timeout", 15_000)
              .catch(() => false);
            const diagnostics = await captureBrowserDiagnostics(
              Runtime,
              logger,
              "assistant-timeout",
              {
                Page,
                sessionId: options.sessionId,
              },
            ).catch(() => undefined);
            const runtime = {
              chromePort: port,
              chromeHost: host,
              chromeBrowserWSEndpoint: browserWSEndpoint,
              chromeProfileRoot,
              chromeTargetId: remoteTargetId ?? undefined,
              tabUrl: lastUrl,
              conversationId: lastUrl ? extractConversationIdFromUrl(lastUrl) : undefined,
              promptSubmitted,
              controllerPid: process.pid,
            };
            throw await createAssistantTimeoutError({
              Runtime,
              logger,
              runtime,
              diagnostics,
              cause: error,
            });
          }
        } else {
          throw error;
        }
      }
      await activeConversationUrlMonitor.update("post-response", 15_000).catch(() => false);
      const baselineNormalized = baselineAssistantText
        ? normalizeForComparison(baselineAssistantText)
        : "";
      if (baselineNormalized) {
        const normalizedAnswer = normalizeForComparison(turnAnswer.text ?? "");
        const baselinePrefix =
          baselineNormalized.length >= 80
            ? baselineNormalized.slice(0, Math.min(200, baselineNormalized.length))
            : "";
        const isBaseline =
          normalizedAnswer === baselineNormalized ||
          (baselinePrefix.length > 0 && normalizedAnswer.startsWith(baselinePrefix));
        if (isBaseline) {
          logger("Detected stale assistant response; waiting for new response...");
          const refreshed = await waitForFreshAssistantResponse(baselineNormalized, 15_000);
          if (refreshed) {
            await applyBoundAssistantSnapshotReplacement(Runtime, refreshed.meta, logger, () => {
              turnAnswer = refreshed;
            });
          }
        }
      }
      let turnAnswerText = turnAnswer.text;
      const turnAnswerHtml = turnAnswer.html ?? "";

      emitRunProgressMarker("capturing");
      const copiedMarkdown = await raceWithAbort(
        withRetries(
          async () => {
            const attempt = await captureAssistantMarkdown(Runtime, turnAnswer.meta, logger, {
              requireSourceIdentity: true,
            });
            if (!attempt) {
              throw new Error("copy-missing");
            }
            return attempt;
          },
          {
            retries: 2,
            delayMs: 350,
            onRetry: (attempt, error) => {
              if (options.verbose) {
                logger(
                  `[retry] Markdown capture attempt ${attempt + 1}: ${error instanceof Error ? error.message : error}`,
                );
              }
            },
          },
        ),
      ).catch(() => null);

      let turnAnswerMarkdown = copiedMarkdown ?? turnAnswerText;
      ({ answerText: turnAnswerText, answerMarkdown: turnAnswerMarkdown } =
        await maybeRecoverLongAssistantResponse({
          runtime: Runtime,
          baselineTurns,
          expectedConversationId: expectedConversationId(),
          answerText: turnAnswerText,
          answerMarkdown: turnAnswerMarkdown,
          logger,
          allowMarkdownUpdate: !copiedMarkdown,
        }));

      const promptEchoMatcher = buildPromptEchoMatcher(turnPrompt);

      // Final sanity check: ensure we didn't accidentally capture the user prompt instead of the assistant turn.
      const finalSnapshot = await readAssistantSnapshot(
        Runtime,
        baselineTurns ?? undefined,
        expectedConversationId(),
      ).catch(() => null);
      const finalText = typeof finalSnapshot?.text === "string" ? finalSnapshot.text.trim() : "";
      if (finalText && finalText !== turnPrompt.trim()) {
        const trimmedMarkdown = turnAnswerMarkdown.trim();
        const finalIsEcho = promptEchoMatcher ? promptEchoMatcher.isEcho(finalText) : false;
        const lengthDelta = finalText.length - trimmedMarkdown.length;
        const missingCopy = !copiedMarkdown && lengthDelta >= 0;
        const likelyTruncatedCopy =
          copiedMarkdown &&
          trimmedMarkdown.length > 0 &&
          lengthDelta >= Math.max(12, Math.floor(trimmedMarkdown.length * 0.75));
        if ((missingCopy || likelyTruncatedCopy) && !finalIsEcho && finalText !== trimmedMarkdown) {
          await applyBoundAssistantSnapshotReplacement(
            Runtime,
            {
              turnId: finalSnapshot?.turnId ?? undefined,
              messageId: finalSnapshot?.messageId ?? undefined,
            },
            logger,
            () => {
              logger("Refreshed assistant response via final DOM snapshot");
              turnAnswerText = finalText;
              turnAnswerMarkdown = finalText;
            },
          );
        }
      }

      // Detect prompt echo using normalized comparison (whitespace-insensitive).
      const alignedEcho = alignPromptEchoPair(
        turnAnswerText,
        turnAnswerMarkdown,
        promptEchoMatcher,
        copiedMarkdown ? logger : undefined,
        {
          text: "Aligned assistant response text to copied markdown after prompt echo",
          markdown: "Aligned assistant markdown to response text after prompt echo",
        },
      );
      turnAnswerText = alignedEcho.answerText;
      turnAnswerMarkdown = alignedEcho.answerMarkdown;
      const isPromptEcho = alignedEcho.isEcho;
      if (isPromptEcho) {
        logger("Detected prompt echo in response; waiting for actual assistant response...");
        const deadline = Date.now() + 15_000;
        let bestText: string | null = null;
        let bestMeta: CapturedAssistantMeta | null = null;
        let stableCount = 0;
        while (Date.now() < deadline) {
          const snapshot = await readAssistantSnapshot(
            Runtime,
            baselineTurns ?? undefined,
            expectedConversationId(),
          ).catch(() => null);
          const text = typeof snapshot?.text === "string" ? snapshot.text.trim() : "";
          const isStillEcho = !text || Boolean(promptEchoMatcher?.isEcho(text));
          if (!isStillEcho) {
            if (!bestText || text.length > bestText.length) {
              bestText = text;
              bestMeta = {
                turnId: snapshot?.turnId ?? undefined,
                messageId: snapshot?.messageId ?? undefined,
              };
              stableCount = 0;
            } else if (text === bestText) {
              stableCount += 1;
            }
            if (stableCount >= 2) {
              break;
            }
          }
          await new Promise((resolve) => setTimeout(resolve, 300));
        }
        if (bestText) {
          await applyBoundAssistantSnapshotReplacement(Runtime, bestMeta ?? {}, logger, () => {
            logger("Recovered assistant response after detecting prompt echo");
            turnAnswerText = bestText;
            turnAnswerMarkdown = bestText;
          });
        }
      }
      const minAnswerChars = 16;
      if (turnAnswerText.trim().length > 0 && turnAnswerText.trim().length < minAnswerChars) {
        const deadline = Date.now() + 12_000;
        let bestText = turnAnswerText.trim();
        let bestMeta: CapturedAssistantMeta | null = null;
        let stableCycles = 0;
        while (Date.now() < deadline) {
          const snapshot = await readAssistantSnapshot(
            Runtime,
            baselineTurns ?? undefined,
            expectedConversationId(),
          ).catch(() => null);
          const text = typeof snapshot?.text === "string" ? snapshot.text.trim() : "";
          if (text && text.length > bestText.length) {
            bestText = text;
            bestMeta = {
              turnId: snapshot?.turnId ?? undefined,
              messageId: snapshot?.messageId ?? undefined,
            };
            stableCycles = 0;
          } else {
            stableCycles += 1;
          }
          if (stableCycles >= 3 && bestText.length >= minAnswerChars) {
            break;
          }
          await delay(400);
        }
        if (bestText.length > turnAnswerText.trim().length) {
          await applyBoundAssistantSnapshotReplacement(Runtime, bestMeta ?? {}, logger, () => {
            logger("Refreshed short assistant response from latest DOM snapshot");
            turnAnswerText = bestText;
            turnAnswerMarkdown = bestText;
          });
        }
      }
      return {
        label,
        answerText: turnAnswerText,
        answerMarkdown: turnAnswerMarkdown,
        answerHtml: turnAnswerHtml,
      };
    };

    const followUpPrompts = normalizeBrowserFollowUpPrompts(options.followUpPrompts);
    const turns: BrowserConversationTurn[] = [];
    const initialTurn = await captureAssistantTurn(promptText, "Initial response");
    turns.push(initialTurn);
    answerText = initialTurn.answerText;
    answerMarkdown = initialTurn.answerMarkdown;
    answerHtml = initialTurn.answerHtml;

    for (let index = 0; index < followUpPrompts.length; index += 1) {
      const followUpPrompt = followUpPrompts[index];
      logger(`[browser] Sending follow-up ${index + 1}/${followUpPrompts.length}`);
      await raceWithAbort(clearPromptComposer(Runtime, logger));
      await raceWithAbort(ensurePromptReady(Runtime, config.inputTimeoutMs, logger));
      const submission = await raceWithAbort(
        runSubmissionWithRecovery({
          prompt: followUpPrompt,
          attachments: [],
          desiredModel: config.desiredModel,
          submit: (submissionPrompt, submissionAttachments, submissionOptions) =>
            preserveChallengeOverPageFailure(
              submitOnce(submissionPrompt, submissionAttachments, submissionOptions),
              Runtime,
              logger,
              { accountId: options.accountId, sessionId: options.sessionId },
            ),
          reloadPromptComposer,
          prepareFallbackSubmission: async () => {
            await raceWithAbort(clearPromptComposer(Runtime, logger));
            await raceWithAbort(ensurePromptReady(Runtime, config.inputTimeoutMs, logger));
          },
          logger,
        }),
      );
      baselineTurns = submission.baselineTurns;
      baselineAssistantText = submission.baselineAssistantText;
      const turn = await captureAssistantTurn(followUpPrompt, `Follow-up ${index + 1}`);
      turns.push({ ...turn, prompt: followUpPrompt });
      answerText = turn.answerText;
      answerMarkdown = turn.answerMarkdown;
      answerHtml = turn.answerHtml;
    }

    if (turns.length > 1) {
      const formatted = formatBrowserTurnTranscript(turns);
      answerText = formatted.answerText;
      answerMarkdown = formatted.answerMarkdown;
      answerHtml = "";
    }
    const canSaveBrowserDownloadsLocally = isLocalChromeHost(host);
    const imageArtifacts = await collectGeneratedImageArtifacts({
      Browser: canSaveBrowserDownloadsLocally ? client.Browser : undefined,
      Client: canSaveBrowserDownloadsLocally ? client : undefined,
      Page: canSaveBrowserDownloadsLocally ? Page : undefined,
      Runtime,
      Network,
      logger,
      minTurnIndex: imageArtifactMinTurnIndex,
      sessionId: options.sessionId,
      generateImagePath: options.generateImagePath,
      outputPath: options.outputPath,
      answerText,
      waitTimeoutMs: options.config?.timeoutMs,
      checkBlockingUiWarning: () =>
        throwChatGptUiWarningIfPresent({
          Runtime,
          logger,
          stage: "image-artifact-wait",
          waitTarget: "generated image artifacts",
          runtime: {
            chromePort: port,
            chromeHost: host,
            chromeBrowserWSEndpoint: browserWSEndpoint,
            chromeProfileRoot,
            chromeTargetId: remoteTargetId ?? undefined,
            tabUrl: lastUrl,
            conversationId: lastUrl ? extractConversationIdFromUrl(lastUrl) : undefined,
            promptSubmitted,
            controllerPid: process.pid,
          },
        }),
    });
    answerText = imageArtifacts.answerText || answerText;
    if (imageArtifacts.markdownSuffix) {
      answerMarkdown += imageArtifacts.markdownSuffix;
    }
    let fileArtifacts = await collectChatGptFileArtifacts({
      Browser: client.Browser,
      Client: client,
      Page,
      Runtime,
      Network,
      answerText: [answerText, answerMarkdown, answerHtml].filter(Boolean).join("\n"),
      logger,
      minTurnIndex: imageArtifactMinTurnIndex,
      sessionId: options.sessionId,
    });
    const savedImageArtifacts = appendArtifacts(undefined, imageArtifacts.savedImages);
    let savedBrowserArtifacts = appendArtifacts(savedImageArtifacts, fileArtifacts.savedFiles);
    const transcriptArtifact = await saveOptionalArtifact(
      () =>
        saveBrowserTranscriptArtifact({
          sessionId: options.sessionId,
          prompt: initialSubmittedPrompt,
          answerMarkdown,
          conversationUrl: lastUrl,
          artifacts: savedBrowserArtifacts,
          logger,
        }),
      logger,
    );
    fileArtifacts = await collectLateChatGptFileArtifactsFromTranscript({
      Browser: client.Browser,
      Client: client,
      Page,
      Runtime,
      Network,
      current: fileArtifacts,
      logger,
      minTurnIndex: imageArtifactMinTurnIndex,
      sessionId: options.sessionId,
      transcriptPath: transcriptArtifact?.path,
    });
    savedBrowserArtifacts = appendArtifacts(savedImageArtifacts, fileArtifacts.savedFiles);
    const savedArtifacts = appendArtifacts(savedBrowserArtifacts, [transcriptArtifact]);
    const archive = await maybeArchiveCompletedConversation({
      Runtime,
      logger,
      config,
      conversationUrl: lastUrl,
      answerText,
      followUpCount: followUpPrompts.length,
      requiredArtifactsSaved:
        Boolean(transcriptArtifact) &&
        imageArtifacts.savedImages.length === imageArtifacts.imageCount &&
        fileArtifacts.savedFiles.length === fileArtifacts.fileCount,
    });
    await raceWithAbort(
      assertCapturedAnswerNotAccessArtifact(
        Runtime,
        { text: answerText, html: answerHtml },
        logger,
        {
          quarantine: { accountId: options.accountId },
          sessionId: options.sessionId,
        },
      ),
    );
    const durationMs = Date.now() - startedAt;
    const answerChars = answerText.length;
    const answerTokens = estimateTokenCount(answerMarkdown);

    expectedConversationId();
    runStatus = "complete";
    emitRunProgressMarker("done");
    return {
      answerText,
      answerMarkdown,
      answerHtml: answerHtml.length > 0 ? answerHtml : undefined,
      tookMs: durationMs,
      answerTokens,
      answerChars,
      browserTransport: "cdp",
      chromePid: undefined,
      chromePort: port,
      chromeHost: host,
      chromeBrowserWSEndpoint: browserWSEndpoint,
      chromeProfileRoot,
      userDataDir: undefined,
      chromeTargetId: remoteTargetId ?? undefined,
      tabUrl: lastUrl,
      conversationId: lastUrl ? extractConversationIdFromUrl(lastUrl) : undefined,
      promptSubmitted,
      submissionProvenance: initialSubmissionProvenance,
      artifacts: savedArtifacts,
      generatedImages: imageArtifacts.generatedImages,
      savedImages: imageArtifacts.savedImages,
      downloadableFiles: fileArtifacts.files,
      savedFiles: fileArtifacts.savedFiles,
      archive,
      modelSelection: modelSelectionEvidence,
      controllerPid: process.pid,
    };
  } catch (error) {
    let normalizedError = error instanceof Error ? error : new Error(String(error));
    const socketClosed = connectionClosedUnexpectedly || isWebSocketClosureError(normalizedError);
    connectionClosedUnexpectedly = connectionClosedUnexpectedly || socketClosed;
    if (!socketClosed && client?.Runtime) {
      const preferred = await preferChallengeOverPageFailure(
        normalizedError,
        client.Runtime,
        logger,
        { accountId: options.accountId, sessionId: options.sessionId },
      );
      normalizedError = preferred instanceof Error ? preferred : new Error(String(preferred));
    }
    const preservedErrorKind = classifyPreservedBrowserError(normalizedError, config.headless);
    preserveOwnedTargetOnError = preservedErrorKind !== null;
    if (preservedErrorKind === "cloudflare-challenge") {
      logger("Challenge detected; preserving the exact remote browser tab for manual clearance.");
    } else if (preservedErrorKind === "reattachable-capture") {
      logger("Assistant capture incomplete; preserving the exact remote browser tab for reattach.");
    }

    if (!socketClosed) {
      logger(`Failed to complete ChatGPT run: ${normalizedError.message}`);
      if ((config.debug || process.env.CHATGPT_DEVTOOLS_TRACE === "1") && normalizedError.stack) {
        logger(normalizedError.stack);
      }
      throw normalizedError;
    }

    const liveness = await probeChromeTargetLiveness({
      host,
      port,
      targetId: remoteTargetId,
      browserWSEndpoint,
    });
    const recoverable = isRecoverableChromeDisconnect(liveness);
    throw new BrowserAutomationError(connectionLostUserMessage({ recoverable, remote: true }), {
      stage: "connection-lost",
      recoverableDisconnect: recoverable,
      disconnectCause: recoverable ? "cdp-client-disconnect" : "chrome-closed",
      runtime: {
        chromeHost: host,
        chromePort: port,
        chromeBrowserWSEndpoint: browserWSEndpoint,
        chromeProfileRoot,
        chromeTargetId: remoteTargetId ?? undefined,
        tabUrl: liveness.matchedUrl ?? lastUrl,
        conversationId:
          (liveness.matchedUrl ?? lastUrl)
            ? extractConversationIdFromUrl(liveness.matchedUrl ?? lastUrl ?? "")
            : undefined,
        promptSubmitted,
        controllerPid: process.pid,
      },
    });
  } finally {
    await conversationUrlMonitor?.stop();
    removeAbortListener?.();
    removeAbortListener = null;
    try {
      await closeRemoteConnectionAfterRun({
        connectionClosedUnexpectedly,
        connection,
        client,
        runStatus,
        logger,
      });
    } catch {
      // ignore
    }
    removeDialogHandler?.();
    // Ordering (load-bearing): close the owned target BEFORE releasing the tab
    // lease. The lease advertises "this run still owns a tab in the shared
    // Chrome"; releasing first opens a window in which a zero-lease reaper or
    // a peer's termination gate can kill the shared Chrome mid-close, and
    // concurrent runs can count a free slot that is still physically occupied.
    // connectionClosedUnexpectedly does NOT skip this: the close goes over a
    // fresh HTTP DevTools call, so a dead CDP socket is a close-attempt-needed
    // case, and a failed attempt latches cleanup-taint instead of silently
    // leaving the tab behind.
    const keepRemoteBrowser = Boolean(config.keepBrowser);
    const shouldCloseOwnedRemoteTarget = shouldCloseOwnedRunTargetAfterRun({
      runStatus,
      ownsTarget,
      keepBrowser: keepRemoteBrowser,
      closeOwnedTabOnComplete: options.closeOwnedTabOnComplete,
      policy: resolveCloseOwnedRunTargetPolicy(config),
      orphanedTargetNeedsCleanup,
      preserveOwnedTargetOnError,
    });
    if (shouldCloseOwnedRemoteTarget && remoteTargetId) {
      // Preserve the successful narrowing across the async close callback.
      const ownedRemoteTargetId = remoteTargetId;
      const safeToClose =
        !keepRemoteBrowser ||
        Boolean(await ensureChromePageTargetAfterClose(port, ownedRemoteTargetId, logger, host));
      if (!safeToClose) {
        ownedTargetCleanupProved = false;
        logger(
          "[browser] Leaving completed remote browser tab open because Chrome has no replacement page target.",
        );
      } else {
        const closeOwnedRemoteTarget = async (): Promise<boolean> => {
          return await closeTab(port, ownedRemoteTargetId, logger, host);
        };
        ownedTargetCleanupProved = await closeOwnedTargetWithDeadline(
          closeOwnedRemoteTarget(),
          logger,
          { targetId: ownedRemoteTargetId },
        );
        if (!ownedTargetCleanupProved && keepRemoteBrowser) {
          const replacementTargetId = await createChromePageTarget(port, logger, host);
          if (!replacementTargetId) {
            logger(
              `[browser] Remote Chrome page retention could not be verified after closing ${ownedRemoteTargetId}.`,
            );
          }
        }
      }
    }
    const retainPreservedOwnedTargetLease = shouldRetainBrowserTabLeaseAfterRun({
      runStatus,
      ownsTarget,
      preserveOwnedTargetOnError,
      orphanedTargetNeedsCleanup,
    });
    if (tabLease && retainPreservedOwnedTargetLease) {
      logger(
        `[browser] Keeping ChatGPT browser slot ${tabLease.id.slice(0, 8)} active with its preserved owned target.`,
      );
    } else if (tabLease && ownedTargetCleanupProved) {
      const handle = tabLease;
      tabLease = null;
      await releaseBrowserTabLeaseOrTaint(handle, logger, "remote browser run cleanup");
    } else if (tabLease) {
      logger(
        `[browser] Keeping ChatGPT browser slot ${tabLease.id.slice(0, 8)} active because owned-target cleanup was not proved.`,
      );
    }
    // Don't kill remote Chrome - it's not ours to manage
    const totalSeconds = (Date.now() - startedAt) / 1000;
    logger(`Remote session complete • ${totalSeconds.toFixed(1)}s total`);
  }
}

export { estimateTokenCount } from "./utils.js";
export { resolveBrowserConfig, DEFAULT_BROWSER_CONFIG } from "./config.js";

// biome-ignore lint/style/useNamingConvention: test-only export used in vitest suite
export const __test__ = {
  assertManualLoginProfileReadyForRun,
  closeRemoteConnectionAfterRun,
  classifyChatGptUiWarningText,
  collectChatGptUiWarnings,
  createAssistantTimeoutError,
  detachKeptChromeProcess,
  enableFocusEmulation,
  formatManualLoginSetupCommand,
  isAssistantResponseTimeoutError,
  shouldReloadAfterAssistantError,
  isManualLoginProfileInitialized,
  isImageOnlyUiChromeText,
  maybeRecoverLongAssistantResponse,
  preferChallengeOverPageFailure,
  listIgnoredRemoteChromeFlags,
  resolveManualLoginWaitMs,
  closeOwnedTargetWithDeadline,
  releaseBrowserTabLeaseOrTaint,
  resolveCloseOwnedRunTargetPolicy,
  mergeModeSelectionEvidence,
  assertProtectedSolProEvidence,
  selectInitialModelWithRefreshRecovery,
  shouldRefreshInitialModelPicker,
  verifyProtectedSolProSelectionForSubmit,
  prepareSubmissionComposerWithProtectedRoute,
  runWithRetainedAttachmentSnapshots,
  shouldCleanupBlankTabsAfterLastLease,
  shouldCloseOwnedRunTargetAfterRun,
  shouldRetainBrowserTabLeaseAfterRun,
  shouldKeepLocalBrowserOpen,
  waitForAssistantOrGeneratedImageResponse,
  waitForAssistantResponseWithReload,
  applyBoundAssistantSnapshotReplacement,
};
export { syncCookies } from "./cookies.js";
export {
  navigateToChatGPT,
  ensureNotBlocked,
  ensurePromptReady,
  ensureModelSelection,
  submitPrompt,
  waitForAssistantResponse,
  captureAssistantMarkdown,
  uploadAttachmentFile,
  waitForAttachmentCompletion,
} from "./pageActions.js";

export async function maybeReuseRunningChromeForTest(
  userDataDir: string,
  logger: BrowserLogger,
  options: {
    waitForPortMs?: number;
    probe?: typeof verifyDevToolsReachable;
    verifyOwner?: typeof verifyChromeDebugTargetOwner;
  } = {},
): Promise<LaunchedChrome | null> {
  return maybeReuseRunningChrome(userDataDir, logger, options);
}

export async function acquireManualLoginChromeForRunForTest(
  userDataDir: string,
  config: ReturnType<typeof resolveBrowserConfig>,
  logger: BrowserLogger,
  sessionId: string | undefined,
  deps: {
    maybeReuse?: typeof maybeReuseRunningChrome;
    launch?: typeof launchChrome;
  },
): Promise<{ chrome: BrowserChrome; reusedChrome: LaunchedChrome | null }> {
  return acquireManualLoginChromeForRun(userDataDir, config, logger, sessionId, deps);
}

export function isWebSocketClosureError(error: Error): boolean {
  const message = error.message.toLowerCase();
  return (
    message.includes("websocket connection closed") ||
    message.includes("websocket is closed") ||
    message.includes("websocket error") ||
    message.includes("inspected target navigated or closed") ||
    message.includes("target closed")
  );
}

async function waitForAssistantResponseWithReload(
  Runtime: ChromeClient["Runtime"],
  Page: ChromeClient["Page"],
  timeoutMs: number,
  logger: BrowserLogger,
  minTurnIndex?: number,
  expectedConversationId?: string,
  accountId?: string,
  deps: {
    waitForResponse?: typeof waitForAssistantResponse;
    waitForHydration?: typeof waitForResumedConversationHydration;
    wait?: typeof delay;
    assertAccess?: typeof assertPreRunAccessState;
    elapsedBaselineMs?: number;
    now?: () => number;
  } = {},
) {
  const waitForResponse = deps.waitForResponse ?? waitForAssistantResponse;
  const now = deps.now ?? Date.now;
  const waitStartedAt = now();
  const elapsedBaselineMs = Math.max(0, deps.elapsedBaselineMs ?? 0);
  try {
    return await waitForResponse(
      Runtime,
      timeoutMs,
      logger,
      minTurnIndex,
      expectedConversationId,
      accountId,
      elapsedBaselineMs,
    );
  } catch (error) {
    if (!shouldReloadAfterAssistantError(error)) {
      throw error;
    }
    const conversationUrl = await readConversationUrl(Runtime);
    if (!conversationUrl || !isConversationUrl(conversationUrl)) {
      throw error;
    }
    const openConversationId = extractConversationIdFromUrl(conversationUrl);
    const normalizedExpectedConversationId = expectedConversationId
      ? normalizeChatGptConversationId(expectedConversationId)
      : null;
    if (
      !normalizedExpectedConversationId ||
      !openConversationId ||
      openConversationId !== normalizedExpectedConversationId
    ) {
      throw error;
    }
    const retryConversationId = normalizedExpectedConversationId;
    logger(
      "Assistant response stalled; reloading the bound conversation and retrying once after hydration",
    );
    // Give ChatGPT's backend a short bounded window to persist a just-finished
    // compact Pro answer before reopening the canonical route. We never accept
    // the answer on elapsed time alone: the retry still has to pass exact-turn
    // completion capture and the submit-time user-message binding assertion.
    await (deps.wait ?? delay)(1_500);
    await Page.navigate({ url: conversationUrl });
    const assertAccess = deps.assertAccess ?? assertPreRunAccessState;
    await assertAccess(Runtime, logger, {
      quarantine: { accountId },
    });
    try {
      await (deps.waitForHydration ?? waitForResumedConversationHydration)(
        Runtime,
        Math.min(Math.max(timeoutMs, 5_000), 30_000),
        logger,
        {
          // This is capture-only recovery. A still-running Pro response may keep
          // the composer disabled, so hydration must not wait for a send-ready
          // composer (and this fallback must never prepare another submission).
          ensurePromptReady: async () => undefined,
          requirePriorTurns: true,
          expectedConversationUrl: conversationUrl,
        },
      );
    } catch (hydrationError) {
      await assertAccess(Runtime, logger, { quarantine: { accountId } });
      throw hydrationError;
    }
    const retryElapsedBaselineMs = elapsedBaselineMs + Math.max(0, now() - waitStartedAt);
    return await waitForResponse(
      Runtime,
      timeoutMs,
      logger,
      minTurnIndex,
      retryConversationId,
      accountId,
      retryElapsedBaselineMs,
    );
  }
}

function shouldReloadAfterAssistantError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error instanceof BrowserAutomationError) {
    const stage = (error.details as { stage?: unknown } | undefined)?.stage;
    return stage === "assistant-timeout";
  }
  const message = error.message.toLowerCase();
  return (
    message.includes("assistant-response") ||
    message.includes("watchdog") ||
    message.includes("timeout") ||
    message.includes("capture assistant response")
  );
}

function isAssistantResponseTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  // Typed browser errors carry their stable classification in details.stage.
  // Never reinterpret capture-binding, challenge, or other typed failures from
  // human-readable text such as "Captured assistant response failed ...".
  if (error instanceof BrowserAutomationError) {
    const stage = (error.details as { stage?: unknown } | undefined)?.stage;
    return stage === "assistant-timeout";
  }
  const message = error.message.toLowerCase();
  if (!message) return false;
  return (
    message === "response timeout" ||
    message.includes("assistant-response") ||
    message.includes("assistant response") ||
    message.includes("watchdog") ||
    message.includes("capture assistant response")
  );
}

async function readConversationUrl(Runtime: ChromeClient["Runtime"]): Promise<string | null> {
  try {
    const currentUrl = await Runtime.evaluate({ expression: "location.href", returnByValue: true });
    return typeof currentUrl.result?.value === "string" ? currentUrl.result.value : null;
  } catch {
    return null;
  }
}

interface SessionValidationResult {
  valid: boolean;
  reason?: string;
}

/**
 * Validates that the ChatGPT session is still active by checking for login CTAs
 * and textarea availability. Sessions can expire during long delays (e.g., recheck).
 *
 * @param Runtime - Chrome Runtime client
 * @param logger - Browser logger for diagnostics
 * @returns SessionValidationResult indicating if session is valid and reason if not
 */
async function validateChatGPTSession(
  Runtime: ChromeClient["Runtime"],
  logger: BrowserLogger,
): Promise<SessionValidationResult> {
  try {
    const outcome = await Runtime.evaluate({
      expression: buildSessionValidationExpression(),
      awaitPromise: true,
      returnByValue: true,
    });

    const result = outcome.result?.value as
      | {
          valid: boolean;
          hasLoginCta: boolean;
          hasTextarea: boolean;
          onAuthPage: boolean;
          pageUrl: string | null;
        }
      | undefined;

    if (!result) {
      return { valid: false, reason: "Failed to evaluate session state" };
    }

    if (result.onAuthPage) {
      return { valid: false, reason: "Redirected to auth page" };
    }

    if (result.hasLoginCta) {
      return { valid: false, reason: "Login button detected on page" };
    }

    if (!result.hasTextarea) {
      return { valid: false, reason: "Prompt textarea not available" };
    }

    return { valid: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger(`[browser] Session validation error: ${message}`);
    return { valid: false, reason: `Validation error: ${message}` };
  }
}

function buildSessionValidationExpression(): string {
  const selectorLiteral = JSON.stringify(INPUT_SELECTORS);
  return `(async () => {
    const pageUrl = typeof location === 'object' && location?.href ? location.href : null;
    const onAuthPage =
      typeof location === 'object' &&
      typeof location.pathname === 'string' &&
      /^\\/(auth|login|signin)/i.test(location.pathname);

    // Check for login CTAs (similar to ensureLoggedIn logic)
    const hasLoginCta = (() => {
      const candidates = Array.from(
        document.querySelectorAll(
          [
            'a[href*="/auth/login"]',
            'a[href*="/auth/signin"]',
            'button[type="submit"]',
            'button[data-testid*="login"]',
            'button[data-testid*="log-in"]',
            'button[data-testid*="sign-in"]',
            'button[data-testid*="signin"]',
            'button',
            'a',
          ].join(','),
        ),
      );
      const textMatches = (text) => {
        if (!text) return false;
        const normalized = text.toLowerCase().trim();
        return ['log in', 'login', 'sign in', 'signin', 'continue with'].some((needle) =>
          normalized.startsWith(needle),
        );
      };
      for (const node of candidates) {
        if (!(node instanceof HTMLElement)) continue;
        const label =
          node.textContent?.trim() ||
          node.getAttribute('aria-label') ||
          node.getAttribute('title') ||
          '';
        if (textMatches(label)) {
          return true;
        }
      }
      return false;
    })();

    // Check for textarea availability
    const hasTextarea = (() => {
      const selectors = ${selectorLiteral};
      for (const selector of selectors) {
        const node = document.querySelector(selector);
        if (node) {
          return true;
        }
      }
      return false;
    })();

    return {
      valid: !onAuthPage && !hasLoginCta && hasTextarea,
      hasLoginCta,
      hasTextarea,
      onAuthPage,
      pageUrl,
    };
  })()`;
}

async function readConversationTurnCount(
  Runtime: ChromeClient["Runtime"],
  logger?: BrowserLogger,
): Promise<number | null> {
  const expression = buildConversationTurnCountExpression();
  const attempts = 4;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const { result } = await Runtime.evaluate({
        expression,
        returnByValue: true,
      });
      const raw = typeof result?.value === "number" ? result.value : Number(result?.value);
      if (!Number.isFinite(raw)) {
        throw new Error("Turn count not numeric");
      }
      return Math.max(0, Math.floor(raw));
    } catch (error) {
      if (attempt < attempts - 1) {
        await delay(150);
        continue;
      }
      if (logger?.verbose) {
        logger(
          `Failed to read conversation turn count: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return null;
    }
  }
  return null;
}

function describeDevtoolsFirewallHint(host: string, port: number): string | null {
  if (!isWsl()) return null;
  return [
    `DevTools port ${host}:${port} is blocked from WSL.`,
    "",
    "PowerShell (admin):",
    `New-NetFirewallRule -DisplayName 'Chrome DevTools ${port}' -Direction Inbound -Action Allow -Protocol TCP -LocalPort ${port}`,
    "New-NetFirewallRule -DisplayName 'Chrome DevTools (chrome.exe)' -Direction Inbound -Action Allow -Program 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' -Protocol TCP",
    "",
    "Re-run the same oracle command after adding the rule.",
  ].join("\n");
}

function isWsl(): boolean {
  if (process.platform !== "linux") return false;
  if (process.env.WSL_DISTRO_NAME) return true;
  return os.release().toLowerCase().includes("microsoft");
}

async function resolveUserDataBaseDir(): Promise<string> {
  // On WSL, Chrome launched via Windows can choke on UNC paths; prefer a Windows-backed temp folder.
  if (isWsl()) {
    const candidates = [
      "/mnt/c/Users/Public/AppData/Local/Temp",
      "/mnt/c/Temp",
      "/mnt/c/Windows/Temp",
    ];
    for (const candidate of candidates) {
      try {
        await mkdir(candidate, { recursive: true });
        return candidate;
      } catch {
        // try next
      }
    }
  }
  const tmpDir = os.tmpdir();
  if (shouldPreferSystemTmpDir(process.platform, tmpDir, os.homedir())) {
    try {
      await mkdir("/tmp", { recursive: true });
      return "/tmp";
    } catch {
      // Fall back to the inherited tmpdir if /tmp is unavailable.
    }
  }
  return tmpDir;
}

function shouldPreferSystemTmpDir(
  platform: NodeJS.Platform,
  tmpDir: string,
  homeDir: string,
): boolean {
  if (platform !== "linux" || !tmpDir || !homeDir) return false;
  const relativeToHome = path.relative(homeDir, tmpDir);
  if (!relativeToHome || relativeToHome.startsWith("..") || path.isAbsolute(relativeToHome)) {
    return false;
  }
  const firstSegment = relativeToHome.split(path.sep, 1)[0];
  return Boolean(firstSegment?.startsWith("."));
}

export function shouldPreferSystemTmpDirForTest(
  platform: NodeJS.Platform,
  tmpDir: string,
  homeDir: string,
): boolean {
  return shouldPreferSystemTmpDir(platform, tmpDir, homeDir);
}

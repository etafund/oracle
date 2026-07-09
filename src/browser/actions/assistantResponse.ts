import type { ChromeClient, BrowserLogger } from "../types.js";
import {
  ANSWER_SELECTORS,
  ASSISTANT_ROLE_SELECTOR,
  CONVERSATION_TURN_SELECTOR,
  COPY_BUTTON_SELECTOR,
  FINISHED_ACTIONS_SELECTOR,
  MIN_TRUSTWORTHY_ANSWER_CHARS,
  STOP_BUTTON_SELECTORS,
} from "../constants.js";
import { buildConversationTurnListExpression } from "../conversationTurns.js";
import { chatgptSelectorList } from "../selectors/chatgpt/index.js";
import { delay } from "../utils.js";
import {
  logDomFailure,
  logConversationSnapshot,
  buildConversationDebugExpression,
} from "../domDebug.js";
import { buildClickDispatcher } from "./domEvents.js";

const ASSISTANT_POLL_TIMEOUT_ERROR = "assistant-response-watchdog-timeout";
const STOP_CONTROL_SELECTOR = STOP_BUTTON_SELECTORS.join(", ");
const MIN_CONFIDENT_ANSWER_LENGTH = 16;
const PREAMBLE_SIZED_ANSWER_CHARS = 500;
const PREAMBLE_COMPLETION_STABLE_MS = 60_000;
const PRO_PREAMBLE_COMPLETION_STABLE_MS = 5 * 60_000;
// Consecutive accepting samples (~3.2s at the 400ms poll cadence) required
// before a non-compact answer is returned. At the thinking→answer transition
// the finished-action controls can flicker visible for a single sample while
// the thinking indicator is mid-teardown; one coincidental sample must never
// be enough to archive a stale preamble as the final answer (fetaos incident
// 2026-07-05: 203-char teaser accepted after a >60s Pro Extended pause).
const NONCOMPACT_ACCEPT_CONFIRM_SAMPLES = 8;
// After this much elapsed wait, a compact (<40 char) answer on bare
// stop-button absence is almost always a paused thinking stream (e.g. the
// literal section heading "1) Verdict"), not a real one-liner. Past this
// point compact answers also need finished-action controls.
const COMPACT_BARE_ACCEPT_MAX_ELAPSED_MS = 60_000;

function isImplausiblyShortAnswer(candidateLength: number): boolean {
  return candidateLength > 0 && candidateLength < MIN_CONFIDENT_ANSWER_LENGTH;
}

export function shouldConfirmAssistantCompletion(args: {
  candidateLength: number;
  stopVisible: boolean;
  completionVisible: boolean;
}): boolean {
  if (args.stopVisible || args.completionVisible) {
    return true;
  }
  return isImplausiblyShortAnswer(args.candidateLength);
}
const THINKING_STATUS_LABELS = [
  "thinking",
  "pro thinking",
  "thinking longer for a better answer",
  "reasoning",
  "finalizing answer",
  "finalizing",
  "analyzing",
  "researching",
  "working on it",
  "working",
  "planning",
  "searching the web",
  "searching",
  "reading",
];

const ANSWER_NOW_PLACEHOLDER_FRAGMENTS = [
  ...THINKING_STATUS_LABELS,
  "chatgpt said",
  "file upload request",
  "answer now",
  "edit",
].sort((left, right) => right.length - left.length);

function matchesThinkingStatusLabel(trimmed: string): boolean {
  if (!trimmed) return false;
  if (THINKING_STATUS_LABELS.includes(trimmed)) return true;
  if (trimmed.startsWith("thought for ") && trimmed.length <= 40) return true;
  return trimmed.startsWith("pro thinking") && trimmed.length <= 40;
}

function isAnswerNowPlaceholderText(normalized: string): boolean {
  const text = normalized.toLowerCase().replace(/\s+/g, " ").trim();
  if (!text) return false;
  // Learned: "Pro thinking" shows a placeholder turn that contains "Answer now".
  // That is not the final answer and must be ignored in browser automation.
  if (text === "chatgpt said:" || text === "chatgpt said") return true;
  if (text === "answer now" || text === "answer now edit") return true;
  if (
    text.includes("file upload request") &&
    (text.includes("pro thinking") || text.includes("chatgpt said"))
  ) {
    return true;
  }
  if (
    text.includes("answer now") &&
    (text.includes("pro thinking") || text.includes("chatgpt said"))
  ) {
    return true;
  }
  if (!text.includes("answer now")) return false;

  // ChatGPT can expose the thinking status and interrupt CTA as one assistant
  // snapshot (for example, "Finalizing answer\nAnswer now"). Strip only known
  // UI chrome and punctuation; any remaining words mean this is real prose that
  // merely mentions the control and must not be discarded.
  let remainder = text;
  for (const fragment of ANSWER_NOW_PLACEHOLDER_FRAGMENTS) {
    remainder = remainder.split(fragment).join(" ");
  }
  return remainder.replace(/[^a-z0-9]+/g, "").length === 0;
}

function buildAnswerNowPlaceholderPredicateJs(fnName: string): string {
  const fragmentsLiteral = JSON.stringify(ANSWER_NOW_PLACEHOLDER_FRAGMENTS);
  return `const ${fnName} = (snapshot) => {
    const normalized = String(snapshot?.text ?? '').toLowerCase().replace(/\\s+/g, ' ').trim();
    if (!normalized) return false;
    if (normalized === 'chatgpt said:' || normalized === 'chatgpt said') return true;
    if (normalized === 'answer now' || normalized === 'answer now edit') return true;
    if (normalized.includes('file upload request') && (normalized.includes('pro thinking') || normalized.includes('chatgpt said'))) {
      return true;
    }
    if (normalized.includes('answer now') && (normalized.includes('pro thinking') || normalized.includes('chatgpt said'))) {
      return true;
    }
    if (!normalized.includes('answer now')) return false;
    let remainder = normalized;
    for (const fragment of ${fragmentsLiteral}) {
      remainder = remainder.split(fragment).join(' ');
    }
    return remainder.replace(/[^a-z0-9]+/g, '').length === 0;
  };`;
}

function buildActiveThinkingStatusPredicateJs(fnName: string): string {
  const labelsLiteral = JSON.stringify(THINKING_STATUS_LABELS);
  return `const ${fnName} = (snapshot) => {
    const normalized = String(snapshot?.text ?? '').toLowerCase().replace(/\\s+/g, ' ').trim();
    if (!normalized) return false;
    const labels = ${labelsLiteral};
    const matches =
      labels.includes(normalized) ||
      (normalized.startsWith('thought for ') && normalized.length <= 40) ||
      (normalized.startsWith('pro thinking') && normalized.length <= 40);
    // Pure thinking/status labels are placeholders even if ChatGPT has hidden the
    // stop button during a Pro thinking transition.
    return matches;
  };`;
}

// Substring keywords that mark a LIVE thinking/reasoning status for the
// acceptance gate. Deliberately broader than THINKING_STATUS_LABELS (exact
// placeholder matches): a keyword missed here silently converts a thinking
// pause into a truncated capture, whereas a false positive only delays
// acceptance until the indicator disappears. Includes the localized stems the
// thinkingStatus.ts logging monitor already knew about — the acceptance gate
// never got them, so a localized UI disabled the only truncation guard.
const THINKING_GATE_KEYWORDS = [
  "thinking",
  "reasoning",
  "finalizing",
  "analyzing",
  "researching",
  "working on it",
  "planning",
  "searching",
  "deliberating",
  "thought for",
  // localized stems (mirrors thinkingStatus.ts looksLikeThinking hints)
  "myslen",
  "mysl",
  "rozumow",
  "denkt nach",
  "nachdenken",
  "raisonn",
  "pensando",
  "razonando",
];

// Structural "still generating" markers that do not depend on label text.
// ChatGPT applies result-streaming / data-is-streaming to the markdown block
// while tokens render; loading-shimmer is the animated status chip. Any of
// these visible means the turn is not final, whatever the label says.
const THINKING_GATE_STRUCTURAL_SELECTORS = [
  "span.loading-shimmer",
  ".result-streaming",
  '[data-is-streaming="true"]',
];

// A visible "Answer now" CTA is an explicit Pro-thinking liveness signal.
// It is sourced from the shared selector manifest so the acceptance gate stays
// aligned with provider diagnostics. This control is detection-only: Oracle
// must wait for the real response and must never click it.
const THINKING_GATE_ANSWER_NOW_SELECTORS = chatgptSelectorList("answer_now_cta");

const THINKING_GATE_LABEL_SELECTORS = [
  '[data-testid*="thinking"]',
  '[data-testid*="reasoning"]',
  '[role="status"]',
  '[aria-live="polite"]',
];

/**
 * Emit the single shared "is ChatGPT still generating?" DOM predicate used to
 * GATE answer acceptance. Both the Node-side isThinkingActive() probe and the
 * in-page observer embed this exact source, so the two acceptance loops can
 * no longer drift apart (they had independently-maintained copies before).
 */
function buildThinkingGatePredicateJs(fnName: string): string {
  const keywordsLiteral = JSON.stringify(THINKING_GATE_KEYWORDS);
  const structuralLiteral = JSON.stringify(THINKING_GATE_STRUCTURAL_SELECTORS);
  const answerNowLiteral = JSON.stringify(THINKING_GATE_ANSWER_NOW_SELECTORS);
  const labelSelectorsLiteral = JSON.stringify(THINKING_GATE_LABEL_SELECTORS);
  return `const ${fnName} = () => {
    const KEYWORDS = ${keywordsLiteral};
    const STRUCTURAL_SELECTORS = ${structuralLiteral};
    const ANSWER_NOW_SELECTORS = ${answerNowLiteral};
    const LABEL_SELECTORS = ${labelSelectorsLiteral};
    const normalize = (value) =>
      String(value || '').toLowerCase().replace(/\\s+/g, ' ').trim();
    const isVisible = (node) => {
      if (!(node instanceof HTMLElement)) return false;
      const rect = node.getBoundingClientRect();
      if (!rect || rect.width <= 0 || rect.height <= 0) return false;
      const style = window.getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      if (style.opacity !== '' && Number(style.opacity) === 0) return false;
      return true;
    };
    const isComposerAdjacent = (node) =>
      Boolean(node.closest?.('[contenteditable="true"], textarea, [data-testid*="composer"], [id*="composer"]'));
    const queryAll = (selector) => {
      try {
        return Array.from(document.querySelectorAll(selector));
      } catch {
        // Selector manifests may include tool-specific fallbacks (for example
        // :has-text) that native querySelectorAll does not understand.
        return [];
      }
    };
    const looksLikeThinking = (node) => {
      const label = normalize([
        node.textContent,
        node.getAttribute?.('aria-label'),
        node.getAttribute?.('title'),
        node.getAttribute?.('data-testid'),
      ].filter(Boolean).join(' '));
      if (!label) return false;
      return KEYWORDS.some((keyword) => label.includes(keyword));
    };
    // "Answer now" is an interrupt control shown while Pro is still thinking.
    // Visibility is authoritative regardless of where the UI mounts it. Detect
    // it only; this predicate never dispatches an interaction.
    for (const selector of ANSWER_NOW_SELECTORS) {
      const nodes = queryAll(selector);
      for (const node of nodes) {
        if (!(node instanceof HTMLElement)) continue;
        if (isVisible(node)) return true;
      }
    }
    // Structural markers are themselves proof of active generation; accept on
    // visibility alone (they carry no meaningful text).
    for (const selector of STRUCTURAL_SELECTORS) {
      const nodes = queryAll(selector);
      for (const node of nodes) {
        if (!(node instanceof HTMLElement)) continue;
        if (isVisible(node) && !isComposerAdjacent(node)) return true;
      }
    }
    for (const selector of LABEL_SELECTORS) {
      const nodes = queryAll(selector);
      for (const node of nodes) {
        if (!(node instanceof HTMLElement)) continue;
        if (isVisible(node) && !isComposerAdjacent(node) && looksLikeThinking(node)) {
          return true;
        }
      }
    }
    return false;
  };`;
}

export function buildThinkingGatePredicateJsForTest(fnName: string): string {
  return buildThinkingGatePredicateJs(fnName);
}

export function matchesThinkingStatusLabelForTest(text: string): boolean {
  return matchesThinkingStatusLabel(text.toLowerCase().replace(/\s+/g, " ").trim());
}

export function isAnswerNowPlaceholderTextForTest(text: string): boolean {
  return isAnswerNowPlaceholderText(text.toLowerCase().replace(/\s+/g, " ").trim());
}

export function buildAnswerNowPlaceholderPredicateJsForTest(fnName: string): string {
  return buildAnswerNowPlaceholderPredicateJs(fnName);
}

export function buildActiveThinkingStatusPredicateJsForTest(fnName: string): string {
  return buildActiveThinkingStatusPredicateJs(fnName);
}

function isPureThinkingStatusText(text: string): boolean {
  return matchesThinkingStatusLabel(text.toLowerCase().replace(/\s+/g, " ").trim());
}

type AssistantCompletionState = {
  stopVisible: boolean;
  completionVisible: boolean;
  /**
   * True when a ChatGPT "Pro thinking" / reasoning indicator is active for the
   * latest assistant turn. During Pro thinking the stop button legitimately
   * disappears while a short streamed preamble is visible, so stop-button
   * absence alone must NOT be treated as completion.
   */
  thinkingActive: boolean;
  currentLength: number;
  stableCycles: number;
  requiredStableCycles: number;
  completionStableTarget: number;
  stableMs: number;
  minStableMs: number;
  /**
   * Milliseconds since this wait began. A compact answer minutes into a run is
   * almost always a paused thinking stream, not a real one-liner; past
   * COMPACT_BARE_ACCEPT_MAX_ELAPSED_MS compact answers require finished-action
   * controls instead of bare stop-button absence. Optional so existing callers
   * and tests keep the historical fast-path behavior (0 = no gating).
   */
  elapsedMs?: number;
  /**
   * Sticky signal that a Pro thinking / streaming indicator appeared at any
   * point during this wait. Finished controls can appear during the
   * thinking-to-answer transition, so preamble-sized captures need a much
   * longer calm window in that territory.
   */
  thinkingObserved?: boolean;
};

function shouldAcceptStableAssistantSnapshot({
  stopVisible,
  completionVisible,
  thinkingActive,
  currentLength,
  stableCycles,
  requiredStableCycles,
  completionStableTarget,
  stableMs,
  minStableMs,
  elapsedMs = 0,
  thinkingObserved = false,
}: AssistantCompletionState): boolean {
  const ultraShortAnswer = currentLength === 1;
  const shortAnswer = currentLength > 0 && currentLength < 16;
  const mediumAnswer = currentLength >= 16 && currentLength < 40;
  const compactAnswer = shortAnswer || mediumAnswer;
  const preambleSizedAnswer = currentLength >= 40 && currentLength < PREAMBLE_SIZED_ANSWER_CHARS;
  const stableEnough = stableCycles >= requiredStableCycles && stableMs >= minStableMs;
  const completionEnough =
    completionVisible && stableCycles >= completionStableTarget && stableMs >= minStableMs;

  // A live "Pro thinking" indicator is authoritative: the real answer has not
  // finished regardless of stop-button / stability heuristics. Keep waiting.
  if (thinkingActive) {
    return false;
  }

  // ChatGPT can leave a live stop-button node after a short answer is already
  // rendered. Keep the normal anti-truncation guard, then accept only compact
  // stable answers so long Pro/thinking pauses still wait for real completion.
  if (stopVisible) {
    const staleStopStableMs = 12_000;
    return (
      !ultraShortAnswer &&
      compactAnswer &&
      stableCycles >= requiredStableCycles &&
      stableMs >= Math.max(minStableMs, staleStopStableMs)
    );
  }

  // Finished-action controls can appear on Pro thinking preambles before the
  // final answer expands. Trust them only after the text has stayed stable long
  // enough for preamble-sized captures; otherwise a one-sentence plan/review
  // preamble can be archived as a completed answer.
  if (completionEnough) {
    const preambleStableTargetMs = thinkingObserved
      ? PRO_PREAMBLE_COMPLETION_STABLE_MS
      : PREAMBLE_COMPLETION_STABLE_MS;
    if (preambleSizedAnswer && stableMs < preambleStableTargetMs) {
      return false;
    }
    return true;
  }

  // No stop button and no finished-action controls. For compact answers this is
  // the normal fast path. For substantial answers, bare stop-button absence is
  // unreliable (the Pro thinking gate hides it mid-turn), so never treat it as
  // final without finished-action controls.
  if (compactAnswer) {
    if (shortAnswer || ultraShortAnswer || !stableEnough) {
      return false;
    }
    // A compact answer minutes into the wait is almost always a paused
    // thinking stream ("1) Verdict"), not a real one-liner: past this point
    // only finished-action controls (handled above) prove it final.
    if (elapsedMs >= COMPACT_BARE_ACCEPT_MAX_ELAPSED_MS) {
      return false;
    }
    return true;
  }
  return false;
}

export function shouldAcceptStableAssistantSnapshotForTest(
  state: AssistantCompletionState,
): boolean {
  return shouldAcceptStableAssistantSnapshot(state);
}

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
  const start = Date.now();
  logger("Waiting for ChatGPT response");
  // Learned: two paths are needed:
  // 1) DOM observer (fast when mutations fire),
  // 2) snapshot poller (fallback when observers miss or JS stalls).
  const expression = buildResponseObserverExpression(
    timeoutMs,
    minTurnIndex,
    expectedConversationId,
  );
  const evaluationPromise = Runtime.evaluate({
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  const raceReadyEvaluation = evaluationPromise.then(
    (value) => ({ kind: "evaluation" as const, value }),
    (error) => {
      throw { source: "evaluation" as const, error };
    },
  );
  // Use AbortController to stop the poller when the evaluation wins the race,
  // preventing abandoned polling loops from consuming resources.
  const pollerAbort = new AbortController();
  const pollerPromise = pollAssistantCompletion(
    Runtime,
    timeoutMs,
    minTurnIndex,
    expectedConversationId,
    pollerAbort.signal,
  ).then(
    (value) => ({ kind: "poll" as const, value }),
    (error) => {
      throw { source: "poll" as const, error };
    },
  );

  let evaluation: Awaited<ReturnType<ChromeClient["Runtime"]["evaluate"]>> | null = null;
  try {
    const winner = await Promise.race([raceReadyEvaluation, pollerPromise]);
    if (winner.kind === "poll") {
      if (!winner.value) {
        throw { source: "poll" as const, error: new Error(ASSISTANT_POLL_TIMEOUT_ERROR) };
      }
      logger("Captured assistant response via snapshot watchdog");
      evaluationPromise.catch(() => undefined);
      await terminateRuntimeExecution(Runtime);
      return winner.value;
    }
    // Evaluation won - abort the poller to prevent it from running until timeout
    pollerAbort.abort();
    evaluation = winner.value;
  } catch (wrappedError) {
    if (
      wrappedError &&
      typeof wrappedError === "object" &&
      "source" in wrappedError &&
      "error" in wrappedError
    ) {
      const { source, error } = wrappedError as { source: string; error: unknown };
      if (
        source === "poll" &&
        error instanceof Error &&
        error.message === ASSISTANT_POLL_TIMEOUT_ERROR
      ) {
        evaluationPromise.catch(() => undefined);
        await terminateRuntimeExecution(Runtime);
        throw error;
      } else if (source === "poll") {
        throw error;
      } else if (source === "evaluation") {
        const recovered = await recoverAssistantResponse(
          Runtime,
          timeoutMs,
          logger,
          minTurnIndex,
          expectedConversationId,
          Date.now() - start,
        );
        if (recovered) {
          return recovered;
        }
        await logDomFailure(Runtime, logger, "assistant-response");
        throw error ?? new Error("Failed to capture assistant response");
      }
    } else {
      throw wrappedError;
    }
  }

  if (!evaluation) {
    await logDomFailure(Runtime, logger, "assistant-response");
    throw new Error("Failed to capture assistant response");
  }

  const parsed = await parseAssistantEvaluationResult(Runtime, evaluation, logger);
  if (!parsed) {
    let remainingMs = Math.max(0, timeoutMs - (Date.now() - start));
    if (remainingMs > 0) {
      const recovered = await recoverAssistantResponse(
        Runtime,
        remainingMs,
        logger,
        minTurnIndex,
        expectedConversationId,
        Date.now() - start,
      );
      if (recovered) {
        return recovered;
      }
      remainingMs = Math.max(0, timeoutMs - (Date.now() - start));
      if (remainingMs > 0) {
        const polled = await Promise.race([
          pollerPromise.catch(() => null),
          delay(remainingMs).then(() => null),
        ]);
        if (polled && polled.kind === "poll" && polled.value) {
          return polled.value;
        }
      }
    }
    await logDomFailure(Runtime, logger, "assistant-response");
    throw new Error("Unable to capture assistant response");
  }

  const refreshed = await refreshAssistantSnapshot(
    Runtime,
    parsed,
    logger,
    minTurnIndex,
    expectedConversationId,
  );
  const candidate = refreshed ?? parsed;
  if (isGeneratedImageAssistantAnswer(candidate)) {
    logger("Captured assistant generated image response");
    return candidate;
  }
  // The evaluation path can race ahead of completion. If ChatGPT is still streaming, wait for the watchdog poller.
  const elapsedMs = Date.now() - start;
  const remainingMs = Math.max(0, timeoutMs - elapsedMs);
  const candidateText = String(candidate?.text ?? "").trim();
  const suspiciouslyShort = isImplausiblyShortAnswer(candidateText.length);
  if (remainingMs > 0) {
    const [stopVisible, completionVisible, thinkingActive] = await Promise.all([
      isStopButtonVisible(Runtime),
      isCompletionVisible(Runtime),
      isThinkingActive(Runtime),
    ]);
    // Completion controls can appear briefly while Pro is still replacing its thinking UI.
    // Confirm every capture from that transition with the stability-based watchdog; a
    // partial first paragraph can be arbitrarily long.
    const ultraShortAnswer = candidateText.length === 1;
    // At the thinking→answer transition there is a third state where BOTH the
    // stop button and the finished-action controls are hidden. Returning the
    // candidate untouched from that window is how a stale mid-thinking
    // preamble becomes the archived answer, so preamble-sized candidates and
    // live-thinking captures must also be confirmed by the watchdog.
    const preambleSizedCandidate = candidateText.length < PREAMBLE_SIZED_ANSWER_CHARS;
    if (
      thinkingActive ||
      preambleSizedCandidate ||
      shouldConfirmAssistantCompletion({
        candidateLength: candidateText.length,
        stopVisible,
        completionVisible,
      })
    ) {
      logger(
        stopVisible
          ? "Assistant still generating; waiting for completion"
          : thinkingActive
            ? "Thinking indicator still active after capture; re-polling for completion"
            : ultraShortAnswer
              ? "Captured one-character assistant response; re-polling for completion"
              : candidateText.length < MIN_TRUSTWORTHY_ANSWER_CHARS
                ? "Captured suspiciously short answer at completion; re-polling for completion"
                : preambleSizedCandidate && !completionVisible
                  ? "Captured preamble-sized answer without completion controls; re-polling for completion"
                  : "Completion controls surfaced; confirming stable assistant response",
      );
      // A calm page (no stop button, no completion controls, no thinking
      // indicator) with a short candidate gets a bounded confirmation budget:
      // some layouts (project view / markdown fallback) never render
      // finished-action controls, and burning the entire response timeout
      // there would stall legitimate short answers. Visible generation UI
      // keeps the full budget because the page has told us it is not done.
      const calmShortCandidate = !stopVisible && !completionVisible && !thinkingActive;
      const confirmBudgetMs = calmShortCandidate ? Math.min(remainingMs, 90_000) : remainingMs;
      const completed = await pollAssistantCompletion(
        Runtime,
        confirmBudgetMs,
        minTurnIndex,
        expectedConversationId,
        undefined,
        elapsedMs,
      );
      if (completed && String(completed.text ?? "").trim().length >= candidateText.length) {
        return completed;
      }
      // Fail loud for the historical triggers: visible generation UI or a
      // one-character fragment means the page never reached a trustworthy
      // stable state. A silent teaser here is strictly worse than an error the
      // caller can retry.
      if (stopVisible || completionVisible || thinkingActive || ultraShortAnswer) {
        await logDomFailure(Runtime, logger, "assistant-response-unconfirmed-completion");
        throw new Error("Assistant response did not reach stable completion");
      }
      // Preamble-sized candidate on a calm page that the watchdog could not
      // confirm within its budget. The initial calm classification is a single
      // sample and can be wrong (indicator-teardown gap), so re-sample before
      // trusting anything: if generation is visibly active again, spend the
      // remaining real budget confirming and fail loud rather than archive a
      // mid-stream partial.
      const [stopNow, completionNow, thinkingNow] = await Promise.all([
        isStopButtonVisible(Runtime),
        isCompletionVisible(Runtime),
        isThinkingActive(Runtime),
      ]);
      const lastResortRead = async () =>
        normalizeAssistantSnapshot(
          await readAssistantSnapshot(Runtime, minTurnIndex, expectedConversationId).catch(
            () => null,
          ),
        );
      const firstRead = await lastResortRead();
      await delay(1500);
      const secondRead = await lastResortRead();
      const stillStreaming =
        (firstRead?.text ?? "") !== (secondRead?.text ?? "") || stopNow || thinkingNow;
      if (stillStreaming || completionNow) {
        const remainingBudgetMs = Math.max(0, timeoutMs - (Date.now() - start));
        if (stillStreaming && remainingBudgetMs > 0) {
          logger("Calm classification was stale; generation resumed — extending confirmation");
          const lateCompleted = await pollAssistantCompletion(
            Runtime,
            remainingBudgetMs,
            minTurnIndex,
            expectedConversationId,
            undefined,
            Date.now() - start,
          );
          if (
            lateCompleted &&
            String(lateCompleted.text ?? "").trim().length >= candidateText.length
          ) {
            return lateCompleted;
          }
          await logDomFailure(Runtime, logger, "assistant-response-unconfirmed-completion");
          throw new Error("Assistant response did not reach stable completion");
        }
      }
      // Genuinely calm and stable across both reads: prefer any strictly
      // longer snapshot the page produced since capture. After the compact
      // grace window, a preamble-sized calm capture is more likely a hidden
      // Pro-thinking pause than a real final answer, so fail loud instead of
      // returning the original teaser.
      if (secondRead && secondRead.text.trim().length > candidateText.length) {
        logger("Watchdog budget elapsed; returning the longer late snapshot");
        return secondRead;
      }
      if (
        suspiciouslyShort ||
        (preambleSizedCandidate && Date.now() - start >= COMPACT_BARE_ACCEPT_MAX_ELAPSED_MS)
      ) {
        await logDomFailure(Runtime, logger, "assistant-response-unconfirmed-completion");
        throw new Error(
          "assistant-response short capture could not be confirmed before timeout; refusing to finalize it",
        );
      }
      logger("Short answer could not be re-confirmed by the watchdog; returning original capture");
    }
  }

  if (suspiciouslyShort) {
    throw new Error(
      "assistant-response short capture could not be confirmed before timeout; refusing to finalize it",
    );
  }

  return candidate;
}

export async function readAssistantSnapshot(
  Runtime: ChromeClient["Runtime"],
  minTurnIndex?: number,
  expectedConversationId?: string,
): Promise<AssistantSnapshot | null> {
  const { result } = await Runtime.evaluate({
    expression: buildAssistantSnapshotExpression(minTurnIndex, expectedConversationId),
    returnByValue: true,
  });
  const value = result?.value;
  if (value && typeof value === "object") {
    const snapshot = value as AssistantSnapshot;
    if (typeof minTurnIndex === "number" && Number.isFinite(minTurnIndex)) {
      const turnIndex = typeof snapshot.turnIndex === "number" ? snapshot.turnIndex : null;
      const afterLatestUser = snapshot.afterLatestUser === true;
      if (turnIndex === null) {
        return snapshot;
      }
      if (turnIndex < minTurnIndex && !afterLatestUser) {
        return null;
      }
    }
    return snapshot;
  }
  return null;
}

export async function captureAssistantMarkdown(
  Runtime: ChromeClient["Runtime"],
  meta: { messageId?: string | null; turnId?: string | null },
  logger: BrowserLogger,
): Promise<string | null> {
  const { result } = await Runtime.evaluate({
    expression: buildCopyExpression(meta),
    returnByValue: true,
    awaitPromise: true,
  });
  if (result?.value?.success && typeof result.value.markdown === "string") {
    return result.value.markdown;
  }
  const status = result?.value?.status;
  if (status && status !== "missing-button") {
    logger(`Copy button fallback status: ${status}`);
    await logDomFailure(Runtime, logger, "copy-markdown");
  }
  if (!status) {
    await logDomFailure(Runtime, logger, "copy-markdown");
  }
  return null;
}

export function buildAssistantExtractorForTest(name: string): string {
  return buildAssistantExtractor(name);
}

export function buildAssistantSnapshotExpressionForTest(
  minTurnIndex?: number,
  expectedConversationId?: string,
): string {
  return buildAssistantSnapshotExpression(minTurnIndex, expectedConversationId);
}

export function buildConversationDebugExpressionForTest(): string {
  return buildConversationDebugExpression();
}

export function buildMarkdownFallbackExtractorForTest(minTurnLiteral = "0"): string {
  return buildMarkdownFallbackExtractor(minTurnLiteral);
}

export function buildCopyExpressionForTest(
  meta: { messageId?: string | null; turnId?: string | null } = {},
): string {
  return buildCopyExpression(meta);
}

export function buildCompletionVisibleExpressionForTest(): string {
  return buildCompletionVisibleExpression();
}

export function buildResponseObserverExpressionForTest(
  timeoutMs = 60_000,
  minTurnIndex?: number,
  expectedConversationId?: string,
): string {
  return buildResponseObserverExpression(timeoutMs, minTurnIndex, expectedConversationId);
}

async function recoverAssistantResponse(
  Runtime: ChromeClient["Runtime"],
  timeoutMs: number,
  logger: BrowserLogger,
  minTurnIndex?: number,
  expectedConversationId?: string,
  elapsedBaselineMs = 0,
): Promise<{
  text: string;
  html?: string;
  meta: { turnId?: string | null; messageId?: string | null };
} | null> {
  const recoveryTimeoutMs = Math.max(0, timeoutMs);
  if (recoveryTimeoutMs === 0) {
    return null;
  }
  const recoveryStartedAt = Date.now();
  // Thread the true elapsed-since-wait-start baseline through: recovery often
  // starts minutes into a run, and a zero baseline would re-open the bare
  // compact fast path that COMPACT_BARE_ACCEPT_MAX_ELAPSED_MS exists to close.
  const recovered = await pollAssistantCompletion(
    Runtime,
    recoveryTimeoutMs,
    minTurnIndex,
    expectedConversationId,
    undefined,
    elapsedBaselineMs,
  );
  if (recovered) {
    if (isImplausiblyShortAnswer(recovered.text.length)) {
      logger("Recovered an implausibly short response; waiting for completion proof");
      const remainingMs = Math.max(0, recoveryTimeoutMs - (Date.now() - recoveryStartedAt));
      return pollAssistantCompletion(Runtime, remainingMs, minTurnIndex, expectedConversationId);
    }
    logger("Recovered assistant response via polling fallback");
    return recovered;
  }
  await logConversationSnapshot(Runtime, logger).catch(() => undefined);
  return null;
}

async function parseAssistantEvaluationResult(
  _Runtime: ChromeClient["Runtime"],
  evaluation: Awaited<ReturnType<ChromeClient["Runtime"]["evaluate"]>>,
  _logger: BrowserLogger,
): Promise<{
  text: string;
  html?: string;
  meta: { turnId?: string | null; messageId?: string | null };
} | null> {
  const { result } = evaluation;
  if (
    result.type === "object" &&
    result.value &&
    typeof result.value === "object" &&
    "text" in result.value
  ) {
    const html =
      typeof (result.value as { html?: unknown }).html === "string"
        ? ((result.value as { html?: string }).html ?? undefined)
        : undefined;
    const turnId =
      typeof (result.value as { turnId?: unknown }).turnId === "string"
        ? ((result.value as { turnId?: string }).turnId ?? undefined)
        : undefined;
    const messageId =
      typeof (result.value as { messageId?: unknown }).messageId === "string"
        ? ((result.value as { messageId?: string }).messageId ?? undefined)
        : undefined;
    const text = cleanAssistantText(String((result.value as { text: unknown }).text ?? ""));
    const normalized = text.toLowerCase();
    if (isAnswerNowPlaceholderText(normalized) || isPureThinkingStatusText(text)) {
      return null;
    }
    return { text, html, meta: { turnId, messageId } };
  }
  const fallbackText =
    typeof result.value === "string" ? cleanAssistantText(result.value as string) : "";
  if (!fallbackText) {
    return null;
  }
  if (
    isAnswerNowPlaceholderText(fallbackText.toLowerCase()) ||
    isPureThinkingStatusText(fallbackText)
  ) {
    return null;
  }
  return { text: fallbackText, html: undefined, meta: {} };
}

async function refreshAssistantSnapshot(
  Runtime: ChromeClient["Runtime"],
  current: {
    text: string;
    html?: string;
    meta: { turnId?: string | null; messageId?: string | null };
  },
  logger: BrowserLogger,
  minTurnIndex?: number,
  expectedConversationId?: string,
): Promise<{
  text: string;
  html?: string;
  meta: { turnId?: string | null; messageId?: string | null };
} | null> {
  const deadline = Date.now() + 5_000;
  let best: {
    text: string;
    html?: string;
    meta: { turnId?: string | null; messageId?: string | null };
  } | null = null;
  let stableCycles = 0;
  const stableTarget = 3;
  while (Date.now() < deadline) {
    // Learned: short/fast answers can race; poll a few extra cycles to pick up messageId + full text.
    const latestSnapshot = await readAssistantSnapshot(
      Runtime,
      minTurnIndex,
      expectedConversationId,
    ).catch(() => null);
    const latest = normalizeAssistantSnapshot(latestSnapshot);
    if (latest) {
      if (
        !best ||
        latest.text.length > best.text.length ||
        (!best.meta.messageId && latest.meta.messageId)
      ) {
        best = latest;
        stableCycles = 0;
      } else if (latest.text.trim() === best.text.trim()) {
        stableCycles += 1;
      }
    }
    if (best && stableCycles >= stableTarget) {
      break;
    }
    await delay(300);
  }
  if (!best) {
    return null;
  }
  const currentLength = cleanAssistantText(current.text).trim().length;
  const latestLength = best.text.length;
  const hasBetterId = !current.meta?.messageId && Boolean(best.meta.messageId);
  const hasDifferentText = best.text.trim() !== current.text.trim();
  if (
    !shouldReplaceAssistantSnapshot({ currentLength, latestLength, hasBetterId, hasDifferentText })
  ) {
    // The re-read may still carry the message/turn ids the candidate lacks
    // (e.g. the candidate came from the markdown fallback): keep the longer
    // candidate text but adopt the ids so exact-turn copy targeting works.
    if (hasBetterId) {
      logger("Adopted message ids from latest snapshot without replacing text");
      return {
        ...current,
        meta: {
          ...current.meta,
          messageId: best.meta.messageId,
          turnId: current.meta?.turnId ?? best.meta.turnId,
        },
      };
    }
    return null;
  }
  logger("Refreshed assistant response via latest snapshot");
  return best;
}

/**
 * Decide whether a re-read snapshot may replace the already-parsed candidate.
 * A turn re-render, virtualization, or an extractor pivot to a fallback node
 * can produce a snapshot with strictly SHORTER text than the candidate;
 * replacing on "different text" alone shrank good captures to a one-line
 * teaser right before the unguarded return. Never trade text away.
 */
function shouldReplaceAssistantSnapshot({
  currentLength,
  latestLength,
  hasBetterId,
  hasDifferentText,
}: {
  currentLength: number;
  latestLength: number;
  hasBetterId: boolean;
  hasDifferentText: boolean;
}): boolean {
  if (latestLength < currentLength) {
    return false;
  }
  return latestLength > currentLength || hasBetterId || hasDifferentText;
}

export function shouldReplaceAssistantSnapshotForTest(state: {
  currentLength: number;
  latestLength: number;
  hasBetterId: boolean;
  hasDifferentText: boolean;
}): boolean {
  return shouldReplaceAssistantSnapshot(state);
}

async function terminateRuntimeExecution(Runtime: ChromeClient["Runtime"]): Promise<void> {
  if (typeof Runtime.terminateExecution !== "function") {
    return;
  }
  try {
    await Runtime.terminateExecution();
  } catch {
    // ignore termination failures
  }
}

async function pollAssistantCompletion(
  Runtime: ChromeClient["Runtime"],
  timeoutMs: number,
  minTurnIndex?: number,
  expectedConversationId?: string,
  abortSignal?: AbortSignal,
  elapsedBaselineMs = 0,
): Promise<{
  text: string;
  html?: string;
  meta: { turnId?: string | null; messageId?: string | null };
} | null> {
  const pollStartedAt = Date.now();
  const watchdogDeadline = pollStartedAt + timeoutMs;
  let previousLength = 0;
  let stableCycles = 0;
  let lastChangeAt = Date.now();
  // Consecutive samples for which the acceptance predicate held. A single
  // 400ms sample can coincide with a finished-action flicker during a
  // thinking pause; non-compact answers must hold acceptance across
  // NONCOMPACT_ACCEPT_CONFIRM_SAMPLES samples (~3.2s) so the real answer
  // streaming in right after the transition resets the decision.
  let acceptStreak = 0;
  // Sticky: a thinking indicator observed at any point during this poll.
  let sawThinking = false;
  while (Date.now() < watchdogDeadline) {
    // Check abort signal to stop polling when another path won the race
    if (abortSignal?.aborted) {
      return null;
    }
    const snapshot = await readAssistantSnapshot(Runtime, minTurnIndex, expectedConversationId);
    const normalized = normalizeAssistantSnapshot(snapshot);
    if (normalized) {
      const currentLength = normalized.text.length;
      if (currentLength > previousLength) {
        previousLength = currentLength;
        stableCycles = 0;
        lastChangeAt = Date.now();
      } else {
        stableCycles += 1;
      }
      const [stopVisible, completionVisible, thinkingActive] = await Promise.all([
        isStopButtonVisible(Runtime),
        isCompletionVisible(Runtime),
        isThinkingActive(Runtime),
      ]);
      if (isGeneratedImageAssistantAnswer(normalized)) {
        return normalized;
      }
      if (thinkingActive) {
        // A live thinking indicator IS activity: the answer is not final and
        // the current text is mid-stream. Without this reset, a >60s thinking
        // pause pre-satisfies every idle window and acceptance collapses to a
        // one-sample race at the thinking→answer transition (the 42-token
        // teaser incident).
        sawThinking = true;
        stableCycles = 0;
        lastChangeAt = Date.now();
        acceptStreak = 0;
      }
      const shortAnswer = isImplausiblyShortAnswer(currentLength);
      const mediumAnswer = currentLength >= MIN_CONFIDENT_ANSWER_LENGTH && currentLength < 40;
      const longAnswer = currentLength >= 40 && currentLength < 500;
      // Learned: short answers need a longer stability window or they truncate.
      // Learned: long streaming responses (esp. thinking models) can pause mid-stream;
      // use progressively longer windows to avoid truncation (#71).
      const completionStableTarget = shortAnswer ? 12 : mediumAnswer ? 8 : longAnswer ? 6 : 8;
      const requiredStableCycles = shortAnswer ? 12 : mediumAnswer ? 8 : longAnswer ? 8 : 10;
      const stableMs = Date.now() - lastChangeAt;
      const minStableMs = shortAnswer ? 8000 : mediumAnswer ? 1200 : longAnswer ? 2000 : 3000;
      const elapsedMs = elapsedBaselineMs + (Date.now() - pollStartedAt);
      const accepted = shouldAcceptStableAssistantSnapshot({
        stopVisible,
        completionVisible,
        thinkingActive,
        currentLength,
        stableCycles,
        requiredStableCycles,
        completionStableTarget,
        stableMs,
        minStableMs,
        elapsedMs,
        thinkingObserved: sawThinking,
      });
      if (accepted) {
        acceptStreak += 1;
        const compactAnswer = currentLength > 0 && currentLength < 40;
        // The multi-sample confirmation guards against finished-controls
        // flickers during thinking pauses. Only waits in thinking territory
        // (indicator seen, or long-elapsed — covering detection misses) pay
        // the extra ~3.2s; ordinary fast captures return on first acceptance.
        const requireStreak = sawThinking || elapsedMs >= COMPACT_BARE_ACCEPT_MAX_ELAPSED_MS;
        if (compactAnswer || !requireStreak || acceptStreak >= NONCOMPACT_ACCEPT_CONFIRM_SAMPLES) {
          return normalized;
        }
      } else {
        acceptStreak = 0;
      }
    } else {
      previousLength = 0;
      stableCycles = 0;
      acceptStreak = 0;
    }
    await delay(400);
  }
  return null;
}

async function isStopButtonVisible(Runtime: ChromeClient["Runtime"]): Promise<boolean> {
  try {
    const { result } = await Runtime.evaluate({
      expression: buildStopButtonVisibilityExpression(),
      returnByValue: true,
    });
    return result?.value === true;
  } catch {
    return false;
  }
}

/**
 * Detect an active ChatGPT "Pro thinking" / reasoning indicator.
 *
 * During a Pro thinking pause the stop button disappears while a short streamed
 * preamble may already be on screen. Relying on stop-button absence alone then
 * accepts the preamble as the final answer (truncation). A visible thinking /
 * reasoning indicator is an authoritative "still generating" signal, so callers
 * keep waiting while it is present. Evaluates the SAME shared gate predicate
 * the in-page observer embeds (buildThinkingGatePredicateJs) so the two
 * acceptance loops cannot drift apart again.
 */
async function isThinkingActive(Runtime: ChromeClient["Runtime"]): Promise<boolean> {
  try {
    const { result } = await Runtime.evaluate({
      expression: `(() => {
        ${buildThinkingGatePredicateJs("isThinkingGateActive")}
        return isThinkingGateActive();
      })()`,
      returnByValue: true,
    });
    return result?.value === true;
  } catch {
    return false;
  }
}

function buildStopButtonVisibilityExpression(): string {
  return `(() => {
    ${buildStopButtonVisibilityPredicateJs("isStopControlVisible")}
    return isStopControlVisible();
  })()`;
}

function buildStopButtonVisibilityPredicateJs(fnName: string): string {
  const selectorLiteral = JSON.stringify(STOP_CONTROL_SELECTOR);
  return `const ${fnName} = () => {
    const isVisible = (node) => {
      if (!(node instanceof HTMLElement)) return false;
      const rect = node.getBoundingClientRect();
      if (!rect || rect.width <= 0 || rect.height <= 0) return false;
      const style = window.getComputedStyle(node);
      return !(
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        (style.opacity !== '' && Number(style.opacity) === 0)
      );
    };
    return Array.from(document.querySelectorAll(${selectorLiteral})).some((node) => isVisible(node));
  };`;
}

export const buildStopButtonVisibilityExpressionForTest = buildStopButtonVisibilityExpression;

async function isCompletionVisible(Runtime: ChromeClient["Runtime"]): Promise<boolean> {
  try {
    const { result } = await Runtime.evaluate({
      expression: buildCompletionVisibleExpression(),
      returnByValue: true,
    });
    return result?.value === true;
  } catch {
    return false;
  }
}

function buildCompletionVisibleExpression(): string {
  return `(() => {
    // Find the LAST assistant turn to check completion status
    // Must match the same logic as buildAssistantExtractor for consistency
    const ASSISTANT_SELECTOR = '${ASSISTANT_ROLE_SELECTOR}';
    const isAssistantTurn = (node) => {
      if (!(node instanceof HTMLElement)) return false;
      const turnAttr = (node.getAttribute('data-turn') || node.dataset?.turn || '').toLowerCase();
      if (turnAttr === 'assistant') return true;
      const role = (node.getAttribute('data-message-author-role') || node.dataset?.messageAuthorRole || '').toLowerCase();
      if (role === 'assistant') return true;
      const testId = (node.getAttribute('data-testid') || '').toLowerCase();
      if (testId.includes('assistant')) return true;
      return Boolean(node.querySelector(ASSISTANT_SELECTOR) || node.querySelector('[data-testid*="assistant"]'));
    };

    const turns = ${buildConversationTurnListExpression()};
    let lastAssistantTurn = null;
    for (let i = turns.length - 1; i >= 0; i--) {
      if (isAssistantTurn(turns[i])) {
        lastAssistantTurn = turns[i];
        break;
      }
    }
    if (!lastAssistantTurn) {
      return false;
    }
    const turnScope =
      lastAssistantTurn.closest('article[data-testid^="conversation-turn"], section[data-testid^="conversation-turn"], div[data-testid^="conversation-turn"]') ||
      lastAssistantTurn;
    // Check if the last assistant turn has finished action buttons (copy, thumbs up/down, share)
    if (turnScope.querySelector('${FINISHED_ACTIONS_SELECTOR}')) {
      return true;
    }
    // Also check for "Done" text in the last assistant turn's markdown
    const markdowns = turnScope.querySelectorAll('.markdown');
    return Array.from(markdowns).some((n) => (n.textContent || '').trim() === 'Done');
  })()`;
}

function normalizeAssistantSnapshot(snapshot: AssistantSnapshot | null): {
  text: string;
  html?: string;
  meta: { turnId?: string | null; messageId?: string | null };
} | null {
  const text = snapshot?.text ? cleanAssistantText(snapshot.text) : "";
  if (!text.trim()) {
    return null;
  }
  const normalized = text.toLowerCase();
  // "Pro thinking" often renders a placeholder turn containing an "Answer now" gate.
  // Treat it as incomplete so browser mode keeps waiting for the real assistant text.
  if (isAnswerNowPlaceholderText(normalized) || isPureThinkingStatusText(text)) {
    return null;
  }
  // Ignore user echo turns that can show up in project view fallbacks.
  if (normalized.startsWith("you said")) {
    return null;
  }
  return {
    text,
    html: snapshot?.html ?? undefined,
    meta: { turnId: snapshot?.turnId ?? undefined, messageId: snapshot?.messageId ?? undefined },
  };
}

function isGeneratedImageAssistantAnswer(answer: { html?: string } | null): boolean {
  return Boolean(answer?.html?.includes("/backend-api/estuary/content?id=file_"));
}

function buildAssistantSnapshotExpression(
  minTurnIndex?: number,
  expectedConversationId?: string,
): string {
  const minTurnLiteral =
    typeof minTurnIndex === "number" && Number.isFinite(minTurnIndex) && minTurnIndex >= 0
      ? Math.floor(minTurnIndex)
      : -1;
  const expectedConversationLiteral =
    typeof expectedConversationId === "string" && expectedConversationId.trim().length > 0
      ? JSON.stringify(expectedConversationId.trim())
      : "null";
  return `(() => {
    const MIN_TURN_INDEX = ${minTurnLiteral};
    const EXPECTED_CONVERSATION_ID = ${expectedConversationLiteral};
    const currentHref = typeof location === 'object' && location.href ? location.href : '';
    const currentConversationId = currentHref.match(/\\/c\\/([a-zA-Z0-9-]+)/)?.[1] ?? null;
    if (
      EXPECTED_CONVERSATION_ID &&
      currentConversationId &&
      currentConversationId !== EXPECTED_CONVERSATION_ID
    ) {
      return null;
    }
    // Learned: the default turn DOM misses project view; keep a fallback extractor.
    ${buildAssistantExtractor("extractAssistantTurn")}
    const extracted = extractAssistantTurn();
    ${buildAnswerNowPlaceholderPredicateJs("isPlaceholder")}
    ${buildActiveThinkingStatusPredicateJs("isActiveThinkingStatus")}
    if (
      extracted &&
      extracted.text &&
      !isPlaceholder(extracted) &&
      !isActiveThinkingStatus(extracted)
    ) {
      return extracted;
    }
    // Fallback for ChatGPT project view: answers can live outside conversation turns.
    const extractFallback = ${buildMarkdownFallbackExtractor("MIN_TURN_INDEX")};
    const fallback = extractFallback();
    if (fallback && !isPlaceholder(fallback) && !isActiveThinkingStatus(fallback)) {
      return fallback;
    }
    return null;
  })()`;
}

function buildResponseObserverExpression(
  timeoutMs: number,
  minTurnIndex?: number,
  expectedConversationId?: string,
): string {
  const selectorsLiteral = JSON.stringify(ANSWER_SELECTORS);
  const assistantLiteral = JSON.stringify(ASSISTANT_ROLE_SELECTOR);
  const minTurnLiteral =
    typeof minTurnIndex === "number" && Number.isFinite(minTurnIndex) && minTurnIndex >= 0
      ? Math.floor(minTurnIndex)
      : -1;
  const expectedConversationLiteral =
    typeof expectedConversationId === "string" && expectedConversationId.trim().length > 0
      ? JSON.stringify(expectedConversationId.trim())
      : "null";
  return `(() => {
    ${buildClickDispatcher()}
    const SELECTORS = ${selectorsLiteral};
    const STOP_SELECTOR = ${JSON.stringify(STOP_CONTROL_SELECTOR)};
    const FINISHED_SELECTOR = '${FINISHED_ACTIONS_SELECTOR}';
    const PREAMBLE_SIZED_ANSWER_CHARS = ${PREAMBLE_SIZED_ANSWER_CHARS};
    const PREAMBLE_COMPLETION_STABLE_MS = ${PREAMBLE_COMPLETION_STABLE_MS};
    const NONCOMPACT_ACCEPT_CONFIRM_SAMPLES = ${NONCOMPACT_ACCEPT_CONFIRM_SAMPLES};
    const COMPACT_BARE_ACCEPT_MAX_ELAPSED_MS = ${COMPACT_BARE_ACCEPT_MAX_ELAPSED_MS};
    // Anchor for every elapsed-time gate in this expression. waitForSettle can
    // start minutes into the wait (captureViaObserver resolves only when the
    // FIRST extractable text appears — for thinking models that is when the
    // answer body starts streaming), so measuring elapsed from settle entry
    // would reset the compact grace window exactly when the incident occurs.
    const waitStartedAt = Date.now();
    const ASSISTANT_SELECTOR = ${assistantLiteral};
    const EXPECTED_CONVERSATION_ID = ${expectedConversationLiteral};
    // Learned: settling avoids capturing mid-stream HTML; keep short.
    const settleDelayMs = 800;
    const currentConversationId = () => {
      const href = typeof location === 'object' && location.href ? location.href : '';
      return href.match(/\\/c\\/([a-zA-Z0-9-]+)/)?.[1] ?? null;
    };
    const matchesExpectedConversation = () => {
      if (!EXPECTED_CONVERSATION_ID) return true;
      const currentId = currentConversationId();
      return !currentId || currentId === EXPECTED_CONVERSATION_ID;
    };
    ${buildAnswerNowPlaceholderPredicateJs("isAnswerNowPlaceholder")}
    ${buildActiveThinkingStatusPredicateJs("isActiveThinkingStatus")}

    // Helper to detect assistant turns - must match buildAssistantExtractor logic for consistency.
    const isAssistantTurn = (node) => {
      if (!(node instanceof HTMLElement)) return false;
      const turnAttr = (node.getAttribute('data-turn') || node.dataset?.turn || '').toLowerCase();
      if (turnAttr === 'assistant') return true;
      const role = (node.getAttribute('data-message-author-role') || node.dataset?.messageAuthorRole || '').toLowerCase();
      if (role === 'assistant') return true;
      const testId = (node.getAttribute('data-testid') || '').toLowerCase();
      if (testId.includes('assistant')) return true;
      return Boolean(node.querySelector(ASSISTANT_SELECTOR) || node.querySelector('[data-testid*="assistant"]'));
    };

    const MIN_TURN_INDEX = ${minTurnLiteral};
    ${buildAssistantExtractor("extractFromTurns")}
    // Learned: some layouts (project view) render markdown without assistant turn wrappers.
    const extractFromMarkdownFallback = ${buildMarkdownFallbackExtractor("MIN_TURN_INDEX")};

    const acceptSnapshot = (snapshot) => {
      if (!snapshot) return null;
      if (!matchesExpectedConversation()) return null;
      const index = typeof snapshot.turnIndex === 'number' ? snapshot.turnIndex : -1;
      const afterLatestUser = snapshot.afterLatestUser === true;
      if (MIN_TURN_INDEX >= 0) {
        if ((index < 0 || index < MIN_TURN_INDEX) && !afterLatestUser) {
          return null;
        }
      }
      return snapshot;
    };

    const captureViaObserver = () =>
      new Promise((resolve, reject) => {
        const deadline = Date.now() + ${timeoutMs};
        let timeoutId = null;
        let cleanedUp = false;
        let observer = null;

        // Centralized cleanup to prevent resource leaks
        const cleanup = () => {
          if (cleanedUp) return;
          cleanedUp = true;
          if (timeoutId) {
            clearTimeout(timeoutId);
            timeoutId = null;
          }
          if (observer) {
            try {
              observer.disconnect();
            } catch {
              // ignore disconnect errors
            }
            observer = null;
          }
        };

        const observerCallback = () => {
          if (cleanedUp) return;
          try {
            const extractedRaw = extractFromTurns();
            const extractedCandidate =
              extractedRaw &&
              !isAnswerNowPlaceholder(extractedRaw) &&
              !isActiveThinkingStatus(extractedRaw)
                ? extractedRaw
                : null;
            let extracted = acceptSnapshot(extractedCandidate);
            if (!extracted) {
              const fallbackRaw = extractFromMarkdownFallback();
              const fallbackCandidate =
                fallbackRaw &&
                !isAnswerNowPlaceholder(fallbackRaw) &&
                !isActiveThinkingStatus(fallbackRaw)
                  ? fallbackRaw
                  : null;
              extracted = acceptSnapshot(fallbackCandidate);
            }
            if (extracted) {
              cleanup();
              resolve(extracted);
            } else if (Date.now() > deadline) {
              cleanup();
              reject(new Error('Response timeout'));
            }
          } catch (error) {
            cleanup();
            reject(error);
          }
        };

        observer = new MutationObserver(observerCallback);
        observer.observe(document.body, { childList: true, subtree: true, characterData: true });

        timeoutId = setTimeout(() => {
          cleanup();
          reject(new Error('Response timeout'));
        }, ${timeoutMs});
      });

    // Check if the last assistant turn has finished (scoped to avoid detecting old turns).
    const isLastAssistantTurnFinished = () => {
      const turns = ${buildConversationTurnListExpression()};
      let lastAssistantTurn = null;
      for (let i = turns.length - 1; i >= 0; i--) {
        if (isAssistantTurn(turns[i])) {
          lastAssistantTurn = turns[i];
          break;
        }
      }
      if (!lastAssistantTurn) return false;
      const turnScope =
        lastAssistantTurn.closest('article[data-testid^="conversation-turn"], section[data-testid^="conversation-turn"], div[data-testid^="conversation-turn"]') ||
        lastAssistantTurn;
      // Check for action buttons in this specific turn
      if (turnScope.querySelector(FINISHED_SELECTOR)) return true;
      // Check for "Done" text in this turn's markdown
      const markdowns = turnScope.querySelectorAll('.markdown');
      return Array.from(markdowns).some((n) => (n.textContent || '').trim() === 'Done');
    };

    // A visible "Pro thinking" / reasoning indicator (or a loading shimmer) is an
    // authoritative "still generating" signal: during a Pro thinking pause the
    // stop button disappears while a short streamed preamble is visible, so
    // breaking on bare stop-button absence would capture that preamble as the
    // final answer. While this returns true we must keep waiting. This is the
    // SAME shared gate predicate the Node-side isThinkingActive() evaluates.
    ${buildThinkingGatePredicateJs("isThinkingIndicatorActive")}

    const waitForSettle = async (snapshot) => {
      if (String(snapshot?.html ?? '').includes('/backend-api/estuary/content?id=file_')) {
        return snapshot;
      }
      // Learned: short answers can be 1-2 tokens; enforce longer settle windows to avoid truncation.
      // Learned: long streaming responses (esp. thinking models) can pause mid-stream;
      // use progressively longer windows to avoid truncation (#71).
      const classifyLength = (length) => ({
        ultraShortAnswer: length === 1,
        shortAnswer: length > 0 && length < ${MIN_CONFIDENT_ANSWER_LENGTH},
        mediumAnswer: length >= ${MIN_CONFIDENT_ANSWER_LENGTH} && length < 40,
        longAnswer: length >= 40 && length < 500,
      });
      const settleWindowForLength = (length) => {
        const size = classifyLength(length);
        return size.shortAnswer ? 12_000 : size.mediumAnswer ? 5_000 : size.longAnswer ? 24_000 : 30_000;
      };
      // Substantial answers get a longer settle window: bare stop-button absence
      // is unreliable for them (the Pro thinking gate hides it mid-turn), so we
      // wait for the finished-action controls. Compact answers keep their
      // original windows because exact one-line replies may finish before copy
      // controls mount. For substantial answers, timing out/rechecking is safer
      // than returning a Pro preamble as the final answer.
      const settleIntervalMs = 400;
      let latest = snapshot;
      let lastLength = snapshot?.text?.length ?? 0;
      let stableCycles = 0;
      let lastChangeAt = Date.now();
      // Overall budget is anchored at expression start, NOT settle entry:
      // waitForSettle can begin minutes into the wait, and re-anchoring here
      // would let the loop overshoot the caller's timeout contract by up to 2x.
      const overallDeadline = waitStartedAt + ${timeoutMs};
      let deadline = Math.min(overallDeadline, Date.now() + settleWindowForLength(lastLength));
      let completionAccepted = false;
      // Consecutive qualifying samples before a non-compact answer is trusted:
      // finished-action controls can flicker visible for a single sample at the
      // thinking→answer transition while the thinking indicator is mid-teardown.
      let acceptStreak = 0;
      // Sticky: a thinking indicator observed at any point in this settle wait.
      let sawThinking = false;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, settleIntervalMs));
        const refreshedRaw = extractFromTurns();
        const refreshedCandidate =
          refreshedRaw &&
          !isAnswerNowPlaceholder(refreshedRaw) &&
          !isActiveThinkingStatus(refreshedRaw)
            ? refreshedRaw
            : null;
        let refreshed = acceptSnapshot(refreshedCandidate);
        if (!refreshed) {
          const fallbackRaw = extractFromMarkdownFallback();
          const fallbackCandidate =
            fallbackRaw &&
            !isAnswerNowPlaceholder(fallbackRaw) &&
            !isActiveThinkingStatus(fallbackRaw)
              ? fallbackRaw
              : null;
          refreshed = acceptSnapshot(fallbackCandidate);
        }
        const nextLength = refreshed?.text?.length ?? lastLength;
        if (refreshed && nextLength >= lastLength) {
          latest = refreshed;
        }
        if (nextLength > lastLength) {
          lastLength = nextLength;
          stableCycles = 0;
          lastChangeAt = Date.now();
          deadline = Math.min(
            overallDeadline,
            Math.max(deadline, Date.now() + settleWindowForLength(lastLength)),
          );
        } else {
          stableCycles += 1;
        }
        const size = classifyLength(lastLength);
        const compactAnswer = size.shortAnswer || size.mediumAnswer;
        const preambleSizedAnswer =
          lastLength >= 40 && lastLength < PREAMBLE_SIZED_ANSWER_CHARS;
        const stableTarget = size.shortAnswer ? 6 : size.mediumAnswer ? 3 : size.longAnswer ? 5 : 6;
        const stopVisible = Boolean(document.querySelector(STOP_SELECTOR));
        const finishedVisible = isLastAssistantTurnFinished();
        const thinkingActive = isThinkingIndicatorActive();
        const idleMs = Date.now() - lastChangeAt;

        // Never accept while a Pro thinking / reasoning indicator is active.
        // A live indicator IS activity: reset the idle clock (otherwise a
        // >60s thinking pause pre-satisfies every idle window and acceptance
        // collapses to a one-sample race at the thinking→answer transition)
        // and keep the settle window alive so the loop cannot lapse into the
        // post-loop fallbacks mid-thinking.
        if (thinkingActive) {
          sawThinking = true;
          stableCycles = 0;
          lastChangeAt = Date.now();
          acceptStreak = 0;
          deadline = Math.min(
            overallDeadline,
            Math.max(deadline, Date.now() + settleWindowForLength(lastLength)),
          );
          continue;
        }
        // Acceptance must hold across consecutive samples when this wait is in
        // thinking territory (indicator seen, or the wait already outlasted the
        // compact grace window — which covers indicator-detection misses): a
        // one-sample finished-controls flicker at the thinking→answer
        // transition must never archive a stale fragment. Ordinary fast
        // captures keep their single-sample latency.
        const confirmSamples =
          sawThinking || Date.now() - waitStartedAt >= COMPACT_BARE_ACCEPT_MAX_ELAPSED_MS
            ? NONCOMPACT_ACCEPT_CONFIRM_SAMPLES
            : 1;
        // Finished-action controls can appear on Pro preambles before the final
        // answer expands. Compact exact answers keep their fast path; preamble-
        // sized answers need a long idle window before controls are trusted.
        if (finishedVisible) {
          if (compactAnswer) {
            acceptStreak += 1;
            if (acceptStreak >= Math.min(confirmSamples, 3)) {
              completionAccepted = true;
              break;
            }
          } else if (
            !stopVisible &&
            (!preambleSizedAnswer ||
              idleMs >=
                (sawThinking
                  ? ${PRO_PREAMBLE_COMPLETION_STABLE_MS}
                  : ${PREAMBLE_COMPLETION_STABLE_MS}))
          ) {
            acceptStreak += 1;
            if (acceptStreak >= confirmSamples) {
              completionAccepted = true;
              break;
            }
          } else {
            acceptStreak = 0;
          }
          deadline = Math.max(deadline, Math.min(overallDeadline, Date.now() + settleIntervalMs * 2));
          continue;
        }
        acceptStreak = 0;
        if (!stopVisible && stableCycles >= stableTarget) {
          // Compact answers may never render a copy button promptly; accept them
          // on stop-button absence + stability — but only early in the wait. A
          // compact fragment after COMPACT_BARE_ACCEPT_MAX_ELAPSED_MS (measured
          // from the START of the whole wait, not settle entry) is a paused
          // thinking stream ("1) Verdict"), so keep waiting for the
          // finished-action controls instead. Substantial answers must always
          // wait for finished controls to avoid capturing a mid-stream preamble.
          if (
            compactAnswer &&
            !size.ultraShortAnswer &&
            !sawThinking &&
            Date.now() - waitStartedAt < COMPACT_BARE_ACCEPT_MAX_ELAPSED_MS
          ) {
            break;
          }
          deadline = Math.max(deadline, Math.min(overallDeadline, Date.now() + settleIntervalMs));
        }
      }
      const finalLength = latest?.text?.length ?? snapshot?.text?.length ?? 0;
      const finalSize = classifyLength(finalLength);
      const finalCompact = finalSize.shortAnswer || finalSize.mediumAnswer;
      // Post-loop compact fallback: only trustworthy when the wait ended
      // quickly or completion controls confirmed the turn. A compact fragment
      // that has been pending for over a minute (since WAIT start) belongs to
      // the Node-side watchdog (returning null hands the race to it), not to
      // this fast path.
      if (
        finalCompact &&
        !finalSize.ultraShortAnswer &&
        (completionAccepted ||
          (!sawThinking && Date.now() - waitStartedAt < COMPACT_BARE_ACCEPT_MAX_ELAPSED_MS))
      ) {
        return latest ?? snapshot;
      }
      if (completionAccepted && isLastAssistantTurnFinished()) {
        return latest ?? snapshot;
      }
      return null;
    };

    const extractedRaw = extractFromTurns();
    const extractedCandidate =
      extractedRaw &&
      !isAnswerNowPlaceholder(extractedRaw) &&
      !isActiveThinkingStatus(extractedRaw)
        ? extractedRaw
        : null;
    let extracted = acceptSnapshot(extractedCandidate);
    if (!extracted) {
      const fallbackRaw = extractFromMarkdownFallback();
      const fallbackCandidate =
        fallbackRaw &&
        !isAnswerNowPlaceholder(fallbackRaw) &&
        !isActiveThinkingStatus(fallbackRaw)
          ? fallbackRaw
          : null;
      extracted = acceptSnapshot(fallbackCandidate);
    }
    if (extracted) {
      return waitForSettle(extracted);
    }
    return captureViaObserver().then((payload) => waitForSettle(payload));
  })()`;
}

function buildAssistantExtractor(functionName: string): string {
  const assistantLiteral = JSON.stringify(ASSISTANT_ROLE_SELECTOR);
  return `const ${functionName} = () => {
    ${buildClickDispatcher()}
    const ASSISTANT_SELECTOR = ${assistantLiteral};
    const isAssistantTurn = (node) => {
      if (!(node instanceof HTMLElement)) return false;
      const turnAttr = (node.getAttribute('data-turn') || node.dataset?.turn || '').toLowerCase();
      if (turnAttr === 'assistant') {
        return true;
      }
      const role = (node.getAttribute('data-message-author-role') || node.dataset?.messageAuthorRole || '').toLowerCase();
      if (role === 'assistant') {
        return true;
      }
      const testId = (node.getAttribute('data-testid') || '').toLowerCase();
      if (testId.includes('assistant')) {
        return true;
      }
      return Boolean(node.querySelector(ASSISTANT_SELECTOR) || node.querySelector('[data-testid*="assistant"]'));
    };
    const isUserTurn = (node) => {
      if (!(node instanceof HTMLElement)) return false;
      const turnAttr = (node.getAttribute('data-turn') || node.dataset?.turn || '').toLowerCase();
      if (turnAttr === 'user') {
        return true;
      }
      const role = (node.getAttribute('data-message-author-role') || node.dataset?.messageAuthorRole || '').toLowerCase();
      if (role === 'user') {
        return true;
      }
      return Boolean(node.querySelector('[data-message-author-role="user"], [data-turn="user"]'));
    };

    const expandCollapsibles = (root) => {
      const buttons = Array.from(root.querySelectorAll('button'));
      for (const button of buttons) {
        const label = (button.textContent || '').toLowerCase();
        const testid = (button.getAttribute('data-testid') || '').toLowerCase();
        if (
          label.includes('more') ||
          label.includes('expand') ||
          label.includes('show') ||
          testid.includes('markdown') ||
          testid.includes('toggle')
        ) {
          dispatchClickSequence(button);
        }
      }
    };

    const turns = ${buildConversationTurnListExpression()};
    let latestUserTurn = null;
    for (let index = turns.length - 1; index >= 0; index -= 1) {
      if (isUserTurn(turns[index])) {
        latestUserTurn = turns[index];
        break;
      }
    }
    const followsLatestUser = (node) => {
      if (!latestUserTurn || !node || typeof latestUserTurn.compareDocumentPosition !== 'function') {
        return false;
      }
      const position = latestUserTurn.compareDocumentPosition(node);
      return Boolean(position & Node.DOCUMENT_POSITION_FOLLOWING);
    };
    for (let index = turns.length - 1; index >= 0; index -= 1) {
      const turn = turns[index];
      if (!isAssistantTurn(turn)) {
        continue;
      }
      const afterLatestUser = followsLatestUser(turn);
      const messageRoot = turn.querySelector(ASSISTANT_SELECTOR) ?? turn;
      expandCollapsibles(messageRoot);
      const preferred =
        (messageRoot.matches?.('.markdown') || messageRoot.matches?.('[data-message-content]') ? messageRoot : null) ||
        messageRoot.querySelector('.markdown') ||
        messageRoot.querySelector('[data-message-content]') ||
        messageRoot.querySelector('[data-testid*="message"]') ||
        messageRoot.querySelector('[data-testid*="assistant"]') ||
        messageRoot.querySelector('.prose') ||
        messageRoot.querySelector('[class*="markdown"]');
      const contentRoot = preferred ?? messageRoot;
      if (!contentRoot) {
        continue;
      }
      const innerText = contentRoot?.innerText ?? '';
      const textContent = contentRoot?.textContent ?? '';
      const text = innerText.trim().length > 0 ? innerText : textContent;
      const html = contentRoot?.innerHTML ?? '';
      const messageId = messageRoot.getAttribute('data-message-id');
      const turnId = messageRoot.getAttribute('data-testid');
      const generatedImages = Array.from(messageRoot.querySelectorAll('img')).filter((img) =>
        String(img?.src || '').includes('/backend-api/estuary/content?id=file_')
      );
      const normalizedText = String(text || '').toLowerCase().replace(/\\s+/g, ' ').trim();
      const imageOnlyChrome =
        !normalizedText ||
        normalizedText === 'edit' ||
        normalizedText === 'stopped thinking' ||
        normalizedText === 'stopped thinking edit' ||
        /^thought for \\d+(?:\\.\\d+)?\\s*(?:s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours)\\s+edit$/.test(normalizedText);
      if (generatedImages.length > 0 && imageOnlyChrome) {
        const label = generatedImages.length === 1 ? 'Generated image.' : \`Generated \${generatedImages.length} images.\`;
        return { text: label, html: messageRoot?.innerHTML ?? html, messageId, turnId, turnIndex: index, afterLatestUser };
      }
      if (text.trim()) {
        return { text, html, messageId, turnId, turnIndex: index, afterLatestUser };
      }
    }
    return null;
  };`;
}

function buildMarkdownFallbackExtractor(minTurnLiteral?: string): string {
  const turnIndexValue = minTurnLiteral
    ? `(${minTurnLiteral} >= 0 ? ${minTurnLiteral} : null)`
    : "null";
  return `(() => {
    const __minTurn = ${turnIndexValue};
    const roots = [
      document.querySelector('section[data-testid="screen-threadFlyOut"]'),
      document.querySelector('[data-testid="chat-thread"]'),
      document.querySelector('main'),
      document.querySelector('[role="main"]'),
    ].filter(Boolean);
    if (roots.length === 0) return null;
    const markdownSelector = '.markdown,[data-message-content],[data-testid*="message"],.prose,[class*="markdown"]';
    const isExcluded = (node) =>
      Boolean(
        node?.closest?.(
          'nav, aside, [data-testid*="sidebar"], [data-testid*="chat-history"], [data-testid*="composer"], form',
        ),
      );
    const scoreRoot = (node) => {
      const actions = node.querySelectorAll('${FINISHED_ACTIONS_SELECTOR}').length;
      const assistants = node.querySelectorAll('[data-message-author-role="assistant"], [data-turn="assistant"]').length;
      const markdowns = node.querySelectorAll(markdownSelector).length;
      return actions * 10 + assistants * 5 + markdowns;
    };
    let root = roots[0];
    let bestScore = scoreRoot(root);
    for (let i = 1; i < roots.length; i += 1) {
      const candidate = roots[i];
      const score = scoreRoot(candidate);
      if (score > bestScore) {
        bestScore = score;
        root = candidate;
      }
    }
    if (!root) return null;
    const CONVERSATION_SELECTOR = ${JSON.stringify(CONVERSATION_TURN_SELECTOR)};
    const turnNodes = ${buildConversationTurnListExpression()};
    const hasTurns = turnNodes.length > 0;
    const isUserTurn = (node) => {
      if (!(node instanceof HTMLElement)) return false;
      const role = (node.getAttribute('data-message-author-role') || node.getAttribute('data-turn') || '').toLowerCase();
      if (role === 'user') return true;
      return Boolean(node.querySelector('[data-message-author-role="user"], [data-turn="user"]'));
    };
    let latestUserTurn = null;
    for (let i = turnNodes.length - 1; i >= 0; i -= 1) {
      if (isUserTurn(turnNodes[i])) {
        latestUserTurn = turnNodes[i];
        break;
      }
    }
    const resolveTurnIndex = (node) => {
      const idx = turnNodes.findIndex((turn) => turn === node || turn.contains?.(node));
      return idx >= 0 ? idx : null;
    };
    const isAfterLatestUserTurn = (node) => {
      if (!latestUserTurn || !node || typeof latestUserTurn.compareDocumentPosition !== 'function') {
        return false;
      }
      const turn = node?.closest?.(CONVERSATION_SELECTOR) ?? node;
      const position = latestUserTurn.compareDocumentPosition(turn);
      return Boolean(position & Node.DOCUMENT_POSITION_FOLLOWING);
    };
    const isAfterMinTurn = (node) => {
      if (__minTurn === null) return true;
      if (!hasTurns) return true;
      const idx = resolveTurnIndex(node);
      return (idx !== null && idx >= __minTurn) || isAfterLatestUserTurn(node);
    };
    const normalize = (value) => String(value || '').toLowerCase().replace(/\\s+/g, ' ').trim();
    const collectUserText = (scope) => {
      if (!scope?.querySelectorAll) return '';
      const userTurns = Array.from(scope.querySelectorAll('[data-message-author-role="user"], [data-turn="user"]'));
      const lastUser = userTurns[userTurns.length - 1];
      return lastUser ? normalize(lastUser.innerText || lastUser.textContent || '') : '';
    };
    const userText = collectUserText(root) || collectUserText(document);
    const isUserEcho = (text) => {
      if (!userText) return false;
      const normalized = normalize(text);
      if (!normalized) return false;
      return normalized === userText || normalized.startsWith(userText);
    };
    const markdowns = Array.from(root.querySelectorAll(markdownSelector))
      .filter((node) => !isExcluded(node))
      .filter((node) => {
        const container = node.closest('[data-message-author-role], [data-turn]');
        if (!container) return true;
        const role =
          (container.getAttribute('data-message-author-role') || container.getAttribute('data-turn') || '').toLowerCase();
        return role !== 'user';
      });
    if (markdowns.length === 0) return null;
    const actionButtons = Array.from(root.querySelectorAll('${FINISHED_ACTIONS_SELECTOR}'));
    const actionMarkdowns = [];
    for (const button of actionButtons) {
      const container =
        button.closest('${CONVERSATION_TURN_SELECTOR}') ||
        button.closest('[data-message-author-role="assistant"], [data-turn="assistant"]') ||
        button.closest('[data-message-author-role], [data-turn]') ||
        button.closest('[data-testid*="assistant"]');
      if (!container || container === root || container === document.body) continue;
      const scoped = Array.from(container.querySelectorAll(markdownSelector))
        .filter((node) => !isExcluded(node))
        .filter((node) => {
          const roleNode = node.closest('[data-message-author-role], [data-turn]');
          if (!roleNode) return true;
          const role =
            (roleNode.getAttribute('data-message-author-role') || roleNode.getAttribute('data-turn') || '').toLowerCase();
          return role !== 'user';
        });
      if (scoped.length === 0) continue;
      for (const node of scoped) {
        actionMarkdowns.push(node);
      }
    }
    const assistantMarkdowns = markdowns.filter((node) => {
      const container = node.closest('[data-message-author-role], [data-turn], [data-testid*="assistant"]');
      if (!container) return false;
      const role =
        (container.getAttribute('data-message-author-role') || container.getAttribute('data-turn') || '').toLowerCase();
      if (role === 'assistant') return true;
      const testId = (container.getAttribute('data-testid') || '').toLowerCase();
      return testId.includes('assistant');
    });
    const hasAssistantIndicators = Boolean(
      root.querySelector('${FINISHED_ACTIONS_SELECTOR}') ||
        root.querySelector('[data-message-author-role="assistant"], [data-turn="assistant"], [data-testid*="assistant"]'),
    );
    const allowMarkdownFallback = hasAssistantIndicators || hasTurns || Boolean(userText);
    const candidates =
      actionMarkdowns.length > 0
        ? actionMarkdowns
        : assistantMarkdowns.length > 0
          ? assistantMarkdowns
          : allowMarkdownFallback
            ? markdowns
            : [];
    for (let i = candidates.length - 1; i >= 0; i -= 1) {
      const node = candidates[i];
      if (!node) continue;
      if (!isAfterMinTurn(node)) continue;
      const text = (node.innerText || node.textContent || '').trim();
      if (!text) continue;
      if (isUserEcho(text)) continue;
      const html = node.innerHTML ?? '';
      const turnIndex = resolveTurnIndex(node);
      const afterLatestUser = isAfterLatestUserTurn(node);
      return { text, html, messageId: null, turnId: null, turnIndex, afterLatestUser };
    }
    return null;
  })`;
}

function buildCopyExpression(meta: { messageId?: string | null; turnId?: string | null }): string {
  return `(() => {
    ${buildClickDispatcher()}
    const BUTTON_SELECTOR = '${COPY_BUTTON_SELECTOR}';
    const TIMEOUT_MS = 10000;

    const locateButton = () => {
      const hint = ${JSON.stringify(meta ?? {})};
      if (hint?.messageId) {
        const node = document.querySelector('[data-message-id="' + hint.messageId + '"]');
        const buttons = node ? Array.from(node.querySelectorAll('${COPY_BUTTON_SELECTOR}')) : [];
        const button = buttons.at(-1) ?? null;
        if (button) {
          return button;
        }
      }
      if (hint?.turnId) {
        const node = document.querySelector('[data-testid="' + hint.turnId + '"]');
        const buttons = node ? Array.from(node.querySelectorAll('${COPY_BUTTON_SELECTOR}')) : [];
        const button = buttons.at(-1) ?? null;
        if (button) {
          return button;
        }
      }
      const CONVERSATION_SELECTOR = ${JSON.stringify(CONVERSATION_TURN_SELECTOR)};
      const ASSISTANT_SELECTOR = '${ASSISTANT_ROLE_SELECTOR}';
      const isAssistantTurn = (node) => {
        if (!(node instanceof HTMLElement)) return false;
        const turnAttr = (node.getAttribute('data-turn') || node.dataset?.turn || '').toLowerCase();
        if (turnAttr === 'assistant') return true;
        const role = (node.getAttribute('data-message-author-role') || node.dataset?.messageAuthorRole || '').toLowerCase();
        if (role === 'assistant') return true;
        const testId = (node.getAttribute('data-testid') || '').toLowerCase();
        if (testId.includes('assistant')) return true;
        return Boolean(node.querySelector(ASSISTANT_SELECTOR) || node.querySelector('[data-testid*="assistant"]'));
      };
      const turns = ${buildConversationTurnListExpression()};
      for (let i = turns.length - 1; i >= 0; i -= 1) {
        const turn = turns[i];
        if (!isAssistantTurn(turn)) continue;
        const button = turn.querySelector(BUTTON_SELECTOR);
        if (button) {
          return button;
        }
      }
      const all = Array.from(document.querySelectorAll(BUTTON_SELECTOR));
      for (let i = all.length - 1; i >= 0; i -= 1) {
        const button = all[i];
        const turn = button?.closest?.(CONVERSATION_SELECTOR);
        if (turn && isAssistantTurn(turn)) {
          return button;
        }
      }
      return null;
    };

    const interceptClipboard = () => {
      const clipboard = navigator.clipboard;
      const state = { text: '', updatedAt: 0 };
      if (!clipboard) {
        return { state, restore: () => {} };
      }
      const originalWriteText = clipboard.writeText;
      const originalWrite = clipboard.write;
      clipboard.writeText = (value) => {
        state.text = typeof value === 'string' ? value : '';
        state.updatedAt = Date.now();
        return Promise.resolve();
      };
      clipboard.write = async (items) => {
        try {
          const list = Array.isArray(items) ? items : items ? [items] : [];
          for (const item of list) {
            if (!item) continue;
            const types = Array.isArray(item.types) ? item.types : [];
            if (types.includes('text/plain') && typeof item.getType === 'function') {
              const blob = await item.getType('text/plain');
              const text = await blob.text();
              state.text = text ?? '';
              state.updatedAt = Date.now();
              break;
            }
          }
        } catch {
          state.text = '';
          state.updatedAt = Date.now();
        }
        return Promise.resolve();
      };
      return {
        state,
        restore: () => {
          clipboard.writeText = originalWriteText;
          clipboard.write = originalWrite;
        },
      };
    };

    return new Promise((resolve) => {
      const deadline = Date.now() + TIMEOUT_MS;
      const waitForButton = () => {
        const button = locateButton();
        if (button) {
          const interception = interceptClipboard();
          let settled = false;
          let pollId = null;
          let timeoutId = null;
          const finish = (payload) => {
            if (settled) {
              return;
            }
            settled = true;
            if (pollId) {
              clearInterval(pollId);
            }
            if (timeoutId) {
              clearTimeout(timeoutId);
            }
            button.removeEventListener('copy', handleCopy, true);
            interception.restore?.();
            resolve(payload);
          };

          const readIntercepted = () => {
            const markdown = interception.state.text ?? '';
            const updatedAt = interception.state.updatedAt ?? 0;
            return { success: Boolean(markdown.trim()), markdown, updatedAt };
          };

          let lastText = '';
          let stableTicks = 0;
          const requiredStableTicks = 3;
          const requiredStableMs = 250;
          const maybeFinish = () => {
            const payload = readIntercepted();
            if (!payload.success) return;
            if (payload.markdown !== lastText) {
              lastText = payload.markdown;
              stableTicks = 0;
              return;
            }
            stableTicks += 1;
            const ageMs = Date.now() - (payload.updatedAt || 0);
            if (stableTicks >= requiredStableTicks && ageMs >= requiredStableMs) {
              finish(payload);
            }
          };

          const handleCopy = () => {
            maybeFinish();
          };

          button.addEventListener('copy', handleCopy, true);
          button.scrollIntoView({ block: 'center', behavior: 'instant' });
          dispatchClickSequence(button);
          pollId = setInterval(maybeFinish, 120);
          timeoutId = setTimeout(() => {
            button.removeEventListener('copy', handleCopy, true);
            finish({ success: false, status: 'timeout' });
          }, TIMEOUT_MS);
          return;
        }
        if (Date.now() > deadline) {
          resolve({ success: false, status: 'missing-button' });
          return;
        }
        setTimeout(waitForButton, 120);
      };

      waitForButton();
    });
  })()`;
}

interface AssistantSnapshot {
  text?: string;
  html?: string;
  messageId?: string | null;
  turnId?: string | null;
  turnIndex?: number | null;
  afterLatestUser?: boolean;
}

const LANGUAGE_TAGS = new Set(
  [
    "copy code",
    "markdown",
    "bash",
    "sh",
    "shell",
    "javascript",
    "typescript",
    "ts",
    "js",
    "yaml",
    "json",
    "python",
    "py",
    "go",
    "java",
    "c",
    "c++",
    "cpp",
    "c#",
    "php",
    "ruby",
    "rust",
    "swift",
    "kotlin",
    "html",
    "css",
    "sql",
    "text",
  ].map((token) => token.toLowerCase()),
);

function cleanAssistantText(text: string): string {
  const normalized = text.replace(/\u00a0/g, " ");
  const lines = normalized.split(/\r?\n/);
  const filtered = lines.filter((line) => {
    const trimmed = line.trim().toLowerCase();
    if (LANGUAGE_TAGS.has(trimmed)) return false;
    return true;
  });
  return filtered
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

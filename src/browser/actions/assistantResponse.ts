import type { ChromeClient, BrowserLogger } from '../types.js';
import {
  ANSWER_SELECTORS,
  ASSISTANT_ROLE_SELECTOR,
  CONVERSATION_TURN_SELECTOR,
  COPY_BUTTON_SELECTOR,
  FINISHED_ACTIONS_SELECTOR,
  STOP_BUTTON_SELECTOR,
} from '../constants.js';
import { delay } from '../utils.js';
import { logDomFailure, logConversationSnapshot, buildConversationDebugExpression } from '../domDebug.js';
import { buildClickDispatcher } from './domEvents.js';

const ASSISTANT_POLL_TIMEOUT_ERROR = 'assistant-response-watchdog-timeout';

export async function waitForAssistantResponse(
  Runtime: ChromeClient['Runtime'],
  timeoutMs: number,
  logger: BrowserLogger,
  minTurnIndex?: number,
): Promise<{ text: string; html?: string; meta: { turnId?: string | null; messageId?: string | null } }> {
  const start = Date.now();
  logger('Waiting for ChatGPT response');
  const expression = buildResponseObserverExpression(timeoutMs, minTurnIndex);
  const evaluationPromise = Runtime.evaluate({ expression, awaitPromise: true, returnByValue: true });
  const raceReadyEvaluation = evaluationPromise.then(
    (value) => ({ kind: 'evaluation' as const, value }),
    (error) => {
      throw { source: 'evaluation' as const, error };
    },
  );
  const pollerPromise = pollAssistantCompletion(Runtime, timeoutMs, minTurnIndex).then(
    (value) => {
      if (!value) {
        throw { source: 'poll' as const, error: new Error(ASSISTANT_POLL_TIMEOUT_ERROR) };
      }
      return { kind: 'poll' as const, value };
    },
    (error) => {
      throw { source: 'poll' as const, error };
    },
  );

  let evaluation: Awaited<ReturnType<ChromeClient['Runtime']['evaluate']>> | null = null;
  try {
    const winner = await Promise.race([raceReadyEvaluation, pollerPromise]);
    if (winner.kind === 'poll') {
      logger('Captured assistant response via snapshot watchdog');
      evaluationPromise.catch(() => undefined);
      await terminateRuntimeExecution(Runtime);
      return winner.value;
    }
    evaluation = winner.value;
  } catch (wrappedError) {
    if (wrappedError && typeof wrappedError === 'object' && 'source' in wrappedError && 'error' in wrappedError) {
      const { source, error } = wrappedError as { source: string; error: unknown };
      if (source === 'poll' && error instanceof Error && error.message === ASSISTANT_POLL_TIMEOUT_ERROR) {
        evaluation = await evaluationPromise;
      } else if (source === 'poll') {
        throw error;
      } else if (source === 'evaluation') {
        const recovered = await recoverAssistantResponse(Runtime, timeoutMs, logger, minTurnIndex);
        if (recovered) {
          return recovered;
        }
        await logDomFailure(Runtime, logger, 'assistant-response');
        throw error ?? new Error('Failed to capture assistant response');
      }
    } else {
      throw wrappedError;
    }
  }

  if (!evaluation) {
    await logDomFailure(Runtime, logger, 'assistant-response');
    throw new Error('Failed to capture assistant response');
  }

  const parsed = await parseAssistantEvaluationResult(Runtime, evaluation, timeoutMs, logger, minTurnIndex);
  if (!parsed) {
    await logDomFailure(Runtime, logger, 'assistant-response');
    throw new Error('Unable to capture assistant response');
  }

  const refreshed = await refreshAssistantSnapshot(Runtime, parsed, logger, minTurnIndex);
  const candidate = refreshed ?? parsed;
  // The evaluation path can race ahead of completion. If ChatGPT is still streaming, wait for the watchdog poller.
  const elapsedMs = Date.now() - start;
  const remainingMs = Math.max(0, timeoutMs - elapsedMs);
  if (remainingMs > 0) {
    const [stopVisible, completionVisible] = await Promise.all([
      isStopButtonVisible(Runtime),
      isCompletionVisible(Runtime),
    ]);
    if (stopVisible && !completionVisible) {
      logger('Assistant still generating; waiting for completion');
      const completed = await pollAssistantCompletion(Runtime, remainingMs, minTurnIndex);
      if (completed) {
        return completed;
      }
    }
  }

  return candidate;
}

export async function readAssistantSnapshot(
  Runtime: ChromeClient['Runtime'],
  minTurnIndex?: number,
): Promise<AssistantSnapshot | null> {
  const { result } = await Runtime.evaluate({ expression: buildAssistantSnapshotExpression(), returnByValue: true });
  const value = result?.value;
  if (value && typeof value === 'object') {
    const snapshot = value as AssistantSnapshot;
    if (typeof minTurnIndex === 'number' && Number.isFinite(minTurnIndex)) {
      const turnIndex = typeof snapshot.turnIndex === 'number' ? snapshot.turnIndex : null;
      if (turnIndex === null) {
        return snapshot;
      }
      if (turnIndex < minTurnIndex) {
        return null;
      }
    }
    return snapshot;
  }
  return null;
}

export async function captureAssistantMarkdown(
  Runtime: ChromeClient['Runtime'],
  meta: { messageId?: string | null; turnId?: string | null },
  logger: BrowserLogger,
): Promise<string | null> {
  const { result } = await Runtime.evaluate({
    expression: buildCopyExpression(meta),
    returnByValue: true,
    awaitPromise: true,
  });
  if (result?.value?.success && typeof result.value.markdown === 'string') {
    return result.value.markdown;
  }
  const status = result?.value?.status;
  if (status && status !== 'missing-button') {
    logger(`Copy button fallback status: ${status}`);
    await logDomFailure(Runtime, logger, 'copy-markdown');
  }
  if (!status) {
    await logDomFailure(Runtime, logger, 'copy-markdown');
  }
  return null;
}

export function buildAssistantExtractorForTest(name: string): string {
  return buildAssistantExtractor(name);
}

export function buildConversationDebugExpressionForTest(): string {
  return buildConversationDebugExpression();
}

async function recoverAssistantResponse(
  Runtime: ChromeClient['Runtime'],
  timeoutMs: number,
  logger: BrowserLogger,
  minTurnIndex?: number,
): Promise<{ text: string; html?: string; meta: { turnId?: string | null; messageId?: string | null } } | null> {
  const snapshot = await waitForAssistantSnapshot(Runtime, Math.min(timeoutMs, 10_000), minTurnIndex);
  const recovered = normalizeAssistantSnapshot(snapshot);
  if (recovered) {
    logger('Recovered assistant response via polling fallback');
    return recovered;
  }
  await logConversationSnapshot(Runtime, logger).catch(() => undefined);
  return null;
}

async function parseAssistantEvaluationResult(
  Runtime: ChromeClient['Runtime'],
  evaluation: Awaited<ReturnType<ChromeClient['Runtime']['evaluate']>>,
  timeoutMs: number,
  logger: BrowserLogger,
  minTurnIndex?: number,
): Promise<{ text: string; html?: string; meta: { turnId?: string | null; messageId?: string | null } } | null> {
  const { result } = evaluation;
  if (result.type === 'object' && result.value && typeof result.value === 'object' && 'text' in result.value) {
    const html =
      typeof (result.value as { html?: unknown }).html === 'string'
        ? ((result.value as { html?: string }).html ?? undefined)
        : undefined;
    const turnId =
      typeof (result.value as { turnId?: unknown }).turnId === 'string'
        ? ((result.value as { turnId?: string }).turnId ?? undefined)
        : undefined;
    const messageId =
      typeof (result.value as { messageId?: unknown }).messageId === 'string'
        ? ((result.value as { messageId?: string }).messageId ?? undefined)
        : undefined;
    const text = cleanAssistantText(String((result.value as { text: unknown }).text ?? ''));
    const normalized = text.toLowerCase();
    if (
      normalized.includes('answer now') &&
      (normalized.includes('pro thinking') || normalized.includes('chatgpt said'))
    ) {
      const recovered = await recoverAssistantResponse(Runtime, Math.min(timeoutMs, 10_000), logger, minTurnIndex);
      return recovered ?? null;
    }
    return { text, html, meta: { turnId, messageId } };
  }
  const fallbackText = typeof result.value === 'string' ? cleanAssistantText(result.value as string) : '';
  if (!fallbackText) {
    const recovered = await recoverAssistantResponse(Runtime, Math.min(timeoutMs, 10_000), logger, minTurnIndex);
    if (recovered) {
      return recovered;
    }
    return null;
  }
  return { text: fallbackText, html: undefined, meta: {} };
}

async function refreshAssistantSnapshot(
  Runtime: ChromeClient['Runtime'],
  current: { text: string; html?: string; meta: { turnId?: string | null; messageId?: string | null } },
  logger: BrowserLogger,
  minTurnIndex?: number,
): Promise<{ text: string; html?: string; meta: { turnId?: string | null; messageId?: string | null } } | null> {
  const latestSnapshot = await waitForCondition(
    () => readAssistantSnapshot(Runtime, minTurnIndex),
    5_000,
    300,
  );
  const latest = normalizeAssistantSnapshot(latestSnapshot);
  if (!latest) {
    return null;
  }
  const currentLength = cleanAssistantText(current.text).trim().length;
  const latestLength = latest.text.length;
  const hasBetterId = !current.meta?.messageId && Boolean(latest.meta.messageId);
  const isLonger = latestLength > currentLength;
  const hasDifferentText = latest.text.trim() !== current.text.trim();
  if (isLonger || hasBetterId || hasDifferentText) {
    logger('Refreshed assistant response via latest snapshot');
    return latest;
  }
  return null;
}

async function terminateRuntimeExecution(Runtime: ChromeClient['Runtime']): Promise<void> {
  if (typeof Runtime.terminateExecution !== 'function') {
    return;
  }
  try {
    await Runtime.terminateExecution();
  } catch {
    // ignore termination failures
  }
}

async function pollAssistantCompletion(
  Runtime: ChromeClient['Runtime'],
  timeoutMs: number,
  minTurnIndex?: number,
): Promise<{ text: string; html?: string; meta: { turnId?: string | null; messageId?: string | null } } | null> {
  const watchdogDeadline = Date.now() + timeoutMs;
  let previousLength = 0;
  let stableCycles = 0;
  const requiredStableCycles = 6;
  while (Date.now() < watchdogDeadline) {
    const snapshot = await readAssistantSnapshot(Runtime, minTurnIndex);
    const normalized = normalizeAssistantSnapshot(snapshot);
    if (normalized) {
      const currentLength = normalized.text.length;
      if (currentLength > previousLength) {
        previousLength = currentLength;
        stableCycles = 0;
      } else {
        stableCycles += 1;
      }
      const [stopVisible, completionVisible] = await Promise.all([
        isStopButtonVisible(Runtime),
        isCompletionVisible(Runtime),
      ]);
      // Require at least 2 stable cycles even when completion buttons are visible
      // to ensure DOM text has fully rendered (buttons can appear before text settles)
      if ((completionVisible && stableCycles >= 2) || (!stopVisible && stableCycles >= requiredStableCycles)) {
        return normalized;
      }
    } else {
      previousLength = 0;
      stableCycles = 0;
    }
    await delay(400);
  }
  return null;
}

async function isStopButtonVisible(Runtime: ChromeClient['Runtime']): Promise<boolean> {
  try {
    const { result } = await Runtime.evaluate({
      expression: `Boolean(document.querySelector('${STOP_BUTTON_SELECTOR}'))`,
      returnByValue: true,
    });
    return Boolean(result?.value);
  } catch {
    return false;
  }
}

async function isCompletionVisible(Runtime: ChromeClient['Runtime']): Promise<boolean> {
  try {
    const { result } = await Runtime.evaluate({
      expression: `(() => {
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

        const turns = Array.from(document.querySelectorAll('${CONVERSATION_TURN_SELECTOR}'));
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
        // Check if the last assistant turn has finished action buttons (copy, thumbs up/down, share)
        if (lastAssistantTurn.querySelector('${FINISHED_ACTIONS_SELECTOR}')) {
          return true;
        }
        // Also check for "Done" text in the last assistant turn's markdown
        const markdowns = lastAssistantTurn.querySelectorAll('.markdown');
        return Array.from(markdowns).some((n) => (n.textContent || '').trim() === 'Done');
      })()`,
      returnByValue: true,
    });
    return Boolean(result?.value);
  } catch {
    return false;
  }
}

function normalizeAssistantSnapshot(
  snapshot: AssistantSnapshot | null,
): { text: string; html?: string; meta: { turnId?: string | null; messageId?: string | null } } | null {
  const text = snapshot?.text ? cleanAssistantText(snapshot.text) : '';
  if (!text.trim()) {
    return null;
  }
  const normalized = text.toLowerCase();
  // "Pro thinking" often renders a placeholder turn containing an "Answer now" gate.
  // Treat it as incomplete so browser mode keeps waiting for the real assistant text.
  if (normalized.includes('answer now') && (normalized.includes('pro thinking') || normalized.includes('chatgpt said'))) {
    return null;
  }
  // Ignore user echo turns that can show up in project view fallbacks.
  if (normalized.startsWith('you said')) {
    return null;
  }
  return {
    text,
    html: snapshot?.html ?? undefined,
    meta: { turnId: snapshot?.turnId ?? undefined, messageId: snapshot?.messageId ?? undefined },
  };
}

async function waitForAssistantSnapshot(
  Runtime: ChromeClient['Runtime'],
  timeoutMs: number,
  minTurnIndex?: number,
): Promise<AssistantSnapshot | null> {
  return waitForCondition(() => readAssistantSnapshot(Runtime, minTurnIndex), timeoutMs);
}

async function waitForCondition<T>(getter: () => Promise<T | null>, timeoutMs: number, pollIntervalMs = 400): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await getter();
    if (value) {
      return value;
    }
    await delay(pollIntervalMs);
  }
  return null;
}

function buildAssistantSnapshotExpression(): string {
  return `(() => {
    ${buildAssistantExtractor('extractAssistantTurn')}
    const extracted = extractAssistantTurn();
    const isPlaceholder = (snapshot) => {
      const normalized = String(snapshot?.text ?? '').toLowerCase();
      return normalized.includes('answer now') && (normalized.includes('pro thinking') || normalized.includes('chatgpt said'));
    };
    if (extracted && extracted.text && !isPlaceholder(extracted)) {
      return extracted;
    }
    // Fallback for ChatGPT project view: answers can live outside conversation turns.
    const fallback = ${buildMarkdownFallbackExtractor()};
    return fallback ?? extracted;
  })()`;
}

function buildResponseObserverExpression(timeoutMs: number, minTurnIndex?: number): string {
  const selectorsLiteral = JSON.stringify(ANSWER_SELECTORS);
  const conversationLiteral = JSON.stringify(CONVERSATION_TURN_SELECTOR);
  const assistantLiteral = JSON.stringify(ASSISTANT_ROLE_SELECTOR);
  const minTurnLiteral =
    typeof minTurnIndex === 'number' && Number.isFinite(minTurnIndex) && minTurnIndex >= 0
      ? Math.floor(minTurnIndex)
      : -1;
  return `(() => {
    ${buildClickDispatcher()}
    const SELECTORS = ${selectorsLiteral};
    const STOP_SELECTOR = '${STOP_BUTTON_SELECTOR}';
    const FINISHED_SELECTOR = '${FINISHED_ACTIONS_SELECTOR}';
    const CONVERSATION_SELECTOR = ${conversationLiteral};
    const ASSISTANT_SELECTOR = ${assistantLiteral};
    const settleDelayMs = 800;
    const isAnswerNowPlaceholder = (snapshot) => {
      const normalized = String(snapshot?.text ?? '').toLowerCase();
      return normalized.includes('answer now') && (normalized.includes('pro thinking') || normalized.includes('chatgpt said'));
    };

    // Helper to detect assistant turns - matches buildAssistantExtractor logic
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
    ${buildAssistantExtractor('extractFromTurns')}
    // Some layouts (project view) render markdown without assistant turn wrappers.
    const extractFromMarkdownFallback = ${buildMarkdownFallbackExtractor('MIN_TURN_INDEX')};

    const acceptSnapshot = (snapshot) => {
      if (!snapshot) return null;
      const index = typeof snapshot.turnIndex === 'number' ? snapshot.turnIndex : -1;
      if (MIN_TURN_INDEX >= 0) {
        if (index < 0 || index < MIN_TURN_INDEX) {
          return null;
        }
      }
      return snapshot;
    };

    const captureViaObserver = () =>
      new Promise((resolve, reject) => {
        const deadline = Date.now() + ${timeoutMs};
        let stopInterval = null;
        const observer = new MutationObserver(() => {
          const extractedRaw = extractFromTurns();
          const extractedCandidate =
            extractedRaw && !isAnswerNowPlaceholder(extractedRaw) ? extractedRaw : null;
          let extracted = acceptSnapshot(extractedCandidate);
          if (!extracted) {
            const fallbackRaw = extractFromMarkdownFallback();
            const fallbackCandidate =
              fallbackRaw && !isAnswerNowPlaceholder(fallbackRaw) ? fallbackRaw : null;
            extracted = acceptSnapshot(fallbackCandidate);
          }
          if (extracted) {
            observer.disconnect();
            if (stopInterval) {
              clearInterval(stopInterval);
            }
            resolve(extracted);
          } else if (Date.now() > deadline) {
            observer.disconnect();
            if (stopInterval) {
              clearInterval(stopInterval);
            }
            reject(new Error('Response timeout'));
          }
        });
        observer.observe(document.body, { childList: true, subtree: true, characterData: true });
        stopInterval = setInterval(() => {
          const stop = document.querySelector(STOP_SELECTOR);
          if (!stop) {
            return;
          }
          const isStopButton =
            stop.getAttribute('data-testid') === 'stop-button' || stop.getAttribute('aria-label')?.toLowerCase()?.includes('stop');
          if (isStopButton) {
            return;
          }
          dispatchClickSequence(stop);
        }, 500);
        setTimeout(() => {
          if (stopInterval) {
            clearInterval(stopInterval);
          }
          observer.disconnect();
          reject(new Error('Response timeout'));
        }, ${timeoutMs});
      });

    // Check if the last assistant turn has finished (scoped to avoid detecting old turns)
    const isLastAssistantTurnFinished = () => {
      const turns = Array.from(document.querySelectorAll(CONVERSATION_SELECTOR));
      let lastAssistantTurn = null;
      for (let i = turns.length - 1; i >= 0; i--) {
        if (isAssistantTurn(turns[i])) {
          lastAssistantTurn = turns[i];
          break;
        }
      }
      if (!lastAssistantTurn) return false;
      // Check for action buttons in this specific turn
      if (lastAssistantTurn.querySelector(FINISHED_SELECTOR)) return true;
      // Check for "Done" text in this turn's markdown
      const markdowns = lastAssistantTurn.querySelectorAll('.markdown');
      return Array.from(markdowns).some((n) => (n.textContent || '').trim() === 'Done');
    };

    const waitForSettle = async (snapshot) => {
      const settleWindowMs = 5000;
      const settleIntervalMs = 400;
        const deadline = Date.now() + settleWindowMs;
        let latest = snapshot;
        let lastLength = snapshot?.text?.length ?? 0;
        while (Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, settleIntervalMs));
          const refreshedRaw = extractFromTurns();
          const refreshedCandidate =
            refreshedRaw && !isAnswerNowPlaceholder(refreshedRaw) ? refreshedRaw : null;
          let refreshed = acceptSnapshot(refreshedCandidate);
          if (!refreshed) {
            const fallbackRaw = extractFromMarkdownFallback();
            const fallbackCandidate =
              fallbackRaw && !isAnswerNowPlaceholder(fallbackRaw) ? fallbackRaw : null;
            refreshed = acceptSnapshot(fallbackCandidate);
          }
          if (refreshed && (refreshed.text?.length ?? 0) >= lastLength) {
            latest = refreshed;
            lastLength = refreshed.text?.length ?? lastLength;
          }
          const stopVisible = Boolean(document.querySelector(STOP_SELECTOR));
          const finishedVisible = isLastAssistantTurnFinished();

          if (!stopVisible || finishedVisible) {
            break;
          }
        }
        return latest ?? snapshot;
      };

    const extractedRaw = extractFromTurns();
    const extractedCandidate = extractedRaw && !isAnswerNowPlaceholder(extractedRaw) ? extractedRaw : null;
    let extracted = acceptSnapshot(extractedCandidate);
    if (!extracted) {
      const fallbackRaw = extractFromMarkdownFallback();
      const fallbackCandidate = fallbackRaw && !isAnswerNowPlaceholder(fallbackRaw) ? fallbackRaw : null;
      extracted = acceptSnapshot(fallbackCandidate);
    }
    if (extracted) {
      return waitForSettle(extracted);
    }
    return captureViaObserver().then((payload) => waitForSettle(payload));
  })()`;
}

function buildAssistantExtractor(functionName: string): string {
  const conversationLiteral = JSON.stringify(CONVERSATION_TURN_SELECTOR);
  const assistantLiteral = JSON.stringify(ASSISTANT_ROLE_SELECTOR);
  return `const ${functionName} = () => {
    ${buildClickDispatcher()}
    const CONVERSATION_SELECTOR = ${conversationLiteral};
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

    const turns = Array.from(document.querySelectorAll(CONVERSATION_SELECTOR));
    for (let index = turns.length - 1; index >= 0; index -= 1) {
      const turn = turns[index];
      if (!isAssistantTurn(turn)) {
        continue;
      }
      const messageRoot = turn.querySelector(ASSISTANT_SELECTOR) ?? turn;
      expandCollapsibles(messageRoot);
      const preferred = messageRoot.querySelector('.markdown') || messageRoot.querySelector('[data-message-content]');
      if (!preferred) {
        continue;
      }
      const innerText = preferred?.innerText ?? '';
      const textContent = preferred?.textContent ?? '';
      const text = innerText.trim().length > 0 ? innerText : textContent;
      const html = preferred?.innerHTML ?? '';
      const messageId = messageRoot.getAttribute('data-message-id');
      const turnId = messageRoot.getAttribute('data-testid');
      if (text.trim()) {
        return { text, html, messageId, turnId, turnIndex: index };
      }
    }
    return null;
  };`;
}

function buildMarkdownFallbackExtractor(minTurnLiteral?: string): string {
  const turnIndexValue = minTurnLiteral ? `(${minTurnLiteral} >= 0 ? ${minTurnLiteral} : null)` : 'null';
  return `(() => {
    // Project view renders answer markdown under screen-threadFlyOut, not conversation turns.
    const root =
      document.querySelector('section[data-testid="screen-threadFlyOut"]') ||
      document.querySelector('[data-testid="chat-thread"]') ||
      document;
    if (!root) return null;
    const markdowns = Array.from(root.querySelectorAll('.markdown'));
    if (markdowns.length === 0) return null;
    const assistantMarkdowns = markdowns.filter((node) => {
      const container = node.closest('[data-message-author-role], [data-turn]');
      if (!container) return false;
      const role =
        (container.getAttribute('data-message-author-role') || container.getAttribute('data-turn') || '').toLowerCase();
      return role === 'assistant';
    });
    const candidates = assistantMarkdowns.length > 0 ? assistantMarkdowns : null;
    if (!candidates) return null;
    const lastMarkdown = candidates[candidates.length - 1];
    const text = (lastMarkdown?.innerText || lastMarkdown?.textContent || '').trim();
    if (!text) return null;
    const html = lastMarkdown?.innerHTML ?? '';
    return { text, html, messageId: null, turnId: null, turnIndex: ${turnIndexValue} };
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
      const all = Array.from(document.querySelectorAll(BUTTON_SELECTOR));
      return all.at(-1) ?? null;
    };

    const interceptClipboard = () => {
      const clipboard = navigator.clipboard;
      const state = { text: '' };
      if (!clipboard) {
        return { state, restore: () => {} };
      }
      const originalWriteText = clipboard.writeText;
      const originalWrite = clipboard.write;
      clipboard.writeText = (value) => {
        state.text = typeof value === 'string' ? value : '';
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
              break;
            }
          }
        } catch {
          state.text = '';
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
            return { success: Boolean(markdown.trim()), markdown };
          };

          const handleCopy = () => {
            finish(readIntercepted());
          };

          button.addEventListener('copy', handleCopy, true);
          button.scrollIntoView({ block: 'center', behavior: 'instant' });
          dispatchClickSequence(button);
          pollId = setInterval(() => {
            const payload = readIntercepted();
            if (payload.success) {
              finish(payload);
            }
          }, 100);
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
}

const LANGUAGE_TAGS = new Set(
  [
    'copy code',
    'markdown',
    'bash',
    'sh',
    'shell',
    'javascript',
    'typescript',
    'ts',
    'js',
    'yaml',
    'json',
    'python',
    'py',
    'go',
    'java',
    'c',
    'c++',
    'cpp',
    'c#',
    'php',
    'ruby',
    'rust',
    'swift',
    'kotlin',
    'html',
    'css',
    'sql',
    'text',
  ].map((token) => token.toLowerCase()),
);

function cleanAssistantText(text: string): string {
  const normalized = text.replace(/\u00a0/g, ' ');
  const lines = normalized.split(/\r?\n/);
  const filtered = lines.filter((line) => {
    const trimmed = line.trim().toLowerCase();
    if (LANGUAGE_TAGS.has(trimmed)) return false;
    return true;
  });
  return filtered.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

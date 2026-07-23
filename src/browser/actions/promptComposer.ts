import type { ChromeClient, BrowserLogger } from "../types.js";
import {
  INPUT_SELECTORS,
  PROMPT_PRIMARY_SELECTOR,
  PROMPT_FALLBACK_SELECTOR,
  SEND_BUTTON_SELECTORS,
  STOP_BUTTON_SELECTOR,
  ASSISTANT_ROLE_SELECTOR,
} from "../constants.js";
import {
  buildConversationTurnCountExpression,
  buildConversationTurnListExpression,
} from "../conversationTurns.js";
import { delay } from "../utils.js";
import { logDomFailure } from "../domDebug.js";
import { buildClickDispatcher } from "./domEvents.js";
import {
  registerSubmittedUserMessage,
  type SubmittedUserMessageBinding,
} from "./captureBinding.js";
import { BrowserAutomationError } from "../../oracle/errors.js";
import { randomUUID } from "node:crypto";
import {
  normalizeRenderedPromptDomIdentity,
  PROMPT_DOM_EXACT_MATCH_DECLARATION,
  PROMPT_DOM_IDENTITY_NORMALIZER_DECLARATION,
  PROMPT_DOM_NORMALIZER_DECLARATION,
} from "../promptDomMatch.js";

const ENTER_KEY_EVENT = {
  key: "Enter",
  code: "Enter",
  windowsVirtualKeyCode: 13,
  nativeVirtualKeyCode: 13,
} as const;
const ENTER_KEY_TEXT = "\r";

export interface AttachmentReadyExpectation {
  name: string;
  generatedBundle?: boolean;
}

type AttachmentReadyInput = string | AttachmentReadyExpectation;

export interface ExactSubmissionExpectation {
  prompt: string;
  attachments: AttachmentReadyExpectation[];
}

/**
 * A synchronous DOM proof that must be evaluated in the same browser task as
 * the final send-target check. `assertResult` runs in Node on the returned
 * value and must throw when the proof no longer holds.
 */
export interface FinalPreDispatchDomGuard {
  expression: string;
  assertResult: (value: unknown) => void;
  /**
   * Read the installed page guard after every awaited persistence/mouse-move
   * step and immediately before the first submission-capable input event.
   */
  immediatelyBeforeDispatchExpression?: string;
  assertImmediatelyBeforeDispatchResult?: (value: unknown) => void;
  verdictBinding?: {
    name: string;
    parsePayload: (payload: string) => unknown | undefined;
  };
  afterDispatchExpression?: string;
  assertAfterDispatchResult?: (value: unknown) => void;
  isDispatchDefinitelyBlocked?: (value: unknown) => boolean;
}

type BeforePromptSubmit = (
  composerBindingToken?: string,
  exactSubmission?: ExactSubmissionExpectation,
) => Promise<FinalPreDispatchDomGuard | void> | FinalPreDispatchDomGuard | void;

const SUBMIT_DISPATCH_STARTED_LOG =
  "Clicked send button (dispatch attempted; awaiting prompt commit proof)";

export async function submitPrompt(
  deps: {
    runtime: ChromeClient["Runtime"];
    input: ChromeClient["Input"];
    attachmentNames?: AttachmentReadyInput[];
    attachmentBindingToken?: string;
    baselineTurns?: number | null;
    inputTimeoutMs?: number | null;
    attachmentTimeoutMs?: number | null;
    beforePromptSubmit?: BeforePromptSubmit;
    requireBoundSendTarget?: boolean;
    /** Require strict full-text equality in the active visible composer before dispatch. */
    requireExactPromptRoundTrip?: boolean;
    onPromptSubmitted?: (submittedPrompt: string) => Promise<void> | void;
    onPromptBound?: (
      submittedPrompt: string,
      binding: SubmittedUserMessageBinding,
    ) => Promise<void> | void;
  },
  prompt: string,
  logger: BrowserLogger,
): Promise<number | null> {
  const { runtime, input } = deps;

  await waitForDomReady(runtime, logger, deps.inputTimeoutMs ?? undefined);
  const baselineTurns = await acquirePreSubmitBaseline(runtime, deps.baselineTurns);
  const encodedPrompt = JSON.stringify(prompt);
  const focusResult = await runtime.evaluate({
    expression: `(() => {
      ${buildClickDispatcher()}
      const SELECTORS = ${JSON.stringify(INPUT_SELECTORS)};
      const isVisible = (node) => {
        if (!node || typeof node.getBoundingClientRect !== 'function') {
          return false;
        }
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      const focusNode = (node) => {
        if (!node) {
          return false;
        }
        // Learned: React/ProseMirror require a real click + focus + selection for inserts to stick.
        dispatchClickSequence(node);
        if (typeof node.focus === 'function') {
          node.focus();
        }
        const doc = node.ownerDocument;
        const selection = doc?.getSelection?.();
        if (selection) {
          const range = doc.createRange();
          range.selectNodeContents(node);
          range.collapse(false);
          selection.removeAllRanges();
          selection.addRange(range);
        }
        return true;
      };

      const candidates = [];
      for (const selector of SELECTORS) {
        candidates.push(...Array.from(document.querySelectorAll(selector)));
      }
      const preferred = candidates.find((node) => isVisible(node)) || candidates[0];
      if (preferred && focusNode(preferred)) {
        return { focused: true };
      }
      return { focused: false };
    })()`,
    returnByValue: true,
    awaitPromise: true,
  });
  if (!focusResult.result?.value?.focused) {
    await logDomFailure(runtime, logger, "focus-textarea");
    throw new Error("Failed to focus prompt textarea");
  }

  await input.insertText({ text: prompt });

  // Some pages (notably ChatGPT when subscriptions/widgets load) need a brief settle
  // before the send button becomes enabled; give it a short breather to avoid races.
  await delay(500);

  const primarySelectorLiteral = JSON.stringify(PROMPT_PRIMARY_SELECTOR);
  const fallbackSelectorLiteral = JSON.stringify(PROMPT_FALLBACK_SELECTOR);
  const verification = await runtime.evaluate({
    expression: `(() => {
      const editor = document.querySelector(${primarySelectorLiteral});
      const fallback = document.querySelector(${fallbackSelectorLiteral});
      const inputSelectors = ${JSON.stringify(INPUT_SELECTORS)};
      const readValue = (node) => {
        if (!node) return '';
        if (node instanceof HTMLTextAreaElement) return node.value ?? '';
        return node.innerText ?? '';
      };
      const isVisible = (node) => {
        if (!node || typeof node.getBoundingClientRect !== 'function') return false;
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      const candidates = inputSelectors.flatMap((selector) =>
        Array.from(document.querySelectorAll(selector)),
      );
      const focused = document.activeElement;
      const focusedCandidate = candidates.find(
        (node) => node === focused || (focused && node.contains?.(focused)),
      );
      const active = focusedCandidate || candidates.find((node) => isVisible(node)) || candidates[0] || null;
      return {
        editorText: editor?.innerText ?? '',
        fallbackValue: fallback?.value ?? '',
        activeValue: active ? readValue(active) : '',
        activeVisible: Boolean(active && isVisible(active)),
        activeFocused: Boolean(active && focusedCandidate === active),
      };
    })()`,
    returnByValue: true,
  });

  const editorTextRaw = verification.result?.value?.editorText ?? "";
  const fallbackValueRaw = verification.result?.value?.fallbackValue ?? "";
  const activeValueRaw = verification.result?.value?.activeValue ?? "";
  const editorTextTrimmed = editorTextRaw?.trim?.() ?? "";
  const fallbackValueTrimmed = fallbackValueRaw?.trim?.() ?? "";
  const activeValueTrimmed = activeValueRaw?.trim?.() ?? "";
  if (!editorTextTrimmed && !fallbackValueTrimmed && !activeValueTrimmed) {
    // Learned: occasionally Input.insertText doesn't land in the editor; force textContent/value + input events.
    await runtime.evaluate({
      expression: `(() => {
        const fallback = document.querySelector(${fallbackSelectorLiteral});
        if (fallback) {
          fallback.value = ${encodedPrompt};
          fallback.dispatchEvent(new InputEvent('input', { bubbles: true, data: ${encodedPrompt}, inputType: 'insertFromPaste' }));
          fallback.dispatchEvent(new Event('change', { bubbles: true }));
        }
        const editor = document.querySelector(${primarySelectorLiteral});
        if (editor) {
          editor.textContent = ${encodedPrompt};
          // Nudge ProseMirror to register the textContent write so its state/send-button updates
          editor.dispatchEvent(new InputEvent('input', { bubbles: true, data: ${encodedPrompt}, inputType: 'insertFromPaste' }));
        }
      })()`,
    });
  }

  const promptLength = prompt.length;
  const postVerification = await runtime.evaluate({
    expression: `(() => {
      const editor = document.querySelector(${primarySelectorLiteral});
      const fallback = document.querySelector(${fallbackSelectorLiteral});
      const inputSelectors = ${JSON.stringify(INPUT_SELECTORS)};
      const readValue = (node) => {
        if (!node) return '';
        if (node instanceof HTMLTextAreaElement) return node.value ?? '';
        return node.innerText ?? '';
      };
      const isVisible = (node) => {
        if (!node || typeof node.getBoundingClientRect !== 'function') return false;
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      const candidates = inputSelectors.flatMap((selector) =>
        Array.from(document.querySelectorAll(selector)),
      );
      const focused = document.activeElement;
      const focusedCandidate = candidates.find(
        (node) => node === focused || (focused && node.contains?.(focused)),
      );
      const active = focusedCandidate || candidates.find((node) => isVisible(node)) || candidates[0] || null;
      return {
        editorText: editor?.innerText ?? '',
        fallbackValue: fallback?.value ?? '',
        activeValue: active ? readValue(active) : '',
        activeVisible: Boolean(active && isVisible(active)),
        activeFocused: Boolean(active && focusedCandidate === active),
      };
    })()`,
    returnByValue: true,
  });
  const observedEditor = postVerification.result?.value?.editorText ?? "";
  const observedFallback = postVerification.result?.value?.fallbackValue ?? "";
  const observedActive = postVerification.result?.value?.activeValue ?? "";
  const activeVisible = postVerification.result?.value?.activeVisible === true;
  const activeFocused = postVerification.result?.value?.activeFocused === true;
  // The focused visible editor is the only composer that can receive the
  // dispatch. A stale hidden editor containing the full prompt must never mask
  // truncation in the active one.
  const observedLength = activeVisible && activeFocused ? observedActive.length : 0;
  if (deps.requireExactPromptRoundTrip) {
    const normalizedPrompt = normalizeRenderedPromptDomIdentity(prompt);
    const exactRoundTrip =
      activeVisible &&
      activeFocused &&
      normalizeRenderedPromptDomIdentity(observedActive) === normalizedPrompt;
    if (!exactRoundTrip) {
      await logDomFailure(runtime, logger, "prompt-inline-fallback-mismatch");
      throw new BrowserAutomationError(
        "Inline attachment fallback did not round-trip the complete prompt; refusing to dispatch.",
        {
          stage: "submit-prompt",
          code: "prompt-inline-fallback-mismatch",
          retryable: true,
          promptLength,
          observedLengths: [observedEditor.length, observedFallback.length, observedActive.length],
        },
      );
    }
  }
  if (promptLength >= 50_000 && observedLength < promptLength - 2_000) {
    // Learned: very large prompts can truncate silently; fail fast so we can fall back to file uploads.
    await logDomFailure(runtime, logger, "prompt-too-large");
    throw new BrowserAutomationError(
      "Prompt appears truncated in the composer (likely too large).",
      {
        stage: "submit-prompt",
        code: "prompt-too-large",
        promptLength,
        observedLength,
      },
    );
  }

  const clicked = await attemptSendButton(
    runtime,
    input,
    logger,
    deps?.attachmentNames,
    deps?.attachmentTimeoutMs,
    deps?.attachmentBindingToken,
    deps.beforePromptSubmit,
    () => deps.onPromptSubmitted?.(prompt),
    prompt,
  );
  if (!clicked) {
    if (
      deps.requireBoundSendTarget ||
      deps.requireExactPromptRoundTrip ||
      deps.beforePromptSubmit
    ) {
      throw new BrowserAutomationError(
        "Protected submission never reached a bound clickable send target; refusing Enter fallback.",
        {
          stage: "submit-prompt",
          code: "protected-send-target-unavailable",
        },
      );
    }
    // Callers without a final page/account guard retain the historical Enter
    // fallback. Guarded provider submissions must use a bound send target.
    // Persist the conservative account-safety boundary before issuing the
    // first key event: a lost CDP response cannot prove that ChatGPT did not
    // receive the keydown. If either callback/log persistence fails, no input
    // is issued.
    await deps.onPromptSubmitted?.(prompt);
    logger("Submitted prompt via Enter key");
    await input.dispatchKeyEvent({
      type: "keyDown",
      ...ENTER_KEY_EVENT,
      text: ENTER_KEY_TEXT,
      unmodifiedText: ENTER_KEY_TEXT,
    });
    await input.dispatchKeyEvent({
      type: "keyUp",
      ...ENTER_KEY_EVENT,
    });
  }
  const commitTimeoutMs = Math.max(60_000, deps.inputTimeoutMs ?? 0);
  const submittedAttachmentNames = (deps.attachmentNames ?? [])
    .map((attachment) => (typeof attachment === "string" ? attachment : attachment.name))
    .filter((name): name is string => typeof name === "string" && name.length > 0);
  // Learned: the send button can succeed but the turn doesn't appear immediately; verify commit via turns/stop button.
  const committedTurns = await verifyPromptCommitted(
    runtime,
    prompt,
    commitTimeoutMs,
    logger,
    baselineTurns,
    submittedAttachmentNames,
  );
  // Bind this run's capture to the user message that was just committed, so
  // the eventual assistant capture can be structurally proven to answer THIS
  // submission (not a stale turn or another run's cross-talk). Never throws.
  const binding = await registerSubmittedUserMessage(runtime, prompt, logger, {
    attachmentNames: submittedAttachmentNames,
  });
  await deps.onPromptBound?.(prompt, binding);
  return committedTurns;
}

async function acquirePreSubmitBaseline(
  Runtime: ChromeClient["Runtime"],
  suppliedBaseline?: number | null,
): Promise<number> {
  if (
    typeof suppliedBaseline === "number" &&
    Number.isFinite(suppliedBaseline) &&
    suppliedBaseline >= 0
  ) {
    return Math.floor(suppliedBaseline);
  }

  try {
    const { result } = await Runtime.evaluate({
      expression: buildConversationTurnCountExpression(),
      returnByValue: true,
    });
    const observed = result?.value;
    if (typeof observed === "number" && Number.isFinite(observed) && observed >= 0) {
      return Math.floor(observed);
    }
  } catch (error) {
    throw new BrowserAutomationError(
      "Unable to establish a pre-submit conversation baseline; refusing to dispatch the prompt.",
      {
        stage: "submit-prompt",
        code: "prompt-baseline-unavailable",
        retryable: true,
      },
      error,
    );
  }

  throw new BrowserAutomationError(
    "Unable to establish a pre-submit conversation baseline; refusing to dispatch the prompt.",
    {
      stage: "submit-prompt",
      code: "prompt-baseline-unavailable",
      retryable: true,
    },
  );
}

export async function clearPromptComposer(Runtime: ChromeClient["Runtime"], logger: BrowserLogger) {
  const primarySelectorLiteral = JSON.stringify(PROMPT_PRIMARY_SELECTOR);
  const fallbackSelectorLiteral = JSON.stringify(PROMPT_FALLBACK_SELECTOR);
  const inputSelectorsLiteral = JSON.stringify(INPUT_SELECTORS);
  const result = await Runtime.evaluate({
    expression: `(() => {
      const SELECTORS = ${inputSelectorsLiteral};
      const fallback = document.querySelector(${fallbackSelectorLiteral});
      const editor = document.querySelector(${primarySelectorLiteral});
      const readValue = (node) => {
        if (!node) return '';
        if (node instanceof HTMLTextAreaElement || node instanceof HTMLInputElement) return node.value ?? '';
        return node.innerText ?? node.textContent ?? '';
      };
      const dispatchClearEvents = (node) => {
        try {
          node.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, data: null, inputType: 'deleteContentBackward' }));
        } catch {}
        try {
          node.dispatchEvent(new InputEvent('input', { bubbles: true, data: '', inputType: 'deleteByCut' }));
        } catch {
          node.dispatchEvent(new Event('input', { bubbles: true }));
        }
        node.dispatchEvent(new Event('change', { bubbles: true }));
      };
      const clearEditable = (node) => {
        if (!node) return false;
        try {
          node.focus?.();
        } catch {}
        if (node instanceof HTMLTextAreaElement || node instanceof HTMLInputElement) {
          node.value = '';
          dispatchClearEvents(node);
          return true;
        }
        if (node.isContentEditable || node.getAttribute('contenteditable') === 'true') {
          try {
            const selection = node.ownerDocument?.getSelection?.();
            const range = node.ownerDocument?.createRange?.();
            if (selection && range) {
              range.selectNodeContents(node);
              selection.removeAllRanges();
              selection.addRange(range);
              node.ownerDocument?.execCommand?.('delete', false);
            }
          } catch {}
          node.textContent = '';
          dispatchClearEvents(node);
          return true;
        }
        return false;
      };
      let cleared = false;
      const nodes = SELECTORS
        .map((selector) => document.querySelector(selector))
        .filter((node) => Boolean(node));
      for (const node of Array.from(new Set([fallback, editor, ...nodes])).filter(Boolean)) {
        cleared = clearEditable(node) || cleared;
      }
      const remaining = Array.from(new Set([fallback, editor, ...nodes]))
        .filter(Boolean)
        .map((node) => readValue(node).trim())
        .filter(Boolean);
      return { cleared, remaining };
    })()`,
    returnByValue: true,
  });
  const value = result.result?.value as { cleared?: boolean; remaining?: string[] } | undefined;
  if (!value?.cleared || (value.remaining?.length ?? 0) > 0) {
    await logDomFailure(Runtime, logger, "clear-composer");
    throw new Error("Failed to clear prompt composer");
  }
  await delay(250);
}

async function waitForDomReady(
  Runtime: ChromeClient["Runtime"],
  logger?: BrowserLogger,
  timeoutMs = 10_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { result } = await Runtime.evaluate({
      expression: `(() => {
        const ready = document.readyState === 'complete';
        const composer = document.querySelector('[data-testid*="composer"]') || document.querySelector('form');
        const fileInput = document.querySelector('input[type="file"]');
        return { ready, composer: Boolean(composer), fileInput: Boolean(fileInput) };
      })()`,
      returnByValue: true,
    });
    const value = result?.value as
      | { ready?: boolean; composer?: boolean; fileInput?: boolean }
      | undefined;
    if (value?.ready && value.composer) {
      return;
    }
    await delay(150);
  }
  logger?.(`Page did not reach ready/composer state within ${timeoutMs}ms; continuing cautiously.`);
}

export function buildAttachmentReadyExpression(
  attachmentNames: AttachmentReadyInput[],
  bindingToken?: string,
  bindToken = false,
  sendBindingToken?: string,
  exactSet = false,
): string {
  const attachmentExpectations = attachmentNames.map((attachment) => {
    const name = typeof attachment === "string" ? attachment : attachment.name;
    const normalized = name.toLowerCase().replace(/\s+/g, " ").trim();
    return {
      name: normalized,
      stem: normalized.replace(/\.[a-z0-9]{1,10}$/i, ""),
      extension: normalized.match(/(\.[a-z0-9]{1,10})$/i)?.[1] ?? "",
      generatedBundle: typeof attachment === "object" && attachment.generatedBundle === true,
    };
  });
  const namesLiteral = JSON.stringify(attachmentExpectations);
  const bindingTokenLiteral = JSON.stringify(bindingToken ?? "");
  const bindTokenLiteral = JSON.stringify(bindToken);
  const exactSetLiteral = JSON.stringify(exactSet);
  const sendBindingTokenLiteral = JSON.stringify(sendBindingToken ?? "");
  return `(() => {
    const expected = ${namesLiteral};
    const exactSet = ${exactSetLiteral};
    const bindingToken = ${bindingTokenLiteral};
    const bindToken = ${bindTokenLiteral};
    const sendBindingToken = ${sendBindingTokenLiteral};
    const sendSelectors = ${JSON.stringify(SEND_BUTTON_SELECTORS)};
    const normalize = (value) => String(value || '').toLowerCase().replace(/\\s+/g, ' ').trim();
    const hasNameBoundary = (text, name) => {
      if (!name) return false;
      let from = 0;
      while (from < text.length) {
        const index = text.indexOf(name, from);
        if (index === -1) return false;
        const previous = text[index - 1] || '';
        const next = text[index + name.length] || '';
        const previousOk = !previous || !/[a-z0-9._-]/.test(previous);
        const nextOk = !next || !/[a-z0-9._-]/.test(next);
        if (previousOk && nextOk) return true;
        from = index + name.length;
      }
      return false;
    };
    const hasStemFileBoundary = (text, stem) => {
      if (!stem) return false;
      let from = 0;
      while (from < text.length) {
        const index = text.indexOf(stem, from);
        if (index === -1) return false;
        const previous = text[index - 1] || '';
        const next = text[index + stem.length] || '';
        const previousOk = !previous || !/[a-z0-9._-]/.test(previous);
        const nextOk = !next || !/[a-z0-9._-]/.test(next);
        if (previousOk && nextOk) return true;
        from = index + stem.length;
      }
      return false;
    };
    const hasBareStemBoundary = (text, stem) => {
      if (!stem) return false;
      let from = 0;
      while (from < text.length) {
        const index = text.indexOf(stem, from);
        if (index === -1) return false;
        const previous = text[index - 1] || '';
        const next = text[index + stem.length] || '';
        const previousOk = !previous || !/[a-z0-9._-]/.test(previous);
        const nextOk = !next || !/[a-z0-9._(-]/.test(next);
        if (previousOk && nextOk) return true;
        from = index + stem.length;
      }
      return false;
    };
    const hasExtensionBoundary = (text, extension) => {
      if (!extension) return false;
      let from = 0;
      while (from < text.length) {
        const index = text.indexOf(extension, from);
        if (index === -1) return false;
        const next = text[index + extension.length] || '';
        if (!next || !/[a-z0-9]/.test(next)) return true;
        from = index + extension.length;
      }
      return false;
    };
    const matchesExpected = (value, item) => {
      const text = normalize(value);
      if (!text) return false;
      if (hasNameBoundary(text, item.name)) return true;
      if (item.generatedBundle && hasBareStemBoundary(text, item.stem)) return true;
      if (
        item.stem &&
        item.stem.length >= 4 &&
        item.extension &&
        text.includes(item.stem + '(') &&
        hasExtensionBoundary(text, item.extension)
      ) {
        return true;
      }
      if (text.includes('…') || text.includes('...')) {
        const marker = text.includes('…') ? '…' : '...';
        const [prefixRaw, suffixRaw] = text.split(marker);
        const prefix = normalize(prefixRaw);
        const suffix = normalize(suffixRaw);
        const prefixParts = prefix.split(' ').filter(Boolean);
        const suffixParts = suffix.split(' ').filter(Boolean);
        const prefixCandidates = prefixParts.map((_, index) => prefixParts.slice(index).join(' '));
        const suffixCandidates = suffixParts.map((_, index) =>
          suffixParts.slice(0, suffixParts.length - index).join(' '),
        );
        if (prefixCandidates.length === 0 || suffixCandidates.length === 0) return false;
        const targets = [item.name, item.stem && item.stem.length >= 4 ? item.stem : ''].filter(Boolean);
        return targets.some((target) => {
          return prefixCandidates.some((prefixPart) =>
            suffixCandidates.some((suffixPart) => {
              const strongEnough =
                suffixPart.length >= 2 &&
                (prefixPart.length >= 3 || (prefixPart.length >= 2 && suffixPart.length >= 4));
              return strongEnough && target.startsWith(prefixPart) && target.endsWith(suffixPart);
            }),
          );
        });
      }
      return false;
    };
    // Restrict to attachment affordances; never scan generic div/span nodes (prompt text can contain the file name).
    const attachmentSelectors = [
      // Current ChatGPT file tiles expose the filename through a role-group aria label.
      '[role="group"][aria-label]',
      '[data-testid*="chip"]',
      '[data-testid*="attachment"]',
      '[data-testid*="upload"]',
      '[data-testid*="file"]',
      '[aria-label*="Remove file"]',
      'button[aria-label*="Remove file"]',
      '[aria-label*="remove file"]',
      'button[aria-label*="remove file"]',
      '[aria-label*="Remove attachment"]',
      'button[aria-label*="Remove attachment"]',
      '[aria-label*="remove attachment"]',
      'button[aria-label*="remove attachment"]',
    ];
    const isVisible = (node) => {
      if (!(node instanceof HTMLElement)) return false;
      const rect = node.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      const style = typeof window === 'object' ? window.getComputedStyle?.(node) : null;
      return !style || (style.display !== 'none' && style.visibility !== 'hidden');
    };
    const promptCandidates = [];
    for (const selector of ${JSON.stringify(INPUT_SELECTORS)}) {
      promptCandidates.push(...Array.from(document.querySelectorAll(selector)));
    }
    const uniquePromptCandidates = Array.from(new Set(promptCandidates));
    const boundEditors = sendBindingToken
      ? uniquePromptCandidates.filter(
          (node) => node?.getAttribute?.('data-oracle-send-editor-binding') === sendBindingToken,
        )
      : [];
    const focused = document.activeElement;
    const focusedPrompts = uniquePromptCandidates.filter(
      (node) => isVisible(node) && Boolean(focused && (node === focused || node.contains?.(focused))),
    );
    const visiblePrompts = uniquePromptCandidates.filter(isVisible);
    const activePrompt = sendBindingToken
      ? (boundEditors.length === 1 ? boundEditors[0] : null)
      : (
          focusedPrompts.length === 1
            ? focusedPrompts[0]
            : (visiblePrompts.length === 1 ? visiblePrompts[0] : null)
        );
    // A binding token is a claim about the exact active editor/controller.
    // Never mint or verify that claim from a chip or send-button wrapper alone.
    if (bindingToken && !activePrompt) return false;
    const isUsableComposerRoot = (node) => {
      if (!(node instanceof HTMLElement)) return false;
      const tagName = String(node.tagName || '').toLowerCase();
      if (tagName === 'button' || tagName === 'textarea' || tagName === 'input') return false;
      if (node.getAttribute?.('contenteditable') === 'true') return false;
      const testId = String(node.getAttribute?.('data-testid') || '').toLowerCase();
      if (!testId.includes('composer')) return false;
      return !(
        testId.includes('footer') ||
        testId.includes('action') ||
        testId.includes('plus') ||
        testId.includes('input') ||
        testId.includes('send')
      );
    };
    const closestComposerRoot = (node) => {
      let current = node instanceof HTMLElement ? node : null;
      while (current) {
        if (isUsableComposerRoot(current)) return current;
        current = current.parentElement;
      }
      return null;
    };
    const firstComposerRoot = () =>
      Array.from(document.querySelectorAll('[data-testid*="composer"]')).find(isUsableComposerRoot) || null;
    const fallbackSendButton = sendSelectors
      .flatMap((selector) => Array.from(document.querySelectorAll(selector)))
      .find(isVisible) || null;
    const boundComposers = sendBindingToken
      ? Array.from(document.querySelectorAll('[data-oracle-send-composer-binding]')).filter(
          (node) => node?.getAttribute?.('data-oracle-send-composer-binding') === sendBindingToken,
        )
      : [];
    const composer = sendBindingToken
      ? (boundComposers.length === 1 ? boundComposers[0] : null)
      : (
          closestComposerRoot(activePrompt) ||
          activePrompt?.closest?.('form') ||
          (!activePrompt ? closestComposerRoot(fallbackSendButton) : null) ||
          (!activePrompt ? fallbackSendButton?.closest?.('form') : null) ||
          firstComposerRoot() ||
          (!activePrompt ? document.querySelector('form') : null)
        );
    if (!composer) return false;
    if (activePrompt && !composer.contains(activePrompt)) return false;
    const sendButton = sendSelectors
      .flatMap((selector) => Array.from(composer.querySelectorAll(selector)))
      .find(isVisible) || null;
    // Walk node + ancestors (up to grandparent) + descendants to gather every textual hint.
    // ChatGPT's current chip DOM nests the filename inside truncated child spans, so checking
    // only the node's own textContent/aria/title misses the match.
    const collectOwnLabelHaystack = (node) => {
      if (!node) return '';
      const pieces = [];
      const pushAttrs = (el) => {
        if (!el || typeof el.getAttribute !== 'function') return;
        for (const attr of ['aria-label', 'title', 'data-testid', 'data-tooltip', 'data-tooltip-content']) {
          const v = el.getAttribute(attr);
          if (v) pieces.push(v);
        }
      };
      const pushText = (el) => {
        if (!el) return;
        const text = (el.innerText ?? el.textContent ?? '').trim();
        if (text) pieces.push(text);
      };
      pushAttrs(node);
      pushText(node);
      return pieces.join(' ').toLowerCase();
    };
    const collectLabelHaystack = (node) => {
      if (!node) return '';
      const pieces = [collectOwnLabelHaystack(node)];
      const push = (el) => {
        const text = collectOwnLabelHaystack(el);
        if (text) pieces.push(text);
      };
      const parent = node.parentElement;
      push(parent);
      const grandparent = parent?.parentElement;
      push(grandparent);
      return pieces.join(' ').toLowerCase();
    };
    const attachmentRoots = Array.from(new Set([composer])).filter(Boolean);
    const collectChipNodes = () => {
      const seen = new Set();
      const collected = [];
      for (const root of attachmentRoots) {
        for (const node of Array.from(root.querySelectorAll(attachmentSelectors.join(',')))) {
          if (!(node instanceof HTMLElement)) continue;
          // Skip elements clearly inside the editable input (composer textarea may contain
          // filename text in the user's prompt — avoid mistaking that for a chip).
          if (node.closest('textarea,[contenteditable="true"]')) continue;
          if (seen.has(node)) continue;
          seen.add(node);
          collected.push(node);
        }
      }
      return collected;
    };
    const chipNodes = collectChipNodes();
    const chipLabels = chipNodes.map((node) => collectLabelHaystack(node));
    const chipOwnLabels = chipNodes.map((node) => collectOwnLabelHaystack(node));
    const hasEllipsisSuffix = (label) => {
      const marker = label.includes('…') ? '…' : label.includes('...') ? '...' : '';
      if (!marker) return false;
      return normalize(label.split(marker)[1] || '').length > 0;
    };
    const chipOwnLabelsWithVisibleNames = chipOwnLabels.filter((label) =>
      /\\.[a-z][a-z0-9]{0,9}(?:\\b|$)/i.test(label) ||
      hasEllipsisSuffix(label),
    );
    const visibleExtensionLabelsMatchExpected = chipOwnLabelsWithVisibleNames.every((label) =>
      expected.some((item) => matchesExpected(label, item)),
    );
    const visibleStemOnlyMismatch = chipOwnLabels.some((label) =>
      expected.some(
        (item) =>
          !item.generatedBundle &&
          item.stem &&
          hasStemFileBoundary(label, item.stem) &&
          !matchesExpected(label, item),
      ),
    );

    const chipsReady = (() => {
      const used = new Set();
      return expected.every((item) => {
        const index = chipLabels.findIndex((label, candidateIndex) =>
          !used.has(candidateIndex) && matchesExpected(label, item),
        );
        if (index === -1) return false;
        used.add(index);
        return true;
      });
    })();
    const selectedFiles = attachmentRoots.flatMap((root) =>
      Array.from(root.querySelectorAll('input[type="file"]')).flatMap((el) =>
        Array.from((el instanceof HTMLInputElement ? el.files : []) || []),
      ),
    );
    const inputsReady = (() => {
      const used = new Set();
      return expected.every((item) => {
        const index = selectedFiles.findIndex(
          (file, candidateIndex) =>
            !used.has(candidateIndex) && matchesExpected(file?.name, item),
        );
        if (index === -1) return false;
        used.add(index);
        return true;
      });
    })();
    // Count-based fallback: if we cannot match names individually (ChatGPT may strip
    // the filename out of attribute-readable text into a deeply nested span), but we
    // do see at least as many distinct "Remove" affordances as attachments we
    // uploaded, trust the upload without double-counting nested chip/remove nodes.
    const removeAffordances = [];
    const removeSeen = new Set();
    for (const root of attachmentRoots) {
      for (const node of Array.from(root.querySelectorAll(
        '[aria-label*="Remove" i], [aria-label*="remove" i], button[aria-label*="Remove" i], button[aria-label*="remove" i]',
      ))) {
        if (!(node instanceof HTMLElement)) continue;
        if (node.closest('textarea,[contenteditable="true"]')) continue;
        const aria = (node.getAttribute?.('aria-label') ?? '').toLowerCase();
        const fileSpecific = aria.includes('remove file') || aria.includes('remove attachment');
        const attachmentOwner = node.closest(
          '[data-testid*="chip"], [data-testid*="attachment"], [data-testid*="upload"], [data-testid*="file"]',
        );
        if (!fileSpecific && !attachmentOwner) continue;
        if (removeSeen.has(node)) continue;
        removeSeen.add(node);
        removeAffordances.push(node);
      }
    }
    const countReady =
      !visibleStemOnlyMismatch &&
      visibleExtensionLabelsMatchExpected &&
      removeAffordances.length >= expected.length;

    const selectedFileCount = selectedFiles.length;
    const residualAttachmentNodes = chipNodes.filter((node) => {
      if (!isVisible(node)) return false;
      const testid = (node.getAttribute('data-testid') || '').toLowerCase();
      const aria = (node.getAttribute('aria-label') || '').toLowerCase();
      const state = (node.getAttribute('data-state') || '').toLowerCase();
      const text = (node.textContent || '').trim();
      const removeControl =
        /remove[-_ ]?(?:file|attachment)/.test(testid + ' ' + aria) ||
        Boolean(node.querySelector?.(
          '[aria-label*="Remove file"], [aria-label*="remove file"], [aria-label*="Remove attachment"], [aria-label*="remove attachment"], [data-testid*="remove-attachment"], [data-testid*="attachment-remove"]',
        ));
      const uploadState =
        node.getAttribute('aria-busy') === 'true' ||
        ['loading', 'uploading', 'pending'].includes(state) ||
        /\\b(?:uploading|processing)\\b/i.test(text);
      const genericTrigger =
        node.matches?.('button,[role="button"]') === true && !removeControl && !uploadState;
      if (genericTrigger) return false;
      return (
        node.matches?.('[role="group"][aria-label]') === true ||
        removeControl ||
        uploadState ||
        testid.includes('attachment') ||
        testid.includes('chip') ||
        ((testid.includes('upload') || testid.includes('file')) && text.length > 0)
      );
    });
    const hasUploadingResidual = residualAttachmentNodes.some((node) => {
      const state = (node.getAttribute('data-state') || '').toLowerCase();
      const text = (node.textContent || '').trim();
      return (
        node.getAttribute('aria-busy') === 'true' ||
        ['loading', 'uploading', 'pending'].includes(state) ||
        /\b(?:uploading|processing)\b/i.test(text)
      );
    });
    const attachmentOwnerSelector = [
      '[role="group"][aria-label]',
      '[data-testid*="attachment"]',
      '[data-testid*="upload"]',
      '[data-testid*="file"]',
      '[data-testid*="chip"]',
    ].join(',');
    const canonicalAttachmentOwners = new Set();
    for (const node of residualAttachmentNodes) {
      const isRemoveAffordance = removeAffordances.includes(node);
      const owner = isRemoveAffordance
        ? (node.parentElement?.closest?.(attachmentOwnerSelector) ?? node.parentElement ?? node)
        : (node.closest?.(attachmentOwnerSelector) ?? node);
      canonicalAttachmentOwners.add(owner);
    }
    const exactInputsReady = inputsReady && selectedFileCount === expected.length;
    const exactChipsReady = chipsReady && removeAffordances.length === expected.length;
    const exactAttachmentSetReady =
      (exactInputsReady || exactChipsReady) &&
      !hasUploadingResidual &&
      visibleExtensionLabelsMatchExpected &&
      !visibleStemOnlyMismatch &&
      (selectedFileCount === 0 || selectedFileCount === expected.length) &&
      (
        residualAttachmentNodes.length === 0 ||
        (
          removeAffordances.length === expected.length &&
          canonicalAttachmentOwners.size === expected.length
        )
      );
    const ready = expected.length === 0
      ? selectedFileCount === 0 && residualAttachmentNodes.length === 0
      : exactSet
        ? exactAttachmentSetReady
        : (
            (chipsReady || inputsReady || countReady) &&
            visibleExtensionLabelsMatchExpected &&
            !visibleStemOnlyMismatch &&
            (removeAffordances.length === 0 || removeAffordances.length === expected.length)
          );
    if (ready && bindingToken) {
      if (bindToken) {
        composer.setAttribute('data-oracle-attachment-binding', bindingToken);
      } else if (composer.getAttribute('data-oracle-attachment-binding') !== bindingToken) {
        return false;
      }
    }
    return ready;
  })()`;
}

export function buildAttachmentReadyExpressionForTest(
  attachmentNames: AttachmentReadyInput[],
  bindingToken?: string,
  bindToken = false,
  sendBindingToken?: string,
  exactSet = false,
) {
  return buildAttachmentReadyExpression(
    attachmentNames,
    bindingToken,
    bindToken,
    sendBindingToken,
    exactSet,
  );
}

export async function bindActiveComposerAttachments(
  Runtime: ChromeClient["Runtime"],
  attachmentNames: AttachmentReadyInput[],
  bindingToken: string,
  logger: BrowserLogger,
): Promise<void> {
  const result = await Runtime.evaluate({
    expression: buildAttachmentReadyExpression(attachmentNames, bindingToken, true),
    returnByValue: true,
  });
  if (result.result?.value === true) return;
  await logDomFailure(Runtime, logger, "attachment-composer-binding");
  throw new BrowserAutomationError(
    "Uploaded attachments could not be bound to the active ChatGPT composer.",
    {
      stage: "submit-prompt",
      code: "attachment-composer-binding-missing",
      attachmentCount: attachmentNames.length,
    },
  );
}

function buildSendButtonTargetExpression(
  attachmentBindingToken?: string,
  sendBindingToken?: string,
  bindSendTarget = false,
): string {
  const attachmentBindingTokenLiteral = JSON.stringify(attachmentBindingToken ?? "");
  const sendBindingTokenLiteral = JSON.stringify(sendBindingToken ?? "");
  return `(() => {
    ${buildClickDispatcher()}
    const inputSelectors = ${JSON.stringify(INPUT_SELECTORS)};
    const sendSelectors = ${JSON.stringify(SEND_BUTTON_SELECTORS)};
    const attachmentBindingToken = ${attachmentBindingTokenLiteral};
    const sendBindingToken = ${sendBindingTokenLiteral};
    const bindSendTarget = ${JSON.stringify(bindSendTarget)};
    const isVisible = (node) => {
      if (!(node instanceof HTMLElement) || node.isConnected === false) return false;
      const rect = node.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      let current = node;
      while (current instanceof HTMLElement) {
        const style = window.getComputedStyle?.(current);
        if (
          current.hidden ||
          current.getAttribute?.('aria-hidden') === 'true' ||
          style?.display === 'none' ||
          style?.visibility === 'hidden' ||
          style?.visibility === 'collapse' ||
          Number.parseFloat(style?.opacity || '1') === 0
        ) return false;
        current = current.parentElement;
      }
      return true;
    };
    const isEnabled = (node) => {
      const ariaDisabled = node.getAttribute('aria-disabled');
      const dataDisabled = node.getAttribute('data-disabled');
      const style = window.getComputedStyle(node);
      return !(
        node.hasAttribute('disabled') ||
        ariaDisabled === 'true' ||
        dataDisabled === 'true' ||
        style.pointerEvents === 'none' ||
        style.display === 'none'
      );
    };
    const promptCandidates = [];
    for (const selector of inputSelectors) {
      promptCandidates.push(...Array.from(document.querySelectorAll(selector)));
    }
    const uniquePromptCandidates = Array.from(new Set(promptCandidates));
    const boundEditors = sendBindingToken
      ? uniquePromptCandidates.filter(
          (node) => node?.getAttribute?.('data-oracle-send-editor-binding') === sendBindingToken,
        )
      : [];
    const focused = document.activeElement;
    const focusedEditors = uniquePromptCandidates.filter(
      (node) =>
        isVisible(node) &&
        Boolean(focused && (node === focused || node.contains?.(focused))),
    );
    const activePrompt = !bindSendTarget && sendBindingToken
      ? (boundEditors.length === 1 ? boundEditors[0] : null)
      : (focusedEditors.length === 1 ? focusedEditors[0] : null);
    if (!activePrompt) {
      return {
        status: 'binding-missing',
        reason: !bindSendTarget && sendBindingToken
          ? 'bound-editor-missing-or-ambiguous'
          : 'focused-editor-missing-or-ambiguous',
      };
    }
    const isUsableComposerRoot = (node) => {
      if (!(node instanceof HTMLElement)) return false;
      const tagName = String(node.tagName || '').toLowerCase();
      if (tagName === 'button' || tagName === 'textarea' || tagName === 'input') return false;
      if (node.getAttribute?.('contenteditable') === 'true') return false;
      const testId = String(node.getAttribute?.('data-testid') || '').toLowerCase();
      if (!testId.includes('composer')) return false;
      return !(
        testId.includes('footer') ||
        testId.includes('action') ||
        testId.includes('plus') ||
        testId.includes('input') ||
        testId.includes('send')
      );
    };
    const closestComposerRoot = (node) => {
      let current = node instanceof HTMLElement ? node : null;
      while (current) {
        if (isUsableComposerRoot(current)) return current;
        current = current.parentElement;
      }
      return null;
    };
    const boundComposers = sendBindingToken
      ? Array.from(document.querySelectorAll('[data-oracle-send-composer-binding]')).filter(
          (node) => node?.getAttribute?.('data-oracle-send-composer-binding') === sendBindingToken,
        )
      : [];
    const composer = !bindSendTarget && sendBindingToken
      ? (boundComposers.length === 1 ? boundComposers[0] : null)
      : (closestComposerRoot(activePrompt) || activePrompt.closest?.('form') || null);
    if (!composer || !composer.contains(activePrompt)) {
      return { status: 'binding-missing', reason: 'active-composer-missing' };
    }
    if (
      attachmentBindingToken &&
      composer.getAttribute('data-oracle-attachment-binding') !== attachmentBindingToken
    ) {
      return { status: 'binding-missing', reason: 'attachment-composer-remounted' };
    }
    const candidates = [];
    for (const selector of sendSelectors) {
      candidates.push(...Array.from(composer.querySelectorAll(selector)));
    }
    const usableButtons = Array.from(new Set(candidates)).filter(
      (node) => isVisible(node) && isEnabled(node),
    );
    const boundButtons = sendBindingToken
      ? usableButtons.filter(
          (node) => node?.getAttribute?.('data-oracle-send-binding') === sendBindingToken,
        )
      : [];
    const button = !bindSendTarget && sendBindingToken
      ? (boundButtons.length === 1 ? boundButtons[0] : null)
      : (usableButtons.length === 1 ? usableButtons[0] : null);
    if (!button) return { status: 'missing', reason: 'same-composer-send-missing-or-ambiguous' };
    if (sendBindingToken) {
      if (bindSendTarget) {
        activePrompt.setAttribute('data-oracle-send-editor-binding', sendBindingToken);
        composer.setAttribute('data-oracle-send-composer-binding', sendBindingToken);
        button.setAttribute('data-oracle-send-binding', sendBindingToken);
      } else if (
        activePrompt.getAttribute('data-oracle-send-editor-binding') !== sendBindingToken ||
        composer.getAttribute('data-oracle-send-composer-binding') !== sendBindingToken ||
        button.getAttribute('data-oracle-send-binding') !== sendBindingToken
      ) {
        return { status: 'binding-missing', reason: 'send-target-remounted-after-preflight' };
      }
    }
    button.scrollIntoView({ block: 'center', inline: 'center' });
    const rect = button.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return { status: 'blocked', reason: 'send-button-empty-rect' };
    }
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const hit = document.elementFromPoint(x, y);
    if (!(hit === button || (hit instanceof Node && button.contains(hit)))) {
      return { status: 'blocked', reason: 'send-button-hit-test-failed' };
    }
    return { status: 'point', x, y };
  })()`;
}

export function buildSendButtonTargetExpressionForTest(
  attachmentBindingToken?: string,
  sendBindingToken?: string,
  bindSendTarget = false,
): string {
  return buildSendButtonTargetExpression(attachmentBindingToken, sendBindingToken, bindSendTarget);
}

interface ArmedFinalDispatchGuard {
  terminalVerdict: unknown | undefined;
  unsubscribe?: () => void;
}

function buildOwnedSendBindingCleanupExpression(sendBindingToken: string): string {
  const tokenLiteral = JSON.stringify(sendBindingToken);
  return `(() => {
    const TOKEN = ${tokenLiteral};
    let removed = 0;
    for (const node of Array.from(document.querySelectorAll('[data-oracle-send-binding]'))) {
      if (node?.getAttribute?.('data-oracle-send-binding') !== TOKEN) continue;
      try { node.removeAttribute?.('data-oracle-send-binding'); removed += 1; } catch {}
    }
    for (const node of Array.from(document.querySelectorAll('[data-oracle-send-editor-binding]'))) {
      if (node?.getAttribute?.('data-oracle-send-editor-binding') !== TOKEN) continue;
      try { node.removeAttribute?.('data-oracle-send-editor-binding'); removed += 1; } catch {}
    }
    for (const node of Array.from(document.querySelectorAll('[data-oracle-send-composer-binding]'))) {
      if (node?.getAttribute?.('data-oracle-send-composer-binding') !== TOKEN) continue;
      try { node.removeAttribute?.('data-oracle-send-composer-binding'); removed += 1; } catch {}
    }
    return { removed };
  })()`;
}

async function armFinalDispatchGuard(
  Runtime: ChromeClient["Runtime"],
  guard: FinalPreDispatchDomGuard,
): Promise<ArmedFinalDispatchGuard> {
  const armed: ArmedFinalDispatchGuard = {
    terminalVerdict: undefined,
  };
  const binding = guard.verdictBinding;
  if (!binding) return armed;
  if (
    typeof Runtime.addBinding !== "function" ||
    typeof Runtime.removeBinding !== "function" ||
    typeof Runtime.bindingCalled !== "function"
  ) {
    throw new BrowserAutomationError(
      "Protected dispatch requires a Runtime binding for its terminal click verdict.",
      {
        stage: "model-selection",
        code: "protected-dispatch-binding-unavailable",
        retryable: false,
      },
    );
  }
  try {
    const detach = Runtime.bindingCalled((event) => {
      if (event.name !== binding.name || armed.terminalVerdict !== undefined) return;
      const parsed = binding.parsePayload(event.payload);
      if (parsed !== undefined) armed.terminalVerdict = parsed;
    });
    armed.unsubscribe = () => {
      try {
        detach();
      } catch {}
    };
    await Runtime.addBinding({ name: binding.name });
    return armed;
  } catch (error) {
    armed.unsubscribe?.();
    throw new BrowserAutomationError(
      "Could not arm the protected dispatch verdict binding; refusing to click.",
      {
        stage: "model-selection",
        code: "protected-dispatch-binding-arm-failed",
        retryable: false,
      },
      error,
    );
  }
}

async function cleanupFinalDispatchGuard(
  Runtime: ChromeClient["Runtime"],
  guard: FinalPreDispatchDomGuard | void,
  armed: ArmedFinalDispatchGuard | undefined,
  sendBindingToken: string,
): Promise<{ pageVerdict: unknown | undefined; cleanupError: unknown | undefined }> {
  let pageVerdict: unknown | undefined;
  let cleanupError: unknown | undefined;
  try {
    const expression =
      guard?.afterDispatchExpression ?? buildOwnedSendBindingCleanupExpression(sendBindingToken);
    const outcome = await Runtime.evaluate({ expression, returnByValue: true });
    if (guard?.afterDispatchExpression) pageVerdict = outcome.result?.value;
  } catch (error) {
    cleanupError = error;
  } finally {
    armed?.unsubscribe?.();
    if (guard?.verdictBinding) {
      try {
        await Runtime.removeBinding({ name: guard.verdictBinding.name });
      } catch (error) {
        cleanupError ??= error;
      }
    }
  }
  return { pageVerdict, cleanupError };
}

function dispatchGuardStatus(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  return typeof (value as { status?: unknown }).status === "string"
    ? ((value as { status: string }).status ?? null)
    : null;
}

function reconcileDispatchGuardVerdicts(
  bindingVerdict: unknown | undefined,
  pageVerdict: unknown | undefined,
): unknown | undefined {
  if (bindingVerdict === undefined) return pageVerdict;
  const bindingStatus = dispatchGuardStatus(bindingVerdict);
  const pageStatus = dispatchGuardStatus(pageVerdict);
  if (pageStatus === "allowed" || pageStatus === "blocked") {
    if (bindingStatus !== pageStatus) {
      return {
        status: "conflict",
        reason: "binding-page-verdict-conflict",
        bindingStatus,
        pageStatus,
      };
    }
  }
  return bindingVerdict;
}

type ExactComposerPreDispatchProof = {
  activeVisible?: boolean;
  activeFocused?: boolean;
  promptMatches?: boolean;
  observedLength?: number;
  inputFileCount?: number;
  residualAttachmentCount?: number;
  residualAttachmentKinds?: string[];
  attachmentExpectationSatisfied?: boolean;
  sendBindingMatches?: boolean | null;
  sendTargetReady?: boolean | null;
  sendX?: number | null;
  sendY?: number | null;
};

/**
 * Build the last-moment proof used by the exact upload-to-inline fallback.
 * The expression is deliberately composer-scoped: ChatGPT always keeps a
 * hidden empty file input in the clean composer, while unrelated page-level
 * upload controls must not make a safe text-only dispatch impossible.
 */
function buildExactComposerPreDispatchExpression(
  expectedPrompt: string,
  sendBindingToken?: string,
  expectedAttachments: AttachmentReadyInput[] = [],
): string {
  const exactAttachmentStateExpression = buildAttachmentReadyExpression(
    expectedAttachments,
    undefined,
    false,
    sendBindingToken,
    true,
  );
  return `(() => {
    const normalizeRenderedPromptDomIdentity = ${normalizeRenderedPromptDomIdentity.toString()};
    const inputSelectors = ${JSON.stringify(INPUT_SELECTORS)};
    const sendSelectors = ${JSON.stringify(SEND_BUTTON_SELECTORS)};
    const expected = ${JSON.stringify(expectedPrompt)};
    const sendBindingToken = ${JSON.stringify(sendBindingToken ?? null)};
    const expectedAttachmentCount = ${JSON.stringify(expectedAttachments.length)};
    const readValue = (node) => {
      if (!node) return '';
      if (node instanceof HTMLTextAreaElement || node instanceof HTMLInputElement) {
        return node.value ?? '';
      }
      return node.innerText ?? node.textContent ?? '';
    };
    const visible = (node) => {
      if (!(node instanceof HTMLElement) || node.isConnected === false) return false;
      const rect = node.getBoundingClientRect();
      if (!(rect.width > 0 && rect.height > 0)) return false;
      let current = node;
      while (current instanceof HTMLElement) {
        const style = window.getComputedStyle?.(current);
        if (
          current.hidden ||
          current.getAttribute?.('aria-hidden') === 'true' ||
          style?.display === 'none' ||
          style?.visibility === 'hidden' ||
          style?.visibility === 'collapse' ||
          Number.parseFloat(style?.opacity || '1') === 0
        ) return false;
        current = current.parentElement;
      }
      return true;
    };
    const enabled = (node) => {
      if (!(node instanceof HTMLElement)) return false;
      if (node instanceof HTMLButtonElement && node.disabled) return false;
      return node.getAttribute('aria-disabled') !== 'true';
    };
    const candidates = Array.from(new Set(inputSelectors.flatMap((selector) =>
      Array.from(document.querySelectorAll(selector)),
    )));
    const focused = document.activeElement;
    const boundEditors = sendBindingToken
      ? candidates.filter(
          (node) => node?.getAttribute?.('data-oracle-send-editor-binding') === sendBindingToken,
        )
      : [];
    const focusedCandidates = candidates.filter(
      (node) => visible(node) && Boolean(focused && (node === focused || node.contains?.(focused))),
    );
    const active = sendBindingToken
      ? (boundEditors.length === 1 ? boundEditors[0] : null)
      : (focusedCandidates.length === 1 ? focusedCandidates[0] : null);
    const boundComposers = sendBindingToken
      ? Array.from(document.querySelectorAll('[data-oracle-send-composer-binding]')).filter(
          (node) => node?.getAttribute?.('data-oracle-send-composer-binding') === sendBindingToken,
        )
      : [];
    const boundComposer = sendBindingToken
      ? (boundComposers.length === 1 ? boundComposers[0] : null)
      : (active?.closest?.('[data-testid*="composer"]') ?? active?.closest?.('form') ?? null);
    const scope = boundComposer;
    const sendCandidates = boundComposer
      ? sendSelectors.flatMap((selector) =>
          Array.from(boundComposer.querySelectorAll(selector)),
        )
      : [];
    const boundSendTarget = sendBindingToken
      ? sendCandidates.find(
          (node) =>
            node instanceof HTMLElement &&
            node.getAttribute('data-oracle-send-binding') === sendBindingToken,
        ) ?? null
      : null;
    const sendBindingMatches = sendBindingToken
      ? Boolean(
          active &&
          boundComposer &&
          boundComposer.contains(active) &&
          boundSendTarget &&
          boundComposer.contains(boundSendTarget)
        )
      : null;
    const sendTarget = sendBindingToken ? boundSendTarget : null;
    let sendTargetReady = sendBindingToken ? false : null;
    let sendX = null;
    let sendY = null;
    if (sendTarget && visible(sendTarget) && enabled(sendTarget)) {
      sendTarget.scrollIntoView({ block: 'center', inline: 'center' });
      const rect = sendTarget.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      const hit = document.elementFromPoint(x, y);
      if (hit === sendTarget || (hit instanceof Node && sendTarget.contains(hit))) {
        sendTargetReady = true;
        sendX = x;
        sendY = y;
      }
    }
    const fileInputs = scope ? Array.from(scope.querySelectorAll('input[type="file"]')) : [];
    const inputFileCount = fileInputs.reduce((count, node) => {
      return count + (node instanceof HTMLInputElement ? Array.from(node.files || []).length : 0);
    }, 0);
    const stateSelector = [
      '[role="group"][aria-label]',
      '[data-testid*="attachment"]',
      '[data-testid*="upload"]',
      '[data-testid*="file"]',
      '[data-testid*="chip"]',
      '[aria-label*="Remove file"]',
      '[aria-label*="remove file"]',
      '[data-testid*="remove-attachment"]',
      '[data-testid*="attachment-remove"]',
      '[aria-busy="true"]',
      '[data-state="loading"]',
      '[data-state="uploading"]',
      '[data-state="pending"]',
    ].join(',');
    const residualAttachmentKinds = [];
    const seen = new Set();
    for (const node of scope ? Array.from(scope.querySelectorAll(stateSelector)) : []) {
      if (!(node instanceof HTMLElement) || seen.has(node)) continue;
      seen.add(node);
      if (node instanceof HTMLInputElement && node.type === 'file') continue;
      const testid = (node.getAttribute('data-testid') ?? '').toLowerCase();
      const aria = (node.getAttribute('aria-label') ?? '').toLowerCase();
      const state = (node.getAttribute('data-state') ?? '').toLowerCase();
      const busy = node.getAttribute('aria-busy') === 'true';
      const text = (node.textContent ?? '').trim();
      const removeControl =
        /remove[-_ ]?(?:file|attachment)/.test(testid + ' ' + aria) ||
        Boolean(node.querySelector('[aria-label*="Remove file"],[aria-label*="remove file"],[data-testid*="remove-attachment"],[data-testid*="attachment-remove"]'));
      const uploadState = busy || ['loading', 'uploading', 'pending'].includes(state) ||
        /\b(?:uploading|processing)\b/i.test(text);
      if (!visible(node) && !uploadState) continue;
      const isGenericControl = node.matches('button,[role="button"]') && !removeControl && !uploadState;
      if (isGenericControl) continue;
      const attachmentState =
        node.matches('[role="group"][aria-label]') ||
        removeControl ||
        uploadState ||
        testid.includes('attachment') ||
        testid.includes('chip') ||
        ((testid.includes('upload') || testid.includes('file')) && text.length > 0);
      if (!attachmentState) continue;
      residualAttachmentKinds.push(testid || aria || state || node.tagName.toLowerCase());
    }
    const activeVisible = Boolean(active && visible(active));
    const activeFocused = Boolean(active && (active === focused || active.contains?.(focused)));
    const observed = active ? readValue(active) : '';
    let attachmentExpectationSatisfied = false;
    try {
      attachmentExpectationSatisfied = (${exactAttachmentStateExpression}) === true;
    } catch {}
    return {
      activeVisible,
      activeFocused,
      promptMatches:
        activeVisible &&
        activeFocused &&
        normalizeRenderedPromptDomIdentity(observed) ===
          normalizeRenderedPromptDomIdentity(expected),
      observedLength: observed.length,
      inputFileCount,
      residualAttachmentCount: residualAttachmentKinds.length,
      residualAttachmentKinds: residualAttachmentKinds.slice(0, 8),
      attachmentExpectationSatisfied,
      sendBindingMatches,
      sendTargetReady,
      sendX,
      sendY,
    };
  })()`;
}

function assertExactComposerPreDispatchProof(
  value: unknown,
  promptLength: number,
  options: { requireBoundSendTarget?: boolean } = {},
): ExactComposerPreDispatchProof {
  const proof =
    value && typeof value === "object" ? (value as ExactComposerPreDispatchProof) : undefined;
  if (
    proof?.activeVisible !== true ||
    proof.activeFocused !== true ||
    proof.promptMatches !== true
  ) {
    throw new BrowserAutomationError(
      "Inline attachment fallback changed after its initial round-trip proof; refusing to dispatch.",
      {
        stage: "submit-prompt",
        code: "prompt-inline-fallback-mismatch",
        retryable: true,
        promptLength,
        observedLength: proof?.observedLength ?? null,
        activeVisible: proof?.activeVisible ?? false,
        activeFocused: proof?.activeFocused ?? false,
      },
    );
  }
  const inputFileCount = proof.inputFileCount ?? 0;
  const residualAttachmentCount = proof.residualAttachmentCount ?? 0;
  if (proof.attachmentExpectationSatisfied !== true) {
    throw new BrowserAutomationError(
      "Exact fallback attachment state no longer matches the verified submission; refusing to dispatch.",
      {
        stage: "submit-prompt",
        code: "prompt-inline-fallback-residual-attachment",
        retryable: true,
        inputFileCount,
        residualAttachmentCount,
        residualAttachmentKinds: proof.residualAttachmentKinds ?? [],
      },
    );
  }
  if (
    options.requireBoundSendTarget &&
    (proof.sendBindingMatches !== true ||
      proof.sendTargetReady !== true ||
      typeof proof.sendX !== "number" ||
      typeof proof.sendY !== "number")
  ) {
    throw new BrowserAutomationError(
      "Exact fallback prompt and trusted send target no longer share the same focused composer; refusing to dispatch.",
      {
        stage: "submit-prompt",
        code: "prompt-inline-fallback-send-binding-mismatch",
        retryable: true,
        sendBindingMatches: proof.sendBindingMatches ?? null,
        sendTargetReady: proof.sendTargetReady ?? null,
      },
    );
  }
  return proof;
}

async function attemptSendButton(
  Runtime: ChromeClient["Runtime"],
  Input: ChromeClient["Input"],
  logger?: BrowserLogger,
  attachmentNames?: AttachmentReadyInput[],
  attachmentTimeoutMs?: number | null,
  attachmentBindingToken?: string,
  beforeDispatch?: BeforePromptSubmit,
  onDispatchAttempt?: () => Promise<void> | void,
  exactPrompt?: string,
): Promise<boolean> {
  const needAttachment = Array.isArray(attachmentNames) && attachmentNames.length > 0;
  if (needAttachment && !attachmentBindingToken) {
    throw new BrowserAutomationError(
      "Attachment submission is missing its active-composer binding; refusing to dispatch.",
      {
        stage: "submit-prompt",
        code: "attachment-composer-binding-missing",
        attachmentCount: attachmentNames.length,
      },
    );
  }
  const sendBindingToken = beforeDispatch || exactPrompt !== undefined ? randomUUID() : undefined;
  let dispatchAttemptReported = false;
  const reportDispatchAttempt = async (): Promise<void> => {
    if (dispatchAttemptReported) return;
    dispatchAttemptReported = true;
    await onDispatchAttempt?.();
    // The remote worker consumes this exact marker as its durable
    // submittedAt boundary. It deliberately precedes the first potentially
    // irreversible mouse/key event so a lost CDP response is never exposed as
    // retryable-before-submit.
    logger?.(SUBMIT_DISPATCH_STARTED_LOG);
  };
  const script = buildSendButtonTargetExpression(
    attachmentBindingToken,
    sendBindingToken,
    Boolean(sendBindingToken),
  );
  const postPreflightScript = buildSendButtonTargetExpression(
    attachmentBindingToken,
    sendBindingToken,
    false,
  );
  const exactComposerExpression =
    typeof exactPrompt === "string"
      ? buildExactComposerPreDispatchExpression(
          exactPrompt,
          sendBindingToken,
          attachmentNames ?? [],
        )
      : undefined;

  // Give attachment-bearing submissions more headroom. ChatGPT's chip render can
  // settle slowly for multi-file uploads, but plain text sends should keep the
  // shorter historical deadline.
  const timeoutMs = sendButtonTimeoutMs(attachmentNames, attachmentTimeoutMs);
  const deadline = Date.now() + timeoutMs;
  let lastTargetDiagnostic: { status?: string; reason?: string } | null = null;
  while (Date.now() < deadline) {
    if (needAttachment) {
      const ready = await Runtime.evaluate({
        expression: buildAttachmentReadyExpression(attachmentNames, attachmentBindingToken),
        returnByValue: true,
      });
      if (!ready?.result?.value) {
        await delay(150);
        continue;
      }
    }
    const { result } = await Runtime.evaluate({ expression: script, returnByValue: true });
    const value = result.value as
      | {
          status?: "binding-missing" | "blocked" | "clicked" | "missing" | "point";
          reason?: string;
          x?: number;
          y?: number;
        }
      | string
      | undefined;
    const status = typeof value === "string" ? value : value?.status;
    if (value && typeof value === "object") {
      lastTargetDiagnostic = { status: value.status, reason: value.reason };
    }
    if (
      status === "point" &&
      typeof value === "object" &&
      typeof value.x === "number" &&
      typeof value.y === "number"
    ) {
      let finalDomGuard: FinalPreDispatchDomGuard | void = undefined;
      let armedGuard: ArmedFinalDispatchGuard | undefined;
      let primaryError: unknown;
      let pageVerdict: unknown | undefined;
      let cleanupError: unknown | undefined;
      let pressStarted = false;
      let dispatched = false;
      try {
        if (beforeDispatch) {
          // Run account + protected-route proof only after attachments and an
          // exact hit-tested send target are ready. Then require the same marked
          // DOM button/controller to survive that asynchronous proof.
          finalDomGuard = await beforeDispatch(
            sendBindingToken,
            typeof exactPrompt === "string"
              ? {
                  prompt: exactPrompt,
                  attachments: (attachmentNames ?? []).map((attachment) =>
                    typeof attachment === "string" ? { name: attachment } : attachment,
                  ),
                }
              : undefined,
          );
          if (finalDomGuard) armedGuard = await armFinalDispatchGuard(Runtime, finalDomGuard);
          if (needAttachment) {
            const ready = await Runtime.evaluate({
              expression: buildAttachmentReadyExpression(attachmentNames, attachmentBindingToken),
              returnByValue: true,
            });
            if (!ready?.result?.value) {
              throw new BrowserAutomationError(
                "Attachment state changed after protected preflight; refusing to dispatch.",
                {
                  stage: "submit-prompt",
                  code: "attachment-state-changed-after-preflight",
                },
              );
            }
          }
        }
        if (beforeDispatch || exactComposerExpression) {
          const finalExpression = `(() => ({
            sendTarget: (${postPreflightScript}),
            ${finalDomGuard ? `routeProof: (${finalDomGuard.expression}),` : ""}
            ${exactComposerExpression ? `composerProof: (${exactComposerExpression}),` : ""}
          }))()`;
          const verified = await Runtime.evaluate({
            expression: finalExpression,
            returnByValue: true,
          });
          const finalValue = verified.result?.value as
            | { sendTarget?: unknown; routeProof?: unknown; composerProof?: unknown }
            | undefined;
          const verifiedValue = finalValue?.sendTarget as
            | { status?: string; reason?: string; x?: number; y?: number }
            | undefined;
          finalDomGuard?.assertResult(finalValue?.routeProof);
          let exactComposerProof: ExactComposerPreDispatchProof | undefined;
          if (exactComposerExpression) {
            exactComposerProof = assertExactComposerPreDispatchProof(
              finalValue?.composerProof,
              exactPrompt?.length ?? 0,
              { requireBoundSendTarget: true },
            );
          }
          if (
            verifiedValue?.status !== "point" ||
            typeof verifiedValue.x !== "number" ||
            typeof verifiedValue.y !== "number"
          ) {
            throw new BrowserAutomationError(
              "Send target changed after protected preflight; refusing to dispatch.",
              {
                stage: "submit-prompt",
                code: "send-target-changed-after-preflight",
                sendTargetStatus: verifiedValue?.status ?? null,
                sendTargetReason: verifiedValue?.reason ?? null,
              },
            );
          }
          value.x = verifiedValue.x;
          value.y = verifiedValue.y;
          if (
            exactComposerProof &&
            typeof exactComposerProof.sendX === "number" &&
            typeof exactComposerProof.sendY === "number"
          ) {
            // These coordinates were derived from the bound button inside the
            // exact focused composer, not merely from a sibling send resolver.
            value.x = exactComposerProof.sendX;
            value.y = exactComposerProof.sendY;
          }
        }

        if (finalDomGuard || exactComposerExpression) {
          if (!Input || typeof Input.dispatchMouseEvent !== "function") {
            throw new BrowserAutomationError(
              "Protected dispatch requires trusted CDP mouse input; refusing DOM click fallback.",
              {
                stage: "submit-prompt",
                code: "protected-trusted-input-unavailable",
                retryable: false,
              },
            );
          }
          const assertGuardImmediatelyBeforeInput = async (): Promise<void> => {
            if (
              !finalDomGuard?.immediatelyBeforeDispatchExpression ||
              !finalDomGuard.assertImmediatelyBeforeDispatchResult
            ) {
              return;
            }
            const outcome = await Runtime.evaluate({
              expression: finalDomGuard.immediatelyBeforeDispatchExpression,
              returnByValue: true,
            });
            finalDomGuard.assertImmediatelyBeforeDispatchResult(outcome.result?.value);
          };
          await assertGuardImmediatelyBeforeInput();
          await Input.dispatchMouseEvent({ type: "mouseMoved", x: value.x, y: value.y });
          await assertGuardImmediatelyBeforeInput();
          await reportDispatchAttempt();
          await assertGuardImmediatelyBeforeInput();
          // The browser might process mousePressed even if the CDP response is
          // lost. From this line onward, only a terminal blocked verdict proves
          // that the application could not observe a submission-capable event.
          pressStarted = true;
          await Input.dispatchMouseEvent({
            type: "mousePressed",
            x: value.x,
            y: value.y,
            button: "left",
            clickCount: 1,
          });
          await Input.dispatchMouseEvent({
            type: "mouseReleased",
            x: value.x,
            y: value.y,
            button: "left",
            clickCount: 1,
          });
          dispatched = true;
        } else {
          await reportDispatchAttempt();
          dispatched = await clickTrustedPoint(Runtime, Input, value.x, value.y);
        }
      } catch (error) {
        primaryError = error;
      } finally {
        if (sendBindingToken) {
          const cleanup = await cleanupFinalDispatchGuard(
            Runtime,
            finalDomGuard,
            armedGuard,
            sendBindingToken,
          );
          pageVerdict = cleanup.pageVerdict;
          cleanupError = cleanup.cleanupError;
        }
      }

      const terminalVerdict = finalDomGuard
        ? reconcileDispatchGuardVerdicts(armedGuard?.terminalVerdict, pageVerdict)
        : undefined;
      let verdictError: unknown;
      if (finalDomGuard && (pressStarted || dispatched || primaryError === undefined)) {
        try {
          finalDomGuard.assertAfterDispatchResult?.(terminalVerdict);
        } catch (error) {
          verdictError = error;
        }
      }
      const definitelyBlocked = Boolean(
        verdictError && finalDomGuard?.isDispatchDefinitelyBlocked?.(terminalVerdict),
      );

      if (primaryError !== undefined) {
        if (definitelyBlocked && verdictError !== undefined) throw verdictError;
        throw primaryError;
      }
      if (!dispatched) {
        throw new BrowserAutomationError(
          "Send target disappeared before dispatch; refusing to report a click.",
          { stage: "submit-prompt", code: "send-target-disappeared-before-dispatch" },
        );
      }
      if (verdictError !== undefined) {
        throw verdictError;
      }
      if (cleanupError !== undefined && !finalDomGuard && logger?.verbose) {
        logger("Send binding cleanup could not be confirmed after dispatch.");
      }
      return true;
    }
    if (status === "clicked" && !beforeDispatch) {
      await reportDispatchAttempt();
      return true;
    }
    if ((status === "missing" || status === "binding-missing") && !needAttachment) {
      break;
    }
    await delay(100);
  }
  if (Array.isArray(attachmentNames) && attachmentNames.length > 0) {
    throw new BrowserAutomationError(
      `Attachments never reached a clickable send button after ${Math.ceil(
        timeoutMs / 1000,
      )}s; tune --browser-attachment-timeout.`,
      {
        stage: "submit-prompt",
        code: "attachment-send-not-ready",
        attachmentNames,
        timeoutMs,
        sendTargetStatus: lastTargetDiagnostic?.status ?? null,
        sendTargetReason: lastTargetDiagnostic?.reason ?? null,
      },
    );
  }
  if (logger?.verbose && lastTargetDiagnostic) {
    logger(`Send target unavailable: ${JSON.stringify(lastTargetDiagnostic)}`);
  }
  return false;
}

async function clickTrustedPoint(
  Runtime: ChromeClient["Runtime"],
  Input: ChromeClient["Input"],
  x: number,
  y: number,
): Promise<boolean> {
  if (Input && typeof Input.dispatchMouseEvent === "function") {
    await Input.dispatchMouseEvent({ type: "mouseMoved", x, y });
    await Input.dispatchMouseEvent({ type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await Input.dispatchMouseEvent({ type: "mouseReleased", x, y, button: "left", clickCount: 1 });
    return true;
  }
  const outcome = await Runtime.evaluate({
    expression: `(() => {
      const el = document.elementFromPoint(${JSON.stringify(x)}, ${JSON.stringify(y)});
      if (!(el instanceof HTMLElement)) return false;
      el.click();
      return true;
    })()`,
    returnByValue: true,
  });
  return outcome.result?.value === true;
}

function sendButtonTimeoutMs(
  attachmentNames?: AttachmentReadyInput[],
  attachmentTimeoutMs?: number | null,
): number {
  if (!Array.isArray(attachmentNames) || attachmentNames.length === 0) {
    return 20_000;
  }
  return typeof attachmentTimeoutMs === "number" && Number.isFinite(attachmentTimeoutMs)
    ? Math.max(1_000, attachmentTimeoutMs)
    : 45_000;
}

async function verifyPromptCommitted(
  Runtime: ChromeClient["Runtime"],
  prompt: string,
  timeoutMs: number,
  logger?: BrowserLogger,
  baselineTurns?: number,
  attachmentNames: string[] = [],
): Promise<number | null> {
  const deadline = Date.now() + timeoutMs;
  const encodedPrompt = JSON.stringify(prompt.trim());
  const primarySelectorLiteral = JSON.stringify(PROMPT_PRIMARY_SELECTOR);
  const fallbackSelectorLiteral = JSON.stringify(PROMPT_FALLBACK_SELECTOR);
  const inputSelectorsLiteral = JSON.stringify(INPUT_SELECTORS);
  const stopSelectorLiteral = JSON.stringify(STOP_BUTTON_SELECTOR);
  const assistantSelectorLiteral = JSON.stringify(ASSISTANT_ROLE_SELECTOR);
  const baseline: number | null =
    typeof baselineTurns === "number" && Number.isFinite(baselineTurns) && baselineTurns >= 0
      ? Math.floor(baselineTurns)
      : null;
  const baselineLiteral = baseline ?? -1;
  const attachmentNamesLiteral = JSON.stringify(attachmentNames);
  // The only trustworthy baseline is the one captured before dispatch by the
  // caller. Reading it here would happen after dispatch and could misclassify
  // an already-present identical turn as this submission.
  // Learned: ChatGPT can render Markdown differently; compare the complete
  // normalized prompt instead of a lossy prefix.
  const script = `(() => {
		    const editor = document.querySelector(${primarySelectorLiteral});
		    const fallback = document.querySelector(${fallbackSelectorLiteral});
		    const inputSelectors = ${inputSelectorsLiteral};
	    ${PROMPT_DOM_NORMALIZER_DECLARATION}
	    ${PROMPT_DOM_IDENTITY_NORMALIZER_DECLARATION}
	    ${PROMPT_DOM_EXACT_MATCH_DECLARATION}
	    const submittedPrompt = ${encodedPrompt};
	    const expectedAttachmentNames = ${attachmentNamesLiteral};
	    const articles = ${buildConversationTurnListExpression()};
	    const normalizedTurnEntries = articles.map((node) => {
	      const role = String(
	        node?.getAttribute?.('data-message-author-role') ||
	        node?.getAttribute?.('data-turn') ||
	        node?.dataset?.turn ||
	        '',
	      ).toLowerCase();
	      const isUser =
	        role === 'user' ||
	        Boolean(node?.querySelector?.('[data-message-author-role="user"], [data-turn="user"]'));
	      const promptContentCandidates = isUser
	        ? readRenderedPromptDomContentCandidates(node)
	        : [];
	      const matchesPrompt = promptContentCandidates.some((candidate) =>
	        renderedPromptCandidateMatchesSubmission(
	          candidate.text,
	          submittedPrompt,
	          expectedAttachmentNames,
	        ),
	      );
	      return {
	        isUser,
	        matchesPrompt,
	        text: normalizePromptForDomMatch(node?.innerText || node?.textContent || ''),
	      };
	    });
	    const normalizedTurns = normalizedTurnEntries.map((entry) => entry.text);
	    const readValue = (node) => {
	      if (!node) return '';
	      if (node instanceof HTMLTextAreaElement) return node.value ?? '';
	      return node.innerText ?? '';
	    };
	    const isVisible = (node) => {
	      if (!node || typeof node.getBoundingClientRect !== 'function') return false;
	      const rect = node.getBoundingClientRect();
	      return rect.width > 0 && rect.height > 0;
	    };
		    const inputs = inputSelectors.flatMap((selector) =>
		      Array.from(document.querySelectorAll(selector)),
		    );
	    const visibleInputs = inputs.filter((node) => isVisible(node));
		    const activeInputs = visibleInputs.length > 0 ? visibleInputs : inputs;
	    const userMatched = normalizedTurnEntries.some(
	      (entry) => entry.isUser && entry.matchesPrompt,
	    );
		    let lastUserTurnIndex = -1;
		    for (let index = normalizedTurnEntries.length - 1; index >= 0; index -= 1) {
		      if (normalizedTurnEntries[index]?.isUser) {
		        lastUserTurnIndex = index;
		        break;
		      }
		    }
	    const lastMatched =
	      lastUserTurnIndex >= 0 &&
	      normalizedTurnEntries[lastUserTurnIndex]?.matchesPrompt === true;
		    const lastTurn = normalizedTurns[normalizedTurns.length - 1] ?? '';
		    const baseline = ${baselineLiteral};
		    const hasNewTurn = baseline < 0 ? false : normalizedTurns.length > baseline;
		    const hasNewUserTurn = baseline < 0 ? false : lastUserTurnIndex >= baseline;
		    const stopVisible = Boolean(document.querySelector(${stopSelectorLiteral}));
		    const assistantVisible = Boolean(
		      document.querySelector(${assistantSelectorLiteral}) ||
		      document.querySelector('[data-testid*="assistant"]'),
		    );
	    // Keep surrounding UI state for diagnostics, never as commit proof.
      const editorValue = editor?.innerText ?? '';
      const fallbackValue = fallback?.value ?? '';
      const activeEmpty =
        activeInputs.length === 0 ? null : activeInputs.every((node) => !String(readValue(node)).trim());
      const composerCleared = activeEmpty ?? !(String(editorValue).trim() || String(fallbackValue).trim());
      const href = typeof location === 'object' && location.href ? location.href : '';
      const inConversation = /\\/c\\//.test(href);
		    return {
        baseline,
	      userMatched,
	      lastMatched,
	      hasNewTurn,
	      hasNewUserTurn,
	      lastUserTurnIndex,
	      stopVisible,
      assistantVisible,
      composerCleared,
      inConversation,
      href,
      fallbackValue,
      editorValue,
      lastTurn,
      turnsCount: normalizedTurns.length,
    };
  })()`;

  let lastProbe: CommitProbeState | undefined;
  while (Date.now() < deadline) {
    const { result } = await Runtime.evaluate({ expression: script, returnByValue: true });
    const info = result.value as CommitProbeState | undefined;
    if (info && typeof info === "object") {
      lastProbe = info;
    }
    const turnsCount = (result.value as { turnsCount?: number } | undefined)?.turnsCount;
    // Commit proof requires both a structurally fresh user turn and ownership
    // by the complete submitted prompt. Composer clearing, stop/assistant UI,
    // and conversation navigation are useful diagnostics but never ownership
    // evidence: each can belong to another submission or an older turn.
    if (info?.hasNewUserTurn && info?.lastMatched) {
      return typeof turnsCount === "number" && Number.isFinite(turnsCount) ? turnsCount : null;
    }
    await delay(100);
  }
  const finalProbe = await Runtime.evaluate({ expression: script, returnByValue: true })
    .then((res) => res?.result?.value as CommitProbeState | undefined)
    .catch(() => undefined);
  const probe = finalProbe && typeof finalProbe === "object" ? finalProbe : lastProbe;
  if (logger) {
    logger(
      `Prompt commit check failed; latest state: ${probe ? JSON.stringify(probe) : "unavailable"}`,
    );
    await logDomFailure(Runtime, logger, "prompt-commit");
  }
  // This probe runs only after the send click/key event. Even when a large
  // prompt is the likely cause, the dispatch outcome is ambiguous: ChatGPT may
  // have accepted the prompt without exposing the user turn yet. Keep this in
  // the non-retryable commit-timeout class so runSubmissionWithRecovery cannot
  // clear the composer and submit an upload fallback on top of a landed turn.
  // The composer-truncation check above is the only safe, pre-dispatch source
  // of `prompt-too-large`.
  throw new BrowserAutomationError(
    "Prompt did not appear in conversation before timeout (send may have failed)",
    {
      stage: "submit-prompt",
      code: "prompt-commit-timeout",
      promptLength: prompt.trim().length,
      timeoutMs,
      retryable: false,
      commitProbe: probe ? summarizeCommitProbe(probe) : undefined,
    },
  );
}

interface CommitProbeState {
  baseline?: number;
  userMatched?: boolean;
  lastMatched?: boolean;
  hasNewTurn?: boolean;
  hasNewUserTurn?: boolean;
  lastUserTurnIndex?: number;
  stopVisible?: boolean;
  assistantVisible?: boolean;
  composerCleared?: boolean;
  inConversation?: boolean;
  turnsCount?: number;
  href?: string;
  editorValue?: string;
  fallbackValue?: string;
  lastTurn?: string;
}

// Keep booleans/counts but replace free text with lengths so session metadata stays lean.
function summarizeCommitProbe(probe: CommitProbeState): Record<string, unknown> {
  return {
    baseline: probe.baseline,
    turnsCount: probe.turnsCount,
    userMatched: probe.userMatched,
    lastMatched: probe.lastMatched,
    hasNewTurn: probe.hasNewTurn,
    hasNewUserTurn: probe.hasNewUserTurn,
    lastUserTurnIndex: probe.lastUserTurnIndex,
    stopVisible: probe.stopVisible,
    assistantVisible: probe.assistantVisible,
    composerCleared: probe.composerCleared,
    inConversation: probe.inConversation,
    editorLength: typeof probe.editorValue === "string" ? probe.editorValue.length : undefined,
    lastTurnLength: typeof probe.lastTurn === "string" ? probe.lastTurn.length : undefined,
  };
}

// biome-ignore lint/style/useNamingConvention: test-only export used in vitest suite
export const __test__ = {
  attemptSendButton,
  buildExactComposerPreDispatchExpression,
  assertExactComposerPreDispatchProof,
  sendButtonTimeoutMs,
  verifyPromptCommitted,
};

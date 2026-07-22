// Structural capture binding.
//
// Cross-talk / stale-tab capture is the sharpest wrong-answer class when
// several runs share a browser profile: a capture that merely grabs "the
// latest assistant message" can archive an answer that belongs to a different
// run, a pre-existing conversation, or a preamble from an older turn.
//
// This module binds every capture to THIS run's own submitted user message:
//
// 1. At submit time (`registerSubmittedUserMessage`, called from
//    `submitPrompt` once the prompt is verified committed) we take a handle to
//    the user turn that carries the submitted prompt — its `data-message-id`,
//    its turn `data-testid`, the surrounding conversation id, and a sha256 of
//    the submitted prompt for provenance.
// 2. At capture time (`assertCapturedAssistantResponseBound`, called from the
//    `pageActions` capture facade) we re-probe the live DOM and fail loudly
//    unless the captured assistant message still sits in the same
//    conversation, after that exact user message, with no foreign user turn
//    interleaved.
//
// Sentinel prompt wrapping is deliberately NOT used here: injected sentinels
// pollute exact-output/code/diff tasks and can be echoed by a wrong answer.
// Structural DOM binding is the primary defense; sentinels stay an opt-in
// concern of canary/smoke prompts.

import { createHash } from "node:crypto";
import type { BrowserLogger, ChromeClient } from "../types.js";
import { CONVERSATION_TURN_SELECTOR } from "../constants.js";
import { delay } from "../utils.js";
import { BrowserAutomationError } from "../../oracle/errors.js";
import {
  buildConversationIdFromHrefExpression,
  buildIsProvisionalChatGptConversationHrefExpression,
  isConversationUrl as isStableConversationUrl,
  normalizeChatGptConversationId,
} from "../conversationIdentity.js";

export type SubmittedMessageBindingQuality = "message-handle" | "guessed" | "conversation-only";

export interface SubmittedUserMessageBinding {
  /** sha256 (hex) of the exact prompt text handed to the composer. */
  promptSha256: string;
  promptLength: number;
  /** Normalized prompt prefix used to re-identify the user turn in the DOM. */
  promptPrefix: string;
  registeredAtMs: number;
  /**
   * "message-handle" when the submitted user turn was structurally located by
   * matching the submitted prompt text; "guessed" when a user turn was found
   * but did NOT match the submitted prompt (the probe fell back to the latest
   * user turn — the handle may belong to another message, so capture
   * validation treats it at conversation-only strength); "conversation-only"
   * when only conversation-level binding is available. Non-"message-handle"
   * bindings are correspondingly weaker but still fail loud on
   * conversation/target changes.
   */
  quality: SubmittedMessageBindingQuality;
  conversationId: string | null;
  userMessageId: string | null;
  userTurnTestId: string | null;
}

export interface CapturedAssistantMeta {
  messageId?: string | null;
  turnId?: string | null;
}

/** Raw facts probed from the live DOM immediately after a capture. */
export interface CaptureBindingFacts {
  conversationId: string | null;
  userTurnFound: boolean;
  userTurnIsLatestUserTurn: boolean;
  capturedNodeFound: boolean;
  capturedFollowsUserMessage: boolean;
  interveningAssistantTurns: number;
  assistantTurnAfterUserMessage: boolean;
}

export interface CaptureBindingVerdict {
  ok: boolean;
  code?: string;
  detail?: string;
  warnings: string[];
}

// Keyed by the CDP Runtime object: submit and capture share the same Runtime
// instance for the lifetime of a run, and a WeakMap keeps bindings from
// leaking across unrelated Chrome clients or outliving the connection.
const bindingsByRuntime = new WeakMap<object, SubmittedUserMessageBinding>();

export function computePromptSha256(prompt: string): string {
  return createHash("sha256").update(prompt, "utf8").digest("hex");
}

/**
 * Mirrors the DOM-side normalization used by the submit-commit check: ChatGPT
 * re-renders markdown, so fence markers are stripped (content kept) before
 * whitespace collapsing.
 */
export function normalizePromptForDomMatch(value: string): string {
  let text = value.toLowerCase();
  text = text.replace(/```[^\n]*\n([\s\S]*?)```/g, " $1 ");
  text = text.replace(/```/g, " ");
  text = text.replace(/`([^`]*)`/g, "$1");
  return text.replace(/\s+/g, " ").trim();
}

export function isConversationUrl(url: string): boolean {
  return isStableConversationUrl(url);
}

const NORMALIZE_JS = `const normalize = (value) => {
      let text = String(value || '').toLowerCase();
      text = text.replace(/\`\`\`[^\\n]*\\n([\\s\\S]*?)\`\`\`/g, ' $1 ');
      text = text.replace(/\`\`\`/g, ' ');
      text = text.replace(/\`([^\`]*)\`/g, '$1');
      return text.replace(/\\s+/g, ' ').trim();
    };`;

const TURN_HELPERS_JS = `const isUserTurn = (node) => {
      if (!(node instanceof HTMLElement)) return false;
      const turnAttr = (node.getAttribute('data-turn') || '').toLowerCase();
      if (turnAttr === 'user') return true;
      const role = (node.getAttribute('data-message-author-role') || '').toLowerCase();
      if (role === 'user') return true;
      return Boolean(node.querySelector('[data-message-author-role="user"], [data-turn="user"]'));
    };
    const isAssistantTurn = (node) => {
      if (!(node instanceof HTMLElement)) return false;
      const turnAttr = (node.getAttribute('data-turn') || '').toLowerCase();
      if (turnAttr === 'assistant') return true;
      const role = (node.getAttribute('data-message-author-role') || '').toLowerCase();
      if (role === 'assistant') return true;
      const testId = (node.getAttribute('data-testid') || '').toLowerCase();
      if (testId.includes('assistant')) return true;
      return Boolean(node.querySelector('[data-message-author-role="assistant"], [data-turn="assistant"], [data-testid*="assistant"]'));
    };`;

function buildSubmittedUserMessageProbeExpression(prompt: string): string {
  const conversationLiteral = JSON.stringify(CONVERSATION_TURN_SELECTOR);
  const promptLiteral = JSON.stringify(prompt);
  const conversationIdExpression = buildConversationIdFromHrefExpression("href");
  return `(() => {
    const CONVERSATION_SELECTOR = ${conversationLiteral};
    ${NORMALIZE_JS}
    ${TURN_HELPERS_JS}
    const href = typeof location === 'object' && location.href ? location.href : '';
    const conversationId = ${conversationIdExpression};
    const normalizedPrompt = normalize(${promptLiteral});
    const promptPrefix = normalizedPrompt.slice(0, 120);
    const turns = Array.from(document.querySelectorAll(CONVERSATION_SELECTOR));
    // Nested turn wrappers duplicate matches; bind against outermost turns.
    const topLevelTurns = turns.filter(
      (turn) => !(turn.parentElement && turn.parentElement.closest(CONVERSATION_SELECTOR)),
    );
    const userTurns = topLevelTurns.filter(isUserTurn);
    let target = null;
    let matchedPrompt = false;
    for (let index = userTurns.length - 1; index >= 0; index -= 1) {
      const turn = userTurns[index];
      const text = normalize(turn.innerText || turn.textContent || '');
      const matches =
        normalizedPrompt.length > 0 &&
        (text.includes(normalizedPrompt) || (promptPrefix.length > 30 && text.includes(promptPrefix)));
      if (matches) {
        target = turn;
        matchedPrompt = true;
        break;
      }
    }
    if (!target && userTurns.length > 0) {
      target = userTurns[userTurns.length - 1];
    }
    if (!target) {
      return { found: false, matchedPrompt: false, conversationId, userMessageId: null, userTurnTestId: null };
    }
    const messageNode = target.matches('[data-message-id]')
      ? target
      : target.querySelector('[data-message-author-role="user"][data-message-id], [data-message-id]');
    return {
      found: true,
      matchedPrompt,
      conversationId,
      userMessageId: messageNode ? messageNode.getAttribute('data-message-id') : null,
      userTurnTestId: target.getAttribute('data-testid'),
    };
  })()`;
}

function buildCaptureBindingFactsExpression(
  binding: SubmittedUserMessageBinding,
  meta: CapturedAssistantMeta,
): string {
  const conversationLiteral = JSON.stringify(CONVERSATION_TURN_SELECTOR);
  const userMessageIdLiteral = JSON.stringify(binding.userMessageId ?? null);
  const userTurnTestIdLiteral = JSON.stringify(binding.userTurnTestId ?? null);
  const promptPrefixLiteral = JSON.stringify(
    binding.promptPrefix.length > 30 ? binding.promptPrefix : null,
  );
  const capturedMessageIdLiteral = JSON.stringify(meta.messageId ?? null);
  const capturedTurnIdLiteral = JSON.stringify(meta.turnId ?? null);
  const conversationIdExpression = buildConversationIdFromHrefExpression("href");
  return `(() => {
    const CONVERSATION_SELECTOR = ${conversationLiteral};
    const USER_MESSAGE_ID = ${userMessageIdLiteral};
    const USER_TURN_TESTID = ${userTurnTestIdLiteral};
    const USER_PROMPT_PREFIX = ${promptPrefixLiteral};
    const CAPTURED_MESSAGE_ID = ${capturedMessageIdLiteral};
    const CAPTURED_TURN_ID = ${capturedTurnIdLiteral};
    ${NORMALIZE_JS}
    ${TURN_HELPERS_JS}
    const esc = (value) =>
      typeof CSS !== 'undefined' && CSS && typeof CSS.escape === 'function'
        ? CSS.escape(String(value))
        : String(value).replace(/["\\\\]/g, '\\\\$&');
    const href = typeof location === 'object' && location.href ? location.href : '';
    const conversationId = ${conversationIdExpression};
    const turns = Array.from(document.querySelectorAll(CONVERSATION_SELECTOR));
    const topLevelTurns = turns.filter(
      (turn) => !(turn.parentElement && turn.parentElement.closest(CONVERSATION_SELECTOR)),
    );
    const toTopLevelTurn = (node) => {
      if (!node) return null;
      let turn = typeof node.closest === 'function' ? (node.closest(CONVERSATION_SELECTOR) || node) : node;
      while (turn) {
        const parentTurn = turn.parentElement
          ? turn.parentElement.closest(CONVERSATION_SELECTOR)
          : null;
        if (!parentTurn) break;
        turn = parentTurn;
      }
      return turn;
    };
    const follows = (anchor, node) =>
      Boolean(
        anchor &&
          node &&
          typeof anchor.compareDocumentPosition === 'function' &&
          anchor.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING,
      );
    const related = (a, b) => Boolean(a && b && (a === b || a.contains(b) || b.contains(a)));

    // Resolve THIS run's own submitted user message.
    let userTurn = null;
    if (USER_MESSAGE_ID) {
      const messageNode = document.querySelector('[data-message-id="' + esc(USER_MESSAGE_ID) + '"]');
      userTurn = messageNode ? toTopLevelTurn(messageNode) : null;
    }
    if (!userTurn && USER_TURN_TESTID) {
      const byTestId = document.querySelector('[data-testid="' + esc(USER_TURN_TESTID) + '"]');
      if (byTestId && isUserTurn(byTestId)) userTurn = toTopLevelTurn(byTestId);
    }
    if (!userTurn && USER_PROMPT_PREFIX) {
      for (let index = topLevelTurns.length - 1; index >= 0; index -= 1) {
        const turn = topLevelTurns[index];
        if (!isUserTurn(turn)) continue;
        if (normalize(turn.innerText || turn.textContent || '').includes(USER_PROMPT_PREFIX)) {
          userTurn = turn;
          break;
        }
      }
    }
    const userTurnFound = Boolean(userTurn);
    const userTurns = topLevelTurns.filter(isUserTurn);
    const lastUserTurn = userTurns.length > 0 ? userTurns[userTurns.length - 1] : null;
    const userTurnIsLatestUserTurn = Boolean(userTurn && lastUserTurn && related(userTurn, lastUserTurn));

    // Resolve the captured assistant node by the ids the extractor reported.
    let capturedNode = null;
    if (CAPTURED_MESSAGE_ID) {
      capturedNode = document.querySelector('[data-message-id="' + esc(CAPTURED_MESSAGE_ID) + '"]');
    }
    if (!capturedNode && CAPTURED_TURN_ID) {
      capturedNode = document.querySelector('[data-testid="' + esc(CAPTURED_TURN_ID) + '"]');
    }
    const capturedTurn = capturedNode ? toTopLevelTurn(capturedNode) : null;
    const capturedNodeFound = Boolean(capturedNode);
    const capturedFollowsUserMessage = Boolean(
      userTurn && capturedTurn && (related(userTurn, capturedTurn) ? false : follows(userTurn, capturedTurn)),
    );
    let interveningAssistantTurns = 0;
    if (userTurn && capturedTurn) {
      for (const turn of topLevelTurns) {
        if (!isAssistantTurn(turn)) continue;
        if (related(turn, capturedTurn) || related(turn, userTurn)) continue;
        if (follows(userTurn, turn) && follows(turn, capturedTurn)) interveningAssistantTurns += 1;
      }
    }
    const assistantTurnAfterUserMessage = Boolean(
      userTurn &&
        topLevelTurns.some(
          (turn) =>
            isAssistantTurn(turn) &&
            !related(turn, userTurn) &&
            follows(userTurn, turn) &&
            normalize(turn.innerText || turn.textContent || '').length > 0,
        ),
    );
    return {
      conversationId,
      userTurnFound,
      userTurnIsLatestUserTurn,
      capturedNodeFound,
      capturedFollowsUserMessage,
      interveningAssistantTurns,
      assistantTurnAfterUserMessage,
    };
  })()`;
}

export function buildSubmittedUserMessageProbeExpressionForTest(prompt: string): string {
  return buildSubmittedUserMessageProbeExpression(prompt);
}

export function buildCaptureBindingFactsExpressionForTest(
  binding: SubmittedUserMessageBinding,
  meta: CapturedAssistantMeta,
): string {
  return buildCaptureBindingFactsExpression(binding, meta);
}

/**
 * Take a structural handle to the user message this run just submitted.
 *
 * Called from `submitPrompt` immediately after the prompt is verified
 * committed. Never throws: the submission itself already succeeded, so a
 * probe failure degrades the binding to conversation-only (logged) rather
 * than failing the run — capture validation stays fail-loud on everything the
 * degraded binding can still prove.
 */
export async function registerSubmittedUserMessage(
  runtime: ChromeClient["Runtime"],
  prompt: string,
  logger: BrowserLogger,
): Promise<SubmittedUserMessageBinding> {
  const promptSha256 = computePromptSha256(prompt);
  const normalizedPrompt = normalizePromptForDomMatch(prompt);
  const base: SubmittedUserMessageBinding = {
    promptSha256,
    promptLength: prompt.length,
    promptPrefix: normalizedPrompt.slice(0, 120),
    registeredAtMs: Date.now(),
    quality: "conversation-only",
    conversationId: null,
    userMessageId: null,
    userTurnTestId: null,
  };
  let binding = base;
  try {
    const { result } = await runtime.evaluate({
      expression: buildSubmittedUserMessageProbeExpression(prompt),
      returnByValue: true,
    });
    const value = result?.value as
      | {
          found?: boolean;
          matchedPrompt?: boolean;
          conversationId?: string | null;
          userMessageId?: string | null;
          userTurnTestId?: string | null;
        }
      | undefined;
    if (value && typeof value === "object") {
      const conversationId = normalizeChatGptConversationId(value.conversationId) ?? null;
      if (value.found === true) {
        binding = {
          ...base,
          // A turn located by matching the submitted prompt text is a proven
          // handle. A fallback guess (latest user turn, matchedPrompt:false)
          // must NOT be recorded at full message-handle strength: the guessed
          // handle may belong to another run's message, and validating
          // against it would manufacture a cross-talk proof that was never
          // established. Keep the ids for diagnostics, downgrade the quality.
          quality: value.matchedPrompt === true ? "message-handle" : "guessed",
          conversationId,
          userMessageId: typeof value.userMessageId === "string" ? value.userMessageId : null,
          userTurnTestId: typeof value.userTurnTestId === "string" ? value.userTurnTestId : null,
        };
      } else {
        binding = { ...base, conversationId };
      }
    }
  } catch {
    // Probe unavailable; keep the conversation-only binding.
  }
  bindingsByRuntime.set(runtime as object, binding);
  logger(
    `[browser] Structural capture binding registered (${binding.quality}); submitted prompt sha256 ${promptSha256} (${prompt.length} chars)` +
      (binding.conversationId ? `; conversation ${binding.conversationId}` : ""),
  );
  if (binding.quality === "conversation-only") {
    logger(
      "[browser] Submitted user message could not be structurally located; capture validation degrades to conversation-level binding.",
    );
  } else if (binding.quality === "guessed") {
    logger(
      "[browser] Submitted user message did not match any user turn; bound to the latest user turn as a guess. Capture validation degrades to conversation-level binding.",
    );
  }
  return binding;
}

export function getSubmittedUserMessageBinding(
  runtime: ChromeClient["Runtime"],
): SubmittedUserMessageBinding | null {
  return bindingsByRuntime.get(runtime as object) ?? null;
}

/** Pure verdict over probed DOM facts — exported for unit tests. */
export function evaluateCaptureBindingFacts(
  binding: SubmittedUserMessageBinding,
  meta: CapturedAssistantMeta,
  facts: CaptureBindingFacts,
): CaptureBindingVerdict {
  const fail = (code: string, detail: string): CaptureBindingVerdict => ({
    ok: false,
    code,
    detail,
    warnings: [],
  });
  if (
    binding.conversationId &&
    facts.conversationId &&
    facts.conversationId !== binding.conversationId
  ) {
    return fail(
      "capture-binding-conversation-changed",
      `capture target moved from conversation ${binding.conversationId} to ${facts.conversationId} between submit and capture`,
    );
  }
  if (binding.conversationId && !facts.conversationId) {
    return fail(
      "capture-binding-conversation-changed",
      `capture target no longer shows bound conversation ${binding.conversationId}`,
    );
  }
  if (!binding.conversationId && binding.quality !== "message-handle") {
    return fail(
      "capture-binding-ownership-unproven",
      "the provisional submit had neither a durable conversation identity nor a structurally matched user message",
    );
  }
  const warnings: string[] = [];
  const hasCapturedIds = Boolean(meta.messageId || meta.turnId);
  if (binding.quality === "message-handle") {
    if (!facts.userTurnFound) {
      return fail(
        "capture-binding-user-message-missing",
        "this run's submitted user message is no longer present in the capture target",
      );
    }
    if (!facts.userTurnIsLatestUserTurn) {
      return fail(
        "capture-binding-user-message-superseded",
        "a user message that is not this run's own submission now follows it in the conversation (cross-talk)",
      );
    }
    if (hasCapturedIds) {
      if (!facts.capturedNodeFound) {
        return fail(
          "capture-binding-captured-node-missing",
          "the captured assistant message can no longer be located in the conversation DOM",
        );
      }
      if (!facts.capturedFollowsUserMessage) {
        return fail(
          "capture-binding-response-precedes-user-message",
          "the captured assistant message does not follow this run's own user message in document order",
        );
      }
      if (facts.interveningAssistantTurns > 0) {
        // Assistant turns strictly between our user message and the captured
        // turn, with no interleaved user turn (that would have failed the
        // superseded check above), belong to this run's own multi-part
        // response sequence (e.g. Deep Research plan + report). Warn, don't fail.
        warnings.push(
          `captured assistant message is not the first reply after the bound user message (${facts.interveningAssistantTurns} earlier assistant turn(s) in this run's own response sequence)`,
        );
      }
    } else if (!facts.assistantTurnAfterUserMessage) {
      return fail(
        "capture-binding-no-assistant-after-user-message",
        "no assistant message follows this run's own user message; the captured text came from stale prior content",
      );
    }
  } else if (hasCapturedIds && !facts.capturedNodeFound) {
    return fail(
      "capture-binding-captured-node-missing",
      "the captured assistant message can no longer be located in the conversation DOM",
    );
  }
  return { ok: true, warnings };
}

function coerceFacts(value: unknown): CaptureBindingFacts | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  return {
    conversationId: normalizeChatGptConversationId(raw.conversationId) ?? null,
    userTurnFound: raw.userTurnFound === true,
    userTurnIsLatestUserTurn: raw.userTurnIsLatestUserTurn === true,
    capturedNodeFound: raw.capturedNodeFound === true,
    capturedFollowsUserMessage: raw.capturedFollowsUserMessage === true,
    interveningAssistantTurns:
      typeof raw.interveningAssistantTurns === "number" &&
      Number.isFinite(raw.interveningAssistantTurns)
        ? raw.interveningAssistantTurns
        : 0,
    assistantTurnAfterUserMessage: raw.assistantTurnAfterUserMessage === true,
  };
}

const CAPTURE_BINDING_ATTEMPTS = 3;
const CAPTURE_BINDING_RETRY_DELAY_MS = 250;

/**
 * Verified-marker log line for a passed capture-binding validation. Full
 * message-handle bindings and the weaker fallback tiers deliberately produce
 * DIFFERENT wording so downstream log matchers (remote server provenance)
 * can distinguish full structural verification from degraded
 * conversation-level verification. Both variants keep the literal
 * "capture binding verified" so older matchers stay compatible.
 */
export function formatCaptureBindingVerifiedLog(
  quality: SubmittedMessageBindingQuality,
  promptSha256: string,
): string {
  const strength =
    quality === "message-handle" ? `(${quality})` : `at degraded strength (${quality})`;
  return `[browser] Structural capture binding verified ${strength}; prompt sha256 ${promptSha256}`;
}

/**
 * Post-capture structural validation: the captured assistant message must be
 * bound to THIS run's own submitted user message, in the same conversation
 * the prompt was submitted to. Throws a typed `BrowserAutomationError`
 * (stage "capture-binding") on violation; no-op when no binding was
 * registered for this runtime (non-ChatGPT providers, unit tests, reattach
 * inspection paths).
 */
export async function assertCapturedAssistantResponseBound(
  runtime: ChromeClient["Runtime"],
  meta: CapturedAssistantMeta,
  logger: BrowserLogger,
): Promise<CaptureBindingFacts | null> {
  const binding = bindingsByRuntime.get(runtime as object);
  if (!binding) {
    return null;
  }
  let lastVerdict: CaptureBindingVerdict = {
    ok: false,
    code: "capture-binding-verification-unavailable",
    detail: "the capture-binding DOM probe did not return verifiable facts",
    warnings: [],
  };
  for (let attempt = 0; attempt < CAPTURE_BINDING_ATTEMPTS; attempt += 1) {
    if (attempt > 0) {
      await delay(CAPTURE_BINDING_RETRY_DELAY_MS);
    }
    let facts: CaptureBindingFacts | null = null;
    try {
      const { result } = await runtime.evaluate({
        expression: buildCaptureBindingFactsExpression(binding, meta),
        returnByValue: true,
      });
      facts = coerceFacts(result?.value);
    } catch {
      facts = null;
    }
    if (!facts) {
      continue;
    }
    const verdict = evaluateCaptureBindingFacts(binding, meta, facts);
    if (verdict.ok) {
      for (const warning of verdict.warnings) {
        logger(`[browser] Capture binding warning: ${warning}`);
      }
      if (!binding.conversationId && facts.conversationId) {
        // A new chat gets its /c/<id> assigned after submit; adopt it so any
        // later capture in this run is held to the same conversation.
        binding.conversationId = facts.conversationId;
      }
      logger(formatCaptureBindingVerifiedLog(binding.quality, binding.promptSha256));
      return facts;
    }
    lastVerdict = verdict;
  }
  throw buildCaptureBindingFailureError(lastVerdict, binding);
}

/**
 * The one typed error every structural capture-binding failure surfaces as.
 * `details.stage === "capture-binding"` is the machine-readable failure
 * signal consumers (e.g. the remote server's terminal done-event provenance)
 * key on — the human-readable message is NOT a stable contract, so nothing
 * should pattern-match it. Exported so tests exercising those consumers stay
 * coupled to the exact error shape this module throws.
 */
export function buildCaptureBindingFailureError(
  verdict: CaptureBindingVerdict,
  binding: Pick<SubmittedUserMessageBinding, "quality" | "promptSha256">,
): BrowserAutomationError {
  return new BrowserAutomationError(
    `Captured assistant response failed structural binding validation: ${verdict.detail}. ` +
      "Refusing to return a response that cannot be proven to answer this run's own submitted message.",
    {
      stage: "capture-binding",
      code: verdict.code,
      bindingQuality: binding.quality,
      promptSha256: binding.promptSha256,
    },
  );
}

function buildFreshCaptureTargetProbeExpression(): string {
  const conversationLiteral = JSON.stringify(CONVERSATION_TURN_SELECTOR);
  const conversationIdExpression = buildConversationIdFromHrefExpression("href");
  const provisionalConversationExpression =
    buildIsProvisionalChatGptConversationHrefExpression("href");
  return `(() => {
    const CONVERSATION_SELECTOR = ${conversationLiteral};
    ${TURN_HELPERS_JS}
    const href = typeof location === 'object' && location.href ? location.href : '';
    const conversationId = ${conversationIdExpression};
    const provisionalConversation = ${provisionalConversationExpression};
    const turns = Array.from(document.querySelectorAll(CONVERSATION_SELECTOR));
    const assistantTurnCount = turns.filter(isAssistantTurn).length;
    return { conversationId, provisionalConversation, assistantTurnCount };
  })()`;
}

export function buildFreshCaptureTargetProbeExpressionForTest(): string {
  return buildFreshCaptureTargetProbeExpression();
}

/**
 * Start-of-run blank-state assertion: a run that requested a fresh target
 * must not land inside an existing conversation (/c/<id>) and must not see
 * pre-existing assistant messages in capture scope. Explicit follow-ups
 * (requested URL is itself a conversation URL) are exempt by construction.
 */
export async function assertFreshCaptureTarget(
  runtime: ChromeClient["Runtime"],
  requestedUrl: string,
  logger: BrowserLogger,
): Promise<void> {
  if (isConversationUrl(requestedUrl)) {
    return;
  }
  let value: unknown;
  try {
    const { result } = await runtime.evaluate({
      expression: buildFreshCaptureTargetProbeExpression(),
      returnByValue: true,
    });
    value = result?.value;
  } catch {
    logger(
      "[browser] Fresh-target probe unavailable after navigation; continuing without blank-state proof.",
    );
    return;
  }
  if (!value || typeof value !== "object") {
    return;
  }
  const facts = value as {
    conversationId?: string | null;
    provisionalConversation?: boolean;
    assistantTurnCount?: number;
  };
  if (facts.provisionalConversation === true) {
    throw new BrowserAutomationError(
      "Navigation for a fresh run landed on ChatGPT's provisional conversation route. " +
        "Refusing to treat an occupied /c/WEB conversation as a blank target.",
      {
        stage: "navigate",
        code: "stale-conversation-at-start",
        provisionalConversation: true,
      },
    );
  }
  const conversationId = normalizeChatGptConversationId(facts.conversationId);
  if (conversationId) {
    throw new BrowserAutomationError(
      `Navigation for a fresh run landed on existing conversation /c/${conversationId}. ` +
        "Refusing to submit into a pre-existing conversation; captured answers could belong to another run.",
      {
        stage: "navigate",
        code: "stale-conversation-at-start",
        conversationId,
      },
    );
  }
  const assistantTurnCount =
    typeof facts.assistantTurnCount === "number" && Number.isFinite(facts.assistantTurnCount)
      ? facts.assistantTurnCount
      : 0;
  if (assistantTurnCount > 0) {
    throw new BrowserAutomationError(
      `Fresh run target already contains ${assistantTurnCount} assistant message(s) in capture scope. ` +
        "Refusing to run against a non-blank conversation surface.",
      {
        stage: "navigate",
        code: "preexisting-assistant-content",
        assistantTurnCount,
      },
    );
  }
}

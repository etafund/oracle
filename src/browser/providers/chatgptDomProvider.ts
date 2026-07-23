import { randomUUID } from "node:crypto";
import type { BrowserLogger, ChromeClient } from "../types.js";
import type { ProviderDomAdapter, ProviderDomFlowContext } from "../providerDomFlow.js";
import { INPUT_SELECTORS, SEND_BUTTON_SELECTORS } from "../constants.js";
import { ensurePromptReady } from "../actions/navigation.js";
import { assertPreRunAccessState } from "../actions/challengeDetection.js";
import {
  buildAttachmentReadyExpression,
  submitPrompt,
  type AttachmentReadyExpectation,
  type ExactSubmissionExpectation,
  type FinalPreDispatchDomGuard,
} from "../actions/promptComposer.js";
import { normalizeRenderedPromptDomIdentity } from "../promptDomMatch.js";
// Capture must flow through the pageActions facade so the structural
// run-binding validation (captureBinding.ts) covers this provider path too.
import { waitForAssistantResponse } from "../pageActions.js";
import { sha256OfBytes } from "../../oracle/v18/evidence.js";
import { chatgptSelectorList } from "../selectors/chatgpt/index.js";
import {
  buildConversationIdFromHrefExpression,
  normalizeChatGptConversationId,
} from "../conversationIdentity.js";
import {
  createChatGptProMachine,
  isFailureState,
  machineVerdict,
  type ChatGptProEvent,
  type ChatGptProMachine,
  type ChatGptProState,
  type ChatGptProVerdict,
} from "./chatgptProVerification.js";
import {
  assertChatGptProSynthesisReady,
  type ChatGptProSynthesisCookieState,
  type ChatGptProSynthesisGateDecision,
  type ChatGptProSynthesisLiveTab,
  type ChatGptProSynthesisSessionState,
} from "./chatgptPro_synthesis_gate.js";

// Re-export the v18 selector manifest + effort strategy so downstream
// callers (state machine, doctor surface, evidence builder) can resolve
// every ChatGPT browser dependency from a single module path.
export {
  CHATGPT_EFFORT_TIERS,
  CHATGPT_SELECTOR_MANIFEST,
  SELECTOR_MANIFEST_LAST_VERIFIED,
  SELECTOR_MANIFEST_VERSION,
  availableEffortLabelsHash,
  chatgptManifestFingerprint,
  chatgptSelector,
  chatgptSelectorFingerprint,
  chatgptSelectorList,
  highestKnownLabel,
  pickHighestVisibleEffort,
  tierForLabel,
  type ChatGptEffortTier,
  type ChatGptEffortTierEntry,
  type ChatGptSelectorEntry,
  type ChatGptSelectorPurpose,
  type EffortStatus,
  type EffortStrategyResult,
  type PickHighestVisibleEffortInput,
  type SelectorConfidence,
} from "../selectors/chatgpt/index.js";
import type { SubmittedUserMessageBinding } from "../actions/captureBinding.js";
import { BrowserAutomationError } from "../../oracle/errors.js";

interface ChatgptDomProviderState {
  runtime: ChromeClient["Runtime"];
  input: ChromeClient["Input"];
  logger: BrowserLogger;
  timeoutMs: number;
  inputTimeoutMs?: number;
  attachmentTimeoutMs?: number;
  baselineTurns?: number | null;
  attachmentNames?: AttachmentReadyExpectation[];
  attachmentBindingToken?: string;
  committedTurns?: number | null;
  beforePromptSubmit?: (
    composerBindingToken?: string,
    exactSubmission?: ExactSubmissionExpectation,
  ) => Promise<FinalPreDispatchDomGuard | void> | FinalPreDispatchDomGuard | void;
  requireBoundSendTarget?: boolean;
  requireExactPromptRoundTrip?: boolean;
  onPromptSubmitted?: (submittedPrompt: string) => Promise<void> | void;
  onPromptBound?: (
    submittedPrompt: string,
    binding: SubmittedUserMessageBinding,
  ) => Promise<void> | void;
  /**
   * Authoritative worker account id (BrowserRunOptions.accountId, i.e. the
   * serve layer's `options.accountId ?? env`). Threaded into the pre-run and
   * pre-result quarantine gates so a trip is keyed on the same account id
   * /ready and /runs admission use — see bead oracle-router-8t1.
   */
  accountId?: string;
}

interface ChatGptProDomVerificationOverrides {
  enabled?: boolean;
  mode?: "remote" | "local";
  accessPath?: "oracle_browser_remote" | "oracle_browser_local" | "oracle_browser_remote_or_local";
  sessionIdHash?: `sha256:${string}`;
  modelLabel?: string;
  observedEffortLabels?: readonly string[];
  liveTab?: Partial<ChatGptProSynthesisLiveTab>;
  cookies?: ChatGptProSynthesisCookieState | null;
  session?: Partial<ChatGptProSynthesisSessionState>;
}

interface ChatGptProDomProbe {
  modelLabel: string;
  effortLabels: readonly string[];
  selectedEffortLabel: string | null;
  routeModelSignals: readonly string[];
  routeModeSignals: readonly string[];
  hasProPill: boolean;
  composerBindingVerified: boolean;
  authenticated: boolean;
  promptReady: boolean;
  sendExists: boolean;
  targetId: string | null;
  url: string | null;
  conversationId: string | null;
  fingerprint: string | null;
}

function requireState(ctx: ProviderDomFlowContext): ChatgptDomProviderState {
  const state = ctx.state as ChatgptDomProviderState | undefined;
  if (!state?.runtime || !state?.input || !state?.logger) {
    throw new Error("chatgptDomProvider requires runtime/input/logger in context.state.");
  }
  return state;
}

async function waitForUi(ctx: ProviderDomFlowContext): Promise<void> {
  const state = requireState(ctx);
  // PRE-RUN access gate (challenge/login fault isolation): refuse before any
  // composer interaction when the worker is quarantined or the page shows a
  // login wall / verification interstitial / security block / rate limit.
  // Runs BEFORE ensurePromptReady so an access wall refuses in milliseconds
  // instead of burning the composer-wait timeout.
  await assertPreRunAccessState(state.runtime, state.logger, {
    quarantine: { accountId: state.accountId },
  });
  await ensurePromptReady(state.runtime, state.inputTimeoutMs ?? 30_000, state.logger);
}

async function typePrompt(_ctx: ProviderDomFlowContext): Promise<void> {
  // submitPrompt() handles typing + send for ChatGPT.
}

async function submitPromptViaAdapter(ctx: ProviderDomFlowContext): Promise<void> {
  const state = requireState(ctx);
  const committedTurns = await submitPrompt(
    {
      runtime: state.runtime,
      input: state.input,
      attachmentNames: state.attachmentNames ?? [],
      attachmentBindingToken: state.attachmentBindingToken,
      baselineTurns: state.baselineTurns ?? undefined,
      inputTimeoutMs: state.inputTimeoutMs ?? undefined,
      attachmentTimeoutMs: state.attachmentTimeoutMs ?? undefined,
      beforePromptSubmit: async (composerBindingToken, exactSubmission) => {
        // Re-check the shared account latch and live page at the final
        // pre-dispatch boundary. Another lane may have quarantined this
        // account while this one was typing/uploading.
        await assertPreRunAccessState(state.runtime, state.logger, {
          quarantine: { accountId: state.accountId },
        });
        return await state.beforePromptSubmit?.(composerBindingToken, exactSubmission);
      },
      requireBoundSendTarget: state.requireBoundSendTarget,
      requireExactPromptRoundTrip: state.requireExactPromptRoundTrip,
      onPromptSubmitted: state.onPromptSubmitted,
      onPromptBound: state.onPromptBound,
    },
    ctx.prompt,
    state.logger,
  );
  state.committedTurns =
    typeof committedTurns === "number" && Number.isFinite(committedTurns) ? committedTurns : null;
  if (
    state.committedTurns != null &&
    (state.baselineTurns == null || state.committedTurns > state.baselineTurns)
  ) {
    state.baselineTurns = Math.max(0, state.committedTurns - 1);
  }
}

async function waitForResponse(ctx: ProviderDomFlowContext): Promise<{
  text: string;
  html?: string;
  meta?: { turnId?: string | null; messageId?: string | null };
}> {
  const state = requireState(ctx);
  const answer = await waitForAssistantResponse(
    state.runtime,
    state.timeoutMs,
    state.logger,
    state.baselineTurns ?? undefined,
    undefined,
    state.accountId,
  );
  return {
    text: answer.text,
    html: answer.html,
    meta: answer.meta,
  };
}

const chatgptDomProviderBase: ProviderDomAdapter = {
  providerName: "chatgpt-web",
  waitForUi,
  typePrompt,
  submitPrompt: submitPromptViaAdapter,
  waitForResponse,
};

// ─── ChatGPT Pro FSM wiring (oracle-byl) ───────────────────────────────────
//
// Production ChatGPT DOM submission previously consumed the bare
// adapter above, so the v18 ChatGPT Pro FSM could exist without ever
// gating the live send click. The wrapper below mirrors the Gemini
// Deep Think wiring: submitPrompt first proves the machine reached
// `mode_verified_same_session`, then consults the synthesis gate, and
// only then delegates to the underlying adapter.

export class ChatGptProFsmError extends Error {
  readonly verdict: ChatGptProVerdict;
  constructor(verdict: ChatGptProVerdict, cause?: unknown) {
    super(
      `ChatGPT Pro FSM rejected operation (state="${verdict.state}", errorCode=${
        verdict.errorCode ?? "n/a"
      }): ${verdict.failureReason ?? "no reason recorded"}`,
    );
    this.name = "ChatGptProFsmError";
    this.verdict = verdict;
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}

export interface WiredChatGptProAdapter extends ProviderDomAdapter {
  readonly getMachine: () => ChatGptProMachine;
  readonly getVerdict: () => ChatGptProVerdict;
  readonly getLastSynthesisGateDecision: () => ChatGptProSynthesisGateDecision | null;
}

export interface WireChatGptProFsmOptions {
  readonly mode?: "remote" | "local";
  readonly accessPath?:
    | "oracle_browser_remote"
    | "oracle_browser_local"
    | "oracle_browser_remote_or_local";
  readonly sessionIdHash?: `sha256:${string}`;
  readonly promptSha256?: (prompt: string) => `sha256:${string}`;
  readonly outputSha256?: (text: string) => `sha256:${string}`;
  readonly now?: () => Date;
  readonly onTransition?: (machine: ChatGptProMachine) => void;
}

function classifyChatGptAdapterError(err: unknown): "login_required" | "ui_drift" {
  const msg = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
  if (msg.includes("sign in") || msg.includes("sign-in") || msg.includes("login")) {
    return "login_required";
  }
  return "ui_drift";
}

function chatGptProOverrides(
  ctx: ProviderDomFlowContext,
): ChatGptProDomVerificationOverrides | null {
  const raw = ctx.state?.chatgptProVerification;
  return raw && typeof raw === "object" ? (raw as ChatGptProDomVerificationOverrides) : null;
}

function chatGptProVerificationEnabled(ctx: ProviderDomFlowContext): boolean {
  return chatGptProOverrides(ctx)?.enabled !== false;
}

function throwIfChatGptProFailure(machine: ChatGptProMachine): void {
  if (isFailureState(machine.state)) {
    throw new ChatGptProFsmError(machineVerdict(machine));
  }
}

function resolveSessionIdHash(
  ctx: ProviderDomFlowContext,
  adapter: ProviderDomAdapter,
  options: WireChatGptProFsmOptions,
): `sha256:${string}` {
  const override = chatGptProOverrides(ctx)?.sessionIdHash;
  return override ?? options.sessionIdHash ?? sha256OfBytes(`chatgpt-pro:${adapter.providerName}`);
}

function resolveMode(
  ctx: ProviderDomFlowContext,
  options: WireChatGptProFsmOptions,
): "remote" | "local" {
  return chatGptProOverrides(ctx)?.mode ?? options.mode ?? "local";
}

function resolveAccessPath(
  ctx: ProviderDomFlowContext,
  options: WireChatGptProFsmOptions,
): "oracle_browser_remote" | "oracle_browser_local" | "oracle_browser_remote_or_local" {
  const override = chatGptProOverrides(ctx)?.accessPath ?? options.accessPath;
  if (override) return override;
  return resolveMode(ctx, options) === "remote" ? "oracle_browser_remote" : "oracle_browser_local";
}

async function resolveChatGptProProbe(ctx: ProviderDomFlowContext): Promise<ChatGptProDomProbe> {
  const overrides = chatGptProOverrides(ctx);
  const state = requireState(ctx);
  const domProbe = await readChatGptProDomProbe(state.runtime).catch(() => null);
  const modelLabel = overrides?.modelLabel ?? domProbe?.modelLabel ?? "";
  const effortLabels = overrides?.observedEffortLabels ?? domProbe?.effortLabels ?? [];
  return {
    modelLabel,
    effortLabels,
    selectedEffortLabel: domProbe?.selectedEffortLabel ?? null,
    routeModelSignals: domProbe?.routeModelSignals ?? [],
    routeModeSignals: domProbe?.routeModeSignals ?? [],
    hasProPill: domProbe?.hasProPill === true,
    composerBindingVerified: domProbe?.composerBindingVerified ?? true,
    authenticated: domProbe?.authenticated ?? true,
    promptReady: domProbe?.promptReady ?? true,
    sendExists: domProbe?.sendExists ?? true,
    targetId: domProbe?.targetId ?? null,
    url: domProbe?.url ?? null,
    conversationId: domProbe?.conversationId ?? null,
    fingerprint: domProbe?.fingerprint ?? null,
  };
}

async function readChatGptProDomProbe(
  runtime: ChromeClient["Runtime"],
  attachmentBindingToken?: string,
  composerBindingToken?: string,
): Promise<ChatGptProDomProbe | null> {
  const result = await runtime.evaluate({
    expression: buildChatGptProDomProbeExpression(attachmentBindingToken, composerBindingToken),
    awaitPromise: true,
    returnByValue: true,
  });
  return parseChatGptProDomProbe(result.result?.value);
}

function parseChatGptProDomProbe(value: unknown): ChatGptProDomProbe | null {
  if (!value || typeof value !== "object") return null;
  const probe = value as Partial<ChatGptProDomProbe>;
  return {
    modelLabel: typeof probe.modelLabel === "string" ? probe.modelLabel : "",
    effortLabels: Array.isArray(probe.effortLabels)
      ? probe.effortLabels.filter((label): label is string => typeof label === "string")
      : [],
    selectedEffortLabel:
      typeof probe.selectedEffortLabel === "string" ? probe.selectedEffortLabel : null,
    routeModelSignals: Array.isArray(probe.routeModelSignals)
      ? probe.routeModelSignals.filter((label): label is string => typeof label === "string")
      : [],
    routeModeSignals: Array.isArray(probe.routeModeSignals)
      ? probe.routeModeSignals.filter((label): label is string => typeof label === "string")
      : [],
    hasProPill: probe.hasProPill === true,
    composerBindingVerified: probe.composerBindingVerified === true,
    authenticated: probe.authenticated !== false,
    promptReady: probe.promptReady === true,
    sendExists: probe.sendExists === true,
    targetId: typeof probe.targetId === "string" ? probe.targetId : null,
    url: typeof probe.url === "string" ? probe.url : null,
    conversationId: normalizeChatGptConversationId(probe.conversationId) ?? null,
    fingerprint: typeof probe.fingerprint === "string" ? probe.fingerprint : null,
  };
}

function buildChatGptProDomProbeExpression(
  attachmentBindingToken?: string,
  composerBindingToken?: string,
): string {
  const modelPickerButtons = JSON.stringify(chatgptSelectorList("model_picker_button"));
  const modelRows = JSON.stringify(chatgptSelectorList("model_row"));
  const effortButtons = JSON.stringify(chatgptSelectorList("effort_picker_button"));
  const effortRows = JSON.stringify(chatgptSelectorList("effort_row"));
  const composerInputs = JSON.stringify(chatgptSelectorList("composer_textarea"));
  const sendButtons = JSON.stringify(chatgptSelectorList("send_button"));
  const conversationIdExpression = buildConversationIdFromHrefExpression("url");
  const attachmentBindingTokenLiteral = JSON.stringify(attachmentBindingToken ?? "");
  const composerBindingTokenLiteral = JSON.stringify(composerBindingToken ?? "");

  return `(() => {
    const MODEL_PICKER_BUTTONS = ${modelPickerButtons};
    const MODEL_ROWS = ${modelRows};
    const EFFORT_BUTTONS = ${effortButtons};
    const EFFORT_ROWS = ${effortRows};
    const COMPOSER_INPUTS = ${composerInputs};
    const SEND_BUTTONS = ${sendButtons};
    const ATTACHMENT_BINDING_TOKEN = ${attachmentBindingTokenLiteral};
    const COMPOSER_BINDING_TOKEN = ${composerBindingTokenLiteral};
    const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
    const text = (node) => normalize(node?.textContent || node?.getAttribute?.('aria-label') || '');
    const isVisible = (node) => {
      if (!node || node.isConnected === false) return false;
      if (node.hidden === true || node.getAttribute?.('aria-hidden') === 'true') return false;
      if (typeof node.getBoundingClientRect === 'function') {
        const rect = node.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return false;
      }
      let current = node;
      while (current && current !== document.documentElement) {
        if (current.hidden === true || current.getAttribute?.('aria-hidden') === 'true') return false;
        const style = typeof window === 'object' ? window.getComputedStyle?.(current) : null;
        if (
          style &&
          (style.display === 'none' ||
            style.visibility === 'hidden' ||
            style.visibility === 'collapse')
        ) {
          return false;
        }
        current = current.parentElement;
      }
      return true;
    };
    const queryVisible = (root, selectors) => {
      if (!root) return [];
      const out = [];
      const seen = new Set();
      for (const selector of selectors) {
        for (const node of root.querySelectorAll(selector)) {
          if (!isVisible(node) || seen.has(node)) continue;
          seen.add(node);
          out.push(node);
        }
      }
      return out;
    };
    const activePrompt = queryVisible(document, COMPOSER_INPUTS)[0] || null;
    const boundComposers = ATTACHMENT_BINDING_TOKEN
      ? queryVisible(document, ['[data-oracle-attachment-binding]']).filter(
          (node) =>
            node.getAttribute?.('data-oracle-attachment-binding') === ATTACHMENT_BINDING_TOKEN &&
            activePrompt &&
            typeof node.contains === 'function' &&
            node.contains(activePrompt),
        )
      : [];
    const dispatchBoundComposers = COMPOSER_BINDING_TOKEN
      ? queryVisible(document, ['[data-oracle-send-composer-binding]']).filter(
          (node) =>
            node.getAttribute?.('data-oracle-send-composer-binding') === COMPOSER_BINDING_TOKEN &&
            activePrompt &&
            typeof node.contains === 'function' &&
            node.contains(activePrompt),
        )
      : [];
    const composerBindingVerified =
      (!ATTACHMENT_BINDING_TOKEN || boundComposers.length === 1) &&
      (!COMPOSER_BINDING_TOKEN || dispatchBoundComposers.length === 1) &&
      (!ATTACHMENT_BINDING_TOKEN ||
        !COMPOSER_BINDING_TOKEN ||
        boundComposers[0] === dispatchBoundComposers[0]);
    // The post-upload protected-route probe must use the same exact composer
    // node that owns the attachment token and active prompt. A document-wide
    // scan can otherwise combine a stale/hidden Sol selector with an unrelated
    // global Pro badge and authorize the wrong send controller.
    const routeRoot = ATTACHMENT_BINDING_TOKEN || COMPOSER_BINDING_TOKEN
      ? (composerBindingVerified
          ? (dispatchBoundComposers[0] || boundComposers[0])
          : null)
      : document;
    const selected = (node) => {
      if (!node) return false;
      const values = [
        node.getAttribute?.('aria-selected'),
        node.getAttribute?.('aria-checked'),
        node.getAttribute?.('aria-pressed'),
        node.getAttribute?.('data-selected'),
        node.getAttribute?.('data-state'),
      ].map((v) => String(v || '').toLowerCase());
      return values.some((v) => v === 'true' || v === 'checked' || v === 'selected' || v === 'on');
    };
    const firstText = (selectors) => {
      for (const node of queryVisible(routeRoot, selectors)) {
        const value = text(node);
        if (value) return value;
      }
      return '';
    };
    const selectedText = (selectors) => {
      for (const node of queryVisible(routeRoot, selectors)) {
        if (!selected(node)) continue;
        const value = text(node);
        if (value) return value;
      }
      return '';
    };
    const collectTexts = (selectors) => {
      const out = [];
      const seen = new Set();
      for (const node of queryVisible(routeRoot, selectors)) {
        const value = text(node);
        if (!value || seen.has(value)) continue;
        seen.add(value);
        out.push(value);
      }
      return out;
    };
    const byOracleRole = (role) =>
      queryVisible(routeRoot, ['[data-oracle-role="' + role + '"]']);
    const fixtureModel =
      byOracleRole('chatgpt-model-option').find(selected)?.textContent?.trim?.() || '';
    const fixtureEfforts = byOracleRole('chatgpt-effort-option')
      .map((node) => text(node))
      .filter(Boolean);
    const fixtureSelectedEffort =
      text(byOracleRole('chatgpt-effort-option').find(selected)) || null;
    const composerPillTexts = collectTexts(['button.__composer-pill']);
    const effortLikeComposerPills = composerPillTexts.filter((label) =>
      /\\b(extended\\s+pro|pro\\s+extended|heavy|ultra|max|standard|light)\\b/i.test(label)
    );
    const modelLikeComposerPill =
      composerPillTexts.find((label) => /\\b(pro|gpt|chatgpt|thinking|instant)\\b/i.test(label)) || '';
    const composerModelNode = queryVisible(routeRoot, [
      '[data-testid="composer-model-label"]',
      '[data-testid="model-label"]',
    ])[0];
    const composerModel = normalize(composerModelNode?.textContent || '');
    const buttonModel = firstText(MODEL_PICKER_BUTTONS) || modelLikeComposerPill;
    const selectedModel = selectedText(MODEL_ROWS);
    const selectedEffort =
      fixtureSelectedEffort ||
      selectedText(EFFORT_ROWS) ||
      firstText(EFFORT_BUTTONS) ||
      effortLikeComposerPills[0] ||
      null;
    const effortLabels =
      fixtureEfforts.length > 0
        ? fixtureEfforts
        : Array.from(new Set([...collectTexts(EFFORT_ROWS), ...effortLikeComposerPills]));
    if (effortLabels.length === 0 && selectedEffort) {
      effortLabels.push(selectedEffort);
    }
    const hasProPill =
      composerPillTexts.some((label) => normalize(label).toLowerCase() === 'pro') ||
      queryVisible(routeRoot, ['button[aria-label="Pro, click to remove" i]']).length > 0;
    // These are deliberately limited to CURRENT-selection surfaces. Never add
    // unselected menu rows here: this probe is the fail-closed, non-mutating
    // check used after an attachment upload, where seeing an available model is
    // not proof that it is still the active model.
    const routeModelSignals = Array.from(new Set([
      fixtureModel,
      selectedModel,
      composerModel,
      buttonModel,
    ].map(normalize).filter(Boolean)));
    const routeModeSignals = Array.from(new Set([
      fixtureSelectedEffort,
      selectedEffort,
      ...effortLikeComposerPills,
      ...(hasProPill ? ['Pro'] : []),
    ].map(normalize).filter(Boolean)));
    const accountProfileText = normalize(
      Array.from(document.querySelectorAll('[data-testid="accounts-profile-button"]'))
        .map((node) => (node.textContent || '') + ' ' + (node.getAttribute?.('aria-label') || ''))
        .join(' ')
    );
    const accountHasPro = /\\bpro\\b/i.test(accountProfileText);
    const highEffortLabels = new Set(['heavy', 'thinking heavy', 'heavy thinking', 'pro heavy', 'ultra', 'pro ultra', 'max']);
    const hasHighEffort = (label) => highEffortLabels.has(normalize(label).toLowerCase());
    const hasProEffortSignal =
      Boolean(selectedEffort && (hasHighEffort(selectedEffort) || /\\bpro\\b/i.test(selectedEffort))) ||
      effortLabels.some((label) => hasHighEffort(label) || /\\bpro\\b/i.test(label));
    const baseModel = fixtureModel || selectedModel || composerModel || buttonModel;
    const modelLabel = baseModel
      ? (effortLikeComposerPills.includes(baseModel) && /\\bpro\\b/i.test(baseModel)
          ? 'Pro'
          : hasProPill && !/\\bpro\\b/i.test(baseModel) ? baseModel + ' + Pro' : baseModel)
      : (accountHasPro && hasProEffortSignal ? 'Pro' : '');
    const promptReady = composerBindingVerified && queryVisible(routeRoot, COMPOSER_INPUTS).length > 0;
    const sendExists = composerBindingVerified && queryVisible(routeRoot, SEND_BUTTONS).length > 0;
    const url = window.location?.href || null;
    const conversationId = ${conversationIdExpression};
    return {
      modelLabel,
      effortLabels,
      selectedEffortLabel: selectedEffort,
      routeModelSignals,
      routeModeSignals,
      hasProPill,
      composerBindingVerified,
      authenticated: !/\\/auth\\/login|\\/login/i.test(url || ''),
      promptReady,
      sendExists,
      targetId: null,
      url,
      conversationId,
      fingerprint: [modelLabel, selectedEffort, effortLabels.join('|')].join('::'),
    };
  })()`;
}

export interface Gpt56SolProReadOnlyRouteEvidence {
  readonly verified: boolean;
  readonly composerBindingVerified: boolean;
  readonly modelVerified: boolean;
  readonly modeVerified: boolean;
  readonly modelSignals: readonly string[];
  readonly modeSignals: readonly string[];
}

function normalizeProtectedRouteLabel(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function classifyGpt56SolProRouteProbe(
  probe: Pick<
    ChatGptProDomProbe,
    "routeModelSignals" | "routeModeSignals" | "hasProPill" | "composerBindingVerified"
  >,
): Gpt56SolProReadOnlyRouteEvidence {
  const modelSignals = Array.from(
    new Set(probe.routeModelSignals.map(normalizeProtectedRouteLabel).filter(Boolean)),
  );
  const modeSignals = Array.from(
    new Set([
      ...probe.routeModeSignals.map(normalizeProtectedRouteLabel).filter(Boolean),
      ...(probe.hasProPill ? ["pro"] : []),
    ]),
  );
  // Every visible signal on the bound composer must agree. Merely finding one
  // exact label is not sufficient: an exact Sol signal plus a Sol Mini
  // lookalike, or Standard plus a foreign/global Pro badge, is ambiguous and
  // therefore fails closed.
  const modelVerified =
    probe.composerBindingVerified &&
    modelSignals.length > 0 &&
    modelSignals.every((label) => label === "gpt 5 6 sol");
  const modeVerified =
    probe.composerBindingVerified &&
    modeSignals.length > 0 &&
    modeSignals.every((label) => label === "pro");
  return {
    verified: probe.composerBindingVerified && modelVerified && modeVerified,
    composerBindingVerified: probe.composerBindingVerified,
    modelVerified,
    modeVerified,
    modelSignals,
    modeSignals,
  };
}

/**
 * Read the already-selected protected route without opening a picker or
 * dispatching any DOM event. This is safe to call after uploading files: it
 * can fail closed, but it can never remount the composer by selecting a model.
 */
export async function readGpt56SolProRouteReadOnly(
  runtime: ChromeClient["Runtime"],
  attachmentBindingToken?: string,
  composerBindingToken?: string,
): Promise<Gpt56SolProReadOnlyRouteEvidence> {
  const probe = await readChatGptProDomProbe(runtime, attachmentBindingToken, composerBindingToken);
  if (!probe) {
    return {
      verified: false,
      composerBindingVerified: false,
      modelVerified: false,
      modeVerified: false,
      modelSignals: [],
      modeSignals: [],
    };
  }
  return classifyGpt56SolProRouteProbe(probe);
}

const PROTECTED_DISPATCH_GUARD_REGISTRY = "__oracleProtectedDispatchGuardsV2";
const PROTECTED_DISPATCH_GUARD_TTL_MS = 15_000;

function buildProtectedDispatchGuardInstallExpression(
  attachmentBindingToken?: string,
  composerBindingToken?: string,
  verdictBindingName?: string,
  verdictNonce?: string,
  options: {
    requireProtectedRoute: boolean;
    exactSubmission?: ExactSubmissionExpectation;
  } = { requireProtectedRoute: true },
): string {
  const routeProbeExpression = buildChatGptProDomProbeExpression(
    attachmentBindingToken,
    composerBindingToken,
  );
  const tokenLiteral = JSON.stringify(composerBindingToken ?? "");
  const bindingNameLiteral = JSON.stringify(verdictBindingName ?? "");
  const nonceLiteral = JSON.stringify(verdictNonce ?? "");
  const registryLiteral = JSON.stringify(PROTECTED_DISPATCH_GUARD_REGISTRY);
  const sendSelectorsLiteral = JSON.stringify(SEND_BUTTON_SELECTORS);
  const ttlLiteral = JSON.stringify(PROTECTED_DISPATCH_GUARD_TTL_MS);
  const requireProtectedRouteLiteral = JSON.stringify(options.requireProtectedRoute);
  const exactPromptLiteral = JSON.stringify(options.exactSubmission?.prompt ?? "");
  const hasExactSubmissionLiteral = JSON.stringify(Boolean(options.exactSubmission));
  const attachmentStateExpression = options.exactSubmission
    ? buildAttachmentReadyExpression(
        options.exactSubmission.attachments,
        attachmentBindingToken,
        false,
        composerBindingToken,
        true,
      )
    : "true";
  const inputSelectorsLiteral = JSON.stringify(INPUT_SELECTORS);
  return `(() => {
    const TOKEN = ${tokenLiteral};
    const BINDING_NAME = ${bindingNameLiteral};
    const NONCE = ${nonceLiteral};
    const REGISTRY_KEY = ${registryLiteral};
    const SEND_SELECTORS = ${sendSelectorsLiteral};
    const TTL_MS = ${ttlLiteral};
    const REQUIRE_PROTECTED_ROUTE = ${requireProtectedRouteLiteral};
    const HAS_EXACT_SUBMISSION = ${hasExactSubmissionLiteral};
    const EXPECTED_PROMPT = ${exactPromptLiteral};
    const INPUT_SELECTORS = ${inputSelectorsLiteral};
    const EVENT_TYPES = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'];
    const normalizeRenderedPromptDomIdentity = ${normalizeRenderedPromptDomIdentity.toString()};
    const readAttachmentState = () => (${attachmentStateExpression});
    const normalize = (value) => String(value || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .replace(/\\s+/g, ' ')
      .trim();
    const readRoute = () => (${routeProbeExpression});
    const classifyRoute = (probe) => {
      const modelSignals = Array.from(new Set(
        (Array.isArray(probe?.routeModelSignals) ? probe.routeModelSignals : [])
          .map(normalize)
          .filter(Boolean)
      ));
      const modeSignals = Array.from(new Set([
        ...(Array.isArray(probe?.routeModeSignals) ? probe.routeModeSignals : [])
          .map(normalize)
          .filter(Boolean),
        ...(probe?.hasProPill === true ? ['pro'] : []),
      ]));
      const composerBindingVerified = REQUIRE_PROTECTED_ROUTE
        ? probe?.composerBindingVerified === true
        : true;
      const modelVerified =
        !REQUIRE_PROTECTED_ROUTE || (composerBindingVerified &&
        modelSignals.length > 0 &&
        modelSignals.every((label) => label === 'gpt 5 6 sol'));
      const modeVerified =
        !REQUIRE_PROTECTED_ROUTE || (composerBindingVerified &&
        modeSignals.length > 0 &&
        modeSignals.every((label) => label === 'pro'));
      return {
        verified: composerBindingVerified && modelVerified && modeVerified,
        composerBindingVerified,
        modelVerified,
        modeVerified,
        modelSignals,
        modeSignals,
      };
    };
    const isVisible = (node) => {
      if (!node || node.isConnected === false || typeof node.getBoundingClientRect !== 'function') {
        return false;
      }
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
    const isEnabled = (node) => {
      if (!node) return false;
      const style = window.getComputedStyle?.(node);
      return !(
        node.hasAttribute?.('disabled') ||
        node.getAttribute?.('aria-disabled') === 'true' ||
        node.getAttribute?.('data-disabled') === 'true' ||
        style?.pointerEvents === 'none' ||
        style?.display === 'none'
      );
    };
    const findExactBoundTarget = () => {
      const buttons = Array.from(document.querySelectorAll('[data-oracle-send-binding]'))
        .filter((node) => node?.getAttribute?.('data-oracle-send-binding') === TOKEN);
      const composers = Array.from(document.querySelectorAll('[data-oracle-send-composer-binding]'))
        .filter((node) => node?.getAttribute?.('data-oracle-send-composer-binding') === TOKEN);
      const editors = Array.from(document.querySelectorAll('[data-oracle-send-editor-binding]'))
        .filter((node) => node?.getAttribute?.('data-oracle-send-editor-binding') === TOKEN);
      const button = buttons.length === 1 ? buttons[0] : null;
      const composer = composers.length === 1 ? composers[0] : null;
      const editor = editors.length === 1 ? editors[0] : null;
      const currentCandidates = [];
      if (composer) {
        for (const selector of SEND_SELECTORS) {
          currentCandidates.push(...Array.from(composer.querySelectorAll(selector)));
        }
      }
      const currentButtons = Array.from(new Set(currentCandidates)).filter(
        (candidate) => isVisible(candidate) && isEnabled(candidate)
      );
      const currentButton = currentButtons.length === 1 ? currentButtons[0] : null;
      const verified = Boolean(
        button &&
        composer &&
        editor &&
        button.isConnected !== false &&
        composer.isConnected !== false &&
        editor.isConnected !== false &&
        typeof composer.contains === 'function' &&
        composer.contains(editor) &&
        composer.contains(button) &&
        isVisible(editor) &&
        isVisible(button) &&
        isEnabled(button) &&
        currentButton === button
      );
      return { verified, button, composer, editor, currentButton };
    };
    const readEditorValue = (editor) => {
      if (editor instanceof HTMLTextAreaElement || editor instanceof HTMLInputElement) {
        return editor.value || '';
      }
      return editor?.innerText ?? editor?.textContent ?? '';
    };
    const inspect = (allowButtonFocus = false) => {
      let probe = null;
      try {
        probe = readRoute();
      } catch {}
      const route = classifyRoute(probe);
      const target = findExactBoundTarget();
      const focused = document.activeElement;
      const editorFocused = Boolean(
        target.editor && focused &&
        (focused === target.editor || target.editor.contains?.(focused))
      );
      const buttonFocused = Boolean(
        allowButtonFocus && target.button && focused &&
        (focused === target.button || target.button.contains?.(focused))
      );
      const exactPromptVerified = !HAS_EXACT_SUBMISSION || Boolean(
        target.editor &&
        normalizeRenderedPromptDomIdentity(readEditorValue(target.editor)) ===
          normalizeRenderedPromptDomIdentity(EXPECTED_PROMPT)
      );
      let attachmentStateVerified = !HAS_EXACT_SUBMISSION;
      if (HAS_EXACT_SUBMISSION) {
        try { attachmentStateVerified = readAttachmentState() === true; } catch {}
      }
      const focusVerified = !HAS_EXACT_SUBMISSION || editorFocused || buttonFocused;
      return {
        ok: Boolean(
          TOKEN &&
          route.verified &&
          target.verified &&
          exactPromptVerified &&
          attachmentStateVerified &&
          focusVerified
        ),
        reason: !TOKEN
          ? 'guard-token-missing'
          : !route.verified
            ? 'protected-route-changed'
            : !target.verified
              ? 'bound-send-target-changed'
              : !exactPromptVerified
                ? 'exact-prompt-changed'
                : !attachmentStateVerified
                  ? 'exact-attachment-state-changed'
                  : !focusVerified
                    ? 'exact-editor-focus-changed'
              : null,
        probe,
        route,
        button: target.button,
        composer: target.composer,
        editor: target.editor,
        exactPromptVerified,
        attachmentStateVerified,
        focusVerified,
      };
    };
    const removeOwnedAttributes = () => {
      for (const node of Array.from(document.querySelectorAll('[data-oracle-send-binding]'))) {
        if (node?.getAttribute?.('data-oracle-send-binding') === TOKEN) {
          try { node.removeAttribute?.('data-oracle-send-binding'); } catch {}
        }
      }
      for (const node of Array.from(document.querySelectorAll('[data-oracle-send-composer-binding]'))) {
        if (node?.getAttribute?.('data-oracle-send-composer-binding') === TOKEN) {
          try { node.removeAttribute?.('data-oracle-send-composer-binding'); } catch {}
        }
      }
      for (const node of Array.from(document.querySelectorAll('[data-oracle-send-editor-binding]'))) {
        if (node?.getAttribute?.('data-oracle-send-editor-binding') === TOKEN) {
          try { node.removeAttribute?.('data-oracle-send-editor-binding'); } catch {}
        }
      }
    };
    const initial = inspect(false);
    const root = window;
    if (
      !initial.ok ||
      !BINDING_NAME ||
      !NONCE ||
      typeof root[BINDING_NAME] !== 'function' ||
      typeof root.addEventListener !== 'function' ||
      typeof document.addEventListener !== 'function' ||
      typeof initial.button?.addEventListener !== 'function'
    ) {
      removeOwnedAttributes();
      try { delete root[BINDING_NAME]; } catch {}
      return {
        installed: false,
        status: 'blocked',
        reason: initial.reason ||
          (typeof root[BINDING_NAME] !== 'function'
            ? 'verdict-binding-unavailable'
            : 'event-guard-unavailable'),
        routeProof: initial.probe,
        exactPromptVerified: initial.exactPromptVerified,
        attachmentStateVerified: initial.attachmentStateVerified,
        focusVerified: initial.focusVerified,
      };
    }
    let registry = root[REGISTRY_KEY];
    if (!(registry instanceof Map)) {
      registry = new Map();
      root[REGISTRY_KEY] = registry;
    }
    if (root[REGISTRY_KEY] !== registry) {
      removeOwnedAttributes();
      try { delete root[BINDING_NAME]; } catch {}
      return {
        installed: false,
        status: 'blocked',
        reason: 'guard-registry-unavailable',
        routeProof: initial.probe,
      };
    }
    for (const previous of Array.from(registry.values())) {
      try { previous?.cleanup?.('superseded'); } catch {}
    }
    registry = new Map();
    root[REGISTRY_KEY] = registry;
    const state = {
      status: 'armed',
      reason: null,
      lastEvent: null,
      reported: false,
      cleaned: false,
      expiryId: null,
      cleanup: null,
    };
    const terminalPayload = () => JSON.stringify({
      version: 1,
      nonce: NONCE,
      token: TOKEN,
      status: state.status,
      reason: state.reason,
      lastEvent: state.lastEvent,
    });
    const reportTerminal = () => {
      if (state.reported) return true;
      try {
        const binding = root[BINDING_NAME];
        if (typeof binding !== 'function') return false;
        binding(terminalPayload());
        state.reported = true;
        return true;
      } catch {
        return false;
      }
    };
    const cancel = (event, reason) => {
      state.status = 'blocked';
      state.reason = state.reason || reason;
      state.lastEvent = event?.type || state.lastEvent;
      reportTerminal();
      try { event?.preventDefault?.(); } catch {}
      try { event?.stopImmediatePropagation?.(); } catch {}
      try { event?.stopPropagation?.(); } catch {}
    };
    const listener = (event) => {
      if (state.status === 'blocked') {
        cancel(event, state.reason || 'dispatch-guard-already-blocked');
        if (
          state.reason === 'dispatch-guard-expired' &&
          (event?.type === 'mouseup' || event?.type === 'click') &&
          typeof root.setTimeout === 'function'
        ) {
          // A crashed controller must not leave the shared browser unusable.
          // Keep the entire first late click sequence blocked, then retire the
          // stale guard so the user's next deliberate click can proceed.
          root.setTimeout(() => cleanup(), 250);
        }
        return;
      }
      if (state.status === 'allowed') {
        cancel(event, 'duplicate-trusted-dispatch-event');
        return;
      }
      if (event?.isTrusted !== true) {
        cancel(event, 'untrusted-dispatch-event');
        return;
      }
      if (
        (typeof event.button === 'number' && event.button !== 0) ||
        (typeof event.pointerType === 'string' && event.pointerType && event.pointerType !== 'mouse')
      ) {
        cancel(event, 'non-primary-dispatch-event');
        return;
      }
      const current = inspect(event.type !== 'pointerdown' && event.type !== 'mousedown');
      const eventTarget = event?.target;
      const eventPath = typeof event?.composedPath === 'function' ? event.composedPath() : [];
      const targetMatches = Boolean(
        current.button &&
        eventTarget &&
        (eventTarget === current.button || current.button.contains?.(eventTarget)) &&
        (eventPath.length === 0 || eventPath.includes(current.button))
      );
      const hit =
        Number.isFinite(event?.clientX) && Number.isFinite(event?.clientY)
          ? document.elementFromPoint?.(event.clientX, event.clientY)
          : null;
      const hitMatches = Boolean(
        current.button && hit && (hit === current.button || current.button.contains?.(hit))
      );
      if (
        !current.ok ||
        current.button !== initial.button ||
        current.composer !== initial.composer ||
        current.editor !== initial.editor ||
        !targetMatches ||
        !hitMatches
      ) {
        cancel(event, current.reason || 'trusted-event-target-changed');
        return;
      }
      state.lastEvent = event.type;
      if (event.type !== 'click') {
        // Keep pointer/mouse precursor handlers from observing a possible send.
        // Deliberately preserve the browser default so Chrome can still synthesize
        // the final trusted click, which is the sole application-visible event.
        if (event.currentTarget === root) {
          try { event.stopImmediatePropagation?.(); } catch {}
          try { event.stopPropagation?.(); } catch {}
        }
        return;
      }
      if (event.currentTarget !== initial.button) return;
      state.status = 'allowed';
      if (!reportTerminal()) {
        state.status = 'blocked';
        state.reason = 'verdict-binding-call-failed';
        cancel(event, state.reason);
      }
    };
    const cleanup = () => {
      if (state.cleaned) return;
      state.cleaned = true;
      try { if (state.expiryId != null) root.clearTimeout?.(state.expiryId); } catch {}
      for (const type of EVENT_TYPES) {
        try { root.removeEventListener(type, listener, true); } catch {}
        try { document.removeEventListener(type, listener, true); } catch {}
        try { initial.button?.removeEventListener?.(type, listener, true); } catch {}
      }
      removeOwnedAttributes();
      try { registry.delete(TOKEN); } catch {}
      try { if (registry.size === 0) delete root[REGISTRY_KEY]; } catch {}
      try { delete root[BINDING_NAME]; } catch {}
    };
    state.cleanup = cleanup;
    for (const type of EVENT_TYPES) {
      root.addEventListener(type, listener, { capture: true, passive: false });
      document.addEventListener(type, listener, { capture: true, passive: false });
      initial.button.addEventListener(type, listener, { capture: true, passive: false });
    }
    registry.set(TOKEN, state);
    if (typeof root.setTimeout === 'function') {
      state.expiryId = root.setTimeout(() => {
        if (state.status === 'armed') {
          state.status = 'blocked';
          state.reason = 'dispatch-guard-expired';
          state.lastEvent = state.lastEvent || 'timeout';
          reportTerminal();
        }
      }, TTL_MS);
    }
    return {
      installed: true,
      status: state.status,
      reason: null,
      routeProof: initial.probe,
      exactPromptVerified: initial.exactPromptVerified,
      attachmentStateVerified: initial.attachmentStateVerified,
      focusVerified: initial.focusVerified,
    };
  })()`;
}

function buildProtectedDispatchGuardStatusExpression(composerBindingToken?: string): string {
  const tokenLiteral = JSON.stringify(composerBindingToken ?? "");
  const registryLiteral = JSON.stringify(PROTECTED_DISPATCH_GUARD_REGISTRY);
  return `(() => {
    const registry = window[${registryLiteral}];
    const state = registry instanceof Map ? registry.get(${tokenLiteral}) : null;
    if (!state) {
      return { status: 'missing', reason: 'dispatch-guard-missing', lastEvent: null };
    }
    return {
      status: state.status,
      reason: state.reason || null,
      lastEvent: state.lastEvent || null,
    };
  })()`;
}

function buildProtectedDispatchGuardVerdictExpression(
  composerBindingToken?: string,
  verdictBindingName?: string,
): string {
  const tokenLiteral = JSON.stringify(composerBindingToken ?? "");
  const bindingNameLiteral = JSON.stringify(verdictBindingName ?? "");
  const registryLiteral = JSON.stringify(PROTECTED_DISPATCH_GUARD_REGISTRY);
  return `(() => {
    const TOKEN = ${tokenLiteral};
    const BINDING_NAME = ${bindingNameLiteral};
    const root = window;
    const registry = root[${registryLiteral}];
    const state = registry instanceof Map ? registry.get(TOKEN) : null;
    if (!state) {
      for (const node of Array.from(document.querySelectorAll('[data-oracle-send-binding]'))) {
        if (node?.getAttribute?.('data-oracle-send-binding') === TOKEN) {
          try { node.removeAttribute?.('data-oracle-send-binding'); } catch {}
        }
      }
      for (const node of Array.from(document.querySelectorAll('[data-oracle-send-composer-binding]'))) {
        if (node?.getAttribute?.('data-oracle-send-composer-binding') === TOKEN) {
          try { node.removeAttribute?.('data-oracle-send-composer-binding'); } catch {}
        }
      }
      for (const node of Array.from(document.querySelectorAll('[data-oracle-send-editor-binding]'))) {
        if (node?.getAttribute?.('data-oracle-send-editor-binding') === TOKEN) {
          try { node.removeAttribute?.('data-oracle-send-editor-binding'); } catch {}
        }
      }
      try { delete root[BINDING_NAME]; } catch {}
      return { status: 'missing', reason: 'dispatch-guard-missing', lastEvent: null };
    }
    const verdict = {
      status: state.status,
      reason: state.reason || null,
      lastEvent: state.lastEvent || null,
    };
    try { state.cleanup?.(); } catch {}
    return verdict;
  })()`;
}

/**
 * Build the read-only route probe for the final, synchronous dispatch-boundary
 * evaluation. The caller combines this with the bound send-target check in one
 * Runtime.evaluate task so React cannot change model/mode labels between the
 * two observations.
 */
export function buildGpt56SolProFinalDispatchGuard(
  attachmentBindingToken?: string,
  composerBindingToken?: string,
  options: {
    requireProtectedRoute?: boolean;
    exactSubmission?: ExactSubmissionExpectation;
  } = {},
): FinalPreDispatchDomGuard {
  const requireProtectedRoute = options.requireProtectedRoute ?? true;
  const verdictBindingName = `__oracleProtectedDispatchVerdict_${randomUUID().replaceAll("-", "")}`;
  const verdictNonce = randomUUID();
  const evidenceFromInstallResult = (value: unknown): Gpt56SolProReadOnlyRouteEvidence | null => {
    if (!value || typeof value !== "object") return null;
    const result = value as { routeProof?: unknown };
    const probe = parseChatGptProDomProbe(result.routeProof);
    return probe ? classifyGpt56SolProRouteProbe(probe) : null;
  };
  return {
    expression: buildProtectedDispatchGuardInstallExpression(
      attachmentBindingToken,
      composerBindingToken,
      verdictBindingName,
      verdictNonce,
      { requireProtectedRoute, exactSubmission: options.exactSubmission },
    ),
    verdictBinding: {
      name: verdictBindingName,
      parsePayload(payload: string): unknown | undefined {
        try {
          const value = JSON.parse(payload) as Record<string, unknown>;
          if (
            value.version !== 1 ||
            value.nonce !== verdictNonce ||
            value.token !== (composerBindingToken ?? "") ||
            (value.status !== "allowed" && value.status !== "blocked")
          ) {
            return undefined;
          }
          return value;
        } catch {
          return undefined;
        }
      },
    },
    assertResult(value: unknown): void {
      const result =
        value && typeof value === "object"
          ? (value as {
              installed?: unknown;
              status?: unknown;
              reason?: unknown;
              exactPromptVerified?: unknown;
              attachmentStateVerified?: unknown;
              focusVerified?: unknown;
            })
          : null;
      const evidence = evidenceFromInstallResult(value);
      const routeVerified = !requireProtectedRoute || evidence?.verified === true;
      const exactVerified =
        !options.exactSubmission ||
        (result?.exactPromptVerified === true &&
          result.attachmentStateVerified === true &&
          result.focusVerified === true);
      if (
        result?.installed === true &&
        result.status === "armed" &&
        routeVerified &&
        exactVerified
      ) {
        return;
      }
      throw new BrowserAutomationError(
        options.exactSubmission
          ? "The exact ChatGPT submission changed after protected preflight; refusing to dispatch."
          : "GPT-5.6 Sol + Pro changed after protected preflight; refusing to dispatch.",
        {
          stage: "model-selection",
          code: "protected-route-changed-after-preflight",
          composerBindingVerified: evidence?.composerBindingVerified === true,
          modelVerified: evidence?.modelVerified === true,
          modeVerified: evidence?.modeVerified === true,
          modelSignals: evidence?.modelSignals ?? [],
          modeSignals: evidence?.modeSignals ?? [],
          guardInstalled: result?.installed === true,
          guardStatus: typeof result?.status === "string" ? result.status : null,
          guardReason: typeof result?.reason === "string" ? result.reason : null,
          exactPromptVerified: result?.exactPromptVerified === true,
          attachmentStateVerified: result?.attachmentStateVerified === true,
          focusVerified: result?.focusVerified === true,
        },
      );
    },
    immediatelyBeforeDispatchExpression:
      buildProtectedDispatchGuardStatusExpression(composerBindingToken),
    assertImmediatelyBeforeDispatchResult(value: unknown): void {
      const result =
        value && typeof value === "object"
          ? (value as { status?: unknown; reason?: unknown; lastEvent?: unknown })
          : null;
      if (result?.status === "armed") return;
      throw new BrowserAutomationError(
        "The protected dispatch guard was no longer armed immediately before input; refusing to click.",
        {
          stage: "model-selection",
          code: "protected-dispatch-guard-not-armed",
          retryable: true,
          guardStatus: typeof result?.status === "string" ? result.status : null,
          guardReason: typeof result?.reason === "string" ? result.reason : null,
          guardLastEvent: typeof result?.lastEvent === "string" ? result.lastEvent : null,
        },
      );
    },
    afterDispatchExpression: buildProtectedDispatchGuardVerdictExpression(
      composerBindingToken,
      verdictBindingName,
    ),
    assertAfterDispatchResult(value: unknown): void {
      const result =
        value && typeof value === "object"
          ? (value as { status?: unknown; reason?: unknown; lastEvent?: unknown })
          : null;
      if (result?.status === "allowed" && result.lastEvent === "click") return;
      throw new BrowserAutomationError(
        result?.status === "blocked"
          ? "The protected ChatGPT submission changed during trusted dispatch; the click was blocked."
          : "Protected dispatch could not prove that its page guard observed the trusted click.",
        {
          stage: "model-selection",
          code:
            result?.status === "blocked"
              ? "protected-route-dispatch-blocked"
              : "protected-route-dispatch-unproven",
          retryable: false,
          dispatchGuardStatus: typeof result?.status === "string" ? result.status : null,
          dispatchGuardReason: typeof result?.reason === "string" ? result.reason : null,
          dispatchGuardLastEvent: typeof result?.lastEvent === "string" ? result.lastEvent : null,
        },
      );
    },
    isDispatchDefinitelyBlocked(value: unknown): boolean {
      return Boolean(
        value && typeof value === "object" && (value as { status?: unknown }).status === "blocked",
      );
    },
  };
}

export function classifyGpt56SolProRouteProbeForTest(args: {
  routeModelSignals?: readonly string[];
  routeModeSignals?: readonly string[];
  hasProPill?: boolean;
  composerBindingVerified?: boolean;
}): Gpt56SolProReadOnlyRouteEvidence {
  return classifyGpt56SolProRouteProbe({
    routeModelSignals: args.routeModelSignals ?? [],
    routeModeSignals: args.routeModeSignals ?? [],
    hasProPill: args.hasProPill === true,
    composerBindingVerified: args.composerBindingVerified !== false,
  });
}

export function buildChatGptProDomProbeExpressionForTest(
  attachmentBindingToken?: string,
  composerBindingToken?: string,
): string {
  return buildChatGptProDomProbeExpression(attachmentBindingToken, composerBindingToken);
}

function buildSynthesisGateInput(
  ctx: ProviderDomFlowContext,
  machine: ChatGptProMachine,
  probe: ChatGptProDomProbe | null,
  options: WireChatGptProFsmOptions,
) {
  const overrides = chatGptProOverrides(ctx);
  const now = (options.now?.() ?? new Date()).toISOString();
  const sessionIdHash = machine.context.sessionIdHash;
  const liveTab: ChatGptProSynthesisLiveTab = {
    targetId: probe?.targetId ?? null,
    url: probe?.url ?? null,
    conversationId: probe?.conversationId ?? null,
    currentModelLabel: machine.context.modelLabel ?? probe?.modelLabel ?? null,
    authenticated: probe?.authenticated ?? true,
    promptReady: probe?.promptReady ?? true,
    sendExists: probe?.sendExists ?? true,
    state: "completed",
    fingerprint: probe?.fingerprint ?? null,
    observedAt: now,
    ...(overrides?.liveTab ?? {}),
  };
  const session: ChatGptProSynthesisSessionState = {
    sessionIdHash,
    liveSessionIdHash: sessionIdHash,
    verifiedAt: now,
    lastActivityAt: now,
    now,
    verifiedTargetId: liveTab.targetId ?? null,
    liveTargetId: liveTab.targetId ?? null,
    ...(overrides?.session ?? {}),
  };
  return {
    slot: "chatgpt_pro_synthesis",
    providerFamily: "chatgpt",
    accessPath: resolveAccessPath(ctx, options),
    machine,
    liveTab,
    cookies: overrides?.cookies ?? {
      required: false,
      remoteBrowser: resolveMode(ctx, options) === "remote",
      appliedCount: liveTab.authenticated ? 1 : 0,
      source: "browser-session",
    },
    session,
  } as const;
}

export function wireChatGptProFsm(
  adapter: ProviderDomAdapter,
  options: WireChatGptProFsmOptions = {},
): WiredChatGptProAdapter {
  let machine: ChatGptProMachine = createChatGptProMachine();
  let lastProbe: ChatGptProDomProbe | null = null;
  let lastGateDecision: ChatGptProSynthesisGateDecision | null = null;
  const promptHash = options.promptSha256 ?? ((text: string) => sha256OfBytes(text));
  const outputHash = options.outputSha256 ?? ((text: string) => sha256OfBytes(text));

  const send = (event: ChatGptProEvent): void => {
    machine = machine.send(event);
    options.onTransition?.(machine);
  };

  return {
    providerName: adapter.providerName,

    async waitForUi(ctx: ProviderDomFlowContext) {
      if (!chatGptProVerificationEnabled(ctx)) {
        await adapter.waitForUi(ctx);
        return;
      }
      machine = createChatGptProMachine();
      lastProbe = null;
      lastGateDecision = null;
      send({ type: "browser_connected", mode: resolveMode(ctx, options) });
      try {
        await adapter.waitForUi(ctx);
      } catch (err) {
        const kind = classifyChatGptAdapterError(err);
        if (kind === "login_required") {
          send({ type: "login_required" });
        } else {
          send({
            type: "ui_drift_observed",
            detail: err instanceof Error ? err.message : String(err),
          });
        }
        throw err;
      }
      send({ type: "login_verified" });
    },

    async selectMode(ctx: ProviderDomFlowContext) {
      if (!chatGptProVerificationEnabled(ctx)) {
        if (adapter.selectMode) await adapter.selectMode(ctx);
        return;
      }
      send({ type: "model_menu_opened" });
      try {
        if (adapter.selectMode) await adapter.selectMode(ctx);
        lastProbe = await resolveChatGptProProbe(ctx);
      } catch (err) {
        send({
          type: "ui_drift_observed",
          detail: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
      send({ type: "pro_candidate_selected", modelLabel: lastProbe.modelLabel });
      throwIfChatGptProFailure(machine);
      send({ type: "effort_candidate_selected", observedEffortLabels: lastProbe.effortLabels });
      throwIfChatGptProFailure(machine);
      send({
        type: "mode_verified_same_session",
        sessionIdHash: resolveSessionIdHash(ctx, adapter, options),
      });
      throwIfChatGptProFailure(machine);
    },

    typePrompt: (ctx: ProviderDomFlowContext) => adapter.typePrompt(ctx),

    async submitPrompt(ctx: ProviderDomFlowContext) {
      if (!chatGptProVerificationEnabled(ctx)) {
        await adapter.submitPrompt(ctx);
        return;
      }
      if (machine.state !== "mode_verified_same_session") {
        send({ type: "submit_prompt", promptSha256: promptHash(ctx.prompt) });
        throw new ChatGptProFsmError(machineVerdict(machine));
      }
      lastGateDecision = assertChatGptProSynthesisReady(
        buildSynthesisGateInput(ctx, machine, lastProbe, options),
      );
      send({ type: "submit_prompt", promptSha256: promptHash(ctx.prompt) });
      throwIfChatGptProFailure(machine);
      await adapter.submitPrompt(ctx);
    },

    async waitForResponse(ctx: ProviderDomFlowContext) {
      if (!chatGptProVerificationEnabled(ctx)) {
        return await adapter.waitForResponse(ctx);
      }
      const response = await adapter.waitForResponse(ctx);
      send({
        type: "response_arrived",
        outputTextSha256: outputHash(response.text),
        bytesLength: Buffer.byteLength(response.text, "utf8"),
      });
      throwIfChatGptProFailure(machine);
      return response;
    },

    extractThoughts: adapter.extractThoughts
      ? (ctx: ProviderDomFlowContext) => adapter.extractThoughts!(ctx)
      : undefined,

    getMachine: () => machine,
    getVerdict: () => machineVerdict(machine),
    getLastSynthesisGateDecision: () => lastGateDecision,
  };
}

export const chatgptDomProvider: WiredChatGptProAdapter = wireChatGptProFsm(chatgptDomProviderBase);

export function chatgptDomProviderWithFsm(): WiredChatGptProAdapter {
  return wireChatGptProFsm(chatgptDomProviderBase);
}

export type { ChatGptProState };

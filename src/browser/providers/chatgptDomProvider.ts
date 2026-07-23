import type { BrowserLogger, ChromeClient } from "../types.js";
import type { ProviderDomAdapter, ProviderDomFlowContext } from "../providerDomFlow.js";
import { ensurePromptReady } from "../actions/navigation.js";
import { assertPreRunAccessState } from "../actions/challengeDetection.js";
import { submitPrompt, type AttachmentReadyExpectation } from "../actions/promptComposer.js";
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
  beforePromptSubmit?: (composerBindingToken?: string) => Promise<void> | void;
  requireBoundSendTarget?: boolean;
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
      beforePromptSubmit: async (composerBindingToken) => {
        // Re-check the shared account latch and live page at the final
        // pre-dispatch boundary. Another lane may have quarantined this
        // account while this one was typing/uploading.
        await assertPreRunAccessState(state.runtime, state.logger, {
          quarantine: { accountId: state.accountId },
        });
        await state.beforePromptSubmit?.(composerBindingToken);
      },
      requireBoundSendTarget: state.requireBoundSendTarget,
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
  const value = result.result?.value;
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

import { randomUUID } from "node:crypto";
import type { BrowserLogger, ChromeClient } from "../types.js";
import type { ProviderDomAdapter, ProviderDomFlowContext } from "../providerDomFlow.js";
import { INPUT_SELECTORS, SEND_BUTTON_SELECTORS } from "../constants.js";
import { ensurePromptReady } from "../actions/navigation.js";
import { buildClickDispatcher } from "../actions/domEvents.js";
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
  privateModelProofAttempted: boolean;
  privateModelProofValid: boolean;
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
    privateModelProofAttempted: domProbe?.privateModelProofAttempted === true,
    privateModelProofValid: domProbe?.privateModelProofValid !== false,
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
    privateModelProofAttempted: probe.privateModelProofAttempted === true,
    privateModelProofValid: probe.privateModelProofValid === true,
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
    const isBareProLabel = (label) => normalize(label).toLowerCase() === 'pro';
    const effortLikeComposerPills = composerPillTexts.filter((label) =>
      /\\b(extended\\s+pro|pro\\s+extended|heavy|ultra|max|standard|light)\\b/i.test(label)
    );
    const modelLikeComposerPill =
      composerPillTexts.find(
        (label) =>
          !isBareProLabel(label) && /\\b(pro|gpt|chatgpt|thinking|instant)\\b/i.test(label)
      ) || '';
    const composerModelNode = queryVisible(routeRoot, [
      '[data-testid="composer-model-label"]',
      '[data-testid="model-label"]',
    ])[0];
    const composerModel = normalize(composerModelNode?.textContent || '');
    const modelButtonText = firstText(MODEL_PICKER_BUTTONS);
    // The current unified Intelligence picker collapses to a bare "Pro" pill.
    // That is a mode signal, never evidence for which versioned model owns it.
    const buttonModel = isBareProLabel(modelButtonText)
      ? modelLikeComposerPill
      : (modelButtonText || modelLikeComposerPill);
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
    const publicModelSignals = Array.from(new Set([
      fixtureModel,
      selectedModel,
      composerModel,
      buttonModel,
    ].map(normalize).filter(Boolean)));
    // Framework-private state is intentionally excluded from authorization.
    // Closed-composer public labels remain useful diagnostics, while the
    // protected Send path gets its authoritative model evidence by opening the
    // exact pill's causally owned public submenu after the last composer
    // mutation (see buildProtectedRouteProofMintExpression below).
    const privateModelProof = { attempted: false, valid: true };
    const routeModelSignals = publicModelSignals;
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
    const baseModel =
      fixtureModel || selectedModel || composerModel || buttonModel || routeModelSignals[0];
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
      privateModelProofAttempted: privateModelProof.attempted,
      privateModelProofValid: privateModelProof.valid,
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

export interface Gpt56SolProPublicRouteEvidence {
  readonly verified: boolean;
  readonly reason: string | null;
  readonly composerBindingVerified: boolean;
  readonly modelVerified: boolean;
  readonly modeVerified: boolean;
  readonly modelSignals: readonly string[];
  readonly modeSignals: readonly string[];
  readonly privateModelProofAttempted: boolean;
  readonly privateModelProofValid: boolean;
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
    | "routeModelSignals"
    | "routeModeSignals"
    | "privateModelProofAttempted"
    | "privateModelProofValid"
    | "hasProPill"
    | "composerBindingVerified"
  >,
): Gpt56SolProPublicRouteEvidence {
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
    reason: null,
    composerBindingVerified: probe.composerBindingVerified,
    modelVerified,
    modeVerified,
    modelSignals,
    modeSignals,
    privateModelProofAttempted: probe.privateModelProofAttempted,
    privateModelProofValid: probe.privateModelProofValid,
  };
}

const PROTECTED_ROUTE_PROOF_REGISTRY = "__oracleProtectedPublicRouteProofsV1";
const PROTECTED_ROUTE_PROOF_TTL_MS = 10_000;
const PROTECTED_DISPATCH_GUARD_REGISTRY = "__oracleProtectedDispatchGuardsV3";
const PROTECTED_DISPATCH_GUARD_TTL_MS = 15_000;

function buildProtectedRouteProofMintExpression(
  attachmentBindingToken?: string,
  composerBindingToken?: string,
  proofNonce?: string,
): string {
  const attachmentTokenLiteral = JSON.stringify(attachmentBindingToken ?? "");
  const composerTokenLiteral = JSON.stringify(composerBindingToken ?? "");
  const proofNonceLiteral = JSON.stringify(proofNonce ?? "");
  const proofRegistryLiteral = JSON.stringify(PROTECTED_ROUTE_PROOF_REGISTRY);
  const proofTtlLiteral = JSON.stringify(PROTECTED_ROUTE_PROOF_TTL_MS);
  const inputSelectorsLiteral = JSON.stringify(INPUT_SELECTORS);
  const sendSelectorsLiteral = JSON.stringify(SEND_BUTTON_SELECTORS);
  return `(async () => {
    const ATTACHMENT_TOKEN = ${attachmentTokenLiteral};
    const TOKEN = ${composerTokenLiteral};
    const NONCE = ${proofNonceLiteral};
    const REGISTRY_KEY = ${proofRegistryLiteral};
    const TTL_MS = ${proofTtlLiteral};
    const INPUT_SELECTORS = ${inputSelectorsLiteral};
    const SEND_SELECTORS = ${sendSelectorsLiteral};
    const MODEL_LABEL = 'GPT-5.6 Sol';
    const MODE_LABEL = 'Pro';
    const root = window;
    ${buildClickDispatcher("activatePublicRouteControl")}
    const normalizeRenderedPromptDomIdentity = ${normalizeRenderedPromptDomIdentity.toString()};
    const exactText = (node) => String(
      node?.innerText || node?.textContent || node?.getAttribute?.('aria-label') || ''
    ).normalize('NFC').replace(/\\s+/g, ' ').trim();
    const isVisible = (node) => {
      if (!node || node.isConnected === false || typeof node.getBoundingClientRect !== 'function') {
        return false;
      }
      const rect = node.getBoundingClientRect();
      if (!(rect.width > 0 && rect.height > 0)) return false;
      if (typeof node.getClientRects === 'function' && node.getClientRects().length === 0) return false;
      let current = node;
      while (current && current !== document.documentElement?.parentElement) {
        const style = root.getComputedStyle?.(current);
        if (
          current.hidden === true ||
          current.hasAttribute?.('inert') ||
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
    const isEnabled = (node) => Boolean(
      node &&
      !node.hasAttribute?.('disabled') &&
      node.getAttribute?.('aria-disabled') !== 'true' &&
      node.getAttribute?.('data-disabled') !== 'true'
    );
    const unique = (values) => Array.from(new Set(values));
    const queryAll = (scope, selectors) => unique(selectors.flatMap((selector) =>
      Array.from(scope?.querySelectorAll?.(selector) ?? [])
    ));
    const readEditorValue = (editor) => {
      if (editor instanceof HTMLTextAreaElement || editor instanceof HTMLInputElement) {
        return editor.value || '';
      }
      return editor?.innerText ?? editor?.textContent ?? '';
    };
    const locate = () => {
      const composers = TOKEN
        ? Array.from(document.querySelectorAll('[data-oracle-send-composer-binding]')).filter(
            (node) => node?.getAttribute?.('data-oracle-send-composer-binding') === TOKEN,
          )
        : [];
      const composer = composers.length === 1 ? composers[0] : null;
      const editors = TOKEN
        ? Array.from(document.querySelectorAll('[data-oracle-send-editor-binding]')).filter(
            (node) => node?.getAttribute?.('data-oracle-send-editor-binding') === TOKEN,
          )
        : [];
      const editor = editors.length === 1 ? editors[0] : null;
      const markedSends = TOKEN
        ? Array.from(document.querySelectorAll('[data-oracle-send-binding]')).filter(
            (node) => node?.getAttribute?.('data-oracle-send-binding') === TOKEN,
          )
        : [];
      const send = markedSends.length === 1 ? markedSends[0] : null;
      const currentSends = composer
        ? queryAll(composer, SEND_SELECTORS).filter((node) => isVisible(node) && isEnabled(node))
        : [];
      const activeInputs = composer
        ? queryAll(composer, INPUT_SELECTORS).filter(isVisible)
        : [];
      const pills = composer
        ? Array.from(composer.querySelectorAll('button.__composer-pill[aria-haspopup="menu"]'))
            .filter(isVisible)
            .filter((node) => exactText(node) === MODE_LABEL)
        : [];
      const pill = pills.length === 1 ? pills[0] : null;
      const attachmentRoots = ATTACHMENT_TOKEN
        ? Array.from(document.querySelectorAll('[data-oracle-attachment-binding]')).filter(
            (node) => node?.getAttribute?.('data-oracle-attachment-binding') === ATTACHMENT_TOKEN,
          )
        : [];
      const attachmentRoot = ATTACHMENT_TOKEN && attachmentRoots.length === 1
        ? attachmentRoots[0]
        : null;
      const ok = Boolean(
        TOKEN && NONCE && composer && editor && send && pill &&
        composer.isConnected !== false &&
        composer.contains?.(editor) && composer.contains?.(send) && composer.contains?.(pill) &&
        activeInputs.length === 1 && activeInputs[0] === editor &&
        currentSends.length === 1 && currentSends[0] === send &&
        exactText(pill) === MODE_LABEL &&
        isVisible(editor) && isVisible(send) && isEnabled(send) &&
        (!ATTACHMENT_TOKEN || attachmentRoot === composer)
      );
      return { ok, composer, editor, send, pill, attachmentRoot };
    };
    const menuRoots = () => Array.from(
      document.querySelectorAll('[role="menu"], [role="listbox"]')
    ).filter(isVisible);
    const rowSelector = '[role="menuitemradio"], [role="radio"], [role="option"]';
    const belongsToOwner = (node, owner) => {
      let current = node;
      while (current && current !== owner) {
        current = current.parentElement;
        if (
          current && current !== owner &&
          (current.getAttribute?.('role') === 'menu' || current.getAttribute?.('role') === 'listbox')
        ) return false;
      }
      return current === owner;
    };
    const ownedRows = (owner) => Array.from(owner?.querySelectorAll?.(rowSelector) ?? [])
      .filter((node) => belongsToOwner(node, owner));
    const ownedSubmenuTriggers = (owner) => Array.from(
      owner?.querySelectorAll?.('[aria-haspopup="menu"]') ?? []
    ).filter((node) => belongsToOwner(node, owner));
    const menuLike = (node) => Boolean(
      node &&
      (ownedRows(node).length > 0 || ownedSubmenuTriggers(node).length > 0)
    );
    const duplicateFreeIdNode = (id) => {
      if (!id) return null;
      const matches = Array.from(document.querySelectorAll('[id]')).filter(
        (node) => node.getAttribute?.('id') === id,
      );
      return matches.length === 1 ? matches[0] : null;
    };
    const controlledOwner = (trigger) => {
      if (!trigger || trigger.getAttribute?.('aria-expanded') !== 'true') return null;
      const id = trigger.getAttribute?.('aria-controls') || '';
      const controlled = duplicateFreeIdNode(id);
      if (!controlled || !isVisible(controlled)) return null;
      const controlledRole = controlled.getAttribute?.('role');
      const controlledIsOwner =
        controlledRole === 'menu' ||
        controlledRole === 'listbox' ||
        controlled.getAttribute?.('data-testid') === 'composer-intelligence-picker-content';
      if (controlledIsOwner && menuLike(controlled)) return controlled;
      const descendants = Array.from(
        controlled.querySelectorAll?.('[role="menu"], [role="listbox"], [data-testid="composer-intelligence-picker-content"]') ?? []
      ).filter((node) => isVisible(node) && menuLike(node));
      const topLevel = descendants.filter((candidate) =>
        !descendants.some(
          (other) => other !== candidate && other.contains?.(candidate),
        )
      );
      return topLevel.length === 1 ? topLevel[0] : null;
    };
    const raf = () => new Promise((resolve) => {
      if (typeof root.requestAnimationFrame === 'function') root.requestAnimationFrame(() => resolve());
      else root.setTimeout?.(resolve, 0);
    });
    const settle = async () => {
      await raf();
      await raf();
      if (typeof MutationObserver !== 'function' || typeof root.setTimeout !== 'function') {
        await new Promise((resolve) => root.setTimeout?.(resolve, 40));
        return;
      }
      await new Promise((resolve) => {
        let quietId = null;
        let maxId = null;
        const done = () => {
          try { observer.disconnect(); } catch {}
          try { if (quietId != null) root.clearTimeout?.(quietId); } catch {}
          try { if (maxId != null) root.clearTimeout?.(maxId); } catch {}
          resolve();
        };
        const armQuiet = () => {
          try { if (quietId != null) root.clearTimeout?.(quietId); } catch {}
          quietId = root.setTimeout?.(done, 50);
        };
        const observer = new MutationObserver(armQuiet);
        try {
          observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true });
          armQuiet();
          maxId = root.setTimeout?.(done, 750);
        } catch {
          done();
        }
      });
    };
    const activate = (node) => {
      if (!node || !isVisible(node) || !isEnabled(node)) return false;
      try { return activatePublicRouteControl(node) === true; } catch { return false; }
    };
    const hover = (node) => {
      if (!node || typeof node.dispatchEvent !== 'function' || typeof MouseEvent !== 'function') {
        return;
      }
      const rect = node.getBoundingClientRect?.();
      const clientX = Number(rect?.left || 0) + Number(rect?.width || 0) / 2;
      const clientY = Number(rect?.top || 0) + Number(rect?.height || 0) / 2;
      for (const type of [
        'pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'pointermove', 'mousemove',
      ]) {
        try {
          const common = { bubbles: true, composed: true, clientX, clientY, view: root };
          const event = type.startsWith('pointer') && typeof PointerEvent === 'function'
            ? new PointerEvent(type, { ...common, pointerId: 1, pointerType: 'mouse' })
            : new MouseEvent(type, common);
          node.dispatchEvent(event);
        } catch {}
      }
    };
    const resolveOwnedMenuAfterOpen = async (reacquire) => {
      let trigger = reacquire();
      if (!trigger || !isVisible(trigger)) return null;
      const waitForControlledOwner = async (attempts) => {
        for (let attempt = 0; attempt < attempts; attempt += 1) {
          const current = reacquire();
          if (!current || !isVisible(current)) return null;
          if (
            current.getAttribute?.('aria-expanded') === 'true' &&
            current.getAttribute?.('aria-controls')
          ) {
            const owner = controlledOwner(current);
            if (owner) return {
              trigger: current,
              owner,
              ownership: 'aria-controls',
              controlId: current.getAttribute?.('aria-controls') || '',
            };
          }
          await new Promise((resolve) => root.setTimeout?.(resolve, 50));
        }
        return null;
      };
      if (trigger.getAttribute?.('aria-expanded') === 'true') {
        if (trigger.getAttribute?.('aria-controls')) {
          return await waitForControlledOwner(12);
        }
        if (!activate(trigger)) return null;
        await settle();
        trigger = reacquire();
        if (!trigger || trigger.getAttribute?.('aria-expanded') === 'true') {
          return null;
        }
      }
      const before = new Set(menuRoots());
      if (!activate(trigger)) return null;
      await settle();
      const waitForOpenOwner = async (attempts) => {
        for (let attempt = 0; attempt < attempts; attempt += 1) {
          const current = reacquire();
          if (current?.getAttribute?.('aria-expanded') === 'true') {
            if (current.getAttribute?.('aria-controls')) {
              if (controlledOwner(current)) return current;
            } else {
              const after = menuRoots();
              const removed = Array.from(before).filter((menu) => !after.includes(menu));
              const added = after.filter((menu) => !before.has(menu));
              if (removed.length === 0 && added.length === 1 && menuLike(added[0])) {
                return current;
              }
            }
          }
          await new Promise((resolve) => root.setTimeout?.(resolve, 50));
        }
        return null;
      };
      trigger = await waitForOpenOwner(2);
      if (!trigger) {
        const hoverTarget = reacquire();
        if (!hoverTarget) return null;
        hover(hoverTarget);
        trigger = await waitForOpenOwner(12);
      }
      if (!trigger) return null;
      if (trigger.getAttribute?.('aria-controls')) {
        const owner = controlledOwner(trigger);
        return owner ? {
          trigger,
          owner,
          ownership: 'aria-controls',
          controlId: trigger.getAttribute?.('aria-controls') || '',
        } : null;
      }
      const after = menuRoots();
      const removed = Array.from(before).filter((menu) => !after.includes(menu));
      const added = after.filter((menu) => !before.has(menu));
      return removed.length === 0 && added.length === 1 && menuLike(added[0])
        ? {
            trigger,
            owner: added[0],
            ownership: 'newly-visible',
            controlId: '',
          }
        : null;
    };
    const resolveBoundOwner = (binding, reacquire) => {
      const trigger = reacquire();
      if (!trigger || !isVisible(trigger) || trigger.getAttribute?.('aria-expanded') !== 'true') {
        return null;
      }
      if (binding.ownership === 'aria-controls') {
        if (
          !binding.controlId ||
          trigger.getAttribute?.('aria-controls') !== binding.controlId
        ) return null;
        return controlledOwner(trigger);
      }
      if (trigger.getAttribute?.('aria-controls')) return null;
      return menuRoots().filter((root) => root === binding.owner).length === 1 &&
        menuLike(binding.owner)
        ? binding.owner
        : null;
    };
    const checkedState = (row) => {
      const aria = row?.getAttribute?.('aria-checked');
      const data = String(row?.getAttribute?.('data-state') || '').toLowerCase();
      const ariaKnown = aria === 'true' || aria === 'false';
      const dataKnown = data === 'checked' || data === 'unchecked';
      const ariaChecked = aria === 'true';
      const dataChecked = data === 'checked';
      const optionalMarkers = [
        row?.getAttribute?.('aria-selected'),
        row?.getAttribute?.('aria-current'),
        row?.getAttribute?.('data-selected'),
      ].filter((value) => value !== null && value !== undefined);
      const optionalKnown = optionalMarkers.every((value) => value === 'true' || value === 'false');
      const optionalAgree = optionalMarkers.every((value) => (value === 'true') === ariaChecked);
      return {
        valid:
          ariaKnown && dataKnown && ariaChecked === dataChecked && optionalKnown && optionalAgree,
        checked: ariaChecked && dataChecked,
      };
    };
    const verifyCheckedRadio = (owner, expectedLabel) => {
      if (!owner || !isVisible(owner)) return { ok: false, reason: 'owned-menu-not-visible' };
      const rows = ownedRows(owner);
      const exactRows = rows.filter((row) => exactText(row) === expectedLabel);
      if (exactRows.length !== 1 || !isVisible(exactRows[0])) {
        return { ok: false, reason: 'exact-row-ambiguous' };
      }
      const states = rows.filter(isVisible).map((row) => ({ row, state: checkedState(row) }));
      if (states.some(({ state }) => !state.valid)) {
        return { ok: false, reason: 'row-selection-state-contradictory' };
      }
      const checked = states.filter(({ state }) => state.checked);
      if (checked.length !== 1 || checked[0].row !== exactRows[0]) {
        return { ok: false, reason: 'checked-row-not-exact' };
      }
      return { ok: true, row: exactRows[0] };
    };
    const findSolTrigger = (owner) => {
      const candidates = Array.from(owner?.querySelectorAll?.('[aria-haspopup="menu"]') ?? [])
        .filter((node) => belongsToOwner(node, owner) && exactText(node) === MODEL_LABEL);
      return candidates.length === 1 && isVisible(candidates[0]) && isEnabled(candidates[0])
        ? candidates[0]
        : null;
    };
    const closeProofMenus = async () => {
      let current = locate().pill;
      if (current?.getAttribute?.('aria-expanded') === 'true') {
        activate(current);
        await settle();
      }
      current = locate().pill;
      if (current?.getAttribute?.('aria-expanded') === 'true') {
        try {
          document.dispatchEvent?.(new KeyboardEvent('keydown', {
            key: 'Escape', code: 'Escape', bubbles: true, composed: true,
          }));
        } catch {}
        await settle();
      }
      current = locate().pill;
      return Boolean(current && current.getAttribute?.('aria-expanded') !== 'true');
    };
    const fail = (reason) => ({
      verified: false,
      composerBindingVerified: locate().ok,
      modelVerified: false,
      modeVerified: false,
      modelSignals: [],
      modeSignals: [],
      proofMinted: false,
      reason,
    });
    if (!TOKEN || !NONCE) return fail('public-route-proof-token-missing');
    let registry = root[REGISTRY_KEY];
    if (!(registry instanceof Map)) {
      registry = new Map();
      root[REGISTRY_KEY] = registry;
    }
    try { registry.get(TOKEN)?.burn?.('superseded'); } catch {}
    registry.delete(TOKEN);

    let proved = null;
    let lastReason = 'public-route-proof-unavailable';
    for (let attempt = 0; attempt < 2 && !proved; attempt += 1) {
      const located = locate();
      if (!located.ok) {
        lastReason = 'exact-dispatch-composer-unavailable';
        break;
      }
      const { composer, editor, send, attachmentRoot } = located;
      const parentBinding = await resolveOwnedMenuAfterOpen(() => locate().pill);
      const readParentProof = () => {
        const owner = parentBinding
          ? resolveBoundOwner(parentBinding, () => locate().pill)
          : null;
        if (!owner) return { ok: false, reason: 'parent-menu-owner-unverified' };
        const pro = verifyCheckedRadio(owner, MODE_LABEL);
        const solTrigger = findSolTrigger(owner);
        if (!pro.ok || !solTrigger) {
          return {
            ok: false,
            reason: !pro.ok ? pro.reason : 'sol-submenu-trigger-ambiguous',
          };
        }
        return { ok: true, owner, pro, solTrigger };
      };
      let parent = readParentProof();
      if (!parentBinding || !parent.ok || locate().composer !== composer) {
        lastReason = 'parent-menu-owner-unverified';
        await closeProofMenus();
        continue;
      }
      const getSolTrigger = () => {
        const current = readParentProof();
        return current.ok ? current.solTrigger : null;
      };
      const modelBinding = await resolveOwnedMenuAfterOpen(getSolTrigger);
      const readModelProof = () => {
        const owner = modelBinding ? resolveBoundOwner(modelBinding, getSolTrigger) : null;
        if (!owner) return { ok: false, reason: 'model-submenu-owner-unverified' };
        const model = verifyCheckedRadio(owner, MODEL_LABEL);
        return model.ok
          ? { ok: true, owner, model }
          : { ok: false, reason: model.reason };
      };
      if (!modelBinding || locate().composer !== composer) {
        lastReason = 'model-submenu-owner-unverified';
        await closeProofMenus();
        continue;
      }
      parent = readParentProof();
      const model = readModelProof();
      if (!parent.ok || !model.ok) {
        lastReason = !parent.ok ? parent.reason : model.reason;
        await closeProofMenus();
        continue;
      }
      const provedOpenPill = locate().pill;
      if (!provedOpenPill || !isVisible(provedOpenPill)) {
        lastReason = 'proved-route-pill-unavailable';
        await closeProofMenus();
        continue;
      }
      if (!(await closeProofMenus())) {
        lastReason = 'proof-menus-did-not-close';
        continue;
      }
      const finalLocated = locate();
      if (
        !finalLocated.ok ||
        finalLocated.composer !== composer ||
        finalLocated.editor !== editor ||
        finalLocated.send !== send ||
        finalLocated.pill !== provedOpenPill ||
        finalLocated.attachmentRoot !== attachmentRoot
      ) {
        lastReason = 'dispatch-composer-remounted-during-proof';
        continue;
      }
      try { editor.focus?.({ preventScroll: true }); } catch { try { editor.focus?.(); } catch {} }
      await settle();
      const rebound = locate();
      if (
        !rebound.ok || rebound.composer !== composer || rebound.editor !== editor ||
        rebound.send !== send || rebound.pill !== finalLocated.pill ||
        rebound.attachmentRoot !== attachmentRoot ||
        document.activeElement !== editor
      ) {
        lastReason = 'dispatch-composer-focus-rebind-failed';
        continue;
      }
      proved = {
        composer, editor, send, pill: provedOpenPill, attachmentRoot,
        parentMenu: parent.owner,
        proRow: parent.pro.row,
        solTrigger: parent.solTrigger,
        modelMenu: model.owner,
        solRow: model.model.row,
      };
    }
    if (!proved) return fail(lastReason);

    const mintedAt = Date.now();
    const promptSnapshot = normalizeRenderedPromptDomIdentity(readEditorValue(proved.editor));
    const hrefSnapshot = String(root.location?.href || '');
    const closedMenuBaseline = menuRoots();
    const routeRefs = [
      proved.parentMenu, proved.proRow, proved.solTrigger, proved.modelMenu, proved.solRow,
    ];
    const boundRefs = [proved.composer, proved.editor, proved.send, proved.pill];
    let observer = null;
    let expiryId = null;
    let handoffExpiryId = null;
    let handoffCleanupId = null;
    const listeners = [];
    const proof = {
      version: 1,
      token: TOKEN,
      nonce: NONCE,
      status: 'valid',
      reason: null,
      mintedAt,
      expiresAt: mintedAt + TTL_MS,
      composer: proved.composer,
      editor: proved.editor,
      send: proved.send,
      pill: proved.pill,
      attachmentRoot: proved.attachmentRoot,
      promptSnapshot,
      hrefSnapshot,
      closedMenuBaseline,
      routeRefs,
      guardArmed: false,
      preGuardViolation: false,
      preGuardTerminalSeen: false,
      observer: null,
      armGuard: null,
      burn: null,
      validate: null,
      consume: null,
      cleanup: null,
    };
    const cleanup = () => {
      try { observer?.disconnect?.(); } catch {}
      observer = null;
      proof.observer = null;
      try { if (expiryId != null) root.clearTimeout?.(expiryId); } catch {}
      expiryId = null;
      for (const [target, type, listener] of listeners) {
        try { target.removeEventListener?.(type, listener, true); } catch {}
      }
      listeners.length = 0;
    };
    const handoffEventTypes = [
      'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'submit',
    ];
    const cleanupHandoffBlocker = () => {
      try { if (handoffExpiryId != null) root.clearTimeout?.(handoffExpiryId); } catch {}
      try { if (handoffCleanupId != null) root.clearTimeout?.(handoffCleanupId); } catch {}
      handoffExpiryId = null;
      handoffCleanupId = null;
      for (const type of handoffEventTypes) {
        try { root.removeEventListener?.(type, handoffBlocker, true); } catch {}
      }
    };
    const scheduleHandoffCleanup = () => {
      if (handoffCleanupId != null) return;
      handoffCleanupId = root.setTimeout?.(cleanupHandoffBlocker, 250) ?? null;
    };
    const handoffBlocker = (event) => {
      if (proof.guardArmed === true) return;
      const target = event?.target;
      const targetsProtectedSend = Boolean(
        event?.type !== 'submit' &&
        target && (target === proved.send || proved.send.contains?.(target))
      );
      const targetsProtectedSubmit = Boolean(
        event?.type === 'submit' &&
        target && (
          target === proved.composer ||
          proved.composer.contains?.(target) ||
          target.contains?.(proved.composer)
        )
      );
      if (!targetsProtectedSend && !targetsProtectedSubmit) return;
      proof.preGuardViolation = true;
      if (event?.type === 'click' || event?.type === 'submit') {
        proof.preGuardTerminalSeen = true;
        if (proof.status !== 'valid') scheduleHandoffCleanup();
      }
      try { event.preventDefault?.(); } catch {}
      try { event.stopImmediatePropagation?.(); } catch {}
      try { event.stopPropagation?.(); } catch {}
    };
    const removeProofRecord = () => {
      try {
        if (registry.get(TOKEN) === proof) registry.delete(TOKEN);
        if (root[REGISTRY_KEY] === registry && registry.size === 0) {
          delete root[REGISTRY_KEY];
        }
      } catch {}
    };
    const burn = (reason) => {
      if (proof.status !== 'valid') return false;
      proof.status = 'burned';
      proof.reason = reason || 'public-route-proof-burned';
      cleanup();
      if (!proof.preGuardViolation || proof.preGuardTerminalSeen) {
        scheduleHandoffCleanup();
      }
      removeProofRecord();
      return true;
    };
    const mutationTargetTouches = (node, ref) => Boolean(
      node && ref && (node === ref || ref.contains?.(node))
    );
    const mutationNodeContainsRef = (node, ref) => Boolean(
      node && ref && (node === ref || node.contains?.(ref))
    );
    const mutationRelevant = (mutation) => {
      const target = mutation?.target;
      // Hover/focus over Send may legitimately add tooltip children or change
      // cosmetic data-state. Continuity is still synchronously revalidated at
      // every trusted precursor and at the button-capture click, so observe
      // only payload/route surfaces plus identity- or enabledness-critical
      // attributes here rather than burning on every composer mutation.
      const attributeName = mutation?.attributeName;
      if (
        mutation?.type === 'attributes' &&
        target === proved.composer &&
        ['data-oracle-send-composer-binding', 'data-oracle-attachment-binding'].includes(attributeName)
      ) return true;
      if (
        mutation?.type === 'attributes' &&
        target === proved.send &&
        ['disabled', 'aria-disabled', 'data-disabled', 'data-oracle-send-binding'].includes(attributeName)
      ) return true;
      if (
        mutationTargetTouches(target, proved.editor) ||
        mutationTargetTouches(target, proved.pill)
      ) return true;
      if (routeRefs.some((ref) => mutationTargetTouches(target, ref))) return true;
      for (const node of [
        ...Array.from(mutation?.addedNodes ?? []),
        ...Array.from(mutation?.removedNodes ?? []),
      ]) {
        if (boundRefs.some((ref) => mutationNodeContainsRef(node, ref))) return true;
        if (routeRefs.some((ref) => mutationNodeContainsRef(node, ref))) return true;
        if (
          node?.getAttribute?.('role') === 'menu' ||
          node?.getAttribute?.('role') === 'listbox' ||
          node?.querySelector?.('[role="menu"], [role="listbox"]')
        ) return true;
      }
      return false;
    };
    const processMutations = (records) => {
      if (records.some(mutationRelevant)) burn('public-route-proof-dom-mutated');
    };
    const addListener = (target, type, listener) => {
      target?.addEventListener?.(type, listener, { capture: true, passive: false });
      listeners.push([target, type, listener]);
    };
    const routeEvent = (event) => {
      if (proof.status !== 'valid') return;
      const target = event?.target;
      const targetsProtectedSubmit = Boolean(
        event?.type === 'submit' &&
        target && (
          target === proved.composer ||
          proved.composer.contains?.(target) ||
          target.contains?.(proved.composer)
        )
      );
      if (targetsProtectedSubmit) {
        burn('public-route-proof-alternate-submit');
        try { event.preventDefault?.(); } catch {}
        try { event.stopImmediatePropagation?.(); } catch {}
        try { event.stopPropagation?.(); } catch {}
        return;
      }
      if (
        ['input', 'change', 'beforeinput', 'paste', 'drop'].includes(event?.type) &&
        target && proved.composer.contains?.(target)
      ) {
        burn('public-route-proof-payload-event');
        return;
      }
      if (event?.type === 'keydown') {
        burn('public-route-proof-key-event');
        try { event.preventDefault?.(); } catch {}
        try { event.stopImmediatePropagation?.(); } catch {}
        try { event.stopPropagation?.(); } catch {}
        return;
      }
      const routeControl = target?.closest?.(
        'button.__composer-pill, [aria-haspopup="menu"], [role="menu"], [role="listbox"]'
      );
      if (routeControl) burn('public-route-proof-route-event');
    };
    const navigationEvent = () => burn('public-route-proof-navigation');
    proof.cleanup = () => {
      cleanup();
      cleanupHandoffBlocker();
    };
    proof.armGuard = () => {
      if (proof.status !== 'valid' || proof.guardArmed === true) return false;
      const checked = proof.validate?.();
      if (checked?.ok !== true) return false;
      proof.guardArmed = true;
      cleanupHandoffBlocker();
      return true;
    };
    proof.burn = burn;
    proof.validate = () => {
      if (proof.status !== 'valid') return { ok: false, reason: proof.reason || proof.status };
      if (proof.preGuardViolation === true) {
        burn('public-route-proof-dispatch-before-guard');
      }
      if (proof.status !== 'valid') return { ok: false, reason: proof.reason };
      try { processMutations(observer?.takeRecords?.() ?? []); } catch { burn('public-route-proof-observer-failed'); }
      if (proof.status !== 'valid') return { ok: false, reason: proof.reason };
      if (Date.now() > proof.expiresAt) burn('public-route-proof-expired');
      const current = locate();
      if (
        proof.status === 'valid' &&
        (!current.ok || current.composer !== proof.composer || current.editor !== proof.editor ||
          current.send !== proof.send || current.pill !== proof.pill ||
          current.attachmentRoot !== proof.attachmentRoot)
      ) burn('public-route-proof-bound-node-changed');
      if (
        proof.status === 'valid' &&
        normalizeRenderedPromptDomIdentity(readEditorValue(proof.editor)) !== proof.promptSnapshot
      ) burn('public-route-proof-prompt-changed');
      if (
        proof.status === 'valid' &&
        (exactText(proof.pill) !== MODE_LABEL ||
          proof.pill.getAttribute?.('aria-haspopup') !== 'menu' ||
          proof.pill.getAttribute?.('aria-expanded') === 'true')
      ) burn('public-route-proof-pill-changed');
      if (proof.status === 'valid') {
        const currentMenus = menuRoots();
        if (
          currentMenus.length !== proof.closedMenuBaseline.length ||
          currentMenus.some((menu, index) => menu !== proof.closedMenuBaseline[index])
        ) {
          burn('public-route-proof-menu-set-changed');
        }
      }
      if (proof.status === 'valid' && String(root.location?.href || '') !== proof.hrefSnapshot) {
        burn('public-route-proof-location-changed');
      }
      return proof.status === 'valid'
        ? { ok: true, reason: null }
        : { ok: false, reason: proof.reason || proof.status };
    };
    proof.consume = () => {
      if (proof.guardArmed !== true) {
        burn('public-route-proof-consumed-before-guard');
        return { ok: false, reason: proof.reason };
      }
      const checked = proof.validate();
      if (!checked.ok) return checked;
      proof.status = 'consumed';
      proof.reason = null;
      cleanup();
      return { ok: true, reason: null };
    };
    if (typeof MutationObserver === 'function') {
      try {
        observer = new MutationObserver(processMutations);
        observer.observe(document.documentElement, {
          subtree: true,
          childList: true,
          characterData: true,
          attributes: true,
          attributeFilter: [
            'aria-controls', 'aria-expanded', 'aria-checked', 'aria-disabled', 'aria-hidden',
            'data-state', 'data-selected', 'disabled', 'hidden',
            'data-oracle-send-binding', 'data-oracle-send-composer-binding',
            'data-oracle-send-editor-binding', 'data-oracle-attachment-binding',
          ],
        });
        proof.observer = observer;
      } catch {
        burn('public-route-proof-observer-unavailable');
      }
    } else {
      burn('public-route-proof-observer-unavailable');
    }
    if (
      proof.status === 'valid' &&
      typeof root.addEventListener === 'function' &&
      typeof root.removeEventListener === 'function'
    ) {
      for (const type of handoffEventTypes) {
        root.addEventListener(type, handoffBlocker, { capture: true, passive: false });
      }
      handoffExpiryId = root.setTimeout?.(cleanupHandoffBlocker, TTL_MS + 250) ?? null;
    } else if (proof.status === 'valid') {
      burn('public-route-proof-handoff-blocker-unavailable');
    }
    if (proof.status === 'valid') {
      for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'submit', 'keydown', 'input', 'change', 'beforeinput', 'paste', 'drop']) {
        addListener(root, type, routeEvent);
      }
      for (const type of ['beforeunload', 'pagehide', 'popstate', 'hashchange']) {
        addListener(root, type, navigationEvent);
      }
      if (typeof root.setTimeout === 'function') {
        expiryId = root.setTimeout(() => burn('public-route-proof-expired'), TTL_MS);
      }
    }
    if (proof.status !== 'valid') {
      return fail(proof.reason || 'public-route-proof-invalid-at-mint');
    }
    registry.set(TOKEN, proof);
    const finalCheck = proof.validate();
    if (!finalCheck.ok) return fail(finalCheck.reason || 'public-route-proof-invalid-at-mint');
    return {
      verified: true,
      composerBindingVerified: true,
      modelVerified: true,
      modeVerified: true,
      modelSignals: [MODEL_LABEL],
      modeSignals: [MODE_LABEL],
      proofMinted: true,
      reason: null,
    };
  })()`;
}

/**
 * Prove the protected route from the exact composer's public, causally owned
 * parent menu and model submenu. This call intentionally opens and closes the
 * picker, awaits UI settling, then mints a short-lived continuity proof after
 * the last composer mutation. The later trusted-click capture guard is the
 * only consumer; private React/Fiber state is not part of authorization.
 */
export async function proveGpt56SolProPublicRoute(
  runtime: ChromeClient["Runtime"],
  attachmentBindingToken?: string,
  composerBindingToken?: string,
): Promise<Gpt56SolProPublicRouteEvidence> {
  const proofNonce = randomUUID();
  const outcome = await runtime.evaluate({
    expression: buildProtectedRouteProofMintExpression(
      attachmentBindingToken,
      composerBindingToken,
      proofNonce,
    ),
    awaitPromise: true,
    returnByValue: true,
  });
  const result = outcome.result?.value;
  if (!result || typeof result !== "object") {
    return {
      verified: false,
      reason: "public-route-proof-result-missing",
      composerBindingVerified: false,
      modelVerified: false,
      modeVerified: false,
      modelSignals: [],
      modeSignals: [],
      privateModelProofAttempted: false,
      privateModelProofValid: true,
    };
  }
  const value = result as {
    verified?: unknown;
    composerBindingVerified?: unknown;
    modelVerified?: unknown;
    modeVerified?: unknown;
    modelSignals?: unknown;
    modeSignals?: unknown;
    proofMinted?: unknown;
    reason?: unknown;
  };
  const modelSignals = Array.isArray(value.modelSignals)
    ? value.modelSignals.filter((signal): signal is string => typeof signal === "string")
    : [];
  const modeSignals = Array.isArray(value.modeSignals)
    ? value.modeSignals.filter((signal): signal is string => typeof signal === "string")
    : [];
  const proofMinted = value.proofMinted === true;
  return {
    verified: value.verified === true && proofMinted,
    reason: typeof value.reason === "string" ? value.reason : null,
    composerBindingVerified: value.composerBindingVerified === true,
    modelVerified: value.modelVerified === true && proofMinted,
    modeVerified: value.modeVerified === true && proofMinted,
    modelSignals,
    modeSignals,
    privateModelProofAttempted: false,
    privateModelProofValid: true,
  };
}

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
  const tokenLiteral = JSON.stringify(composerBindingToken ?? "");
  const bindingNameLiteral = JSON.stringify(verdictBindingName ?? "");
  const nonceLiteral = JSON.stringify(verdictNonce ?? "");
  const registryLiteral = JSON.stringify(PROTECTED_DISPATCH_GUARD_REGISTRY);
  const routeProofRegistryLiteral = JSON.stringify(PROTECTED_ROUTE_PROOF_REGISTRY);
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
    const ROUTE_PROOF_REGISTRY_KEY = ${routeProofRegistryLiteral};
    const SEND_SELECTORS = ${sendSelectorsLiteral};
    const TTL_MS = ${ttlLiteral};
    const REQUIRE_PROTECTED_ROUTE = ${requireProtectedRouteLiteral};
    const HAS_EXACT_SUBMISSION = ${hasExactSubmissionLiteral};
    const EXPECTED_PROMPT = ${exactPromptLiteral};
    const INPUT_SELECTORS = ${inputSelectorsLiteral};
    const EVENT_TYPES = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'];
    const normalizeRenderedPromptDomIdentity = ${normalizeRenderedPromptDomIdentity.toString()};
    const readAttachmentState = () => (${attachmentStateExpression});
    const readPublicRouteProof = () => {
      if (!REQUIRE_PROTECTED_ROUTE) {
        return {
          verified: true,
          reason: null,
          record: null,
          probe: {
            routeModelSignals: [],
            routeModeSignals: [],
            privateModelProofAttempted: false,
            privateModelProofValid: true,
            hasProPill: false,
            composerBindingVerified: true,
          },
        };
      }
      const registry = window[ROUTE_PROOF_REGISTRY_KEY];
      const record = registry instanceof Map ? registry.get(TOKEN) : null;
      let checked = null;
      try { checked = record?.validate?.(); } catch {}
      const verified = Boolean(
        record && record.version === 1 && record.token === TOKEN && checked?.ok === true
      );
      return {
        verified,
        reason: verified ? null : (checked?.reason || record?.reason || 'public-route-proof-missing'),
        record,
        probe: {
          routeModelSignals: verified ? ['GPT-5.6 Sol'] : [],
          routeModeSignals: verified ? ['Pro'] : [],
          privateModelProofAttempted: false,
          privateModelProofValid: true,
          hasProPill: verified,
          composerBindingVerified: verified,
        },
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
      const routeProof = readPublicRouteProof();
      const probe = routeProof.probe;
      const route = {
        verified: routeProof.verified,
        composerBindingVerified: routeProof.verified,
        modelVerified: routeProof.verified,
        modeVerified: routeProof.verified,
        modelSignals: routeProof.verified ? ['gpt 5 6 sol'] : [],
        modeSignals: routeProof.verified ? ['pro'] : [],
        privateModelProofAttempted: false,
        privateModelProofValid: true,
      };
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
            ? (routeProof.reason || 'protected-route-changed')
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
        routeProofRecord: routeProof.record,
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
      try { initial.routeProofRecord?.burn?.(initial.reason || 'dispatch-guard-install-failed'); } catch {}
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
      try { initial.routeProofRecord?.burn?.('guard-registry-unavailable'); } catch {}
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
      requireProtectedRoute: REQUIRE_PROTECTED_ROUTE,
      routeProofRecord: initial.routeProofRecord,
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
      try { initial.routeProofRecord?.burn?.(state.reason); } catch {}
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
        current.routeProofRecord !== initial.routeProofRecord ||
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
      if (REQUIRE_PROTECTED_ROUTE) {
        let consumed = null;
        try { consumed = current.routeProofRecord?.consume?.(); } catch {}
        if (consumed?.ok !== true) {
          cancel(event, consumed?.reason || 'public-route-proof-consume-failed');
          return;
        }
      }
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
      if (state.status !== 'allowed') {
        try { initial.routeProofRecord?.burn?.('dispatch-guard-cleanup'); } catch {}
      }
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
    let routeGuardArmed = !REQUIRE_PROTECTED_ROUTE;
    if (REQUIRE_PROTECTED_ROUTE) {
      try { routeGuardArmed = initial.routeProofRecord?.armGuard?.() === true; } catch {}
    }
    if (!routeGuardArmed) {
      state.status = 'blocked';
      state.reason = 'public-route-proof-guard-handoff-failed';
      reportTerminal();
      cleanup();
      return {
        installed: false,
        status: state.status,
        reason: state.reason,
        routeProof: initial.probe,
        exactPromptVerified: initial.exactPromptVerified,
        attachmentStateVerified: initial.attachmentStateVerified,
        focusVerified: initial.focusVerified,
      };
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
  const routeProofRegistryLiteral = JSON.stringify(PROTECTED_ROUTE_PROOF_REGISTRY);
  return `(() => {
    const registry = window[${registryLiteral}];
    const state = registry instanceof Map ? registry.get(${tokenLiteral}) : null;
    if (!state) {
      return { status: 'missing', reason: 'dispatch-guard-missing', lastEvent: null };
    }
    const proofRegistry = window[${routeProofRegistryLiteral}];
    const proof =
      (proofRegistry instanceof Map ? proofRegistry.get(${tokenLiteral}) : null) ||
      state.routeProofRecord ||
      null;
    let proofCheck = null;
    try { proofCheck = proof?.validate?.(); } catch {}
    return {
      status: state.status === 'armed' && state.requireProtectedRoute === true && proofCheck?.ok !== true
        ? 'blocked'
        : state.status,
      reason: state.reason || (
        state.status === 'armed' && state.requireProtectedRoute === true && proofCheck?.ok !== true
          ? (proofCheck?.reason || proof?.reason || 'public-route-proof-invalid')
          : null
      ),
      lastEvent: state.lastEvent || null,
      routeProofStatus: proof?.status || null,
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
  const routeProofRegistryLiteral = JSON.stringify(PROTECTED_ROUTE_PROOF_REGISTRY);
  return `(() => {
    const TOKEN = ${tokenLiteral};
    const BINDING_NAME = ${bindingNameLiteral};
    const root = window;
    const registry = root[${registryLiteral}];
    const proofRegistry = root[${routeProofRegistryLiteral}];
    const routeProof = proofRegistry instanceof Map ? proofRegistry.get(TOKEN) : null;
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
      try { routeProof?.burn?.('dispatch-guard-missing'); } catch {}
      try { routeProof?.cleanup?.(); } catch {}
      try { proofRegistry?.delete?.(TOKEN); } catch {}
      try { if (proofRegistry instanceof Map && proofRegistry.size === 0) delete root[${routeProofRegistryLiteral}]; } catch {}
      try { delete root[BINDING_NAME]; } catch {}
      return { status: 'missing', reason: 'dispatch-guard-missing', lastEvent: null };
    }
    const verdict = {
      status: state.status,
      reason: state.reason || null,
      lastEvent: state.lastEvent || null,
    };
    try { state.cleanup?.(); } catch {}
    try { if (routeProof?.status === 'valid') routeProof.burn?.('dispatch-verdict-cleanup'); } catch {}
    try { routeProof?.cleanup?.(); } catch {}
    try { proofRegistry?.delete?.(TOKEN); } catch {}
    try { if (proofRegistry instanceof Map && proofRegistry.size === 0) delete root[${routeProofRegistryLiteral}]; } catch {}
    return verdict;
  })()`;
}

/**
 * Build the synchronous consumer for the public route proof minted by
 * proveGpt56SolProPublicRoute(). Menu discovery is deliberately asynchronous;
 * this guard does not claim same-task atomicity with it. Instead, the trusted
 * click's capture listener requires the exact short-lived proof, revalidates
 * its bound nodes/payload, and consumes it before application handlers run.
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
  const evidenceFromInstallResult = (value: unknown): Gpt56SolProPublicRouteEvidence | null => {
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
          privateModelProofAttempted: evidence?.privateModelProofAttempted === true,
          privateModelProofValid: evidence?.privateModelProofValid === true,
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
  privateModelProofAttempted?: boolean;
  privateModelProofValid?: boolean;
}): Gpt56SolProPublicRouteEvidence {
  return classifyGpt56SolProRouteProbe({
    routeModelSignals: args.routeModelSignals ?? [],
    routeModeSignals: args.routeModeSignals ?? [],
    privateModelProofAttempted: args.privateModelProofAttempted === true,
    privateModelProofValid: args.privateModelProofValid !== false,
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

export function buildGpt56SolProPublicRouteProofExpressionForTest(
  attachmentBindingToken?: string,
  composerBindingToken?: string,
  proofNonce = "oracle-public-route-proof-test",
): string {
  return buildProtectedRouteProofMintExpression(
    attachmentBindingToken,
    composerBindingToken,
    proofNonce,
  );
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

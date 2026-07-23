import type { ChromeClient, BrowserLogger } from "../types.js";
import type { ThinkingTimeLevel } from "../../oracle/types.js";
import type { BrowserModelSelectionEvidence } from "../../sessionStore.js";
import {
  INPUT_SELECTORS,
  MENU_CONTAINER_SELECTOR,
  MENU_ITEM_SELECTOR,
  MODEL_BUTTON_SELECTOR,
} from "../constants.js";
import { logDomFailure } from "../domDebug.js";
import { buildClickDispatcher } from "./domEvents.js";

// Snapshot of the model-picker / thinking-effort subtree, captured at the moment
// detection fails so a chip-not-found can be diagnosed without re-running with
// --verbose. Loosely typed: the shape is whatever the injected probe returns.
type ThinkingTimePickerDiagnostic = Record<string, unknown>;

type ThinkingTimeOutcome = (
  | { status: "already-selected"; label?: string | null }
  | { status: "switched"; label?: string | null }
  | { status: "chip-not-found"; diagnostic?: ThinkingTimePickerDiagnostic }
  | { status: "menu-not-found"; diagnostic?: ThinkingTimePickerDiagnostic }
  | { status: "option-not-found"; diagnostic?: ThinkingTimePickerDiagnostic }
  | { status: "selection-unverified"; diagnostic?: ThinkingTimePickerDiagnostic }
  | {
      status: "model-kind-not-found";
      diagnostic?: ThinkingTimePickerDiagnostic;
    }
) & {
  label?: string | null;
  modelKind?: string | null;
  modelLabel?: string | null;
  modelVerified?: boolean;
  modeLabel?: string | null;
  modeVerified?: boolean;
  verifiedBeforePromptSubmit?: boolean;
};

export type BrowserModeSelectionEvidence = Pick<
  BrowserModelSelectionEvidence,
  | "requestedModelLabel"
  | "resolvedModelLabel"
  | "modelVerified"
  | "requestedMode"
  | "resolvedModeLabel"
  | "modeVerified"
  | "verifiedBeforePromptSubmit"
>;

const BROWSER_THINKING_LOG_PREFIX = "[browser] Thinking time:";

function formatBrowserThinkingLog(message: string): string {
  return `${BROWSER_THINKING_LOG_PREFIX} ${message.replace(/^Thinking time:\s*/, "")}`;
}

/**
 * Surfaces the model-picker snapshot captured alongside a failed detection.
 *
 * The browser prefix routes this through the session runner's non-verbose
 * always-print path. The injected probe bounds and redacts all text values.
 */
function logPickerDiagnostic(result: ThinkingTimeOutcome | undefined, logger: BrowserLogger): void {
  const diagnostic =
    result && "diagnostic" in result
      ? (result.diagnostic as ThinkingTimePickerDiagnostic | undefined)
      : undefined;
  if (!diagnostic) {
    return;
  }
  logger(`[browser] Model picker diagnostic: ${JSON.stringify(diagnostic)}`);
}

/**
 * Selects a thinking-time level in ChatGPT's composer.
 *
 * Missing controls remain best-effort except Pro Extended, which fails closed
 * unless the selected option is confirmed.
 */
export async function ensureThinkingTime(
  Runtime: ChromeClient["Runtime"],
  level: ThinkingTimeLevel,
  logger: BrowserLogger,
  desiredModel?: string | null,
): Promise<BrowserModeSelectionEvidence | undefined> {
  const result = await evaluateThinkingTimeSelection(Runtime, level, desiredModel);
  const capitalizedLevel = level.charAt(0).toUpperCase() + level.slice(1);
  const targetModelKind = inferThinkingTargetModelKind(desiredModel);
  const observedModelKind = result && "modelKind" in result ? result.modelKind : null;
  const strictProEffort =
    (targetModelKind === "pro" || observedModelKind === "pro") && level === "extended";
  const strictGpt56SolPro = isGpt56SolModelLabel(desiredModel) && level === "extended";
  const evidence = buildModeSelectionEvidence(result, level, desiredModel);
  const returnedEvidence = strictGpt56SolPro ? evidence : undefined;

  if (
    strictGpt56SolPro &&
    (!evidence.modelVerified ||
      !evidence.modeVerified ||
      evidence.verifiedBeforePromptSubmit !== true)
  ) {
    await logDomFailure(Runtime, logger, "thinking-gpt-5-6-sol-pro-unverified");
    logPickerDiagnostic(result, logger);
    throw new Error(
      "Thinking time: GPT-5.6 Sol + Pro selection unverified; refusing to submit without a checked bare Pro row in the active composer's owned Intelligence menu plus a checked exact GPT-5.6 Sol row in its owned model submenu.",
    );
  }

  switch (result?.status) {
    case "already-selected":
      logger(formatBrowserThinkingLog(`${result.label ?? capitalizedLevel} (already selected)`));
      return returnedEvidence;
    case "switched":
      logger(formatBrowserThinkingLog(result.label ?? capitalizedLevel));
      return returnedEvidence;
    case "chip-not-found":
    case "menu-not-found":
    case "option-not-found":
    case "selection-unverified":
    case "model-kind-not-found": {
      await logDomFailure(Runtime, logger, `thinking-${result.status}`);
      logPickerDiagnostic(result, logger);
      const kindHint =
        result.status === "model-kind-not-found" && result.modelKind
          ? ` for ${result.modelKind}`
          : targetModelKind
            ? ` for ${targetModelKind}`
            : "";
      const message = `Thinking time: ${result.status.replaceAll("-", " ")}${kindHint} (requested ${capitalizedLevel})`;
      if (strictProEffort) {
        throw new Error(
          `${message}; refusing to submit without confirmed ${strictGpt56SolPro ? "GPT-5.6 Sol + Pro" : "Pro Extended"}.`,
        );
      }
      logger(formatBrowserThinkingLog(`${message}; continuing with ChatGPT default.`));
      return returnedEvidence;
    }
    default: {
      await logDomFailure(Runtime, logger, "thinking-time-unknown");
      logPickerDiagnostic(result, logger);
      if (strictProEffort) {
        throw new Error(
          `Thinking time: unknown outcome selecting ${capitalizedLevel}; refusing to submit without confirmed ${strictGpt56SolPro ? "GPT-5.6 Sol + Pro" : "Pro Extended"}.`,
        );
      }
      logger(
        formatBrowserThinkingLog(
          `unknown outcome selecting ${capitalizedLevel}; continuing with ChatGPT default.`,
        ),
      );
      return returnedEvidence;
    }
  }
}

function buildModeSelectionEvidence(
  result: ThinkingTimeOutcome | undefined,
  level: ThinkingTimeLevel,
  desiredModel?: string | null,
): BrowserModeSelectionEvidence {
  const isGpt56Sol = isGpt56SolModelLabel(desiredModel);
  const success = result?.status === "already-selected" || result?.status === "switched";
  const requestedMode = isGpt56Sol && level === "extended" ? "Pro" : level;
  return {
    requestedModelLabel: desiredModel ?? null,
    resolvedModelLabel: result?.modelLabel ?? null,
    modelVerified: isGpt56Sol ? result?.modelVerified === true : undefined,
    requestedMode,
    resolvedModeLabel: result?.modeLabel ?? result?.label ?? null,
    modeVerified: isGpt56Sol ? result?.modeVerified === true : success,
    verifiedBeforePromptSubmit: isGpt56Sol
      ? result?.verifiedBeforePromptSubmit === true
      : undefined,
  };
}

/**
 * Best-effort selection of a thinking time level in ChatGPT's composer pill menu.
 * Safe by default: if the pill/menu/option isn't present, we continue without throwing.
 * @param level - The thinking time intensity: 'light', 'standard', 'extended', or 'heavy'
 */
export async function ensureThinkingTimeIfAvailable(
  Runtime: ChromeClient["Runtime"],
  level: ThinkingTimeLevel,
  logger: BrowserLogger,
  desiredModel?: string | null,
): Promise<boolean> {
  try {
    const result = await evaluateThinkingTimeSelection(Runtime, level, desiredModel);
    const capitalizedLevel = level.charAt(0).toUpperCase() + level.slice(1);

    switch (result?.status) {
      case "already-selected":
        logger(formatBrowserThinkingLog(`${result.label ?? capitalizedLevel} (already selected)`));
        return true;
      case "switched":
        logger(formatBrowserThinkingLog(result.label ?? capitalizedLevel));
        return true;
      case "chip-not-found":
      case "menu-not-found":
      case "option-not-found":
      case "selection-unverified":
      case "model-kind-not-found":
        if (logger.verbose) {
          logger(
            formatBrowserThinkingLog(
              `${result.status.replaceAll("-", " ")}; continuing with default.`,
            ),
          );
        }
        return false;
      default:
        if (logger.verbose) {
          logger(formatBrowserThinkingLog("unknown outcome; continuing with default."));
        }
        return false;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (logger.verbose) {
      logger(formatBrowserThinkingLog(`selection failed (${message}); continuing with default.`));
      await logDomFailure(Runtime, logger, "thinking-time");
    }
    return false;
  }
}

async function evaluateThinkingTimeSelection(
  Runtime: ChromeClient["Runtime"],
  level: ThinkingTimeLevel,
  desiredModel?: string | null,
): Promise<ThinkingTimeOutcome | undefined> {
  const outcome = await Runtime.evaluate({
    expression: buildThinkingTimeExpression(level, desiredModel),
    awaitPromise: true,
    returnByValue: true,
  });

  return outcome.result?.value as ThinkingTimeOutcome | undefined;
}

function buildThinkingTimeExpression(
  level: ThinkingTimeLevel,
  desiredModel?: string | null,
): string {
  const menuContainerLiteral = JSON.stringify(MENU_CONTAINER_SELECTOR);
  const menuItemLiteral = JSON.stringify(MENU_ITEM_SELECTOR);
  const modelButtonLiteral = JSON.stringify(MODEL_BUTTON_SELECTOR);
  const inputSelectorsLiteral = JSON.stringify(INPUT_SELECTORS);
  const targetLevelLiteral = JSON.stringify(level.toLowerCase());
  const targetModelKindLiteral = JSON.stringify(inferThinkingTargetModelKind(desiredModel));
  const targetModelLabelLiteral = JSON.stringify(desiredModel ?? null);
  const targetIsGpt56ModelLiteral = JSON.stringify(
    /(?:^|[^0-9])5[._ -]6(?:[^0-9]|$)/i.test(desiredModel ?? ""),
  );

  return `(async () => {
    ${buildClickDispatcher()}

    const MENU_CONTAINER_SELECTOR = ${menuContainerLiteral};
    const MENU_ITEM_SELECTOR = ${menuItemLiteral};
    const MODEL_BUTTON_SELECTOR = ${modelButtonLiteral};
    const INPUT_SELECTORS = ${inputSelectorsLiteral};
    const TARGET_LEVEL = ${targetLevelLiteral};
    const TARGET_MODEL_KIND = ${targetModelKindLiteral};
    const TARGET_MODEL_LABEL = ${targetModelLabelLiteral};
    const TARGET_IS_GPT56_MODEL = ${targetIsGpt56ModelLiteral};

    // Bilingual matchers: English level token + observed Chinese variants.
    const LEVEL_TOKENS = {
      light: ['light', 'instant', '轻', '极速'],
      standard: ['standard', 'medium', '标准', '中'],
      extended: ['extended', 'high', '扩展', '深度', '加强', '高'],
      heavy: ['heavy', 'extra high', '重度', '加重', '极高'],
    };
    const targetTokens = LEVEL_TOKENS[TARGET_LEVEL] || [TARGET_LEVEL];

    const INITIAL_WAIT_MS = 150;
    const STEP_WAIT_MS = 200;
    const MAX_WAIT_MS = 8000;
    // The "Intelligence" menu renders right after opening the composer pill, so
    // a short probe is enough; if it's absent this is an older UI and we fall
    // back to the legacy paths without paying the full MAX_WAIT_MS.
    const INTELLIGENCE_WAIT_MS = 2500;

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    // Keep CJK characters so we can match Chinese labels against LEVEL_TOKENS.
    const normalize = (value) => (value || '')
      .toLowerCase()
      .replace(/[^a-z0-9\\u4e00-\\u9fa5]+/g, ' ')
      .replace(/\\s+/g, ' ')
      .trim();
    const hasToken = (text, token) => normalize(text).split(' ').includes(token);
    // Normalized EXACT match against the sole served label — mirrors the
    // isGpt56SolModelLabel gate so the in-page Sol+Pro two-axis path and the
    // serve/client label gates agree on what "GPT-5.6 Sol" is. Token membership
    // would over-accept 'GPT-5.6 Sol Mini', reversed 'GPT-6.5 Sol', and prose
    // wrappers; exact match refuses them.
    const TARGET_IS_GPT56_SOL = normalize(TARGET_MODEL_LABEL) === 'gpt 5 6 sol';
    const matchesLevel = (text) => {
      const t = normalize(text);
      if (!t) return false;
      return targetTokens.some((tok) => {
        const token = normalize(tok);
        if (!token) return false;
        if (token === 'high') return hasToken(t, 'high') && !hasToken(t, 'extra');
        if (token === 'extra high') return hasToken(t, 'extra') && hasToken(t, 'high');
        if (token === '极速') {
          const suffix = t.slice(token.length);
          return t === token || hasToken(t, token) || /^[0-9]/.test(suffix);
        }
        if (['中', '高', '极高'].includes(token)) {
          return t === token || hasToken(t, token);
        }
        return t === token || hasToken(t, token) || t.includes(token);
      });
    };
    const matchesAnyEffortLevel = (text) => {
      const normalizedText = normalize(text);
      if (!normalizedText) return false;
      for (const tokens of Object.values(LEVEL_TOKENS)) {
        for (const rawToken of tokens) {
          const token = normalize(rawToken);
          if (!token) continue;
          if (token.includes(' ')) {
            if (token.split(' ').every((part) => hasToken(normalizedText, part))) return true;
          } else if (/^[a-z0-9]+$/.test(token)) {
            if (hasToken(normalizedText, token)) return true;
          } else if (normalizedText.includes(token)) {
            return true;
          }
        }
      }
      return false;
    };
    const optionIsSelected = (node) => {
      if (!(node instanceof HTMLElement)) return false;
      const ariaChecked = node.getAttribute('aria-checked');
      const ariaSelected = node.getAttribute('aria-selected');
      const ariaCurrent = node.getAttribute('aria-current');
      const dataSelected = node.getAttribute('data-selected');
      const dataState = (node.getAttribute('data-state') || '').toLowerCase();
      if (ariaChecked === 'true' || ariaSelected === 'true' || ariaCurrent === 'true') return true;
      return (
        dataSelected === 'true' ||
        dataState === 'checked' ||
        dataState === 'selected' ||
        dataState === 'on' ||
        dataState === 'true'
      );
    };
    const closeOpenMenus = () => {
      try {
        document.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true }),
        );
      } catch {}
    };
    const dispatchHoverSequence = (target) => {
      if (!target || !(target instanceof EventTarget)) return false;
      const types = ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'pointermove', 'mousemove'];
      const rect = target.getBoundingClientRect?.();
      const clientX = Number(rect?.left ?? rect?.x ?? 0) + Number(rect?.width ?? 0) / 2;
      const clientY = Number(rect?.top ?? rect?.y ?? 0) + Number(rect?.height ?? 0) / 2;
      for (const type of types) {
        try {
          const common = { bubbles: true, cancelable: true, view: window, clientX, clientY };
          const event =
            type.startsWith('pointer') && 'PointerEvent' in window
              ? new PointerEvent(type, { ...common, pointerId: 1, pointerType: 'mouse' })
              : new MouseEvent(type, common);
          target.dispatchEvent(event);
        } catch {}
      }
      try {
        target.focus?.();
      } catch {}
      return true;
    };

    const TRAILING_SELECTOR = '[data-model-picker-thinking-effort-action="true"]';
    const INTELLIGENCE_MENU_SELECTOR = '[data-testid="composer-intelligence-picker-content"]';
    const PRO_EFFORT_TRIGGER_SELECTOR = '[data-testid="composer-intelligence-pro-thinking-effort-trigger"]';

    const findModelButton = () => document.querySelector(MODEL_BUTTON_SELECTOR);
    const findTrailingButtons = () => Array.from(document.querySelectorAll(TRAILING_SELECTOR));
    const KIND_NOT_FOUND = { kindNotFound: true };

    const isVisible = (node) => {
      if (!node || node.getAttribute?.('aria-hidden') === 'true') return false;
      const rect = node.getBoundingClientRect?.();
      return Boolean(rect && rect.width > 0 && rect.height > 0);
    };
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
    const findActiveComposerRoot = () => {
      const promptCandidates = Array.from(new Set(
        INPUT_SELECTORS.flatMap((selector) => Array.from(document.querySelectorAll(selector))),
      ));
      const visiblePrompts = promptCandidates.filter(isVisible);
      const focused = document.activeElement;
      const focusedPrompts = visiblePrompts.filter(
        (node) => Boolean(focused && (node === focused || node.contains?.(focused))),
      );
      const activePrompt = focusedPrompts.length === 1
        ? focusedPrompts[0]
        : (visiblePrompts.length === 1 ? visiblePrompts[0] : null);
      if (!activePrompt) return null;
      const composer = closestComposerRoot(activePrompt) || activePrompt.closest?.('form') || null;
      return composer?.contains?.(activePrompt) ? composer : null;
    };
    const findActiveComposerIntelligencePill = (composer) => {
      if (!composer) return null;
      // The picker pill displays the *current* effort. It therefore cannot be
      // located by requiring "Pro" before the repair path has selected Pro.
      // Keep the pre-open locator closed-world and fail on ambiguity; the
      // owned Intelligence menu proof below remains the authority.
      const intelligencePillLabels = new Set([
        'instant',
        'instant5 5',
        'instant 5 5',
        'standard',
        'medium',
        'high',
        'extra high',
        'pro',
      ]);
      const candidates = Array.from(composer.querySelectorAll('button.__composer-pill'))
        .filter(isVisible)
        .filter((node) => node.getAttribute?.('aria-haspopup') === 'menu')
        .filter((node) =>
          intelligencePillLabels.has(
            normalize(node.textContent ?? node.getAttribute?.('aria-label') ?? ''),
          ),
        );
      return candidates.length === 1 ? candidates[0] : null;
    };
    const redactDiagnosticText = (value, maxLength = 120) =>
      String(value ?? '')
        .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}/gi, '[redacted-email]')
        .replace(/\\b[A-Za-z0-9_-]{32,}\\b/g, '[redacted]')
        .replace(/\\s+/g, ' ')
        .trim()
        .slice(0, maxLength);
    const describeNode = (el) => {
      if (!el || typeof el.getAttribute !== 'function') return null;
      let rect = null;
      try {
        const r = el.getBoundingClientRect?.();
        if (r) {
          rect = {
            w: Math.round(r.width),
            h: Math.round(r.height),
            visible: r.width > 0 && r.height > 0,
          };
        }
      } catch {}
      return {
        tag: el.tagName || null,
        testid: el.getAttribute('data-testid'),
        role: el.getAttribute('role'),
        ariaLabel: redactDiagnosticText(el.getAttribute('aria-label')),
        ariaExpanded: el.getAttribute('aria-expanded'),
        ariaChecked: el.getAttribute('aria-checked'),
        ariaSelected: el.getAttribute('aria-selected'),
        ariaHaspopup: el.getAttribute('aria-haspopup'),
        dataState: el.getAttribute('data-state'),
        text: redactDiagnosticText(el.textContent, 80),
        rect,
      };
    };
    const describeMenu = (menu) => {
      if (!menu || typeof menu.querySelectorAll !== 'function') return null;
      const items = Array.from(
        menu.querySelectorAll('[role="menuitem"], [role="menuitemradio"], [role="option"], button, [data-testid]'),
      )
        .slice(0, 30)
        .map(describeNode);
      return {
        role: menu.getAttribute?.('role') ?? null,
        testid: menu.getAttribute?.('data-testid') ?? null,
        itemCount: items.length,
        items,
      };
    };
    const collectPickerDiagnostic = () => {
      try {
        const trailings = findTrailingButtons();
        const switchers = Array.from(document.querySelectorAll('[data-testid*="model-switcher"]'));
        const composerButtons = Array.from(
          document.querySelectorAll(
            'form button[aria-haspopup="menu"], [data-testid="model-switcher-dropdown-button"]',
          ),
        );
        const menus = Array.from(document.querySelectorAll(MENU_CONTAINER_SELECTOR)).filter(
          isVisible,
        );
        const modelBtn = findModelButton();
        return {
          targetModelKind: TARGET_MODEL_KIND,
          targetLevel: TARGET_LEVEL,
          modelButton: describeNode(modelBtn),
          composerButtons: composerButtons.slice(0, 12).map(describeNode),
          trailingCount: trailings.length,
          trailings: trailings.slice(0, 12).map(describeNode),
          modelSwitcherCount: switchers.length,
          modelSwitcher: switchers.slice(0, 12).map(describeNode),
          menuCount: menus.length,
          menus: menus.slice(0, 4).map(describeMenu),
        };
      } catch (err) {
        return { error: redactDiagnosticText(err && err.message ? err.message : err) };
      }
    };
    const modelKindFromNode = (button) => {
      const label = normalize(
        (button?.textContent ?? '') + ' ' + (button?.getAttribute?.('aria-label') ?? ''),
      );
      if (hasToken(label, 'pro')) return 'pro';
      if (hasToken(label, 'thinking')) return 'thinking';
      if (hasToken(label, 'instant')) return 'instant';
      return null;
    };
    const currentModelKind = () => modelKindFromNode(findModelButton());
    const effectiveTargetModelKind = () => TARGET_MODEL_KIND || currentModelKind();
    const isIntelligenceEffortMenu = (menu) => {
      if (menu?.getAttribute?.('data-testid') === 'composer-intelligence-picker-content') {
        return true;
      }
      if (menu?.querySelector?.(INTELLIGENCE_MENU_SELECTOR)) {
        return true;
      }
      const label = menu?.querySelector?.('.__menu-label, [class*="menu-label"]');
      return normalize(label?.textContent ?? '').includes('intelligence');
    };
    const failure = (status, extra = {}) => ({
      status,
      modelKind: effectiveTargetModelKind(),
      ...extra,
      diagnostic: collectPickerDiagnostic(),
    });
    const findOptionInMenu = (menu, modelKindOverride = null) => {
      const items = Array.from(menu.querySelectorAll(MENU_ITEM_SELECTOR));
      const modelKind = modelKindOverride || effectiveTargetModelKind();
      if (modelKind === 'pro') {
        // GPT-5.6's unified Intelligence picker exposes Pro as the highest
        // effort radio directly. It no longer has a nested "Pro Extended"
        // row, so preserve the legacy request semantics by selecting Pro.
        if (
          TARGET_LEVEL === 'extended' &&
          isIntelligenceEffortMenu(menu) &&
          !document.querySelector(PRO_EFFORT_TRIGGER_SELECTOR)
        ) {
          for (const item of items) {
            const itemText = normalize(
              (item.textContent ?? '') + ' ' + (item.getAttribute?.('aria-label') ?? ''),
            );
            if (itemText === 'pro') return item;
          }
        }
        for (const item of items) {
          const itemText = normalize(
            (item.textContent ?? '') + ' ' + (item.getAttribute?.('aria-label') ?? ''),
          );
          if (
            hasToken(itemText, 'pro') &&
            (matchesLevel(item.textContent ?? '') ||
              matchesLevel(item.getAttribute?.('aria-label') ?? ''))
          ) {
            return item;
          }
        }
        if (isIntelligenceEffortMenu(menu)) {
          return null;
        }
      }
      for (const item of items) {
        const itemText = normalize(
          (item.textContent ?? '') + ' ' + (item.getAttribute?.('aria-label') ?? ''),
        );
        if (modelKind !== 'pro' && hasToken(itemText, 'pro')) {
          continue;
        }
        if (
          matchesLevel(item.textContent ?? '') ||
          matchesLevel(item.getAttribute?.('aria-label') ?? '')
        ) {
          return item;
        }
      }
      if (TARGET_LEVEL === 'heavy') {
        // Older Chinese layouts used bare 高 for the highest effort. Keep it
        // only as a second-pass exact fallback so a current 高 row can never
        // win before the primary 极高 row.
        for (const item of items) {
          const itemText = normalize(item.textContent ?? '');
          const ariaLabel = normalize(item.getAttribute?.('aria-label') ?? '');
          if (itemText === '高' || ariaLabel === '高') return item;
        }
      }
      return null;
    };
    const countEffortLevels = (menu) => {
      const text = normalize(menu?.textContent ?? '');
      let hits = 0;
      for (const tokens of Object.values(LEVEL_TOKENS)) {
        if (tokens.some((token) => text.includes(String(token).toLowerCase()))) hits += 1;
      }
      return hits;
    };
    const isEffortMenu = (menu) => {
      if (!isVisible(menu)) return false;
      if (menu.getAttribute?.('data-testid') === 'composer-intelligence-picker-content') return true;
      if (menu.querySelector?.(INTELLIGENCE_MENU_SELECTOR)) return true;
      const label = menu.querySelector?.('.__menu-label, [class*="menu-label"]');
      const labelText = normalize(label?.textContent ?? '');
      return (
        labelText.includes('intelligence') ||
        labelText.includes('thinking time') ||
        labelText.includes('thinking effort') ||
        countEffortLevels(menu) >= 2
      );
    };
    const isProEffortMenu = (menu) => {
      if (!isVisible(menu)) return false;
      const text = normalize(menu?.textContent ?? '');
      return text.includes('pro standard') && text.includes('pro extended');
    };
    const controlledMenu = (trigger) => {
      const id = trigger?.getAttribute?.('aria-controls');
      if (!id) return null;
      const menu = document.getElementById?.(id);
      return isEffortMenu(menu) ? menu : null;
    };
    const findVisibleEffortMenu = (trigger) => {
      const controlled = controlledMenu(trigger);
      if (controlled) return controlled;
      for (const menu of document.querySelectorAll(MENU_CONTAINER_SELECTOR)) {
        if (isEffortMenu(menu)) return menu;
      }
      return null;
    };
    const controlledProEffortMenu = (trigger) => {
      const id = trigger?.getAttribute?.('aria-controls');
      if (!id) return null;
      const menu = document.getElementById?.(id);
      return isProEffortMenu(menu) ? menu : null;
    };
    const findVisibleProEffortMenu = (trigger) => {
      const controlled = controlledProEffortMenu(trigger);
      if (controlled) return controlled;
      for (const menu of document.querySelectorAll(MENU_CONTAINER_SELECTOR)) {
        if (isProEffortMenu(menu)) return menu;
      }
      return null;
    };
    const matchesProEffortLevel = (node) => {
      const text = normalize(
        (node?.textContent ?? '') + ' ' + (node?.getAttribute?.('aria-label') ?? ''),
      );
      if (TARGET_LEVEL === 'standard') {
        return text.includes('pro') && text.includes('standard');
      }
      if (TARGET_LEVEL === 'extended') {
        return text.includes('pro') && text.includes('extended');
      }
      return false;
    };
    const findProEffortOptionInMenu = (menu) => {
      for (const item of menu.querySelectorAll(MENU_ITEM_SELECTOR)) {
        if (matchesProEffortLevel(item)) return item;
      }
      return null;
    };
    const freshComposerTrigger = (trigger) => {
      if (!trigger?.matches?.('button.__composer-pill')) return null;
      // React can replace the composer pill after an effort click. Keep using
      // the captured node while it is live, but re-query once it is detached so
      // verification does not read its stale pre-click label.
      if (trigger.isConnected !== false) return trigger;
      return findComposerEffortPill() || findModelButton() || trigger;
    };
    const currentProEffortPillMatchesTarget = (trigger, modelKindOverride = null) => {
      const button = freshComposerTrigger(trigger) || findModelButton();
      if ((modelKindOverride || TARGET_MODEL_KIND || modelKindFromNode(button)) !== 'pro') {
        return false;
      }
      const label = normalize(button?.textContent ?? '');
      if (TARGET_LEVEL === 'standard') {
        return hasToken(label, 'pro') && !hasToken(label, 'extended');
      }
      if (TARGET_LEVEL === 'extended') {
        return hasToken(label, 'pro') && hasToken(label, 'extended');
      }
      return false;
    };
    const currentEffortPillMatchesTarget = (trigger, modelKindOverride = null) => {
      if (currentProEffortPillMatchesTarget(trigger, modelKindOverride)) return true;
      const button = freshComposerTrigger(trigger) || findModelButton();
      if ((modelKindOverride || TARGET_MODEL_KIND || modelKindFromNode(button)) === 'pro') {
        return false;
      }
      const label = (button?.textContent ?? '') + ' ' + (button?.getAttribute?.('aria-label') ?? '');
      return matchesLevel(label);
    };
    const selectAndVerify = async (trigger, findOption, modelKindOverride = null) => {
      const option = findOption();
      const triggerModelKind =
        modelKindOverride ||
        TARGET_MODEL_KIND ||
        modelKindFromNode(trigger) ||
        effectiveTargetModelKind();
      if (!option) return failure('option-not-found', { modelKind: triggerModelKind });
      const label = option.textContent?.trim?.() || null;
      if (optionIsSelected(option)) {
        closeOpenMenus();
        return { status: 'already-selected', label };
      }

      dispatchClickSequence(option);
      await sleep(STEP_WAIT_MS);
      const refreshed = findOption();
      if (refreshed && optionIsSelected(refreshed)) {
        closeOpenMenus();
        return { status: 'switched', label: refreshed.textContent?.trim?.() || label };
      }
      if (currentEffortPillMatchesTarget(trigger, triggerModelKind)) {
        closeOpenMenus();
        return { status: 'switched', label };
      }

      const reopenTrigger = freshComposerTrigger(trigger) || trigger;
      if (!refreshed && reopenTrigger?.getAttribute?.('aria-expanded') !== 'true') {
        dispatchClickSequence(reopenTrigger);
        await sleep(INITIAL_WAIT_MS);
      }
      const deadline = performance.now() + 2000;
      while (performance.now() < deadline) {
        const selected = findOption();
        if (selected && optionIsSelected(selected)) {
          closeOpenMenus();
          return { status: 'switched', label: selected.textContent?.trim?.() || label };
        }
        if (currentEffortPillMatchesTarget(trigger, triggerModelKind)) {
          closeOpenMenus();
          return { status: 'switched', label };
        }
        await sleep(100);
      }
      const result = failure('selection-unverified', { modelKind: triggerModelKind });
      closeOpenMenus();
      return result;
    };

    // Current ChatGPT Pro is a two-axis selection. Authorization comes only
    // from rendered, checked rows in menus causally owned by the exact active
    // composer: bare Pro in the parent Intelligence menu and exact GPT-5.6 Sol
    // in the Sol trigger's model submenu. React fiber data is intentionally not
    // an authorization input: it is implementation-private and can be stale or
    // truncated. A hostile renderer can still paint false state; this gate is a
    // fail-closed UI-state proof, not an attestation of ChatGPT's server state.
    if (TARGET_IS_GPT56_SOL && TARGET_LEVEL === 'extended') {
      const EXACT_PRO = 'pro';
      const EXACT_SOL = 'gpt 5 6 sol';
      const MAX_FULL_REPROOFS = 6;
      const MAX_SWITCHES_PER_AXIS = 2;
      const belongsToSelectionOwner = (node, owner) => {
        let current = node;
        while (current && current !== owner) {
          current = current.parentElement;
          if (
            current &&
            current !== owner &&
            ['menu', 'listbox'].includes(current.getAttribute?.('role'))
          ) {
            return false;
          }
        }
        return current === owner;
      };
      const selectionRows = (owner) => Array.from(
        owner?.querySelectorAll?.(
          '[role="menuitemradio"], [role="radio"], [role="option"]',
        ) ?? [],
      ).filter((row) => belongsToSelectionOwner(row, owner));
      const triggerRows = (owner) => Array.from(
        owner?.querySelectorAll?.(
          '[role="menuitemradio"], [role="menuitem"], [role="option"], [role="radio"], button',
        ) ?? [],
      ).filter((row) => belongsToSelectionOwner(row, owner));
      const itemLabel = (node) =>
        normalize(node?.textContent ?? '') || normalize(node?.getAttribute?.('aria-label') ?? '');
      const isLive = (node) => node?.isConnected !== false && isVisible(node);
      const readSelectionMarkers = (node) => {
        if (!node || !['menuitemradio', 'radio', 'option'].includes(node.getAttribute?.('role'))) {
          return { valid: false, selected: false };
        }
        const readings = [];
        const pushBoolean = (raw, selectedValues, unselectedValues) => {
          if (raw === null || raw === undefined) return true;
          const value = String(raw).toLowerCase();
          if (selectedValues.includes(value)) {
            readings.push(true);
            return true;
          }
          if (unselectedValues.includes(value)) {
            readings.push(false);
            return true;
          }
          return false;
        };
        const ariaChecked = node.getAttribute?.('aria-checked');
        const dataState = node.getAttribute?.('data-state');
        if (
          ariaChecked === null ||
          ariaChecked === undefined ||
          dataState === null ||
          dataState === undefined
        ) {
          return { valid: false, selected: false };
        }
        let valid = pushBoolean(ariaChecked, ['true'], ['false']);
        valid &&= pushBoolean(dataState, ['checked'], ['unchecked']);
        valid &&= pushBoolean(node.getAttribute?.('aria-selected'), ['true'], ['false']);
        valid &&= pushBoolean(node.getAttribute?.('aria-current'), ['true'], ['false']);
        valid &&= pushBoolean(node.getAttribute?.('data-selected'), ['true'], ['false']);
        if (!valid || readings.length === 0 || new Set(readings).size !== 1) {
          return { valid: false, selected: false };
        }
        return { valid: true, selected: readings[0] };
      };
      const readClosedWorldSelection = (owner, exactLabel) => {
        if (!isLive(owner)) return { valid: false, target: null, targetSelected: false };
        const allRows = selectionRows(owner);
        // Exact-label uniqueness is over visible and hidden rows. A hidden exact
        // duplicate is ambiguity, not something to silently ignore.
        const exactRows = allRows.filter((row) => itemLabel(row) === exactLabel);
        if (exactRows.length !== 1 || !isLive(exactRows[0])) {
          return { valid: false, target: null, targetSelected: false };
        }
        const visibleRows = allRows.filter(isLive);
        const states = visibleRows.map((row) => ({ row, state: readSelectionMarkers(row) }));
        if (states.length === 0 || states.some(({ state }) => !state.valid)) {
          return { valid: false, target: null, targetSelected: false };
        }
        const checked = states.filter(({ state }) => state.selected);
        if (checked.length !== 1) {
          return { valid: false, target: null, targetSelected: false };
        }
        const target = exactRows[0];
        const targetState = states.find(({ row }) => row === target)?.state;
        if (!targetState?.selected && target.getAttribute?.('aria-disabled') === 'true') {
          return { valid: false, target: null, targetSelected: false };
        }
        return { valid: true, target, targetSelected: targetState?.selected === true };
      };
      const readExactSolTrigger = (owner) => {
        if (!isLive(owner)) return { valid: false, trigger: null };
        const exactRows = triggerRows(owner).filter((row) => itemLabel(row) === EXACT_SOL);
        if (exactRows.length !== 1) return { valid: false, trigger: null };
        const trigger = exactRows[0];
        if (!isLive(trigger) || trigger.getAttribute?.('aria-haspopup') !== 'menu') {
          return { valid: false, trigger: null };
        }
        return { valid: true, trigger };
      };
      const visibleMenuRoots = () => Array.from(
        new Set(Array.from(document.querySelectorAll(MENU_CONTAINER_SELECTOR)).filter(isLive)),
      );
      const intelligenceSelectionScope = (root) => {
        if (!isLive(root)) return null;
        const markers = [];
        if (root.getAttribute?.('data-testid') === 'composer-intelligence-picker-content') {
          markers.push(root);
        }
        for (const marker of root.querySelectorAll?.(INTELLIGENCE_MENU_SELECTOR) ?? []) {
          if (!markers.includes(marker)) markers.push(marker);
        }
        return markers.length === 1 && isLive(markers[0]) ? markers[0] : null;
      };
      const isIntelligenceOwner = (root) => Boolean(intelligenceSelectionScope(root));
      const uniqueIdNode = (id) => {
        if (!id) return null;
        const matches = Array.from(document.querySelectorAll('[id]')).filter(
          (node) => node.getAttribute?.('id') === id,
        );
        return matches.length === 1 ? matches[0] : null;
      };
      const controlledMenu = (trigger, kind) => {
        const id = trigger?.getAttribute?.('aria-controls');
        const root = uniqueIdNode(id);
        if (!root || !isLive(root)) return null;
        if (kind === 'parent') return isIntelligenceOwner(root) ? root : null;
        const role = root.getAttribute?.('role');
        if (
          role === 'menu' ||
          role === 'listbox' ||
          root.getAttribute?.('data-radix-collection-root') !== null
        ) {
          return root;
        }
        const descendants = Array.from(
          root.querySelectorAll?.(
            '[role="menu"], [role="listbox"], [data-radix-collection-root]',
          ) ?? [],
        ).filter(isLive);
        const topLevel = descendants.filter((candidate) =>
          !descendants.some(
            (other) => other !== candidate && other.contains?.(candidate),
          )
        );
        return topLevel.length === 1 ? topLevel[0] : null;
      };
      const parentTrigger = () => {
        const composer = findActiveComposerRoot();
        const pill = findActiveComposerIntelligencePill(composer);
        return composer && pill && composer.contains?.(pill) && isLive(pill) ? pill : null;
      };
      const bindingOwner = (binding, getTrigger) => {
        const trigger = getTrigger();
        if (!trigger || trigger.getAttribute?.('aria-expanded') !== 'true') return null;
        if (binding.type === 'controlled') {
          if (!trigger.getAttribute?.('aria-controls')) return null;
          return controlledMenu(trigger, binding.kind);
        }
        if (trigger.getAttribute?.('aria-controls')) return null;
        const current = visibleMenuRoots().filter((root) => root === binding.root);
        if (current.length !== 1) return null;
        if (binding.kind === 'parent' && !isIntelligenceOwner(current[0])) return null;
        return current[0];
      };
      const waitForControlledBinding = async (getTrigger, kind, attempts = 12) => {
        for (let attempt = 0; attempt < attempts; attempt += 1) {
          const current = getTrigger();
          if (
            !current ||
            !current.getAttribute?.('aria-controls')
          ) {
            return null;
          }
          if (
            current.getAttribute?.('aria-expanded') === 'true' &&
            controlledMenu(current, kind)
          ) {
            return { type: 'controlled', kind };
          }
          await sleep(50);
        }
        return null;
      };
      const openBoundMenu = async (getTrigger, kind) => {
        let trigger = getTrigger();
        if (!trigger) return null;
        if (trigger.getAttribute?.('aria-controls')) {
          if (trigger.getAttribute?.('aria-expanded') !== 'true') {
            dispatchHoverSequence(trigger);
            trigger = getTrigger();
            if (!trigger) return null;
            if (trigger.getAttribute?.('aria-expanded') !== 'true') {
              dispatchClickSequence(trigger);
            }
            await sleep(INITIAL_WAIT_MS);
          }
          // Discard the pre-click handle. Poll only the current trigger and its
          // unique IDREF so ordinary delayed portal rendering remains viable
          // without transferring trust from a stale handle.
          return await waitForControlledBinding(getTrigger, kind);
        }

        if (trigger.getAttribute?.('aria-expanded') === 'true') {
          dispatchClickSequence(trigger);
          await sleep(STEP_WAIT_MS);
          trigger = getTrigger();
          if (
            !trigger ||
            trigger.getAttribute?.('aria-controls') ||
            trigger.getAttribute?.('aria-expanded') === 'true'
          ) {
            return null;
          }
        }
        const before = new Set(visibleMenuRoots());
        dispatchHoverSequence(trigger);
        trigger = getTrigger();
        if (!trigger) return null;
        if (trigger.getAttribute?.('aria-expanded') !== 'true') {
          dispatchClickSequence(trigger);
        }
        await sleep(INITIAL_WAIT_MS);
        for (let attempt = 0; attempt < 12; attempt += 1) {
          trigger = getTrigger();
          if (!trigger || trigger.getAttribute?.('aria-controls')) return null;
          if (trigger.getAttribute?.('aria-expanded') === 'true') {
            const after = visibleMenuRoots();
            const added = after.filter((root) => !before.has(root));
            const removed = Array.from(before).filter((root) => !after.includes(root));
            if (added.length === 1 && removed.length === 0) {
              if (kind === 'parent' && !isIntelligenceOwner(added[0])) return null;
              return { type: 'causal', kind, root: added[0] };
            }
            if (added.length > 1 || removed.length > 0) return null;
          }
          await sleep(50);
        }
        return null;
      };
      const readParentProof = (binding) => {
        const owner = bindingOwner(binding, parentTrigger);
        if (!owner) return { valid: false, owner: null };
        const scope = intelligenceSelectionScope(owner);
        if (!scope) return { valid: false, owner: null };
        const effort = readClosedWorldSelection(scope, EXACT_PRO);
        const solTrigger = readExactSolTrigger(scope);
        return {
          valid: effort.valid && solTrigger.valid,
          owner,
          scope,
          effort,
          solTrigger,
        };
      };
      const modelTriggerFor = (parentBinding) => () => {
        const parent = readParentProof(parentBinding);
        return parent.valid ? parent.solTrigger.trigger : null;
      };
      const readModelProof = (modelBinding, getModelTrigger) => {
        const owner = bindingOwner(modelBinding, getModelTrigger);
        if (!owner) return { valid: false, owner: null };
        const model = readClosedWorldSelection(owner, EXACT_SOL);
        return { valid: model.valid, owner, model };
      };
      const gpt56Failure = (status, extra = {}) => failure(status, {
        modelKind: 'pro',
        modelLabel: null,
        modelVerified: false,
        modeLabel: null,
        modeVerified: false,
        verifiedBeforePromptSubmit: false,
        ...extra,
      });
      const verifiedGpt56SolPro = (status, modelLabel, modeLabel) => ({
        status,
        label: modeLabel,
        modelKind: 'pro',
        modelLabel,
        modelVerified: true,
        modeLabel,
        modeVerified: true,
        verifiedBeforePromptSubmit: true,
      });

      if (!parentTrigger()) {
        return gpt56Failure('chip-not-found');
      }
      let switched = false;
      let modeSwitches = 0;
      let modelSwitches = 0;
      let lastStatus = 'menu-not-found';
      for (let attempt = 0; attempt < MAX_FULL_REPROOFS; attempt += 1) {
        const parentBinding = await openBoundMenu(parentTrigger, 'parent');
        if (!parentBinding) {
          lastStatus = 'menu-not-found';
          continue;
        }
        let parent = readParentProof(parentBinding);
        if (!parent.valid) {
          closeOpenMenus();
          return gpt56Failure(
            parent.effort?.valid === false ? 'selection-unverified' : 'model-kind-not-found',
          );
        }

        if (!parent.effort.targetSelected) {
          if (modeSwitches >= MAX_SWITCHES_PER_AXIS) break;
          // Re-resolve immediately before the action. No row handle crosses the
          // click or following wait; the next iteration starts at the composer.
          parent = readParentProof(parentBinding);
          const target = parent.valid ? parent.effort.target : null;
          if (!target || !isLive(target)) {
            lastStatus = 'selection-unverified';
            continue;
          }
          dispatchClickSequence(target);
          modeSwitches += 1;
          switched = true;
          await sleep(STEP_WAIT_MS);
          continue;
        }

        const getModelTrigger = modelTriggerFor(parentBinding);
        const modelBinding = await openBoundMenu(getModelTrigger, 'model');
        if (!modelBinding) {
          lastStatus = 'model-kind-not-found';
          continue;
        }
        let model = readModelProof(modelBinding, getModelTrigger);
        if (!model.valid) {
          closeOpenMenus();
          return gpt56Failure('model-kind-not-found', {
            modeLabel: parent.effort.target?.textContent?.trim?.() || 'Pro',
          });
        }
        if (!model.model.targetSelected) {
          if (modelSwitches >= MAX_SWITCHES_PER_AXIS) break;
          // Both bindings and both axes are synchronously re-read before the
          // click. The click invalidates every handle and forces a full reproof.
          parent = readParentProof(parentBinding);
          model = readModelProof(modelBinding, getModelTrigger);
          const target =
            parent.valid && parent.effort.targetSelected && model.valid
              ? model.model.target
              : null;
          if (!target || !isLive(target)) {
            lastStatus = 'selection-unverified';
            continue;
          }
          dispatchClickSequence(target);
          modelSwitches += 1;
          switched = true;
          await sleep(STEP_WAIT_MS);
          continue;
        }

        // Final same-task reproof: active composer/pill, both live owner
        // bindings, exact unique rows, marker agreement, and exactly one checked
        // row per axis are all re-read without a wait between proof and return.
        parent = readParentProof(parentBinding);
        model = readModelProof(modelBinding, getModelTrigger);
        if (
          parent.valid &&
          parent.effort.targetSelected &&
          model.valid &&
          model.model.targetSelected
        ) {
          const modeRow = parent.effort.target;
          const modelRow = model.model.target;
          // Capture only inert labels before Escape can synchronously unmount
          // the menu portals. Authorization above is complete; detached DOM
          // handles never cross the close operation or leave this expression.
          const modeLabel = modeRow.textContent?.trim?.() || 'Pro';
          const modelLabel = modelRow.textContent?.trim?.() || 'GPT-5.6 Sol';
          closeOpenMenus();
          return verifiedGpt56SolPro(
            switched ? 'switched' : 'already-selected',
            modelLabel,
            modeLabel,
          );
        }
        lastStatus = 'selection-unverified';
      }
      const result = gpt56Failure(lastStatus);
      closeOpenMenus();
      return result;
    }

    const selectProEffortFromSubmenu = async () => {
      if (TARGET_MODEL_KIND !== 'pro' || (TARGET_LEVEL !== 'standard' && TARGET_LEVEL !== 'extended')) {
        return null;
      }
      const trigger = document.querySelector(PRO_EFFORT_TRIGGER_SELECTOR);
      if (!trigger) {
        return null;
      }
      dispatchHoverSequence(trigger);
      if (trigger.getAttribute?.('aria-expanded') !== 'true') {
        dispatchClickSequence(trigger);
      }
      const deadline = performance.now() + MAX_WAIT_MS;
      while (performance.now() < deadline) {
        const menu = findVisibleProEffortMenu(trigger);
        if (menu) {
          return selectAndVerify(trigger, () => {
            const currentMenu = findVisibleProEffortMenu(trigger);
            return currentMenu ? findProEffortOptionInMenu(currentMenu) : null;
          });
        }
        await sleep(100);
      }
      return null;
    };

    // Current ChatGPT exposes a standalone Pro or Thinking composer pill whose
    // controlled menu contains the effort levels. Prefer this ownership boundary
    // before probing older model-picker layouts.
    const COMPOSER_EFFORT_PILL_SELECTORS = [
      'form button.__composer-pill',
      '[data-testid="composer-footer-actions"] button.__composer-pill',
      '.__composer-pill-composite button.__composer-pill',
    ];
    const findComposerEffortPill = () => {
      const seen = new Set();
      let gpt56Fallback = null;
      for (const selector of COMPOSER_EFFORT_PILL_SELECTORS) {
        for (const button of document.querySelectorAll(selector)) {
          if (seen.has(button) || !isVisible(button)) continue;
          seen.add(button);
          if (button.getAttribute?.('data-testid') === 'model-switcher-dropdown-button') continue;
          const label = normalize(
            (button.getAttribute?.('aria-label') ?? '') + ' ' +
            (button.getAttribute?.('data-testid') ?? '') + ' ' +
            (button.textContent ?? ''),
          );
          if (
            (TARGET_MODEL_KIND === 'pro' && hasToken(label, 'pro') && !hasToken(label, 'thinking')) ||
            (TARGET_MODEL_KIND === 'thinking' && hasToken(label, 'thinking') && !hasToken(label, 'pro')) ||
            (!TARGET_MODEL_KIND && hasToken(label, 'thinking')) ||
            (button.matches?.('button.__composer-pill') && matchesAnyEffortLevel(label))
          ) {
            return button;
          }
          if (
            TARGET_IS_GPT56_MODEL &&
            button.matches?.('button.__composer-pill') &&
            normalize(button.textContent ?? '') === 'pro'
          ) {
            gpt56Fallback ||= button;
          }
        }
      }
      return gpt56Fallback;
    };
    let composerEffortPill = findComposerEffortPill();
    let modelBtn = findModelButton();
    const modelKindFromLegacyTrailing = (trailing) => {
      const row = trailing.closest?.(
        '[role="menuitem"], [role="menuitemradio"], [data-radix-collection-item]',
      );
      const idText = normalize(
        (row?.getAttribute?.('data-testid') ?? '') + ' ' +
        (trailing.getAttribute?.('data-testid') ?? '')
      );
      if (!idText.includes('model switcher')) return null;
      const modelPart = normalize(idText.replace(/\\bthinking effort\\b.*$/, ''));
      if (hasToken(modelPart, 'pro')) return 'pro';
      if (hasToken(modelPart, 'thinking')) return 'thinking';
      if (hasToken(modelPart, 'instant')) return 'instant';
      return null;
    };
    const legacyEffortOwnerIsReady = () => {
      if (
        TARGET_MODEL_KIND === 'pro' &&
        TARGET_LEVEL === 'extended' &&
        isVisible(document.querySelector(INTELLIGENCE_MENU_SELECTOR))
      ) {
        return true;
      }
      const expectedKind = TARGET_MODEL_KIND || modelKindFromNode(modelBtn);
      return Boolean(
        expectedKind &&
        findTrailingButtons().some(
          (button) => isVisible(button) && modelKindFromLegacyTrailing(button) === expectedKind,
        ),
      );
    };
    let attemptedModelButton =
      modelBtn?.getAttribute?.('aria-expanded') === 'true' ? modelBtn : null;
    const effortOwnerDeadline = performance.now() + MAX_WAIT_MS;
    while (!composerEffortPill && performance.now() < effortOwnerDeadline) {
      if (
        modelBtn &&
        attemptedModelButton !== modelBtn &&
        modelBtn.getAttribute?.('aria-expanded') !== 'true'
      ) {
        dispatchClickSequence(modelBtn);
        attemptedModelButton = modelBtn;
        await sleep(INITIAL_WAIT_MS);
      }
      if (modelBtn && legacyEffortOwnerIsReady()) break;
      await sleep(100);
      composerEffortPill = findComposerEffortPill();
      modelBtn = findModelButton();
      if (modelBtn?.getAttribute?.('aria-expanded') === 'true') {
        attemptedModelButton = modelBtn;
      }
    }
    if (composerEffortPill) {
      if (attemptedModelButton && attemptedModelButton !== composerEffortPill) closeOpenMenus();
      const composerModelKind =
        TARGET_MODEL_KIND ||
        (TARGET_IS_GPT56_MODEL ? 'versioned' : modelKindFromNode(composerEffortPill));
      if (composerEffortPill.getAttribute?.('aria-expanded') !== 'true') {
        dispatchClickSequence(composerEffortPill);
        await sleep(INITIAL_WAIT_MS);
      }
      const deadline = performance.now() + MAX_WAIT_MS;
      while (performance.now() < deadline) {
        const menu = findVisibleEffortMenu(composerEffortPill);
        if (menu) {
          const proEffortResult = await selectProEffortFromSubmenu();
          if (proEffortResult) {
            return proEffortResult;
          }
          return selectAndVerify(
            composerEffortPill,
            () => {
              const currentMenu = findVisibleEffortMenu(composerEffortPill);
              return currentMenu ? findOptionInMenu(currentMenu, composerModelKind) : null;
            },
            composerModelKind,
          );
        }
        await sleep(100);
      }
      const result = failure('menu-not-found', {
        modelKind: composerModelKind,
      });
      closeOpenMenus();
      return result;
    }

    // Older ChatGPT layouts attach effort controls to rows inside the model
    // picker. Keep these compatibility paths after the standalone pill owner.
    const findEffortRow = (node) => {
      let current = node instanceof HTMLElement ? node.parentElement : null;
      while (current && current !== document.body) {
        if (current.getAttribute?.('data-model-picker-thinking-effort-row') === 'true') {
          return current;
        }
        current = current.parentElement;
      }
      return null;
    };
    const rowIsSelected = (row) => {
      if (!(row instanceof HTMLElement)) return false;
      const modelItem = row.querySelector('[data-model-picker-thinking-effort-menu-item="true"], [role="menuitemradio"]');
      if (optionIsSelected(modelItem)) return true;
      return Boolean(
        row.querySelector(
          '[aria-checked="true"], [aria-selected="true"], [aria-current="true"], [data-selected="true"], [data-state="checked"], [data-state="selected"], [data-state="on"]',
        ),
      );
    };
    const rowForTrailing = (trailing) =>
      trailing.closest('[role="menuitem"], [role="menuitemradio"], [data-radix-collection-item]');
    const rowTextForTrailing = (trailing) => {
      const row = rowForTrailing(trailing) || findEffortRow(trailing);
      return normalize(
        (row?.getAttribute?.('aria-label') ?? '') + ' ' +
        (row?.getAttribute?.('data-testid') ?? '') + ' ' +
        (row?.textContent ?? '') + ' ' +
        (trailing.getAttribute?.('aria-label') ?? '') + ' ' +
        (trailing.getAttribute?.('data-testid') ?? '')
      );
    };
    const modelKindFromTrailing = modelKindFromLegacyTrailing;
    const trailingMatchesTargetModelKind = (trailing) => {
      if (!TARGET_MODEL_KIND) return false;
      const idKind = modelKindFromTrailing(trailing);
      if (idKind) return idKind === TARGET_MODEL_KIND;
      const text = rowTextForTrailing(trailing);
      if (TARGET_MODEL_KIND === 'pro') {
        return hasToken(text, 'pro') && !hasToken(text, 'thinking');
      }
      if (TARGET_MODEL_KIND === 'thinking') {
        return hasToken(text, 'thinking') && !hasToken(text, 'pro');
      }
      if (TARGET_MODEL_KIND === 'instant') {
        return hasToken(text, 'instant') && !hasToken(text, 'thinking') && !hasToken(text, 'pro');
      }
      return false;
    };
    const pickSingleStableTrailing = (trailings) => {
      const visible = trailings.filter((trailing) => isVisible(trailing));
      return visible.length === 1 ? visible[0] : null;
    };
    const pickTrailingForCurrentModel = () => {
      const trailings = findTrailingButtons();
      if (trailings.length === 0) return null;
      if (trailings.length === 1) return trailings[0];
      // Prefer the trailing button whose model row is currently selected.
      for (const t of trailings) {
        const row = findEffortRow(t);
        if (rowIsSelected(row)) return t;
      }
      if (TARGET_MODEL_KIND) {
        const targetTrailings = trailings.filter((t) => trailingMatchesTargetModelKind(t));
        return pickSingleStableTrailing(targetTrailings) || KIND_NOT_FOUND;
      }
      return null;
    };

    const modelButtonDeadline = performance.now() + MAX_WAIT_MS;
    while (!modelBtn && performance.now() < modelButtonDeadline) {
      await sleep(100);
      modelBtn = findModelButton();
    }
    if (!modelBtn) {
      return failure('chip-not-found');
    }
    // Open model menu (idempotent — leaves it open if already open).
    if (
      modelBtn.getAttribute('aria-expanded') !== 'true' &&
      !legacyEffortOwnerIsReady()
    ) {
      dispatchClickSequence(modelBtn);
      await sleep(INITIAL_WAIT_MS);
    }

    // ---------- COMPATIBILITY UI: unified "Intelligence" effort picker ----------
    // One observed ChatGPT layout replaced the per-model trailing buttons with a single
    // "Intelligence" menu ([data-testid="composer-intelligence-picker-content"]),
    // whose role="menuitemradio" rows are the effort tiers. We verify the checked
    // radio instead of trusting the composer-pill label; non-Pro targets also
    // explicitly skip Pro rows before matching effort labels.
    if (TARGET_MODEL_KIND === 'pro' && TARGET_LEVEL === 'extended') {
      const matchesProExtended = (node) => {
        const text = normalize(
          (node?.textContent ?? '') + ' ' + (node?.getAttribute?.('aria-label') ?? ''),
        );
        return text.includes('pro') && text.includes('extended');
      };
      const findProExtendedOption = () => {
        const menu = document.querySelector(INTELLIGENCE_MENU_SELECTOR);
        if (!isVisible(menu)) return null;
        for (const item of menu.querySelectorAll(
          '[role="menuitemradio"], [role="menuitem"], [role="option"]',
        )) {
          if (matchesProExtended(item)) return item;
        }
        return null;
      };
      let proExtended = null;
      const intelligenceDeadline = performance.now() + INTELLIGENCE_WAIT_MS;
      while (performance.now() < intelligenceDeadline) {
        proExtended = findProExtendedOption();
        if (proExtended) break;
        await sleep(100);
      }
      if (proExtended) {
        return selectAndVerify(modelBtn, findProExtendedOption);
      }
      // Intelligence menu absent (older UI) or its Pro Extended row is missing:
      // fall through to the legacy trailing-button path below.
    }

    let trailing = null;
    const trailingDeadline = performance.now() + MAX_WAIT_MS;
    while (performance.now() < trailingDeadline) {
      trailing = pickTrailingForCurrentModel();
      if (trailing) break;
      await sleep(100);
    }
    if (!trailing) {
      const result = failure('chip-not-found');
      closeOpenMenus();
      return result;
    }
    if (trailing.kindNotFound) {
      const result = failure('model-kind-not-found', { modelKind: TARGET_MODEL_KIND });
      closeOpenMenus();
      return result;
    }

    dispatchClickSequence(trailing);
    await sleep(STEP_WAIT_MS);

    // Resolve the effort submenu via aria-controls when ChatGPT exposes it,
    // otherwise fall back to scanning newly opened menus for our level tokens.
    const resolveEffortMenu = () => {
      const id = trailing.getAttribute('aria-controls');
      if (id) {
        const node = document.getElementById?.(id);
        if (isEffortMenu(node)) return node;
      }
      const menus = document.querySelectorAll(MENU_CONTAINER_SELECTOR);
      let best = null;
      for (const menu of menus) {
        if (menu === modelBtn || menu.contains(trailing)) continue;
        if (!isVisible(menu)) continue;
        const hits = countEffortLevels(menu);
        if (hits >= 2 && (!best || hits > best.hits)) best = { menu, hits };
      }
      return best?.menu ?? null;
    };

    let effortMenu = null;
    const effortDeadline = performance.now() + MAX_WAIT_MS;
    while (performance.now() < effortDeadline) {
      effortMenu = resolveEffortMenu();
      if (effortMenu) break;
      await sleep(100);
    }
    if (!effortMenu) {
      const result = failure('menu-not-found');
      closeOpenMenus();
      return result;
    }

    return selectAndVerify(trailing, () => {
      const currentMenu = resolveEffortMenu();
      return currentMenu ? findOptionInMenu(currentMenu) : null;
    });
  })()`;
}

export function buildThinkingTimeExpressionForTest(
  level: ThinkingTimeLevel = "extended",
  desiredModel?: string | null,
): string {
  return buildThinkingTimeExpression(level, desiredModel);
}

function inferThinkingTargetModelKind(
  desiredModel?: string | null,
): "pro" | "thinking" | "instant" | null {
  const normalized = normalizeModelLabel(desiredModel);
  if (!normalized) return null;
  const tokens = normalized.split(" ");
  if (tokens.includes("pro")) return "pro";
  if (tokens.includes("thinking")) return "thinking";
  if (tokens.includes("instant")) return "instant";
  return null;
}

// Normalize a model label for exact-match gating: lowercase, collapse every run
// of non-[a-z0-9] characters to a single space, and trim. This tolerates the
// formatting variance the fleet legitimately sends (casing, surrounding
// whitespace, and separator style — space / hyphen / dot / underscore /
// non-breaking hyphen all fold to the same shape) while preserving token order,
// adjacency, and the absence of extra tokens.
function normalizeModelLabel(value?: string | null): string {
  return (value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// The fleet serves exactly one model. Gating is a normalized EXACT match against
// this allowlist — never token membership — so reordered version digits
// ("GPT-6.5 Sol"), trailing variants ("GPT-5.6 Sol Mini"), extra tokens
// ("GPT-5.6 Sol Pro"), and prose / instruction-injection wrappers around the
// tokens are all refused. This predicate backs BOTH fleet money-path gates
// (serve /runs admission fallback in src/remote/server.ts + the client fleet
// pre-connect gate in src/remote/client.ts) plus the Sol+Pro
// verify-before-submit gating in this module, so any loosening here widens the
// trust boundary. See tests/browser/modelLabelGate.test.ts.
const GPT_5_6_SOL_LABEL_ALLOWLIST: ReadonlySet<string> = new Set(["gpt 5 6 sol"]);

export function isGpt56SolModelLabel(value?: string | null): boolean {
  return GPT_5_6_SOL_LABEL_ALLOWLIST.has(normalizeModelLabel(value));
}

export function inferThinkingTargetModelKindForTest(
  desiredModel?: string | null,
): "pro" | "thinking" | "instant" | null {
  return inferThinkingTargetModelKind(desiredModel);
}

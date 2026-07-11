import type { BrowserLogger, ChromeClient } from "../types.js";
import { formatElapsed } from "../../oracle/format.js";
import {
  buildRunProgressEvent,
  progressPercentFromElapsed,
  type RunProgressState,
} from "../../oracle/v18/run_progress.js";
import type { RunProgress } from "../../oracle/v18/index.js";
import {
  ASSISTANT_ROLE_SELECTOR,
  CONVERSATION_TURN_SELECTOR,
  STOP_BUTTON_SELECTORS,
} from "../constants.js";

const THINKING_STALE_HINT_MS = 10 * 60_000;

export interface ThinkingStatusSnapshot {
  message: string;
  source: "inline" | "sidecar";
  progressPercent?: number;
  panelOpened?: boolean;
  panelVisible?: boolean;
}

interface ThinkingStatusMonitorOptions {
  intervalMs?: number;
  now?: () => number;
  /**
   * Optional structured `run_progress.v1` emission for the browser lane. When
   * enabled (see {@link ThinkingStatusRunProgressOptions.enabled}), each
   * heartbeat tick also emits one run_progress NDJSON line — the same schema
   * the API lane emits — to a stderr sink, so a `--json` / detached poller gets
   * a machine-readable liveness signal instead of only prose.
   */
  runProgress?: ThinkingStatusRunProgressOptions;
}

export function startThinkingStatusMonitor(
  Runtime: ChromeClient["Runtime"],
  logger: BrowserLogger,
  options: ThinkingStatusMonitorOptions = {},
): () => void {
  const intervalMs = resolveThinkingStatusInterval(options.intervalMs);
  if (!intervalMs) {
    return () => {};
  }
  const now = options.now ?? Date.now;
  const runProgress = resolveThinkingRunProgress(options.runProgress);
  let stopped = false;
  let pending = false;
  let lastFingerprint: string | null = null;
  let lastChangedAt = now();
  const startedAt = now();
  const interval = setInterval(async () => {
    // stop flag flips asynchronously
    if (stopped || pending) {
      return;
    }
    pending = true;
    try {
      const snapshot = await readThinkingStatus(Runtime);
      if (stopped) {
        return;
      }
      const tickAt = now();
      let unchangedMs = 0;
      if (snapshot) {
        const fingerprint = buildThinkingStatusFingerprint(snapshot);
        if (fingerprint !== lastFingerprint) {
          lastFingerprint = fingerprint;
          lastChangedAt = tickAt;
        }
        if (stopped) {
          return;
        }
        unchangedMs = tickAt - lastChangedAt;
        logger(formatThinkingLog(startedAt, tickAt, snapshot, "", unchangedMs));
      } else {
        logger(formatThinkingWaitingLog(startedAt, tickAt));
      }
      if (runProgress && !stopped) {
        runProgress.emit(
          JSON.stringify(
            buildBrowserThinkingRunProgress({
              runId: runProgress.runId,
              phase: runProgress.phase,
              elapsedMs: tickAt - startedAt,
              timeoutMs: runProgress.timeoutMs,
              snapshot,
              unchangedMs,
            }),
          ),
        );
      }
    } catch {
      // ignore DOM polling errors
    } finally {
      pending = false;
    }
  }, intervalMs);
  interval.unref?.();
  return () => {
    // multiple callers may race to stop
    if (stopped) {
      return;
    }
    stopped = true;
    clearInterval(interval);
  };
}

// ─── run_progress.v1 emission adapter (browser lane) ─────────────────────────
//
// The browser lanes historically emitted only prose heartbeat lines, so a
// 5–60 min ChatGPT Pro run is a black box to an agent polling for liveness.
// This adapter maps the same monitor signals (UI %, elapsed, status label,
// stale-hint, phase) into the documented `run_progress.v1` schema, gated by the
// same env flag the API lane reads (ORACLE_RUN_PROGRESS_JSON=1) and written to
// stderr so stdout stays reserved for the final envelope in --json mode.

/** Coarse browser-lane phase; drives current_stage and the progress state. */
export type BrowserRunProgressPhase = "submit" | "verify" | "thinking" | "capture";

export interface BrowserThinkingProgressTick {
  /** run_progress `run_id` — the session id in practice. */
  readonly runId: string;
  /** Coarse phase; drives current_stage + state. Defaults to "thinking". */
  readonly phase?: BrowserRunProgressPhase;
  /** Monotonic elapsed time since the wait started, in ms. */
  readonly elapsedMs: number;
  /** Overall run timeout; used for elapsed-based percent when no UI % exists. */
  readonly timeoutMs?: number;
  /** Latest thinking-status snapshot, or null when none was detected yet. */
  readonly snapshot: ThinkingStatusSnapshot | null;
  /** ms since the snapshot fingerprint last changed (stale-hint source). */
  readonly unchangedMs?: number;
  /** Injected clock for a deterministic `last_event_at` in tests. */
  readonly now?: Date;
}

const BROWSER_RUN_PROGRESS_PROFILE = "browser";

function browserPhaseState(phase: BrowserRunProgressPhase): RunProgressState {
  return phase === "thinking" ? "thinking" : "running";
}

/**
 * Build one `run_progress.v1` event from a browser thinking-status tick. Pure
 * and deterministic given `now`, so the emission adapter can be unit-tested by
 * feeding fake ticks and asserting the resulting NDJSON.
 */
export function buildBrowserThinkingRunProgress(tick: BrowserThinkingProgressTick): RunProgress {
  const phase = tick.phase ?? "thinking";
  const snapshot = tick.snapshot;
  const uiPercent =
    snapshot &&
    typeof snapshot.progressPercent === "number" &&
    Number.isFinite(snapshot.progressPercent)
      ? Math.max(0, Math.min(100, Math.round(snapshot.progressPercent)))
      : null;
  const progressPercent = uiPercent ?? progressPercentFromElapsed(tick.elapsedMs, tick.timeoutMs);
  const unchangedMs = Math.max(0, tick.unchangedMs ?? 0);
  const staleHint = unchangedMs >= THINKING_STALE_HINT_MS;
  const statusLabel = snapshot?.message ?? (snapshot ? "active" : "waiting");
  const elapsedText = formatElapsed(Math.max(0, tick.elapsedMs));
  const userVisibleMessage = snapshot
    ? `ChatGPT ${phase} — ${elapsedText} elapsed${
        uiPercent != null ? `, ${uiPercent}% UI progress` : ""
      }${staleHint ? " (stale: no UI progress change)" : ""}.`
    : `Waiting for ChatGPT response — ${elapsedText} elapsed; no thinking status detected yet.`;
  return buildRunProgressEvent({
    run_id: tick.runId,
    profile: BROWSER_RUN_PROGRESS_PROFILE,
    state: browserPhaseState(phase),
    current_stage: `browser_${phase}`,
    progress_percent: progressPercent,
    user_visible_message: userVisibleMessage,
    now: tick.now,
    extras: {
      lane: "browser",
      elapsed_ms: Math.max(0, Math.round(tick.elapsedMs)),
      ui_progress_percent: uiPercent,
      status_label: statusLabel,
      source: snapshot?.source ?? null,
      stale_hint: staleHint,
    },
  });
}

/** NDJSON sink for run_progress lines. Defaults to a single stderr write. */
export type RunProgressLineSink = (line: string) => void;

function defaultRunProgressSink(line: string): void {
  // stderr only: stdout is reserved for the final --json envelope.
  process.stderr.write(`${line}\n`);
}

export interface ThinkingStatusRunProgressOptions {
  /** run_progress `run_id` (session id in practice). */
  readonly runId: string;
  /** Overall run timeout for the elapsed-based percent fallback. */
  readonly timeoutMs?: number;
  /** Coarse phase; defaults to "thinking". */
  readonly phase?: BrowserRunProgressPhase;
  /**
   * Force emission on/off. When omitted, resolves from
   * `ORACLE_RUN_PROGRESS_JSON==="1"` — the same env-flag path the API lane uses.
   */
  readonly enabled?: boolean;
  /** NDJSON sink; defaults to process.stderr (stdout stays clean). */
  readonly emit?: RunProgressLineSink;
}

interface ResolvedThinkingRunProgress {
  readonly runId: string;
  readonly timeoutMs?: number;
  readonly phase: BrowserRunProgressPhase;
  readonly emit: RunProgressLineSink;
}

/** Whether the browser lane should emit run_progress.v1 events, from env. */
export function shouldEmitBrowserRunProgress(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ORACLE_RUN_PROGRESS_JSON === "1";
}

function resolveThinkingRunProgress(
  options: ThinkingStatusRunProgressOptions | undefined,
): ResolvedThinkingRunProgress | null {
  if (!options) {
    return null;
  }
  const enabled = options.enabled ?? shouldEmitBrowserRunProgress();
  if (!enabled) {
    return null;
  }
  return {
    runId: options.runId,
    timeoutMs: options.timeoutMs,
    phase: options.phase ?? "thinking",
    emit: options.emit ?? defaultRunProgressSink,
  };
}

export function formatThinkingLog(
  startedAt: number,
  now: number,
  status: string | ThinkingStatusSnapshot,
  locatorSuffix: string,
  unchangedMs = 0,
): string {
  const elapsedMs = now - startedAt;
  const elapsedText = formatElapsed(elapsedMs);
  const snapshot: ThinkingStatusSnapshot =
    typeof status === "string"
      ? { message: sanitizeThinkingText(status) || "active", source: "inline" }
      : status;
  const progress =
    typeof snapshot.progressPercent === "number" && Number.isFinite(snapshot.progressPercent)
      ? `${Math.max(0, Math.min(100, Math.round(snapshot.progressPercent)))}% UI progress`
      : null;
  const prefix = progress
    ? `[browser] ChatGPT thinking - ${progress}, ${elapsedText} elapsed`
    : `[browser] ChatGPT thinking - ${elapsedText} elapsed`;
  const statusLabel = snapshot.message ? `; status=${snapshot.message}` : "";
  const changeLabel = unchangedMs > 0 ? `; last change ${formatElapsed(unchangedMs)} ago` : "";
  const staleLabel =
    unchangedMs >= THINKING_STALE_HINT_MS ? "; stale-hint=no UI progress change" : "";
  const sourceLabel = snapshot.source ? `; source=${snapshot.source}` : "";
  return `${prefix}${statusLabel}${changeLabel}${staleLabel}${sourceLabel}${locatorSuffix}`;
}

export function formatThinkingWaitingLog(startedAt: number, now: number): string {
  return `[browser] Waiting for ChatGPT response - ${formatElapsed(now - startedAt)} elapsed; no thinking status detected yet.`;
}

function resolveThinkingStatusInterval(intervalMs?: number): number | null {
  if (intervalMs === 0) {
    return null;
  }
  if (typeof intervalMs === "number" && Number.isFinite(intervalMs) && intervalMs > 0) {
    return Math.max(1000, Math.floor(intervalMs));
  }
  return 30_000;
}

function buildThinkingStatusFingerprint(snapshot: ThinkingStatusSnapshot): string {
  return [
    snapshot.source,
    snapshot.message,
    snapshot.progressPercent == null ? "" : Math.round(snapshot.progressPercent),
    snapshot.panelVisible ? "panel" : "",
  ].join(":");
}

async function readThinkingStatus(
  Runtime: ChromeClient["Runtime"],
): Promise<ThinkingStatusSnapshot | null> {
  const expression = buildThinkingStatusExpression();
  const { result } = await Runtime.evaluate({
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  const value = result.value as Partial<ThinkingStatusSnapshot> | string | null | undefined;
  if (typeof value === "string") {
    const sanitized = sanitizeThinkingText(value);
    return sanitized ? { message: sanitized, source: "inline" } : null;
  }
  if (!value || typeof value !== "object") {
    return null;
  }
  const source = value.source === "sidecar" ? "sidecar" : "inline";
  const message = sanitizeThinkingText(value.message ?? "");
  const progressPercent =
    typeof value.progressPercent === "number" && Number.isFinite(value.progressPercent)
      ? Math.max(0, Math.min(100, value.progressPercent))
      : undefined;
  if (!message && progressPercent == null) {
    return null;
  }
  return {
    message: message || "active",
    source,
    progressPercent,
    panelOpened: value.panelOpened === true,
    panelVisible: value.panelVisible === true,
  };
}

const SAFE_THINKING_STATUS_MESSAGES = new Set([
  "active",
  "response streaming",
  "thinking sidecar active",
  "thinking sidecar opened",
]);

export function sanitizeThinkingText(raw: string): string {
  if (!raw) {
    return "";
  }
  const trimmed = raw.replace(/\s+/g, " ").trim();
  const prefixPattern = /^(pro thinking)\s*[•:\-–—]*\s*/i;
  const normalized = prefixPattern.test(trimmed)
    ? trimmed.replace(prefixPattern, "").trim()
    : trimmed;
  if (!normalized) {
    return "";
  }
  const normalizedKey = normalized.toLowerCase();
  return SAFE_THINKING_STATUS_MESSAGES.has(normalizedKey) ? normalizedKey : "active";
}

function buildThinkingStatusExpression(): string {
  const conversationLiteral = JSON.stringify(CONVERSATION_TURN_SELECTOR);
  const assistantLiteral = JSON.stringify(ASSISTANT_ROLE_SELECTOR);
  const selectors = [
    "span.loading-shimmer",
    "span.flex.items-center.gap-1.truncate.text-start.align-middle.text-token-text-tertiary",
    '[data-testid*="thinking"]',
    '[data-testid*="reasoning"]',
    '[role="status"]',
    '[aria-live="polite"]',
  ];
  const keywords = ["pro thinking", "thinking", "reasoning"];
  const stopSelector = STOP_BUTTON_SELECTORS.join(", ");
  const selectorLiteral = JSON.stringify(selectors);
  const keywordsLiteral = JSON.stringify(keywords);
  const stopSelectorLiteral = JSON.stringify(stopSelector);
  return `(async () => {
    const CONVERSATION_SELECTOR = ${conversationLiteral};
    const ASSISTANT_SELECTOR = ${assistantLiteral};
    const selectors = ${selectorLiteral};
    const keywords = ${keywordsLiteral};
    const stopSelector = ${stopSelectorLiteral};
    const normalize = (value) =>
      String(value || '')
        .normalize('NFD')
        .replace(/[\\u0300-\\u036f]/g, '')
        .toLowerCase()
        .replace(/\\s+/g, ' ')
        .trim();
    const isVisible = (node) => {
      if (!(node instanceof HTMLElement)) return false;
      const rect = node.getBoundingClientRect();
      if (!rect || rect.width <= 0 || rect.height <= 0) return false;
      const style = window.getComputedStyle(node);
      if (
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        (style.opacity !== '' && Number(style.opacity) === 0)
      ) {
        return false;
      }
      return rect.bottom >= 0 && rect.right >= 0 && rect.top <= window.innerHeight && rect.left <= window.innerWidth;
    };
    const labelFor = (node) =>
      normalize([
        node.textContent,
        node.getAttribute?.('aria-label'),
        node.getAttribute?.('title'),
        node.getAttribute?.('data-testid'),
      ].filter(Boolean).join(' '));
    const looksLikeThinking = (node) => {
      const label = labelFor(node);
      return (
        label.includes('thinking') ||
        label.includes('reasoning') ||
        label.includes('pro thinking') ||
        label.includes('myslen') ||
        label.includes('mysl') ||
        label.includes('rozumow')
      );
    };
    const isComposerAdjacent = (node) =>
      Boolean(node.closest?.('[contenteditable="true"], textarea, [data-testid*="composer"], [id*="composer"]'));
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
    const latestAssistantTurn = () => {
      const turns = Array.from(document.querySelectorAll(CONVERSATION_SELECTOR));
      for (let index = turns.length - 1; index >= 0; index -= 1) {
        if (isAssistantTurn(turns[index])) {
          return turns[index];
        }
      }
      return null;
    };
    const findThinkingDisclosure = (scope) => {
      const candidates = Array.from(
        scope.querySelectorAll(
          [
            'button',
            '[role="button"]',
            '[aria-expanded]',
            '[data-testid*="thinking"]',
            '[data-testid*="reasoning"]',
          ].join(','),
        ),
      );
      for (const node of candidates) {
        if (!(node instanceof HTMLElement)) continue;
        if (!isVisible(node) || isComposerAdjacent(node) || !looksLikeThinking(node)) continue;
        if (node.getAttribute('aria-haspopup') === 'menu') continue;
        if (node.dataset?.oracleThinkingProbed === 'true') continue;
        const expanded = normalize(node.getAttribute('aria-expanded'));
        if (expanded !== 'false') {
          continue;
        }
        return node;
      }
      return null;
    };
    const findProgressPercent = (scope) => {
      const progressNodes = Array.from(
        scope.querySelectorAll('progress, [role="progressbar"], [aria-valuenow], [data-testid*="progress"], [class*="progress"]'),
      );
      const readNumeric = (raw) => {
        if (raw == null || raw === '') return null;
        const value = Number(String(raw).replace('%', '').trim());
        return Number.isFinite(value) ? value : null;
      };
      const readStylePercent = (node) => {
        const style = node instanceof HTMLElement ? window.getComputedStyle(node) : null;
        if (!style) return null;
        const widthMatch = String(node.style?.width || style.width || '').match(
          /([0-9]+(?:\\.[0-9]+)?)%/,
        );
        if (widthMatch) return readNumeric(widthMatch[1]);
        const transform = String(style.transform || '');
        const scaleMatch = transform.match(/scaleX\\(([0-9.]+)\\)/);
        if (scaleMatch) {
          const scale = readNumeric(scaleMatch[1]);
          return scale == null ? null : scale * 100;
        }
        const matrixMatch = transform.match(/matrix\\(([0-9.\\-]+),/);
        if (matrixMatch) {
          const scale = readNumeric(matrixMatch[1]);
          return scale == null ? null : scale * 100;
        }
        return null;
      };
      for (const node of progressNodes) {
        if (!(node instanceof HTMLElement) || !isVisible(node)) continue;
        const ariaNow = readNumeric(node.getAttribute('aria-valuenow'));
        if (ariaNow != null) {
          const ariaMin = readNumeric(node.getAttribute('aria-valuemin')) ?? 0;
          const ariaMax = readNumeric(node.getAttribute('aria-valuemax')) ?? 100;
          const span = Math.max(ariaMax - ariaMin, 1);
          return Math.max(0, Math.min(100, ((ariaNow - ariaMin) / span) * 100));
        }
        if (node instanceof HTMLProgressElement && Number.isFinite(node.value) && Number.isFinite(node.max) && node.max > 0) {
          return Math.max(0, Math.min(100, (node.value / node.max) * 100));
        }
        const stylePercent = readStylePercent(node);
        if (stylePercent != null) {
          return Math.max(0, Math.min(100, stylePercent));
        }
      }
      return null;
    };
    const findThinkingPanel = () => {
      const candidates = Array.from(
        document.querySelectorAll(
          [
            'aside',
            '[role="complementary"]',
            '[role="dialog"]',
            '[data-testid*="thinking"]',
            '[data-testid*="reasoning"]',
            '[data-testid*="sidebar"]',
            '[class*="sidecar"]',
            '[class*="sidebar"]',
          ].join(','),
        ),
      );
      for (const node of candidates) {
        if (!(node instanceof HTMLElement) || !isVisible(node) || isComposerAdjacent(node)) continue;
        const rect = node.getBoundingClientRect();
        const rightSidePanel = rect.left >= window.innerWidth * 0.35 && rect.width >= 180 && rect.height >= 120;
        const hasProgress = findProgressPercent(node) != null;
        if (hasProgress || (rightSidePanel && looksLikeThinking(node))) {
          return node;
        }
      }
      return null;
    };
    const existingPanel = findThinkingPanel();
    if (existingPanel) {
      return {
        message: 'thinking sidecar active',
        source: 'sidecar',
        progressPercent: findProgressPercent(existingPanel),
        panelOpened: false,
        panelVisible: true,
      };
    }
    let panelOpened = false;
    const currentTurn = latestAssistantTurn();
    const disclosure = currentTurn ? findThinkingDisclosure(currentTurn) : null;
    if (disclosure) {
      try {
        disclosure.dataset.oracleThinkingProbed = 'true';
        disclosure.click();
        panelOpened = true;
        await new Promise((resolve) => setTimeout(resolve, 200));
      } catch {
        // non-fatal; fall through to passive status detection
      }
    }
    const panel = findThinkingPanel();
    if (panel) {
      const progressPercent = findProgressPercent(panel);
      return {
        message: panelOpened ? 'thinking sidecar opened' : 'thinking sidecar active',
        source: 'sidecar',
        progressPercent,
        panelOpened,
        panelVisible: true,
      };
    }
    const nodes = new Set();
    for (const selector of selectors) {
      document.querySelectorAll(selector).forEach((node) => nodes.add(node));
    }
    for (const node of nodes) {
      if (!(node instanceof HTMLElement)) {
        continue;
      }
      const text = node.textContent?.trim();
      if (!text) {
        continue;
      }
      const classLabel = String(node.className || '').toLowerCase();
      const dataLabel = ((node.getAttribute('data-testid') || '') + ' ' + (node.getAttribute('aria-label') || ''))
        .toLowerCase();
      const normalizedText = text.toLowerCase();
      const matches = keywords.some((keyword) =>
        normalizedText.includes(keyword) || classLabel.includes(keyword) || dataLabel.includes(keyword)
      );
      if (matches) {
        return {
          message: 'active',
          source: 'inline',
        };
      }
    }
    // Last-resort liveness fallback: selector drift can hide every thinking
    // indicator while a response is still generating, and returning null here
    // reads as "dead" downstream. The stop/interrupt control is a stable,
    // language-independent signal that generation is active; it lives in the
    // composer, so isComposerAdjacent must not filter it.
    const stopVisible = Array.from(document.querySelectorAll(stopSelector)).some((node) =>
      isVisible(node),
    );
    if (stopVisible) {
      return {
        message: 'response streaming',
        source: 'inline',
      };
    }
    return null;
  })()`;
}

export const startThinkingStatusMonitorForTest = startThinkingStatusMonitor;
export const readThinkingStatusForTest = readThinkingStatus;
export const buildThinkingStatusExpressionForTest = buildThinkingStatusExpression;

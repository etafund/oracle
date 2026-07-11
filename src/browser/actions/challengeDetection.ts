// Challenge / login access-state detection.
//
// Distinguishes, with READ-ONLY structural DOM probes:
//   (a) login / forced-reauth walls            -> "login_required"
//   (b) verification interstitials             -> "verification_interstitial"
//       (edge "unusual activity" / human-verification interludes)
//   (c) provider account security blocks       -> "account_security_block"
//   (d) rate-limit refusal surfaces            -> "rate_limited"
//   (e) healthy logged-in state                -> "healthy"
//   (f) anything unprovable                    -> "indeterminate"
//
// ACCOUNT-SAFETY HARD-HALT DOCTRINE (shared with quarantineLatch.ts):
// detection NEVER clicks, types, focuses, solves, retries, or otherwise
// interacts with a verification step — the probe expression contains no
// event dispatch of any kind and the gates only read. On a challenge-class
// detection the run stops cleanly with a typed error and the worker-local
// quarantine latch is tripped BEFORE the error surfaces; the account owner
// resolves the state manually. Defensive fault isolation, never
// anti-detection.
//
// Taxonomy alignment: the state classes extend the existing
// chatgpt-ui-warning classification (rate_limit / auth_or_challenge,
// src/browser/index.ts) into admission-gate form; the serve layer reuses
// these functions for /runs admission and the /ready body.

import { CLOUDFLARE_SCRIPT_SELECTOR, CLOUDFLARE_TITLE, INPUT_SELECTORS } from "../constants.js";
import type { BrowserLogger, ChromeClient } from "../types.js";
import { BrowserAutomationError } from "../../oracle/errors.js";
import {
  assertNotQuarantined,
  tripQuarantineLatch,
  type QuarantineLatchOptions,
} from "../quarantineLatch.js";

export type BrowserAccessStateClass =
  | "healthy"
  | "login_required"
  | "verification_interstitial"
  | "account_security_block"
  | "rate_limited"
  | "indeterminate";

/** State classes that must trip the worker-local quarantine latch. */
export const QUARANTINE_STATE_CLASSES: ReadonlySet<BrowserAccessStateClass> = new Set([
  "verification_interstitial",
  "account_security_block",
]);

/** State classes that refuse a run (superset of the quarantine classes). */
export const RUN_REFUSAL_STATE_CLASSES: ReadonlySet<BrowserAccessStateClass> = new Set([
  "verification_interstitial",
  "account_security_block",
  "login_required",
  "rate_limited",
]);

/** Raw, read-only facts probed from the page in a single evaluation. */
export interface BrowserAccessFacts {
  url: string | null;
  title: string | null;
  interstitialTitle: boolean;
  interstitialScript: boolean;
  interstitialUrlMarker: boolean;
  bodySample: string;
  composerPresent: boolean;
  composerVisible: boolean;
  loginCtaVisible: boolean;
  onAuthPath: boolean;
  accountSignal: boolean;
}

export interface BrowserAccessReport {
  state: BrowserAccessStateClass;
  at: string;
  url: string | null;
  title: string | null;
  /** Neutral signal names that fired; safe for logs and /ready bodies. */
  signals: string[];
  composerUsable: boolean;
  /** DOM-level logged-in signal (composer + account affordance). */
  appSessionOk: boolean;
}

export type ChallengeGate = "pre-run" | "pre-result";

export class ChallengeGateError extends BrowserAutomationError {
  constructor(gate: ChallengeGate, report: BrowserAccessReport, message: string) {
    super(message, {
      stage: "challenge-gate",
      code: `challenge-gate-${report.state}`,
      gate,
      state: report.state,
      signals: report.signals,
      retryable: false,
    });
    this.name = "ChallengeGateError";
  }
}

const BODY_SAMPLE_CHARS = 4_000;

// Neutral phrase sets. Verification interstitials and security blocks are
// challenge-class (quarantine); the others are refusal-only.
const VERIFICATION_INTERSTITIAL_PHRASES = [
  "verify you are human",
  "verifying you are human",
  "checking your browser",
  "enable javascript and cookies to continue",
  "unusual traffic",
  "performance & security by",
] as const;

const SECURITY_BLOCK_PHRASES = ["suspicious activity detected", "secure your account"] as const;

// Mirrors the rate-limit vocabulary of classifyChatGptUiWarningText
// (src/browser/index.ts chatgpt-ui-warning taxonomy).
const RATE_LIMIT_PHRASES = [
  "too many requests",
  "sending too many requests",
  "temporarily limited access",
  "please wait a few minutes",
  "you are being rate limited",
  "rate limited",
  "rate limit exceeded",
  "rate limit reached",
  "rate limit hit",
] as const;

const LOGIN_WALL_PHRASES = [
  "log in to get answers",
  "get responses tailored to you",
  "log in or sign up",
] as const;

export interface AccessProbeOptions {
  /**
   * PRE-RESULT re-probe only: exclude the assistant turns' rendered text from the
   * body sample so the just-captured answer's own prose can never classify the
   * live page as a challenge wall. A genuine interstitial replaces the whole page
   * (its text is NOT inside an assistant turn), so the wall stays detectable while
   * an answer that merely quotes challenge vocabulary no longer self-quarantines
   * a healthy worker. Left off for the pre-run gate, which must see the full body.
   */
  excludeAssistantText?: boolean;
}

function buildAccessStateProbeExpression(options: AccessProbeOptions = {}): string {
  const interstitialScriptSelector = JSON.stringify(CLOUDFLARE_SCRIPT_SELECTOR);
  const interstitialTitle = JSON.stringify(CLOUDFLARE_TITLE.toLowerCase());
  const inputSelectors = JSON.stringify(INPUT_SELECTORS);
  const excludeAssistantText = options.excludeAssistantText === true;
  // READ-ONLY by contract: no clicks, no focus, no key events, no fetches.
  return `(() => {
    const normalize = (value) => String(value || '').toLowerCase().replace(/\\s+/g, ' ').trim();
    const isVisible = (node) => {
      if (!(node instanceof HTMLElement) || typeof node.getBoundingClientRect !== 'function') {
        return false;
      }
      const rect = node.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      const style = window.getComputedStyle(node);
      return Boolean(style) && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const href = typeof location === 'object' && location.href ? location.href : null;
    const pathname =
      typeof location === 'object' && typeof location.pathname === 'string'
        ? location.pathname
        : '';
    const hostname =
      typeof location === 'object' && typeof location.hostname === 'string'
        ? location.hostname
        : '';
    const title = typeof document.title === 'string' ? document.title : null;
    const excludeAssistantText = ${excludeAssistantText ? "true" : "false"};
    const rawBodyText = document.body ? (document.body.innerText || '') : '';
    let scopedBodyText = rawBodyText;
    if (excludeAssistantText && document.body) {
      // Drop the assistant turns' rendered text before sampling. A genuine wall
      // replaces the page (its text lives outside any assistant turn), so this
      // keeps real interstitial/security-block phrases detectable while an answer
      // that merely quotes challenge vocabulary is removed. Read-only: the live
      // DOM is never mutated (substrings are removed from a copied string).
      const assistantTurns = Array.from(
        document.querySelectorAll('[data-message-author-role="assistant"], [data-turn="assistant"]'),
      );
      for (const turn of assistantTurns) {
        const turnText =
          turn && (turn.innerText || turn.textContent) ? (turn.innerText || turn.textContent) : '';
        if (turnText) {
          scopedBodyText = scopedBodyText.split(turnText).join(' ');
        }
      }
    }
    const bodySample = normalize(scopedBodyText).slice(0, ${BODY_SAMPLE_CHARS});

    const composerNodes = ${inputSelectors}
      .map((selector) => document.querySelector(selector))
      .filter(Boolean);
    const composerPresent = composerNodes.length > 0;
    const composerVisible = composerNodes.some((node) => isVisible(node));

    const loginCtaVisible = (() => {
      const candidates = Array.from(
        document.querySelectorAll('a[href*="/auth/login"], a[href*="/auth/signin"], button, a'),
      );
      for (const node of candidates) {
        if (!isVisible(node)) continue;
        const label = normalize(
          node.textContent || node.getAttribute('aria-label') || node.getAttribute('title') || '',
        );
        if (
          label === 'log in' ||
          label === 'login' ||
          label === 'sign in' ||
          label === 'signin' ||
          label === 'sign up for free' ||
          label.startsWith('continue with')
        ) {
          return true;
        }
      }
      return false;
    })();

    return {
      url: href,
      title,
      interstitialTitle: Boolean(title && title.toLowerCase().includes(${interstitialTitle})),
      interstitialScript: Boolean(document.querySelector(${interstitialScriptSelector})),
      interstitialUrlMarker: Boolean(href && /\\/cdn-cgi\\/challenge|__cf_chl/.test(href)),
      bodySample,
      composerPresent,
      composerVisible,
      loginCtaVisible,
      onAuthPath:
        /^\\/(auth|login|signin)/i.test(pathname) || hostname.includes('auth.openai.com'),
      accountSignal: Boolean(
        document.querySelector('[data-testid="accounts-profile-button"]') ||
          document.querySelector('[data-testid^="history-item-"]'),
      ),
    };
  })()`;
}

export function buildAccessStateProbeExpressionForTest(options: AccessProbeOptions = {}): string {
  return buildAccessStateProbeExpression(options);
}

function coerceAccessFacts(value: unknown): BrowserAccessFacts | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  // Require at least one discriminating field so arbitrary evaluate results
  // (unit-test stubs, unrelated pages) coerce to null -> indeterminate.
  if (!("bodySample" in raw) || !("composerPresent" in raw)) return null;
  return {
    url: typeof raw.url === "string" ? raw.url : null,
    title: typeof raw.title === "string" ? raw.title : null,
    interstitialTitle: raw.interstitialTitle === true,
    interstitialScript: raw.interstitialScript === true,
    interstitialUrlMarker: raw.interstitialUrlMarker === true,
    bodySample: typeof raw.bodySample === "string" ? raw.bodySample : "",
    composerPresent: raw.composerPresent === true,
    composerVisible: raw.composerVisible === true,
    loginCtaVisible: raw.loginCtaVisible === true,
    onAuthPath: raw.onAuthPath === true,
    accountSignal: raw.accountSignal === true,
  };
}

/** Pure classification over probed facts — exported for unit tests and serve reuse. */
export function classifyBrowserAccessFacts(facts: BrowserAccessFacts): BrowserAccessReport {
  const signals: string[] = [];
  const body = facts.bodySample;

  if (facts.interstitialTitle) signals.push("interstitial-title");
  if (facts.interstitialScript) signals.push("interstitial-script");
  if (facts.interstitialUrlMarker) signals.push("interstitial-url-marker");
  for (const phrase of VERIFICATION_INTERSTITIAL_PHRASES) {
    if (body.includes(phrase)) {
      signals.push("interstitial-text");
      break;
    }
  }
  const securityBlock = SECURITY_BLOCK_PHRASES.every((phrase) => body.includes(phrase));
  if (securityBlock) signals.push("security-block-text");
  const rateLimited = RATE_LIMIT_PHRASES.some((phrase) => body.includes(phrase));
  if (rateLimited) signals.push("rate-limit-text");
  if (facts.onAuthPath) signals.push("auth-path");
  if (facts.loginCtaVisible) signals.push("login-cta");
  for (const phrase of LOGIN_WALL_PHRASES) {
    if (body.includes(phrase)) {
      signals.push("login-wall-text");
      break;
    }
  }
  if (facts.composerVisible) signals.push("composer-visible");
  if (facts.accountSignal) signals.push("account-signal");

  const appSessionOk = facts.composerVisible && facts.accountSignal;
  const base = {
    at: new Date().toISOString(),
    url: facts.url,
    title: facts.title,
    signals,
    composerUsable: facts.composerVisible,
    appSessionOk,
  };

  // ChatGPT can transiently load Cloudflare's challenge-platform script inside
  // an otherwise healthy signed-in app. Script presence alone is only a
  // challenge signal when the usable app session is absent; title, URL, and
  // wall text remain authoritative even if stale app DOM is still mounted.
  const authoritativeInterstitial = signals.some(
    (signal) => signal.startsWith("interstitial-") && signal !== "interstitial-script",
  );
  const scriptWithoutUsableApp = facts.interstitialScript && !appSessionOk;
  if (authoritativeInterstitial || scriptWithoutUsableApp) {
    return { state: "verification_interstitial", ...base };
  }
  if (securityBlock) {
    return { state: "account_security_block", ...base };
  }
  if (
    facts.onAuthPath ||
    ((facts.loginCtaVisible || signals.includes("login-wall-text")) && !appSessionOk)
  ) {
    return { state: "login_required", ...base };
  }
  if (rateLimited) {
    return { state: "rate_limited", ...base };
  }
  if (appSessionOk) {
    return { state: "healthy", ...base };
  }
  return { state: "indeterminate", ...base };
}

/**
 * Single read-only probe of the current page's access state. Any evaluation
 * failure degrades to "indeterminate" (with a probe-error signal) — the
 * GATES decide what indeterminate means for their context.
 */
export async function probeBrowserAccessState(
  runtime: ChromeClient["Runtime"],
  options: AccessProbeOptions = {},
): Promise<BrowserAccessReport> {
  let facts: BrowserAccessFacts | null = null;
  try {
    const { result } = await runtime.evaluate({
      expression: buildAccessStateProbeExpression(options),
      returnByValue: true,
    });
    facts = coerceAccessFacts(result?.value);
  } catch {
    facts = null;
  }
  if (!facts) {
    return {
      state: "indeterminate",
      at: new Date().toISOString(),
      url: null,
      title: null,
      signals: ["probe-error"],
      composerUsable: false,
      appSessionOk: false,
    };
  }
  return classifyBrowserAccessFacts(facts);
}

export interface AccessGateOptions {
  quarantine?: QuarantineLatchOptions;
  runId?: string | null;
  sessionId?: string | null;
}

async function refuseForState(
  gate: ChallengeGate,
  report: BrowserAccessReport,
  logger: BrowserLogger,
  options: AccessGateOptions,
): Promise<never> {
  if (QUARANTINE_STATE_CLASSES.has(report.state)) {
    // Trip the latch BEFORE surfacing the terminal error so a crash in
    // between still leaves the worker latched.
    const outcome = await tripQuarantineLatch({
      ...(options.quarantine ?? {}),
      reason: report.state,
      detail: `signals: ${report.signals.join(",") || "none"}`,
      runId: options.runId ?? null,
      sessionId: options.sessionId ?? null,
      source: `${gate}-gate`,
    });
    logger(
      `[browser] ${report.state} detected at ${gate} gate; account quarantine latch ` +
        `${outcome.alreadyLatched ? "already present" : "tripped"} at ${outcome.latchPath}. ` +
        "Stopping cleanly; a human must resolve the account state and clear the latch manually.",
    );
    throw new ChallengeGateError(
      gate,
      report,
      `${report.state} detected at the ${gate} gate; the run was stopped and the account ` +
        `was quarantined (latch: ${outcome.latchPath}). Automation never attempts to solve, ` +
        "retry, or evade a verification step — resolve the account state manually, then " +
        "delete the latch file.",
    );
  }
  logger(`[browser] ${report.state} detected at ${gate} gate; refusing to proceed.`);
  throw new ChallengeGateError(
    gate,
    report,
    `${report.state} detected at the ${gate} gate; refusing to proceed. ` +
      (report.state === "login_required"
        ? "Restore the login manually, then rerun."
        : "Wait for the provider limit to lift, then rerun."),
  );
}

/**
 * PRE-RUN gate (browser side): called before any prompt is composed or
 * submitted. Hard-stops when the worker's quarantine latch is present
 * (independent of any serve/router admission racing a retry), refuses on any
 * positive detection, and trips the latch for challenge-class states.
 * "indeterminate" passes here — the browser-side gate refuses only on proof;
 * the serve-layer /runs admission implements the fail-closed HTTP refusal.
 */
export async function assertPreRunAccessState(
  runtime: ChromeClient["Runtime"],
  logger: BrowserLogger,
  options: AccessGateOptions = {},
): Promise<BrowserAccessReport> {
  await assertNotQuarantined(options.quarantine ?? {});
  const report = await probeBrowserAccessState(runtime);
  if (RUN_REFUSAL_STATE_CLASSES.has(report.state)) {
    await refuseForState("pre-run", report, logger, options);
  }
  if (report.state === "indeterminate") {
    logger(
      "[browser] Access-state probe indeterminate at pre-run gate; continuing (no positive challenge/login signal).",
    );
  }
  return report;
}

// ── Pre-result artifact screening ───────────────────────────────────────────

const ARTIFACT_HTML_MARKERS = ["/cdn-cgi/challenge", "challenge-platform", "__cf_chl"] as const;

// Only phrases that unambiguously belong to a challenge wall. The generic
// Cloudflare title "just a moment" is NOT included: it is common conversational
// filler ("Just a moment while I think about this."), and a short benign answer
// starting with it would otherwise strip to a tiny residue and self-quarantine
// the worker. A genuine "Just a moment…" interstitial always co-renders the
// verification phrases below (and the HTML challenge markers / interstitial
// title check cover the platform page), so detection is unaffected.
const ARTIFACT_TEXT_PHRASES = [...VERIFICATION_INTERSTITIAL_PHRASES] as const;

const LOGIN_ARTIFACT_PHRASES = [...LOGIN_WALL_PHRASES, "welcome back"] as const;

const ARTIFACT_MAX_CHARS = 1_000;
const ARTIFACT_RESIDUE_MAX_CHARS = 48;

export interface CapturedAnswerArtifactVerdict {
  artifact: boolean;
  /** Set when artifact=true. */
  state?: Extract<BrowserAccessStateClass, "verification_interstitial" | "login_required">;
  signals: string[];
}

/**
 * Conservative content screen: flags captured text that IS an access-wall
 * artifact, not answers that merely mention one. A capture is an artifact
 * only when it is short, matches wall phrases, and has almost no residual
 * content once those phrases are removed — a real answer about verification
 * pages keeps its surrounding prose and passes.
 */
export function screenCapturedAnswerForAccessArtifacts(
  text: string,
  html?: string | null,
): CapturedAnswerArtifactVerdict {
  const signals: string[] = [];
  const rawHtml = String(html ?? "");
  for (const marker of ARTIFACT_HTML_MARKERS) {
    if (rawHtml.includes(marker)) {
      signals.push("artifact-html-marker");
      return { artifact: true, state: "verification_interstitial", signals };
    }
  }
  const normalized = String(text ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized || normalized.length > ARTIFACT_MAX_CHARS) {
    return { artifact: false, signals };
  }
  const residueAfter = (phrases: readonly string[]): { matched: boolean; residue: number } => {
    let matched = false;
    let stripped = normalized;
    for (const phrase of phrases) {
      if (stripped.includes(phrase)) {
        matched = true;
        stripped = stripped.split(phrase).join(" ");
      }
    }
    return { matched, residue: stripped.replace(/[^a-z0-9]+/g, "").length };
  };

  const interstitial = residueAfter(ARTIFACT_TEXT_PHRASES);
  if (interstitial.matched && interstitial.residue <= ARTIFACT_RESIDUE_MAX_CHARS) {
    signals.push("artifact-interstitial-text");
    return { artifact: true, state: "verification_interstitial", signals };
  }
  const login = residueAfter([...LOGIN_ARTIFACT_PHRASES, "log in", "sign up"]);
  const loginPhraseHit = LOGIN_ARTIFACT_PHRASES.some((phrase) => normalized.includes(phrase));
  if (loginPhraseHit && login.residue <= ARTIFACT_RESIDUE_MAX_CHARS) {
    signals.push("artifact-login-text");
    return { artifact: true, state: "login_required", signals };
  }
  return { artifact: false, signals };
}

/**
 * PRE-RESULT gate: never emit an access-wall page as an answer. Runs a pure
 * content screen over the captured text/html, then a live read-only re-probe
 * of the page state. Challenge-class findings trip the quarantine latch
 * before the typed error surfaces. An indeterminate live probe passes — the
 * capture already survived structural binding validation, and this gate
 * refuses only on positive evidence.
 */
export async function assertCapturedAnswerNotAccessArtifact(
  runtime: ChromeClient["Runtime"],
  captured: { text: string; html?: string | null },
  logger: BrowserLogger,
  options: AccessGateOptions = {},
): Promise<void> {
  const verdict = screenCapturedAnswerForAccessArtifacts(captured.text, captured.html);
  if (verdict.artifact && verdict.state) {
    const report: BrowserAccessReport = {
      state: verdict.state,
      at: new Date().toISOString(),
      url: null,
      title: null,
      signals: verdict.signals,
      composerUsable: false,
      appSessionOk: false,
    };
    await refuseForState("pre-result", report, logger, options);
  }
  // Scope the live re-probe to the page CHROME, not the captured answer: the
  // body sample excludes the assistant turns so an answer that merely quotes
  // challenge vocabulary (e.g. an agent asking Oracle about CAPTCHAs) cannot
  // quarantine a healthy signed-in worker. A real wall that replaced the page
  // still classifies here (its text is outside any assistant turn).
  const report = await probeBrowserAccessState(runtime, { excludeAssistantText: true });
  if (QUARANTINE_STATE_CLASSES.has(report.state) || report.state === "login_required") {
    await refuseForState("pre-result", report, logger, options);
  }
}

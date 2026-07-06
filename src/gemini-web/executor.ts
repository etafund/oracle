import path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  BrowserRunOptions,
  BrowserRunResult,
  BrowserLogger,
  CookieParam,
} from "../browser/types.js";
import { getCookies } from "@steipete/sweet-cookie";
import { runProviderDomFlow } from "../browser/providerDomFlow.js";
import { delay } from "../browser/utils.js";
import { BrowserAutomationError } from "../oracle/errors.js";
import { runGeminiWebWithFallback, saveFirstGeminiImageFromOutput } from "./client.js";
import {
  geminiDeepThinkWithStrategyDomProviderWithFsm,
  emitGeminiDeepThinkV18ArtifactsForRun,
  type WiredGeminiDeepThinkAdapter,
} from "../browser/providers/index.js";
import { resolveGeminiWebModel, type GeminiWebModelId } from "./models.js";
import type { GeminiWebOptions, GeminiWebResponse } from "./types.js";
import { openGeminiBrowserSession } from "./browserSessionManager.js";
import { selectGeminiExecutionMode } from "./executionMode.js";
import type { IGeminiExecutionClient } from "./executionClients.js";
import { buildGeminiStreamCaptureSummary, sha256OfGeminiText } from "./streamSafeguards.js";

export class GeminiDeepThinkFallbackBlockedError extends Error {
  constructor(public readonly reasons: string[]) {
    super(
      `Gemini Deep Think cannot use its verified DOM path for this run (blocked by: ${reasons.join(", ")}), ` +
        "and --gemini-deep-think-fallback fail refuses the unverified HTTP/header fallback path.\n" +
        "Fix: drop --file/--generate-image/--edit-image from this Deep Think run, or explicitly accept the " +
        "less-verified fallback by omitting --gemini-deep-think-fallback fail.",
    );
    this.name = "GeminiDeepThinkFallbackBlockedError";
  }
}

const GEMINI_COOKIE_NAMES = [
  "__Secure-1PSID",
  "__Secure-1PSIDTS",
  "__Secure-1PSIDCC",
  "__Secure-1PAPISID",
  "NID",
  "AEC",
  "SOCS",
  "__Secure-BUCKET",
  "__Secure-ENID",
  "SID",
  "HSID",
  "SSID",
  "APISID",
  "SAPISID",
  "__Secure-3PSID",
  "__Secure-3PSIDTS",
  "__Secure-3PAPISID",
  "SIDCC",
] as const;

const GEMINI_REQUIRED_COOKIES = ["__Secure-1PSID", "__Secure-1PSIDTS"] as const;

interface GeminiCookieLoadResult {
  cookieMap: Record<string, string>;
  warnings: string[];
}

function estimateTokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}

function resolveInvocationPath(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return path.isAbsolute(trimmed) ? trimmed : path.resolve(process.cwd(), trimmed);
}

function resolveCookieDomain(cookie: { domain?: string; url?: string }): string | null {
  const rawDomain = cookie.domain?.trim();
  if (rawDomain) {
    return rawDomain.startsWith(".") ? rawDomain.slice(1) : rawDomain;
  }
  const rawUrl = cookie.url?.trim();
  if (rawUrl) {
    try {
      return new URL(rawUrl).hostname;
    } catch {
      return null;
    }
  }
  return null;
}

function pickCookieValue<
  T extends { name?: string; value?: string; domain?: string; path?: string; url?: string },
>(cookies: T[], name: string): string | undefined {
  const matches = cookies.filter(
    (cookie) => cookie.name === name && typeof cookie.value === "string",
  );
  if (matches.length === 0) return undefined;

  const preferredDomain = matches.find((cookie) => {
    const domain = resolveCookieDomain(cookie);
    return domain === "google.com" && (cookie.path ?? "/") === "/";
  });
  const googleDomain = matches.find((cookie) =>
    (resolveCookieDomain(cookie) ?? "").endsWith("google.com"),
  );
  return (preferredDomain ?? googleDomain ?? matches[0])?.value;
}

function buildGeminiCookieMap<
  T extends { name?: string; value?: string; domain?: string; path?: string; url?: string },
>(cookies: T[]): Record<string, string> {
  const cookieMap: Record<string, string> = {};
  for (const name of GEMINI_COOKIE_NAMES) {
    const value = pickCookieValue(cookies, name);
    if (value) cookieMap[name] = value;
  }
  return cookieMap;
}

function hasRequiredGeminiCookies(cookieMap: Record<string, string>): boolean {
  return GEMINI_REQUIRED_COOKIES.every((name) => Boolean(cookieMap[name]));
}

const GEMINI_CDP_COOKIE_URLS = [
  "https://gemini.google.com",
  "https://accounts.google.com",
  "https://www.google.com",
];

async function loadGeminiCookiesFromCDP(
  browserConfig: BrowserRunOptions["config"],
  log?: BrowserLogger,
): Promise<GeminiCookieLoadResult> {
  const session = await openGeminiBrowserSession({
    browserConfig,
    keepBrowserDefault: false,
    purpose: "Gemini manual-login cookie extraction (no keychain)",
    log,
  });
  try {
    const client = session.client;
    const { Network, Page } = client;
    await Network.enable({});
    await Page.enable();

    log?.("[gemini-web] Navigating to gemini.google.com for sign-in/cookie capture...");
    await Page.navigate({ url: "https://gemini.google.com" });
    await delay(2_000);

    const pollTimeoutMs = 5 * 60_000;
    const pollIntervalMs = 2_000;
    const deadline = Date.now() + pollTimeoutMs;
    let lastNotice = 0;
    let cookieMap: Record<string, string> = {};

    while (Date.now() < deadline) {
      const { cookies } = await Network.getCookies({ urls: GEMINI_CDP_COOKIE_URLS });
      cookieMap = buildGeminiCookieMap(cookies);

      if (hasRequiredGeminiCookies(cookieMap)) {
        log?.(`[gemini-web] Extracted ${Object.keys(cookieMap).length} Gemini cookie(s) via CDP.`);
        return { cookieMap, warnings: [] };
      }

      const now = Date.now();
      if (now - lastNotice > 10_000) {
        log?.(
          "[gemini-web] Waiting for Google sign-in... please sign in in the opened Chrome window.",
        );
        lastNotice = now;
      }

      await delay(pollIntervalMs);
    }

    throw new Error("Timed out waiting for Google sign-in (5 minutes). Please sign in and retry.");
  } finally {
    await session.close();
  }
}

/**
 * Typed error for a caller-gone abort on the Gemini lane, mirroring the
 * ChatGPT lane's contract (buildClientAbortError in src/browser/index.ts):
 * pre-submit aborts are retryable transport interruptions; once the prompt
 * has been submitted the run is NOT auto-retryable and no Gemini-side
 * cancellation is attempted — the run is simply abandoned.
 */
function buildGeminiClientAbortError(promptSubmitted: boolean): BrowserAutomationError {
  return new BrowserAutomationError(
    promptSubmitted
      ? "Caller disconnected after submit; abandoning the Gemini run without Gemini-side cancellation."
      : "Caller disconnected before submit; aborting the Gemini run.",
    {
      stage: "client-abort",
      oracleErrorClass: promptSubmitted
        ? "transport_interrupted_after_submit"
        : "transport_interrupted_before_submit",
      retryable: !promptSubmitted,
    },
  );
}

async function runGeminiDeepThinkViaBrowser(
  prompt: string,
  wired: WiredGeminiDeepThinkAdapter,
  browserConfig: BrowserRunOptions["config"],
  log?: BrowserLogger,
  signal?: AbortSignal,
): Promise<{ text: string; thoughts: string | null }> {
  // promptSubmitted is read at abort time so the typed class reflects
  // whether the Send boundary was crossed (same contract as the ChatGPT lane).
  let promptSubmitted = false;
  if (signal?.aborted) {
    throw buildGeminiClientAbortError(promptSubmitted);
  }
  const session = await openGeminiBrowserSession({
    browserConfig,
    keepBrowserDefault: true,
    purpose: "Gemini Deep Think",
    log,
  });
  let removeAbortListener: (() => void) | null = () => {};
  try {
    const client = session.client;
    const { Runtime, Page } = client;
    if (
      !Runtime ||
      typeof Runtime.enable !== "function" ||
      typeof Runtime.evaluate !== "function"
    ) {
      throw new Error("Chrome Runtime domain unavailable for Gemini Deep Think DOM automation.");
    }
    if (!Page || typeof Page.enable !== "function" || typeof Page.navigate !== "function") {
      throw new Error("Chrome Page domain unavailable for Gemini Deep Think DOM automation.");
    }
    await Runtime.enable();
    await Page.enable();

    // Caller-gone abort (BrowserRunOptions.signal): mirror the ChatGPT
    // lane's raceWithAbort (src/browser/index.ts) so a cancelled run stops
    // at the next wait point and unwinds through session cleanup instead
    // of polling out the full RESPONSE_TIMEOUT_MS.
    const abortPromise = new Promise<never>((_, reject) => {
      if (!signal) {
        return;
      }
      const rejectAborted = () => {
        log?.("[gemini-web] Caller disconnected; aborting run at the next wait point.");
        reject(buildGeminiClientAbortError(promptSubmitted));
      };
      if (signal.aborted) {
        rejectAborted();
        return;
      }
      signal.addEventListener("abort", rejectAborted, { once: true });
      removeAbortListener = () => signal.removeEventListener("abort", rejectAborted);
    });
    // Keep the rejection handled even if no wait is currently racing it.
    void abortPromise.catch(() => undefined);
    const raceWithAbort = <T>(promise: Promise<T>): Promise<T> =>
      Promise.race([promise, abortPromise]);

    const evaluate = async <T>(expression: string): Promise<T | undefined> => {
      const { result } = await Runtime.evaluate({ expression, returnByValue: true });
      return result?.value as T | undefined;
    };

    log?.("[gemini-web] Navigating to gemini.google.com...");
    await raceWithAbort(Promise.resolve(Page.navigate({ url: "https://gemini.google.com/app" })));
    await raceWithAbort(delay(3_000));

    // Track the Send boundary so an abort mid-flight is classified
    // before/after submit like the ChatGPT lane. The wrapper delegates to
    // the FSM-wired adapter, so verification gating is unchanged.
    const adapter: WiredGeminiDeepThinkAdapter = {
      ...wired,
      submitPrompt: async (ctx) => {
        await wired.submitPrompt(ctx);
        promptSubmitted = true;
      },
    };

    // Production path: wrap through the v18 verification FSM so the
    // adapter cannot call submitPrompt before Deep Think is verified
    // in the same browser session (oracle-svt). The caller owns the
    // wired adapter (one per run) so it can also emit v18 artifacts
    // from the FSM's recorded verdict after this call resolves.
    // Every wait point inside the provider polls via ctx.evaluate/ctx.delay,
    // so racing those (plus the flow itself) makes an abort take effect
    // promptly at whichever wait the run is currently parked on.
    const domResult = await raceWithAbort(
      runProviderDomFlow(adapter, {
        prompt,
        evaluate: <T>(expression: string): Promise<T | undefined> =>
          raceWithAbort(evaluate<T>(expression)),
        delay: (ms: number) => raceWithAbort(delay(ms)),
        log,
        state: {
          inputTimeoutMs: browserConfig?.inputTimeoutMs,
          timeoutMs: browserConfig?.timeoutMs,
        },
      }),
    );

    log?.(`[gemini-web] Deep Think response received (${domResult.text.length} chars).`);
    return domResult;
  } finally {
    removeAbortListener?.();
    await session.close();
  }
}

async function loadGeminiCookiesFromInline(
  browserConfig: BrowserRunOptions["config"],
  log?: BrowserLogger,
): Promise<GeminiCookieLoadResult> {
  const inline = browserConfig?.inlineCookies;
  if (!inline || inline.length === 0) return { cookieMap: {}, warnings: [] };

  const cookieMap = buildGeminiCookieMap(
    inline.filter((cookie): cookie is CookieParam =>
      Boolean(cookie?.name && typeof cookie.value === "string"),
    ),
  );

  if (Object.keys(cookieMap).length > 0) {
    const source = browserConfig?.inlineCookiesSource ?? "inline";
    log?.(
      `[gemini-web] Loaded Gemini cookies from inline payload (${source}): ${Object.keys(cookieMap).length} cookie(s).`,
    );
  } else {
    log?.("[gemini-web] Inline cookie payload provided but no Gemini cookies matched.");
  }

  return { cookieMap, warnings: [] };
}

async function loadGeminiCookiesFromChrome(
  browserConfig: BrowserRunOptions["config"],
  log?: BrowserLogger,
): Promise<GeminiCookieLoadResult> {
  try {
    // Learned: Gemini web relies on Google auth cookies in the *browser* profile, not API keys.
    const profileCandidate =
      browserConfig?.chromeCookiePath ?? browserConfig?.chromeProfile ?? undefined;
    const profile =
      typeof profileCandidate === "string" && profileCandidate.trim().length > 0
        ? profileCandidate.trim()
        : undefined;

    const sources = [
      "https://gemini.google.com",
      "https://accounts.google.com",
      "https://www.google.com",
    ];

    const { cookies, warnings } = await getCookies({
      url: sources[0],
      origins: sources,
      names: [...GEMINI_COOKIE_NAMES],
      browsers: ["chrome"],
      mode: "merge",
      chromeProfile: profile,
      timeoutMs: 5_000,
    });
    if (warnings.length && log?.verbose) {
      log(`[gemini-web] Cookie warnings:\n- ${warnings.join("\n- ")}`);
    }

    const cookieMap = buildGeminiCookieMap(cookies);

    log?.(
      `[gemini-web] Loaded Gemini cookies from Chrome (node): ${Object.keys(cookieMap).length} cookie(s).`,
    );
    return { cookieMap, warnings };
  } catch (error) {
    log?.(
      `[gemini-web] Failed to load Chrome cookies via node: ${error instanceof Error ? error.message : String(error ?? "")}`,
    );
    return { cookieMap: {}, warnings: [] };
  }
}

function formatGeminiCookieError(warnings: string[]): string {
  const base =
    "Gemini browser mode requires Chrome cookies for google.com (missing __Secure-1PSID/__Secure-1PSIDTS).";
  const guidance =
    "Try --browser-manual-login or --browser-inline-cookies-file if local cookie extraction is unavailable.";
  if (warnings.length === 0) {
    return `${base} ${guidance}`;
  }
  return `${base}\nCookie read warnings:\n- ${warnings.join("\n- ")}\n${guidance}`;
}

async function loadGeminiCookies(
  browserConfig: BrowserRunOptions["config"],
  log?: BrowserLogger,
  options?: { preferManualNoKeychain?: boolean },
): Promise<GeminiCookieLoadResult> {
  const inlineResult = await loadGeminiCookiesFromInline(browserConfig, log);
  const hasInlineRequired = hasRequiredGeminiCookies(inlineResult.cookieMap);
  if (hasInlineRequired) {
    return inlineResult;
  }

  const manualNoKeychain =
    Boolean(browserConfig?.manualLogin) || Boolean(options?.preferManualNoKeychain);
  if (manualNoKeychain) {
    log?.("[gemini-web] Using manual-login cookie extraction path (no keychain cookie read).");
    const cdpResult = await loadGeminiCookiesFromCDP(browserConfig, log);
    return {
      cookieMap: { ...cdpResult.cookieMap, ...inlineResult.cookieMap },
      warnings: [...inlineResult.warnings, ...cdpResult.warnings],
    };
  }

  if (browserConfig?.cookieSync === false && !hasInlineRequired) {
    log?.("[gemini-web] Cookie sync disabled and inline cookies missing Gemini auth tokens.");
    return inlineResult;
  }

  const chromeResult = await loadGeminiCookiesFromChrome(browserConfig, log);
  return {
    cookieMap: { ...chromeResult.cookieMap, ...inlineResult.cookieMap },
    warnings: [...inlineResult.warnings, ...chromeResult.warnings],
  };
}

export function createGeminiWebExecutor(
  geminiOptions: GeminiWebOptions,
): (runOptions: BrowserRunOptions) => Promise<BrowserRunResult> {
  return async (runOptions: BrowserRunOptions): Promise<BrowserRunResult> => {
    const startTime = Date.now();
    const log = runOptions.log;

    log?.("[gemini-web] Starting Gemini web executor (TypeScript)");

    const model: GeminiWebModelId = resolveGeminiWebModel(runOptions.config?.desiredModel, log);
    const generateImagePath = resolveInvocationPath(geminiOptions.generateImage);
    const editImagePath = resolveInvocationPath(geminiOptions.editImage);
    const outputPath = resolveInvocationPath(geminiOptions.outputPath);
    const attachmentPaths = (runOptions.attachments ?? []).map((attachment) => attachment.path);

    let prompt = runOptions.prompt;
    if (geminiOptions.aspectRatio && (generateImagePath || editImagePath)) {
      prompt = `${prompt} (aspect ratio: ${geminiOptions.aspectRatio})`;
    }
    if (geminiOptions.youtube) {
      prompt = `${prompt}\n\nYouTube video: ${geminiOptions.youtube}`;
    }
    if (generateImagePath && !editImagePath) {
      prompt = `Generate an image: ${prompt}`;
    }

    const modeSelection = selectGeminiExecutionMode({
      model,
      attachmentPaths,
      generateImagePath,
      editImagePath,
    });

    const domClient: IGeminiExecutionClient = {
      mode: "dom",
      execute: async () => {
        log?.("[gemini-web] Using browser DOM automation for Deep Think.");
        // A fresh wired adapter is built per run so each browser session
        // owns its own FSM. We keep the reference here (rather than
        // inside runGeminiDeepThinkViaBrowser) so the v18 emission call
        // below can read the FSM's recorded verdict on BOTH the success
        // and failure paths (oracle-scb: live Deep Think DOM runs must
        // stop shipping zero v18 artifacts/evidence-ledger entries).
        // The *WithStrategy* variant additionally applies the
        // high-if-exposed thinking-level strategy during selectMode, so
        // live runs pick the 'high' effort tier whenever Gemini's UI
        // exposes the selector (previously dead code — the bare variant
        // was wired here and 'high' was never attempted).
        const wired = geminiDeepThinkWithStrategyDomProviderWithFsm();
        const sessionId = runOptions.sessionId ?? `gemini-deep-think-dom-${randomUUID()}`;

        let browserResult: { text: string; thoughts: string | null } | null = null;
        let runError: unknown = null;
        try {
          browserResult = await runGeminiDeepThinkViaBrowser(
            prompt,
            wired,
            runOptions.config,
            log,
            runOptions.signal,
          );
        } catch (error) {
          runError = error;
        }

        const answerText = browserResult?.text ?? "";
        const stream = buildGeminiStreamCaptureSummary({
          text: answerText,
          chunkCount: answerText.length > 0 ? 1 : 0,
          nonEmptyCandidateCount: answerText.length > 0 ? 1 : 0,
          currentSessionId: sessionId,
        });

        try {
          const emitResult = await emitGeminiDeepThinkV18ArtifactsForRun({
            wired,
            sessionId,
            promptText: prompt,
            answerText,
            stream,
            promptManifestSha256: sha256OfGeminiText(prompt),
            sourceBaselineSha256: sha256OfGeminiText(
              "oracle-gemini-deep-think-dom-source-baseline:v1",
            ),
            providerResultId: `provider-result-${sessionId}-gemini_deep_think`,
            evidenceId: `evidence-${sessionId}-gemini_deep_think`,
            runId: sessionId,
          });
          log?.(
            `[gemini-web] v18 artifacts: ${emitResult.synthesisEligible ? "eligible" : "blocked"}` +
              (emitResult.blockedErrorCodes.length
                ? ` (blocked: ${emitResult.blockedErrorCodes.join(", ")})`
                : ""),
          );
        } catch (emitError) {
          // Mirror the ChatGPT v18 wrapper's contract (runLive_emit_artifacts.ts):
          // a live browser run that already succeeded/failed on its own
          // terms must not be re-classified just because artifact
          // emission tripped. Log and move on.
          log?.(
            `[gemini-web] v18 artifact emission failed: ${
              emitError instanceof Error ? emitError.message : String(emitError)
            }`,
          );
        }

        if (runError) {
          throw runError;
        }
        const result = browserResult as { text: string; thoughts: string | null };

        const tookMs = Date.now() - startTime;
        let answerMarkdown = result.text;
        if (geminiOptions.showThoughts && result.thoughts) {
          answerMarkdown = `## Thinking\n\n${result.thoughts}\n\n## Response\n\n${result.text}`;
        }
        log?.(`[gemini-web] Completed in ${tookMs}ms`);
        return {
          answerText: result.text,
          answerMarkdown,
          tookMs,
          answerTokens: estimateTokenCount(result.text),
          answerChars: result.text.length,
        };
      },
    };

    const httpClient: IGeminiExecutionClient = {
      mode: "http",
      execute: async () => {
        const useNoKeychainPath = Boolean(runOptions.config?.manualLogin);
        const cookieResult = await loadGeminiCookies(runOptions.config, log, {
          preferManualNoKeychain: useNoKeychainPath,
        });
        if (!hasRequiredGeminiCookies(cookieResult.cookieMap)) {
          throw new Error(formatGeminiCookieError(cookieResult.warnings));
        }

        const configTimeout =
          typeof runOptions.config?.timeoutMs === "number" &&
          Number.isFinite(runOptions.config.timeoutMs)
            ? Math.max(1_000, runOptions.config.timeoutMs)
            : null;

        const defaultTimeoutMs = geminiOptions.youtube
          ? 240_000
          : geminiOptions.generateImage || geminiOptions.editImage
            ? 300_000
            : 120_000;

        const timeoutMs = Math.min(configTimeout ?? defaultTimeoutMs, 600_000);
        // Session identity for stream-ownership/cross-talk guards: threaded
        // into every StreamGenerate parse so typed capture errors carry the
        // run they belong to (oracle-svt cross-talk class).
        const httpSessionId = runOptions.sessionId ?? `gemini-web-http-${randomUUID()}`;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        // Caller-gone abort (BrowserRunOptions.signal): merge the caller's
        // signal into the timeout controller so cancelling the run actually
        // aborts in-flight Gemini fetches instead of letting them run to
        // completion (the ChatGPT lane already honors this signal).
        const callerSignal = runOptions.signal;
        const onCallerAbort = () => controller.abort();
        if (callerSignal?.aborted) {
          controller.abort();
        } else {
          callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
        }

        let response: GeminiWebResponse;

        try {
          if (editImagePath) {
            const intro = await runGeminiWebWithFallback({
              prompt: "Here is an image to edit",
              files: [editImagePath],
              model,
              cookieMap: cookieResult.cookieMap,
              chatMetadata: null,
              signal: controller.signal,
              sessionId: httpSessionId,
            });
            const editPrompt = `Use image generation tool to ${prompt}`;
            const out = await runGeminiWebWithFallback({
              prompt: editPrompt,
              files: attachmentPaths,
              model,
              cookieMap: cookieResult.cookieMap,
              chatMetadata: intro.metadata,
              signal: controller.signal,
              sessionId: httpSessionId,
              // Gemini mints a fresh rcid per turn; if this continuation turn
              // echoes the intro turn's candidate id we captured stale content
              // (cross-talk/replay) and the parse guard fails retry-safe.
              previousResponseCandidateId: intro.responseCandidateId ?? null,
            });
            response = {
              text: out.text ?? null,
              thoughts: geminiOptions.showThoughts ? out.thoughts : null,
              has_images: false,
              image_count: 0,
              effective_model: out.effectiveModel,
            };

            const resolvedOutputPath = outputPath ?? generateImagePath ?? "generated.png";
            const imageSave = await saveFirstGeminiImageFromOutput(
              out,
              cookieResult.cookieMap,
              resolvedOutputPath,
              controller.signal,
            );
            response.has_images = imageSave.saved;
            response.image_count = imageSave.imageCount;
            if (!imageSave.saved) {
              throw new Error(
                `No images generated. Response text:\n${out.text || "(empty response)"}`,
              );
            }
          } else if (generateImagePath) {
            const out = await runGeminiWebWithFallback({
              prompt,
              files: attachmentPaths,
              model,
              cookieMap: cookieResult.cookieMap,
              chatMetadata: null,
              signal: controller.signal,
              sessionId: httpSessionId,
            });
            response = {
              text: out.text ?? null,
              thoughts: geminiOptions.showThoughts ? out.thoughts : null,
              has_images: false,
              image_count: 0,
              effective_model: out.effectiveModel,
            };
            const imageSave = await saveFirstGeminiImageFromOutput(
              out,
              cookieResult.cookieMap,
              generateImagePath,
              controller.signal,
            );
            response.has_images = imageSave.saved;
            response.image_count = imageSave.imageCount;
            if (!imageSave.saved) {
              throw new Error(
                `No images generated. Response text:\n${out.text || "(empty response)"}`,
              );
            }
          } else {
            const out = await runGeminiWebWithFallback({
              prompt,
              files: attachmentPaths,
              model,
              cookieMap: cookieResult.cookieMap,
              chatMetadata: null,
              signal: controller.signal,
              sessionId: httpSessionId,
            });
            response = {
              text: out.text ?? null,
              thoughts: geminiOptions.showThoughts ? out.thoughts : null,
              has_images: out.images.length > 0,
              image_count: out.images.length,
              effective_model: out.effectiveModel,
            };
          }
        } finally {
          clearTimeout(timeout);
          callerSignal?.removeEventListener("abort", onCallerAbort);
        }

        const answerText = response.text ?? "";
        let answerMarkdown = answerText;

        if (geminiOptions.showThoughts && response.thoughts) {
          answerMarkdown = `## Thinking\n\n${response.thoughts}\n\n## Response\n\n${answerText}`;
        }

        if (response.has_images && response.image_count > 0) {
          const imagePath = generateImagePath || outputPath || "generated.png";
          answerMarkdown += `\n\n*Generated ${response.image_count} image(s). Saved to: ${imagePath}*`;
        }

        // Surface silent model fallback (oracle: "silent model downgrade"):
        // runGeminiWebWithFallback retries with FALLBACK_GEMINI_WEB_MODEL when
        // the requested model is unavailable, so a gemini-3.1-pro request can
        // be answered by a materially weaker model. Mirror the
        // `Resolved model: X → Y` pattern from oracle/run.ts so the
        // substitution is visible in logs, the answer, and result warnings.
        const effectiveModel = response.effective_model ?? null;
        const modelDowngraded = effectiveModel !== null && effectiveModel !== model;
        if (modelDowngraded) {
          log?.(
            `[gemini-web] Resolved model: ${model} → ${effectiveModel} (requested model unavailable; fell back)`,
          );
          answerMarkdown += `\n\n*Note: requested model \`${model}\` was unavailable; this answer was produced by \`${effectiveModel}\`.*`;
        }

        const tookMs = Date.now() - startTime;
        log?.(`[gemini-web] Completed in ${tookMs}ms`);

        return {
          answerText,
          answerMarkdown,
          ...(modelDowngraded
            ? {
                warnings: [
                  {
                    code: "gemini-web-model-fallback",
                    severity: "warning" as const,
                    message: `Requested Gemini model ${model} was unavailable; response was produced by ${effectiveModel}.`,
                    details: { requestedModel: model, effectiveModel },
                  },
                ],
              }
            : {}),
          tookMs,
          answerTokens: estimateTokenCount(answerText),
          answerChars: answerText.length,
        };
      },
    };

    if (model === "gemini-3-pro-deep-think" && modeSelection.mode === "http") {
      if (geminiOptions.deepThinkFallback === "fail") {
        throw new GeminiDeepThinkFallbackBlockedError(modeSelection.reasons);
      }
      log?.(
        `[gemini-web] Deep Think DOM path skipped (${modeSelection.reasons.join(", ")} requested); using HTTP/header fallback path.`,
      );
    }

    const executionClient = modeSelection.mode === "dom" ? domClient : httpClient;
    return executionClient.execute();
  };
}

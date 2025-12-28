import path from 'node:path';
import type { BrowserRunOptions, BrowserRunResult, BrowserLogger, CookieParam } from '../browser/types.js';
import { getCookies } from '@steipete/sweet-cookie';
import { runGeminiWebWithFallback, saveFirstGeminiImageFromOutput } from './client.js';
import type { GeminiWebModelId } from './client.js';
import type { GeminiWebOptions, GeminiWebResponse } from './types.js';

const GEMINI_COOKIE_NAMES = [
  '__Secure-1PSID',
  '__Secure-1PSIDTS',
  '__Secure-1PSIDCC',
  '__Secure-1PAPISID',
  'NID',
  'AEC',
  'SOCS',
  '__Secure-BUCKET',
  '__Secure-ENID',
  'SID',
  'HSID',
  'SSID',
  'APISID',
  'SAPISID',
  '__Secure-3PSID',
  '__Secure-3PSIDTS',
  '__Secure-3PAPISID',
  'SIDCC',
] as const;

const GEMINI_REQUIRED_COOKIES = ['__Secure-1PSID', '__Secure-1PSIDTS'] as const;

function estimateTokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}

function resolveInvocationPath(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return path.isAbsolute(trimmed) ? trimmed : path.resolve(process.cwd(), trimmed);
}

function resolveGeminiWebModel(
  desiredModel: string | null | undefined,
  log?: BrowserLogger,
): GeminiWebModelId {
  const desired = typeof desiredModel === 'string' ? desiredModel.trim() : '';
  if (!desired) return 'gemini-3-pro';

  switch (desired) {
    case 'gemini-3-pro':
    case 'gemini-3.0-pro':
      return 'gemini-3-pro';
    case 'gemini-2.5-pro':
      return 'gemini-2.5-pro';
    case 'gemini-2.5-flash':
      return 'gemini-2.5-flash';
    default:
      if (desired.startsWith('gemini-')) {
        log?.(
          `[gemini-web] Unsupported Gemini web model "${desired}". Falling back to gemini-3-pro.`,
        );
      }
      return 'gemini-3-pro';
  }
}

function resolveCookieDomain(cookie: { domain?: string; url?: string }): string | null {
  const rawDomain = cookie.domain?.trim();
  if (rawDomain) {
    return rawDomain.startsWith('.') ? rawDomain.slice(1) : rawDomain;
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

function pickCookieValue<T extends { name?: string; value?: string; domain?: string; path?: string; url?: string }>(
  cookies: T[],
  name: string,
): string | undefined {
  const matches = cookies.filter((cookie) => cookie.name === name && typeof cookie.value === 'string');
  if (matches.length === 0) return undefined;

  const preferredDomain = matches.find((cookie) => {
    const domain = resolveCookieDomain(cookie);
    return domain === 'google.com' && (cookie.path ?? '/') === '/';
  });
  const googleDomain = matches.find((cookie) => (resolveCookieDomain(cookie) ?? '').endsWith('google.com'));
  return (preferredDomain ?? googleDomain ?? matches[0])?.value;
}

function buildGeminiCookieMap<T extends { name?: string; value?: string; domain?: string; path?: string; url?: string }>(
  cookies: T[],
): Record<string, string> {
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

async function loadGeminiCookiesFromInline(
  browserConfig: BrowserRunOptions['config'],
  log?: BrowserLogger,
): Promise<Record<string, string>> {
  const inline = browserConfig?.inlineCookies;
  if (!inline || inline.length === 0) return {};

  const cookieMap = buildGeminiCookieMap(
    inline.filter((cookie): cookie is CookieParam => Boolean(cookie?.name && typeof cookie.value === 'string')),
  );

  if (Object.keys(cookieMap).length > 0) {
    const source = browserConfig?.inlineCookiesSource ?? 'inline';
    log?.(`[gemini-web] Loaded Gemini cookies from inline payload (${source}): ${Object.keys(cookieMap).length} cookie(s).`);
  } else {
    log?.('[gemini-web] Inline cookie payload provided but no Gemini cookies matched.');
  }

  return cookieMap;
}

async function loadGeminiCookiesFromChrome(
  browserConfig: BrowserRunOptions['config'],
  log?: BrowserLogger,
): Promise<Record<string, string>> {
  try {
    // Learned: Gemini web relies on Google auth cookies in the *browser* profile, not API keys.
    const profileCandidate =
      browserConfig?.chromeCookiePath ?? browserConfig?.chromeProfile ?? undefined;
    const profile =
      typeof profileCandidate === 'string' && profileCandidate.trim().length > 0
        ? profileCandidate.trim()
        : undefined;

    const sources = [
      'https://gemini.google.com',
      'https://accounts.google.com',
      'https://www.google.com',
    ];

    const { cookies, warnings } = await getCookies({
      url: sources[0],
      origins: sources,
      names: [...GEMINI_COOKIE_NAMES],
      browsers: ['chrome'],
      mode: 'merge',
      chromeProfile: profile,
      timeoutMs: 5_000,
    });
    if (warnings.length && log?.verbose) {
      log(`[gemini-web] Cookie warnings:\n- ${warnings.join('\n- ')}`);
    }

    const cookieMap = buildGeminiCookieMap(cookies);

    log?.(
      `[gemini-web] Loaded Gemini cookies from Chrome (node): ${Object.keys(cookieMap).length} cookie(s).`,
    );
    return cookieMap;
  } catch (error) {
    log?.(
      `[gemini-web] Failed to load Chrome cookies via node: ${error instanceof Error ? error.message : String(error ?? '')}`,
    );
    return {};
  }
}

async function loadGeminiCookies(
  browserConfig: BrowserRunOptions['config'],
  log?: BrowserLogger,
): Promise<Record<string, string>> {
  const inlineMap = await loadGeminiCookiesFromInline(browserConfig, log);
  const hasInlineRequired = hasRequiredGeminiCookies(inlineMap);
  if (hasInlineRequired && browserConfig?.cookieSync === false) {
    return inlineMap;
  }

  if (browserConfig?.cookieSync === false && !hasInlineRequired) {
    log?.('[gemini-web] Cookie sync disabled and inline cookies missing Gemini auth tokens.');
    return inlineMap;
  }

  const chromeMap = await loadGeminiCookiesFromChrome(browserConfig, log);
  const merged = { ...chromeMap, ...inlineMap };
  return merged;
}

export function createGeminiWebExecutor(
  geminiOptions: GeminiWebOptions,
): (runOptions: BrowserRunOptions) => Promise<BrowserRunResult> {
  return async (runOptions: BrowserRunOptions): Promise<BrowserRunResult> => {
    const startTime = Date.now();
    const log = runOptions.log;

    log?.('[gemini-web] Starting Gemini web executor (TypeScript)');

    const cookieMap = await loadGeminiCookies(runOptions.config, log);
    if (!hasRequiredGeminiCookies(cookieMap)) {
      throw new Error(
        'Gemini browser mode requires Chrome cookies for google.com (missing __Secure-1PSID/__Secure-1PSIDTS).',
      );
    }

    const configTimeout =
      typeof runOptions.config?.timeoutMs === 'number' && Number.isFinite(runOptions.config.timeoutMs)
        ? Math.max(1_000, runOptions.config.timeoutMs)
        : null;

    const defaultTimeoutMs = geminiOptions.youtube
      ? 240_000
      : geminiOptions.generateImage || geminiOptions.editImage
        ? 300_000
        : 120_000;

    const timeoutMs = Math.min(configTimeout ?? defaultTimeoutMs, 600_000);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

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

    const model: GeminiWebModelId = resolveGeminiWebModel(runOptions.config?.desiredModel, log);
    let response: GeminiWebResponse;

    try {
      if (editImagePath) {
        const intro = await runGeminiWebWithFallback({
          prompt: 'Here is an image to edit',
          files: [editImagePath],
          model,
          cookieMap,
          chatMetadata: null,
          signal: controller.signal,
        });
        const editPrompt = `Use image generation tool to ${prompt}`;
        const out = await runGeminiWebWithFallback({
          prompt: editPrompt,
          files: attachmentPaths,
          model,
          cookieMap,
          chatMetadata: intro.metadata,
          signal: controller.signal,
        });
        response = {
          text: out.text ?? null,
          thoughts: geminiOptions.showThoughts ? out.thoughts : null,
          has_images: false,
          image_count: 0,
        };

        const resolvedOutputPath = outputPath ?? generateImagePath ?? 'generated.png';
        const imageSave = await saveFirstGeminiImageFromOutput(out, cookieMap, resolvedOutputPath, controller.signal);
        response.has_images = imageSave.saved;
        response.image_count = imageSave.imageCount;
        if (!imageSave.saved) {
          throw new Error(`No images generated. Response text:\n${out.text || '(empty response)'}`);
        }
      } else if (generateImagePath) {
        const out = await runGeminiWebWithFallback({
          prompt,
          files: attachmentPaths,
          model,
          cookieMap,
          chatMetadata: null,
          signal: controller.signal,
        });
        response = {
          text: out.text ?? null,
          thoughts: geminiOptions.showThoughts ? out.thoughts : null,
          has_images: false,
          image_count: 0,
        };
        const imageSave = await saveFirstGeminiImageFromOutput(out, cookieMap, generateImagePath, controller.signal);
        response.has_images = imageSave.saved;
        response.image_count = imageSave.imageCount;
        if (!imageSave.saved) {
          throw new Error(`No images generated. Response text:\n${out.text || '(empty response)'}`);
        }
      } else {
        const out = await runGeminiWebWithFallback({
          prompt,
          files: attachmentPaths,
          model,
          cookieMap,
          chatMetadata: null,
          signal: controller.signal,
        });
        response = {
          text: out.text ?? null,
          thoughts: geminiOptions.showThoughts ? out.thoughts : null,
          has_images: out.images.length > 0,
          image_count: out.images.length,
        };
      }
    } finally {
      clearTimeout(timeout);
    }

    const answerText = response.text ?? '';
    let answerMarkdown = answerText;

    if (geminiOptions.showThoughts && response.thoughts) {
      answerMarkdown = `## Thinking\n\n${response.thoughts}\n\n## Response\n\n${answerText}`;
    }

    if (response.has_images && response.image_count > 0) {
      const imagePath = generateImagePath || outputPath || 'generated.png';
      answerMarkdown += `\n\n*Generated ${response.image_count} image(s). Saved to: ${imagePath}*`;
    }

    const tookMs = Date.now() - startTime;
    log?.(`[gemini-web] Completed in ${tookMs}ms`);

    return {
      answerText,
      answerMarkdown,
      tookMs,
      answerTokens: estimateTokenCount(answerText),
      answerChars: answerText.length,
    };
  };
}

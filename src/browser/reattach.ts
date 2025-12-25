import CDP from 'chrome-remote-interface';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import type { BrowserRuntimeMetadata, BrowserSessionConfig } from '../sessionStore.js';
import {
  waitForAssistantResponse,
  captureAssistantMarkdown,
  navigateToChatGPT,
  ensureNotBlocked,
  ensureLoggedIn,
  ensurePromptReady,
} from './pageActions.js';
import type { BrowserLogger, ChromeClient } from './types.js';
import { launchChrome, connectToChrome, hideChromeWindow } from './chromeLifecycle.js';
import { resolveBrowserConfig } from './config.js';
import { syncCookies } from './cookies.js';
import { CHATGPT_URL } from './constants.js';
import { delay } from './utils.js';

export interface ReattachDeps {
  listTargets?: () => Promise<TargetInfoLite[]>;
  connect?: (options?: unknown) => Promise<ChromeClient>;
  waitForAssistantResponse?: typeof waitForAssistantResponse;
  captureAssistantMarkdown?: typeof captureAssistantMarkdown;
  recoverSession?: (runtime: BrowserRuntimeMetadata, config: BrowserSessionConfig | undefined) => Promise<ReattachResult>;
  promptPreview?: string;
}

export interface ReattachResult {
  answerText: string;
  answerMarkdown: string;
}

type TargetInfoLite = {
  targetId?: string;
  type?: string;
  url?: string;
  [key: string]: unknown;
};

function pickTarget(
  targets: TargetInfoLite[],
  runtime: BrowserRuntimeMetadata,
): TargetInfoLite | undefined {
  if (!Array.isArray(targets) || targets.length === 0) {
    return undefined;
  }
  if (runtime.chromeTargetId) {
    const byId = targets.find((t) => t.targetId === runtime.chromeTargetId);
    if (byId) return byId;
  }
  if (runtime.tabUrl) {
    const byUrl =
      targets.find((t) => t.url?.startsWith(runtime.tabUrl as string)) ||
      targets.find((t) => (runtime.tabUrl as string).startsWith(t.url || ''));
    if (byUrl) return byUrl;
  }
  return targets.find((t) => t.type === 'page') ?? targets[0];
}

export async function resumeBrowserSession(
  runtime: BrowserRuntimeMetadata,
  config: BrowserSessionConfig | undefined,
  logger: BrowserLogger,
  deps: ReattachDeps = {},
): Promise<ReattachResult> {
  const recoverSession =
    deps.recoverSession ??
    (async (runtimeMeta, configMeta) =>
      resumeBrowserSessionViaNewChrome(runtimeMeta, configMeta, logger, deps));

  if (!runtime.chromePort) {
    logger('No running Chrome detected; reopening browser to locate the session.');
    return recoverSession(runtime, config);
  }

  const host = runtime.chromeHost ?? '127.0.0.1';
  try {
    const listTargets =
      deps.listTargets ??
      (async () => {
        const targets = await CDP.List({ host, port: runtime.chromePort as number });
        return targets as unknown as TargetInfoLite[];
      });
    const connect = deps.connect ?? ((options?: unknown) => CDP(options as CDP.Options));
    const targetList = (await listTargets()) as TargetInfoLite[];
    const target = pickTarget(targetList, runtime);
    const client: ChromeClient = (await connect({
      host,
      port: runtime.chromePort,
      target: target?.targetId,
    })) as unknown as ChromeClient;
    const { Runtime, DOM } = client;
    if (Runtime?.enable) {
      await Runtime.enable();
    }
    if (DOM && typeof DOM.enable === 'function') {
      await DOM.enable();
    }

    const ensureConversationOpen = async () => {
      const { result } = await Runtime.evaluate({ expression: 'location.href', returnByValue: true });
      const href = typeof result?.value === 'string' ? result.value : '';
      if (href.includes('/c/')) {
        return;
      }
      const opened = await openConversationFromSidebarWithRetry(
        Runtime,
        {
          conversationId: runtime.conversationId ?? extractConversationIdFromUrl(runtime.tabUrl ?? ''),
          preferProjects: true,
          promptPreview: deps.promptPreview,
        },
        15_000,
      );
      if (!opened) {
        throw new Error('Unable to locate prior ChatGPT conversation in sidebar.');
      }
      await waitForLocationChange(Runtime, 15_000);
    };

    const waitForResponse = deps.waitForAssistantResponse ?? waitForAssistantResponse;
    const captureMarkdown = deps.captureAssistantMarkdown ?? captureAssistantMarkdown;
    const timeoutMs = config?.timeoutMs ?? 120_000;
    const pingTimeoutMs = Math.min(5_000, Math.max(1_500, Math.floor(timeoutMs * 0.05)));
    await withTimeout(
      Runtime.evaluate({ expression: '1+1', returnByValue: true }),
      pingTimeoutMs,
      'Reattach target did not respond',
    );
    await ensureConversationOpen();
    const answer = await withTimeout(
      waitForResponse(Runtime, timeoutMs, logger),
      timeoutMs + 5_000,
      'Reattach response timed out',
    );
    const markdown = (await withTimeout(
      captureMarkdown(Runtime, answer.meta, logger),
      15_000,
      'Reattach markdown capture timed out',
    )) ?? answer.text;

    if (client && typeof client.close === 'function') {
      try {
        await client.close();
      } catch {
        // ignore
      }
    }

    return { answerText: answer.text, answerMarkdown: markdown };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger(`Existing Chrome reattach failed (${message}); reopening browser to locate the session.`);
    return recoverSession(runtime, config);
  }
}

async function resumeBrowserSessionViaNewChrome(
  runtime: BrowserRuntimeMetadata,
  config: BrowserSessionConfig | undefined,
  logger: BrowserLogger,
  deps: ReattachDeps,
): Promise<ReattachResult> {
  const resolved = resolveBrowserConfig(config ?? {});
  const manualLogin = Boolean(resolved.manualLogin);
  const userDataDir = manualLogin
    ? resolved.manualLoginProfileDir ?? path.join(os.homedir(), '.oracle', 'browser-profile')
    : await mkdtemp(path.join(os.tmpdir(), 'oracle-reattach-'));
  if (manualLogin) {
    await mkdir(userDataDir, { recursive: true });
  }
  const chrome = await launchChrome(resolved, userDataDir, logger);
  const chromeHost = (chrome as unknown as { host?: string }).host ?? '127.0.0.1';
  const client = await connectToChrome(chrome.port, logger, chromeHost);
  const { Network, Page, Runtime, DOM } = client;

  if (Runtime?.enable) {
    await Runtime.enable();
  }
  if (DOM && typeof DOM.enable === 'function') {
    await DOM.enable();
  }
  if (!resolved.headless && resolved.hideWindow) {
    await hideChromeWindow(chrome, logger);
  }

  let appliedCookies = 0;
  if (!manualLogin && resolved.cookieSync) {
    appliedCookies = await syncCookies(Network, resolved.url, resolved.chromeProfile, logger, {
      allowErrors: resolved.allowCookieErrors,
      filterNames: resolved.cookieNames ?? undefined,
      inlineCookies: resolved.inlineCookies ?? undefined,
      cookiePath: resolved.chromeCookiePath ?? undefined,
    });
  }

  await navigateToChatGPT(Page, Runtime, CHATGPT_URL, logger);
  await ensureNotBlocked(Runtime, resolved.headless, logger);
  await ensureLoggedIn(Runtime, logger, { appliedCookies });
  if (resolved.url !== CHATGPT_URL) {
    await navigateToChatGPT(Page, Runtime, resolved.url, logger);
    await ensureNotBlocked(Runtime, resolved.headless, logger);
  }
  await ensurePromptReady(Runtime, resolved.inputTimeoutMs, logger);

  const conversationUrl = buildConversationUrl(runtime, resolved.url);
  if (conversationUrl) {
    logger(`Reopening conversation at ${conversationUrl}`);
    await navigateToChatGPT(Page, Runtime, conversationUrl, logger);
    await ensureNotBlocked(Runtime, resolved.headless, logger);
    await ensurePromptReady(Runtime, resolved.inputTimeoutMs, logger);
  } else {
    const opened = await openConversationFromSidebarWithRetry(
      Runtime,
      {
        conversationId: runtime.conversationId ?? extractConversationIdFromUrl(runtime.tabUrl ?? ''),
        preferProjects: resolved.url !== CHATGPT_URL,
        promptPreview: deps.promptPreview,
      },
      15_000,
    );
    if (!opened) {
      throw new Error('Unable to locate prior ChatGPT conversation in sidebar.');
    }
    await waitForLocationChange(Runtime, 15_000);
  }

  const waitForResponse = deps.waitForAssistantResponse ?? waitForAssistantResponse;
  const captureMarkdown = deps.captureAssistantMarkdown ?? captureAssistantMarkdown;
  const timeoutMs = resolved.timeoutMs ?? 120_000;
  const answer = await waitForResponse(Runtime, timeoutMs, logger);
  const markdown = (await captureMarkdown(Runtime, answer.meta, logger)) ?? answer.text;

  if (client && typeof client.close === 'function') {
    try {
      await client.close();
    } catch {
      // ignore
    }
  }
  if (!resolved.keepBrowser && !manualLogin) {
    try {
      await chrome.kill();
    } catch {
      // ignore
    }
    await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
  }

  return { answerText: answer.text, answerMarkdown: markdown };
}

function extractConversationIdFromUrl(url: string): string | undefined {
  if (!url) return undefined;
  const match = url.match(/\/c\/([a-zA-Z0-9-]+)/);
  return match?.[1];
}

function buildConversationUrl(runtime: BrowserRuntimeMetadata, baseUrl: string): string | null {
  if (runtime.tabUrl) {
    if (runtime.tabUrl.includes('/c/')) {
      return runtime.tabUrl;
    }
    return null;
  }
  const conversationId = runtime.conversationId;
  if (!conversationId) {
    return null;
  }
  try {
    const base = new URL(baseUrl);
    return `${base.origin}/c/${conversationId}`;
  } catch {
    return null;
  }
}

async function withTimeout<T>(task: Promise<T>, ms: number, label: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(label)), ms);
  });
  return Promise.race([task, timeout]).finally(() => {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  });
}

async function openConversationFromSidebar(
  Runtime: ChromeClient['Runtime'],
  options: { conversationId?: string; preferProjects?: boolean; promptPreview?: string },
): Promise<boolean> {
  const response = await Runtime.evaluate({
    expression: `(() => {
      const conversationId = ${JSON.stringify(options.conversationId ?? null)};
      const preferProjects = ${JSON.stringify(Boolean(options.preferProjects))};
      const promptPreview = ${JSON.stringify(options.promptPreview ?? null)};
      const promptNeedle = promptPreview ? promptPreview.trim().toLowerCase().slice(0, 100) : '';
      const nav = document.querySelector('nav') || document.querySelector('aside') || document.body;
      if (preferProjects) {
        const projectLink = Array.from(nav.querySelectorAll('a,button'))
          .find((el) => (el.textContent || '').trim().toLowerCase() === 'projects');
        if (projectLink) {
          projectLink.click();
        }
      }
      const allElements = Array.from(
        document.querySelectorAll(
          'a,button,[role="link"],[role="button"],[data-href],[data-url],[data-conversation-id],[data-testid*="conversation"],[data-testid*="history"]',
        ),
      );
      const getHref = (el) =>
        el.getAttribute('href') ||
        el.getAttribute('data-href') ||
        el.getAttribute('data-url') ||
        el.dataset?.href ||
        el.dataset?.url ||
        '';
      const toCandidate = (el) => {
        const clickable = el.closest('a,button,[role="link"],[role="button"]') || el;
        const rawText = (el.textContent || clickable.textContent || '').trim();
        return {
          el,
          clickable,
          href: getHref(clickable) || getHref(el),
          conversationId:
            clickable.getAttribute('data-conversation-id') ||
            el.getAttribute('data-conversation-id') ||
            clickable.dataset?.conversationId ||
            el.dataset?.conversationId ||
            '',
          testId: clickable.getAttribute('data-testid') || el.getAttribute('data-testid') || '',
          text: rawText.replace(/\\s+/g, ' ').slice(0, 400),
          inNav: Boolean(clickable.closest('nav,aside')),
        };
      };
      const candidates = allElements.map(toCandidate);
      const mainCandidates = candidates.filter((item) => !item.inNav);
      const navCandidates = candidates.filter((item) => item.inNav);
      const visible = (item) => {
        const rect = item.clickable.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      const pick = (items) => (items.find(visible) || items[0] || null);
      let target = null;
      if (conversationId) {
        const byId = (item) =>
          (item.href && item.href.includes('/c/' + conversationId)) ||
          (item.conversationId && item.conversationId === conversationId);
        target = pick(mainCandidates.filter(byId)) || pick(navCandidates.filter(byId));
      }
      if (!target && promptNeedle) {
        const byPrompt = (item) => item.text && item.text.toLowerCase().includes(promptNeedle);
        target = pick(mainCandidates.filter(byPrompt)) || pick(navCandidates.filter(byPrompt));
      }
      if (!target) {
        const byHref = (item) => item.href && item.href.includes('/c/');
        target = pick(mainCandidates.filter(byHref)) || pick(navCandidates.filter(byHref));
      }
      if (!target) {
        const byTestId = (item) => /conversation|history/i.test(item.testId || '');
        target = pick(mainCandidates.filter(byTestId)) || pick(navCandidates.filter(byTestId));
      }
      if (target) {
        target.clickable.scrollIntoView({ block: 'center' });
        target.clickable.dispatchEvent(
          new MouseEvent('click', { bubbles: true, cancelable: true, view: window }),
        );
        return {
          ok: true,
          href: target.href || '',
          count: candidates.length,
          scope: target.inNav ? 'nav' : 'main',
        };
      }
      return { ok: false, count: candidates.length };
    })()`,
    returnByValue: true,
  });
  return Boolean(response.result?.value?.ok);
}

async function openConversationFromSidebarWithRetry(
  Runtime: ChromeClient['Runtime'],
  options: { conversationId?: string; preferProjects?: boolean; promptPreview?: string },
  timeoutMs: number,
): Promise<boolean> {
  const start = Date.now();
  let attempt = 0;
  while (Date.now() - start < timeoutMs) {
    // Retry because project list can hydrate after initial navigation.
    const opened = await openConversationFromSidebar(Runtime, options);
    if (opened) {
      return true;
    }
    attempt += 1;
    await delay(attempt < 5 ? 250 : 500);
  }
  return false;
}

async function waitForLocationChange(Runtime: ChromeClient['Runtime'], timeoutMs: number): Promise<void> {
  const start = Date.now();
  let lastHref = '';
  while (Date.now() - start < timeoutMs) {
    const { result } = await Runtime.evaluate({ expression: 'location.href', returnByValue: true });
    const href = typeof result?.value === 'string' ? result.value : '';
    if (lastHref && href !== lastHref) {
      return;
    }
    lastHref = href;
    await delay(200);
  }
}

// biome-ignore lint/style/useNamingConvention: test-only export used in vitest suite
export const __test__ = {
  pickTarget,
  extractConversationIdFromUrl,
  buildConversationUrl,
  openConversationFromSidebar,
};

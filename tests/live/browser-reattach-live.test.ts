import { describe, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import { runBrowserMode } from '../../src/browser/index.js';
import { resumeBrowserSession } from '../../src/browser/reattach.js';
import { closeRemoteChromeTarget } from '../../src/browser/chromeLifecycle.js';
import type { BrowserLogger } from '../../src/browser/types.js';
import type { ChromeCookiesSecureModule } from '../../src/browser/types.js';

const LIVE = process.env.ORACLE_LIVE_TEST === '1';
const PROJECT_URL =
  process.env.ORACLE_CHATGPT_PROJECT_URL ??
  'https://chatgpt.com/g/g-p-691edc9fec088191b553a35093da1ea8-oracle/project';

async function hasChatGptCookies(): Promise<boolean> {
  const mod = (await import('chrome-cookies-secure')) as unknown;
  const chromeCookies = (mod as { default?: unknown }).default ?? mod;
  const cookies = (await (chromeCookies as ChromeCookiesSecureModule).getCookiesPromised(
    'https://chatgpt.com',
    'puppeteer',
  )) as Array<{ name: string; value: string }>;
  const hasSession = cookies.some((cookie) => cookie.name.startsWith('__Secure-next-auth.session-token'));
  if (!hasSession) {
    console.warn(
      'Skipping ChatGPT browser live tests (missing __Secure-next-auth.session-token). Open chatgpt.com in Chrome and retry.',
    );
    return false;
  }
  return true;
}

function createLogger(): BrowserLogger {
  return (() => {}) as BrowserLogger;
}

(LIVE ? describe : describe.skip)('ChatGPT browser live reattach', () => {
  test(
    'reattaches from project list after closing Chrome (pro request)',
    async () => {
      if (!(await hasChatGptCookies())) return;
      if (!PROJECT_URL.includes('/g/')) {
        console.warn('Skipping live reattach test (project URL missing).');
        return;
      }

      const prompt = `live reattach pro ${Date.now()}`;
      const log = createLogger();
      let runtime: {
        chromePid?: number;
        chromePort?: number;
        chromeHost?: string;
        userDataDir?: string;
        chromeTargetId?: string;
        tabUrl?: string;
        controllerPid?: number;
        conversationId?: string;
      } | null = null;
      try {
        const result = await runBrowserMode({
          prompt,
          config: {
            chromeProfile: 'Default',
            url: PROJECT_URL,
            keepBrowser: true,
            desiredModel: 'GPT-5.2 Pro',
            timeoutMs: 180_000,
          },
          log,
        });

        expect(result.answerText.toLowerCase()).toContain('live reattach');
        const tabUrl = result.tabUrl ?? PROJECT_URL;
        const conversationId = (() => {
          const marker = '/c/';
          const idx = tabUrl.indexOf(marker);
          if (idx === -1) return undefined;
          const rest = tabUrl.slice(idx + marker.length);
          return rest.split(/[/?#]/)[0] || undefined;
        })();

        runtime = {
          chromePid: result.chromePid,
          chromePort: result.chromePort,
          chromeHost: result.chromeHost ?? '127.0.0.1',
          chromeTargetId: result.chromeTargetId,
          tabUrl,
          userDataDir: result.userDataDir,
          controllerPid: result.controllerPid,
          conversationId,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/Unable to find model option/i.test(message)) {
          console.warn(`Skipping live reattach (pro model unavailable): ${message}`);
          return;
        }
        throw error;
      }

      const host = runtime.chromeHost ?? '127.0.0.1';
      const port = runtime.chromePort ?? 0;

      if (runtime.chromePid) {
        try {
          process.kill(runtime.chromePid);
        } catch {
          // ignore kill failures
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));

      // Open a new browser and reattach via project list + prompt preview.
      const reattached = await resumeBrowserSession(
        {
          ...runtime,
          chromePort: undefined,
          chromeTargetId: undefined,
        },
        { chromeProfile: 'Default', url: PROJECT_URL, timeoutMs: 180_000 },
        Object.assign(createLogger(), { verbose: true }),
        { promptPreview: prompt },
      );

      expect(reattached.answerText.toLowerCase()).toContain('live reattach');

      if (runtime.chromePort && runtime.chromeTargetId) {
        await closeRemoteChromeTarget(host, port, runtime.chromeTargetId, log);
      }
      if (runtime.userDataDir) {
        await fs.rm(runtime.userDataDir, { recursive: true, force: true });
      }
    },
    15 * 60 * 1000,
  );
});

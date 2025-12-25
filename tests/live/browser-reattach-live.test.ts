import { describe, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import { runBrowserMode } from '../../src/browser/index.js';
import { resumeBrowserSession } from '../../src/browser/reattach.js';
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
        let result: Awaited<ReturnType<typeof runBrowserMode>> | null = null;
        let lastErrorMessage = '';
        for (let attempt = 1; attempt <= 3; attempt += 1) {
          try {
            result = await runBrowserMode({
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
            break;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            lastErrorMessage = message;
            if (/Unable to find model option/i.test(message)) {
              console.warn(`Skipping live reattach (pro model unavailable): ${message}`);
              return;
            }
            const transient =
              message.includes('Prompt did not appear in conversation before timeout') ||
              message.includes('Chrome window closed before oracle finished') ||
              message.includes('Reattach target did not respond');
            if (transient && attempt < 3) {
              console.warn(`Retrying live reattach run (attempt ${attempt + 1}/3): ${message}`);
              await new Promise((resolve) => setTimeout(resolve, 750 * attempt));
              continue;
            }
            throw error;
          }
        }
        if (!result) {
          throw new Error(`Live reattach run did not return a result: ${lastErrorMessage || 'unknown error'}`);
        }

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
        throw error;
      }

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

      if (runtime.userDataDir) {
        await fs.rm(runtime.userDataDir, { recursive: true, force: true });
      }
    },
    15 * 60 * 1000,
  );
});

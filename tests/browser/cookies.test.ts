import { beforeEach, describe, expect, test, vi } from 'vitest';
import { syncCookies, ChromeCookieSyncError } from '../../src/browser/cookies.js';
import type { ChromeClient } from '../../src/browser/types.js';

const getCookies = vi.hoisted(() => vi.fn());
vi.mock('@steipete/sweet-cookie', () => ({ getCookies }));

const logger = vi.fn();

beforeEach(() => {
  getCookies.mockReset();
  logger.mockReset();
});

describe('syncCookies', () => {
  test('replays cookies via DevTools Network.setCookie', async () => {
    getCookies.mockResolvedValue({
      cookies: [
        { name: 'sid', value: 'abc', domain: 'chatgpt.com', path: '/', secure: true, httpOnly: true },
        { name: 'csrftoken', value: 'xyz', domain: 'chatgpt.com', path: '/', secure: true, httpOnly: true },
      ],
      warnings: [],
    });
    const setCookie = vi.fn().mockResolvedValue({ success: true });
    const applied = await syncCookies(
      { setCookie } as unknown as ChromeClient['Network'],
      'https://chatgpt.com',
      null,
      logger,
    );
    expect(applied).toBe(2);
    expect(setCookie).toHaveBeenCalledTimes(2);
  });

  test('throws when cookie load fails', async () => {
    getCookies.mockRejectedValue(new Error('boom'));
    await expect(
      syncCookies({ setCookie: vi.fn() } as unknown as ChromeClient['Network'], 'https://chatgpt.com', null, logger),
    ).rejects.toBeInstanceOf(ChromeCookieSyncError);
  });

  test('can opt into continuing on cookie failures', async () => {
    getCookies.mockRejectedValue(new Error('boom'));
    const applied = await syncCookies(
      { setCookie: vi.fn() } as unknown as ChromeClient['Network'],
      'https://chatgpt.com',
      null,
      logger,
      { allowErrors: true },
    );
    expect(applied).toBe(0);
    expect(logger).toHaveBeenCalledWith(expect.stringContaining('Cookie sync failed (continuing with override)'));
  });
});

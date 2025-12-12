import { describe, expect, test, vi, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setOracleHomeDirOverrideForTest } from '../../src/oracleHome.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  setOracleHomeDirOverrideForTest(null);
});

describe('browser reattach end-to-end (simulated)', () => {
  test('marks session completed after reconnection', async () => {
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'oracle-reattach-'));
    setOracleHomeDirOverrideForTest(tmpHome);

    try {
      const resumeMock = vi.fn(async () => ({ answerText: 'ok text', answerMarkdown: 'ok markdown' }));

      vi.resetModules();
      vi.doMock('../../src/browser/reattach.js', () => ({ resumeBrowserSession: resumeMock }));
      const { sessionStore } = await import('../../src/sessionStore.js');
      const { attachSession } = await import('../../src/cli/sessionDisplay.js');

      await sessionStore.ensureStorage();
      const sessionMeta = await sessionStore.createSession(
        {
          prompt: 'Test prompt',
          model: 'gpt-5.1-pro',
          mode: 'browser',
          browserConfig: {},
        },
        '/repo',
      );
      await sessionStore.updateModelRun(sessionMeta.id, 'gpt-5.1-pro', {
        status: 'running',
        startedAt: new Date().toISOString(),
      });
      await sessionStore.updateSession(sessionMeta.id, {
        status: 'running',
        startedAt: new Date().toISOString(),
        mode: 'browser',
        browser: {
          config: {},
          runtime: {
            chromePort: 51559,
            chromeHost: '127.0.0.1',
            chromeTargetId: 't-1',
            tabUrl: 'https://chatgpt.com/c/demo',
          },
        },
        response: { status: 'running', incompleteReason: 'chrome-disconnected' },
      });

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await attachSession(sessionMeta.id, { suppressMetadata: true, renderPrompt: false });

      logSpy.mockRestore();

      const updated = await sessionStore.readSession(sessionMeta.id);
      expect(updated?.status).toBe('completed');
      expect(updated?.response?.status).toBe('completed');
      expect(resumeMock).toHaveBeenCalledTimes(1);
      const runs = updated?.models ?? [];
      expect(runs.some((r) => r.status === 'completed')).toBe(true);
    } finally {
      await fs.rm(tmpHome, { recursive: true, force: true });
      setOracleHomeDirOverrideForTest(null);
    }
  });

  test('reattaches when controller pid is gone even without incompleteReason', async () => {
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'oracle-reattach-'));
    setOracleHomeDirOverrideForTest(tmpHome);

    try {
      const resumeMock = vi.fn(async () => ({ answerText: 'ok text', answerMarkdown: 'ok markdown' }));

      vi.resetModules();
      vi.doMock('../../src/browser/reattach.js', () => ({ resumeBrowserSession: resumeMock }));
      const { sessionStore } = await import('../../src/sessionStore.js');
      const { attachSession } = await import('../../src/cli/sessionDisplay.js');

      await sessionStore.ensureStorage();
      const sessionMeta = await sessionStore.createSession(
        {
          prompt: 'Test prompt',
          model: 'gpt-5.1-pro',
          mode: 'browser',
          browserConfig: {},
        },
        '/repo',
      );
      await sessionStore.updateModelRun(sessionMeta.id, 'gpt-5.1-pro', {
        status: 'running',
        startedAt: new Date().toISOString(),
      });
      await sessionStore.updateSession(sessionMeta.id, {
        status: 'running',
        startedAt: new Date().toISOString(),
        mode: 'browser',
        browser: {
          config: {},
          runtime: {
            chromePort: 51559,
            chromeHost: '127.0.0.1',
            chromeTargetId: 't-1',
            tabUrl: 'https://chatgpt.com/c/demo',
            controllerPid: 999_999,
          },
        },
      });

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await attachSession(sessionMeta.id, { suppressMetadata: true, renderPrompt: false });

      logSpy.mockRestore();

      const updated = await sessionStore.readSession(sessionMeta.id);
      expect(updated?.status).toBe('completed');
      expect(updated?.response?.status).toBe('completed');
      expect(resumeMock).toHaveBeenCalledTimes(1);
    } finally {
      await fs.rm(tmpHome, { recursive: true, force: true });
      setOracleHomeDirOverrideForTest(null);
    }
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';

const runGeminiWebWithFallback = vi.fn(async () => ({
  rawResponseText: '',
  text: 'ok',
  thoughts: 'thinking',
  metadata: { cid: '1' },
  images: [],
  effectiveModel: 'gemini-3-pro',
}));

const saveFirstGeminiImageFromOutput = vi.fn(async () => ({ saved: true, imageCount: 1 }));

vi.mock('../../src/gemini-web/client.js', () => ({
  runGeminiWebWithFallback,
  saveFirstGeminiImageFromOutput,
}));

vi.mock('chrome-cookies-secure', () => ({
  default: {
    getCookiesPromised: async () => [
      { name: '__Secure-1PSID', value: 'psid', domain: '.google.com', path: '/' },
      { name: '__Secure-1PSIDTS', value: 'psidts', domain: '.google.com', path: '/' },
    ],
  },
}));

describe('gemini-web executor', () => {
  beforeEach(() => {
    runGeminiWebWithFallback.mockClear();
    saveFirstGeminiImageFromOutput.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('builds a generate-image prompt with aspect ratio and passes attachments', async () => {
    const { createGeminiWebExecutor } = await import('../../src/gemini-web/executor.js');
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'oracle-gemini-exec-'));
    const outPath = path.join(tempDir, 'gen.jpg');

    const exec = createGeminiWebExecutor({ generateImage: outPath, aspectRatio: '1:1', showThoughts: true });
    const result = await exec({
      prompt: 'a cute robot holding a banana',
      attachments: [{ path: '/tmp/attach.txt', displayPath: 'attach.txt' }],
      config: { desiredModel: 'Gemini 3 Pro', chromeProfile: 'Default' },
      log: () => {},
    });

    expect(runGeminiWebWithFallback).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gemini-3-pro',
        prompt: 'Generate an image: a cute robot holding a banana (aspect ratio: 1:1)',
        files: ['/tmp/attach.txt'],
      }),
    );
    expect(saveFirstGeminiImageFromOutput).toHaveBeenCalledWith(expect.anything(), expect.anything(), outPath);
    expect(result.answerMarkdown).toContain('## Thinking');
    expect(result.answerMarkdown).toContain('Generated 1 image(s).');
  });

  it('runs the edit flow as two calls and uses intro metadata', async () => {
    const { createGeminiWebExecutor } = await import('../../src/gemini-web/executor.js');
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'oracle-gemini-exec-'));
    const inPath = path.join(tempDir, 'in.png');
    const outPath = path.join(tempDir, 'out.jpg');

    runGeminiWebWithFallback
      .mockResolvedValueOnce({
        rawResponseText: '',
        text: 'intro',
        thoughts: null,
        metadata: { chat: 'meta' },
        images: [],
        effectiveModel: 'gemini-3-pro',
      })
      .mockResolvedValueOnce({
        rawResponseText: '',
        text: 'edited',
        thoughts: null,
        metadata: null,
        images: [],
        effectiveModel: 'gemini-3-pro',
      });

    const exec = createGeminiWebExecutor({ editImage: inPath, outputPath: outPath });
    await exec({
      prompt: 'add sunglasses',
      attachments: [],
      config: { desiredModel: 'Gemini 3 Pro', chromeProfile: 'Default' },
      log: () => {},
    });

    expect(runGeminiWebWithFallback).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ prompt: 'Here is an image to edit', files: [inPath], chatMetadata: null }),
    );
    expect(runGeminiWebWithFallback).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ chatMetadata: { chat: 'meta' } }),
    );
    expect(saveFirstGeminiImageFromOutput).toHaveBeenCalledWith(expect.anything(), expect.anything(), outPath);
  });
});

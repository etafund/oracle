import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  assertTrustedGeminiImageDownloadUrl,
  downloadGeminiImageWithCookies,
} from "../../src/gemini-web/image_download_cookie.js";
import {
  saveFirstGeminiImageFromOutput,
  type GeminiWebCandidateImage,
  type GeminiWebRunOutput,
} from "../../src/gemini-web/client.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "oracle-gemini-image-download-"));
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(tmpDir, { recursive: true, force: true });
});

describe("Gemini image download cookie constraints", () => {
  test("rejects non-HTTPS Gemini generated image URLs before reading cookies", () => {
    expect(() =>
      assertTrustedGeminiImageDownloadUrl("http://lh3.googleusercontent.com/gg-dl/generated"),
    ).toThrow(/must use https/i);
  });

  test("does not attach Gemini cookies to ordinary web image candidates", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await saveFirstGeminiImageFromOutput(
      geminiOutput([
        {
          kind: "web",
          url: "https://example.com/public-image.png",
          title: "web image",
          alt: "web image",
        },
      ]),
      { "__Secure-1PSID": "secret-session-cookie" },
      path.join(tmpDir, "out.png"),
    );

    expect(result).toEqual({ saved: false, imageCount: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("does not forward Gemini cookies when a generated image redirects to an untrusted host", async () => {
    const cookieHeader = "__Secure-1PSID=secret-session-cookie";
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("", {
        status: 302,
        headers: {
          location: "https://example.com/stolen-generated-image.png",
        },
      }),
    );

    await expect(
      downloadGeminiImageWithCookies({
        url: "https://lh3.googleusercontent.com/gg-dl/generated=s2048",
        cookieHeader,
        fetchImpl: fetchMock as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/not trusted/i);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    expect(init).toMatchObject({
      redirect: "manual",
      headers: {
        cookie: cookieHeader,
      },
    });
    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes("example.com"))).toBe(
      false,
    );
  });

  test("preserves cookies across approved Gemini generated-image redirects", async () => {
    const calls: Array<{ url: string; cookie?: string }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string> | undefined;
      calls.push({ url: String(input), cookie: headers?.cookie });

      if (calls.length === 1) {
        return new Response("", {
          status: 302,
          headers: {
            location: "https://work.fife.usercontent.google.com/rd-gg-dl/generated=s2048",
          },
        });
      }

      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "content-type": "image/png" },
      });
    });

    const result = await downloadGeminiImageWithCookies({
      url: "https://lh3.googleusercontent.com/gg-dl/generated=s2048",
      cookieHeader: "a=b",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(result.response.ok).toBe(true);
    expect(result.finalUrl).toBe(
      "https://work.fife.usercontent.google.com/rd-gg-dl/generated=s2048",
    );
    expect(calls).toEqual([
      { url: "https://lh3.googleusercontent.com/gg-dl/generated=s2048", cookie: "a=b" },
      {
        url: "https://work.fife.usercontent.google.com/rd-gg-dl/generated=s2048",
        cookie: "a=b",
      },
    ]);
  });
});

function geminiOutput(images: GeminiWebCandidateImage[]): GeminiWebRunOutput {
  return {
    rawResponseText: "",
    text: "",
    thoughts: null,
    metadata: null,
    images,
  };
}

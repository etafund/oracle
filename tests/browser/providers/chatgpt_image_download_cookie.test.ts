import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { saveChatGptGeneratedImages } from "../../../src/browser/chatgptImages.js";
import {
  assertTrustedChatGptImageDownloadUrl,
  downloadChatGptImageWithCookies,
} from "../../../src/browser/providers/chatgpt_image_download.js";
import type { ChromeClient } from "../../../src/browser/types.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "oracle-chatgpt-image-download-"));
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(tmpDir, { recursive: true, force: true });
});

describe("ChatGPT image download URL constraints", () => {
  test("rejects off-origin estuary URLs before reading or attaching ChatGPT cookies", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const getCookies = vi.fn();
    const Network = { getCookies } as unknown as ChromeClient["Network"];

    const result = await saveChatGptGeneratedImages({
      Network,
      images: [
        {
          url: "https://evil.example/backend-api/estuary/content?id=file_attacker",
          fileId: "file_attacker",
        },
      ],
      outputPath: path.join(tmpDir, "out.png"),
    });

    expect(result.saved).toBe(false);
    expect(result.errors.join("\n")).toMatch(/not trusted/i);
    expect(getCookies).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("rejects non-HTTPS ChatGPT estuary URLs before reading cookies", () => {
    expect(() =>
      assertTrustedChatGptImageDownloadUrl(
        "http://chatgpt.com/backend-api/estuary/content?id=file_insecure",
      ),
    ).toThrow(/must use https/i);
  });

  test("does not forward cookies when a trusted ChatGPT URL redirects off-origin", async () => {
    const cookieHeader = "__Secure-next-auth.session-token=secret-session-cookie";
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("", {
        status: 302,
        headers: {
          location: "https://evil.example/backend-api/estuary/content?id=file_attacker",
        },
      }),
    );

    await expect(
      downloadChatGptImageWithCookies({
        url: "https://chatgpt.com/backend-api/estuary/content?id=file_safe",
        cookieHeader,
        fetchImpl: fetchMock as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/not trusted/i);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://chatgpt.com/backend-api/estuary/content?id=file_safe");
    expect(init).toMatchObject({
      redirect: "manual",
      headers: {
        cookie: cookieHeader,
      },
    });
    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes("evil.example"))).toBe(
      false,
    );
  });

  test("manual redirect follows only trusted ChatGPT image URLs", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("", {
          status: 302,
          headers: {
            location: "/backend-api/estuary/content?id=file_redirected",
          },
        }),
      )
      .mockResolvedValueOnce(
        new Response("image-bytes", {
          status: 200,
          headers: { "content-type": "image/png" },
        }),
      );

    const result = await downloadChatGptImageWithCookies({
      url: "https://chatgpt.com/backend-api/estuary/content?id=file_initial",
      cookieHeader: "session=ok",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(result.response.ok).toBe(true);
    expect(result.finalUrl).toBe(
      "https://chatgpt.com/backend-api/estuary/content?id=file_redirected",
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1][0])).toBe(result.finalUrl);
  });
});

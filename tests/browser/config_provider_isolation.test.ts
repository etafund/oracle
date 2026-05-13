import { describe, expect, test } from "vitest";

import { DEFAULT_CHATGPT_COOKIE_NAMES, resolveBrowserConfig } from "../../src/browser/config.js";
import {
  DEFAULT_GEMINI_COOKIE_NAMES,
  GEMINI_APP_URL,
  normalizeGeminiUrl,
  resolveGeminiBrowserConfig,
} from "../../src/gemini-web/config.js";

describe("browser config provider isolation", () => {
  test("Gemini config defaults to Gemini URL and cookies, not ChatGPT post-processing", () => {
    const resolved = resolveGeminiBrowserConfig(undefined);

    expect(resolved.url).toBe(GEMINI_APP_URL);
    expect(resolved.chatgptUrl).toBeNull();
    expect(resolved.cookieNames).toEqual(DEFAULT_GEMINI_COOKIE_NAMES);
    expect(resolved.cookieNames).not.toEqual(DEFAULT_CHATGPT_COOKIE_NAMES);
    expect(resolved.desiredModel).toBe("gemini-3-pro");
    expect(resolved.modelStrategy).toBe("ignore");
  });

  test("Gemini config accepts gemini.google.com/app without ChatGPT URL normalization", () => {
    const resolved = resolveGeminiBrowserConfig({
      url: "https://gemini.google.com/app",
      cookieNames: [],
    });

    expect(resolved.url).toBe("https://gemini.google.com/app");
    expect(resolved.chatgptUrl).toBeNull();
    expect(resolved.cookieNames).toEqual(DEFAULT_GEMINI_COOKIE_NAMES);
  });

  test("Gemini config rejects non-Gemini hosts, including ChatGPT hosts", () => {
    expect(() => resolveGeminiBrowserConfig({ url: "https://example.com/" })).toThrow(
      /Gemini URL host/i,
    );
    expect(() => resolveGeminiBrowserConfig({ chatgptUrl: "https://chatgpt.com/" })).toThrow(
      /Gemini URL host/i,
    );
    expect(() => resolveGeminiBrowserConfig({ url: "https://chat.openai.com/" })).toThrow(
      /Gemini URL host/i,
    );
  });

  test("Gemini URL normalization is not ChatGPT's protocol-filling semantics", () => {
    expect(() => normalizeGeminiUrl("gemini.google.com/app", GEMINI_APP_URL)).toThrow(
      /Invalid Gemini browser URL/i,
    );
  });

  test("ChatGPT resolver behavior is unchanged", () => {
    const chatgpt = resolveBrowserConfig({ url: "https://chatgpt.com/g/g-p-foo/project" });
    expect(chatgpt.url).toBe("https://chatgpt.com/g/g-p-foo/project");
    expect(chatgpt.chatgptUrl).toBe("https://chatgpt.com/g/g-p-foo/project");
    expect(chatgpt.cookieNames).toEqual(DEFAULT_CHATGPT_COOKIE_NAMES);

    expect(() => resolveBrowserConfig({ url: "https://gemini.google.com/app" })).toThrow(
      /ChatGPT URL host/i,
    );
  });
});

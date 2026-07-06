import { describe, expect, it } from "vitest";

import {
  collectLaneBrowserConflictFlags,
  isLaneBrowserConflictFlagName,
} from "../../bin/oracle-cli.js";

type Options = Parameters<typeof collectLaneBrowserConflictFlags>[0];

const explicit = (): boolean => false; // every option was set on the CLI
const allDefault = (): boolean => true; // every option still has its default

describe("collectLaneBrowserConflictFlags", () => {
  it("collects browser-only flags previously missing from the hand-maintained list", () => {
    const options = {
      model: "gpt-5.5",
      browserFollowUp: ["more"],
      browserThinkingTime: "extended",
      browserArchive: "always",
      browserProfileLockTimeout: "30s",
      browserMaxConcurrentTabs: "2",
      browserCookieWait: "5s",
      browserNoCookieSync: true,
      browserInlineCookiesFile: "/tmp/cookies.json",
      browserCookieNames: "session",
      browserInlineCookies: "e30=",
      browserAllowCookieErrors: true,
      browserManualLoginProfileDir: "/tmp/profile",
      browserPort: 9222,
      browserDebugPort: 9223,
      remoteToken: "secret",
    } as unknown as Options;

    const flags = collectLaneBrowserConflictFlags(options, explicit);
    expect(flags).toEqual(
      expect.arrayContaining([
        "browserFollowUp",
        "browserThinkingTime",
        "browserArchive",
        "browserProfileLockTimeout",
        "browserMaxConcurrentTabs",
        "browserCookieWait",
        "browserNoCookieSync",
        "browserInlineCookiesFile",
        "browserCookieNames",
        "browserInlineCookies",
        "browserAllowCookieErrors",
        "browserManualLoginProfileDir",
        "browserPort",
        "browserDebugPort",
        "remoteToken",
      ]),
    );
    expect(flags).not.toContain("model");
  });

  it("still collects the original hand-maintained flag set", () => {
    const options = {
      browser: true,
      browserChromeProfile: "Default",
      browserChromePath: "/usr/bin/chrome",
      browserCookiePath: "/tmp/c",
      browserAttachRunning: true,
      chatgptUrl: "https://chatgpt.com",
      browserUrl: "https://chatgpt.com",
      browserTimeout: "10m",
      browserInputTimeout: "1m",
      browserAttachmentTimeout: "1m",
      browserModelStrategy: "select",
      browserResearch: "deep",
      browserAttachments: "always",
      browserInlineFiles: true,
      browserBundleFiles: true,
      browserBundleFormat: "zip",
      browserHeadless: true,
      browserHideWindow: true,
      browserKeepBrowser: true,
      browserTab: "current",
      browserManualLogin: true,
      copyProfile: "/tmp/p",
      geminiDeepThink: true,
      deepThink: true,
      geminiDeepThinkFallback: "fail",
      evidence: "redacted",
      youtube: "https://youtu.be/x",
      generateImage: "out.png",
      editImage: "in.png",
      remoteChrome: "127.0.0.1:9222",
      remoteHost: "127.0.0.1:9470",
      remoteBrowser: "required",
    } as unknown as Options;

    const flags = collectLaneBrowserConflictFlags(options, explicit);
    for (const name of Object.keys(options)) {
      expect(flags).toContain(name);
    }
  });

  it("ignores commander defaults, falsy values, and empty repeatable options", () => {
    const options = {
      browser: false,
      browserAttachments: "auto", // commander default
      browserBundleFormat: "auto", // commander default
      browserFollowUp: [], // commander default for repeatable option
      geminiDeepThink: false,
      deepThink: false,
      remoteToken: undefined,
      browserTab: null,
    } as unknown as Options;

    expect(collectLaneBrowserConflictFlags(options, allDefault)).toEqual([]);
  });

  it("flags boolean true even when it comes from a default source", () => {
    const options = { geminiDeepThink: true } as unknown as Options;
    expect(collectLaneBrowserConflictFlags(options, allDefault)).toEqual(["geminiDeepThink"]);
  });

  it("does not treat unrelated option names as browser conflicts", () => {
    for (const name of [
      "model",
      "models",
      "engine",
      "prompt",
      "copy",
      "copyMarkdown",
      "render",
      "timeout",
      "session",
    ]) {
      expect(isLaneBrowserConflictFlagName(name)).toBe(false);
    }
  });
});

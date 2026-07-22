import { describe, expect, test } from "vitest";
import {
  buildRemoteRunRecoveryHint,
  sanitizeRemoteRunRecoveryHint,
} from "../../src/remote/recovery.js";

describe("remote browser failure recovery evidence", () => {
  const authority = {
    originRunId: "run-original",
    accountId: "acct1",
    authToken: "account-secret",
    promptPreview: "submitted prompt prefix",
    nowMs: Date.parse("2026-07-21T00:00:00.000Z"),
  } as const;

  test("keeps only a durable ChatGPT identity and prompt-submit bit", () => {
    const recovery = buildRemoteRunRecoveryHint(
      {
        stage: "assistant-timeout",
        diagnostics: { path: "/home/oracle/private/timeout.png" },
        runtime: {
          tabUrl: "https://chatgpt.com/c/canonical-123?private=1#fragment",
          conversationId: "canonical-123",
          promptSubmitted: true,
          chromePid: 1234,
          chromePort: 9222,
          chromeHost: "127.0.0.1",
          userDataDir: "/home/oracle/.oracle/browser-profile",
          chromeTargetId: "target-secret",
        },
      },
      undefined,
      authority,
    );

    expect(recovery).toMatchObject({
      category: "browser-automation",
      stage: "assistant-timeout",
      originRunId: "run-original",
      runtime: {
        tabUrl: "https://chatgpt.com/c/canonical-123",
        conversationId: "canonical-123",
        promptSubmitted: true,
      },
    });
    expect(recovery?.capability).toMatch(/^v1\./);
    expect(recovery?.promptPreviewSha256).toMatch(/^[a-f0-9]{64}$/);
    const serialized = JSON.stringify(recovery);
    expect(serialized).not.toContain("chromePid");
    expect(serialized).not.toContain("9222");
    expect(serialized).not.toContain("browser-profile");
    expect(serialized).not.toContain("timeout.png");
    expect(serialized).not.toContain("private=1");
  });

  test("uses the latest worker runtime when the typed error has none", () => {
    expect(
      buildRemoteRunRecoveryHint(
        { stage: "capture-binding" },
        {
          tabUrl: "https://chatgpt.com/g/g-demo/project/c/canonical-456?private=1",
          conversationId: "canonical-456",
          promptSubmitted: true,
        },
        authority,
      ),
    ).toMatchObject({
      stage: "capture-binding",
      runtime: {
        tabUrl: "https://chatgpt.com/c/canonical-456",
        conversationId: "canonical-456",
      },
    });
  });

  test("falls back to the latest canonical runtime when typed details are still provisional", () => {
    expect(
      buildRemoteRunRecoveryHint(
        {
          stage: "assistant-timeout",
          runtime: {
            tabUrl: "https://chatgpt.com/c/WEB:client-id",
            promptSubmitted: true,
          },
        },
        {
          tabUrl: "https://chatgpt.com/c/canonical-later",
          conversationId: "canonical-later",
          promptSubmitted: true,
        },
        authority,
      ),
    ).toMatchObject({
      stage: "assistant-timeout",
      runtime: {
        tabUrl: "https://chatgpt.com/c/canonical-later",
        conversationId: "canonical-later",
        promptSubmitted: true,
      },
    });
  });

  test.each([
    {
      category: "other",
      stage: "assistant-timeout",
      runtime: { tabUrl: "https://chatgpt.com/c/good-id", promptSubmitted: true },
    },
    {
      stage: "unknown",
      runtime: { tabUrl: "https://chatgpt.com/c/good-id", promptSubmitted: true },
    },
    {
      stage: "assistant-timeout",
      runtime: { tabUrl: "https://evil.example/c/good-id", promptSubmitted: true },
    },
    {
      stage: "assistant-timeout",
      runtime: { tabUrl: "http://chatgpt.com/c/good-id", promptSubmitted: true },
    },
    {
      stage: "assistant-timeout",
      runtime: { tabUrl: "https://chatgpt.com/c/WEB", promptSubmitted: true },
    },
    {
      stage: "assistant-timeout",
      runtime: {
        tabUrl: "https://chatgpt.com/c/WEB:fee7a622-991a-497a-bac4-a878b86f82f3",
        promptSubmitted: true,
      },
    },
    {
      stage: "assistant-timeout",
      runtime: {
        tabUrl: "https://evil.example/c/good-id",
        conversationId: "good-id",
        promptSubmitted: true,
      },
    },
    {
      stage: "assistant-timeout",
      runtime: {
        tabUrl: "https://chatgpt.com/c/first-id",
        conversationId: "second-id",
        promptSubmitted: true,
      },
    },
    {
      stage: "assistant-timeout",
      runtime: {
        tabUrl: `https://chatgpt.com/c/${"a".repeat(257)}`,
        promptSubmitted: true,
      },
    },
  ])("rejects unsafe or non-durable recovery evidence %#", (input) => {
    expect(sanitizeRemoteRunRecoveryHint(input)).toBeUndefined();
  });

  test("rejects stale conversation metadata when submission was not proved", () => {
    expect(
      sanitizeRemoteRunRecoveryHint({
        stage: "assistant-timeout",
        runtime: {
          tabUrl: "https://chatgpt.com/c/stale-id",
          conversationId: "stale-id",
          promptSubmitted: false,
        },
      }),
    ).toBeUndefined();
  });
});

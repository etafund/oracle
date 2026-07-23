import { describe, expect, test } from "vitest";
import {
  buildRemoteRunRecoveryHint,
  sanitizeRemoteRunRecoveryHint,
  verifyRemoteRunRecoveryCapability,
} from "../../src/remote/recovery.js";
import type { RemoteRunRecoveryHint } from "../../src/remote/types.js";
import {
  PROMPT_DOM_IDENTITY_ALGORITHM,
  PROMPT_RECOVERY_PREVIEW_ALGORITHM,
} from "../../src/browser/promptDomMatch.js";

const NOW_MS = Date.parse("2026-07-21T12:00:00.000Z");
const AUTH_TOKEN = "account-scoped-secret";
const PROMPT_PREVIEW = "exact submitted composer prefix";
const PROMPT_DOM_SHA256 = "d".repeat(64);

function mintHint(): RemoteRunRecoveryHint {
  const hint = buildRemoteRunRecoveryHint(
    {
      stage: "assistant-timeout",
      runtime: {
        tabUrl: "https://chatgpt.com/c/canonical-conversation?private=discarded#fragment",
        conversationId: "canonical-conversation",
        promptSubmitted: true,
      },
    },
    undefined,
    {
      originRunId: "origin-run-123",
      accountId: "acct1",
      authToken: AUTH_TOKEN,
      promptPreview: PROMPT_PREVIEW,
      promptDomSha256: PROMPT_DOM_SHA256,
      nowMs: NOW_MS,
      ttlMs: 60_000,
    },
  );
  if (!hint) throw new Error("fixture did not mint a recovery hint");
  return hint;
}

function verify(
  value: unknown,
  overrides: Partial<{
    accountId: string;
    authToken: string;
    promptPreview: string;
    nowMs: number;
  }> = {},
): boolean {
  return verifyRemoteRunRecoveryCapability(value, {
    accountId: "acct1",
    authToken: AUTH_TOKEN,
    promptPreview: PROMPT_PREVIEW,
    nowMs: NOW_MS + 1,
    ...overrides,
  });
}

function mutate(
  hint: RemoteRunRecoveryHint,
  apply: (copy: Record<string, unknown>) => void,
): unknown {
  const copy = structuredClone(hint) as unknown as Record<string, unknown>;
  apply(copy);
  return copy;
}

describe("remote recovery capability hardening", () => {
  test("accepts only the exact account, prompt, stage, conversation, expiry, and HMAC", () => {
    const hint = mintHint();
    expect(verify(hint)).toBe(true);
    expect(hint).toMatchObject({
      promptPreviewAlgorithm: PROMPT_RECOVERY_PREVIEW_ALGORITHM,
      promptDomIdentityAlgorithm: PROMPT_DOM_IDENTITY_ALGORITHM,
    });

    const cases: Array<[string, unknown]> = [
      [
        "capability",
        mutate(hint, (copy) => {
          const capability = copy.capability as string;
          copy.capability = `${capability.slice(0, -1)}${capability.endsWith("A") ? "B" : "A"}`;
        }),
      ],
      [
        "category",
        mutate(hint, (copy) => {
          copy.category = "other";
        }),
      ],
      [
        "deleted category",
        mutate(hint, (copy) => {
          delete copy.category;
        }),
      ],
      [
        "stage",
        mutate(hint, (copy) => {
          copy.stage = "capture-binding";
        }),
      ],
      [
        "origin run",
        mutate(hint, (copy) => {
          copy.originRunId = "different-origin-run";
        }),
      ],
      [
        "conversation",
        mutate(hint, (copy) => {
          const runtime = copy.runtime as Record<string, unknown>;
          runtime.conversationId = "different-conversation";
          runtime.tabUrl = "https://chatgpt.com/c/different-conversation";
        }),
      ],
      [
        "expiry",
        mutate(hint, (copy) => {
          copy.expiresAt = new Date(NOW_MS + 120_000).toISOString();
        }),
      ],
      [
        "preview algorithm",
        mutate(hint, (copy) => {
          copy.promptPreviewAlgorithm = "oracle.prompt-recovery-preview.v1";
        }),
      ],
      [
        "DOM identity algorithm",
        mutate(hint, (copy) => {
          copy.promptDomIdentityAlgorithm = "oracle.rendered-prompt-dom-identity.v1";
        }),
      ],
      [
        "DOM digest",
        mutate(hint, (copy) => {
          copy.promptDomSha256 = "e".repeat(64);
        }),
      ],
    ];

    for (const [label, value] of cases) {
      expect(verify(value), label).toBe(false);
    }
    expect(verify(hint, { accountId: "acct2" }), "account").toBe(false);
    expect(verify(hint, { authToken: "different-account-secret" }), "secret").toBe(false);
    expect(verify(hint, { promptPreview: `${PROMPT_PREVIEW}!` }), "prompt").toBe(false);
  });

  test("expires at the exact signed boundary", () => {
    const hint = mintHint();
    const expiryMs = Date.parse(hint.expiresAt);

    expect(verify(hint, { nowMs: expiryMs - 1 })).toBe(true);
    expect(verify(hint, { nowMs: expiryMs })).toBe(false);
    expect(verify(hint, { nowMs: expiryMs + 1 })).toBe(false);
  });

  test("sanitizer canonicalizes the URL and rejects unsafe or ambiguous claims", () => {
    const hint = mintHint();
    expect(sanitizeRemoteRunRecoveryHint(hint)).toMatchObject({
      category: "browser-automation",
      stage: "assistant-timeout",
      runtime: {
        tabUrl: "https://chatgpt.com/c/canonical-conversation",
        conversationId: "canonical-conversation",
        promptSubmitted: true,
      },
    });

    const invalid: unknown[] = [
      mutate(hint, (copy) => {
        copy.capability = "v1.short";
      }),
      mutate(hint, (copy) => {
        copy.promptPreviewSha256 = "A".repeat(64);
      }),
      mutate(hint, (copy) => {
        delete copy.promptDomSha256;
      }),
      mutate(hint, (copy) => {
        delete copy.promptPreviewAlgorithm;
      }),
      mutate(hint, (copy) => {
        delete copy.promptDomIdentityAlgorithm;
      }),
      mutate(hint, (copy) => {
        copy.promptDomSha256 = "A".repeat(64);
      }),
      mutate(hint, (copy) => {
        copy.capability = `v1.${"a".repeat(43)}`;
      }),
      mutate(hint, (copy) => {
        copy.expiresAt = "2026-07-21T12:01:00Z";
      }),
      mutate(hint, (copy) => {
        copy.originRunId = "unsafe/run";
      }),
      mutate(hint, (copy) => {
        copy.stage = "not-a-recovery-stage";
      }),
      mutate(hint, (copy) => {
        const runtime = copy.runtime as Record<string, unknown>;
        runtime.promptSubmitted = false;
      }),
      mutate(hint, (copy) => {
        const runtime = copy.runtime as Record<string, unknown>;
        runtime.tabUrl = "http://chatgpt.com/c/canonical-conversation";
      }),
      mutate(hint, (copy) => {
        const runtime = copy.runtime as Record<string, unknown>;
        runtime.tabUrl = "https://evil.example/c/canonical-conversation";
      }),
      mutate(hint, (copy) => {
        const runtime = copy.runtime as Record<string, unknown>;
        runtime.tabUrl = "https://user:pass@chatgpt.com/c/canonical-conversation";
      }),
      mutate(hint, (copy) => {
        const runtime = copy.runtime as Record<string, unknown>;
        runtime.tabUrl = "https://chatgpt.com:444/c/canonical-conversation";
      }),
      mutate(hint, (copy) => {
        const runtime = copy.runtime as Record<string, unknown>;
        runtime.tabUrl = "https://chatgpt.com/c/WEB:provisional-client-id";
        delete runtime.conversationId;
      }),
      mutate(hint, (copy) => {
        const runtime = copy.runtime as Record<string, unknown>;
        runtime.conversationId = "contradictory-conversation";
      }),
    ];

    for (const value of invalid) {
      expect(sanitizeRemoteRunRecoveryHint(value)).toBeUndefined();
      expect(verify(value)).toBe(false);
    }
  });

  test("builder refuses unsigned authorities and pre-submit coordinates but may report challenges", () => {
    const runtime = {
      tabUrl: "https://chatgpt.com/c/canonical-conversation",
      conversationId: "canonical-conversation",
      promptSubmitted: true,
    };
    const authority = {
      originRunId: "origin-run-123",
      accountId: "acct1",
      authToken: AUTH_TOKEN,
      promptPreview: PROMPT_PREVIEW,
      promptDomSha256: PROMPT_DOM_SHA256,
      nowMs: NOW_MS,
    };

    expect(
      buildRemoteRunRecoveryHint(
        { stage: "assistant-timeout", runtime: { ...runtime, promptSubmitted: false } },
        undefined,
        authority,
      ),
    ).toBeUndefined();
    expect(
      buildRemoteRunRecoveryHint({ stage: "assistant-timeout", runtime }, undefined, {
        ...authority,
        authToken: "",
      }),
    ).toBeUndefined();
    expect(
      buildRemoteRunRecoveryHint({ stage: "assistant-timeout", runtime }, undefined, {
        ...authority,
        promptPreview: "   ",
      }),
    ).toBeUndefined();
    expect(
      buildRemoteRunRecoveryHint({ stage: "assistant-timeout", runtime }, undefined, {
        ...authority,
        promptDomSha256: "A".repeat(64),
      }),
    ).toBeUndefined();

    const challenge = buildRemoteRunRecoveryHint(
      { stage: "cloudflare-challenge", runtime },
      undefined,
      authority,
    );
    expect(challenge?.stage).toBe("cloudflare-challenge");
    expect(verify(challenge)).toBe(true);
  });
});

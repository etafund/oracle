import { describe, expect, test, vi } from "vitest";

import type { BrowserSessionConfig } from "../../src/sessionManager.js";
import {
  createRemoteBrowserExecutor,
  recoverRemoteBrowserSession,
} from "../../src/remote/client.js";
import {
  MAX_REMOTE_RECOVERY_REQUEST_BYTES,
  sanitizeRemoteBrowserRecoveryRequestForHost,
} from "../../src/remote/payload_sanitize.js";
import { buildRemoteRunRecoveryHint } from "../../src/remote/recovery.js";
import {
  REMOTE_BROWSER_RECOVERY_PROTOCOL,
  type RemoteBrowserRecoveryRequest,
} from "../../src/remote/types.js";
import {
  PROMPT_DOM_IDENTITY_ALGORITHM,
  PROMPT_RECOVERY_PREVIEW_ALGORITHM,
} from "../../src/browser/promptDomMatch.js";

type ExecutorOptions = Parameters<typeof createRemoteBrowserExecutor>[0];
type RequestFn = NonNullable<ExecutorOptions["requestFn"]>;
type RequestHandlers = Record<string, (...args: unknown[]) => void>;

describe("remote client payload sanitizer", () => {
  test("serializes requests through the wire allowlist before sending", async () => {
    const { requestFn, body } = captureSerializedBodyRequest();
    const exec = createRemoteBrowserExecutor({
      host: "localhost:9222",
      token: "remote-client-token",
      requestFn,
    });

    await exec({
      prompt: "CHECK_CLIENT_SANITIZE",
      config: {
        url: "https://chatgpt.com/",
        // Served-model label: survives the client fleet gate so this test
        // exercises the wire allowlist (not the model gate). See
        // tests/remote/client_model_gate.test.ts for the gate itself.
        desiredModel: "GPT-5.6 Sol",
        modelStrategy: "select",
        timeoutMs: 90_000,
        inputTimeoutMs: 12_000,
        queueTimeoutMs: 75_000,
        researchMode: "deep",
        resumeConversationUrl: "https://chat.openai.com/c/client-safe-resume",
        inlineCookies: [
          {
            name: "__Secure-next-auth.session-token",
            value: "client-cookie-secret",
            domain: "chatgpt.com",
            path: "/",
            secure: true,
            httpOnly: true,
          },
        ],
        inlineCookiesSource: "/tmp/client-inline-cookie-source.json",
        chromeCookiePath: "/Users/client/Chrome/Default/Cookies",
        chromeProfile: "ClientDefault",
        manualLoginProfileDir: "/Users/client/.oracle/browser-profile",
        debugPort: 9222,
        attachRunning: true,
        keepBrowser: true,
        browserTabRef: "client-tab",
        remoteChrome: { host: "127.0.0.1", port: 9223 },
        // @ts-expect-error regression input from older callers/config plumbing
        remoteToken: "remote-token-in-config",
      },
      heartbeatIntervalMs: 5000,
      verbose: true,
      sessionId: "client-payload-sanitize",
      followUpPrompts: ["safe follow-up"],
      log: () => {},
    }).catch(() => {});

    const raw = body();
    expect(raw, "request body was not captured").not.toBeNull();
    expect(raw).toContain("CHECK_CLIENT_SANITIZE");
    expect(raw).toContain("GPT-5.6 Sol");
    expect(raw).not.toContain("client-cookie-secret");
    expect(raw).not.toContain("client-inline-cookie-source");
    expect(raw).not.toContain("/Users/client/Chrome");
    expect(raw).not.toContain("/Users/client/.oracle/browser-profile");
    expect(raw).not.toContain("ClientDefault");
    expect(raw).not.toContain("client-tab");
    expect(raw).not.toContain("remote-client-token");
    expect(raw).not.toContain("remote-token-in-config");

    const payload = JSON.parse(raw ?? "{}") as Record<string, unknown>;
    const browserConfig = payload.browserConfig as Record<string, unknown>;
    expect(browserConfig).toMatchObject({
      url: "https://chatgpt.com/",
      desiredModel: "GPT-5.6 Sol",
      modelStrategy: "select",
      timeoutMs: 90_000,
      inputTimeoutMs: 12_000,
      queueTimeoutMs: 75_000,
      researchMode: "deep",
      resumeConversationUrl: "https://chat.openai.com/c/client-safe-resume",
    });
    for (const forbidden of [
      "inlineCookies",
      "inlineCookiesSource",
      "chromeCookiePath",
      "chromeProfile",
      "manualLoginProfileDir",
      "debugPort",
      "attachRunning",
      "keepBrowser",
      "browserTabRef",
      "remoteChrome",
      "remoteToken",
    ]) {
      expect(browserConfig).not.toHaveProperty(forbidden);
    }

    expect(payload.options).toMatchObject({
      heartbeatIntervalMs: 5000,
      verbose: true,
      sessionId: "client-payload-sanitize",
      followUpPrompts: ["safe follow-up"],
    });
  });

  test("rejects malformed run options before writing the request", async () => {
    const { requestFn, body } = captureSerializedBodyRequest();
    const exec = createRemoteBrowserExecutor({
      host: "localhost:9222",
      token: "remote-client-token",
      requestFn,
    });

    await expect(
      exec({
        prompt: "CHECK_CLIENT_SANITIZE",
        config: {},
        followUpPrompts: ["safe follow-up", 42 as unknown as string],
      }),
    ).rejects.toThrow(/follow-up prompt 1/i);
    expect(body()).toBeNull();
  });

  test("rejects unsafe resumeConversationUrl before writing the request", async () => {
    const { requestFn, body } = captureSerializedBodyRequest();
    const exec = createRemoteBrowserExecutor({
      host: "localhost:9222",
      token: "remote-client-token",
      requestFn,
    });

    await expect(
      exec({
        prompt: "CHECK_CLIENT_SANITIZE",
        config: {
          resumeConversationUrl: "https://evil.example/c/not-chatgpt",
        },
        log: () => {},
      }),
    ).rejects.toThrow(/resumeConversationUrl/i);
    expect(body()).toBeNull();
  });

  test("minimizes a realistic saved config before POST /recover without mutating the saved config", async () => {
    const { requestFn, body } = captureSerializedBodyRequest();
    const cookieSecret = `cookie-${"x".repeat(70 * 1024)}`;
    const savedConfig: BrowserSessionConfig = {
      url: "https://chatgpt.com/g/g-private/project",
      chatgptUrl: "https://chatgpt.com/",
      timeoutMs: 2_400_000,
      inputTimeoutMs: 45_000,
      queueTimeoutMs: 360_000,
      assistantRecheckDelayMs: 2_000,
      assistantRecheckTimeoutMs: 120_000,
      autoReattachDelayMs: 3_000,
      autoReattachIntervalMs: 10_000,
      autoReattachTimeoutMs: 300_000,
      researchMode: "off",
      desiredModel: "GPT-5.6 Pro",
      thinkingTime: "extended",
      resumeConversationUrl: "https://chatgpt.com/c/saved-config-conversation",
      inlineCookies: [
        {
          name: "__Secure-next-auth.session-token",
          value: cookieSecret,
          domain: "chatgpt.com",
          path: "/",
          secure: true,
          httpOnly: true,
        },
      ],
      inlineCookiesSource: "/home/client/.oracle/private-cookies.json",
      chromePath: "/usr/bin/google-chrome",
      chromeCookiePath: "/home/client/.config/chrome/Cookies",
      chromeProfile: "ClientDefault",
      manualLoginProfileDir: "/home/client/.oracle/browser-profile",
      debugPort: 9222,
      attachRunning: true,
      keepBrowser: true,
      browserTabRef: "client-owned-target",
      remoteChrome: { host: "127.0.0.1", port: 9223 },
      cookieNames: ["__Secure-next-auth.session-token"],
      cookieSync: false,
      manualLogin: true,
      allowCookieErrors: true,
    };
    const savedSnapshot = structuredClone(savedConfig);
    const request = recoveryRequest(savedConfig);

    await recoverRemoteBrowserSession({
      host: "localhost:9222",
      token: "remote-client-token",
      accountId: "acct1",
      request,
      requestFn,
    }).catch(() => undefined);

    const raw = body();
    expect(raw, "recovery request body was not captured").not.toBeNull();
    expect(Buffer.byteLength(raw ?? "", "utf8")).toBeLessThan(MAX_REMOTE_RECOVERY_REQUEST_BYTES);
    expect(raw).not.toContain(cookieSecret);
    expect(raw).not.toContain("private-cookies.json");
    expect(raw).not.toContain("browser-profile");
    expect(raw).not.toContain("client-owned-target");
    expect(raw).not.toContain("remote-client-token");

    const wire = JSON.parse(raw ?? "{}") as RemoteBrowserRecoveryRequest;
    expect(wire.recovery).toMatchObject({
      promptPreviewAlgorithm: PROMPT_RECOVERY_PREVIEW_ALGORITHM,
      promptDomIdentityAlgorithm: PROMPT_DOM_IDENTITY_ALGORITHM,
    });
    expect(wire.browserConfig).toEqual({
      timeoutMs: 2_400_000,
      inputTimeoutMs: 45_000,
      queueTimeoutMs: 360_000,
      assistantRecheckDelayMs: 2_000,
      assistantRecheckTimeoutMs: 120_000,
      autoReattachDelayMs: 3_000,
      autoReattachIntervalMs: 10_000,
      autoReattachTimeoutMs: 300_000,
      researchMode: "off",
    });
    expect(() => sanitizeRemoteBrowserRecoveryRequestForHost(wire)).not.toThrow();
    expect(savedConfig).toEqual(savedSnapshot);
  });

  test.each([
    ["top-level", (value: Record<string, unknown>) => (value.prompt = "must-not-submit")],
    [
      "recovery runtime",
      (value: Record<string, unknown>) =>
        ((
          (value.recovery as Record<string, unknown>).runtime as Record<string, unknown>
        ).chromePort = 9222),
    ],
    [
      "browser config",
      (value: Record<string, unknown>) =>
        ((value.browserConfig as Record<string, unknown>).inlineCookies = [
          { name: "session", value: "secret" },
        ]),
    ],
    [
      "options",
      (value: Record<string, unknown>) =>
        ((value.options as Record<string, unknown>).followUpPrompts = ["submit again"]),
    ],
  ])("host strictly rejects an extra %s recovery field", (_label, mutate) => {
    const value = structuredClone(recoveryRequest({ timeoutMs: 120_000 })) as unknown as Record<
      string,
      unknown
    >;
    mutate(value);
    expect(() => sanitizeRemoteBrowserRecoveryRequestForHost(value)).toThrow(/unexpected field/i);
  });

  test.each([
    [
      "legacy v1 schema",
      (value: Record<string, unknown>) => {
        value.schema = "remote-browser-recovery.v1";
      },
    ],
    [
      "missing DOM digest",
      (value: Record<string, unknown>) => {
        delete (value.recovery as Record<string, unknown>).promptDomSha256;
      },
    ],
    [
      "missing preview algorithm version",
      (value: Record<string, unknown>) => {
        delete (value.recovery as Record<string, unknown>).promptPreviewAlgorithm;
      },
    ],
    [
      "unknown DOM identity algorithm version",
      (value: Record<string, unknown>) => {
        (value.recovery as Record<string, unknown>).promptDomIdentityAlgorithm =
          "oracle.rendered-prompt-dom-identity.v1";
      },
    ],
    [
      "malformed DOM digest",
      (value: Record<string, unknown>) => {
        (value.recovery as Record<string, unknown>).promptDomSha256 = "A".repeat(64);
      },
    ],
  ])("host rejects a %s recovery request", async (_label, mutate) => {
    const value = structuredClone(recoveryRequest({ timeoutMs: 120_000 })) as unknown as Record<
      string,
      unknown
    >;
    mutate(value);
    expect(() => sanitizeRemoteBrowserRecoveryRequestForHost(value)).toThrow(/invalid/i);
  });
});

function recoveryRequest(browserConfig: BrowserSessionConfig): RemoteBrowserRecoveryRequest {
  const promptPreview = "exact submitted prompt prefix";
  const recovery = buildRemoteRunRecoveryHint(
    {
      stage: "assistant-recheck",
      runtime: {
        tabUrl: "https://chatgpt.com/c/recovery-client-test",
        conversationId: "recovery-client-test",
        promptSubmitted: true,
      },
    },
    undefined,
    {
      originRunId: "origin-client-test",
      accountId: "acct1",
      authToken: "account-secret",
      promptPreview,
      promptDomSha256: "d".repeat(64),
      nowMs: Date.now(),
    },
  );
  if (!recovery || recovery.stage !== "assistant-recheck") {
    throw new Error("failed to build recovery client fixture");
  }
  return {
    schema: REMOTE_BROWSER_RECOVERY_PROTOCOL,
    recovery: { ...recovery, stage: "assistant-recheck" },
    promptPreview,
    browserConfig,
    options: {
      heartbeatIntervalMs: 5_000,
      verbose: true,
      sessionId: "recovery-client-test",
    },
  };
}

function captureSerializedBodyRequest(): {
  requestFn: RequestFn;
  body: () => string | null;
} {
  let capturedBody: string | null = null;
  const requestFn: RequestFn = ((_opts: unknown, _cb: unknown) => {
    const handlers: RequestHandlers = {};
    return {
      on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        handlers[event] = handler;
      }),
      write: vi.fn((body: Buffer | string) => {
        capturedBody = typeof body === "string" ? body : body.toString("utf8");
      }),
      end: vi.fn(() => {
        setImmediate(() => handlers.error?.(new Error("test-stub: end")));
      }),
      destroy: vi.fn(),
    };
  }) as unknown as RequestFn;
  return { requestFn, body: () => capturedBody };
}

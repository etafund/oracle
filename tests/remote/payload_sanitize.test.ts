import http from "node:http";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

import { describe, expect, test } from "vitest";

import type { BrowserRunResult } from "../../src/browserMode.js";
import { createRemoteServer } from "../../src/remote/server.js";
import {
  sanitizeRemoteRunPayloadForHost,
  serializeRemoteRunPayloadForWire,
} from "../../src/remote/payload_sanitize.js";
import type { RemoteRunPayload } from "../../src/remote/types.js";
import {
  REMOTE_BROWSER_RECOVERY_ADMISSION_HEADER_VALUES,
  REMOTE_BROWSER_RUN_PATH,
} from "../../src/remote/types.js";

const CAN_LISTEN_LOCALHOST =
  spawnSync(
    process.execPath,
    [
      "-e",
      `
      const net = require('net');
      const s = net.createServer();
      s.on('error', () => process.exit(1));
      s.listen(0, '127.0.0.1', () => s.close(() => process.exit(0)));
    `,
    ],
    { stdio: "ignore" },
  ).status === 0;

describe("remote payload sanitization", () => {
  test("wire serializer strips client cookies, tokens, and host-local browser config", () => {
    const raw = serializeRemoteRunPayloadForWire(maliciousPayload());

    expect(raw).toContain("gpt-5.5-pro");
    expect(raw).toContain("CHECK_SAFE_REMOTE_PAYLOAD");
    expect(raw).not.toContain("client-cookie-secret");
    expect(raw).not.toContain("client-inline-cookie-source");
    expect(raw).not.toContain("/Users/client/Chrome");
    expect(raw).not.toContain("/Applications/Client Chrome.app");
    expect(raw).not.toContain("/Users/client/.oracle/browser-profile");
    expect(raw).not.toContain("remote-browser-token");

    const parsed = JSON.parse(raw) as RemoteRunPayload;
    expect(parsed.browserConfig).toMatchObject({
      desiredModel: "gpt-5.5-pro",
      modelStrategy: "select",
      timeoutMs: 90_000,
      queueTimeoutMs: 75_000,
      thinkingTime: "heavy",
      resumeConversationUrl: "https://chatgpt.com/c/safe-resume-id",
    });
    expect(parsed.browserConfig).not.toHaveProperty("inlineCookies");
    expect(parsed.browserConfig).not.toHaveProperty("inlineCookiesSource");
    expect(parsed.browserConfig).not.toHaveProperty("chromePath");
    expect(parsed.browserConfig).not.toHaveProperty("chromeCookiePath");
    expect(parsed.browserConfig).not.toHaveProperty("chromeProfile");
    expect(parsed.browserConfig).not.toHaveProperty("manualLoginProfileDir");
    expect(parsed.browserConfig).not.toHaveProperty("debugPort");
    expect(parsed.browserConfig).not.toHaveProperty("attachRunning");
    expect(parsed.browserConfig).not.toHaveProperty("keepBrowser");
    expect(parsed.browserConfig).not.toHaveProperty("browserTabRef");
  });

  test("host intake rejects unknown browser fields instead of silently dropping them", () => {
    expect(() => sanitizeRemoteRunPayloadForHost(maliciousPayload())).toThrow(
      /unexpected field inlineCookies/i,
    );
  });

  test.each([
    ["empty desiredModel", { desiredModel: "" }, /desiredModel.*non-empty string/i],
    ["boolean desiredModel", { desiredModel: false }, /desiredModel.*non-empty string/i],
    ["numeric desiredModel", { desiredModel: 0 }, /desiredModel.*non-empty string/i],
    ["numeric modelStrategy", { modelStrategy: 0 }, /modelStrategy.*non-empty string/i],
    ["unknown thinkingTime", { thinkingTime: "maximum" }, /thinkingTime.*not recognized/i],
  ])("host intake rejects %s", (_label, browserConfig, expected) => {
    expect(() =>
      sanitizeRemoteRunPayloadForHost({
        prompt: "x",
        attachments: [],
        browserConfig,
        options: {},
      } as unknown as RemoteRunPayload),
    ).toThrow(expected);
  });

  test.each([
    ["a tab in fileName", { fileName: "bad\tname.txt" }, /fileName|basename/i],
    ["a newline in displayPath", { displayPath: "bad\npath.txt" }, /displayPath|relative/i],
    ["non-canonical base64", { contentBase64: "eA" }, /contentBase64.*canonical/i],
  ])("rejects an attachment with %s", (_label, override, expected) => {
    const content = Buffer.from("x", "utf8");
    const attachment = {
      fileName: "safe.txt",
      displayPath: "safe.txt",
      sizeBytes: content.length,
      sha256: createHash("sha256").update(content).digest("hex"),
      generatedBundle: false,
      contentBase64: content.toString("base64"),
      ...override,
    };
    expect(() =>
      sanitizeRemoteRunPayloadForHost({
        prompt: "x",
        attachments: [attachment],
        browserConfig: {},
        options: {},
      }),
    ).toThrow(expected);
  });

  test("preserves strict prompt fallback policy and rejects missing or extra authorization", () => {
    const payload: RemoteRunPayload = {
      prompt: "primary",
      attachments: [],
      fallbackSubmission: {
        prompt: "fallback",
        attachments: [],
      },
      fallbackPolicy: {
        attachmentsPolicy: "auto",
        bundleRequested: false,
        model: "gpt-5.6-sol",
        maxInputTokens: 272_000,
      },
      browserConfig: {},
      options: {},
    };

    const wire = JSON.parse(serializeRemoteRunPayloadForWire(payload)) as RemoteRunPayload;
    expect(wire.fallbackPolicy).toEqual(payload.fallbackPolicy);
    expect(sanitizeRemoteRunPayloadForHost(payload).fallbackPolicy).toEqual(payload.fallbackPolicy);

    const forgedPolicy = {
      ...payload,
      fallbackPolicy: { ...payload.fallbackPolicy, model: "gpt-5.5-pro" },
    } as unknown as RemoteRunPayload;
    expect(() => sanitizeRemoteRunPayloadForHost(forgedPolicy)).toThrow(/fallback policy/i);

    const missingPolicy = {
      ...payload,
      fallbackPolicy: undefined,
    } as unknown as RemoteRunPayload;
    expect(() => sanitizeRemoteRunPayloadForHost(missingPolicy)).toThrow(/supplied together/i);

    const extraField = {
      ...payload,
      fallbackSubmission: { ...payload.fallbackSubmission, trusted: true },
    } as unknown as RemoteRunPayload;
    expect(() => sanitizeRemoteRunPayloadForHost(extraField)).toThrow(/unexpected field trusted/i);
  });

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "server rejects client cookies and host-local paths before runBrowser",
    async () => {
      let capturedConfig: Record<string, unknown> | null = null;
      const server = await createRemoteServer(
        {
          host: "127.0.0.1",
          port: 0,
          token: "server-token",
          logger: () => {},
          manualLoginDefault: true,
          manualLoginProfileDir: "/server-owned/manual-profile",
          // This test exercises payload sanitization with a stubbed
          // runBrowser; disable the attach-only substrate gate so admission
          // does not require a live DevTools endpoint.
          attachOnly: false,
        },
        {
          runBrowser: async (options) => {
            capturedConfig = (options.config ?? {}) as Record<string, unknown>;
            return okResult();
          },
        },
      );

      try {
        const response = await postRun(server.port, maliciousPayload(), "server-token");
        expect(response.statusCode).toBe(400);
        expect(response.body).toContain("invalid_request");
      } finally {
        await server.close();
      }

      expect(capturedConfig).toBeNull();
    },
  );
});

function maliciousPayload(): RemoteRunPayload {
  return {
    prompt: "CHECK_SAFE_REMOTE_PAYLOAD",
    attachments: [],
    browserConfig: {
      url: "https://chatgpt.com/",
      desiredModel: "gpt-5.5-pro",
      modelStrategy: "select",
      timeoutMs: 90_000,
      queueTimeoutMs: 75_000,
      thinkingTime: "heavy",
      resumeConversationUrl: "https://chatgpt.com/c/safe-resume-id",
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
      chromePath: "/Applications/Client Chrome.app/Contents/MacOS/Google Chrome",
      chromeCookiePath: "/Users/client/Chrome/Default/Cookies",
      chromeProfile: "ClientDefault",
      manualLoginProfileDir: "/Users/client/.oracle/browser-profile",
      debugPort: 9222,
      attachRunning: true,
      keepBrowser: true,
      browserTabRef: "client-tab",
      remoteChrome: { host: "127.0.0.1", port: 9223 },
      cookieNames: ["__Secure-next-auth.session-token"],
      cookieSync: false,
      manualLogin: true,
      allowCookieErrors: true,
      // @ts-expect-error security regression input from older clients
      remoteToken: "remote-browser-token",
    },
    options: {
      verbose: true,
      sessionId: "remote-payload-sanitize-test",
    },
  };
}

function okResult(): BrowserRunResult {
  return {
    answerText: "ok",
    answerMarkdown: "ok",
    tookMs: 1,
    answerTokens: 1,
    answerChars: 2,
  };
}

async function postRun(
  port: number,
  payload: RemoteRunPayload,
  token: string,
): Promise<{ statusCode: number; body: string }> {
  return await new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: REMOTE_BROWSER_RUN_PATH,
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          ...REMOTE_BROWSER_RECOVERY_ADMISSION_HEADER_VALUES,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
      },
      (res) => {
        res.setEncoding("utf8");
        let responseBody = "";
        res.on("data", (chunk: string) => {
          responseBody += chunk;
        });
        res.on("end", () => {
          resolve({ statusCode: res.statusCode ?? 0, body: responseBody });
        });
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

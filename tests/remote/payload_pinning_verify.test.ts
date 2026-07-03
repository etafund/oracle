import { describe, expect, test } from "vitest";
import http from "node:http";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  REMOTE_RUN_TIMEOUT_MS_MAX,
  REMOTE_RUN_TIMEOUT_MS_MIN,
  sanitizeRemoteRunPayloadForHost,
} from "../../src/remote/payload_sanitize.js";
import { createRemoteServer } from "../../src/remote/server.js";
import type { BrowserRunResult } from "../../src/browserMode.js";
import type { RemoteRunPayload } from "../../src/remote/types.js";

// ─────────────────────────────────────────────────────────────────────────────
// F11 server-side browserConfig pinning — per-key audit (hostile-client fleet
// model: anyone holding the caller token can send any JSON; the server must
// construct Chrome/profile/CDP/lock/concurrency config exclusively from
// trusted service config).
//
// ALLOWLISTED KEYS (SAFE_BROWSER_CONFIG_KEYS) — verdicts:
//   url                       ALLOW. Validated by normalizeChatgptUrl: https
//                             only, hosts chatgpt.com/chat.openai.com only,
//                             no credentials/custom ports/control chars.
//                             Invalid value -> typed 400 at admission.
//   chatgptUrl                ALLOW. Same validator inside
//                             resolveBrowserConfig; invalid values fail the
//                             run loudly and never navigate elsewhere.
//   timeoutMs                 ALLOW + CLAMP. Bounded to
//                             [REMOTE_RUN_TIMEOUT_MS_MIN..MAX] on the host;
//                             non-finite or <= 0 (documented disable
//                             sentinel: unbounded tab-lease wait) is DROPPED
//                             so the server default wins. Prevents both the
//                             sentinel and a caller pinning a lane for hours.
//   inputTimeoutMs            ALLOW + CLAMP. Same bounds/drop rules
//                             (composer-readiness wait).
//   assistantRecheckDelayMs   ALLOW + CLAMP [0..MAX]; negative/non-number
//                             dropped. 0 is a legitimate default.
//   assistantRecheckTimeoutMs ALLOW + CLAMP [0..MAX]; as above.
//   autoReattachDelayMs       ALLOW + CLAMP [0..MAX]; as above.
//   autoReattachIntervalMs    ALLOW + CLAMP [0..MAX]; 0 = disabled is safe.
//   autoReattachTimeoutMs     ALLOW + CLAMP [0..MAX]; as above.
//   desiredModel              ALLOW. Model-picker label; unknown labels fail
//                             model verification loudly. No path/exec
//                             semantics on the host.
//   modelStrategy             ALLOW. Normalized to a closed enum
//                             (normalizeBrowserModelStrategy); invalid ->
//                             default.
//   thinkingTime              ALLOW. Consumed as a closed-enum intensity by
//                             the thinking-time DOM flow; invalid values are
//                             ignored there.
//   researchMode              ALLOW. Normalized enum (normalizeResearchMode);
//                             "deep" only selects a longer default timeout,
//                             which the clamp still bounds when
//                             client-supplied.
//   archiveConversations      ALLOW. Normalized enum (normalizeArchiveMode);
//                             worst case archives/keeps a conversation the
//                             caller owns anyway.
//
// STRIPPED CLASSES (everything not in the allowlist is dropped; the server
// then force-pins cookie handling):
//   Chrome binary/profile/cookie paths  chromePath, chromeProfile,
//                                       chromeCookiePath,
//                                       manualLoginProfileDir,
//                                       copyProfileSource
//   Transport / CDP attachment          debugPort, remoteChrome,
//                                       remoteChromeBrowserWSEndpoint,
//                                       remoteChromeProfileRoot,
//                                       attachRunning, browserTabRef
//   Concurrency / locking               profileLockTimeoutMs,
//                                       maxConcurrentTabs, reuseChromeWaitMs
//   Cookies / auth material             cookieSync (forced true),
//                                       inlineCookies + inlineCookiesSource
//                                       (forced null), cookieNames,
//                                       cookieSyncWaitMs,
//                                       manualLoginCookieSync,
//                                       allowCookieErrors
//   Window / lifecycle / debug          headless, keepBrowser, hideWindow,
//                                       manualLogin, debug
//   Navigation pinning                  resumeConversationUrl
//   Host-budgeted timings               attachmentTimeoutMs
// ─────────────────────────────────────────────────────────────────────────────

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

const MINIMAL_RESULT: BrowserRunResult = {
  answerText: "ok",
  answerMarkdown: "ok",
  tookMs: 1,
  answerTokens: 1,
  answerChars: 2,
};

const STRIPPED_KEYS = [
  "chromePath",
  "chromeProfile",
  "chromeCookiePath",
  "manualLoginProfileDir",
  "copyProfileSource",
  "debugPort",
  "remoteChrome",
  "remoteChromeBrowserWSEndpoint",
  "remoteChromeProfileRoot",
  "attachRunning",
  "browserTabRef",
  "profileLockTimeoutMs",
  "maxConcurrentTabs",
  "reuseChromeWaitMs",
  "cookieNames",
  "cookieSyncWaitMs",
  "manualLoginCookieSync",
  "allowCookieErrors",
  "headless",
  "keepBrowser",
  "hideWindow",
  "manualLogin",
  "debug",
  "resumeConversationUrl",
  "attachmentTimeoutMs",
] as const;

function hostilePayload(): Record<string, unknown> {
  return {
    prompt: "pinning verify",
    attachments: [],
    browserConfig: {
      // Hostile values for every stripped key.
      chromePath: "/usr/bin/false",
      chromeProfile: "Hostile",
      chromeCookiePath: "/etc/passwd",
      manualLoginProfileDir: "/somewhere/else",
      copyProfileSource: "/victim/profile",
      debugPort: 1,
      remoteChrome: { host: "192.0.2.1", port: 9222 },
      remoteChromeBrowserWSEndpoint: "ws://192.0.2.1:9222/devtools/browser/x",
      remoteChromeProfileRoot: "/victim/root",
      attachRunning: true,
      browserTabRef: "hostile-tab",
      profileLockTimeoutMs: 0,
      maxConcurrentTabs: 99,
      reuseChromeWaitMs: 0,
      cookieNames: ["session"],
      cookieSyncWaitMs: 0,
      manualLoginCookieSync: true,
      allowCookieErrors: true,
      headless: true,
      keepBrowser: true,
      hideWindow: true,
      manualLogin: true,
      debug: true,
      resumeConversationUrl: "https://chatgpt.com/c/other-tenant",
      attachmentTimeoutMs: 1,
      // Sentinel/pinning attempts on allowlisted keys.
      timeoutMs: 0,
      inputTimeoutMs: -1,
      // Cookie-material injection attempts.
      cookieSync: false,
      inlineCookies: [{ name: "stolen", value: "cookie", domain: "chatgpt.com" }],
      inlineCookiesSource: "hostile",
    },
    options: {},
  };
}

describe("host-side browserConfig timing clamps", () => {
  test("timeoutMs/inputTimeoutMs: sentinel and nonsense dropped, extremes clamped", () => {
    const sanitize = (browserConfig: Record<string, unknown>) =>
      sanitizeRemoteRunPayloadForHost({
        prompt: "x",
        attachments: [],
        browserConfig,
        options: {},
      } as unknown as RemoteRunPayload).browserConfig as Record<string, unknown>;

    // <= 0 must never reach the downstream disable-sentinel path.
    expect(sanitize({ timeoutMs: 0 }).timeoutMs).toBeUndefined();
    expect(sanitize({ timeoutMs: -1 }).timeoutMs).toBeUndefined();
    expect(sanitize({ inputTimeoutMs: 0 }).inputTimeoutMs).toBeUndefined();
    expect(sanitize({ inputTimeoutMs: -5 }).inputTimeoutMs).toBeUndefined();
    // Non-numbers are dropped, not coerced.
    expect(sanitize({ timeoutMs: "60000" }).timeoutMs).toBeUndefined();
    expect(sanitize({ timeoutMs: Number.NaN }).timeoutMs).toBeUndefined();
    expect(sanitize({ timeoutMs: Number.POSITIVE_INFINITY }).timeoutMs).toBeUndefined();
    // Extremes are clamped to the shared bounds.
    expect(sanitize({ timeoutMs: 10 * 60 * 60 * 1000 }).timeoutMs).toBe(REMOTE_RUN_TIMEOUT_MS_MAX);
    expect(sanitize({ timeoutMs: 500 }).timeoutMs).toBe(REMOTE_RUN_TIMEOUT_MS_MIN);
    expect(sanitize({ inputTimeoutMs: 10 * 60 * 60 * 1000 }).inputTimeoutMs).toBe(
      REMOTE_RUN_TIMEOUT_MS_MAX,
    );
    // Legitimate values pass through untouched.
    expect(sanitize({ timeoutMs: 90_000 }).timeoutMs).toBe(90_000);
    expect(sanitize({ inputTimeoutMs: 30_000 }).inputTimeoutMs).toBe(30_000);
  });

  test("auxiliary waits: negatives/non-numbers dropped, zero kept, upper bound applied", () => {
    const sanitize = (browserConfig: Record<string, unknown>) =>
      sanitizeRemoteRunPayloadForHost({
        prompt: "x",
        attachments: [],
        browserConfig,
        options: {},
      } as unknown as RemoteRunPayload).browserConfig as Record<string, unknown>;

    expect(sanitize({ assistantRecheckDelayMs: 0 }).assistantRecheckDelayMs).toBe(0);
    expect(sanitize({ assistantRecheckDelayMs: -1 }).assistantRecheckDelayMs).toBeUndefined();
    expect(
      sanitize({ assistantRecheckTimeoutMs: 10 * 60 * 60 * 1000 }).assistantRecheckTimeoutMs,
    ).toBe(REMOTE_RUN_TIMEOUT_MS_MAX);
    expect(sanitize({ autoReattachIntervalMs: 0 }).autoReattachIntervalMs).toBe(0);
    expect(
      sanitize({ autoReattachTimeoutMs: Number.MAX_SAFE_INTEGER }).autoReattachTimeoutMs,
    ).toBe(REMOTE_RUN_TIMEOUT_MS_MAX);
    expect(sanitize({ autoReattachDelayMs: "soon" }).autoReattachDelayMs).toBeUndefined();
  });
});

describe("sanitizer is the single choke point between payloads and runBrowser", () => {
  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "a hostile payload with every stripped key reaches runBrowser with none of them",
    async () => {
      let receivedConfig: Record<string, unknown> | null = null;
      const server = await createRemoteServer(
        { host: "127.0.0.1", port: 0, token: "secret", logger: () => {} },
        {
          runBrowser: async (options) => {
            receivedConfig = { ...(options.config as Record<string, unknown>) };
            return MINIMAL_RESULT;
          },
        },
      );

      try {
        const response = await sendRun(server.port, "secret", JSON.stringify(hostilePayload()));
        expect(response.statusCode).toBe(200);
        expect(receivedConfig).not.toBeNull();
        const config = receivedConfig as unknown as Record<string, unknown>;
        for (const key of STRIPPED_KEYS) {
          expect(config[key], `stripped key leaked: ${key}`).toBeUndefined();
        }
        // Cookie handling is force-pinned regardless of hostile input.
        expect(config.cookieSync).toBe(true);
        expect(config.inlineCookies).toBeNull();
        expect(config.inlineCookiesSource).toBeNull();
        // Sentinel attempts on allowlisted timings never arrive.
        expect(config.timeoutMs).toBeUndefined();
        expect(config.inputTimeoutMs).toBeUndefined();
      } finally {
        await server.close();
      }
    },
  );

  test("server source routes the parsed body through sanitizeRemoteRunPayloadForHost only", async () => {
    const serverSource = await readFile(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "../../src/remote/server.ts"),
      "utf8",
    );
    // The raw body is parsed exactly once, directly inside the sanitizer call.
    const parseSites = serverSource.match(/JSON\.parse\(body\)/g) ?? [];
    expect(parseSites).toHaveLength(1);
    expect(serverSource).toContain(
      "sanitizeRemoteRunPayloadForHost(JSON.parse(body) as RemoteRunPayload)",
    );
    // After sanitization the server only writes these pinned/normalized
    // fields onto the config; nothing else may copy client browserConfig
    // material around the sanitizer.
    const writes = new Set(
      [...serverSource.matchAll(/payload\.browserConfig\.(\w+)\s*=/g)].map((match) => match[1]),
    );
    const allowedWrites = new Set([
      "url",
      "inlineCookies",
      "inlineCookiesSource",
      "cookieSync",
      "manualLogin",
      "manualLoginProfileDir",
      "keepBrowser",
    ]);
    for (const key of writes) {
      expect(allowedWrites.has(key ?? ""), `unexpected browserConfig write: ${key}`).toBe(true);
    }
  });
});

interface RunResponse {
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

async function sendRun(port: number, token: string, body: string): Promise<RunResponse> {
  return await new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/runs",
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
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
        const settle = () =>
          resolve({ statusCode: res.statusCode ?? 0, headers: res.headers, body: responseBody });
        res.on("end", settle);
        res.on("close", settle);
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import {
  createLeasedBrowserExecutor,
  deriveBrowserLeaseProfileHash,
  runBrowserWithLease,
  type BrowserExecutor,
} from "../../src/browser/leaseIntegration.js";
import { readBrowserLease } from "../../src/browser/leases.js";
import { runLeasedProviderDomFlow } from "../../src/browser/providers/leaseProvider.js";
import type { ProviderDomAdapter } from "../../src/browser/providerDomFlow.js";
import type { BrowserRunOptions, BrowserRunResult } from "../../src/browser/types.js";

const PROFILE_A = `sha256:${"a".repeat(64)}`;
const PROFILE_B = `sha256:${"b".repeat(64)}`;

async function withLeaseDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-browser-lease-integration-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function browserResult(overrides: Partial<BrowserRunResult> = {}): BrowserRunResult {
  return {
    answerText: "ok",
    answerMarkdown: "ok",
    tookMs: 100,
    answerTokens: 1,
    answerChars: 2,
    ...overrides,
  };
}

describe("browser lease integration", () => {
  test("acquires before execution, emits runtime evidence, and releases after success", async () => {
    await withLeaseDir(async (leaseDir) => {
      let nowMs = Date.parse("2026-01-01T00:00:00.000Z");
      const now = () => new Date(nowMs);
      const runtimeHints: unknown[] = [];
      const executeBrowser = vi.fn(async (options: BrowserRunOptions) => {
        const active = await readBrowserLease("chatgpt", {
          leaseDir,
          expectedProfileIdHash: PROFILE_A,
          now,
          isProcessAlive: () => true,
        });
        expect(active.state).toBe("active");
        await options.runtimeHintCb?.({
          chromePort: 9222,
          chromeHost: "127.0.0.1",
          chromeTargetId: "target-1",
          tabUrl: "https://chatgpt.com/c/abc",
          conversationId: "abc",
        });
        nowMs = Date.parse("2026-01-01T00:00:05.000Z");
        return browserResult({ chromePort: 9222, conversationId: "abc" });
      });

      const result = await runBrowserWithLease(
        {
          prompt: "hello",
          sessionId: "session-success",
          runtimeHintCb: (hint) => {
            runtimeHints.push(hint);
          },
        },
        executeBrowser,
        {
          provider: "chatgpt",
          profileIdHash: PROFILE_A,
          leaseDir,
          now,
          pid: 1234,
          uuid: () => "lease-success",
          isProcessAlive: () => true,
          ttlSeconds: 300,
          holder: "pane-2",
        },
      );

      expect(executeBrowser).toHaveBeenCalledTimes(1);
      expect(result.lease).toMatchObject({
        schema_version: "browser_lease_execution.v1",
        lease_id: "lease-success",
        provider: "chatgpt",
        profile_id_hash: PROFILE_A,
        status: "released",
      });
      expect(runtimeHints).toHaveLength(1);
      expect(runtimeHints[0]).toMatchObject({
        chromePort: 9222,
        browserLease: {
          lease_id: "lease-success",
          provider: "chatgpt",
          status: "acquired",
        },
      });

      const stored = await readBrowserLease("chatgpt", {
        leaseDir,
        expectedProfileIdHash: PROFILE_A,
        now,
        isProcessAlive: () => true,
      });
      expect(stored.state).toBe("released");
      if (stored.state === "released") {
        expect(stored.record.released_at).toBe("2026-01-01T00:00:05.000Z");
        expect(stored.record.remote_session_id).toBe("session-success");
      }
    });
  });

  test("releases the lease when provider execution times out", async () => {
    await withLeaseDir(async (leaseDir) => {
      let nowMs = Date.parse("2026-01-01T00:00:00.000Z");
      const now = () => new Date(nowMs);
      const timeout = new Error("Timed out waiting for provider response.");
      const executeBrowser: BrowserExecutor = async () => {
        nowMs = Date.parse("2026-01-01T00:02:00.000Z");
        throw timeout;
      };

      await expect(
        runBrowserWithLease(
          { prompt: "slow prompt", sessionId: "session-timeout" },
          executeBrowser,
          {
            provider: "chatgpt",
            profileIdHash: PROFILE_A,
            leaseDir,
            now,
            uuid: () => "lease-timeout",
            isProcessAlive: () => true,
          },
        ),
      ).rejects.toThrow("Timed out waiting for provider response.");

      const stored = await readBrowserLease("chatgpt", {
        leaseDir,
        expectedProfileIdHash: PROFILE_A,
        now,
        isProcessAlive: () => true,
      });
      expect(stored.state).toBe("released");
      if (stored.state === "released") {
        expect(stored.record.lease_id).toBe("lease-timeout");
        expect(stored.record.released_at).toBe("2026-01-01T00:02:00.000Z");
      }
    });
  });

  test("wraps provider DOM flow so prompt submission happens under an active lease", async () => {
    await withLeaseDir(async (leaseDir) => {
      let nowMs = Date.parse("2026-01-01T00:00:00.000Z");
      const now = () => new Date(nowMs);
      const sequence: string[] = [];
      const adapter: ProviderDomAdapter = {
        providerName: "chatgpt-web",
        waitForUi: async (ctx) => {
          sequence.push("waitForUi");
          expect(ctx.state?.browserLease).toMatchObject({
            lease_id: "lease-provider-flow",
            status: "acquired",
          });
          const active = await readBrowserLease("chatgpt", {
            leaseDir,
            expectedProfileIdHash: PROFILE_A,
            now,
            isProcessAlive: () => true,
          });
          expect(active.state).toBe("active");
        },
        selectMode: async () => {
          sequence.push("selectMode");
        },
        typePrompt: async () => {
          sequence.push("typePrompt");
        },
        submitPrompt: async () => {
          sequence.push("submitPrompt");
          expect(sequence).toEqual(["waitForUi", "selectMode", "typePrompt", "submitPrompt"]);
        },
        waitForResponse: async () => {
          sequence.push("waitForResponse");
          nowMs = Date.parse("2026-01-01T00:00:10.000Z");
          return { text: "leased answer" };
        },
      };
      const state: Record<string, unknown> = {};

      const result = await runLeasedProviderDomFlow(
        adapter,
        {
          prompt: "leased prompt",
          evaluate: async () => undefined,
          delay: async () => undefined,
          state,
        },
        {
          provider: "chatgpt",
          profileIdHash: PROFILE_A,
          leaseDir,
          now,
          uuid: () => "lease-provider-flow",
          isProcessAlive: () => true,
        },
      );

      expect(sequence).toEqual([
        "waitForUi",
        "selectMode",
        "typePrompt",
        "submitPrompt",
        "waitForResponse",
      ]);
      expect(result).toMatchObject({
        text: "leased answer",
        thoughts: null,
        lease: {
          lease_id: "lease-provider-flow",
          provider: "chatgpt",
          status: "released",
        },
      });
      expect(state.browserLease).toMatchObject({
        lease_id: "lease-provider-flow",
        status: "released",
      });
    });
  });

  test("keeps interruption-style abandoned runs recoverable when release is disabled", async () => {
    await withLeaseDir(async (leaseDir) => {
      const now = () => new Date("2026-01-01T00:00:00.000Z");
      const leasedExecutor = createLeasedBrowserExecutor(async () => browserResult(), {
        provider: "gemini",
        profileIdHash: PROFILE_B,
        leaseDir,
        now,
        uuid: () => "lease-abandoned",
        isProcessAlive: () => true,
        releaseOnCompletion: false,
      });

      const result = await leasedExecutor({ prompt: "simulate interrupted process" });

      expect(result).toMatchObject({
        answerText: "ok",
        lease: {
          lease_id: "lease-abandoned",
          provider: "gemini",
          status: "acquired",
          safe_recovery_command:
            "oracle browser leases recover --provider gemini --lease-id lease-abandoned",
        },
      });
      const stored = await readBrowserLease("gemini", {
        leaseDir,
        expectedProfileIdHash: PROFILE_B,
        now,
        isProcessAlive: () => true,
      });
      expect(stored.state).toBe("active");
      if (stored.state === "active") {
        expect(stored.recoveryCommand).toContain("lease-abandoned");
      }
    });
  });

  test("isolates ChatGPT and Gemini provider leases in the same lease directory", async () => {
    await withLeaseDir(async (leaseDir) => {
      let nowMs = Date.parse("2026-01-01T00:00:00.000Z");
      const now = () => new Date(nowMs);

      await runBrowserWithLease(
        { prompt: "chatgpt" },
        async () => browserResult({ answerText: "chatgpt", answerMarkdown: "chatgpt" }),
        {
          provider: "chatgpt",
          profileIdHash: PROFILE_A,
          leaseDir,
          now,
          uuid: () => "lease-chatgpt-active",
          isProcessAlive: () => true,
          releaseOnCompletion: false,
        },
      );

      nowMs = Date.parse("2026-01-01T00:01:00.000Z");
      const gemini = await runBrowserWithLease(
        { prompt: "gemini" },
        async () => browserResult({ answerText: "gemini", answerMarkdown: "gemini" }),
        {
          provider: "gemini",
          profileIdHash: PROFILE_B,
          leaseDir,
          now,
          uuid: () => "lease-gemini-released",
          isProcessAlive: () => true,
        },
      );

      expect(gemini.lease.status).toBe("released");
      const chatgptLease = await readBrowserLease("chatgpt", {
        leaseDir,
        expectedProfileIdHash: PROFILE_A,
        now,
        isProcessAlive: () => true,
      });
      const geminiLease = await readBrowserLease("gemini", {
        leaseDir,
        expectedProfileIdHash: PROFILE_B,
        now,
        isProcessAlive: () => true,
      });
      expect(chatgptLease.state).toBe("active");
      expect(geminiLease.state).toBe("released");
      if (chatgptLease.state === "active") {
        expect(chatgptLease.record.lease_id).toBe("lease-chatgpt-active");
      }
      if (geminiLease.state === "released") {
        expect(geminiLease.record.lease_id).toBe("lease-gemini-released");
      }
    });
  });

  test("derives stable provider-specific profile hashes from browser config", () => {
    const runOptions = {
      prompt: "ignored",
      config: {
        remoteChrome: { host: "browser.internal", port: 9222 },
        manualLogin: true,
        manualLoginProfileDir: "/profiles/shared",
        chatgptUrl: "https://chatgpt.com/g/project",
        attachRunning: true,
      },
    } satisfies BrowserRunOptions;
    const reordered = {
      prompt: "also ignored",
      attachments: [{ path: "/tmp/file", displayPath: "file" }],
      config: {
        attachRunning: true,
        chatgptUrl: "https://chatgpt.com/g/project",
        manualLoginProfileDir: "/profiles/shared",
        manualLogin: true,
        remoteChrome: { port: 9222, host: "browser.internal" },
      },
    } satisfies BrowserRunOptions;

    const hash = deriveBrowserLeaseProfileHash(runOptions, "chatgpt");
    expect(hash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(deriveBrowserLeaseProfileHash(reordered, "chatgpt")).toBe(hash);
    expect(deriveBrowserLeaseProfileHash(runOptions, "gemini")).not.toBe(hash);
    expect(
      deriveBrowserLeaseProfileHash(
        {
          ...runOptions,
          config: { ...runOptions.config, manualLoginProfileDir: "/profiles/other" },
        },
        "chatgpt",
      ),
    ).not.toBe(hash);
  });
});

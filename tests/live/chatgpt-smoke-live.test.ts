import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { getCookies } from "@steipete/sweet-cookie";
import { describe, expect, test } from "vitest";

import { runBrowserMode } from "../../src/browser/index.js";
import type { BrowserAutomationConfig, BrowserRunResult } from "../../src/browser/types.js";
import { loadUserConfig } from "../../src/config.js";
import { createRemoteBrowserExecutor } from "../../src/remote/client.js";
import { resolveRemoteServiceConfig } from "../../src/remote/remoteServiceConfig.js";
import {
  assertStructuredTestLogRecords,
  createStructuredTestLog,
} from "../_helpers/structuredTestLog.js";
import { acquireLiveTestLock, releaseLiveTestLock } from "./liveLock.js";

const LIVE_BROWSER =
  process.env.ORACLE_LIVE_TEST === "1" && process.env.ORACLE_LIVE_BROWSER === "1";

const CHECK_TOKEN = "CHECK_CHATGPT_PRO_OK";
const PROVIDER_SLOT = "chatgpt_pro_first_plan";
const LOCK_LABEL = "chatgpt-browser";
type BrowserExecutor = typeof runBrowserMode;

(LIVE_BROWSER ? describe : describe.skip)("ChatGPT Pro live browser smoke", () => {
  test(
    "returns the exact check token and writes verifiable sanitized smoke artifacts",
    async () => {
      const sessionId = `live-chatgpt-pro-${Date.now()}`;
      const log = createStructuredTestLog({
        testName: "live.chatgpt.pro.smoke",
        evidencePointer: `oracle session ${sessionId} --render`,
      });
      const remoteChrome = parseRemoteChrome();
      const remoteService = await resolveRemoteServiceForLive();
      if (remoteChrome && remoteService.host) {
        throw new Error(
          "Set either ORACLE_LIVE_REMOTE_CHROME or ORACLE_REMOTE_HOST/browser.remoteHost, not both.",
        );
      }
      const logs: string[] = [];
      const artifactPath = liveSmokeArtifactPath("chatgpt", `${sessionId}.jsonl`);

      log.record("preflight", {
        provider_slot: PROVIDER_SLOT,
        session_id: sessionId,
        remote_browser: remoteChrome ? "remote-chrome" : remoteService.host ? "service" : "local",
        remote_service_mode: remoteService.mode,
        remote_service_host_hash: remoteService.hostHash ?? null,
        vitest_command:
          "ORACLE_LIVE_TEST=1 ORACLE_LIVE_BROWSER=1 pnpm vitest run tests/live/chatgpt-smoke-live.test.ts",
        run_command:
          "oracle --engine browser --provider chatgpt --model gpt-5.5-pro --chatgpt-pro --extended-reasoning --remote-browser preferred --evidence redacted --prompt <redacted>",
        manual_test_doc:
          "docs/manual-tests.md#opt-in-live-browser-smoke-tests-chatgpt-pro-gemini-deep-think",
        reattach_command: `oracle session ${sessionId} --render`,
        evidence_verify_command: `oracle evidence verify ${sessionId} --json`,
      });

      if (remoteService.host && !remoteService.token) {
        log.record("blocked", {
          blocker: "remote_browser_token_missing",
          fix_command: "export ORACLE_REMOTE_TOKEN=<token>",
          next_command: "oracle remote doctor --json",
        });
        await log.writeJsonl(artifactPath);
        assertStructuredTestLogRecords(log.records());
        console.warn(`Skipping ChatGPT Pro live smoke; structured log: ${artifactPath}`);
        return;
      }

      if (!remoteChrome && !remoteService.host && !(await hasChatGptSession())) {
        log.record("blocked", {
          blocker: "provider_login_required",
          fix_command: "Open Chrome, sign in to chatgpt.com with Pro access, then rerun.",
        });
        await log.writeJsonl(artifactPath);
        assertStructuredTestLogRecords(log.records());
        console.warn(`Skipping ChatGPT Pro live smoke; structured log: ${artifactPath}`);
        return;
      }

      await acquireLiveTestLock(LOCK_LABEL);
      log.record("lease_acquired", {
        lease_id: `live-test-lock:${LOCK_LABEL}`,
        provider_slot: PROVIDER_SLOT,
      });

      try {
        const executeBrowser: BrowserExecutor = remoteService.host
          ? createRemoteBrowserExecutor({
              host: remoteService.host,
              token: remoteService.token,
            })
          : runBrowserMode;
        const startedAt = Date.now();
        const result = await executeBrowser({
          sessionId,
          prompt: `Reply with exactly ${CHECK_TOKEN} and no other words.`,
          heartbeatIntervalMs: 30_000,
          verbose: true,
          config: {
            desiredModel: "gpt-5.5-pro",
            thinkingTime: "extended",
            timeoutMs: 10 * 60_000,
            inputTimeoutMs: 60_000,
            assistantRecheckDelayMs: 30_000,
            assistantRecheckTimeoutMs: 120_000,
            autoReattachDelayMs: 30_000,
            autoReattachIntervalMs: 60_000,
            autoReattachTimeoutMs: 120_000,
            keepBrowser: false,
            remoteChrome,
          },
          log: (message) => {
            logs.push(message);
          },
        });
        const elapsedMs = Date.now() - startedAt;

        log.record("run_completed", {
          session_id: sessionId,
          provider_slot: PROVIDER_SLOT,
          elapsed_ms: elapsedMs,
          heartbeat_events: summarizeBrowserProgress(logs),
          conversation_id_present: Boolean(result.conversationId),
          chrome_port_present: Boolean(result.chromePort),
        });

        const evidence = await verifyTranscriptArtifact(result);
        log.record("evidence_verified", {
          session_id: sessionId,
          provider_slot: PROVIDER_SLOT,
          evidence_id: evidence.evidenceId,
          evidence_status: evidence.status,
          evidence_sha256: evidence.sha256,
          evidence_path: evidence.path,
        });

        expect(normalizeAnswer(result.answerText)).toContain(CHECK_TOKEN.toLowerCase());
        expect(evidence.status).toBe("verified");
        assertStructuredTestLogRecords(log.records());
      } catch (error) {
        log.record("failed", {
          session_id: sessionId,
          provider_slot: PROVIDER_SLOT,
          error_kind: error instanceof Error ? error.name : typeof error,
          error_message: error instanceof Error ? error.message : String(error),
          reattach_command: `oracle session ${sessionId} --render`,
          evidence_verify_command: `oracle evidence verify ${sessionId} --json`,
          likely_blockers: [
            "provider_login_required",
            "ui_drift_suspected",
            "lease_conflict",
            "output_capture_unverified",
            "legitimate_long_pro_wait",
          ],
        });
        throw error;
      } finally {
        await releaseLiveTestLock(LOCK_LABEL);
        log.record("lease_released", { lease_id: `live-test-lock:${LOCK_LABEL}` });
        await log.writeJsonl(artifactPath);
      }
    },
    12 * 60 * 1000,
  );
});

async function resolveRemoteServiceForLive(): Promise<
  ReturnType<typeof resolveRemoteServiceConfig>
> {
  const { config } = await loadUserConfig();
  return resolveRemoteServiceConfig({
    userConfig: config,
    env: process.env,
    allowMissingToken: true,
  });
}

async function hasChatGptSession(): Promise<boolean> {
  try {
    const { cookies } = await getCookies({
      url: "https://chatgpt.com",
      origins: ["https://chatgpt.com", "https://chat.openai.com", "https://atlas.openai.com"],
      browsers: ["chrome"],
      mode: "merge",
      chromeProfile: "Default",
      timeoutMs: 5_000,
    });
    return cookies.some((cookie) => cookie.name.startsWith("__Secure-next-auth.session-token"));
  } catch {
    return false;
  }
}

function parseRemoteChrome(): BrowserAutomationConfig["remoteChrome"] {
  const raw = process.env.ORACLE_LIVE_REMOTE_CHROME?.trim();
  if (!raw) return null;
  const withoutScheme = raw.replace(/^https?:\/\//u, "");
  const match = /^([^:]+):(\d{1,5})$/u.exec(withoutScheme);
  if (!match) {
    throw new Error("ORACLE_LIVE_REMOTE_CHROME must be host:port.");
  }
  const port = Number(match[2]);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error("ORACLE_LIVE_REMOTE_CHROME has an invalid port.");
  }
  return { host: match[1], port };
}

async function verifyTranscriptArtifact(result: BrowserRunResult): Promise<{
  evidenceId: string;
  status: "verified" | "unverified";
  path: string | null;
  sha256: `sha256:${string}` | null;
}> {
  const transcript = result.artifacts?.find((artifact) => artifact.kind === "transcript");
  if (!transcript?.path) {
    return { evidenceId: "transcript:missing", status: "unverified", path: null, sha256: null };
  }
  const fileStat = await stat(transcript.path);
  if (!fileStat.isFile() || fileStat.size <= 0) {
    return {
      evidenceId: `transcript:${path.basename(transcript.path)}`,
      status: "unverified",
      path: transcript.path,
      sha256: null,
    };
  }
  const bytes = await readFile(transcript.path);
  return {
    evidenceId: `transcript:${path.basename(transcript.path)}`,
    status: "verified",
    path: transcript.path,
    sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
  };
}

function summarizeBrowserProgress(lines: readonly string[]): Record<string, number> {
  return {
    total: lines.length,
    thinking: lines.filter((line) => /thinking|reasoning/i.test(line)).length,
    waiting: lines.filter((line) => /waiting/i.test(line)).length,
    response: lines.filter((line) => /response|answer/i.test(line)).length,
  };
}

function normalizeAnswer(value: string): string {
  return value.toLowerCase().replace(/\s+/gu, " ").trim();
}

function liveSmokeArtifactPath(provider: string, filename: string): string {
  const root =
    process.env.ORACLE_LIVE_ARTIFACT_DIR ??
    path.join(process.env.ORACLE_HOME_DIR ?? os.tmpdir(), "live-browser-smoke");
  return path.join(root, provider, filename);
}

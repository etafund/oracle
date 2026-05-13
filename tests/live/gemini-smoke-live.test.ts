import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { getCookies } from "@steipete/sweet-cookie";
import { describe, expect, test } from "vitest";

import type { BrowserAutomationConfig } from "../../src/browser/types.js";
import { createGeminiWebExecutor } from "../../src/gemini-web/executor.js";
import {
  assertStructuredTestLogRecords,
  createStructuredTestLog,
} from "../_helpers/structuredTestLog.js";
import { acquireLiveTestLock, releaseLiveTestLock } from "./liveLock.js";

const LIVE_BROWSER =
  process.env.ORACLE_LIVE_TEST === "1" && process.env.ORACLE_LIVE_BROWSER === "1";

const CHECK_TOKEN = "CHECK_GEMINI_DEEP_THINK_OK";
const PROVIDER_SLOT = "gemini_deep_think";
const LOCK_LABEL = "gemini-deep-think";

(LIVE_BROWSER ? describe : describe.skip)("Gemini Deep Think live browser smoke", () => {
  test(
    "returns the exact check token and writes verifiable sanitized smoke artifacts",
    async () => {
      const sessionId = `live-gemini-deep-think-${Date.now()}`;
      const log = createStructuredTestLog({
        testName: "live.gemini.deep_think.smoke",
        evidencePointer: `oracle session ${sessionId} --render`,
      });
      const remoteChrome = parseRemoteChrome();
      const logs: string[] = [];
      const artifactPath = liveSmokeArtifactPath("gemini", `${sessionId}.jsonl`);

      log.record("preflight", {
        provider_slot: PROVIDER_SLOT,
        session_id: sessionId,
        remote_browser: remoteChrome ? "required" : "preferred",
        vitest_command:
          "ORACLE_LIVE_TEST=1 ORACLE_LIVE_BROWSER=1 pnpm vitest run tests/live/gemini-smoke-live.test.ts",
        run_command:
          "oracle --engine browser --provider gemini --model gemini-3-pro-deep-think --gemini-deep-think --gemini-deep-think-fallback fail --remote-browser preferred --evidence redacted --prompt <redacted>",
        manual_test_doc: "docs/manual-tests.md#opt-in-live-browser-smoke-tests-chatgpt-pro-gemini-deep-think",
        reattach_command: `oracle session ${sessionId} --render`,
        evidence_verify_command: `oracle evidence ledger verify ${sessionId} --json`,
      });

      if (!remoteChrome && !(await hasGeminiSession())) {
        log.record("blocked", {
          blocker: "provider_login_required",
          fix_command: "Open Chrome, sign in to gemini.google.com, then rerun.",
        });
        await log.writeJsonl(artifactPath);
        assertStructuredTestLogRecords(log.records());
        console.warn(`Skipping Gemini Deep Think live smoke; structured log: ${artifactPath}`);
        return;
      }

      await acquireLiveTestLock(LOCK_LABEL);
      log.record("lease_acquired", {
        lease_id: `live-test-lock:${LOCK_LABEL}`,
        provider_slot: PROVIDER_SLOT,
      });

      try {
        const startedAt = Date.now();
        const exec = createGeminiWebExecutor({});
        const result = await exec({
          prompt: `Reply with exactly ${CHECK_TOKEN} and no other words.`,
          attachments: [],
          config: {
            desiredModel: "gemini-3-pro-deep-think",
            chromeProfile: "Default",
            timeoutMs: 5 * 60_000,
            inputTimeoutMs: 60_000,
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
          answer_chars: result.answerChars,
        });

        const evidence = await writeAndVerifySmokeEvidence("gemini", sessionId, {
          schema_version: "live_browser_smoke_evidence.v1",
          session_id: sessionId,
          provider_slot: PROVIDER_SLOT,
          elapsed_ms: elapsedMs,
          check_token_present: normalizeAnswer(result.answerText).includes(
            CHECK_TOKEN.toLowerCase(),
          ),
          artifact_kind: "sanitized-gemini-smoke-summary",
        });
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
          evidence_verify_command: `oracle evidence ledger verify ${sessionId} --json`,
          likely_blockers: [
            "provider_login_required",
            "gemini_deep_think_unverified",
            "lease_conflict",
            "output_capture_unverified",
            "legitimate_long_wait",
          ],
        });
        throw error;
      } finally {
        await releaseLiveTestLock(LOCK_LABEL);
        log.record("lease_released", { lease_id: `live-test-lock:${LOCK_LABEL}` });
        await log.writeJsonl(artifactPath);
      }
    },
    7 * 60 * 1000,
  );
});

async function hasGeminiSession(): Promise<boolean> {
  try {
    const { cookies } = await getCookies({
      url: "https://gemini.google.com",
      origins: [
        "https://gemini.google.com",
        "https://accounts.google.com",
        "https://www.google.com",
      ],
      names: ["__Secure-1PSID", "__Secure-1PSIDTS"],
      browsers: ["chrome"],
      mode: "merge",
      chromeProfile: "Default",
      timeoutMs: 5_000,
    });
    const names = new Set(cookies.map((cookie) => cookie.name));
    return names.has("__Secure-1PSID") && names.has("__Secure-1PSIDTS");
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

async function writeAndVerifySmokeEvidence(
  provider: string,
  sessionId: string,
  payload: Record<string, unknown>,
): Promise<{
  evidenceId: string;
  status: "verified" | "unverified";
  path: string;
  sha256: `sha256:${string}` | null;
}> {
  const evidencePath = liveSmokeArtifactPath(provider, `${sessionId}.evidence.json`);
  await mkdir(path.dirname(evidencePath), { recursive: true });
  await writeFile(evidencePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  const fileStat = await stat(evidencePath);
  if (!fileStat.isFile() || fileStat.size <= 0) {
    return {
      evidenceId: `smoke-summary:${path.basename(evidencePath)}`,
      status: "unverified",
      path: evidencePath,
      sha256: null,
    };
  }
  const bytes = await readFile(evidencePath);
  return {
    evidenceId: `smoke-summary:${path.basename(evidencePath)}`,
    status: "verified",
    path: evidencePath,
    sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
  };
}

function summarizeBrowserProgress(lines: readonly string[]): Record<string, number> {
  return {
    total: lines.length,
    thinking: lines.filter((line) => /thinking|deep think/i.test(line)).length,
    waiting: lines.filter((line) => /waiting/i.test(line)).length,
    response: lines.filter((line) => /response|answer|completed/i.test(line)).length,
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

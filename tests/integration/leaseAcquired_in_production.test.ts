import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { runBrowserSessionExecution } from "../../src/browser/sessionRunner.js";
import { readBrowserLease } from "../../src/browser/leases.js";
import type { BrowserRunResult } from "../../src/browser/types.js";
import { readEvidenceLedger } from "../../src/oracle/evidence_ledger.js";
import type { RunOracleOptions } from "../../src/oracle.js";
import type { BrowserSessionConfig } from "../../src/sessionStore.js";

let homeDir: string;

beforeEach(async () => {
  homeDir = await mkdtemp(path.join(os.tmpdir(), "oracle-u89-"));
});

afterEach(async () => {
  await rm(homeDir, { recursive: true, force: true });
});

describe("production browser session lease vertical slice", () => {
  test("acquires a browser_lease.v1 record, emits it to the ledger, and releases after success", async () => {
    const sessionId = "session-u89-success";
    const executeBrowser = vi.fn(async () => protectedBrowserResult());

    await runBrowserSessionExecution(
      {
        runOptions: runOptions(sessionId),
        browserConfig: browserConfig(),
        cwd: "/repo",
        log: vi.fn(),
      },
      {
        assemblePrompt: async () => promptArtifacts(),
        executeBrowser,
        v18EmitHomeDir: homeDir,
      },
    );

    expect(executeBrowser).toHaveBeenCalledOnce();
    const ledger = await readEvidenceLedger(sessionId, { homeDir });
    expect(ledger.chainValid).toBe(true);
    expect(ledger.entries.map((entry) => entry.event.metadata?.action).filter(Boolean)).toEqual([
      "browser_lease_acquired",
      "browser_lease_released",
    ]);

    const acquired = ledger.entries.find(
      (entry) => entry.event.metadata?.action === "browser_lease_acquired",
    );
    const released = ledger.entries.find(
      (entry) => entry.event.metadata?.action === "browser_lease_released",
    );
    expect(acquired?.event.metadata?.browser_lease).toMatchObject({
      schema_version: "browser_lease.v1",
      provider: "chatgpt",
      status: "acquired",
    });
    expect(released?.event.metadata?.browser_lease).toMatchObject({
      schema_version: "browser_lease.v1",
      provider: "chatgpt",
      status: "released",
    });

    const stored = await readBrowserLease("chatgpt", {
      leaseDir: path.join(homeDir, "browser-leases"),
    });
    expect(stored.state).toBe("released");
    if (stored.state === "released") {
      expect(stored.record.schema_version).toBe("browser_lease.v1");
      expect(stored.record.provider).toBe("chatgpt");
      expect(stored.record.released_at).toEqual(expect.any(String));
    }
  });

  test("releases and records the browser lease when provider execution fails", async () => {
    const sessionId = "session-u89-failure";
    const executeBrowser = vi.fn(async () => {
      throw new Error("fake provider failed");
    });

    await expect(
      runBrowserSessionExecution(
        {
          runOptions: runOptions(sessionId),
          browserConfig: browserConfig(),
          cwd: "/repo",
          log: vi.fn(),
        },
        {
          assemblePrompt: async () => promptArtifacts(),
          executeBrowser,
          v18EmitHomeDir: homeDir,
        },
      ),
    ).rejects.toThrow("fake provider failed");

    const ledger = await readEvidenceLedger(sessionId, { homeDir });
    expect(ledger.chainValid).toBe(true);
    expect(ledger.entries.map((entry) => entry.event.metadata?.action).filter(Boolean)).toEqual([
      "browser_lease_acquired",
      "browser_lease_released",
    ]);

    const stored = await readBrowserLease("chatgpt", {
      leaseDir: path.join(homeDir, "browser-leases"),
    });
    expect(stored.state).toBe("released");
  });
});

function runOptions(sessionId: string): RunOracleOptions {
  return {
    prompt: "Lease the production browser slot.",
    model: "gpt-5.2-pro",
    file: [],
    sessionId,
    silent: true,
  };
}

function browserConfig(): BrowserSessionConfig {
  return {
    chatgptUrl: "https://chatgpt.com/c/lease-production",
  } as BrowserSessionConfig;
}

function promptArtifacts() {
  return {
    markdown: "Lease the production browser slot.",
    composerText: "Lease the production browser slot.",
    estimatedInputTokens: 7,
    attachments: [],
    inlineFileCount: 0,
    tokenEstimateIncludesInlineFiles: false,
    attachmentsPolicy: "auto" as const,
    attachmentMode: "inline" as const,
    fallback: null,
  };
}

function protectedBrowserResult(): BrowserRunResult {
  return {
    answerText: "leased ok",
    answerMarkdown: "leased ok",
    artifacts: [{ kind: "transcript", path: "/tmp/transcript.md" }],
    tookMs: 10,
    answerTokens: 2,
    answerChars: 9,
    tabUrl: "https://chatgpt.com/c/lease-production",
    v18Capture: {
      promptText: "Lease the production browser slot.",
      answerText: "leased ok",
      observedEffortLabels: ["Standard", "Heavy", "Pro Extended"],
      observedTurnIndex: 2,
      baselineTurns: 1,
      modeVerified: true,
      verifiedBeforePromptSubmit: true,
      captureConfidence: "high",
    },
  } as BrowserRunResult;
}

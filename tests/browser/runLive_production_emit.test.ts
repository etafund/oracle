import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { runBrowserSessionExecution } from "../../src/browser/sessionRunner.js";
import type { BrowserRunResult } from "../../src/browser/types.js";
import { readEvidenceLedger } from "../../src/oracle/evidence_ledger.js";
import {
  evidenceFilePath,
  evidenceIndexPath,
  readArtifactIndex,
} from "../../src/oracle/v18/evidence.js";
import type { RunOracleOptions } from "../../src/oracle.js";
import type { BrowserSessionConfig } from "../../src/sessionStore.js";

const testNonWindows = process.platform === "win32" ? test.skip : test;

const SESSION_ID = "session-4xw-production";
const PROMPT = "Audit the production browser executor for v18 emission.";
const ANSWER = "The protected browser path emitted safe v18 artifacts.";

let homeDir: string;

beforeEach(async () => {
  homeDir = await mkdtemp(path.join(os.tmpdir(), "oracle-4xw-"));
});

afterEach(async () => {
  await rm(homeDir, { recursive: true, force: true });
});

function runOptions(overrides: Partial<RunOracleOptions> = {}): RunOracleOptions {
  return {
    prompt: PROMPT,
    model: "gpt-5.2-pro",
    file: [],
    sessionId: SESSION_ID,
    silent: true,
    ...overrides,
  };
}

function browserConfig(overrides: Partial<BrowserSessionConfig> = {}): BrowserSessionConfig {
  return {
    chatgptUrl: "https://chatgpt.com/c/production-emit",
    ...overrides,
  } as BrowserSessionConfig;
}

function promptArtifacts(text = PROMPT) {
  return {
    markdown: text,
    composerText: text,
    estimatedInputTokens: 17,
    attachments: [],
    inlineFileCount: 0,
    tokenEstimateIncludesInlineFiles: false,
    attachmentsPolicy: "auto" as const,
    attachmentMode: "inline" as const,
    fallback: null,
  };
}

function protectedBrowserResult(withCapture: boolean): BrowserRunResult {
  return {
    answerText: ANSWER,
    answerMarkdown: ANSWER,
    artifacts: [{ kind: "transcript", path: "/tmp/transcript.md" }],
    tookMs: 250,
    answerTokens: 9,
    answerChars: ANSWER.length,
    tabUrl: "https://chatgpt.com/c/production-emit",
    ...(withCapture
      ? {
          v18Capture: {
            promptText: PROMPT,
            answerText: ANSWER,
            observedEffortLabels: ["Standard", "Heavy", "Pro Extended"],
            observedTurnIndex: 5,
            baselineTurns: 4,
            modeVerified: true,
            verifiedBeforePromptSubmit: true,
            captureConfidence: "high",
          },
        }
      : {}),
  } as BrowserRunResult;
}

describe("production browser runner v18 emission", () => {
  testNonWindows(
    "wires protected ChatGPT runs through evidence/provider_result/ledger emission",
    async () => {
      const executeBrowser = vi.fn(async () => protectedBrowserResult(true));

      const result = await runBrowserSessionExecution(
        {
          runOptions: runOptions(),
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

      expect(executeBrowser).toHaveBeenCalledTimes(1);
      expect(result.v18Emit?.attempted).toBe(true);
      expect(result.v18Emit?.emitError).toBeNull();
      expect(result.v18Emit?.artifacts?.synthesisEligible).toBe(true);
      expect(result.v18Emit?.artifacts?.blockedErrorCodes).toEqual([]);

      const evidenceId = `evidence-${SESSION_ID}-chatgpt_pro_first_plan`;
      const rawEvidence = await readFile(evidenceFilePath(SESSION_ID, evidenceId, homeDir), "utf8");
      expect(rawEvidence).not.toContain(PROMPT);
      expect(rawEvidence).not.toContain(ANSWER);

      const evidence = JSON.parse(rawEvidence) as Record<string, unknown>;
      expect(evidence.schema_version).toBe("browser_evidence.v1");
      expect(evidence.evidence_id).toBe(evidenceId);
      expect(evidence.mode_verified).toBe(true);
      expect(evidence.verified_before_prompt_submit).toBe(true);

      const index = await readArtifactIndex(evidenceIndexPath(SESSION_ID, homeDir));
      expect(index?.artifacts.some((entry) => entry.artifact_id === evidenceId)).toBe(true);

      const ledger = await readEvidenceLedger(SESSION_ID, { homeDir });
      expect(ledger.chainValid).toBe(true);
      expect(ledger.entries.map((entry) => entry.event.type)).toEqual([
        "evidence_written",
        "run_completed",
      ]);

      const providerResult = result.v18Emit!.artifacts!.providerResult.result;
      expect(providerResult.schema_version).toBe("provider_result.v1");
      expect(providerResult.evidence_id).toBe(evidenceId);
      expect(providerResult.synthesis_eligible).toBe(true);
    },
  );

  testNonWindows(
    "missing live capture observations stay blocked instead of claiming verification",
    async () => {
      const result = await runBrowserSessionExecution(
        {
          runOptions: runOptions({ sessionId: `${SESSION_ID}-uncaptured` }),
          browserConfig: browserConfig(),
          cwd: "/repo",
          log: vi.fn(),
        },
        {
          assemblePrompt: async () => promptArtifacts(),
          executeBrowser: async () => protectedBrowserResult(false),
          v18EmitHomeDir: homeDir,
        },
      );

      expect(result.v18Emit?.attempted).toBe(true);
      expect(result.v18Emit?.emitError).toBeNull();
      expect(result.v18Emit?.artifacts?.synthesisEligible).toBe(false);
      expect(result.v18Emit?.artifacts?.blockedErrorCodes).toEqual(
        expect.arrayContaining([
          "chatgpt_pro_unverified",
          "chatgpt_extended_reasoning_unverified",
          "prompt_submitted_before_verification",
        ]),
      );

      const sessionId = `${SESSION_ID}-uncaptured`;
      const evidenceId = `evidence-${sessionId}-chatgpt_pro_first_plan`;
      const evidence = JSON.parse(
        await readFile(evidenceFilePath(sessionId, evidenceId, homeDir), "utf8"),
      ) as Record<string, unknown>;
      expect(evidence.mode_verified).toBe(false);
      expect(evidence.verified_before_prompt_submit).toBe(false);
      expect(evidence.capture_confidence).toBe("low");

      const ledger = await readEvidenceLedger(sessionId, { homeDir });
      expect(ledger.chainValid).toBe(true);
      expect(ledger.entries.map((entry) => entry.event.type)).toEqual([
        "evidence_written",
        "run_failed",
      ]);
    },
  );
});

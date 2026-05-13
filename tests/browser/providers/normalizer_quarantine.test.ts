// Regression tests for
// oracle-v18-evidence-schema-parse-no-raw-quarantine-y00.
//
// When the chatgpt / gemini result normalizers throw on an unexpected
// DOM shape, the raw capture must land in
// `<homeDir>/sessions/<sessionId>/evidence/quarantine/raw_capture/`
// before the error propagates — otherwise post-mortem auditors can
// never see what the browser actually returned.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  ChatGptNormalizerParseError,
  normalizeChatGptRun,
  type NormalizeChatGptRunInput,
} from "../../../src/browser/providers/chatgptResultNormalizer.js";
import {
  GeminiNormalizerParseError,
  normalizeGeminiRun,
  type NormalizeGeminiRunInput,
} from "../../../src/browser/providers/geminiResultNormalizer.js";
import { verifyGeminiDeepThinkCandidate } from "../../../src/browser/providers/geminiDeepThink_verification.js";
import { browserEvidenceSchema, type BrowserEvidence } from "../../../src/oracle/v18/contracts.js";
import { captured } from "../../../src/browser/output-capture/index.js";
import type { CaptureVerdict } from "../../../src/browser/output-capture/captureVerdict.js";
import type { EffortStrategyResult } from "../../../src/browser/selectors/chatgpt/effortStrategy.js";
import type { GeminiStreamCaptureSummary } from "../../../src/gemini-web/streamSafeguards.js";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const PLAN_BUNDLE = path.resolve(moduleDir, "../../../PLAN/oracle-vnext-plan-bundle-v18.0.0");

async function loadEvidence(rel: string): Promise<BrowserEvidence> {
  return browserEvidenceSchema.parse(
    JSON.parse(await readFile(path.join(PLAN_BUNDLE, rel), "utf8")),
  ) as BrowserEvidence;
}

function makeTempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "oracle-quarantine-test-"));
}

function cleanupTempHome(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

function capturedVerdict(outputSha: `sha256:${string}`): CaptureVerdict {
  return captured({
    outputTextSha256: outputSha,
    outputBytes: 4096,
    captureConfidence: "high",
    turnId: "turn-quarantine",
    messageId: "msg-quarantine",
    markdownPreserved: true,
  });
}

function effortVerified(): EffortStrategyResult {
  return {
    status: "verified",
    selected: "Heavy",
    tier: "heavy",
    rank: 60,
    selectedIsHighestVisible: true,
    availableEffortLabelsHash: `sha256:${"a".repeat(64)}`,
    selectorManifestVersion: "chatgpt-selectors.v1",
    errorCode: null,
    reason: "verified",
    observedLabels: ["Heavy", "Pro Extended"],
  };
}

function geminiCapture(outputSha: `sha256:${string}`): GeminiStreamCaptureSummary {
  return {
    capture_method: "stream_generate_latest_non_empty_candidate",
    confidence: "high",
    result_text_sha256: outputSha,
    output_bytes: 4096,
    current_prompt_sha256: null,
    current_session_id: "gemini-session",
    observed_response_candidate_id: "rcid-gemini",
    expected_response_candidate_id: "rcid-gemini",
    chunk_count: 3,
    non_empty_candidate_count: 1,
  };
}

function quarantineDir(home: string, sessionId: string): string {
  return path.join(home, "sessions", sessionId, "evidence", "quarantine", "raw_capture");
}

function listQuarantineFiles(home: string, sessionId: string): string[] {
  const dir = quarantineDir(home, sessionId);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir);
}

describe("chatgpt normalizer raw-capture quarantine", () => {
  let home: string;
  beforeEach(() => {
    home = makeTempHome();
  });
  afterEach(() => {
    cleanupTempHome(home);
  });

  test("malformed input lands in raw_capture quarantine and re-throws", async () => {
    const evidence = await loadEvidence("fixtures/chatgpt-pro-evidence.json");
    const sessionId = "test-session-chatgpt";

    // Bad input: promptManifestSha256 is not a sha256 — providerResultSchema
    // will reject it inside buildChatGptProviderResult.
    const input = {
      slot: "chatgpt_pro_first_plan",
      providerResultId: "provider-result-quarantine",
      accessPath: "oracle_browser_remote",
      evidence,
      capture: capturedVerdict(evidence.output_text_sha256 as `sha256:${string}`),
      effort: effortVerified(),
      promptManifestSha256: "not-a-real-hash",
      sourceBaselineSha256: `sha256:${"d".repeat(64)}`,
      sessionId,
      homeDir: home,
    } as unknown as NormalizeChatGptRunInput;

    expect(() => normalizeChatGptRun(input)).toThrow(ChatGptNormalizerParseError);

    const files = listQuarantineFiles(home, sessionId);
    expect(files.length).toBe(1);

    const envelope = JSON.parse(
      fs.readFileSync(path.join(quarantineDir(home, sessionId), files[0]), "utf8"),
    );
    expect(envelope.schema_version).toBe("browser_evidence_raw_capture_quarantine.v1");
    expect(envelope.source).toBe("chatgpt-normalizer");
    expect(envelope.session_id).toBe(sessionId);
    expect(envelope.evidence_id).toBe(evidence.evidence_id);
    expect(envelope.failure.name).toBeTruthy();
    expect(envelope.failure.zod_issues).toBeTruthy();
    // The raw input bundle must be preserved verbatim so post-mortem
    // auditors can see exactly what the normalizer was handed.
    expect(envelope.raw_input.providerResultId).toBe("provider-result-quarantine");
    expect(envelope.raw_input.evidence.evidence_id).toBe(evidence.evidence_id);
    expect(envelope.raw_input.promptManifestSha256).toBe("not-a-real-hash");
  });

  test("thrown error exposes the quarantine file path", async () => {
    const evidence = await loadEvidence("fixtures/chatgpt-pro-evidence.json");
    const sessionId = "test-session-chatgpt-path";

    const input = {
      slot: "chatgpt_pro_first_plan",
      providerResultId: "provider-result-quarantine-path",
      accessPath: "oracle_browser_remote",
      evidence,
      capture: capturedVerdict(evidence.output_text_sha256 as `sha256:${string}`),
      effort: effortVerified(),
      promptManifestSha256: "bogus",
      sourceBaselineSha256: `sha256:${"d".repeat(64)}`,
      sessionId,
      homeDir: home,
    } as unknown as NormalizeChatGptRunInput;

    try {
      normalizeChatGptRun(input);
      throw new Error("expected normalizer to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ChatGptNormalizerParseError);
      const parseErr = err as ChatGptNormalizerParseError;
      expect(parseErr.quarantinePath).toBeTruthy();
      expect(fs.existsSync(parseErr.quarantinePath!)).toBe(true);
      expect(parseErr.cause).toBeDefined();
    }
  });

  test("no sessionId — error still propagates, no file written", async () => {
    const evidence = await loadEvidence("fixtures/chatgpt-pro-evidence.json");
    const input = {
      slot: "chatgpt_pro_first_plan",
      providerResultId: "provider-result-no-session",
      accessPath: "oracle_browser_remote",
      evidence,
      capture: capturedVerdict(evidence.output_text_sha256 as `sha256:${string}`),
      effort: effortVerified(),
      promptManifestSha256: "bad",
      sourceBaselineSha256: `sha256:${"d".repeat(64)}`,
      homeDir: home,
    } as unknown as NormalizeChatGptRunInput;

    expect(() => normalizeChatGptRun(input)).toThrow(ChatGptNormalizerParseError);
    // Without sessionId, no path can be derived, so nothing is written.
    expect(fs.existsSync(path.join(home, "sessions"))).toBe(false);
  });
});

describe("gemini normalizer raw-capture quarantine", () => {
  let home: string;
  beforeEach(() => {
    home = makeTempHome();
  });
  afterEach(() => {
    cleanupTempHome(home);
  });

  test("malformed input lands in raw_capture quarantine and re-throws", async () => {
    const evidence = await loadEvidence("fixtures/gemini-deep-think-evidence.json");
    const sessionId = "test-session-gemini";

    const input = {
      slot: "gemini_deep_think",
      providerResultId: "provider-result-gemini-quarantine",
      accessPath: "oracle_browser_remote",
      evidence,
      capture: geminiCapture(evidence.output_text_sha256 as `sha256:${string}`),
      deepThink: verifyGeminiDeepThinkCandidate({
        deepThinkLabel: "Deep Think",
        observedThinkingLevelLabels: ["standard", "high"],
        selectedThinkingLevel: "high",
        thinkingLevelControlExposed: true,
      }),
      promptManifestSha256: "not-a-real-hash",
      sourceBaselineSha256: `sha256:${"d".repeat(64)}`,
      sessionId,
      homeDir: home,
    } as unknown as NormalizeGeminiRunInput;

    expect(() => normalizeGeminiRun(input)).toThrow(GeminiNormalizerParseError);

    const files = listQuarantineFiles(home, sessionId);
    expect(files.length).toBe(1);

    const envelope = JSON.parse(
      fs.readFileSync(path.join(quarantineDir(home, sessionId), files[0]), "utf8"),
    );
    expect(envelope.schema_version).toBe("browser_evidence_raw_capture_quarantine.v1");
    expect(envelope.source).toBe("gemini-normalizer");
    expect(envelope.session_id).toBe(sessionId);
    expect(envelope.evidence_id).toBe(evidence.evidence_id);
    expect(envelope.failure.zod_issues).toBeTruthy();
    expect(envelope.raw_input.providerResultId).toBe("provider-result-gemini-quarantine");
    expect(envelope.raw_input.evidence.evidence_id).toBe(evidence.evidence_id);
  });

  test("thrown error exposes the quarantine file path", async () => {
    const evidence = await loadEvidence("fixtures/gemini-deep-think-evidence.json");
    const sessionId = "test-session-gemini-path";

    const input = {
      slot: "gemini_deep_think",
      providerResultId: "provider-result-gemini-path",
      accessPath: "oracle_browser_remote",
      evidence,
      capture: geminiCapture(evidence.output_text_sha256 as `sha256:${string}`),
      deepThink: verifyGeminiDeepThinkCandidate({
        deepThinkLabel: "Deep Think",
        observedThinkingLevelLabels: ["standard", "high"],
        selectedThinkingLevel: "high",
        thinkingLevelControlExposed: true,
      }),
      promptManifestSha256: "bogus",
      sourceBaselineSha256: `sha256:${"d".repeat(64)}`,
      sessionId,
      homeDir: home,
    } as unknown as NormalizeGeminiRunInput;

    try {
      normalizeGeminiRun(input);
      throw new Error("expected normalizer to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(GeminiNormalizerParseError);
      const parseErr = err as GeminiNormalizerParseError;
      expect(parseErr.quarantinePath).toBeTruthy();
      expect(fs.existsSync(parseErr.quarantinePath!)).toBe(true);
      expect(parseErr.cause).toBeDefined();
    }
  });
});

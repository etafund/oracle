import { describe, expect, it } from "vitest";
import {
  GeminiStreamCaptureError,
  assertGeminiStreamNonEmpty,
  buildGeminiStreamCaptureSummary,
  geminiStreamTimeoutFailure,
  stripAnsiEscapes,
} from "../../src/gemini-web/streamSafeguards.js";

const PROMPT_HASH = `sha256:${"a".repeat(64)}` as const;

describe("gemini stream safeguards", () => {
  it("records capture provenance for non-empty text", () => {
    const summary = buildGeminiStreamCaptureSummary({
      text: "answer",
      chunkCount: 3,
      nonEmptyCandidateCount: 1,
      currentPromptSha256: PROMPT_HASH,
      currentSessionId: "session-1",
      observedResponseCandidateId: "rcid-1",
      expectedResponseCandidateId: "rcid-1",
    });

    expect(summary).toMatchObject({
      capture_method: "stream_generate_latest_non_empty_candidate",
      confidence: "high",
      output_bytes: 6,
      current_prompt_sha256: PROMPT_HASH,
      current_session_id: "session-1",
      observed_response_candidate_id: "rcid-1",
      expected_response_candidate_id: "rcid-1",
      chunk_count: 3,
      non_empty_candidate_count: 1,
    });
    expect(summary.result_text_sha256).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("throws a typed retry-safe error for empty terminal captures", () => {
    const summary = buildGeminiStreamCaptureSummary({
      text: "",
      chunkCount: 2,
      nonEmptyCandidateCount: 0,
      currentPromptSha256: PROMPT_HASH,
      currentSessionId: "session-2",
    });

    expect(() => assertGeminiStreamNonEmpty(summary)).toThrow(GeminiStreamCaptureError);
    try {
      assertGeminiStreamNonEmpty(summary);
    } catch (error) {
      expect(error).toBeInstanceOf(GeminiStreamCaptureError);
      expect((error as GeminiStreamCaptureError).code).toBe("output_capture_empty");
      expect((error as GeminiStreamCaptureError).details.chunk_count).toBe(2);
      expect((error as GeminiStreamCaptureError).details.current_session_id).toBe("session-2");
    }
  });

  it("models timeouts as recoverable output_capture_unverified failures", () => {
    const error = geminiStreamTimeoutFailure({
      elapsedMs: 60_000,
      timeoutMs: 60_000,
      currentPromptSha256: PROMPT_HASH,
      currentSessionId: "session-timeout",
      expectedResponseCandidateId: "rcid-timeout",
    });

    expect(error).toBeInstanceOf(GeminiStreamCaptureError);
    expect(error.code).toBe("output_capture_unverified");
    expect(error.retry_safe).toBe(true);
    expect(error.message).toMatch(/timed out/);
    expect(error.details.expected_response_candidate_id).toBe("rcid-timeout");
  });

  it("strips common ANSI control sequences without changing markdown bytes", () => {
    const value = "\u001b[32m- item\u001b[0m\n```js\nconsole.log(1)\n```";
    expect(stripAnsiEscapes(value)).toBe("- item\n```js\nconsole.log(1)\n```");
  });
});

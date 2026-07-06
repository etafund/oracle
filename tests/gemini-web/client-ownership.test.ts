import { afterEach, describe, expect, it, vi } from "vitest";
import { runGeminiWebOnce } from "../../src/gemini-web/client.js";
import {
  GeminiStreamCaptureError,
  sha256OfGeminiText,
} from "../../src/gemini-web/streamSafeguards.js";

function makeRawResponseWithBody(body: unknown): string {
  const responseJson = [[null, null, JSON.stringify(body)]];
  return `)]}'\n\n${JSON.stringify(responseJson)}`;
}

function makeBodyWithText(rcid: string, text: string): unknown[] {
  const candidate: unknown[] = [];
  candidate[0] = rcid;
  candidate[1] = [text];

  const body: unknown[] = [];
  body[1] = ["cid", "rid", rcid];
  body[4] = [candidate];
  return body;
}

function mockGeminiFetch(rcid: string, text: string): void {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    if (url === "https://gemini.google.com/app") {
      return new Response('<html>"SNlM0e":"test-access-token"</html>', { status: 200 });
    }
    if (url.includes("/StreamGenerate")) {
      return new Response(makeRawResponseWithBody(makeBodyWithText(rcid, text)), {
        status: 200,
      });
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  });
}

// Regression coverage for the stream-ownership/cross-talk guard being
// unreachable from the production HTTP path: client.ts used to shadow
// parse.ts's parseGeminiStreamGenerateResponse with a wrapper whose signature
// dropped GeminiStreamParseOptions, so assertGeminiStreamOwnership was a
// permanent no-op for real runGeminiWebOnce calls.
describe("gemini-web runGeminiWebOnce stream-ownership guard", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("throws a retry-safe capture error when the response carries a different candidate id", async () => {
    mockGeminiFetch("rcid-other-conversation", "someone else's answer");

    const run = runGeminiWebOnce({
      prompt: "current prompt",
      model: "gemini-3.5-flash",
      cookieMap: { sid: "cookie" },
      expectedResponseCandidateId: "rcid-current",
      sessionId: "session-guard-1",
    });

    await expect(run).rejects.toThrow(GeminiStreamCaptureError);
    try {
      mockGeminiFetch("rcid-other-conversation", "someone else's answer");
      await runGeminiWebOnce({
        prompt: "current prompt",
        model: "gemini-3.5-flash",
        cookieMap: { sid: "cookie" },
        expectedResponseCandidateId: "rcid-current",
        sessionId: "session-guard-1",
      });
      expect.unreachable("expected a GeminiStreamCaptureError");
    } catch (error) {
      const captureError = error as GeminiStreamCaptureError;
      expect(captureError).toBeInstanceOf(GeminiStreamCaptureError);
      expect(captureError.code).toBe("output_capture_unverified");
      expect(captureError.retry_safe).toBe(true);
      expect(captureError.details.current_session_id).toBe("session-guard-1");
      expect(captureError.details.current_prompt_sha256).toBe(
        sha256OfGeminiText("current prompt"),
      );
      expect(captureError.details.expected_response_candidate_id).toBe("rcid-current");
      expect(captureError.details.observed_response_candidate_id).toBe(
        "rcid-other-conversation",
      );
    }
  });

  it("throws when a continuation response echoes the previous turn's candidate id (stale capture)", async () => {
    mockGeminiFetch("rcid-turn-1", "stale echo of turn 1");

    const run = runGeminiWebOnce({
      prompt: "turn 2 prompt",
      model: "gemini-3.5-flash",
      cookieMap: { sid: "cookie" },
      previousResponseCandidateId: "rcid-turn-1",
      sessionId: "session-guard-2",
    });

    await expect(run).rejects.toMatchObject({
      name: "GeminiStreamCaptureError",
      code: "output_capture_unverified",
      retry_safe: true,
    });
  });

  it("returns the observed candidate id so callers can bind the next turn's guard", async () => {
    mockGeminiFetch("rcid-turn-1", "turn 1 answer");

    const result = await runGeminiWebOnce({
      prompt: "turn 1 prompt",
      model: "gemini-3.5-flash",
      cookieMap: { sid: "cookie" },
      sessionId: "session-guard-3",
    });

    expect(result.text).toBe("turn 1 answer");
    expect(result.responseCandidateId).toBe("rcid-turn-1");
  });

  it("accepts a fresh candidate id on continuation turns", async () => {
    mockGeminiFetch("rcid-turn-2", "turn 2 answer");

    const result = await runGeminiWebOnce({
      prompt: "turn 2 prompt",
      model: "gemini-3.5-flash",
      cookieMap: { sid: "cookie" },
      previousResponseCandidateId: "rcid-turn-1",
      sessionId: "session-guard-4",
    });

    expect(result.text).toBe("turn 2 answer");
    expect(result.responseCandidateId).toBe("rcid-turn-2");
  });
});

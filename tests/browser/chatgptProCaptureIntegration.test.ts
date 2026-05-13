// Integration: chatgptProVerification.buildChatGptCaptureVerdict
// composes the output-capture helpers into a single verdict the FSM
// caller can feed into its `response_arrived` event without
// reconstructing the captureVerdict by hand.

import { describe, expect, test } from "vitest";

import { buildChatGptCaptureVerdict } from "../../src/browser/providers/chatgptProVerification.js";
import { sha256OfText } from "../../src/browser/output-capture/index.js";

const RICH_TEXT = `# Plan

- alpha
- bravo

\`\`\`ts
const x = 1;
\`\`\`

See [link](https://example.invalid/x).
`;

describe("buildChatGptCaptureVerdict — happy path", () => {
  test("captured verdict with sha256 + markdown preservation + confidence", () => {
    const v = buildChatGptCaptureVerdict({
      text: RICH_TEXT,
      turnId: "turn-5",
      messageId: "msg-5",
    });
    expect(v.status).toBe("captured");
    expect(v.outputTextSha256).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(v.outputBytes).toBeGreaterThan(0);
    expect(v.turnId).toBe("turn-5");
    expect(v.messageId).toBe("msg-5");
    expect(v.markdownPreserved).toBe(true);
    expect(v.captureConfidence).toBe("high");
  });

  test("captureConfidence drops to medium when markdown didn't survive", () => {
    const v = buildChatGptCaptureVerdict({ text: "plain text, no structure" });
    expect(v.status).toBe("captured");
    expect(v.markdownPreserved).toBe(false);
    expect(v.captureConfidence).toBe("medium");
  });

  test("caller-supplied confidence hint wins over the heuristic", () => {
    const v = buildChatGptCaptureVerdict({
      text: "plain",
      confidenceHint: "low",
    });
    expect(v.captureConfidence).toBe("low");
  });
});

describe("buildChatGptCaptureVerdict — empty + stale paths", () => {
  test("empty text → output_capture_empty", () => {
    const v = buildChatGptCaptureVerdict({ text: "" });
    expect(v.status).toBe("empty");
    expect(v.errorCode).toBe("output_capture_empty");
  });

  test("stale turn binding short-circuits to stale_turn", () => {
    const v = buildChatGptCaptureVerdict({
      text: RICH_TEXT,
      turnBinding: { baselineTurns: 10, observedTurnIndex: 3, turnId: "old-turn" },
    });
    expect(v.status).toBe("stale_turn");
    expect(v.errorCode).toBe("output_capture_unverified");
    expect(v.turnId).toBe("old-turn");
  });

  test("prompt sha256 mismatch in turn binding → stale_turn", () => {
    const expected = sha256OfText("prompt-A");
    const observed = sha256OfText("prompt-B");
    const v = buildChatGptCaptureVerdict({
      text: RICH_TEXT,
      turnBinding: {
        baselineTurns: 0,
        observedTurnIndex: 0,
        expectedPromptSha256: expected,
        observedPromptSha256: observed,
      },
    });
    expect(v.status).toBe("stale_turn");
  });

  test("matching turn binding allows the captured verdict through", () => {
    const v = buildChatGptCaptureVerdict({
      text: RICH_TEXT,
      turnBinding: { baselineTurns: 3, observedTurnIndex: 4, turnId: "fresh-turn" },
    });
    expect(v.status).toBe("captured");
    expect(v.outputTextSha256).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

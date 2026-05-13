// Unit tests for the captureVerdict builders (oracle-qfl).

import { describe, expect, test } from "vitest";

import {
  backgroundPending,
  captured,
  emptyOutput,
  isCapturedOk,
  isWaiting,
  needsReattach,
  partial,
  staleTurn,
} from "../../../src/browser/output-capture/index.js";

const SHA = `sha256:${"a".repeat(64)}` as const;

describe("captured()", () => {
  test("returns status=captured with all the recorded provenance", () => {
    const v = captured({
      outputTextSha256: SHA,
      outputBytes: 100,
      captureConfidence: "high",
      turnId: "turn-1",
      messageId: "msg-1",
      markdownPreserved: true,
    });
    expect(v.status).toBe("captured");
    expect(v.outputTextSha256).toBe(SHA);
    expect(v.outputBytes).toBe(100);
    expect(v.captureConfidence).toBe("high");
    expect(v.turnId).toBe("turn-1");
    expect(v.messageId).toBe("msg-1");
    expect(v.markdownPreserved).toBe(true);
    expect(v.errorCode).toBeNull();
    expect(v.recoveryCommand).toBeNull();
    expect(isCapturedOk(v)).toBe(true);
    expect(isWaiting(v)).toBe(false);
  });
});

describe("emptyOutput()", () => {
  test("maps to output_capture_empty v18 error code", () => {
    const v = emptyOutput();
    expect(v.status).toBe("empty");
    expect(v.errorCode).toBe("output_capture_empty");
    expect(v.outputBytes).toBe(0);
    expect(isCapturedOk(v)).toBe(false);
    expect(isWaiting(v)).toBe(false);
  });

  test("custom reason flows through", () => {
    const v = emptyOutput("custom emptiness");
    expect(v.reason).toBe("custom emptiness");
  });
});

describe("staleTurn()", () => {
  test("maps to output_capture_unverified", () => {
    const v = staleTurn({ expectedTurnIndex: 5, observedTurnIndex: 3, turnId: "turn-old" });
    expect(v.status).toBe("stale_turn");
    expect(v.errorCode).toBe("output_capture_unverified");
    expect(v.captureConfidence).toBe("low");
    expect(v.turnId).toBe("turn-old");
    expect(v.reason).toMatch(/turn 3.+expected 5/);
  });
});

describe("backgroundPending()", () => {
  test("status is background_pending with no error code", () => {
    const v = backgroundPending({ detail: "Pro thinking active", turnId: "turn-12" });
    expect(v.status).toBe("background_pending");
    expect(v.errorCode).toBeNull();
    expect(v.reason).toBe("Pro thinking active");
    expect(v.turnId).toBe("turn-12");
    expect(isWaiting(v)).toBe(true);
    expect(isCapturedOk(v)).toBe(false);
  });
});

describe("needsReattach()", () => {
  test("emits a recovery command that names the session", () => {
    const v = needsReattach({ sessionId: "session-abc", reason: "10m budget elapsed" });
    expect(v.status).toBe("needs_reattach");
    expect(v.recoveryCommand).toBe("oracle session session-abc --render");
    expect(v.errorCode).toBe("output_capture_unverified");
    expect(isWaiting(v)).toBe(true);
  });

  test("never recommends duplicating the run", () => {
    const v = needsReattach({ sessionId: "session-abc", reason: "budget elapsed" });
    expect(v.recoveryCommand).not.toMatch(/duplicate|rerun|retry --force/i);
    expect(v.recoveryCommand).toMatch(/^oracle session/);
  });
});

describe("partial()", () => {
  test("status is partial; isWaiting() is true", () => {
    const v = partial({
      outputTextSha256: SHA,
      outputBytes: 42,
      captureConfidence: "medium",
      turnId: null,
      messageId: null,
      markdownPreserved: false,
    });
    expect(v.status).toBe("partial");
    expect(isWaiting(v)).toBe(true);
    expect(isCapturedOk(v)).toBe(false);
  });
});

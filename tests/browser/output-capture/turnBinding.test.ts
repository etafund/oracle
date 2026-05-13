// Unit tests for the turn-binding check (oracle-qfl).

import { describe, expect, test } from "vitest";

import { sha256OfText, verifyTurnBinding } from "../../../src/browser/output-capture/index.js";

describe("verifyTurnBinding", () => {
  test("binds when observed turn matches the baseline", () => {
    const result = verifyTurnBinding({ baselineTurns: 3, observedTurnIndex: 3 });
    expect(result.bound).toBe(true);
    expect(result.staleVerdict).toBeNull();
  });

  test("binds when observed turn is past the baseline (multiple new turns)", () => {
    const result = verifyTurnBinding({ baselineTurns: 3, observedTurnIndex: 5 });
    expect(result.bound).toBe(true);
  });

  test("rejects a stale observed turn (predates baseline)", () => {
    const result = verifyTurnBinding({
      baselineTurns: 5,
      observedTurnIndex: 3,
      turnId: "old-turn",
    });
    expect(result.bound).toBe(false);
    expect(result.staleVerdict?.status).toBe("stale_turn");
    expect(result.staleVerdict?.turnId).toBe("old-turn");
    expect(result.staleVerdict?.errorCode).toBe("output_capture_unverified");
  });

  test("rejects when prompt sha256 mismatches between caller and DOM", () => {
    const a = sha256OfText("prompt-A");
    const b = sha256OfText("prompt-B");
    const result = verifyTurnBinding({
      baselineTurns: 3,
      observedTurnIndex: 3,
      expectedPromptSha256: a,
      observedPromptSha256: b,
    });
    expect(result.bound).toBe(false);
    expect(result.reason).toMatch(/prompt/);
    expect(result.staleVerdict?.status).toBe("stale_turn");
  });

  test("rejects negative or non-integer indexes", () => {
    expect(verifyTurnBinding({ baselineTurns: -1, observedTurnIndex: 0 }).bound).toBe(false);
    expect(verifyTurnBinding({ baselineTurns: 0, observedTurnIndex: -2 }).bound).toBe(false);
    expect(
      verifyTurnBinding({ baselineTurns: 1.5 as unknown as number, observedTurnIndex: 2 }).bound,
    ).toBe(false);
  });

  test("matching prompt sha256s on both sides bind successfully", () => {
    const hash = sha256OfText("same-prompt");
    const result = verifyTurnBinding({
      baselineTurns: 0,
      observedTurnIndex: 0,
      expectedPromptSha256: hash,
      observedPromptSha256: hash,
    });
    expect(result.bound).toBe(true);
  });
});

describe("sha256OfText", () => {
  test("produces stable sha256:<64-hex> digests", () => {
    expect(sha256OfText("hello")).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(sha256OfText("hello")).toBe(sha256OfText("hello"));
  });
});

import { describe, expect, test } from "vitest";
import { isRetryableRunErrorClass, type RunErrorClass } from "../../src/remote/run_event_sink.js";

// isRetryableRunErrorClass encodes MONEY-CRITICAL auto-retry semantics: only a
// capacity refusal and a PRE-submit transport failure may be automatically
// retried. Every other class — including any POST-submit interruption — must
// not be, because the prompt may already have reached the paid account, so a
// blind resubmission risks double-pay / a duplicate submission. Widening the
// allow-list is exactly the regression this test exists to catch, so the full
// truth table is pinned here (the sibling classifier classifyRunErrorClass is
// tested in run_event_sink.test.ts, but the retry DECISION itself was
// previously unguarded — test-gaps#1).

// Every RunErrorClass value (kept in lockstep with the union in
// run_event_sink.ts) plus null, mapped to its required retry decision.
const RETRY_TRUTH_TABLE: ReadonlyArray<readonly [RunErrorClass | null, boolean]> = [
  ["capacity_busy", true],
  ["transport_interrupted_before_submit", true],
  ["transport_interrupted_after_submit", false],
  ["account_quarantine", false],
  ["integrity_binding_failed", false],
  ["integrity_ui_unknown", false],
  [null, false],
];

describe("isRetryableRunErrorClass: money-critical retryable allow-list", () => {
  for (const [errorClass, expected] of RETRY_TRUTH_TABLE) {
    test(`${errorClass === null ? "null" : errorClass} -> ${
      expected ? "retryable" : "NOT retryable"
    }`, () => {
      expect(isRetryableRunErrorClass(errorClass)).toBe(expected);
    });
  }

  test("exactly two classes are retryable; every other class (and null) is not", () => {
    const retryable = RETRY_TRUTH_TABLE.filter(([, ok]) => ok).map(([cls]) => cls);
    // Pin the retryable SET: only capacity refusals and pre-submit transport
    // failures. Any widening (e.g. adding transport_interrupted_after_submit)
    // flips this to a failing test rather than shipping a double-billing bug.
    expect(new Set(retryable)).toEqual(
      new Set<RunErrorClass>(["capacity_busy", "transport_interrupted_before_submit"]),
    );
    expect(retryable).toHaveLength(2);
  });

  test("no POST-submit or integrity/quarantine class is ever retryable", () => {
    // These share the invariant that the prompt may already have reached the
    // account (or the account is compromised), so a blind auto-retry is unsafe.
    for (const cls of [
      "transport_interrupted_after_submit",
      "account_quarantine",
      "integrity_binding_failed",
      "integrity_ui_unknown",
    ] as const) {
      expect(isRetryableRunErrorClass(cls)).toBe(false);
    }
  });
});

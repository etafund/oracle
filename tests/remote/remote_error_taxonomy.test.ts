import { describe, expect, test } from "vitest";
import { RemoteRunFailedError } from "../../src/remote/client.js";
import {
  classifyOracleErrorClass,
  ORACLE_ERROR_CLASS_EXIT_CODES,
} from "../../src/cli/exitCodes.js";

// P2-3: a RemoteRunFailedError carries a fleet `errorClass`/`retryable`, but the
// normalized exit-code taxonomy (bin/oracle-cli.ts's resolveTopLevelExitCode
// calls classifyOracleErrorClass on the RAW thrown error) previously never read
// `errorClass`, so every remote failure collapsed into the generic exit `1`
// bucket. It must now:
//   - map the RETRYABLE, pre-submit classes to their retry-aware exit codes so
//     an agent can branch retry policy on the status (transport_interrupted_
//     before_submit -> timeout/5, capacity_busy -> retryable_backoff/4);
//   - leave the NON-retryable, post-submit / integrity / quarantine classes
//     unclassified (exit 1), so a run whose prompt may already have reached the
//     paid account is never advertised as retry-safe. This mirrors the fleet's
//     own isRetryableRunErrorClass truth table (src/remote/run_event_sink.ts).

function exitCodeFor(error: unknown): number {
  const cls = classifyOracleErrorClass(error);
  return cls ? ORACLE_ERROR_CLASS_EXIT_CODES[cls] : 1;
}

describe("remote failure exit-code taxonomy", () => {
  test("pre-submit transport interruption maps to timeout (exit 5, retry-safe)", () => {
    const error = new RemoteRunFailedError(
      "worker accepted the connection but sent no response headers",
      { errorClass: "transport_interrupted_before_submit", retryable: true },
    );
    expect(classifyOracleErrorClass(error)).toBe("timeout");
    expect(exitCodeFor(error)).toBe(5);
  });

  test("capacity_busy refusal maps to retryable_backoff (exit 4)", () => {
    const error = new RemoteRunFailedError("another run is active", {
      errorClass: "capacity_busy",
      retryable: true,
    });
    expect(classifyOracleErrorClass(error)).toBe("retryable_backoff");
    expect(exitCodeFor(error)).toBe(4);
  });

  test.each([
    "transport_interrupted_after_submit",
    "integrity_binding_failed",
    "integrity_ui_unknown",
    "account_quarantine",
    "model_not_allowed",
    "model_strategy_not_allowed",
  ])("non-retryable class %s stays generic exit 1 (never advertised retry-safe)", (errorClass) => {
    const error = new RemoteRunFailedError("post-submit / integrity failure", {
      errorClass,
      retryable: false,
    });
    expect(classifyOracleErrorClass(error)).toBeNull();
    expect(exitCodeFor(error)).toBe(1);
  });

  test("a null errorClass remains unclassified (exit 1)", () => {
    const error = new RemoteRunFailedError("unknown remote failure", {
      errorClass: null,
      retryable: null,
    });
    expect(classifyOracleErrorClass(error)).toBeNull();
    expect(exitCodeFor(error)).toBe(1);
  });
});

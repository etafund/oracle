import { describe, expect, test } from "vitest";
import {
  buildTopLevelCliErrorEnvelope,
  TOP_LEVEL_ERROR_CODES,
  TOP_LEVEL_ERROR_CODES_VERSION,
} from "../../src/cli/errorEnvelope.js";
import {
  BrowserAutomationError,
  OracleTransportError,
  PromptValidationError,
} from "../../src/oracle/errors.js";
import { RemoteRunFailedError } from "../../src/remote/client.js";

function envelopeFor(error: unknown, exitCode = 1) {
  return buildTopLevelCliErrorEnvelope({ error, command: "oracle", exitCode });
}

describe("normalizeTopLevelError closed code set (machine-output#3)", () => {
  test("transport timeouts map to the closed `timeout` code, not the free-form reason", () => {
    const envelope = envelopeFor(new OracleTransportError("client-timeout", "timed out"), 5);
    expect(envelope.error.code).toBe("timeout");
    expect(envelope.blocked_reason).toBe("timeout");
    expect(envelope.retry_safe).toBe(true);
    // The raw reason is preserved for callers that want it, and the pre-v2
    // `details.reason` is kept alongside it so a consumer still keyed on
    // `reason` retains a migration path.
    expect(envelope.error.details?.raw_reason).toBe("client-timeout");
    expect(envelope.error.details?.reason).toBe("client-timeout");
    expect(TOP_LEVEL_ERROR_CODES).toContain(envelope.error.code);
  });

  test("the error envelope advertises the bumped error-code vocabulary version on meta", () => {
    const envelope = envelopeFor(new OracleTransportError("client-timeout", "timed out"), 5);
    // The closed-code migration is a breaking vocabulary change; the version tag
    // lets a consumer detect it without diffing every code. The structural
    // envelope contract (json_envelope.v1) is unchanged.
    expect(envelope.meta.error_codes_version).toBe(TOP_LEVEL_ERROR_CODES_VERSION);
    expect(TOP_LEVEL_ERROR_CODES_VERSION).toBe("top_level_error_codes.v2");
    expect(envelope.schema_version).toBe("json_envelope.v1");
  });

  test("provider/api transport errors map to the closed `provider_error` code", () => {
    const envelope = envelopeFor(new OracleTransportError("api-error", "500 from provider"));
    expect(envelope.error.code).toBe("provider_error");
    expect(envelope.error.details?.raw_reason).toBe("api-error");
    expect(TOP_LEVEL_ERROR_CODES).toContain(envelope.error.code);
  });

  test("a browser-automation error never leaks the free-form `browser-automation` category", () => {
    const envelope = envelopeFor(new BrowserAutomationError("assistant did not respond"));
    expect(envelope.error.code).not.toBe("browser-automation");
    expect(envelope.error.code).toBe("browser_automation_failed");
    expect(envelope.error.details?.raw_reason).toBe("browser-automation");
    // Back-compat: `details.reason` keeps carrying the free-form category too.
    expect(envelope.error.details?.reason).toBe("browser-automation");
  });

  test("a recognized recovery code is normalized into the shared class (matches the exit code)", () => {
    const envelope = envelopeFor(
      new BrowserAutomationError("usage limit", { stage: "usage_limit" }),
    );
    expect(envelope.error.code).toBe("retryable_backoff");
    expect(envelope.retry_safe).toBe(true);
  });

  test("an already-submitted browser lock timeout keeps its code but is not retry-safe", () => {
    const envelope = envelopeFor(
      new BrowserAutomationError("recovery queue expired", {
        stage: "browser-queue",
        code: "browser_lock_timeout",
        oracleErrorClass: "capacity_busy",
        retryable: false,
        runtime: { promptSubmitted: true },
      }),
    );
    expect(envelope.error.code).toBe("browser_lock_timeout");
    expect(envelope.blocked_reason).toBe("browser_lock_timeout");
    expect(envelope.retry_safe).toBe(false);
  });

  test("a retryable remote capacity refusal matches its exit taxonomy in the envelope", () => {
    const envelope = envelopeFor(
      new RemoteRunFailedError("another run is active", {
        errorClass: "capacity_busy",
        retryable: true,
      }),
      4,
    );
    expect(envelope.meta.exit_code).toBe(4);
    expect(envelope.error.code).toBe("retryable_backoff");
    expect(envelope.blocked_reason).toBe("retryable_backoff");
    expect(envelope.retry_safe).toBe(true);
  });

  test("an explicit non-retryable remote recovery refusal remains fail-closed", () => {
    const envelope = envelopeFor(
      new RemoteRunFailedError("recovery capacity wait expired", {
        errorClass: "capacity_busy",
        retryable: false,
      }),
      1,
    );
    expect(envelope.meta.exit_code).toBe(1);
    expect(envelope.error.code).toBe("top_level_error");
    expect(envelope.blocked_reason).toBe("top_level_error");
    expect(envelope.retry_safe).toBe(false);
  });

  test("prompt-validation without a stage maps to the closed `input_invalid` code", () => {
    const envelope = envelopeFor(new PromptValidationError("prompt was empty"));
    expect(envelope.error.code).toBe("input_invalid");
    expect(envelope.error.code).not.toBe("prompt-validation");
    expect(envelope.error.details?.raw_reason).toBe("prompt-validation");
  });

  test("an explicit stable stage code (e.g. prompt_required) passes through unchanged", () => {
    const envelope = envelopeFor(
      new PromptValidationError("prompt required", { stage: "prompt_required" }),
    );
    expect(envelope.error.code).toBe("prompt_required");
  });
});

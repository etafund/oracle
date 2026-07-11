import { describe, expect, test } from "vitest";
import {
  buildTopLevelCliErrorEnvelope,
  TOP_LEVEL_ERROR_CODES,
} from "../../src/cli/errorEnvelope.js";
import {
  BrowserAutomationError,
  OracleTransportError,
  PromptValidationError,
} from "../../src/oracle/errors.js";

function envelopeFor(error: unknown, exitCode = 1) {
  return buildTopLevelCliErrorEnvelope({ error, command: "oracle", exitCode });
}

describe("normalizeTopLevelError closed code set (machine-output#3)", () => {
  test("transport timeouts map to the closed `timeout` code, not the free-form reason", () => {
    const envelope = envelopeFor(new OracleTransportError("client-timeout", "timed out"), 5);
    expect(envelope.error.code).toBe("timeout");
    expect(envelope.blocked_reason).toBe("timeout");
    expect(envelope.retry_safe).toBe(true);
    // The raw reason is preserved for callers that want it.
    expect(envelope.error.details?.raw_reason).toBe("client-timeout");
    expect(TOP_LEVEL_ERROR_CODES).toContain(envelope.error.code);
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
  });

  test("a recognized recovery code is normalized into the shared class (matches the exit code)", () => {
    const envelope = envelopeFor(
      new BrowserAutomationError("usage limit", { stage: "usage_limit" }),
    );
    expect(envelope.error.code).toBe("retryable_backoff");
    expect(envelope.retry_safe).toBe(true);
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

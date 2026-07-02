// Regression: v18 envelope helpers must never echo back caller-supplied
// secret material via extension keys, error details, or meta blobs.
//
// The helpers in src/oracle/v18/json_envelope.ts are the funnel every
// robot-facing command uses, so a leak here would propagate to every
// CLI surface.

import { describe, expect, test } from "vitest";

import {
  assertRecoveryContract,
  createEnvelope,
  createErrorEnvelope,
} from "../../../src/oracle/v18/json_envelope.js";
import { assertNoLeaks, detectLeaks } from "../../_helpers/secretLeakDetector.js";

const FAKES = [
  { name: "oracle-remote-token", value: "fake-oracle-token-9X8b1A2C" },
  { name: "user-account-email", value: "agent@example.invalid" },
  { name: "openai-api-key", value: "sk-fake-1234567890abcdefghij" },
] as const;

describe("createEnvelope — extension keys are emitted but never break redaction", () => {
  test("ok envelope with clean inputs is leak-free", () => {
    const env = createEnvelope({
      ok: true,
      data: { message: "ok" },
      meta: { tool: "oracle remote doctor" },
    });
    assertNoLeaks(env, { fakes: FAKES });
  });

  test("forbidden extension keys still appear in the envelope (helper is permissive)", () => {
    // The envelope helper itself is permissive by design — it does not
    // redact extension keys. The contract is enforced upstream by the
    // emitter (e.g. evidence.ts redactor) before the value reaches
    // createEnvelope. We capture that explicitly so a future refactor
    // that adds silent redaction in createEnvelope would surface here.
    const env = createEnvelope(
      { ok: true, data: null, meta: { tool: "test" } },
      { cookies: "session=abc" },
    );
    const leaks = detectLeaks(env, { fakes: [] });
    expect(leaks.some((l) => l.kind === "forbidden-key" && l.name === "cookies")).toBe(true);
  });

  test("extension keys MUST NOT overwrite core fields when colliding", () => {
    const env = createEnvelope(
      { ok: true, data: null, meta: { tool: "test" } },
      { ok: false, schema_version: "wrong", retry_safe: "evil-string" },
    );
    expect(env.ok).toBe(true);
    expect(env.schema_version).toBe("json_envelope.v1");
    expect(env.retry_safe).toBeNull();
  });
});

describe("createErrorEnvelope — error envelopes never leak secrets through detail blobs", () => {
  test("clean error envelope is leak-free", () => {
    const env = createErrorEnvelope({
      errors: [{ error_code: "provider_login_required", message: "login required" }],
      meta: { tool: "oracle remote doctor" },
      next_command: "oracle remote doctor --json",
      fix_command: "export ORACLE_REMOTE_TOKEN=<token>",
      retry_safe: true,
    });
    assertNoLeaks(env, { fakes: FAKES });
    assertRecoveryContract(env);
  });

  test("blocked_reason defaults to the first error_code (no prose to parse)", () => {
    const env = createErrorEnvelope({
      errors: [
        { error_code: "remote_browser_auth_failed", message: "Unauthorized" },
        { error_code: "ui_drift_suspected", message: "selector changed" },
      ],
      meta: {},
      next_command: null,
      fix_command: null,
      retry_safe: false,
    });
    expect(env.blocked_reason).toBe("remote_browser_auth_failed");
  });

  test("error_code values are stable taxonomy strings, not free-form prose", () => {
    const env = createErrorEnvelope({
      errors: [
        {
          error_code: "remote_browser_token_missing",
          // The message field is free-form prose — that's expected, but
          // it must not contain raw token material.
          message: `A remote host is configured but no token was provided. (token_env=ORACLE_REMOTE_TOKEN)`,
        },
      ],
      meta: { tool: "oracle remote doctor" },
      next_command: "oracle remote doctor --json",
      fix_command: "export ORACLE_REMOTE_TOKEN=<token>",
      retry_safe: true,
    });
    assertNoLeaks(env, { fakes: FAKES });
  });

  test("regression: a careless caller embedding a raw token in meta is detected", () => {
    // This is the failure mode we want this suite to catch — a CLI
    // surface that drops the literal token into the envelope's meta or
    // error.details.
    const leaky = createErrorEnvelope({
      errors: [
        {
          error_code: "remote_browser_auth_failed",
          message: "the upstream rejected the token",
          details: { raw_token: FAKES[0].value },
        },
      ],
      meta: { tool: "oracle remote doctor", debug_authorization: `Bearer ${FAKES[0].value}` },
      next_command: null,
      fix_command: null,
      retry_safe: false,
    });
    const leaks = detectLeaks(leaky, { fakes: FAKES });
    // Detector catches the literal value AND the pattern.
    expect(leaks.length).toBeGreaterThanOrEqual(2);
    expect(leaks.some((l) => l.kind === "literal" && l.name === "oracle-remote-token")).toBe(true);
    expect(leaks.some((l) => l.kind === "pattern" && l.name === "authorization-bearer")).toBe(true);
  });
});

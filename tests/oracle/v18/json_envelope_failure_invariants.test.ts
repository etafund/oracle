// Regression suite for oracle-9a7: jsonEnvelopeStrictSchema must reject
// malformed `ok=false` envelopes that the v18 §12 recovery contract
// forbids. The base jsonEnvelopeSchema only validates structural shape,
// so callers that don't also invoke assertRecoveryContract were
// accepting unrecoverable robot errors silently.
//
// These tests pin the failure-arm invariants at the schema level:
//   - errors[] non-empty
//   - retry_safe boolean (not null)
//   - blocked_reason non-empty string (not null, not "")
//   - each error entry carries a taxonomy error_code + non-empty message
// while keeping success envelopes round-trippable with all-null
// recovery fields (the policy for ok=true).

import { describe, expect, it } from "vitest";

import {
  JSON_ENVELOPE_SCHEMA_VERSION,
  V18_ERROR_CODES,
  assertRecoveryContract,
  createErrorEnvelope,
  jsonEnvelopeSchema,
  jsonEnvelopeStrictSchema,
  parseJsonEnvelopeStrict,
} from "../../../src/oracle/v18/index.js";

function baseFailure(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: JSON_ENVELOPE_SCHEMA_VERSION,
    ok: false,
    data: null,
    meta: {},
    blocked_reason: "provider_login_required",
    next_command: "oracle remote attach --host …",
    fix_command: null,
    retry_safe: false,
    errors: [
      {
        error_code: "provider_login_required",
        message: "ChatGPT session not signed in.",
      },
    ],
    warnings: [],
    commands: {},
    ...overrides,
  };
}

describe("jsonEnvelopeStrictSchema — failure-arm invariants (oracle-9a7)", () => {
  describe("regression: bead repro", () => {
    it("base schema accepts the malformed envelope (proves the bug exists)", () => {
      // Exact payload quoted in the bead description: `ok=false` with
      // empty errors[] and null retry_safe. The base schema lets it
      // through, which is the gap this commit closes.
      const malformed = {
        schema_version: JSON_ENVELOPE_SCHEMA_VERSION,
        ok: false,
        data: null,
        meta: {},
        blocked_reason: null,
        next_command: null,
        fix_command: null,
        retry_safe: null,
        errors: [],
        warnings: [],
        commands: {},
      };
      expect(jsonEnvelopeSchema.safeParse(malformed).success).toBe(true);
    });

    it("strict schema rejects the same malformed envelope", () => {
      const malformed = {
        schema_version: JSON_ENVELOPE_SCHEMA_VERSION,
        ok: false,
        data: null,
        meta: {},
        blocked_reason: null,
        next_command: null,
        fix_command: null,
        retry_safe: null,
        errors: [],
        warnings: [],
        commands: {},
      };
      const result = parseJsonEnvelopeStrict(malformed);
      expect(result.success).toBe(false);
      if (!result.success) {
        const paths = result.error.issues.map((issue) => issue.path.join("."));
        // All three failure-arm invariants must surface.
        expect(paths).toEqual(expect.arrayContaining(["retry_safe", "blocked_reason", "errors"]));
      }
    });
  });

  describe("recovery-field invariants", () => {
    it("rejects ok=false with retry_safe = null", () => {
      const result = jsonEnvelopeStrictSchema.safeParse(baseFailure({ retry_safe: null }));
      expect(result.success).toBe(false);
    });

    it("rejects ok=false with blocked_reason = null", () => {
      const result = jsonEnvelopeStrictSchema.safeParse(baseFailure({ blocked_reason: null }));
      expect(result.success).toBe(false);
    });

    it("rejects ok=false with blocked_reason = empty string", () => {
      const result = jsonEnvelopeStrictSchema.safeParse(baseFailure({ blocked_reason: "" }));
      expect(result.success).toBe(false);
    });

    it("accepts ok=false with retry_safe=true (retryable failure)", () => {
      const result = jsonEnvelopeStrictSchema.safeParse(
        baseFailure({
          retry_safe: true,
          errors: [{ error_code: "browser_lock_timeout", message: "Browser lock not released." }],
          blocked_reason: "browser_lock_timeout",
        }),
      );
      expect(result.success).toBe(true);
    });

    it("accepts ok=false with retry_safe=false (terminal failure)", () => {
      const result = jsonEnvelopeStrictSchema.safeParse(baseFailure({ retry_safe: false }));
      expect(result.success).toBe(true);
    });
  });

  describe("errors[] invariants", () => {
    it("rejects ok=false with empty errors[]", () => {
      const result = jsonEnvelopeStrictSchema.safeParse(baseFailure({ errors: [] }));
      expect(result.success).toBe(false);
      if (!result.success) {
        const paths = result.error.issues.map((issue) => issue.path.join("."));
        expect(paths).toContain("errors");
      }
    });

    it("rejects an error entry missing error_code", () => {
      const result = jsonEnvelopeStrictSchema.safeParse(
        baseFailure({ errors: [{ message: "no code present" }] }),
      );
      expect(result.success).toBe(false);
    });

    it("rejects an error entry with error_code outside the v18 taxonomy", () => {
      const result = jsonEnvelopeStrictSchema.safeParse(
        baseFailure({
          errors: [{ error_code: "definitely_not_in_taxonomy", message: "rogue code" }],
        }),
      );
      expect(result.success).toBe(false);
      if (!result.success) {
        const paths = result.error.issues.map((issue) => issue.path.join("."));
        // The taxonomy violation should surface at errors[0].error_code.
        expect(paths).toContain("errors.0.error_code");
      }
    });

    it("rejects an error entry with empty message", () => {
      const result = jsonEnvelopeStrictSchema.safeParse(
        baseFailure({ errors: [{ error_code: "provider_login_required", message: "" }] }),
      );
      expect(result.success).toBe(false);
    });

    it("rejects an error entry missing message", () => {
      const result = jsonEnvelopeStrictSchema.safeParse(
        baseFailure({ errors: [{ error_code: "provider_login_required" }] }),
      );
      expect(result.success).toBe(false);
    });

    it("accepts multiple well-formed error entries", () => {
      const result = jsonEnvelopeStrictSchema.safeParse(
        baseFailure({
          errors: [
            { error_code: "provider_login_required", message: "Not signed in." },
            { error_code: "ui_drift_suspected", message: "Effort picker selector drifted." },
          ],
        }),
      );
      expect(result.success).toBe(true);
    });

    it("permits extension keys on individual error entries (passthrough)", () => {
      const result = jsonEnvelopeStrictSchema.safeParse(
        baseFailure({
          errors: [
            {
              error_code: "provider_login_required",
              message: "Not signed in.",
              details: { last_url: "https://chatgpt.com/auth/login" },
              hint_for_human: "Open ChatGPT in a regular tab and sign in.",
            },
          ],
        }),
      );
      expect(result.success).toBe(true);
    });
  });

  describe("success envelopes still round-trip cleanly", () => {
    it("accepts ok=true with all recovery fields null", () => {
      const success = {
        schema_version: JSON_ENVELOPE_SCHEMA_VERSION,
        ok: true,
        data: { answer: "42" },
        meta: { session_id: "sess-xyz" },
        blocked_reason: null,
        next_command: null,
        fix_command: null,
        retry_safe: null,
        errors: [],
        warnings: [],
        commands: {},
      };
      expect(jsonEnvelopeStrictSchema.safeParse(success).success).toBe(true);
    });

    it("accepts ok=true with empty errors[] and no extension keys", () => {
      const success = {
        schema_version: JSON_ENVELOPE_SCHEMA_VERSION,
        ok: true,
        data: null,
        meta: {},
        blocked_reason: null,
        next_command: null,
        fix_command: null,
        retry_safe: null,
        errors: [],
        warnings: ["non-critical drift warning"],
        commands: {},
      };
      expect(jsonEnvelopeStrictSchema.safeParse(success).success).toBe(true);
    });
  });

  describe("integration with the existing helpers", () => {
    it("every output of createErrorEnvelope satisfies the strict schema", () => {
      for (const code of V18_ERROR_CODES) {
        const envelope = createErrorEnvelope({
          errors: [{ error_code: code, message: `failure: ${code}` }],
          meta: { run_id: "test" },
          next_command: null,
          fix_command: null,
          retry_safe: false,
        });
        const result = jsonEnvelopeStrictSchema.safeParse(envelope);
        expect(result.success, `createErrorEnvelope output for ${code} failed strict parse`).toBe(
          true,
        );
        // assertRecoveryContract must agree.
        expect(() => assertRecoveryContract(envelope)).not.toThrow();
      }
    });
  });
});

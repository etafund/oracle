import { describe, expect, test } from "vitest";
import { expectGoldenJson } from "../../_helpers/goldenSnapshots.js";
import {
  assertRecoveryContract,
  createEnvelope,
  createErrorEnvelope,
} from "../../../src/oracle/v18/json_envelope.js";
import {
  JSON_ENVELOPE_SCHEMA_VERSION,
  jsonEnvelopeSchema,
} from "../../../src/oracle/v18/contracts.js";

describe("json_envelope.v1 unit conformance", () => {
  test("round-trips a success envelope with stable core fields and extensions", () => {
    const envelope = createEnvelope(
      {
        ok: true,
        data: { lease_id: "lease-1", state: "released" },
        meta: { command: "browser leases release", request_id: "req-1" },
        warnings: ["unit-warning"],
        commands: { retry: "oracle status" },
      },
      {
        extension_a: { kept: true },
        ok: false,
        schema_version: "evil.v0",
      },
    );

    const roundTripped = jsonEnvelopeSchema.parse(JSON.parse(JSON.stringify(envelope)));

    expect(roundTripped).toEqual(envelope);
    expect(roundTripped.schema_version).toBe(JSON_ENVELOPE_SCHEMA_VERSION);
    expect(roundTripped.ok).toBe(true);
    expect(roundTripped).not.toHaveProperty("schema_version", "evil.v0");
    expectGoldenJson(
      roundTripped,
      `
      {
        "blocked_reason": null,
        "commands": {
          "retry": "oracle status"
        },
        "data": {
          "lease_id": "lease-1",
          "state": "released"
        },
        "errors": [],
        "extension_a": {
          "kept": true
        },
        "fix_command": null,
        "meta": {
          "command": "browser leases release",
          "request_id": "req-1"
        },
        "next_command": null,
        "ok": true,
        "retry_safe": null,
        "schema_version": "json_envelope.v1",
        "warnings": [
          "unit-warning"
        ]
      }
      `,
    );
  });

  test("error envelopes serialize recovery fields required by robot callers", () => {
    const envelope = createErrorEnvelope(
      {
        errors: [
          {
            error_code: "remote_browser_token_missing",
            message: "Remote browser host is configured without a token.",
            details: { token_env: "ORACLE_REMOTE_TOKEN" },
          },
        ],
        meta: { command: "oracle remote doctor" },
        next_command: "export ORACLE_REMOTE_TOKEN=<token>",
        fix_command: "oracle config set browser.remoteToken <token>",
        retry_safe: true,
      },
      { diagnostic_id: "diag-remote-token" },
    );

    assertRecoveryContract(envelope);
    const roundTripped = jsonEnvelopeSchema.parse(JSON.parse(JSON.stringify(envelope)));
    expect(roundTripped.blocked_reason).toBe("remote_browser_token_missing");
    expectGoldenJson(
      roundTripped,
      `
      {
        "blocked_reason": "remote_browser_token_missing",
        "commands": {},
        "data": null,
        "diagnostic_id": "diag-remote-token",
        "errors": [
          {
            "details": {
              "token_env": "ORACLE_REMOTE_TOKEN"
            },
            "error_code": "remote_browser_token_missing",
            "message": "Remote browser host is configured without a token."
          }
        ],
        "fix_command": "oracle config set browser.remoteToken <token>",
        "meta": {
          "command": "oracle remote doctor"
        },
        "next_command": "export ORACLE_REMOTE_TOKEN=<token>",
        "ok": false,
        "retry_safe": true,
        "schema_version": "json_envelope.v1",
        "warnings": []
      }
      `,
    );
  });

  test("recovery contract guard rejects malformed failure envelopes", () => {
    const envelope = createErrorEnvelope({
      errors: [{ error_code: "ui_drift_suspected", message: "Selector drift." }],
      meta: { command: "browser run" },
      next_command: "oracle session sess-1",
      fix_command: "rerun with --verbose",
      retry_safe: false,
    });

    expect(() => assertRecoveryContract({ ...envelope, blocked_reason: null })).toThrow(
      /blocked_reason/,
    );
    expect(() => assertRecoveryContract({ ...envelope, retry_safe: null })).toThrow(/retry_safe/);
    expect(() => assertRecoveryContract({ ...envelope, errors: [] })).toThrow(/errors/);
  });
});

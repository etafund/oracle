import { describe, expect, test } from "vitest";
import {
  classifyOracleErrorClass,
  isRetrySafeErrorClass,
  ORACLE_ERROR_CLASS_EXIT_CODES,
  ORACLE_EXIT_CODE_DICTIONARY,
  ORACLE_WAIT_TIMEOUT_EXIT_CODE,
} from "../../src/cli/exitCodes.js";
import { OracleTransportError } from "../../src/oracle/errors.js";

describe("ORACLE_EXIT_CODE_DICTIONARY", () => {
  test("documents the new operational exit codes 3–6", () => {
    for (const code of ["3", "4", "5", "6"] as const) {
      expect(ORACLE_EXIT_CODE_DICTIONARY[code]).toBeTypeOf("string");
      expect(ORACLE_EXIT_CODE_DICTIONARY[code].length).toBeGreaterThan(0);
    }
    expect(ORACLE_EXIT_CODE_DICTIONARY["3"]).toContain("auth_required");
    expect(ORACLE_EXIT_CODE_DICTIONARY["4"]).toContain("retryable_backoff");
    expect(ORACLE_EXIT_CODE_DICTIONARY["5"]).toContain("timeout");
    expect(ORACLE_EXIT_CODE_DICTIONARY["6"]).toContain("challenge_or_drift");
  });

  test("documents the wait_timeout exit code 7 and pins its constant", () => {
    expect(ORACLE_WAIT_TIMEOUT_EXIT_CODE).toBe(7);
    expect(ORACLE_EXIT_CODE_DICTIONARY["7"]).toContain("wait_timeout");
    expect(ORACLE_EXIT_CODE_DICTIONARY["7"]).toContain("oracle wait");
  });

  test("nonzero-means-fail is preserved (0 is the only success code)", () => {
    expect(ORACLE_EXIT_CODE_DICTIONARY["0"]).toContain("success");
    for (const key of Object.keys(ORACLE_EXIT_CODE_DICTIONARY)) {
      if (key !== "0") {
        expect(ORACLE_EXIT_CODE_DICTIONARY[key as "1"]).not.toContain("success —");
      }
    }
  });
});

describe("classifyOracleErrorClass", () => {
  test("maps transport client-timeout / connection-lost to timeout (exit 5, retry-safe)", () => {
    for (const reason of ["client-timeout", "connection-lost"] as const) {
      const error = new OracleTransportError(reason, "boom");
      expect(classifyOracleErrorClass(error)).toBe("timeout");
      expect(error.exitCode).toBe(5);
    }
    expect(ORACLE_ERROR_CLASS_EXIT_CODES.timeout).toBe(5);
    expect(isRetrySafeErrorClass("timeout")).toBe(true);
  });

  test("classifies auth / usage-limit / challenge tokens carried in details", () => {
    expect(classifyOracleErrorClass({ details: { error_code: "provider_login_required" } })).toBe(
      "auth_required",
    );
    expect(classifyOracleErrorClass({ details: { stage: "login_required" } })).toBe(
      "auth_required",
    );
    expect(classifyOracleErrorClass({ blocked_reason: "provider_usage_limit" })).toBe(
      "retryable_backoff",
    );
    expect(classifyOracleErrorClass({ details: { stage: "cloudflare-challenge" } })).toBe(
      "challenge_or_drift",
    );
    expect(classifyOracleErrorClass({ details: { error_code: "ui_drift_suspected" } })).toBe(
      "challenge_or_drift",
    );
  });

  test("exit-code mapping matches the taxonomy", () => {
    expect(ORACLE_ERROR_CLASS_EXIT_CODES).toEqual({
      auth_required: 3,
      retryable_backoff: 4,
      timeout: 5,
      challenge_or_drift: 6,
    });
    expect(isRetrySafeErrorClass("retryable_backoff")).toBe(true);
    expect(isRetrySafeErrorClass("auth_required")).toBe(false);
    expect(isRetrySafeErrorClass("challenge_or_drift")).toBe(false);
  });

  test("returns null for an unclassified error (stays in the generic 1 bucket)", () => {
    expect(classifyOracleErrorClass(new Error("generic"))).toBeNull();
    expect(classifyOracleErrorClass({ details: { stage: "some-unknown-stage" } })).toBeNull();
    expect(classifyOracleErrorClass("a string")).toBeNull();
    expect(classifyOracleErrorClass(undefined)).toBeNull();
  });
});

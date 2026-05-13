import { describe, expect, test } from "vitest";

import { jsonEnvelopeSchema } from "../../src/oracle/v18/contracts.js";
import {
  RemoteBrowserRecoveryError,
  createRemoteBrowserRecoveryError,
  createRemoteBrowserRecoveryFailure,
  hashRemoteBrowserHost,
  shouldAutoRetryRemoteBrowserRecovery,
  toRemoteBrowserRecoveryEnvelope,
} from "../../src/remote/browser-recovery.js";
import type {
  RemoteBrowserRecoveryFailure,
  RemoteBrowserRecoveryFailureInput,
} from "../../src/types/remote-recovery.js";

const CASES: ReadonlyArray<{
  input: RemoteBrowserRecoveryFailureInput;
  kind: RemoteBrowserRecoveryFailure["kind"];
  errorCode: RemoteBrowserRecoveryFailure["error_code"];
  retrySafe: boolean;
}> = [
  {
    input: { kind: "remote_browser_token_missing", hostHash: "abc123abc123" },
    kind: "remote_browser_token_missing",
    errorCode: "remote_browser_token_missing",
    retrySafe: false,
  },
  {
    input: { kind: "remote_browser_host_unreachable", details: { errno: "ECONNREFUSED" } },
    kind: "remote_browser_host_unreachable",
    errorCode: "remote_browser_unavailable",
    retrySafe: true,
  },
  {
    input: { kind: "remote_browser_auth_failed" },
    kind: "remote_browser_auth_failed",
    errorCode: "remote_browser_auth_failed",
    retrySafe: false,
  },
  {
    input: { kind: "remote_browser_profile_unavailable" },
    kind: "remote_browser_profile_unavailable",
    errorCode: "remote_browser_unavailable",
    retrySafe: false,
  },
  {
    input: { kind: "provider_login_required", provider: "chatgpt" },
    kind: "provider_login_required",
    errorCode: "provider_login_required",
    retrySafe: false,
  },
  {
    input: { kind: "remote_browser_required_unavailable" },
    kind: "remote_browser_required_unavailable",
    errorCode: "remote_browser_unavailable",
    retrySafe: false,
  },
  {
    input: {
      kind: "remote_browser_health_stale",
      staleAfterMs: 60_000,
      observedAgeMs: 120_000,
    },
    kind: "remote_browser_health_stale",
    errorCode: "remote_browser_unavailable",
    retrySafe: true,
  },
];

describe("remote browser recovery failures", () => {
  test.each(CASES)("builds typed $kind failures", ({ input, kind, errorCode, retrySafe }) => {
    const failure = createRemoteBrowserRecoveryFailure(input);

    expect(failure).toMatchObject({
      schema_version: "remote_browser_recovery_failure.v1",
      ok: false,
      kind,
      error_code: errorCode,
      blocked_reason: errorCode,
      retry_safe: retrySafe,
    });
    expect(failure.message).toEqual(expect.any(String));
    expect(failure.next_command).toEqual(expect.any(String));
    expect(failure.fix_command).toEqual(expect.any(String));
    expect(failure.docs_url_or_path).toEqual(expect.any(String));
    expect(shouldAutoRetryRemoteBrowserRecovery(failure)).toBe(retrySafe);
  });

  test("includes required env metadata for token and required-remote failures", () => {
    const token = createRemoteBrowserRecoveryFailure({
      kind: "remote_browser_token_missing",
    });
    expect(token.required_env).toEqual(["ORACLE_REMOTE_TOKEN"]);

    const auth = createRemoteBrowserRecoveryFailure({
      kind: "remote_browser_auth_failed",
    });
    expect(auth.required_env).toEqual(["ORACLE_REMOTE_TOKEN"]);

    const required = createRemoteBrowserRecoveryFailure({
      kind: "remote_browser_required_unavailable",
    });
    expect(required.required_env).toEqual(["ORACLE_REMOTE_BROWSER", "ORACLE_REMOTE_HOST"]);
  });

  test("serializes every recovery failure as a v18 json_envelope", () => {
    for (const item of CASES) {
      const failure = createRemoteBrowserRecoveryFailure(item.input);
      const envelope = toRemoteBrowserRecoveryEnvelope(failure);

      expect(jsonEnvelopeSchema.safeParse(envelope).success).toBe(true);
      expect(envelope.ok).toBe(false);
      expect(envelope.blocked_reason).toBe(failure.blocked_reason);
      expect(envelope.retry_safe).toBe(failure.retry_safe);
      expect(envelope.next_command).toBe(failure.next_command);
      expect(envelope.fix_command).toBe(failure.fix_command);
      expect(envelope.errors[0]).toMatchObject({
        error_code: failure.error_code,
        message: failure.message,
        details: {
          kind: failure.kind,
          docs_url_or_path: failure.docs_url_or_path,
        },
      });
      expect(envelope.data).toMatchObject({
        kind: failure.kind,
        retry_safe: failure.retry_safe,
      });
    }
  });

  test("retry helper prevents automatic retry for unsafe recovery states", () => {
    for (const input of [
      { kind: "remote_browser_token_missing" },
      { kind: "remote_browser_auth_failed" },
      { kind: "remote_browser_profile_unavailable" },
      { kind: "provider_login_required", provider: "gemini" },
      { kind: "remote_browser_required_unavailable" },
    ] satisfies RemoteBrowserRecoveryFailureInput[]) {
      const failure = createRemoteBrowserRecoveryFailure(input);
      expect(shouldAutoRetryRemoteBrowserRecovery(failure)).toBe(false);
    }
  });

  test("host hashes are stable and do not reveal host strings", () => {
    const hash = hashRemoteBrowserHost("secret.example.test:9473");
    expect(hash).toMatch(/^[0-9a-f]{12}$/);
    expect(hash).toBe(hashRemoteBrowserHost("secret.example.test:9473"));
    expect(hash).not.toContain("secret");
    expect(hashRemoteBrowserHost(" ")).toBeUndefined();
  });

  test("RemoteBrowserRecoveryError carries the typed failure for catch blocks", () => {
    const error = createRemoteBrowserRecoveryError({
      kind: "remote_browser_auth_failed",
      hostHash: "abc123abc123",
    });

    expect(error).toBeInstanceOf(RemoteBrowserRecoveryError);
    expect(error.failure.kind).toBe("remote_browser_auth_failed");
    expect(error.failure.retry_safe).toBe(false);
    expect(error.message).toBe(error.failure.message);
  });
});

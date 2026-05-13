import { describe, expect, test } from "vitest";
import { assertNoLeaks } from "../../_helpers/secretLeakDetector.js";
import { expectGoldenJson } from "../../_helpers/goldenSnapshots.js";
import { resolveRemoteServiceConfig } from "../../../src/remote/remoteServiceConfig.js";
import {
  buildSharedProfileView,
  assertNoSecretsInPublicView,
} from "../../../src/oracle/v18/browser_profile.js";
import {
  buildStoredBrowserLease,
  redactBrowserLeaseMetadata,
} from "../../../src/oracle/v18/browser_lease.js";
import { redactEvidencePayload, sha256OfBytes } from "../../../src/oracle/v18/evidence.js";

const FAKE_REMOTE_TOKEN = "sk-proj-unit-redaction-12345678901234567890";
const FAKE_COOKIE = "session=unitCookieSecret123";

describe("secret redaction unit invariants", () => {
  test("recursive evidence redaction strips forbidden keys while preserving privacy declarations", () => {
    const input = {
      provider_slot: "chatgpt_pro_first_plan",
      prompt_sha256: sha256OfBytes("prompt"),
      output_text_sha256: sha256OfBytes("output"),
      evidence_privacy: {
        stores_cookies: false,
        stores_raw_dom: false,
        debug_session_token: FAKE_REMOTE_TOKEN,
      },
      nested: {
        cookies: FAKE_COOKIE,
        raw_dom: "<html>secret</html>",
        authorization: `Bearer ${FAKE_REMOTE_TOKEN}`,
      },
    };

    const redacted = redactEvidencePayload(input);

    expect(redacted.removedPaths).toEqual(
      expect.arrayContaining([
        "evidence_privacy.debug_session_token",
        "nested.cookies",
        "nested.raw_dom",
        "nested.authorization",
      ]),
    );
    expect(redacted.redacted).toMatchObject({
      evidence_privacy: {
        stores_cookies: false,
        stores_raw_dom: false,
      },
      nested: {},
    });
    assertNoLeaks(redacted.redacted, {
      fakes: [
        { name: "remote-token", value: FAKE_REMOTE_TOKEN },
        { name: "cookie", value: FAKE_COOKIE },
      ],
    });
  });

  test("lease metadata redaction removes holder, command, remote session, and remote browser secrets", () => {
    const lease = buildStoredBrowserLease({
      leaseId: "lease-secret-1",
      provider: "chatgpt",
      profileIdHash: sha256OfBytes("profile-secret"),
      issuedAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2026-01-01T00:05:00.000Z",
      ttlSeconds: 300,
      holder: "agent@example.com",
      commandSummary: `oracle --remote-token ${FAKE_REMOTE_TOKEN}`,
      remoteSessionId: "remote-session-secret",
      remoteBrowser: {
        provider: "chatgpt",
        host: "browser.internal",
        token: FAKE_REMOTE_TOKEN,
        auth_profile_id_hash: sha256OfBytes("auth-profile"),
      },
    });

    const redacted = redactBrowserLeaseMetadata(lease);
    assertNoLeaks(redacted, {
      fakes: [
        { name: "email", value: "agent@example.com" },
        { name: "remote-token", value: FAKE_REMOTE_TOKEN },
        { name: "remote-session", value: "remote-session-secret" },
        { name: "remote-host", value: "browser.internal" },
      ],
    });
    expectGoldenJson(
      {
        holder: redacted.holder,
        command_summary: redacted.command_summary,
        remote_session_id: redacted.remote_session_id,
        remote_browser: redacted.remote_browser,
      },
      `
      {
        "command_summary": "[redacted]",
        "holder": "[redacted]",
        "remote_browser": {
          "auth_profile_id_hash": "sha256:eddc905339f78510c5bfca7007b4882d961cd4c7bea46c9e4409b747fda0f840",
          "host": "[redacted]",
          "provider": "chatgpt",
          "token": "[redacted]"
        },
        "remote_session_id": "[redacted]"
      }
      `,
    );
  });

  test("shared browser profile public view never includes raw account or profile secrets", () => {
    const view = buildSharedProfileView({
      identity: {
        endpointId: "remote-prod-1",
        hostEnv: "ORACLE_REMOTE_HOST",
        tokenEnv: "ORACLE_REMOTE_TOKEN",
        accountId: "agent@example.com",
        rawProfilePath: "/Users/agent/Library/Application Support/Chrome/Profile 1",
      },
    });

    expect(() => assertNoSecretsInPublicView(view)).not.toThrow();
    assertNoLeaks(view, {
      fakes: [
        { name: "email", value: "agent@example.com" },
        {
          name: "profile-path",
          value: "/Users/agent/Library/Application Support/Chrome/Profile 1",
        },
      ],
    });
    expect(view.remote_browser).toEqual({
      endpoint_id: "remote-prod-1",
      host_env: "ORACLE_REMOTE_HOST",
      token_env: "ORACLE_REMOTE_TOKEN",
      no_plaintext_secrets: true,
    });
    expect(() => assertNoSecretsInPublicView({ remote_token: FAKE_REMOTE_TOKEN })).toThrow(
      /forbidden keys/,
    );
  });

  test("remote service config exposes redacted token material for user-visible surfaces", () => {
    const resolved = resolveRemoteServiceConfig({
      cliHost: "browser.internal:9473",
      cliToken: FAKE_REMOTE_TOKEN,
      env: {},
    });
    const userVisible = {
      hostHash: resolved.hostHash,
      mode: resolved.mode,
      redactedToken: resolved.redactedToken,
      sources: resolved.sources,
    };

    expect(resolved.token).toBe(FAKE_REMOTE_TOKEN);
    expect(userVisible.redactedToken).toBe("***");
    expect(userVisible.hostHash).not.toBe("browser.internal:9473");
    assertNoLeaks(userVisible, {
      fakes: [
        { name: "remote-token", value: FAKE_REMOTE_TOKEN },
        { name: "remote-host", value: "browser.internal:9473" },
      ],
    });
  });
});

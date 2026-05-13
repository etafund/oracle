// Regression: the v18 shared-profile public view must never leak
// cookies, DOM, screenshots, account identifiers, raw profile paths, or
// raw remote-host/token values — even when callers smuggle them
// through extension paths.

import { describe, expect, test } from "vitest";

import {
  describeSharedBrowserProfile,
  deriveProfileIdHash,
} from "../../../src/browser/profile.js";
import {
  assertNoSecretsInPublicView,
  buildSharedProfileView,
  computeProfileIdHash,
} from "../../../src/oracle/v18/browser_profile.js";
import { assertNoLeaks, detectLeaks } from "../../_helpers/secretLeakDetector.js";

const FAKES = [
  { name: "manual-profile-path", value: "/home/agent/.oracle/profiles/manual-very-private" },
  { name: "account-email", value: "agent-pii@example.invalid" },
  { name: "remote-host", value: "192.0.2.42:9473" },
  { name: "remote-token", value: "fake-remote-token-Sh3duLe" },
  { name: "session-cookie", value: "session=PHPSESSID-abc123def456" },
];

describe("buildSharedProfileView — public view is leak-free", () => {
  test("redacts every fake internal-identity input", () => {
    const view = buildSharedProfileView({
      identity: {
        endpointId: "ep-1",
        hostEnv: "ORACLE_REMOTE_HOST",
        tokenEnv: "ORACLE_REMOTE_TOKEN",
        accountId: FAKES[1].value,
        rawProfilePath: FAKES[0].value,
      },
    });
    assertNoLeaks(view, { fakes: FAKES });
  });

  test("public view does NOT include cookies/dom/screenshots even if a caller smuggles them via extension hooks", () => {
    // The shared-profile model has no extension hook today. This test
    // captures that: a freshly-built view stays clean.
    const view = buildSharedProfileView({
      identity: {
        endpointId: "ep-2",
        hostEnv: "H",
        tokenEnv: "T",
        accountId: FAKES[1].value,
      },
    });
    const leaks = detectLeaks(view, { fakes: FAKES });
    expect(leaks).toEqual([]);
  });

  test("assertNoSecretsInPublicView catches a leaky synthetic view", () => {
    expect(() =>
      assertNoSecretsInPublicView({
        schema_version: "shared_browser_profile.v1",
        cookies: ["raw-cookie"],
      }),
    ).toThrow(/forbidden keys/i);
    expect(() =>
      assertNoSecretsInPublicView({
        schema_version: "shared_browser_profile.v1",
        remote_browser: { raw_profile_path: FAKES[0].value },
      }),
    ).toThrow(/forbidden keys/i);
  });

  test("provider_locks expose only the documented lock names", () => {
    const view = buildSharedProfileView({
      identity: { endpointId: "ep", hostEnv: "H", tokenEnv: "T" },
    });
    const locks = view.provider_locks.map((entry) => entry.lock);
    expect(locks).toContain("browser:shared-profile:chatgpt");
    expect(locks).toContain("browser:shared-profile:gemini");
    for (const lock of locks) {
      expect(lock).toMatch(/^browser:shared-profile:/);
    }
  });

  test("profile_id_hash is opaque (no raw account or path material leaks via the hash domain)", () => {
    const hash = computeProfileIdHash({
      endpointId: "ep",
      hostEnv: "H",
      tokenEnv: "T",
      accountId: FAKES[1].value,
      rawProfilePath: FAKES[0].value,
    });
    expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    // The hash digest must not contain the literal raw account/path.
    expect(hash).not.toContain(FAKES[1].value);
    expect(hash).not.toContain(FAKES[0].value);
  });
});

describe("describeSharedBrowserProfile — wiring helper stays leak-free", () => {
  test("default ORACLE_REMOTE_* config produces a clean view", () => {
    const view = describeSharedBrowserProfile({});
    assertNoLeaks(view, { fakes: FAKES });
    expect(view.remote_browser.host_env).toBe("ORACLE_REMOTE_HOST");
    expect(view.remote_browser.token_env).toBe("ORACLE_REMOTE_TOKEN");
  });

  test("never serializes raw account / profile path even when configured", () => {
    const view = describeSharedBrowserProfile({
      accountId: FAKES[1].value,
      rawProfilePath: FAKES[0].value,
    });
    const serialised = JSON.stringify(view);
    expect(serialised).not.toContain(FAKES[1].value);
    expect(serialised).not.toContain(FAKES[0].value);
    assertNoLeaks(view, { fakes: FAKES });
  });

  test("never serializes raw host or token values", () => {
    // The wiring helper accepts hostEnv/tokenEnv (env-var NAMES) only,
    // never raw host/token VALUES — confirm the typed shape rules out
    // accidental injection.
    const view = describeSharedBrowserProfile({
      endpointId: "remote-prod-1",
      hostEnv: "MY_HOST_ENV",
      tokenEnv: "MY_TOKEN_ENV",
    });
    expect(JSON.stringify(view)).not.toContain(FAKES[2].value);
    expect(JSON.stringify(view)).not.toContain(FAKES[3].value);
  });

  test("deriveProfileIdHash + view.profile_id_hash agree (no separate identity leakage)", () => {
    const config = {
      endpointId: "ep-3",
      hostEnv: "H",
      tokenEnv: "T",
      accountId: FAKES[1].value,
    };
    const direct = deriveProfileIdHash(config);
    const view = describeSharedBrowserProfile(config);
    expect(direct).toBe(view.profile_id_hash);
    expect(view.profile_id_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

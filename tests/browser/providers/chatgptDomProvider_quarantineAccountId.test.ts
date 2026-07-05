// Regression test for oracle-router-8t1 (quarantine account-id resolution
// diverges between serve layer and browser-side latch paths).
//
// The serve layer resolves the worker's account id as
// `options.accountId ?? env` (src/remote/server.ts) and uses THAT id for
// /ready and /runs admission's quarantine check. Before this fix,
// chatgptDomProvider's PRE-RUN access gate (`waitForUi` ->
// `assertPreRunAccessState`) called through with no options at all, so a
// trip always fell back to resolving the account id from env only
// (quarantineLatch.ts `resolveQuarantineAccountId`). When an embedder
// supplies an explicit accountId that diverges from env, the latch would
// trip under the WRONG identity: the trip writes `quarantine-<env>.json`
// while the serve layer's admission check reads `quarantine-<options>.json`
// — i.e. the account looks clean to /ready and /runs even though it was
// just quarantined.
//
// This test pins that ctx.state.accountId (BrowserRunOptions.accountId,
// threaded down from the serve layer) is the identity the trip lands under,
// even when process.env.ORACLE_ACCOUNT_ID disagrees.

import { afterEach, describe, expect, test, vi } from "vitest";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { chatgptDomProvider } from "../../../src/browser/providers/chatgptDomProvider.js";
import { getQuarantineLatchState } from "../../../src/browser/quarantineLatch.js";
import type { ProviderDomFlowContext } from "../../../src/browser/providerDomFlow.js";
import type { ChromeClient } from "../../../src/browser/types.js";

function interstitialRuntime(): ChromeClient["Runtime"] {
  return {
    evaluate: vi.fn(async () => ({
      result: {
        value: {
          url: "https://chatgpt.com/",
          title: "Just a moment...",
          interstitialTitle: true,
          interstitialScript: false,
          interstitialUrlMarker: false,
          bodySample: "verifying you are human. this may take a few seconds.",
          composerPresent: false,
          composerVisible: false,
          loginCtaVisible: false,
          onAuthPath: false,
          accountSignal: false,
        },
      },
    })),
  } as unknown as ChromeClient["Runtime"];
}

async function tempLatchDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "oracle-provider-quarantine-test-"));
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("chatgptDomProvider pre-run gate account-id threading (8t1 regression)", () => {
  test("trips the latch under ctx.state.accountId, not a diverging env account", async () => {
    const dir = await tempLatchDir();
    // Simulate an embedder whose BrowserRunOptions.accountId differs from
    // the process environment — e.g. a server started with an explicit
    // `options.accountId` that isn't mirrored into ORACLE_ACCOUNT_ID.
    vi.stubEnv("ORACLE_FLEET_DIR", dir);
    vi.stubEnv("ORACLE_ACCOUNT_ID", "env-account");

    const ctx: ProviderDomFlowContext = {
      prompt: "hello",
      evaluate: async () => undefined,
      delay: async () => {},
      state: {
        runtime: interstitialRuntime(),
        input: {} as ChromeClient["Input"],
        logger: () => {},
        accountId: "options-account",
        // Bypass the ChatGPT Pro FSM wrapper so this call reaches the base
        // adapter's waitForUi (the actual pre-run gate call site) directly.
        chatgptProVerification: { enabled: false },
      },
    };

    await expect(chatgptDomProvider.waitForUi(ctx)).rejects.toMatchObject({
      details: {
        stage: "challenge-gate",
        code: "challenge-gate-verification_interstitial",
        gate: "pre-run",
        retryable: false,
      },
    });

    // The authoritative accountId threaded from options must be the id the
    // latch lands under...
    expect(
      (await getQuarantineLatchState({ accountId: "options-account" })).quarantined,
    ).toBe(true);
    // ...and NOT the env-resolved account the old code would have used.
    expect(
      (await getQuarantineLatchState({ accountId: "env-account" })).quarantined,
    ).toBe(false);
  });
});

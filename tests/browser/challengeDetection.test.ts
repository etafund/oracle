// Challenge/login access-state detection and gates (browser-side half).
//
// Fixtures cover the state taxonomy (login wall, verification interstitial,
// account security block, rate limit, healthy, indeterminate), the pre-run
// and pre-result gates, quarantine-latch tripping, and the no-interaction
// property (detection is strictly read-only).

import { describe, expect, test, vi } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  QUARANTINE_STATE_CLASSES,
  RUN_REFUSAL_STATE_CLASSES,
  assertCapturedAnswerNotAccessArtifact,
  assertPreRunAccessState,
  buildAccessStateProbeExpressionForTest,
  classifyBrowserAccessFacts,
  probeBrowserAccessState,
  screenCapturedAnswerForAccessArtifacts,
  type BrowserAccessFacts,
} from "../../src/browser/actions/challengeDetection.js";
import { getQuarantineLatchState, tripQuarantineLatch } from "../../src/browser/quarantineLatch.js";
import type { ChromeClient } from "../../src/browser/types.js";

const HEALTHY_FACTS: BrowserAccessFacts = {
  url: "https://chatgpt.com/",
  title: "ChatGPT",
  interstitialTitle: false,
  interstitialScript: false,
  interstitialUrlMarker: false,
  bodySample: "how can i help you today?",
  composerPresent: true,
  composerVisible: true,
  loginCtaVisible: false,
  onAuthPath: false,
  accountSignal: true,
};

function runtimeReturning(value: unknown): ChromeClient["Runtime"] & {
  evaluate: ReturnType<typeof vi.fn>;
} {
  return {
    evaluate: vi.fn(async () => ({ result: { value } })),
  } as unknown as ChromeClient["Runtime"] & { evaluate: ReturnType<typeof vi.fn> };
}

async function tempLatchDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "oracle-challenge-test-"));
}

describe("classifyBrowserAccessFacts", () => {
  test("healthy: visible composer plus account affordance", () => {
    const report = classifyBrowserAccessFacts(HEALTHY_FACTS);
    expect(report.state).toBe("healthy");
    expect(report.composerUsable).toBe(true);
    expect(report.appSessionOk).toBe(true);
  });

  test("verification interstitial via title", () => {
    const report = classifyBrowserAccessFacts({
      ...HEALTHY_FACTS,
      title: "Just a moment...",
      interstitialTitle: true,
      composerPresent: false,
      composerVisible: false,
      accountSignal: false,
      bodySample: "verifying you are human. this may take a few seconds.",
    });
    expect(report.state).toBe("verification_interstitial");
    expect(report.signals).toContain("interstitial-title");
  });

  test("verification interstitial via URL marker alone", () => {
    const report = classifyBrowserAccessFacts({
      ...HEALTHY_FACTS,
      url: "https://chatgpt.com/cdn-cgi/challenge-platform/h/b/orchestrate",
      interstitialUrlMarker: true,
    });
    expect(report.state).toBe("verification_interstitial");
  });

  test("interstitial signals outrank login signals", () => {
    const report = classifyBrowserAccessFacts({
      ...HEALTHY_FACTS,
      interstitialScript: true,
      loginCtaVisible: true,
      composerVisible: false,
      accountSignal: false,
    });
    expect(report.state).toBe("verification_interstitial");
  });

  test("transient challenge script does not quarantine a healthy signed-in app", () => {
    const report = classifyBrowserAccessFacts({
      ...HEALTHY_FACTS,
      interstitialScript: true,
    });
    expect(report.state).toBe("healthy");
    expect(report.appSessionOk).toBe(true);
    expect(report.signals).toContain("interstitial-script");
  });

  test("authoritative challenge text still outranks a stale usable app DOM", () => {
    const report = classifyBrowserAccessFacts({
      ...HEALTHY_FACTS,
      bodySample: "verify you are human. checking your browser.",
    });
    expect(report.state).toBe("verification_interstitial");
  });

  test("account security block requires both phrases", () => {
    const blocked = classifyBrowserAccessFacts({
      ...HEALTHY_FACTS,
      composerVisible: false,
      accountSignal: false,
      bodySample:
        "suspicious activity detected on your account. secure your account to regain access.",
    });
    expect(blocked.state).toBe("account_security_block");

    const notBlocked = classifyBrowserAccessFacts({
      ...HEALTHY_FACTS,
      bodySample: "suspicious activity detected somewhere unrelated",
    });
    expect(notBlocked.state).toBe("healthy");
  });

  test("login wall via auth path", () => {
    const report = classifyBrowserAccessFacts({
      ...HEALTHY_FACTS,
      url: "https://auth.openai.com/log-in",
      onAuthPath: true,
      composerPresent: false,
      composerVisible: false,
      accountSignal: false,
      bodySample: "welcome back. log in or sign up.",
    });
    expect(report.state).toBe("login_required");
  });

  test("login wall via visible CTA without a session signal", () => {
    const report = classifyBrowserAccessFacts({
      ...HEALTHY_FACTS,
      loginCtaVisible: true,
      composerVisible: true,
      accountSignal: false,
      bodySample: "log in to get answers tailored to you",
    });
    expect(report.state).toBe("login_required");
  });

  test("a stray login-looking string does not outrank a live session", () => {
    const report = classifyBrowserAccessFacts({
      ...HEALTHY_FACTS,
      loginCtaVisible: true,
    });
    expect(report.state).toBe("healthy");
  });

  test("rate-limit surfaces classify as rate_limited", () => {
    const report = classifyBrowserAccessFacts({
      ...HEALTHY_FACTS,
      bodySample: "you are sending too many requests too quickly. please try again later.",
    });
    expect(report.state).toBe("rate_limited");
  });

  test("ordinary sidebar/task titles about rate limiters do not classify as rate_limited", () => {
    const report = classifyBrowserAccessFacts({
      ...HEALTHY_FACTS,
      bodySample:
        "chat history chatgpt pro recents api rate limiter review oracle sentinel review ready when you are.",
    });
    expect(report.state).toBe("healthy");
    expect(report.signals).not.toContain("rate-limit-text");
  });

  test("explicit quota exhaustion still classifies as rate_limited", () => {
    const report = classifyBrowserAccessFacts({
      ...HEALTHY_FACTS,
      bodySample: "rate limit exceeded. please wait a few minutes before trying again.",
    });
    expect(report.state).toBe("rate_limited");
  });

  test("no signals at all is indeterminate", () => {
    const report = classifyBrowserAccessFacts({
      ...HEALTHY_FACTS,
      composerPresent: false,
      composerVisible: false,
      accountSignal: false,
      bodySample: "",
    });
    expect(report.state).toBe("indeterminate");
  });

  test("state class policy sets are consistent", () => {
    for (const state of QUARANTINE_STATE_CLASSES) {
      expect(RUN_REFUSAL_STATE_CLASSES.has(state)).toBe(true);
    }
    expect(QUARANTINE_STATE_CLASSES.has("login_required")).toBe(false);
    expect(QUARANTINE_STATE_CLASSES.has("rate_limited")).toBe(false);
  });
});

describe("probeBrowserAccessState", () => {
  test("degrades to indeterminate when the probe cannot run", async () => {
    const runtime = {
      evaluate: vi.fn(async () => {
        throw new Error("cdp gone");
      }),
    } as unknown as ChromeClient["Runtime"];
    const report = await probeBrowserAccessState(runtime);
    expect(report.state).toBe("indeterminate");
    expect(report.signals).toContain("probe-error");
  });

  test("arbitrary evaluate results (unit-test stubs) coerce to indeterminate", async () => {
    const report = await probeBrowserAccessState(runtimeReturning({ some: "junk" }));
    expect(report.state).toBe("indeterminate");
  });
});

describe("assertPreRunAccessState", () => {
  test("healthy state passes", async () => {
    const dir = await tempLatchDir();
    const report = await assertPreRunAccessState(runtimeReturning(HEALTHY_FACTS), () => {}, {
      quarantine: { dir, accountId: "acct1" },
    });
    expect(report.state).toBe("healthy");
  });

  test("a latched worker refuses without probing the page", async () => {
    const dir = await tempLatchDir();
    await tripQuarantineLatch({
      dir,
      accountId: "acct1",
      reason: "verification_interstitial",
      source: "pre-run-gate",
    });
    const runtime = runtimeReturning(HEALTHY_FACTS);
    await expect(
      assertPreRunAccessState(runtime, () => {}, { quarantine: { dir, accountId: "acct1" } }),
    ).rejects.toMatchObject({
      details: { code: "account_quarantine", retryable: false },
    });
    expect(runtime.evaluate).not.toHaveBeenCalled();
  });

  test("verification interstitial trips the latch, then fails with a typed error", async () => {
    const dir = await tempLatchDir();
    const logs: string[] = [];
    await expect(
      assertPreRunAccessState(
        runtimeReturning({
          ...HEALTHY_FACTS,
          interstitialTitle: true,
          composerVisible: false,
          accountSignal: false,
        }),
        (m) => logs.push(String(m)),
        { quarantine: { dir, accountId: "acct1" }, runId: "run-9" },
      ),
    ).rejects.toMatchObject({
      details: {
        stage: "challenge-gate",
        code: "challenge-gate-verification_interstitial",
        gate: "pre-run",
        retryable: false,
      },
    });
    const latch = await getQuarantineLatchState({ dir, accountId: "acct1" });
    expect(latch.quarantined).toBe(true);
    expect(latch.record?.reason).toBe("verification_interstitial");
    expect(latch.record?.runId).toBe("run-9");
    expect(latch.record?.source).toBe("pre-run-gate");
    expect(logs.join("\n")).toContain("quarantine latch");
  });

  test("login walls refuse but do NOT quarantine the account", async () => {
    const dir = await tempLatchDir();
    await expect(
      assertPreRunAccessState(
        runtimeReturning({
          ...HEALTHY_FACTS,
          onAuthPath: true,
          composerVisible: false,
          accountSignal: false,
        }),
        () => {},
        { quarantine: { dir, accountId: "acct1" } },
      ),
    ).rejects.toMatchObject({
      details: { code: "challenge-gate-login_required", gate: "pre-run" },
    });
    expect(existsSync(path.join(dir, "quarantine-acct1.json"))).toBe(false);
  });

  test("rate limits refuse without quarantining", async () => {
    const dir = await tempLatchDir();
    await expect(
      assertPreRunAccessState(
        runtimeReturning({
          ...HEALTHY_FACTS,
          bodySample: "too many requests. please wait a few minutes before you try again.",
        }),
        () => {},
        { quarantine: { dir, accountId: "acct1" } },
      ),
    ).rejects.toMatchObject({
      details: { code: "challenge-gate-rate_limited" },
    });
    expect(existsSync(path.join(dir, "quarantine-acct1.json"))).toBe(false);
  });

  test("indeterminate passes browser-side (positive proof refuses; serve admission fails closed)", async () => {
    const dir = await tempLatchDir();
    const logs: string[] = [];
    const report = await assertPreRunAccessState(
      runtimeReturning(null),
      (m) => logs.push(String(m)),
      { quarantine: { dir, accountId: "acct1" } },
    );
    expect(report.state).toBe("indeterminate");
    expect(logs.join("\n")).toContain("indeterminate");
  });
});

describe("screenCapturedAnswerForAccessArtifacts", () => {
  test("an interstitial page text is an artifact", () => {
    const verdict = screenCapturedAnswerForAccessArtifacts(
      "Verify you are human. Checking your browser. This may take a few seconds. Performance & security by a network service.",
    );
    expect(verdict.artifact).toBe(true);
    expect(verdict.state).toBe("verification_interstitial");
  });

  test("challenge markup in html is an artifact regardless of text", () => {
    const verdict = screenCapturedAnswerForAccessArtifacts(
      "Done.",
      '<script src="/cdn-cgi/challenge-platform/h/b/x.js"></script>',
    );
    expect(verdict.artifact).toBe(true);
    expect(verdict.state).toBe("verification_interstitial");
  });

  test("a login wall snippet is an artifact", () => {
    const verdict = screenCapturedAnswerForAccessArtifacts(
      "Welcome back. Log in or sign up. Log in to get answers tailored to you.",
    );
    expect(verdict.artifact).toBe(true);
    expect(verdict.state).toBe("login_required");
  });

  test("a real answer that MENTIONS verification pages is not an artifact", () => {
    const verdict = screenCapturedAnswerForAccessArtifacts(
      'The phrase "verify you are human" typically appears on automated interstitial pages. ' +
        "To translate it into French you would say: « vérifiez que vous êtes humain ». " +
        "This phrasing is common on gateway pages that check browsers before allowing access.",
    );
    expect(verdict.artifact).toBe(false);
  });

  test("long content never trips the artifact screen", () => {
    const verdict = screenCapturedAnswerForAccessArtifacts(
      `verify you are human ${"analysis ".repeat(200)}`,
    );
    expect(verdict.artifact).toBe(false);
  });

  test("ordinary short answers pass", () => {
    expect(screenCapturedAnswerForAccessArtifacts("42.").artifact).toBe(false);
    expect(
      screenCapturedAnswerForAccessArtifacts("Yes — use rename() for atomicity.").artifact,
    ).toBe(false);
  });
});

describe("assertCapturedAnswerNotAccessArtifact (pre-result gate)", () => {
  test("passes a clean capture on a healthy page", async () => {
    const dir = await tempLatchDir();
    await expect(
      assertCapturedAnswerNotAccessArtifact(
        runtimeReturning(HEALTHY_FACTS),
        { text: "The answer is 42.", html: "<p>The answer is 42.</p>" },
        () => {},
        { quarantine: { dir, accountId: "acct1" } },
      ),
    ).resolves.toBeUndefined();
  });

  test("an interstitial artifact capture trips the latch and fails typed", async () => {
    const dir = await tempLatchDir();
    await expect(
      assertCapturedAnswerNotAccessArtifact(
        runtimeReturning(HEALTHY_FACTS),
        { text: "Verify you are human. Checking your browser." },
        () => {},
        { quarantine: { dir, accountId: "acct1" }, runId: "run-3" },
      ),
    ).rejects.toMatchObject({
      details: {
        code: "challenge-gate-verification_interstitial",
        gate: "pre-result",
        retryable: false,
      },
    });
    const latch = await getQuarantineLatchState({ dir, accountId: "acct1" });
    expect(latch.quarantined).toBe(true);
    expect(latch.record?.source).toBe("pre-result-gate");
  });

  test("a live interstitial at capture time fails even when the text looks clean", async () => {
    const dir = await tempLatchDir();
    await expect(
      assertCapturedAnswerNotAccessArtifact(
        runtimeReturning({
          ...HEALTHY_FACTS,
          interstitialScript: true,
          composerVisible: false,
          accountSignal: false,
        }),
        { text: "Partial answer that streamed before the page was replaced." },
        () => {},
        { quarantine: { dir, accountId: "acct1" } },
      ),
    ).rejects.toMatchObject({
      details: { code: "challenge-gate-verification_interstitial", gate: "pre-result" },
    });
    expect((await getQuarantineLatchState({ dir, accountId: "acct1" })).quarantined).toBe(true);
  });

  test("an indeterminate live probe passes (the capture already passed binding checks)", async () => {
    const dir = await tempLatchDir();
    await expect(
      assertCapturedAnswerNotAccessArtifact(
        runtimeReturning(false),
        { text: "A normal answer." },
        () => {},
        { quarantine: { dir, accountId: "acct1" } },
      ),
    ).resolves.toBeUndefined();
  });
});

describe("no-interaction property (read-only detection)", () => {
  test("the probe expression dispatches no events and drives no controls", () => {
    const expression = buildAccessStateProbeExpressionForTest();
    for (const forbidden of [
      "dispatchEvent",
      "dispatchClickSequence",
      ".click(",
      ".focus(",
      "KeyboardEvent",
      "MouseEvent",
      "InputEvent",
      "insertText",
      "submit(",
      "fetch(",
    ]) {
      expect(expression, `probe expression must not contain ${forbidden}`).not.toContain(forbidden);
    }
  });

  test("detection touches nothing on the CDP client except Runtime.evaluate", async () => {
    const accessed = new Set<string>();
    const target = {
      evaluate: async () => ({ result: { value: HEALTHY_FACTS } }),
    };
    const runtime = new Proxy(target, {
      get(obj, prop) {
        accessed.add(String(prop));
        return (obj as Record<string, unknown>)[String(prop)];
      },
    }) as unknown as ChromeClient["Runtime"];

    await probeBrowserAccessState(runtime);
    const dir = await tempLatchDir();
    await assertPreRunAccessState(runtime, () => {}, {
      quarantine: { dir, accountId: "acct1" },
    });
    expect([...accessed]).toEqual(["evaluate"]);
  });
});

// Challenge/login access-state detection and gates (browser-side half).
//
// Fixtures cover the state taxonomy (login wall, verification interstitial,
// account security block, rate limit, healthy, indeterminate), the pre-run
// and pre-result gates, quarantine-latch tripping, and the no-interaction
// property (detection is strictly read-only).

import { describe, expect, test, vi } from "vitest";
import { chmod, mkdtemp } from "node:fs/promises";
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

  test("exact interstitial title and a transient script cannot overrule a usable app", () => {
    const healthy = classifyBrowserAccessFacts({
      ...HEALTHY_FACTS,
      title: "Just a moment...",
      interstitialTitle: true,
    });
    expect(healthy.state).toBe("healthy");
    expect(healthy.appSessionOk).toBe(true);
    expect(healthy.signals).toContain("interstitial-title");

    const transientResidue = classifyBrowserAccessFacts({
      ...HEALTHY_FACTS,
      title: "Just a moment...",
      interstitialTitle: true,
      interstitialScript: true,
    });
    expect(transientResidue.state).toBe("healthy");
    expect(transientResidue.appSessionOk).toBe(true);
    expect(transientResidue.signals).toContain("interstitial-title");
    expect(transientResidue.signals).toContain("interstitial-script");

    const challenged = classifyBrowserAccessFacts({
      ...HEALTHY_FACTS,
      title: "Just a moment...",
      interstitialTitle: true,
      composerPresent: false,
      composerVisible: false,
      accountSignal: false,
      bodySample: "",
    });
    expect(challenged.state).toBe("verification_interstitial");
    expect(challenged.appSessionOk).toBe(false);
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

  test("transient title and script residue does not quarantine a usable signed-in app", async () => {
    const dir = await tempLatchDir();
    const report = await assertPreRunAccessState(
      runtimeReturning({
        ...HEALTHY_FACTS,
        title: "Just a moment...",
        interstitialTitle: true,
        interstitialScript: true,
      }),
      () => {},
      { quarantine: { dir, accountId: "acct1" } },
    );

    expect(report.state).toBe("healthy");
    expect((await getQuarantineLatchState({ dir, accountId: "acct1" })).quarantined).toBe(false);
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
    expect(logs.join("\n")).not.toContain(dir);
  });

  test("quarantine storage failure preserves the typed challenge hard stop", async () => {
    const sensitivePath = await tempLatchDir();
    const logs: string[] = [];
    // The initial latch read must see an ordinary missing file so the test
    // reaches the live challenge probe. Removing directory write permission
    // only after that setup makes the subsequent sentinel creation fail.
    await chmod(sensitivePath, 0o500);
    try {
      await expect(
        assertPreRunAccessState(
          runtimeReturning({
            ...HEALTHY_FACTS,
            interstitialTitle: true,
            composerVisible: false,
            accountSignal: false,
          }),
          (message) => logs.push(String(message)),
          { quarantine: { dir: sensitivePath, accountId: "acct1" } },
        ),
      ).rejects.toMatchObject({
        details: {
          stage: "challenge-gate",
          code: "challenge-gate-verification_interstitial",
          gate: "pre-run",
          retryable: false,
        },
      });
      expect(logs.join("\n")).toContain("preserving the terminal account-quarantine hard stop");
      expect(logs.join("\n")).not.toContain(sensitivePath);
    } finally {
      await chmod(sensitivePath, 0o700);
    }
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

  test("answer-owned challenge markup is only a signal, not an artifact by itself", () => {
    const verdict = screenCapturedAnswerForAccessArtifacts(
      "The endpoint /cdn-cgi/challenge-platform is part of this diagnostic example.",
      "<pre><code>/cdn-cgi/challenge-platform/h/b/x.js</code></pre>",
    );
    expect(verdict.artifact).toBe(false);
    expect(verdict.signals).toContain("artifact-html-marker");
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

  test("benign 'just a moment' filler is not a verification artifact", () => {
    // Regression: the generic Cloudflare title lived in the text-only artifact
    // phrase set, so a short answer that merely opened with the common filler
    // stripped to a tiny residue and self-quarantined the worker.
    expect(
      screenCapturedAnswerForAccessArtifacts("Just a moment while I think about this.").artifact,
    ).toBe(false);
    expect(
      screenCapturedAnswerForAccessArtifacts("Just a moment — here's the plan.").artifact,
    ).toBe(false);
  });

  test("a genuine Cloudflare interstitial opening with 'Just a moment' is still an artifact", () => {
    const verdict = screenCapturedAnswerForAccessArtifacts(
      "Just a moment... Verify you are human. Checking your browser. Enable JavaScript and cookies to continue.",
    );
    expect(verdict.artifact).toBe(true);
    expect(verdict.state).toBe("verification_interstitial");
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

  test("healthy page plus answer-owned challenge code does not quarantine", async () => {
    const dir = await tempLatchDir();
    await expect(
      assertCapturedAnswerNotAccessArtifact(
        runtimeReturning(HEALTHY_FACTS),
        {
          text: "The /cdn-cgi/challenge-platform path is shown here as code, not a live wall.",
          html: "<pre><code>/cdn-cgi/challenge-platform/h/b/x.js</code></pre>",
        },
        () => {},
        { quarantine: { dir, accountId: "acct1" } },
      ),
    ).resolves.toBeUndefined();
    expect((await getQuarantineLatchState({ dir, accountId: "acct1" })).quarantined).toBe(false);
  });

  test("a sibling lane's latch blocks a clean capture without probing the page", async () => {
    const dir = await tempLatchDir();
    await tripQuarantineLatch({
      dir,
      accountId: "acct1",
      reason: "verification_interstitial",
      source: "sibling-lane-test",
    });
    const runtime = runtimeReturning(HEALTHY_FACTS);

    await expect(
      assertCapturedAnswerNotAccessArtifact(
        runtime,
        { text: "A fully formed clean answer." },
        () => {},
        { quarantine: { dir, accountId: "acct1" } },
      ),
    ).rejects.toMatchObject({
      details: { code: "account_quarantine", retryable: false },
    });
    expect(runtime.evaluate).not.toHaveBeenCalled();
  });

  test("answer text alone is suppressed without publishing account quarantine", async () => {
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
        stage: "captured-access-artifact",
        code: "captured-access-artifact-verification_interstitial",
        gate: "pre-result",
        artifactState: "verification_interstitial",
        retryable: false,
      },
    });
    const latch = await getQuarantineLatchState({ dir, accountId: "acct1" });
    expect(latch.quarantined).toBe(false);
    expect(existsSync(path.join(dir, "quarantine-acct1.json"))).toBe(false);
  });

  test("an actual live wall corroborates the capture and publishes account quarantine", async () => {
    const dir = await tempLatchDir();
    await expect(
      assertCapturedAnswerNotAccessArtifact(
        runtimeReturning({
          ...HEALTHY_FACTS,
          title: "Just a moment...",
          interstitialTitle: true,
          composerVisible: false,
          accountSignal: false,
          bodySample: "verify you are human. checking your browser.",
        }),
        { text: "Verify you are human. Checking your browser." },
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

describe("pre-result probe scopes challenge text away from the captured answer", () => {
  // Regression: the pre-result live re-probe sampled the whole body INCLUDING the
  // just-captured answer, so an answer that merely quoted challenge vocabulary
  // (e.g. an agent asking Oracle about CAPTCHAs) classified a healthy signed-in
  // worker as a verification interstitial and tripped the quarantine latch.
  class ProbeElement {
    readonly nodeType = 1;
    readonly tagName = "DIV";
    readonly childNodes: Array<{ nodeType: number; nodeValue: string; childNodes: never[] }>;

    constructor(
      private readonly ownText = "",
      private readonly visible = true,
    ) {
      this.childNodes = ownText ? [{ nodeType: 3, nodeValue: ownText, childNodes: [] }] : [];
    }
    get innerText(): string {
      return this.ownText;
    }
    get textContent(): string {
      return this.ownText;
    }
    getAttribute(): string | null {
      return null;
    }
    getBoundingClientRect(): { width: number; height: number } {
      return { width: this.visible ? 120 : 0, height: this.visible ? 40 : 0 };
    }
  }

  function classifyViaProbe(opts: {
    excludeAssistantText: boolean;
    chromeText: string;
    answerText: string;
    userText?: string;
    title?: string;
    composerText?: string;
    historyText?: string;
  }): string {
    const expression = buildAccessStateProbeExpressionForTest({
      excludeAssistantText: opts.excludeAssistantText,
    });
    const composer = new ProbeElement(opts.composerText ?? "", true);
    const account = new ProbeElement("", true);
    const assistant = new ProbeElement(opts.answerText, true);
    const user = new ProbeElement(opts.userText ?? "", true);
    const history = new ProbeElement(opts.historyText ?? "", true);
    const chrome = new ProbeElement(opts.chromeText, true);
    const document = {
      title: opts.title ?? "ChatGPT",
      body: {
        nodeType: 1,
        tagName: "BODY",
        childNodes: [chrome, history, user, assistant, composer],
        getAttribute: () => null,
        innerText:
          `${opts.chromeText} ${opts.historyText ?? ""} ${opts.userText ?? ""} ` +
          `${opts.answerText} ${opts.composerText ?? ""}`.trim(),
      },
      querySelector: (selector: string) => {
        if (selector.includes("challenge-platform")) return null;
        if (selector.includes("accounts-profile-button") || selector.includes("history-item-")) {
          return account;
        }
        return composer;
      },
      querySelectorAll: (selector: string) => {
        if (
          selector.includes('author-role="assistant"') &&
          selector.includes('author-role="user"')
        ) {
          return [...(opts.answerText ? [assistant] : []), ...(opts.userText ? [user] : [])];
        }
        if (selector.includes("history-item-") || selector.includes('nav a[href*="/c/"]')) {
          return opts.historyText ? [history] : [];
        }
        if (
          selector.includes("prompt-textarea") ||
          selector.includes("composer-input") ||
          selector.includes("contenteditable")
        ) {
          return [composer];
        }
        return [];
      },
    };
    const location = { href: "https://chatgpt.com/", pathname: "/", hostname: "chatgpt.com" };
    const window = { getComputedStyle: () => ({ display: "block", visibility: "visible" }) };
    const evaluate = new Function(
      "document",
      "HTMLElement",
      "location",
      "window",
      `return ${expression};`,
    );
    const facts = evaluate(document, ProbeElement, location, window) as BrowserAccessFacts;
    return classifyBrowserAccessFacts(facts).state;
  }

  const CHALLENGE_QUOTING_ANSWER =
    'the phrase "verify you are human" appears on cloudflare interstitials; ' +
    '"checking your browser" is the same family of gateway page.';

  test("a healthy worker whose answer quotes challenge text stays healthy at the pre-result gate", () => {
    expect(
      classifyViaProbe({
        excludeAssistantText: true,
        chromeText: "how can i help you today?",
        answerText: CHALLENGE_QUOTING_ANSWER,
      }),
    ).toBe("healthy");
  });

  test("a healthy resumed conversation strips user and assistant challenge prose pre-run", () => {
    expect(
      classifyViaProbe({
        excludeAssistantText: false,
        chromeText: "how can i help you today?",
        answerText: CHALLENGE_QUOTING_ANSWER,
        userText: "Diagnose why this page says verify you are human and checking your browser.",
      }),
    ).toBe("healthy");
  });

  test("a ChatGPT conversation title containing just-a-moment prose is not a CF title", () => {
    expect(
      classifyViaProbe({
        excludeAssistantText: false,
        chromeText: "how can i help you today?",
        answerText: "A normal answer.",
        title: "Just a moment while I think — ChatGPT",
      }),
    ).toBe("healthy");
  });

  test("the exact generic title stays healthy when the probed signed-in app is usable", () => {
    expect(
      classifyViaProbe({
        excludeAssistantText: false,
        chromeText: "how can i help you today?",
        answerText: "A normal answer.",
        title: "Just a moment...",
      }),
    ).toBe("healthy");
  });

  test("a typed challenge-debug prompt in the active composer stays healthy", () => {
    expect(
      classifyViaProbe({
        excludeAssistantText: false,
        chromeText: "how can i help you today?",
        answerText: "",
        composerText: "Why does this page say verify you are human and checking your browser?",
      }),
    ).toBe("healthy");
  });

  test("a sidebar conversation title containing challenge prose stays healthy", () => {
    expect(
      classifyViaProbe({
        excludeAssistantText: false,
        chromeText: "how can i help you today?",
        answerText: "",
        historyText: "Verify you are human — browser troubleshooting",
      }),
    ).toBe("healthy");
  });

  test("excluded composer prose cannot erase identical real wall chrome", () => {
    expect(
      classifyViaProbe({
        excludeAssistantText: false,
        chromeText: "verify you are human",
        answerText: "",
        composerText: "verify you are human",
      }),
    ).toBe("verification_interstitial");
  });

  test("a real wall that replaced the page is still caught by the scoped pre-result probe", () => {
    // The wall's text lives in the page chrome, not inside an assistant turn.
    expect(
      classifyViaProbe({
        excludeAssistantText: true,
        chromeText: "verify you are human. checking your browser.",
        answerText: "",
      }),
    ).toBe("verification_interstitial");
  });
});

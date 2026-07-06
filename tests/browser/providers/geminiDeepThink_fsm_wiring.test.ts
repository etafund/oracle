// Regression suite for oracle-svt: the production Gemini Deep Think
// DOM provider must drive every adapter call through the verification
// FSM in src/browser/state/geminiDeepThink.ts. The CRITICAL invariant:
// `submitPrompt` cannot reach the underlying adapter (the real
// `btn.click()` inside src/browser/providers/geminiDeepThinkDomProvider.ts)
// unless the machine has reached `deep_think_verified_same_session`.
//
// These tests use a faked ProviderDomAdapter so we can prove the
// wrapper's contract without touching Chrome — every call is observed,
// every transition is asserted.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type {
  ProviderDomAdapter,
  ProviderDomFlowContext,
  ProviderDomResponse,
} from "../../../src/browser/providerDomFlow.js";
import {
  GeminiDeepThinkFsmError,
  geminiDeepThinkDomProviderWithFsm,
  geminiDeepThinkWithStrategyDomProviderWithFsm,
  wireGeminiDeepThinkFsm,
} from "../../../src/browser/providers/geminiDeepThinkDomProvider.js";
import {
  GEMINI_DEEP_THINK_FAILURE_STATES,
  GEMINI_DEEP_THINK_LEGAL_STATES,
} from "../../../src/browser/state/geminiDeepThink.js";
import type {
  GeminiDeepThinkMachine,
  GeminiDeepThinkState,
} from "../../../src/browser/state/geminiDeepThink.js";

interface FakeAdapterCalls {
  waitForUi: number;
  selectMode: number;
  typePrompt: number;
  submitPrompt: number;
  waitForResponse: number;
  extractThoughts: number;
}

interface FakeAdapterOptions {
  waitForUiThrows?: Error;
  selectModeThrows?: Error;
  responseText?: string;
}

function makeFakeAdapter(options: FakeAdapterOptions = {}): {
  adapter: ProviderDomAdapter;
  calls: FakeAdapterCalls;
} {
  const calls: FakeAdapterCalls = {
    waitForUi: 0,
    selectMode: 0,
    typePrompt: 0,
    submitPrompt: 0,
    waitForResponse: 0,
    extractThoughts: 0,
  };
  const adapter: ProviderDomAdapter = {
    providerName: "gemini-web-fake",
    waitForUi: async () => {
      calls.waitForUi += 1;
      if (options.waitForUiThrows) throw options.waitForUiThrows;
    },
    selectMode: async () => {
      calls.selectMode += 1;
      if (options.selectModeThrows) throw options.selectModeThrows;
    },
    typePrompt: async () => {
      calls.typePrompt += 1;
    },
    submitPrompt: async () => {
      calls.submitPrompt += 1;
    },
    waitForResponse: async (): Promise<ProviderDomResponse> => {
      calls.waitForResponse += 1;
      return { text: options.responseText ?? "deep think response" };
    },
    extractThoughts: async () => {
      calls.extractThoughts += 1;
      return null;
    },
  };
  return { adapter, calls };
}

function makeCtx(overrides: Partial<ProviderDomFlowContext> = {}): ProviderDomFlowContext {
  const evaluate: ProviderDomFlowContext["evaluate"] = async <T>(
    _expr: string,
  ): Promise<T | undefined> => undefined;
  const delay: ProviderDomFlowContext["delay"] = async (_ms: number): Promise<void> => {};
  const log: ProviderDomFlowContext["log"] = () => {};
  return {
    prompt: "hello deep think",
    evaluate,
    delay,
    log,
    ...overrides,
  };
}

describe("wireGeminiDeepThinkFsm — adapter wrapper invariants (oracle-svt)", () => {
  it("happy path drives the FSM into output_captured_nonempty", async () => {
    const { adapter, calls } = makeFakeAdapter();
    const wired = wireGeminiDeepThinkFsm(adapter);
    const ctx = makeCtx();

    await wired.waitForUi(ctx);
    await wired.selectMode!(ctx);
    await wired.typePrompt(ctx);
    await wired.submitPrompt(ctx);
    await wired.waitForResponse(ctx);

    expect(calls.waitForUi).toBe(1);
    expect(calls.selectMode).toBe(1);
    expect(calls.typePrompt).toBe(1);
    expect(calls.submitPrompt).toBe(1);
    expect(calls.waitForResponse).toBe(1);

    const verdict = wired.getVerdict();
    expect(verdict.verified).toBe(false); // success requires evidence_written + finish
    expect(verdict.errorCode).toBeNull();
    expect(verdict.state).toBe<GeminiDeepThinkState>("output_captured_nonempty");
  });

  it("CRITICAL: submitPrompt without selectMode never invokes the underlying adapter", async () => {
    // This is the heart of the bug oracle-svt addresses: the live
    // executor previously called the bare provider directly, so a UI
    // drift that bypassed Deep Think activation could still click the
    // send button. The wrapper MUST gate the click.
    const { adapter, calls } = makeFakeAdapter();
    const wired = wireGeminiDeepThinkFsm(adapter);
    const ctx = makeCtx();

    await wired.waitForUi(ctx);
    // Deliberately skip selectMode — the FSM is now in `login_verified`,
    // not `deep_think_verified_same_session`.
    await wired.typePrompt(ctx);

    await expect(wired.submitPrompt(ctx)).rejects.toBeInstanceOf(GeminiDeepThinkFsmError);
    // The underlying adapter's submitPrompt must NOT have been called.
    expect(calls.submitPrompt, "underlying submitPrompt was invoked").toBe(0);

    const verdict = wired.getVerdict();
    expect(verdict.state).toBe<GeminiDeepThinkState>("prompt_submitted_before_verification");
    expect(verdict.errorCode).toBe("prompt_submitted_before_verification");
  });

  it("login-style error during waitForUi lands FSM in login_required", async () => {
    const { adapter, calls } = makeFakeAdapter({
      waitForUiThrows: new Error(
        "Gemini is showing a sign-in flow. Please sign in in Chrome and retry.",
      ),
    });
    const wired = wireGeminiDeepThinkFsm(adapter);
    const ctx = makeCtx();

    await expect(wired.waitForUi(ctx)).rejects.toThrow(/sign-in flow/);
    const verdict = wired.getVerdict();
    expect(verdict.state).toBe<GeminiDeepThinkState>("login_required");
    expect(verdict.errorCode).toBe("provider_login_required");
    expect(calls.selectMode + calls.submitPrompt).toBe(0);
  });

  it("non-login waitForUi failure lands FSM in ui_drift_suspected", async () => {
    const { adapter } = makeFakeAdapter({
      waitForUiThrows: new Error("Timed out waiting for Gemini UI prompt input to become ready."),
    });
    const wired = wireGeminiDeepThinkFsm(adapter);
    await expect(wired.waitForUi(makeCtx())).rejects.toThrow(/Timed out/);
    const verdict = wired.getVerdict();
    expect(verdict.state).toBe<GeminiDeepThinkState>("ui_drift_suspected");
    expect(verdict.errorCode).toBe("ui_drift_suspected");
  });

  it("selectMode failure lands FSM in ui_drift_suspected and gates submitPrompt", async () => {
    const { adapter, calls } = makeFakeAdapter({
      selectModeThrows: new Error('Unable to select "Deep Think" from Gemini tools menu.'),
    });
    const wired = wireGeminiDeepThinkFsm(adapter);
    const ctx = makeCtx();

    await wired.waitForUi(ctx);
    await expect(wired.selectMode!(ctx)).rejects.toThrow(/Deep Think/);
    expect(wired.getVerdict().state).toBe<GeminiDeepThinkState>("ui_drift_suspected");

    // Even though the wrapper is in a failure state, the test confirms
    // that submitPrompt does NOT silently call the underlying click.
    await expect(wired.submitPrompt(ctx)).rejects.toBeInstanceOf(GeminiDeepThinkFsmError);
    expect(calls.submitPrompt).toBe(0);
  });

  it("empty response transitions FSM to output_empty failure", async () => {
    const { adapter } = makeFakeAdapter({ responseText: "" });
    const wired = wireGeminiDeepThinkFsm(adapter);
    const ctx = makeCtx();

    await wired.waitForUi(ctx);
    await wired.selectMode!(ctx);
    await wired.typePrompt(ctx);
    await wired.submitPrompt(ctx);
    await expect(wired.waitForResponse(ctx)).rejects.toBeInstanceOf(GeminiDeepThinkFsmError);

    const verdict = wired.getVerdict();
    expect(verdict.state).toBe<GeminiDeepThinkState>("output_empty");
    expect(verdict.errorCode).toBe("output_capture_empty");
  });

  it("onTransition observer fires after each FSM transition", async () => {
    const transitions: GeminiDeepThinkState[] = [];
    const { adapter } = makeFakeAdapter();
    const wired = wireGeminiDeepThinkFsm(adapter, {
      onTransition: (m: GeminiDeepThinkMachine) => transitions.push(m.state),
    });
    const ctx = makeCtx();

    await wired.waitForUi(ctx);
    await wired.selectMode!(ctx);
    await wired.typePrompt(ctx);
    await wired.submitPrompt(ctx);
    await wired.waitForResponse(ctx);

    // The exact transition list — proves we walk every state on the
    // happy path through the legal-state ladder.
    expect(transitions).toEqual([
      "remote_or_local_browser_connected",
      "login_verified",
      "gemini_model_candidate_selected",
      "deep_think_menu_open",
      "deep_think_candidate_selected",
      "deep_think_verified_same_session",
      "prompt_submitted",
      "response_streaming",
      "output_captured_nonempty",
    ] satisfies GeminiDeepThinkState[]);
  });

  it("geminiDeepThinkDomProviderWithFsm() returns a fresh machine each call", () => {
    const a = geminiDeepThinkDomProviderWithFsm();
    const b = geminiDeepThinkDomProviderWithFsm();
    expect(a.getMachine()).not.toBe(b.getMachine());
    expect(a.getMachine().state).toBe<GeminiDeepThinkState>("session_start");
    expect(b.getMachine().state).toBe<GeminiDeepThinkState>("session_start");
    // Both must implement the public ProviderDomAdapter contract.
    expect(a.providerName).toBe("gemini-web");
    expect(typeof a.submitPrompt).toBe("function");
  });

  it("FSM state types match the source-of-truth state list", () => {
    // Belt-and-suspenders: catches drift between this test's expected
    // transitions and the FSM's legal/failure lists.
    expect(GEMINI_DEEP_THINK_LEGAL_STATES).toContain("deep_think_verified_same_session");
    expect(GEMINI_DEEP_THINK_LEGAL_STATES).toContain("output_captured_nonempty");
    expect(GEMINI_DEEP_THINK_FAILURE_STATES).toContain("prompt_submitted_before_verification");
    expect(GEMINI_DEEP_THINK_FAILURE_STATES).toContain("output_empty");
  });
});

describe("high-if-exposed thinking-level strategy wiring (dead-code regression)", () => {
  // Regression for: the 'high-if-exposed' Deep Think strategy variant
  // (geminiDeepThinkWithStrategyDomProviderWithFsm) was exported but the
  // live executor consumed the bare geminiDeepThinkDomProviderWithFsm, so
  // live runs never attempted to click Gemini's 'high' thinking-level
  // control even when the UI exposed it.

  /**
   * Builds a ProviderDomFlowContext whose evaluate() plays a Gemini page
   * that exposes the thinking-level control, keyed on distinctive
   * substrings of the real provider's evaluate expressions. The page
   * defaults the control to "Standard"; only the high-if-exposed
   * strategy's click moves it to "High".
   */
  function makeStrategyCtx(options: { thinkingLevelLabels?: readonly string[] } = {}): {
    ctx: ProviderDomFlowContext;
    thinkingLevelEvals: string[];
    logs: string[];
  } {
    const thinkingLevelEvals: string[] = [];
    const logs: string[] = [];
    const labels = options.thinkingLevelLabels ?? ["Standard", "High"];
    let highClicked = false;
    const evaluate: ProviderDomFlowContext["evaluate"] = async <T>(
      expr: string,
    ): Promise<T | undefined> => {
      if (expr.includes("observedThinkingLevelLabels")) {
        // The wired selectMode's read-only post-selection DOM probe
        // (probeDeepThinkSelectionState) — reports what the page shows.
        return {
          deepThinkLabel: "Deselect Deep Think",
          thinkingLevelControlExposed: true,
          observedThinkingLevelLabels: labels,
          selectedThinkingLevel: highClicked ? "High" : "Standard",
        } as T;
      }
      if (expr.includes(".thinking-level-option")) {
        // applyHighIfExposedStrategy's click probe.
        thinkingLevelEvals.push(expr);
        highClicked = true;
        return { clicked: true, label: "high" } as T;
      }
      if (expr.includes("requiresLogin")) {
        // waitForUi readiness probe.
        return { ready: true, requiresLogin: false } as T;
      }
      if (expr.includes("label.includes('deep think')")) {
        // selectMode's "Deep Think is active" verification probe.
        return true as T;
      }
      // Tools-button / menu-item click probes.
      return "clicked" as T;
    };
    const ctx: ProviderDomFlowContext = {
      prompt: "hello deep think",
      evaluate,
      delay: async () => {},
      log: (msg: string) => logs.push(msg),
    };
    return { ctx, thinkingLevelEvals, logs };
  }

  it("strategy variant clicks the 'high' control during selectMode when exposed", async () => {
    const wired = geminiDeepThinkWithStrategyDomProviderWithFsm();
    const { ctx, thinkingLevelEvals, logs } = makeStrategyCtx();

    await wired.waitForUi(ctx);
    await wired.selectMode!(ctx);

    expect(thinkingLevelEvals, "high-if-exposed strategy never probed the control").toHaveLength(
      1,
    );
    expect(logs.some((l) => l.includes("Selected high thinking level"))).toBe(true);
    // The strategy must not derail the verification FSM.
    expect(wired.getMachine().state).toBe<GeminiDeepThinkState>(
      "deep_think_verified_same_session",
    );
    // Regression (hardcoded-label bug): the candidate event must carry
    // the OBSERVED DOM state, not a literal — the recorded verdict
    // proves the thinking-level checks actually ran.
    const deepThink = wired.getMachine().context.deepThink;
    expect(deepThink?.thinkingLevelControlExposed).toBe(true);
    expect(deepThink?.selected).toBe("High");
    expect(deepThink?.tier).toBe("high");
    expect(deepThink?.selectedIsHighestVisible).toBe(true);
    expect(deepThink?.observedLabels).toContain("Standard");
    expect(deepThink?.observedLabels).toContain("High");
  });

  it("bare variant never clicks the thinking-level control, and the FSM now catches the non-high selection", async () => {
    // Proves the previous assertion actually distinguishes the variants:
    // wiring the bare provider (the old executor behavior) skips 'high'.
    // Since the wrapper forwards live DOM state into
    // deep_think_candidate_selected, leaving the exposed control on
    // "Standard" is no longer trivially verified — the FSM rejects it.
    const wired = geminiDeepThinkDomProviderWithFsm();
    const { ctx, thinkingLevelEvals } = makeStrategyCtx();

    await wired.waitForUi(ctx);
    await expect(wired.selectMode!(ctx)).rejects.toBeInstanceOf(GeminiDeepThinkFsmError);

    expect(thinkingLevelEvals).toHaveLength(0);
    const verdict = wired.getVerdict();
    expect(verdict.state).toBe<GeminiDeepThinkState>("deep_think_unverified");
    expect(verdict.errorCode).toBe("gemini_deep_think_unverified");
    expect(verdict.failureReason).toMatch(/not the highest visible option/i);
  });

  it("regression: drifted thinking-level labels land the FSM in ui_drift_suspected during selectMode", async () => {
    // Before the fix, selectMode sent a hardcoded
    // `{ deepThinkLabel: 'deep think' }` event, so verification always
    // took the trivial "no control exposed" branch and unknown effort
    // labels (UI drift) could never be detected on a live run.
    const wired = geminiDeepThinkWithStrategyDomProviderWithFsm();
    const { ctx } = makeStrategyCtx({ thinkingLevelLabels: ["Turbo Max", "Ludicrous"] });

    await wired.waitForUi(ctx);
    await expect(wired.selectMode!(ctx)).rejects.toBeInstanceOf(GeminiDeepThinkFsmError);

    const verdict = wired.getVerdict();
    expect(verdict.state).toBe<GeminiDeepThinkState>("ui_drift_suspected");
    expect(verdict.errorCode).toBe("ui_drift_suspected");
  });

  it("live executor wires the strategy variant, not the bare provider", () => {
    // Guards the executor.ts wiring itself: the strategy variant must be
    // the one constructed for live DOM runs. A pure-source check is used
    // because the executor's DOM path cannot run without Chrome.
    const executorSource = readFileSync(
      fileURLToPath(new URL("../../../src/gemini-web/executor.ts", import.meta.url)),
      "utf8",
    );
    expect(executorSource).toMatch(/\bgeminiDeepThinkWithStrategyDomProviderWithFsm\s*\(\s*\)/);
    // The bare variant must not be referenced anywhere in the executor.
    // (Note: the bare name is not a substring of the strategy name.)
    expect(executorSource).not.toMatch(/\bgeminiDeepThinkDomProviderWithFsm\b/);
  });
});

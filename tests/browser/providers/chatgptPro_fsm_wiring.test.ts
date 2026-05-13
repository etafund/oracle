// Regression suite for oracle-byl: production ChatGPT DOM submission
// must drive the ChatGPT Pro verification FSM and consult the
// synthesis gate before the real send-click adapter is allowed to run.

import { describe, expect, it } from "vitest";

import type {
  ProviderDomAdapter,
  ProviderDomFlowContext,
  ProviderDomResponse,
} from "../../../src/browser/providerDomFlow.js";
import {
  ChatGptProFsmError,
  chatgptDomProvider,
  wireChatGptProFsm,
} from "../../../src/browser/providers/chatgptDomProvider.js";
import { ChatGptProSynthesisGateError } from "../../../src/browser/providers/chatgptPro_synthesis_gate.js";
import type {
  ChatGptProMachine,
  ChatGptProState,
} from "../../../src/browser/providers/chatgptProVerification.js";

const SESSION_HASH = `sha256:${"a".repeat(64)}` as const;
const PROMPT_HASH = `sha256:${"b".repeat(64)}` as const;
const OUTPUT_HASH = `sha256:${"c".repeat(64)}` as const;

interface FakeAdapterCalls {
  waitForUi: number;
  selectMode: number;
  typePrompt: number;
  submitPrompt: number;
  waitForResponse: number;
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
  };
  const adapter: ProviderDomAdapter = {
    providerName: "chatgpt-web-fake",
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
      return { text: options.responseText ?? "verified ChatGPT Pro response" };
    },
  };
  return { adapter, calls };
}

function makeCtx(overrides: {
  modelLabel?: string;
  observedEffortLabels?: readonly string[];
  liveModelLabel?: string;
} = {}): ProviderDomFlowContext {
  const modelLabel = overrides.modelLabel ?? "GPT-5.5 Pro";
  const observedEffortLabels = overrides.observedEffortLabels ?? ["Standard", "Heavy"];
  const liveModelLabel = overrides.liveModelLabel ?? modelLabel;
  return {
    prompt: "hello ChatGPT Pro",
    evaluate: async <T>(): Promise<T | undefined> => undefined,
    delay: async () => {},
    log: () => {},
    state: {
      runtime: {
        evaluate: async () => ({
          result: {
            value: {
              modelLabel,
              effortLabels: observedEffortLabels,
              selectedEffortLabel: "Heavy",
              authenticated: true,
              promptReady: true,
              sendExists: true,
              targetId: "target-1",
              url: "https://chatgpt.com/c/abc",
              conversationId: "abc",
              fingerprint: "target-1::GPT-5.5 Pro::Heavy",
            },
          },
        }),
      },
      input: {},
      logger: () => {},
      timeoutMs: 100,
      chatgptProVerification: {
        mode: "remote",
        accessPath: "oracle_browser_remote",
        sessionIdHash: SESSION_HASH,
        modelLabel,
        observedEffortLabels,
        liveTab: {
          targetId: "target-1",
          currentModelLabel: liveModelLabel,
          authenticated: true,
          promptReady: true,
          sendExists: true,
          state: "completed",
        },
        cookies: {
          appliedCount: 1,
          source: "test-cookie-store",
        },
        session: {
          sessionIdHash: SESSION_HASH,
          liveSessionIdHash: SESSION_HASH,
          verifiedAt: "2026-05-13T00:00:00.000Z",
          lastActivityAt: "2026-05-13T00:00:01.000Z",
          now: "2026-05-13T00:00:02.000Z",
          staleAfterMs: 60_000,
          verifiedTargetId: "target-1",
          liveTargetId: "target-1",
        },
      },
    },
  };
}

describe("wireChatGptProFsm — adapter wrapper invariants (oracle-byl)", () => {
  it("happy path drives the FSM through mode verification, gate, submit, and output capture", async () => {
    const transitions: ChatGptProState[] = [];
    const { adapter, calls } = makeFakeAdapter();
    const wired = wireChatGptProFsm(adapter, {
      promptSha256: () => PROMPT_HASH,
      outputSha256: () => OUTPUT_HASH,
      onTransition: (machine: ChatGptProMachine) => transitions.push(machine.state),
      now: () => new Date("2026-05-13T00:00:02.000Z"),
    });
    const ctx = makeCtx();

    await wired.waitForUi(ctx);
    await wired.selectMode!(ctx);
    await wired.typePrompt(ctx);
    await wired.submitPrompt(ctx);
    await wired.waitForResponse(ctx);

    expect(calls).toMatchObject({
      waitForUi: 1,
      selectMode: 1,
      typePrompt: 1,
      submitPrompt: 1,
      waitForResponse: 1,
    });

    expect(transitions).toEqual([
      "remote_or_local_browser_connected",
      "login_verified",
      "chatgpt_model_menu_open",
      "pro_candidate_selected",
      "extended_reasoning_candidate_selected",
      "mode_verified_same_session",
      "prompt_submitted",
      "output_captured",
    ] satisfies ChatGptProState[]);
    expect(wired.getLastSynthesisGateDecision()).toMatchObject({
      ok: true,
      can_submit_prompt: true,
      mode_verified_same_session: true,
      selected_effort_is_highest_visible: true,
    });
    expect(wired.getVerdict()).toMatchObject({
      state: "output_captured",
      errorCode: null,
      failureReason: null,
    });
  });

  it("CRITICAL: submitPrompt without mode verification never invokes the underlying adapter", async () => {
    const { adapter, calls } = makeFakeAdapter();
    const wired = wireChatGptProFsm(adapter, {
      promptSha256: () => PROMPT_HASH,
    });
    const ctx = makeCtx();

    await wired.waitForUi(ctx);
    await wired.typePrompt(ctx);

    await expect(wired.submitPrompt(ctx)).rejects.toBeInstanceOf(ChatGptProFsmError);
    expect(calls.submitPrompt, "underlying submitPrompt was invoked").toBe(0);
    expect(wired.getVerdict()).toMatchObject({
      state: "prompt_submitted_before_verification",
      errorCode: "prompt_submitted_before_verification",
    });
    expect(wired.getLastSynthesisGateDecision()).toBeNull();
  });

  it("consults the synthesis gate before the send click and blocks stale live-tab mismatches", async () => {
    const { adapter, calls } = makeFakeAdapter();
    const wired = wireChatGptProFsm(adapter, {
      promptSha256: () => PROMPT_HASH,
      now: () => new Date("2026-05-13T00:00:02.000Z"),
    });
    const ctx = makeCtx({ liveModelLabel: "GPT-5.5 Thinking" });

    await wired.waitForUi(ctx);
    await wired.selectMode!(ctx);

    await expect(wired.submitPrompt(ctx)).rejects.toBeInstanceOf(ChatGptProSynthesisGateError);
    expect(calls.submitPrompt, "underlying submitPrompt was invoked").toBe(0);
    expect(wired.getVerdict()).toMatchObject({
      state: "mode_verified_same_session",
      errorCode: null,
    });
  });

  it("selectMode failure lands the FSM in ui_drift_suspected and gates submitPrompt", async () => {
    const { adapter, calls } = makeFakeAdapter({
      selectModeThrows: new Error("ChatGPT model picker drifted"),
    });
    const wired = wireChatGptProFsm(adapter);
    const ctx = makeCtx();

    await wired.waitForUi(ctx);
    await expect(wired.selectMode!(ctx)).rejects.toThrow(/drifted/);
    expect(wired.getVerdict()).toMatchObject({
      state: "ui_drift_suspected",
      errorCode: "ui_drift_suspected",
    });

    await expect(wired.submitPrompt(ctx)).rejects.toBeInstanceOf(ChatGptProFsmError);
    expect(calls.submitPrompt).toBe(0);
  });

  it("exported production provider includes the protected selectMode gate", () => {
    expect(chatgptDomProvider.providerName).toBe("chatgpt-web");
    expect(typeof chatgptDomProvider.selectMode).toBe("function");
  });
});

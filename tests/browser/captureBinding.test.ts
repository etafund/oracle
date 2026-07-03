// Structural capture binding (oracle-router-structural-message-binding-wrl):
// the captured assistant message must be provably bound to THIS run's own
// submitted user message, in the same conversation from submit to capture.
// These tests drive the post-capture validation layer with mocked CDP
// runtimes; DOM semantics live in the generated expressions and are asserted
// structurally below.

import { describe, expect, test, vi } from "vitest";

import {
  assertCapturedAssistantResponseBound,
  buildCaptureBindingFactsExpressionForTest,
  buildFreshCaptureTargetProbeExpressionForTest,
  buildSubmittedUserMessageProbeExpressionForTest,
  computePromptSha256,
  evaluateCaptureBindingFacts,
  getSubmittedUserMessageBinding,
  isConversationUrl,
  normalizePromptForDomMatch,
  registerSubmittedUserMessage,
  type CaptureBindingFacts,
  type SubmittedUserMessageBinding,
} from "../../src/browser/actions/captureBinding.js";
import type { ChromeClient } from "../../src/browser/types.js";

vi.mock("../../src/browser/actions/assistantResponse.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/browser/actions/assistantResponse.js")>();
  return {
    ...actual,
    waitForAssistantResponse: vi.fn(async () => ({
      text: "Captured answer",
      html: "<p>Captured answer</p>",
      meta: { messageId: "assistant-msg-1", turnId: "conversation-turn-3" },
    })),
  };
});

import { waitForAssistantResponse } from "../../src/browser/pageActions.js";

type EvaluateResult = { result: { value: unknown } };

function runtimeWithValues(values: unknown[]): ChromeClient["Runtime"] & {
  evaluate: ReturnType<typeof vi.fn>;
} {
  const queue = [...values];
  const evaluate = vi.fn(async (): Promise<EvaluateResult> => {
    const value = queue.length > 1 ? queue.shift() : queue[0];
    return { result: { value } };
  });
  return { evaluate } as unknown as ChromeClient["Runtime"] & {
    evaluate: ReturnType<typeof vi.fn>;
  };
}

const HANDLE_PROBE_RESULT = {
  found: true,
  matchedPrompt: true,
  conversationId: "run-conv-1",
  userMessageId: "user-msg-1",
  userTurnTestId: "conversation-turn-2",
};

const GOOD_FACTS: CaptureBindingFacts = {
  conversationId: "run-conv-1",
  userTurnFound: true,
  userTurnIsLatestUserTurn: true,
  capturedNodeFound: true,
  capturedFollowsUserMessage: true,
  interveningAssistantTurns: 0,
  assistantTurnAfterUserMessage: true,
};

const CAPTURED_META = { messageId: "assistant-msg-1", turnId: "conversation-turn-3" };

async function registeredRuntime(
  probeResult: unknown = HANDLE_PROBE_RESULT,
  factsResults: unknown[] = [GOOD_FACTS],
): Promise<ReturnType<typeof runtimeWithValues>> {
  const runtime = runtimeWithValues([probeResult, ...factsResults]);
  await registerSubmittedUserMessage(runtime, "What is the answer?", () => {});
  return runtime;
}

describe("registerSubmittedUserMessage", () => {
  test("stores a message-handle binding with the submitted prompt hash", async () => {
    const logs: string[] = [];
    const runtime = runtimeWithValues([HANDLE_PROBE_RESULT]);
    const binding = await registerSubmittedUserMessage(runtime, "What is the answer?", (m) =>
      logs.push(String(m)),
    );

    expect(binding.quality).toBe("message-handle");
    expect(binding.userMessageId).toBe("user-msg-1");
    expect(binding.userTurnTestId).toBe("conversation-turn-2");
    expect(binding.conversationId).toBe("run-conv-1");
    expect(binding.promptSha256).toBe(computePromptSha256("What is the answer?"));
    expect(getSubmittedUserMessageBinding(runtime)).toEqual(binding);
    expect(logs.join("\n")).toContain(`sha256 ${binding.promptSha256}`);
  });

  test("degrades to conversation-only when the user turn cannot be located", async () => {
    const logs: string[] = [];
    const runtime = runtimeWithValues([
      { found: false, matchedPrompt: false, conversationId: "run-conv-2" },
    ]);
    const binding = await registerSubmittedUserMessage(runtime, "prompt", (m) =>
      logs.push(String(m)),
    );

    expect(binding.quality).toBe("conversation-only");
    expect(binding.conversationId).toBe("run-conv-2");
    expect(logs.join("\n")).toContain("conversation-level binding");
  });

  test("never throws when the DOM probe fails", async () => {
    const runtime = {
      evaluate: vi.fn(async () => {
        throw new Error("cdp gone");
      }),
    } as unknown as ChromeClient["Runtime"];
    const binding = await registerSubmittedUserMessage(runtime, "prompt", () => {});
    expect(binding.quality).toBe("conversation-only");
    expect(getSubmittedUserMessageBinding(runtime)).toEqual(binding);
  });
});

describe("assertCapturedAssistantResponseBound", () => {
  test("is a no-op when no binding was registered for the runtime", async () => {
    const runtime = runtimeWithValues([GOOD_FACTS]);
    await expect(
      assertCapturedAssistantResponseBound(runtime, CAPTURED_META, () => {}),
    ).resolves.toBeNull();
    expect(runtime.evaluate).not.toHaveBeenCalled();
  });

  test("accepts a capture bound to this run's own user message", async () => {
    const runtime = await registeredRuntime();
    await expect(
      assertCapturedAssistantResponseBound(runtime, CAPTURED_META, () => {}),
    ).resolves.toMatchObject({ capturedFollowsUserMessage: true });
  });

  test("adopts the conversation id assigned after submit", async () => {
    const runtime = await registeredRuntime({ ...HANDLE_PROBE_RESULT, conversationId: null }, [
      { ...GOOD_FACTS, conversationId: "assigned-later" },
    ]);
    await assertCapturedAssistantResponseBound(runtime, CAPTURED_META, () => {});
    expect(getSubmittedUserMessageBinding(runtime)?.conversationId).toBe("assigned-later");
  });

  test("fails loud when the conversation changed between submit and capture", async () => {
    const runtime = await registeredRuntime(HANDLE_PROBE_RESULT, [
      { ...GOOD_FACTS, conversationId: "other-conv" },
    ]);
    await expect(
      assertCapturedAssistantResponseBound(runtime, CAPTURED_META, () => {}),
    ).rejects.toMatchObject({
      details: { code: "capture-binding-conversation-changed" },
    });
  });

  test("rejects a capture when this run's user message vanished", async () => {
    const runtime = await registeredRuntime(HANDLE_PROBE_RESULT, [
      { ...GOOD_FACTS, userTurnFound: false },
    ]);
    await expect(
      assertCapturedAssistantResponseBound(runtime, CAPTURED_META, () => {}),
    ).rejects.toMatchObject({
      details: { code: "capture-binding-user-message-missing" },
    });
  });

  test("rejects cross-talk: a foreign user message superseded this run's own", async () => {
    const runtime = await registeredRuntime(HANDLE_PROBE_RESULT, [
      { ...GOOD_FACTS, userTurnIsLatestUserTurn: false },
    ]);
    await expect(
      assertCapturedAssistantResponseBound(runtime, CAPTURED_META, () => {}),
    ).rejects.toMatchObject({
      details: { code: "capture-binding-user-message-superseded" },
    });
  });

  test("rejects a stale assistant message that precedes this run's user message", async () => {
    const runtime = await registeredRuntime(HANDLE_PROBE_RESULT, [
      { ...GOOD_FACTS, capturedFollowsUserMessage: false },
    ]);
    await expect(
      assertCapturedAssistantResponseBound(runtime, CAPTURED_META, () => {}),
    ).rejects.toMatchObject({
      details: { code: "capture-binding-response-precedes-user-message" },
    });
  });

  test("rejects id-less captures when no assistant message follows the user message (stale prior content)", async () => {
    const runtime = await registeredRuntime(HANDLE_PROBE_RESULT, [
      { ...GOOD_FACTS, capturedNodeFound: false, assistantTurnAfterUserMessage: false },
    ]);
    await expect(assertCapturedAssistantResponseBound(runtime, {}, () => {})).rejects.toMatchObject(
      {
        details: { code: "capture-binding-no-assistant-after-user-message" },
      },
    );
  });

  test("warns (but accepts) this run's own multi-part response sequence", async () => {
    const logs: string[] = [];
    const runtime = await registeredRuntime(HANDLE_PROBE_RESULT, [
      { ...GOOD_FACTS, interveningAssistantTurns: 1 },
    ]);
    await expect(
      assertCapturedAssistantResponseBound(runtime, CAPTURED_META, (m) => logs.push(String(m))),
    ).resolves.toBeTruthy();
    expect(logs.join("\n")).toContain("not the first reply");
  });

  test("retries the DOM probe before failing", async () => {
    const runtime = await registeredRuntime(HANDLE_PROBE_RESULT, [
      { ...GOOD_FACTS, userTurnFound: false },
    ]);
    await expect(
      assertCapturedAssistantResponseBound(runtime, CAPTURED_META, () => {}),
    ).rejects.toThrow(/structural binding validation/);
    // 1 registration probe + 3 validation attempts.
    expect(runtime.evaluate).toHaveBeenCalledTimes(4);
  });

  test("fails loud when the probe never returns verifiable facts", async () => {
    const runtime = await registeredRuntime(HANDLE_PROBE_RESULT, ["not-an-object"]);
    await expect(
      assertCapturedAssistantResponseBound(runtime, CAPTURED_META, () => {}),
    ).rejects.toMatchObject({
      details: { code: "capture-binding-verification-unavailable" },
    });
  });
});

describe("evaluateCaptureBindingFacts", () => {
  const binding: SubmittedUserMessageBinding = {
    promptSha256: computePromptSha256("prompt"),
    promptLength: 6,
    promptPrefix: "prompt prefix long enough to matter",
    registeredAtMs: 0,
    quality: "message-handle",
    conversationId: "run-conv-1",
    userMessageId: "user-msg-1",
    userTurnTestId: "conversation-turn-2",
  };

  test("conversation-only bindings still fail loud on conversation change", () => {
    const verdict = evaluateCaptureBindingFacts(
      { ...binding, quality: "conversation-only", userMessageId: null, userTurnTestId: null },
      CAPTURED_META,
      { ...GOOD_FACTS, conversationId: "other" },
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.code).toBe("capture-binding-conversation-changed");
  });

  test("conversation-only bindings fail when the captured node vanished", () => {
    const verdict = evaluateCaptureBindingFacts(
      { ...binding, quality: "conversation-only" },
      CAPTURED_META,
      { ...GOOD_FACTS, capturedNodeFound: false },
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.code).toBe("capture-binding-captured-node-missing");
  });

  test("losing the bound conversation entirely is a failure", () => {
    const verdict = evaluateCaptureBindingFacts(binding, CAPTURED_META, {
      ...GOOD_FACTS,
      conversationId: null,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.code).toBe("capture-binding-conversation-changed");
  });
});

describe("capture facade (pageActions.waitForAssistantResponse)", () => {
  test("rejects a capture that fails structural binding validation", async () => {
    const runtime = await registeredRuntime(HANDLE_PROBE_RESULT, [
      { ...GOOD_FACTS, capturedFollowsUserMessage: false },
    ]);
    await expect(waitForAssistantResponse(runtime, 1_000, () => {})).rejects.toThrow(
      /structural binding validation/,
    );
  });

  test("returns the capture when structural binding validation passes", async () => {
    const runtime = await registeredRuntime();
    await expect(waitForAssistantResponse(runtime, 1_000, () => {})).resolves.toMatchObject({
      text: "Captured answer",
    });
  });
});

describe("generated DOM expressions", () => {
  test("submit probe binds against conversation turns, not body text", () => {
    const expression = buildSubmittedUserMessageProbeExpressionForTest("What is the answer?");
    expect(expression).toContain("conversation-turn");
    expect(expression).toContain("data-message-id");
    expect(expression).toContain("data-message-author-role");
    expect(expression).not.toContain("document.body.innerText");
  });

  test("facts probe proves document order relative to this run's user message", () => {
    const binding: SubmittedUserMessageBinding = {
      promptSha256: "0".repeat(64),
      promptLength: 10,
      promptPrefix: "a prefix that is definitely longer than thirty chars",
      registeredAtMs: 0,
      quality: "message-handle",
      conversationId: "conv",
      userMessageId: "user-msg-1",
      userTurnTestId: "conversation-turn-2",
    };
    const expression = buildCaptureBindingFactsExpressionForTest(binding, CAPTURED_META);
    expect(expression).toContain("compareDocumentPosition");
    expect(expression).toContain("DOCUMENT_POSITION_FOLLOWING");
    expect(expression).toContain('"user-msg-1"');
    expect(expression).toContain('"assistant-msg-1"');
    expect(expression).toContain("interveningAssistantTurns");
    expect(expression).not.toContain("document.body.innerText");
  });

  test("fresh-target probe reports conversation id and assistant turn count", () => {
    const expression = buildFreshCaptureTargetProbeExpressionForTest();
    expect(expression).toContain("assistantTurnCount");
    expect(expression).toContain("conversation-turn");
  });
});

describe("helpers", () => {
  test("isConversationUrl matches only /c/<id> URLs", () => {
    expect(isConversationUrl("https://chatgpt.com/c/abc-123")).toBe(true);
    expect(isConversationUrl("https://chatgpt.com/?model=gpt-5-pro")).toBe(false);
    expect(isConversationUrl("https://chatgpt.com/g/g-p-project/project")).toBe(false);
  });

  test("normalizePromptForDomMatch strips fence markers and collapses whitespace", () => {
    expect(normalizePromptForDomMatch("Review ```ts\nconst a = 1;\n```  now")).toBe(
      "review const a = 1; now",
    );
  });
});

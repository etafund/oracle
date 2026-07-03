// Start-of-run blank-state assertion (oracle-router-structural-message-binding-wrl):
// a run that requested a fresh target must not land inside an existing
// conversation (/c/<id>) and must not see pre-existing assistant messages in
// capture scope. Explicit follow-ups request a /c/ URL and are exempt.

import { describe, expect, test, vi } from "vitest";

import { navigateToChatGPT } from "../../src/browser/pageActions.js";
import { assertFreshCaptureTarget } from "../../src/browser/actions/captureBinding.js";
import type { ChromeClient } from "../../src/browser/types.js";

function chromeStubs(freshTargetFacts: unknown): {
  Page: ChromeClient["Page"];
  Runtime: ChromeClient["Runtime"] & { evaluate: ReturnType<typeof vi.fn> };
} {
  const Page = { navigate: vi.fn(async () => ({})) } as unknown as ChromeClient["Page"];
  const evaluate = vi.fn(async (params: { expression?: string }) => {
    const expression = params.expression ?? "";
    if (expression === "document.readyState") {
      return { result: { value: "complete" } };
    }
    if (expression.includes("assistantTurnCount")) {
      return { result: { value: freshTargetFacts } };
    }
    return { result: { value: null } };
  });
  return {
    Page,
    Runtime: { evaluate } as unknown as ChromeClient["Runtime"] & {
      evaluate: ReturnType<typeof vi.fn>;
    },
  };
}

describe("navigateToChatGPT blank-state assertion", () => {
  test("fails loud when a fresh-run navigation lands on an existing conversation", async () => {
    const { Page, Runtime } = chromeStubs({
      conversationId: "stale-conv-9",
      assistantTurnCount: 4,
    });
    await expect(
      navigateToChatGPT(Page, Runtime, "https://chatgpt.com/?model=gpt-5-pro", () => {}),
    ).rejects.toMatchObject({
      details: { code: "stale-conversation-at-start", conversationId: "stale-conv-9" },
    });
  });

  test("fails loud when the fresh target already shows assistant messages", async () => {
    const { Page, Runtime } = chromeStubs({ conversationId: null, assistantTurnCount: 2 });
    await expect(
      navigateToChatGPT(Page, Runtime, "https://chatgpt.com/", () => {}),
    ).rejects.toMatchObject({
      details: { code: "preexisting-assistant-content", assistantTurnCount: 2 },
    });
  });

  test("passes on a clean fresh target", async () => {
    const { Page, Runtime } = chromeStubs({ conversationId: null, assistantTurnCount: 0 });
    await expect(
      navigateToChatGPT(Page, Runtime, "https://chatgpt.com/?model=gpt-5-pro", () => {}),
    ).resolves.toBeUndefined();
  });

  test("explicit follow-ups (requested /c/ URL) skip the blank-state probe", async () => {
    const { Page, Runtime } = chromeStubs({
      conversationId: "resumed-conv",
      assistantTurnCount: 7,
    });
    await expect(
      navigateToChatGPT(Page, Runtime, "https://chatgpt.com/c/resumed-conv", () => {}),
    ).resolves.toBeUndefined();
    // Only the readyState poll ran; the fresh-target probe was skipped.
    const expressions = Runtime.evaluate.mock.calls.map(
      (call) => (call[0] as { expression?: string }).expression ?? "",
    );
    expect(expressions.some((expression) => expression.includes("assistantTurnCount"))).toBe(false);
  });

  test("probe unavailability does not fabricate a failure", async () => {
    const Page = { navigate: vi.fn(async () => ({})) } as unknown as ChromeClient["Page"];
    const evaluate = vi.fn(async (params: { expression?: string }) => {
      if ((params.expression ?? "") === "document.readyState") {
        return { result: { value: "complete" } };
      }
      throw new Error("cdp hiccup");
    });
    const Runtime = { evaluate } as unknown as ChromeClient["Runtime"];
    const logs: string[] = [];
    await expect(
      navigateToChatGPT(Page, Runtime, "https://chatgpt.com/", (m) => logs.push(String(m))),
    ).resolves.toBeUndefined();
    expect(logs.join("\n")).toContain("Fresh-target probe unavailable");
  });
});

describe("assertFreshCaptureTarget", () => {
  test("is exempt for conversation URLs without touching the DOM", async () => {
    const evaluate = vi.fn();
    const runtime = { evaluate } as unknown as ChromeClient["Runtime"];
    await expect(
      assertFreshCaptureTarget(runtime, "https://chatgpt.com/c/abc-123", () => {}),
    ).resolves.toBeUndefined();
    expect(evaluate).not.toHaveBeenCalled();
  });
});

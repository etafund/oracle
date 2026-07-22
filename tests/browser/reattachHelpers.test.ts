import { describe, expect, test, vi } from "vitest";
import {
  alignPromptEchoPair,
  buildPromptEchoMatcher,
  recoverPromptEcho,
} from "../../src/browser/reattachHelpers.ts";

describe("alignPromptEchoPair", () => {
  test("aligns answer text when text is a prompt echo", () => {
    const matcher = buildPromptEchoMatcher("Echo prompt");
    expect(matcher).not.toBeNull();
    const result = alignPromptEchoPair("Echo prompt", "Real answer", matcher);
    expect(result.answerText).toBe("Real answer");
    expect(result.answerMarkdown).toBe("Real answer");
    expect(result.isEcho).toBe(false);
  });

  test("aligns answer markdown when markdown is a prompt echo", () => {
    const matcher = buildPromptEchoMatcher("Echo prompt");
    expect(matcher).not.toBeNull();
    const result = alignPromptEchoPair("Real answer", "Echo prompt", matcher);
    expect(result.answerText).toBe("Real answer");
    expect(result.answerMarkdown).toBe("Real answer");
    expect(result.isEcho).toBe(false);
  });

  test("keeps echo flag when both text and markdown are prompt echoes", () => {
    const matcher = buildPromptEchoMatcher("Echo prompt");
    expect(matcher).not.toBeNull();
    const result = alignPromptEchoPair("Echo prompt", "Echo prompt", matcher);
    expect(result.isEcho).toBe(true);
  });
});

describe("recoverPromptEcho", () => {
  test("keeps the replacement snapshot's identity and binds rereads to the proven conversation", async () => {
    vi.useFakeTimers();
    try {
      const replacement = {
        text: "Recovered answer",
        html: "<p>Recovered answer</p>",
        messageId: "replacement-message",
        turnId: "replacement-turn",
        turnIndex: 2,
        afterLatestUser: true,
        turnComplete: true,
      };
      const evaluate = vi.fn(async (_input: { expression: string }) => ({
        result: { value: replacement },
      }));
      const logger = vi.fn();
      const matcher = buildPromptEchoMatcher("Echo prompt");

      const pending = recoverPromptEcho(
        { evaluate } as never,
        {
          text: "Echo prompt",
          html: "<p>Echo prompt</p>",
          meta: { messageId: "echo-message", turnId: "echo-turn" },
        },
        matcher,
        logger as never,
        1,
        15_000,
        "owned-conversation",
      );
      await vi.advanceTimersByTimeAsync(1_000);

      await expect(pending).resolves.toEqual({
        text: "Recovered answer",
        html: "<p>Recovered answer</p>",
        meta: {
          messageId: "replacement-message",
          turnId: "replacement-turn",
        },
      });
      expect(evaluate).toHaveBeenCalledTimes(3);
      expect(evaluate.mock.calls[0]?.[0]?.expression).toContain(
        'const EXPECTED_CONVERSATION_ID = "owned-conversation"',
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

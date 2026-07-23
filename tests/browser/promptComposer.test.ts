import { describe, expect, test, vi } from "vitest";
import {
  __test__ as promptComposer,
  clearPromptComposer,
  submitPrompt,
} from "../../src/browser/actions/promptComposer.js";
import {
  CONVERSATION_TURN_CONTAINER_SELECTOR,
  CONVERSATION_TURN_SELECTOR,
} from "../../src/browser/constants.js";
import { computeRenderedPromptDomSha256 } from "../../src/browser/promptDomMatch.js";
import { BrowserAutomationError } from "../../src/oracle/errors.js";

describe("promptComposer", () => {
  function makeTerminalGuard() {
    return {
      expression: "(() => ({ installed: true }))()",
      assertResult: vi.fn(),
      verdictBinding: {
        name: "__oracle_test_terminal_verdict",
        parsePayload: (payload: string): unknown | undefined => {
          try {
            return JSON.parse(payload);
          } catch {
            return undefined;
          }
        },
      },
      afterDispatchExpression: "(() => globalThis.__oracle_test_page_verdict)()",
      assertAfterDispatchResult(value: unknown): void {
        const status =
          value && typeof value === "object" ? (value as { status?: unknown }).status : null;
        if (status === "allowed") return;
        throw new BrowserAutomationError("Protected dispatch was not allowed.", {
          stage: "model-selection",
          code:
            status === "blocked"
              ? "protected-route-dispatch-blocked"
              : "protected-route-dispatch-unproven",
          retryable: false,
        });
      },
      isDispatchDefinitelyBlocked: (value: unknown): boolean =>
        Boolean(
          value &&
          typeof value === "object" &&
          (value as { status?: unknown }).status === "blocked",
        ),
    };
  }

  function makeTerminalGuardRuntime(pageStatus: "allowed" | "armed" | "blocked") {
    let bindingListener: ((event: { name: string; payload: string }) => void) | undefined;
    const detach = vi.fn();
    const runtime = {
      evaluate: vi
        .fn()
        .mockResolvedValueOnce({ result: { value: { status: "point", x: 10, y: 20 } } })
        .mockResolvedValueOnce({
          result: {
            value: {
              sendTarget: { status: "point", x: 10, y: 20 },
              routeProof: { installed: true },
            },
          },
        })
        .mockResolvedValueOnce({ result: { value: { status: pageStatus, lastEvent: "click" } } }),
      bindingCalled: vi.fn((listener: (event: { name: string; payload: string }) => void) => {
        bindingListener = listener;
        return detach;
      }),
      addBinding: vi.fn().mockResolvedValue(undefined),
      removeBinding: vi.fn().mockResolvedValue(undefined),
    };
    return {
      detach,
      emit(status: "allowed" | "blocked"): void {
        bindingListener?.({
          name: "__oracle_test_terminal_verdict",
          payload: JSON.stringify({ status, lastEvent: "click" }),
        });
      },
      runtime,
    };
  }

  test("fails composer clearing when stale text remains", async () => {
    const runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: { value: { cleared: true, remaining: ["old draft"] } },
      }),
    } as unknown as {
      evaluate: (args: { expression: string; returnByValue?: boolean }) => Promise<unknown>;
    };
    const logger = Object.assign(vi.fn(), { verbose: false });

    await expect(clearPromptComposer(runtime as never, logger as never)).rejects.toThrow(
      /Failed to clear prompt composer/,
    );
  });

  test("does not treat historical assistant content as committed without a new turn", async () => {
    vi.useFakeTimers();
    try {
      const runtime = {
        evaluate: vi.fn().mockResolvedValue({
          result: {
            value: {
              baseline: 10,
              turnsCount: 10,
              userMatched: false,
              lastMatched: false,
              hasNewTurn: false,
              hasNewUserTurn: false,
              lastUserTurnIndex: 8,
              stopVisible: true,
              assistantVisible: false,
              composerCleared: true,
              inConversation: false,
            },
          },
        }),
      } as unknown as {
        evaluate: (args: { expression: string; returnByValue?: boolean }) => Promise<unknown>;
      };

      const promise = promptComposer.verifyPromptCommitted(
        runtime as never,
        "hello",
        150,
        undefined,
        10,
      );
      // Attach the rejection handler before timers advance to avoid unhandled-rejection warnings.
      const assertion = expect(promise).rejects.toThrow(/prompt did not appear/i);
      await vi.advanceTimersByTimeAsync(250);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  test("does not treat a foreign new user turn as committed from surrounding UI state", async () => {
    vi.useFakeTimers();
    try {
      const runtime = {
        evaluate: vi.fn().mockResolvedValue({
          result: {
            value: {
              baseline: 10,
              turnsCount: 11,
              userMatched: false,
              lastMatched: false,
              hasNewTurn: true,
              hasNewUserTurn: true,
              lastUserTurnIndex: 10,
              stopVisible: true,
              assistantVisible: true,
              composerCleared: true,
              inConversation: true,
            },
          },
        }),
      };

      const promise = promptComposer.verifyPromptCommitted(
        runtime as never,
        "expected prompt",
        150,
        undefined,
        10,
      );
      const assertion = expect(promise).rejects.toThrow(/prompt did not appear/i);
      await vi.advanceTimersByTimeAsync(250);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  test("does not bind a fresh foreign turn that only shares the first 120 normalized characters", async () => {
    vi.useFakeTimers();
    try {
      const sharedPrefix = "common ownership prefix ".repeat(8);
      const expectedPrompt = `${sharedPrefix}expected ending`;
      const foreignPrompt = `${sharedPrefix}foreign ending`;
      const turn = (role: "user" | "assistant", text: string) => ({
        innerText: text,
        textContent: text,
        dataset: { turn: role },
        getAttribute: (name: string) => (name === "data-turn" ? role : ""),
        querySelector: () => null,
      });
      const turns = [turn("assistant", "Earlier answer"), turn("user", foreignPrompt)];
      const document = {
        querySelector: () => null,
        querySelectorAll: (selector: string) =>
          selector === CONVERSATION_TURN_CONTAINER_SELECTOR ? turns : [],
      };
      class FakeTextArea {}
      const evaluate = vi.fn(async ({ expression }: { expression: string }) => ({
        result: {
          value: Function(
            "document",
            "HTMLTextAreaElement",
            "location",
            `return ${expression};`,
          )(document, FakeTextArea, { href: "https://chatgpt.com/c/commit-proof" }),
        },
      }));

      const pending = promptComposer.verifyPromptCommitted(
        { evaluate } as never,
        expectedPrompt,
        150,
        undefined,
        1,
      );
      const assertion = expect(pending).rejects.toThrow(/prompt did not appear/i);
      await vi.advanceTimersByTimeAsync(250);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  test("does not count nested broad-selector matches as new turns in a reused conversation", async () => {
    vi.useFakeTimers();
    try {
      const topLevelTurns = [{ innerText: "old user" }, { innerText: "old assistant" }];
      const nestedMatches = [
        topLevelTurns[0],
        { innerText: "old user" },
        topLevelTurns[1],
        { innerText: "old assistant" },
      ];
      const document = {
        querySelector: () => null,
        querySelectorAll: (selector: string) => {
          if (selector === CONVERSATION_TURN_CONTAINER_SELECTOR) return topLevelTurns;
          if (selector === CONVERSATION_TURN_SELECTOR) return nestedMatches;
          return [];
        },
      };
      class FakeTextArea {}
      const runtime = {
        evaluate: vi.fn(async ({ expression }: { expression: string }) => ({
          result: {
            value: Function(
              "document",
              "HTMLTextAreaElement",
              "location",
              `return ${expression};`,
            )(document, FakeTextArea, { href: "https://chatgpt.com/c/reused" }),
          },
        })),
      } as unknown as {
        evaluate: (args: { expression: string; returnByValue?: boolean }) => Promise<unknown>;
      };

      const promise = promptComposer.verifyPromptCommitted(
        runtime as never,
        "new prompt",
        150,
        undefined,
        2,
      );
      const assertion = expect(promise).rejects.toThrow(/prompt did not appear/i);
      await vi.advanceTimersByTimeAsync(250);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  test("commit timeout throws a structured error with probe diagnostics", async () => {
    vi.useFakeTimers();
    try {
      const probe = {
        baseline: 10,
        turnsCount: 10,
        userMatched: false,
        lastMatched: false,
        hasNewTurn: false,
        hasNewUserTurn: false,
        lastUserTurnIndex: 8,
        stopVisible: false,
        assistantVisible: false,
        composerCleared: true,
        inConversation: false,
        editorValue: "",
        lastTurn: "previous turn text",
      };
      const runtime = {
        evaluate: vi.fn().mockResolvedValue({ result: { value: probe } }),
      } as unknown as {
        evaluate: (args: { expression: string; returnByValue?: boolean }) => Promise<unknown>;
      };

      const promise = promptComposer.verifyPromptCommitted(
        runtime as never,
        "hello",
        150,
        undefined,
        10,
      );
      const assertion = promise.then(
        () => {
          throw new Error("expected verifyPromptCommitted to reject");
        },
        (error: unknown) => error,
      );
      await vi.advanceTimersByTimeAsync(250);
      const error = (await assertion) as {
        name?: string;
        details?: Record<string, unknown>;
        message?: string;
      };
      expect(error.message).toMatch(/prompt did not appear/i);
      expect(error.name).toBe("BrowserAutomationError");
      expect(error.details).toMatchObject({
        stage: "submit-prompt",
        code: "prompt-commit-timeout",
        retryable: false,
        commitProbe: expect.objectContaining({
          hasNewTurn: false,
          composerCleared: true,
          turnsCount: 10,
          lastTurnLength: "previous turn text".length,
        }),
      });
      // Free text must not leak into the structured details.
      const commitProbe = error.details?.commitProbe as Record<string, unknown>;
      expect(commitProbe).not.toHaveProperty("lastTurn");
      expect(commitProbe).not.toHaveProperty("editorValue");
    } finally {
      vi.useRealTimers();
    }
  });

  test("large post-dispatch commit timeout is not classified as retry-safe prompt-too-large", async () => {
    vi.useFakeTimers();
    try {
      const runtime = {
        evaluate: vi.fn().mockResolvedValue({
          result: {
            value: {
              baseline: 4,
              turnsCount: 4,
              userMatched: false,
              lastMatched: false,
              hasNewTurn: false,
              hasNewUserTurn: false,
              lastUserTurnIndex: 2,
              stopVisible: false,
              assistantVisible: false,
              composerCleared: true,
              inConversation: true,
            },
          },
        }),
      } as unknown as {
        evaluate: (args: { expression: string; returnByValue?: boolean }) => Promise<unknown>;
      };

      const promise = promptComposer.verifyPromptCommitted(
        runtime as never,
        "x".repeat(50_000),
        150,
        undefined,
        4,
      );
      const assertion = promise.then(
        () => {
          throw new Error("expected verifyPromptCommitted to reject");
        },
        (error: unknown) => error,
      );
      await vi.advanceTimersByTimeAsync(250);

      await expect(assertion).resolves.toMatchObject({
        details: {
          stage: "submit-prompt",
          code: "prompt-commit-timeout",
          promptLength: 50_000,
          retryable: false,
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  test("baseline-unknown commit proof refuses a pre-existing identical latest turn", async () => {
    vi.useFakeTimers();
    try {
      const runtime = {
        evaluate: vi.fn().mockResolvedValue({
          result: {
            value: {
              baseline: -1,
              turnsCount: 1,
              userMatched: true,
              lastMatched: true,
              hasNewTurn: false,
              hasNewUserTurn: false,
              lastUserTurnIndex: 0,
              stopVisible: false,
              assistantVisible: false,
              composerCleared: true,
              inConversation: true,
            },
          },
        }),
      };

      const pending = promptComposer.verifyPromptCommitted(runtime as never, "hello", 150);
      const assertion = expect(pending).rejects.toThrow(/prompt did not appear/i);
      await vi.advanceTimersByTimeAsync(250);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  test("known-baseline commit proof normalizes a heading-leading Markdown prompt", async () => {
    const markdownPrompt = "# Commit ownership\n\n- `first value`\n- second   value";
    const renderedPrompt = "Commit ownership\nfirst value\nsecond value";
    const turn = (role: "user" | "assistant", text: string) => ({
      innerText: text,
      textContent: text,
      dataset: { turn: role },
      getAttribute: (name: string) => (name === "data-turn" ? role : ""),
      querySelector: () => null,
    });
    const turns = [turn("user", renderedPrompt), turn("assistant", "Thinking…")];
    const document = {
      querySelector: () => null,
      querySelectorAll: (selector: string) =>
        selector === CONVERSATION_TURN_CONTAINER_SELECTOR ? turns : [],
    };
    class FakeTextArea {}
    const evaluate = vi.fn(async ({ expression }: { expression: string }) => ({
      result: {
        value: Function(
          "document",
          "HTMLTextAreaElement",
          "location",
          `return ${expression};`,
        )(document, FakeTextArea, { href: "https://chatgpt.com/c/commit-proof" }),
      },
    }));

    await expect(
      promptComposer.verifyPromptCommitted(
        { evaluate } as never,
        markdownPrompt,
        150,
        undefined,
        0,
      ),
    ).resolves.toBe(2);
  });

  test("known-baseline commit proof allows only explicitly supplied attachment suffixes", async () => {
    const prompt = "review this implementation";
    const rendered = `${prompt}\nimplementation.ts`;
    const turn = {
      innerText: rendered,
      textContent: rendered,
      dataset: { turn: "user" },
      getAttribute: (name: string) => (name === "data-turn" ? "user" : ""),
      querySelector: () => null,
    };
    const document = {
      querySelector: () => null,
      querySelectorAll: (selector: string) =>
        selector === CONVERSATION_TURN_CONTAINER_SELECTOR ? [turn] : [],
    };
    class FakeTextArea {}
    const evaluate = vi.fn(async ({ expression }: { expression: string }) => ({
      result: {
        value: Function(
          "document",
          "HTMLTextAreaElement",
          "location",
          `return ${expression};`,
        )(document, FakeTextArea, { href: "https://chatgpt.com/c/commit-proof" }),
      },
    }));

    await expect(
      promptComposer.verifyPromptCommitted({ evaluate } as never, prompt, 150, undefined, 0, [
        "implementation.ts",
      ]),
    ).resolves.toBe(1);
  });

  test("known-baseline commit proof rejects a fresh turn that wraps the prompt", async () => {
    vi.useFakeTimers();
    try {
      const prompt = "explain the exact ownership invariant";
      const rendered = `Quoted request: ${prompt}`;
      const turn = {
        innerText: rendered,
        textContent: rendered,
        dataset: { turn: "user" },
        getAttribute: (name: string) => (name === "data-turn" ? "user" : ""),
        querySelector: () => null,
      };
      const document = {
        querySelector: () => null,
        querySelectorAll: (selector: string) =>
          selector === CONVERSATION_TURN_CONTAINER_SELECTOR ? [turn] : [],
      };
      class FakeTextArea {}
      const evaluate = vi.fn(async ({ expression }: { expression: string }) => ({
        result: {
          value: Function(
            "document",
            "HTMLTextAreaElement",
            "location",
            `return ${expression};`,
          )(document, FakeTextArea, { href: "https://chatgpt.com/c/commit-proof" }),
        },
      }));

      const pending = promptComposer.verifyPromptCommitted(
        { evaluate } as never,
        prompt,
        150,
        undefined,
        0,
      );
      const assertion = expect(pending).rejects.toThrow(/prompt did not appear/i);
      await vi.advanceTimersByTimeAsync(250);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  test("baseline-unknown commit proof refuses an older matching prompt", async () => {
    vi.useFakeTimers();
    try {
      const markdownPrompt = "# Commit ownership\n\n`first value`";
      const turn = (text: string) => ({
        innerText: text,
        textContent: text,
        dataset: { turn: "user" },
        getAttribute: (name: string) => (name === "data-turn" ? "user" : ""),
        querySelector: () => null,
      });
      const turns = [turn("Commit ownership first value"), turn("newer foreign prompt")];
      const document = {
        querySelector: () => null,
        querySelectorAll: (selector: string) =>
          selector === CONVERSATION_TURN_CONTAINER_SELECTOR ? turns : [],
      };
      class FakeTextArea {}
      const evaluate = vi.fn(async ({ expression }: { expression: string }) => {
        return {
          result: {
            value: Function(
              "document",
              "HTMLTextAreaElement",
              "location",
              `return ${expression};`,
            )(document, FakeTextArea, { href: "https://chatgpt.com/c/commit-proof" }),
          },
        };
      });

      const pending = promptComposer.verifyPromptCommitted(
        { evaluate } as never,
        markdownPrompt,
        150,
      );
      const assertion = expect(pending).rejects.toThrow(/prompt did not appear/i);
      await vi.advanceTimersByTimeAsync(250);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  test("attachment sends time out instead of allowing Enter fallback", async () => {
    vi.useFakeTimers();
    try {
      const runtime = {
        evaluate: vi.fn(async ({ expression }: { expression: string }) => {
          if (expression.includes("dispatchClickSequence")) {
            return { result: { value: { status: "disabled" } } };
          }
          return { result: { value: true } };
        }),
      } as unknown as {
        evaluate: (args: { expression: string; returnByValue?: boolean }) => Promise<unknown>;
      };

      const promise = promptComposer.attemptSendButton(
        runtime as never,
        (() => undefined) as never,
        undefined,
        ["oracle-attach-verify.txt"],
        undefined,
        "attachment-binding-1",
      );
      const assertion = expect(promise).rejects.toThrow(/after 45s/i);
      await vi.advanceTimersByTimeAsync(46_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  test("does not run the final pre-dispatch hook before a send target exists", async () => {
    const beforeDispatch = vi.fn();
    const runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: { value: { status: "missing", reason: "same-composer-send-missing" } },
      }),
    };

    await expect(
      promptComposer.attemptSendButton(
        runtime as never,
        {} as never,
        undefined,
        undefined,
        undefined,
        undefined,
        beforeDispatch,
      ),
    ).resolves.toBe(false);
    expect(beforeDispatch).not.toHaveBeenCalled();
  });

  test("a rejected route/account preflight dispatches no mouse or key event", async () => {
    const preflightError = new Error("protected route changed");
    const input = { dispatchMouseEvent: vi.fn(), dispatchKeyEvent: vi.fn() };
    const runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: { value: { status: "point", x: 10, y: 20 } },
      }),
    };

    await expect(
      promptComposer.attemptSendButton(
        runtime as never,
        input as never,
        undefined,
        undefined,
        undefined,
        undefined,
        vi.fn().mockRejectedValue(preflightError),
      ),
    ).rejects.toBe(preflightError);
    expect(input.dispatchMouseEvent).not.toHaveBeenCalled();
    expect(input.dispatchKeyEvent).not.toHaveBeenCalled();
  });

  test("a composer/send remount after preflight dispatches nothing", async () => {
    const input = { dispatchMouseEvent: vi.fn(), dispatchKeyEvent: vi.fn() };
    const runtime = {
      evaluate: vi
        .fn()
        .mockResolvedValueOnce({ result: { value: { status: "point", x: 10, y: 20 } } })
        .mockResolvedValueOnce({
          result: {
            value: {
              status: "binding-missing",
              reason: "send-target-remounted-after-preflight",
            },
          },
        }),
    };

    await expect(
      promptComposer.attemptSendButton(
        runtime as never,
        input as never,
        undefined,
        undefined,
        undefined,
        undefined,
        vi.fn().mockResolvedValue(undefined),
      ),
    ).rejects.toMatchObject({
      details: { code: "send-target-changed-after-preflight" },
    });
    expect(input.dispatchMouseEvent).not.toHaveBeenCalled();
    expect(input.dispatchKeyEvent).not.toHaveBeenCalled();
  });

  test("a final route-label guard shares the send-target evaluation and can veto dispatch", async () => {
    const routeChanged = new Error("protected route changed after preflight");
    const assertResult = vi.fn(() => {
      throw routeChanged;
    });
    const input = { dispatchMouseEvent: vi.fn(), dispatchKeyEvent: vi.fn() };
    const runtime = {
      evaluate: vi
        .fn()
        .mockResolvedValueOnce({ result: { value: { status: "point", x: 10, y: 20 } } })
        .mockResolvedValueOnce({
          result: {
            value: {
              sendTarget: { status: "point", x: 10, y: 20 },
              routeProof: { model: "GPT-5.6 Sol", mode: "Standard" },
            },
          },
        }),
    };

    await expect(
      promptComposer.attemptSendButton(
        runtime as never,
        input as never,
        undefined,
        undefined,
        undefined,
        undefined,
        vi.fn().mockResolvedValue({
          expression: "(() => ({ model: 'GPT-5.6 Sol', mode: 'Standard' }))()",
          assertResult,
        }),
      ),
    ).rejects.toBe(routeChanged);

    const finalExpression = runtime.evaluate.mock.calls[1]?.[0].expression as string;
    expect(finalExpression).toContain("sendTarget:");
    expect(finalExpression).toContain("routeProof:");
    expect(finalExpression).toContain("data-oracle-send-binding");
    expect(assertResult).toHaveBeenCalledWith({ model: "GPT-5.6 Sol", mode: "Standard" });
    expect(input.dispatchMouseEvent).not.toHaveBeenCalled();
    expect(input.dispatchKeyEvent).not.toHaveBeenCalled();
  });

  test("a terminal binding authorizes exactly one protected dispatch report", async () => {
    const harness = makeTerminalGuardRuntime("allowed");
    const onDispatchAttempt = vi.fn();
    const input = {
      dispatchMouseEvent: vi.fn(async ({ type }: { type: string }) => {
        if (type === "mouseReleased") harness.emit("allowed");
      }),
    };

    await expect(
      promptComposer.attemptSendButton(
        harness.runtime as never,
        input as never,
        undefined,
        undefined,
        undefined,
        undefined,
        vi.fn().mockResolvedValue(makeTerminalGuard()),
        onDispatchAttempt,
      ),
    ).resolves.toBe(true);

    expect(onDispatchAttempt).toHaveBeenCalledTimes(1);
    expect(input.dispatchMouseEvent).toHaveBeenCalledTimes(3);
    expect(harness.runtime.addBinding).toHaveBeenCalledWith({
      name: "__oracle_test_terminal_verdict",
    });
    expect(harness.runtime.removeBinding).toHaveBeenCalledWith({
      name: "__oracle_test_terminal_verdict",
    });
    expect(harness.detach).toHaveBeenCalledTimes(1);
  });

  test("a terminal blocked verdict dispatches protocol events but never marks submitted", async () => {
    const harness = makeTerminalGuardRuntime("blocked");
    const onDispatchAttempt = vi.fn();
    const input = {
      dispatchMouseEvent: vi.fn(async ({ type }: { type: string }) => {
        if (type === "mousePressed") harness.emit("blocked");
      }),
    };

    await expect(
      promptComposer.attemptSendButton(
        harness.runtime as never,
        input as never,
        undefined,
        undefined,
        undefined,
        undefined,
        vi.fn().mockResolvedValue(makeTerminalGuard()),
        onDispatchAttempt,
      ),
    ).rejects.toMatchObject({
      details: { code: "protected-route-dispatch-blocked", retryable: false },
    });

    expect(input.dispatchMouseEvent).toHaveBeenCalledTimes(3);
    expect(onDispatchAttempt).not.toHaveBeenCalled();
    expect(harness.detach).toHaveBeenCalledTimes(1);
  });

  test("protected dispatch refuses the untrusted DOM click fallback before submission", async () => {
    const harness = makeTerminalGuardRuntime("armed");
    const onDispatchAttempt = vi.fn();

    await expect(
      promptComposer.attemptSendButton(
        harness.runtime as never,
        {} as never,
        undefined,
        undefined,
        undefined,
        undefined,
        vi.fn().mockResolvedValue(makeTerminalGuard()),
        onDispatchAttempt,
      ),
    ).rejects.toMatchObject({
      details: { code: "protected-trusted-input-unavailable", retryable: false },
    });

    expect(onDispatchAttempt).not.toHaveBeenCalled();
    expect(harness.runtime.removeBinding).toHaveBeenCalledTimes(1);
  });

  test("a failed Runtime binding arm detaches and attempts idempotent binding cleanup", async () => {
    const harness = makeTerminalGuardRuntime("armed");
    harness.runtime.evaluate.mockReset();
    harness.runtime.evaluate
      .mockResolvedValueOnce({ result: { value: { status: "point", x: 10, y: 20 } } })
      .mockResolvedValueOnce({ result: { value: { status: "missing" } } });
    harness.runtime.addBinding.mockRejectedValueOnce(new Error("binding unavailable"));
    const onDispatchAttempt = vi.fn();
    const input = { dispatchMouseEvent: vi.fn() };

    await expect(
      promptComposer.attemptSendButton(
        harness.runtime as never,
        input as never,
        undefined,
        undefined,
        undefined,
        undefined,
        vi.fn().mockResolvedValue(makeTerminalGuard()),
        onDispatchAttempt,
      ),
    ).rejects.toMatchObject({
      details: { code: "protected-dispatch-binding-arm-failed", retryable: false },
    });

    expect(input.dispatchMouseEvent).not.toHaveBeenCalled();
    expect(onDispatchAttempt).not.toHaveBeenCalled();
    expect(harness.detach).toHaveBeenCalledTimes(1);
    expect(harness.runtime.removeBinding).toHaveBeenCalledWith({
      name: "__oracle_test_terminal_verdict",
    });
  });

  test("a pre-press input failure stays pre-submit and still cleans the guard", async () => {
    const harness = makeTerminalGuardRuntime("armed");
    const onDispatchAttempt = vi.fn();
    const moveFailure = new Error("mouse move failed");
    const input = {
      dispatchMouseEvent: vi.fn(async ({ type }: { type: string }) => {
        if (type === "mouseMoved") throw moveFailure;
      }),
    };

    await expect(
      promptComposer.attemptSendButton(
        harness.runtime as never,
        input as never,
        undefined,
        undefined,
        undefined,
        undefined,
        vi.fn().mockResolvedValue(makeTerminalGuard()),
        onDispatchAttempt,
      ),
    ).rejects.toBe(moveFailure);

    expect(onDispatchAttempt).not.toHaveBeenCalled();
    expect(harness.runtime.removeBinding).toHaveBeenCalledTimes(1);
    expect(harness.detach).toHaveBeenCalledTimes(1);
  });

  test("press-start uncertainty marks submitted unless a terminal verdict proves blocking", async () => {
    for (const blocked of [false, true]) {
      const harness = makeTerminalGuardRuntime(blocked ? "blocked" : "armed");
      const onDispatchAttempt = vi.fn();
      const pressFailure = new Error("mouse press response lost");
      const input = {
        dispatchMouseEvent: vi.fn(async ({ type }: { type: string }) => {
          if (type !== "mousePressed") return;
          if (blocked) harness.emit("blocked");
          throw pressFailure;
        }),
      };

      const result = promptComposer.attemptSendButton(
        harness.runtime as never,
        input as never,
        undefined,
        undefined,
        undefined,
        undefined,
        vi.fn().mockResolvedValue(makeTerminalGuard()),
        onDispatchAttempt,
      );
      if (blocked) {
        await expect(result).rejects.toMatchObject({
          details: { code: "protected-route-dispatch-blocked" },
        });
        expect(onDispatchAttempt).not.toHaveBeenCalled();
      } else {
        await expect(result).rejects.toBe(pressFailure);
        expect(onDispatchAttempt).toHaveBeenCalledTimes(1);
      }
    }
  });

  test("an allowed binding survives page-verdict cleanup failure", async () => {
    const harness = makeTerminalGuardRuntime("allowed");
    harness.runtime.evaluate.mockReset();
    harness.runtime.evaluate
      .mockResolvedValueOnce({ result: { value: { status: "point", x: 10, y: 20 } } })
      .mockResolvedValueOnce({
        result: {
          value: {
            sendTarget: { status: "point", x: 10, y: 20 },
            routeProof: { installed: true },
          },
        },
      })
      .mockRejectedValueOnce(new Error("execution context destroyed"));
    const onDispatchAttempt = vi.fn();
    const input = {
      dispatchMouseEvent: vi.fn(async ({ type }: { type: string }) => {
        if (type === "mouseReleased") harness.emit("allowed");
      }),
    };

    await expect(
      promptComposer.attemptSendButton(
        harness.runtime as never,
        input as never,
        undefined,
        undefined,
        undefined,
        undefined,
        vi.fn().mockResolvedValue(makeTerminalGuard()),
        onDispatchAttempt,
      ),
    ).resolves.toBe(true);
    expect(onDispatchAttempt).toHaveBeenCalledTimes(1);
  });

  test("DOM click fallback must prove dispatch instead of reporting fake success", async () => {
    const runtime = {
      evaluate: vi
        .fn()
        .mockResolvedValueOnce({ result: { value: { status: "point", x: 10, y: 20 } } })
        .mockResolvedValueOnce({ result: { value: false } }),
    };

    await expect(
      promptComposer.attemptSendButton(runtime as never, {} as never),
    ).rejects.toMatchObject({
      details: { code: "send-target-disappeared-before-dispatch" },
    });
  });

  test("only attachment sends get the longer send-button deadline", () => {
    expect(promptComposer.sendButtonTimeoutMs()).toBe(20_000);
    expect(promptComposer.sendButtonTimeoutMs([])).toBe(20_000);
    expect(promptComposer.sendButtonTimeoutMs(["oracle-attach-verify.txt"])).toBe(45_000);
    expect(promptComposer.sendButtonTimeoutMs(["oracle-attach-verify.txt"], 120_000)).toBe(120_000);
  });

  test("baseline acquisition failure aborts before typing, dispatch, or submission callback", async () => {
    const onPromptSubmitted = vi.fn();
    const beforePromptSubmit = vi.fn();
    const runtime = {
      evaluate: vi.fn(async ({ expression }: { expression: string }) => {
        if (expression.includes("document.readyState")) {
          return { result: { value: { ready: true, composer: true, fileInput: false } } };
        }
        throw new Error("turn count read failed");
      }),
    };
    const input = {
      insertText: vi.fn(),
      dispatchKeyEvent: vi.fn(),
      dispatchMouseEvent: vi.fn(),
    };
    const logger = Object.assign(vi.fn(), { verbose: false });

    await expect(
      submitPrompt(
        {
          runtime: runtime as never,
          input: input as never,
          beforePromptSubmit,
          onPromptSubmitted,
        },
        "must not be sent",
        logger as never,
      ),
    ).rejects.toMatchObject({
      name: "BrowserAutomationError",
      details: {
        stage: "submit-prompt",
        code: "prompt-baseline-unavailable",
        retryable: true,
      },
    });

    expect(runtime.evaluate).toHaveBeenCalledTimes(2);
    expect(input.insertText).not.toHaveBeenCalled();
    expect(input.dispatchKeyEvent).not.toHaveBeenCalled();
    expect(input.dispatchMouseEvent).not.toHaveBeenCalled();
    expect(beforePromptSubmit).not.toHaveBeenCalled();
    expect(onPromptSubmitted).not.toHaveBeenCalled();
  });

  test("Enter fallback does not mark submitted when the submission-capable keyDown fails", async () => {
    vi.useFakeTimers();
    try {
      const onPromptSubmitted = vi.fn();
      const keyFailure = new Error("key dispatch failed");
      const runtime = {
        evaluate: vi.fn(async ({ expression }: { expression: string }) => {
          if (expression.includes("document.readyState")) {
            return { result: { value: { ready: true, composer: true, fileInput: false } } };
          }
          if (expression.includes("dispatchClickSequence")) {
            return { result: { value: { focused: true } } };
          }
          if (expression.includes("editorText")) {
            return {
              result: { value: { editorText: "hello", fallbackValue: "", activeValue: "hello" } },
            };
          }
          if (expression.includes("button.scrollIntoView")) {
            return { result: { value: { status: "missing", reason: "send-button-missing" } } };
          }
          throw new Error("unexpected evaluation");
        }),
      };
      const input = {
        insertText: vi.fn(),
        dispatchKeyEvent: vi.fn(async () => {
          throw keyFailure;
        }),
      };
      const logger = Object.assign(vi.fn(), { verbose: false });

      const submission = submitPrompt(
        {
          runtime: runtime as never,
          input: input as never,
          baselineTurns: 0,
          onPromptSubmitted,
        },
        "hello",
        logger as never,
      );
      const assertion = expect(submission).rejects.toBe(keyFailure);
      await vi.advanceTimersByTimeAsync(25_000);
      await assertion;

      expect(input.dispatchKeyEvent).toHaveBeenCalledTimes(1);
      expect(onPromptSubmitted).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  test("marks prompt submitted before commit verification finishes", async () => {
    const onPromptSubmitted = vi.fn();
    const onPromptBound = vi.fn();
    const runtime = {
      evaluate: vi.fn(async ({ expression }: { expression: string }) => {
        if (expression.includes("document.readyState")) {
          return { result: { value: { ready: true, composer: true, fileInput: false } } };
        }
        if (expression.includes("focused: true")) {
          return { result: { value: { focused: true } } };
        }
        if (expression.includes("editorText")) {
          return {
            result: { value: { editorText: "hello", fallbackValue: "", activeValue: "hello" } },
          };
        }
        if (expression.includes("button.scrollIntoView")) {
          return { result: { value: { status: "clicked" } } };
        }
        if (expression.includes("EXPECTED_PROMPT_DOM_SHA256")) {
          return {
            result: {
              value: {
                found: true,
                matchedPrompt: true,
                isLatestUserTurn: true,
                promptDomIdentity: "hello",
                conversationId: "bound-conversation",
                userMessageId: "bound-user-message",
                userTurnTestId: "conversation-turn-0",
              },
            },
          };
        }
        return {
          result: {
            value: {
              baseline: 0,
              turnsCount: 1,
              userMatched: true,
              prefixMatched: false,
              lastMatched: true,
              hasNewTurn: true,
              hasNewUserTurn: true,
              lastUserTurnIndex: 0,
              stopVisible: true,
              assistantVisible: false,
              composerCleared: true,
              inConversation: true,
            },
          },
        };
      }),
    };
    const input = { insertText: vi.fn(), dispatchKeyEvent: vi.fn() };
    const logger = Object.assign(vi.fn(), { verbose: false });

    await submitPrompt(
      {
        runtime: runtime as never,
        input: input as never,
        baselineTurns: 0,
        onPromptSubmitted,
        onPromptBound,
      },
      "hello",
      logger as never,
    );

    expect(onPromptSubmitted).toHaveBeenCalledTimes(1);
    expect(onPromptBound).toHaveBeenCalledWith(
      "hello",
      expect.objectContaining({
        quality: "message-handle",
        promptDomSha256: computeRenderedPromptDomSha256("hello"),
      }),
    );
  });

  test("waits for a delayed trusted click without issuing a second send", async () => {
    vi.useFakeTimers();
    try {
      const evaluate = vi.fn().mockResolvedValue({
        result: { value: { status: "point", x: 10, y: 20 } },
      });
      const input = {
        dispatchMouseEvent: vi.fn(async ({ type }: { type: string }) => {
          if (type === "mouseReleased") {
            await new Promise((resolve) => setTimeout(resolve, 1_000));
          }
        }),
      };

      const result = promptComposer.attemptSendButton(
        { evaluate } as never,
        input as never,
        undefined,
        undefined,
      );
      await vi.advanceTimersByTimeAsync(1_000);

      await expect(result).resolves.toBe(true);
      expect(evaluate).toHaveBeenCalledTimes(1);
      expect(input.dispatchMouseEvent).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
});

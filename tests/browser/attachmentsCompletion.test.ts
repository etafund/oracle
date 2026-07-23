import { describe, expect, test, vi } from "vitest";
import {
  clearComposerAttachments,
  waitForAttachmentCompletion,
  waitForUserTurnAttachments,
} from "../../src/browser/pageActions.js";
import type { ChromeClient } from "../../src/browser/types.js";

const useFakeTime = () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
};

const useRealTime = () => {
  vi.useRealTimers();
};

describe("attachment completion fallbacks", () => {
  test("waitForAttachmentCompletion resolves when ready file input contains expected name (no UI chip)", async () => {
    useFakeTime();

    const runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: {
          value: {
            state: "ready",
            uploading: false,
            filesAttached: false,
            attachedNames: [],
            inputNames: ["oracle-attach-verify.txt"],
            fileCount: 0,
          },
        },
      }),
    } as unknown as ChromeClient["Runtime"];

    const promise = waitForAttachmentCompletion(runtime, 10_000, ["oracle-attach-verify.txt"]);
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(promise).resolves.toBeUndefined();
    useRealTime();
  });

  test("waitForAttachmentCompletion does not resolve input-only match while upload is still flagged", async () => {
    useFakeTime();

    const runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: {
          value: {
            state: "ready",
            uploading: true,
            filesAttached: false,
            attachedNames: [],
            inputNames: ["oracle-attach-verify.txt"],
            fileCount: 0,
          },
        },
      }),
    } as unknown as ChromeClient["Runtime"];

    const promise = waitForAttachmentCompletion(runtime, 800, ["oracle-attach-verify.txt"]);
    const assertion = expect(promise).rejects.toThrow(/did not finish uploading/i);
    await vi.advanceTimersByTimeAsync(2_000);
    await assertion;
    useRealTime();
  });

  test("waitForAttachmentCompletion resolves when all ready file input names match", async () => {
    useFakeTime();

    const runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: {
          value: {
            state: "ready",
            uploading: false,
            filesAttached: false,
            attachedNames: [],
            inputNames: ["a.txt", "b.txt"],
            fileCount: 0,
          },
        },
      }),
    } as unknown as ChromeClient["Runtime"];

    const promise = waitForAttachmentCompletion(runtime, 10_000, ["a.txt", "b.txt"]);
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(promise).resolves.toBeUndefined();
    useRealTime();
  });

  test("waitForAttachmentCompletion times out when ready file input misses an expected name", async () => {
    useFakeTime();

    const runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: {
          value: {
            state: "ready",
            uploading: false,
            filesAttached: false,
            attachedNames: [],
            inputNames: ["a.txt"],
            fileCount: 0,
          },
        },
      }),
    } as unknown as ChromeClient["Runtime"];

    const promise = waitForAttachmentCompletion(runtime, 800, ["a.txt", "b.txt"]);
    const assertion = expect(promise).rejects.toMatchObject({
      name: "BrowserAutomationError",
      details: {
        stage: "attachment-upload",
        code: "attachment-upload-timeout",
        retryable: true,
        stalledFiles: ["b.txt"],
        expectedFiles: ["a.txt", "b.txt"],
      },
    });
    await vi.advanceTimersByTimeAsync(2_000);
    await assertion;
    useRealTime();
  });

  test("waitForAttachmentCompletion times out when ready file input has an unexpected extra name", async () => {
    useFakeTime();

    const runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: {
          value: {
            state: "ready",
            uploading: false,
            filesAttached: false,
            attachedNames: [],
            inputNames: ["oracle-attach-verify.txt", "unexpected-extra.txt"],
            fileCount: 0,
          },
        },
      }),
    } as unknown as ChromeClient["Runtime"];

    const promise = waitForAttachmentCompletion(runtime, 2_000, ["oracle-attach-verify.txt"]);
    const assertion = expect(promise).rejects.toThrow(/did not finish uploading/i);
    await vi.advanceTimersByTimeAsync(3_000);
    await assertion;
    useRealTime();
  });

  test("waitForAttachmentCompletion can resolve when send button is missing (input match fallback)", async () => {
    useFakeTime();

    const runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: {
          value: {
            state: "missing",
            uploading: false,
            filesAttached: true,
            attachedNames: [],
            inputNames: ["oracle-attach-verify.txt"],
          },
        },
      }),
    } as unknown as ChromeClient["Runtime"];

    const promise = waitForAttachmentCompletion(runtime, 10_000, ["oracle-attach-verify.txt"]);
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(promise).resolves.toBeUndefined();
    useRealTime();
  });

  test("waitForAttachmentCompletion times out when send button stays disabled (upload likely in progress)", async () => {
    useFakeTime();

    const runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: {
          value: {
            state: "disabled",
            uploading: false,
            filesAttached: true,
            attachedNames: ["oracle-attach-verify.txt"],
            inputNames: [],
          },
        },
      }),
    } as unknown as ChromeClient["Runtime"];

    const promise = waitForAttachmentCompletion(runtime, 800, ["oracle-attach-verify.txt"]);
    const assertion = expect(promise).rejects.toThrow(/did not finish uploading/i);
    await vi.advanceTimersByTimeAsync(2_000);
    await assertion;
    useRealTime();
  });

  test("waitForAttachmentCompletion times out when neither UI nor file input matches", async () => {
    useFakeTime();

    const runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: {
          value: {
            state: "ready",
            uploading: false,
            filesAttached: false,
            attachedNames: [],
            inputNames: [],
          },
        },
      }),
    } as unknown as ChromeClient["Runtime"];

    const promise = waitForAttachmentCompletion(runtime, 800, ["oracle-attach-verify.txt"]);
    const assertion = expect(promise).rejects.toThrow(/did not finish uploading/i);
    await vi.advanceTimersByTimeAsync(2_000);
    await assertion;
    useRealTime();
  });
});

describe("attachment cleanup proof", () => {
  test("requires two consecutive clean composer samples", async () => {
    useFakeTime();
    try {
      const runtime = {
        evaluate: vi.fn().mockResolvedValue({
          result: {
            value: {
              removeClicks: 0,
              chipCount: 0,
              inputCount: 0,
              hadAttachments: false,
              residualKinds: [],
            },
          },
        }),
      } as unknown as ChromeClient["Runtime"];

      const cleanup = clearComposerAttachments(runtime, 1_000);
      await vi.advanceTimersByTimeAsync(300);
      await expect(cleanup).resolves.toBeUndefined();
      expect(runtime.evaluate).toHaveBeenCalledTimes(2);
    } finally {
      useRealTime();
    }
  });

  test("refuses a visible residual attachment node even without a remove button", async () => {
    useFakeTime();
    try {
      const runtime = {
        evaluate: vi.fn(async ({ expression }: { expression: string }) => {
          expect(expression).toContain("residualKinds");
          expect(expression).toContain('[data-testid*="attachment"]');
          return {
            result: {
              value: {
                removeClicks: 0,
                chipCount: 1,
                inputCount: 0,
                hadAttachments: true,
                residualKinds: ["attachment-preview"],
              },
            },
          };
        }),
      } as unknown as ChromeClient["Runtime"];

      const cleanup = clearComposerAttachments(runtime, 500);
      const assertion = expect(cleanup).rejects.toMatchObject({
        name: "BrowserAutomationError",
        details: {
          stage: "attachment-cleanup",
          code: "attachment-cleanup-unverified",
          retryable: true,
          chipCount: 1,
          residualKinds: ["attachment-preview"],
        },
      });
      await vi.advanceTimersByTimeAsync(1_000);
      await assertion;
    } finally {
      useRealTime();
    }
  });

  test("fails closed when the cleanup DOM evaluation returns no value", async () => {
    useFakeTime();
    try {
      const runtime = {
        evaluate: vi.fn().mockResolvedValue({ result: {} }),
      } as unknown as ChromeClient["Runtime"];

      const cleanup = clearComposerAttachments(runtime, 500);
      const assertion = expect(cleanup).rejects.toMatchObject({
        details: {
          code: "attachment-cleanup-unverified",
          evaluationMissing: true,
        },
      });
      await vi.advanceTimersByTimeAsync(1_000);
      await assertion;
    } finally {
      useRealTime();
    }
  });
});

describe("sent turn attachment verification", () => {
  test("waitForUserTurnAttachments resolves when last user turn includes filename", async () => {
    const runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: {
          value: {
            ok: true,
            text: "You said:\noracle-attach-verify.txt\nDocument",
            attrs: [],
            hasAttachmentUi: true,
          },
        },
      }),
    } as unknown as ChromeClient["Runtime"];

    await expect(
      waitForUserTurnAttachments(runtime, ["oracle-attach-verify.txt"], 1000),
    ).resolves.toBe(true);
  });

  test("waitForUserTurnAttachments times out when filename never appears", async () => {
    useFakeTime();

    const runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: {
          value: {
            ok: true,
            text: "You said:\n(no attachment name here)",
            attrs: [],
            hasAttachmentUi: true,
          },
        },
      }),
    } as unknown as ChromeClient["Runtime"];

    const promise = waitForUserTurnAttachments(runtime, ["oracle-attach-verify.txt"], 600);
    const assertion = expect(promise).rejects.toThrow(/Attachment was not present/i);
    await vi.advanceTimersByTimeAsync(2_000);
    await assertion;
    useRealTime();
  });

  test("waitForUserTurnAttachments skips when user turn lacks attachment UI", async () => {
    useFakeTime();

    const runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: {
          value: {
            ok: true,
            text: "You said:\n(no attachment UI here)",
            attrs: [],
            hasAttachmentUi: false,
          },
        },
      }),
    } as unknown as ChromeClient["Runtime"];

    const promise = waitForUserTurnAttachments(runtime, ["oracle-attach-verify.txt"], 600);
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(promise).resolves.toBe(false);
    useRealTime();
  });

  test("waitForUserTurnAttachments resolves when attachment UI count satisfies expected files (no filename text)", async () => {
    const runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: {
          value: {
            ok: true,
            text: "You said:\n(no attachment name here)",
            attrs: [],
            hasAttachmentUi: true,
            attachmentUiCount: 2,
            fileCount: 0,
          },
        },
      }),
    } as unknown as ChromeClient["Runtime"];

    await expect(
      waitForUserTurnAttachments(
        runtime,
        ["oracle-attach-verify-a.txt", "oracle-attach-verify-b.txt"],
        1000,
      ),
    ).resolves.toBe(true);
  });

  test("waitForUserTurnAttachments ignores turns before the expected baseline", async () => {
    useFakeTime();

    const runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: {
          value: {
            ok: false,
          },
        },
      }),
    } as unknown as ChromeClient["Runtime"];

    const promise = waitForUserTurnAttachments(
      runtime,
      ["oracle-attach-verify.txt"],
      600,
      undefined,
      {
        minTurnIndex: 4,
      },
    );
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(promise).resolves.toBe(false);
    useRealTime();
  });

  test("waitForUserTurnAttachments requires prompt evidence when provided", async () => {
    useFakeTime();

    const runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: {
          value: {
            ok: true,
            text: "You said: unrelated prompt oracle-attach-verify.txt",
            attrs: [],
            hasAttachmentUi: true,
            promptMatches: false,
          },
        },
      }),
    } as unknown as ChromeClient["Runtime"];

    const promise = waitForUserTurnAttachments(
      runtime,
      ["oracle-attach-verify.txt"],
      600,
      undefined,
      {
        expectedPrompt: "expected prompt text",
      },
    );
    const assertion = expect(promise).rejects.toThrow(/Attachment was not present/i);
    await vi.advanceTimersByTimeAsync(2_000);
    await assertion;
    useRealTime();
  });

  test("waitForUserTurnAttachments ignores mismatched conversations", async () => {
    useFakeTime();

    const runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: {
          value: {
            ok: false,
            conversationMismatch: true,
          },
        },
      }),
    } as unknown as ChromeClient["Runtime"];

    const promise = waitForUserTurnAttachments(
      runtime,
      ["oracle-attach-verify.txt"],
      600,
      undefined,
      {
        expectedConversationId: "conv-123",
      },
    );
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(promise).resolves.toBe(false);
    useRealTime();
  });
});

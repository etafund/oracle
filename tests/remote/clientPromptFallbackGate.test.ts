// NO SILENT PROMPT FALLBACK on fleet lanes: the remote payload must not
// carry a prompt-altering fallback submission unless the caller explicitly
// opts in via ORACLE_ALLOW_PROMPT_FALLBACK. Opting in logs both prompt hashes
// so the run's event trail can prove which question was actually submitted.
//
// Uses the requestFn DI seam (see tests/remote/payload.test.ts for why
// vi.mock of node:http is avoided).

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createRemoteBrowserExecutor,
  isPromptFallbackOptInEnabled,
} from "../../src/remote/client.js";
import { computePromptSha256 } from "../../src/browser/actions/captureBinding.js";

type ExecutorOptions = Parameters<typeof createRemoteBrowserExecutor>[0];
type RequestFn = NonNullable<ExecutorOptions["requestFn"]>;

type RequestHandlers = Record<string, (...args: unknown[]) => void>;

function makeCapturingRequest(): {
  fn: RequestFn;
  capture: () => Record<string, unknown> | null;
} {
  let inspected: Record<string, unknown> | null = null;
  const spy = vi.fn((_opts: unknown, _cb: unknown) => {
    const handlers: RequestHandlers = {};
    return {
      on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        handlers[event] = handler;
      }),
      write: vi.fn((body: Buffer | string) => {
        const raw = typeof body === "string" ? body : body.toString("utf8");
        inspected = JSON.parse(raw) as Record<string, unknown>;
      }),
      end: vi.fn(() => {
        // Reject the in-flight run right after the body was written; the
        // tests only inspect the serialized payload.
        setImmediate(() => handlers.error?.(new Error("test-stub: end")));
      }),
      destroy: vi.fn(),
    };
  });
  return {
    fn: spy as unknown as RequestFn,
    capture: () => inspected,
  };
}

const FALLBACK_RUN = {
  prompt: "primary prompt",
  fallbackSubmission: { prompt: "re-packed fallback prompt", attachments: [] },
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("remote prompt-fallback gate", () => {
  it("drops the fallback submission from the payload by default and says so", async () => {
    vi.stubEnv("ORACLE_ALLOW_PROMPT_FALLBACK", "");
    const { fn, capture } = makeCapturingRequest();
    const logs: string[] = [];
    const exec = createRemoteBrowserExecutor({ host: "localhost:9222", requestFn: fn });

    await exec({ ...FALLBACK_RUN, log: (m) => logs.push(String(m)) }).catch(() => {
      // stubbed transport always fails after write; ignore
    });

    const payload = capture();
    expect(payload).not.toBeNull();
    expect(payload?.prompt).toBe("primary prompt");
    expect(payload?.fallbackSubmission).toBeUndefined();
    expect(logs.join("\n")).toContain("fallback submission is disabled");
    expect(logs.join("\n")).toContain("ORACLE_ALLOW_PROMPT_FALLBACK");
  });

  it("keeps the fallback submission when the caller explicitly opts in, logging both prompt hashes", async () => {
    vi.stubEnv("ORACLE_ALLOW_PROMPT_FALLBACK", "1");
    const { fn, capture } = makeCapturingRequest();
    const logs: string[] = [];
    const exec = createRemoteBrowserExecutor({ host: "localhost:9222", requestFn: fn });

    await exec({ ...FALLBACK_RUN, log: (m) => logs.push(String(m)) }).catch(() => {
      // ignore stubbed transport failure
    });

    const payload = capture();
    expect(payload).not.toBeNull();
    const fallback = payload?.fallbackSubmission as { prompt?: string } | undefined;
    expect(fallback?.prompt).toBe("re-packed fallback prompt");
    const logText = logs.join("\n");
    expect(logText).toContain("provenance degraded");
    expect(logText).toContain(computePromptSha256("primary prompt"));
    expect(logText).toContain(computePromptSha256("re-packed fallback prompt"));
  });

  it("leaves runs without a fallback submission untouched", async () => {
    vi.stubEnv("ORACLE_ALLOW_PROMPT_FALLBACK", "");
    const { fn, capture } = makeCapturingRequest();
    const logs: string[] = [];
    const exec = createRemoteBrowserExecutor({ host: "localhost:9222", requestFn: fn });

    await exec({ prompt: "plain run", log: (m) => logs.push(String(m)) }).catch(() => {
      // ignore stubbed transport failure
    });

    expect(capture()?.prompt).toBe("plain run");
    expect(capture()?.fallbackSubmission).toBeUndefined();
    expect(logs.join("\n")).not.toContain("fallback submission is disabled");
  });
});

describe("isPromptFallbackOptInEnabled", () => {
  it("is off by default and on only for explicit truthy values", () => {
    expect(isPromptFallbackOptInEnabled({})).toBe(false);
    expect(isPromptFallbackOptInEnabled({ ORACLE_ALLOW_PROMPT_FALLBACK: "" })).toBe(false);
    expect(isPromptFallbackOptInEnabled({ ORACLE_ALLOW_PROMPT_FALLBACK: "0" })).toBe(false);
    expect(isPromptFallbackOptInEnabled({ ORACLE_ALLOW_PROMPT_FALLBACK: "no" })).toBe(false);
    expect(isPromptFallbackOptInEnabled({ ORACLE_ALLOW_PROMPT_FALLBACK: "1" })).toBe(true);
    expect(isPromptFallbackOptInEnabled({ ORACLE_ALLOW_PROMPT_FALLBACK: "true" })).toBe(true);
    expect(isPromptFallbackOptInEnabled({ ORACLE_ALLOW_PROMPT_FALLBACK: "TRUE" })).toBe(true);
  });
});

// Fleet fallbacks are armed only when their declared direction and exact
// byte-derived representation verify locally; the worker repeats the proof.
//
// Uses the requestFn DI seam (see tests/remote/payload.test.ts for why
// vi.mock of node:http is avoided).

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createRemoteBrowserExecutor } from "../../src/remote/client.js";
import { computePromptSha256 } from "../../src/browser/actions/captureBinding.js";
import { formatFileSections } from "../../src/oracle/markdown.js";

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

function inlineFallback(primary: string, displayPath: string, content: string): string {
  return [
    primary,
    formatFileSections([{ displayPath, content }], { preserveTrailingWhitespace: true }),
  ].join("\n\n");
}

const FALLBACK_AUTHORIZATION = {
  attachmentsPolicy: "auto" as const,
  bundleRequested: false as const,
  model: "gpt-5.6-sol",
  maxInputTokens: 272_000,
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("remote prompt-fallback gate", () => {
  it("drops an unverifiable fallback submission and says so", async () => {
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
    expect(logs.join("\n")).toContain("Refusing to arm an unverifiable prompt fallback");
  });

  it("does not let the legacy environment opt-in bypass exact verification", async () => {
    vi.stubEnv("ORACLE_ALLOW_PROMPT_FALLBACK", "1");
    const { fn, capture } = makeCapturingRequest();
    const logs: string[] = [];
    const exec = createRemoteBrowserExecutor({ host: "localhost:9222", requestFn: fn });

    await exec({ ...FALLBACK_RUN, log: (m) => logs.push(String(m)) }).catch(() => {
      // ignore stubbed transport failure
    });

    const payload = capture();
    expect(payload).not.toBeNull();
    expect(payload?.fallbackSubmission).toBeUndefined();
    expect(logs.join("\n")).toContain("Refusing to arm an unverifiable prompt fallback");
  });

  it("keeps a planner-tagged upload-to-inline fallback by default", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-fallback-"));
    try {
      const attachmentPath = path.join(dir, "source.txt");
      await writeFile(attachmentPath, "source contents", "utf8");
      const { fn, capture } = makeCapturingRequest();
      const logs: string[] = [];
      const exec = createRemoteBrowserExecutor({ host: "localhost:9222", requestFn: fn });

      await exec({
        prompt: "primary prompt",
        attachments: [{ path: attachmentPath, displayPath: "source.txt" }],
        fallbackSubmission: {
          prompt: inlineFallback("primary prompt", "source.txt", "source contents"),
          attachments: [],
          reason: "auto-upload-timeout-to-inline",
          authorization: FALLBACK_AUTHORIZATION,
        },
        log: (message) => logs.push(String(message)),
      }).catch(() => {
        // ignore stubbed transport failure
      });

      const captured = capture();
      const fallback = captured?.fallbackSubmission as { prompt?: string } | undefined;
      expect(fallback).toMatchObject({
        prompt: expect.stringContaining("source contents"),
      });
      expect(captured?.fallbackPolicy).toEqual(FALLBACK_AUTHORIZATION);
      expect(logs.join("\n")).toContain(
        "Exact pre-dispatch auto-upload-timeout-to-inline fallback armed",
      );
      expect(logs.join("\n")).toContain(computePromptSha256("primary prompt"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps an exactly verified inline-to-upload fallback", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-fallback-"));
    try {
      const attachmentPath = path.join(dir, "source.txt");
      await writeFile(attachmentPath, "source contents", "utf8");
      const { fn, capture } = makeCapturingRequest();
      const exec = createRemoteBrowserExecutor({ host: "localhost:9222", requestFn: fn });

      await exec({
        prompt: inlineFallback("base prompt", "source.txt", "source contents"),
        attachments: [],
        fallbackSubmission: {
          prompt: "base prompt",
          attachments: [{ path: attachmentPath, displayPath: "source.txt" }],
          reason: "auto-inline-too-large-to-upload",
          authorization: FALLBACK_AUTHORIZATION,
        },
      }).catch(() => {
        // ignore stubbed transport failure
      });

      expect(capture()?.fallbackSubmission).toMatchObject({
        prompt: "base prompt",
        attachments: [expect.objectContaining({ displayPath: "source.txt" })],
      });
      expect(capture()?.fallbackPolicy).toEqual(FALLBACK_AUTHORIZATION);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("drops a safe reason whose primary/fallback direction does not match", async () => {
    const { fn, capture } = makeCapturingRequest();
    const exec = createRemoteBrowserExecutor({ host: "localhost:9222", requestFn: fn });

    await exec({
      prompt: "primary prompt",
      attachments: [],
      fallbackSubmission: {
        prompt: "inline fallback",
        attachments: [],
        reason: "auto-upload-timeout-to-inline",
      },
    }).catch(() => {
      // ignore stubbed transport failure
    });

    expect(capture()?.fallbackSubmission).toBeUndefined();
  });

  it("leaves runs without a fallback submission untouched", async () => {
    const { fn, capture } = makeCapturingRequest();
    const logs: string[] = [];
    const exec = createRemoteBrowserExecutor({ host: "localhost:9222", requestFn: fn });

    await exec({ prompt: "plain run", log: (m) => logs.push(String(m)) }).catch(() => {
      // ignore stubbed transport failure
    });

    expect(capture()?.prompt).toBe("plain run");
    expect(capture()?.fallbackSubmission).toBeUndefined();
    expect(logs.join("\n")).not.toContain("Refusing to arm");
  });
});

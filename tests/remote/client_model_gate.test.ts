// FLEET-BOUND MODEL GATE (client, defense-in-depth). The remote browser
// executor is only ever instantiated behind a resolved remote (fleet) host, so
// every request through it is fleet-bound. The browser fleet serves ONLY
// GPT-5.6 Sol + Pro, so an EXPLICIT non-Sol desired model label is rejected at
// the source — before any attachment file read or connection is opened — with
// the same actionable error the worker returns. An absent/empty label is left
// to the worker's baseline (no silent remap). The serve is the authority; this
// gate just fails faster with a clearer error.
//
// Uses the requestFn DI seam (see tests/remote/payload.test.ts for why
// vi.mock of node:http is avoided).

import { describe, expect, it, vi } from "vitest";

import { createRemoteBrowserExecutor, RemoteRunFailedError } from "../../src/remote/client.js";

type ExecutorOptions = Parameters<typeof createRemoteBrowserExecutor>[0];
type RequestFn = NonNullable<ExecutorOptions["requestFn"]>;
type RequestHandlers = Record<string, (...args: unknown[]) => void>;

function makeCapturingRequest(): {
  fn: RequestFn;
  spy: ReturnType<typeof vi.fn>;
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
        setImmediate(() => handlers.error?.(new Error("test-stub: end")));
      }),
      destroy: vi.fn(),
    };
  });
  return { fn: spy as unknown as RequestFn, spy, capture: () => inspected };
}

const REJECTED_LABELS = [
  "GPT-5.5 Pro",
  "GPT-5.5",
  "GPT-5.4 Pro",
  "gpt-5.5-pro",
  // The current remote executor/serve protocol is the ChatGPT fleet path.
  // Gemini uses its provider-specific executor unless a separately reviewed
  // remote worker is introduced; it must not reach ChatGPT done/recovery
  // provenance gates by accident.
  "gemini-3.1-pro-deep-think",
  "totally-made-up",
];

describe("remote client fleet model gate", () => {
  for (const label of REJECTED_LABELS) {
    it(`rejects the non-Sol label ${JSON.stringify(label)} before any network call`, async () => {
      const { fn, spy, capture } = makeCapturingRequest();
      const executor = createRemoteBrowserExecutor({ host: "localhost:9222", requestFn: fn });

      const error = await executor({ prompt: "x", config: { desiredModel: label } }).then(
        () => null,
        (err: unknown) => err,
      );

      // Fails closed at the source: no connection opened, no body serialized.
      expect(spy).not.toHaveBeenCalled();
      expect(capture()).toBeNull();

      // Typed, non-retryable failure carrying the actionable guidance.
      expect(error).toBeInstanceOf(RemoteRunFailedError);
      const failure = error as RemoteRunFailedError;
      expect(failure.errorClass).toBe("model_not_allowed");
      expect(failure.retryable).toBe(false);
      expect(failure.message).toContain("serves only GPT-5.6 Sol + Pro");
      expect(failure.message).toContain(label);
      expect(failure.message).toContain("--engine api");
    });
  }

  it("admits the served GPT-5.6 Sol label (gate does not fire)", async () => {
    const { fn, spy, capture } = makeCapturingRequest();
    const executor = createRemoteBrowserExecutor({ host: "localhost:9222", requestFn: fn });

    const error = await executor({ prompt: "x", config: { desiredModel: "GPT-5.6 Sol" } }).then(
      () => null,
      (err: unknown) => err,
    );

    // The gate passed: the request reached the transport and serialized a body.
    expect(spy).toHaveBeenCalledTimes(1);
    expect(capture()).not.toBeNull();
    // It fails only because the stub transport always errors after write, NOT
    // because of the model gate.
    expect((error as RemoteRunFailedError).errorClass).not.toBe("model_not_allowed");
  });

  it("admits a Sol label in any case (predicate is case-insensitive)", async () => {
    const { fn, spy } = makeCapturingRequest();
    const executor = createRemoteBrowserExecutor({ host: "localhost:9222", requestFn: fn });

    await executor({ prompt: "x", config: { desiredModel: "gpt-5.6 sol" } }).catch(() => {});
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("does not fire when no desired model label is set (left to the worker baseline)", async () => {
    const { fn, spy, capture } = makeCapturingRequest();
    const executor = createRemoteBrowserExecutor({ host: "localhost:9222", requestFn: fn });

    // Empty config (and absent config) must pass the gate untouched: existing
    // callers that let the worker resolve its own baseline are unaffected.
    await executor({ prompt: "x", config: {} }).catch(() => {});
    expect(spy).toHaveBeenCalledTimes(1);
    expect(capture()).not.toBeNull();

    spy.mockClear();
    await executor({ prompt: "x" }).catch(() => {});
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

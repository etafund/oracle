import { describe, expect, test, vi, beforeEach, afterEach } from "vitest";
import { startHeartbeat } from "../../src/heartbeat.js";

describe("startHeartbeat", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("logs messages on interval while active and stops when stopped", async () => {
    const log = vi.fn();
    const isActive = vi.fn(() => true);
    const makeMessage = vi.fn(async (elapsed: number) => `tick-${elapsed}`);

    const stop = startHeartbeat({ intervalMs: 25, log, isActive, makeMessage });

    await vi.advanceTimersByTimeAsync(30);
    await vi.advanceTimersByTimeAsync(30);

    expect(log).toHaveBeenCalledTimes(2);
    stop();
    await vi.advanceTimersByTimeAsync(50);
    expect(log).toHaveBeenCalledTimes(2);
  });

  test("no-ops when interval is missing or non-positive", async () => {
    const log = vi.fn();
    const stop = startHeartbeat({
      intervalMs: 0,
      log,
      isActive: () => true,
      makeMessage: () => "noop",
    });
    await vi.advanceTimersByTimeAsync(50);
    expect(log).not.toHaveBeenCalled();
    stop();
  });

  test("stops cleanly when the active check fails", async () => {
    const log = vi.fn();
    const makeMessage = vi.fn(() => "tick");
    const stop = startHeartbeat({
      intervalMs: 25,
      log,
      isActive: () => {
        throw new Error("active check failed");
      },
      makeMessage,
    });

    await vi.advanceTimersByTimeAsync(30);
    await vi.advanceTimersByTimeAsync(30);

    expect(makeMessage).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    stop();
  });

  test("does not emit an in-flight heartbeat after stop", async () => {
    const log = vi.fn();
    let resolveMessage: ((message: string) => void) | undefined;
    const makeMessage = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveMessage = resolve;
        }),
    );

    const stop = startHeartbeat({
      intervalMs: 25,
      log,
      isActive: () => true,
      makeMessage,
    });

    await vi.advanceTimersByTimeAsync(30);
    expect(makeMessage).toHaveBeenCalledTimes(1);

    stop();
    resolveMessage?.("late tick");
    await vi.advanceTimersByTimeAsync(0);

    expect(log).not.toHaveBeenCalled();
  });
});

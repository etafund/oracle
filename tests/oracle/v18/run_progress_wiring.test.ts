import { describe, expect, test, vi, beforeEach, afterEach } from "vitest";

import { startHeartbeat } from "@src/heartbeat.ts";
import { executeBackgroundResponse } from "@src/oracle/background.ts";
import type { ClientLike, OracleRequestBody, OracleResponse } from "@src/oracle.ts";
import { runProgressSchema } from "@src/oracle/v18/index.ts";
import { buildRunProgressEvent } from "@src/oracle/v18/run_progress.ts";

function completedResponse(overrides: Partial<OracleResponse> = {}): OracleResponse {
  return {
    id: "resp-run-progress",
    status: "completed",
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      reasoning_tokens: 0,
      total_tokens: 2,
    },
    output: [
      {
        type: "message",
        content: [{ type: "text", text: "done" }],
      },
    ],
    ...overrides,
  } as OracleResponse;
}

describe("heartbeat run_progress wiring", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("startHeartbeat emits run_progress JSON before prose fallback", async () => {
    const log = vi.fn();
    const makeMessage = vi.fn(() => "prose fallback");
    const event = buildRunProgressEvent({
      run_id: "run-heartbeat",
      profile: "balanced",
      state: "running",
      current_stage: "first_plan",
      progress_percent: 12,
      user_visible_message: "Structured progress.",
      extras: {
        model: "gpt-5.2-pro",
        raw_output: "must not leak",
      },
    });

    const stop = startHeartbeat({
      intervalMs: 10,
      log,
      isActive: () => true,
      runProgress: { provider: () => event },
      makeMessage,
    });

    await vi.advanceTimersByTimeAsync(11);

    expect(makeMessage).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);
    const line = String(log.mock.calls[0]?.[0]);
    const parsed = runProgressSchema.parse(JSON.parse(line));
    expect(parsed.schema_version).toBe("run_progress.v1");
    expect(parsed.state).toBe("running");
    expect(line).not.toContain("raw_output");
    expect(line).not.toContain("must not leak");
    stop();
  });

  test("startHeartbeat falls back to prose when structured provider returns null", async () => {
    const log = vi.fn();
    const makeMessage = vi.fn(() => "prose fallback");
    const stop = startHeartbeat({
      intervalMs: 10,
      log,
      isActive: () => true,
      runProgress: { provider: () => null },
      makeMessage,
    });

    await vi.advanceTimersByTimeAsync(11);

    expect(makeMessage).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith("prose fallback");
    stop();
  });
});

describe("API background live path run_progress wiring", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("background heartbeat emits schema-valid run_progress when enabled", async () => {
    const logs: string[] = [];
    const initial = completedResponse({ status: "in_progress", output: [] });
    const final = completedResponse();
    const client: ClientLike = {
      responses: {
        create: vi.fn(async () => initial),
        retrieve: vi.fn(async () => final),
        stream: vi.fn(async () => {
          throw new Error("stream not used");
        }),
      },
    };
    const waitResolvers: Array<() => void> = [];
    let clock = 0;
    const wait = vi.fn((ms: number) => {
      clock += ms;
      return new Promise<void>((resolve) => {
        waitResolvers.push(resolve);
      });
    });

    const run = executeBackgroundResponse({
      client,
      requestBody: { model: "gpt-5.2-pro" } as OracleRequestBody,
      log: (line) => logs.push(line),
      wait,
      heartbeatIntervalMs: 10,
      runProgress: true,
      runId: "session-run-progress",
      now: () => clock,
      maxWaitMs: 60_000,
    });

    await vi.advanceTimersByTimeAsync(11);

    const line = logs.find((entry) => entry.trim().startsWith("{"));
    expect(line).toBeTruthy();
    const parsed = runProgressSchema.parse(JSON.parse(String(line)));
    expect(parsed.run_id).toBe("session-run-progress");
    expect(parsed.current_stage).toBe("api_background_poll");
    expect(parsed.progress_percent).toBeGreaterThanOrEqual(0);
    expect((parsed as Record<string, unknown>).background).toBe(true);

    waitResolvers.shift()?.();
    await run;
  });
});

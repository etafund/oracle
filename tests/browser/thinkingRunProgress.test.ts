// run_progress.v1 emission adapter for the browser lane
// (src/browser/actions/thinkingStatus.ts). The browser lanes used to emit only
// prose heartbeats, making a 5–60 min ChatGPT Pro run a black box to a polling
// agent. These tests pin (1) the pure tick→event mapping, (2) that the monitor
// emits one NDJSON line per heartbeat when enabled, and (3) that the default
// sink writes to stderr only so stdout stays reserved for the --json envelope.

import { afterEach, describe, expect, test, vi } from "vitest";
import {
  buildBrowserThinkingRunProgress,
  shouldEmitBrowserRunProgress,
  startThinkingStatusMonitor,
  type ThinkingStatusSnapshot,
} from "../../src/browser/actions/thinkingStatus.js";
import type { ChromeClient } from "../../src/browser/types.js";

const FIXED_NOW = new Date("2026-07-11T00:00:00.000Z");

function snapshot(overrides: Partial<ThinkingStatusSnapshot> = {}): ThinkingStatusSnapshot {
  return { message: "active", source: "inline", ...overrides };
}

describe("buildBrowserThinkingRunProgress", () => {
  test("maps a UI-progress snapshot into a run_progress.v1 thinking event", () => {
    const event = buildBrowserThinkingRunProgress({
      runId: "sess-1",
      elapsedMs: 134_000,
      timeoutMs: 3_600_000,
      snapshot: snapshot({ progressPercent: 34, source: "sidecar", panelVisible: true }),
      unchangedMs: 5_000,
      now: FIXED_NOW,
    });

    expect(event).toMatchObject({
      schema_version: "run_progress.v1",
      run_id: "sess-1",
      profile: "browser",
      state: "thinking",
      current_stage: "browser_thinking",
      progress_percent: 34, // UI % wins over elapsed-based
      completed_stages: [],
      pending_stages: [],
      next_command: null,
      last_event_at: FIXED_NOW.toISOString(),
      lane: "browser",
      elapsed_ms: 134_000,
      ui_progress_percent: 34,
      status_label: "active",
      source: "sidecar",
      stale_hint: false,
    });
  });

  test("falls back to elapsed-based percent when the snapshot has no UI %", () => {
    const event = buildBrowserThinkingRunProgress({
      runId: "sess-2",
      elapsedMs: 900_000,
      timeoutMs: 3_600_000,
      snapshot: snapshot(),
      now: FIXED_NOW,
    });
    // 900_000 / 3_600_000 = 25%
    expect(event.progress_percent).toBe(25);
    expect(event.ui_progress_percent).toBeNull();
  });

  test("emits a waiting event with null UI % when no snapshot is present", () => {
    const event = buildBrowserThinkingRunProgress({
      runId: "sess-3",
      elapsedMs: 4_000,
      snapshot: null,
      now: FIXED_NOW,
    });
    expect(event).toMatchObject({
      state: "thinking",
      current_stage: "browser_thinking",
      progress_percent: 0, // no UI %, no timeout -> 0
      ui_progress_percent: null,
      status_label: "waiting",
      source: null,
      stale_hint: false,
    });
    expect(event.user_visible_message).toMatch(/Waiting for ChatGPT response/);
  });

  test("sets stale_hint once the UI has not changed for the stale threshold", () => {
    const event = buildBrowserThinkingRunProgress({
      runId: "sess-4",
      elapsedMs: 1_200_000,
      snapshot: snapshot({ progressPercent: 50 }),
      unchangedMs: 11 * 60_000, // > 10 min
      now: FIXED_NOW,
    });
    expect(event.stale_hint).toBe(true);
    expect(event.user_visible_message).toMatch(/stale/i);
  });

  test("non-thinking phases report the running state and a phase-scoped stage", () => {
    for (const phase of ["submit", "verify", "capture"] as const) {
      const event = buildBrowserThinkingRunProgress({
        runId: "sess-5",
        phase,
        elapsedMs: 1_000,
        snapshot: snapshot(),
        now: FIXED_NOW,
      });
      expect(event.state).toBe("running");
      expect(event.current_stage).toBe(`browser_${phase}`);
    }
  });
});

describe("shouldEmitBrowserRunProgress", () => {
  test("is enabled only when ORACLE_RUN_PROGRESS_JSON is exactly '1'", () => {
    expect(shouldEmitBrowserRunProgress({ ORACLE_RUN_PROGRESS_JSON: "1" })).toBe(true);
    expect(shouldEmitBrowserRunProgress({ ORACLE_RUN_PROGRESS_JSON: "0" })).toBe(false);
    expect(shouldEmitBrowserRunProgress({ ORACLE_RUN_PROGRESS_JSON: "true" })).toBe(false);
    expect(shouldEmitBrowserRunProgress({})).toBe(false);
  });
});

function fakeRuntime(value: unknown): ChromeClient["Runtime"] {
  return {
    evaluate: vi.fn(async () => ({ result: { value } })),
  } as unknown as ChromeClient["Runtime"];
}

describe("startThinkingStatusMonitor run_progress emission", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("emits one run_progress.v1 NDJSON line per heartbeat to the sink", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const lines: string[] = [];
    const runtime = fakeRuntime({
      message: "active",
      source: "inline",
      progressPercent: 42,
      panelVisible: true,
    });
    const stop = startThinkingStatusMonitor(runtime, vi.fn() as never, {
      intervalMs: 1_000,
      runProgress: {
        runId: "sess-mon",
        timeoutMs: 3_600_000,
        enabled: true,
        emit: (l) => lines.push(l),
      },
    });
    try {
      await vi.advanceTimersByTimeAsync(1_000);
    } finally {
      stop();
    }

    expect(lines.length).toBeGreaterThanOrEqual(1);
    const parsed = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      schema_version: "run_progress.v1",
      run_id: "sess-mon",
      profile: "browser",
      state: "thinking",
      current_stage: "browser_thinking",
      progress_percent: 42,
      lane: "browser",
      ui_progress_percent: 42,
      status_label: "active",
      source: "inline",
    });
  });

  test("does not emit when run_progress is disabled", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const lines: string[] = [];
    const runtime = fakeRuntime({ message: "active", source: "inline" });
    const stop = startThinkingStatusMonitor(runtime, vi.fn() as never, {
      intervalMs: 1_000,
      runProgress: { runId: "sess-off", enabled: false, emit: (l) => lines.push(l) },
    });
    try {
      await vi.advanceTimersByTimeAsync(2_000);
    } finally {
      stop();
    }
    expect(lines).toHaveLength(0);
  });

  test("the default sink writes NDJSON to stderr and never to stdout", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const runtime = fakeRuntime({ message: "active", source: "inline", progressPercent: 10 });
    const stop = startThinkingStatusMonitor(runtime, vi.fn() as never, {
      intervalMs: 1_000,
      // No emit sink -> exercises the default stderr sink.
      runProgress: { runId: "sess-stderr", enabled: true },
    });
    try {
      await vi.advanceTimersByTimeAsync(1_000);
    } finally {
      stop();
    }

    const isRunProgressLine = (call: unknown[]): boolean =>
      typeof call[0] === "string" && call[0].includes('"schema_version":"run_progress.v1"');
    expect(stderrSpy.mock.calls.some(isRunProgressLine)).toBe(true);
    expect(stdoutSpy.mock.calls.some(isRunProgressLine)).toBe(false);

    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });
});

import { describe, expect, test } from "vitest";

import { composeHeartbeatMessages } from "@src/heartbeat.ts";
import {
  BALANCED_RUN_PROFILE,
  FAST_RUN_PROFILE,
  HANDOFF_ELIGIBLE_STATES,
  TERMINAL_RUN_PROGRESS_STATES,
  applyRunProgressEvent,
  buildRunProgressEvent,
  initialRunProgress,
  materializeRunProgress,
  progressPercentFromStages,
  runProgressMessageProvider,
  sanitizeRunProgressExtras,
  type RunProgressTrackerState,
} from "@src/oracle/v18/run_progress.ts";
import {
  RUN_PROGRESS_SCHEMA_VERSION,
  V18_BUNDLE_VERSION,
  runProgressSchema,
} from "@src/oracle/v18/index.ts";

const NOW = new Date("2026-05-12T00:00:00.000Z");
const NOW_MS = NOW.getTime();

function freshTracker(): RunProgressTrackerState {
  return initialRunProgress({ run_id: "run-test-1", profile: BALANCED_RUN_PROFILE, now: NOW });
}

describe("progressPercentFromStages", () => {
  test("returns 0 for no completed stages", () => {
    expect(progressPercentFromStages(0, 5)).toBe(0);
  });

  test("caps at 99 when only one pending stage remains", () => {
    expect(progressPercentFromStages(10, 0)).toBe(91);
    expect(progressPercentFromStages(99, 0)).toBe(99);
  });

  test("scales monotonically with completed stages", () => {
    const a = progressPercentFromStages(1, 9);
    const b = progressPercentFromStages(5, 5);
    const c = progressPercentFromStages(9, 1);
    expect(a).toBeLessThan(b);
    expect(b).toBeLessThan(c);
  });

  test("returns 0 for negative or NaN inputs", () => {
    expect(progressPercentFromStages(-1, 5)).toBe(0);
    expect(progressPercentFromStages(5, -1)).toBe(0);
  });
});

describe("buildRunProgressEvent — required shape", () => {
  test("happy path running event passes runProgressSchema", () => {
    const event = buildRunProgressEvent({
      run_id: "run-1",
      profile: "balanced",
      state: "running",
      current_stage: "first_plan",
      completed_stages: ["brief_lint", "source_baseline", "route_plan", "preflight"],
      pending_stages: ["synthesis", "handoff"],
      user_visible_message: "First plan submission in flight.",
      next_command: null,
      now: NOW,
    });
    expect(() => runProgressSchema.parse(event)).not.toThrow();
    expect(event.schema_version).toBe(RUN_PROGRESS_SCHEMA_VERSION);
    expect(event.bundle_version).toBe(V18_BUNDLE_VERSION);
    expect(event.run_id).toBe("run-1");
    expect(event.progress_percent).toBeGreaterThan(0);
    expect(event.progress_percent).toBeLessThanOrEqual(99);
  });

  test("completed state always reports progress_percent=100", () => {
    const event = buildRunProgressEvent({
      run_id: "run-1",
      profile: "balanced",
      state: "completed",
      current_stage: "handoff",
      completed_stages: BALANCED_RUN_PROFILE.stages.slice(0, -1),
      pending_stages: [],
      progress_percent: 50, // caller lied
      user_visible_message: "Run complete.",
      now: NOW,
    });
    expect(event.progress_percent).toBe(100);
  });

  test("non-completed states never exceed 99", () => {
    const event = buildRunProgressEvent({
      run_id: "run-1",
      profile: "balanced",
      state: "running",
      current_stage: "first_plan",
      progress_percent: 500,
      user_visible_message: "Going hard.",
      now: NOW,
    });
    expect(event.progress_percent).toBe(99);
  });

  test("blocked state defaults blocked_reason and retry_safe=true", () => {
    const event = buildRunProgressEvent({
      run_id: "run-1",
      profile: "balanced",
      state: "blocked",
      current_stage: "preflight",
      user_visible_message: "Waiting for live provider approval.",
      now: NOW,
    });
    expect(event.blocked_reason).toBe("live_provider_action_required");
    expect(event.retry_safe).toBe(true);
  });

  test("retryable_failure defaults retry_safe=true", () => {
    const event = buildRunProgressEvent({
      run_id: "run-1",
      profile: "balanced",
      state: "retryable_failure",
      current_stage: "first_plan",
      user_visible_message: "Transient browser hiccup; safe to retry.",
      next_command: "oracle session run-1",
      now: NOW,
    });
    expect(event.retry_safe).toBe(true);
    expect(event.next_command).toBe("oracle session run-1");
    expect(event.blocked_reason).toBe("retryable_failure");
  });

  test("non_retryable_failure defaults retry_safe=false", () => {
    const event = buildRunProgressEvent({
      run_id: "run-1",
      profile: "balanced",
      state: "non_retryable_failure",
      current_stage: "first_plan",
      user_visible_message: "Provider policy violation; manual review required.",
      now: NOW,
    });
    expect(event.retry_safe).toBe(false);
    expect(event.blocked_reason).toBe("non_retryable_failure");
  });

  test("extras are round-tripped after sanitization", () => {
    const event = buildRunProgressEvent({
      run_id: "run-1",
      profile: "balanced",
      state: "blocked",
      current_stage: "first_plan",
      user_visible_message: "Provider chatgpt is unverified.",
      extras: {
        blocked_on_provider: "chatgpt",
        blocked_on_error_code: "chatgpt_pro_unverified",
        fallback_available: true,
      },
      now: NOW,
    });
    expect((event as Record<string, unknown>).blocked_on_provider).toBe("chatgpt");
    expect((event as Record<string, unknown>).blocked_on_error_code).toBe(
      "chatgpt_pro_unverified",
    );
    expect((event as Record<string, unknown>).fallback_available).toBe(true);
  });

  test("extras carrying reasoning-text keys are stripped", () => {
    const event = buildRunProgressEvent({
      run_id: "run-1",
      profile: "balanced",
      state: "thinking",
      current_stage: "first_plan",
      user_visible_message: "Pro is thinking…",
      extras: {
        observed_reasoning_effort_label: "Heavy", // safe — picker label
        raw_output: "leaked text",
        assistant_text: "leaked too",
        cookies: "session=abc",
      },
      now: NOW,
    });
    const serialized = JSON.stringify(event);
    for (const banned of ["raw_output", "assistant_text", "cookies", "leaked"]) {
      expect(serialized).not.toContain(banned);
    }
    // The non-forbidden picker label survives.
    expect(serialized).toContain("Heavy");
  });

  test("extras cannot overwrite typed core fields", () => {
    const event = buildRunProgressEvent({
      run_id: "run-1",
      profile: "balanced",
      state: "running",
      current_stage: "first_plan",
      user_visible_message: "ok",
      extras: {
        // adversarial: try to flip the typed run_id via extras
        run_id: "spoof",
        state: "completed",
      },
      now: NOW,
    });
    expect(event.run_id).toBe("run-1");
    expect(event.state).toBe("running");
  });
});

describe("sanitizeRunProgressExtras", () => {
  test("recursively drops forbidden keys", () => {
    const dirty = {
      meta: { cookie: "x", trace_id: "t1" },
      runs: [{ assistant_text: "leaked", attempt: 1 }, { count: 2 }],
      observed_reasoning_effort_label: "Pro",
    };
    const clean = sanitizeRunProgressExtras(dirty);
    expect(JSON.stringify(clean)).not.toMatch(/cookie|assistant_text|leaked/);
    expect(clean).toEqual({
      meta: { trace_id: "t1" },
      runs: [{ attempt: 1 }, { count: 2 }],
      observed_reasoning_effort_label: "Pro",
    });
  });
});

describe("applyRunProgressEvent — pure state transitions", () => {
  test("advance increments stage index and clears blocked state", () => {
    let tracker = freshTracker();
    tracker = applyRunProgressEvent(tracker, { type: "block", reason: "x", at: NOW_MS + 1000 });
    expect(tracker.state).toBe("blocked");
    tracker = applyRunProgressEvent(tracker, { type: "advance", at: NOW_MS + 2000 });
    expect(tracker.state).toBe("running");
    expect(tracker.current_stage).toBe(BALANCED_RUN_PROFILE.stages[1]);
  });

  test("advance never overshoots the last stage", () => {
    let tracker = freshTracker();
    for (let i = 0; i < BALANCED_RUN_PROFILE.stages.length + 5; i += 1) {
      tracker = applyRunProgressEvent(tracker, { type: "advance", at: NOW_MS + i * 1000 });
    }
    expect(tracker.stageIndex).toBe(BALANCED_RUN_PROFILE.stages.length - 1);
    expect(tracker.current_stage).toBe(
      BALANCED_RUN_PROFILE.stages[BALANCED_RUN_PROFILE.stages.length - 1],
    );
  });

  test("block / unblock toggles and records blocked metadata", () => {
    let tracker = freshTracker();
    tracker = applyRunProgressEvent(tracker, {
      type: "block",
      reason: "chatgpt_pro_unverified",
      provider: "chatgpt",
      errorCode: "chatgpt_pro_unverified",
      at: NOW_MS + 1000,
    });
    expect(tracker.state).toBe("blocked");
    expect(tracker.extras.blocked_on_provider).toBe("chatgpt");
    expect(tracker.extras.blocked_on_error_code).toBe("chatgpt_pro_unverified");

    tracker = applyRunProgressEvent(tracker, { type: "unblock", at: NOW_MS + 2000 });
    expect(tracker.state).toBe("running");
    expect(tracker.extras.blocked_on_provider).toBeUndefined();
    expect(tracker.extras.blocked_on_error_code).toBeUndefined();
  });

  test("fail records retryable vs non-retryable failure modes", () => {
    let retryable = freshTracker();
    retryable = applyRunProgressEvent(retryable, {
      type: "fail",
      reason: "timeout",
      retrySafe: true,
      at: NOW_MS + 1000,
    });
    expect(retryable.state).toBe("retryable_failure");
    expect(retryable.extras.fallback_available).toBe(true);

    let hard = freshTracker();
    hard = applyRunProgressEvent(hard, {
      type: "fail",
      reason: "policy_violation",
      retrySafe: false,
      at: NOW_MS + 1000,
    });
    expect(hard.state).toBe("non_retryable_failure");
    expect(hard.extras.fallback_available).toBe(false);
  });

  test("complete marks handoff_eligible and snaps stage index to the last stage", () => {
    let tracker = freshTracker();
    tracker = applyRunProgressEvent(tracker, { type: "complete", at: NOW_MS + 5000 });
    expect(tracker.state).toBe("completed");
    expect(tracker.stageIndex).toBe(BALANCED_RUN_PROFILE.stages.length - 1);
    expect(tracker.extras.implementation_handoff_eligible).toBe(true);
  });
});

describe("materializeRunProgress — tracker → run_progress.v1", () => {
  test("running tracker materializes a schema-valid event with completed/pending lists", () => {
    let tracker = freshTracker();
    tracker = applyRunProgressEvent(tracker, { type: "advance", at: NOW_MS + 1000 });
    tracker = applyRunProgressEvent(tracker, { type: "advance", at: NOW_MS + 2000 });
    const event = materializeRunProgress(tracker, {
      user_visible_message: "Source baseline being captured.",
      next_command: null,
      now: NOW,
    });
    expect(() => runProgressSchema.parse(event)).not.toThrow();
    expect(event.current_stage).toBe(BALANCED_RUN_PROFILE.stages[2]);
    expect(event.completed_stages).toEqual([
      BALANCED_RUN_PROFILE.stages[0],
      BALANCED_RUN_PROFILE.stages[1],
    ]);
    expect(event.pending_stages.length).toBe(BALANCED_RUN_PROFILE.stages.length - 3);
  });

  test("completed tracker materializes 100% with handoff-eligible flag", () => {
    let tracker = freshTracker();
    tracker = applyRunProgressEvent(tracker, { type: "complete", at: NOW_MS + 5000 });
    const event = materializeRunProgress(tracker, {
      user_visible_message: "Run complete.",
      now: NOW,
    });
    expect(event.state).toBe("completed");
    expect(event.progress_percent).toBe(100);
    expect((event as Record<string, unknown>).implementation_handoff_eligible).toBe(true);
    expect(HANDOFF_ELIGIBLE_STATES.has("completed")).toBe(true);
    expect(TERMINAL_RUN_PROGRESS_STATES.has("completed")).toBe(true);
  });

  test("FAST profile still satisfies the typed contract", () => {
    let tracker = initialRunProgress({
      run_id: "run-fast",
      profile: FAST_RUN_PROFILE,
      now: NOW,
    });
    tracker = applyRunProgressEvent(tracker, { type: "advance", at: NOW_MS + 1000 });
    const event = materializeRunProgress(tracker, {
      user_visible_message: "Fast profile baseline.",
      now: NOW,
    });
    expect(event.profile).toBe("fast");
    expect(() => runProgressSchema.parse(event)).not.toThrow();
  });
});

describe("runProgressMessageProvider + composeHeartbeatMessages", () => {
  test("emits a single JSON line of run_progress event when provider returns one", async () => {
    let tracker = freshTracker();
    tracker = applyRunProgressEvent(tracker, { type: "advance", at: NOW_MS + 1000 });
    const provider = runProgressMessageProvider(() =>
      materializeRunProgress(tracker, {
        user_visible_message: "running",
        now: NOW,
      }),
    );
    const out = await provider(1000);
    expect(typeof out).toBe("string");
    const parsed = JSON.parse(String(out));
    expect(parsed.schema_version).toBe(RUN_PROGRESS_SCHEMA_VERSION);
    expect(parsed.state).toBe("running");
  });

  test("returns null when the provider has no event yet (suppresses log line)", async () => {
    const provider = runProgressMessageProvider(() => null);
    expect(await provider(1000)).toBeNull();
  });

  test("composeHeartbeatMessages routes to the first non-null provider", async () => {
    const a = async () => null;
    const b = async () => "from-b";
    const c = async () => "from-c";
    const composed = composeHeartbeatMessages(a, b, c);
    expect(await composed(100)).toBe("from-b");
  });

  test("composed provider returns null when every provider returns null", async () => {
    const composed = composeHeartbeatMessages(
      async () => null,
      async () => null,
    );
    expect(await composed(100)).toBeNull();
  });
});

describe("heartbeat output never contains reasoning text", () => {
  test("emitted JSON line passes a strict reasoning-leak scan", async () => {
    const tracker = applyRunProgressEvent(freshTracker(), {
      type: "block",
      reason: "chatgpt_pro_unverified",
      provider: "chatgpt",
      errorCode: "chatgpt_pro_unverified",
      at: NOW_MS + 1000,
    });
    const provider = runProgressMessageProvider(() =>
      buildRunProgressEvent({
        run_id: tracker.run_id,
        profile: tracker.profile.profile,
        state: tracker.state,
        current_stage: tracker.current_stage,
        completed_stages: tracker.profile.stages.slice(0, tracker.stageIndex),
        pending_stages: tracker.profile.stages.slice(tracker.stageIndex + 1),
        user_visible_message: "Chatgpt pro thinking…",
        extras: {
          // Adversarial: simulate what a sloppy caller might pass.
          observed_reasoning_effort_label: "Heavy",
          raw_output: "the model said XYZ",
          assistant_text: "more text",
          authorization: "Bearer sk-secret",
          cookies: "session=abc",
        },
        now: NOW,
      }),
    );
    const line = await provider(1000);
    expect(typeof line).toBe("string");
    const text = String(line);
    for (const banned of [
      /raw_output/i,
      /assistant_text/i,
      /authorization/i,
      /Bearer\s+sk-/i,
      /cookies?/i,
      /the model said/i,
      /more text/i,
    ]) {
      expect(text).not.toMatch(banned);
    }
    // Picker label is fine.
    expect(text).toContain("Heavy");
  });
});

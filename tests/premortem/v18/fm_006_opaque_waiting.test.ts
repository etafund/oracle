import { describe, expect, test } from "vitest";

import { RUN_PROGRESS_SCHEMA_VERSION, V18_BUNDLE_VERSION } from "@src/oracle/v18/index.ts";
import {
  applyRunProgressEvent,
  buildRunProgressEvent,
  initialRunProgress,
  materializeRunProgress,
  runProgressMessageProvider,
} from "@src/oracle/v18/run_progress.ts";
import { premortemForId } from "@tests/_helpers/premortem.ts";

const FM = premortemForId("FM-006")!;
const NOW = new Date("2026-05-12T00:00:00Z");

describe(`premortem ${FM.id}: ${FM.title}`, () => {
  test("documents which Oracle acceptance checks this file covers", () => {
    expect(FM.oracle_acceptance_checks.length).toBeGreaterThan(0);
  });

  test("run_progress.v1 carries the four user-visible-recovery fields", () => {
    const event = buildRunProgressEvent({
      run_id: "run-fm006",
      profile: "balanced",
      state: "blocked",
      current_stage: "preflight",
      user_visible_message: "Waiting for live provider approval.",
      next_command: "oracle remote doctor --json",
      blocked_reason: "live_provider_action_required",
      now: NOW,
    });
    expect(event.schema_version).toBe(RUN_PROGRESS_SCHEMA_VERSION);
    expect(event.bundle_version).toBe(V18_BUNDLE_VERSION);
    expect(event.user_visible_message).toBe("Waiting for live provider approval.");
    expect(event.next_command).toBe("oracle remote doctor --json");
    expect(event.blocked_reason).toBe("live_provider_action_required");
    expect(typeof event.retry_safe).toBe("boolean");
  });

  test("blocked state surfaces blocked_on_provider + blocked_on_error_code in extras", () => {
    let tracker = initialRunProgress({ run_id: "run-fm006", now: NOW });
    tracker = applyRunProgressEvent(tracker, {
      type: "block",
      reason: "chatgpt_pro_unverified",
      provider: "chatgpt",
      errorCode: "chatgpt_pro_unverified",
      at: NOW.getTime() + 1_000,
    });
    const event = materializeRunProgress(tracker, {
      user_visible_message: "ChatGPT pro unverified; awaiting manual login.",
      now: new Date(NOW.getTime() + 2_000),
    });
    expect((event as Record<string, unknown>).blocked_on_provider).toBe("chatgpt");
    expect((event as Record<string, unknown>).blocked_on_error_code).toBe("chatgpt_pro_unverified");
  });

  test("heartbeat NDJSON line carries the v18 contract but no reasoning text", () => {
    const tracker = applyRunProgressEvent(initialRunProgress({ run_id: "run-fm006", now: NOW }), {
      type: "prompt_thinking" as never, // run_progress doesn't model thinking directly; advance
      at: NOW.getTime() + 1_000,
    } as never);
    void tracker; // tests for thinking live in reconnect/heartbeat; we just ensure the run_progress message provider is sanitized.
    const provider = runProgressMessageProvider(() =>
      buildRunProgressEvent({
        run_id: "run-fm006",
        profile: "balanced",
        state: "thinking",
        current_stage: "first_plan",
        user_visible_message: "Pro is thinking…",
        extras: {
          observed_reasoning_effort_label: "Heavy", // picker label is fine
          raw_output: "the model said X",
          assistant_text: "leaked",
          authorization: "Bearer sk-secret",
          cookies: "session=abc",
        },
        now: NOW,
      }),
    );
    const line = String(provider(1000));
    expect(line).toContain("Pro is thinking");
    expect(line).toContain("Heavy");
    for (const banned of [
      /raw_output/i,
      /assistant_text/i,
      /authorization/i,
      /Bearer\s+sk-/i,
      /cookies?/i,
      /the model said/i,
    ]) {
      expect(line).not.toMatch(banned);
    }
  });

  test("non-completed states clamp progress_percent at 99 (no false 100%)", () => {
    const event = buildRunProgressEvent({
      run_id: "run-fm006",
      profile: "balanced",
      state: "running",
      current_stage: "first_plan",
      progress_percent: 1000,
      user_visible_message: "running",
      now: NOW,
    });
    expect(event.progress_percent).toBeLessThanOrEqual(99);
  });
});

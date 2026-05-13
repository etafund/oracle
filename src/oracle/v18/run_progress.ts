// `run_progress.v1` event emission for long / multi-stage browser runs.
//
// Per oracle-cw3 + AGENTS.md: ChatGPT Pro thinking can outlive any
// reasonable timeout, so callers need a deterministic JSON progress
// signal — not prose, not reasoning text — to tell whether a run is
// actually making forward progress, which provider is currently
// blocking, and whether the caller should retry or hand off.
//
// This module:
//
//   * Defines the high-level lifecycle states (`preflight | running |
//     thinking | reconnecting | blocked | completed | retryable_failure
//     | non_retryable_failure`) and a pure transition function.
//   * Builds typed `run_progress.v1` payloads with strict-core
//     validation through `runProgressSchema` (which lives in pane 5's
//     `contracts.ts` — read-only here).
//   * Sanitizes every emitted event through the evidence module's
//     `FORBIDDEN_KEY_TEST` so reasoning-text-bearing extension keys
//     cannot piggy-back into the heartbeat log.
//   * Exposes a `runProgressMessageProvider(state, options)` factory
//     that callers wire into `src/heartbeat.ts`.

import {
  RUN_PROGRESS_SCHEMA_VERSION,
  V18_BUNDLE_VERSION,
  runProgressSchema,
  type RunProgress,
  type V18ErrorCode,
} from "./index.js";
import { FORBIDDEN_KEY_TEST } from "./index.js";

export type RunProgressState =
  | "preflight"
  | "running"
  | "thinking"
  | "reconnecting"
  | "blocked"
  | "completed"
  | "retryable_failure"
  | "non_retryable_failure";

export const TERMINAL_RUN_PROGRESS_STATES: ReadonlySet<RunProgressState> = new Set([
  "completed",
  "retryable_failure",
  "non_retryable_failure",
]);

export const HANDOFF_ELIGIBLE_STATES: ReadonlySet<RunProgressState> = new Set([
  "completed",
]);

export interface RunProgressStageProfile {
  /** Stable profile name reported on the event (matches v18 fixture). */
  readonly profile: string;
  /** Ordered stage list. The current stage's position drives `progress_percent`. */
  readonly stages: readonly string[];
}

/** Default balanced profile lifted from the v18 fixture run-progress.json. */
export const BALANCED_RUN_PROFILE: RunProgressStageProfile = Object.freeze({
  profile: "balanced",
  stages: Object.freeze([
    "brief_lint",
    "source_baseline",
    "route_plan",
    "preflight",
    "oracle_remote_smoke",
    "first_plan",
    "independent_review",
    "quorum",
    "compare",
    "synthesis",
    "handoff",
  ]) as readonly string[],
});

export const FAST_RUN_PROFILE: RunProgressStageProfile = Object.freeze({
  profile: "fast",
  stages: Object.freeze([
    "brief_lint",
    "source_baseline",
    "first_plan",
    "synthesis",
    "handoff",
  ]) as readonly string[],
});

export interface BuildRunProgressInput {
  readonly run_id: string;
  readonly profile: string;
  readonly state: RunProgressState;
  readonly current_stage: string;
  readonly completed_stages?: readonly string[];
  readonly pending_stages?: readonly string[];
  readonly progress_percent?: number;
  readonly user_visible_message: string;
  readonly next_command?: string | null;
  readonly blocked_reason?: string | null;
  readonly retry_safe?: boolean;
  readonly last_event_at?: string;
  readonly now?: Date;
  /**
   * Optional non-prose extras (e.g. which provider is currently blocking,
   * blocked-on error code). Reasoning-text-bearing keys are stripped.
   */
  readonly extras?: Record<string, unknown>;
}

/**
 * Compute progress percent from completed + pending stages.
 *
 *   percent = round(completed / (completed + 1 + pending) * 100)
 *
 * Clamped to [0, 100]; never returns 100 unless `state === "completed"`.
 * Callers that hard-cap progress for non-terminal states should rely on
 * `buildRunProgressEvent`, which applies that clamp.
 */
export function progressPercentFromStages(completed: number, pending: number): number {
  if (completed < 0 || pending < 0) return 0;
  const total = completed + 1 + pending;
  if (total <= 0) return 0;
  const raw = Math.round((completed / total) * 100);
  return Math.min(99, Math.max(0, raw));
}

function defaultRetrySafe(state: RunProgressState): boolean {
  switch (state) {
    case "retryable_failure":
      return true;
    case "non_retryable_failure":
      return false;
    case "blocked":
      // Blocked typically means waiting on a human action (login,
      // approval); retry-safe is true once the action is taken.
      return true;
    default:
      return true;
  }
}

function defaultBlockedReason(state: RunProgressState): string | null {
  switch (state) {
    case "blocked":
      return "live_provider_action_required";
    case "retryable_failure":
      return "retryable_failure";
    case "non_retryable_failure":
      return "non_retryable_failure";
    default:
      return null;
  }
}

function clampProgressPercent(state: RunProgressState, percent: number | undefined): number {
  if (state === "completed") return 100;
  if (typeof percent !== "number" || !Number.isFinite(percent)) return 0;
  if (percent < 0) return 0;
  if (percent > 99) return 99;
  return Math.round(percent);
}

/**
 * Strip any extension key whose name matches the reasoning-text family
 * (`raw_output`, `assistant_text`, etc.) recursively. We reuse
 * `FORBIDDEN_KEY_TEST` from the evidence module so heartbeat logs share
 * one redaction policy across the codebase.
 */
export function sanitizeRunProgressExtras(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeRunProgressExtras(entry));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (FORBIDDEN_KEY_TEST(key)) continue;
      out[key] = sanitizeRunProgressExtras(entry);
    }
    return out;
  }
  return value;
}

/**
 * Build a `run_progress.v1` event with strict-core required fields and
 * sanitized extras. Throws via zod when a required field is missing —
 * this is a build-time contract, not a soft warning.
 */
export function buildRunProgressEvent(input: BuildRunProgressInput): RunProgress {
  const now = input.now ?? new Date();
  const completed = input.completed_stages ?? [];
  const pending = input.pending_stages ?? [];
  const computedPercent =
    input.progress_percent ?? progressPercentFromStages(completed.length, pending.length);
  const percent = clampProgressPercent(input.state, computedPercent);
  const retry_safe = input.retry_safe ?? defaultRetrySafe(input.state);
  const blocked_reason =
    input.blocked_reason !== undefined ? input.blocked_reason : defaultBlockedReason(input.state);

  const draft: RunProgress = {
    schema_version: RUN_PROGRESS_SCHEMA_VERSION,
    bundle_version: V18_BUNDLE_VERSION,
    run_id: input.run_id,
    profile: input.profile,
    state: input.state,
    current_stage: input.current_stage,
    completed_stages: [...completed],
    pending_stages: [...pending],
    progress_percent: percent,
    user_visible_message: input.user_visible_message,
    next_command: input.next_command ?? null,
    blocked_reason,
    retry_safe,
    last_event_at: input.last_event_at ?? now.toISOString(),
  };

  if (input.extras !== undefined) {
    const sanitized = sanitizeRunProgressExtras(input.extras);
    if (sanitized && typeof sanitized === "object") {
      for (const [key, value] of Object.entries(sanitized as Record<string, unknown>)) {
        if (key in draft) continue; // never let an extra collide with a core field
        (draft as Record<string, unknown>)[key] = value;
      }
    }
  }

  // Final shape check — pane 5's typed runProgressSchema is the source of truth.
  return runProgressSchema.parse(draft);
}

/** Helper for the v18 fixture's `subset_focus` extension. */
export interface RunProgressExtras {
  readonly subset_focus?: string;
  readonly blocked_on_provider?: string;
  readonly blocked_on_error_code?: V18ErrorCode;
  readonly fallback_available?: boolean;
  readonly implementation_handoff_eligible?: boolean;
}

// ─── Pure state transitions ──────────────────────────────────────────────────

export interface RunProgressTrackerState {
  readonly run_id: string;
  readonly profile: RunProgressStageProfile;
  readonly state: RunProgressState;
  readonly current_stage: string;
  readonly stageIndex: number;
  readonly extras: Record<string, unknown>;
  readonly last_event_at: string;
}

export function initialRunProgress(
  input: {
    run_id: string;
    profile?: RunProgressStageProfile;
    now?: Date;
  },
): RunProgressTrackerState {
  const profile = input.profile ?? BALANCED_RUN_PROFILE;
  return {
    run_id: input.run_id,
    profile,
    state: "preflight",
    current_stage: profile.stages[0] ?? "preflight",
    stageIndex: 0,
    extras: {},
    last_event_at: (input.now ?? new Date()).toISOString(),
  };
}

export type RunProgressEvent =
  | { type: "advance"; at: number }
  | { type: "set_state"; state: RunProgressState; at: number }
  | { type: "block"; reason: string; provider?: string; errorCode?: V18ErrorCode; at: number }
  | { type: "unblock"; at: number }
  | { type: "fail"; retrySafe: boolean; reason: string; at: number }
  | { type: "complete"; at: number };

export function applyRunProgressEvent(
  state: RunProgressTrackerState,
  event: RunProgressEvent,
): RunProgressTrackerState {
  const at = new Date(event.at).toISOString();
  switch (event.type) {
    case "advance": {
      const nextIndex = Math.min(state.stageIndex + 1, state.profile.stages.length - 1);
      // Advancing past the first stage implicitly means the run is now
      // executing; preflight/blocked transitions to running unless the
      // caller explicitly set a terminal state.
      const nextRunState =
        state.state === "blocked" || state.state === "preflight" ? "running" : state.state;
      return {
        ...state,
        stageIndex: nextIndex,
        current_stage: state.profile.stages[nextIndex] ?? state.current_stage,
        state: nextRunState,
        last_event_at: at,
      };
    }
    case "set_state":
      return { ...state, state: event.state, last_event_at: at };
    case "block":
      return {
        ...state,
        state: "blocked",
        extras: {
          ...state.extras,
          blocked_reason: event.reason,
          ...(event.provider ? { blocked_on_provider: event.provider } : {}),
          ...(event.errorCode ? { blocked_on_error_code: event.errorCode } : {}),
        },
        last_event_at: at,
      };
    case "unblock": {
      const { blocked_reason, blocked_on_provider, blocked_on_error_code, ...rest } = state.extras;
      void blocked_reason;
      void blocked_on_provider;
      void blocked_on_error_code;
      return { ...state, state: "running", extras: rest, last_event_at: at };
    }
    case "fail":
      return {
        ...state,
        state: event.retrySafe ? "retryable_failure" : "non_retryable_failure",
        extras: {
          ...state.extras,
          failure_reason: event.reason,
          fallback_available: event.retrySafe,
        },
        last_event_at: at,
      };
    case "complete":
      return {
        ...state,
        state: "completed",
        stageIndex: state.profile.stages.length - 1,
        current_stage: state.profile.stages[state.profile.stages.length - 1] ?? state.current_stage,
        extras: { ...state.extras, implementation_handoff_eligible: true },
        last_event_at: at,
      };
  }
}

/**
 * Materialize the tracker state into a `run_progress.v1` event ready to
 * emit. Pure function — supply `user_visible_message` from the caller's
 * own UX layer, since this module is not allowed to invent prose.
 */
export interface MaterializeOptions {
  readonly user_visible_message: string;
  readonly next_command?: string | null;
  readonly blocked_reason?: string | null;
  readonly now?: Date;
}

export function materializeRunProgress(
  tracker: RunProgressTrackerState,
  options: MaterializeOptions,
): RunProgress {
  const completed = tracker.profile.stages.slice(0, tracker.stageIndex);
  const pending = tracker.profile.stages.slice(tracker.stageIndex + 1);
  return buildRunProgressEvent({
    run_id: tracker.run_id,
    profile: tracker.profile.profile,
    state: tracker.state,
    current_stage: tracker.current_stage,
    completed_stages: completed,
    pending_stages: pending,
    user_visible_message: options.user_visible_message,
    next_command: options.next_command ?? null,
    blocked_reason: options.blocked_reason,
    last_event_at: tracker.last_event_at,
    now: options.now,
    extras: tracker.extras,
  });
}

// ─── Heartbeat integration ───────────────────────────────────────────────────

/** A callback that returns the current run_progress event, or null to skip. */
export type RunProgressEventProvider = () => RunProgress | null;

/**
 * Builds a `HeartbeatConfig.makeMessage`-shaped callback that emits the
 * latest run_progress event as a single JSON line. Heartbeat lines that
 * leak reasoning text would defeat the whole point of `run_progress.v1`;
 * the event passes through the schema parse (so missing required fields
 * blow up loudly here, not in the log) and any extension keys have
 * already been stripped by `buildRunProgressEvent`.
 */
export function runProgressMessageProvider(
  provider: RunProgressEventProvider,
): (elapsedMs: number) => string | null {
  return (_elapsedMs: number) => {
    const event = provider();
    if (event == null) return null;
    return JSON.stringify(event);
  };
}

import { createHash } from "node:crypto";

import {
  GEMINI_DEEP_THINK_MANIFEST,
  type GeminiDeepThinkManifest,
} from "../../gemini-web/selectors/geminiDeepThinkManifest.js";
import type { V18ErrorCode } from "../../oracle/v18/json_envelope.js";

export const GEMINI_DEEP_THINK_SELECTOR_MANIFEST_VERSION = "gemini-deep-think-v1" as const;

export const GEMINI_DEEP_THINK_LEGAL_STATES = [
  "session_start",
  "remote_or_local_browser_connected",
  "login_verified",
  "gemini_model_candidate_selected",
  "deep_think_menu_open",
  "deep_think_candidate_selected",
  "deep_think_verified_same_session",
  "prompt_submitted",
  "response_streaming",
  "output_captured_nonempty",
  "evidence_written",
  "success",
] as const;
export type GeminiDeepThinkLegalState = (typeof GEMINI_DEEP_THINK_LEGAL_STATES)[number];

export const GEMINI_DEEP_THINK_FAILURE_STATES = [
  "login_required",
  "deep_think_unverified",
  "ui_drift_suspected",
  "usage_limit",
  "output_empty",
  "prompt_submitted_before_verification",
  "remote_browser_unavailable",
] as const;
export type GeminiDeepThinkFailureState = (typeof GEMINI_DEEP_THINK_FAILURE_STATES)[number];

export type GeminiDeepThinkState = GeminiDeepThinkLegalState | GeminiDeepThinkFailureState;

const LEGAL_RANK: Record<GeminiDeepThinkLegalState, number> = (() => {
  const map = Object.create(null) as Record<GeminiDeepThinkLegalState, number>;
  GEMINI_DEEP_THINK_LEGAL_STATES.forEach((state, idx) => {
    map[state] = idx;
  });
  return map;
})();

const FAILURE_STATE_SET: ReadonlySet<string> = new Set(GEMINI_DEEP_THINK_FAILURE_STATES);

const FAILURE_ERROR_CODE: Record<GeminiDeepThinkFailureState, V18ErrorCode> = {
  login_required: "provider_login_required",
  deep_think_unverified: "gemini_deep_think_unverified",
  ui_drift_suspected: "ui_drift_suspected",
  usage_limit: "provider_usage_limit",
  output_empty: "output_capture_empty",
  prompt_submitted_before_verification: "prompt_submitted_before_verification",
  remote_browser_unavailable: "remote_browser_unavailable",
};

export function isGeminiDeepThinkFailureState(
  state: GeminiDeepThinkState,
): state is GeminiDeepThinkFailureState {
  return FAILURE_STATE_SET.has(state);
}

export function geminiDeepThinkErrorCodeForFailure(
  state: GeminiDeepThinkFailureState,
): V18ErrorCode {
  return FAILURE_ERROR_CODE[state];
}

export type GeminiThinkingLevelTier = "standard" | "high";

export interface GeminiThinkingLevelTierEntry {
  readonly tier: GeminiThinkingLevelTier;
  readonly rank: number;
  readonly aliases: readonly string[];
}

export const GEMINI_THINKING_LEVEL_TIERS: readonly GeminiThinkingLevelTierEntry[] = Object.freeze([
  {
    tier: "standard",
    rank: 10,
    aliases: ["standard"],
  },
  {
    tier: "high",
    rank: 20,
    aliases: ["high"],
  },
]);

const GEMINI_THINKING_ALIAS_TO_TIER: ReadonlyMap<string, GeminiThinkingLevelTierEntry> = (() => {
  const map = new Map<string, GeminiThinkingLevelTierEntry>();
  for (const entry of GEMINI_THINKING_LEVEL_TIERS) {
    for (const alias of entry.aliases) {
      map.set(normalizeLabel(alias), entry);
    }
  }
  return map;
})();

export type GeminiDeepThinkVerificationStatus = "verified" | "unverified" | "ui_drift_suspected";

export interface GeminiDeepThinkVerificationResult {
  readonly status: GeminiDeepThinkVerificationStatus;
  readonly deepThinkLabel: string | null;
  readonly selected: string | null;
  readonly tier: GeminiThinkingLevelTier | "deep_think" | null;
  readonly rank: number | null;
  readonly selectedIsHighestVisible: boolean;
  readonly thinkingLevelControlExposed: boolean;
  readonly thinkingLevelVerified: boolean;
  readonly availableEffortLabelsHash: `sha256:${string}`;
  readonly selectorManifestVersion: typeof GEMINI_DEEP_THINK_SELECTOR_MANIFEST_VERSION;
  readonly errorCode: V18ErrorCode | null;
  readonly reason: string;
  readonly observedLabels: readonly string[];
}

export interface VerifyGeminiDeepThinkCandidateInput {
  readonly deepThinkLabel?: string | null;
  readonly observedThinkingLevelLabels?: readonly string[];
  readonly selectedThinkingLevel?: string | null;
  readonly thinkingLevelControlExposed?: boolean;
  readonly manifest?: GeminiDeepThinkManifest;
}

export function verifyGeminiDeepThinkCandidate(
  input: VerifyGeminiDeepThinkCandidateInput,
): GeminiDeepThinkVerificationResult {
  const manifest = input.manifest ?? GEMINI_DEEP_THINK_MANIFEST;
  const deepThinkLabel = normalizeDisplayLabel(input.deepThinkLabel ?? "");
  const observedThinkingLabels = normalizeDisplayLabels(input.observedThinkingLevelLabels ?? []);
  const observedLabels = deepThinkLabel
    ? [deepThinkLabel, ...observedThinkingLabels]
    : observedThinkingLabels;
  const hash = availableGeminiEffortLabelsHash(observedLabels);
  const requiredDeepThinkLabel = normalizeLabel(manifest.observedDeepThinkLabel);

  if (!labelContains(deepThinkLabel, requiredDeepThinkLabel)) {
    return {
      status: "unverified",
      deepThinkLabel: deepThinkLabel || null,
      selected: null,
      tier: null,
      rank: null,
      selectedIsHighestVisible: false,
      thinkingLevelControlExposed: Boolean(input.thinkingLevelControlExposed),
      thinkingLevelVerified: false,
      availableEffortLabelsHash: hash,
      selectorManifestVersion: GEMINI_DEEP_THINK_SELECTOR_MANIFEST_VERSION,
      errorCode: "gemini_deep_think_unverified",
      reason: `Observed Gemini mode label "${deepThinkLabel || "(empty)"}" does not verify Deep Think.`,
      observedLabels,
    };
  }

  const controlExposed =
    input.thinkingLevelControlExposed === true || observedThinkingLabels.length > 0;
  if (!controlExposed) {
    return {
      status: "verified",
      deepThinkLabel,
      selected: deepThinkLabel,
      tier: "deep_think",
      rank: 100,
      selectedIsHighestVisible: true,
      thinkingLevelControlExposed: false,
      thinkingLevelVerified: true,
      availableEffortLabelsHash: hash,
      selectorManifestVersion: GEMINI_DEEP_THINK_SELECTOR_MANIFEST_VERSION,
      errorCode: null,
      reason: "Deep Think is selected; no Gemini thinking-level control was exposed.",
      observedLabels,
    };
  }

  if (observedThinkingLabels.length === 0) {
    return {
      status: "unverified",
      deepThinkLabel,
      selected: null,
      tier: null,
      rank: null,
      selectedIsHighestVisible: false,
      thinkingLevelControlExposed: true,
      thinkingLevelVerified: false,
      availableEffortLabelsHash: hash,
      selectorManifestVersion: GEMINI_DEEP_THINK_SELECTOR_MANIFEST_VERSION,
      errorCode: "gemini_deep_think_unverified",
      reason: "Gemini thinking-level control was exposed but no option labels were visible.",
      observedLabels,
    };
  }

  const ranked = observedThinkingLabels
    .map((label) => ({ label, tier: tierForGeminiThinkingLevel(label) }))
    .sort((left, right) => (right.tier?.rank ?? -1) - (left.tier?.rank ?? -1));
  const top = ranked[0];
  if (!top?.tier) {
    return {
      status: "ui_drift_suspected",
      deepThinkLabel,
      selected: null,
      tier: null,
      rank: null,
      selectedIsHighestVisible: false,
      thinkingLevelControlExposed: true,
      thinkingLevelVerified: false,
      availableEffortLabelsHash: hash,
      selectorManifestVersion: GEMINI_DEEP_THINK_SELECTOR_MANIFEST_VERSION,
      errorCode: "ui_drift_suspected",
      reason: `Gemini thinking-level labels [${observedThinkingLabels.join(", ")}] do not match manifest ${GEMINI_DEEP_THINK_SELECTOR_MANIFEST_VERSION}.`,
      observedLabels,
    };
  }

  const selectedLabel = normalizeDisplayLabel(input.selectedThinkingLevel ?? top.label);
  const selectedTier = tierForGeminiThinkingLevel(selectedLabel);
  if (!selectedTier) {
    return {
      status: "ui_drift_suspected",
      deepThinkLabel,
      selected: selectedLabel || null,
      tier: null,
      rank: null,
      selectedIsHighestVisible: false,
      thinkingLevelControlExposed: true,
      thinkingLevelVerified: false,
      availableEffortLabelsHash: hash,
      selectorManifestVersion: GEMINI_DEEP_THINK_SELECTOR_MANIFEST_VERSION,
      errorCode: "ui_drift_suspected",
      reason: `Selected Gemini thinking level "${selectedLabel || "(empty)"}" is not known to the manifest.`,
      observedLabels,
    };
  }

  const selectedIsHighestVisible = selectedTier.rank >= top.tier.rank;
  if (!selectedIsHighestVisible) {
    return {
      status: "unverified",
      deepThinkLabel,
      selected: selectedLabel,
      tier: selectedTier.tier,
      rank: selectedTier.rank,
      selectedIsHighestVisible: false,
      thinkingLevelControlExposed: true,
      thinkingLevelVerified: false,
      availableEffortLabelsHash: hash,
      selectorManifestVersion: GEMINI_DEEP_THINK_SELECTOR_MANIFEST_VERSION,
      errorCode: "gemini_deep_think_unverified",
      reason: `Selected Gemini thinking level "${selectedLabel}" is not the highest visible option "${top.label}".`,
      observedLabels,
    };
  }

  return {
    status: "verified",
    deepThinkLabel,
    selected: selectedLabel,
    tier: selectedTier.tier,
    rank: selectedTier.rank,
    selectedIsHighestVisible: true,
    thinkingLevelControlExposed: true,
    thinkingLevelVerified: true,
    availableEffortLabelsHash: hash,
    selectorManifestVersion: GEMINI_DEEP_THINK_SELECTOR_MANIFEST_VERSION,
    errorCode: null,
    reason: `Selected Gemini thinking level "${selectedLabel}" as the highest visible option.`,
    observedLabels,
  };
}

export function availableGeminiEffortLabelsHash(labels: readonly string[]): `sha256:${string}` {
  const canonical = normalizeDisplayLabels(labels).sort().join("\n");
  const digest = createHash("sha256").update(canonical, "utf8").digest("hex");
  return `sha256:${digest}`;
}

export function tierForGeminiThinkingLevel(label: string): GeminiThinkingLevelTierEntry | null {
  return GEMINI_THINKING_ALIAS_TO_TIER.get(normalizeLabel(label)) ?? null;
}

export type GeminiDeepThinkEvent =
  | { type: "browser_connected"; mode: "remote" | "local" }
  | { type: "browser_connect_failed"; reason?: string }
  | { type: "login_verified" }
  | { type: "login_required" }
  | { type: "gemini_model_candidate_selected"; modelLabel: string }
  | { type: "deep_think_menu_opened" }
  | {
      type: "deep_think_candidate_selected";
      deepThinkLabel: string;
      observedThinkingLevelLabels?: readonly string[];
      selectedThinkingLevel?: string | null;
      thinkingLevelControlExposed?: boolean;
    }
  | {
      type: "deep_think_verified_same_session";
      sessionIdHash: `sha256:${string}`;
      verifiedAt?: string;
    }
  | { type: "usage_limit_observed" }
  | { type: "ui_drift_observed"; detail?: string }
  | { type: "submit_prompt"; promptSha256: `sha256:${string}`; submittedAt?: string }
  | { type: "response_stream_started" }
  | {
      type: "response_arrived";
      outputTextSha256: `sha256:${string}`;
      bytesLength: number;
      capturedAt?: string;
    }
  | { type: "evidence_written"; evidenceId: string; writtenAt?: string }
  | { type: "finish" };

export interface GeminiDeepThinkContext {
  readonly mode: "remote" | "local" | null;
  readonly modelLabel: string | null;
  readonly deepThink: GeminiDeepThinkVerificationResult | null;
  readonly sessionIdHash: `sha256:${string}` | null;
  readonly verifiedAt: string | null;
  readonly promptSha256: `sha256:${string}` | null;
  readonly promptSubmittedAt: string | null;
  readonly outputTextSha256: `sha256:${string}` | null;
  readonly outputBytes: number | null;
  readonly outputCapturedAt: string | null;
  readonly evidenceId: string | null;
  readonly evidenceWrittenAt: string | null;
  readonly selectorManifestVersion: typeof GEMINI_DEEP_THINK_SELECTOR_MANIFEST_VERSION;
  readonly failureReason: string | null;
}

const EMPTY_CONTEXT: GeminiDeepThinkContext = Object.freeze({
  mode: null,
  modelLabel: null,
  deepThink: null,
  sessionIdHash: null,
  verifiedAt: null,
  promptSha256: null,
  promptSubmittedAt: null,
  outputTextSha256: null,
  outputBytes: null,
  outputCapturedAt: null,
  evidenceId: null,
  evidenceWrittenAt: null,
  selectorManifestVersion: GEMINI_DEEP_THINK_SELECTOR_MANIFEST_VERSION,
  failureReason: null,
});

export interface GeminiDeepThinkMachine {
  readonly state: GeminiDeepThinkState;
  readonly context: GeminiDeepThinkContext;
  send(event: GeminiDeepThinkEvent): GeminiDeepThinkMachine;
}

export function createGeminiDeepThinkMachine(): GeminiDeepThinkMachine {
  return makeMachine("session_start", EMPTY_CONTEXT);
}

function makeMachine(
  state: GeminiDeepThinkState,
  context: GeminiDeepThinkContext,
): GeminiDeepThinkMachine {
  return {
    state,
    context,
    send(event) {
      const next = transitionGeminiDeepThink(state, context, event);
      return makeMachine(next.state, next.context);
    },
  };
}

export function transitionGeminiDeepThink(
  state: GeminiDeepThinkState,
  context: GeminiDeepThinkContext,
  event: GeminiDeepThinkEvent,
): { state: GeminiDeepThinkState; context: GeminiDeepThinkContext } {
  if (isGeminiDeepThinkFailureState(state)) return { state, context };

  if (event.type === "submit_prompt" && !modeAndDeepThinkVerified(state, context)) {
    return failureFrom(
      context,
      "prompt_submitted_before_verification",
      `submit_prompt rejected: machine is in state "${state}" before deep_think_verified_same_session.`,
    );
  }

  switch (event.type) {
    case "browser_connect_failed":
      return failureFrom(context, "remote_browser_unavailable", event.reason);

    case "browser_connected":
      if (state !== "session_start") return noop(state, context);
      return advance(context, "remote_or_local_browser_connected", { mode: event.mode });

    case "login_required":
      return failureFrom(context, "login_required", "Gemini login required");

    case "login_verified":
      if (state !== "remote_or_local_browser_connected") return noop(state, context);
      return advance(context, "login_verified");

    case "gemini_model_candidate_selected":
      if (state !== "login_verified") return noop(state, context);
      if (!isGeminiModelLabel(event.modelLabel)) {
        return failureFrom(
          context,
          "deep_think_unverified",
          `model label "${event.modelLabel}" is not a recognised Gemini candidate`,
        );
      }
      return advance(context, "gemini_model_candidate_selected", {
        modelLabel: event.modelLabel,
      });

    case "deep_think_menu_opened":
      if (state !== "gemini_model_candidate_selected") return noop(state, context);
      return advance(context, "deep_think_menu_open");

    case "deep_think_candidate_selected": {
      if (state !== "deep_think_menu_open") return noop(state, context);
      const verdict = verifyGeminiDeepThinkCandidate(event);
      const ctxWithVerdict: GeminiDeepThinkContext = { ...context, deepThink: verdict };
      if (verdict.status === "verified") {
        return {
          state: "deep_think_candidate_selected",
          context: ctxWithVerdict,
        };
      }
      if (verdict.status === "ui_drift_suspected") {
        return failureFrom(ctxWithVerdict, "ui_drift_suspected", verdict.reason);
      }
      return failureFrom(ctxWithVerdict, "deep_think_unverified", verdict.reason);
    }

    case "deep_think_verified_same_session":
      if (state !== "deep_think_candidate_selected") return noop(state, context);
      return advance(context, "deep_think_verified_same_session", {
        sessionIdHash: event.sessionIdHash,
        verifiedAt: normalizeIsoTime(event.verifiedAt) ?? null,
      });

    case "usage_limit_observed":
      return failureFrom(context, "usage_limit", "Gemini reported a usage limit");

    case "ui_drift_observed":
      return failureFrom(context, "ui_drift_suspected", event.detail ?? "ui drift observed");

    case "submit_prompt": {
      if (state !== "deep_think_verified_same_session") return noop(state, context);
      const submittedAt = normalizeIsoTime(event.submittedAt) ?? null;
      if (isBefore(submittedAt, context.verifiedAt)) {
        return failureFrom(
          context,
          "prompt_submitted_before_verification",
          "Gemini prompt timestamp precedes Deep Think same-session verification.",
        );
      }
      return advance(context, "prompt_submitted", {
        promptSha256: event.promptSha256,
        promptSubmittedAt: submittedAt,
      });
    }

    case "response_stream_started":
      if (state !== "prompt_submitted") return noop(state, context);
      return advance(context, "response_streaming");

    case "response_arrived": {
      if (state !== "prompt_submitted" && state !== "response_streaming") {
        return noop(state, context);
      }
      if (event.bytesLength <= 0) {
        return failureFrom(
          context,
          "output_empty",
          `Gemini Deep Think returned an empty response (${event.bytesLength} bytes)`,
        );
      }
      const capturedAt = normalizeIsoTime(event.capturedAt) ?? null;
      if (isBefore(capturedAt, context.promptSubmittedAt)) {
        return failureFrom(
          context,
          "ui_drift_suspected",
          "Gemini output timestamp precedes prompt submission.",
        );
      }
      return {
        state: "output_captured_nonempty",
        context: {
          ...context,
          outputTextSha256: event.outputTextSha256,
          outputBytes: event.bytesLength,
          outputCapturedAt: capturedAt,
        },
      };
    }

    case "evidence_written": {
      if (state !== "output_captured_nonempty") {
        return failureFrom(
          context,
          "ui_drift_suspected",
          `evidence_written rejected: machine is in state "${state}", expected "output_captured_nonempty" first`,
        );
      }
      const writtenAt = normalizeIsoTime(event.writtenAt) ?? null;
      if (isBefore(writtenAt, context.outputCapturedAt)) {
        return failureFrom(
          context,
          "ui_drift_suspected",
          "Gemini evidence timestamp precedes output capture.",
        );
      }
      return advance(context, "evidence_written", {
        evidenceId: event.evidenceId,
        evidenceWrittenAt: writtenAt,
      });
    }

    case "finish":
      if (state !== "evidence_written") {
        return failureFrom(
          context,
          "ui_drift_suspected",
          `finish rejected: machine is in state "${state}", expected "evidence_written" first`,
        );
      }
      return advance(context, "success");
  }
}

function modeAndDeepThinkVerified(
  state: GeminiDeepThinkState,
  context: GeminiDeepThinkContext,
): boolean {
  if (state !== "deep_think_verified_same_session") return false;
  if (context.deepThink?.status !== "verified") return false;
  if (context.deepThink.selectedIsHighestVisible !== true) return false;
  if (!context.sessionIdHash) return false;
  return true;
}

function advance(
  context: GeminiDeepThinkContext,
  next: GeminiDeepThinkLegalState,
  patch: Partial<GeminiDeepThinkContext> = {},
): { state: GeminiDeepThinkState; context: GeminiDeepThinkContext } {
  return { state: next, context: { ...context, ...patch } };
}

function failureFrom(
  context: GeminiDeepThinkContext,
  failure: GeminiDeepThinkFailureState,
  reason: string | undefined,
): { state: GeminiDeepThinkState; context: GeminiDeepThinkContext } {
  return {
    state: failure,
    context: {
      ...context,
      failureReason: reason ?? null,
    },
  };
}

function noop(
  state: GeminiDeepThinkState,
  context: GeminiDeepThinkContext,
): { state: GeminiDeepThinkState; context: GeminiDeepThinkContext } {
  return { state, context };
}

export function isGeminiModelLabel(label: string): boolean {
  return /\bgemini\b/i.test(label.trim());
}

export function isGeminiDeepThinkSuccessState(state: GeminiDeepThinkState): boolean {
  return state === "success";
}

export function geminiDeepThinkLegalStateRank(state: GeminiDeepThinkLegalState): number {
  return LEGAL_RANK[state];
}

function normalizeLabel(label: string): string {
  return label.trim().replace(/\s+/g, " ").toLowerCase();
}

function normalizeDisplayLabel(label: string): string {
  return label.trim().replace(/\s+/g, " ");
}

function normalizeDisplayLabels(labels: readonly string[]): string[] {
  return labels.map((label) => normalizeDisplayLabel(label)).filter((label) => label.length > 0);
}

function labelContains(label: string, expectedNeedle: string): boolean {
  return normalizeLabel(label).includes(expectedNeedle);
}

function normalizeIsoTime(value: string | null | undefined): string | null {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }
  const time = new Date(value);
  return Number.isFinite(time.getTime()) ? time.toISOString() : null;
}

function isBefore(left: string | null, right: string | null): boolean {
  if (!left || !right) return false;
  return new Date(left).getTime() < new Date(right).getTime();
}

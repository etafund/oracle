import type { BrowserModelSelectionEvidence, SessionMetadata } from "../sessionStore.js";
import { isGpt56SolModelLabel } from "./actions/thinkingTime.js";
import type { BrowserModelStrategy } from "./types.js";

interface BrowserModelDisplayInput {
  model?: string | null;
  desiredModel?: string | null;
  modelStrategy?: BrowserModelStrategy;
  evidence?: BrowserModelSelectionEvidence;
}

/**
 * Normalized labels that the ChatGPT picker can expose for reasoning effort
 * without exposing a model identity. Keep the in-page producer and every
 * consumer on this one list so a newly observed effort spelling cannot be
 * laundered into session/model output.
 *
 * `Thinking`, `Instant`, and `Pro` are intentionally absent: ChatGPT also uses
 * those strings as independently selectable model/variant labels.
 */
export const MODEL_AXIS_EFFORT_ONLY_LABELS = Object.freeze([
  "low",
  "light",
  "medium",
  "standard",
  "high",
  "very high",
  "xhigh",
  "x high",
  "extra high",
  "extended",
  "heavy",
  "max",
  "ultra",
] as const);

function cleanLabel(value?: string | null): string | null {
  const label = value?.trim();
  return label ? label : null;
}

function sameLabel(left: string, right: string): boolean {
  return left.localeCompare(right, undefined, { sensitivity: "accent" }) === 0;
}

function normalizeAxisLabel(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, " ")
    .trim();
}

function isEffortOnlyModelAxisLabel(value: string): boolean {
  const normalized = normalizeAxisLabel(value);
  return (MODEL_AXIS_EFFORT_ONLY_LABELS as readonly string[]).includes(normalized);
}

function combinesProtectedSolAndProOnModelAxis(value: string): boolean {
  const normalized = normalizeAxisLabel(value);
  const tokens = normalized.split(" ");
  // Accept only adjacency-preserving spellings of 5.6 here. This catches the
  // dotted/dashed/spaced and compact UI forms without confusing 6.5 or 5.60.
  const hasVersion = /(?:^| )(?:gpt ?5 ?6|5 ?6)(?: |$)/u.test(normalized);
  return hasVersion && tokens.includes("sol") && tokens.includes("pro");
}

function resolveTrustedObservedModelLabel(evidence?: BrowserModelSelectionEvidence): string | null {
  const observedModel = cleanLabel(evidence?.resolvedModelLabel);
  if (
    evidence?.source !== "chatgpt-model-picker" ||
    (evidence.status !== "already-selected" && evidence.status !== "switched") ||
    evidence.modelVerified !== true ||
    evidence.verified !== true ||
    !observedModel ||
    isEffortOnlyModelAxisLabel(observedModel) ||
    combinesProtectedSolAndProOnModelAxis(observedModel)
  ) {
    return null;
  }
  return observedModel;
}

function requestedModelLabel(input: BrowserModelDisplayInput): string | null {
  return (
    cleanLabel(input.evidence?.requestedModelLabel) ??
    cleanLabel(input.evidence?.requestedModel) ??
    cleanLabel(input.desiredModel) ??
    cleanLabel(input.model)
  );
}

function requiresProtectedSolProProof(input: BrowserModelDisplayInput): boolean {
  const requestedSolPro =
    isGpt56SolModelLabel(requestedModelLabel(input)) &&
    cleanLabel(input.evidence?.requestedMode)?.toLowerCase() === "pro";
  const observedSolPro =
    isGpt56SolModelLabel(input.evidence?.resolvedModelLabel) &&
    cleanLabel(input.evidence?.resolvedModeLabel)?.toLowerCase() === "pro";
  return requestedSolPro || observedSolPro;
}

/**
 * Return only a browser-observed identity supported by the fork's structured
 * evidence fields. The legacy `verified + resolvedLabel` pair is deliberately
 * ignored: older runs could populate it from the requested picker target.
 *
 * Adapted from upstream PR #318 (f19dc537d, ec844ca3c), with the fork's
 * independent model/mode and verify-before-submit requirements retained.
 */
export function resolveTrustedBrowserModelDisplayName(
  input: BrowserModelDisplayInput,
): string | null {
  const evidence = input.evidence;
  const observedModel = resolveTrustedObservedModelLabel(evidence);
  if (!evidence || !observedModel) {
    // Model and mode are independent proof axes. The shared observed-model
    // trust gate rejects effort text, combined Sol/Pro text, and evidence that
    // did not come from a successful verified picker selection.
    return null;
  }

  const requestedMode = cleanLabel(evidence.requestedMode);
  const observedMode = cleanLabel(evidence.resolvedModeLabel);
  const modeApplies = requestedMode !== null || observedMode !== null;
  if (modeApplies && (evidence.modeVerified !== true || !observedMode)) {
    return null;
  }
  if (requestedMode && observedMode && !sameLabel(requestedMode, observedMode)) {
    return null;
  }

  if (requiresProtectedSolProProof(input)) {
    if (
      evidence.verifiedBeforePromptSubmit !== true ||
      !isGpt56SolModelLabel(observedModel) ||
      observedMode?.toLowerCase() !== "pro"
    ) {
      return null;
    }
    const explicitRequestedModel = cleanLabel(evidence.requestedModelLabel);
    if (explicitRequestedModel && !isGpt56SolModelLabel(explicitRequestedModel)) {
      return null;
    }
  }

  return observedMode ? `${observedModel} + ${observedMode}` : observedModel;
}

/** Describe selection intent without presenting the target as observed fact. */
export function formatBrowserModelTarget({
  model,
  desiredModel,
  modelStrategy,
}: BrowserModelDisplayInput): string {
  const requested = cleanLabel(model) ?? "n/a";
  if (modelStrategy === "current" || modelStrategy === "ignore") {
    return `picker=${modelStrategy}; requested=${requested}`;
  }
  const target = cleanLabel(desiredModel);
  return target ? `target=${target}; requested=${requested}` : `requested=${requested}`;
}

/** Prefer trusted picker evidence; otherwise fail closed to the requested key. */
export function resolveBrowserModelDisplayName(input: BrowserModelDisplayInput): string {
  return resolveTrustedBrowserModelDisplayName(input) ?? cleanLabel(input.model) ?? "n/a";
}

export function formatBrowserModelWithRequestedKey(input: BrowserModelDisplayInput): string {
  const displayName = resolveBrowserModelDisplayName(input);
  const requested = cleanLabel(input.model);
  if (!requested || sameLabel(displayName, requested)) {
    return displayName;
  }
  return `${displayName} (requested ${requested})`;
}

function sessionEvidenceApplies(metadata: SessionMetadata, model?: string | null): boolean {
  const sessionModel = cleanLabel(metadata.model);
  const requestedModel = cleanLabel(model);
  return requestedModel === null
    ? sessionModel === null
    : sessionModel !== null && sameLabel(requestedModel, sessionModel);
}

export function resolveSessionBrowserModelDisplayName(
  metadata: SessionMetadata,
  model = metadata.model,
): string {
  return resolveBrowserModelDisplayName({
    model,
    evidence: sessionEvidenceApplies(metadata, model)
      ? metadata.browser?.modelSelection
      : undefined,
  });
}

export function formatSessionBrowserModelWithRequestedKey(
  metadata: SessionMetadata,
  model = metadata.model,
): string {
  return formatBrowserModelWithRequestedKey({
    model,
    evidence: sessionEvidenceApplies(metadata, model)
      ? metadata.browser?.modelSelection
      : undefined,
  });
}

export function formatBrowserModelSelectionEvidence(
  evidence: BrowserModelSelectionEvidence,
  model?: string | null,
): string {
  const requestedKey = cleanLabel(model) ?? "(none)";
  const target = cleanLabel(evidence.requestedModelLabel) ?? cleanLabel(evidence.requestedModel);
  const observedModel = resolveTrustedObservedModelLabel(evidence);
  const requestedMode = cleanLabel(evidence.requestedMode);
  const observedMode =
    evidence.modeVerified === true ? cleanLabel(evidence.resolvedModeLabel) : null;
  const trustedDisplay = resolveTrustedBrowserModelDisplayName({ model, evidence });
  const strategy = evidence.strategy ?? "(default)";
  return [
    `requestedKey=${requestedKey}`,
    `target=${target ?? "(none)"}`,
    `observedModel=${observedModel ?? "(unverified)"}`,
    `modelVerified=${observedModel ? "yes" : "no"}`,
    `requestedMode=${requestedMode ?? "(none)"}`,
    `observedMode=${observedMode ?? "(unverified)"}`,
    `modeVerified=${evidence.modeVerified === true ? "yes" : "no"}`,
    `verifiedBeforePromptSubmit=${evidence.verifiedBeforePromptSubmit === true ? "yes" : "no"}`,
    `trustedDisplay=${trustedDisplay ?? "(unverified)"}`,
    `status=${evidence.status}`,
    `strategy=${strategy}`,
    `aggregateVerified=${evidence.verified ? "yes" : "no"}`,
    `source=${evidence.source}`,
    `capturedAt=${evidence.capturedAt}`,
  ].join("; ");
}

import { createHash } from "node:crypto";

export type GeminiStreamCaptureErrorCode = "output_capture_empty" | "output_capture_unverified";

export type GeminiStreamCaptureMethod =
  | "stream_generate_latest_non_empty_candidate"
  | "stream_generate_image_candidate"
  | "stream_generate_terminal_error";

export type GeminiStreamCaptureConfidence = "high" | "medium" | "low";

export interface GeminiStreamCaptureFailureDetails {
  readonly code: GeminiStreamCaptureErrorCode;
  readonly message: string;
  readonly retry_safe: boolean;
  readonly capture_method: GeminiStreamCaptureMethod;
  readonly confidence: GeminiStreamCaptureConfidence;
  readonly current_prompt_sha256?: `sha256:${string}` | null;
  readonly current_session_id?: string | null;
  readonly expected_response_candidate_id?: string | null;
  readonly observed_response_candidate_id?: string | null;
  readonly chunk_count?: number;
  readonly non_empty_candidate_count?: number;
}

export class GeminiStreamCaptureError extends Error {
  readonly code: GeminiStreamCaptureErrorCode;
  readonly retry_safe: boolean;
  readonly capture_method: GeminiStreamCaptureMethod;
  readonly confidence: GeminiStreamCaptureConfidence;
  readonly details: GeminiStreamCaptureFailureDetails;

  constructor(details: GeminiStreamCaptureFailureDetails) {
    super(details.message);
    this.name = "GeminiStreamCaptureError";
    this.code = details.code;
    this.retry_safe = details.retry_safe;
    this.capture_method = details.capture_method;
    this.confidence = details.confidence;
    this.details = details;
  }
}

export interface GeminiStreamOwnershipInput {
  readonly expectedResponseCandidateId?: string | null;
  /**
   * The previous turn's observed response-candidate id (rcid). Gemini mints a
   * fresh rcid for every turn, so a continuation response that still carries
   * the previous turn's rcid is stale captured content (replay / cross-talk),
   * not this turn's answer.
   */
  readonly previousResponseCandidateId?: string | null;
  readonly observedResponseCandidateId?: string | null;
  readonly currentPromptSha256?: `sha256:${string}` | string | null;
  readonly currentSessionId?: string | null;
  readonly captureMethod?: GeminiStreamCaptureMethod;
}

export interface GeminiStreamCaptureSummary {
  readonly capture_method: GeminiStreamCaptureMethod;
  readonly confidence: GeminiStreamCaptureConfidence;
  readonly result_text_sha256: `sha256:${string}` | null;
  readonly output_bytes: number;
  readonly current_prompt_sha256: `sha256:${string}` | null;
  readonly current_session_id: string | null;
  readonly observed_response_candidate_id: string | null;
  readonly expected_response_candidate_id: string | null;
  readonly chunk_count: number;
  readonly non_empty_candidate_count: number;
}

export interface BuildGeminiStreamCaptureSummaryInput extends GeminiStreamOwnershipInput {
  readonly text: string;
  readonly imageCount?: number;
  readonly chunkCount: number;
  readonly nonEmptyCandidateCount: number;
}

export interface GeminiStreamTimeoutFailureInput extends GeminiStreamOwnershipInput {
  readonly elapsedMs: number;
  readonly timeoutMs: number;
}

export function stripAnsiEscapes(value: string): string {
  return value.replace(
    // eslint-disable-next-line no-control-regex
    /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g,
    "",
  );
}

export function sha256OfGeminiText(text: string): `sha256:${string}` {
  const digest = createHash("sha256").update(text, "utf8").digest("hex");
  return `sha256:${digest}`;
}

export function buildGeminiStreamCaptureSummary(
  input: BuildGeminiStreamCaptureSummaryInput,
): GeminiStreamCaptureSummary {
  const outputBytes = Buffer.byteLength(input.text, "utf8");
  const hasText = input.text.length > 0;
  const hasImages = (input.imageCount ?? 0) > 0;
  return {
    capture_method:
      input.captureMethod ??
      (hasText
        ? "stream_generate_latest_non_empty_candidate"
        : hasImages
          ? "stream_generate_image_candidate"
          : "stream_generate_terminal_error"),
    confidence: hasText || hasImages ? "high" : "low",
    result_text_sha256: hasText ? sha256OfGeminiText(input.text) : null,
    output_bytes: outputBytes,
    current_prompt_sha256: normalizeSha256(input.currentPromptSha256),
    current_session_id: input.currentSessionId ?? null,
    observed_response_candidate_id: input.observedResponseCandidateId ?? null,
    expected_response_candidate_id: input.expectedResponseCandidateId ?? null,
    chunk_count: input.chunkCount,
    non_empty_candidate_count: input.nonEmptyCandidateCount,
  };
}

export function assertGeminiStreamOwnership(input: GeminiStreamOwnershipInput): void {
  const expected = normalizeIdentifier(input.expectedResponseCandidateId);
  const previous = normalizeIdentifier(input.previousResponseCandidateId);
  const observed = normalizeIdentifier(input.observedResponseCandidateId);
  if (!observed) {
    return;
  }
  if (expected && expected !== observed) {
    throw new GeminiStreamCaptureError({
      code: "output_capture_unverified",
      message: `Gemini stream candidate ownership mismatch: expected ${expected}, observed ${observed}.`,
      retry_safe: true,
      capture_method: input.captureMethod ?? "stream_generate_latest_non_empty_candidate",
      confidence: "low",
      current_prompt_sha256: normalizeSha256(input.currentPromptSha256),
      current_session_id: input.currentSessionId ?? null,
      expected_response_candidate_id: expected,
      observed_response_candidate_id: observed,
    });
  }
  if (previous && previous === observed) {
    throw new GeminiStreamCaptureError({
      code: "output_capture_unverified",
      message:
        `Gemini stream returned stale candidate ${observed}: the response echoes the previous ` +
        "turn's candidate id instead of a fresh one for this turn.",
      retry_safe: true,
      capture_method: input.captureMethod ?? "stream_generate_latest_non_empty_candidate",
      confidence: "low",
      current_prompt_sha256: normalizeSha256(input.currentPromptSha256),
      current_session_id: input.currentSessionId ?? null,
      expected_response_candidate_id: expected,
      observed_response_candidate_id: observed,
    });
  }
}

export function assertGeminiStreamNonEmpty(
  summary: GeminiStreamCaptureSummary,
  options: { readonly imageCount?: number; readonly errorCode?: number } = {},
): void {
  if (summary.output_bytes > 0 || (options.imageCount ?? 0) > 0 || options.errorCode != null) {
    return;
  }
  throw new GeminiStreamCaptureError({
    code: "output_capture_empty",
    message: "Gemini stream completed without non-empty candidate text or image output.",
    retry_safe: true,
    capture_method: summary.capture_method,
    confidence: "low",
    current_prompt_sha256: summary.current_prompt_sha256,
    current_session_id: summary.current_session_id,
    expected_response_candidate_id: summary.expected_response_candidate_id,
    observed_response_candidate_id: summary.observed_response_candidate_id,
    chunk_count: summary.chunk_count,
    non_empty_candidate_count: summary.non_empty_candidate_count,
  });
}

export function geminiStreamTimeoutFailure(
  input: GeminiStreamTimeoutFailureInput,
): GeminiStreamCaptureError {
  return new GeminiStreamCaptureError({
    code: "output_capture_unverified",
    message: `Gemini stream timed out before verified non-empty output (${input.elapsedMs}/${input.timeoutMs} ms).`,
    retry_safe: true,
    capture_method: input.captureMethod ?? "stream_generate_latest_non_empty_candidate",
    confidence: "low",
    current_prompt_sha256: normalizeSha256(input.currentPromptSha256),
    current_session_id: input.currentSessionId ?? null,
    expected_response_candidate_id: input.expectedResponseCandidateId ?? null,
    observed_response_candidate_id: input.observedResponseCandidateId ?? null,
  });
}

function normalizeIdentifier(value: string | null | undefined): string | null {
  const normalized = String(value ?? "").trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizeSha256(value: string | null | undefined): `sha256:${string}` | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return /^sha256:[0-9a-f]{64}$/.test(normalized) ? (normalized as `sha256:${string}`) : null;
}

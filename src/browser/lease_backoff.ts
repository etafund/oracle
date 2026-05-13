export const DEFAULT_BROWSER_LEASE_BACKOFF_MAX_MS = 500;
export const DEFAULT_BROWSER_LEASE_BACKOFF_JITTER_RATIO = 0.25;

export interface BrowserLeaseBackoffDelayInput {
  readonly attempt: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs?: number;
  readonly remainingMs: number;
  readonly jitterRatio?: number;
  readonly random?: () => number;
}

export function browserLeaseBackoffDelayMs(input: BrowserLeaseBackoffDelayInput): number {
  const baseDelayMs = normalizePositiveMilliseconds(input.baseDelayMs, "baseDelayMs");
  const maxDelayMs = normalizePositiveMilliseconds(
    input.maxDelayMs ?? DEFAULT_BROWSER_LEASE_BACKOFF_MAX_MS,
    "maxDelayMs",
  );
  const remainingMs = normalizePositiveMilliseconds(input.remainingMs, "remainingMs");
  const jitterRatio = normalizeBrowserLeaseBackoffJitterRatio(input.jitterRatio);
  const attempt = Math.max(0, Math.trunc(input.attempt));
  const exponential = baseDelayMs * 2 ** Math.min(attempt, 20);
  const capped = Math.min(exponential, maxDelayMs);
  const jitter = capped * jitterRatio * (clampUnit(input.random?.() ?? Math.random()) * 2 - 1);
  return Math.max(1, Math.min(remainingMs, maxDelayMs, Math.round(capped + jitter)));
}

export function normalizeBrowserLeaseBackoffJitterRatio(value?: number): number {
  const ratio = value ?? DEFAULT_BROWSER_LEASE_BACKOFF_JITTER_RATIO;
  if (!Number.isFinite(ratio) || ratio < 0 || ratio > 1) {
    throw new Error("Browser lease mutation lock jitter ratio must be between 0 and 1.");
  }
  return ratio;
}

function normalizePositiveMilliseconds(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Browser lease backoff ${label} must be a positive number of milliseconds.`);
  }
  return Math.trunc(value);
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) {
    return 0.5;
  }
  return Math.min(1, Math.max(0, value));
}

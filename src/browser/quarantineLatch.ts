// Worker-local account quarantine latch (oracle-router-challenge-login-gates-cs1).
//
// ACCOUNT-SAFETY HARD-HALT DOCTRINE: when a verification interstitial or an
// account security block is detected, the two worst outcomes are (a) the
// interstitial being captured and returned as "the answer" and (b) callers
// retrying the challenged account's work into a *different* account
// (cross-account contagion). The latch is the hard stop for both:
//
// - It is tripped ATOMICALLY before the terminal error is surfaced, so a
//   crash between detection and reporting still leaves the worker latched.
// - While the latch file exists the worker refuses new runs (browser-side
//   pre-run gate) and the serve layer surfaces 503 (quarantined) on /ready
//   and refuses /runs — independent of any router-side drain, which can race
//   a caller retry.
// - The latch is cleared ONLY manually by a human (see
//   `clearQuarantineLatchManually`). No automated code path may clear it.
//   Automation never attempts to click through, solve, retry, or evade a
//   verification step; the account owner resolves it by hand. This is
//   defensive fault isolation, never anti-detection.
//
// Atomic-write and fail-closed-read patterns follow the tab-lease registry
// hardening (tabLeaseRegistry.ts, f62639b2): same-directory temp file +
// fsync + atomic publish; unreadable/corrupt latch reads FAIL CLOSED as
// "quarantined" because a corrupt latch still proves something tripped it.

import { randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BrowserAutomationError } from "../oracle/errors.js";

/** Terminal error class consumed by serve/router: never retryable. */
export const ACCOUNT_QUARANTINE_ERROR_CLASS = "account_quarantine";

/**
 * Mirrors the serve layer's worker-identity fallback (src/remote/server.ts
 * DEFAULT_ACCOUNT_ID). Keep in sync: both layers must agree on the latch
 * filename for the same worker.
 */
export const DEFAULT_QUARANTINE_ACCOUNT_ID = "acct1";

export interface QuarantineLatchRecord {
  version: 1;
  accountId: string;
  /** Neutral state class that tripped the latch, e.g. "verification_interstitial". */
  reason: string;
  detail: string | null;
  runId: string | null;
  sessionId: string | null;
  /** ISO timestamp of the trip. */
  at: string;
  pid: number;
  /** Which gate tripped it, e.g. "pre-run-gate" | "pre-result-gate". */
  source: string;
  clearInstructions: string;
}

export interface QuarantineLatchState {
  quarantined: boolean;
  record: QuarantineLatchRecord | null;
  latchPath: string;
  /** Non-null when the latch file exists but could not be read/parsed (fail closed). */
  readError: string | null;
}

export interface QuarantineLatchOptions {
  /** Neutral worker account label; defaults to sanitized ORACLE_ACCOUNT_ID or "acct1". */
  accountId?: string;
  /** Latch directory override (tests, embedders). */
  dir?: string;
  env?: NodeJS.ProcessEnv;
}

export interface TripQuarantineLatchInput extends QuarantineLatchOptions {
  reason: string;
  detail?: string | null;
  runId?: string | null;
  sessionId?: string | null;
  source: string;
}

export interface TripQuarantineLatchOutcome {
  record: QuarantineLatchRecord;
  latchPath: string;
  /** True when an earlier trip already latched this account; its record is kept. */
  alreadyLatched: boolean;
}

export class AccountQuarantinedError extends BrowserAutomationError {
  constructor(state: QuarantineLatchState, context?: { reason?: string; source?: string }) {
    const reason = context?.reason ?? state.record?.reason ?? state.readError ?? "unknown";
    super(
      `Account is quarantined (${reason}); refusing to run. ` +
        "A human must resolve the account state and manually clear the latch file " +
        `at ${state.latchPath}. Automation never retries into or around a quarantined account.`,
      {
        stage: "account-quarantine",
        code: ACCOUNT_QUARANTINE_ERROR_CLASS,
        oracleErrorClass: ACCOUNT_QUARANTINE_ERROR_CLASS,
        retryable: false,
        accountId: state.record?.accountId ?? null,
        reason,
        source: context?.source ?? state.record?.source ?? null,
        latchPath: state.latchPath,
      },
    );
    this.name = "AccountQuarantinedError";
  }
}

/** Same acceptance rule as the serve layer's identity labels: neutral ids only. */
export function sanitizeQuarantineAccountId(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || !/^[A-Za-z0-9._-]{1,64}$/.test(trimmed)) {
    return undefined;
  }
  return trimmed;
}

export function resolveQuarantineAccountId(env: NodeJS.ProcessEnv = process.env): string {
  return sanitizeQuarantineAccountId(env.ORACLE_ACCOUNT_ID) ?? DEFAULT_QUARANTINE_ACCOUNT_ID;
}

export function quarantineLatchDir(options: QuarantineLatchOptions = {}): string {
  if (options.dir) {
    return options.dir;
  }
  const env = options.env ?? process.env;
  const fleetDir = env.ORACLE_FLEET_DIR?.trim();
  if (fleetDir) {
    return fleetDir;
  }
  const configHome = env.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), ".config");
  return path.join(configHome, "oracle-fleet");
}

export function quarantineLatchPath(options: QuarantineLatchOptions = {}): string {
  const accountId =
    sanitizeQuarantineAccountId(options.accountId) ??
    resolveQuarantineAccountId(options.env ?? process.env);
  return path.join(quarantineLatchDir(options), `quarantine-${accountId}.json`);
}

function parseLatchRecord(raw: string): QuarantineLatchRecord | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.accountId !== "string" || typeof record.reason !== "string") {
    return null;
  }
  return {
    version: 1,
    accountId: record.accountId,
    reason: record.reason,
    detail: typeof record.detail === "string" ? record.detail : null,
    runId: typeof record.runId === "string" ? record.runId : null,
    sessionId: typeof record.sessionId === "string" ? record.sessionId : null,
    at: typeof record.at === "string" ? record.at : "",
    pid: typeof record.pid === "number" ? record.pid : 0,
    source: typeof record.source === "string" ? record.source : "unknown",
    clearInstructions: typeof record.clearInstructions === "string" ? record.clearInstructions : "",
  };
}

/**
 * Read API for the serve layer (/ready body, /runs admission) and the
 * browser-side gates. FAIL CLOSED: a latch file that exists but cannot be
 * read or parsed still reports `quarantined: true` — a corrupt latch proves
 * something tripped it, and "unreadable" must never masquerade as "clear".
 */
export async function getQuarantineLatchState(
  options: QuarantineLatchOptions = {},
): Promise<QuarantineLatchState> {
  const latchPath = quarantineLatchPath(options);
  let raw: string;
  try {
    raw = await readFile(latchPath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === "ENOENT") {
      return { quarantined: false, record: null, latchPath, readError: null };
    }
    return {
      quarantined: true,
      record: null,
      latchPath,
      readError: error instanceof Error ? error.message : String(error),
    };
  }
  const record = parseLatchRecord(raw);
  if (!record) {
    return {
      quarantined: true,
      record: null,
      latchPath,
      readError: "latch file exists but is not a valid quarantine record",
    };
  }
  return { quarantined: true, record, latchPath, readError: null };
}

/**
 * Trip the latch atomically: write a same-directory temp file (fsynced),
 * then publish with link() so exactly one tripper wins and the FIRST trip's
 * record is preserved; later trips observe `alreadyLatched: true`. If link()
 * is unsupported by the filesystem, fall back to rename() — last-writer-wins
 * on the record, but the account still ends latched, which is the property
 * that matters.
 */
export async function tripQuarantineLatch(
  input: TripQuarantineLatchInput,
): Promise<TripQuarantineLatchOutcome> {
  const accountId =
    sanitizeQuarantineAccountId(input.accountId) ??
    resolveQuarantineAccountId(input.env ?? process.env);
  const latchPath = quarantineLatchPath({ ...input, accountId });
  const record: QuarantineLatchRecord = {
    version: 1,
    accountId,
    reason: input.reason,
    detail: input.detail ?? null,
    runId: input.runId ?? null,
    sessionId: input.sessionId ?? null,
    at: new Date().toISOString(),
    pid: process.pid,
    source: input.source,
    clearInstructions:
      "Manual human action required: resolve the account state in a real browser session, " +
      "then delete this file to clear the quarantine. No automated process may delete it.",
  };
  await mkdir(path.dirname(latchPath), { recursive: true });
  const tempPath = `${latchPath}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  const handle = await open(tempPath, "w");
  try {
    await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(tempPath, latchPath);
    await rm(tempPath, { force: true }).catch(() => undefined);
    return { record, latchPath, alreadyLatched: false };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === "EEXIST") {
      // First trip wins; keep its record.
      await rm(tempPath, { force: true }).catch(() => undefined);
      const existing = await getQuarantineLatchState({ ...input, accountId });
      return {
        record: existing.record ?? record,
        latchPath,
        alreadyLatched: true,
      };
    }
    // Filesystem without link() support: publish via rename instead.
    await rename(tempPath, latchPath);
    return { record, latchPath, alreadyLatched: false };
  }
}

/**
 * Hard stop consumed by the browser-side pre-run gate (and available to any
 * other worker-local entry point): throws the terminal, non-retryable
 * quarantine error while the latch exists.
 */
export async function assertNotQuarantined(options: QuarantineLatchOptions = {}): Promise<void> {
  const state = await getQuarantineLatchState(options);
  if (state.quarantined) {
    throw new AccountQuarantinedError(state);
  }
}

/**
 * MANUAL-ONLY clear. This function exists for human-driven tooling and tests;
 * no automated recovery/retry path may call it. Clearing the latch asserts a
 * human has resolved the account state by hand.
 */
export async function clearQuarantineLatchManually(
  options: QuarantineLatchOptions = {},
): Promise<{ cleared: boolean; latchPath: string }> {
  const latchPath = quarantineLatchPath(options);
  try {
    await rm(latchPath);
    return { cleared: true, latchPath };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === "ENOENT") {
      return { cleared: false, latchPath };
    }
    throw error;
  }
}

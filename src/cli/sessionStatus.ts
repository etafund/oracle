// The closed session-status enum, promoted to a runtime tuple so the
// machine-readable session surfaces (`oracle_session_list.v1`,
// `oracle_session.v1`) and the capabilities registry can advertise the
// exact, finite value set an agent polls on — instead of the open
// `string` the list contract used to type `status` as.
//
// This module deliberately has ZERO runtime dependencies (the only import
// is a type-only import of `SessionStatus`, which is erased at build
// time), so importing it from the cold-path capability registry never
// pulls in the session store / manager or any I/O.

import type { SessionStatus } from "../sessionManager.js";

/**
 * Every value `SessionMetadata.status` can hold, as a runtime tuple. The
 * `satisfies` clause guarantees every member is a real `SessionStatus`;
 * the exhaustiveness check below guarantees the tuple is complete, so a
 * new status added to `SessionStatus` fails the build here until it is
 * enumerated (and thus advertised to agents).
 */
export const SESSION_STATUS_VALUES = [
  "pending",
  "running",
  "completed",
  "partial",
  "error",
  "cancelled",
  "imported",
] as const satisfies readonly SessionStatus[];

// Compile-time exhaustiveness guard: if `SessionStatus` ever grows a value
// not present in SESSION_STATUS_VALUES, this assignment stops type-checking.
type _StatusExhaustive = SessionStatus extends (typeof SESSION_STATUS_VALUES)[number]
  ? true
  : never;
const _statusExhaustive: _StatusExhaustive = true;
void _statusExhaustive;

/** Statuses a record can no longer leave — including metadata-only imports. */
export const TERMINAL_SESSION_STATUSES = [
  "completed",
  "partial",
  "error",
  "cancelled",
  "imported",
] as const satisfies readonly SessionStatus[];

/** Statuses that mean the run is still in flight (or about to start). */
export const IN_FLIGHT_SESSION_STATUSES = [
  "pending",
  "running",
] as const satisfies readonly SessionStatus[];

const TERMINAL_SET: ReadonlySet<string> = new Set(TERMINAL_SESSION_STATUSES);
const STATUS_SET: ReadonlySet<string> = new Set(SESSION_STATUS_VALUES);

/**
 * Narrow the loosely-typed `SessionMetadata.status` (declared `string`)
 * to the closed {@link SessionStatus} enum for the JSON surfaces. Every
 * writer in the session store uses a real `SessionStatus`, so the fallback
 * is effectively unreachable; when a value is nonetheless unrecognized we
 * report it as `error` (the conservative terminal choice) rather than let
 * an off-contract string leak into a surface that advertises a closed set.
 */
export function coerceSessionStatus(value: string): SessionStatus {
  return (STATUS_SET.has(value) ? value : "error") as SessionStatus;
}

/**
 * Coerce a stored status after the caller has validated any imported-session
 * claim. A bare `status: "imported"` is not sufficient evidence: only the
 * exact metadata-only shape written by the strict importer may retain that
 * status on user- and agent-facing surfaces. Invalid imported records fail
 * closed as a terminal error.
 */
export function coerceValidatedSessionStatus(
  value: string,
  importedSessionIsPure: boolean,
): SessionStatus {
  if (value === "imported" && !importedSessionIsPure) {
    return "error";
  }
  return coerceSessionStatus(value);
}

/** True when `status` is a terminal state (`oracle wait` stops on these). */
export function isTerminalSessionStatus(status: string): boolean {
  return TERMINAL_SET.has(status);
}

/** True only when a terminal status represents a successful model run. */
export function isSuccessTerminalStatus(status: string): boolean {
  return status === "completed" || status === "partial";
}

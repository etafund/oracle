// The Oracle CLI process exit-code dictionary — a single source of truth
// consumed by both `oracle capabilities --json` and `oracle robot-docs`
// (agent-ergonomics Stage 1 self-doc primitives) so the documented
// contract can never drift from the two other places that independently
// decide a process exit code:
//   - `bin/oracle-cli.ts`'s top-level `main().catch()` handler
//     (`resolveTopLevelExitCode`), which defaults to 1 for any thrown
//     error lacking a numeric `.exitCode`, and honors 130 on SIGINT.
//   - `LaneRouteBlockError` (`src/cli/routeBlockError.ts`) and
//     `LaneRouteBlock` (`src/cli/lanePolicy.ts`), which both pin
//     `exitCode: 2` for the reviewed-lane policy gate.
//
// Every guardrail refusal Oracle ships today (`envGuard.ts`'s
// `ClaudeCodeEnvGuardError`, `localOwnerGuard.ts`'s
// `ClaudeCodeLocalOwnerError`, generic `OracleUserError` subclasses that
// don't set `.exitCode`) falls through to the "1" bucket below — this
// dictionary documents that behavior, it does not change it.
export const ORACLE_EXIT_CODE_DICTIONARY = Object.freeze({
  "0": "success — the run (or read command) completed and produced a result.",
  "1": "user_error — invalid input, a failed validation, a guardrail refusal (e.g. ANTHROPIC_API_KEY present for --lane fable-local, an unsafe local-owner check), or an unrecoverable provider/run error. This is the default bucket: any thrown error without a more specific exit code lands here.",
  "2": "lane_route_blocked — the request violates the reviewed-lane policy (agent_lane_blocked) or a bare positional was refused as a likely mistyped command. The JSON error envelope's blocked_reason/next_command/fix_command name the exact fix; no backend was started.",
  "3": "auth_required — the provider needs a fresh sign-in before it can run (provider_login_required / remote_browser_auth_failed / remote_browser_token_missing). Re-authenticate, then retry.",
  "4": "retryable_backoff — a transient capacity/lock condition (provider_usage_limit / remote_browser_unavailable / browser_lock_timeout). Safe to retry after a backoff.",
  "5": "timeout — the run exceeded its deadline or the connection dropped before completion (client-timeout / connection-lost). Safe to retry.",
  "6": "challenge_or_drift — the automation hit a human-verification challenge or a suspected UI drift (ui_drift_suspected / cloudflare-challenge). Complete the check or re-run; not silently retry-safe.",
  "7": "wait_timeout — `oracle wait <id>` reached its --timeout-seconds deadline before the session became terminal. The run is still in flight (not failed); poll again or wait longer. Safe to retry.",
  "130":
    "cancelled — the run was interrupted with SIGINT (Ctrl-C) before it finished. Safe to retry.",
} as const);

export type OracleExitCodeKey = keyof typeof ORACLE_EXIT_CODE_DICTIONARY;

/**
 * Exit code `oracle wait <id>` returns when it hits its --timeout-seconds
 * deadline before the session reaches a terminal state. Distinct from the
 * failure taxonomy (3–6): the run has NOT failed, it is simply still in
 * flight, so a caller can safely poll again. See dictionary key "7".
 */
export const ORACLE_WAIT_TIMEOUT_EXIT_CODE = 7 as const;

export const ORACLE_EXIT_CODE_KEYS: readonly OracleExitCodeKey[] = Object.freeze(
  Object.keys(ORACLE_EXIT_CODE_DICTIONARY) as OracleExitCodeKey[],
);

// ─── normalized error-class taxonomy ───────────────────────────────────────
//
// A single source of truth mapping a thrown error to (a) a distinct process
// exit code (consumed by `bin/oracle-cli.ts`'s `resolveTopLevelExitCode`) and
// (b) a stable, closed error-code string for the top-level `--json` envelope
// (consumed by `src/cli/errorEnvelope.ts`'s `normalizeTopLevelError`). Before
// this, operational failures collapsed into exit `1` and the envelope emitted
// free-form `OracleTransportError.reason` / `OracleUserError.category` strings
// that no documented enum listed, so agents could not branch retry logic on
// either surface. Classification is duck-typed (no `instanceof`) so this module
// stays dependency-free and off the cold startup path.

/** The closed set of normalized, retryable-aware error classes. */
export type OracleErrorClass =
  | "auth_required"
  | "retryable_backoff"
  | "timeout"
  | "challenge_or_drift";

export const ORACLE_ERROR_CLASS_EXIT_CODES: Readonly<Record<OracleErrorClass, number>> =
  Object.freeze({
    auth_required: 3,
    retryable_backoff: 4,
    timeout: 5,
    challenge_or_drift: 6,
  });

/** Error classes whose exit code / envelope should advertise retry_safe = true. */
const RETRY_SAFE_CLASSES: ReadonlySet<OracleErrorClass> = new Set<OracleErrorClass>([
  "retryable_backoff",
  "timeout",
]);

export function isRetrySafeErrorClass(cls: OracleErrorClass): boolean {
  return RETRY_SAFE_CLASSES.has(cls);
}

// Recovery-code / transport-reason / browser-stage tokens grouped by class.
// Tokens are matched case-insensitively against every string signal an error
// exposes (its `.reason`/`.code`/`.error_code`/`.blocked_reason`, the same keys
// under `.details`, and `.details.stage`). New tokens are additive: an
// unrecognized error still lands in the generic `1` bucket.
const TOKENS_BY_CLASS: Readonly<Record<OracleErrorClass, readonly string[]>> = Object.freeze({
  auth_required: [
    "provider_login_required",
    "remote_browser_auth_failed",
    "remote_browser_token_missing",
    "login_required",
  ],
  retryable_backoff: [
    "provider_usage_limit",
    "usage_limit",
    "remote_browser_unavailable",
    "browser_lock_timeout",
  ],
  timeout: ["client-timeout", "connection-lost", "connection_lost"],
  challenge_or_drift: ["ui_drift_suspected", "cloudflare-challenge", "challenge-gate"],
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function collectErrorTokens(error: unknown): string[] {
  if (!isRecord(error)) return [];
  const tokens: string[] = [];
  const pushFrom = (record: Record<string, unknown> | undefined): void => {
    if (!record) return;
    for (const key of ["reason", "code", "error_code", "blocked_reason", "stage"]) {
      const value = record[key];
      if (typeof value === "string" && value.length > 0) {
        tokens.push(value.toLowerCase());
      }
    }
  };
  pushFrom(error);
  pushFrom(isRecord(error.details) ? error.details : undefined);
  pushFrom(isRecord(error.recovery) ? error.recovery : undefined);
  return tokens;
}

/**
 * Classify a thrown error into one of the normalized {@link OracleErrorClass}
 * buckets, or `null` when no known recovery signal is present (caller keeps its
 * default). Purely additive: never downgrades an already-classified error.
 */
export function classifyOracleErrorClass(error: unknown): OracleErrorClass | null {
  const tokens = collectErrorTokens(error);
  if (tokens.length === 0) return null;
  const tokenSet = new Set(tokens);
  for (const cls of Object.keys(TOKENS_BY_CLASS) as OracleErrorClass[]) {
    if (TOKENS_BY_CLASS[cls].some((token) => tokenSet.has(token))) {
      return cls;
    }
  }
  return null;
}

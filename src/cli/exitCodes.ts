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
  "2": "lane_route_blocked — the request violates the reviewed-lane policy (agent_lane_blocked). The JSON error envelope's blocked_reason/next_command/fix_command name the exact fix; no backend was started.",
  "130":
    "cancelled — the run was interrupted with SIGINT (Ctrl-C) before it finished. Safe to retry.",
} as const);

export type OracleExitCodeKey = keyof typeof ORACLE_EXIT_CODE_DICTIONARY;

export const ORACLE_EXIT_CODE_KEYS: readonly OracleExitCodeKey[] = Object.freeze(
  Object.keys(ORACLE_EXIT_CODE_DICTIONARY) as OracleExitCodeKey[],
);

// `oracle wait <id> [--timeout-seconds N] [--json]` — the bounded,
// atomic "block until this session is done" primitive.
//
// Closes agent-workflow-gaps finding #0: before this, the only way to
// block on a run was `attachSession`'s unbounded `while (true)` reattach
// loop (no deadline, up to 60m), and there was no machine-readable
// terminal result for a specific session. `oracle wait` polls the session
// store with modest exponential backoff (no busy-spin), stops the instant
// the session reaches a terminal state OR the --timeout-seconds deadline
// passes, and exits with a code an agent can branch on:
//
//   * 0                              — terminal run success (completed/partial)
//                                      or a valid metadata-only import
//   * 3/4/5/6 (failure taxonomy)     — terminal failure, classified
//   * 1                              — terminal failure (generic) / cancelled
//   * 7 (ORACLE_WAIT_TIMEOUT_EXIT_CODE) — deadline hit, still in flight
//   * 1                              — no such session
//
// In `--json` mode the SAME `oracle_session.v1` object the read surfaces
// emit is written to stdout at the end (progress lines move to stderr), so
// a submit→wait→fetch loop parses one envelope; `data.exit_code` always
// agrees with the process exit code because both come from
// `resolveSessionExitCode`.

import type { SessionMetadata } from "../sessionManager.js";
import { sessionStore, wait } from "../sessionStore.js";
import { ORACLE_WAIT_TIMEOUT_EXIT_CODE } from "./exitCodes.js";
import {
  buildSessionJsonEnvelope,
  buildSessionNotFoundEnvelope,
  resolveSessionExitCode,
  resolveValidatedSessionStatus,
} from "./sessionJson.js";
import { isTerminalSessionStatus } from "./sessionStatus.js";

const INITIAL_POLL_MS = 500;
const MAX_POLL_MS = 5_000;
const BACKOFF_FACTOR = 1.5;

export interface RunWaitOptions {
  /** Deadline in seconds; omitted / <=0 means wait indefinitely. */
  readonly timeoutSeconds?: number;
  readonly json?: boolean;
}

export type WaitOutcome = "terminal" | "timeout" | "not_found";

export interface WaitLoopResult {
  readonly outcome: WaitOutcome;
  readonly metadata: SessionMetadata | null;
  readonly exitCode: number;
}

export interface WaitLoopDeps {
  readSession: (sessionId: string) => Promise<SessionMetadata | null>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  /** Called once per poll with the freshest metadata (for progress logging). */
  onObserve?: (metadata: SessionMetadata) => void;
  initialPollMs?: number;
  maxPollMs?: number;
}

/**
 * Poll the session store until the session is terminal or the deadline
 * passes. Pure control flow over injected deps — no direct clock, sleep,
 * or store access — so tests drive transitions deterministically.
 */
export async function runWaitLoop(
  sessionId: string,
  options: RunWaitOptions,
  deps: WaitLoopDeps,
): Promise<WaitLoopResult> {
  const hasDeadline = typeof options.timeoutSeconds === "number" && options.timeoutSeconds > 0;
  const deadline = hasDeadline ? deps.now() + (options.timeoutSeconds as number) * 1_000 : null;
  const initialPollMs = deps.initialPollMs ?? INITIAL_POLL_MS;
  const maxPollMs = deps.maxPollMs ?? MAX_POLL_MS;

  let pollMs = initialPollMs;
  let metadata = await deps.readSession(sessionId);
  if (!metadata) {
    return { outcome: "not_found", metadata: null, exitCode: 1 };
  }

  // biome-ignore lint/nursery/noUnnecessaryConditions: deliberate poll loop
  while (true) {
    const fresh = await deps.readSession(sessionId);
    if (fresh) {
      metadata = fresh;
    }
    deps.onObserve?.(metadata);
    if (isTerminalSessionStatus(resolveValidatedSessionStatus(metadata))) {
      return { outcome: "terminal", metadata, exitCode: resolveSessionExitCode(metadata) ?? 0 };
    }
    if (deadline != null) {
      const remaining = deadline - deps.now();
      if (remaining <= 0) {
        return { outcome: "timeout", metadata, exitCode: ORACLE_WAIT_TIMEOUT_EXIT_CODE };
      }
      await deps.sleep(Math.min(pollMs, remaining));
    } else {
      await deps.sleep(pollMs);
    }
    pollMs = Math.min(Math.ceil(pollMs * BACKOFF_FACTOR), maxPollMs);
  }
}

export interface RunWaitCommandIo {
  readonly stdout?: (text: string) => void;
  readonly stderr?: (text: string) => void;
  readonly deps?: Partial<WaitLoopDeps>;
}

/**
 * CLI entry point behind `oracle wait <id>`. Returns the process exit code
 * (the bin action assigns it to `process.exitCode`) so this stays a pure,
 * testable function that never mutates global process state.
 */
export async function runWaitCommand(
  sessionId: string,
  options: RunWaitOptions,
  io: RunWaitCommandIo = {},
): Promise<number> {
  const jsonMode = Boolean(options.json);
  const stdout = io.stdout ?? ((text: string) => void process.stdout.write(text));
  const stderr = io.stderr ?? ((text: string) => void process.stderr.write(text));
  // Liveness signal: in --json mode progress goes to stderr so stdout stays a
  // single clean envelope; otherwise it prints to stdout.
  const progress = (message: string): void => {
    if (jsonMode) {
      stderr(`${message}\n`);
    } else {
      stdout(`${message}\n`);
    }
  };

  const timeoutLabel =
    typeof options.timeoutSeconds === "number" && options.timeoutSeconds > 0
      ? `${options.timeoutSeconds}s`
      : "no deadline";
  progress(
    `Waiting for session ${sessionId} to reach a terminal state (timeout: ${timeoutLabel})…`,
  );

  let lastStatus: string | null = null;
  const result = await runWaitLoop(sessionId, options, {
    readSession: io.deps?.readSession ?? ((id) => sessionStore.readSession(id)),
    sleep: io.deps?.sleep ?? ((ms) => wait(ms)),
    now: io.deps?.now ?? (() => Date.now()),
    initialPollMs: io.deps?.initialPollMs,
    maxPollMs: io.deps?.maxPollMs,
    onObserve: (metadata) => {
      const status = resolveValidatedSessionStatus(metadata);
      if (status !== lastStatus) {
        lastStatus = status;
        progress(`  session ${sessionId} status: ${status}`);
      }
      io.deps?.onObserve?.(metadata);
    },
  });

  if (result.outcome === "not_found") {
    if (jsonMode) {
      stdout(`${JSON.stringify(buildSessionNotFoundEnvelope(sessionId), null, 2)}\n`);
    } else {
      stderr(`No session found with ID ${sessionId}.\n`);
    }
    return result.exitCode;
  }

  const metadata = result.metadata as SessionMetadata;
  const status = resolveValidatedSessionStatus(metadata);
  if (jsonMode) {
    const paths = await sessionStore.getPaths(sessionId).catch(() => null);
    const { envelope } = buildSessionJsonEnvelope(metadata, {
      sessionDir: paths?.dir,
      outputFile: paths?.log,
    });
    stdout(`${JSON.stringify(envelope, null, 2)}\n`);
    return result.exitCode;
  }

  if (result.outcome === "timeout") {
    progress(
      `Timed out after ${timeoutLabel}; session ${sessionId} is still ${status}. Exit ${result.exitCode} (wait_timeout).`,
    );
  } else {
    progress(`Session ${sessionId} finished with status ${status}. Exit ${result.exitCode}.`);
  }
  return result.exitCode;
}

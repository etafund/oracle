// `oracle cancel <id>` — cleanly abort a running or detached (paid,
// 5–60 min) run.
//
// Closes agent-workflow-gaps finding #1: before this there was no CLI verb
// to stop a run — an agent that launched a wrong or expensive Pro run
// could only wait for the timeout auto-abort or hunt the PID by hand,
// leaving the browser slot / lease dangling. `oracle cancel`:
//
//   1. SIGTERMs (then SIGKILLs after a grace period) the stored controller
//      process when it is still alive, using the same `process.kill(pid,0)`
//      liveness probe the session manager uses to detect orphans;
//   2. releases any browser tab lease the session still holds, through the
//      same locked mutation path a normal run's release takes
//      (`releaseSessionBrowserLeases` in browser/leaseIntegration.ts);
//   3. marks the session `cancelled` (a member of the closed status enum)
//      via the store's serialized-update guard, guarding against the race
//      where the run finished on its own between read and write.
//
// Idempotent by construction: on an already-terminal session it changes
// nothing, exits 0, and says so. `--json` emits the `oracle_session.v1`
// snapshot of the resulting session.

import type { SessionMetadata, SessionMetadataUpdater } from "../sessionManager.js";
import { sessionStore } from "../sessionStore.js";
import {
  releaseSessionBrowserLeases,
  type ReleasedSessionLease,
} from "../browser/leaseIntegration.js";
import { buildSessionJsonEnvelope, buildSessionNotFoundEnvelope } from "./sessionJson.js";
import { isTerminalSessionStatus } from "./sessionStatus.js";

const DEFAULT_GRACE_MS = 2_000;

export type CancelOutcome = "cancelled" | "already_terminal" | "not_found";

export interface RunCancelOptions {
  readonly json?: boolean;
  /** Grace window between SIGTERM and SIGKILL of the controller (default 2s). */
  readonly graceMs?: number;
}

export interface CancelResult {
  readonly outcome: CancelOutcome;
  readonly metadata: SessionMetadata | null;
  readonly killedPid: number | null;
  readonly killSignals: readonly ("SIGTERM" | "SIGKILL")[];
  readonly releasedLeases: readonly ReleasedSessionLease[];
  readonly exitCode: number;
}

export interface CancelDeps {
  readSession: (sessionId: string) => Promise<SessionMetadata | null>;
  updateSession: (sessionId: string, updates: SessionMetadataUpdater) => Promise<SessionMetadata>;
  releaseLeases: (sessionId: string) => Promise<ReleasedSessionLease[]>;
  isProcessAlive: (pid: number) => boolean;
  /** Send `signal` to `pid`; returns true when it was delivered. */
  killProcess: (pid: number, signal: "SIGTERM" | "SIGKILL") => boolean;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

/** The same `process.kill(pid, 0)` liveness probe the session manager uses. */
export function isProcessAlive(pid: number): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
    if (code === "ESRCH" || code === "EINVAL") {
      return false;
    }
    // EPERM (or anything else) means the process exists but we can't signal it.
    return true;
  }
}

function sendSignal(pid: number, signal: "SIGTERM" | "SIGKILL"): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

function defaultCancelDeps(): CancelDeps {
  return {
    readSession: (id) => sessionStore.readSession(id),
    updateSession: (id, updates) => sessionStore.updateSession(id, updates),
    releaseLeases: (id) => releaseSessionBrowserLeases(id),
    isProcessAlive,
    killProcess: sendSignal,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
  };
}

/**
 * Core cancel flow over injected deps. Returns a {@link CancelResult};
 * never mutates global process state and never throws for the ordinary
 * "already terminal" / "not found" cases so it is safe to call twice.
 */
export async function runCancelCore(
  sessionId: string,
  options: RunCancelOptions,
  deps: CancelDeps,
): Promise<CancelResult> {
  const metadata = await deps.readSession(sessionId);
  if (!metadata) {
    return {
      outcome: "not_found",
      metadata: null,
      killedPid: null,
      killSignals: [],
      releasedLeases: [],
      exitCode: 1,
    };
  }
  if (isTerminalSessionStatus(metadata.status)) {
    return {
      outcome: "already_terminal",
      metadata,
      killedPid: null,
      killSignals: [],
      releasedLeases: [],
      exitCode: 0,
    };
  }

  // 1. Terminate the controller process (SIGTERM, then SIGKILL after grace).
  const killSignals: ("SIGTERM" | "SIGKILL")[] = [];
  let killedPid: number | null = null;
  const controllerPid = metadata.browser?.runtime?.controllerPid;
  if (
    typeof controllerPid === "number" &&
    controllerPid > 0 &&
    deps.isProcessAlive(controllerPid)
  ) {
    killedPid = controllerPid;
    if (deps.killProcess(controllerPid, "SIGTERM")) {
      killSignals.push("SIGTERM");
    }
    const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
    const deadline = deps.now() + graceMs;
    while (deps.isProcessAlive(controllerPid) && deps.now() < deadline) {
      await deps.sleep(Math.min(100, Math.max(0, deadline - deps.now())));
    }
    if (deps.isProcessAlive(controllerPid) && deps.killProcess(controllerPid, "SIGKILL")) {
      killSignals.push("SIGKILL");
    }
  }

  // 2. Release any browser tab lease the session still holds.
  const releasedLeases = await deps
    .releaseLeases(sessionId)
    .catch(() => [] as ReleasedSessionLease[]);

  // 3. Mark the session cancelled through the locked update path, but only
  //    if the run did not finish on its own in the meantime (race guard).
  const nowIso = new Date(deps.now()).toISOString();
  const updater: SessionMetadataUpdater = (current) => {
    if (isTerminalSessionStatus(current.status)) {
      return {};
    }
    return {
      status: "cancelled",
      completedAt: current.completedAt ?? nowIso,
      errorMessage: current.errorMessage ?? "Cancelled via `oracle cancel`.",
      error: current.error ?? {
        category: "session",
        message: "Cancelled via `oracle cancel`.",
      },
      response: current.response ?? { status: "error", incompleteReason: "cancelled" },
    };
  };
  const updated = await deps.updateSession(sessionId, updater);

  return {
    outcome:
      isTerminalSessionStatus(updated.status) && updated.status !== "cancelled"
        ? "already_terminal"
        : "cancelled",
    metadata: updated,
    killedPid,
    killSignals,
    releasedLeases,
    exitCode: 0,
  };
}

export interface RunCancelCommandIo {
  readonly stdout?: (text: string) => void;
  readonly stderr?: (text: string) => void;
  readonly deps?: Partial<CancelDeps>;
}

/**
 * CLI entry point behind `oracle cancel <id>`. Returns the process exit
 * code so the bin action owns `process.exitCode` and this stays testable.
 */
export async function runCancelCommand(
  sessionId: string,
  options: RunCancelOptions,
  io: RunCancelCommandIo = {},
): Promise<number> {
  const jsonMode = Boolean(options.json);
  const stdout = io.stdout ?? ((text: string) => void process.stdout.write(text));
  const stderr = io.stderr ?? ((text: string) => void process.stderr.write(text));
  const deps: CancelDeps = { ...defaultCancelDeps(), ...io.deps };

  const result = await runCancelCore(sessionId, options, deps);

  if (result.outcome === "not_found") {
    if (jsonMode) {
      stdout(`${JSON.stringify(buildSessionNotFoundEnvelope(sessionId), null, 2)}\n`);
    } else {
      stderr(`No session found with ID ${sessionId}.\n`);
    }
    return result.exitCode;
  }

  const metadata = result.metadata as SessionMetadata;
  if (jsonMode) {
    const paths = await sessionStore.getPaths(sessionId).catch(() => null);
    const { envelope } = buildSessionJsonEnvelope(metadata, {
      sessionDir: paths?.dir,
      outputFile: paths?.log,
    });
    stdout(`${JSON.stringify(envelope, null, 2)}\n`);
    return result.exitCode;
  }

  if (result.outcome === "already_terminal") {
    stdout(
      `Session ${sessionId} is already ${metadata.status}; nothing to cancel (no-op, exit 0).\n`,
    );
    return result.exitCode;
  }

  const lines = [`Cancelled session ${sessionId} (status is now ${metadata.status}).`];
  if (result.killedPid != null) {
    lines.push(
      `  Controller pid ${result.killedPid}: ${
        result.killSignals.length > 0 ? result.killSignals.join(" then ") : "already exited"
      }.`,
    );
  }
  const released = result.releasedLeases.filter((lease) => lease.status === "released");
  if (released.length > 0) {
    lines.push(
      `  Released browser lease(s): ${released.map((lease) => lease.provider).join(", ")}.`,
    );
  }
  for (const line of lines) {
    stdout(`${line}\n`);
  }
  return result.exitCode;
}

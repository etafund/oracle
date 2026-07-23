import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { BrowserRunResult } from "../browserMode.js";
import { loadUserConfig } from "../config.js";
import type {
  BrowserRemoteRecoveryCompletionClaim,
  BrowserSessionConfig,
} from "../sessionManager.js";
import type { SessionMetadata } from "../sessionManager.js";
import { sessionStore } from "../sessionStore.js";
import { recoverRemoteBrowserSession, resolveRemoteBrowserPendingRecoveryClaim } from "./client.js";
import { resolveRemoteServiceConfig } from "./remoteServiceConfig.js";
import {
  deleteRemoteBrowserPendingRecoveryClaim,
  deleteRemoteBrowserRecoverySecret,
  InvalidStoredRemoteRecoverySecretError,
  readRemoteBrowserPendingRecoveryClaim,
  readRemoteBrowserRecoverySecret,
  toPublicRemoteRecoveryMetadata,
  writeRemoteBrowserRecoverySecret,
} from "./sessionRecoveryStore.js";
import { REMOTE_BROWSER_RECOVERY_PROTOCOL } from "./types.js";

export interface RecoverStoredRemoteBrowserSessionOptions {
  log?: (message?: string) => void;
  signal?: AbortSignal;
  /** Per-attempt timeout/config overrides used by bounded auto-reattach. */
  browserConfig?: BrowserSessionConfig;
  /** Origin-bound dispatch/commit lease acquired by the caller before /recover. */
  completionClaim?: BrowserRemoteRecoveryCompletionClaim;
}

interface RecoverStoredRemoteBrowserSessionDeps {
  loadConfig?: typeof loadUserConfig;
  recover?: typeof recoverRemoteBrowserSession;
}

export class RemoteBrowserRecoveryUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RemoteBrowserRecoveryUnavailableError";
  }
}

function readProcessStartToken(pid: number): string | undefined {
  if (process.platform !== "linux") return undefined;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const afterCommand = stat
      .slice(stat.lastIndexOf(")") + 2)
      .trim()
      .split(/\s+/);
    // /proc/<pid>/stat field 22 (starttime); afterCommand starts at field 3.
    return afterCommand[19];
  } catch {
    return undefined;
  }
}

function completionClaimIsStale(claim: BrowserRemoteRecoveryCompletionClaim): boolean {
  if (!Number.isInteger(claim.ownerPid) || claim.ownerPid <= 0) return true;
  try {
    process.kill(claim.ownerPid, 0);
    const liveStartToken = readProcessStartToken(claim.ownerPid);
    if (claim.ownerStartToken && liveStartToken && claim.ownerStartToken !== liveStartToken) {
      return true;
    }
    // Never steal from a demonstrably live process merely because a local
    // filesystem operation took longer than expected.
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

function currentRecoveryRouteIsBound(metadata: SessionMetadata, originRunId: string): boolean {
  const coordinate = metadata.browser?.remoteRecovery;
  const failedRun = metadata.browser?.remoteRun;
  return Boolean(
    coordinate &&
    failedRun?.terminalDoneOk === false &&
    coordinate.originRunId === originRunId &&
    failedRun.runId === originRunId &&
    failedRun.accountId === coordinate.accountId &&
    (failedRun.laneId ?? null) === (coordinate.laneId ?? null),
  );
}

/**
 * Atomically reserve the right to dispatch and persist a recovery. Callers
 * acquire this before /recover so a replayable capability cannot operate on
 * the same remote conversation from two processes at once. A unique claim id
 * also excludes two contenders recovering the same origin run.
 */
export async function claimRemoteBrowserRecoveryCompletion(
  sessionId: string,
  originRunId: string | undefined,
): Promise<BrowserRemoteRecoveryCompletionClaim | null> {
  if (!originRunId) return null;
  const claim: BrowserRemoteRecoveryCompletionClaim = {
    schema: "remote-browser-recovery-completion-claim.v1",
    originRunId,
    claimId: randomUUID(),
    claimedAt: new Date().toISOString(),
    ownerPid: process.pid,
    ownerStartToken: readProcessStartToken(process.pid),
  };
  let claimed = false;
  await sessionStore.updateSession(sessionId, (current) => {
    // updateSession may re-run this updater after an optimistic-concurrency
    // conflict. Reset on every invocation so the final invocation decides.
    claimed = false;
    const browser = current.browser;
    const existingClaim = browser?.remoteRecoveryCompletionClaim;
    if (
      !browser ||
      !currentRecoveryRouteIsBound(current, originRunId) ||
      (existingClaim && !completionClaimIsStale(existingClaim))
    ) {
      return {};
    }
    claimed = true;
    return {
      browser: {
        ...browser,
        remoteRecoveryCompletionClaim: claim,
      },
    };
  });
  return claimed ? claim : null;
}

/**
 * Release only this writer's reservation after a local persistence failure.
 * The public coordinate and private sidecar remain available for a retry.
 */
export async function releaseRemoteBrowserRecoveryCompletion(
  sessionId: string,
  claim: BrowserRemoteRecoveryCompletionClaim,
): Promise<boolean> {
  let released = false;
  await sessionStore.updateSession(sessionId, (current) => {
    released = false;
    const browser = current.browser;
    if (browser?.remoteRecoveryCompletionClaim?.claimId !== claim.claimId) return {};
    const { remoteRecoveryCompletionClaim: _claim, ...withoutClaim } = browser;
    released = true;
    return { browser: withoutClaim };
  });
  return released;
}

export function ownsRemoteBrowserRecoveryCompletion(
  metadata: SessionMetadata,
  claim: BrowserRemoteRecoveryCompletionClaim,
): boolean {
  return (
    metadata.browser?.remoteRecoveryCompletionClaim?.claimId === claim.claimId &&
    currentRecoveryRouteIsBound(metadata, claim.originRunId)
  );
}

/**
 * Detect the narrow partial-commit case where meta.json reached the terminal
 * state but updateSession later rejected while persisting normalized model
 * files. The fresh transcript path(s) make this stronger than status alone.
 */
export function isRemoteBrowserRecoveryCompletionPersisted(
  metadata: SessionMetadata | null,
  expectedRemoteRun: NonNullable<SessionMetadata["browser"]>["remoteRun"],
  expectedArtifacts: SessionMetadata["artifacts"],
): boolean {
  if (!metadata || !expectedRemoteRun || expectedRemoteRun.terminalDoneOk !== true) return false;
  const actualRun = metadata.browser?.remoteRun;
  if (
    metadata.status !== "completed" ||
    metadata.browser?.remoteRecovery ||
    metadata.browser?.remoteRecoveryCompletionClaim ||
    actualRun?.terminalDoneOk !== true ||
    actualRun.runId !== expectedRemoteRun.runId ||
    (actualRun.accountId ?? null) !== (expectedRemoteRun.accountId ?? null) ||
    (actualRun.laneId ?? null) !== (expectedRemoteRun.laneId ?? null)
  ) {
    return false;
  }
  const requiredTranscriptPaths = (expectedArtifacts ?? [])
    .filter((artifact) => artifact.kind === "transcript")
    .map((artifact) => artifact.path);
  if (requiredTranscriptPaths.length === 0) return false;
  const persistedPaths = new Set(
    (metadata.artifacts ?? [])
      .filter((artifact) => artifact.kind === "transcript")
      .map((artifact) => artifact.path),
  );
  return requiredTranscriptPaths.every((artifactPath) => persistedPaths.has(artifactPath));
}

export function isFailedRemoteBrowserOrigin(metadata: SessionMetadata): boolean {
  return (
    Boolean(metadata.browser?.remoteRecovery) ||
    metadata.browser?.remoteRun?.terminalDoneOk === false
  );
}

const MANUAL_HISTORY_GUIDANCE =
  "Open the conversation in the originating ChatGPT account's history; Oracle will not attach to a local or arbitrary account.";

async function pruneStaleRemoteRecoveryCoordinate(
  metadata: SessionMetadata,
  originRunId: string,
  completionClaim?: BrowserRemoteRecoveryCompletionClaim,
): Promise<void> {
  // Clear the public executable coordinate first. If the following best-effort
  // secret deletion fails, the nonsecret failed remoteRun marker still keeps
  // every caller fail-closed and the orphaned capability is undiscoverable.
  let pruned = false;
  await sessionStore.updateSession(metadata.id, (current) => {
    pruned = false;
    const activeClaim = current.browser?.remoteRecoveryCompletionClaim;
    if (
      current.browser?.remoteRecovery?.originRunId !== originRunId ||
      (activeClaim && activeClaim.claimId !== completionClaim?.claimId) ||
      current.browser.remoteRun?.terminalDoneOk === true
    ) {
      return {};
    }
    const {
      remoteRecovery: _remoteRecovery,
      remoteRecoveryCompletionClaim: _completionClaim,
      ...browser
    } = current.browser;
    pruned = true;
    return { browser };
  });
  if (pruned) {
    await deleteRemoteBrowserRecoverySecret(metadata.id, originRunId).catch(() => undefined);
  }
}

/**
 * Promote the private authority captured at /runs admission into the existing
 * executable recovery sidecar after the worker has durably bound it. This is
 * GET-only and cannot replay the original prompt.
 */
export async function promotePendingRemoteBrowserRecoveryClaim(
  metadata: SessionMetadata,
  options: { log?: (message?: string) => void; timeoutMs?: number } = {},
): Promise<SessionMetadata | null> {
  const failedRun = metadata.browser?.remoteRun;
  if (
    failedRun?.terminalDoneOk !== false ||
    !failedRun.runId ||
    !failedRun.accountId ||
    !failedRun.laneId
  ) {
    return null;
  }
  let pending;
  try {
    pending = await readRemoteBrowserPendingRecoveryClaim(metadata.id, failedRun.runId);
  } catch (error) {
    throw new RemoteBrowserRecoveryUnavailableError(
      `The stored pending remote recovery authority failed its owner-only file checks. ${MANUAL_HISTORY_GUIDANCE}`,
      { cause: error },
    );
  }
  if (!pending) return null;
  if (
    pending.originRunId !== failedRun.runId ||
    pending.accountId !== failedRun.accountId ||
    pending.originLaneId !== failedRun.laneId
  ) {
    throw new RemoteBrowserRecoveryUnavailableError(
      `Pending remote recovery authority does not match its authenticated failed-run route. ${MANUAL_HISTORY_GUIDANCE}`,
    );
  }

  const loaded = await loadUserConfig({ cwd: metadata.cwd ?? process.cwd() });
  const remote = resolveRemoteServiceConfig({ userConfig: loaded.config });
  if (!remote.host || !remote.token) {
    throw new RemoteBrowserRecoveryUnavailableError(
      "Remote browser recovery endpoint is not configured. Restore ORACLE_REMOTE_HOST and ORACLE_REMOTE_TOKEN (or browser.remoteHost/remoteToken) for the Oracle router that owns this account.",
    );
  }
  options.log?.(
    "[remote] Resolving the stored post-submit recovery claim without submitting another prompt.",
  );
  const { schema: _pendingSchema, ...pendingClaim } = pending;
  const carrier = await resolveRemoteBrowserPendingRecoveryClaim({
    host: remote.host,
    token: remote.token,
    claim: pendingClaim,
    timeoutMs: options.timeoutMs,
  });
  if (!carrier) {
    throw new RemoteBrowserRecoveryUnavailableError(
      "The stored post-submit recovery claim is not ready or is no longer available; the original prompt will not be replayed.",
    );
  }
  if (
    carrier.recovery.originRunId !== failedRun.runId ||
    carrier.accountId !== failedRun.accountId ||
    carrier.laneId !== failedRun.laneId
  ) {
    throw new RemoteBrowserRecoveryUnavailableError(
      "Resolved remote recovery capability changed its authenticated route; refusing promotion.",
    );
  }

  await writeRemoteBrowserRecoverySecret(metadata.id, carrier);
  const coordinate = toPublicRemoteRecoveryMetadata(carrier);
  let promoted = false;
  const updated = await sessionStore.updateSession(metadata.id, (current) => {
    promoted = false;
    const currentRun = current.browser?.remoteRun;
    const existing = current.browser?.remoteRecovery;
    const routeStillMatches =
      currentRun?.terminalDoneOk === false &&
      currentRun.runId === failedRun.runId &&
      currentRun.accountId === failedRun.accountId &&
      (currentRun.laneId ?? null) === (failedRun.laneId ?? null);
    if (
      !routeStillMatches ||
      current.browser?.remoteRecoveryCompletionClaim ||
      (existing && existing.originRunId !== failedRun.runId)
    ) {
      return {};
    }
    promoted = true;
    return {
      browser: {
        ...current.browser,
        remoteRecovery: coordinate,
      },
    };
  });
  if (!promoted) {
    const current = await sessionStore.readSession(metadata.id).catch(() => null);
    if (current?.browser?.remoteRecovery?.originRunId !== failedRun.runId) {
      await deleteRemoteBrowserRecoverySecret(metadata.id, failedRun.runId).catch(() => false);
    }
    throw new RemoteBrowserRecoveryUnavailableError(
      "A newer browser generation superseded the pending remote recovery claim.",
    );
  }
  await deleteRemoteBrowserPendingRecoveryClaim(metadata.id, failedRun.runId).catch(() => false);
  return updated ?? (await sessionStore.readSession(metadata.id));
}

/**
 * Capture a failed remote session on its originating account. This is the
 * single dispatcher used by manual and automatic reattach paths; a session
 * with remote recovery metadata never falls back to local Chrome.
 */
export async function recoverStoredRemoteBrowserSession(
  metadata: SessionMetadata,
  options: RecoverStoredRemoteBrowserSessionOptions = {},
  deps: RecoverStoredRemoteBrowserSessionDeps = {},
): Promise<BrowserRunResult> {
  const coordinate = metadata.browser?.remoteRecovery;
  if (!coordinate) {
    throw new RemoteBrowserRecoveryUnavailableError(
      `This session belongs to a failed remote browser route, but no executable private recovery capability is available. ${MANUAL_HISTORY_GUIDANCE}`,
    );
  }
  const failedRun = metadata.browser?.remoteRun;
  if (
    failedRun?.terminalDoneOk !== false ||
    failedRun.runId !== coordinate.originRunId ||
    failedRun.accountId !== coordinate.accountId ||
    (failedRun.laneId ?? null) !== (coordinate.laneId ?? null)
  ) {
    throw new RemoteBrowserRecoveryUnavailableError(
      "Remote browser recovery coordinate does not match its authenticated failed-run route; refusing recovery.",
    );
  }
  const expiresAtMs = Date.parse(coordinate.expiresAt);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
    await pruneStaleRemoteRecoveryCoordinate(
      metadata,
      coordinate.originRunId,
      options.completionClaim,
    );
    throw new RemoteBrowserRecoveryUnavailableError(
      `The private remote browser recovery capability expired. ${MANUAL_HISTORY_GUIDANCE}`,
    );
  }
  let secret;
  try {
    secret = await readRemoteBrowserRecoverySecret(metadata.id, coordinate.originRunId);
  } catch (error) {
    if (error instanceof InvalidStoredRemoteRecoverySecretError) {
      await pruneStaleRemoteRecoveryCoordinate(
        metadata,
        coordinate.originRunId,
        options.completionClaim,
      );
      if (error.kind === "legacy_protocol") {
        throw new RemoteBrowserRecoveryUnavailableError(
          `This session has a legacy v1 remote browser recovery sidecar. It is guidance-only and will never be executed. ${MANUAL_HISTORY_GUIDANCE}`,
          { cause: error },
        );
      }
      throw new RemoteBrowserRecoveryUnavailableError(
        `The private remote browser recovery capability failed its owner-only file checks. ${MANUAL_HISTORY_GUIDANCE}`,
        { cause: error },
      );
    }
    throw error;
  }
  if (!secret) {
    await pruneStaleRemoteRecoveryCoordinate(
      metadata,
      coordinate.originRunId,
      options.completionClaim,
    );
    throw new RemoteBrowserRecoveryUnavailableError(
      `This remote browser session predates secure recovery or its private capability file is missing. ${MANUAL_HISTORY_GUIDANCE}`,
    );
  }
  if (
    secret.accountId !== coordinate.accountId ||
    secret.laneId !== (coordinate.laneId ?? null) ||
    secret.recovery.originRunId !== coordinate.originRunId ||
    secret.recovery.expiresAt !== coordinate.expiresAt ||
    secret.recovery.stage !== coordinate.stage ||
    secret.recovery.runtime.conversationId !== coordinate.runtime.conversationId ||
    secret.recovery.runtime.tabUrl !== coordinate.runtime.tabUrl
  ) {
    await pruneStaleRemoteRecoveryCoordinate(
      metadata,
      coordinate.originRunId,
      options.completionClaim,
    );
    throw new RemoteBrowserRecoveryUnavailableError(
      `Remote browser recovery coordinate does not match its private capability; refusing cross-session recovery. ${MANUAL_HISTORY_GUIDANCE}`,
    );
  }

  const loaded = await (deps.loadConfig ?? loadUserConfig)({
    cwd: metadata.cwd ?? process.cwd(),
  });
  const remote = resolveRemoteServiceConfig({ userConfig: loaded.config });
  if (!remote.host || !remote.token) {
    throw new Error(
      "Remote browser recovery endpoint is not configured. Restore ORACLE_REMOTE_HOST and ORACLE_REMOTE_TOKEN (or browser.remoteHost/remoteToken) for the Oracle router that owns this account.",
    );
  }
  return await (deps.recover ?? recoverRemoteBrowserSession)({
    host: remote.host,
    token: remote.token,
    accountId: secret.accountId,
    request: {
      schema: REMOTE_BROWSER_RECOVERY_PROTOCOL,
      recovery: secret.recovery,
      promptPreview: secret.promptPreview,
      browserConfig: {
        ...(metadata.browser?.config ?? {}),
        ...(options.browserConfig ?? {}),
      },
      options: {
        heartbeatIntervalMs: metadata.options.heartbeatIntervalMs,
        verbose: metadata.options.verbose,
        sessionId: metadata.id,
      },
    },
    log: options.log,
    signal: options.signal,
  });
}

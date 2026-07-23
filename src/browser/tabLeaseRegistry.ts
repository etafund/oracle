import path from "node:path";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { link, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import type { BrowserLogger } from "./types.js";
import { BrowserAutomationError } from "../oracle/errors.js";
import { isProcessAlive } from "./profileState.js";
import { delay } from "./utils.js";

export const DEFAULT_MAX_CONCURRENT_CHATGPT_TABS = 3;
const REGISTRY_FILENAME = "oracle-tab-leases.json";
const REGISTRY_LOCK_DIRNAME = "oracle-tab-leases.lock";
const REGISTRY_LOCK_OWNER_FILENAME = "owner.json";
const REGISTRY_LOCK_ABANDONED_FILENAME = "abandoned.json";
const DEFAULT_POLL_MS = 1000;
const DEFAULT_STALE_MS = 6 * 60 * 60 * 1000;
// Waiters heartbeat on every poll and own no browser state. A stopped waiter
// may safely lose its place and rejoin when it resumes; keeping an orphaned
// waiter for the lease's six-hour safety window would unnecessarily wedge the
// whole FIFO behind a still-live long-running serve PID.
const DEFAULT_WAITER_STALE_MS = 2 * 60 * 1000;
const MAX_WAITER_FUTURE_SKEW_MS = 5 * 60 * 1000;
const REGISTRY_LOCK_TIMEOUT_MS = 10_000;
/**
 * Windows can briefly report a just-released lock directory as busy or
 * inaccessible while filesystem handles drain. Retry only these known
 * transient codes, and only for a small bounded window; EEXIST continues to
 * use the owner-aware lock path below.
 */
const WINDOWS_LOCK_TRANSIENT_RETRY_MS = 500;
// Leave a margin after the dead-owner steal threshold so bounded mutation
// waits get one real reclamation attempt before their own deadline wins.
const REGISTRY_MUTATION_LOCK_TIMEOUT_MS = REGISTRY_LOCK_TIMEOUT_MS + 1_000;
/**
 * A lock directory with no readable owner record (legacy writer or a crash
 * between mkdir() and the owner write) may only be reclaimed after this quiet
 * period. Locked critical sections are sub-second, so one minute is far
 * outside any legitimate hold time while still bounding recovery.
 */
const OWNERLESS_LOCK_STEAL_AGE_MS = 60_000;
/**
 * Bounded ASSUME-ACTIVE recovery for a corrupt registry file: quarantine and
 * restart empty only when at least one PID remains extractable, every such
 * PID is provably dead, and the file has been quiet for this long. Corruption
 * without owner evidence remains fail-closed for manual repair.
 */
const CORRUPT_REGISTRY_RECOVERY_QUIET_MS = 15 * 60 * 1000;
const DEFERRED_RELEASE_INITIAL_RETRY_MS = 250;
const DEFERRED_RELEASE_MAX_RETRY_MS = 30_000;

export interface BrowserTabLeaseRecord {
  id: string;
  pid: number;
  sessionId?: string;
  chromeHost?: string;
  chromePort?: number;
  chromeTargetId?: string;
  tabUrl?: string;
  createdAt: string;
  updatedAt: string;
}

interface BrowserTabLeaseIdentity {
  id: string;
  pid: number;
  createdAt: string;
}

interface DeferredBrowserTabLeaseRelease {
  identity: BrowserTabLeaseIdentity;
  /** The original release mutation committed; only lock recovery remains. */
  committedReleaseResult?: DeferredReleaseRepairResult;
  attempt: number;
  initialDelayMs: number;
  timer: ReturnType<typeof setTimeout> | null;
  completion: Promise<void>;
  resolveCompletion: () => void;
  onRelease?: (context: { isLastLease: boolean }) => Promise<void>;
  onRecovered: Set<() => void>;
}

const deferredBrowserTabLeaseReleases = new Map<string, DeferredBrowserTabLeaseRelease>();

interface BrowserTabWaiterRecord {
  id: string;
  pid: number;
  sessionId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface BrowserTabLease {
  id: string;
  release: (options?: {
    onRelease?: (context: { isLastLease: boolean }) => Promise<void>;
    /** Called if a failed synchronous release is later repaired in the background. */
    onDeferredRelease?: () => void;
  }) => Promise<void>;
  update: (patch: Partial<BrowserTabLeaseRecord>) => Promise<void>;
}

interface BrowserTabLeaseDeps {
  now?: () => number;
  /** Monotonic clock for in-process budgets; wall time remains `now`. */
  monotonicNow?: () => number;
  pid?: number;
  isProcessAlive?: (pid: number) => boolean;
  /** Test seam for the lock-free DevTools target snapshot used by reclamation. */
  listChromeTargetIds?: (options: {
    chromeHost: string;
    chromePort: number;
    signal?: AbortSignal;
  }) => Promise<readonly string[]>;
  /** Test seam for lock-publication/release fault injection. */
  registryLockOptions?: Pick<
    RegistryLockWaitOptions,
    "beforeOwnerPublish" | "platform" | "releaseRetryMs" | "rmLockDir"
  >;
}

const TARGET_RECLAIM_PROBE_TIMEOUT_MS = 1_500;
const TARGET_RECLAIM_PROBE_INTERVAL_MS = 5_000;

function defaultMonotonicNow(): number {
  return performance.now();
}

function elapsedMonotonicMs(startedAt: number, monotonicNow: () => number): number {
  return Math.max(0, monotonicNow() - startedAt);
}

/**
 * Fail-closed read outcome. `readable: false` means the registry exists but
 * cannot be verified (unreadable/corrupt/torn): callers must treat that as
 * ASSUME-ACTIVE — refuse to grant slots and report other leases as active —
 * never as an empty registry.
 */
type RegistryReadOutcome =
  | {
      readable: true;
      valid: BrowserTabLeaseRecord[];
      opaque: unknown[];
      /** FIFO order, including malformed entries retained fail-closed. */
      waiters: unknown[];
    }
  | { readable: false; reason: string; cause?: unknown; corruptRaw?: string };

/** Typed refusal for the lease-grant path when the registry is unverifiable. */
export class TabLeaseRegistryUnreadableError extends Error {
  constructor(profileDir: string, reason: string, cause?: unknown) {
    super(
      `ChatGPT tab-lease registry at ${path.join(profileDir, REGISTRY_FILENAME)} is unreadable or corrupt (${reason}); ` +
        "assuming active leases (fail-closed). Repair or remove the registry file to recover.",
      cause === undefined ? undefined : { cause },
    );
    this.name = "TabLeaseRegistryUnreadableError";
  }
}

/**
 * Surfaced when a process discovers, while releasing the registry lock, that
 * the lock directory it is about to remove no longer belongs to it (a peer's
 * dead-owner reclamation ran while this process held the lock and completed
 * the callback under it). Deleting the directory in that state would tear
 * down a different process's active critical section, so the release path
 * fails closed and throws instead of silently releasing or silently
 * abandoning it.
 */
export class TabLeaseRegistryLockOwnershipLostError extends Error {
  constructor(lockDir: string, options?: ErrorOptions) {
    super(
      `Tab-lease registry lock at ${lockDir} was reclaimed by another process while this process held it; ` +
        "refusing to release a lock that is no longer ours. Treat the operation just performed under this " +
        "lock as unverified, not successful.",
      options,
    );
    this.name = "TabLeaseRegistryLockOwnershipLostError";
  }
}

/**
 * Surfaced when a lock-steal attempt renames away what turns out to be a
 * fresh acquirer's lock directory (raced in between the liveness check and
 * the reclaim rename) and the subsequent attempt to hand it back collides
 * with yet another acquirer. There is no way to restore the displaced
 * owner's lock at that point, so the steal fails closed with a thrown error
 * instead of logging a warning and reporting the steal as successful.
 */
export class TabLeaseRegistryLockCollisionError extends Error {
  constructor(lockDir: string) {
    super(
      `Tab-lease registry lock steal at ${lockDir} collided with a concurrent acquirer while trying to ` +
        "restore a displaced fresh owner's lock; failing closed instead of assuming the steal succeeded cleanly.",
    );
    this.name = "TabLeaseRegistryLockCollisionError";
  }
}

export class TabLeaseRegistryLockWaitError extends Error {
  readonly reason: "aborted" | "timed out";

  constructor(lockDir: string, reason: "aborted" | "timed out") {
    super(`Tab-lease registry lock wait ${reason} at ${lockDir}.`);
    this.name = "TabLeaseRegistryLockWaitError";
    this.reason = reason;
  }
}

export class TabLeaseRegistryLockReleaseError extends Error {
  constructor(lockDir: string, cause?: unknown) {
    super(
      `Tab-lease registry lock at ${lockDir} could not be proved removed; retaining fail-closed lock state.`,
      cause === undefined ? undefined : { cause },
    );
    this.name = "TabLeaseRegistryLockReleaseError";
  }
}

/**
 * The callback committed successfully, but publishing unlock could not be
 * proved. Callers must treat `committedResult` as durable ownership evidence,
 * not retry the mutation as though it never happened.
 */
export class TabLeaseRegistryPostCommitUnlockError extends Error {
  readonly committedResult: unknown;

  constructor(committedResult: unknown, releaseError: unknown) {
    super(
      "Tab-lease registry mutation committed, but lock release could not be proved; the committed result remains authoritative.",
      { cause: releaseError },
    );
    this.name = "TabLeaseRegistryPostCommitUnlockError";
    this.committedResult = committedResult;
  }
}

export class OrphanedBrowserTabLeaseError extends Error {
  readonly lease: BrowserTabLease;

  constructor(lease: BrowserTabLease, cause: unknown) {
    super(
      `Browser tab lease ${lease.id} was durably written, but acquisition could not prove a safely unlocked hand-off; the lease remains active fail-closed.`,
      { cause },
    );
    this.name = "OrphanedBrowserTabLeaseError";
    this.lease = lease;
  }
}

export class OrphanedBrowserTabWaiterError extends Error {
  constructor(waiterId: string, acquisitionCause: unknown, cleanupCause: unknown) {
    const acquisitionMessage =
      acquisitionCause instanceof Error ? acquisitionCause.message : String(acquisitionCause);
    super(
      `${acquisitionMessage} Waiter ${waiterId} cleanup could not be proved; it remains queued fail-closed until stale/dead-owner pruning.`,
      { cause: new AggregateError([acquisitionCause, cleanupCause]) },
    );
    this.name = "OrphanedBrowserTabWaiterError";
  }
}

/**
 * Stable refusal when FIFO browser capacity cannot be obtained within the
 * caller's independent queue budget. A new admission is retry-safe and
 * pre-submit; recovery of an already-submitted run is explicitly not.
 */
export class BrowserTabLeaseQueueTimeoutError extends BrowserAutomationError {
  constructor(
    elapsedMs: number,
    maxConcurrentTabs: number,
    cause?: unknown,
    promptSubmitted = false,
  ) {
    super(
      `Timed out waiting for ChatGPT browser slot after ${Math.round(elapsedMs / 1000)}s (${maxConcurrentTabs} max).`,
      {
        stage: "browser-queue",
        code: "browser_lock_timeout",
        error_code: "browser_lock_timeout",
        oracleErrorClass: "capacity_busy",
        // A normal admission wait happens before dispatch and is safely
        // retryable. Recovery admission, however, belongs to an already-
        // submitted session: never let a generic retry wrapper interpret that
        // session as safe to replay merely because this particular wait was
        // pre-capture.
        retryable: !promptSubmitted,
        runtime: { promptSubmitted },
      },
      cause,
    );
    this.name = "BrowserTabLeaseQueueTimeoutError";
  }
}

/**
 * The FIFO queue budget expired while contending for the registry mutex,
 * before capacity could even be inspected. Keep the closed v18
 * `browser_lock_timeout` code, but expose a distinct stage/subtype so this is
 * not diagnosed as a full tab-capacity queue.
 */
export class BrowserTabLeaseRegistryLockTimeoutError extends BrowserAutomationError {
  constructor(elapsedMs: number, cause?: unknown, promptSubmitted = false) {
    super(
      `Timed out waiting for the ChatGPT tab-lease registry lock after ${Math.round(elapsedMs / 1000)}s.`,
      {
        stage: "browser-registry-lock",
        subtype: "registry_mutex",
        code: "browser_lock_timeout",
        error_code: "browser_lock_timeout",
        oracleErrorClass: "capacity_busy",
        retryable: !promptSubmitted,
        runtime: { promptSubmitted },
      },
      cause,
    );
    this.name = "BrowserTabLeaseRegistryLockTimeoutError";
  }
}

export function normalizeMaxConcurrentTabs(value: unknown): number {
  if (value === undefined || value === null) {
    return DEFAULT_MAX_CONCURRENT_CHATGPT_TABS;
  }
  const numeric = typeof value === "string" ? Number.parseInt(value, 10) : Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return DEFAULT_MAX_CONCURRENT_CHATGPT_TABS;
  }
  return Math.max(1, Math.trunc(numeric));
}

export async function acquireBrowserTabLease(
  profileDir: string,
  options: {
    maxConcurrentTabs?: number;
    timeoutMs?: number;
    pollMs?: number;
    logger?: BrowserLogger;
    sessionId?: string;
    chromeHost?: string;
    chromePort?: number;
    staleMs?: number;
    /** True when admission belongs to recovery of an already-submitted run. */
    promptSubmitted?: boolean;
    signal?: AbortSignal;
  },
  deps: BrowserTabLeaseDeps = {},
): Promise<BrowserTabLease> {
  const maxConcurrentTabs = normalizeMaxConcurrentTabs(options.maxConcurrentTabs);
  const pollMs = Math.max(50, options.pollMs ?? DEFAULT_POLL_MS);
  const timeoutMs = Math.max(0, options.timeoutMs ?? 0);
  const staleMs = Math.max(60_000, options.staleMs ?? DEFAULT_STALE_MS);
  const wallNow = deps.now ?? Date.now;
  const monotonicNow = deps.monotonicNow ?? defaultMonotonicNow;
  const pid = deps.pid ?? process.pid;
  const alive = deps.isProcessAlive ?? isProcessAlive;
  const leaseId = randomUUID();
  const startedAt = monotonicNow();
  let warned = false;
  let lastHeartbeatAt = 0;
  let lastTargetReclaimProbeAt = Number.NEGATIVE_INFINITY;
  let waiterMayExist = false;
  let leaseAcquired = false;
  let acquiredIdentity: BrowserTabLeaseIdentity | null = null;
  const createLeaseHandle = (): BrowserTabLease => ({
    id: leaseId,
    release: async (releaseOptions) =>
      releaseBrowserTabLease(profileDir, leaseId, options.logger, {
        ...releaseOptions,
        expectedIdentity: acquiredIdentity ?? undefined,
      }),
    update: async (patch) => updateBrowserTabLease(profileDir, leaseId, patch, options.logger),
  });

  const throwIfAborted = (): void => {
    if (options.signal?.aborted) {
      throw new Error("Browser tab-lease acquisition aborted by caller.");
    }
  };

  try {
    for (;;) {
      throwIfAborted();
      // A headful challenge intentionally preserves both its exact target and
      // capacity lease so a human can clear the wall. Once the human closes
      // that tab, however, the live serve PID would otherwise keep the lease
      // occupied until the six-hour heartbeat bound. Reconcile that state
      // before granting capacity. The DevTools read is deliberately OUTSIDE the
      // registry lock; reclaimMissingBrowserTabLeasesForClosedTargets performs
      // a second, locked compare-and-remove against the exact snapshot record.
      if (
        typeof options.chromeHost === "string" &&
        options.chromeHost.length > 0 &&
        typeof options.chromePort === "number" &&
        Number.isInteger(options.chromePort) &&
        options.chromePort > 0 &&
        monotonicNow() - lastTargetReclaimProbeAt >= TARGET_RECLAIM_PROBE_INTERVAL_MS
      ) {
        lastTargetReclaimProbeAt = monotonicNow();
        await reclaimMissingBrowserTabLeasesForClosedTargets(
          profileDir,
          {
            chromeHost: options.chromeHost,
            chromePort: options.chromePort,
            logger: options.logger,
            signal: options.signal,
          },
          { listChromeTargetIds: deps.listChromeTargetIds },
        ).catch((error) => {
          // Probe/read/lock ambiguity fails closed: retain every lease and let
          // the normal capacity path decide whether to wait. A caller abort is
          // surfaced by throwIfAborted immediately below.
          options.logger?.(
            `[browser] Could not reconcile closed-target tab leases: ${error instanceof Error ? error.message : String(error)}; retaining them fail-closed.`,
          );
        });
        throwIfAborted();
      }
      const acquired = await withRegistryLock(
        profileDir,
        async () => {
          const outcome = await readRegistryOutcomeLocked(profileDir, options.logger);
          if (!outcome.readable) {
            // Fail-closed grant path: an unverifiable registry cannot prove a
            // free slot, so refuse with a typed error instead of assuming free.
            throw new TabLeaseRegistryUnreadableError(profileDir, outcome.reason, outcome.cause);
          }
          const pruneOptions = { nowMs: wallNow(), staleMs, isProcessAlive: alive };
          const activeValid = pruneStaleLeases(outcome.valid, pruneOptions);
          const activeOpaque = pruneOpaqueRecords(outcome.opaque, pruneOptions);
          const timestamp = new Date(wallNow()).toISOString();
          let activeWaiters = pruneStaleWaiters(outcome.waiters, {
            ...pruneOptions,
            staleMs: Math.min(staleMs, DEFAULT_WAITER_STALE_MS),
          });
          const existingWaiterIndex = activeWaiters.findIndex(
            (waiter) => isWaiterRecord(waiter) && waiter.id === leaseId,
          );
          if (existingWaiterIndex >= 0) {
            activeWaiters = activeWaiters.map((waiter, index) =>
              index === existingWaiterIndex && isWaiterRecord(waiter)
                ? { ...waiter, updatedAt: timestamp }
                : waiter,
            );
          } else {
            activeWaiters.push({
              id: leaseId,
              pid,
              sessionId: options.sessionId,
              createdAt: timestamp,
              updatedAt: timestamp,
            } satisfies BrowserTabWaiterRecord);
          }

          const occupied = activeValid.length + activeOpaque.length;
          const availableSlots = Math.max(0, maxConcurrentTabs - occupied);
          const queuePosition = activeWaiters.findIndex(
            (waiter) => isWaiterRecord(waiter) && waiter.id === leaseId,
          );
          if (queuePosition < 0 || queuePosition >= availableSlots) {
            await writeRegistry(profileDir, {
              leases: [...activeValid, ...activeOpaque],
              waiters: activeWaiters,
            });
            waiterMayExist = true;
            return null;
          }

          const lease: BrowserTabLeaseRecord = {
            id: leaseId,
            pid,
            sessionId: options.sessionId,
            chromeHost: options.chromeHost,
            chromePort: options.chromePort,
            createdAt: timestamp,
            updatedAt: timestamp,
          };
          await writeRegistry(profileDir, {
            leases: [...activeValid, lease, ...activeOpaque],
            waiters: activeWaiters.filter(
              (waiter) => !(isWaiterRecord(waiter) && waiter.id === leaseId),
            ),
          });
          waiterMayExist = false;
          return lease;
        },
        options.logger,
        {
          ...deps.registryLockOptions,
          signal: options.signal,
          timeoutMs:
            timeoutMs > 0
              ? Math.max(0, timeoutMs - elapsedMonotonicMs(startedAt, monotonicNow))
              : undefined,
          monotonicNow,
        },
      );

      if (acquired) {
        leaseAcquired = true;
        acquiredIdentity = browserTabLeaseIdentity(acquired);
        const leaseHandle = createLeaseHandle();
        if (options.signal?.aborted) {
          // The abort may race the registry write. Remove the just-created
          // record before surfacing it so a vanished caller cannot leave an
          // orphan capacity claim without ever receiving a lease handle.
          try {
            await leaseHandle.release();
          } catch (error) {
            throw new OrphanedBrowserTabLeaseError(leaseHandle, error);
          }
          throwIfAborted();
        }
        options.logger?.(
          `[browser] Acquired ChatGPT browser slot ${leaseId.slice(0, 8)} (${maxConcurrentTabs} max).`,
        );
        return leaseHandle;
      }

      const elapsed = elapsedMonotonicMs(startedAt, monotonicNow);
      const heartbeatNow = monotonicNow();
      if (!warned || heartbeatNow - lastHeartbeatAt >= 30_000) {
        options.logger?.(
          `[browser] Waiting for ChatGPT browser slot (${maxConcurrentTabs} max, ${Math.round(elapsed / 1000)}s elapsed).`,
        );
        warned = true;
        lastHeartbeatAt = heartbeatNow;
      }
      if (timeoutMs > 0 && elapsed >= timeoutMs) {
        throw new BrowserTabLeaseQueueTimeoutError(
          elapsed,
          maxConcurrentTabs,
          undefined,
          options.promptSubmitted === true,
        );
      }
      await delayWithAbort(
        timeoutMs > 0 ? Math.min(pollMs, timeoutMs - elapsed) : pollMs,
        options.signal,
      );
    }
  } catch (error) {
    if (
      error instanceof TabLeaseRegistryPostCommitUnlockError &&
      isLeaseRecord(error.committedResult) &&
      error.committedResult.id === leaseId
    ) {
      // The whole-document rename landed before unlock failed. Preserve the
      // resulting lease as an explicit orphan handle so no caller can replay
      // acquisition while the durable capacity claim is forgotten.
      leaseAcquired = true;
      acquiredIdentity = browserTabLeaseIdentity(error.committedResult);
      throw new OrphanedBrowserTabLeaseError(createLeaseHandle(), error);
    }
    const acquisitionError =
      error instanceof TabLeaseRegistryLockWaitError && error.reason === "timed out"
        ? new BrowserTabLeaseRegistryLockTimeoutError(
            elapsedMonotonicMs(startedAt, monotonicNow),
            error,
            options.promptSubmitted === true,
          )
        : error;
    if (!leaseAcquired && waiterMayExist) {
      try {
        await removeBrowserTabWaiter(profileDir, leaseId, options.logger);
      } catch (cleanupError) {
        throw new OrphanedBrowserTabWaiterError(leaseId, acquisitionError, cleanupError);
      }
    }
    throw acquisitionError;
  }
}

async function delayWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    await delay(ms);
    return;
  }
  if (signal.aborted) throw new Error("Browser tab-lease acquisition aborted by caller.");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      },
      Math.max(0, ms),
    );
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(new Error("Browser tab-lease acquisition aborted by caller."));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Remove a queued acquisition only after an atomic, locked registry rewrite. */
async function removeBrowserTabWaiter(
  profileDir: string,
  waiterId: string,
  logger?: BrowserLogger,
): Promise<void> {
  await withRegistryLock(
    profileDir,
    async () => {
      const outcome = await readRegistryOutcomeLocked(profileDir, logger);
      if (!outcome.readable) {
        throw new TabLeaseRegistryUnreadableError(profileDir, outcome.reason, outcome.cause);
      }
      const waiters = outcome.waiters.filter(
        (waiter) => !(isWaiterRecord(waiter) && waiter.id === waiterId),
      );
      if (waiters.length === outcome.waiters.length) {
        return;
      }
      await writeRegistry(profileDir, {
        leases: [...outcome.valid, ...outcome.opaque],
        waiters,
      });
    },
    logger,
    { timeoutMs: REGISTRY_MUTATION_LOCK_TIMEOUT_MS },
  );
}

interface ClosedTargetLeaseReclaimDeps {
  listChromeTargetIds?: (options: {
    chromeHost: string;
    chromePort: number;
    signal?: AbortSignal;
  }) => Promise<readonly string[]>;
}

/**
 * Reclaim leases whose recorded, owned Chrome target was manually closed.
 *
 * This is deliberately a two-phase operation:
 * 1. read an atomic registry snapshot without the registry lock;
 * 2. list Chrome targets over DevTools (also without the registry lock);
 * 3. take the lock and remove only records that are byte-for-byte identical
 *    to the snapshot proved missing.
 *
 * A failed/ambiguous target probe reclaims nothing. A concurrent lease
 * update also reclaims nothing. The function never closes a target; it only
 * releases capacity after a successful target list proves that exact target
 * no longer exists.
 */
export async function reclaimMissingBrowserTabLeasesForClosedTargets(
  profileDir: string,
  options: {
    chromeHost: string;
    chromePort: number;
    logger?: BrowserLogger;
    signal?: AbortSignal;
  },
  deps: ClosedTargetLeaseReclaimDeps = {},
): Promise<number> {
  const snapshot = await readRegistryOutcome(profileDir);
  if (!snapshot.readable) {
    return 0;
  }

  // Only inspect the endpoint explicitly selected by this acquisition. Do
  // not follow arbitrary host/port values from a registry file.
  const endpointRecords = snapshot.valid.filter(
    (lease) =>
      lease.chromeHost === options.chromeHost &&
      lease.chromePort === options.chromePort &&
      typeof lease.chromeTargetId === "string" &&
      lease.chromeTargetId.length > 0,
  );
  if (endpointRecords.length === 0) {
    return 0;
  }

  const snapshotIdCounts = countLeaseIds(snapshot.valid);
  const listChromeTargetIds = deps.listChromeTargetIds ?? listChromeTargetIdsOverHttp;
  const liveTargetIds = new Set(
    await listChromeTargetIds({
      chromeHost: options.chromeHost,
      chromePort: options.chromePort,
      signal: options.signal,
    }),
  );
  const missingSnapshots = new Map<string, string>();
  for (const lease of endpointRecords) {
    // Duplicate lease IDs are structurally ambiguous. Keep all of them
    // fail-closed rather than allowing one observation to remove many.
    if (
      snapshotIdCounts.get(lease.id) === 1 &&
      lease.chromeTargetId &&
      !liveTargetIds.has(lease.chromeTargetId)
    ) {
      missingSnapshots.set(lease.id, JSON.stringify(lease));
    }
  }
  if (missingSnapshots.size === 0) {
    return 0;
  }

  const reclaimedIds = await withRegistryLock(
    profileDir,
    async () => {
      const current = await readRegistryOutcomeLocked(profileDir, options.logger);
      if (!current.readable) {
        return [] as string[];
      }
      const currentIdCounts = countLeaseIds(current.valid);
      const removed: string[] = [];
      const remaining = current.valid.filter((lease) => {
        const snapshotJson = missingSnapshots.get(lease.id);
        const exactUnchangedMatch =
          snapshotJson !== undefined &&
          currentIdCounts.get(lease.id) === 1 &&
          JSON.stringify(lease) === snapshotJson;
        if (exactUnchangedMatch) {
          removed.push(lease.id);
          return false;
        }
        return true;
      });
      if (removed.length > 0) {
        await writeRegistry(profileDir, {
          leases: [...remaining, ...current.opaque],
          waiters: current.waiters,
        });
      }
      return removed;
    },
    options.logger,
    { signal: options.signal, timeoutMs: REGISTRY_MUTATION_LOCK_TIMEOUT_MS },
  );

  for (const id of reclaimedIds) {
    options.logger?.(
      `[browser] Reclaimed ChatGPT browser slot ${id.slice(0, 8)} after its recorded target was manually closed.`,
    );
  }
  return reclaimedIds.length;
}

function countLeaseIds(leases: readonly BrowserTabLeaseRecord[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const lease of leases) {
    counts.set(lease.id, (counts.get(lease.id) ?? 0) + 1);
  }
  return counts;
}

async function listChromeTargetIdsOverHttp(options: {
  chromeHost: string;
  chromePort: number;
  signal?: AbortSignal;
}): Promise<readonly string[]> {
  const timeoutSignal = AbortSignal.timeout(TARGET_RECLAIM_PROBE_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
  const host =
    options.chromeHost.includes(":") && !options.chromeHost.startsWith("[")
      ? `[${options.chromeHost}]`
      : options.chromeHost;
  const response = await fetch(`http://${host}:${options.chromePort}/json/list`, { signal });
  if (!response.ok) {
    throw new Error(`DevTools target list returned HTTP ${response.status}.`);
  }
  const payload = (await response.json()) as unknown;
  if (!Array.isArray(payload)) {
    throw new Error("DevTools target list returned an invalid document.");
  }
  const ids = new Set<string>();
  for (const target of payload) {
    if (!target || typeof target !== "object") continue;
    const candidate = target as { id?: unknown; targetId?: unknown };
    const id =
      typeof candidate.targetId === "string"
        ? candidate.targetId
        : typeof candidate.id === "string"
          ? candidate.id
          : null;
    if (id && id.length > 0) {
      ids.add(id);
    }
  }
  return [...ids];
}

export async function updateBrowserTabLease(
  profileDir: string,
  leaseId: string,
  patch: Partial<BrowserTabLeaseRecord>,
  logger?: BrowserLogger,
): Promise<void> {
  await withRegistryLock(
    profileDir,
    async () => {
      const outcome = await readRegistryOutcomeLocked(profileDir, logger);
      if (!outcome.readable) {
        // Metadata patches gate nothing destructive. Skipping the patch keeps
        // the ASSUME-ACTIVE state intact, whereas rewriting an unverifiable
        // registry could destroy peer leases.
        logger?.(
          `[browser] Skipped tab-lease update for ${leaseId.slice(0, 8)}: registry unverifiable (${outcome.reason}); leases remain assumed active.`,
        );
        return;
      }
      const leases = outcome.valid.map((lease) =>
        lease.id === leaseId
          ? { ...lease, ...patch, id: lease.id, updatedAt: new Date().toISOString() }
          : lease,
      );
      await writeRegistry(profileDir, {
        leases: [...leases, ...outcome.opaque],
        waiters: outcome.waiters,
      });
    },
    logger,
    { timeoutMs: REGISTRY_MUTATION_LOCK_TIMEOUT_MS },
  );
}

function browserTabLeaseIdentitiesEqual(
  left: BrowserTabLeaseIdentity,
  right: BrowserTabLeaseIdentity,
): boolean {
  return left.id === right.id && left.pid === right.pid && left.createdAt === right.createdAt;
}

function browserTabLeaseIdentity(record: BrowserTabLeaseRecord): BrowserTabLeaseIdentity {
  return { id: record.id, pid: record.pid, createdAt: record.createdAt };
}

async function readBrowserTabLeaseIdentity(
  profileDir: string,
  leaseId: string,
): Promise<BrowserTabLeaseIdentity | "absent"> {
  const outcome = await readRegistryOutcome(profileDir);
  if (!outcome.readable) {
    throw new TabLeaseRegistryUnreadableError(profileDir, outcome.reason, outcome.cause);
  }
  const matches = outcome.valid.filter((lease) => lease.id === leaseId);
  if (matches.length === 0) return "absent";
  if (matches.length !== 1) {
    throw new Error(
      `Tab-lease identity lookup for ${leaseId} found duplicate records; retaining them fail-closed.`,
    );
  }
  return browserTabLeaseIdentity(matches[0]!);
}

type DeferredReleaseRepairResult = "removed" | "already-gone-or-replaced";

function isDeferredReleaseRepairResult(value: unknown): value is DeferredReleaseRepairResult {
  return value === "removed" || value === "already-gone-or-replaced";
}

async function repairDeferredBrowserTabLeaseRelease(
  profileDir: string,
  expected: BrowserTabLeaseIdentity,
  logger?: BrowserLogger,
  onRelease?: (context: { isLastLease: boolean }) => Promise<void>,
  committedReleaseResult?: DeferredReleaseRepairResult,
  registryLockOptions?: Pick<
    RegistryLockWaitOptions,
    "mkdirLockDir" | "monotonicNow" | "platform" | "releaseRetryMs" | "rmLockDir" | "timeoutMs"
  >,
): Promise<DeferredReleaseRepairResult> {
  return await withRegistryLock(
    profileDir,
    async () => {
      const outcome = await readRegistryOutcomeLocked(profileDir, logger);
      if (!outcome.readable) {
        throw new TabLeaseRegistryUnreadableError(profileDir, outcome.reason, outcome.cause);
      }
      const matchingIndexes = outcome.valid.flatMap((lease, index) =>
        browserTabLeaseIdentitiesEqual(browserTabLeaseIdentity(lease), expected) ? [index] : [],
      );
      if (committedReleaseResult) {
        // The first callback returned only after writeRegistry completed, so
        // its exact record must already be absent. Reclaim/unlock the token-
        // abandoned mutex without replaying onRelease or deleting anything.
        // A contradictory exact identity is ownership ambiguity and remains
        // fail-closed rather than trusting the stale committed result blindly.
        if (matchingIndexes.length !== 0) {
          throw new Error(
            `Committed tab-lease release recovery for ${expected.id} found its exact identity still present; retaining state fail-closed.`,
          );
        }
        return committedReleaseResult;
      }
      if (matchingIndexes.length === 0) {
        // The original record was already removed or replaced. Never use
        // the stale release intent to remove a newer record with the same
        // id but a different owner/creation identity.
        return "already-gone-or-replaced" as const;
      }
      if (matchingIndexes.length !== 1) {
        throw new Error(
          `Deferred tab-lease release for ${expected.id} found duplicate exact identities; retaining them fail-closed.`,
        );
      }
      const removeIndex = matchingIndexes[0]!;
      const remainingValid = outcome.valid.filter((_lease, index) => index !== removeIndex);
      await onRelease?.({
        isLastLease:
          remainingValid.length === 0 &&
          outcome.opaque.length === 0 &&
          outcome.waiters.length === 0,
      });
      await writeRegistry(profileDir, {
        leases: [...remainingValid, ...outcome.opaque],
        waiters: outcome.waiters,
      });
      return "removed" as const;
    },
    logger,
    {
      timeoutMs: REGISTRY_MUTATION_LOCK_TIMEOUT_MS,
      ...registryLockOptions,
    },
  );
}

function deferredBrowserTabLeaseReleaseKey(
  profileDir: string,
  identity: BrowserTabLeaseIdentity,
): string {
  return `${path.resolve(profileDir)}\0${identity.id}\0${identity.pid}\0${identity.createdAt}`;
}

function scheduleDeferredBrowserTabLeaseRelease(
  profileDir: string,
  identity: BrowserTabLeaseIdentity,
  logger: BrowserLogger | undefined,
  options: {
    initialDelayMs?: number;
    onRelease?: (context: { isLastLease: boolean }) => Promise<void>;
    onRecovered?: () => void;
    committedReleaseResult?: DeferredReleaseRepairResult;
  },
): void {
  const key = deferredBrowserTabLeaseReleaseKey(profileDir, identity);
  const existing = deferredBrowserTabLeaseReleases.get(key);
  if (existing) {
    if (options.committedReleaseResult) {
      // A committed removal supersedes an older not-yet-run removal intent.
      // Its onRelease callback already ran before the durable registry write.
      existing.committedReleaseResult = options.committedReleaseResult;
      existing.onRelease = undefined;
    } else if (!existing.committedReleaseResult) {
      existing.onRelease ??= options.onRelease;
    }
    if (options.onRecovered) existing.onRecovered.add(options.onRecovered);
    return;
  }

  let resolveCompletion!: () => void;
  const completion = new Promise<void>((resolve) => {
    resolveCompletion = resolve;
  });
  const entry: DeferredBrowserTabLeaseRelease = {
    identity,
    committedReleaseResult: options.committedReleaseResult,
    attempt: 0,
    initialDelayMs: Math.max(1, options.initialDelayMs ?? DEFERRED_RELEASE_INITIAL_RETRY_MS),
    timer: null,
    completion,
    resolveCompletion,
    onRelease: options.onRelease,
    onRecovered: new Set(options.onRecovered ? [options.onRecovered] : []),
  };
  deferredBrowserTabLeaseReleases.set(key, entry);

  const finish = (): void => {
    if (deferredBrowserTabLeaseReleases.get(key) !== entry) return;
    deferredBrowserTabLeaseReleases.delete(key);
    for (const callback of entry.onRecovered) {
      try {
        callback();
      } catch (error) {
        logger?.(
          `[browser] Deferred tab-lease recovery callback failed for ${identity.id.slice(0, 8)}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    entry.resolveCompletion();
  };
  const arm = (delayMs: number): void => {
    entry.timer = setTimeout(() => {
      entry.timer = null;
      void repairDeferredBrowserTabLeaseRelease(
        profileDir,
        identity,
        logger,
        entry.onRelease,
        entry.committedReleaseResult,
      ).then(
        (result) => {
          logger?.(
            result === "removed"
              ? `[browser] Deferred self-heal released ChatGPT browser slot ${identity.id.slice(0, 8)} after registry contention cleared.`
              : `[browser] Deferred self-heal found ChatGPT browser slot ${identity.id.slice(0, 8)} already removed or replaced; leaving current state untouched.`,
          );
          finish();
        },
        (error: unknown) => {
          if (deferredBrowserTabLeaseReleases.get(key) !== entry) return;
          entry.attempt += 1;
          const retryMs = Math.min(
            DEFERRED_RELEASE_MAX_RETRY_MS,
            entry.initialDelayMs * 2 ** Math.min(entry.attempt, 16),
          );
          logger?.(
            `[browser] Deferred tab-lease self-heal for ${identity.id.slice(0, 8)} is still blocked (${error instanceof Error ? error.message : String(error)}); retrying in ${retryMs}ms.`,
          );
          arm(retryMs);
        },
      );
    }, delayMs);
    entry.timer.unref?.();
  };
  arm(entry.initialDelayMs);
}

/** @internal Test-only completion handle for deterministic deferred-release coverage. */
export function deferredBrowserTabLeaseReleaseCompletionForTest(
  profileDir: string,
  leaseId: string,
): Promise<void> | null {
  const resolvedProfileDir = path.resolve(profileDir);
  const completions = [...deferredBrowserTabLeaseReleases.entries()]
    .filter(
      ([key, entry]) => key.startsWith(`${resolvedProfileDir}\0`) && entry.identity.id === leaseId,
    )
    .map(([, entry]) => entry.completion);
  if (completions.length === 0) return null;
  return Promise.all(completions).then(() => undefined);
}

function containsRegistryLockOwnershipLoss(error: unknown, seen = new Set<unknown>()): boolean {
  if (error instanceof TabLeaseRegistryLockOwnershipLostError) return true;
  if (!error || typeof error !== "object" || seen.has(error)) return false;
  seen.add(error);
  if (error instanceof AggregateError) {
    for (const nested of error.errors) {
      if (containsRegistryLockOwnershipLoss(nested, seen)) return true;
    }
  }
  return containsRegistryLockOwnershipLoss((error as { cause?: unknown }).cause, seen);
}

export async function releaseBrowserTabLease(
  profileDir: string,
  leaseId: string,
  logger?: BrowserLogger,
  options: {
    onRelease?: (context: { isLastLease: boolean }) => Promise<void>;
    /** Notification hook for a later successful self-heal. */
    onDeferredRelease?: () => void;
    /** Exact immutable identity captured by an acquired lease handle. */
    expectedIdentity?: Pick<BrowserTabLeaseRecord, "id" | "pid" | "createdAt">;
    /** Test seam for deterministic lock-wait recovery coverage. */
    registryLockOptions?: Pick<
      RegistryLockWaitOptions,
      "mkdirLockDir" | "monotonicNow" | "platform" | "releaseRetryMs" | "rmLockDir" | "timeoutMs"
    >;
    /** Total bounded lock-acquire attempts; production defaults to two. */
    lockRetryAttempts?: number;
    /** Test seam for the small inter-attempt backoff. */
    lockRetryDelayMs?: number;
    /** Test seam for the first unref'd deferred self-heal attempt. */
    deferredReleaseInitialDelayMs?: number;
  } = {},
): Promise<void> {
  const resolvedIdentity =
    options.expectedIdentity ?? (await readBrowserTabLeaseIdentity(profileDir, leaseId));
  if (resolvedIdentity === "absent") {
    logger?.(`[browser] ChatGPT browser slot ${leaseId.slice(0, 8)} was already released.`);
    return;
  }
  const expectedIdentity: BrowserTabLeaseIdentity = resolvedIdentity;
  if (expectedIdentity.id !== leaseId) {
    throw new Error(
      `Tab-lease release identity mismatch: requested ${leaseId}, received ${expectedIdentity.id}; retaining state fail-closed.`,
    );
  }
  const lockRetryAttempts = Math.max(1, Math.trunc(options.lockRetryAttempts ?? 2));
  const lockRetryDelayMs = Math.max(0, options.lockRetryDelayMs ?? 50);
  for (let attempt = 1; ; attempt += 1) {
    try {
      await withRegistryLock(
        profileDir,
        async () => {
          const outcome = await readRegistryOutcomeLocked(profileDir, logger);
          if (!outcome.readable) {
            // Truthful release: we cannot prove the record was removed from an
            // unverifiable registry, so surface the fault instead of pretending.
            throw new TabLeaseRegistryUnreadableError(profileDir, outcome.reason, outcome.cause);
          }
          const pruneOptions = {
            nowMs: Date.now(),
            staleMs: DEFAULT_STALE_MS,
            isProcessAlive,
          };
          const activeValid = pruneStaleLeases(outcome.valid, pruneOptions);
          const activeOpaque = pruneOpaqueRecords(outcome.opaque, pruneOptions);
          const activeWaiters = pruneStaleWaiters(outcome.waiters, pruneOptions);
          const matchingIndexes = activeValid.flatMap((lease, index) =>
            browserTabLeaseIdentitiesEqual(browserTabLeaseIdentity(lease), expectedIdentity)
              ? [index]
              : [],
          );
          if (matchingIndexes.length > 1) {
            throw new Error(
              `Tab-lease release for ${leaseId} found duplicate matching identities; retaining them fail-closed.`,
            );
          }
          const removeIndex = matchingIndexes[0] ?? -1;
          const remaining = activeValid.filter((_lease, index) => index !== removeIndex);
          const committedResult: DeferredReleaseRepairResult =
            removeIndex >= 0 ? "removed" : "already-gone-or-replaced";
          if (removeIndex >= 0) {
            // Keep the lease advertised while the registry lock blocks new
            // acquisitions. Publish its removal only after the cleanup callback
            // succeeds; callback failure therefore retains capacity fail-closed.
            await options.onRelease?.({
              isLastLease:
                remaining.length === 0 && activeOpaque.length === 0 && activeWaiters.length === 0,
            });
          }
          await writeRegistry(profileDir, {
            leases: [...remaining, ...activeOpaque],
            waiters: activeWaiters,
          });
          return committedResult;
        },
        logger,
        {
          timeoutMs: REGISTRY_MUTATION_LOCK_TIMEOUT_MS,
          ...options.registryLockOptions,
        },
      );
      break;
    } catch (error) {
      const retryableLockWait =
        error instanceof TabLeaseRegistryLockWaitError && error.reason === "timed out";
      const committedReleaseResult =
        error instanceof TabLeaseRegistryPostCommitUnlockError &&
        isDeferredReleaseRepairResult(error.committedResult)
          ? error.committedResult
          : null;
      if (committedReleaseResult) {
        const lockDir = path.join(profileDir, REGISTRY_LOCK_DIRNAME);
        const safeToRecover =
          !containsRegistryLockOwnershipLoss(error) &&
          (await isRegistryLockExplicitlyAbandoned(lockDir));
        if (safeToRecover) {
          try {
            // The removal is authoritative, but readiness is not clean until
            // the exact token-abandoned mutex is reclaimed and a new no-op
            // critical section unlocks normally. Never replay onRelease.
            await repairDeferredBrowserTabLeaseRelease(
              profileDir,
              expectedIdentity,
              logger,
              undefined,
              committedReleaseResult,
              options.registryLockOptions,
            );
            logger?.(
              `[browser] Recovered the abandoned registry mutex after committed release of tab lease ${leaseId.slice(0, 8)}.`,
            );
            break;
          } catch (recoveryError) {
            const stillSafelyAbandoned =
              !containsRegistryLockOwnershipLoss(recoveryError) &&
              (await isRegistryLockExplicitlyAbandoned(lockDir));
            if (stillSafelyAbandoned) {
              scheduleDeferredBrowserTabLeaseRelease(profileDir, expectedIdentity, logger, {
                initialDelayMs: options.deferredReleaseInitialDelayMs,
                committedReleaseResult,
                onRecovered: options.onDeferredRelease,
              });
            }
            logger?.(
              `[browser] Committed tab-lease removal for ${leaseId.slice(0, 8)} could not yet prove a clean registry unlock: ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}.`,
            );
          }
        }
        // The record removal is durable, but absent a clean unlock or an exact
        // token-bound abandonment proof readiness remains tainted fail-closed.
        throw error;
      }
      if (!retryableLockWait || attempt >= lockRetryAttempts) {
        if (retryableLockWait && expectedIdentity) {
          scheduleDeferredBrowserTabLeaseRelease(profileDir, expectedIdentity, logger, {
            initialDelayMs: options.deferredReleaseInitialDelayMs,
            onRelease: options.onRelease,
            onRecovered: options.onDeferredRelease,
          });
        }
        throw error;
      }
      logger?.(
        `[browser] Tab-lease release for ${leaseId.slice(0, 8)} could not acquire the registry lock; retrying the identity-safe removal (${attempt + 1}/${lockRetryAttempts}).`,
      );
      if (lockRetryDelayMs > 0) {
        await delay(lockRetryDelayMs);
      }
    }
  }
  // Only report success after the lease record was actually removed and the
  // registry rewritten; lock/read/write failures propagate to the caller.
  logger?.(`[browser] Released ChatGPT browser slot ${leaseId.slice(0, 8)}.`);
}

/**
 * Read-only census of active tab leases for observability surfaces (/ready).
 * Lock-free by design: a torn concurrent write parses as corrupt and reports
 * `readable: false` (ASSUME-ACTIVE, count unknown) rather than blocking or
 * contending with writers; the next probe sees the settled state. Fail-closed
 * consumers must treat `activeLeaseCount: null` as "cannot prove idle".
 */
export interface TabLeaseCensus {
  readable: boolean;
  activeLeaseCount: number | null;
  reason?: string;
}

export async function countActiveBrowserTabLeases(
  profileDir: string,
  options: {
    staleMs?: number;
    now?: () => number;
    isProcessAlive?: (pid: number) => boolean;
    logger?: BrowserLogger;
  } = {},
): Promise<TabLeaseCensus> {
  const now = options.now ?? Date.now;
  const staleMs = Math.max(60_000, options.staleMs ?? DEFAULT_STALE_MS);
  const outcome = await readRegistryOutcome(profileDir);
  if (!outcome.readable) {
    return { readable: false, activeLeaseCount: null, reason: outcome.reason };
  }
  const pruneOptions = {
    nowMs: now(),
    staleMs,
    isProcessAlive: options.isProcessAlive ?? isProcessAlive,
  };
  const activeValid = pruneStaleLeases(outcome.valid, pruneOptions);
  const activeOpaque = pruneOpaqueRecords(outcome.opaque, pruneOptions);
  return { readable: true, activeLeaseCount: activeValid.length + activeOpaque.length };
}

export async function hasOtherActiveBrowserTabLeases(
  profileDir: string,
  leaseId: string,
  options: {
    staleMs?: number;
    now?: () => number;
    isProcessAlive?: (pid: number) => boolean;
    logger?: BrowserLogger;
  } = {},
): Promise<boolean> {
  const now = options.now ?? Date.now;
  const staleMs = Math.max(60_000, options.staleMs ?? DEFAULT_STALE_MS);
  return withRegistryLock(
    profileDir,
    async () => {
      const outcome = await readRegistryOutcomeLocked(profileDir, options.logger);
      if (!outcome.readable) {
        // Fail-closed: we cannot prove "no other leases", so report other
        // leases active and let destructive cleanup (Chrome termination,
        // blank-tab sweeps) stand down.
        return true;
      }
      const pruneOptions = {
        nowMs: now(),
        staleMs,
        isProcessAlive: options.isProcessAlive ?? isProcessAlive,
      };
      const activeValid = pruneStaleLeases(outcome.valid, pruneOptions);
      const activeOpaque = pruneOpaqueRecords(outcome.opaque, pruneOptions);
      const activeWaiters = pruneStaleWaiters(outcome.waiters, pruneOptions);
      if (
        activeValid.length + activeOpaque.length !== outcome.valid.length + outcome.opaque.length ||
        activeWaiters.length !== outcome.waiters.length
      ) {
        // Best-effort persistence of the prune; the computed answer below is
        // valid regardless of whether this write lands.
        await writeRegistry(profileDir, {
          leases: [...activeValid, ...activeOpaque],
          waiters: activeWaiters,
        }).catch(() => undefined);
      }
      return (
        activeWaiters.length > 0 ||
        activeOpaque.length > 0 ||
        activeValid.some((lease) => lease.id !== leaseId)
      );
    },
    options.logger,
  );
}

/**
 * Snapshot of the OTHER currently-active leases' recorded Chrome target IDs,
 * taken under the same registry lock / prune-stale path as
 * hasOtherActiveBrowserTabLeases. Consumed by the exit-time blank-tab sweep so
 * a concurrently-running lane's tab is excluded from closure instead of being
 * mistaken for an orphaned about:blank tab.
 *
 * Fail-closed shape: `readable: false` means the registry is unverifiable and
 * the caller must assume unknown tabs belong to live lanes (stand down);
 * `unattributedCount > 0` means at least one other active occupant has no
 * recorded chromeTargetId yet (its brand-new tab is indistinguishable from an
 * orphan), so a sweep must also stand down.
 */
export interface OtherActiveLeaseTargetSnapshot {
  readable: boolean;
  /** Deduplicated chromeTargetIds recorded by OTHER active leases. */
  targetIds: string[];
  /**
   * Other active occupants whose tab cannot be attributed to a target ID:
   * valid leases that have not recorded chromeTargetId yet, plus opaque
   * (assume-active) records.
   */
  unattributedCount: number;
}

export async function listOtherActiveBrowserTabLeaseTargetIds(
  profileDir: string,
  leaseId: string,
  options: {
    staleMs?: number;
    now?: () => number;
    isProcessAlive?: (pid: number) => boolean;
    logger?: BrowserLogger;
  } = {},
): Promise<OtherActiveLeaseTargetSnapshot> {
  const now = options.now ?? Date.now;
  const staleMs = Math.max(60_000, options.staleMs ?? DEFAULT_STALE_MS);
  return withRegistryLock(
    profileDir,
    async () => {
      const outcome = await readRegistryOutcomeLocked(profileDir, options.logger);
      if (!outcome.readable) {
        // Fail-closed: we cannot enumerate other leases' targets, so report
        // the registry unverifiable and let destructive sweeps stand down.
        return { readable: false, targetIds: [], unattributedCount: 0 };
      }
      const pruneOptions = {
        nowMs: now(),
        staleMs,
        isProcessAlive: options.isProcessAlive ?? isProcessAlive,
      };
      const activeValid = pruneStaleLeases(outcome.valid, pruneOptions);
      const activeOpaque = pruneOpaqueRecords(outcome.opaque, pruneOptions);
      const activeWaiters = pruneStaleWaiters(outcome.waiters, pruneOptions);
      if (
        activeValid.length + activeOpaque.length !== outcome.valid.length + outcome.opaque.length ||
        activeWaiters.length !== outcome.waiters.length
      ) {
        // Best-effort persistence of the prune; the computed answer below is
        // valid regardless of whether this write lands.
        await writeRegistry(profileDir, {
          leases: [...activeValid, ...activeOpaque],
          waiters: activeWaiters,
        }).catch(() => undefined);
      }
      const targetIds = new Set<string>();
      let unattributedCount = activeOpaque.length + activeWaiters.length;
      for (const lease of activeValid) {
        if (lease.id === leaseId) {
          continue;
        }
        if (typeof lease.chromeTargetId === "string" && lease.chromeTargetId.length > 0) {
          targetIds.add(lease.chromeTargetId);
        } else {
          unattributedCount += 1;
        }
      }
      return { readable: true, targetIds: [...targetIds], unattributedCount };
    },
    options.logger,
  );
}

interface RegistryLockOwner {
  pid: number;
  startTicks?: string | null;
  createdAt?: string;
  token?: string;
}

interface RegistryLockAbandonment {
  token: string;
  abandonedAt: string;
  reason: "post-commit-unlock-failed";
}

interface RegistryLockWaitOptions {
  signal?: AbortSignal;
  /** Absolute deadline on `monotonicNow`'s time base. */
  deadlineMs?: number;
  /** Relative monotonic bound, ignored when deadlineMs is supplied. */
  timeoutMs?: number;
  /** Test seam; production uses `performance.now()`. */
  monotonicNow?: () => number;
  /** Test seam for deterministic filesystem-error injection. */
  mkdirLockDir?: (lockDir: string) => Promise<void>;
  /** Test seam; production always uses process.platform. */
  platform?: NodeJS.Platform;
  /** Test seam for deterministic lock-release filesystem errors. */
  rmLockDir?: (lockDir: string) => Promise<void>;
  /** Test seam for the bounded Windows release-retry window. */
  releaseRetryMs?: number;
  /** Test seam that pauses after mkdir but before atomic owner publication. */
  beforeOwnerPublish?: (lockDir: string) => Promise<void>;
}

async function withRegistryLock<T>(
  profileDir: string,
  callback: () => Promise<T>,
  logger?: BrowserLogger,
  options: RegistryLockWaitOptions = {},
): Promise<T> {
  const lockDir = path.join(profileDir, REGISTRY_LOCK_DIRNAME);
  const ownerPath = path.join(lockDir, REGISTRY_LOCK_OWNER_FILENAME);
  const monotonicNow = options.monotonicNow ?? defaultMonotonicNow;
  const startedAt = monotonicNow();
  const deadlineMs =
    options.deadlineMs ??
    (options.timeoutMs !== undefined
      ? startedAt + Math.max(0, options.timeoutMs)
      : Number.POSITIVE_INFINITY);
  const mkdirLockDir =
    options.mkdirLockDir ??
    (async (target: string) => {
      await mkdir(target, { recursive: false });
    });
  const platform = options.platform ?? process.platform;
  let lastWaitLogAt = Number.NEGATIVE_INFINITY;
  for (;;) {
    if (options.signal?.aborted) {
      throw new TabLeaseRegistryLockWaitError(lockDir, "aborted");
    }
    try {
      // Always allow one non-blocking mkdir attempt, even at the exact
      // deadline. A free registry lock is not a lock-wait timeout; callers
      // such as tab-slot acquisition must get to observe capacity and report
      // their own domain-specific timeout. The deadline applies only once an
      // existing lock would make us wait.
      await mkdirLockDir(lockDir);
      break;
    } catch (error) {
      const code = (error as { code?: string }).code;
      const windowsTransient = platform === "win32" && (code === "EPERM" || code === "EBUSY");
      if (code !== "EEXIST" && !windowsTransient) {
        throw error;
      }
      if (windowsTransient) {
        const currentMonotonic = monotonicNow();
        const elapsed = Math.max(0, currentMonotonic - startedAt);
        if (elapsed >= WINDOWS_LOCK_TRANSIENT_RETRY_MS || currentMonotonic >= deadlineMs) {
          throw error;
        }
        try {
          await delayWithAbort(
            Math.min(50, WINDOWS_LOCK_TRANSIENT_RETRY_MS - elapsed, deadlineMs - currentMonotonic),
            options.signal,
          );
        } catch (delayError) {
          if (options.signal?.aborted) {
            throw new TabLeaseRegistryLockWaitError(lockDir, "aborted");
          }
          throw delayError;
        }
        continue;
      }
      const currentMonotonic = monotonicNow();
      if (currentMonotonic >= deadlineMs) {
        throw new TabLeaseRegistryLockWaitError(lockDir, "timed out");
      }
      const explicitlyAbandoned = await isRegistryLockExplicitlyAbandoned(lockDir);
      if (explicitlyAbandoned || currentMonotonic - startedAt > REGISTRY_LOCK_TIMEOUT_MS) {
        // Owner-aware steal: the lock is reclaimed only from a provably-dead
        // owner, an explicitly post-commit-abandoned owner, or a bounded-stale
        // ownerless legacy lock. A live owner without a matching abandonment
        // marker is NEVER stolen — we keep waiting instead.
        const stolen = await stealRegistryLockFromDeadOwner(lockDir, logger);
        if (stolen) {
          continue;
        }
        if (currentMonotonic - lastWaitLogAt >= 30_000) {
          lastWaitLogAt = currentMonotonic;
          logger?.(
            `[browser] Tab-lease registry lock at ${lockDir} is held by a live owner; waiting (${Math.round((currentMonotonic - startedAt) / 1000)}s elapsed).`,
          );
        }
      }
      if (options.signal?.aborted) {
        throw new TabLeaseRegistryLockWaitError(lockDir, "aborted");
      }
      const remainingMs = deadlineMs - monotonicNow();
      if (remainingMs <= 0) {
        throw new TabLeaseRegistryLockWaitError(lockDir, "timed out");
      }
      try {
        await delayWithAbort(Math.min(50, remainingMs), options.signal);
      } catch (error) {
        if (options.signal?.aborted) {
          throw new TabLeaseRegistryLockWaitError(lockDir, "aborted");
        }
        throw error;
      }
    }
  }
  // Publish our identity with a create-if-absent hard link. A plain write to
  // owner.json leaves a mkdir -> write gap: if this process is paused there,
  // an ownerless-lock reclaimer can replace the directory and this process
  // can resume by writing into the replacement, giving two callbacks the same
  // lock pathname. The prewritten claim plus link() makes owner publication a
  // single no-overwrite operation. If the directory was replaced, exactly one
  // contender can publish its token; every loser refuses before its callback.
  const ownerToken = randomUUID();
  const owner: RegistryLockOwner = {
    pid: process.pid,
    startTicks: readProcessStartTicks(process.pid),
    createdAt: new Date().toISOString(),
    token: ownerToken,
  };
  const ownerClaimPath = `${lockDir}.owner-${ownerToken}.claim`;
  const ownerClaimHandle = await open(ownerClaimPath, "wx");
  try {
    await ownerClaimHandle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
    await ownerClaimHandle.sync();
  } finally {
    await ownerClaimHandle.close();
  }
  try {
    await options.beforeOwnerPublish?.(lockDir);
    await link(ownerClaimPath, ownerPath);
  } catch (error) {
    throw new TabLeaseRegistryLockOwnershipLostError(lockDir, { cause: error });
  } finally {
    await rm(ownerClaimPath, { force: true }).catch(() => undefined);
  }
  // Hold an open handle on the directory we just created so release-time can
  // prove it is still the SAME directory (see releaseRegistryLockIfOwned): a
  // peer's dead-owner reclamation replaces `lockDir` with a brand-new
  // directory, which self-ownership verification must detect even when no
  // owner file is involved on either side. Comparing inode numbers alone is
  // NOT sufficient — many filesystems reuse a freed inode number immediately
  // for the next mkdir() at the same path, so a delete+recreate can produce
  // an identical (dev, ino) to the one we started with. Keeping our own file
  // descriptor open on the ORIGINAL directory for the lifetime of the lock
  // prevents the kernel from recycling its inode for anything else in the
  // meantime, which is what makes the dev/ino comparison at release time a
  // real proof of identity rather than a coincidence.
  const myLockHandle = await openOwnedLockDirIdentityHandle(lockDir, ownerToken, monotonicNow);
  if (!myLockHandle) {
    throw new TabLeaseRegistryLockOwnershipLostError(lockDir);
  }

  let callbackResult: T;
  try {
    callbackResult = await callback();
  } catch (callbackError) {
    try {
      await releaseRegistryLockIfOwned(lockDir, myLockHandle, logger, {
        platform,
        rmLockDir: options.rmLockDir,
        retryMs: options.releaseRetryMs,
        monotonicNow,
      });
    } catch (releaseError) {
      // Preserve the primary callback type/taxonomy while attaching the
      // independently important cleanup failure for diagnostics.
      logger?.(
        `[browser] ERROR: registry callback failed and its lock also could not be released: ${releaseError instanceof Error ? releaseError.message : String(releaseError)}`,
      );
      if (callbackError && typeof callbackError === "object") {
        Object.defineProperty(callbackError, "registryLockReleaseError", {
          configurable: true,
          enumerable: false,
          value: releaseError,
        });
      }
    }
    throw callbackError;
  }
  try {
    await releaseRegistryLockIfOwned(lockDir, myLockHandle, logger, {
      platform,
      rmLockDir: options.rmLockDir,
      retryMs: options.releaseRetryMs,
      monotonicNow,
      abandonOnFailure: true,
    });
  } catch (releaseError) {
    throw new TabLeaseRegistryPostCommitUnlockError(callbackResult, releaseError);
  }
  return callbackResult;
}

/**
 * An open directory handle plus the (dev, ino) pair captured from it,
 * pinned for the lifetime of a registry-lock hold. Used to prove directory
 * identity across a delete+recreate at the same path — see
 * `openDirIdentityHandle` for why a live handle (not just a stat() snapshot)
 * is required.
 */
interface DirIdentityHandle {
  dev: number;
  ino: number;
  token?: string;
  close: () => Promise<void>;
}

/**
 * Open a directory and capture its (dev, ino) identity via the open
 * descriptor (fstat), not a plain stat() by path. Holding the descriptor
 * open keeps the underlying inode allocated for as long as the caller holds
 * it, even if the directory is later renamed away and removed — so a
 * DIFFERENT directory later mkdir()'d at the same path is guaranteed a
 * different (dev, ino), never a coincidentally-recycled match. Returns
 * `null` when the directory cannot be opened/stat()'d, which callers must
 * treat as "identity unproven", never as a match.
 */
async function openDirIdentityHandle(dirPath: string): Promise<DirIdentityHandle | null> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(dirPath, "r");
  } catch {
    return null;
  }
  try {
    const stats = await handle.stat();
    return { dev: stats.dev, ino: stats.ino, close: () => handle.close() };
  } catch {
    await handle.close().catch(() => undefined);
    return null;
  }
}

/** Pin only a directory whose published owner token is exactly ours. */
async function openOwnedLockDirIdentityHandle(
  lockDir: string,
  token: string,
  monotonicNow: () => number,
): Promise<DirIdentityHandle | null> {
  // A concurrent stale-owner check may have the directory briefly renamed to
  // a tombstone before detecting that owner publication won the race and
  // giving it back. Retry that bounded transitional absence; never accept a
  // different token.
  const deadline = monotonicNow() + WINDOWS_LOCK_TRANSIENT_RETRY_MS;
  for (;;) {
    const handle = await openDirIdentityHandle(lockDir);
    if (handle) {
      const [current, raw] = await Promise.all([
        stat(lockDir).catch(() => null),
        readFile(path.join(lockDir, REGISTRY_LOCK_OWNER_FILENAME), "utf8").catch(() => null),
      ]);
      let observedToken: string | null = null;
      if (raw !== null) {
        try {
          const parsed = JSON.parse(raw) as { token?: unknown };
          observedToken = typeof parsed.token === "string" ? parsed.token : null;
        } catch {
          observedToken = null;
        }
      }
      if (
        current !== null &&
        current.dev === handle.dev &&
        current.ino === handle.ino &&
        observedToken === token
      ) {
        return { ...handle, token };
      }
      await handle.close().catch(() => undefined);
      if (observedToken !== null && observedToken !== token) return null;
    }
    if (monotonicNow() >= deadline) return null;
    await delay(10);
  }
}

/**
 * Release the registry lock directory, but only after proving it is still
 * the exact directory this process created (via the held-open identity
 * handle captured at acquire time). A concurrent dead-owner reclamation
 * (`stealRegistryLockFromDeadOwner`) can replace `lockDir` with a different
 * owner's lock while our callback was running; a blind `rm()` here would
 * tear down that owner's critical section instead of releasing our own.
 * When self-ownership cannot be proven, fail closed by throwing rather than
 * guessing which directory to delete.
 */
async function releaseRegistryLockIfOwned(
  lockDir: string,
  myLockHandle: DirIdentityHandle | null,
  logger?: BrowserLogger,
  options: {
    platform?: NodeJS.Platform;
    rmLockDir?: (lockDir: string) => Promise<void>;
    retryMs?: number;
    monotonicNow?: () => number;
    /** Publish an atomic recovery marker only after a committed callback. */
    abandonOnFailure?: boolean;
  } = {},
): Promise<void> {
  const platform = options.platform ?? process.platform;
  const rmLockDir =
    options.rmLockDir ??
    (async (target: string) => {
      await rm(target, { recursive: true, force: true });
    });
  const retryMs = Math.max(0, options.retryMs ?? WINDOWS_LOCK_TRANSIENT_RETRY_MS);
  const monotonicNow = options.monotonicNow ?? defaultMonotonicNow;
  const startedAt = monotonicNow();
  try {
    for (;;) {
      // Re-prove identity before EVERY removal attempt. A peer may replace the
      // path while a transient Windows error is backing off; retrying a bare
      // rm() would otherwise delete that peer's fresh lock.
      const current = await stat(lockDir).catch(() => null);
      const currentOwnerToken = await readRegistryLockOwnerToken(lockDir);
      const sameDir =
        myLockHandle !== null &&
        current !== null &&
        current.dev === myLockHandle.dev &&
        current.ino === myLockHandle.ino &&
        typeof myLockHandle.token === "string" &&
        currentOwnerToken === myLockHandle.token;
      if (!sameDir) {
        logger?.(
          `[browser] ERROR: tab-lease registry lock at ${lockDir} no longer matches the directory this ` +
            "process acquired; refusing to release it (it may belong to another owner now).",
        );
        throw new TabLeaseRegistryLockOwnershipLostError(lockDir);
      }
      try {
        await rmLockDir(lockDir);
        const remaining = await stat(lockDir).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return null;
          throw error;
        });
        if (remaining === null) return;
        if (
          myLockHandle !== null &&
          (remaining.dev !== myLockHandle.dev || remaining.ino !== myLockHandle.ino)
        ) {
          // Our exact directory is gone and a peer acquired the path after
          // removal. That is a successful hand-off, not a release failure.
          return;
        }
        throw new TabLeaseRegistryLockReleaseError(lockDir);
      } catch (error) {
        if (error instanceof TabLeaseRegistryLockReleaseError) throw error;
        const code = (error as NodeJS.ErrnoException).code;
        const windowsTransient = platform === "win32" && (code === "EPERM" || code === "EBUSY");
        const elapsed = elapsedMonotonicMs(startedAt, monotonicNow);
        if (!windowsTransient || elapsed >= retryMs) {
          throw new TabLeaseRegistryLockReleaseError(lockDir, error);
        }
        await delay(Math.min(50, Math.max(1, retryMs - elapsed)));
      }
    }
  } catch (error) {
    if (options.abandonOnFailure && !(error instanceof TabLeaseRegistryLockOwnershipLostError)) {
      try {
        await publishRegistryLockAbandonment(lockDir, myLockHandle);
        logger?.(
          `[browser] Marked committed tab-lease registry lock at ${lockDir} explicitly abandoned after unlock failed; a later acquirer may reclaim it safely.`,
        );
      } catch (abandonmentError) {
        logger?.(
          `[browser] ERROR: could not publish the post-commit abandonment marker for registry lock at ${lockDir}: ${abandonmentError instanceof Error ? abandonmentError.message : String(abandonmentError)}`,
        );
        throw new TabLeaseRegistryLockReleaseError(
          lockDir,
          new AggregateError([error, abandonmentError]),
        );
      }
    }
    throw error;
  } finally {
    if (myLockHandle) {
      await myLockHandle.close().catch(() => undefined);
    }
  }
}

async function readRegistryLockOwnerToken(lockDir: string): Promise<string | null> {
  try {
    const raw = await readFile(path.join(lockDir, REGISTRY_LOCK_OWNER_FILENAME), "utf8");
    const parsed = JSON.parse(raw) as { token?: unknown };
    return typeof parsed.token === "string" ? parsed.token : null;
  } catch {
    return null;
  }
}

async function readRegistryLockAbandonment(
  lockDir: string,
): Promise<{ raw: string; value: RegistryLockAbandonment } | null> {
  try {
    const raw = await readFile(path.join(lockDir, REGISTRY_LOCK_ABANDONED_FILENAME), "utf8");
    const parsed = JSON.parse(raw) as Partial<RegistryLockAbandonment>;
    if (
      typeof parsed.token !== "string" ||
      typeof parsed.abandonedAt !== "string" ||
      parsed.reason !== "post-commit-unlock-failed"
    ) {
      return null;
    }
    return { raw, value: parsed as RegistryLockAbandonment };
  } catch {
    return null;
  }
}

async function isRegistryLockExplicitlyAbandoned(lockDir: string): Promise<boolean> {
  const [ownerToken, abandonment] = await Promise.all([
    readRegistryLockOwnerToken(lockDir),
    readRegistryLockAbandonment(lockDir),
  ]);
  return ownerToken !== null && abandonment?.value.token === ownerToken;
}

/**
 * Atomically publish that a committed callback has stopped holding the
 * critical section even though its directory removal failed. The marker is a
 * token-bound hard link, never an overwrite: if the path was replaced, the
 * new owner's distinct token cannot be made reclaimable by this marker.
 */
async function publishRegistryLockAbandonment(
  lockDir: string,
  myLockHandle: DirIdentityHandle | null,
): Promise<void> {
  if (!myLockHandle || typeof myLockHandle.token !== "string") {
    throw new TabLeaseRegistryLockOwnershipLostError(lockDir);
  }
  const token = myLockHandle.token;
  const marker: RegistryLockAbandonment = {
    token,
    abandonedAt: new Date().toISOString(),
    reason: "post-commit-unlock-failed",
  };
  const claimPath = `${lockDir}.abandoned-${token}-${randomUUID().slice(0, 8)}.claim`;
  const markerPath = path.join(lockDir, REGISTRY_LOCK_ABANDONED_FILENAME);
  const claimHandle = await open(claimPath, "wx");
  try {
    await claimHandle.writeFile(`${JSON.stringify(marker)}\n`, "utf8");
    await claimHandle.sync();
  } finally {
    await claimHandle.close();
  }
  try {
    await link(claimPath, markerPath);
  } catch (error) {
    const existing = await readRegistryLockAbandonment(lockDir);
    if (existing?.value.token !== token) {
      throw new TabLeaseRegistryLockOwnershipLostError(lockDir, { cause: error });
    }
  } finally {
    await rm(claimPath, { force: true }).catch(() => undefined);
  }

  const [current, ownerToken, abandonment] = await Promise.all([
    stat(lockDir).catch(() => null),
    readRegistryLockOwnerToken(lockDir),
    readRegistryLockAbandonment(lockDir),
  ]);
  if (
    current === null ||
    current.dev !== myLockHandle.dev ||
    current.ino !== myLockHandle.ino ||
    ownerToken !== token ||
    abandonment?.value.token !== token
  ) {
    throw new TabLeaseRegistryLockOwnershipLostError(lockDir);
  }

  // Best-effort durability for the hard-link publication. If the machine
  // crashes before it reaches storage, the owner process also dies and the
  // ordinary dead-owner proof remains available.
  try {
    const dirHandle = await open(lockDir, "r");
    try {
      await dirHandle.sync();
    } finally {
      await dirHandle.close();
    }
  } catch {
    // Directory fsync is not supported on every platform.
  }
}

/**
 * Attempt to reclaim the registry lock. Returns true when the lock directory
 * was removed (provably-dead owner, token-matched post-commit abandonment, or
 * bounded-stale ownerless lock) and the caller may retry mkdir(); returns
 * false when the owner is (or may be) actively holding it, or another process
 * raced us.
 */
async function stealRegistryLockFromDeadOwner(
  lockDir: string,
  logger?: BrowserLogger,
): Promise<boolean> {
  const ownerPath = path.join(lockDir, REGISTRY_LOCK_OWNER_FILENAME);
  // Open a handle on the lock directory (and pin its identity) BEFORE doing
  // any owner-liveness/age read below, and reuse this SAME handle all the way
  // through to the tombstone comparison — never re-opened later. Holding the
  // descriptor open prevents the filesystem from recycling this exact
  // (dev, ino) for anything else until we close it, which is what makes the
  // eventual identity comparison against the tombstone a real proof of
  // "this is the directory we judged", not a coincidence.
  //
  // Pinning here (rather than only right before the reclaim rename, after
  // the liveness verdict below has already been formed) closes the window a
  // fresh legitimate acquirer could otherwise win: if the swap (delete the
  // judged directory, mkdir its own) happens between this pin and the
  // liveness/age read just below, that read is necessarily performed
  // against the FRESH directory (its owner.json, its mtime) — which reads
  // as either live-owned or too young to steal, so the verdict naturally
  // comes back "do not steal". If the swap instead happens AFTER the
  // verdict is formed, the identity pinned here (from the directory that
  // was actually judged) will differ from whatever ends up renamed into the
  // tombstone, and the same-lock check below catches it. Two absent owner
  // files are NOT proof it is the same lock; only a provably-unrecycled
  // identity match, captured before the judgment was even made, is.
  const preStealHandle = await openDirIdentityHandle(lockDir);
  let ownerRaw: string | null = null;
  let owner: RegistryLockOwner | null = null;
  let abandonmentRaw: string | null = null;
  let abandonment: RegistryLockAbandonment | null = null;
  try {
    ownerRaw = await readFile(ownerPath, "utf8");
    const parsed = JSON.parse(ownerRaw) as unknown;
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as RegistryLockOwner).pid === "number"
    ) {
      owner = parsed as RegistryLockOwner;
    }
  } catch {
    owner = null;
  }
  try {
    abandonmentRaw = await readFile(path.join(lockDir, REGISTRY_LOCK_ABANDONED_FILENAME), "utf8");
    const parsed = JSON.parse(abandonmentRaw) as Partial<RegistryLockAbandonment>;
    if (
      typeof parsed.token === "string" &&
      typeof parsed.abandonedAt === "string" &&
      parsed.reason === "post-commit-unlock-failed"
    ) {
      abandonment = parsed as RegistryLockAbandonment;
    }
  } catch {
    abandonment = null;
  }
  const explicitlyAbandoned =
    owner !== null && typeof owner.token === "string" && abandonment?.token === owner.token;
  if (owner) {
    if (isLockOwnerAlive(owner) && !explicitlyAbandoned) {
      // A live owner is stealable only after its exact owner token atomically
      // published a post-commit abandonment marker. Without that proof, never
      // steal no matter how long the lock has been held.
      if (preStealHandle) await preStealHandle.close().catch(() => undefined);
      return false;
    }
  } else {
    // No verifiable owner identity (legacy lock, or the owner crashed before
    // its identity write landed). Only reclaim after a bounded quiet period
    // so an in-flight acquisition is never raced.
    const ageMs = await lockDirAgeMs(lockDir);
    if (ageMs === null || ageMs < OWNERLESS_LOCK_STEAL_AGE_MS) {
      if (preStealHandle) await preStealHandle.close().catch(() => undefined);
      return false;
    }
  }
  // Atomic reclamation: rename the lock directory to a tombstone (exactly one
  // stealer wins the rename), verify the tombstone still holds the identity
  // pinned above (and the same dead owner we judged), then remove it. If a
  // fresh owner slipped in at any point between the pin and the rename, give
  // the lock back.
  const tomb = `${lockDir}.stale-${randomUUID().slice(0, 8)}`;
  try {
    await rename(lockDir, tomb);
  } catch {
    // Lock released or another stealer won; let the caller retry mkdir().
    if (preStealHandle) await preStealHandle.close().catch(() => undefined);
    return false;
  }
  const postStealStats = await stat(tomb).catch(() => null);
  let tombRaw: string | null = null;
  let tombAbandonmentRaw: string | null = null;
  try {
    tombRaw = await readFile(path.join(tomb, REGISTRY_LOCK_OWNER_FILENAME), "utf8");
  } catch {
    tombRaw = null;
  }
  try {
    tombAbandonmentRaw = await readFile(path.join(tomb, REGISTRY_LOCK_ABANDONED_FILENAME), "utf8");
  } catch {
    tombAbandonmentRaw = null;
  }
  // Same-lock proof requires BOTH signals to agree. Requiring the identity
  // match (rather than trusting content alone) is what prevents a false
  // "same owner" verdict when both owner-file reads come back null/null — an
  // indeterminate content comparison must never be treated as a match.
  const sameLock =
    preStealHandle !== null &&
    postStealStats !== null &&
    postStealStats.dev === preStealHandle.dev &&
    postStealStats.ino === preStealHandle.ino &&
    tombRaw === ownerRaw &&
    tombAbandonmentRaw === abandonmentRaw;
  if (preStealHandle) await preStealHandle.close().catch(() => undefined);
  if (!sameLock) {
    try {
      await rename(tomb, lockDir);
      return false;
    } catch {
      // A third process created a new lock while we held the tombstone, so
      // the displaced fresh owner's lock cannot be restored. The registry
      // FILE itself stays consistent (writes are atomic temp+rename), but the
      // displaced owner may still be executing under what it believes is
      // exclusive access. Do not paper over this with a warning-and-continue:
      // fail closed so the caller's operation is not reported as successful
      // while an ambiguous concurrent-ownership state exists. The displaced
      // owner's own release path (releaseRegistryLockIfOwned) independently
      // detects and rejects the lost lock when it finishes.
      await rm(tomb, { recursive: true, force: true }).catch(() => undefined);
      throw new TabLeaseRegistryLockCollisionError(lockDir);
    }
  }
  await rm(tomb, { recursive: true, force: true }).catch(() => undefined);
  const detail = explicitlyAbandoned
    ? `explicitly abandoned post-commit owner pid ${owner?.pid ?? "unknown"}`
    : owner
      ? `provably dead owner pid ${owner.pid}`
      : `ownerless lock older than ${Math.round(OWNERLESS_LOCK_STEAL_AGE_MS / 1000)}s`;
  logger?.(`[browser] Reclaimed tab-lease registry lock at ${lockDir} from ${detail}.`);
  return true;
}

/** Test-only direct access to the internal dead-owner lock-steal logic. */
export async function stealRegistryLockFromDeadOwnerForTest(
  lockDir: string,
  logger?: BrowserLogger,
): Promise<boolean> {
  return stealRegistryLockFromDeadOwner(lockDir, logger);
}

/** Test-only direct access to the internal registry-lock critical section. */
export async function withRegistryLockForTest<T>(
  profileDir: string,
  callback: () => Promise<T>,
  logger?: BrowserLogger,
  options?: RegistryLockWaitOptions,
): Promise<T> {
  return withRegistryLock(profileDir, callback, logger, options);
}

function isLockOwnerAlive(owner: RegistryLockOwner): boolean {
  if (!isProcessAlive(owner.pid)) {
    return false;
  }
  // PID-reuse discriminator (conservative): when the owner recorded its
  // process start ticks and the current process at that PID reports different
  // ticks, the PID was reused and the original owner is dead. When start
  // ticks are unavailable on either side, treat the owner as alive — we only
  // steal with proof of death.
  const recorded = owner.startTicks;
  if (typeof recorded === "string" && recorded.length > 0) {
    const current = readProcessStartTicks(owner.pid);
    if (current !== null && current !== recorded) {
      return false;
    }
  }
  return true;
}

/**
 * Linux: process start time in clock ticks since boot (field 22 of
 * /proc/<pid>/stat). Returns null where procfs is unavailable (macOS), which
 * degrades PID-reuse detection to conservative kill(0) liveness.
 */
function readProcessStartTicks(pid: number): string | null {
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
    const closeParen = raw.lastIndexOf(")");
    if (closeParen === -1) {
      return null;
    }
    const fields = raw.slice(closeParen + 2).split(" ");
    return fields[19] ?? null;
  } catch {
    return null;
  }
}

async function lockDirAgeMs(lockDir: string): Promise<number | null> {
  try {
    const stats = await stat(lockDir);
    return Math.max(0, Date.now() - stats.mtimeMs);
  } catch {
    return null;
  }
}

/**
 * Pure, read-only registry read. Never mutates the registry file, even when
 * the bytes are corrupt: a corrupt/wrong-shape document is reported as
 * `readable: false` with the raw bytes attached via `corruptRaw` so a
 * *locked* caller may attempt bounded recovery (see
 * `readRegistryOutcomeLocked`). This function is safe to call without
 * holding the registry lock (used by the lock-free census path,
 * `countActiveBrowserTabLeases`) precisely because it never writes.
 */
async function readRegistryOutcome(profileDir: string): Promise<RegistryReadOutcome> {
  const file = registryPath(profileDir);
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") {
      // A missing registry provably has no leases; only unreadable or corrupt
      // registries are ASSUME-ACTIVE.
      return { readable: true, valid: [], opaque: [], waiters: [] };
    }
    const message = error instanceof Error ? error.message : String(error);
    return { readable: false, reason: `read failed: ${message}`, cause: error };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      readable: false,
      reason: "not valid JSON (torn or corrupt)",
      cause: error,
      corruptRaw: raw,
    };
  }
  if (!parsed || typeof parsed !== "object") {
    return { readable: false, reason: "wrong document shape", corruptRaw: raw };
  }
  const document = parsed as { version?: unknown; leases?: unknown; waiters?: unknown };
  if (document.version !== undefined && document.version !== 1 && document.version !== 2) {
    // A future writer may attach semantics this binary does not understand.
    // This is not corrupt/torn input and must never enter the timed corruption
    // quarantine path, which would silently replace it with an empty v2 file.
    return { readable: false, reason: `unsupported registry version ${String(document.version)}` };
  }
  const legacyWithoutWaiters =
    (document.version === undefined || document.version === 1) && document.waiters === undefined;
  const currentDocument = document.version === 2 && Array.isArray(document.waiters);
  if (!Array.isArray(document.leases) || (!legacyWithoutWaiters && !currentDocument)) {
    return { readable: false, reason: "wrong document shape", corruptRaw: raw };
  }
  const valid: BrowserTabLeaseRecord[] = [];
  const opaque: unknown[] = [];
  for (const record of document.leases) {
    if (isLeaseRecord(record)) {
      valid.push(record);
    } else {
      // Malformed records are retained as opaque occupants (assume-active)
      // rather than silently dropped; see pruneOpaqueRecords for the bounded
      // evidence-based recovery.
      opaque.push(record);
    }
  }
  return {
    readable: true,
    valid,
    opaque,
    waiters: Array.isArray(document.waiters) ? document.waiters : [],
  };
}

/**
 * Locked variant of `readRegistryOutcome`: identical read, but when the
 * document is corrupt/wrong-shape it may additionally attempt bounded
 * quarantine recovery (`maybeRecoverCorruptRegistry`), which mutates the
 * registry file (rename to a quarantine path). Callers MUST already hold the
 * registry lock (`withRegistryLock`) before calling this — that is what
 * makes the mutation safe. The lock-free census path
 * (`countActiveBrowserTabLeases`) must never call this function; it uses the
 * read-only `readRegistryOutcome` instead.
 */
async function readRegistryOutcomeLocked(
  profileDir: string,
  logger?: BrowserLogger,
): Promise<RegistryReadOutcome> {
  const outcome = await readRegistryOutcome(profileDir);
  if (outcome.readable || outcome.corruptRaw === undefined) {
    return outcome;
  }
  return maybeRecoverCorruptRegistry(
    profileDir,
    outcome.corruptRaw,
    outcome.reason,
    outcome.cause,
    logger,
  );
}

/**
 * Bounded ASSUME-ACTIVE recovery for corrupt bytes that still contain
 * positive owner evidence: quarantine (rename, never delete) and restart
 * empty only when (a) at least one PID is extractable, (b) every extracted
 * PID is provably dead, and (c) the file has been quiet for
 * CORRUPT_REGISTRY_RECOVERY_QUIET_MS. PID-less/indeterminate corruption stays
 * fail-closed indefinitely; manual repair is safer than double-driving an
 * active browser whose lease record was damaged.
 */
async function maybeRecoverCorruptRegistry(
  profileDir: string,
  raw: string,
  reason: string,
  cause: unknown,
  logger?: BrowserLogger,
): Promise<RegistryReadOutcome> {
  const file = registryPath(profileDir);
  const candidatePids = extractPidCandidates(raw);
  const allCandidateOwnersDead =
    candidatePids.length > 0 && candidatePids.every((pid) => !isProcessAlive(pid));
  if (allCandidateOwnersDead) {
    try {
      const stats = await stat(file);
      if (Date.now() - stats.mtimeMs >= CORRUPT_REGISTRY_RECOVERY_QUIET_MS) {
        const quarantine = `${file}.corrupt-${new Date().toISOString().replace(/[:.]/gu, "-")}`;
        await rename(file, quarantine);
        logger?.(
          `[browser] Quarantined corrupt tab-lease registry (${reason}) to ${quarantine}; no referenced process is alive and the file was quiet for ${Math.round(CORRUPT_REGISTRY_RECOVERY_QUIET_MS / 60000)}m. Restarting with an empty registry.`,
        );
        return { readable: true, valid: [], opaque: [], waiters: [] };
      }
    } catch {
      // Quarantine failed or the file vanished mid-check: fall through to the
      // fail-closed outcome below.
    }
  }
  return { readable: false, reason, cause };
}

/** Salvage PID digits from corrupt registry bytes for liveness screening. */
function extractPidCandidates(raw: string): number[] {
  const pids = new Set<number>();
  const matcher = /"pid"\s*:\s*"?(\d{1,10})/gu;
  for (const match of raw.matchAll(matcher)) {
    const pid = Number.parseInt(match[1] ?? "", 10);
    if (Number.isFinite(pid) && pid > 0) {
      pids.add(pid);
    }
    if (pids.size >= 64) {
      break;
    }
  }
  return [...pids];
}

async function writeRegistry(
  profileDir: string,
  registry: { leases: readonly unknown[]; waiters: readonly unknown[] },
): Promise<void> {
  await mkdir(profileDir, { recursive: true });
  const finalPath = registryPath(profileDir);
  const payload = `${JSON.stringify({ version: 2, ...registry }, null, 2)}\n`;
  // Atomic publish: write + fsync a same-directory temp file, then rename()
  // over the registry so a concurrent reader can never observe a torn
  // document.
  const tempPath = `${finalPath}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  const handle = await open(tempPath, "w");
  try {
    await handle.writeFile(payload, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(tempPath, finalPath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
  // Durability of the rename itself: fsync the containing directory where the
  // platform allows it (best-effort; directory fsync is not universal).
  try {
    const dirHandle = await open(profileDir, "r");
    try {
      await dirHandle.sync();
    } catch {
      // ignore: directory fsync unsupported
    } finally {
      await dirHandle.close();
    }
  } catch {
    // ignore: directory cannot be opened for fsync on this platform
  }
}

function registryPath(profileDir: string): string {
  return path.join(profileDir, REGISTRY_FILENAME);
}

function pruneStaleLeases(
  leases: BrowserTabLeaseRecord[],
  options: { nowMs: number; staleMs: number; isProcessAlive: (pid: number) => boolean },
): BrowserTabLeaseRecord[] {
  return leases.filter((lease) => {
    if (!options.isProcessAlive(lease.pid)) {
      // Provably-dead owner: reclaim the slot immediately.
      return false;
    }
    // A live process can be paused by SIGSTOP, a debugger, VM suspension, or a
    // long host sleep. Reclaiming solely because its wall-clock heartbeat is
    // old would let a second controller acquire capacity; the first could then
    // resume and mutate the same browser without a fencing token. Preserve the
    // lease fail-closed until the owner is provably dead or its exact recorded
    // Chrome target is proved gone by the separate target-reconciliation path.
    return true;
  });
}

/**
 * Preserve FIFO order while pruning only waiters proven abandoned. Unlike a
 * lease, a waiter owns no browser state, so any parseable heartbeat outside
 * its bounded stale/future window is enough to make the record rejoin-safe.
 * Malformed records without a parseable heartbeat remain fail-closed.
 */
function pruneStaleWaiters(
  waiters: unknown[],
  options: { nowMs: number; staleMs: number; isProcessAlive: (pid: number) => boolean },
): unknown[] {
  return waiters.filter((waiter) => {
    if (!isWaiterRecord(waiter)) {
      const updatedAt = coerceTimestamp(waiter);
      if (updatedAt === null) return true;
      if (updatedAt - options.nowMs > MAX_WAITER_FUTURE_SKEW_MS) return false;
      if (options.nowMs - updatedAt > options.staleMs) return false;
      const pid = coercePid(waiter);
      return pid === null || options.isProcessAlive(pid);
    }
    if (!options.isProcessAlive(waiter.pid)) {
      return false;
    }
    const updatedAt = Date.parse(waiter.updatedAt);
    if (!Number.isFinite(updatedAt)) return true;
    // Invalid future timestamps must not become immortal FIFO blockers after
    // a host clock correction. Dropping a waiter is safe: it owns no browser
    // state and a live caller simply rejoins on its next poll.
    if (updatedAt - options.nowMs > MAX_WAITER_FUTURE_SKEW_MS) return false;
    return options.nowMs - updatedAt <= options.staleMs;
  });
}

/**
 * Malformed lease records count as occupants (assume-active). A coercible PID
 * that is provably dead is the only safe pruning evidence: timestamps cannot
 * fence a paused or suspended live owner, and a PID-less record may be the
 * damaged remnant of an active browser controller. Availability requires
 * manual repair when positive death cannot be established.
 */
function pruneOpaqueRecords(
  records: unknown[],
  options: { nowMs: number; staleMs: number; isProcessAlive: (pid: number) => boolean },
): unknown[] {
  return records.filter((record) => {
    const pid = coercePid(record);
    if (pid !== null) {
      return options.isProcessAlive(pid);
    }
    return true;
  });
}

function coercePid(record: unknown): number | null {
  if (!record || typeof record !== "object") {
    return null;
  }
  const value = (record as { pid?: unknown }).pid;
  const numeric =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number.parseInt(value, 10)
        : Number.NaN;
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return null;
  }
  return Math.trunc(numeric);
}

function coerceTimestamp(record: unknown): number | null {
  if (!record || typeof record !== "object") {
    return null;
  }
  const candidate = record as { createdAt?: unknown; updatedAt?: unknown };
  for (const value of [candidate.updatedAt, candidate.createdAt]) {
    if (typeof value !== "string") continue;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function isLeaseRecord(value: unknown): value is BrowserTabLeaseRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as BrowserTabLeaseRecord;
  return (
    typeof record.id === "string" &&
    typeof record.pid === "number" &&
    typeof record.createdAt === "string" &&
    typeof record.updatedAt === "string"
  );
}

function isWaiterRecord(value: unknown): value is BrowserTabWaiterRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as BrowserTabWaiterRecord;
  return (
    typeof record.id === "string" &&
    typeof record.pid === "number" &&
    typeof record.createdAt === "string" &&
    typeof record.updatedAt === "string"
  );
}

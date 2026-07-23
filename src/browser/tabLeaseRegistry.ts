import path from "node:path";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import type { BrowserLogger } from "./types.js";
import { isProcessAlive } from "./profileState.js";
import { delay } from "./utils.js";

export const DEFAULT_MAX_CONCURRENT_CHATGPT_TABS = 3;
const REGISTRY_FILENAME = "oracle-tab-leases.json";
const REGISTRY_LOCK_DIRNAME = "oracle-tab-leases.lock";
const REGISTRY_LOCK_OWNER_FILENAME = "owner.json";
const DEFAULT_POLL_MS = 1000;
const DEFAULT_STALE_MS = 6 * 60 * 60 * 1000;
const REGISTRY_LOCK_TIMEOUT_MS = 10_000;
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
 * restart empty only when no PID mentioned in the corrupt bytes is alive AND
 * the file has been quiet for this long. Keeps a single corrupt write from
 * deadlocking the fleet forever without ever racing a live writer.
 */
const CORRUPT_REGISTRY_RECOVERY_QUIET_MS = 15 * 60 * 1000;

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

export interface BrowserTabLease {
  id: string;
  release: (options?: {
    onRelease?: (context: { isLastLease: boolean }) => Promise<void>;
  }) => Promise<void>;
  update: (patch: Partial<BrowserTabLeaseRecord>) => Promise<void>;
}

interface BrowserTabLeaseDeps {
  now?: () => number;
  pid?: number;
  isProcessAlive?: (pid: number) => boolean;
  /** Test seam for the lock-free DevTools target snapshot used by reclamation. */
  listChromeTargetIds?: (options: {
    chromeHost: string;
    chromePort: number;
    signal?: AbortSignal;
  }) => Promise<readonly string[]>;
}

const TARGET_RECLAIM_PROBE_TIMEOUT_MS = 1_500;
const TARGET_RECLAIM_PROBE_INTERVAL_MS = 5_000;

/**
 * Fail-closed read outcome. `readable: false` means the registry exists but
 * cannot be verified (unreadable/corrupt/torn): callers must treat that as
 * ASSUME-ACTIVE — refuse to grant slots and report other leases as active —
 * never as an empty registry.
 */
type RegistryReadOutcome =
  | { readable: true; valid: BrowserTabLeaseRecord[]; opaque: unknown[] }
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
  constructor(lockDir: string) {
    super(
      `Tab-lease registry lock at ${lockDir} was reclaimed by another process while this process held it; ` +
        "refusing to release a lock that is no longer ours. Treat the operation just performed under this " +
        "lock as unverified, not successful.",
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
  constructor(lockDir: string, reason: "aborted" | "timed out") {
    super(`Tab-lease registry lock wait ${reason} at ${lockDir}.`);
    this.name = "TabLeaseRegistryLockWaitError";
  }
}

export class OrphanedBrowserTabLeaseError extends Error {
  readonly lease: BrowserTabLease;

  constructor(lease: BrowserTabLease, cause: unknown) {
    super(
      `Caller aborted after browser tab lease ${lease.id} was written, and rollback could not be proved; the lease remains active fail-closed.`,
      { cause },
    );
    this.name = "OrphanedBrowserTabLeaseError";
    this.lease = lease;
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
    signal?: AbortSignal;
  },
  deps: BrowserTabLeaseDeps = {},
): Promise<BrowserTabLease> {
  const maxConcurrentTabs = normalizeMaxConcurrentTabs(options.maxConcurrentTabs);
  const pollMs = Math.max(50, options.pollMs ?? DEFAULT_POLL_MS);
  const timeoutMs = Math.max(0, options.timeoutMs ?? 0);
  const staleMs = Math.max(60_000, options.staleMs ?? DEFAULT_STALE_MS);
  const now = deps.now ?? Date.now;
  const pid = deps.pid ?? process.pid;
  const alive = deps.isProcessAlive ?? isProcessAlive;
  const leaseId = randomUUID();
  const startedAt = now();
  let warned = false;
  let lastHeartbeatAt = 0;
  let lastTargetReclaimProbeAt = Number.NEGATIVE_INFINITY;
  const createLeaseHandle = (): BrowserTabLease => ({
    id: leaseId,
    release: async (releaseOptions) =>
      releaseBrowserTabLease(profileDir, leaseId, options.logger, releaseOptions),
    update: async (patch) => updateBrowserTabLease(profileDir, leaseId, patch, options.logger),
  });

  const throwIfAborted = (): void => {
    if (options.signal?.aborted) {
      throw new Error("Browser tab-lease acquisition aborted by caller.");
    }
  };

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
      Date.now() - lastTargetReclaimProbeAt >= TARGET_RECLAIM_PROBE_INTERVAL_MS
    ) {
      lastTargetReclaimProbeAt = Date.now();
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
        const pruneOptions = { nowMs: now(), staleMs, isProcessAlive: alive };
        const activeValid = pruneStaleLeases(outcome.valid, pruneOptions);
        const activeOpaque = pruneOpaqueRecords(outcome.opaque, pruneOptions);
        const occupied = activeValid.length + activeOpaque.length;
        if (occupied >= maxConcurrentTabs) {
          if (occupied !== outcome.valid.length + outcome.opaque.length) {
            await writeRegistry(profileDir, [...activeValid, ...activeOpaque]);
          }
          return null;
        }
        const timestamp = new Date(now()).toISOString();
        const lease: BrowserTabLeaseRecord = {
          id: leaseId,
          pid,
          sessionId: options.sessionId,
          chromeHost: options.chromeHost,
          chromePort: options.chromePort,
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        await writeRegistry(profileDir, [...activeValid, lease, ...activeOpaque]);
        return lease;
      },
      options.logger,
      {
        signal: options.signal,
        deadlineMs:
          timeoutMs > 0 ? Date.now() + Math.max(0, timeoutMs - (now() - startedAt)) : undefined,
      },
    );

    if (acquired) {
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

    const elapsed = now() - startedAt;
    if (!warned || now() - lastHeartbeatAt >= 30_000) {
      options.logger?.(
        `[browser] Waiting for ChatGPT browser slot (${maxConcurrentTabs} max, ${Math.round(elapsed / 1000)}s elapsed).`,
      );
      warned = true;
      lastHeartbeatAt = now();
    }
    if (timeoutMs > 0 && elapsed >= timeoutMs) {
      throw new Error(
        `Timed out waiting for ChatGPT browser slot after ${Math.round(elapsed / 1000)}s (${maxConcurrentTabs} max).`,
      );
    }
    await delayWithAbort(
      timeoutMs > 0 ? Math.min(pollMs, timeoutMs - elapsed) : pollMs,
      options.signal,
    );
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
        await writeRegistry(profileDir, [...remaining, ...current.opaque]);
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
      await writeRegistry(profileDir, [...leases, ...outcome.opaque]);
    },
    logger,
    { timeoutMs: REGISTRY_MUTATION_LOCK_TIMEOUT_MS },
  );
}

export async function releaseBrowserTabLease(
  profileDir: string,
  leaseId: string,
  logger?: BrowserLogger,
  options: { onRelease?: (context: { isLastLease: boolean }) => Promise<void> } = {},
): Promise<void> {
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
      const ownsLease = activeValid.some((lease) => lease.id === leaseId);
      const remaining = activeValid.filter((lease) => lease.id !== leaseId);
      if (ownsLease) {
        // Keep the lease advertised while the registry lock blocks new
        // acquisitions. Publish its removal only after the cleanup callback
        // succeeds; callback failure therefore retains capacity fail-closed.
        await options.onRelease?.({
          isLastLease: remaining.length === 0 && activeOpaque.length === 0,
        });
      }
      await writeRegistry(profileDir, [...remaining, ...activeOpaque]);
    },
    logger,
    { timeoutMs: REGISTRY_MUTATION_LOCK_TIMEOUT_MS },
  );
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
      if (
        activeValid.length + activeOpaque.length !==
        outcome.valid.length + outcome.opaque.length
      ) {
        // Best-effort persistence of the prune; the computed answer below is
        // valid regardless of whether this write lands.
        await writeRegistry(profileDir, [...activeValid, ...activeOpaque]).catch(() => undefined);
      }
      return activeOpaque.length > 0 || activeValid.some((lease) => lease.id !== leaseId);
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
      if (
        activeValid.length + activeOpaque.length !==
        outcome.valid.length + outcome.opaque.length
      ) {
        // Best-effort persistence of the prune; the computed answer below is
        // valid regardless of whether this write lands.
        await writeRegistry(profileDir, [...activeValid, ...activeOpaque]).catch(() => undefined);
      }
      const targetIds = new Set<string>();
      let unattributedCount = activeOpaque.length;
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

interface RegistryLockWaitOptions {
  signal?: AbortSignal;
  /** Absolute wall-clock deadline. */
  deadlineMs?: number;
  /** Relative wall-clock bound, ignored when deadlineMs is supplied. */
  timeoutMs?: number;
}

async function withRegistryLock<T>(
  profileDir: string,
  callback: () => Promise<T>,
  logger?: BrowserLogger,
  options: RegistryLockWaitOptions = {},
): Promise<T> {
  const lockDir = path.join(profileDir, REGISTRY_LOCK_DIRNAME);
  const ownerPath = path.join(lockDir, REGISTRY_LOCK_OWNER_FILENAME);
  const startedAt = Date.now();
  const deadlineMs =
    options.deadlineMs ??
    (options.timeoutMs !== undefined
      ? startedAt + Math.max(0, options.timeoutMs)
      : Number.POSITIVE_INFINITY);
  let lastWaitLogAt = 0;
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
      await mkdir(lockDir, { recursive: false });
      break;
    } catch (error) {
      if ((error as { code?: string }).code !== "EEXIST") {
        throw error;
      }
      if (Date.now() >= deadlineMs) {
        throw new TabLeaseRegistryLockWaitError(lockDir, "timed out");
      }
      if (Date.now() - startedAt > REGISTRY_LOCK_TIMEOUT_MS) {
        // Owner-aware steal: the lock is reclaimed only from a provably-dead
        // owner (or a bounded-stale ownerless legacy lock). A lock whose
        // owner is alive is NEVER stolen — we keep waiting instead.
        const stolen = await stealRegistryLockFromDeadOwner(lockDir, logger);
        if (stolen) {
          continue;
        }
        if (Date.now() - lastWaitLogAt >= 30_000) {
          lastWaitLogAt = Date.now();
          logger?.(
            `[browser] Tab-lease registry lock at ${lockDir} is held by a live owner; waiting (${Math.round((Date.now() - startedAt) / 1000)}s elapsed).`,
          );
        }
      }
      if (options.signal?.aborted) {
        throw new TabLeaseRegistryLockWaitError(lockDir, "aborted");
      }
      const remainingMs = deadlineMs - Date.now();
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
  // Record our identity inside the lock so peers can verify owner liveness.
  // Best-effort: if this write fails, peers fall back to the bounded
  // ownerless-stale reclamation path instead of stealing immediately.
  const owner: RegistryLockOwner = {
    pid: process.pid,
    startTicks: readProcessStartTicks(process.pid),
    createdAt: new Date().toISOString(),
    token: randomUUID(),
  };
  await writeFile(ownerPath, `${JSON.stringify(owner)}\n`, "utf8").catch(() => undefined);
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
  const myLockHandle = await openDirIdentityHandle(lockDir);
  try {
    return await callback();
  } finally {
    await releaseRegistryLockIfOwned(lockDir, myLockHandle, logger);
  }
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
): Promise<void> {
  try {
    const current = await stat(lockDir).catch(() => null);
    const sameDir =
      myLockHandle !== null &&
      current !== null &&
      current.dev === myLockHandle.dev &&
      current.ino === myLockHandle.ino;
    if (!sameDir) {
      logger?.(
        `[browser] ERROR: tab-lease registry lock at ${lockDir} no longer matches the directory this ` +
          "process acquired; refusing to release it (it may belong to another owner now).",
      );
      throw new TabLeaseRegistryLockOwnershipLostError(lockDir);
    }
    await rm(lockDir, { recursive: true, force: true }).catch(() => undefined);
  } finally {
    if (myLockHandle) {
      await myLockHandle.close().catch(() => undefined);
    }
  }
}

/**
 * Attempt to reclaim the registry lock. Returns true when the lock directory
 * was removed (provably-dead owner or bounded-stale ownerless lock) and the
 * caller may retry mkdir(); returns false when the owner is (or may be)
 * alive, or another process raced us.
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
  if (owner) {
    if (isLockOwnerAlive(owner)) {
      // Live owner: never steal, no matter how long the lock has been held.
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
  try {
    tombRaw = await readFile(path.join(tomb, REGISTRY_LOCK_OWNER_FILENAME), "utf8");
  } catch {
    tombRaw = null;
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
    tombRaw === ownerRaw;
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
  const detail = owner
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
      return { readable: true, valid: [], opaque: [] };
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
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !Array.isArray((parsed as { leases?: unknown }).leases)
  ) {
    return { readable: false, reason: "wrong document shape", corruptRaw: raw };
  }
  const valid: BrowserTabLeaseRecord[] = [];
  const opaque: unknown[] = [];
  for (const record of (parsed as { leases: unknown[] }).leases) {
    if (isLeaseRecord(record)) {
      valid.push(record);
    } else {
      // Malformed records are retained as opaque occupants (assume-active)
      // rather than silently dropped; see pruneOpaqueRecords for the bounded
      // evidence-based recovery.
      opaque.push(record);
    }
  }
  return { readable: true, valid, opaque };
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
 * Bounded ASSUME-ACTIVE recovery so a corrupt registry cannot deadlock the
 * fleet forever: quarantine (rename, never delete) and restart empty only
 * when (a) no PID mentioned anywhere in the corrupt bytes is alive and
 * (b) the file has been quiet for CORRUPT_REGISTRY_RECOVERY_QUIET_MS.
 * Otherwise the registry stays unverifiable and every caller fails closed.
 */
async function maybeRecoverCorruptRegistry(
  profileDir: string,
  raw: string,
  reason: string,
  cause: unknown,
  logger?: BrowserLogger,
): Promise<RegistryReadOutcome> {
  const file = registryPath(profileDir);
  const anyCandidateAlive = extractPidCandidates(raw).some((pid) => isProcessAlive(pid));
  if (!anyCandidateAlive) {
    try {
      const stats = await stat(file);
      if (Date.now() - stats.mtimeMs >= CORRUPT_REGISTRY_RECOVERY_QUIET_MS) {
        const quarantine = `${file}.corrupt-${new Date().toISOString().replace(/[:.]/gu, "-")}`;
        await rename(file, quarantine);
        logger?.(
          `[browser] Quarantined corrupt tab-lease registry (${reason}) to ${quarantine}; no referenced process is alive and the file was quiet for ${Math.round(CORRUPT_REGISTRY_RECOVERY_QUIET_MS / 60000)}m. Restarting with an empty registry.`,
        );
        return { readable: true, valid: [], opaque: [] };
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

async function writeRegistry(profileDir: string, leases: readonly unknown[]): Promise<void> {
  await mkdir(profileDir, { recursive: true });
  const finalPath = registryPath(profileDir);
  const payload = `${JSON.stringify({ version: 1, leases }, null, 2)}\n`;
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
    const updatedAt = Date.parse(lease.updatedAt);
    if (Number.isFinite(updatedAt) && options.nowMs - updatedAt > options.staleMs) {
      // Stale heartbeat despite an "alive" PID: bounded recovery for PID
      // reuse, where kill(0) keeps answering for an unrelated process.
      return false;
    }
    return true;
  });
}

/**
 * Malformed lease records count as occupants (assume-active). They are pruned
 * only with evidence: a coercible PID that is provably dead, or a parseable
 * heartbeat older than the stale window (bounded recovery for PID-less
 * garbage). Records with neither stay occupied rather than silently vanish.
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
    const updatedAt = coerceTimestamp(record);
    if (updatedAt !== null && options.nowMs - updatedAt > options.staleMs) {
      return false;
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
  const value = (record as { updatedAt?: unknown }).updatedAt;
  if (typeof value !== "string") {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
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

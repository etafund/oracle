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
  release: () => Promise<void>;
  update: (patch: Partial<BrowserTabLeaseRecord>) => Promise<void>;
}

interface BrowserTabLeaseDeps {
  now?: () => number;
  pid?: number;
  isProcessAlive?: (pid: number) => boolean;
}

/**
 * Fail-closed read outcome. `readable: false` means the registry exists but
 * cannot be verified (unreadable/corrupt/torn): callers must treat that as
 * ASSUME-ACTIVE — refuse to grant slots and report other leases as active —
 * never as an empty registry.
 */
type RegistryReadOutcome =
  | { readable: true; valid: BrowserTabLeaseRecord[]; opaque: unknown[] }
  | { readable: false; reason: string; cause?: unknown };

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

  for (;;) {
    const acquired = await withRegistryLock(
      profileDir,
      async () => {
        const outcome = await readRegistryOutcome(profileDir, options.logger);
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
    );

    if (acquired) {
      options.logger?.(
        `[browser] Acquired ChatGPT browser slot ${leaseId.slice(0, 8)} (${maxConcurrentTabs} max).`,
      );
      return {
        id: leaseId,
        release: async () => releaseBrowserTabLease(profileDir, leaseId, options.logger),
        update: async (patch) => updateBrowserTabLease(profileDir, leaseId, patch, options.logger),
      };
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
    await delay(timeoutMs > 0 ? Math.min(pollMs, timeoutMs - elapsed) : pollMs);
  }
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
      const outcome = await readRegistryOutcome(profileDir, logger);
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
  );
}

export async function releaseBrowserTabLease(
  profileDir: string,
  leaseId: string,
  logger?: BrowserLogger,
): Promise<void> {
  await withRegistryLock(
    profileDir,
    async () => {
      const outcome = await readRegistryOutcome(profileDir, logger);
      if (!outcome.readable) {
        // Truthful release: we cannot prove the record was removed from an
        // unverifiable registry, so surface the fault instead of pretending.
        throw new TabLeaseRegistryUnreadableError(profileDir, outcome.reason, outcome.cause);
      }
      const remaining = outcome.valid.filter((lease) => lease.id !== leaseId);
      await writeRegistry(profileDir, [...remaining, ...outcome.opaque]);
    },
    logger,
  );
  // Only report success after the lease record was actually removed and the
  // registry rewritten; lock/read/write failures propagate to the caller.
  logger?.(`[browser] Released ChatGPT browser slot ${leaseId.slice(0, 8)}.`);
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
      const outcome = await readRegistryOutcome(profileDir, options.logger);
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

interface RegistryLockOwner {
  pid: number;
  startTicks?: string | null;
  createdAt?: string;
  token?: string;
}

async function withRegistryLock<T>(
  profileDir: string,
  callback: () => Promise<T>,
  logger?: BrowserLogger,
): Promise<T> {
  const lockDir = path.join(profileDir, REGISTRY_LOCK_DIRNAME);
  const ownerPath = path.join(lockDir, REGISTRY_LOCK_OWNER_FILENAME);
  const startedAt = Date.now();
  let lastWaitLogAt = 0;
  for (;;) {
    try {
      await mkdir(lockDir, { recursive: false });
      break;
    } catch (error) {
      if ((error as { code?: string }).code !== "EEXIST") {
        throw error;
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
      await delay(50);
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
  try {
    return await callback();
  } finally {
    await rm(lockDir, { recursive: true, force: true }).catch(() => undefined);
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
      return false;
    }
  } else {
    // No verifiable owner identity (legacy lock, or the owner crashed before
    // its identity write landed). Only reclaim after a bounded quiet period
    // so an in-flight acquisition is never raced.
    const ageMs = await lockDirAgeMs(lockDir);
    if (ageMs === null || ageMs < OWNERLESS_LOCK_STEAL_AGE_MS) {
      return false;
    }
  }
  // Atomic reclamation: rename the lock directory to a tombstone (exactly one
  // stealer wins the rename), verify the tombstone still holds the same dead
  // owner we judged, then remove it. If a fresh owner slipped in between the
  // liveness check and the rename, give the lock back.
  const tomb = `${lockDir}.stale-${randomUUID().slice(0, 8)}`;
  try {
    await rename(lockDir, tomb);
  } catch {
    // Lock released or another stealer won; let the caller retry mkdir().
    return false;
  }
  let tombRaw: string | null = null;
  try {
    tombRaw = await readFile(path.join(tomb, REGISTRY_LOCK_OWNER_FILENAME), "utf8");
  } catch {
    tombRaw = null;
  }
  if (tombRaw !== ownerRaw) {
    try {
      await rename(tomb, lockDir);
      return false;
    } catch {
      // A third process created a new lock while we held the tombstone. The
      // displaced fresh owner loses its lock; log loudly — the registry file
      // itself stays consistent because writes are atomic (temp + rename).
      await rm(tomb, { recursive: true, force: true }).catch(() => undefined);
      logger?.(
        `[browser] WARNING: tab-lease lock steal collided with a concurrent acquirer at ${lockDir}; a lock holder may have been displaced.`,
      );
      return true;
    }
  }
  await rm(tomb, { recursive: true, force: true }).catch(() => undefined);
  const detail = owner
    ? `provably dead owner pid ${owner.pid}`
    : `ownerless lock older than ${Math.round(OWNERLESS_LOCK_STEAL_AGE_MS / 1000)}s`;
  logger?.(`[browser] Reclaimed tab-lease registry lock at ${lockDir} from ${detail}.`);
  return true;
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

async function readRegistryOutcome(
  profileDir: string,
  logger?: BrowserLogger,
): Promise<RegistryReadOutcome> {
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
    return maybeRecoverCorruptRegistry(
      profileDir,
      raw,
      "not valid JSON (torn or corrupt)",
      error,
      logger,
    );
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !Array.isArray((parsed as { leases?: unknown }).leases)
  ) {
    return maybeRecoverCorruptRegistry(profileDir, raw, "wrong document shape", undefined, logger);
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

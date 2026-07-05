/**
 * Regression tests for two tab-lease registry concurrency defects found in
 * adversarial review 2026-07-03 (beads `1fy`, `e3x`), both in
 * src/browser/tabLeaseRegistry.ts. Every test below is written to FAIL
 * against the pre-fix behavior; see the inline notes on each test for what
 * the old code did instead.
 *
 * 1fy (P2): lock-steal could displace a fresh owner.
 *   - withRegistryLock() released the lock directory in a `finally` block
 *     via an unconditional `rm()`, without ever checking that the directory
 *     still belonged to the calling process. If a peer's dead-owner
 *     reclamation replaced the lock mid-callback, the original holder would
 *     delete the NEW owner's lock on its way out.
 *   - stealRegistryLockFromDeadOwner()'s same-owner check compared owner-file
 *     CONTENT only (`tombRaw !== ownerRaw`), so two absent owner files
 *     (null/null — a fresh acquirer whose own owner.json write had not yet
 *     landed) were wrongly treated as proof of "same lock", completing a
 *     steal against a fresh, legitimate owner.
 *   - When the give-back rename after a detected mismatch ALSO failed (a
 *     third acquirer raced in), the old code deleted the tombstone, logged a
 *     warning, and reported the steal as successful (`return true`) instead
 *     of failing closed.
 *
 * e3x (P3): countActiveBrowserTabLeases() (the lock-free census path used by
 * /ready) read the registry via a helper that could itself mutate
 * (quarantine-rename) the registry file on a corrupt read — a write
 * happening outside any lock, racing real lock-holding writers.
 */
import { describe, expect, test, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";

const raceHooks = vi.hoisted(() => ({
  beforeStealRename: null as (() => Promise<void>) | null,
  beforeGiveBackRename: null as (() => Promise<void>) | null,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: async (oldPath: unknown, newPath: unknown) => {
      if (
        raceHooks.beforeStealRename &&
        typeof oldPath === "string" &&
        typeof newPath === "string" &&
        !oldPath.includes(".stale-") &&
        newPath.includes(".stale-")
      ) {
        const hook = raceHooks.beforeStealRename;
        raceHooks.beforeStealRename = null;
        await hook();
      } else if (
        raceHooks.beforeGiveBackRename &&
        typeof oldPath === "string" &&
        typeof newPath === "string" &&
        oldPath.includes(".stale-") &&
        !newPath.includes(".stale-")
      ) {
        const hook = raceHooks.beforeGiveBackRename;
        raceHooks.beforeGiveBackRename = null;
        await hook();
      }
      return actual.rename(oldPath as string, newPath as string);
    },
  };
});

import {
  TabLeaseRegistryLockCollisionError,
  TabLeaseRegistryLockOwnershipLostError,
  acquireBrowserTabLease,
  countActiveBrowserTabLeases,
  stealRegistryLockFromDeadOwnerForTest,
  withRegistryLockForTest,
} from "../../src/browser/tabLeaseRegistry.js";

const LOCK_DIRNAME = "oracle-tab-leases.lock";
const REGISTRY_FILENAME = "oracle-tab-leases.json";
const OWNERLESS_STEAL_AGE_MS = 60_000;
const CORRUPT_RECOVERY_QUIET_MS = 15 * 60 * 1000;

async function makeProfileDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "oracle-lease-concurrency-"));
}

async function backdate(target: string, ageMs: number): Promise<void> {
  const past = new Date(Date.now() - ageMs);
  await utimes(target, past, past);
}

describe("tab-lease registry: lock-steal self-ownership (1fy)", () => {
  test("[regression 1fy] steal must NOT treat null/null owner content as proof of same lock", async () => {
    const dir = await makeProfileDir();
    const lockDir = path.join(dir, LOCK_DIRNAME);
    try {
      // An ownerless legacy lock (no owner.json ever written), aged past the
      // bounded steal window.
      await mkdir(lockDir, { recursive: true });
      await backdate(lockDir, OWNERLESS_STEAL_AGE_MS + 5_000);

      // Inject the race right before the steal-away rename fires: a fresh,
      // legitimate acquirer grabs the SAME path in between our liveness
      // check and our rename() call. Its own owner.json write has not yet
      // landed, so — like the dead lock we are examining — it also reads as
      // ownerless (content: null). Only directory identity (inode) can tell
      // these two apart.
      raceHooks.beforeStealRename = async () => {
        await rm(lockDir, { recursive: true, force: true });
        await mkdir(lockDir, { recursive: true });
      };

      const stolen = await stealRegistryLockFromDeadOwnerForTest(lockDir);

      // Old (buggy) behavior: tombRaw(null) !== ownerRaw(null) is false, so
      // the mismatch was never detected; the tombstone (holding the fresh
      // owner's brand-new directory) was deleted outright and `true` was
      // returned, permanently destroying the fresh owner's lock.
      //
      // Fixed behavior: the inode captured before the rename differs from
      // the inode of what actually got renamed, so the mismatch IS detected;
      // the directory is handed back and the steal is reported as failed.
      expect(stolen).toBe(false);
      const restored = await stat(lockDir).catch(() => null);
      expect(restored).not.toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("[regression 1fy] a steal collision (give-back also fails) fails closed instead of warn-and-continue", async () => {
    const dir = await makeProfileDir();
    const lockDir = path.join(dir, LOCK_DIRNAME);
    try {
      await mkdir(lockDir, { recursive: true });
      await backdate(lockDir, OWNERLESS_STEAL_AGE_MS + 5_000);

      // A fresh owner slips in right before the steal-away rename...
      raceHooks.beforeStealRename = async () => {
        await rm(lockDir, { recursive: true, force: true });
        await mkdir(lockDir, { recursive: true });
      };
      // ...and a THIRD acquirer takes the path while the fresh owner's
      // directory sits in the tombstone, so the give-back rename collides.
      raceHooks.beforeGiveBackRename = async () => {
        await mkdir(lockDir, { recursive: true });
        await writeFile(
          path.join(lockDir, "owner.json"),
          `${JSON.stringify({ pid: process.pid })}\n`,
          "utf8",
        );
      };

      // Old (buggy) behavior: this branch deleted the tombstone, logged a
      // WARNING, and returned `true` (steal "succeeded") — the displaced
      // fresh owner's callback would keep running believing it still held
      // the critical section while a third owner also held an independent
      // lock. Fixed behavior: fail closed with a typed error.
      await expect(stealRegistryLockFromDeadOwnerForTest(lockDir)).rejects.toBeInstanceOf(
        TabLeaseRegistryLockCollisionError,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("[regression 1fy] release refuses to delete a lock reclaimed mid-callback", async () => {
    const dir = await makeProfileDir();
    const lockDir = path.join(dir, LOCK_DIRNAME);
    let peerOwnerPid = -1;
    try {
      const run = withRegistryLockForTest(dir, async () => {
        // Simulate: while our callback is still running, a peer decided we
        // were dead and reclaimed the lock, replacing the directory with its
        // own fresh one.
        await rm(lockDir, { recursive: true, force: true });
        await mkdir(lockDir, { recursive: true });
        peerOwnerPid = 999_999;
        await writeFile(
          path.join(lockDir, "owner.json"),
          `${JSON.stringify({ pid: peerOwnerPid })}\n`,
          "utf8",
        );
        return "callback-completed";
      });

      // Old (buggy) behavior: the finally block did an unconditional
      // `rm(lockDir, ...)`, silently deleting the peer's active lock and
      // resolving as if nothing had gone wrong. Fixed behavior: self-
      // ownership verification (inode comparison) detects the swap and
      // throws instead of tearing down someone else's critical section.
      await expect(run).rejects.toBeInstanceOf(TabLeaseRegistryLockOwnershipLostError);

      const peerLockStillThere = await stat(lockDir).catch(() => null);
      expect(peerLockStillThere).not.toBeNull();
      const ownerContents = await stat(path.join(lockDir, "owner.json")).catch(() => null);
      expect(ownerContents).not.toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("tab-lease registry: lock-free census must never mutate the file (e3x)", () => {
  test("[regression e3x] countActiveBrowserTabLeases does not quarantine a corrupt registry", async () => {
    const dir = await makeProfileDir();
    const registryFile = path.join(dir, REGISTRY_FILENAME);
    try {
      // Corrupt bytes referencing no live PID, quiet long enough that a
      // LOCKED caller would be entitled to recover it.
      await writeFile(registryFile, "%%% not json, no pid, corrupt %%%", "utf8");
      await backdate(registryFile, CORRUPT_RECOVERY_QUIET_MS + 60_000);

      const census = await countActiveBrowserTabLeases(dir);
      expect(census.readable).toBe(false);
      expect(census.activeLeaseCount).toBeNull();

      // Old (buggy) behavior: countActiveBrowserTabLeases() -> readRegistry-
      // Outcome() -> maybeRecoverCorruptRegistry() performed a rename() of
      // the registry file to a quarantine path, from a code path that holds
      // no lock at all — a write racing any concurrent locked writer. Fixed
      // behavior: the lock-free census path is read-only; the original file
      // must still exist, byte-for-byte, and no quarantine file should have
      // been created.
      const original = await stat(registryFile).catch(() => null);
      expect(original).not.toBeNull();
      const entries = await readdir(dir);
      expect(entries.some((name) => name.includes(".corrupt-"))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("[regression e3x] a LOCKED caller still recovers the same corrupt registry", async () => {
    const dir = await makeProfileDir();
    const registryFile = path.join(dir, REGISTRY_FILENAME);
    try {
      await writeFile(registryFile, "%%% not json, no pid, corrupt %%%", "utf8");
      await backdate(registryFile, CORRUPT_RECOVERY_QUIET_MS + 60_000);

      // A locked operation (acquire) is entitled to attempt bounded
      // quarantine recovery and should succeed in granting a slot afterward.
      const lease = await acquireBrowserTabLease(dir, {
        maxConcurrentTabs: 1,
        pollMs: 25,
        timeoutMs: 1_000,
      });
      const entries = await readdir(dir);
      expect(entries.some((name) => name.includes(".corrupt-"))).toBe(true);
      await lease.release();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

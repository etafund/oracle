import { describe, expect, test, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import {
  acquireBrowserTabLease,
  BrowserTabLeaseQueueTimeoutError,
  BrowserTabLeaseRegistryLockTimeoutError,
  deferredBrowserTabLeaseReleaseCompletionForTest,
  OrphanedBrowserTabLeaseError,
  releaseBrowserTabLease,
  TabLeaseRegistryLockOwnershipLostError,
  TabLeaseRegistryLockReleaseError,
  TabLeaseRegistryLockWaitError,
  TabLeaseRegistryPostCommitUnlockError,
  stealRegistryLockFromDeadOwnerForTest,
  withRegistryLockForTest,
} from "../../src/browser/tabLeaseRegistry.js";

const REGISTRY_FILENAME = "oracle-tab-leases.json";

interface RegistryDocument {
  version: number;
  leases: Array<{
    id: string;
    pid?: number;
    startTicks?: string | null;
    sessionId?: string;
    createdAt?: string;
    updatedAt?: string;
  }>;
  waiters: Array<{
    id?: string;
    pid?: number;
    sessionId?: string;
    createdAt?: string;
    updatedAt?: string;
  }>;
}

async function makeProfileDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "oracle-lease-queue-"));
}

async function readRegistry(dir: string): Promise<RegistryDocument> {
  return JSON.parse(await readFile(path.join(dir, REGISTRY_FILENAME), "utf8")) as RegistryDocument;
}

async function waitForRegistry(
  dir: string,
  predicate: (registry: RegistryDocument) => boolean,
  timeoutMs = 2_000,
): Promise<RegistryDocument> {
  const deadline = Date.now() + timeoutMs;
  let latest: RegistryDocument | null = null;
  while (Date.now() < deadline) {
    latest = await readRegistry(dir).catch(() => null);
    if (latest && predicate(latest)) return latest;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for registry state: ${JSON.stringify(latest)}`);
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((fulfill) => {
    resolve = fulfill;
  });
  return { promise, resolve };
}

describe("tab-lease persisted FIFO queue", () => {
  test("keeps two active leases overlapping when maxConcurrentTabs is two", async () => {
    const dir = await makeProfileDir();
    try {
      const first = await acquireBrowserTabLease(dir, {
        maxConcurrentTabs: 2,
        timeoutMs: 500,
        sessionId: "lane-one",
      });
      const second = await acquireBrowserTabLease(dir, {
        maxConcurrentTabs: 2,
        timeoutMs: 500,
        sessionId: "lane-two",
      });

      const registry = await readRegistry(dir);
      expect(registry.version).toBe(2);
      expect(registry.leases.map((lease) => lease.sessionId)).toEqual(["lane-one", "lane-two"]);
      expect(registry.waiters).toEqual([]);

      await first.release();
      await second.release();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("grants the third waiter before the fourth at maxConcurrentTabs two", async () => {
    const dir = await makeProfileDir();
    try {
      const first = await acquireBrowserTabLease(dir, {
        maxConcurrentTabs: 2,
        timeoutMs: 500,
        sessionId: "active-one",
      });
      const second = await acquireBrowserTabLease(dir, {
        maxConcurrentTabs: 2,
        timeoutMs: 500,
        sessionId: "active-two",
      });
      const resolutionOrder: string[] = [];
      const thirdPromise = acquireBrowserTabLease(dir, {
        maxConcurrentTabs: 2,
        pollMs: 25,
        timeoutMs: 3_000,
        sessionId: "third",
      }).then((lease) => {
        resolutionOrder.push("third");
        return lease;
      });
      await waitForRegistry(
        dir,
        (registry) => registry.waiters.map((waiter) => waiter.sessionId).join(",") === "third",
      );

      let fourthResolved = false;
      const fourthPromise = acquireBrowserTabLease(dir, {
        maxConcurrentTabs: 2,
        pollMs: 25,
        timeoutMs: 3_000,
        sessionId: "fourth",
      }).then((lease) => {
        fourthResolved = true;
        resolutionOrder.push("fourth");
        return lease;
      });
      await waitForRegistry(
        dir,
        (registry) =>
          registry.waiters.map((waiter) => waiter.sessionId).join(",") === "third,fourth",
      );

      await first.release();
      const third = await thirdPromise;
      await waitForRegistry(
        dir,
        (registry) =>
          registry.leases.some((lease) => lease.sessionId === "third") &&
          registry.waiters.map((waiter) => waiter.sessionId).join(",") === "fourth",
      );
      expect(fourthResolved).toBe(false);
      expect(resolutionOrder).toEqual(["third"]);

      await second.release();
      const fourth = await fourthPromise;
      expect(resolutionOrder).toEqual(["third", "fourth"]);

      await third.release();
      await fourth.release();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("removes a persisted waiter when its caller aborts", async () => {
    const dir = await makeProfileDir();
    try {
      const active = await acquireBrowserTabLease(dir, {
        maxConcurrentTabs: 1,
        timeoutMs: 500,
        sessionId: "active",
      });
      const controller = new AbortController();
      const queued = acquireBrowserTabLease(dir, {
        maxConcurrentTabs: 1,
        pollMs: 5_000,
        timeoutMs: 30_000,
        sessionId: "aborted",
        signal: controller.signal,
      });
      await waitForRegistry(dir, (registry) =>
        registry.waiters.some((waiter) => waiter.sessionId === "aborted"),
      );

      controller.abort();
      await expect(queued).rejects.toThrow(/acquisition aborted by caller/u);
      const registry = await waitForRegistry(dir, (value) => value.waiters.length === 0);
      expect(registry.leases.map((lease) => lease.sessionId)).toEqual(["active"]);

      await active.release();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("removes a timed-out waiter and returns typed retry-safe pre-submit capacity metadata", async () => {
    const dir = await makeProfileDir();
    try {
      const active = await acquireBrowserTabLease(dir, {
        maxConcurrentTabs: 1,
        timeoutMs: 500,
        sessionId: "active",
      });
      const queued = acquireBrowserTabLease(dir, {
        maxConcurrentTabs: 1,
        pollMs: 25,
        timeoutMs: 100,
        sessionId: "timed-out",
      });
      await expect(queued).rejects.toMatchObject({
        name: "BrowserTabLeaseQueueTimeoutError",
        details: {
          stage: "browser-queue",
          code: "browser_lock_timeout",
          oracleErrorClass: "capacity_busy",
          retryable: true,
          runtime: { promptSubmitted: false },
        },
      } satisfies Partial<BrowserTabLeaseQueueTimeoutError>);
      const registry = await waitForRegistry(dir, (value) => value.waiters.length === 0);
      expect(registry.leases.map((lease) => lease.sessionId)).toEqual(["active"]);
      await active.release();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("marks a recovery admission timeout non-retryable and preserves submitted state", async () => {
    const dir = await makeProfileDir();
    try {
      const active = await acquireBrowserTabLease(dir, {
        maxConcurrentTabs: 1,
        timeoutMs: 500,
        sessionId: "active",
      });
      const recovery = acquireBrowserTabLease(dir, {
        maxConcurrentTabs: 1,
        pollMs: 25,
        timeoutMs: 100,
        sessionId: "submitted-recovery",
        promptSubmitted: true,
      });

      await expect(recovery).rejects.toMatchObject({
        name: "BrowserTabLeaseQueueTimeoutError",
        details: {
          stage: "browser-queue",
          code: "browser_lock_timeout",
          oracleErrorClass: "capacity_busy",
          retryable: false,
          runtime: { promptSubmitted: true },
        },
      } satisfies Partial<BrowserTabLeaseQueueTimeoutError>);
      const registry = await waitForRegistry(dir, (value) => value.waiters.length === 0);
      expect(registry.leases.map((lease) => lease.sessionId)).toEqual(["active"]);
      await active.release();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("uses wall time for records and an injected monotonic clock for queue budgets", async () => {
    const dir = await makeProfileDir();
    const fixedWallMs = Date.parse("2026-07-23T12:34:56.000Z");
    let activeMonotonicMs = 0;
    let queuedMonotonicMs = 0;
    let active: Awaited<ReturnType<typeof acquireBrowserTabLease>> | null = null;
    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), 250);
    try {
      active = await acquireBrowserTabLease(
        dir,
        {
          maxConcurrentTabs: 1,
          timeoutMs: 100,
          sessionId: "fixed-wall-active",
        },
        {
          now: () => fixedWallMs,
          monotonicNow: () => (activeMonotonicMs += 250),
        },
      );

      const persisted = await readRegistry(dir);
      expect(persisted.leases).toEqual([
        expect.objectContaining({
          sessionId: "fixed-wall-active",
          createdAt: "2026-07-23T12:34:56.000Z",
          updatedAt: "2026-07-23T12:34:56.000Z",
        }),
      ]);

      const queued = acquireBrowserTabLease(
        dir,
        {
          maxConcurrentTabs: 1,
          pollMs: 25,
          timeoutMs: 100,
          sessionId: "fixed-wall-queued",
          signal: controller.signal,
        },
        {
          // A frozen or backward-adjusted wall clock must not freeze the
          // process-local timeout. Before the monotonic split this test hit
          // the abort fallback instead of the typed queue timeout.
          now: () => fixedWallMs,
          monotonicNow: () => (queuedMonotonicMs += 250),
        },
      );
      await expect(queued).rejects.toBeInstanceOf(BrowserTabLeaseQueueTimeoutError);

      const registry = await waitForRegistry(dir, (value) => value.waiters.length === 0);
      expect(registry.leases.map((lease) => lease.sessionId)).toEqual(["fixed-wall-active"]);
    } finally {
      clearTimeout(abortTimer);
      await active?.release();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("never ages out a lease whose owner PID is still live", async () => {
    const dir = await makeProfileDir();
    const oldTimestamp = "2000-01-01T00:00:00.000Z";
    try {
      await writeFile(
        path.join(dir, REGISTRY_FILENAME),
        `${JSON.stringify(
          {
            version: 2,
            leases: [
              {
                id: "paused-owner",
                pid: process.pid,
                sessionId: "paused-owner",
                createdAt: oldTimestamp,
                updatedAt: oldTimestamp,
              },
            ],
            waiters: [],
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      await expect(
        acquireBrowserTabLease(dir, {
          maxConcurrentTabs: 1,
          pollMs: 25,
          timeoutMs: 100,
          staleMs: 60_000,
          sessionId: "must-not-over-admit",
        }),
      ).rejects.toBeInstanceOf(BrowserTabLeaseQueueTimeoutError);

      const registry = await readRegistry(dir);
      expect(registry.leases).toEqual([
        expect.objectContaining({ id: "paused-owner", sessionId: "paused-owner" }),
      ]);
      expect(registry.waiters).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("never age-prunes a malformed lease without positive owner-death evidence", async () => {
    const dir = await makeProfileDir();
    const malformedLease = {
      sessionId: "opaque-active-unknown",
      updatedAt: "2000-01-01T00:00:00.000Z",
    };
    try {
      await writeFile(
        path.join(dir, REGISTRY_FILENAME),
        `${JSON.stringify(
          {
            version: 2,
            leases: [malformedLease],
            waiters: [],
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      await expect(
        acquireBrowserTabLease(dir, {
          maxConcurrentTabs: 1,
          pollMs: 25,
          timeoutMs: 100,
          staleMs: 60_000,
          sessionId: "must-not-over-admit-opaque",
        }),
      ).rejects.toBeInstanceOf(BrowserTabLeaseQueueTimeoutError);

      const registry = await readRegistry(dir);
      expect(registry.leases).toEqual([malformedLease]);
      expect(registry.waiters).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("drops an impossible future-dated waiter instead of wedging FIFO forever", async () => {
    const dir = await makeProfileDir();
    const futureTimestamp = "2100-01-01T00:00:00.000Z";
    try {
      await writeFile(
        path.join(dir, REGISTRY_FILENAME),
        `${JSON.stringify(
          {
            version: 2,
            leases: [],
            waiters: [
              {
                id: "future-orphan",
                pid: process.pid,
                sessionId: "future-orphan",
                createdAt: futureTimestamp,
                updatedAt: futureTimestamp,
              },
            ],
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      const live = await acquireBrowserTabLease(dir, {
        maxConcurrentTabs: 1,
        timeoutMs: 500,
        sessionId: "live",
      });
      const registry = await readRegistry(dir);
      expect(registry.waiters).toEqual([]);
      expect(registry.leases.map((lease) => lease.sessionId)).toEqual(["live"]);
      await live.release();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("prunes stale and impossible-future opaque waiters because they own no browser state", async () => {
    const dir = await makeProfileDir();
    const nowMs = Date.now();
    try {
      await writeFile(
        path.join(dir, REGISTRY_FILENAME),
        `${JSON.stringify(
          {
            version: 2,
            leases: [],
            waiters: [
              {
                pid: process.pid,
                sessionId: "opaque-stale",
                updatedAt: new Date(nowMs - 3 * 60_000).toISOString(),
              },
              {
                pid: process.pid,
                sessionId: "opaque-future",
                updatedAt: new Date(nowMs + 10 * 60_000).toISOString(),
              },
            ],
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      const live = await acquireBrowserTabLease(dir, {
        maxConcurrentTabs: 1,
        timeoutMs: 500,
        sessionId: "live-after-opaque",
      });
      const registry = await readRegistry(dir);
      expect(registry.waiters).toEqual([]);
      expect(registry.leases.map((lease) => lease.sessionId)).toEqual(["live-after-opaque"]);
      await live.release();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("keeps an opaque waiter without a parseable timestamp fail-closed", async () => {
    const dir = await makeProfileDir();
    const malformedWaiter = { pid: 987_654, sessionId: "opaque-no-time" };
    try {
      await writeFile(
        path.join(dir, REGISTRY_FILENAME),
        `${JSON.stringify(
          {
            version: 2,
            leases: [],
            waiters: [malformedWaiter],
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      await expect(
        acquireBrowserTabLease(
          dir,
          {
            maxConcurrentTabs: 1,
            pollMs: 25,
            timeoutMs: 100,
            sessionId: "must-not-pass-opaque",
          },
          { isProcessAlive: () => false },
        ),
      ).rejects.toBeInstanceOf(BrowserTabLeaseQueueTimeoutError);

      const registry = await readRegistry(dir);
      expect(registry.leases).toEqual([]);
      expect(registry.waiters).toEqual([malformedWaiter]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("prunes a crashed process's persisted waiter before granting capacity", async () => {
    const dir = await makeProfileDir();
    const deadPid = 987_654;
    const timestamp = new Date().toISOString();
    try {
      await writeFile(
        path.join(dir, REGISTRY_FILENAME),
        `${JSON.stringify(
          {
            version: 2,
            leases: [],
            waiters: [
              {
                id: "crashed-waiter",
                pid: deadPid,
                sessionId: "crashed",
                createdAt: timestamp,
                updatedAt: timestamp,
              },
            ],
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      const live = await acquireBrowserTabLease(
        dir,
        { maxConcurrentTabs: 1, timeoutMs: 500, sessionId: "live" },
        { isProcessAlive: (pid) => pid !== deadPid },
      );
      const registry = await readRegistry(dir);
      expect(registry.waiters).toEqual([]);
      expect(registry.leases.map((lease) => lease.sessionId)).toEqual(["live"]);

      await live.release();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("keeps a corrupt registry fail-closed instead of creating a waiter or lease", async () => {
    const dir = await makeProfileDir();
    const corrupt = '{not-json-with-a-live-looking-pid:"pid":1';
    try {
      await writeFile(path.join(dir, REGISTRY_FILENAME), corrupt, "utf8");
      await expect(
        acquireBrowserTabLease(dir, {
          maxConcurrentTabs: 2,
          pollMs: 25,
          timeoutMs: 200,
          sessionId: "must-not-enter",
        }),
      ).rejects.toThrow(/unreadable|corrupt/iu);
      expect(await readFile(path.join(dir, REGISTRY_FILENAME), "utf8")).toBe(corrupt);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("preserves aged corrupt bytes with no extractable owner PID", async () => {
    const dir = await makeProfileDir();
    const registryFile = path.join(dir, REGISTRY_FILENAME);
    const corrupt = "%%% aged corrupt registry with no owner evidence %%%";
    try {
      await writeFile(registryFile, corrupt, "utf8");
      const old = new Date(Date.now() - 16 * 60_000);
      await utimes(registryFile, old, old);

      await expect(
        acquireBrowserTabLease(dir, {
          maxConcurrentTabs: 1,
          pollMs: 25,
          timeoutMs: 100,
          sessionId: "must-not-reset-pidless-corruption",
        }),
      ).rejects.toThrow(/unreadable|corrupt/iu);
      expect(await readFile(registryFile, "utf8")).toBe(corrupt);
      expect((await readdir(dir)).some((entry) => entry.includes(".corrupt-"))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("preserves an aged unknown future registry version without quarantining it", async () => {
    const dir = await makeProfileDir();
    const registryFile = path.join(dir, REGISTRY_FILENAME);
    const raw = `${JSON.stringify(
      {
        version: 3,
        leases: [],
        waiters: [],
        futureField: { semantics: "must-not-downgrade" },
      },
      null,
      2,
    )}\n`;
    try {
      await writeFile(registryFile, raw, "utf8");
      const old = new Date(Date.now() - 16 * 60_000);
      await utimes(registryFile, old, old);

      await expect(
        acquireBrowserTabLease(dir, {
          maxConcurrentTabs: 1,
          pollMs: 25,
          timeoutMs: 100,
          sessionId: "must-not-downgrade-v3",
        }),
      ).rejects.toThrow(/unsupported registry version 3/iu);
      expect(await readFile(registryFile, "utf8")).toBe(raw);
      expect((await readdir(dir)).some((entry) => entry.includes(".corrupt-"))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("refuses a paused acquirer whose ownerless directory was stolen before publication", async () => {
    const dir = await makeProfileDir();
    const lockDir = path.join(dir, "oracle-tab-leases.lock");
    const firstReady = deferred();
    const resumeFirst = deferred();
    const secondEntered = deferred();
    const releaseSecond = deferred();
    let firstCallbackRan = false;
    let secondPromise: Promise<string> | null = null;
    const firstPromise = withRegistryLockForTest(
      dir,
      async () => {
        firstCallbackRan = true;
        return "first-complete";
      },
      undefined,
      {
        beforeOwnerPublish: async () => {
          firstReady.resolve();
          await resumeFirst.promise;
        },
      },
    );
    const firstRejection = firstPromise.then(
      () => null,
      (error: unknown) => error,
    );

    try {
      await firstReady.promise;
      const old = new Date(Date.now() - 65_000);
      await utimes(lockDir, old, old);
      await expect(stealRegistryLockFromDeadOwnerForTest(lockDir)).resolves.toBe(true);

      secondPromise = withRegistryLockForTest(dir, async () => {
        secondEntered.resolve();
        await releaseSecond.promise;
        return "second-complete";
      });
      await secondEntered.promise;

      // Before atomic no-overwrite owner publication, the first acquirer
      // resumed by writing owner.json into the second acquirer's directory
      // and both callbacks could run under one pathname. Its hard-link
      // publication now collides and refuses before the callback.
      resumeFirst.resolve();
      expect(await firstRejection).toBeInstanceOf(TabLeaseRegistryLockOwnershipLostError);
      expect(firstCallbackRan).toBe(false);

      releaseSecond.resolve();
      await expect(secondPromise).resolves.toBe("second-complete");
    } finally {
      resumeFirst.resolve();
      releaseSecond.resolve();
      await Promise.allSettled([firstPromise, ...(secondPromise ? [secondPromise] : [])]);
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("uses the injected monotonic clock for registry-lock deadlines", async () => {
    const dir = await makeProfileDir();
    const lockDir = path.join(dir, "oracle-tab-leases.lock");
    let monotonicMs = 0;
    let callbackRan = false;
    try {
      await mkdir(lockDir, { recursive: false });
      await writeFile(
        path.join(lockDir, "owner.json"),
        `${JSON.stringify({ pid: process.pid, token: "live-peer" })}\n`,
        "utf8",
      );

      const error = await withRegistryLockForTest(
        dir,
        async () => {
          callbackRan = true;
        },
        undefined,
        {
          timeoutMs: 100,
          monotonicNow: () => (monotonicMs += 60),
        },
      ).then(
        () => null,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(TabLeaseRegistryLockWaitError);
      expect(error).toMatchObject({ reason: "timed out" });
      expect(callbackRan).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("distinguishes registry-mutex timeout from a full capacity queue", async () => {
    const dir = await makeProfileDir();
    const lockDir = path.join(dir, "oracle-tab-leases.lock");
    let monotonicMs = 0;
    try {
      await mkdir(lockDir, { recursive: false });
      await writeFile(
        path.join(lockDir, "owner.json"),
        `${JSON.stringify({ pid: process.pid, token: "live-peer" })}\n`,
        "utf8",
      );

      await expect(
        acquireBrowserTabLease(
          dir,
          {
            maxConcurrentTabs: 1,
            timeoutMs: 100,
            sessionId: "mutex-contender",
          },
          { monotonicNow: () => (monotonicMs += 60) },
        ),
      ).rejects.toMatchObject({
        name: "BrowserTabLeaseRegistryLockTimeoutError",
        details: {
          stage: "browser-registry-lock",
          subtype: "registry_mutex",
          code: "browser_lock_timeout",
          oracleErrorClass: "capacity_busy",
          retryable: true,
          runtime: { promptSubmitted: false },
        },
      } satisfies Partial<BrowserTabLeaseRegistryLockTimeoutError>);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("recovers the next acquirer after a permanent post-commit unlock failure", async () => {
    const dir = await makeProfileDir();
    const lockDir = path.join(dir, "oracle-tab-leases.lock");
    let orphan: OrphanedBrowserTabLeaseError | null = null;
    let next: Awaited<ReturnType<typeof acquireBrowserTabLease>> | null = null;
    try {
      const error = await acquireBrowserTabLease(
        dir,
        {
          maxConcurrentTabs: 2,
          timeoutMs: 500,
          sessionId: "committed-orphan",
        },
        {
          registryLockOptions: {
            platform: "win32",
            releaseRetryMs: 0,
            rmLockDir: async () => {
              throw Object.assign(new Error("persistent injected EBUSY"), { code: "EBUSY" });
            },
          },
        },
      ).then(
        () => null,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(OrphanedBrowserTabLeaseError);
      orphan = error as OrphanedBrowserTabLeaseError;
      expect(orphan.cause).toBeInstanceOf(TabLeaseRegistryPostCommitUnlockError);
      expect((orphan.cause as TabLeaseRegistryPostCommitUnlockError).cause).toBeInstanceOf(
        TabLeaseRegistryLockReleaseError,
      );

      const committed = await readRegistry(dir);
      expect(committed.leases).toEqual([
        expect.objectContaining({
          id: orphan.lease.id,
          sessionId: "committed-orphan",
        }),
      ]);
      expect(committed.waiters).toEqual([]);
      const owner = JSON.parse(await readFile(path.join(lockDir, "owner.json"), "utf8")) as {
        token: string;
      };
      const abandoned = JSON.parse(
        await readFile(path.join(lockDir, "abandoned.json"), "utf8"),
      ) as { token: string; reason: string };
      expect(abandoned).toMatchObject({
        token: owner.token,
        reason: "post-commit-unlock-failed",
      });

      // The durable orphan still occupies one capacity slot, but its mutex is
      // no longer genuinely held. The matching abandonment token lets the
      // next acquirer reclaim that lock immediately, even though the worker
      // PID that published owner.json is still alive.
      next = await acquireBrowserTabLease(dir, {
        maxConcurrentTabs: 2,
        timeoutMs: 1_000,
        sessionId: "after-orphan",
      });
      const recovered = await readRegistry(dir);
      expect(recovered.leases.map((lease) => lease.sessionId)).toEqual([
        "committed-orphan",
        "after-orphan",
      ]);
      await expect(stat(lockDir)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await next?.release();
      await orphan?.lease.release().catch(() => undefined);
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("retries a timed-out release lock wait and removes the exact live-owner lease", async () => {
    const dir = await makeProfileDir();
    let lease: Awaited<ReturnType<typeof acquireBrowserTabLease>> | null = null;
    let mkdirAttempts = 0;
    let monotonicMs = 0;
    try {
      lease = await acquireBrowserTabLease(dir, {
        maxConcurrentTabs: 1,
        timeoutMs: 500,
        sessionId: "release-retry-owner",
      });

      await releaseBrowserTabLease(dir, lease.id, undefined, {
        lockRetryAttempts: 2,
        lockRetryDelayMs: 0,
        registryLockOptions: {
          timeoutMs: 100,
          monotonicNow: () => (monotonicMs += 60),
          mkdirLockDir: async (lockDir) => {
            mkdirAttempts += 1;
            if (mkdirAttempts === 1) {
              throw Object.assign(new Error("injected first-attempt contention"), {
                code: "EEXIST",
              });
            }
            await mkdir(lockDir, { recursive: false });
          },
        },
      });

      expect(mkdirAttempts).toBe(2);
      const registry = await readRegistry(dir);
      expect(registry.leases).toEqual([]);
      expect(registry.waiters).toEqual([]);
      lease = null;
    } finally {
      await lease?.release().catch(() => undefined);
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("recovers a token-abandoned mutex after the lease removal committed", async () => {
    const dir = await makeProfileDir();
    const lockDir = path.join(dir, "oracle-tab-leases.lock");
    let lease: Awaited<ReturnType<typeof acquireBrowserTabLease>> | null = null;
    let removeAttempts = 0;
    const onRelease = vi.fn(async () => undefined);
    const onDeferredRelease = vi.fn();
    try {
      lease = await acquireBrowserTabLease(dir, {
        maxConcurrentTabs: 1,
        timeoutMs: 500,
        sessionId: "committed-release-recovery",
      });

      await releaseBrowserTabLease(dir, lease.id, undefined, {
        onRelease,
        onDeferredRelease,
        registryLockOptions: {
          platform: "win32",
          releaseRetryMs: 0,
          rmLockDir: async (target) => {
            removeAttempts += 1;
            if (removeAttempts === 1) {
              throw Object.assign(new Error("injected first unlock EBUSY"), { code: "EBUSY" });
            }
            await rm(target, { recursive: true, force: true });
          },
        },
      });

      expect(removeAttempts).toBe(2);
      expect(onRelease).toHaveBeenCalledTimes(1);
      expect(onDeferredRelease).not.toHaveBeenCalled();
      expect((await readRegistry(dir)).leases).toEqual([]);
      await expect(stat(lockDir)).rejects.toMatchObject({ code: "ENOENT" });
      lease = null;
    } finally {
      await lease?.release().catch(() => undefined);
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("recovers a committed no-op unlock without replaying onRelease", async () => {
    const dir = await makeProfileDir();
    const lockDir = path.join(dir, "oracle-tab-leases.lock");
    let lease: Awaited<ReturnType<typeof acquireBrowserTabLease>> | null = null;
    let removeAttempts = 0;
    const onRelease = vi.fn(async () => undefined);
    try {
      lease = await acquireBrowserTabLease(dir, {
        maxConcurrentTabs: 1,
        timeoutMs: 500,
        sessionId: "committed-noop-recovery",
      });
      const [identity] = (await readRegistry(dir)).leases;
      expect(identity).toBeDefined();
      await writeFile(
        path.join(dir, REGISTRY_FILENAME),
        `${JSON.stringify({ version: 2, leases: [], waiters: [] }, null, 2)}\n`,
        "utf8",
      );

      await releaseBrowserTabLease(dir, lease.id, undefined, {
        expectedIdentity: {
          id: identity!.id,
          pid: identity!.pid!,
          createdAt: identity!.createdAt!,
        },
        onRelease,
        registryLockOptions: {
          platform: "win32",
          releaseRetryMs: 0,
          rmLockDir: async (target) => {
            removeAttempts += 1;
            if (removeAttempts === 1) {
              throw Object.assign(new Error("injected no-op unlock EBUSY"), { code: "EBUSY" });
            }
            await rm(target, { recursive: true, force: true });
          },
        },
      });

      expect(removeAttempts).toBe(2);
      expect(onRelease).not.toHaveBeenCalled();
      expect((await readRegistry(dir)).leases).toEqual([]);
      await expect(stat(lockDir)).rejects.toMatchObject({ code: "ENOENT" });
      lease = null;
    } finally {
      await lease?.release().catch(() => undefined);
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("an acquired handle never removes a replacement that reuses its lease id", async () => {
    const dir = await makeProfileDir();
    let original: Awaited<ReturnType<typeof acquireBrowserTabLease>> | null = null;
    const onRelease = vi.fn(async () => undefined);
    try {
      original = await acquireBrowserTabLease(dir, {
        maxConcurrentTabs: 1,
        timeoutMs: 500,
        sessionId: "captured-identity-original",
      });
      const [originalRecord] = (await readRegistry(dir)).leases;
      expect(originalRecord).toBeDefined();
      const replacementCreatedAt = "2026-07-24T00:00:00.000Z";
      await writeFile(
        path.join(dir, REGISTRY_FILENAME),
        `${JSON.stringify(
          {
            version: 2,
            leases: [
              {
                ...originalRecord,
                sessionId: "captured-identity-replacement",
                createdAt: replacementCreatedAt,
                updatedAt: replacementCreatedAt,
              },
            ],
            waiters: [],
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      await original.release({ onRelease });
      original = null;

      expect(onRelease).not.toHaveBeenCalled();
      expect((await readRegistry(dir)).leases).toEqual([
        expect.objectContaining({
          id: originalRecord!.id,
          sessionId: "captured-identity-replacement",
          createdAt: replacementCreatedAt,
        }),
      ]);
      await releaseBrowserTabLease(dir, originalRecord!.id);
    } finally {
      await original?.release().catch(() => undefined);
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("defers committed-release unlock recovery until the abandoned mutex is cleanly reclaimed", async () => {
    vi.useFakeTimers();
    const dir = await makeProfileDir();
    const lockDir = path.join(dir, "oracle-tab-leases.lock");
    let lease: Awaited<ReturnType<typeof acquireBrowserTabLease>> | null = null;
    const onRelease = vi.fn(async () => undefined);
    const onDeferredRelease = vi.fn();
    try {
      lease = await acquireBrowserTabLease(dir, {
        maxConcurrentTabs: 1,
        timeoutMs: 500,
        sessionId: "committed-release-deferred",
      });

      const releaseError = await releaseBrowserTabLease(dir, lease.id, undefined, {
        deferredReleaseInitialDelayMs: 10,
        onRelease,
        onDeferredRelease,
        registryLockOptions: {
          platform: "win32",
          releaseRetryMs: 0,
          rmLockDir: async () => {
            throw Object.assign(new Error("persistent injected unlock EBUSY"), { code: "EBUSY" });
          },
        },
      }).then(
        () => null,
        (caught: unknown) => caught,
      );

      expect(releaseError).toBeInstanceOf(TabLeaseRegistryPostCommitUnlockError);
      expect(releaseError).toMatchObject({ committedResult: "removed" });
      expect(onRelease).toHaveBeenCalledTimes(1);
      expect(onDeferredRelease).not.toHaveBeenCalled();
      expect((await readRegistry(dir)).leases).toEqual([]);
      expect(await stat(path.join(lockDir, "abandoned.json"))).not.toBeNull();

      const completion = deferredBrowserTabLeaseReleaseCompletionForTest(dir, lease.id);
      expect(completion).not.toBeNull();
      await vi.advanceTimersByTimeAsync(10);
      await completion;

      expect(onRelease).toHaveBeenCalledTimes(1);
      expect(onDeferredRelease).toHaveBeenCalledTimes(1);
      await expect(stat(lockDir)).rejects.toMatchObject({ code: "ENOENT" });
      lease = null;
    } finally {
      vi.useRealTimers();
      await lease?.release().catch(() => undefined);
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("does not reclaim a peer mutex when committed-release unlock lost ownership", async () => {
    const dir = await makeProfileDir();
    const lockDir = path.join(dir, "oracle-tab-leases.lock");
    let lease: Awaited<ReturnType<typeof acquireBrowserTabLease>> | null = null;
    try {
      lease = await acquireBrowserTabLease(dir, {
        maxConcurrentTabs: 1,
        timeoutMs: 500,
        sessionId: "committed-release-ownership-lost",
      });

      const releaseError = await releaseBrowserTabLease(dir, lease.id, undefined, {
        deferredReleaseInitialDelayMs: 10,
        registryLockOptions: {
          platform: "win32",
          releaseRetryMs: 0,
          rmLockDir: async (target) => {
            await rm(target, { recursive: true, force: true });
            await mkdir(target, { recursive: false });
            await writeFile(
              path.join(target, "owner.json"),
              `${JSON.stringify({ pid: process.pid, token: "peer-owner-token" })}\n`,
              "utf8",
            );
            throw Object.assign(new Error("injected peer replacement"), { code: "EPERM" });
          },
        },
      }).then(
        () => null,
        (caught: unknown) => caught,
      );

      expect(releaseError).toBeInstanceOf(TabLeaseRegistryPostCommitUnlockError);
      expect(releaseError).toMatchObject({ committedResult: "removed" });
      expect(deferredBrowserTabLeaseReleaseCompletionForTest(dir, lease.id)).toBeNull();
      expect((await readRegistry(dir)).leases).toEqual([]);
      const peerOwner = JSON.parse(await readFile(path.join(lockDir, "owner.json"), "utf8")) as {
        token: string;
      };
      expect(peerOwner.token).toBe("peer-owner-token");
      lease = null;
    } finally {
      await lease?.release().catch(() => undefined);
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("deferred self-heal removes only the original lease after synchronous retries exhaust", async () => {
    vi.useFakeTimers();
    const dir = await makeProfileDir();
    let original: Awaited<ReturnType<typeof acquireBrowserTabLease>> | null = null;
    let replacement: Awaited<ReturnType<typeof acquireBrowserTabLease>> | null = null;
    let monotonicMs = 0;
    const onRelease = vi.fn(async () => undefined);
    const onDeferredRelease = vi.fn();
    try {
      original = await acquireBrowserTabLease(dir, {
        maxConcurrentTabs: 2,
        timeoutMs: 500,
        sessionId: "deferred-original",
      });

      const releaseError = await releaseBrowserTabLease(dir, original.id, undefined, {
        lockRetryAttempts: 2,
        lockRetryDelayMs: 0,
        deferredReleaseInitialDelayMs: 10,
        onRelease,
        onDeferredRelease,
        registryLockOptions: {
          timeoutMs: 100,
          monotonicNow: () => (monotonicMs += 60),
          mkdirLockDir: async () => {
            throw Object.assign(new Error("injected synchronous contention"), {
              code: "EEXIST",
            });
          },
        },
      }).then(
        () => null,
        (caught: unknown) => caught,
      );
      expect(releaseError).toBeInstanceOf(TabLeaseRegistryLockWaitError);
      const completion = deferredBrowserTabLeaseReleaseCompletionForTest(dir, original.id);
      expect(completion).not.toBeNull();

      // A later lease may be present by the time the mutex clears. The repair
      // intent is fenced by id+pid+createdAt and must remove only the original
      // record, not treat the whole live-PID registry as disposable.
      replacement = await acquireBrowserTabLease(dir, {
        maxConcurrentTabs: 2,
        timeoutMs: 500,
        sessionId: "deferred-replacement",
      });
      const originalId = original.id;
      const replacementId = replacement.id;
      const beforeHeal = await readRegistry(dir);
      const replacementCreatedAt = "2026-07-23T23:59:59.000Z";
      await writeFile(
        path.join(dir, REGISTRY_FILENAME),
        `${JSON.stringify(
          {
            version: 2,
            leases: beforeHeal.leases.map((lease) =>
              lease.id === replacementId
                ? {
                    ...lease,
                    // Deliberately reuse the old UUID to prove the deferred
                    // repair is fenced by the full stable identity, not id
                    // alone. This newer record must survive.
                    id: originalId,
                    createdAt: replacementCreatedAt,
                    updatedAt: replacementCreatedAt,
                  }
                : lease,
            ),
            waiters: beforeHeal.waiters,
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      await vi.advanceTimersByTimeAsync(10);
      await completion;

      const registry = await readRegistry(dir);
      expect(registry.leases).toEqual([
        expect.objectContaining({
          id: originalId,
          sessionId: "deferred-replacement",
          createdAt: replacementCreatedAt,
        }),
      ]);
      expect(onRelease).toHaveBeenCalledWith({ isLastLease: false });
      expect(onDeferredRelease).toHaveBeenCalledTimes(1);
      original = null;
      replacement = null;
    } finally {
      vi.useRealTimers();
      await replacement?.release().catch(() => undefined);
      await original?.release().catch(() => undefined);
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("legacy three-field release identity removes a generation-tagged lease", async () => {
    const dir = await makeProfileDir();
    let lease: Awaited<ReturnType<typeof acquireBrowserTabLease>> | null = null;
    try {
      lease = await acquireBrowserTabLease(
        dir,
        {
          maxConcurrentTabs: 1,
          timeoutMs: 500,
          sessionId: "legacy-release-identity",
        },
        {
          readProcessStartTicks: () => "generation-a",
        },
      );
      const [identity] = (await readRegistry(dir)).leases;
      expect(identity?.startTicks).toEqual(expect.any(String));

      await releaseBrowserTabLease(dir, lease.id, undefined, {
        expectedIdentity: {
          id: identity!.id,
          pid: identity!.pid!,
          createdAt: identity!.createdAt!,
        },
      });

      expect((await readRegistry(dir)).leases).toEqual([]);
      lease = null;
    } finally {
      await lease?.release().catch(() => undefined);
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("migrates v1 to v2 without dropping the existing lease", async () => {
    const dir = await makeProfileDir();
    const timestamp = "2026-07-23T10:00:00.000Z";
    const legacyLease = {
      id: "legacy-v1-lease",
      pid: process.pid,
      sessionId: "legacy-v1",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    let current: Awaited<ReturnType<typeof acquireBrowserTabLease>> | null = null;
    try {
      await writeFile(
        path.join(dir, REGISTRY_FILENAME),
        `${JSON.stringify({ version: 1, leases: [legacyLease] }, null, 2)}\n`,
        "utf8",
      );

      current = await acquireBrowserTabLease(dir, {
        maxConcurrentTabs: 2,
        timeoutMs: 500,
        sessionId: "current-v2",
      });
      const registry = await readRegistry(dir);
      expect(registry.version).toBe(2);
      expect(registry.waiters).toEqual([]);
      expect(registry.leases[0]).toEqual(legacyLease);
      expect(registry.leases[1]).toEqual(expect.objectContaining({ sessionId: "current-v2" }));

      await current.release();
      current = null;
      await releaseBrowserTabLease(dir, legacyLease.id);
    } finally {
      await current?.release().catch(() => undefined);
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("retries injected Windows EPERM and EBUSY lock-directory failures", async () => {
    const dir = await makeProfileDir();
    let attempts = 0;
    let callbackRan = false;
    try {
      await withRegistryLockForTest(
        dir,
        async () => {
          callbackRan = true;
        },
        undefined,
        {
          platform: "win32",
          timeoutMs: 1_000,
          mkdirLockDir: async (lockDir) => {
            attempts += 1;
            if (attempts <= 2) {
              throw Object.assign(new Error("injected Windows lock contention"), {
                code: attempts === 1 ? "EPERM" : "EBUSY",
              });
            }
            await mkdir(lockDir, { recursive: false });
          },
        },
      );

      expect(attempts).toBe(3);
      expect(callbackRan).toBe(true);
      await expect(stat(path.join(dir, "oracle-tab-leases.lock"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("retries Windows EPERM and EBUSY while releasing the same proved lock", async () => {
    const dir = await makeProfileDir();
    let attempts = 0;
    try {
      await withRegistryLockForTest(dir, async () => undefined, undefined, {
        platform: "win32",
        releaseRetryMs: 1_000,
        rmLockDir: async (lockDir) => {
          attempts += 1;
          if (attempts <= 2) {
            throw Object.assign(new Error("injected Windows release contention"), {
              code: attempts === 1 ? "EPERM" : "EBUSY",
            });
          }
          await rm(lockDir, { recursive: true, force: true });
        },
      });
      expect(attempts).toBe(3);
      await expect(stat(path.join(dir, "oracle-tab-leases.lock"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("surfaces a committed result when Windows lock release remains unproved", async () => {
    const dir = await makeProfileDir();
    try {
      const error = await withRegistryLockForTest(dir, async () => "callback-complete", undefined, {
        platform: "win32",
        releaseRetryMs: 0,
        rmLockDir: async () => {
          throw Object.assign(new Error("persistent injected EBUSY"), { code: "EBUSY" });
        },
      }).then(
        () => null,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(TabLeaseRegistryPostCommitUnlockError);
      expect(error).toMatchObject({ committedResult: "callback-complete" });
      expect((error as TabLeaseRegistryPostCommitUnlockError).cause).toBeInstanceOf(
        TabLeaseRegistryLockReleaseError,
      );
      expect(await stat(path.join(dir, "oracle-tab-leases.lock"))).not.toBeNull();
      expect(await stat(path.join(dir, "oracle-tab-leases.lock", "abandoned.json"))).not.toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("rechecks directory identity before a Windows release retry", async () => {
    const dir = await makeProfileDir();
    const lockDir = path.join(dir, "oracle-tab-leases.lock");
    let attempts = 0;
    try {
      const error = await withRegistryLockForTest(dir, async () => undefined, undefined, {
        platform: "win32",
        releaseRetryMs: 1_000,
        rmLockDir: async () => {
          attempts += 1;
          await rm(lockDir, { recursive: true, force: true });
          await mkdir(lockDir, { recursive: false });
          throw Object.assign(new Error("injected EPERM after peer replacement"), {
            code: "EPERM",
          });
        },
      }).then(
        () => null,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(TabLeaseRegistryPostCommitUnlockError);
      expect((error as TabLeaseRegistryPostCommitUnlockError).cause).toBeInstanceOf(
        TabLeaseRegistryLockOwnershipLostError,
      );
      expect(attempts).toBe(1);
      expect(await stat(lockDir)).not.toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

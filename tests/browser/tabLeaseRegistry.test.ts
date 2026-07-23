import { describe, expect, test, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import {
  acquireBrowserTabLease,
  hasOtherActiveBrowserTabLeases,
  listOtherActiveBrowserTabLeaseTargetIds,
  normalizeMaxConcurrentTabs,
} from "../../src/browser/tabLeaseRegistry.js";

describe("tabLeaseRegistry", () => {
  test("normalizes the concurrent tab limit", () => {
    expect(normalizeMaxConcurrentTabs(undefined)).toBe(3);
    expect(normalizeMaxConcurrentTabs("4")).toBe(4);
    expect(normalizeMaxConcurrentTabs(0)).toBe(3);
    expect(normalizeMaxConcurrentTabs("nope")).toBe(3);
  });

  test("queues when the max concurrent tab limit is reached", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-tab-leases-"));
    try {
      const logger = vi.fn();
      const first = await acquireBrowserTabLease(dir, {
        maxConcurrentTabs: 3,
        pollMs: 25,
        timeoutMs: 500,
        logger,
      });
      const second = await acquireBrowserTabLease(dir, {
        maxConcurrentTabs: 3,
        pollMs: 25,
        timeoutMs: 500,
        logger,
      });
      const third = await acquireBrowserTabLease(dir, {
        maxConcurrentTabs: 3,
        pollMs: 25,
        timeoutMs: 500,
        logger,
      });
      let resolved = false;
      const fourthPromise = acquireBrowserTabLease(dir, {
        maxConcurrentTabs: 3,
        pollMs: 25,
        timeoutMs: 1000,
        logger,
      }).then((lease) => {
        resolved = true;
        return lease;
      });

      await new Promise((resolve) => setTimeout(resolve, 75));
      expect(resolved).toBe(false);
      expect(logger).toHaveBeenCalledWith(
        expect.stringContaining("Waiting for ChatGPT browser slot"),
      );

      await first.release();
      const fourth = await fourthPromise;
      expect(resolved).toBe(true);

      await second.release();
      await third.release();
      await fourth.release();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("aborts promptly while queued for a browser slot without writing a lease", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-tab-leases-"));
    try {
      const first = await acquireBrowserTabLease(dir, {
        maxConcurrentTabs: 1,
        timeoutMs: 500,
        sessionId: "slot-owner",
      });
      const controller = new AbortController();
      const queued = acquireBrowserTabLease(dir, {
        maxConcurrentTabs: 1,
        pollMs: 5_000,
        timeoutMs: 60_000,
        sessionId: "aborted-waiter",
        signal: controller.signal,
      });

      controller.abort();
      await expect(queued).rejects.toThrow(/acquisition aborted by caller/u);

      const registry = JSON.parse(
        await readFile(path.join(dir, "oracle-tab-leases.json"), "utf8"),
      ) as { leases: Array<{ sessionId?: string }> };
      expect(registry.leases.map((lease) => lease.sessionId)).toEqual(["slot-owner"]);
      await first.release();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("drops stale leases owned by dead pids", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-tab-leases-"));
    try {
      const stale = await acquireBrowserTabLease(
        dir,
        { maxConcurrentTabs: 1, timeoutMs: 500, sessionId: "stale-session" },
        { pid: 123_456, isProcessAlive: () => true },
      );
      await stale.update({ chromeTargetId: "target-stale" });

      const fresh = await acquireBrowserTabLease(
        dir,
        { maxConcurrentTabs: 1, timeoutMs: 500, sessionId: "fresh-session" },
        { isProcessAlive: (pid) => pid !== 123_456 },
      );
      await fresh.update({ chromeTargetId: "target-fresh", tabUrl: "https://chatgpt.com/c/1" });

      const registry = JSON.parse(
        await readFile(path.join(dir, "oracle-tab-leases.json"), "utf8"),
      ) as { leases: Array<{ sessionId?: string; chromeTargetId?: string; tabUrl?: string }> };
      expect(registry.leases).toHaveLength(1);
      expect(registry.leases[0]).toMatchObject({
        sessionId: "fresh-session",
        chromeTargetId: "target-fresh",
        tabUrl: "https://chatgpt.com/c/1",
      });

      await fresh.release();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("detects other active leases before releasing a shared Chrome owner", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-tab-leases-"));
    try {
      const first = await acquireBrowserTabLease(dir, {
        maxConcurrentTabs: 3,
        timeoutMs: 500,
        sessionId: "first-session",
      });
      const second = await acquireBrowserTabLease(dir, {
        maxConcurrentTabs: 3,
        timeoutMs: 500,
        sessionId: "second-session",
      });

      expect(await hasOtherActiveBrowserTabLeases(dir, first.id)).toBe(true);

      await second.release();
      expect(await hasOtherActiveBrowserTabLeases(dir, first.id)).toBe(false);

      await first.release();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("lists other active leases' recorded chrome targets for the blank-tab sweep", async () => {
    // Regression: the exit-time blank-tab sweep previously only excluded the
    // caller's own target IDs, so a concurrent lane's freshly-opened
    // about:blank tab could be closed as an orphan. The sweep now unions
    // OTHER active leases' recorded chromeTargetIds into its exclude set.
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-tab-leases-"));
    try {
      const first = await acquireBrowserTabLease(dir, {
        maxConcurrentTabs: 3,
        timeoutMs: 500,
        sessionId: "sweeper",
      });
      const second = await acquireBrowserTabLease(dir, {
        maxConcurrentTabs: 3,
        timeoutMs: 500,
        sessionId: "concurrent-lane",
      });

      // Lease registered but chromeTargetId not recorded yet (mid-startup):
      // the occupant is unattributed, so a sweep must stand down.
      const beforeRecord = await listOtherActiveBrowserTabLeaseTargetIds(dir, first.id);
      expect(beforeRecord).toEqual({ readable: true, targetIds: [], unattributedCount: 1 });

      await second.update({ chromeTargetId: "target-lane-b" });
      await first.update({ chromeTargetId: "target-lane-a" });

      // Once recorded, the OTHER lane's target is listed (and the caller's
      // own target is not).
      const afterRecord = await listOtherActiveBrowserTabLeaseTargetIds(dir, first.id);
      expect(afterRecord).toEqual({
        readable: true,
        targetIds: ["target-lane-b"],
        unattributedCount: 0,
      });

      await second.release();
      const afterRelease = await listOtherActiveBrowserTabLeaseTargetIds(dir, first.id);
      expect(afterRelease).toEqual({ readable: true, targetIds: [], unattributedCount: 0 });

      await first.release();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("prunes dead-pid leases from the other-target snapshot", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-tab-leases-"));
    try {
      const dead = await acquireBrowserTabLease(
        dir,
        { maxConcurrentTabs: 3, timeoutMs: 500, sessionId: "dead-lane" },
        { pid: 123_456, isProcessAlive: () => true },
      );
      await dead.update({ chromeTargetId: "target-dead" });

      const live = await acquireBrowserTabLease(
        dir,
        { maxConcurrentTabs: 3, timeoutMs: 500, sessionId: "live-lane" },
        { isProcessAlive: (pid) => pid !== 123_456 },
      );

      const snapshot = await listOtherActiveBrowserTabLeaseTargetIds(dir, live.id, {
        isProcessAlive: (pid) => pid !== 123_456,
      });
      expect(snapshot).toEqual({ readable: true, targetIds: [], unattributedCount: 0 });

      await live.release();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("reports the other-target snapshot unreadable on a corrupt registry (fail closed)", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-tab-leases-"));
    try {
      await writeFile(path.join(dir, "oracle-tab-leases.json"), "{not json at all###", "utf8");
      const snapshot = await listOtherActiveBrowserTabLeaseTargetIds(dir, "any-lease-id");
      expect(snapshot).toEqual({ readable: false, targetIds: [], unattributedCount: 0 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("reclaims a preserved lease after its exact owned target is manually closed", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-tab-leases-"));
    const logger = vi.fn();
    try {
      const preserved = await acquireBrowserTabLease(dir, {
        maxConcurrentTabs: 1,
        timeoutMs: 500,
        sessionId: "preserved-challenge",
        chromeHost: "127.0.0.1",
        chromePort: 9222,
      });
      await preserved.update({
        chromeHost: "127.0.0.1",
        chromePort: 9222,
        chromeTargetId: "manually-closed-target",
      });

      const listChromeTargetIds = vi.fn(async () => {
        // The DevTools/network observation must never run while the registry
        // lock is held. A lock-held implementation would fail this premise.
        const lock = await stat(path.join(dir, "oracle-tab-leases.lock")).catch(() => null);
        expect(lock).toBeNull();
        return [] as string[];
      });
      const replacement = await acquireBrowserTabLease(
        dir,
        {
          maxConcurrentTabs: 1,
          timeoutMs: 500,
          sessionId: "replacement-run",
          chromeHost: "127.0.0.1",
          chromePort: 9222,
          logger,
        },
        { listChromeTargetIds },
      );

      expect(listChromeTargetIds).toHaveBeenCalledOnce();
      expect(logger).toHaveBeenCalledWith(
        expect.stringMatching(/Reclaimed ChatGPT browser slot .*manually closed/u),
      );
      const registry = JSON.parse(
        await readFile(path.join(dir, "oracle-tab-leases.json"), "utf8"),
      ) as { leases: Array<{ id: string; sessionId?: string }> };
      expect(registry.leases).toEqual([
        expect.objectContaining({ id: replacement.id, sessionId: "replacement-run" }),
      ]);

      await replacement.release();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("does not reclaim a target-backed lease when the target still exists", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-tab-leases-"));
    try {
      const preserved = await acquireBrowserTabLease(dir, {
        maxConcurrentTabs: 1,
        timeoutMs: 500,
        sessionId: "preserved-live-target",
        chromeHost: "127.0.0.1",
        chromePort: 9222,
      });
      await preserved.update({ chromeTargetId: "still-live-target" });

      await expect(
        acquireBrowserTabLease(
          dir,
          {
            maxConcurrentTabs: 1,
            pollMs: 25,
            timeoutMs: 150,
            chromeHost: "127.0.0.1",
            chromePort: 9222,
          },
          { listChromeTargetIds: async () => ["still-live-target"] },
        ),
      ).rejects.toThrow(/Timed out waiting for ChatGPT browser slot/u);

      await preserved.release();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("compare-and-remove retains a lease that changes during the target probe", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-tab-leases-"));
    try {
      const preserved = await acquireBrowserTabLease(dir, {
        maxConcurrentTabs: 1,
        timeoutMs: 500,
        sessionId: "concurrently-updated",
        chromeHost: "127.0.0.1",
        chromePort: 9222,
      });
      await preserved.update({ chromeTargetId: "snapshot-target" });

      await expect(
        acquireBrowserTabLease(
          dir,
          {
            maxConcurrentTabs: 1,
            pollMs: 25,
            timeoutMs: 150,
            chromeHost: "127.0.0.1",
            chromePort: 9222,
          },
          {
            listChromeTargetIds: async () => {
              // This update can complete only because the DevTools probe runs
              // outside the registry lock. It also changes the CAS identity,
              // so the subsequent locked phase must retain the lease.
              await preserved.update({ chromeTargetId: "replacement-target" });
              return [];
            },
          },
        ),
      ).rejects.toThrow(/Timed out waiting for ChatGPT browser slot/u);

      const registry = JSON.parse(
        await readFile(path.join(dir, "oracle-tab-leases.json"), "utf8"),
      ) as { leases: Array<{ chromeTargetId?: string }> };
      expect(registry.leases).toEqual([
        expect.objectContaining({ chromeTargetId: "replacement-target" }),
      ]);
      await preserved.release();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("runs cleanup exactly once when concurrent runs release their final lease", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-tab-leases-"));
    try {
      const first = await acquireBrowserTabLease(dir, {
        maxConcurrentTabs: 3,
        timeoutMs: 500,
      });
      const second = await acquireBrowserTabLease(dir, {
        maxConcurrentTabs: 3,
        timeoutMs: 500,
      });
      const firstCleanup = vi.fn(async () => undefined);
      const secondCleanup = vi.fn(async () => undefined);

      await Promise.all([
        first.release({
          onRelease: async ({ isLastLease }) => {
            if (isLastLease) await firstCleanup();
          },
        }),
        second.release({
          onRelease: async ({ isLastLease }) => {
            if (isLastLease) await secondCleanup();
          },
        }),
      ]);

      expect(firstCleanup.mock.calls.length + secondCleanup.mock.calls.length).toBe(1);
      const registry = JSON.parse(
        await readFile(path.join(dir, "oracle-tab-leases.json"), "utf8"),
      ) as { leases: unknown[] };
      expect(registry.leases).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("blocks a new lease until final-lease cleanup completes", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-tab-leases-"));
    try {
      const current = await acquireBrowserTabLease(dir, {
        maxConcurrentTabs: 3,
        timeoutMs: 500,
      });
      let finishCleanup!: () => void;
      const cleanupStarted = new Promise<void>((resolveStarted) => {
        void current.release({
          onRelease: async ({ isLastLease }) => {
            expect(isLastLease).toBe(true);
            resolveStarted();
            await new Promise<void>((resolveCleanup) => {
              finishCleanup = resolveCleanup;
            });
          },
        });
      });
      await cleanupStarted;

      let acquired = false;
      const nextPromise = acquireBrowserTabLease(dir, {
        maxConcurrentTabs: 3,
        pollMs: 25,
        timeoutMs: 1000,
      }).then((lease) => {
        acquired = true;
        return lease;
      });
      await new Promise((resolve) => setTimeout(resolve, 75));
      expect(acquired).toBe(false);

      finishCleanup();
      const next = await nextPromise;
      expect(acquired).toBe(true);
      await next.release();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

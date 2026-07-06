import { describe, expect, test, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
});

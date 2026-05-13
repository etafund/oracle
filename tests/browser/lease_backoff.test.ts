import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { browserLeaseBackoffDelayMs } from "../../src/browser/lease_backoff.js";
import {
  createBrowserLease,
  type BrowserLeaseMutationLockPollEvent,
  type BrowserLeaseStoreOptions,
} from "../../src/browser/leases.js";

const PROFILE_ID_HASH = `sha256:${"f".repeat(64)}`;
const FIXED_NOW = "2026-01-01T00:00:00.000Z";

describe("browser lease mutation lock backoff", () => {
  test("computes bounded exponential delays with jitter", () => {
    const noJitter = Array.from({ length: 8 }, (_, attempt) =>
      browserLeaseBackoffDelayMs({
        attempt,
        baseDelayMs: 10,
        maxDelayMs: 500,
        remainingMs: 5_000,
        jitterRatio: 0,
        random: () => 0.5,
      }),
    );

    expect(noJitter).toEqual([10, 20, 40, 80, 160, 320, 500, 500]);
    expect(
      browserLeaseBackoffDelayMs({
        attempt: 3,
        baseDelayMs: 10,
        maxDelayMs: 500,
        remainingMs: 5_000,
        jitterRatio: 0.5,
        random: () => 0,
      }),
    ).toBe(40);
    expect(
      browserLeaseBackoffDelayMs({
        attempt: 3,
        baseDelayMs: 10,
        maxDelayMs: 500,
        remainingMs: 5_000,
        jitterRatio: 0.5,
        random: () => 1,
      }),
    ).toBe(120);
  });

  test("50 contenders against a held mutation lock back off instead of herding", async () => {
    await withLeaseDir(async (leaseDir) => {
      await createHeldMutationLock(leaseDir, "chatgpt", process.pid);

      const contenders = Array.from({ length: 50 }, (_, index) => {
        const delays: number[] = [];
        const events: BrowserLeaseMutationLockPollEvent[] = [];
        let nowMs = 0;
        const options: BrowserLeaseStoreOptions = {
          leaseDir,
          now: () => new Date(FIXED_NOW),
          uuid: () => `contender-${index}`,
          pid: 20_000 + index,
          mutationLockTimeoutMs: 5_000,
          mutationLockPollMs: 10,
          mutationLockBackoffMaxMs: 500,
          mutationLockJitterRatio: 0.5,
          mutationLockRandom: () => index / 49,
          mutationLockNowMs: () => nowMs,
          mutationLockSleep: async (milliseconds) => {
            delays.push(milliseconds);
            nowMs += milliseconds;
          },
          mutationLockPollObserver: (event) => events.push(event),
        };
        return { index, delays, events, promise: contendForLease(options) };
      });

      const outcomes = await Promise.all(contenders.map((contender) => contender.promise));

      expect(outcomes.every((outcome) => outcome instanceof Error)).toBe(true);
      const pollCounts = contenders.map((contender) => contender.events.length);
      const totalPolls = pollCounts.reduce((sum, count) => sum + count, 0);
      const firstDelays = contenders.map((contender) => contender.delays[0]);

      expect(Math.max(...pollCounts)).toBeLessThanOrEqual(25);
      expect(totalPolls).toBeLessThan(2_500);
      expect(new Set(firstDelays).size).toBeGreaterThan(5);
      for (const contender of contenders) {
        expect(Math.max(...contender.delays)).toBeLessThanOrEqual(500);
      }
    });
  });

  test("dead-pid mutation locks are still recovered", async () => {
    await withLeaseDir(async (leaseDir) => {
      await createHeldMutationLock(leaseDir, "gemini", 2_147_483_647);
      let nowMs = 0;
      let pollCount = 0;

      const lease = await createBrowserLease(
        {
          provider: "gemini",
          profileIdHash: PROFILE_ID_HASH,
          holder: "stale-lock-recovery",
        },
        {
          leaseDir,
          now: () => new Date(FIXED_NOW),
          uuid: () => "stale-lock-recovered",
          mutationLockTimeoutMs: 1_000,
          mutationLockPollMs: 10,
          mutationLockJitterRatio: 0,
          mutationLockNowMs: () => nowMs,
          mutationLockSleep: async (milliseconds) => {
            nowMs += milliseconds;
          },
          mutationLockPollObserver: () => {
            pollCount += 1;
          },
        },
      );

      expect(lease.lease_id).toBe("stale-lock-recovered");
      expect(pollCount).toBe(1);
    });
  });
});

async function contendForLease(options: BrowserLeaseStoreOptions): Promise<unknown> {
  try {
    return await createBrowserLease(
      {
        provider: "chatgpt",
        profileIdHash: PROFILE_ID_HASH,
      },
      options,
    );
  } catch (error) {
    return error;
  }
}

async function withLeaseDir<T>(fn: (leaseDir: string) => Promise<T>): Promise<T> {
  const leaseDir = await mkdtemp(path.join(os.tmpdir(), "oracle-browser-lease-backoff-"));
  try {
    return await fn(leaseDir);
  } finally {
    await rm(leaseDir, { recursive: true, force: true });
  }
}

async function createHeldMutationLock(
  leaseDir: string,
  provider: "chatgpt" | "gemini",
  pid: number,
): Promise<void> {
  const lockPath = path.join(leaseDir, `.${provider}.mutation.lock`);
  await mkdir(lockPath, { recursive: true, mode: 0o700 });
  await writeFile(
    path.join(lockPath, "owner.json"),
    `${JSON.stringify({ created_at: FIXED_NOW, pid, provider }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
}

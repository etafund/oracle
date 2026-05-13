import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { expectGoldenJson } from "../../_helpers/goldenSnapshots.js";
import {
  BrowserLeaseStateError,
  browserLeasePath,
  createBrowserLease,
  readBrowserLease,
  releaseBrowserLease,
  renewBrowserLease,
} from "../../../src/browser/leases.js";
import { sha256OfBytes } from "../../../src/oracle/v18/evidence.js";

const PROFILE_HASH = sha256OfBytes("unit-profile");

async function withLeaseDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-unit-leases-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("browser lease lifecycle unit conformance", () => {
  test("acquire, renew, release, and reacquire preserve recovery metadata", async () => {
    await withLeaseDir(async (leaseDir) => {
      let nowMs = Date.parse("2026-01-01T00:00:00.000Z");
      const now = () => new Date(nowMs);
      const store = { leaseDir, now, isProcessAlive: () => true };

      const acquired = await createBrowserLease(
        {
          provider: "chatgpt",
          profileIdHash: PROFILE_HASH,
          ttlSeconds: 60,
          holder: "unit-pane",
          commandSummary: "oracle --engine browser",
        },
        { ...store, pid: 5101, uuid: () => "lease-lifecycle-1" },
      );
      expect(acquired.safe_recovery_command).toBe(
        "oracle browser leases recover --provider chatgpt --lease-id lease-lifecycle-1",
      );

      nowMs = Date.parse("2026-01-01T00:00:10.000Z");
      const renewed = await renewBrowserLease(
        {
          provider: "chatgpt",
          profileIdHash: PROFILE_HASH,
          leaseId: "lease-lifecycle-1",
          ttlSeconds: 120,
        },
        store,
      );
      expect(renewed.expires_at).toBe("2026-01-01T00:02:10.000Z");

      nowMs = Date.parse("2026-01-01T00:00:20.000Z");
      const released = await releaseBrowserLease(
        { provider: "chatgpt", profileIdHash: PROFILE_HASH, leaseId: "lease-lifecycle-1" },
        store,
      );
      expectGoldenJson(
        {
          acquired_at: released.acquired_at,
          expires_at: released.expires_at,
          lease_id: released.lease_id,
          released_at: released.released_at,
          renewable: released.renewable,
          safe_recovery_command: released.safe_recovery_command,
          status: released.status,
          updated_at: released.updated_at,
        },
        `
        {
          "acquired_at": "2026-01-01T00:00:00.000Z",
          "expires_at": "2026-01-01T00:02:10.000Z",
          "lease_id": "lease-lifecycle-1",
          "released_at": "2026-01-01T00:00:20.000Z",
          "renewable": false,
          "safe_recovery_command": "oracle browser leases recover --provider chatgpt --lease-id lease-lifecycle-1",
          "status": "released",
          "updated_at": "2026-01-01T00:00:20.000Z"
        }
        `,
      );

      const readReleased = await readBrowserLease("chatgpt", {
        ...store,
        expectedProfileIdHash: PROFILE_HASH,
      });
      expect(readReleased.state).toBe("released");

      const reacquired = await createBrowserLease(
        { provider: "chatgpt", profileIdHash: PROFILE_HASH, ttlSeconds: 60 },
        { ...store, uuid: () => "lease-lifecycle-2" },
      );
      expect(reacquired.lease_id).toBe("lease-lifecycle-2");
    });
  });

  test("stale locks are recoverable but never silently overwritten", async () => {
    await withLeaseDir(async (leaseDir) => {
      const deadPid = 5201;
      const store = {
        leaseDir,
        now: () => new Date("2026-01-01T00:00:00.000Z"),
        isProcessAlive: (pid: number) => pid !== deadPid,
      };
      await createBrowserLease(
        { provider: "gemini", profileIdHash: PROFILE_HASH, ttlSeconds: 300 },
        { ...store, pid: deadPid, uuid: () => "lease-stale-1" },
      );

      const stale = await readBrowserLease("gemini", {
        ...store,
        expectedProfileIdHash: PROFILE_HASH,
      });
      expect(stale.state).toBe("stale");
      if (stale.state === "stale") {
        expect(stale.recoveryCommand).toContain("lease-stale-1");
      }
      await expect(
        createBrowserLease(
          { provider: "gemini", profileIdHash: PROFILE_HASH },
          { ...store, uuid: () => "lease-should-not-overwrite" },
        ),
      ).rejects.toBeInstanceOf(BrowserLeaseStateError);

      await releaseBrowserLease(
        { provider: "gemini", profileIdHash: PROFILE_HASH, leaseId: "lease-stale-1" },
        store,
      );
      const recovered = await createBrowserLease(
        { provider: "gemini", profileIdHash: PROFILE_HASH },
        { ...store, uuid: () => "lease-after-stale-recover" },
      );
      expect(recovered.lease_id).toBe("lease-after-stale-recover");
    });
  });

  test("corrupt locks and bad profile hashes surface deterministic recovery failures", async () => {
    await withLeaseDir(async (leaseDir) => {
      await mkdir(leaseDir, { recursive: true });
      await writeFile(browserLeasePath("chatgpt", { leaseDir }), "{not-json", "utf8");

      const corrupt = await readBrowserLease("chatgpt", { leaseDir });
      expect(corrupt.state).toBe("corrupt");
      if (corrupt.state === "corrupt") {
        expect(corrupt.recoveryCommand).toBe("oracle browser leases recover --provider chatgpt");
        expect(corrupt.error).toMatch(/json/i);
      }
      await expect(
        createBrowserLease(
          { provider: "chatgpt", profileIdHash: PROFILE_HASH },
          { leaseDir, uuid: () => "lease-after-corrupt" },
        ),
      ).rejects.toBeInstanceOf(BrowserLeaseStateError);
    });

    await expect(
      createBrowserLease({ provider: "chatgpt", profileIdHash: "not-a-hash" }, {}),
    ).rejects.toThrow(/profile_id_hash/);
  });
});

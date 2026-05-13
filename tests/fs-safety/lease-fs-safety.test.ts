import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";

import {
  BrowserLeaseStateError,
  browserLeasePath,
  createBrowserLease,
  readBrowserLease,
} from "@src/browser/leases.ts";
import {
  browserLeaseLockName,
  type BrowserLeaseProvider,
} from "@src/oracle/v18/browser_lease.ts";

import {
  REPRESENTATIVE_HOME_PATHS,
  isPathUnderRoot,
  isSafePortableFilename,
  makeLongButPortableDir,
  pathParts,
  representativeJoin,
  withFsSafetyTempDir,
} from "../_helpers/fsCrossPlatform.js";

const PROFILE_A = `sha256:${"a".repeat(64)}`;
const PROFILE_B = `sha256:${"b".repeat(64)}`;
const PROVIDERS: readonly BrowserLeaseProvider[] = ["chatgpt", "gemini"];

describe("browser lease filesystem safety conformance", () => {
  test.each(REPRESENTATIVE_HOME_PATHS)(
    "lease paths remain provider-scoped under representative $name roots",
    (entry) => {
      const leaseDir = representativeJoin(entry, "Browser Leases With Spaces");

      for (const provider of PROVIDERS) {
        const lockName = browserLeaseLockName(provider);
        const lockPath = browserLeasePath(provider, { leaseDir });

        expect(isSafePortableFilename(lockName)).toBe(true);
        expect(lockName).toBe(`${provider}.shared-browser-profile`);
        expect(path.basename(lockPath)).toBe(`${provider}.json`);
        expect(pathParts(lockPath).slice(-1)).toEqual([`${provider}.json`]);
        expect(pathParts(lockPath)).not.toContain("..");
      }
    },
  );

  test("rejects provider names that could escape the lease directory", () => {
    for (const provider of ["chatgpt/evil", "gemini\\evil", "..", "firefox"]) {
      expect(() =>
        browserLeasePath(provider as BrowserLeaseProvider, {
          leaseDir: "/tmp/oracle leases",
        }),
      ).toThrow(/Unsupported browser lease provider/);
    }
  });

  test("creates lease files under long portable directories without leaving temp artifacts", async () => {
    await withFsSafetyTempDir("oracle-lease-fs-", async ({ root }) => {
      const leaseDir = await makeLongButPortableDir(root, "Browser Leases With Spaces");
      const now = new Date("2026-05-12T12:00:00.000Z");

      const record = await createBrowserLease(
        {
          provider: "chatgpt",
          profileIdHash: PROFILE_A,
          ttlSeconds: 180,
          holder: "pane 7",
          commandSummary: "oracle --engine browser --remote-host host.local:9473",
          localPid: 12_345,
          remoteSessionId: "remote session with spaces",
          remoteBrowser: {
            provider: "chatgpt",
            windows_profile_path: String.raw`C:\Users\Ada Lovelace\AppData\Local\Google\Chrome\User Data`,
            wsl_profile_path: "/mnt/c/Users/Ada Lovelace/AppData/Local/Google/Chrome/User Data",
            profile_id_hash: PROFILE_A,
          },
        },
        {
          leaseDir,
          now: () => now,
          pid: 12_345,
          uuid: () => "lease-chatgpt-fs",
          isProcessAlive: () => true,
        },
      );

      const lockPath = browserLeasePath("chatgpt", { leaseDir });
      expect(isPathUnderRoot(leaseDir, lockPath)).toBe(true);
      expect(pathParts(lockPath).slice(-1)).toEqual(["chatgpt.json"]);
      expect(record.safe_recovery_command).toBe(
        "oracle browser leases recover --provider chatgpt --lease-id lease-chatgpt-fs",
      );

      const entries = await readdir(leaseDir);
      expect(entries).toContain("chatgpt.json");
      expect(entries.filter((name) => name.includes(".tmp"))).toEqual([]);

      const raw = await readFile(lockPath, "utf8");
      expect(raw.endsWith("\n")).toBe(true);
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      expect(parsed.lock_name).toBe(browserLeaseLockName("chatgpt"));
      expect(parsed.local_pid).toBe(12_345);
      expect(parsed.remote_session_id).toBe("remote session with spaces");
      expect(parsed.remote_browser).toMatchObject({
        windows_profile_path: String.raw`C:\Users\Ada Lovelace\AppData\Local\Google\Chrome\User Data`,
        wsl_profile_path: "/mnt/c/Users/Ada Lovelace/AppData/Local/Google/Chrome/User Data",
      });

      const active = await readBrowserLease("chatgpt", {
        leaseDir,
        expectedProfileIdHash: PROFILE_A,
        now: () => now,
        isProcessAlive: () => true,
      });
      expect(active.state).toBe("active");
      if (active.state === "active") {
        expect(active.record.lease_id).toBe("lease-chatgpt-fs");
        expect(active.profileMatches).toBe(true);
      }
    });
  });

  test("stale local-pid leases are reported without mutating the lock file", async () => {
    await withFsSafetyTempDir("oracle-lease-stale-", async ({ leaseDir }) => {
      await createBrowserLease(
        {
          provider: "gemini",
          profileIdHash: PROFILE_A,
          ttlSeconds: 300,
          holder: "pane 7",
        },
        {
          leaseDir,
          now: () => new Date("2026-05-12T13:00:00.000Z"),
          pid: 999_999,
          uuid: () => "lease-gemini-stale",
          isProcessAlive: () => true,
        },
      );

      const lockPath = browserLeasePath("gemini", { leaseDir });
      const before = await readFile(lockPath, "utf8");
      const stale = await readBrowserLease("gemini", {
        leaseDir,
        expectedProfileIdHash: PROFILE_A,
        now: () => new Date("2026-05-12T13:01:00.000Z"),
        isProcessAlive: () => false,
      });

      expect(stale.state).toBe("stale");
      if (stale.state === "stale") {
        expect(stale.recoveryCommand).toBe(
          "oracle browser leases recover --provider gemini --lease-id lease-gemini-stale",
        );
      }

      await expect(
        createBrowserLease(
          {
            provider: "gemini",
            profileIdHash: PROFILE_B,
            ttlSeconds: 300,
            holder: "pane 7",
          },
          {
            leaseDir,
            now: () => new Date("2026-05-12T13:01:00.000Z"),
            uuid: () => "lease-gemini-new",
            isProcessAlive: () => false,
          },
        ),
      ).rejects.toBeInstanceOf(BrowserLeaseStateError);

      expect(await readFile(lockPath, "utf8")).toBe(before);
    });
  });
});

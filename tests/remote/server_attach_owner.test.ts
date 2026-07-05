import { describe, expect, test } from "vitest";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { probeAttachTarget } from "../../src/remote/server.js";

// oracle-router-t38: in attach-only topology nothing writes chrome.pid for
// the operator-launched Chrome a worker attaches to, so `checkAttachTargetOwner`
// used to always resolve "unknown" (null) and could never actually fire the
// split-brain discriminator. It now falls back to a live process-table
// lookup (`findRunningChromeDebugTargetForProfile`) keyed on the profile's
// --user-data-dir, injected here instead of shelling out to `ps` so the test
// is deterministic.

const OK_REACHABLE = async () => ({ ok: true as const });

describe("probeAttachTarget owner-identity fallback (attach-only, no chrome.pid)", () => {
  let profileDir: string;

  async function withProfileDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-attach-owner-"));
    try {
      return await fn(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  test("a matching running Chrome process for this profile establishes ownerOk=true (not null)", async () => {
    await withProfileDir(async (dir) => {
      profileDir = dir;
      const probe = await probeAttachTarget({
        profileDir,
        fixedPort: 54321,
        probe: OK_REACHABLE,
        findRunningTarget: async (userDataDir) => {
          expect(userDataDir).toBe(profileDir);
          return { pid: process.pid, port: 54321 };
        },
      });
      expect(probe.ok).toBe(true);
      expect(probe.ownerOk).toBe(true);
    });
  });

  test("a running Chrome process for this profile on a DIFFERENT port is a definitive owner mismatch (ownerOk=false, not null)", async () => {
    await withProfileDir(async (dir) => {
      const probe = await probeAttachTarget({
        profileDir: dir,
        fixedPort: 54321,
        probe: OK_REACHABLE,
        findRunningTarget: async () => ({ pid: process.pid, port: 11111 }),
      });
      expect(probe.ok).toBe(false);
      expect(probe.reason).toBe("attach-target-owner-mismatch");
      expect(probe.ownerOk).toBe(false);
    });
  });

  test("no chrome.pid and no matching process resolves ownerOk=null (unverified) and still does not block the attach path", async () => {
    await withProfileDir(async (dir) => {
      const probe = await probeAttachTarget({
        profileDir: dir,
        fixedPort: 54321,
        probe: OK_REACHABLE,
        findRunningTarget: async () => null,
      });
      // Unverified must remain distinct from confirmed: it is not "false"
      // (rejected) and must not be conflated with "true" (verified) either —
      // callers key gating on `ownerOk === false` specifically.
      expect(probe.ok).toBe(true);
      expect(probe.ownerOk).toBeNull();
    });
  });
});

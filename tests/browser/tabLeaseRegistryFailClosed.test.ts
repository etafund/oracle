/**
 * RED-TEST HARNESS (expected-failure): tab-lease registry fail-closed semantics.
 *
 * These tests encode the *desired* fault-isolation contract for the shared
 * ChatGPT tab-lease registry (src/browser/tabLeaseRegistry.ts). They are known
 * to FAIL against current behavior and are landed with `test.fails` so the
 * default `vitest run` signal stays green. The registry-hardening change that
 * fixes each property must flip the corresponding case from `test.fails` to a
 * required `test` (or run the file with ORACLE_RED_ASSERT=1, which turns every
 * red case into a hard assertion).
 *
 * Expected-failure mechanics:
 *   - default:                `redTest` === `test.fails` -> a failing body is
 *     reported as passing; an unexpectedly PASSING body turns the suite red,
 *     so these cases cannot silently rot into no-ops.
 *   - ORACLE_RED_ASSERT=1:    `redTest` === `test` -> assertions are enforced,
 *     reproducing the recorded red run below.
 *
 * Contract under test (fail-closed / fault isolation):
 *   R1. An unreadable, partial, torn, or corrupt oracle-tab-leases.json must
 *       be treated as ASSUME-ACTIVE (cannot prove a free slot -> do not grant;
 *       cannot prove "no other leases" -> report other leases active).
 *       Today readRegistry() maps every read/parse error to an EMPTY registry,
 *       so capacity checks and peer-lease checks fail OPEN.
 *   R2. Registry writes must be atomic (temp file + rename) so readers can
 *       never observe a torn write. Today writeRegistry() writes the final
 *       path directly with writeFile().
 *   R3. The registry lock must never be stolen from a LIVE owner. Today
 *       withRegistryLock() force-removes the lock directory after a flat 10s
 *       timeout without consulting any owner identity or liveness.
 *   R4. releaseBrowserTabLease() must not report success when the lease was
 *       not actually removed. Today all lock/write errors are swallowed
 *       (`.catch(() => undefined)`) and the success log is emitted anyway.
 *   R5. Both call sites that gate destructive cleanup on
 *       hasOtherActiveBrowserTabLeases() must fail CLOSED. Today the blank-tab
 *       cleanup gate fails closed (`.catch(() => true)`) but the Chrome
 *       TERMINATION gate in src/browser/index.ts and the one in
 *       src/browser/projectSourcesRunner.ts fail OPEN (`.catch(() => false)`),
 *       i.e. a registry fault can kill a Chrome that other runs still use.
 *
 * Red run recorded 2026-07-03 against HEAD 3e38abb7
 * (`ORACLE_RED_ASSERT=1 pnpm vitest run tests/browser/tabLeaseRegistryFailClosed.test.ts`):
 *   16 red cases failed as expected (see assertions below); the 3 baseline
 *   cases passed. Representative failures:
 *     - "[red] R1 ... corrupt registry" -> promise resolved (lease granted)
 *       instead of rejecting: capacity check treated corrupt file as empty.
 *     - "[red] R1 ... hasOtherActiveBrowserTabLeases ... torn registry"
 *       -> expected true, received false (live peer lease made invisible).
 *     - "[red] R3 live-owner lock steal" -> lock stolen ~10s in; lease granted
 *       while the owner process was still alive (expected stolen=false).
 *     - "[red] R4 release reports success" -> resolved instead of rejecting.
 *     - "[red] R5 termination gate" -> `.catch(() => false)` present.
 */
import { describe, expect, test, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import {
  acquireBrowserTabLease,
  hasOtherActiveBrowserTabLeases,
  releaseBrowserTabLease,
} from "../../src/browser/tabLeaseRegistry.js";

const RED_MODE = process.env.ORACLE_RED_ASSERT === "1";
/** Expected-failure gate: red assertions stay out of the default CI signal. */
const redTest = RED_MODE ? test : test.fails;

const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
const REGISTRY_FILENAME = "oracle-tab-leases.json";
const LOCK_DIRNAME = "oracle-tab-leases.lock";
const SRC_ROOT = fileURLToPath(new URL("../../src", import.meta.url));

async function makeProfileDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "oracle-lease-failclosed-"));
}

function registryFile(dir: string): string {
  return path.join(dir, REGISTRY_FILENAME);
}

function validRegistry(leases: Array<Record<string, unknown>>): string {
  return `${JSON.stringify({ version: 1, leases }, null, 2)}\n`;
}

function liveLease(id: string, pid: number): Record<string, unknown> {
  const now = new Date().toISOString();
  return { id, pid, createdAt: now, updatedAt: now };
}

/** Acquire with a short timeout: fail-closed behavior must NOT grant a slot. */
async function acquireExpectingNoFreeSlot(dir: string): Promise<void> {
  const lease = await acquireBrowserTabLease(dir, {
    maxConcurrentTabs: 1,
    pollMs: 50,
    timeoutMs: 300,
  });
  // If we get here the registry fault was treated as "no active leases".
  await lease.release().catch(() => undefined);
  throw new Error("lease granted despite unverifiable registry (fail-open)");
}

async function readSource(relative: string): Promise<string> {
  return readFile(path.join(SRC_ROOT, relative), "utf8");
}

function normalize(source: string): string {
  return source.replace(/\s+/gu, "");
}

function slice(source: string, startAnchor: string, endAnchor: string): string {
  const start = source.indexOf(startAnchor);
  const end = source.indexOf(endAnchor, start + startAnchor.length);
  if (start === -1 || end === -1) {
    throw new Error(`source anchors not found: ${startAnchor} .. ${endAnchor}`);
  }
  return source.slice(start, end);
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("tab-lease registry: fail-closed fault isolation (red harness)", () => {
  // ---------------------------------------------------------------------
  // Baselines (green today, green after hardening): prove the harness setup
  // itself is sound so the red cases below cannot fail for bogus reasons.
  // ---------------------------------------------------------------------
  test("baseline: a READABLE registry at capacity blocks acquisition", async () => {
    const dir = await makeProfileDir();
    try {
      await writeFile(registryFile(dir), validRegistry([liveLease("peer", process.pid)]), "utf8");
      await expect(
        acquireBrowserTabLease(dir, { maxConcurrentTabs: 1, pollMs: 50, timeoutMs: 300 }),
      ).rejects.toThrow(/Timed out waiting for ChatGPT browser slot/u);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("baseline: a READABLE registry with a live peer reports other leases", async () => {
    const dir = await makeProfileDir();
    try {
      await writeFile(registryFile(dir), validRegistry([liveLease("peer", process.pid)]), "utf8");
      await expect(hasOtherActiveBrowserTabLeases(dir, "someone-else")).resolves.toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("baseline: blank-tab cleanup gate fails closed today (call-site contrast)", async () => {
    // src/browser/index.ts guards blank-tab cleanup with `.catch(() => true)`
    // (assume other leases on registry faults). The red R5 cases below demand
    // the same fail-closed default at the Chrome-termination gates.
    const source = normalize(await readSource("browser/index.ts"));
    expect(source).toContain("hasOtherActiveLeases().catch(()=>true)");
  });

  // ---------------------------------------------------------------------
  // R1: unreadable/partial/corrupt registry must be ASSUME-ACTIVE, not empty.
  // Today: readRegistry() catches every error and returns { leases: [] },
  // so a slot is granted instantly. Fail-closed must refuse/queue instead.
  // ---------------------------------------------------------------------
  redTest("[red] R1a acquire must not treat a CORRUPT registry as empty", async () => {
    const dir = await makeProfileDir();
    try {
      await writeFile(registryFile(dir), "{not json at all###", "utf8");
      await expect(acquireExpectingNoFreeSlot(dir)).rejects.toThrow(
        /Timed out|unreadable|corrupt/iu,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  redTest("[red] R1b acquire must not treat a ZERO-BYTE registry as empty", async () => {
    const dir = await makeProfileDir();
    try {
      await writeFile(registryFile(dir), "", "utf8");
      await expect(acquireExpectingNoFreeSlot(dir)).rejects.toThrow(
        /Timed out|unreadable|corrupt/iu,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  redTest("[red] R1c acquire must not treat a JSON-null registry as empty", async () => {
    const dir = await makeProfileDir();
    try {
      await writeFile(registryFile(dir), "null\n", "utf8");
      await expect(acquireExpectingNoFreeSlot(dir)).rejects.toThrow(
        /Timed out|unreadable|corrupt/iu,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  redTest("[red] R1d acquire must not treat a WRONG-SHAPE registry as empty", async () => {
    const dir = await makeProfileDir();
    try {
      await writeFile(registryFile(dir), JSON.stringify({ version: 1, leases: 42 }), "utf8");
      await expect(acquireExpectingNoFreeSlot(dir)).rejects.toThrow(
        /Timed out|unreadable|corrupt/iu,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  redTest("[red] R1e acquire must not treat a TORN (truncated) registry as empty", async () => {
    const dir = await makeProfileDir();
    try {
      // Simulate the observable artifact of the non-atomic writeRegistry():
      // a reader catches the file mid-write and sees a truncated document.
      const full = validRegistry([liveLease("peer", process.pid)]);
      await writeFile(registryFile(dir), full.slice(0, Math.floor(full.length * 0.6)), "utf8");
      await expect(acquireExpectingNoFreeSlot(dir)).rejects.toThrow(
        /Timed out|unreadable|corrupt|torn/iu,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  redTest("[red] R1f acquire must not silently DROP malformed lease records", async () => {
    const dir = await makeProfileDir();
    try {
      // One record with a string pid: isLeaseRecord() filters it out today,
      // making an occupied slot invisible. Unknown records must count as
      // occupied (assume-active), not vanish.
      const now = new Date().toISOString();
      await writeFile(
        registryFile(dir),
        validRegistry([{ id: "peer", pid: String(process.pid), createdAt: now, updatedAt: now }]),
        "utf8",
      );
      await expect(acquireExpectingNoFreeSlot(dir)).rejects.toThrow(
        /Timed out|unreadable|corrupt|malformed/iu,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  redTest(
    "[red] R1g hasOtherActiveBrowserTabLeases must ASSUME-ACTIVE on a corrupt registry",
    async () => {
      const dir = await makeProfileDir();
      try {
        await writeFile(registryFile(dir), "%%% definitely not json %%%", "utf8");
        // Fail-closed: cannot prove "no other leases" -> must report true.
        await expect(hasOtherActiveBrowserTabLeases(dir, "my-lease")).resolves.toBe(true);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );

  redTest(
    "[red] R1h a live PEER PROCESS lease hidden by a torn registry must still count (multi-process)",
    async () => {
      const dir = await makeProfileDir();
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], {
        stdio: "ignore",
      });
      try {
        if (!child.pid) throw new Error("premise failure: could not spawn peer process");
        // A real, live peer process holds a lease; the registry file is then
        // torn mid-write. Today the torn read parses to empty and the peer
        // becomes invisible -> destructive cleanup would proceed.
        const full = validRegistry([liveLease("peer-child", child.pid)]);
        await writeFile(registryFile(dir), full.slice(0, Math.floor(full.length * 0.7)), "utf8");
        await expect(hasOtherActiveBrowserTabLeases(dir, "my-lease")).resolves.toBe(true);
      } finally {
        child.kill();
        await rm(dir, { recursive: true, force: true });
      }
    },
  );

  (isRoot ? test.skip : redTest)(
    "[red] R1i an UNREADABLE (permission-denied) registry must ASSUME-ACTIVE",
    async () => {
      const dir = await makeProfileDir();
      try {
        await writeFile(registryFile(dir), validRegistry([liveLease("peer", process.pid)]), "utf8");
        await chmod(registryFile(dir), 0o000);
        await expect(hasOtherActiveBrowserTabLeases(dir, "my-lease")).resolves.toBe(true);
      } finally {
        await chmod(registryFile(dir), 0o644).catch(() => undefined);
        await rm(dir, { recursive: true, force: true });
      }
    },
  );

  // ---------------------------------------------------------------------
  // R2: writes must be atomic so torn reads cannot exist in the first place.
  // ---------------------------------------------------------------------
  redTest("[red] R2 writeRegistry must publish atomically (temp file + rename)", async () => {
    const source = await readSource("browser/tabLeaseRegistry.ts");
    const writeSlice = slice(source, "async function writeRegistry", "function registryPath");
    // Fail-closed persistence: write a temp file then rename() into place.
    // Today the final path is written directly with writeFile().
    expect(writeSlice).toMatch(/rename/u);
  });

  // ---------------------------------------------------------------------
  // R3: the registry lock must never be stolen from a live owner.
  // ---------------------------------------------------------------------
  redTest("[red] R3a lock-timeout path must consult owner liveness before stealing", async () => {
    const source = await readSource("browser/tabLeaseRegistry.ts");
    const lockSlice = slice(source, "async function withRegistryLock", "async function readRegistry");
    // The steal path must identify the lock owner (recorded metadata) and
    // verify it is dead before removing the lock. Today it is an
    // unconditional rm() after a flat timeout.
    expect(normalize(lockSlice)).toMatch(/isProcessAlive|owner/iu);
  });

  redTest(
    "[red] R3b the lock must NOT be stolen while its owner process is alive (multi-process)",
    async () => {
      const dir = await makeProfileDir();
      const lockDir = path.join(dir, LOCK_DIRNAME);
      // A real, live process represents the lock owner mid-critical-section.
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], {
        stdio: "ignore",
      });
      let stolenLeaseRelease: (() => Promise<void>) | null = null;
      try {
        if (!child.pid) throw new Error("premise failure: could not spawn lock-owner process");
        await mkdir(lockDir, { recursive: false });
        // Owner metadata a fail-closed implementation can consult. Today's
        // implementation records no owner and ignores this entirely.
        await writeFile(
          path.join(lockDir, "owner.json"),
          `${JSON.stringify({ pid: child.pid, createdAt: new Date().toISOString() })}\n`,
          "utf8",
        );

        const acquirePromise = acquireBrowserTabLease(dir, {
          maxConcurrentTabs: 1,
          pollMs: 100,
          timeoutMs: 0,
        });
        acquirePromise.catch(() => undefined);

        // Today: withRegistryLock() rm's the lock at ~10s and the lease is
        // granted. Fail-closed: with a live owner it must keep waiting (or
        // surface a diagnostic error) well past the steal deadline.
        const outcome = await Promise.race([
          acquirePromise.then((lease) => ({ stolen: true as const, lease })),
          wait(15_000).then(() => ({ stolen: false as const, lease: null })),
        ]);
        if (outcome.lease) {
          stolenLeaseRelease = outcome.lease.release;
        }
        // Premise check: the owner must still be alive when we judge a steal.
        try {
          process.kill(child.pid, 0);
        } catch {
          throw new Error("premise failure: lock-owner process died during the test");
        }
        expect(outcome.stolen).toBe(false);
      } finally {
        child.kill();
        if (stolenLeaseRelease) await stolenLeaseRelease().catch(() => undefined);
        await rm(dir, { recursive: true, force: true });
      }
    },
    30_000,
  );

  // ---------------------------------------------------------------------
  // R4: release must not report success when the lease was not removed.
  // ---------------------------------------------------------------------
  redTest("[red] R4a release must surface failure when the profile dir is not a dir", async () => {
    const dir = await makeProfileDir();
    const bogusProfile = path.join(dir, "not-a-directory");
    try {
      await writeFile(bogusProfile, "plain file where a profile dir was expected", "utf8");
      // Locking/writing under a file fails (ENOTDIR); today the error is
      // swallowed and the success log is emitted anyway.
      await expect(releaseBrowserTabLease(bogusProfile, "some-lease")).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  redTest(
    "[red] R4b release must surface failure when the lease record could not be removed",
    async () => {
      const dir = await makeProfileDir();
      const logger = vi.fn();
      try {
        await writeFile(registryFile(dir), validRegistry([liveLease("stuck", process.pid)]), "utf8");
        await chmod(dir, 0o555); // registry (and lock dir) can no longer be written
        await expect(releaseBrowserTabLease(dir, "stuck", logger)).rejects.toThrow();
        // Truthfulness: no success log for a release that did not happen.
        expect(logger).not.toHaveBeenCalledWith(expect.stringContaining("Released"));
      } finally {
        await chmod(dir, 0o755).catch(() => undefined);
        await rm(dir, { recursive: true, force: true });
      }
    },
  );

  // ---------------------------------------------------------------------
  // R5: hasOtherActiveBrowserTabLeases call sites gating DESTRUCTIVE cleanup
  // must fail closed, matching the blank-tab gate (see baseline above).
  // ---------------------------------------------------------------------
  redTest(
    "[red] R5a Chrome-termination gate in browser/index.ts must fail CLOSED on registry faults",
    async () => {
      const source = normalize(await readSource("browser/index.ts"));
      // `.catch(() => false)` at the termination gate means a registry fault
      // reads as "no other leases" and a shared Chrome gets killed.
      expect(source).not.toMatch(/hasOtherActiveLeases\(\)\.catch\(\(\)=>false,?\)/u);
    },
  );

  redTest(
    "[red] R5b Chrome-termination gate in projectSourcesRunner.ts must fail CLOSED on registry faults",
    async () => {
      const source = normalize(await readSource("browser/projectSourcesRunner.ts"));
      expect(source).not.toMatch(
        /hasOtherActiveBrowserTabLeases\(userDataDir,tabLease\.id\)\.catch\(\(\)=>false,?\)/u,
      );
    },
  );
});

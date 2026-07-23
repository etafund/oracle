import { describe, expect, test } from "vitest";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { probeAttachTarget } from "../../src/remote/server.js";

// Attach-only topology may not have a persisted owner record, so the server
// asks the shared ownership verifier to discover and generation-bind the
// Chrome process for this exact profile and fixed port.

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

  test.skipIf(process.platform !== "linux")(
    "a matching running Chrome process for this profile establishes ownerOk=true (not null)",
    async () => {
      await withProfileDir(async (dir) => {
        profileDir = dir;
        const chromeScript = path.join(dir, "google-chrome");
        await writeFile(chromeScript, "setInterval(() => {}, 1_000);\n", "utf8");
        const chrome = spawn(
          process.execPath,
          [chromeScript, "--remote-debugging-port=54321", `--user-data-dir=${profileDir}`],
          { stdio: "ignore" },
        );
        try {
          await once(chrome, "spawn");
          const probe = await probeAttachTarget({
            profileDir,
            fixedPort: 54321,
            probe: OK_REACHABLE,
            findRunningTarget: async (userDataDir) => {
              expect(userDataDir).toBe(profileDir);
              return { pid: chrome.pid!, port: 54321 };
            },
          });
          expect(probe.ok).toBe(true);
          expect(probe.ownerOk).toBe(true);
        } finally {
          chrome.kill("SIGTERM");
          await once(chrome, "exit").catch(() => undefined);
        }
      });
    },
  );

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

  test("no owner record and no matching process fails closed", async () => {
    await withProfileDir(async (dir) => {
      const probe = await probeAttachTarget({
        profileDir: dir,
        fixedPort: 54321,
        probe: OK_REACHABLE,
        findRunningTarget: async () => null,
      });
      expect(probe.ok).toBe(false);
      expect(probe.reason).toBe("attach-target-owner-mismatch");
      expect(probe.ownerOk).toBe(false);
    });
  });
});

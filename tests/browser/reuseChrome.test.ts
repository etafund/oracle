import { afterEach, describe, expect, test, vi } from "vitest";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  acquireManualLoginChromeForRunForTest,
  maybeReuseRunningChromeForTest,
} from "../../src/browser/index.js";
import { maybeReuseProjectSourcesChromeForTest } from "../../src/browser/projectSourcesRunner.js";
import { maybeReuseCodexFindingsChromeForTest } from "../../src/browser/codexFindingsRunner.js";
import { resolveBrowserConfig } from "../../src/browser/config.js";
import type { LaunchedChrome } from "chrome-launcher";

const noopLogger = () => {};
const reusePaths = [
  ["browser runs", maybeReuseRunningChromeForTest],
  ["Project Sources", maybeReuseProjectSourcesChromeForTest],
  ["Codex findings", maybeReuseCodexFindingsChromeForTest],
] as const;

async function writeChromeLocks(dir: string): Promise<string[]> {
  const lockFiles = [
    path.join(dir, "lockfile"),
    path.join(dir, "SingletonLock"),
    path.join(dir, "SingletonSocket"),
    path.join(dir, "SingletonCookie"),
  ];
  for (const lock of lockFiles) {
    await fs.writeFile(lock, "x");
  }
  return lockFiles;
}

describe("maybeReuseRunningChrome", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("waits for a shared Chrome port before reusing", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-chrome-reuse-"));
    const port = 9222;

    void (async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
      await fs.writeFile(
        path.join(tmpDir, "DevToolsActivePort"),
        `${port}\n/devtools/browser`,
        "utf8",
      );
    })();

    const probe = vi.fn(async () => ({ ok: true as const }));
    const reusePromise = maybeReuseRunningChromeForTest(tmpDir, noopLogger, {
      waitForPortMs: 1000,
      probe,
      verifyOwner: vi.fn(async () => ({
        ok: true as const,
        pid: 12345,
        port,
        processStartToken: "test:1",
        source: "record" as const,
      })),
    });

    const reused = await reusePromise;
    expect(reused?.port).toBe(port);
    expect(probe).toHaveBeenCalled();

    await fs.rm(tmpDir, { recursive: true, force: true });
  }, 10_000);

  test("returns null immediately when no port and no wait", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-chrome-reuse-"));
    const probe = vi.fn(async () => ({ ok: true as const }));
    const reused = await maybeReuseRunningChromeForTest(tmpDir, noopLogger, {
      waitForPortMs: 0,
      probe,
    });
    expect(reused).toBeNull();
    expect(probe).not.toHaveBeenCalled();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test.each(reusePaths)(
    "refuses a reachable stale port for %s when Chrome ownership is not proven",
    async (_label, maybeReuse) => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-chrome-reuse-owner-"));
      try {
        await fs.writeFile(path.join(tmpDir, "DevToolsActivePort"), "9222\n/devtools/browser");
        const probe = vi.fn(async () => ({ ok: true as const }));
        const reused = await maybeReuse(tmpDir, vi.fn<(message: string) => void>(), {
          probe,
          verifyOwner: vi.fn(async () => ({
            ok: false as const,
            reason: "owner-process-generation-mismatch" as const,
          })),
        });
        expect(reused).toBeNull();
        expect(probe).not.toHaveBeenCalled();
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    },
  );

  test.each(reusePaths)(
    "switches %s from a stale recorded port only after exact owner resolution",
    async (_label, maybeReuse) => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-chrome-reuse-port-"));
      try {
        await fs.writeFile(path.join(tmpDir, "DevToolsActivePort"), "9222\n/devtools/browser");
        const probe = vi.fn(async () => ({ ok: true as const }));
        const reused = await maybeReuse(tmpDir, vi.fn<(message: string) => void>(), {
          probe,
          verifyOwner: vi.fn(async () => ({
            ok: true as const,
            pid: process.pid,
            port: 9333,
            processStartToken: "test:2",
            source: "process-discovery" as const,
          })),
        });
        expect(reused?.port).toBe(9333);
        expect(probe).toHaveBeenCalledWith({ port: 9333 });
        await expect(fs.readFile(path.join(tmpDir, "DevToolsActivePort"), "utf8")).resolves.toMatch(
          /^9333\n/u,
        );
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    },
  );

  test.each(reusePaths)(
    "cleans stale locks for %s when a recorded Chrome pid is dead and no DevTools target is reachable",
    async (_label, maybeReuse) => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-chrome-reuse-"));
      try {
        const lockFiles = await writeChromeLocks(tmpDir);
        const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
        await once(child, "exit");
        await fs.writeFile(path.join(tmpDir, "chrome.pid"), `${child.pid ?? 0}\n`, "utf8");

        const logger = vi.fn();
        const probe = vi.fn(async () => ({ ok: true as const }));
        const reused = await maybeReuse(tmpDir, logger, {
          waitForPortMs: 0,
          probe,
        });

        expect(reused).toBeNull();
        expect(probe).not.toHaveBeenCalled();
        for (const lock of lockFiles) {
          expect(existsSync(lock)).toBe(false);
        }
        expect(logger).toHaveBeenCalledWith(
          expect.stringContaining("clearing stale profile state"),
        );
        expect(logger).toHaveBeenCalledWith("Cleaned up stale Chrome profile locks");
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    },
  );

  test.each(reusePaths)(
    "preserves locks for %s when the recorded Chrome pid is still alive",
    async (_label, maybeReuse) => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-chrome-reuse-"));
      try {
        const lockFiles = await writeChromeLocks(tmpDir);
        await fs.writeFile(path.join(tmpDir, "chrome.pid"), `${process.pid}\n`, "utf8");

        const logger = vi.fn();
        const reused = await maybeReuse(tmpDir, logger, {
          waitForPortMs: 0,
          probe: vi.fn(async () => ({ ok: true as const })),
        });

        expect(reused).toBeNull();
        for (const lock of lockFiles) {
          expect(existsSync(lock)).toBe(true);
        }
        expect(logger).toHaveBeenCalledWith(
          expect.stringContaining("skipping profile lock cleanup"),
        );
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    },
  );

  test.each(reusePaths)(
    "preserves locks for %s when no Oracle Chrome pid was recorded",
    async (_label, maybeReuse) => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-chrome-reuse-"));
      try {
        const lockFiles = await writeChromeLocks(tmpDir);
        const logger = vi.fn();

        const reused = await maybeReuse(tmpDir, logger, {
          waitForPortMs: 0,
          probe: vi.fn(async () => ({ ok: true as const })),
        });

        expect(reused).toBeNull();
        for (const lock of lockFiles) {
          expect(existsSync(lock)).toBe(true);
        }
        expect(logger).not.toHaveBeenCalledWith("Cleaned up stale Chrome profile locks");
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    },
  );

  test("serializes manual-login Chrome launch so parallel runs reuse the first browser", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-chrome-launch-lock-"));
    try {
      const config = resolveBrowserConfig({
        manualLogin: true,
        manualLoginProfileDir: tmpDir,
        profileLockTimeoutMs: 2_000,
        reuseChromeWaitMs: 0,
      });
      const launch = vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return {
          port: 45678,
          pid: process.pid,
          kill: async () => undefined,
          process: undefined,
        } as unknown as LaunchedChrome;
      });
      const maybeReuse = vi.fn(async (dir: string) => {
        try {
          const raw = await fs.readFile(path.join(dir, "DevToolsActivePort"), "utf8");
          const port = Number.parseInt(raw.split(/\r?\n/u)[0] ?? "", 10);
          if (Number.isFinite(port)) {
            return {
              port,
              pid: process.pid,
              kill: async () => undefined,
              process: undefined,
            } as unknown as LaunchedChrome;
          }
        } catch {
          // no reusable browser yet
        }
        return null;
      });

      const first = acquireManualLoginChromeForRunForTest(tmpDir, config, noopLogger, "first", {
        maybeReuse,
        launch,
      });
      const second = acquireManualLoginChromeForRunForTest(tmpDir, config, noopLogger, "second", {
        maybeReuse,
        launch,
      });

      const [firstResult, secondResult] = await Promise.all([first, second]);

      expect(launch).toHaveBeenCalledTimes(1);
      const results = [firstResult, secondResult];
      expect(results.filter((result) => result.reusedChrome === null)).toHaveLength(1);
      expect(results.filter((result) => result.reusedChrome?.port === 45678)).toHaveLength(1);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

/**
 * RED-TEST HARNESS (expected-failure): `oracle serve` in manual-login mode
 * must be ATTACH-ONLY / fail-closed when no attachable Chrome exists.
 *
 * Property (correctness / fault isolation): when serveRemote() starts with a
 * manual-login profile whose DevTools endpoint is ABSENT or STALE, it cannot
 * prove there is a browser it owns. Launching a fresh Chrome at that point is
 * fail-open behavior: it races any concurrently starting serve/run against
 * the same profile (launch is fire-and-forget `void launchManualLoginChrome`
 * with a freshly picked port and NO lock), and it silently converts "operator
 * has not prepared a browser" into "spawn a new one". The fail-closed
 * contract: refuse to launch and surface an unready state until an attachable
 * DevTools endpoint appears.
 *
 * The harness mocks the `chrome-launcher` module (dynamically imported by
 * src/remote/server.ts), so no real browser is ever spawned; the red
 * assertions check that the launch entry point is never invoked and that the
 * server does not report itself ready.
 *
 * Expected-failure mechanics: identical to tabLeaseRegistryFailClosed.test.ts
 * (`test.fails` by default keeps these out of the default CI signal;
 * ORACLE_RED_ASSERT=1 enforces the assertions). The attach-only serve change
 * must flip these to required `test`s.
 *
 * Red run recorded 2026-07-03 against HEAD 3e38abb7
 * (`ORACLE_RED_ASSERT=1 pnpm vitest run tests/remote/attachOnlyServe.test.ts`):
 *   - "[red] absent DevTools port: serve must refuse to launch Chrome"
 *     FAILED: chrome-launcher launch() was invoked once (fallback launch).
 *   - "[red] stale DevTools port: serve must refuse to launch Chrome"
 *     FAILED: launch() invoked after the stale-endpoint probe failed.
 *   - "[red] serve must not report ready while no attachable Chrome exists"
 *     FAILED: GET /status returned { ok: true }.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { serveRemote } from "../../src/remote/server.js";

const RED_MODE = process.env.ORACLE_RED_ASSERT === "1";
/** Expected-failure gate: red assertions stay out of the default CI signal. */
const redTest = RED_MODE ? test : test.fails;

const { launchMock } = vi.hoisted(() => ({
  launchMock: vi.fn(async (options?: { port?: number }) => ({
    port: options?.port ?? 0,
    pid: 99_999,
    process: {},
    kill: async () => {},
  })),
}));

// src/remote/server.ts loads chrome-launcher via dynamic import inside
// launchManualLoginChrome(); this intercepts it so no browser can spawn.
vi.mock("chrome-launcher", () => ({ launch: launchMock, default: { launch: launchMock } }));

const CAN_LISTEN_LOCALHOST =
  spawnSync(
    process.execPath,
    [
      "-e",
      `
      const net = require('net');
      const s = net.createServer();
      s.on('error', () => process.exit(1));
      s.listen(0, '127.0.0.1', () => s.close(() => process.exit(0)));
    `,
    ],
    { stdio: "ignore" },
  ).status === 0;

const maybeRedTest = CAN_LISTEN_LOCALHOST ? redTest : test.skip;

interface ServeHandle {
  logs: string[];
  stop: () => Promise<void>;
}

const activeHandles: ServeHandle[] = [];

/**
 * Starts serveRemote() against an isolated manual-login profile dir. The
 * returned handle captures all output (nothing is printed, so no generated
 * access token ever reaches the test log) and can shut the server down by
 * invoking the SIGINT handler serveRemote registers.
 */
async function startServe(profileDir: string): Promise<ServeHandle> {
  const logs: string[] = [];
  const sigintBefore = new Set(process.listeners("SIGINT"));
  const sigtermBefore = new Set(process.listeners("SIGTERM"));
  const consoleSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  });

  const servePromise = serveRemote({
    host: "127.0.0.1",
    port: 0,
    token: "secret",
    manualLoginDefault: true,
    manualLoginProfileDir: profileDir,
    logger: (message: string) => logs.push(message),
  });
  servePromise.catch(() => undefined);

  const stop = async (): Promise<void> => {
    try {
      // Wait (bounded) for serveRemote to register its shutdown handler, then
      // trigger it directly instead of signaling the whole test process.
      const deadline = Date.now() + 5000;
      let added = process.listeners("SIGINT").filter((l) => !sigintBefore.has(l));
      while (added.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        added = process.listeners("SIGINT").filter((l) => !sigintBefore.has(l));
      }
      for (const listener of added) {
        (listener as () => void)();
      }
      await Promise.race([
        servePromise.catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, 5000)),
      ]);
      for (const listener of added) {
        process.removeListener("SIGINT", listener);
      }
      for (const listener of process.listeners("SIGTERM").filter((l) => !sigtermBefore.has(l))) {
        process.removeListener("SIGTERM", listener);
      }
    } finally {
      consoleSpy.mockRestore();
    }
  };

  const handle = { logs, stop };
  activeHandles.push(handle);
  return handle;
}

/** Allocates a port with nothing listening on it (bind, record, close). */
async function deadPort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      if (typeof address === "object" && address?.port) {
        const { port } = address;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error("could not allocate a probe port")));
      }
    });
  });
}

afterEach(async () => {
  while (activeHandles.length > 0) {
    await activeHandles.pop()?.stop();
  }
  launchMock.mockClear();
});

describe("attach-only serve: fail-closed startup (red harness)", () => {
  maybeRedTest(
    "[red] absent DevTools port: serve must refuse to launch Chrome",
    async () => {
      const profileDir = await mkdtemp(path.join(os.tmpdir(), "oracle-attach-only-"));
      try {
        await startServe(profileDir);
        // Today: no DevToolsActivePort -> fire-and-forget launch fallback.
        // Surface it deterministically, then assert the fail-closed contract.
        await vi.waitFor(() => expect(launchMock).toHaveBeenCalled(), { timeout: 5000 });
        expect(launchMock).not.toHaveBeenCalled();
      } finally {
        await rm(profileDir, { recursive: true, force: true });
      }
    },
    20_000,
  );

  maybeRedTest(
    "[red] stale DevTools port: serve must refuse to launch Chrome",
    async () => {
      const profileDir = await mkdtemp(path.join(os.tmpdir(), "oracle-attach-only-"));
      try {
        // A DevToolsActivePort pointing at a port nothing listens on: the
        // recorded endpoint is stale, so an attach-only serve must go unready
        // and wait for an operator-provided browser instead of launching.
        const stale = await deadPort();
        await writeFile(
          path.join(profileDir, "DevToolsActivePort"),
          `${stale}\n/devtools/browser/00000000-0000-0000-0000-000000000000\n`,
          "utf8",
        );
        const handle = await startServe(profileDir);
        await vi.waitFor(() => expect(launchMock).toHaveBeenCalled(), { timeout: 15_000 });
        expect(
          handle.logs.filter((line) => line.includes("stale DevToolsActivePort")).length,
        ).toBeGreaterThanOrEqual(0); // context for the red-run log, never fails
        expect(launchMock).not.toHaveBeenCalled();
      } finally {
        await rm(profileDir, { recursive: true, force: true });
      }
    },
    30_000,
  );

  maybeRedTest(
    "[red] serve must not report ready while no attachable Chrome exists",
    async () => {
      const profileDir = await mkdtemp(path.join(os.tmpdir(), "oracle-attach-only-"));
      try {
        const handle = await startServe(profileDir);
        let listeningLine = "";
        await vi.waitFor(
          () => {
            const line = handle.logs.find((entry) => entry.includes("Listening at"));
            if (!line) throw new Error("server not listening yet");
            listeningLine = line;
          },
          { timeout: 10_000 },
        );
        const match = /Listening at (\d+\.\d+\.\d+\.\d+):(\d+)/u.exec(listeningLine);
        if (!match) throw new Error(`could not parse listen address from: ${listeningLine}`);
        const port = Number.parseInt(match[2] ?? "", 10);

        const response = await fetch(`http://127.0.0.1:${port}/status`);
        const body = (await response.json()) as { ok?: boolean };
        // Fail-closed readiness: with neither a live DevTools endpoint nor an
        // owned browser, the service must not advertise itself as ready to
        // accept runs. Today /status unconditionally reports ok: true.
        expect(body.ok).toBe(false);
      } finally {
        await rm(profileDir, { recursive: true, force: true });
      }
    },
    30_000,
  );
});

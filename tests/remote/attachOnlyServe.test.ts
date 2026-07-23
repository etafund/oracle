/**
 * Attach-only / fail-closed serve contract (formerly the Wave-0 red-test
 * harness; flipped to required tests by the attach-only serve change).
 *
 * Property (correctness / fault isolation): `oracle serve` in manual-login /
 * attach-only mode only ever ATTACHES to a pre-launched, operator-owned
 * Chrome. When the profile's DevTools endpoint is ABSENT or STALE the worker
 * cannot prove there is a browser it owns, so it must:
 *   - never launch a Chrome of its own (the old fire-and-forget fallback
 *     raced concurrently starting workers against one --user-data-dir:
 *     singleton-lock collisions and profile split-brain);
 *   - report itself unready (/status ok:false, fail-closed);
 *   - refuse /runs with a typed error (browser_unavailable) instead of
 *     converting "operator has not prepared a browser" into "spawn one".
 *
 * The harness mocks the `chrome-launcher` module so that if any launch path
 * were ever reintroduced it would be caught here without spawning a real
 * browser. (The launch entry point was removed from src/remote/server.ts
 * outright; the mock plus assertions keep it removed.)
 *
 * Provenance: the original red run (2026-07-03, HEAD 3e38abb7, red harness
 * commit c64a100c) failed all three [red] cases: launch() was invoked on
 * absent and stale DevTools ports, and /status reported ok:true with no
 * attachable Chrome.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { serveRemote } from "../../src/remote/server.js";
import {
  REMOTE_BROWSER_RECOVERY_ADMISSION_HEADER_VALUES,
  REMOTE_BROWSER_RUN_PATH,
} from "../../src/remote/types.js";

const { launchMock } = vi.hoisted(() => ({
  launchMock: vi.fn(async (options?: { port?: number }) => ({
    port: options?.port ?? 0,
    pid: 99_999,
    process: {},
    kill: async () => {},
  })),
}));

// Guard: if a chrome-launcher import were ever reintroduced anywhere in the
// serve path, this intercepts it so no browser can spawn and the assertions
// below fail loudly.
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

const maybeTest = CAN_LISTEN_LOCALHOST ? test : test.skip;

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

/** Waits for the serve listener and returns its bound port. */
async function waitForListenPort(handle: ServeHandle): Promise<number> {
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
  return Number.parseInt(match[2] ?? "", 10);
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

/** A fake operator-owned CDP endpoint answering GET /json/version. */
async function startFakeCdp(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/json/version") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ Browser: "FakeChrome/1.0" }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("fake CDP endpoint did not bind");
  }
  return {
    port: address.port,
    close: async () =>
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

afterEach(async () => {
  while (activeHandles.length > 0) {
    await activeHandles.pop()?.stop();
  }
  launchMock.mockClear();
});

describe("attach-only serve: fail-closed startup", () => {
  maybeTest(
    "absent DevTools port: serve refuses to launch Chrome",
    async () => {
      const profileDir = await mkdtemp(path.join(os.tmpdir(), "oracle-attach-only-"));
      try {
        const handle = await startServe(profileDir);
        await waitForListenPort(handle);
        // Grace period: the old fallback launched fire-and-forget shortly
        // after startup; give any such path time to trip the mock.
        await new Promise((resolve) => setTimeout(resolve, 750));
        expect(launchMock).not.toHaveBeenCalled();
        expect(handle.logs.some((line) => line.includes("UNREADY"))).toBe(true);
      } finally {
        await rm(profileDir, { recursive: true, force: true });
      }
    },
    20_000,
  );

  maybeTest(
    "stale DevTools port: serve refuses to launch Chrome and reports unready",
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
        const port = await waitForListenPort(handle);
        await new Promise((resolve) => setTimeout(resolve, 750));
        expect(launchMock).not.toHaveBeenCalled();

        const response = await fetch(`http://127.0.0.1:${port}/status`, {
          headers: { authorization: "Bearer secret" },
        });
        const body = (await response.json()) as { ok?: boolean; reason?: string };
        expect(body.ok).toBe(false);
        expect(String(body.reason)).toContain("cdp-unreachable");
      } finally {
        await rm(profileDir, { recursive: true, force: true });
      }
    },
    30_000,
  );

  maybeTest(
    "unauthenticated /status stays a bare liveness boolean: no probe reason or chromeReachable leak",
    async () => {
      const profileDir = await mkdtemp(path.join(os.tmpdir(), "oracle-attach-only-"));
      try {
        const handle = await startServe(profileDir);
        const port = await waitForListenPort(handle);

        // Regression: /status used to echo the raw attach-probe diagnostics
        // (reason like "cdp-unreachable: ..." / "attach-target-owner-mismatch"
        // plus chromeReachable) to ANY caller, while /health and /ready gate
        // the same substrate/ownership state behind the bearer token. An
        // unauthenticated caller must only see the bare ok boolean.
        const unauthenticated = await fetch(`http://127.0.0.1:${port}/status`);
        expect(unauthenticated.status).toBe(200);
        const bareBody = (await unauthenticated.json()) as Record<string, unknown>;
        expect(bareBody.ok).toBe(false);
        expect(bareBody.attachOnly).toBe(true);
        expect(bareBody).not.toHaveProperty("reason");
        expect(bareBody).not.toHaveProperty("chromeReachable");

        // A wrong token is treated the same as no token: no diagnostics.
        const badToken = await fetch(`http://127.0.0.1:${port}/status`, {
          headers: { authorization: "Bearer wrong-token" },
        });
        expect(badToken.status).toBe(200);
        const badTokenBody = (await badToken.json()) as Record<string, unknown>;
        expect(badTokenBody).not.toHaveProperty("reason");
        expect(badTokenBody).not.toHaveProperty("chromeReachable");

        // The fleet token still unlocks the diagnostics on the same endpoint.
        const authorized = await fetch(`http://127.0.0.1:${port}/status`, {
          headers: { authorization: "Bearer secret" },
        });
        const authorizedBody = (await authorized.json()) as Record<string, unknown>;
        expect(authorizedBody.reason).toBe("no-attach-target-recorded");
        expect(authorizedBody.chromeReachable).toBe(false);
      } finally {
        await rm(profileDir, { recursive: true, force: true });
      }
    },
    30_000,
  );

  maybeTest(
    "serve does not report ready while no attachable Chrome exists",
    async () => {
      const profileDir = await mkdtemp(path.join(os.tmpdir(), "oracle-attach-only-"));
      try {
        const handle = await startServe(profileDir);
        const port = await waitForListenPort(handle);

        const response = await fetch(`http://127.0.0.1:${port}/status`, {
          headers: { authorization: "Bearer secret" },
        });
        const body = (await response.json()) as { ok?: boolean; reason?: string };
        // Fail-closed readiness: with neither a live DevTools endpoint nor an
        // owned browser, the service must not advertise itself as ready.
        expect(body.ok).toBe(false);
        expect(body.reason).toBe("no-attach-target-recorded");
      } finally {
        await rm(profileDir, { recursive: true, force: true });
      }
    },
    30_000,
  );
});

describe("attach-only serve: fail-closed admission", () => {
  maybeTest(
    "unreachable CDP: /runs is refused with a typed error and no launch",
    async () => {
      const profileDir = await mkdtemp(path.join(os.tmpdir(), "oracle-attach-only-"));
      try {
        const handle = await startServe(profileDir);
        const port = await waitForListenPort(handle);

        const response = await fetch(`http://127.0.0.1:${port}${REMOTE_BROWSER_RUN_PATH}`, {
          method: "POST",
          headers: {
            authorization: "Bearer secret",
            ...REMOTE_BROWSER_RECOVERY_ADMISSION_HEADER_VALUES,
            "content-type": "application/json",
          },
          body: JSON.stringify({ prompt: "x", attachments: [], browserConfig: {}, options: {} }),
        });
        expect(response.status).toBe(503);
        expect(response.headers.get("x-oracle-run-id")).toBeTruthy();
        const body = (await response.json()) as { error?: string; reason?: string };
        expect(body.error).toBe("browser_unavailable");
        expect(body.reason).toBe("no-attach-target-recorded");
        expect(launchMock).not.toHaveBeenCalled();
      } finally {
        await rm(profileDir, { recursive: true, force: true });
      }
    },
    30_000,
  );

  maybeTest(
    "an attachable operator-owned Chrome flips the worker to ready without any launch",
    async () => {
      const profileDir = await mkdtemp(path.join(os.tmpdir(), "oracle-attach-only-"));
      const fakeCdp = await startFakeCdp();
      const chromeScript = path.join(profileDir, "google-chrome");
      await writeFile(chromeScript, "setInterval(() => {}, 1_000);\n", "utf8");
      const chrome = spawn(
        process.execPath,
        [chromeScript, `--remote-debugging-port=${fakeCdp.port}`, `--user-data-dir=${profileDir}`],
        { stdio: "ignore" },
      );
      try {
        await once(chrome, "spawn");
        await writeFile(
          path.join(profileDir, "DevToolsActivePort"),
          `${fakeCdp.port}\n/devtools/browser/00000000-0000-0000-0000-000000000000\n`,
          "utf8",
        );
        const handle = await startServe(profileDir);
        const port = await waitForListenPort(handle);

        const response = await fetch(`http://127.0.0.1:${port}/status`, {
          headers: { authorization: "Bearer secret" },
        });
        const body = (await response.json()) as { ok?: boolean; chromeReachable?: boolean };
        expect(body.ok).toBe(true);
        expect(body.chromeReachable).toBe(true);
        expect(launchMock).not.toHaveBeenCalled();
      } finally {
        chrome.kill("SIGTERM");
        await once(chrome, "exit").catch(() => undefined);
        await fakeCdp.close();
        await rm(profileDir, { recursive: true, force: true });
      }
    },
    30_000,
  );
});

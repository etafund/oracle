import { afterEach, describe, expect, test } from "vitest";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRemoteServer } from "../../src/remote/server.js";
import type { BrowserRunResult } from "../../src/browserMode.js";

// GET /ready: layered, fail-closed per-worker readiness (probed directly,
// never through the router LB which masks per-worker truth).
//   200 idle-ready | 409 busy-but-healthy (client connected/disconnected
//   distinguished) | 503 substrate-broken or wedged-no-progress | 401 bad
//   token. Unknown values are null, never omitted.
// Fail-closed inputs: attach-target probe (chromeReachable/chromeOwnerOk),
// browser cleanup taint, lease-registry census; fleet-manifest agreement is
// exposure-only.

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

const MINIMAL_RESULT: BrowserRunResult = {
  answerText: "ok",
  answerMarkdown: "ok",
  tookMs: 1,
  answerTokens: 1,
  answerChars: 2,
};

const savedManifestEnv = process.env.ORACLE_FLEET_MANIFEST;
const tempDirs: string[] = [];

afterEach(async () => {
  if (savedManifestEnv === undefined) {
    delete process.env.ORACLE_FLEET_MANIFEST;
  } else {
    process.env.ORACLE_FLEET_MANIFEST = savedManifestEnv;
  }
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop()!, { recursive: true, force: true });
  }
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** Point the manifest env at a controlled (absent) path by default. */
async function isolateManifest(): Promise<string> {
  const dir = await tempDir("oracle-ready-manifest-");
  const manifestPath = path.join(dir, "manifest.json");
  process.env.ORACLE_FLEET_MANIFEST = manifestPath;
  return manifestPath;
}

describe("GET /ready", () => {
  test.skipIf(!CAN_LISTEN_LOCALHOST)("requires the bearer token", async () => {
    await isolateManifest();
    const profileDir = await tempDir("oracle-ready-profile-");
    const server = await createRemoteServer(
      {
        host: "127.0.0.1",
        port: 0,
        token: "secret",
        logger: () => {},
        attachOnly: false,
        manualLoginProfileDir: profileDir,
      },
      { runBrowser: async () => MINIMAL_RESULT },
    );
    try {
      const unauthorized = await getReady(server.port, "wrong");
      expect(unauthorized.statusCode).toBe(401);
      expect(unauthorized.json?.error).toBe("unauthorized");
    } finally {
      await server.close();
    }
  });

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "idle worker reports 200 idle-ready with identity, config, and census",
    async () => {
      await isolateManifest();
      const profileDir = await tempDir("oracle-ready-profile-");
      const server = await createRemoteServer(
        {
          host: "127.0.0.1",
          port: 0,
          token: "secret",
          logger: () => {},
          attachOnly: false,
          manualLoginProfileDir: profileDir,
          accountId: "acct2",
        },
        { runBrowser: async () => MINIMAL_RESULT },
      );
      try {
        const ready = await getReady(server.port, "secret");
        expect(ready.statusCode).toBe(200);
        const body = ready.json!;
        expect(body.ok).toBe(true);
        expect(body.state).toBe("idle-ready");
        expect(body.busy).toBe(false);
        expect(body.identity).toEqual({
          accountId: "acct2",
          laneId: `acct2-${server.port}`,
          port: server.port,
        });
        const effective = body.effectiveConfig as Record<string, number>;
        expect(effective.timeoutMs).toBeGreaterThan(0);
        expect(effective.profileLockTimeoutMs).toBeGreaterThan(0);
        expect(effective.maxConcurrentTabs).toBeGreaterThanOrEqual(1);
        expect(body.activeLeaseCount).toBe(0);
        expect(body.leaseRegistryReadable).toBe(true);
        expect(body.cleanupTaint).toBeNull();
        const quarantine = body.quarantine as Record<string, unknown>;
        expect(quarantine.quarantined).toBe(false);
        expect(quarantine.record).toBeNull();
        expect(body.activeRun).toBeNull();
        expect((body.manifest as Record<string, unknown>).present).toBe(false);
      } finally {
        await server.close();
      }
    },
  );

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "attach-only worker without a browser reports 503 substrate-broken",
    async () => {
      await isolateManifest();
      const profileDir = await tempDir("oracle-ready-profile-");
      const server = await createRemoteServer(
        {
          host: "127.0.0.1",
          port: 0,
          token: "secret",
          logger: () => {},
          attachOnly: true,
          manualLoginProfileDir: profileDir,
        },
        { runBrowser: async () => MINIMAL_RESULT },
      );
      try {
        const ready = await getReady(server.port, "secret");
        expect(ready.statusCode).toBe(503);
        expect(ready.json?.ok).toBe(false);
        expect(ready.json?.state).toBe("substrate-broken");
        expect(ready.json?.reason).toBe("no-attach-target-recorded");
        expect(ready.json?.chromeReachable).toBe(false);
      } finally {
        await server.close();
      }
    },
  );

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "a reachable endpoint owned by the wrong Chrome reports chromeOwnerOk=false and 503",
    async () => {
      await isolateManifest();
      const profileDir = await tempDir("oracle-ready-profile-");
      const fakeCdp = await startFakeCdp();
      try {
        // The worker is pinned to the fake CDP port, but the profile records
        // a DIFFERENT DevTools port: the listener answering on the pinned
        // port is not the Chrome this profile owns (split-brain defense).
        await writeFile(
          path.join(profileDir, "DevToolsActivePort"),
          `${fakeCdp.port + 1}\n/devtools/browser/00000000-0000-0000-0000-000000000000\n`,
          "utf8",
        );
        const server = await createRemoteServer(
          {
            host: "127.0.0.1",
            port: 0,
            token: "secret",
            logger: () => {},
            attachOnly: true,
            manualLoginProfileDir: profileDir,
            devtoolsPort: fakeCdp.port,
          },
          { runBrowser: async () => MINIMAL_RESULT },
        );
        try {
          const ready = await getReady(server.port, "secret");
          expect(ready.statusCode).toBe(503);
          expect(ready.json?.reason).toBe("attach-target-owner-mismatch");
          expect(ready.json?.chromeOwnerOk).toBe(false);
          expect(ready.json?.chromeReachable).toBe(true);
        } finally {
          await server.close();
        }
      } finally {
        await fakeCdp.close();
      }
    },
  );

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "busy worker distinguishes client-connected from client-disconnected (409)",
    async () => {
      await isolateManifest();
      const profileDir = await tempDir("oracle-ready-profile-");
      let releaseRun: ((result: BrowserRunResult) => void) | undefined;
      let markStarted: () => void = () => {};
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      const finished = new Promise<BrowserRunResult>((resolve) => {
        releaseRun = resolve;
      });
      const server = await createRemoteServer(
        {
          host: "127.0.0.1",
          port: 0,
          token: "secret",
          logger: () => {},
          attachOnly: false,
          manualLoginProfileDir: profileDir,
        },
        {
          runBrowser: async () => {
            markStarted();
            return await finished;
          },
        },
      );

      const active = startRun(server.port, "secret");
      void active.finished.catch(() => undefined);
      try {
        await started;
        const busyReady = await getReady(server.port, "secret");
        expect(busyReady.statusCode).toBe(409);
        expect(busyReady.json?.state).toBe("active-run-client-connected");
        expect(busyReady.json?.busy).toBe(true);
        expect(busyReady.json?.activeRun).toBeTruthy();
        expect(typeof busyReady.json?.lastProgressAgeSeconds).toBe("number");

        active.abort();
        await waitFor(async () => {
          const probe = await getReady(server.port, "secret");
          return probe.json?.state === "active-run-client-disconnected" ? probe : null;
        });
      } finally {
        releaseRun?.(MINIMAL_RESULT);
        await active.finished.catch(() => undefined);
        await server.close();
      }
    },
  );

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "an active run with no event progress beyond the wedge threshold reports 503 wedged",
    async () => {
      await isolateManifest();
      const profileDir = await tempDir("oracle-ready-profile-");
      let releaseRun: ((result: BrowserRunResult) => void) | undefined;
      let markStarted: () => void = () => {};
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      const finished = new Promise<BrowserRunResult>((resolve) => {
        releaseRun = resolve;
      });
      const server = await createRemoteServer(
        {
          host: "127.0.0.1",
          port: 0,
          token: "secret",
          logger: () => {},
          attachOnly: false,
          manualLoginProfileDir: profileDir,
          wedgeAfterMs: 100,
        },
        {
          runBrowser: async () => {
            markStarted();
            return await finished;
          },
        },
      );

      const active = startRun(server.port, "secret");
      void active.finished.catch(() => undefined);
      try {
        await started;
        const wedged = await waitFor(async () => {
          const probe = await getReady(server.port, "secret");
          return probe.statusCode === 503 && probe.json?.state === "wedged-no-progress"
            ? probe
            : null;
        });
        expect(String(wedged.json?.reason)).toContain("no-progress-for-ms");
      } finally {
        releaseRun?.(MINIMAL_RESULT);
        await active.finished.catch(() => undefined);
        await server.close();
      }
    },
  );

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "latched cleanup taint fails readiness closed (503)",
    async () => {
      await isolateManifest();
      const profileDir = await tempDir("oracle-ready-profile-");
      const server = await createRemoteServer(
        {
          host: "127.0.0.1",
          port: 0,
          token: "secret",
          logger: () => {},
          attachOnly: false,
          manualLoginProfileDir: profileDir,
        },
        {
          runBrowser: async () => MINIMAL_RESULT,
          cleanupTaint: () => ({
            at: "2026-07-03T00:00:00.000Z",
            reason: "owned-target-close-timeout",
          }),
        },
      );
      try {
        const ready = await getReady(server.port, "secret");
        expect(ready.statusCode).toBe(503);
        expect(String(ready.json?.reason)).toContain("cleanup-tainted");
        expect(ready.json?.cleanupTaint).toEqual({
          at: "2026-07-03T00:00:00.000Z",
          reason: "owned-target-close-timeout",
        });
      } finally {
        await server.close();
      }
    },
  );

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "an unverifiable lease registry fails readiness closed (503)",
    async () => {
      await isolateManifest();
      const profileDir = await tempDir("oracle-ready-profile-");
      await writeFile(path.join(profileDir, "oracle-tab-leases.json"), "{{{ not json", "utf8");
      const server = await createRemoteServer(
        {
          host: "127.0.0.1",
          port: 0,
          token: "secret",
          logger: () => {},
          attachOnly: false,
          manualLoginProfileDir: profileDir,
        },
        { runBrowser: async () => MINIMAL_RESULT },
      );
      try {
        const ready = await getReady(server.port, "secret");
        expect(ready.statusCode).toBe(503);
        expect(String(ready.json?.reason)).toContain("lease-registry-unreadable");
        expect(ready.json?.activeLeaseCount).toBeNull();
        expect(ready.json?.leaseRegistryReadable).toBe(false);
      } finally {
        await server.close();
      }
    },
  );

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "fleet-manifest agreement is exposed (match and mismatch) without gating",
    async () => {
      const manifestPath = await isolateManifest();
      const profileDir = await tempDir("oracle-ready-profile-");
      await writeFile(
        manifestPath,
        JSON.stringify({ account_id: "acct1", maxConcurrentTabs: 3 }),
        "utf8",
      );
      const server = await createRemoteServer(
        {
          host: "127.0.0.1",
          port: 0,
          token: "secret",
          logger: () => {},
          attachOnly: false,
          manualLoginProfileDir: profileDir,
        },
        { runBrowser: async () => MINIMAL_RESULT },
      );
      try {
        const matching = await getReady(server.port, "secret");
        expect(matching.statusCode).toBe(200);
        expect(matching.json?.manifest).toEqual({ present: true, match: true, mismatches: [] });

        await writeFile(
          manifestPath,
          JSON.stringify({ account_id: "acct2", maxConcurrentTabs: 99 }),
          "utf8",
        );
        const mismatching = await getReady(server.port, "secret");
        // Exposure only tonight: mismatch is visible but does not gate.
        expect(mismatching.statusCode).toBe(200);
        expect(mismatching.json?.manifest).toEqual({
          present: true,
          match: false,
          mismatches: ["account_id", "maxConcurrentTabs"],
        });
      } finally {
        await server.close();
      }
    },
  );
});

async function getReady(
  port: number,
  token: string,
): Promise<{ statusCode: number; json: Record<string, unknown> | null }> {
  return await new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/ready",
        method: "GET",
        headers: { authorization: `Bearer ${token}` },
      },
      (res) => {
        res.setEncoding("utf8");
        let body = "";
        res.on("data", (chunk: string) => {
          body += chunk;
        });
        res.on("end", () => {
          let json: Record<string, unknown> | null = null;
          try {
            json = body.length ? (JSON.parse(body) as Record<string, unknown>) : null;
          } catch {
            json = null;
          }
          resolve({ statusCode: res.statusCode ?? 0, json });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function startRun(
  port: number,
  token: string,
): { abort(): void; finished: Promise<{ statusCode: number; body: string }> } {
  const body = JSON.stringify({ prompt: "hold", attachments: [], browserConfig: {}, options: {} });
  let req: http.ClientRequest | undefined;
  const finished = new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
    req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/runs",
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
      },
      (res) => {
        res.setEncoding("utf8");
        let responseBody = "";
        res.on("data", (chunk: string) => {
          responseBody += chunk;
        });
        const settle = () => resolve({ statusCode: res.statusCode ?? 0, body: responseBody });
        res.on("end", settle);
        res.on("close", settle);
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
  return {
    abort() {
      req?.destroy();
    },
    finished,
  };
}

async function waitFor<T>(
  read: () => Promise<T | null>,
  timeoutMs = 3000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | null = null;
  while (Date.now() <= deadline) {
    last = await read();
    if (last) {
      return last;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for condition");
}

/** A fake CDP endpoint answering GET /json/version. */
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

import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, test } from "vitest";
import { collectRemoteFleetSlots } from "../../src/remote/slots.js";

const servers: http.Server[] = [];
const NOW = new Date("2026-07-05T12:00:00.000Z");

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

describe("remote fleet slots collector", () => {
  test("builds an idle direct-worker slot from /ready + GET /health without probing /runs", async () => {
    const requests: string[] = [];
    const server = await startFakeRemote((req, res, port) => {
      requests.push(`${req.method} ${req.url}`);
      if (req.url === "/ready") {
        writeJson(res, 200, {
          ok: true,
          state: "idle-ready",
          busy: false,
          identity: { accountId: "acct1", laneId: "acct1-9473", port },
          activeRun: null,
          activeLeaseCount: 0,
          leaseRegistryReadable: true,
          lastProgressAgeSeconds: null,
          effectiveConfig: { timeoutMs: 1000, profileLockTimeoutMs: 1000, maxConcurrentTabs: 1 },
          quarantine: {
            quarantined: false,
            record: null,
            latchPath: "/home/oracle/.config/oracle/quarantine.json",
          },
          manifest: { present: true, match: true, mismatches: [] },
        });
        return;
      }
      if (req.url === "/health") {
        writeJson(res, 200, { ok: true, busy: false, version: "0.1.0" });
        return;
      }
      writeJson(res, 404, { error: "not found" });
    });

    const report = await collectRemoteFleetSlots({
      targets: [{ laneId: "acct1-9473", host: `127.0.0.1:${server.port}`, token: "secret-token" }],
      inventorySource: "explicit-hosts",
      inventoryComplete: true,
      now: NOW,
    });

    expect(requests).toEqual(["GET /ready", "GET /health"]);
    expect(requests.some((entry) => entry.includes("/runs"))).toBe(false);
    expect(report).toMatchObject({
      _schema: "remote_fleet_slots.v1",
      generated_at: NOW.toISOString(),
      no_plaintext_secrets: true,
      summary: { total: 1, healthy: 1, read_only: true },
      lanes: [
        {
          lane_id: "acct1-9473",
          account_id: "acct1",
          status: "healthy",
          readiness_state: "idle-ready",
          version: "0.1.0",
          lease: { active_count: 0, registry_readable: true },
          substrate: { quarantined: false, manifest_present: true, manifest_match: true },
          next_action: { code: "ready" },
        },
      ],
    });
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("secret-token");
    expect(serialized).not.toContain("/home/oracle");
  });

  test("redacts unsafe reason and session id fields from busy/disconnected readiness", async () => {
    const server = await startFakeRemote((req, res) => {
      if (req.url === "/ready") {
        writeJson(res, 409, {
          ok: false,
          state: "active-run-client-disconnected",
          busy: true,
          reason:
            "busy for alice@example.com under /home/oracle/profile with Bearer sk-proj-secretvalue123456",
          identity: { accountId: "acct2", laneId: "acct2-9474", port: 9474 },
          activeRun: {
            id: "run-123",
            startedAt: "2026-07-05T11:58:00.000Z",
            ageSeconds: 120,
            clientConnected: false,
            promptChars: 44,
            phase: "running",
            sessionId: "https://chatgpt.com/c/session?token=sk-proj-secretvalue123456",
            desiredModel: "gpt-5.5-pro",
          },
          activeLeaseCount: 1,
          leaseRegistryReadable: true,
          lastProgressAgeSeconds: 30,
          chromeBrowserWSEndpoint: "ws://127.0.0.1/devtools/browser/secret",
          quarantine: {
            quarantined: false,
            latchPath: "/home/oracle/.config/oracle/quarantine.json",
          },
          manifest: { present: true, match: false, mismatches: ["ports"] },
        });
        return;
      }
      if (req.url === "/health") {
        writeJson(res, 409, { ok: false, busy: true, version: "0.1.0" });
        return;
      }
      writeJson(res, 404, { error: "not found" });
    });

    const report = await collectRemoteFleetSlots({
      targets: [{ host: `127.0.0.1:${server.port}`, token: "sk-proj-raw-token123456" }],
      inventorySource: "configured-remote",
      inventoryComplete: false,
      now: NOW,
    });

    expect(report.lanes[0]).toMatchObject({
      status: "disconnected",
      run: {
        run_id: "run-123",
        session_id: null,
        session_id_redacted: true,
        client_connected: false,
      },
      progress: { last_progress_age_seconds: 30 },
      next_action: { code: "watch_abort" },
    });
    expect(report.lanes[0]?.run.session_id_hash).toMatch(/^sha256:[a-f0-9]{12}$/);
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("alice@example.com");
    expect(serialized).not.toContain("/home/oracle");
    expect(serialized).not.toContain("sk-proj-secretvalue123456");
    expect(serialized).not.toContain("sk-proj-raw-token123456");
    expect(serialized).not.toContain("chromeBrowserWSEndpoint");
    expect(serialized).not.toContain("ws://");
  });

  test("falls back to a legacy health-only slot when /ready is absent", async () => {
    const requests: string[] = [];
    const server = await startFakeRemote((req, res) => {
      requests.push(`${req.method} ${req.url}`);
      if (req.url === "/ready") {
        writeJson(res, 404, { error: "missing" });
        return;
      }
      if (req.url === "/health") {
        writeJson(res, 200, { ok: true, busy: false, version: "0.0.9" });
        return;
      }
      writeJson(res, 404, { error: "not found" });
    });

    const report = await collectRemoteFleetSlots({
      targets: [{ laneId: "legacy", host: `127.0.0.1:${server.port}`, token: "secret-token" }],
      inventorySource: "explicit-hosts",
      inventoryComplete: true,
      now: NOW,
    });

    expect(requests).toEqual(["GET /ready", "GET /health"]);
    expect(report.lanes[0]).toMatchObject({
      lane_id: "legacy",
      status: "legacy",
      version: "0.0.9",
      compatibility: { ready_supported: false, health_supported: true },
      next_action: { code: "upgrade_worker" },
    });
  });

  test("reports auth failures and not-configured inventory without leaking token state", async () => {
    const server = await startFakeRemote((_req, res) => {
      writeJson(res, 401, { error: "unauthorized" });
    });

    const auth = await collectRemoteFleetSlots({
      targets: [{ host: `127.0.0.1:${server.port}`, token: "secret-token" }],
      inventorySource: "configured-remote",
      inventoryComplete: false,
      now: NOW,
    });

    expect(auth.lanes[0]).toMatchObject({
      status: "auth_failed",
      next_action: { code: "fix_token" },
    });
    expect(JSON.stringify(auth)).not.toContain("secret-token");

    const none = await collectRemoteFleetSlots({
      targets: [],
      inventorySource: "none",
      now: NOW,
    });
    expect(none).toMatchObject({
      summary: { total: 1, not_configured: 1 },
      lanes: [{ endpoint_id: "not-configured", status: "not_configured" }],
    });
  });
});

async function startFakeRemote(
  handler: (req: http.IncomingMessage, res: http.ServerResponse, port: number) => void,
): Promise<{ port: number; server: http.Server }> {
  const server = http.createServer((req, res) => {
    const address = server.address() as AddressInfo;
    handler(req, res, address.port);
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  return { port: (server.address() as AddressInfo).port, server };
}

function writeJson(res: http.ServerResponse, statusCode: number, body: unknown): void {
  res.writeHead(statusCode, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

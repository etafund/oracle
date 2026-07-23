import { describe, expect, test } from "vitest";
import http from "node:http";
import { spawnSync } from "node:child_process";
import { assertFleetSafeServeBrowserConfig, createRemoteServer } from "../../src/remote/server.js";

// Fleet-safety config asserts: `<= 0` is a documented disable sentinel for
// profileLockTimeoutMs (serialized-submit lock), timeoutMs (response wait),
// and queueTimeoutMs (FIFO capacity wait). On a shared serve worker those
// sentinels mean composer cross-talk or wedged-forever lanes, so serve must
// refuse to start with them, surface the effective values in the startup log,
// and expose them for health/readiness probes.

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

const SAFE = {
  profileLockTimeoutMs: 300_000,
  timeoutMs: 1_200_000,
  queueTimeoutMs: 1_200_000,
  maxConcurrentTabs: 3,
};

describe("assertFleetSafeServeBrowserConfig", () => {
  test("accepts safe effective values", () => {
    expect(() => assertFleetSafeServeBrowserConfig(SAFE)).not.toThrow();
    expect(() =>
      assertFleetSafeServeBrowserConfig({ ...SAFE, maxConcurrentTabs: 1 }),
    ).not.toThrow();
  });

  test("rejects zero, negative, and absent profileLockTimeoutMs, naming the key and value", () => {
    for (const value of [0, -1, undefined, null, Number.NaN]) {
      expect(() =>
        assertFleetSafeServeBrowserConfig({ ...SAFE, profileLockTimeoutMs: value }),
      ).toThrow(new RegExp(`profileLockTimeoutMs=${String(value)}`));
    }
  });

  test("rejects zero, negative, and absent timeoutMs, naming the key and value", () => {
    for (const value of [0, -5, undefined, null, Number.NaN]) {
      expect(() => assertFleetSafeServeBrowserConfig({ ...SAFE, timeoutMs: value })).toThrow(
        new RegExp(`timeoutMs=${String(value)}`),
      );
    }
  });

  test("rejects queueTimeoutMs outside the remote 1s through 75m bounds", () => {
    for (const value of [0, 999, -1, 4_500_001, undefined, null, Number.NaN]) {
      expect(() => assertFleetSafeServeBrowserConfig({ ...SAFE, queueTimeoutMs: value })).toThrow(
        new RegExp(`queueTimeoutMs=${String(value)}`),
      );
    }
  });

  test("rejects out-of-range or non-integer maxConcurrentTabs", () => {
    for (const value of [0, 4, -1, 2.5, undefined, null]) {
      expect(() =>
        assertFleetSafeServeBrowserConfig({ ...SAFE, maxConcurrentTabs: value }),
      ).toThrow(new RegExp(`maxConcurrentTabs=${String(value)}`));
    }
  });

  test("reports every violated key in one refusal message", () => {
    try {
      assertFleetSafeServeBrowserConfig({
        profileLockTimeoutMs: 0,
        timeoutMs: -1,
        queueTimeoutMs: 0,
        maxConcurrentTabs: 9,
      });
      expect.unreachable("should have thrown");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toContain("Refusing to start");
      expect(message).toContain("profileLockTimeoutMs=0");
      expect(message).toContain("timeoutMs=-1");
      expect(message).toContain("queueTimeoutMs=0");
      expect(message).toContain("maxConcurrentTabs=9");
    }
  });
});

describe("serve startup surfaces effective run config", () => {
  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "valid defaults start, are logged, and appear in the health body",
    async () => {
      const logs: string[] = [];
      const server = await createRemoteServer({
        host: "127.0.0.1",
        port: 0,
        token: "secret",
        logger: (message) => logs.push(message),
        manualLoginDefault: true,
      });

      try {
        const configLine = logs.find((line) => line.includes("Effective run config:"));
        expect(configLine).toBeTruthy();
        expect(configLine).toMatch(/timeoutMs=\d+/);
        expect(configLine).toMatch(/profileLockTimeoutMs=\d+/);
        expect(configLine).toMatch(/queueTimeoutMs=\d+/);
        expect(configLine).toMatch(/maxConcurrentTabs=[123]/);

        const health = await getJson(server.port, "/health", "secret");
        expect(health.statusCode).toBe(200);
        const effective = health.json?.effectiveConfig as Record<string, unknown>;
        expect(typeof effective?.timeoutMs).toBe("number");
        expect(effective?.timeoutMs).toBeGreaterThan(0);
        expect(typeof effective?.profileLockTimeoutMs).toBe("number");
        expect(effective?.profileLockTimeoutMs).toBeGreaterThan(0);
        expect(typeof effective?.queueTimeoutMs).toBe("number");
        expect(effective?.queueTimeoutMs).toBeGreaterThan(0);
        expect(effective?.maxConcurrentTabs).toBeGreaterThanOrEqual(1);
        expect(effective?.maxConcurrentTabs).toBeLessThanOrEqual(3);
      } finally {
        await server.close();
      }
    },
  );
});

async function getJson(
  port: number,
  path: string,
  token: string,
): Promise<{ statusCode: number; json: Record<string, unknown> | null }> {
  return await new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
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

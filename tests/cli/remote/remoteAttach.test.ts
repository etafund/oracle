// Integration test for `oracle remote attach --host ... --token-env ... --json`.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { resolveRemoteServiceConfig } = vi.hoisted(() => ({
  resolveRemoteServiceConfig: vi.fn(({ cliHost, cliToken }: { cliHost?: string; cliToken?: string }) => ({
    host: cliHost,
    token: cliToken,
    mode: "preferred",
    hostHash: cliHost ? "cli-host-hash-1234" : undefined,
    redactedToken: cliToken ? "***" : undefined,
    sources: { host: "cli", token: "cli", mode: "cli" },
  })),
}));

interface MockTcp {
  ok: boolean;
  error?: string;
}
interface MockHealth {
  ok: boolean;
  statusCode?: number;
  error?: string;
  version?: string;
  uptimeSeconds?: number;
  authProfileIdHash?: string;
  providerLocks?: string[];
}

const { checkTcpConnection, checkRemoteHealth } = vi.hoisted(() => ({
  checkTcpConnection: vi.fn<(host: string, timeoutMs?: number) => Promise<MockTcp>>(),
  checkRemoteHealth:
    vi.fn<
      (opts: { host: string; token?: string; timeoutMs?: number }) => Promise<MockHealth>
    >(),
}));

vi.mock("../../../src/remote/remoteServiceConfig.js", () => ({ resolveRemoteServiceConfig }));
vi.mock("../../../src/remote/health.js", () => ({ checkTcpConnection, checkRemoteHealth }));

import { runRemoteAttach } from "../../../src/cli/remote/attach.js";

describe("runRemoteAttach --json", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let originalExitCode: typeof process.exitCode;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    originalExitCode = process.exitCode;
    process.exitCode = undefined;
    vi.clearAllMocks();
    checkTcpConnection.mockResolvedValue({ ok: true });
    checkRemoteHealth.mockResolvedValue({
      ok: true,
      version: "1.0.0",
      uptimeSeconds: 7,
      authProfileIdHash: "auth-hash-1",
      providerLocks: ["browser:shared-profile:chatgpt"],
    });
  });

  afterEach(() => {
    logSpy.mockRestore();
    process.exitCode = originalExitCode;
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("ORACLE_TEST_TOKEN_")) delete process.env[key];
    }
    delete process.env.ORACLE_REMOTE_TOKEN;
  });

  test("rejects an empty --host", async () => {
    await expect(runRemoteAttach({ host: "" })).rejects.toThrow(/--host/);
  });

  test("emits healthy v18 envelope using the named token env", async () => {
    process.env.ORACLE_TEST_TOKEN_A = "attach-secret-A";
    await runRemoteAttach({
      host: "attach-host:9999",
      tokenEnv: "ORACLE_TEST_TOKEN_A",
      json: true,
    });
    expect(logSpy).toHaveBeenCalledTimes(1);
    const out = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(out._schema).toBe("remote_browser_endpoint.v1");
    expect(out.status).toBe("healthy");
    expect(out.version).toBe("1.0.0");
    expect(out.host_env).toBeNull(); // ORACLE_REMOTE_HOST not set; attach uses --host directly
    expect(out.token_env).toBe("ORACLE_TEST_TOKEN_A");
    expect(out.provider_locks).toEqual(["browser:shared-profile:chatgpt"]);
    expect(process.exitCode).toBe(0);
  });

  test("never prints the raw token in JSON output", async () => {
    process.env.ORACLE_TEST_TOKEN_B = "very-secret-attach-token";
    await runRemoteAttach({
      host: "attach-host:9999",
      tokenEnv: "ORACLE_TEST_TOKEN_B",
      json: true,
    });
    const raw = logSpy.mock.calls[0][0] as string;
    expect(raw).not.toContain("very-secret-attach-token");
  });

  test("never prints the raw token in human output", async () => {
    process.env.ORACLE_TEST_TOKEN_C = "human-out-secret";
    await runRemoteAttach({
      host: "attach-host:9999",
      tokenEnv: "ORACLE_TEST_TOKEN_C",
    });
    const all = logSpy.mock.calls.map((args: unknown[]) => String(args[0])).join("\n");
    expect(all).not.toContain("human-out-secret");
  });

  test("rejects when token env var is set but empty", async () => {
    process.env.ORACLE_TEST_TOKEN_D = "  ";
    await expect(
      runRemoteAttach({ host: "attach-host:9999", tokenEnv: "ORACLE_TEST_TOKEN_D", json: true }),
    ).rejects.toThrow(/empty/);
  });

  test("defaults to ORACLE_REMOTE_TOKEN when --token-env is omitted", async () => {
    process.env.ORACLE_REMOTE_TOKEN = "default-env-token";
    await runRemoteAttach({ host: "attach-host:9999", json: true });
    const out = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(out.token_env).toBe("ORACLE_REMOTE_TOKEN");
    expect(JSON.stringify(out)).not.toContain("default-env-token");
  });

  test("unreachable host yields status=unreachable and non-zero exit", async () => {
    process.env.ORACLE_TEST_TOKEN_E = "tok-e";
    checkTcpConnection.mockResolvedValueOnce({ ok: false, error: "ENETUNREACH" });
    await runRemoteAttach({
      host: "bad-host:9999",
      tokenEnv: "ORACLE_TEST_TOKEN_E",
      json: true,
    });
    const out = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(out.status).toBe("unreachable");
    expect(out.error).toBe("ENETUNREACH");
    expect(process.exitCode).toBe(1);
  });

  test("auth_failed when /health rejects", async () => {
    process.env.ORACLE_TEST_TOKEN_F = "tok-f";
    checkRemoteHealth.mockResolvedValueOnce({ ok: false, statusCode: 401, error: "Unauthorized" });
    await runRemoteAttach({
      host: "attach-host:9999",
      tokenEnv: "ORACLE_TEST_TOKEN_F",
      json: true,
    });
    const out = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(out.status).toBe("auth_failed");
    expect(out.error).toBe("HTTP 401 (Unauthorized)");
  });
});

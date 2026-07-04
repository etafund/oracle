// Integration test for `oracle remote doctor` JSON path.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { loadUserConfig } = vi.hoisted(() => ({
  loadUserConfig: vi.fn(async () => ({
    config: {},
    path: "/mock/config.json",
    loaded: true,
  })),
}));

interface MockResolved {
  host: string | undefined;
  token: string | undefined;
  mode: "preferred" | "required" | "off";
  hostHash: string | undefined;
  redactedToken: string | undefined;
  sources: { host: string; token: string; mode: string };
}

const { resolveRemoteServiceConfig } = vi.hoisted(() => ({
  resolveRemoteServiceConfig: vi.fn<() => MockResolved>(),
}));

interface MockTcp {
  ok: boolean;
  error?: string;
}
interface MockHealth {
  ok: boolean;
  statusCode?: number;
  error?: string;
  busy?: boolean;
  activeRun?: {
    id: string;
    startedAt: string;
    ageSeconds: number;
    clientConnected: boolean;
    promptChars: number;
    sessionId?: string;
    desiredModel?: string;
  };
  version?: string;
  uptimeSeconds?: number;
  authProfileIdHash?: string;
  providerLocks?: string[];
  build?: {
    schema_version: "oracle_build_provenance.v1";
    version: string;
    commit: string | null;
    commit_short: string | null;
    dirty: boolean | null;
    built_at: string | null;
    source: string;
  };
}

const { checkTcpConnection, checkRemoteHealth } = vi.hoisted(() => ({
  checkTcpConnection: vi.fn<(host: string, timeoutMs?: number) => Promise<MockTcp>>(),
  checkRemoteHealth:
    vi.fn<(opts: { host: string; token?: string; timeoutMs?: number }) => Promise<MockHealth>>(),
}));

vi.mock("../../../src/config.js", () => ({ loadUserConfig }));
vi.mock("../../../src/remote/remoteServiceConfig.js", () => ({ resolveRemoteServiceConfig }));
vi.mock("../../../src/remote/health.js", () => ({ checkTcpConnection, checkRemoteHealth }));

import { runRemoteDoctor } from "../../../src/cli/remote/doctor.js";

describe("runRemoteDoctor --json", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let originalExitCode: typeof process.exitCode;
  let originalEnv: Record<string, string | undefined>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    originalExitCode = process.exitCode;
    process.exitCode = undefined;
    originalEnv = {
      ORACLE_REMOTE_HOST: process.env.ORACLE_REMOTE_HOST,
      ORACLE_REMOTE_TOKEN: process.env.ORACLE_REMOTE_TOKEN,
    };
    process.env.ORACLE_REMOTE_HOST = "remote.test:9473";
    process.env.ORACLE_REMOTE_TOKEN = "secret-token";
    vi.clearAllMocks();
    resolveRemoteServiceConfig.mockReturnValue({
      host: "remote.test:9473",
      token: "secret-token",
      mode: "preferred",
      hostHash: "0123456789ab",
      redactedToken: "***",
      sources: { host: "env", token: "env", mode: "default" },
    });
    checkTcpConnection.mockResolvedValue({ ok: true });
    checkRemoteHealth.mockResolvedValue({
      ok: true,
      version: "1.2.3",
      uptimeSeconds: 9001,
      authProfileIdHash: "auth-hash-789",
      providerLocks: ["browser:shared-profile:chatgpt", "browser:shared-profile:gemini"],
      build: {
        schema_version: "oracle_build_provenance.v1",
        version: "1.2.3",
        commit: "0123456789abcdef0123456789abcdef01234567",
        commit_short: "0123456789ab",
        dirty: false,
        built_at: "2026-07-04T20:00:00.000Z",
        source: "build-provenance",
      },
    });
  });

  afterEach(() => {
    logSpy.mockRestore();
    process.exitCode = originalExitCode;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test("emits healthy v18 endpoint envelope", async () => {
    await runRemoteDoctor({ json: true });
    expect(logSpy).toHaveBeenCalledTimes(1);
    const out = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(out._schema).toBe("remote_browser_endpoint.v1");
    expect(out.status).toBe("healthy");
    expect(out.version).toBe("1.2.3");
    expect(out.build).toMatchObject({
      schema_version: "oracle_build_provenance.v1",
      version: "1.2.3",
      commit_short: "0123456789ab",
      source: "build-provenance",
    });
    expect(out.auth_profile_id_hash).toBe("auth-hash-789");
    expect(out.provider_locks).toEqual([
      "browser:shared-profile:chatgpt",
      "browser:shared-profile:gemini",
    ]);
    expect(out.host_env).toBe("ORACLE_REMOTE_HOST");
    expect(out.token_env).toBe("ORACLE_REMOTE_TOKEN");
    expect(out.no_plaintext_secrets).toBe(true);
    expect(out.oracle_version).toMatch(/\d+\.\d+\.\d+/);
    expect(out.oracle_build).toMatchObject({
      schema_version: "oracle_build_provenance.v1",
      version: expect.stringMatching(/\d+\.\d+\.\d+/),
    });
    expect(process.exitCode).toBe(0);
  });

  test("missing_token exits non-zero with stable envelope", async () => {
    resolveRemoteServiceConfig.mockReturnValueOnce({
      host: "remote.test:9473",
      token: undefined,
      mode: "preferred",
      hostHash: "0123456789ab",
      redactedToken: undefined,
      sources: { host: "env", token: "unset", mode: "default" },
    });
    delete process.env.ORACLE_REMOTE_TOKEN;

    await runRemoteDoctor({ json: true });
    const out = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(out.status).toBe("missing_token");
    expect(out.recover_command).toBe("export ORACLE_REMOTE_TOKEN=<token>");
    expect(process.exitCode).toBe(1);
  });

  test("unreachable emits TCP error", async () => {
    checkTcpConnection.mockResolvedValueOnce({ ok: false, error: "ECONNREFUSED" });
    await runRemoteDoctor({ json: true });
    const out = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(out.status).toBe("unreachable");
    expect(out.error).toBe("ECONNREFUSED");
    expect(process.exitCode).toBe(1);
  });

  test("auth_failed emits HTTP status", async () => {
    checkRemoteHealth.mockResolvedValueOnce({ ok: false, statusCode: 401, error: "Unauthorized" });
    await runRemoteDoctor({ json: true });
    const out = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(out.status).toBe("auth_failed");
    expect(out.error).toBe("HTTP 401 (Unauthorized)");
    expect(process.exitCode).toBe(1);
  });

  test("busy emits active-run metadata instead of auth_failed", async () => {
    checkRemoteHealth.mockResolvedValueOnce({
      ok: false,
      statusCode: 409,
      error: "busy",
      busy: true,
      version: "1.2.3",
      uptimeSeconds: 9002,
      activeRun: {
        id: "run-1",
        startedAt: "2026-06-28T03:27:58.000Z",
        ageSeconds: 30,
        clientConnected: false,
        promptChars: 42,
        sessionId: "session-1",
        desiredModel: "gpt-5.5-pro",
      },
    });
    await runRemoteDoctor({ json: true });
    const out = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(out.status).toBe("busy");
    expect(out.busy).toBe(true);
    expect(out.activeRun).toMatchObject({
      id: "run-1",
      clientConnected: false,
      sessionId: "session-1",
      desiredModel: "gpt-5.5-pro",
    });
    expect(out.error).toBe("HTTP 409 (busy)");
    expect(process.exitCode).toBe(1);
  });

  test("never prints the raw token in JSON output", async () => {
    await runRemoteDoctor({ json: true });
    const raw = logSpy.mock.calls[0][0] as string;
    expect(raw).not.toContain("secret-token");
  });

  test("never prints the raw token in human output", async () => {
    await runRemoteDoctor({ json: false });
    const raw = logSpy.mock.calls.map((args: unknown[]) => String(args[0])).join("\n");
    expect(raw).not.toContain("secret-token");
  });
});

describe("runRemoteDoctor not_configured", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let originalExitCode: typeof process.exitCode;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    originalExitCode = process.exitCode;
    process.exitCode = undefined;
    resolveRemoteServiceConfig.mockReturnValue({
      host: undefined,
      token: undefined,
      mode: "preferred",
      hostHash: undefined,
      redactedToken: undefined,
      sources: { host: "unset", token: "unset", mode: "default" },
    });
    delete process.env.ORACLE_REMOTE_HOST;
    delete process.env.ORACLE_REMOTE_TOKEN;
    vi.clearAllMocks();
  });

  afterEach(() => {
    logSpy.mockRestore();
    process.exitCode = originalExitCode;
  });

  test("not_configured exits zero (local-only is allowed)", async () => {
    await runRemoteDoctor({ json: true });
    const out = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(out.status).toBe("not_configured");
    expect(out.endpoint_id).toBe("local");
    expect(process.exitCode ?? 0).toBe(0);
  });
});

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { runBridgeDoctor } from "../../../src/cli/bridge/doctor.js";

const { loadUserConfig } = vi.hoisted(() => ({
  loadUserConfig: vi.fn(async () => ({
    config: {},
    path: "/mock/config.json",
    paths: ["/mock/config.json"],
    loaded: true,
  })),
}));

const { resolveRemoteServiceConfig } = vi.hoisted(() => ({
  resolveRemoteServiceConfig: vi.fn(() => ({
    host: "remote.host:9222",
    token: "mock-token",
    mode: "preferred",
    hostHash: "mock-hash",
    redactedToken: "***",
    sources: { host: "env", token: "env", mode: "default" },
  })),
}));

const { checkTcpConnection, checkRemoteHealth } = vi.hoisted(() => {
  // Hoisted mocks need explicit return types — vi.fn infers from the
  // default implementation, which would narrow to the success shape and
  // reject mockResolvedValueOnce calls that use the failure variants.
  type TcpResult = { ok: boolean; error?: string };
  type HealthResult = {
    ok: boolean;
    statusCode?: number;
    error?: string;
    version?: string;
    uptimeSeconds?: number;
    authProfileIdHash?: string;
    providerLocks?: string[];
  };
  return {
    checkTcpConnection: vi.fn<(host: string, timeoutMs?: number) => Promise<TcpResult>>(
      async () => ({ ok: true }),
    ),
    checkRemoteHealth: vi.fn<
      (args: { host: string; token?: string; timeoutMs?: number }) => Promise<HealthResult>
    >(async () => ({
      ok: true,
      version: "1.2.3",
      uptimeSeconds: 100,
      authProfileIdHash: "auth-hash-123",
      providerLocks: ["chatgpt", "gemini"],
    })),
  };
});

vi.mock("../../../src/config.js", () => ({ loadUserConfig }));
vi.mock("../../../src/remote/remoteServiceConfig.js", () => ({ resolveRemoteServiceConfig }));
vi.mock("../../../src/remote/health.js", () => ({ checkTcpConnection, checkRemoteHealth }));
vi.mock("../../../src/browser/detect.js", () => ({
  detectChromeBinary: async () => ({ path: null }),
  detectChromeCookieDb: async () => null,
}));

describe("runBridgeDoctor --json", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  // process.exitCode widened in newer @types/node to allow string | null;
  // capture it with the actual property type rather than narrowing.
  let originalExitCode: typeof process.exitCode;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    originalExitCode = process.exitCode;
    process.exitCode = undefined;
    vi.clearAllMocks();
  });

  afterEach(() => {
    logSpy.mockRestore();
    process.exitCode = originalExitCode;
  });

  it("outputs healthy endpoint JSON", async () => {
    await runBridgeDoctor({ json: true });

    expect(logSpy).toHaveBeenCalledTimes(1);
    const jsonOutput = JSON.parse(logSpy.mock.calls[0][0]);

    expect(jsonOutput._schema).toBe("remote_browser_endpoint.v1");
    expect(jsonOutput.status).toBe("healthy");
    expect(jsonOutput.version).toBe("1.2.3");
    expect(jsonOutput.auth_profile_id_hash).toBe("auth-hash-123");
    expect(jsonOutput.provider_locks).toEqual(["chatgpt", "gemini"]);
    expect(jsonOutput.mode).toBe("preferred");
    expect(jsonOutput.no_plaintext_secrets).toBe(true);
    expect(jsonOutput.token_env).toBeNull(); // process.env.ORACLE_REMOTE_TOKEN is not set in this test
    expect(process.exitCode).toBe(0);
  });

  it("outputs missing_token JSON when token is omitted", async () => {
    resolveRemoteServiceConfig.mockReturnValueOnce({
      host: "remote.host:9222",
      token: undefined,
      mode: "preferred",
      hostHash: "mock-hash",
      redactedToken: undefined,
      sources: { host: "env", token: "unset", mode: "default" },
    } as any);

    await runBridgeDoctor({ json: true });

    const jsonOutput = JSON.parse(logSpy.mock.calls[0][0]);
    expect(jsonOutput.status).toBe("missing_token");
    expect(process.exitCode).toBe(1);
  });

  it("outputs unreachable JSON when TCP fails", async () => {
    checkTcpConnection.mockResolvedValueOnce({ ok: false, error: "ECONNREFUSED" });

    await runBridgeDoctor({ json: true });

    const jsonOutput = JSON.parse(logSpy.mock.calls[0][0]);
    expect(jsonOutput.status).toBe("unreachable");
    expect(jsonOutput.error).toBe("ECONNREFUSED");
    expect(process.exitCode).toBe(1);
  });

  it("outputs auth_failed JSON when /health fails", async () => {
    checkRemoteHealth.mockResolvedValueOnce({ ok: false, statusCode: 401, error: "Unauthorized" });

    await runBridgeDoctor({ json: true });

    const jsonOutput = JSON.parse(logSpy.mock.calls[0][0]);
    expect(jsonOutput.status).toBe("auth_failed");
    expect(jsonOutput.error).toBe("HTTP 401 (Unauthorized)");
    expect(process.exitCode).toBe(1);
  });

  it("writes JSON to injected io.stdout instead of console.log", async () => {
    let captured = "";
    await runBridgeDoctor({ json: true }, { stdout: (text) => (captured += text) });

    expect(logSpy).not.toHaveBeenCalled();
    const jsonOutput = JSON.parse(captured);
    expect(jsonOutput.status).toBe("healthy");
    expect(process.exitCode).toBe(0);
  });
});

describe("aggregate doctor bridge check concurrency", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let originalExitCode: typeof process.exitCode;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    originalExitCode = process.exitCode;
    process.exitCode = undefined;
    vi.clearAllMocks();
  });

  afterEach(() => {
    logSpy.mockRestore();
    process.exitCode = originalExitCode;
  });

  it("does not swallow sibling console.log output while the default bridge doctor runs", async () => {
    // Regression: defaultRemoteBridgeDoctor used to monkeypatch the global
    // console.log while awaiting runBridgeDoctor inside Promise.all. A sibling
    // check logging during that window had its output silently captured into
    // the bridge doctor's JSON buffer, corrupting the JSON.parse and turning a
    // healthy bridge result into remote_bridge_doctor_error.
    const { runAggregateDoctor } = await import(
      "../../../src/cli/commands/doctor/aggregate.js"
    );

    // Keep the bridge doctor in-flight long enough for the sibling to log.
    checkRemoteHealth.mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return {
        ok: true,
        version: "1.2.3",
        uptimeSeconds: 100,
        authProfileIdHash: "auth-hash-123",
        providerLocks: ["chatgpt", "gemini"],
      };
    });

    const providerEnvelope = (provider: "chatgpt" | "gemini") => ({
      schema_version: "provider_doctor.v1" as const,
      provider,
      ok: true,
      status: "ready" as const,
      requested: {},
      checks: [],
      blockers: [],
      warnings: [],
      next_command: null,
      fix_command: null,
    });

    const result = await runAggregateDoctor(
      {
        json: true,
        chatgptDoctor: async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          console.log("sibling-check-log-line");
          return providerEnvelope("chatgpt");
        },
        geminiDoctor: async () => providerEnvelope("gemini"),
        sessionStorageCheck: async () => ({
          component: "session_storage",
          status: "pass" as const,
          code: "session_storage_pass",
          message: "ok",
          retry_safe: true,
        }),
      },
      { stdout: () => {} },
    );

    // The sibling's output must reach the real console.log...
    expect(logSpy).toHaveBeenCalledWith("sibling-check-log-line");
    // ...and must not corrupt the bridge doctor's captured JSON.
    expect(result.data.remote_bridge.status).toBe("pass");
    expect(result.data.remote_bridge.code).toBe("remote_bridge_healthy");
  });
});

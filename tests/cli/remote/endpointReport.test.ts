// Tests for the shared `remote_browser_endpoint.v1` report builder.
//
// Covers the bead's acceptance criteria at the unit level (the
// command-runner integration tests in ./doctor*.test.ts / ./status.test.ts
// / ./attach.test.ts exercise the same paths through the CLI wrapper).

import { beforeEach, describe, expect, test, vi } from "vitest";

import {
  buildRemoteEndpointReport,
  isHealthyReport,
  reportLeaksToken,
} from "../../../src/cli/remote/endpointReport.js";
import type { ResolvedRemoteServiceConfig } from "../../../src/remote/remoteServiceConfig.js";

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
}

const { checkTcpConnection, checkRemoteHealth } = vi.hoisted(() => ({
  checkTcpConnection: vi.fn<(host: string, timeoutMs?: number) => Promise<MockTcp>>(),
  checkRemoteHealth:
    vi.fn<(opts: { host: string; token?: string; timeoutMs?: number }) => Promise<MockHealth>>(),
}));

vi.mock("../../../src/remote/health.js", () => ({ checkTcpConnection, checkRemoteHealth }));

function resolvedConfig(
  overrides: Partial<ResolvedRemoteServiceConfig> = {},
): ResolvedRemoteServiceConfig {
  return {
    host: "remote.test:9473",
    token: "secret-token",
    mode: "preferred",
    hostHash: "0123456789ab",
    redactedToken: "***",
    sources: { host: "env", token: "env", mode: "default" },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  checkTcpConnection.mockResolvedValue({ ok: true });
  checkRemoteHealth.mockResolvedValue({
    ok: true,
    version: "9.9.9",
    uptimeSeconds: 42,
    authProfileIdHash: "auth-hash",
    providerLocks: ["browser:shared-profile:chatgpt", "browser:shared-profile:gemini"],
  } satisfies MockHealth);
});

describe("buildRemoteEndpointReport — status precedence", () => {
  test("not_configured when no host is resolved", async () => {
    const { report } = await buildRemoteEndpointReport({
      resolved: resolvedConfig({ host: undefined, token: undefined, hostHash: undefined }),
      env: {},
    });
    expect(report._schema).toBe("remote_browser_endpoint.v1");
    expect(report.status).toBe("not_configured");
    expect(report.endpoint_id).toBe("local");
    expect(report.no_plaintext_secrets).toBe(true);
    expect(isHealthyReport(report)).toBe(true);
  });

  test("missing_token when host but no token", async () => {
    const { report } = await buildRemoteEndpointReport({
      resolved: resolvedConfig({ token: undefined, redactedToken: undefined }),
      env: { ORACLE_REMOTE_HOST: "remote.test:9473" },
    });
    expect(report.status).toBe("missing_token");
    expect(report.recover_command).toBe("export ORACLE_REMOTE_TOKEN=<token>");
    expect(isHealthyReport(report)).toBe(false);
  });

  test("unreachable when TCP fails", async () => {
    checkTcpConnection.mockResolvedValueOnce({ ok: false, error: "ECONNREFUSED" });
    const { report, probe } = await buildRemoteEndpointReport({
      resolved: resolvedConfig(),
      env: { ORACLE_REMOTE_HOST: "h", ORACLE_REMOTE_TOKEN: "t" },
    });
    expect(report.status).toBe("unreachable");
    expect(report.error).toBe("ECONNREFUSED");
    expect(probe.tcp).toEqual({ ok: false, error: "ECONNREFUSED" });
    expect(probe.health).toBeUndefined();
    expect(isHealthyReport(report)).toBe(false);
  });

  test("auth_failed when /health rejects the token", async () => {
    checkRemoteHealth.mockResolvedValueOnce({
      ok: false,
      statusCode: 401,
      error: "Unauthorized",
    });
    const { report } = await buildRemoteEndpointReport({
      resolved: resolvedConfig(),
      env: { ORACLE_REMOTE_HOST: "h", ORACLE_REMOTE_TOKEN: "t" },
    });
    expect(report.status).toBe("auth_failed");
    expect(report.error).toBe("HTTP 401 (Unauthorized)");
  });

  test("auth_failed with no status code carries the raw error", async () => {
    checkRemoteHealth.mockResolvedValueOnce({
      ok: false,
      error: "socket hang up",
    });
    const { report } = await buildRemoteEndpointReport({
      resolved: resolvedConfig(),
      env: { ORACLE_REMOTE_HOST: "h", ORACLE_REMOTE_TOKEN: "t" },
    });
    expect(report.status).toBe("auth_failed");
    expect(report.error).toBe("socket hang up");
  });

  test("busy when auth succeeds but the single-flight lane is occupied", async () => {
    checkRemoteHealth.mockResolvedValueOnce({
      ok: false,
      statusCode: 409,
      error: "busy",
      busy: true,
      version: "9.9.9",
      uptimeSeconds: 43,
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
    const { report } = await buildRemoteEndpointReport({
      resolved: resolvedConfig(),
      env: { ORACLE_REMOTE_HOST: "h", ORACLE_REMOTE_TOKEN: "t" },
    });
    expect(report.status).toBe("busy");
    expect(report.busy).toBe(true);
    expect(report.version).toBe("9.9.9");
    expect(report.uptimeSeconds).toBe(43);
    expect(report.activeRun).toMatchObject({
      id: "run-1",
      clientConnected: false,
      sessionId: "session-1",
      desiredModel: "gpt-5.5-pro",
    });
    expect(report.error).toBe("HTTP 409 (busy)");
    expect(isHealthyReport(report)).toBe(false);
  });

  test("healthy populates version, uptime, auth_profile_id_hash and provider_locks", async () => {
    const { report } = await buildRemoteEndpointReport({
      resolved: resolvedConfig(),
      env: { ORACLE_REMOTE_HOST: "h", ORACLE_REMOTE_TOKEN: "t" },
    });
    expect(report.status).toBe("healthy");
    expect(report.version).toBe("9.9.9");
    expect(report.uptimeSeconds).toBe(42);
    expect(report.auth_profile_id_hash).toBe("auth-hash");
    expect(report.provider_locks).toEqual([
      "browser:shared-profile:chatgpt",
      "browser:shared-profile:gemini",
    ]);
    expect(isHealthyReport(report)).toBe(true);
  });

  test("probe=false emits a config-only snapshot with status=unknown", async () => {
    const { report, probe } = await buildRemoteEndpointReport({
      resolved: resolvedConfig(),
      probe: false,
      env: { ORACLE_REMOTE_HOST: "h", ORACLE_REMOTE_TOKEN: "t" },
    });
    expect(report.status).toBe("unknown");
    expect(probe).toEqual({});
    expect(checkTcpConnection).not.toHaveBeenCalled();
    expect(checkRemoteHealth).not.toHaveBeenCalled();
  });
});

describe("buildRemoteEndpointReport — token redaction", () => {
  test("never embeds the raw token in the report", async () => {
    const { report } = await buildRemoteEndpointReport({
      resolved: resolvedConfig({ token: "SHHHH-very-secret-321" }),
      env: { ORACLE_REMOTE_HOST: "h", ORACLE_REMOTE_TOKEN: "SHHHH-very-secret-321" },
    });
    const serialised = JSON.stringify(report);
    expect(serialised).not.toContain("SHHHH-very-secret-321");
    expect(report.no_plaintext_secrets).toBe(true);
    expect(report.token_env).toBe("ORACLE_REMOTE_TOKEN");
  });

  test("token_env reflects the env var name only, never the value", async () => {
    const { report } = await buildRemoteEndpointReport({
      resolved: resolvedConfig(),
      tokenEnvName: "MY_TOKEN_VAR",
      env: { ORACLE_REMOTE_HOST: "h", MY_TOKEN_VAR: "another-secret" },
    });
    expect(report.token_env).toBe("MY_TOKEN_VAR");
    expect(JSON.stringify(report)).not.toContain("another-secret");
  });

  test("token_env is null when the env var is unset", async () => {
    const { report } = await buildRemoteEndpointReport({
      resolved: resolvedConfig(),
      env: { ORACLE_REMOTE_HOST: "h" },
    });
    expect(report.token_env).toBeNull();
  });

  test("reportLeaksToken catches raw-token smuggling", async () => {
    const { report } = await buildRemoteEndpointReport({
      resolved: resolvedConfig({ token: "tkn-1" }),
      env: { ORACLE_REMOTE_HOST: "h", ORACLE_REMOTE_TOKEN: "tkn-1" },
    });
    expect(reportLeaksToken(report, "tkn-1")).toBe(false);
    const leaky = { ...report, error: "got tkn-1 back" } as typeof report;
    expect(reportLeaksToken(leaky, "tkn-1")).toBe(true);
    expect(reportLeaksToken(report, undefined)).toBe(false);
  });
});

describe("buildRemoteEndpointReport — common envelope fields", () => {
  test("always populates the v18 envelope keys", async () => {
    const { report } = await buildRemoteEndpointReport({
      resolved: resolvedConfig(),
      env: { ORACLE_REMOTE_HOST: "h", ORACLE_REMOTE_TOKEN: "t" },
    });
    expect(report._schema).toBe("remote_browser_endpoint.v1");
    expect(typeof report.endpoint_id).toBe("string");
    expect(["preferred", "required", "off"]).toContain(report.mode);
    expect(report.no_plaintext_secrets).toBe(true);
    expect(typeof report.shared_profile_policy).toBe("boolean");
    expect(Array.isArray(report.provider_locks)).toBe(true);
    expect(report.doctor_command).toMatch(/^oracle remote doctor/);
    expect(report.recover_command).toMatch(/^oracle/);
  });

  test("endpoint_id falls back to 'local' when no host hash is available", async () => {
    const { report } = await buildRemoteEndpointReport({
      resolved: resolvedConfig({ host: undefined, hostHash: undefined, token: undefined }),
      env: {},
    });
    expect(report.endpoint_id).toBe("local");
  });
});

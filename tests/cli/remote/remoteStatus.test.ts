// Integration test for `oracle remote status --json`.
// status must NOT touch the network.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { loadUserConfig } = vi.hoisted(() => ({
  loadUserConfig: vi.fn(async () => ({
    config: {},
    path: "/mock/config.json",
    loaded: true,
  })),
}));

const { resolveRemoteServiceConfig } = vi.hoisted(() => ({
  resolveRemoteServiceConfig: vi.fn(() => ({
    host: "remote.test:9473",
    token: "secret-token-shhh",
    mode: "preferred",
    hostHash: "abcdef012345",
    redactedToken: "***",
    sources: { host: "env", token: "env", mode: "default" },
  })),
}));

const { checkTcpConnection, checkRemoteHealth } = vi.hoisted(() => ({
  checkTcpConnection: vi.fn(),
  checkRemoteHealth: vi.fn(),
}));

vi.mock("../../../src/config.js", () => ({ loadUserConfig }));
vi.mock("../../../src/remote/remoteServiceConfig.js", () => ({ resolveRemoteServiceConfig }));
vi.mock("../../../src/remote/health.js", () => ({ checkTcpConnection, checkRemoteHealth }));

import { runRemoteStatus } from "../../../src/cli/remote/status.js";

describe("runRemoteStatus --json", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let originalExitCode: typeof process.exitCode;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    originalExitCode = process.exitCode;
    process.exitCode = undefined;
    process.env.ORACLE_REMOTE_HOST = "remote.test:9473";
    process.env.ORACLE_REMOTE_TOKEN = "secret-token-shhh";
    vi.clearAllMocks();
  });

  afterEach(() => {
    logSpy.mockRestore();
    process.exitCode = originalExitCode;
    delete process.env.ORACLE_REMOTE_HOST;
    delete process.env.ORACLE_REMOTE_TOKEN;
  });

  test("does not touch the network", async () => {
    await runRemoteStatus({ json: true });
    expect(checkTcpConnection).not.toHaveBeenCalled();
    expect(checkRemoteHealth).not.toHaveBeenCalled();
  });

  test("emits the v18 envelope with status=unknown (no probe)", async () => {
    await runRemoteStatus({ json: true });
    const out = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(out._schema).toBe("remote_browser_endpoint.v1");
    expect(out.status).toBe("unknown");
    expect(out.endpoint_id).toBe("abcdef012345");
    expect(out.host_env).toBe("ORACLE_REMOTE_HOST");
    expect(out.token_env).toBe("ORACLE_REMOTE_TOKEN");
    expect(out.no_plaintext_secrets).toBe(true);
  });

  test("never prints the raw token", async () => {
    await runRemoteStatus({ json: true });
    expect(logSpy.mock.calls[0][0]).not.toContain("secret-token-shhh");
  });

  test("human output redacts the token", async () => {
    await runRemoteStatus({});
    const all = logSpy.mock.calls.map((args: unknown[]) => String(args[0])).join("\n");
    expect(all).not.toContain("secret-token-shhh");
    expect(all).toContain("***");
  });
});

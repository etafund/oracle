// Regression: oracle remote doctor/status/attach CLI surfaces must
// never echo raw tokens, cookies, or auth headers to stdout/stderr,
// regardless of where the secret entered the system (env var, config,
// --host, --token-env). The remote host itself is operator-facing
// diagnostic data and is permitted in human output; the JSON envelope
// emits only `host_hash`, not the raw host string.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { assertNoLeaks } from "../../_helpers/secretLeakDetector.js";

interface MockResolved {
  host: string | undefined;
  token: string | undefined;
  mode: "preferred" | "required" | "off";
  hostHash: string | undefined;
  redactedToken: string | undefined;
  sources: { host: string; token: string; mode: string };
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

const { loadUserConfig } = vi.hoisted(() => ({
  loadUserConfig: vi.fn(async () => ({
    config: {},
    path: "/mock/config.json",
    loaded: true,
  })),
}));

const { resolveRemoteServiceConfig } = vi.hoisted(() => ({
  resolveRemoteServiceConfig: vi.fn<(input?: { cliHost?: string; cliToken?: string }) => MockResolved>(),
}));

const { checkTcpConnection, checkRemoteHealth } = vi.hoisted(() => ({
  checkTcpConnection: vi.fn<() => Promise<{ ok: boolean; error?: string }>>(),
  checkRemoteHealth: vi.fn<() => Promise<MockHealth>>(),
}));

vi.mock("../../../src/config.js", () => ({ loadUserConfig }));
vi.mock("../../../src/remote/remoteServiceConfig.js", () => ({ resolveRemoteServiceConfig }));
vi.mock("../../../src/remote/health.js", () => ({ checkTcpConnection, checkRemoteHealth }));

// Secret-shaped fakes that must NEVER appear in any output (machine or
// human). The host is intentionally NOT in this list — the bead spec
// lists cookies/account email/auth headers/raw DOM/screenshots/prompt
// text/output text/plaintext tokens; the remote host is operator-facing
// diagnostic data that the human surface is allowed to print.
const FAKES = [
  { name: "oracle-remote-token", value: "fake-remote-token-Z9y8X7w6V5" },
  { name: "openai-leak", value: "sk-fake-9876543210zyxwvutsrqponm" },
  { name: "session-cookie", value: "session=PHPSESSID-leak-me-please" },
];
const REMOTE_HOST = "10.0.0.42:9473";

function setHappyPathMocks() {
  resolveRemoteServiceConfig.mockReturnValue({
    host: REMOTE_HOST,
    token: FAKES[0].value,
    mode: "preferred",
    hostHash: "abcdef012345",
    redactedToken: "***",
    sources: { host: "env", token: "env", mode: "default" },
  });
  checkTcpConnection.mockResolvedValue({ ok: true });
  checkRemoteHealth.mockResolvedValue({
    ok: true,
    version: "1.2.3",
    uptimeSeconds: 9001,
    authProfileIdHash: "auth-hash",
    providerLocks: ["browser:shared-profile:chatgpt", "browser:shared-profile:gemini"],
  });
}

describe("oracle remote doctor — no secret leak", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let originalExitCode: typeof process.exitCode;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    originalExitCode = process.exitCode;
    process.exitCode = undefined;
    vi.clearAllMocks();
    process.env.ORACLE_REMOTE_HOST = REMOTE_HOST;
    process.env.ORACLE_REMOTE_TOKEN = FAKES[0].value;
    setHappyPathMocks();
  });

  afterEach(() => {
    logSpy.mockRestore();
    process.exitCode = originalExitCode;
    delete process.env.ORACLE_REMOTE_HOST;
    delete process.env.ORACLE_REMOTE_TOKEN;
  });

  test("healthy JSON output has no literal token / pattern leaks", async () => {
    const { runRemoteDoctor } = await import("../../../src/cli/remote/doctor.js");
    await runRemoteDoctor({ json: true });
    const raw = String(logSpy.mock.calls[0][0]);
    assertNoLeaks(raw, { fakes: FAKES });
  });

  test("healthy human output has no literal token leaks", async () => {
    const { runRemoteDoctor } = await import("../../../src/cli/remote/doctor.js");
    await runRemoteDoctor({ json: false });
    const raw = logSpy.mock.calls.map((args: unknown[]) => String(args[0])).join("\n");
    assertNoLeaks(raw, { fakes: FAKES });
  });

  test("auth_failed path does not leak the token in error detail", async () => {
    checkRemoteHealth.mockResolvedValueOnce({ ok: false, statusCode: 401, error: "Unauthorized" });
    const { runRemoteDoctor } = await import("../../../src/cli/remote/doctor.js");
    await runRemoteDoctor({ json: true });
    const raw = String(logSpy.mock.calls[0][0]);
    assertNoLeaks(raw, { fakes: FAKES });
    expect(raw).toContain("auth_failed");
  });

  test("unreachable path does not leak the token", async () => {
    checkTcpConnection.mockResolvedValueOnce({ ok: false, error: "ECONNREFUSED" });
    const { runRemoteDoctor } = await import("../../../src/cli/remote/doctor.js");
    await runRemoteDoctor({ json: true });
    const raw = String(logSpy.mock.calls[0][0]);
    assertNoLeaks(raw, { fakes: FAKES });
  });
});

describe("oracle remote status — no secret leak", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let originalExitCode: typeof process.exitCode;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    originalExitCode = process.exitCode;
    process.exitCode = undefined;
    vi.clearAllMocks();
    process.env.ORACLE_REMOTE_HOST = REMOTE_HOST;
    process.env.ORACLE_REMOTE_TOKEN = FAKES[0].value;
    setHappyPathMocks();
  });

  afterEach(() => {
    logSpy.mockRestore();
    process.exitCode = originalExitCode;
    delete process.env.ORACLE_REMOTE_HOST;
    delete process.env.ORACLE_REMOTE_TOKEN;
  });

  test("JSON status output has no leaks (and skips the network probe)", async () => {
    const { runRemoteStatus } = await import("../../../src/cli/remote/status.js");
    await runRemoteStatus({ json: true });
    const raw = String(logSpy.mock.calls[0][0]);
    assertNoLeaks(raw, { fakes: FAKES });
    expect(checkRemoteHealth).not.toHaveBeenCalled();
    expect(checkTcpConnection).not.toHaveBeenCalled();
  });

  test("human status output redacts the token while still naming the env var", async () => {
    const { runRemoteStatus } = await import("../../../src/cli/remote/status.js");
    await runRemoteStatus({});
    const raw = logSpy.mock.calls.map((args: unknown[]) => String(args[0])).join("\n");
    assertNoLeaks(raw, { fakes: FAKES });
    expect(raw).toContain("***");
  });
});

describe("oracle remote attach — no secret leak", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let originalExitCode: typeof process.exitCode;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    originalExitCode = process.exitCode;
    process.exitCode = undefined;
    vi.clearAllMocks();
    // resolveRemoteServiceConfig is called with the CLI args. Mirror that
    // back so the test surface looks realistic.
    resolveRemoteServiceConfig.mockImplementation((input) => {
      const cliHost = input?.cliHost;
      const cliToken = input?.cliToken;
      return {
        host: cliHost,
        token: cliToken,
        mode: "preferred",
        hostHash: cliHost ? "cli-host-hash-1234" : undefined,
        redactedToken: cliToken ? "***" : undefined,
        sources: { host: "cli", token: "cli", mode: "cli" },
      };
    });
    checkTcpConnection.mockResolvedValue({ ok: true });
    checkRemoteHealth.mockResolvedValue({
      ok: true,
      version: "1.0.0",
      uptimeSeconds: 7,
      authProfileIdHash: "auth-hash",
      providerLocks: ["browser:shared-profile:chatgpt"],
    });
  });

  afterEach(() => {
    logSpy.mockRestore();
    process.exitCode = originalExitCode;
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("ORACLE_LEAK_TEST_TOKEN_")) delete process.env[key];
    }
  });

  test("JSON attach output never echoes the raw token even when env carries it", async () => {
    process.env.ORACLE_LEAK_TEST_TOKEN_A = FAKES[0].value;
    const { runRemoteAttach } = await import("../../../src/cli/remote/attach.js");
    await runRemoteAttach({
      host: REMOTE_HOST,
      tokenEnv: "ORACLE_LEAK_TEST_TOKEN_A",
      json: true,
    });
    const raw = String(logSpy.mock.calls[0][0]);
    assertNoLeaks(raw, { fakes: FAKES });
  });

  test("human attach output never echoes the raw token", async () => {
    process.env.ORACLE_LEAK_TEST_TOKEN_B = FAKES[0].value;
    const { runRemoteAttach } = await import("../../../src/cli/remote/attach.js");
    await runRemoteAttach({
      host: REMOTE_HOST,
      tokenEnv: "ORACLE_LEAK_TEST_TOKEN_B",
    });
    const raw = logSpy.mock.calls.map((args: unknown[]) => String(args[0])).join("\n");
    assertNoLeaks(raw, { fakes: FAKES });
  });

  test("auth_failed path on attach still does not leak the token", async () => {
    process.env.ORACLE_LEAK_TEST_TOKEN_C = FAKES[0].value;
    checkRemoteHealth.mockResolvedValueOnce({ ok: false, statusCode: 401, error: "Unauthorized" });
    const { runRemoteAttach } = await import("../../../src/cli/remote/attach.js");
    await runRemoteAttach({
      host: REMOTE_HOST,
      tokenEnv: "ORACLE_LEAK_TEST_TOKEN_C",
      json: true,
    });
    const raw = String(logSpy.mock.calls[0][0]);
    assertNoLeaks(raw, { fakes: FAKES });
  });

  test("envelopes carry env-var NAME never VALUE", async () => {
    process.env.ORACLE_LEAK_TEST_TOKEN_D = FAKES[0].value;
    const { runRemoteAttach } = await import("../../../src/cli/remote/attach.js");
    await runRemoteAttach({
      host: REMOTE_HOST,
      tokenEnv: "ORACLE_LEAK_TEST_TOKEN_D",
      json: true,
    });
    const raw = String(logSpy.mock.calls[0][0]);
    const parsed = JSON.parse(raw) as { token_env: string | null };
    expect(parsed.token_env).toBe("ORACLE_LEAK_TEST_TOKEN_D");
    expect(raw).not.toContain(FAKES[0].value);
  });
});

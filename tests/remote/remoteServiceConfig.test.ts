import { describe, expect, it } from "vitest";
import { resolveRemoteServiceConfig } from "../../src/remote/remoteServiceConfig.js";

describe("resolveRemoteServiceConfig", () => {
  it("prefers ENV values over CLI and config", () => {
    const env = {} as NodeJS.ProcessEnv;
    // biome-ignore lint/complexity/useLiteralKeys: env var names are uppercase with underscores
    env["ORACLE_REMOTE_HOST"] = "env:4";
    // biome-ignore lint/complexity/useLiteralKeys: env var names are uppercase with underscores
    env["ORACLE_REMOTE_TOKEN"] = "env-token";

    const resolved = resolveRemoteServiceConfig({
      cliHost: "cli:1",
      cliToken: "cli-token",
      userConfig: {
        browser: { remoteHost: "config:2", remoteToken: "config-token" },
      },
      env,
    });

    expect(resolved.host).toBe("env:4");
    expect(resolved.token).toBe("env-token");
    expect(resolved.sources.host).toBe("env");
    expect(resolved.sources.token).toBe("env");
  });

  it("prefers CLI over config when env is missing", () => {
    const resolved = resolveRemoteServiceConfig({
      cliHost: "cli:1",
      cliToken: "cli-token",
      userConfig: {
        browser: { remoteHost: "config:2", remoteToken: "config-token" },
      },
      env: {},
    });

    expect(resolved.host).toBe("cli:1");
    expect(resolved.token).toBe("cli-token");
    expect(resolved.sources.host).toBe("cli");
    expect(resolved.sources.token).toBe("cli");
  });

  it("prefers browser.remoteHost/browser.remoteToken when env and cli are missing", () => {
    const resolved = resolveRemoteServiceConfig({
      userConfig: {
        browser: { remoteHost: "cfg:9473", remoteToken: "cfg-token" },
      },
      env: {} as NodeJS.ProcessEnv,
    });

    expect(resolved.host).toBe("cfg:9473");
    expect(resolved.token).toBe("cfg-token");
    expect(resolved.sources.host).toBe("config.browser");
    expect(resolved.sources.token).toBe("config.browser");
  });

  it("ignores config if mode is 'off'", () => {
    const resolved = resolveRemoteServiceConfig({
      cliHost: "cli:1",
      cliMode: "off",
      env: {},
    });

    expect(resolved.host).toBeUndefined();
    expect(resolved.token).toBeUndefined();
    expect(resolved.mode).toBe("off");
  });

  it("throws if mode is 'required' but no host is configured", () => {
    expect(() => resolveRemoteServiceConfig({ cliMode: "required", env: {} })).toThrow(
      /remote_browser_endpoint_missing/,
    );
  });

  it("throws if host is configured but no token is provided", () => {
    expect(() => resolveRemoteServiceConfig({ cliHost: "host:123", env: {} })).toThrow(
      /remote_browser_token_missing/,
    );
  });

  it("can preserve missing-token endpoint state for diagnostic commands", () => {
    const resolved = resolveRemoteServiceConfig({
      cliHost: "host:123",
      env: {},
      allowMissingToken: true,
    });

    expect(resolved.host).toBe("host:123");
    expect(resolved.token).toBeUndefined();
    expect(resolved.redactedToken).toBeUndefined();
    expect(resolved.sources.host).toBe("cli");
    expect(resolved.sources.token).toBe("unset");
  });

  it("provides hostHash and redactedToken for safe logging", () => {
    const resolved = resolveRemoteServiceConfig({
      cliHost: "secret-host.com:9222",
      cliToken: "super-secret-token",
      env: {},
    });

    expect(resolved.hostHash).toBeDefined();
    expect(resolved.hostHash?.length).toBe(12); // SHA-256 hex truncated to 12 chars
    expect(resolved.redactedToken).toBe("***");
    expect(resolved.token).toBe("super-secret-token");
  });
});

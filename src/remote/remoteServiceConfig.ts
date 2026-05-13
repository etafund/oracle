import type { UserConfig } from "../config.js";
import { createHash } from "node:crypto";

export type RemoteServiceConfigSource = "cli" | "config.browser" | "env" | "unset" | "default";

export type RemoteBrowserMode = "preferred" | "required" | "off";

export interface ResolvedRemoteServiceConfig {
  host?: string;
  token?: string;
  mode: RemoteBrowserMode;
  hostHash?: string;
  redactedToken?: string;
  sources: {
    host: RemoteServiceConfigSource;
    token: RemoteServiceConfigSource;
    mode: RemoteServiceConfigSource;
  };
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : undefined;
}

function normalizeMode(value: unknown): RemoteBrowserMode | undefined {
  const norm = normalizeString(value)?.toLowerCase();
  if (norm === "preferred" || norm === "required" || norm === "off") {
    return norm as RemoteBrowserMode;
  }
  return undefined;
}

function hashHost(host: string | undefined): string | undefined {
  if (!host) return undefined;
  return createHash("sha256").update(host).digest("hex").slice(0, 12);
}

function redactToken(token: string | undefined): string | undefined {
  if (!token) return undefined;
  return "***";
}

export function resolveRemoteServiceConfig({
  cliHost,
  cliToken,
  cliMode,
  userConfig,
  env = process.env,
}: {
  cliHost?: string;
  cliToken?: string;
  cliMode?: string;
  userConfig?: UserConfig;
  env?: NodeJS.ProcessEnv;
}): ResolvedRemoteServiceConfig {
  const configBrowserHost = normalizeString(userConfig?.browser?.remoteHost);
  const configBrowserToken = normalizeString(userConfig?.browser?.remoteToken);
  const configBrowserMode = normalizeMode(userConfig?.browser?.remoteBrowser);

  const envHost = normalizeString(env.ORACLE_REMOTE_HOST);
  const envToken = normalizeString(env.ORACLE_REMOTE_TOKEN);
  const envMode = normalizeMode(env.ORACLE_REMOTE_BROWSER);

  const cliHostValue = normalizeString(cliHost);
  const cliTokenValue = normalizeString(cliToken);
  const cliModeValue = normalizeMode(cliMode);

  let host = envHost ?? cliHostValue ?? configBrowserHost;
  let token = envToken ?? cliTokenValue ?? configBrowserToken;
  const mode = envMode ?? cliModeValue ?? configBrowserMode ?? "preferred";

  if (mode === "off") {
    host = undefined;
    token = undefined;
  } else if (mode === "required" && !host) {
    throw new Error(
      "remote_browser_endpoint_missing: --remote-browser=required but no remote host is configured.",
    );
  }

  if (host && !token && mode !== "off") {
    throw new Error(
      "remote_browser_token_missing: A remote host is configured but no token was provided.\n" +
        "Fix command: oracle config set browser.remoteToken <token>\n" +
        "Next command: export ORACLE_REMOTE_TOKEN=<token>",
    );
  }

  const hostSource: RemoteServiceConfigSource = envHost
    ? "env"
    : cliHostValue
      ? "cli"
      : configBrowserHost
        ? "config.browser"
        : "unset";

  const tokenSource: RemoteServiceConfigSource = envToken
    ? "env"
    : cliTokenValue
      ? "cli"
      : configBrowserToken
        ? "config.browser"
        : "unset";

  const modeSource: RemoteServiceConfigSource = envMode
    ? "env"
    : cliModeValue
      ? "cli"
      : configBrowserMode
        ? "config.browser"
        : "default";

  return {
    host,
    token,
    mode,
    hostHash: hashHost(host),
    redactedToken: redactToken(token),
    sources: { host: hostSource, token: tokenSource, mode: modeSource },
  };
}

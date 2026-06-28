// Shared builder for the `remote_browser_endpoint.v1`-compatible JSON
// report that `oracle remote doctor|status|attach` and
// `oracle bridge doctor --json` all emit.
//
// The wire shape is the existing `RemoteBrowserEndpointV1` type from
// `src/remote/types.ts` (already exercised by tests/cli/remote/doctor.test.ts
// and tests/bridge/doctor.test.ts). Token redaction is enforced here:
// no caller of this module may inject a raw token into the output.

import { checkRemoteHealth, checkTcpConnection } from "../../remote/health.js";
import type { ResolvedRemoteServiceConfig } from "../../remote/remoteServiceConfig.js";
import type { RemoteActiveRunInfo, RemoteBrowserEndpointV1 } from "../../remote/types.js";
import { getCliVersion } from "../../version.js";

/**
 * Status values the report can emit. The wider union (including
 * `not_configured`) is in `RemoteBrowserEndpointV1`; this re-export keeps
 * the spec close to the call sites.
 */
export type RemoteEndpointStatus = RemoteBrowserEndpointV1["status"];

/**
 * Outcome of a single probe step. Exposed for callers that want to log
 * the per-step results in verbose mode without re-running the probe.
 */
export interface RemoteEndpointProbe {
  tcp?: { ok: boolean; error?: string };
  health?: {
    ok: boolean;
    statusCode?: number;
    error?: string;
    version?: string;
    uptimeSeconds?: number;
    authProfileIdHash?: string;
    providerLocks?: string[];
    busy?: boolean;
    activeRun?: RemoteActiveRunInfo;
  };
}

export interface BuildRemoteEndpointReportInput {
  resolved: ResolvedRemoteServiceConfig;
  /**
   * Skip the TCP+/health probe and emit a config-only snapshot. Used by
   * `oracle remote status --json`. Defaults to false.
   */
  probe?: boolean;
  /** TCP-probe timeout (ms). Defaults to 2000. */
  tcpTimeoutMs?: number;
  /** Health-check timeout (ms). Defaults to 5000. */
  healthTimeoutMs?: number;
  /**
   * The `host_env` value to emit in the JSON. Defaults to the process
   * env value of `ORACLE_REMOTE_HOST`. Passed explicitly by `remote
   * attach` so it can record the user-supplied override.
   */
  hostEnvName?: string;
  /** Same idea for the token env variable. */
  tokenEnvName?: string;
  /** Process env to consult for default values. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

const DEFAULT_HOST_ENV_NAME = "ORACLE_REMOTE_HOST";
const DEFAULT_TOKEN_ENV_NAME = "ORACLE_REMOTE_TOKEN";

/**
 * Build the wire-shape report and attach a parallel probe summary.
 *
 * Status precedence:
 *   1. `not_configured` — no host resolved.
 *   2. `missing_token`  — host but no token.
 *   3. `unreachable`    — TCP probe failed.
 *   4. `auth_failed`    — /health rejected the token.
 *   5. `busy`           — auth succeeded but the single-flight lane is occupied.
 *   6. `healthy`        — /health succeeded.
 *   7. `unknown`        — probe was skipped.
 *
 * Exit-code policy (caller-side): only `healthy` and `not_configured`
 * count as success. `not_configured` is success because the user may
 * intentionally run Oracle entirely locally.
 */
export async function buildRemoteEndpointReport(
  input: BuildRemoteEndpointReportInput,
): Promise<{ report: RemoteBrowserEndpointV1; probe: RemoteEndpointProbe }> {
  const env = input.env ?? process.env;
  const resolved = input.resolved;
  const probe: RemoteEndpointProbe = {};

  const hostEnvName = input.hostEnvName ?? DEFAULT_HOST_ENV_NAME;
  const tokenEnvName = input.tokenEnvName ?? DEFAULT_TOKEN_ENV_NAME;

  const report: RemoteBrowserEndpointV1 = {
    _schema: "remote_browser_endpoint.v1",
    endpoint_id: resolved.hostHash || "local",
    mode: resolved.mode,
    status: "unknown",
    host_env: env[hostEnvName] ? hostEnvName : null,
    // Never put the raw token in the report; we record whether the env
    // var was set and use the env-var *name*, not its value.
    token_env: env[tokenEnvName] ? tokenEnvName : null,
    host_hash: resolved.hostHash ?? null,
    auth_profile_id_hash: null,
    no_plaintext_secrets: true,
    shared_profile_policy: true,
    provider_locks: [],
    doctor_command: "oracle remote doctor --json",
    recover_command: "oracle remote doctor --json",
    version: null,
    uptimeSeconds: null,
  };

  if (!resolved.host) {
    report.status = "not_configured";
    return { report, probe };
  }
  if (!resolved.token) {
    report.status = "missing_token";
    report.recover_command = "oracle config set browser.remoteToken <token>";
    return { report, probe };
  }
  if (input.probe === false) {
    // Status-only snapshot: configuration is present but we did not
    // probe the network.
    return { report, probe };
  }

  const tcp = await checkTcpConnection(resolved.host, input.tcpTimeoutMs ?? 2000);
  probe.tcp = tcp;
  if (!tcp.ok) {
    report.status = "unreachable";
    if (tcp.error) report.error = tcp.error;
    return { report, probe };
  }

  const health = await checkRemoteHealth({
    host: resolved.host,
    token: resolved.token,
    timeoutMs: input.healthTimeoutMs ?? 5000,
  });
  probe.health = health;
  if (health.ok) {
    report.status = "healthy";
    applyHealthMetadata(report, health);
    return { report, probe };
  }

  if (health.busy) {
    report.status = "busy";
    applyHealthMetadata(report, health);
    report.busy = true;
    report.activeRun = health.activeRun ?? null;
    if (health.error || health.statusCode) {
      const detail = health.error ?? "remote host is busy";
      report.error = health.statusCode ? `HTTP ${health.statusCode} (${detail})` : detail;
    } else {
      report.error = "remote host is busy";
    }
    return { report, probe };
  }

  report.status = "auth_failed";
  if (health.error || health.statusCode) {
    const detail = health.error ?? "unknown error";
    report.error = health.statusCode ? `HTTP ${health.statusCode} (${detail})` : detail;
  }
  return { report, probe };
}

/** Returns true if the report indicates a successful end-state. */
export function isHealthyReport(report: RemoteBrowserEndpointV1): boolean {
  return report.status === "healthy" || report.status === "not_configured";
}

function applyHealthMetadata(
  report: RemoteBrowserEndpointV1,
  health: RemoteEndpointProbe["health"],
): void {
  if (!health) {
    return;
  }
  report.version = health.version ?? null;
  report.uptimeSeconds = health.uptimeSeconds ?? null;
  report.auth_profile_id_hash = health.authProfileIdHash ?? null;
  report.provider_locks = health.providerLocks ?? [];
}

/**
 * Defensive: scan a serialised report for token-looking material. Used
 * by callers as a last-line guard before printing.
 */
export function reportLeaksToken(
  report: RemoteBrowserEndpointV1,
  rawToken: string | undefined,
): boolean {
  if (!rawToken) return false;
  return JSON.stringify(report).includes(rawToken);
}

/** Add the CLI version onto a report's `meta`-style top-level fields. */
export function annotateClientVersion(report: RemoteBrowserEndpointV1): RemoteBrowserEndpointV1 {
  return { ...report, oracle_version: getCliVersion() } as RemoteBrowserEndpointV1 & {
    oracle_version: string;
  };
}

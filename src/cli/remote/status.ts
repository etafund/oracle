// `oracle remote status [--json]` — config snapshot, no network probe.
//
// Used to inspect what Oracle *thinks* the remote endpoint config is
// (env vs CLI vs user config precedence). Does not touch the network,
// so it is safe to run in CI/preflight checks without false-negative
// `unreachable` alerts.

import chalk from "chalk";

import { loadUserConfig } from "../../config.js";
import { resolveRemoteServiceConfig } from "../../remote/remoteServiceConfig.js";
import {
  annotateClientVersion,
  buildRemoteEndpointReport,
  isHealthyReport,
} from "./endpointReport.js";

export interface RemoteStatusCliOptions {
  json?: boolean;
}

export async function runRemoteStatus(options: RemoteStatusCliOptions): Promise<void> {
  const { config: userConfig } = await loadUserConfig();
  const resolved = resolveRemoteServiceConfig({
    cliHost: undefined,
    cliToken: undefined,
    userConfig,
    env: process.env,
  });

  const { report } = await buildRemoteEndpointReport({ resolved, probe: false });
  const annotated = annotateClientVersion(report);

  if (options.json) {
    console.log(JSON.stringify(annotated, null, 2));
    process.exitCode = isHealthyReport(report) ? 0 : 1;
    return;
  }

  const lines: string[] = [];
  lines.push(chalk.bold("🧿 oracle remote status"));
  lines.push(chalk.dim(`mode: ${report.mode} (${resolved.sources.mode})`));
  lines.push(chalk.dim(`endpoint: ${report.endpoint_id}`));
  lines.push(chalk.dim(`host: ${resolved.host ?? "(unset)"} (${resolved.sources.host})`));
  lines.push(
    chalk.dim(`token: ${resolved.redactedToken ?? "(unset)"} (${resolved.sources.token})`),
  );
  lines.push(chalk.dim(`status: ${report.status}`));
  console.log(lines.join("\n"));
  process.exitCode = isHealthyReport(report) ? 0 : 1;
}

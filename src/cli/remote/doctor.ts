// `oracle remote doctor [--json]` — full health probe (TCP + /health).
//
// Reuses `buildRemoteEndpointReport` for the JSON wire shape so this
// command, `oracle remote status`, `oracle remote attach`, and
// `oracle bridge doctor --json` all emit identical envelopes.

import chalk from "chalk";

import { loadUserConfig } from "../../config.js";
import { resolveRemoteServiceConfig } from "../../remote/remoteServiceConfig.js";
import {
  annotateClientVersion,
  buildRemoteEndpointReport,
  isHealthyReport,
} from "./endpointReport.js";

export interface RemoteDoctorCliOptions {
  json?: boolean;
  verbose?: boolean;
}

export async function runRemoteDoctor(options: RemoteDoctorCliOptions): Promise<void> {
  const { config: userConfig } = await loadUserConfig({ degradeOnUserConfigError: true });
  const resolved = resolveRemoteServiceConfig({
    cliHost: undefined,
    cliToken: undefined,
    userConfig,
    env: process.env,
    allowMissingToken: true,
  });

  const { report, probe } = await buildRemoteEndpointReport({ resolved });
  const annotated = annotateClientVersion(report);

  if (options.json) {
    console.log(JSON.stringify(annotated, null, 2));
    process.exitCode = isHealthyReport(report) ? 0 : 1;
    return;
  }

  const lines: string[] = [];
  lines.push(chalk.bold(`🧿 oracle remote doctor`));
  lines.push(chalk.dim(`mode: ${report.mode}`));
  lines.push(chalk.dim(`endpoint: ${report.endpoint_id}`));
  lines.push(chalk.dim(`host_env: ${report.host_env ?? "(unset)"}`));
  lines.push(chalk.dim(`token_env: ${report.token_env ?? "(unset)"}`));
  if (probe.tcp) {
    lines.push(
      `TCP connect: ${probe.tcp.ok ? chalk.green("ok") : chalk.red(`failed (${probe.tcp.error ?? "unknown"})`)}`,
    );
  }
  if (probe.health) {
    if (probe.health.ok) {
      const v = probe.health.version ? `oracle ${probe.health.version}` : "ok";
      lines.push(`Auth (/health): ${chalk.green(v)}`);
    } else if (probe.health.busy) {
      const detail = probe.health.error ?? "remote host is busy";
      const suffix = probe.health.statusCode ? `HTTP ${probe.health.statusCode}` : "busy";
      const v = probe.health.version ? `oracle ${probe.health.version}` : "ok";
      lines.push(`Auth (/health): ${chalk.green(v)}`);
      lines.push(`Run availability: ${chalk.yellow(`${suffix} (${detail})`)}`);
      if (probe.health.activeRun) {
        lines.push(chalk.dim(`Active run: ${formatActiveRun(probe.health.activeRun)}`));
      }
    } else {
      const detail = probe.health.error ?? "unknown";
      const suffix = probe.health.statusCode ? `HTTP ${probe.health.statusCode}` : "network";
      lines.push(`Auth (/health): ${chalk.red(`${suffix} (${detail})`)}`);
    }
    const recovery = probe.health.browserRecoveryCompatibility;
    if (recovery) {
      const observed = [
        recovery.protocol ?? "missing protocol",
        recovery.promptPreviewAlgorithm ?? "missing prompt-preview algorithm",
        recovery.promptDomIdentityAlgorithm ?? "missing DOM-identity algorithm",
        recovery.durableClaimLookup === true
          ? "durable claim lookup"
          : "missing durable claim lookup",
      ].join("; ");
      lines.push(
        `Browser recovery: ${recovery.compatible ? chalk.green("compatible") : chalk.red("incompatible")} (${observed})`,
      );
    }
  }
  lines.push(`Status: ${formatStatus(report.status)}`);
  if (report.error) {
    lines.push(chalk.red(`Error: ${report.error}`));
  }
  console.log(lines.join("\n"));
  process.exitCode = isHealthyReport(report) ? 0 : 1;
}

function formatStatus(status: string): string {
  if (status === "healthy" || status === "not_configured") return chalk.green(status);
  if (status === "unknown" || status === "busy") return chalk.yellow(status);
  return chalk.red(status);
}

function formatActiveRun(activeRun: {
  id: string;
  ageSeconds: number;
  clientConnected: boolean;
}): string {
  return `${activeRun.id} age=${activeRun.ageSeconds}s client=${activeRun.clientConnected ? "connected" : "disconnected"}`;
}

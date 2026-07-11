import chalk from "chalk";
import { loadUserConfig } from "../../config.js";
import {
  collectRemoteFleetSlots,
  hashRemoteSlotHost,
  type RemoteSlotTarget,
} from "../../remote/slots.js";
import { resolveRemoteServiceConfig } from "../../remote/remoteServiceConfig.js";
import type { RemoteFleetSlotsV1, RemoteSlotInventorySource } from "../../remote/types.js";
import { stableJsonStringify } from "../errorEnvelope.js";

export interface RemoteSlotsCliOptions {
  json?: boolean;
  host?: string[];
  hosts?: string;
  timeout?: number;
  requireHealthy?: boolean;
}

interface ResolveSlotInventoryResult {
  source: RemoteSlotInventorySource;
  complete: boolean;
  targets: RemoteSlotTarget[];
  notes: string[];
  configuredEndpoint: {
    endpointId: string | null;
    hostHash: string | null;
  };
}

const SLOT_HOSTS_ENV = "ORACLE_REMOTE_SLOT_HOSTS";

export async function runRemoteSlots(options: RemoteSlotsCliOptions): Promise<void> {
  const timeoutMs = typeof options.timeout === "number" ? options.timeout : undefined;
  const { config: userConfig } = await loadUserConfig({ degradeOnUserConfigError: true });
  const resolved = resolveRemoteServiceConfig({
    cliHost: undefined,
    cliToken: undefined,
    userConfig,
    env: process.env,
    allowMissingToken: true,
  });
  const inventory = resolveSlotInventory({
    options,
    resolvedHost: resolved.host,
    resolvedToken: resolved.token,
    resolvedHostHash: resolved.hostHash ?? null,
    env: process.env,
  });
  const report = await collectRemoteFleetSlots({
    targets: inventory.targets,
    inventorySource: inventory.source,
    inventoryComplete: inventory.complete,
    configuredEndpoint: inventory.configuredEndpoint,
    notes: inventory.notes,
    timeoutMs,
  });

  if (options.json) {
    process.stdout.write(stableJsonStringify(report));
  } else {
    process.stdout.write(formatRemoteSlotsHuman(report));
  }

  if (inventory.source === "none" || (options.requireHealthy && report.summary.healthy === 0)) {
    process.exitCode = 1;
  } else {
    process.exitCode = 0;
  }
}

export function resolveSlotInventory({
  options,
  resolvedHost,
  resolvedToken,
  resolvedHostHash,
  env,
}: {
  options: RemoteSlotsCliOptions;
  resolvedHost?: string;
  resolvedToken?: string;
  resolvedHostHash: string | null;
  env: NodeJS.ProcessEnv;
}): ResolveSlotInventoryResult {
  const configuredEndpoint = {
    endpointId: resolvedHostHash ? `endpoint:${resolvedHostHash}` : null,
    hostHash: resolvedHostHash,
  };
  const explicit = [
    ...parseSlotHostList(options.hosts),
    ...(options.host ?? []).flatMap((entry) => parseSlotHostList(entry)),
  ];
  if (explicit.length > 0) {
    return {
      source: "explicit-hosts",
      complete: true,
      targets: attachToken(explicit, resolvedToken),
      notes: [],
      configuredEndpoint,
    };
  }

  const envSlots = parseSlotHostList(env[SLOT_HOSTS_ENV]);
  if (envSlots.length > 0) {
    return {
      source: "env-hosts",
      complete: true,
      targets: attachToken(envSlots, resolvedToken),
      notes: [`slot inventory read from ${SLOT_HOSTS_ENV}`],
      configuredEndpoint,
    };
  }

  if (resolvedHost) {
    return {
      source: "configured-remote",
      complete: false,
      targets: [{ laneId: undefined, host: resolvedHost, token: resolvedToken }],
      notes: [
        "Configured endpoint is treated as one sampled slot. Provide --hosts or ORACLE_REMOTE_SLOT_HOSTS for per-lane fleet visibility.",
      ],
      configuredEndpoint,
    };
  }

  return {
    source: "none",
    complete: false,
    targets: [],
    notes: [],
    configuredEndpoint,
  };
}

export function parseSlotHostList(value: unknown): Array<{ laneId?: string; host: string }> {
  if (typeof value !== "string") return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map(parseSlotHostEntry);
}

export function formatRemoteSlotsHuman(report: RemoteFleetSlotsV1): string {
  const lines: string[] = [];
  lines.push(chalk.bold("🧿 oracle remote slots"));
  lines.push(
    chalk.dim(
      `inventory: ${report.inventory.source} complete=${report.inventory.complete ? "yes" : "no"} healthy=${report.summary.healthy}/${report.summary.total}`,
    ),
  );
  for (const note of report.inventory.notes) {
    lines.push(chalk.dim(`note: ${note}`));
  }
  lines.push("");
  lines.push(
    "LANE                 STATUS                      RUN          AGE    PROGRESS  LEASES  NEXT",
  );
  for (const lane of report.lanes) {
    lines.push(
      [
        pad((lane.lane_id ?? lane.endpoint_id).slice(0, 20), 20),
        pad(lane.status, 27),
        pad(lane.run.run_id ? lane.run.run_id.slice(0, 10) : "-", 12),
        pad(formatSeconds(lane.run.age_seconds), 6),
        pad(formatSeconds(lane.progress.last_progress_age_seconds), 9),
        pad(lane.lease.active_count === null ? "-" : String(lane.lease.active_count), 6),
        lane.next_action.code,
      ].join("  "),
    );
  }
  if (report.problems.length > 0) {
    lines.push("");
    for (const problem of report.problems) {
      lines.push(`${problem.code}: ${problem.message}`);
    }
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function parseSlotHostEntry(entry: string): { laneId?: string; host: string } {
  const equals = entry.indexOf("=");
  if (equals > 0) {
    return normalizeParsedEntry(entry.slice(0, equals), entry.slice(equals + 1));
  }
  const at = entry.indexOf("@");
  if (at > 0) {
    return normalizeParsedEntry(entry.slice(0, at), entry.slice(at + 1));
  }
  return { host: entry };
}

function normalizeParsedEntry(laneId: string, host: string): { laneId?: string; host: string } {
  const normalizedLaneId = laneId.trim();
  return {
    ...(normalizedLaneId ? { laneId: normalizedLaneId } : {}),
    host: host.trim(),
  };
}

function attachToken(
  targets: Array<{ laneId?: string; host: string }>,
  token: string | undefined,
): RemoteSlotTarget[] {
  return targets.map((target) => ({
    ...target,
    token,
  }));
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : `${value}${" ".repeat(width - value.length)}`;
}

function formatSeconds(value: number | null): string {
  if (value === null) return "-";
  if (value < 60) return `${value}s`;
  const minutes = Math.floor(value / 60);
  const seconds = value % 60;
  return seconds === 0 ? `${minutes}m` : `${minutes}m${seconds}s`;
}

export function endpointIdForHost(host: string | undefined): string | null {
  const hash = hashRemoteSlotHost(host);
  return hash ? `endpoint:${hash}` : null;
}

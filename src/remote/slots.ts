import http from "node:http";
import { createHash } from "node:crypto";
import { parseHostPort } from "../bridge/connection.js";
import { parseOracleBuildInfo, type OracleBuildInfo } from "../version.js";
import { REMOTE_FLEET_SLOTS_SCHEMA_VERSION } from "./types.js";
import type {
  RemoteActiveRunInfo,
  RemoteActiveRunPhase,
  RemoteFleetSlotLaneV1,
  RemoteFleetSlotsProblem,
  RemoteFleetSlotsV1,
  RemoteFleetSlotStatus,
  RemoteRunReadinessState,
  RemoteSlotInventorySource,
} from "./types.js";

export interface RemoteSlotTarget {
  laneId?: string;
  host: string;
  token?: string;
  path?: "/ready";
}

export interface CollectRemoteFleetSlotsInput {
  targets: readonly RemoteSlotTarget[];
  inventorySource: RemoteSlotInventorySource;
  inventoryComplete?: boolean;
  configuredEndpoint?: {
    endpointId?: string | null;
    hostHash?: string | null;
  };
  notes?: readonly string[];
  timeoutMs?: number;
  now?: Date;
}

interface RequestRemoteJsonResult {
  statusCode: number;
  json: unknown;
  bodyText: string;
}

interface ParsedReady {
  ok: boolean | null;
  busy: boolean | null;
  state: RemoteRunReadinessState | null;
  reason: string | null;
  identity: {
    accountId: string | null;
    laneId: string | null;
    port: number | null;
  };
  activeRun: RemoteActiveRunInfo | null;
  activeLeaseCount: number | null;
  leaseRegistryReadable: boolean | null;
  lastProgressAgeSeconds: number | null;
  attachOnly: boolean | null;
  chromeReachable: boolean | null;
  chromeOwnerOk: boolean | null;
  cleanupTainted: boolean | null;
  quarantined: boolean | null;
  manifestPresent: boolean | null;
  manifestMatch: boolean | null;
  manifestMismatches: string[];
}

interface ParsedHealth {
  ok: boolean | null;
  busy: boolean | null;
  state: RemoteRunReadinessState | null;
  activeRun: RemoteActiveRunInfo | null;
  version: string | null;
  build: OracleBuildInfo | null;
  reason: string | null;
}

const DEFAULT_TIMEOUT_MS = 3000;
const SECRET_SCAN_PATTERNS = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/i,
  /\bsk-(?:proj-|ant-|or-)?[A-Za-z0-9_-]{8,}\b/,
  /\bxai-[A-Za-z0-9_-]{8,}\b/,
  /\bAIza[0-9A-Za-z_-]{8,}\b/,
  /webSocketDebuggerUrl/i,
  /chromeBrowserWSEndpoint/i,
  /DevToolsActivePort/i,
  /\/Users\//,
  /\/home\//,
  /\\AppData\\/i,
];

export async function collectRemoteFleetSlots(
  input: CollectRemoteFleetSlotsInput,
): Promise<RemoteFleetSlotsV1> {
  const generatedAt = (input.now ?? new Date()).toISOString();
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const problems: RemoteFleetSlotsProblem[] = [];

  if (input.targets.length === 0) {
    const report = buildReport({
      generatedAt,
      inventorySource: input.inventorySource,
      inventoryComplete: false,
      configuredEndpoint: input.configuredEndpoint,
      notes: [
        ...(input.notes ?? []),
        "No configured remote endpoint or explicit slot inventory was provided.",
      ],
      lanes: [
        makeNoTargetLane({
          observedAt: generatedAt,
          status: "not_configured",
          nextAction: {
            code: "configure_lane_inventory",
            message:
              "Configure ORACLE_REMOTE_HOST/ORACLE_REMOTE_TOKEN or pass --host/--hosts for slot visibility.",
          },
        }),
      ],
      problems,
    });
    assertNoSlotSecretLeak(report, input.targets);
    return report;
  }

  const lanes = await Promise.all(
    input.targets.map((target) => probeSlotTarget(target, { timeoutMs, observedAt: generatedAt })),
  );
  const report = buildReport({
    generatedAt,
    inventorySource: input.inventorySource,
    inventoryComplete: input.inventoryComplete ?? input.targets.length > 0,
    configuredEndpoint: input.configuredEndpoint,
    notes: [...(input.notes ?? [])],
    lanes,
    problems,
  });
  assertNoSlotSecretLeak(report, input.targets);
  return report;
}

export async function requestRemoteJson({
  host,
  path,
  token,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}: {
  host: string;
  path: "/ready" | "/health" | "/status";
  token?: string;
  timeoutMs?: number;
}): Promise<RequestRemoteJsonResult> {
  const { hostname, port } = parseHostPort(host);
  const headers: Record<string, string> = { accept: "application/json" };
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }

  return await new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname,
        port,
        path,
        method: "GET",
        headers,
      },
      (res) => {
        res.setEncoding("utf8");
        let body = "";
        res.on("data", (chunk: string) => {
          body += chunk;
        });
        res.on("end", () => {
          const statusCode = res.statusCode ?? 0;
          let json: unknown = null;
          try {
            json = body.length ? JSON.parse(body) : null;
          } catch {
            json = null;
          }
          resolve({ statusCode, json, bodyText: body });
        });
      },
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`timeout after ${timeoutMs}ms`));
    });
    req.on("error", reject);
    req.end();
  });
}

export function hashRemoteSlotHost(host: string | undefined): string | null {
  if (!host) return null;
  return createHash("sha256").update(host).digest("hex").slice(0, 12);
}

async function probeSlotTarget(
  target: RemoteSlotTarget,
  options: { timeoutMs: number; observedAt: string },
): Promise<RemoteFleetSlotLaneV1> {
  const hostHash = hashRemoteSlotHost(target.host);
  const endpointId = safeLabel(target.laneId) ?? `endpoint:${hostHash ?? "unknown"}`;
  const parsedHost = tryParseHostPort(target.host);
  if (!target.token) {
    return makeLane({
      target,
      endpointId,
      hostHash,
      observedAt: options.observedAt,
      port: parsedHost?.port ?? null,
      status: "missing_token",
      httpStatus: null,
      reason: "missing token",
      probeError: null,
      timedOut: false,
      nextAction: {
        code: "set_token",
        message: "Configure ORACLE_REMOTE_TOKEN or a remote token in user config.",
      },
    });
  }

  let ready: RequestRemoteJsonResult | null = null;
  let readyError: Error | null = null;
  try {
    ready = await requestRemoteJson({
      host: target.host,
      path: target.path ?? "/ready",
      token: target.token,
      timeoutMs: options.timeoutMs,
    });
  } catch (error) {
    readyError = error instanceof Error ? error : new Error(String(error));
  }

  if (readyError) {
    const timedOut = readyError.message.includes("timeout after");
    return makeLane({
      target,
      endpointId,
      hostHash,
      observedAt: options.observedAt,
      port: parsedHost?.port ?? null,
      status: "unreachable",
      httpStatus: null,
      reason: sanitizeReason(readyError.message),
      probeError: sanitizeReason(readyError.message),
      timedOut,
      nextAction: {
        code: "check_service_network",
        message: "Check service, host, port, firewall, and router path.",
      },
    });
  }

  if (ready?.statusCode === 401 || ready?.statusCode === 403) {
    return makeLane({
      target,
      endpointId,
      hostHash,
      observedAt: options.observedAt,
      port: parsedHost?.port ?? null,
      status: "auth_failed",
      httpStatus: ready.statusCode,
      reason: sanitizeReason(extractErrorMessage(ready.json)),
      nextAction: {
        code: "fix_token",
        message: "Token rejected; fix remote token env/config/rotation.",
      },
    });
  }

  let health: RequestRemoteJsonResult | null = null;
  if (ready && ready.statusCode !== 401 && ready.statusCode !== 403) {
    try {
      health = await requestRemoteJson({
        host: target.host,
        path: "/health",
        token: target.token,
        timeoutMs: options.timeoutMs,
      });
    } catch {
      health = null;
    }
  }

  const readySupported = Boolean(ready && ready.statusCode !== 404 && ready.statusCode !== 405);
  const healthSupported = Boolean(health && health.statusCode !== 404 && health.statusCode !== 405);
  const parsedReady = readySupported ? parseReadyBody(ready?.json) : null;
  const parsedHealth = healthSupported ? parseHealthBody(health?.json) : null;

  if (!readySupported && parsedHealth) {
    const status = mapLegacyHealthStatus(parsedHealth, health?.statusCode ?? null);
    const lane = makeLane({
      target,
      endpointId,
      hostHash,
      observedAt: options.observedAt,
      port: parsedHost?.port ?? null,
      status,
      httpStatus: health?.statusCode ?? ready?.statusCode ?? null,
      reason: parsedHealth.reason,
      activeRun: parsedHealth.activeRun,
      readinessState: parsedHealth.state,
      version: parsedHealth.version,
      build: parsedHealth.build,
      compatibility: {
        ready_supported: false,
        health_supported: true,
        status_supported: null,
        rich_progress_available: false,
        lease_ttl_available: false,
      },
    });
    lane.next_action = target.laneId
      ? recommendNextAction(lane)
      : {
          code: "configure_lane_inventory",
          message:
            "Configured endpoint did not expose /ready; provide --hosts or ORACLE_REMOTE_SLOT_HOSTS for per-lane visibility.",
        };
    return lane;
  }

  if (!readySupported) {
    return makeLane({
      target,
      endpointId,
      hostHash,
      observedAt: options.observedAt,
      port: parsedHost?.port ?? null,
      status: "legacy",
      httpStatus: ready?.statusCode ?? null,
      reason: "remote worker does not expose /ready",
      compatibility: {
        ready_supported: false,
        health_supported: healthSupported,
        status_supported: null,
        rich_progress_available: false,
        lease_ttl_available: false,
      },
      nextAction: {
        code: "upgrade_worker",
        message: "Upgrade worker for /ready slot visibility.",
      },
    });
  }

  const status = mapReadyStatus(ready?.statusCode ?? null, parsedReady);
  const lane = makeLane({
    target,
    endpointId: safeLabel(parsedReady?.identity.laneId) ?? endpointId,
    hostHash,
    observedAt: options.observedAt,
    accountId: safeLabel(parsedReady?.identity.accountId),
    port: parsedReady?.identity.port ?? parsedHost?.port ?? null,
    status,
    ok: parsedReady?.ok ?? status === "healthy",
    httpStatus: ready?.statusCode ?? null,
    reason: parsedReady?.reason,
    activeRun: parsedReady?.activeRun ?? parsedHealth?.activeRun ?? null,
    readinessState: parsedReady?.state,
    version: parsedHealth?.version ?? null,
    build: parsedHealth?.build ?? null,
    progressAgeSeconds: parsedReady?.lastProgressAgeSeconds ?? null,
    leaseActiveCount: parsedReady?.activeLeaseCount ?? null,
    leaseRegistryReadable: parsedReady?.leaseRegistryReadable ?? null,
    substrate: {
      attach_only: parsedReady?.attachOnly ?? null,
      chrome_reachable: parsedReady?.chromeReachable ?? null,
      chrome_owner_ok: parsedReady?.chromeOwnerOk ?? null,
      cleanup_tainted: parsedReady?.cleanupTainted ?? null,
      quarantined: parsedReady?.quarantined ?? null,
      manifest_present: parsedReady?.manifestPresent ?? null,
      manifest_match: parsedReady?.manifestMatch ?? null,
      manifest_mismatches: parsedReady?.manifestMismatches ?? [],
    },
    compatibility: {
      ready_supported: true,
      health_supported: healthSupported,
      status_supported: null,
      rich_progress_available: parsedReady?.lastProgressAgeSeconds !== null,
      lease_ttl_available: false,
    },
  });
  lane.next_action = recommendNextAction(lane);
  return lane;
}

function buildReport({
  generatedAt,
  inventorySource,
  inventoryComplete,
  configuredEndpoint,
  notes,
  lanes,
  problems,
}: {
  generatedAt: string;
  inventorySource: RemoteSlotInventorySource;
  inventoryComplete: boolean;
  configuredEndpoint?: { endpointId?: string | null; hostHash?: string | null };
  notes: readonly string[];
  lanes: RemoteFleetSlotLaneV1[];
  problems: RemoteFleetSlotsProblem[];
}): RemoteFleetSlotsV1 {
  return {
    _schema: REMOTE_FLEET_SLOTS_SCHEMA_VERSION,
    generated_at: generatedAt,
    no_plaintext_secrets: true,
    inventory: {
      source: inventorySource,
      complete: inventoryComplete,
      configured_endpoint_id: configuredEndpoint?.endpointId ?? null,
      configured_host_hash: configuredEndpoint?.hostHash ?? null,
      notes: [...notes],
    },
    summary: summarizeLanes(lanes),
    lanes: lanes.sort((a, b) => a.endpoint_id.localeCompare(b.endpoint_id)),
    problems,
  };
}

function summarizeLanes(lanes: readonly RemoteFleetSlotLaneV1[]): RemoteFleetSlotsV1["summary"] {
  const summary: RemoteFleetSlotsV1["summary"] = {
    total: lanes.length,
    healthy: 0,
    busy: 0,
    disconnected: 0,
    completed_but_not_finalized: 0,
    wedged: 0,
    substrate_broken: 0,
    unreachable: 0,
    auth_failed: 0,
    missing_token: 0,
    not_configured: 0,
    legacy: 0,
    unknown: 0,
    read_only: true,
  };
  for (const lane of lanes) {
    switch (lane.status) {
      case "healthy":
        summary.healthy += 1;
        break;
      case "busy":
        summary.busy += 1;
        break;
      case "disconnected":
        summary.disconnected += 1;
        break;
      case "completed-but-not-finalized":
        summary.completed_but_not_finalized += 1;
        break;
      case "wedged":
        summary.wedged += 1;
        break;
      case "substrate-broken":
        summary.substrate_broken += 1;
        break;
      case "unreachable":
        summary.unreachable += 1;
        break;
      case "auth_failed":
        summary.auth_failed += 1;
        break;
      case "missing_token":
        summary.missing_token += 1;
        break;
      case "not_configured":
        summary.not_configured += 1;
        break;
      case "legacy":
        summary.legacy += 1;
        break;
      default:
        summary.unknown += 1;
        break;
    }
  }
  return summary;
}

function makeNoTargetLane({
  observedAt,
  status,
  nextAction,
}: {
  observedAt: string;
  status: RemoteFleetSlotStatus;
  nextAction: RemoteFleetSlotLaneV1["next_action"];
}): RemoteFleetSlotLaneV1 {
  return makeLane({
    target: { host: "" },
    endpointId: "not-configured",
    hostHash: null,
    observedAt,
    status,
    httpStatus: null,
    reason: "not configured",
    nextAction,
  });
}

function makeLane({
  target,
  endpointId,
  hostHash,
  observedAt,
  accountId = null,
  port = null,
  status,
  ok = status === "healthy",
  httpStatus,
  reason = null,
  probeError = null,
  timedOut = false,
  activeRun = null,
  readinessState = null,
  version = null,
  build = null,
  progressAgeSeconds = null,
  leaseActiveCount = null,
  leaseRegistryReadable = null,
  substrate,
  compatibility,
  nextAction,
}: {
  target: RemoteSlotTarget;
  endpointId: string;
  hostHash: string | null;
  observedAt: string;
  accountId?: string | null;
  port?: number | null;
  status: RemoteFleetSlotStatus;
  ok?: boolean;
  httpStatus: number | null;
  reason?: string | null;
  probeError?: string | null;
  timedOut?: boolean;
  activeRun?: RemoteActiveRunInfo | null;
  readinessState?: RemoteRunReadinessState | null;
  version?: string | null;
  build?: OracleBuildInfo | null;
  progressAgeSeconds?: number | null;
  leaseActiveCount?: number | null;
  leaseRegistryReadable?: boolean | null;
  substrate?: Partial<RemoteFleetSlotLaneV1["substrate"]>;
  compatibility?: Partial<RemoteFleetSlotLaneV1["compatibility"]>;
  nextAction?: RemoteFleetSlotLaneV1["next_action"];
}): RemoteFleetSlotLaneV1 {
  const run = buildRun(activeRun);
  const lane: RemoteFleetSlotLaneV1 = {
    lane_id: safeLabel(target.laneId) ?? safeLabel(endpointId),
    account_id: accountId,
    endpoint_id: endpointId,
    host_hash: hostHash,
    port,
    status,
    readiness_state: readinessState,
    ok,
    http_status: httpStatus,
    version,
    build,
    observed_at: observedAt,
    reason: sanitizeReason(reason),
    probe: {
      primary_endpoint: compatibility?.ready_supported === false ? "/health" : "/ready",
      fallback_endpoint: compatibility?.health_supported ? "/health" : null,
      read_only: true,
      timed_out: timedOut,
      error: sanitizeReason(probeError),
    },
    run,
    progress: {
      last_progress_age_seconds: finiteNumber(progressAgeSeconds),
      source: progressAgeSeconds === null ? null : "ready.lastProgressAgeSeconds",
    },
    lease: {
      active_count: finiteNumber(leaseActiveCount),
      registry_readable: leaseRegistryReadable,
      ttl_seconds: null,
      ttl_source: null,
    },
    substrate: {
      attach_only: substrate?.attach_only ?? null,
      chrome_reachable: substrate?.chrome_reachable ?? null,
      chrome_owner_ok: substrate?.chrome_owner_ok ?? null,
      cleanup_tainted: substrate?.cleanup_tainted ?? null,
      quarantined: substrate?.quarantined ?? null,
      manifest_present: substrate?.manifest_present ?? null,
      manifest_match: substrate?.manifest_match ?? null,
      manifest_mismatches: substrate?.manifest_mismatches ?? [],
    },
    compatibility: {
      ready_supported: compatibility?.ready_supported ?? true,
      health_supported: compatibility?.health_supported ?? false,
      status_supported: compatibility?.status_supported ?? null,
      rich_progress_available: compatibility?.rich_progress_available ?? false,
      lease_ttl_available: compatibility?.lease_ttl_available ?? false,
    },
    next_action: nextAction ?? {
      code: "inspect",
      message: "Unexpected response; inspect endpoint.",
    },
  };
  return lane;
}

function buildRun(activeRun: RemoteActiveRunInfo | null): RemoteFleetSlotLaneV1["run"] {
  const session = classifySafeSessionId(activeRun?.sessionId);
  return {
    run_id: activeRun?.id ?? null,
    session_id: session.sessionId,
    session_id_hash: session.sessionIdHash,
    session_id_redacted: session.sessionIdRedacted,
    phase: activeRun?.phase ?? null,
    age_seconds: activeRun?.ageSeconds ?? null,
    started_at: activeRun?.startedAt ?? null,
    client_connected: activeRun?.clientConnected ?? null,
    completed_at: activeRun?.completedAt ?? null,
    completed_age_seconds: activeRun?.completedAgeSeconds ?? null,
    prompt_chars: activeRun?.promptChars ?? null,
    desired_model: safePlainString(activeRun?.desiredModel),
  };
}

function parseReadyBody(json: unknown): ParsedReady | null {
  if (!isRecord(json)) return null;
  const identity = isRecord(json.identity) ? json.identity : {};
  const quarantine = isRecord(json.quarantine) ? json.quarantine : {};
  const manifest = isRecord(json.manifest) ? json.manifest : {};
  const cleanupTaint = json.cleanupTaint;
  return {
    ok: typeof json.ok === "boolean" ? json.ok : null,
    busy: typeof json.busy === "boolean" ? json.busy : null,
    state: parseReadinessState(json.state),
    reason: sanitizeReason(typeof json.reason === "string" ? json.reason : null),
    identity: {
      accountId: safeLabel(identity.accountId),
      laneId: safeLabel(identity.laneId),
      port: finiteNumber(identity.port),
    },
    activeRun: parseActiveRun(json.activeRun),
    activeLeaseCount: finiteNumber(json.activeLeaseCount),
    leaseRegistryReadable:
      typeof json.leaseRegistryReadable === "boolean" ? json.leaseRegistryReadable : null,
    lastProgressAgeSeconds: finiteNumber(json.lastProgressAgeSeconds),
    attachOnly: typeof json.attachOnly === "boolean" ? json.attachOnly : null,
    chromeReachable: typeof json.chromeReachable === "boolean" ? json.chromeReachable : null,
    chromeOwnerOk: typeof json.chromeOwnerOk === "boolean" ? json.chromeOwnerOk : null,
    cleanupTainted: cleanupTaint !== null && cleanupTaint !== undefined,
    quarantined: typeof quarantine.quarantined === "boolean" ? quarantine.quarantined : null,
    manifestPresent: typeof manifest.present === "boolean" ? manifest.present : null,
    manifestMatch: typeof manifest.match === "boolean" ? manifest.match : null,
    manifestMismatches: Array.isArray(manifest.mismatches)
      ? manifest.mismatches.filter((entry): entry is string => typeof entry === "string")
      : [],
  };
}

function parseHealthBody(json: unknown): ParsedHealth | null {
  if (!isRecord(json)) return null;
  const version = typeof json.version === "string" ? json.version : null;
  return {
    ok: typeof json.ok === "boolean" ? json.ok : null,
    busy: typeof json.busy === "boolean" ? json.busy : null,
    state: parseReadinessState(json.state),
    activeRun: parseActiveRun(json.activeRun),
    version,
    build: parseOracleBuildInfo(json.build, version ?? "0.0.0") ?? null,
    reason: sanitizeReason(extractErrorMessage(json)),
  };
}

function mapReadyStatus(
  statusCode: number | null,
  ready: ParsedReady | null,
): RemoteFleetSlotStatus {
  if (!ready) {
    if (statusCode === 401 || statusCode === 403) return "auth_failed";
    return "unknown";
  }
  switch (ready.state) {
    case "idle-ready":
      return "healthy";
    case "active-run-client-connected":
      return "busy";
    case "active-run-client-disconnected":
      return "disconnected";
    case "completed-but-not-finalized":
      return "completed-but-not-finalized";
    case "wedged-no-progress":
      return "wedged";
    case "substrate-broken":
      return "substrate-broken";
    default:
      return statusCode === 200 && ready.ok ? "healthy" : "unknown";
  }
}

function mapLegacyHealthStatus(
  health: ParsedHealth,
  statusCode: number | null,
): RemoteFleetSlotStatus {
  if (statusCode === 401 || statusCode === 403) return "auth_failed";
  if (health.state) return mapReadyStatus(statusCode, { ...emptyReady(), ...health });
  if (health.busy) return "busy";
  if (health.ok) return "legacy";
  return "legacy";
}

function emptyReady(): ParsedReady {
  return {
    ok: null,
    busy: null,
    state: null,
    reason: null,
    identity: { accountId: null, laneId: null, port: null },
    activeRun: null,
    activeLeaseCount: null,
    leaseRegistryReadable: null,
    lastProgressAgeSeconds: null,
    attachOnly: null,
    chromeReachable: null,
    chromeOwnerOk: null,
    cleanupTainted: null,
    quarantined: null,
    manifestPresent: null,
    manifestMatch: null,
    manifestMismatches: [],
  };
}

function recommendNextAction(lane: RemoteFleetSlotLaneV1): RemoteFleetSlotLaneV1["next_action"] {
  switch (lane.status) {
    case "healthy":
      return { code: "ready", message: "Lane is ready for work." };
    case "busy":
      return { code: "wait", message: "Run is active; wait or inspect the linked session." };
    case "disconnected":
      return {
        code: "watch_abort",
        message: "Client disconnected; worker should abort and free the lane.",
      };
    case "completed-but-not-finalized":
      return {
        code: "wait_finalize",
        message: "Browser completed; final response/artifacts are still being emitted.",
      };
    case "wedged":
      return {
        code: "drain_and_inspect",
        message: "No progress past wedge threshold; drain this lane and inspect logs.",
      };
    case "substrate-broken":
      if (lane.substrate.chrome_reachable === false) {
        return { code: "start_chrome", message: "Start or repair the dedicated Chrome target." };
      }
      if (lane.substrate.chrome_owner_ok === false) {
        return {
          code: "repair_chrome_owner",
          message: "DevTools endpoint is not owned by the expected profile.",
        };
      }
      if (lane.substrate.quarantined) {
        return {
          code: "manual_quarantine_clear",
          message: "Account is quarantined; human review required before clearing.",
        };
      }
      if (lane.lease.registry_readable === false) {
        return {
          code: "fix_lease_registry",
          message: "Check profile/registry permissions and disk state.",
        };
      }
      return { code: "inspect", message: "Substrate readiness failed; inspect worker logs." };
    case "unreachable":
      return {
        code: "check_service_network",
        message: "Check service, host, port, firewall, and router path.",
      };
    case "auth_failed":
      return {
        code: "fix_token",
        message: "Token rejected; fix remote token env/config/rotation.",
      };
    case "missing_token":
      return { code: "set_token", message: "Configure remote token." };
    case "legacy":
      return { code: "upgrade_worker", message: "Upgrade worker for /ready slot visibility." };
    default:
      return { code: "inspect", message: "Unexpected response; inspect endpoint and logs." };
  }
}

function parseActiveRun(value: unknown): RemoteActiveRunInfo | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.id !== "string" ||
    typeof value.startedAt !== "string" ||
    typeof value.ageSeconds !== "number" ||
    typeof value.clientConnected !== "boolean" ||
    typeof value.promptChars !== "number"
  ) {
    return null;
  }
  const phase = parseActiveRunPhase(value.phase);
  return {
    id: value.id,
    startedAt: value.startedAt,
    ageSeconds: value.ageSeconds,
    clientConnected: value.clientConnected,
    promptChars: value.promptChars,
    ...(phase ? { phase } : {}),
    ...(typeof value.completedAt === "string" ? { completedAt: value.completedAt } : {}),
    ...(typeof value.completedAgeSeconds === "number"
      ? { completedAgeSeconds: value.completedAgeSeconds }
      : {}),
    ...(typeof value.sessionId === "string" ? { sessionId: value.sessionId } : {}),
    ...(typeof value.desiredModel === "string" ? { desiredModel: value.desiredModel } : {}),
  };
}

function parseReadinessState(value: unknown): RemoteRunReadinessState | null {
  if (
    value === "idle-ready" ||
    value === "active-run-client-connected" ||
    value === "active-run-client-disconnected" ||
    value === "completed-but-not-finalized" ||
    value === "wedged-no-progress" ||
    value === "substrate-broken"
  ) {
    return value;
  }
  return null;
}

function parseActiveRunPhase(value: unknown): RemoteActiveRunPhase | null {
  return value === "running" || value === "completed" ? value : null;
}

function classifySafeSessionId(value: string | undefined): {
  sessionId: string | null;
  sessionIdHash: string | null;
  sessionIdRedacted: boolean;
} {
  if (!value) {
    return { sessionId: null, sessionIdHash: null, sessionIdRedacted: false };
  }
  const safe =
    value.length <= 128 &&
    /^[A-Za-z0-9._-]+$/.test(value) &&
    !value.includes("@") &&
    !value.includes("://") &&
    !value.includes("/") &&
    !value.includes("\\") &&
    !/^(sk-|Bearer\s|eyJ)/i.test(value);
  if (safe) {
    return { sessionId: value, sessionIdHash: null, sessionIdRedacted: false };
  }
  return {
    sessionId: null,
    sessionIdHash: `sha256:${createHash("sha256").update(value).digest("hex").slice(0, 12)}`,
    sessionIdRedacted: true,
  };
}

function assertNoSlotSecretLeak(
  report: RemoteFleetSlotsV1,
  targets: readonly RemoteSlotTarget[],
): void {
  const serialized = JSON.stringify(report);
  for (const target of targets) {
    if (target.token && serialized.includes(target.token)) {
      throw new Error("remote_slots_redaction_failed: report includes raw remote token");
    }
  }
  for (const pattern of SECRET_SCAN_PATTERNS) {
    if (pattern.test(serialized)) {
      throw new Error(`remote_slots_redaction_failed: report matched ${pattern}`);
    }
  }
}

function sanitizeReason(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/\bsk-(?:proj-|ant-|or-)?[A-Za-z0-9_-]{8,}\b/g, "sk-...[redacted]")
    .replace(/\bxai-[A-Za-z0-9_-]{8,}\b/g, "xai-...[redacted]")
    .replace(/\bAIza[0-9A-Za-z_-]{8,}\b/g, "AIza...[redacted]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]")
    .replace(/\/(?:Users|home)\/[^\s,)]+/g, "[redacted-path]");
}

function extractErrorMessage(json: unknown): string | null {
  if (!isRecord(json)) return null;
  return typeof json.error === "string" ? json.error : null;
}

function safeLabel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 128) return null;
  if (!/^[A-Za-z0-9._-]+$/.test(trimmed)) return null;
  if (
    trimmed.includes("@") ||
    trimmed.includes("://") ||
    trimmed.includes("/") ||
    trimmed.includes("\\")
  ) {
    return null;
  }
  return trimmed;
}

function safePlainString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed && !trimmed.includes("://") && !trimmed.includes("@") ? trimmed : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function tryParseHostPort(host: string): { hostname: string; port: number } | null {
  try {
    return host ? parseHostPort(host) : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

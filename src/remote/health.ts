import http from "node:http";
import net from "node:net";
import { parseHostPort } from "../bridge/connection.js";
import { parseOracleBuildInfo, type OracleBuildInfo } from "../version.js";
import {
  MAX_REMOTE_ARTIFACT_BYTES,
  REMOTE_BROWSER_RECOVERY_ADMISSION_HEADER_VALUES,
  REMOTE_BROWSER_RECOVERY_PROTOCOL,
  REMOTE_BROWSER_RUN_PATH,
  type RemoteActiveRunInfo,
  type RemoteArtifactCapabilities,
  type RemoteRunReadinessState,
} from "./types.js";
import {
  PROMPT_DOM_IDENTITY_ALGORITHM,
  PROMPT_RECOVERY_PREVIEW_ALGORITHM,
} from "../browser/promptDomMatch.js";

export interface RemoteBrowserRecoveryCompatibility {
  compatible: boolean;
  protocol: string | null;
  promptPreviewAlgorithm: string | null;
  promptDomIdentityAlgorithm: string | null;
}

export interface RemoteHealthResult {
  ok: boolean;
  statusCode?: number;
  error?: string;
  busy?: boolean;
  activeRun?: RemoteActiveRunInfo;
  state?: RemoteRunReadinessState;
  version?: string;
  build?: OracleBuildInfo;
  uptimeSeconds?: number;
  authProfileIdHash?: string;
  providerLocks?: string[];
  capabilities?: RemoteArtifactCapabilities;
  browserRecoveryCompatibility?: RemoteBrowserRecoveryCompatibility;
}

export interface RemoteRunAvailabilityResult {
  ok: boolean;
  statusCode?: number;
  error?: string;
  busy?: boolean;
  activeRun?: RemoteActiveRunInfo;
  state?: RemoteRunReadinessState;
}

export async function checkTcpConnection(
  host: string,
  timeoutMs = 2000,
): Promise<{ ok: boolean; error?: string }> {
  let hostname: string;
  let port: number;
  try {
    ({ hostname, port } = parseHostPort(host));
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  return await new Promise((resolve) => {
    const socket = net.createConnection({ host: hostname, port });
    const onError = (err: Error) => {
      cleanup();
      resolve({ ok: false, error: err.message });
    };
    const onConnect = () => {
      cleanup();
      resolve({ ok: true });
    };
    const onTimeout = () => {
      cleanup();
      resolve({ ok: false, error: `timeout after ${timeoutMs}ms` });
    };
    const cleanup = () => {
      socket.removeAllListeners();
      socket.end();
      socket.destroy();
      socket.unref();
    };
    socket.setTimeout(timeoutMs);
    socket.once("error", onError);
    socket.once("connect", onConnect);
    socket.once("timeout", onTimeout);
  });
}

export async function checkRemoteHealth({
  host,
  token,
  timeoutMs = 5000,
  requestFn = http.request,
  probeRunAvailability = true,
}: {
  host: string;
  token?: string;
  timeoutMs?: number;
  requestFn?: typeof http.request;
  /** Client admission preflight needs /health only; doctor also probes /runs. */
  probeRunAvailability?: boolean;
}): Promise<RemoteHealthResult> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }
  try {
    const { hostname, port } = parseHostPort(host);
    const response = await requestJson({
      hostname,
      port,
      path: "/health",
      headers,
      timeoutMs,
      requestFn,
    });
    if (response.statusCode === 200 && typeof response.json === "object" && response.json) {
      const ok = (response.json as { ok?: unknown }).ok === true;
      const busy = (response.json as { busy?: unknown }).busy === true;
      const version = (response.json as { version?: unknown }).version;
      const build = parseOracleBuildInfo(
        (response.json as { build?: unknown }).build,
        typeof version === "string" ? version : "0.0.0",
      );
      const uptimeSeconds = (response.json as { uptimeSeconds?: unknown }).uptimeSeconds;
      const authProfileIdHash = (response.json as { authProfileIdHash?: unknown })
        .authProfileIdHash;
      const providerLocks = (response.json as { providerLocks?: unknown }).providerLocks;
      const state = parseReadinessState((response.json as { state?: unknown }).state);
      const activeRun = parseActiveRun((response.json as { activeRun?: unknown }).activeRun);
      const capabilities = parseCapabilities(
        (response.json as { capabilities?: unknown }).capabilities,
      );
      const browserRecoveryCompatibility = inspectRemoteBrowserRecoveryCompatibility(
        (response.json as { capabilities?: unknown }).capabilities,
      );
      const healthResult: RemoteHealthResult = {
        ok: ok && !busy,
        statusCode: response.statusCode,
        busy: busy || undefined,
        state,
        activeRun,
        version: typeof version === "string" ? version : undefined,
        build: build ?? undefined,
        uptimeSeconds: typeof uptimeSeconds === "number" ? uptimeSeconds : undefined,
        authProfileIdHash: typeof authProfileIdHash === "string" ? authProfileIdHash : undefined,
        providerLocks: Array.isArray(providerLocks) ? providerLocks : undefined,
        capabilities,
        browserRecoveryCompatibility,
      };

      if (busy) {
        return {
          ...healthResult,
          ok: false,
          statusCode: 409,
          error:
            extractErrorMessage(response.json, response.bodyText) ??
            "remote host is busy; /health reports an active run",
        };
      }

      if (!ok) {
        return {
          ...healthResult,
          error: extractErrorMessage(response.json, response.bodyText) ?? healthResult.error,
        };
      }

      if (!probeRunAvailability) {
        return healthResult;
      }

      const runAvailability = await probeRemoteRunAvailability({
        hostname,
        port,
        headers,
        timeoutMs,
        requestFn,
      });
      if (!runAvailability.ok) {
        return {
          ...healthResult,
          ok: false,
          statusCode: runAvailability.statusCode,
          error: runAvailability.error,
          busy: runAvailability.busy,
          state: runAvailability.state,
          activeRun: runAvailability.activeRun,
        };
      }

      return healthResult;
    }
    if (response.statusCode === 409 && typeof response.json === "object" && response.json) {
      const capabilities = parseCapabilities(
        (response.json as { capabilities?: unknown }).capabilities,
      );
      const browserRecoveryCompatibility = inspectRemoteBrowserRecoveryCompatibility(
        (response.json as { capabilities?: unknown }).capabilities,
      );
      const version = (response.json as { version?: unknown }).version;
      const build = parseOracleBuildInfo(
        (response.json as { build?: unknown }).build,
        typeof version === "string" ? version : "0.0.0",
      );
      return {
        ok: false,
        statusCode: response.statusCode,
        busy: true,
        state: parseReadinessState((response.json as { state?: unknown }).state),
        activeRun: parseActiveRun((response.json as { activeRun?: unknown }).activeRun),
        version: typeof version === "string" ? version : undefined,
        build: build ?? undefined,
        uptimeSeconds:
          typeof (response.json as { uptimeSeconds?: unknown }).uptimeSeconds === "number"
            ? ((response.json as { uptimeSeconds?: unknown }).uptimeSeconds as number)
            : undefined,
        error:
          extractErrorMessage(response.json, response.bodyText) ??
          "remote host is busy; /health reports an active run",
        capabilities,
        browserRecoveryCompatibility,
      };
    }
    if (response.statusCode === 404) {
      return {
        ok: false,
        statusCode: response.statusCode,
        error: "remote host does not expose /health (upgrade oracle on the host and retry)",
      };
    }
    const error =
      extractErrorMessage(response.json, response.bodyText) ?? `HTTP ${response.statusCode}`;
    return { ok: false, statusCode: response.statusCode, error };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function checkRemoteRunAvailability({
  host,
  token,
  timeoutMs = 5000,
}: {
  host: string;
  token?: string;
  timeoutMs?: number;
}): Promise<RemoteRunAvailabilityResult> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }
  try {
    const { hostname, port } = parseHostPort(host);
    return await probeRemoteRunAvailability({
      hostname,
      port,
      headers,
      timeoutMs,
      requestFn: http.request,
    });
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function probeRemoteRunAvailability({
  hostname,
  port,
  headers,
  timeoutMs,
  requestFn,
}: {
  hostname: string;
  port: number;
  headers: Record<string, string>;
  timeoutMs: number;
  requestFn: typeof http.request;
}): Promise<RemoteRunAvailabilityResult> {
  const body = "{";
  const response = await requestJson({
    hostname,
    port,
    path: REMOTE_BROWSER_RUN_PATH,
    method: "POST",
    headers: {
      ...headers,
      ...REMOTE_BROWSER_RECOVERY_ADMISSION_HEADER_VALUES,
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(body)),
    },
    body,
    timeoutMs,
    requestFn,
  });
  const error = extractErrorMessage(response.json, response.bodyText);

  if (response.statusCode === 400) {
    return { ok: true, statusCode: response.statusCode };
  }
  if (response.statusCode === 409) {
    return {
      ok: false,
      statusCode: response.statusCode,
      busy: true,
      state: response.json
        ? parseReadinessState((response.json as { state?: unknown }).state)
        : undefined,
      activeRun: parseActiveRun(
        response.json ? (response.json as { activeRun?: unknown }).activeRun : undefined,
      ),
      error: error ?? "remote host is busy; /runs is rejecting new work",
    };
  }
  if (response.statusCode === 404) {
    return {
      ok: false,
      statusCode: response.statusCode,
      error: "remote host does not expose /runs (upgrade oracle on the host and retry)",
    };
  }
  if (response.statusCode === 401 || response.statusCode === 403) {
    return { ok: false, statusCode: response.statusCode, error: error ?? "unauthorized" };
  }
  return {
    ok: false,
    statusCode: response.statusCode,
    error: error ?? `unexpected /runs probe status HTTP ${response.statusCode}`,
  };
}

function parseActiveRun(value: unknown): RemoteActiveRunInfo | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.id !== "string" ||
    typeof record.startedAt !== "string" ||
    typeof record.ageSeconds !== "number" ||
    typeof record.clientConnected !== "boolean" ||
    typeof record.promptChars !== "number"
  ) {
    return undefined;
  }
  return {
    id: record.id,
    startedAt: record.startedAt,
    ageSeconds: record.ageSeconds,
    clientConnected: record.clientConnected,
    promptChars: record.promptChars,
    ...(isActiveRunPhase(record.phase) ? { phase: record.phase } : {}),
    ...(typeof record.completedAt === "string" ? { completedAt: record.completedAt } : {}),
    ...(typeof record.completedAgeSeconds === "number"
      ? { completedAgeSeconds: record.completedAgeSeconds }
      : {}),
    ...(typeof record.sessionId === "string" ? { sessionId: record.sessionId } : {}),
    ...(typeof record.desiredModel === "string" ? { desiredModel: record.desiredModel } : {}),
  };
}

function parseReadinessState(value: unknown): RemoteRunReadinessState | undefined {
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
  return undefined;
}

function isActiveRunPhase(value: unknown): value is NonNullable<RemoteActiveRunInfo["phase"]> {
  return value === "running" || value === "completed";
}

function parseCapabilities(value: unknown): RemoteArtifactCapabilities | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const raw = value as {
    artifactTransfer?: unknown;
    artifactProtocolVersion?: unknown;
    maxArtifactBytes?: unknown;
  };
  if (raw.artifactTransfer !== true) {
    return undefined;
  }
  const artifactProtocolVersion = raw.artifactProtocolVersion;
  const maxArtifactBytes = raw.maxArtifactBytes;
  if (
    typeof artifactProtocolVersion !== "number" ||
    !Number.isSafeInteger(artifactProtocolVersion) ||
    artifactProtocolVersion <= 0 ||
    typeof maxArtifactBytes !== "number" ||
    !Number.isSafeInteger(maxArtifactBytes) ||
    maxArtifactBytes <= 0
  ) {
    return undefined;
  }
  return {
    artifactTransfer: true,
    artifactProtocolVersion,
    maxArtifactBytes: Math.min(maxArtifactBytes, MAX_REMOTE_ARTIFACT_BYTES),
    ...(inspectRemoteBrowserRecoveryCompatibility(value).compatible
      ? {
          browserRecovery: {
            protocol: REMOTE_BROWSER_RECOVERY_PROTOCOL,
            promptPreviewAlgorithm: PROMPT_RECOVERY_PREVIEW_ALGORITHM,
            promptDomIdentityAlgorithm: PROMPT_DOM_IDENTITY_ALGORITHM,
          },
        }
      : {}),
  };
}

/** Parse even incompatible values so doctor can explain mixed-version drift. */
export function inspectRemoteBrowserRecoveryCompatibility(
  value: unknown,
): RemoteBrowserRecoveryCompatibility {
  const recovery =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as { browserRecovery?: unknown }).browserRecovery
      : undefined;
  const raw =
    recovery && typeof recovery === "object" && !Array.isArray(recovery)
      ? (recovery as Record<string, unknown>)
      : {};
  const protocol = typeof raw.protocol === "string" ? raw.protocol : null;
  const promptPreviewAlgorithm =
    typeof raw.promptPreviewAlgorithm === "string" ? raw.promptPreviewAlgorithm : null;
  const promptDomIdentityAlgorithm =
    typeof raw.promptDomIdentityAlgorithm === "string" ? raw.promptDomIdentityAlgorithm : null;
  return {
    compatible:
      protocol === REMOTE_BROWSER_RECOVERY_PROTOCOL &&
      promptPreviewAlgorithm === PROMPT_RECOVERY_PREVIEW_ALGORITHM &&
      promptDomIdentityAlgorithm === PROMPT_DOM_IDENTITY_ALGORITHM,
    protocol,
    promptPreviewAlgorithm,
    promptDomIdentityAlgorithm,
  };
}

function extractErrorMessage(json: unknown, bodyText: string): string | null {
  if (json && typeof json === "object") {
    const err = (json as { error?: unknown }).error;
    if (typeof err === "string" && err.trim().length > 0) {
      return err.trim();
    }
  }
  const trimmed = bodyText.trim();
  return trimmed.length ? trimmed : null;
}

async function requestJson({
  hostname,
  port,
  path,
  method = "GET",
  headers,
  body,
  timeoutMs,
  requestFn,
}: {
  hostname: string;
  port: number;
  path: string;
  method?: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
  requestFn: typeof http.request;
}): Promise<{ statusCode: number; json: unknown; bodyText: string }> {
  return await new Promise((resolve, reject) => {
    const req = requestFn(
      {
        hostname,
        port,
        path,
        method,
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
    if (body !== undefined) {
      req.write(body);
    }
    req.end();
  });
}

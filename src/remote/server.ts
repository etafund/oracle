import http from "node:http";
import { createReadStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm, mkdir, readFile, writeFile, stat, realpath } from "node:fs/promises";
import chalk from "chalk";
import type { BrowserAttachment, BrowserLogger, CookieParam } from "../browser/types.js";
import { runBrowserMode } from "../browserMode.js";
import type { BrowserRunResult } from "../browserMode.js";
import type {
  RemoteActiveRunInfo,
  RemoteArtifactCapabilities,
  RemoteArtifactDescriptor,
  RemoteAttachmentIntegrityEntry,
  RemoteAttachmentPayload,
  RemoteRunPayload,
  RemoteRunEvent,
  RemoteRunProvenanceSummary,
  RemoteUploadIntegrity,
} from "./types.js";
import { MAX_REMOTE_ARTIFACT_BYTES } from "./types.js";
import { getQuarantineLatchState } from "../browser/quarantineLatch.js";
import type { OracleUserError } from "../oracle/errors.js";
import { getCookies, type Cookie } from "@steipete/sweet-cookie";
import { CHATGPT_URL } from "../browser/constants.js";
import { getCliVersion } from "../version.js";
import { getOracleHomeDir } from "../oracleHome.js";
import {
  isProcessAlive,
  readChromePid,
  readDevToolsPort,
  verifyDevToolsReachable,
} from "../browser/profileState.js";
import { normalizeChatgptUrl } from "../browser/utils.js";
import { resolveBrowserConfig } from "../browser/config.js";
import { getBrowserCleanupTaint, type BrowserCleanupTaint } from "../browser/index.js";
import { countActiveBrowserTabLeases } from "../browser/tabLeaseRegistry.js";
import {
  appendOracleRunEvent,
  classifyRunErrorClass,
  isRunErrorClass,
  type RunAttachmentDigest,
  type RunErrorClass,
} from "./run_event_sink.js";
import { sanitizeRemoteRunPayloadForHost } from "./payload_sanitize.js";
import {
  computeFileSha256,
  sanitizeArtifactFilename,
  sanitizeArtifactMimeType,
  validateArtifactFile,
} from "../browser/artifacts.js";
import type { BrowserRunWarning, SessionArtifact } from "../sessionManager.js";

export interface RemoteServerOptions {
  host?: string;
  port?: number;
  token?: string;
  /**
   * Path to a file containing the access token (trailing whitespace
   * trimmed). Keeps the secret out of argv, where it would be visible in
   * /proc/<pid>/cmdline, ps output, and crash reports. Composes with
   * systemd LoadCredential. Resolution precedence:
   * --token-file > ORACLE_REMOTE_TOKEN_FILE > ORACLE_REMOTE_TOKEN > --token.
   */
  tokenFile?: string;
  logger?: (message: string) => void;
  manualLoginDefault?: boolean;
  manualLoginProfileDir?: string;
  /**
   * Neutral worker-identity labels used for run correlation across a fleet.
   * Sourced from config/env (ORACLE_LANE_ID / ORACLE_ACCOUNT_ID); must be
   * neutral identifiers (e.g. "acct1"), never emails or hostnames, because
   * they are echoed to callers in response headers.
   */
  laneId?: string;
  accountId?: string;
  /**
   * Attach-only / fail-closed mode (also via ORACLE_SERVE_ATTACH_ONLY=1):
   * the worker only ever ATTACHES to a pre-launched, operator-owned Chrome.
   * When no attachable DevTools endpoint exists the worker reports itself
   * unready and refuses runs with a typed error — it never launches a
   * browser itself (a worker-side launch races sibling workers sharing one
   * profile: singleton-lock collisions and profile split-brain). Manual-login
   * serve is attach-only by construction; this flag makes the intent
   * explicit and forces the attach flow on any platform.
   */
  attachOnly?: boolean;
  /**
   * Fixed loopback DevTools port to probe for the attach target (also via
   * ORACLE_SERVE_DEVTOOLS_PORT). When unset, the profile directory's
   * recorded DevToolsActivePort is used.
   */
  devtoolsPort?: number;
  /**
   * Admission limits for /runs request bodies. The default cap matches the
   * router tier's client_max_body_size (100 MiB) with a 60s read deadline;
   * overridable here (or via ORACLE_SERVE_MAX_BODY_BYTES for the cap) so
   * deployments can tighten it and fault-isolation tests can exercise the
   * refusal paths quickly.
   */
  maxRunRequestBodyBytes?: number;
  runBodyReadDeadlineMs?: number;
  /**
   * Wedge detection for readiness probes: an active run that has produced no
   * events for this long is reported as wedged-no-progress (503) so
   * supervision can intervene. Also via ORACLE_SERVE_WEDGE_AFTER_MS.
   */
  wedgeAfterMs?: number;
}

interface RemoteServerDeps {
  runBrowser?: typeof runBrowserMode;
  /**
   * Cleanup-taint provider for readiness probes (defaults to the browser
   * layer's latched cleanup-failure flag). Injectable so fault-isolation
   * tests can exercise the tainted path without breaking a real browser.
   */
  cleanupTaint?: () => BrowserCleanupTaint | null;
}

interface RemoteServerInstance {
  port: number;
  token: string;
  close(): Promise<void>;
}

interface ActiveRunState {
  id: string;
  startedAtMs: number;
  clientConnected: boolean;
  promptChars: number;
  sessionId?: string;
  desiredModel?: string;
}

interface RegisteredRemoteArtifact {
  descriptor: RemoteArtifactDescriptor;
  filePath: string;
  expiresAt: number;
}

const ARTIFACT_PROTOCOL_VERSION = 1;
const REMOTE_ARTIFACT_TTL_MS = 30 * 60 * 1000;

// App-level request admission limits. The default cap is aligned with the
// router tier's client_max_body_size (100m, raised deliberately to support
// attachment/artifact-heavy runs); the worker must enforce a bound itself so
// a request that reaches the backend port directly cannot balloon memory or
// pin the lane with an unbounded/slow upload. Configurable per worker via
// RemoteServerOptions.maxRunRequestBodyBytes or ORACLE_SERVE_MAX_BODY_BYTES.
export const MAX_RUN_REQUEST_BODY_BYTES = 100 * 1024 * 1024;
export const RUN_BODY_READ_DEADLINE_MS = 60_000;

type RequestBodyErrorKind = "too_large" | "timed_out" | "aborted";

class RequestBodyError extends Error {
  readonly kind: RequestBodyErrorKind;

  constructor(kind: RequestBodyErrorKind, message: string) {
    super(message);
    this.name = "RequestBodyError";
    this.kind = kind;
  }
}

const ARTIFACT_CAPABILITIES: RemoteArtifactCapabilities = {
  artifactTransfer: true,
  artifactProtocolVersion: ARTIFACT_PROTOCOL_VERSION,
  maxArtifactBytes: MAX_REMOTE_ARTIFACT_BYTES,
};

export interface AttachTargetProbe {
  /** True when a recorded/configured DevTools endpoint answered the probe. */
  ok: boolean;
  /** Machine-readable refusal reason when not ok. */
  reason: string | null;
  /** The probed DevTools port, when one was recorded/configured. */
  port: number | null;
  /** Where the port came from: fixed worker config or the profile's file. */
  portSource: "fixed" | "profile" | null;
  /**
   * Best-effort owner check (the chromeOwnerOk hook for readiness probes):
   * true = the endpoint is owned by the Chrome this profile recorded;
   * false = definitive mismatch (split-brain / rogue listener);
   * null = ownership could not be established on this platform.
   */
  ownerOk: boolean | null;
  probedAt: string;
}

/**
 * Probes the attach target for an attach-only worker: is there a live,
 * operator-owned Chrome DevTools endpoint this worker may attach to?
 * Never launches anything; observing only.
 */
export async function probeAttachTarget(params: {
  profileDir?: string;
  fixedPort?: number;
  probe?: typeof verifyDevToolsReachable;
}): Promise<AttachTargetProbe> {
  const probedAt = new Date().toISOString();
  const probe = params.probe ?? verifyDevToolsReachable;
  let port: number | null = null;
  let portSource: AttachTargetProbe["portSource"] = null;
  if (typeof params.fixedPort === "number" && params.fixedPort > 0) {
    port = params.fixedPort;
    portSource = "fixed";
  } else if (params.profileDir) {
    port = await readDevToolsPort(params.profileDir).catch(() => null);
    portSource = port === null ? null : "profile";
  }
  if (port === null) {
    return {
      ok: false,
      reason: "no-attach-target-recorded",
      port: null,
      portSource: null,
      ownerOk: null,
      probedAt,
    };
  }
  const reachable = await probe({ port, attempts: 1, timeoutMs: 1_500 });
  if (!reachable.ok) {
    return {
      ok: false,
      reason: `cdp-unreachable: ${reachable.error}`,
      port,
      portSource,
      ownerOk: null,
      probedAt,
    };
  }
  const ownerOk = await checkAttachTargetOwner(params.profileDir, port);
  if (ownerOk === false) {
    return {
      ok: false,
      reason: "attach-target-owner-mismatch",
      port,
      portSource,
      ownerOk,
      probedAt,
    };
  }
  return { ok: true, reason: null, port, portSource, ownerOk, probedAt };
}

/**
 * Best-effort verification that the DevTools endpoint belongs to the Chrome
 * recorded for this profile (split-brain / rogue-listener defense):
 * - the profile's recorded DevToolsActivePort must agree with the probed
 *   port when both exist;
 * - the recorded owner pid must still be alive, and (on Linux) its command
 *   line must reference this profile directory.
 * Returns null when ownership cannot be established (no recorded state, or
 * platform without readable process info) — callers decide policy; a
 * definitive false always means "do not attach".
 */
async function checkAttachTargetOwner(
  profileDir: string | undefined,
  port: number,
): Promise<boolean | null> {
  if (!profileDir) {
    return null;
  }
  try {
    const recordedPort = await readDevToolsPort(profileDir).catch(() => null);
    if (recordedPort !== null && recordedPort !== port) {
      return false;
    }
    const pid = await readChromePid(profileDir).catch(() => null);
    if (pid === null) {
      return null;
    }
    if (!isProcessAlive(pid)) {
      return false;
    }
    if (process.platform === "linux") {
      const cmdline = await readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => null);
      if (cmdline === null) {
        return null;
      }
      return cmdline.includes(profileDir);
    }
    return null;
  } catch {
    return null;
  }
}

export async function createRemoteServer(
  options: RemoteServerOptions = {},
  deps: RemoteServerDeps = {},
): Promise<RemoteServerInstance> {
  const runBrowser = deps.runBrowser ?? runBrowserMode;
  const resolvedToken = await resolveServeAuthToken({
    tokenFile: options.tokenFile,
    token: options.token,
  });
  // Resolve the baseline browser config this worker will enforce on every
  // run (payloads are sanitized and cannot reintroduce these keys) and
  // refuse to start if any fleet-safety invariant would be violated.
  const baselineBrowserConfig = resolveBrowserConfig(
    options.manualLoginDefault
      ? {
          manualLogin: true,
          manualLoginProfileDir: options.manualLoginProfileDir,
          keepBrowser: true,
        }
      : undefined,
  );
  const effectiveRunConfig = {
    timeoutMs: baselineBrowserConfig.timeoutMs,
    profileLockTimeoutMs: baselineBrowserConfig.profileLockTimeoutMs,
    maxConcurrentTabs: baselineBrowserConfig.maxConcurrentTabs,
  };
  assertFleetSafeServeBrowserConfig(effectiveRunConfig);

  // Attach-only / fail-closed substrate probing. Manual-login serve shares
  // one operator-owned Chrome between workers, so it is attach-only by
  // construction; the explicit flag/env extends the same contract to any
  // deployment shape. Probes are cached briefly so /status and admission
  // checks cannot hammer the DevTools endpoint.
  const attachOnly =
    options.attachOnly ??
    (process.env.ORACLE_SERVE_ATTACH_ONLY === "1" || Boolean(options.manualLoginDefault));
  const attachProfileDir =
    options.manualLoginProfileDir ?? path.join(os.homedir(), ".oracle", "browser-profile");
  const attachDevtoolsPort =
    options.devtoolsPort ?? parsePositiveIntEnv(process.env.ORACLE_SERVE_DEVTOOLS_PORT);
  let lastAttachProbe: AttachTargetProbe | null = null;
  let lastAttachProbeAtMs = 0;
  const probeAttachTargetCached = async (): Promise<AttachTargetProbe> => {
    if (lastAttachProbe && Date.now() - lastAttachProbeAtMs < 2_000) {
      return lastAttachProbe;
    }
    lastAttachProbe = await probeAttachTarget({
      profileDir: attachProfileDir,
      fixedPort: attachDevtoolsPort,
    });
    lastAttachProbeAtMs = Date.now();
    return lastAttachProbe;
  };

  // Readiness inputs beyond the attach probe: latched cleanup taint from the
  // browser layer, run-progress tracking for wedge detection, and the bound
  // port for worker identity.
  const cleanupTaintProvider = deps.cleanupTaint ?? getBrowserCleanupTaint;
  const wedgeAfterMs =
    options.wedgeAfterMs ??
    parsePositiveIntEnv(process.env.ORACLE_SERVE_WEDGE_AFTER_MS) ??
    15 * 60 * 1000;
  let lastRunProgressAtMs: number | null = null;
  let boundPort: number | null = null;

  /**
   * Layered, fail-closed readiness for supervision probes (probed DIRECTLY,
   * never through a load balancer that would mask per-worker truth):
   * - 503 substrate-broken: attach target missing/stale/foreign-owned,
   *   cleanup taint latched, lease registry unverifiable, or any probe error;
   * - 503 wedged-no-progress: an active run with no events for wedgeAfterMs;
   * - 409 active-run-client-connected / active-run-client-disconnected:
   *   busy but healthy;
   * - 200 idle-ready.
   * Unknown values are emitted as null, never omitted.
   */
  const buildReadiness = async (): Promise<{
    statusCode: number;
    body: Record<string, unknown>;
  }> => {
    const identity = {
      accountId,
      laneId,
      port: boundPort,
    };
    const base: Record<string, unknown> = {
      ok: false,
      state: "substrate-broken",
      reason: null,
      busy,
      attachOnly,
      chromeReachable: null,
      chromeOwnerOk: null,
      cleanupTaint: null,
      identity,
      activeRun: activeRun ? serializeActiveRun(activeRun) : null,
      activeLeaseCount: null,
      leaseRegistryReadable: null,
      lastProgressAgeSeconds:
        busy && lastRunProgressAtMs !== null
          ? Math.max(0, Math.round((Date.now() - lastRunProgressAtMs) / 1000))
          : null,
      effectiveConfig: effectiveRunConfig,
      // Integration point: challenge/login quarantine latch (separate change)
      // surfaces here; null means "latch subsystem not present", never "clean".
      quarantine: null,
      manifest: null,
    };
    try {
      if (attachOnly) {
        const probe = await probeAttachTargetCached();
        // Owner mismatch means the endpoint answered but belongs to a Chrome
        // this worker must not touch: reachable yes, usable no.
        base.chromeReachable = probe.ok || probe.reason === "attach-target-owner-mismatch";
        base.chromeOwnerOk = probe.ownerOk;
        if (!probe.ok) {
          base.reason = probe.reason;
          return { statusCode: 503, body: base };
        }
      }

      const taint = cleanupTaintProvider();
      base.cleanupTaint = taint;
      if (taint) {
        base.reason = `cleanup-tainted: ${taint.reason}`;
        return { statusCode: 503, body: base };
      }

      const census = await countActiveBrowserTabLeases(attachProfileDir);
      base.leaseRegistryReadable = census.readable;
      base.activeLeaseCount = census.activeLeaseCount;
      if (!census.readable) {
        base.reason = `lease-registry-unreadable: ${census.reason ?? "unknown"}`;
        return { statusCode: 503, body: base };
      }

      base.manifest = await readFleetManifestStatus({
        accountId,
        port: boundPort,
        devtoolsPort: attachDevtoolsPort ?? null,
        effectiveConfig: effectiveRunConfig,
      });

      if (busy) {
        const progressAge =
          lastRunProgressAtMs === null ? null : Date.now() - lastRunProgressAtMs;
        if (progressAge !== null && progressAge > wedgeAfterMs) {
          base.state = "wedged-no-progress";
          base.reason = `no-progress-for-ms: ${progressAge}`;
          return { statusCode: 503, body: base };
        }
        base.state = activeRun?.clientConnected
          ? "active-run-client-connected"
          : "active-run-client-disconnected";
        base.reason = "busy";
        return { statusCode: 409, body: base };
      }

      base.ok = true;
      base.state = "idle-ready";
      return { statusCode: 200, body: base };
    } catch (error) {
      // FAIL CLOSED: a readiness probe that cannot complete reports broken.
      base.ok = false;
      base.state = "substrate-broken";
      base.reason = `probe-error: ${error instanceof Error ? error.message : String(error)}`;
      return { statusCode: 503, body: base };
    }
  };

  const server = http.createServer();
  // Socket-layer bounds to complement the app-level admission limits: slow
  // header/body transmission must not hold sockets open indefinitely. The
  // request timeout only covers receiving the request, not the (long-lived)
  // streamed NDJSON response.
  server.headersTimeout = 30_000;
  server.requestTimeout = 120_000;
  const logger = options.logger ?? console.log;
  const authToken = resolvedToken.token;
  const startedAt = Date.now();
  const verbose = process.argv.includes("--verbose") || process.env.ORACLE_SERVE_VERBOSE === "1";
  const color = process.stdout.isTTY
    ? (formatter: (msg: string) => string, msg: string) => formatter(msg)
    : (_formatter: (msg: string) => string, msg: string) => msg;
  // Two-stage single-flight guard: remote Chrome can only host one run at a
  // time. `admitting` is held while a request body is read and validated;
  // `busy` is only flipped once a validated run is handed to the browser.
  // A second request during either stage is refused with 409, and a request
  // that fails admission (oversize, slow body, invalid payload, disconnect)
  // releases the slot without ever flipping `busy`.
  let admitting = false;
  let busy = false;
  let activeRun: ActiveRunState | null = null;
  const bodyLimits = {
    // Precedence: explicit option > env override > router-aligned default.
    maxBytes:
      options.maxRunRequestBodyBytes ??
      parsePositiveIntEnv(process.env.ORACLE_SERVE_MAX_BODY_BYTES) ??
      MAX_RUN_REQUEST_BODY_BYTES,
    deadlineMs: options.runBodyReadDeadlineMs ?? RUN_BODY_READ_DEADLINE_MS,
  };
  const artifactRegistry = new Map<string, RegisteredRemoteArtifact>();

  // Worker identity for run correlation. Account id must stay a neutral label
  // (never an email/hostname); the default lane id incorporates the bound port
  // once the listener is up so co-hosted workers stay distinguishable.
  const accountId =
    sanitizeIdentityLabel(options.accountId ?? process.env.ORACLE_ACCOUNT_ID) ??
    DEFAULT_ACCOUNT_ID;
  const explicitLaneId = sanitizeIdentityLabel(options.laneId ?? process.env.ORACLE_LANE_ID);
  let laneId = explicitLaneId ?? accountId;
  const identityHeaders = (runId: string): Record<string, string> => ({
    "X-Oracle-Run-Id": runId,
    "X-Oracle-Lane-Id": laneId,
    "X-Oracle-Account-Id": accountId,
  });

  if (!process.listenerCount("unhandledRejection")) {
    process.on("unhandledRejection", (reason) => {
      logger(
        `Unhandled promise rejection in remote server: ${reason instanceof Error ? reason.message : String(reason)}`,
      );
    });
  }

  server.on("request", (req, res) => {
    // Populated as soon as a /runs request mints its identity so even the
    // outermost failure handler can attribute the wreckage to a run id.
    let requestRunId: string | null = null;
    void (async () => {
      if (req.method === "GET" && req.url === "/status") {
        logger("[serve] Health check /status");
        if (attachOnly) {
          // Fail-closed liveness: an attach-only worker without an
          // attachable, owned Chrome must not advertise itself as ready.
          const probe = await probeAttachTargetCached();
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              ok: probe.ok,
              attachOnly: true,
              chromeReachable: probe.ok,
              ...(probe.reason ? { reason: probe.reason } : {}),
            }),
          );
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (req.method === "GET" && req.url === "/health") {
        if (!isAuthorizedBearer(req.headers.authorization, authToken)) {
          if (verbose) {
            logger(
              `[serve] Unauthorized /health attempt from ${formatSocket(req)} (missing/invalid token)`,
            );
          }
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "unauthorized" }));
          return;
        }
        const health = buildHealthResponse({
          startedAt,
          busy,
          activeRun,
          effectiveConfig: effectiveRunConfig,
        });
        res.writeHead(busy ? 409 : 200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(health));
        return;
      }

      if (req.method === "GET" && req.url === "/ready") {
        if (!isAuthorizedBearer(req.headers.authorization, authToken)) {
          if (verbose) {
            logger(
              `[serve] Unauthorized /ready attempt from ${formatSocket(req)} (missing/invalid token)`,
            );
          }
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "unauthorized" }));
          return;
        }
        const readiness = await buildReadiness();
        res.writeHead(readiness.statusCode, { "Content-Type": "application/json" });
        res.end(JSON.stringify(readiness.body));
        return;
      }

      const artifactMatch = matchArtifactRequest(req);
      if (artifactMatch) {
        await serveRemoteArtifact({
          req,
          res,
          authToken,
          artifactRegistry,
          logger,
          verbose,
          runId: artifactMatch.runId,
          artifactId: artifactMatch.artifactId,
        });
        return;
      }

      if (req.method !== "POST" || req.url !== "/runs") {
        res.statusCode = 404;
        res.end();
        return;
      }

      // Mint the run identity at request arrival, BEFORE any side effect
      // (auth verdict, body read, temp-dir creation, single-flight flips,
      // response head). Every log line, NDJSON event, and refusal for this
      // request carries the same id so early failures stay attributable.
      const runId = randomUUID();
      requestRunId = runId;
      const runStartedAt = Date.now();

      const logRefusal = (reason: string, status: number) => {
        // One structured line per refusal so refusals are as greppable and
        // joinable as accepted runs.
        logger(
          `[serve] ${JSON.stringify({ event: "run.refused", runId, laneId, accountId, reason, status })}`,
        );
      };
      const refuseRun = (
        status: number,
        code: string,
        extra: Record<string, unknown> = {},
        extraHeaders: Record<string, string> = {},
      ) => {
        logRefusal(code, status);
        if (res.destroyed || res.writableEnded) {
          return;
        }
        if (!res.headersSent) {
          // `Connection: close` so a peer mid-upload does not keep streaming
          // into a connection whose request we already refused.
          res.writeHead(status, {
            "Content-Type": "application/json",
            Connection: "close",
            ...identityHeaders(runId),
            ...extraHeaders,
          });
        }
        res.end(JSON.stringify({ error: code, runId, ...extra }));
      };

      if (!isAuthorizedBearer(req.headers.authorization, authToken)) {
        if (verbose) {
          logger(
            `[serve] Unauthorized /runs attempt for run ${runId} from ${formatSocket(req)} (missing/invalid token)`,
          );
        }
        refuseRun(401, "unauthorized");
        return;
      }
      if (admitting || busy) {
        if (verbose) {
          logger(
            `[serve] Busy: rejecting run ${runId} from ${formatSocket(req)} while another run is active`,
          );
        }
        refuseRun(
          409,
          "busy",
          {
            busy: true,
            // Typed retry semantics for the router/caller: capacity refusals
            // are safe to retry elsewhere after the hinted delay.
            errorClass: "capacity_busy",
            retryable: true,
            ...(activeRun ? { activeRun: serializeActiveRun(activeRun) } : {}),
          },
          { "Retry-After": "15" },
        );
        return;
      }

      admitting = true;
      let payload: RemoteRunPayload | null = null;
      let runDir: string | null = null;
      let attachProbeForRun: AttachTargetProbe | null = null;
      // oracle.run.v1 accounting for this run (one sink line per ACCEPTED
      // run, emitted from the finally below on success, failure, and abort).
      let acceptedAt: string | null = null;
      let submittedAt: string | null = null;
      let activeTabLeasesAtSubmit: number | null = null;
      let attachments: BrowserAttachment[] = [];
      let fallbackSubmission:
        | {
            prompt: string;
            attachments: BrowserAttachment[];
          }
        | undefined;
      let uploadIntegrity: RemoteUploadIntegrity | null = null;
      try {
        if (attachOnly) {
          // Fail-closed admission: no attachable, owned browser means the
          // run is refused with a typed error. The worker NEVER launches a
          // browser to satisfy a run — that converts "operator has not
          // prepared a browser" into a profile race between sibling workers.
          attachProbeForRun = await probeAttachTargetCached();
          if (!attachProbeForRun.ok) {
            refuseRun(
              503,
              "browser_unavailable",
              {
                reason: attachProbeForRun.reason,
                // Substrate outages are retryable on another lane; this
                // worker cannot serve until its browser returns.
                retryable: true,
              },
              { "Retry-After": "30" },
            );
            return;
          }
        }
        try {
          const body = await readRequestBody(req, bodyLimits);
          payload = sanitizeRemoteRunPayloadForHost(JSON.parse(body) as RemoteRunPayload);
          if (payload?.browserConfig) {
            payload.browserConfig.url = normalizeChatgptUrl(
              payload.browserConfig.url,
              CHATGPT_URL,
            );
          }
        } catch (error) {
          if (error instanceof RequestBodyError && error.kind === "too_large") {
            refuseRun(413, "payload_too_large");
          } else if (error instanceof RequestBodyError && error.kind === "timed_out") {
            refuseRun(408, "request_timeout");
          } else if (error instanceof RequestBodyError && error.kind === "aborted") {
            // Peer is gone; nothing to answer, but the refusal is still logged
            // and the admission slot is released by the finally below.
            logRefusal("client_disconnected", 0);
          } else {
            refuseRun(400, "invalid_request");
          }
          return;
        }

        // Stage attachments during admission (before `busy` flips) so a
        // truncated/corrupted upload is refused with a typed error instead of
        // consuming a browser slot. Stored names are collision-proof and the
        // integrity manifest is emitted with the run's events below.
        try {
          runDir = await mkdtemp(path.join(os.tmpdir(), `oracle-serve-${runId}-`));
          const attachmentDir = path.join(runDir, "attachments");
          await mkdir(attachmentDir, { recursive: true });
          const staged = await stageAttachmentsWithIntegrity({
            payloadAttachments: payload.attachments,
            dir: attachmentDir,
            fallbackLabel: "attachment",
          });
          attachments = staged.attachments;
          uploadIntegrity = {
            attachments: staged.manifest,
            preSendDomCheck: "composer-chips-by-stored-name",
          };

          if (payload.fallbackSubmission) {
            const fallbackAttachmentDir = path.join(runDir, "fallback-attachments");
            await mkdir(fallbackAttachmentDir, { recursive: true });
            const stagedFallback = await stageAttachmentsWithIntegrity({
              payloadAttachments: payload.fallbackSubmission.attachments,
              dir: fallbackAttachmentDir,
              fallbackLabel: "fallback-attachment",
            });
            fallbackSubmission = {
              prompt: payload.fallbackSubmission.prompt,
              attachments: stagedFallback.attachments,
            };
            uploadIntegrity.fallbackAttachments = stagedFallback.manifest;
          }
        } catch (error) {
          if (runDir) {
            await rm(runDir, { recursive: true, force: true }).catch(() => undefined);
          }
          if (error instanceof AttachmentIntegrityError) {
            refuseRun(400, "attachment_size_mismatch", { detail: error.message });
          } else {
            refuseRun(400, "invalid_request");
          }
          return;
        }

        // Admission checks passed: hand the single-flight slot to the browser
        // stage before releasing the admitting stage (no gap in coverage).
        busy = true;
        lastRunProgressAtMs = Date.now();
        acceptedAt = new Date().toISOString();
      } finally {
        admitting = false;
      }

      res.writeHead(200, { "Content-Type": "application/x-ndjson", ...identityHeaders(runId) });
      // Flush immediately: callers correlate on X-Oracle-Run-Id before the
      // first NDJSON event arrives (long runs may stay quiet for a while).
      res.flushHeaders();

      activeRun = {
        id: runId,
        startedAtMs: runStartedAt,
        clientConnected: true,
        promptChars: payload?.prompt?.length ?? 0,
        sessionId: payload.options?.sessionId,
        desiredModel:
          typeof payload.browserConfig?.desiredModel === "string"
            ? payload.browserConfig.desiredModel
            : undefined,
      };
      let responseCompleted = false;
      res.once("close", () => {
        if (!responseCompleted && activeRun?.id === runId) {
          activeRun.clientConnected = false;
          if (verbose) {
            logger(`[serve] Client disconnected while run ${runId} is still active`);
          }
        }
      });
      logger(
        `[serve] Accepted run ${runId} from ${formatSocket(req)} (prompt ${payload?.prompt?.length ?? 0} chars)`,
      );

      const sendEvent = (event: RemoteRunEvent) => {
        // Every emitted event counts as run progress for wedge detection,
        // whether or not the client is still connected to receive it.
        lastRunProgressAtMs = Date.now();
        if (res.destroyed || res.writableEnded) {
          return;
        }
        // Stamp the run id onto every NDJSON line so each event of a run is
        // joinable without relying on stream framing alone.
        res.write(`${JSON.stringify({ runId, ...event })}\n`);
      };

      let runResult: BrowserRunResult | null = null;
      let runErrorMessage: string | null = null;
      let runErrorClass: RunErrorClass | null = null;
      let runRetryable: boolean | null = null;
      let bindingVerified: boolean | null = null;
      try {
        if (uploadIntegrity && uploadIntegrity.attachments.length + (uploadIntegrity.fallbackAttachments?.length ?? 0) > 0) {
          // Emit the staging proof before the browser stage starts so the
          // manifest survives even if the run later fails.
          sendEvent({ type: "attachment-manifest", uploadIntegrity });
        }

        const automationLogger: BrowserLogger = ((message?: string) => {
          if (typeof message === "string") {
            // Send-confirmation marker: the account-safety boundary for run
            // accounting is the ChatGPT submit moment, not /runs acceptance.
            if (submittedAt === null && /submitted prompt|prompt submitted/i.test(message)) {
              submittedAt = new Date().toISOString();
              void countActiveBrowserTabLeases(attachProfileDir)
                .then((census) => {
                  activeTabLeasesAtSubmit = census.activeLeaseCount;
                })
                .catch(() => undefined);
            }
            // Structural capture-binding markers feed the provenance summary
            // of the terminal done event.
            if (/capture binding verified/i.test(message)) {
              bindingVerified = true;
            } else if (/capture binding (?:failed|mismatch|lost|unverified)/i.test(message)) {
              bindingVerified = false;
            }
            sendEvent({ type: "log", message });
          }
        }) as BrowserLogger;
        automationLogger.verbose = Boolean(payload.options.verbose);

        if (payload.browserConfig) {
          payload.browserConfig.inlineCookies = null;
          payload.browserConfig.inlineCookiesSource = null;
          payload.browserConfig.cookieSync = true;
        } else {
          payload.browserConfig = {} as typeof payload.browserConfig;
        }

        if (options.manualLoginDefault) {
          payload.browserConfig.manualLogin = true;
          payload.browserConfig.manualLoginProfileDir = options.manualLoginProfileDir;
          payload.browserConfig.keepBrowser = true;
          if (verbose) {
            logger(
              `[serve] Enforcing manual-login profile at ${options.manualLoginProfileDir ?? "default"} for remote run ${runId}`,
            );
          }
        }

        const result = await runBrowser({
          prompt: payload.prompt,
          attachments,
          fallbackSubmission,
          config: payload.browserConfig,
          log: automationLogger,
          heartbeatIntervalMs: payload.options.heartbeatIntervalMs,
          verbose: payload.options.verbose,
          sessionId: payload.options.sessionId,
          followUpPrompts: payload.options.followUpPrompts,
        });
        runResult = result;
        const artifactRegistration = await registerRemoteArtifacts({
          runId,
          result,
          artifactRegistry,
          logger,
        });
        const artifactDescriptors = artifactRegistration.descriptors;
        if (artifactDescriptors.length > 0) {
          sendEvent({
            type: "log",
            message:
              `[browser] ${artifactDescriptors.length} artifact(s) ready for bridge transfer. ` +
              "If no cloud-local artifact path appears, upgrade both Oracle bridge endpoints or copy the file manually from the Windows browser host.",
          });
        }
        for (const artifact of artifactDescriptors) {
          sendEvent({ type: "artifact-ready", runId, artifact });
        }
        // TERMINAL event: the caller-usable answer travels ONLY here.
        // Success is defined as done.ok, never as "stream ended after some
        // result-shaped bytes" — loose wrappers must not act on a truncated
        // stream or on non-authoritative intermediate events.
        sendEvent({
          type: "done",
          ok: true,
          errorClass: null,
          retryable: null,
          provenance: await buildRunProvenance({
            result,
            bindingVerified,
            accountId,
          }),
          result: sanitizeResult(result, artifactRegistration.warnings),
          // Repeat the staging proof on the terminal event so consumers that
          // only persist the result still get the upload-plumbing evidence.
          ...(uploadIntegrity ? { uploadIntegrity } : {}),
        });
        logger(
          `[serve] Run ${runId} completed in ${Date.now() - runStartedAt}ms${
            artifactDescriptors.length > 0
              ? `; ${artifactDescriptors.length} artifact(s) ready for bridge transfer`
              : ""
          }`,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        runErrorMessage = message;
        const details = (error as Partial<OracleUserError>)?.details;
        const declaredClass = details?.oracleErrorClass;
        const declaredRetryable = details?.retryable;
        runErrorClass = isRunErrorClass(declaredClass)
          ? declaredClass
          : classifyRunErrorClass(message, submittedAt !== null);
        runRetryable =
          typeof declaredRetryable === "boolean"
            ? declaredRetryable
            : runErrorClass === "capacity_busy" ||
              runErrorClass === "transport_interrupted_before_submit";
        sendEvent({
          type: "done",
          ok: false,
          errorClass: runErrorClass,
          errorMessage: message,
          retryable: runRetryable,
          provenance: await buildRunProvenance({
            result: runResult,
            bindingVerified,
            accountId,
          }),
        });
        logger(
          `[serve] Run ${runId} failed after ${Date.now() - runStartedAt}ms (${runErrorClass}, retryable=${runRetryable}): ${message}`,
        );
      } finally {
        busy = false;
        lastRunProgressAtMs = null;
        if (activeRun?.id === runId) {
          activeRun = null;
        }
        responseCompleted = true;
        // Exactly one oracle.run.v1 line per accepted run — success, failure,
        // and client-abort all land here. Sink failures are logged, never
        // allowed to disturb the response path.
        try {
          const attachmentDigests: RunAttachmentDigest[] | null = uploadIntegrity
            ? [
                ...uploadIntegrity.attachments,
                ...(uploadIntegrity.fallbackAttachments ?? []),
              ].map((entry) => ({
                index: entry.index,
                bytes: entry.bytes,
                sha256: entry.sha256,
              }))
            : null;
          const challengeMatched = runErrorMessage
            ? /challenge|captcha|interstitial/i.test(runErrorMessage)
            : null;
          await appendOracleRunEvent(
            {
              run_id: runId,
              job_id: typeof payload.options?.jobId === "string" ? payload.options.jobId : null,
              account_id: accountId,
              lane_id: laneId,
              port: boundPort,
              accepted_at: acceptedAt,
              submitted_at: submittedAt,
              first_token_at: null,
              completed_at: new Date().toISOString(),
              scheduled_concurrency: null,
              active_tab_leases: activeTabLeasesAtSubmit,
              busy_workers: null,
              error_class: runErrorClass,
              done_ok: runErrorMessage === null,
              challenge_detected:
                runErrorClass === "account_quarantine" ? true : challengeMatched,
              model_verified: runResult?.modelSelection?.verified ?? null,
              max_active_before_first_token: null,
              mean_active_during_ttft: null,
              max_active_during_generation: null,
              overlap_ms_at_c1: null,
              overlap_ms_at_c2: null,
              overlap_ms_at_c3: null,
              observed_egress_ip: null,
              attachments: attachmentDigests,
              conversation_id_hash: runResult?.conversationId
                ? sha256Hex(runResult.conversationId)
                : null,
              provenance: runResult?.modelSelection
                ? {
                    model_requested: runResult.modelSelection.requestedModel ?? null,
                    model_resolved: runResult.modelSelection.resolvedLabel ?? null,
                    model_verified: runResult.modelSelection.verified ?? null,
                  }
                : null,
            },
            { assertAbsent: [authToken] },
          );
        } catch (sinkError) {
          logger(
            `[serve] run-event sink append failed for run ${runId}: ${
              sinkError instanceof Error ? sinkError.message : String(sinkError)
            }`,
          );
        }
        if (!res.destroyed && !res.writableEnded) {
          res.end();
        }
        if (runDir) {
          try {
            await rm(runDir, { recursive: true, force: true });
          } catch {
            // ignore cleanup errors
          }
        }
      }
    })().catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      logger(
        `[serve] Unhandled request failure${requestRunId ? ` for run ${requestRunId}` : ""} from ${formatSocket(req)}: ${message}`,
      );
      if (!res.headersSent) {
        res.writeHead(500, {
          "Content-Type": "application/json",
          ...(requestRunId ? identityHeaders(requestRunId) : {}),
        });
      }
      res.end(JSON.stringify({ error: "internal_error", ...(requestRunId ? { runId: requestRunId } : {}) }));
      admitting = false;
      busy = false;
      activeRun = null;
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(options.port ?? 0, options.host ?? "0.0.0.0", () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Unable to determine server address.");
  }
  boundPort = address.port;
  if (!explicitLaneId) {
    // Default lane id contract: <account_id>-<port>. The port is only known
    // once the listener is bound, and no request can arrive before that.
    laneId = `${accountId}-${address.port}`;
  }
  const reachable = formatReachableAddresses(address.address, address.port);
  const primary = reachable[0] ?? `${address.address}:${address.port}`;
  const extras = reachable.slice(1);
  const also = extras.length ? `, also [${extras.join(", ")}]` : "";
  logger(color(chalk.cyanBright.bold, `Listening at ${primary}${also}`));
  // Effective values are non-secret; surfacing them at startup lets fleet
  // tooling confirm every worker runs with safe run-isolation settings.
  logger(
    `[serve] Effective run config: timeoutMs=${effectiveRunConfig.timeoutMs} profileLockTimeoutMs=${effectiveRunConfig.profileLockTimeoutMs} maxConcurrentTabs=${effectiveRunConfig.maxConcurrentTabs}`,
  );
  // Never echo a supplied token: startup logs land in service journals, and a
  // shared bearer secret copied into every journal defeats file permissions
  // and token rotation alike. Log a short token id (sha256 prefix) instead so
  // operators can still tell WHICH token generation a worker is running.
  const tokenWasSupplied = resolvedToken.source !== "generated";
  const printTokenOptIn =
    process.env.ORACLE_SERVE_PRINT_TOKEN === "1" || Boolean(process.stdout.isTTY);
  if (!tokenWasSupplied && printTokenOptIn) {
    // Freshly generated token for an interactive first run: printing it once
    // is the only way the operator can hand it to clients.
    logger(color(chalk.yellowBright, `Access token: ${authToken}`));
  } else {
    logger(
      color(
        chalk.yellowBright,
        `Access token: <redacted> (token id ${tokenIdForLog(authToken)}, source ${resolvedToken.source})`,
      ),
    );
    if (!tokenWasSupplied) {
      logger(
        "Token was generated randomly but not printed (non-interactive session). " +
          "Set ORACLE_SERVE_PRINT_TOKEN=1 to print it once, or supply a token explicitly.",
      );
    }
  }
  logger("Leave this terminal running; press Ctrl+C to stop oracle serve.");

  return {
    port: address.port,
    token: authToken,
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

function buildHealthResponse({
  startedAt,
  busy,
  activeRun,
  effectiveConfig,
}: {
  startedAt: number;
  busy: boolean;
  activeRun: ActiveRunState | null;
  effectiveConfig: {
    timeoutMs: number | null | undefined;
    profileLockTimeoutMs: number | null | undefined;
    maxConcurrentTabs: number | null | undefined;
  };
}): {
  ok: boolean;
  version: string;
  uptimeSeconds: number;
  busy: boolean;
  activeRun?: RemoteActiveRunInfo;
  capabilities: RemoteArtifactCapabilities;
  effectiveConfig: {
    timeoutMs: number | null | undefined;
    profileLockTimeoutMs: number | null | undefined;
    maxConcurrentTabs: number | null | undefined;
  };
  error?: string;
} {
  return {
    ok: !busy,
    version: getCliVersion(),
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    busy,
    capabilities: ARTIFACT_CAPABILITIES,
    // Integration point for the dedicated /ready endpoint: it should surface
    // these exact field names (timeoutMs, profileLockTimeoutMs,
    // maxConcurrentTabs) so fleet tooling reads one shape everywhere.
    effectiveConfig,
    ...(activeRun ? { activeRun: serializeActiveRun(activeRun) } : {}),
    ...(busy ? { error: "busy" } : {}),
  };
}

function serializeActiveRun(run: ActiveRunState): RemoteActiveRunInfo {
  return {
    id: run.id,
    startedAt: new Date(run.startedAtMs).toISOString(),
    ageSeconds: Math.max(0, Math.round((Date.now() - run.startedAtMs) / 1000)),
    clientConnected: run.clientConnected,
    promptChars: run.promptChars,
    ...(run.sessionId ? { sessionId: run.sessionId } : {}),
    ...(run.desiredModel ? { desiredModel: run.desiredModel } : {}),
  };
}

export async function serveRemote(options: RemoteServerOptions = {}): Promise<void> {
  // Resolve the access token before any interactive warm-up (cookie probing,
  // login prompts): a worker with a misconfigured credential path must refuse
  // to start immediately, not after minutes of browser setup. The resolved
  // value is re-read inside createRemoteServer; this early pass is the
  // fail-loud gate.
  await resolveServeAuthToken({ tokenFile: options.tokenFile, token: options.token });
  const manualProfileDir =
    options.manualLoginProfileDir ?? path.join(os.homedir(), ".oracle", "browser-profile");
  const attachOnlyRequested =
    options.attachOnly ?? process.env.ORACLE_SERVE_ATTACH_ONLY === "1";
  const preferManualLogin =
    options.manualLoginDefault ||
    attachOnlyRequested ||
    process.platform === "win32" ||
    isWsl();
  let cookies: CookieParam[] | null = null;
  let opened = false;

  if (isWsl() && process.env.ORACLE_ALLOW_WSL_SERVE !== "1") {
    console.log(
      "WSL detected. For reliable browser automation, run `oracle serve` from Windows PowerShell/Command Prompt so we can use your Windows Chrome profile.",
    );
    console.log(
      "If you want to stay in WSL anyway, set ORACLE_ALLOW_WSL_SERVE=1 and ensure a Linux Chrome is installed, then rerun.",
    );
    console.log(
      "Alternatively, start Windows Chrome with --remote-debugging-port=9222 and use `--remote-chrome <windows-ip>:9222`.",
    );
    return;
  }

  if (!preferManualLogin) {
    // Warm-up: ensure this host has a ChatGPT login before accepting runs.
    const result = await loadLocalChatgptCookies(console.log, CHATGPT_URL);
    cookies = result.cookies;
    opened = result.opened;
  }

  if (!cookies || cookies.length === 0) {
    console.log("No ChatGPT cookies detected on this host.");
    if (preferManualLogin) {
      // Attach-only / fail-closed: serve never launches Chrome. Several
      // workers may share this profile, and a worker-side launch (the old
      // fire-and-forget fallback) races their startups against each other on
      // one --user-data-dir: singleton-lock collisions, profile split-brain,
      // and a browser nobody owns. The worker attaches to the operator's
      // pre-launched Chrome or stays unready until one appears.
      await mkdir(manualProfileDir, { recursive: true });
      console.log(
        `Using manual-login Chrome profile at ${manualProfileDir} (attach-only; serve does not launch browsers).`,
      );
      const probe = await probeAttachTarget({
        profileDir: manualProfileDir,
        fixedPort:
          options.devtoolsPort ?? parsePositiveIntEnv(process.env.ORACLE_SERVE_DEVTOOLS_PORT),
      });
      if (probe.ok) {
        console.log(
          `Attach target ready: DevTools port ${probe.port} (${probe.portSource}); runs will attach to this Chrome.`,
        );
      } else {
        console.log(
          `No attachable Chrome (${probe.reason}). Serve starts UNREADY and will refuse runs until the browser service is up.`,
        );
        console.log(
          `Start the dedicated Chrome with --user-data-dir=${manualProfileDir} and remote debugging enabled, then this worker will attach automatically.`,
        );
      }
    } else if (opened) {
      console.log(
        "Opened chatgpt.com for login. Sign in, then restart `oracle serve` to continue.",
      );
      return;
    } else {
      console.log(
        "Please open https://chatgpt.com/ in this host's browser and sign in; then rerun.",
      );
      console.log(
        "Tip: install xdg-utils (xdg-open) to enable automatic browser opening on Linux/WSL.",
      );
      return;
    }
  } else {
    console.log(
      `Detected ${cookies.length} ChatGPT cookies on this host; runs will reuse this session.`,
    );
  }

  const server = await createRemoteServer({
    ...options,
    manualLoginDefault: preferManualLogin,
    manualLoginProfileDir: manualProfileDir,
  });
  await new Promise<void>((resolve) => {
    const shutdown = () => {
      console.log("Shutting down remote service...");
      server
        .close()
        .catch((error) => console.error("Failed to close remote server:", error))
        .finally(() => resolve());
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });
}

function matchArtifactRequest(
  req: http.IncomingMessage,
): { runId: string; artifactId: string } | null {
  if (req.method !== "GET" || !req.url) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(req.url, "http://oracle.local");
  } catch {
    return null;
  }
  const match = /^\/runs\/([^/]+)\/artifacts\/([^/]+)$/.exec(url.pathname);
  if (!match) {
    return null;
  }
  try {
    return {
      runId: decodeURIComponent(match[1] ?? ""),
      artifactId: decodeURIComponent(match[2] ?? ""),
    };
  } catch {
    return null;
  }
}

async function serveRemoteArtifact(params: {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  authToken: string;
  artifactRegistry: Map<string, RegisteredRemoteArtifact>;
  logger: (message: string) => void;
  verbose: boolean;
  runId: string;
  artifactId: string;
}): Promise<void> {
  if (!isAuthorizedBearer(params.req.headers.authorization, params.authToken)) {
    if (params.verbose) {
      params.logger(
        `[serve] Unauthorized artifact transfer attempt from ${formatSocket(params.req)} (missing/invalid token)`,
      );
    }
    params.res.writeHead(401, { "Content-Type": "application/json" });
    params.res.end(JSON.stringify({ error: "unauthorized" }));
    return;
  }

  pruneExpiredArtifacts(params.artifactRegistry);
  const key = remoteArtifactKey(params.runId, params.artifactId);
  const artifact = params.artifactRegistry.get(key);
  if (!artifact) {
    params.res.writeHead(404, { "Content-Type": "application/json" });
    params.res.end(JSON.stringify({ error: "artifact_not_found" }));
    return;
  }
  if (Date.now() > artifact.expiresAt) {
    params.artifactRegistry.delete(key);
    params.res.writeHead(410, { "Content-Type": "application/json" });
    params.res.end(JSON.stringify({ error: "artifact_expired" }));
    return;
  }

  const fileStat = await stat(artifact.filePath).catch(() => null);
  if (!fileStat?.isFile() || fileStat.size <= 0) {
    params.res.writeHead(410, { "Content-Type": "application/json" });
    params.res.end(JSON.stringify({ error: "artifact_unavailable" }));
    return;
  }
  if (fileStat.size > MAX_REMOTE_ARTIFACT_BYTES) {
    params.res.writeHead(413, { "Content-Type": "application/json" });
    params.res.end(JSON.stringify({ error: "artifact_too_large" }));
    return;
  }

  const filename = sanitizeArtifactFilename(artifact.descriptor.filename, "artifact.bin");
  params.res.writeHead(200, {
    "Content-Type":
      sanitizeArtifactMimeType(artifact.descriptor.mimeType) ?? "application/octet-stream",
    "Content-Length": fileStat.size,
    "Content-Disposition": `attachment; filename="${filename.replace(/"/g, "")}"`,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Oracle-Artifact-Id": artifact.descriptor.artifactId,
    "X-Oracle-Artifact-Sha256": artifact.descriptor.sha256,
  });

  await pipeline(createReadStream(artifact.filePath), params.res).catch((error) => {
    params.logger(
      `[serve] Artifact transfer failed for ${artifact.descriptor.artifactId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  });
}

function pruneExpiredArtifacts(artifactRegistry: Map<string, RegisteredRemoteArtifact>): void {
  const now = Date.now();
  for (const [key, artifact] of artifactRegistry) {
    if (artifact.expiresAt <= now) {
      artifactRegistry.delete(key);
    }
  }
}

function remoteArtifactKey(runId: string, artifactId: string): string {
  return `${runId}:${artifactId}`;
}

async function registerRemoteArtifacts(params: {
  runId: string;
  result: BrowserRunResult;
  artifactRegistry: Map<string, RegisteredRemoteArtifact>;
  logger: (message: string) => void;
}): Promise<{ descriptors: RemoteArtifactDescriptor[]; warnings: BrowserRunWarning[] }> {
  pruneExpiredArtifacts(params.artifactRegistry);
  const seen = new Set<string>();
  const fileArtifacts: SessionArtifact[] = [
    ...(params.result.savedFiles ?? []),
    ...(params.result.artifacts ?? []).filter((artifact) => artifact.kind === "file"),
  ];
  const descriptors: RemoteArtifactDescriptor[] = [];
  const warnings: BrowserRunWarning[] = [];
  for (const artifact of fileArtifacts) {
    if (!artifact?.path || seen.has(artifact.path)) {
      continue;
    }
    seen.add(artifact.path);
    const registration = await buildRemoteArtifactRegistration(params.runId, artifact).catch(
      (error) => {
        const filename = sanitizeArtifactFilename(path.basename(artifact.path), "artifact.bin");
        params.logger(
          `[serve] Skipping remote artifact descriptor: ${error instanceof Error ? error.message : String(error)}`,
        );
        warnings.push({
          code: "remote-artifact-registration-failed",
          severity: "warning",
          message:
            `Oracle captured the browser text response, but the bridge host could not prepare ${filename} for transfer. ` +
            "Open the ChatGPT browser on the bridge host, download the ZIP/file shown in the current response, and copy it to a cloud-readable path.",
        });
        return null;
      },
    );
    if (!registration) {
      continue;
    }
    params.artifactRegistry.set(
      remoteArtifactKey(params.runId, registration.descriptor.artifactId),
      {
        descriptor: registration.descriptor,
        filePath: registration.filePath,
        expiresAt: Date.now() + REMOTE_ARTIFACT_TTL_MS,
      },
    );
    descriptors.push(registration.descriptor);
  }
  return { descriptors, warnings };
}

async function buildRemoteArtifactRegistration(
  runId: string,
  artifact: SessionArtifact,
): Promise<{ descriptor: RemoteArtifactDescriptor; filePath: string }> {
  if (artifact.path.endsWith(".crdownload")) {
    throw new Error("artifact is still a Chrome partial download");
  }
  const filePath = await resolveRegisteredArtifactPath(artifact.path);
  const fileStat = await stat(filePath);
  if (!fileStat.isFile() || fileStat.size <= 0) {
    throw new Error("artifact is not a completed non-empty file");
  }
  if (fileStat.size > MAX_REMOTE_ARTIFACT_BYTES) {
    throw new Error("artifact exceeds bridge transfer size limit");
  }
  const filename = sanitizeArtifactFilename(path.basename(filePath), "artifact.bin");
  const mimeType = sanitizeArtifactMimeType(artifact.mimeType);
  // Recompute security metadata from the exact file registered for transfer.
  const validation = await validateArtifactFile({
    path: filePath,
    filename,
    mimeType,
  });
  const sha256 = await computeFileSha256(filePath);
  return {
    filePath,
    descriptor: {
      artifactId: randomUUID(),
      runId,
      kind: "file",
      filename,
      label: artifact.label ?? filename,
      mimeType,
      byteSize: fileStat.size,
      sha256,
      validation,
      sourceUrlKind: classifySourceUrlKind(artifact.sourceUrl),
      transferStatus: "ready",
    },
  };
}

async function resolveRegisteredArtifactPath(filePath: string): Promise<string> {
  const [resolvedFile, sessionsRoot] = await Promise.all([
    realpath(filePath),
    realpath(path.join(getOracleHomeDir(), "sessions")),
  ]);
  const relative = path.relative(sessionsRoot, resolvedFile);
  const segments = relative.split(path.sep);
  if (
    !relative ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative) ||
    segments.length < 3 ||
    segments[1] !== "artifacts"
  ) {
    throw new Error("artifact is outside Oracle's session artifact boundary");
  }
  return resolvedFile;
}

function classifySourceUrlKind(sourceUrl?: string): RemoteArtifactDescriptor["sourceUrlKind"] {
  if (sourceUrl?.startsWith("sandbox:")) {
    return "sandbox";
  }
  if (sourceUrl === "browser-download") {
    return "browser-download";
  }
  return "chatgpt-file-endpoint";
}

async function readRequestBody(
  req: http.IncomingMessage,
  limits: { maxBytes: number; deadlineMs: number } = {
    maxBytes: MAX_RUN_REQUEST_BODY_BYTES,
    deadlineMs: RUN_BODY_READ_DEADLINE_MS,
  },
): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
      req.off("aborted", onAborted);
      req.off("close", onAborted);
      fn();
    };

    // A peer that trickles the body forever must not hold the admission slot
    // indefinitely: bound the whole body read with one deadline.
    const deadline = setTimeout(() => {
      settle(() =>
        reject(
          new RequestBodyError(
            "timed_out",
            `request body not received within ${limits.deadlineMs}ms`,
          ),
        ),
      );
    }, limits.deadlineMs);
    deadline.unref?.();

    const onData = (chunk: Buffer | string) => {
      const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      totalBytes += buffer.length;
      if (totalBytes > limits.maxBytes) {
        settle(() =>
          reject(
            new RequestBodyError(
              "too_large",
              `request body exceeds ${limits.maxBytes} byte limit`,
            ),
          ),
        );
        return;
      }
      chunks.push(buffer);
    };
    const onEnd = () => {
      settle(() => resolve(Buffer.concat(chunks).toString("utf8")));
    };
    const onError = (error: Error) => {
      settle(() => reject(new RequestBodyError("aborted", error.message)));
    };
    const onAborted = () => {
      settle(() => reject(new RequestBodyError("aborted", "request aborted by peer")));
    };

    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
    req.on("aborted", onAborted);
    // Some teardown paths close the socket without an error/aborted event;
    // `end` wins the settle race on a normal completion, so this only fires
    // for a genuinely torn-down request.
    req.on("close", onAborted);
  });
}

const DEFAULT_ACCOUNT_ID = "acct1";

export interface FleetManifestStatus {
  present: boolean;
  /** null when absent/unparseable-key-free; false on any mismatch. */
  match: boolean | null;
  mismatches: string[];
}

/**
 * Reads the per-box fleet manifest (if present) and reports whether this
 * worker's live identity/config matches it. EXPOSURE ONLY: readiness surfaces
 * the verdict for supervision; refusing /runs on mismatch is a separate
 * enforcement step. Keys absent from the manifest are not checked.
 */
async function readFleetManifestStatus(worker: {
  accountId: string;
  port: number | null;
  devtoolsPort: number | null;
  effectiveConfig: {
    timeoutMs: number | null | undefined;
    profileLockTimeoutMs: number | null | undefined;
    maxConcurrentTabs: number | null | undefined;
  };
}): Promise<FleetManifestStatus> {
  const manifestPath =
    process.env.ORACLE_FLEET_MANIFEST ??
    path.join(os.homedir(), ".config", "oracle-fleet", "manifest.json");
  let raw: string;
  try {
    raw = await readFile(manifestPath, "utf8");
  } catch {
    return { present: false, match: null, mismatches: [] };
  }
  let manifest: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return { present: true, match: false, mismatches: ["manifest-not-an-object"] };
    }
    manifest = parsed as Record<string, unknown>;
  } catch {
    return { present: true, match: false, mismatches: ["manifest-unparseable"] };
  }
  const mismatches: string[] = [];
  if (typeof manifest.account_id === "string" && manifest.account_id !== worker.accountId) {
    mismatches.push("account_id");
  }
  if (Array.isArray(manifest.ports) && worker.port !== null) {
    const ports = manifest.ports.filter((entry): entry is number => typeof entry === "number");
    if (!ports.includes(worker.port)) {
      mismatches.push("ports");
    }
  }
  if (
    typeof manifest.devtools_port === "number" &&
    worker.devtoolsPort !== null &&
    manifest.devtools_port !== worker.devtoolsPort
  ) {
    mismatches.push("devtools_port");
  }
  if (
    typeof manifest.maxConcurrentTabs === "number" &&
    manifest.maxConcurrentTabs !== worker.effectiveConfig.maxConcurrentTabs
  ) {
    mismatches.push("maxConcurrentTabs");
  }
  if (
    typeof manifest.profileLockTimeoutMs === "number" &&
    manifest.profileLockTimeoutMs !== worker.effectiveConfig.profileLockTimeoutMs
  ) {
    mismatches.push("profileLockTimeoutMs");
  }
  if (
    typeof manifest.timeoutMs === "number" &&
    manifest.timeoutMs !== worker.effectiveConfig.timeoutMs
  ) {
    mismatches.push("timeoutMs");
  }
  return { present: true, match: mismatches.length === 0, mismatches };
}

/** Plain hex sha256 for hashed identifiers (e.g. conversation ids). */
function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Provenance summary for the terminal done event: what the worker VERIFIED
 * (model selection, structural capture binding, quarantine-latch cleanliness).
 * Provenance proves plumbing, not answer correctness; unknowns stay null.
 */
async function buildRunProvenance(params: {
  result: BrowserRunResult | null;
  bindingVerified: boolean | null;
  accountId: string;
}): Promise<RemoteRunProvenanceSummary> {
  let challengeClean: boolean | null = null;
  try {
    const latch = await getQuarantineLatchState({ accountId: params.accountId });
    challengeClean = !latch.quarantined;
  } catch {
    challengeClean = null;
  }
  const selection = params.result?.modelSelection ?? null;
  return {
    modelVerified: selection?.verified ?? null,
    modelRequested: selection?.requestedModel ?? null,
    modelResolved: selection?.resolvedLabel ?? null,
    captureBindingVerified: params.bindingVerified,
    challengeClean,
  };
}

function parsePositiveIntEnv(value: string | undefined): number | undefined {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * Short non-reversible identifier for a token generation. Safe to log: eight
 * hex chars of the SHA-256 digest identify which rotation a worker holds
 * without exposing usable secret material.
 */
export function tokenIdForLog(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex").slice(0, 8);
}

export interface FleetSafeServeConfigInput {
  profileLockTimeoutMs?: number | null;
  timeoutMs?: number | null;
  maxConcurrentTabs?: number | null;
}

/**
 * Startup guard for serve/fleet workers. `<= 0` is a documented DISABLE
 * sentinel for these keys in local single-user runs, but on a shared worker:
 * - profileLockTimeoutMs <= 0 silently disables the serialized-submit
 *   profile lock, allowing composer cross-talk between concurrent runs
 *   (prompts landing in the wrong conversation — the worst wrong-answer
 *   class);
 * - timeoutMs <= 0 means an unbounded tab-lease wait and a permanently
 *   wedged worker;
 * - maxConcurrentTabs outside 1..3 either starves the lane or exceeds the
 *   validated per-account tab budget.
 * A worker with any of these misconfigured must refuse to start rather than
 * degrade silently.
 */
export function assertFleetSafeServeBrowserConfig(effective: FleetSafeServeConfigInput): void {
  const problems: string[] = [];
  const lock = effective.profileLockTimeoutMs;
  if (typeof lock !== "number" || !Number.isFinite(lock) || lock <= 0) {
    problems.push(
      `profileLockTimeoutMs=${String(lock)} (must be > 0; a non-positive value disables the serialized-submit profile lock)`,
    );
  }
  const timeout = effective.timeoutMs;
  if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0) {
    problems.push(
      `timeoutMs=${String(timeout)} (must be > 0; a non-positive value permits an unbounded tab-lease wait)`,
    );
  }
  const tabs = effective.maxConcurrentTabs;
  if (typeof tabs !== "number" || !Number.isInteger(tabs) || tabs < 1 || tabs > 3) {
    problems.push(`maxConcurrentTabs=${String(tabs)} (must be an integer between 1 and 3)`);
  }
  if (problems.length > 0) {
    throw new Error(
      `Refusing to start remote serve with unsafe effective browser config: ${problems.join("; ")}`,
    );
  }
}

export type ServeTokenSource = "token-file" | "env-token-file" | "env" | "flag" | "generated";

/**
 * Resolve the serve access token without ever requiring the secret in argv
 * (argv is world-visible via /proc/<pid>/cmdline, ps, and crash reports).
 *
 * Precedence: --token-file > ORACLE_REMOTE_TOKEN_FILE > ORACLE_REMOTE_TOKEN
 * > --token > freshly generated. File modes fail loud (missing/empty/
 * world-readable) so a misconfigured worker refuses to start instead of
 * silently serving with a token nobody expects.
 */
export async function resolveServeAuthToken(options: {
  tokenFile?: string;
  token?: string;
}): Promise<{ token: string; source: ServeTokenSource }> {
  const flagTokenFile = options.tokenFile?.trim();
  if (flagTokenFile) {
    return { token: await readTokenFile(flagTokenFile), source: "token-file" };
  }
  const envTokenFile = process.env.ORACLE_REMOTE_TOKEN_FILE?.trim();
  if (envTokenFile) {
    return { token: await readTokenFile(envTokenFile), source: "env-token-file" };
  }
  const envToken = process.env.ORACLE_REMOTE_TOKEN?.trim();
  if (envToken) {
    return { token: envToken, source: "env" };
  }
  const flagToken = options.token?.trim();
  if (flagToken) {
    return { token: flagToken, source: "flag" };
  }
  return { token: randomBytes(16).toString("hex"), source: "generated" };
}

async function readTokenFile(filePath: string): Promise<string> {
  let contents: string;
  try {
    contents = await readFile(filePath, "utf8");
  } catch (error) {
    throw new Error(
      `Unable to read token file ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (process.platform !== "win32") {
    const fileStat = await stat(filePath).catch(() => null);
    if (fileStat && (fileStat.mode & 0o004) !== 0) {
      throw new Error(
        `Refusing world-readable token file ${filePath} (mode ${(fileStat.mode & 0o777).toString(8)}); chmod 600 it.`,
      );
    }
  }
  const token = contents.trim();
  if (!token) {
    throw new Error(`Token file ${filePath} is empty.`);
  }
  return token;
}

/**
 * Identity labels are echoed in response headers and log lines, so they must
 * stay short, neutral tokens. Anything else (whitespace, separators that could
 * smuggle header/log content, overlong values) is rejected and replaced with
 * the built-in default rather than propagated.
 */
function sanitizeIdentityLabel(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || !/^[A-Za-z0-9._-]{1,64}$/.test(trimmed)) {
    return undefined;
  }
  return trimmed;
}

function isAuthorizedBearer(authHeader: string | undefined, authToken: string): boolean {
  try {
    return timingSafeEqual(Buffer.from(authHeader ?? ""), Buffer.from(`Bearer ${authToken}`));
  } catch {
    return false;
  }
}

function sanitizeName(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9._-]/g, "_");
}

class AttachmentIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttachmentIntegrityError";
  }
}

/**
 * Collision-proof stored name: NNN-<sha256:12>-<sanitized original name>.
 * Sanitizing alone maps distinct inputs (e.g. "a/b.txt" and "a_b.txt") to the
 * same file name, silently overwriting one attachment with another — the
 * model then answers about the wrong file. The zero-padded index alone makes
 * collisions impossible; the content-hash fragment keeps the name joinable
 * to the integrity manifest.
 */
function buildStoredAttachmentName(index: number, sha256: string, originalName: string): string {
  const safeName = sanitizeName(originalName).slice(0, 120) || "attachment";
  return `${String(index).padStart(3, "0")}-${sha256.slice(0, 12)}-${safeName}`;
}

async function stageAttachmentsWithIntegrity(params: {
  payloadAttachments: unknown;
  dir: string;
  fallbackLabel: string;
}): Promise<{
  attachments: BrowserAttachment[];
  manifest: RemoteAttachmentIntegrityEntry[];
}> {
  const entries = Array.isArray(params.payloadAttachments)
    ? (params.payloadAttachments as RemoteAttachmentPayload[])
    : [];
  const attachments: BrowserAttachment[] = [];
  const manifest: RemoteAttachmentIntegrityEntry[] = [];
  for (const [index, attachment] of entries.entries()) {
    const originalName = attachment.fileName ?? `${params.fallbackLabel}-${index + 1}`;
    const content = Buffer.from(
      typeof attachment.contentBase64 === "string" ? attachment.contentBase64 : "",
      "base64",
    );
    if (typeof attachment.sizeBytes === "number" && attachment.sizeBytes !== content.length) {
      // Fail loud: a declared-size mismatch means the upload was truncated or
      // corrupted in transit; silently staging it would hand the model wrong
      // bytes.
      throw new AttachmentIntegrityError(
        `attachment ${index} (${sanitizeName(originalName)}) declared ${attachment.sizeBytes} bytes but decoded to ${content.length}`,
      );
    }
    const sha256 = createHash("sha256").update(content).digest("hex");
    const storedName = buildStoredAttachmentName(index, sha256, originalName);
    const filePath = path.join(params.dir, storedName);
    await writeFile(filePath, content);
    attachments.push({
      path: filePath,
      displayPath: attachment.displayPath,
      sizeBytes: content.length,
    });
    manifest.push({
      index,
      originalName,
      storedName,
      bytes: content.length,
      sha256,
    });
  }
  return { attachments, manifest };
}

function sanitizeResult(
  result: BrowserRunResult,
  warnings: BrowserRunWarning[] = [],
): BrowserRunResult {
  const mergedWarnings = [
    ...(result.warnings ?? []).flatMap((warning) => {
      const sanitized = sanitizeRemoteWarning(warning);
      return sanitized ? [sanitized] : [];
    }),
    ...warnings,
  ];
  return {
    answerText: result.answerText,
    answerMarkdown: result.answerMarkdown,
    answerHtml: result.answerHtml,
    artifacts: undefined,
    generatedImages: result.generatedImages,
    savedImages: undefined,
    downloadableFiles: sanitizeDownloadableFiles(result.downloadableFiles),
    savedFiles: undefined,
    archive: result.archive,
    tookMs: result.tookMs,
    answerTokens: result.answerTokens,
    answerChars: result.answerChars,
    browserTransport: result.browserTransport,
    warnings: mergedWarnings.length > 0 ? mergedWarnings : undefined,
    chromePid: undefined,
    chromePort: undefined,
    chromeHost: undefined,
    chromeBrowserWSEndpoint: undefined,
    chromeProfileRoot: undefined,
    userDataDir: undefined,
    chromeTargetId: undefined,
    tabUrl: result.tabUrl,
    conversationId: result.conversationId,
    controllerPid: undefined,
    // Preserve model-selection evidence + warnings across the remote boundary.
    // Without these the local session runner fabricates `resolved=(unavailable)`
    // / `verified=no` even when the host actually selected and verified the model.
    // The Chrome pid/port/ws-endpoint/profile fields above stay redacted — those
    // are genuine host secrets; modelSelection/warnings carry only model labels,
    // strategy, status, source, timestamp, and non-sensitive warning text.
    modelSelection: result.modelSelection,
  };
}

function sanitizeDownloadableFiles(
  files: BrowserRunResult["downloadableFiles"],
): BrowserRunResult["downloadableFiles"] {
  if (!files?.length) {
    return undefined;
  }
  const sanitized = files.flatMap((file) => {
    const sandboxUrl = safeSandboxUrl(file.sandboxUrl) ?? safeSandboxUrl(file.url);
    if (!sandboxUrl) {
      return [];
    }
    const filename = safeDisplayString(file.filename);
    const label = safeDisplayString(file.label);
    const mimeType = safeDisplayString(file.mimeType);
    return [
      {
        url: sandboxUrl,
        sandboxUrl,
        ...(filename ? { filename } : {}),
        ...(label ? { label } : {}),
        ...(mimeType ? { mimeType } : {}),
      },
    ];
  });
  return sanitized.length > 0 ? sanitized : undefined;
}

function safeSandboxUrl(value: string | undefined): string | undefined {
  if (typeof value !== "string" || !value.startsWith("sandbox:") || containsLocalPath(value)) {
    return undefined;
  }
  return value;
}

function safeDisplayString(value: string | undefined): string | undefined {
  if (typeof value !== "string" || !value || containsLocalPath(value)) {
    return undefined;
  }
  return value;
}

function sanitizeRemoteWarning(warning: BrowserRunWarning): BrowserRunWarning | null {
  if (!warning?.message || containsLocalPath(warning.message)) {
    return null;
  }
  return {
    code: String(warning.code || "browser-warning"),
    severity: "warning",
    message: warning.message,
    ...(warning.details ? { details: sanitizeWarningDetails(warning.details) } : {}),
  };
}

function sanitizeWarningDetails(details: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details)) {
    if (typeof value === "string") {
      if (containsLocalPath(value)) {
        continue;
      }
      sanitized[key] = value;
    } else if (typeof value === "number" || typeof value === "boolean" || value === null) {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

function containsLocalPath(value: string): boolean {
  return (
    /(?:file:\/\/)?\/(?:Users|home|private|tmp)\//i.test(value) ||
    /(?:file:\/\/)?\/mnt\/[a-z]\/Users\//i.test(value) ||
    /(?:^|[\s"'([])[A-Za-z]:[\\/]/.test(value) ||
    value.includes("\\AppData\\")
  );
}

function formatSocket(req: http.IncomingMessage): string {
  const socket = req.socket;
  const host = socket.remoteAddress ?? "unknown";
  const port = socket.remotePort ?? "0";
  return `${host}:${port}`;
}

function formatReachableAddresses(bindAddress: string, port: number): string[] {
  const ipv4: string[] = [];
  const ipv6: string[] = [];
  if (bindAddress && bindAddress !== "::" && bindAddress !== "0.0.0.0") {
    if (bindAddress.includes(":")) {
      ipv6.push(`[${bindAddress}]:${port}`);
    } else {
      ipv4.push(`${bindAddress}:${port}`);
    }
  }
  try {
    const interfaces = os.networkInterfaces();
    for (const entries of Object.values(interfaces)) {
      if (!entries) continue;
      for (const entry of entries) {
        const iface = entry as
          | { family?: string | number; address: string; internal?: boolean }
          | undefined;
        if (!iface || iface.internal) continue;
        const family =
          typeof iface.family === "string"
            ? iface.family
            : iface.family === 4
              ? "IPv4"
              : iface.family === 6
                ? "IPv6"
                : "";
        if (family === "IPv4") {
          const addr = iface.address;
          if (addr.startsWith("127.")) continue;
          if (addr.startsWith("169.254.")) continue; // APIPA/link-local
          ipv4.push(`${addr}:${port}`);
        } else if (family === "IPv6") {
          const addr = iface.address.toLowerCase();
          if (addr === "::1" || addr.startsWith("fe80:")) continue; // loopback/link-local
          ipv6.push(`[${iface.address}]:${port}`);
        }
      }
    }
  } catch {
    // network interface probing can fail in locked-down environments; ignore
  }
  // de-dup
  return Array.from(new Set([...ipv4, ...ipv6]));
}

async function loadLocalChatgptCookies(
  logger: (message: string) => void,
  targetUrl: string,
): Promise<{ cookies: CookieParam[] | null; opened: boolean }> {
  try {
    logger("Loading ChatGPT cookies from this host's Chrome profile...");
    const { cookies: rawCookies, warnings } = await getCookies({
      url: targetUrl,
      browsers: ["chrome"],
      mode: "merge",
      chromeProfile: "Default",
      timeoutMs: 5_000,
    });
    if (warnings.length) {
      logger(`Cookie warnings:\n- ${warnings.join("\n- ")}`);
    }
    const cookies = rawCookies.map(toCdpCookie).filter((c): c is CookieParam => Boolean(c));
    if (!cookies || cookies.length === 0) {
      logger("No local ChatGPT cookies found on this host. Please log in once; opening ChatGPT...");
      const opened = triggerLocalLoginPrompt(logger, targetUrl);
      return { cookies: null, opened };
    }
    logger(`Loaded ${cookies.length} local ChatGPT cookies on this host.`);
    return { cookies, opened: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const missingDbMatch = message.match(/Unable to locate Chrome cookie DB at (.+?)(?:\.|$)/);
    if (missingDbMatch) {
      const lookedPath = missingDbMatch[1];
      logger(
        `Chrome cookies not found at ${lookedPath}. Set --browser-cookie-path to your Chrome profile or log in manually.`,
      );
    } else {
      logger(`Unable to load local ChatGPT cookies on this host: ${message}`);
    }
    if (process.platform === "linux" && isWsl()) {
      logger(
        "WSL hint: Chrome lives under /mnt/c/Users/<you>/AppData/Local/Google/Chrome/User Data/Default; pass --browser-cookie-path to that directory if auto-detect fails.",
      );
    }
    const opened = triggerLocalLoginPrompt(logger, targetUrl);
    return { cookies: null, opened };
  }
}

function toCdpCookie(cookie: Cookie): CookieParam | null {
  if (!cookie?.name) return null;
  const out: CookieParam = {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path ?? "/",
    secure: cookie.secure ?? true,
    httpOnly: cookie.httpOnly ?? false,
  };
  if (typeof cookie.expires === "number") out.expires = cookie.expires;
  if (cookie.sameSite === "Lax" || cookie.sameSite === "Strict" || cookie.sameSite === "None") {
    out.sameSite = cookie.sameSite;
  }
  return out;
}

function triggerLocalLoginPrompt(logger: (message: string) => void, url: string): boolean {
  const verbose = process.argv.includes("--verbose") || process.env.ORACLE_SERVE_VERBOSE === "1";
  const openers: Array<{ cmd: string; args?: string[] }> = [];

  if (process.platform === "darwin") {
    openers.push({ cmd: "open" });
  } else if (process.platform === "win32") {
    openers.push({ cmd: "start" });
  } else {
    if (isWsl()) {
      // Prefer wslview when available, then fall back to Windows start.exe to open in the host browser.
      openers.push({ cmd: "wslview" });
      openers.push({ cmd: "cmd.exe", args: ["/c", "start", "", url] });
    }
    openers.push({ cmd: "xdg-open" });
  }

  // Add a cross-platform, low-friction fallback when nothing above is available.
  openers.push({ cmd: "sensible-browser" });

  try {
    // Fire and forget; user completes login in the opened browser window.
    if (verbose) {
      logger(`[serve] Login opener candidates: ${openers.map((o) => o.cmd).join(", ")}`);
    }
    const candidate = openers.find((opener) => canSpawn(opener.cmd));
    if (candidate) {
      const child = spawn(candidate.cmd, candidate.args ?? [url], {
        stdio: "ignore",
        detached: true,
      });
      child.unref();
      child.once("error", (error) => {
        if (verbose) {
          logger(
            `[serve] Opener ${candidate.cmd} failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        logger(`Please open ${url} in this host's browser and sign in; then rerun.`);
      });
      logger(
        `Opened ${url} locally via ${candidate.cmd}. Please sign in; subsequent runs will reuse the session.`,
      );
      if (verbose && candidate.args) {
        logger(`[serve] Opener args: ${candidate.args.join(" ")}`);
      }
      return true;
    }
    if (verbose) {
      logger("[serve] No available opener found; prompting manual login.");
    }
    return false;
  } catch {
    return false;
  }
}

function isWsl(): boolean {
  if (process.platform !== "linux") return false;
  return Boolean(process.env.WSL_DISTRO_NAME || os.release().toLowerCase().includes("microsoft"));
}

function canSpawn(cmd: string): boolean {
  if (!cmd) return false;
  try {
    if (process.platform === "win32") {
      // `where` returns non-zero when the command is not found.
      const result = spawnSync("where", [cmd], { stdio: "ignore" });
      return result.status === 0;
    }
    // `command -v` is a shell builtin; run through sh. Fallback to `which`.
    const shResult = spawnSync("sh", ["-c", `command -v ${cmd}`], { stdio: "ignore" });
    if (shResult.status === 0) return true;
    const whichResult = spawnSync("which", [cmd], { stdio: "ignore" });
    return whichResult.status === 0;
  } catch {
    return false;
  }
}

// NOTE: serve is attach-only by design. The former launchManualLoginChrome
// fallback was removed: a worker-side Chrome launch races sibling workers
// sharing one profile (singleton-lock collisions, profile split-brain) and
// silently converts "no operator-prepared browser" into "spawn a new one".
// The launch path is intentionally absent so it cannot be reached.

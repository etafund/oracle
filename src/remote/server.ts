import http from "node:http";
import { createReadStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm, mkdir, writeFile, stat, realpath } from "node:fs/promises";
import chalk from "chalk";
import type { BrowserAttachment, BrowserLogger, CookieParam } from "../browser/types.js";
import { runBrowserMode } from "../browserMode.js";
import type { BrowserRunResult } from "../browserMode.js";
import type {
  RemoteActiveRunInfo,
  RemoteArtifactCapabilities,
  RemoteArtifactDescriptor,
  RemoteRunPayload,
  RemoteRunEvent,
} from "./types.js";
import { MAX_REMOTE_ARTIFACT_BYTES } from "./types.js";
import { getCookies, type Cookie } from "@steipete/sweet-cookie";
import { CHATGPT_URL } from "../browser/constants.js";
import { getCliVersion } from "../version.js";
import { getOracleHomeDir } from "../oracleHome.js";
import {
  cleanupStaleProfileState,
  readDevToolsPort,
  verifyDevToolsReachable,
  writeChromePid,
  writeDevToolsActivePort,
} from "../browser/profileState.js";
import { normalizeChatgptUrl } from "../browser/utils.js";
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
   * Admission limits for /runs request bodies. Defaults match the
   * reverse-proxy tier (10 MiB cap, 60s read deadline); overridable so
   * fault-isolation tests can exercise the refusal paths quickly.
   */
  maxRunRequestBodyBytes?: number;
  runBodyReadDeadlineMs?: number;
}

interface RemoteServerDeps {
  runBrowser?: typeof runBrowserMode;
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

// App-level request admission limits. The reverse-proxy tier caps bodies at
// 10 MiB; the worker must enforce the same bound itself so a request that
// reaches the backend port directly cannot balloon memory or pin the lane
// with an unbounded/slow upload.
export const MAX_RUN_REQUEST_BODY_BYTES = 10 * 1024 * 1024;
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

async function findAvailablePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", (err) => reject(err));
    srv.listen(0, () => {
      const address = srv.address();
      if (typeof address === "object" && address?.port) {
        const port = address.port;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error("Unable to allocate port")));
      }
    });
  });
}

export async function createRemoteServer(
  options: RemoteServerOptions = {},
  deps: RemoteServerDeps = {},
): Promise<RemoteServerInstance> {
  const runBrowser = deps.runBrowser ?? runBrowserMode;
  const server = http.createServer();
  // Socket-layer bounds to complement the app-level admission limits: slow
  // header/body transmission must not hold sockets open indefinitely. The
  // request timeout only covers receiving the request, not the (long-lived)
  // streamed NDJSON response.
  server.headersTimeout = 30_000;
  server.requestTimeout = 120_000;
  const logger = options.logger ?? console.log;
  const authToken = options.token ?? randomBytes(16).toString("hex");
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
    maxBytes: options.maxRunRequestBodyBytes ?? MAX_RUN_REQUEST_BODY_BYTES,
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
        });
        res.writeHead(busy ? 409 : 200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(health));
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
      const refuseRun = (status: number, code: string, extra: Record<string, unknown> = {}) => {
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
        refuseRun(409, "busy", {
          busy: true,
          ...(activeRun ? { activeRun: serializeActiveRun(activeRun) } : {}),
        });
        return;
      }

      admitting = true;
      let payload: RemoteRunPayload | null = null;
      try {
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
        // Admission checks passed: hand the single-flight slot to the browser
        // stage before releasing the admitting stage (no gap in coverage).
        busy = true;
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
      const runDir = await mkdtemp(path.join(os.tmpdir(), `oracle-serve-${runId}-`));
      const attachmentDir = path.join(runDir, "attachments");
      await mkdir(attachmentDir, { recursive: true });

      const sendEvent = (event: RemoteRunEvent) => {
        if (res.destroyed || res.writableEnded) {
          return;
        }
        // Stamp the run id onto every NDJSON line so each event of a run is
        // joinable without relying on stream framing alone.
        res.write(`${JSON.stringify({ runId, ...event })}\n`);
      };

      const attachments: BrowserAttachment[] = [];
      let fallbackSubmission:
        | {
            prompt: string;
            attachments: BrowserAttachment[];
          }
        | undefined;
      try {
        const attachmentsPayload = Array.isArray(payload.attachments) ? payload.attachments : [];
        for (const [index, attachment] of attachmentsPayload.entries()) {
          const safeName = sanitizeName(attachment.fileName ?? `attachment-${index + 1}`);
          const filePath = path.join(attachmentDir, safeName);
          await writeFile(filePath, Buffer.from(attachment.contentBase64, "base64"));
          attachments.push({
            path: filePath,
            displayPath: attachment.displayPath,
            sizeBytes: attachment.sizeBytes,
          });
        }

        if (payload.fallbackSubmission) {
          const fallbackAttachmentDir = path.join(runDir, "fallback-attachments");
          await mkdir(fallbackAttachmentDir, { recursive: true });
          const fallbackAttachments: BrowserAttachment[] = [];
          const fallbackPayload = Array.isArray(payload.fallbackSubmission.attachments)
            ? payload.fallbackSubmission.attachments
            : [];
          for (const [index, attachment] of fallbackPayload.entries()) {
            const safeName = sanitizeName(
              attachment.fileName ?? `fallback-attachment-${index + 1}`,
            );
            const filePath = path.join(fallbackAttachmentDir, safeName);
            await writeFile(filePath, Buffer.from(attachment.contentBase64, "base64"));
            fallbackAttachments.push({
              path: filePath,
              displayPath: attachment.displayPath,
              sizeBytes: attachment.sizeBytes,
            });
          }
          fallbackSubmission = {
            prompt: payload.fallbackSubmission.prompt,
            attachments: fallbackAttachments,
          };
        }

        const automationLogger: BrowserLogger = ((message?: string) => {
          if (typeof message === "string") {
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
        sendEvent({
          type: "result",
          result: sanitizeResult(result, artifactRegistration.warnings),
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
        sendEvent({ type: "error", message });
        logger(`[serve] Run ${runId} failed after ${Date.now() - runStartedAt}ms: ${message}`);
      } finally {
        busy = false;
        if (activeRun?.id === runId) {
          activeRun = null;
        }
        responseCompleted = true;
        if (!res.destroyed && !res.writableEnded) {
          res.end();
        }
        try {
          await rm(runDir, { recursive: true, force: true });
        } catch {
          // ignore cleanup errors
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
  logger(color(chalk.yellowBright, `Access token: ${authToken}`));
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
}: {
  startedAt: number;
  busy: boolean;
  activeRun: ActiveRunState | null;
}): {
  ok: boolean;
  version: string;
  uptimeSeconds: number;
  busy: boolean;
  activeRun?: RemoteActiveRunInfo;
  capabilities: RemoteArtifactCapabilities;
  error?: string;
} {
  return {
    ok: !busy,
    version: getCliVersion(),
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    busy,
    capabilities: ARTIFACT_CAPABILITIES,
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
  const manualProfileDir =
    options.manualLoginProfileDir ?? path.join(os.homedir(), ".oracle", "browser-profile");
  const preferManualLogin = options.manualLoginDefault || process.platform === "win32" || isWsl();
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
      await mkdir(manualProfileDir, { recursive: true });
      console.log(
        `Cookie extraction is unavailable on this platform. Using manual-login Chrome profile at ${manualProfileDir}. Remote runs will reuse this profile; sign in once when the browser opens.`,
      );
      const existingPort = await readDevToolsPort(manualProfileDir);
      if (existingPort) {
        const reachable = await verifyDevToolsReachable({ port: existingPort });
        if (reachable.ok) {
          console.log(
            "Detected an existing automation Chrome session; will reuse it for manual login.",
          );
        } else {
          console.log(
            `Found stale DevToolsActivePort (port ${existingPort}, ${reachable.error}); launching a fresh manual-login Chrome.`,
          );
          await cleanupStaleProfileState(manualProfileDir, console.log, {
            lockRemovalMode: "never",
          });
          void launchManualLoginChrome(manualProfileDir, CHATGPT_URL, console.log);
        }
      } else {
        void launchManualLoginChrome(manualProfileDir, CHATGPT_URL, console.log);
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

async function launchManualLoginChrome(
  profileDir: string,
  url: string,
  logger: (msg: string) => void,
): Promise<void> {
  const timeoutMs = 7000;
  let finished = false;
  const timeout = setTimeout(() => {
    if (!finished) {
      logger(
        `Timed out launching Chrome for manual login. Launch Chrome manually with --user-data-dir=${profileDir} and log in to ${url}.`,
      );
    }
  }, timeoutMs);

  try {
    const chromeLauncher = await import("chrome-launcher");
    const { launch } = chromeLauncher;
    const debugPort = await findAvailablePort();
    logger(`Planned manual-login Chrome DevTools port: ${debugPort}`);
    const chrome = await launch({
      // Expose DevTools so later runs can attach instead of spawning a second Chrome.
      // Use a per-serve free port so the login window stays stable for all runs.
      port: debugPort,
      userDataDir: profileDir,
      startingUrl: url,
      chromeFlags: [
        "--no-first-run",
        "--no-default-browser-check",
        `--user-data-dir=${profileDir}`,
        "--remote-allow-origins=*",
        `--remote-debugging-port=${debugPort}`, // ensure DevToolsActivePort is written even on Windows
      ],
    });

    const chosenPort = chrome?.port ?? debugPort ?? null;
    if (chosenPort) {
      // Persist DevToolsActivePort eagerly so future runs can attach/reuse this Chrome.
      await writeDevToolsActivePort(profileDir, chosenPort);
      if (chrome?.pid) {
        await writeChromePid(profileDir, chrome.pid);
      }
      logger(`Manual-login Chrome DevTools port: ${chosenPort}`);
      logger(`If needed, DevTools JSON at http://127.0.0.1:${chosenPort}/json/version`);
    } else {
      logger(
        "Warning: unable to determine manual-login Chrome DevTools port. Remote runs may fail to attach.",
      );
    }

    finished = true;
    clearTimeout(timeout);
    const portInfo = chosenPort ? ` (DevTools port ${chosenPort})` : "";
    logger(
      `Opened Chrome with manual-login profile at ${profileDir}${portInfo}. Complete login, then rerun remote sessions.`,
    );
  } catch (error) {
    finished = true;
    clearTimeout(timeout);
    const message = error instanceof Error ? error.message : String(error);
    logger(
      `Unable to open Chrome for manual login (${message}). Launch Chrome manually with --user-data-dir=${profileDir} and log in to ${url}.`,
    );
  }
}

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import http from "node:http";

import {
  REMOTE_BROWSER_RECOVERY_ADMISSION_HEADER_VALUES,
  REMOTE_BROWSER_RECOVERY_CLAIM_HEADERS,
  REMOTE_BROWSER_RECOVERY_CLAIM_LOOKUP_PATH,
  REMOTE_BROWSER_RECOVERY_CLAIM_ROUTE_HEADER,
  REMOTE_BROWSER_RECOVERY_CLAIM_ROUTE_HEADER_VALUE,
  REMOTE_BROWSER_RECOVERY_CLAIM_SCHEMA,
  REMOTE_BROWSER_RECOVERY_PATH,
  REMOTE_BROWSER_RECOVERY_PROTOCOL,
  REMOTE_BROWSER_RUN_PATH,
  REMOTE_BROWSER_RUN_SCHEMA,
} from "../../src/remote/types.js";

const MAX_PROXY_BODY_BYTES = 1024 * 1024;
const MAX_CLAIM_RESPONSE_BYTES = 64 * 1024;
const DEFAULT_MAX_NDJSON_LINE_BYTES = 32 * 1024 * 1024;
const SUBMIT_CONFIRMATION_PATTERN = /submitted prompt|prompt submitted|clicked send button/i;
const PROTECTED_ROUTE_PROOF_PATTERN =
  /Protected route: GPT-5\.6 Sol \+ Pro public-menu proof minted at the dispatch boundary/i;
const FORBIDDEN_ANSWER_NOW_CLICK_PATTERN =
  /\b(?:clicked|clicking|auto-clicked|auto-clicking|will click|about to click|attempt(?:ed|ing)? to click)["'\s:-]*(?:the\s+)?["']?Answer now\b/i;
const ROUTE_VALUE_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
const CLAIM_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const RECOVERY_BROWSER_CONFIG_KEYS = new Set([
  "timeoutMs",
  "inputTimeoutMs",
  "queueTimeoutMs",
  "assistantRecheckDelayMs",
  "assistantRecheckTimeoutMs",
  "autoReattachDelayMs",
  "autoReattachIntervalMs",
  "autoReattachTimeoutMs",
  "researchMode",
]);

export interface RemoteRecoveryProxyTarget {
  hostname: string;
  port: number;
}

export interface RemoteRecoveryRouteIdentity {
  runId: string;
  accountId: string;
  laneId: string;
}

export interface RemoteRecoverySeveringProxyOptions {
  target: RemoteRecoveryProxyTarget;
  token: string;
  expectedAccountId: string;
  expectedLaneId: string;
  expectedSessionId: string;
  expectedPromptSha256: string;
  expectedPromptPreviewSha256: string;
  claimReadyTimeoutMs: number;
  claimPollIntervalMs?: number;
  /** Lower only in focused tests; live runs retain the client's 32 MiB cap. */
  maxNdjsonLineBytes?: number;
}

export interface RemoteRecoveryProxySnapshot {
  runPostAttempts: number;
  runPostsForwarded: number;
  recoveryPostAttempts: number;
  recoveryPostsForwarded: number;
  claimLookupsForwarded: number;
  claimLookupStatuses: number[];
  internalClaimLookupStatuses: number[];
  outstandingUpstreamRequests: number;
  runRequestContractVerified: boolean;
  recoveryRequestContractVerified: boolean;
  recoveryClaimBindingVerified: boolean;
  runResponseContractVerified: boolean;
  recoveryResponseContractVerified: boolean;
  protectedRouteProofObserved: boolean;
  submitConfirmationObserved: boolean;
  forbiddenAnswerNowClickObserved: boolean;
  claimReadyBeforeDisconnect: boolean;
  disconnected: boolean;
  acceptedRoute: RemoteRecoveryRouteIdentity | null;
  recoveryRoute: RemoteRecoveryRouteIdentity | null;
}

export interface RemoteRecoverySeveringProxy {
  hostname: "127.0.0.1";
  port: number;
  host: string;
  waitForDisconnect(): Promise<void>;
  snapshot(): RemoteRecoveryProxySnapshot;
  containsSensitive(text: string): boolean;
  redactSensitive(text: string): string;
  close(): Promise<void>;
}

export function assertNoRemoteLaneChallenge(
  response: { statusCode: number; body: Record<string, unknown> },
  phase: string,
): void {
  const quarantine = objectFieldOrEmpty(response.body, "quarantine");
  const signals = [
    response.body.reason,
    response.body.error,
    response.body.errorClass,
    response.body.state,
    quarantine.reason,
    quarantine.failureCode,
  ];
  if (
    response.body.challenge_detected === true ||
    quarantine.quarantined === true ||
    signals.some((value) => typeof value === "string" && isAccountChallengeSignal(value))
  ) {
    throw new Error(`account challenge/quarantine detected during ${phase}`);
  }
}

export async function readOwnerOnlyTokenFile(filePath: string): Promise<string> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(
      filePath,
      constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW),
    );
    const info = await handle.stat();
    const ownerMismatch =
      process.platform !== "win32" &&
      typeof process.getuid === "function" &&
      info.uid !== process.getuid();
    if (
      !info.isFile() ||
      info.size <= 0 ||
      info.size > 4096 ||
      ownerMismatch ||
      (process.platform !== "win32" && ((info.mode & 0o077) !== 0 || (info.mode & 0o400) === 0))
    ) {
      throw new Error(
        "remote token file must be a bounded owner-owned regular file with owner-only permissions (0600 or stricter)",
      );
    }
    const token = (await handle.readFile("utf8")).trim();
    if (!token || token.length > 2048 || /\s/u.test(token)) {
      throw new Error("remote token file contained an invalid token");
    }
    return token;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

interface MutableProxyState extends RemoteRecoveryProxySnapshot {
  claimKey: string | null;
  recoveryCapability: string | null;
  recoveryHintSha256: string | null;
  fatalError: Error | null;
  closed: boolean;
}

/**
 * A real-service test transport that forwards one ordinary /runs request, then
 * cuts only that response after independently authenticating a READY durable
 * recovery claim. It remains alive for the client's claim lookup and one
 * capture-only /recover request. A second /runs is refused locally before it
 * can reach the worker.
 */
export async function startRemoteRecoverySeveringProxy(
  options: RemoteRecoverySeveringProxyOptions,
): Promise<RemoteRecoverySeveringProxy> {
  validateOptions(options);
  const state: MutableProxyState = {
    runPostAttempts: 0,
    runPostsForwarded: 0,
    recoveryPostAttempts: 0,
    recoveryPostsForwarded: 0,
    claimLookupsForwarded: 0,
    claimLookupStatuses: [],
    internalClaimLookupStatuses: [],
    outstandingUpstreamRequests: 0,
    runRequestContractVerified: false,
    recoveryRequestContractVerified: false,
    recoveryClaimBindingVerified: false,
    runResponseContractVerified: false,
    recoveryResponseContractVerified: false,
    protectedRouteProofObserved: false,
    submitConfirmationObserved: false,
    forbiddenAnswerNowClickObserved: false,
    claimReadyBeforeDisconnect: false,
    disconnected: false,
    acceptedRoute: null,
    recoveryRoute: null,
    claimKey: null,
    recoveryCapability: null,
    recoveryHintSha256: null,
    fatalError: null,
    closed: false,
  };

  let resolveDisconnect!: () => void;
  let rejectDisconnect!: (error: Error) => void;
  const disconnected = new Promise<void>((resolve, reject) => {
    resolveDisconnect = resolve;
    rejectDisconnect = reject;
  });
  // The worker can fail immediately after proxy start; keep the promise
  // observable to callers without creating a transient unhandled rejection
  // before they attach their waiter.
  void disconnected.catch(() => undefined);
  const upstreamRequests = new Map<http.ClientRequest, Promise<void>>();

  const trackUpstreamRequest = (request: http.ClientRequest): void => {
    const closed = new Promise<void>((resolve) => {
      request.once("close", resolve);
    });
    upstreamRequests.set(request, closed);
    state.outstandingUpstreamRequests += 1;
    void closed.then(() => {
      upstreamRequests.delete(request);
      state.outstandingUpstreamRequests -= 1;
    });
  };

  const server = http.createServer((clientReq, clientRes) => {
    void handleRequest(clientReq, clientRes).catch((error: unknown) => {
      const safeError =
        error instanceof Error
          ? new Error(
              redactSensitiveText(
                error.message,
                options.token,
                state.claimKey,
                state.recoveryCapability,
              ),
            )
          : new Error("remote recovery proxy request failed");
      state.fatalError ??= safeError;
      if (!state.disconnected) rejectDisconnect(safeError);
      sendJson(clientRes, 502, { error: "remote_recovery_test_proxy_failed" });
    });
  });

  async function handleRequest(
    clientReq: http.IncomingMessage,
    clientRes: http.ServerResponse,
  ): Promise<void> {
    const method = clientReq.method ?? "GET";
    const requestPath = clientReq.url ?? "/";
    if (method === "POST" && requestPath === REMOTE_BROWSER_RUN_PATH) {
      state.runPostAttempts += 1;
      if (state.runPostAttempts !== 1) {
        sendJson(clientRes, 409, { error: "remote_recovery_test_replay_refused" });
        return;
      }
      const body = await readBoundedRequestBody(clientReq);
      validateRunRequest(clientReq.headers, body, options);
      state.runRequestContractVerified = true;
      state.runPostsForwarded += 1;
      forwardRun(body, clientReq.headers, clientRes);
      return;
    }

    if (method === "POST" && requestPath === REMOTE_BROWSER_RECOVERY_PATH) {
      state.recoveryPostAttempts += 1;
      if (state.recoveryPostAttempts !== 1) {
        sendJson(clientRes, 409, { error: "remote_recovery_test_duplicate_recover_refused" });
        return;
      }
      const body = await readBoundedRequestBody(clientReq);
      validateRecoveryRequest(
        clientReq.headers,
        body,
        options,
        state.acceptedRoute,
        state.recoveryHintSha256,
      );
      state.recoveryRequestContractVerified = true;
      state.recoveryClaimBindingVerified = true;
      state.recoveryPostsForwarded += 1;
      forwardRecovery(body, clientReq.headers, clientRes);
      return;
    }

    if (method === "GET" && requestPath === REMOTE_BROWSER_RECOVERY_CLAIM_LOOKUP_PATH) {
      validateClaimLookupRequest(clientReq.headers, options, state);
      state.claimLookupsForwarded += 1;
      forwardOrdinary(clientReq, clientRes, (statusCode) => {
        state.claimLookupStatuses.push(statusCode);
      });
      return;
    }

    forwardOrdinary(clientReq, clientRes);
  }

  function forwardRun(
    body: Buffer,
    incomingHeaders: http.IncomingHttpHeaders,
    clientRes: http.ServerResponse,
  ): void {
    const upstreamReq = http.request(
      {
        hostname: options.target.hostname,
        port: options.target.port,
        path: REMOTE_BROWSER_RUN_PATH,
        method: "POST",
        headers: forwardedHeaders(incomingHeaders, options.target, body.length),
      },
      (upstreamRes) => {
        let upstreamEnded = false;
        let terminalEventObserved = false;
        let terminalSuccessHeld = false;
        let terminalFailureCategory: string | null = null;
        let lineBuffer = "";
        const maxLineBytes = options.maxNdjsonLineBytes ?? DEFAULT_MAX_NDJSON_LINE_BYTES;

        const failControlledDisconnect = (error: Error): void => {
          if (state.fatalError || state.disconnected) return;
          const safe = new Error(
            redactSensitiveText(
              error.message,
              options.token,
              state.claimKey,
              state.recoveryCapability,
            ),
          );
          state.fatalError = safe;
          rejectDisconnect(safe);
          upstreamReq.destroy();
          upstreamRes.destroy();
          clientRes.destroy();
        };

        const maybeDisconnect = (): void => {
          if (
            state.disconnected ||
            state.fatalError ||
            !state.claimReadyBeforeDisconnect ||
            !state.submitConfirmationObserved
          ) {
            return;
          }
          if (!state.protectedRouteProofObserved) {
            failControlledDisconnect(
              new Error(
                "submit was observed without the protected GPT-5.6 Sol + Pro dispatch proof",
              ),
            );
            return;
          }
          state.disconnected = true;
          clientRes.end();
          upstreamReq.destroy();
          upstreamRes.destroy();
          resolveDisconnect();
        };

        const processLine = (line: string): void => {
          if (Buffer.byteLength(line, "utf8") > maxLineBytes) {
            failControlledDisconnect(
              new Error(`worker NDJSON line exceeded the ${maxLineBytes}-byte test proxy cap`),
            );
            return;
          }
          if (terminalEventObserved) {
            failControlledDisconnect(
              new Error("worker emitted data after its terminal done event"),
            );
            return;
          }

          let event: Record<string, unknown> | null = null;
          try {
            const parsed = JSON.parse(line) as unknown;
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
              event = parsed as Record<string, unknown>;
            }
          } catch {
            // Forward malformed evidence so the real client rejects it.
          }

          if (event?.type === "log" && typeof event.message === "string") {
            if (PROTECTED_ROUTE_PROOF_PATTERN.test(event.message)) {
              state.protectedRouteProofObserved = true;
            }
            if (FORBIDDEN_ANSWER_NOW_CLICK_PATTERN.test(event.message)) {
              state.forbiddenAnswerNowClickObserved = true;
              failControlledDisconnect(
                new Error("worker log reported a forbidden Answer now click"),
              );
              return;
            }
            if (SUBMIT_CONFIRMATION_PATTERN.test(event.message)) {
              if (!state.protectedRouteProofObserved) {
                failControlledDisconnect(
                  new Error(
                    "worker crossed submit before emitting the protected GPT-5.6 Sol + Pro proof",
                  ),
                );
                return;
              }
              state.submitConfirmationObserved = true;
            }
          }

          if (event?.type === "done") {
            terminalEventObserved = true;
            if (event.ok === true) {
              terminalSuccessHeld = true;
              return;
            }
            terminalFailureCategory = classifyTerminalFailure(event);
          } else if (event?.type === "error") {
            terminalFailureCategory = classifyTerminalFailure(event);
          }
          clientRes.write(`${line}\n`);
        };

        let route: RemoteRecoveryRouteIdentity;
        try {
          route = validateRunResponse(upstreamRes, options);
          state.acceptedRoute = route;
          state.claimKey = requireCanonicalHeader(
            upstreamRes.headers,
            REMOTE_BROWSER_RECOVERY_CLAIM_HEADERS.claimKey,
            CLAIM_KEY_PATTERN,
          );
          state.runResponseContractVerified = true;
        } catch (error) {
          failControlledDisconnect(toError(error));
          return;
        }

        writeResponseHead(clientRes, upstreamRes);
        upstreamRes.setEncoding("utf8");

        void pollClaimUntilReady(route)
          .then(() => {
            state.claimReadyBeforeDisconnect = true;
            maybeDisconnect();
          })
          .catch((error: unknown) => {
            failControlledDisconnect(toError(error));
          });

        upstreamRes.on("data", (chunk: string) => {
          if (state.disconnected || state.fatalError) return;
          lineBuffer += chunk;
          while (true) {
            const newline = lineBuffer.indexOf("\n");
            if (newline < 0) break;
            const line = lineBuffer.slice(0, newline);
            lineBuffer = lineBuffer.slice(newline + 1);
            processLine(line);
            if (state.disconnected || state.fatalError) return;
          }
          if (Buffer.byteLength(lineBuffer, "utf8") > maxLineBytes) {
            failControlledDisconnect(
              new Error(
                `worker NDJSON line exceeded the ${maxLineBytes}-byte test proxy cap without a newline`,
              ),
            );
            return;
          }
          maybeDisconnect();
        });

        upstreamRes.on("end", () => {
          upstreamEnded = true;
          if (state.disconnected || state.fatalError) return;
          if (lineBuffer.length > 0) {
            processLine(lineBuffer);
            lineBuffer = "";
          }
          if (state.disconnected || state.fatalError) return;
          if (terminalSuccessHeld) {
            // A clean terminal event is emitted only after durable claim
            // publication. Hold it until the independent authenticated lookup
            // catches up, then cut the caller before success can be observed.
            maybeDisconnect();
            return;
          }
          clientRes.end();
          failControlledDisconnect(
            new Error(
              terminalFailureCategory ??
                "worker stream ended before the controlled post-claim disconnect",
            ),
          );
        });
        upstreamRes.on("error", (error) => {
          if (!state.disconnected && !upstreamEnded) failControlledDisconnect(error);
        });
      },
    );
    trackUpstreamRequest(upstreamReq);
    clientRes.on("close", () => {
      if (clientRes.writableEnded || state.disconnected || state.fatalError) return;
      const safe = new Error("run caller disconnected before the controlled post-claim cut");
      state.fatalError = safe;
      rejectDisconnect(safe);
      upstreamReq.destroy();
    });
    upstreamReq.on("error", (error) => {
      if (!state.disconnected && !state.fatalError) {
        const safe = new Error(
          redactSensitiveText(
            error.message,
            options.token,
            state.claimKey,
            state.recoveryCapability,
          ),
        );
        state.fatalError = safe;
        rejectDisconnect(safe);
        clientRes.destroy();
      }
    });
    upstreamReq.end(body);
  }

  function forwardRecovery(
    body: Buffer,
    incomingHeaders: http.IncomingHttpHeaders,
    clientRes: http.ServerResponse,
  ): void {
    const upstreamReq = http.request(
      {
        hostname: options.target.hostname,
        port: options.target.port,
        path: REMOTE_BROWSER_RECOVERY_PATH,
        method: "POST",
        headers: forwardedHeaders(incomingHeaders, options.target, body.length),
      },
      (upstreamRes) => {
        let upstreamEnded = false;
        let lineBuffer = "";
        const maxLineBytes = options.maxNdjsonLineBytes ?? DEFAULT_MAX_NDJSON_LINE_BYTES;
        const failRecovery = (error: Error): void => {
          if (state.fatalError) return;
          state.fatalError = new Error(
            redactSensitiveText(
              error.message,
              options.token,
              state.claimKey,
              state.recoveryCapability,
            ),
          );
          upstreamReq.destroy();
          upstreamRes.destroy();
          clientRes.destroy();
        };
        const inspectLine = (line: string): void => {
          if (Buffer.byteLength(line, "utf8") > maxLineBytes) {
            failRecovery(
              new Error(`recovery NDJSON line exceeded the ${maxLineBytes}-byte test proxy cap`),
            );
            return;
          }
          let event: Record<string, unknown> | null = null;
          try {
            const parsed = JSON.parse(line) as unknown;
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
              event = parsed as Record<string, unknown>;
            }
          } catch {
            // The real client owns full protocol parsing; this observer exists
            // only for the no-click account-safety tripwire.
          }
          if (
            event?.type === "log" &&
            typeof event.message === "string" &&
            FORBIDDEN_ANSWER_NOW_CLICK_PATTERN.test(event.message)
          ) {
            state.forbiddenAnswerNowClickObserved = true;
            failRecovery(new Error("recovery worker log reported a forbidden Answer now click"));
          }
        };
        if (upstreamRes.statusCode === 200) {
          const route = readRouteIdentity(upstreamRes.headers);
          if (
            !route ||
            route.accountId !== options.expectedAccountId ||
            route.laneId !== options.expectedLaneId
          ) {
            upstreamRes.destroy();
            sendJson(clientRes, 502, { error: "remote_recovery_route_identity_mismatch" });
            return;
          }
          state.recoveryRoute = route;
          state.recoveryResponseContractVerified =
            hasExactAdmissionEcho(upstreamRes.headers) &&
            isNdjsonContentType(upstreamRes.headers["content-type"]);
          if (!state.recoveryResponseContractVerified) {
            upstreamRes.destroy();
            sendJson(clientRes, 502, { error: "remote_recovery_response_contract_mismatch" });
            return;
          }
        }
        writeResponseHead(clientRes, upstreamRes);
        upstreamRes.setEncoding("utf8");
        upstreamRes.on("data", (chunk: string) => {
          if (state.fatalError) return;
          lineBuffer += chunk;
          while (true) {
            const newline = lineBuffer.indexOf("\n");
            if (newline < 0) break;
            const line = lineBuffer.slice(0, newline);
            lineBuffer = lineBuffer.slice(newline + 1);
            inspectLine(line);
            if (state.fatalError) return;
          }
          if (Buffer.byteLength(lineBuffer, "utf8") > maxLineBytes) {
            failRecovery(
              new Error(
                `recovery NDJSON line exceeded the ${maxLineBytes}-byte test proxy cap without a newline`,
              ),
            );
            return;
          }
          clientRes.write(chunk);
        });
        upstreamRes.on("end", () => {
          upstreamEnded = true;
          if (state.fatalError) return;
          if (lineBuffer.length > 0) inspectLine(lineBuffer);
          if (!state.fatalError) clientRes.end();
        });
        upstreamRes.on("error", () => {
          if (upstreamEnded) return;
          sendJson(clientRes, 502, { error: "remote_recovery_upstream_unavailable" });
        });
      },
    );
    trackUpstreamRequest(upstreamReq);
    upstreamReq.on("error", () => {
      sendJson(clientRes, 502, { error: "remote_recovery_upstream_unavailable" });
    });
    upstreamReq.end(body);
  }

  function forwardOrdinary(
    clientReq: http.IncomingMessage,
    clientRes: http.ServerResponse,
    observeStatus?: (statusCode: number) => void,
  ): void {
    const upstreamReq = http.request(
      {
        hostname: options.target.hostname,
        port: options.target.port,
        path: clientReq.url,
        method: clientReq.method,
        headers: forwardedHeaders(clientReq.headers, options.target),
      },
      (upstreamRes) => {
        observeStatus?.(upstreamRes.statusCode ?? 0);
        writeResponseHead(clientRes, upstreamRes);
        upstreamRes.pipe(clientRes);
      },
    );
    trackUpstreamRequest(upstreamReq);
    upstreamReq.on("error", () => {
      sendJson(clientRes, 502, { error: "remote_recovery_upstream_unavailable" });
    });
    clientReq.pipe(upstreamReq);
  }

  async function pollClaimUntilReady(route: RemoteRecoveryRouteIdentity): Promise<void> {
    const deadline = Date.now() + options.claimReadyTimeoutMs;
    while (!state.closed && Date.now() <= deadline) {
      const status = await lookupClaimReady(route, Math.max(1, deadline - Date.now()));
      state.internalClaimLookupStatuses.push(status);
      if (status === 200) return;
      if (status !== 425) {
        throw new Error(
          `durable recovery claim returned terminal HTTP ${status} before disconnect`,
        );
      }
      await delay(options.claimPollIntervalMs ?? 100);
    }
    throw new Error("durable recovery claim did not become ready before the disconnect deadline");
  }

  async function lookupClaimReady(
    route: RemoteRecoveryRouteIdentity,
    remainingMs: number,
  ): Promise<number> {
    if (!state.claimKey) throw new Error("accepted run omitted its recovery claim key");
    const response = await requestJson(
      {
        hostname: options.target.hostname,
        port: options.target.port,
        path: REMOTE_BROWSER_RECOVERY_CLAIM_LOOKUP_PATH,
        method: "GET",
        headers: {
          authorization: `Bearer ${options.token}`,
          accept: "application/json",
          ...REMOTE_BROWSER_RECOVERY_ADMISSION_HEADER_VALUES,
          [REMOTE_BROWSER_RECOVERY_CLAIM_HEADERS.claimKey]: state.claimKey,
          [REMOTE_BROWSER_RECOVERY_CLAIM_HEADERS.accountId]: route.accountId,
          [REMOTE_BROWSER_RECOVERY_CLAIM_HEADERS.originRunId]: route.runId,
          [REMOTE_BROWSER_RECOVERY_CLAIM_HEADERS.originLaneId]: route.laneId,
          [REMOTE_BROWSER_RECOVERY_CLAIM_HEADERS.promptPreviewSha256]:
            options.expectedPromptPreviewSha256,
        },
      },
      trackUpstreamRequest,
      Math.min(10_000, remainingMs),
    );
    const validated = validateClaimLookupResponse(response, route, options);
    if (validated) {
      if (
        (state.recoveryCapability && state.recoveryCapability !== validated.capability) ||
        (state.recoveryHintSha256 && state.recoveryHintSha256 !== validated.recoveryHintSha256)
      ) {
        throw new Error("durable claim identity changed between authenticated READY lookups");
      }
      state.recoveryCapability = validated.capability;
      state.recoveryHintSha256 = validated.recoveryHintSha256;
    }
    return response.statusCode;
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("remote recovery severing proxy did not bind a TCP port");
  }

  return {
    hostname: "127.0.0.1",
    port: address.port,
    host: `127.0.0.1:${address.port}`,
    waitForDisconnect: () => disconnected,
    snapshot: () => snapshotState(state),
    containsSensitive: (text) =>
      [options.token, state.claimKey, state.recoveryCapability].some((secret) =>
        Boolean(secret && text.includes(secret)),
      ),
    redactSensitive: (text) =>
      redactSensitiveText(text, options.token, state.claimKey, state.recoveryCapability),
    close: async () => {
      state.closed = true;
      const pendingUpstream = [...upstreamRequests.entries()];
      for (const [request] of pendingUpstream) {
        request.destroy(new Error("remote recovery test proxy closed"));
      }
      server.closeAllConnections();
      const serverClosed = server.listening
        ? new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
          })
        : Promise.resolve();
      await Promise.all([serverClosed, ...pendingUpstream.map(([, closed]) => closed)]);
    },
  };
}

function validateOptions(options: RemoteRecoverySeveringProxyOptions): void {
  if (!options.target.hostname.trim() || !Number.isInteger(options.target.port)) {
    throw new Error("remote recovery proxy requires a concrete upstream host and port");
  }
  if (!options.token || /\s/u.test(options.token)) {
    throw new Error("remote recovery proxy token must be a nonempty whitespace-free value");
  }
  for (const [label, value] of [
    ["account", options.expectedAccountId],
    ["lane", options.expectedLaneId],
    ["session", options.expectedSessionId],
  ] as const) {
    if (!ROUTE_VALUE_PATTERN.test(value)) {
      throw new Error(`remote recovery proxy expected ${label} is invalid`);
    }
  }
  if (
    !/^[a-f0-9]{64}$/u.test(options.expectedPromptSha256) ||
    !/^[a-f0-9]{64}$/u.test(options.expectedPromptPreviewSha256)
  ) {
    throw new Error("remote recovery proxy requires canonical prompt hashes");
  }
  if (
    !Number.isFinite(options.claimReadyTimeoutMs) ||
    options.claimReadyTimeoutMs < 1_000 ||
    options.claimReadyTimeoutMs > 10 * 60_000
  ) {
    throw new Error("remote recovery proxy claim-ready timeout is outside the safe bounds");
  }
  if (
    options.maxNdjsonLineBytes !== undefined &&
    (!Number.isSafeInteger(options.maxNdjsonLineBytes) ||
      options.maxNdjsonLineBytes < 128 ||
      options.maxNdjsonLineBytes > DEFAULT_MAX_NDJSON_LINE_BYTES)
  ) {
    throw new Error("remote recovery proxy NDJSON line cap is outside the safe bounds");
  }
}

function validateRunRequest(
  headers: http.IncomingHttpHeaders,
  body: Buffer,
  options: RemoteRecoverySeveringProxyOptions,
): void {
  assertAuthorizedAndVersioned(headers, options.token);
  const value = parseJsonObject(body, "run request");
  const config = objectField(value, "browserConfig");
  const runOptions = objectField(value, "options");
  if (
    value.schema !== REMOTE_BROWSER_RUN_SCHEMA ||
    typeof value.prompt !== "string" ||
    sha256(value.prompt) !== options.expectedPromptSha256 ||
    !Array.isArray(value.attachments) ||
    value.attachments.length !== 0 ||
    value.fallbackSubmission !== undefined ||
    value.fallbackPolicy !== undefined ||
    config.desiredModel !== "GPT-5.6 Sol" ||
    config.modelStrategy !== "select" ||
    config.thinkingTime !== "extended" ||
    config.archiveConversations !== "never" ||
    runOptions.sessionId !== options.expectedSessionId ||
    (runOptions.followUpPrompts !== undefined &&
      (!Array.isArray(runOptions.followUpPrompts) || runOptions.followUpPrompts.length !== 0))
  ) {
    throw new Error("ordinary run request did not match the controlled one-shot Pro contract");
  }
}

function validateRecoveryRequest(
  headers: http.IncomingHttpHeaders,
  body: Buffer,
  options: RemoteRecoverySeveringProxyOptions,
  origin: RemoteRecoveryRouteIdentity | null,
  authenticatedRecoveryHintSha256: string | null,
): void {
  assertAuthorizedAndVersioned(headers, options.token);
  if (!origin) throw new Error("recovery request arrived without an accepted origin route");
  if (requireSingleHeader(headers, "x-oracle-recovery-account-id") !== options.expectedAccountId) {
    throw new Error("recovery request was not pinned to the expected account");
  }
  const value = parseJsonObject(body, "recovery request");
  const allowedTopLevel = new Set([
    "schema",
    "recovery",
    "promptPreview",
    "browserConfig",
    "options",
  ]);
  if (Object.keys(value).some((key) => !allowedTopLevel.has(key))) {
    throw new Error("capture-only recovery request contained an unexpected top-level field");
  }
  const recovery = objectField(value, "recovery");
  const runtime = objectField(recovery, "runtime");
  const browserConfig = objectField(value, "browserConfig");
  const recoveryOptions = objectField(value, "options");
  if (
    value.schema !== REMOTE_BROWSER_RECOVERY_PROTOCOL ||
    typeof value.promptPreview !== "string" ||
    sha256(value.promptPreview) !== options.expectedPromptPreviewSha256 ||
    recovery.category !== "browser-automation" ||
    recovery.stage !== "capture-binding" ||
    recovery.originRunId !== origin.runId ||
    !authenticatedRecoveryHintSha256 ||
    sha256(canonicalJson(recovery)) !== authenticatedRecoveryHintSha256 ||
    recovery.promptPreviewSha256 !== options.expectedPromptPreviewSha256 ||
    runtime.promptSubmitted !== true ||
    typeof runtime.conversationId !== "string" ||
    !runtime.conversationId ||
    Object.keys(browserConfig).some((key) => !RECOVERY_BROWSER_CONFIG_KEYS.has(key)) ||
    recoveryOptions.sessionId !== options.expectedSessionId ||
    "prompt" in value ||
    "attachments" in value ||
    "followUpPrompts" in recoveryOptions
  ) {
    throw new Error("capture-only recovery request could replay or changed origin ownership");
  }
}

function validateClaimLookupRequest(
  headers: http.IncomingHttpHeaders,
  options: RemoteRecoverySeveringProxyOptions,
  state: MutableProxyState,
): void {
  assertAuthorizedAndVersioned(headers, options.token);
  const route = state.acceptedRoute;
  if (
    !route ||
    !state.claimKey ||
    requireSingleHeader(headers, REMOTE_BROWSER_RECOVERY_CLAIM_HEADERS.claimKey) !==
      state.claimKey ||
    requireSingleHeader(headers, REMOTE_BROWSER_RECOVERY_CLAIM_HEADERS.accountId) !==
      route.accountId ||
    requireSingleHeader(headers, REMOTE_BROWSER_RECOVERY_CLAIM_HEADERS.originRunId) !==
      route.runId ||
    requireSingleHeader(headers, REMOTE_BROWSER_RECOVERY_CLAIM_HEADERS.originLaneId) !==
      route.laneId ||
    requireSingleHeader(headers, REMOTE_BROWSER_RECOVERY_CLAIM_HEADERS.promptPreviewSha256) !==
      options.expectedPromptPreviewSha256
  ) {
    throw new Error("client claim lookup changed or omitted its authenticated origin binding");
  }
}

function validateRunResponse(
  response: http.IncomingMessage,
  options: RemoteRecoverySeveringProxyOptions,
): RemoteRecoveryRouteIdentity {
  if (response.statusCode !== 200 || !isNdjsonContentType(response.headers["content-type"])) {
    throw new Error("ordinary run was not accepted with the versioned NDJSON contract");
  }
  if (!hasExactAdmissionEcho(response.headers)) {
    throw new Error("ordinary run response omitted the recovery admission contract");
  }
  const route = readRouteIdentity(response.headers);
  if (
    !route ||
    route.accountId !== options.expectedAccountId ||
    route.laneId !== options.expectedLaneId
  ) {
    throw new Error("ordinary run response route did not match the expected direct lane");
  }
  return route;
}

function validateClaimLookupResponse(
  response: JsonHttpResponse,
  route: RemoteRecoveryRouteIdentity,
  options: RemoteRecoverySeveringProxyOptions,
): { capability: string; recoveryHintSha256: string } | null {
  const headers = response.headers;
  if (
    !hasExactAdmissionEcho(headers) ||
    requireSingleHeader(headers, REMOTE_BROWSER_RECOVERY_CLAIM_ROUTE_HEADER) !==
      REMOTE_BROWSER_RECOVERY_CLAIM_ROUTE_HEADER_VALUE ||
    requireSingleHeader(headers, "x-oracle-run-id") !== route.runId ||
    requireSingleHeader(headers, "x-oracle-account-id") !== route.accountId ||
    requireSingleHeader(headers, "x-oracle-lane-id") !== route.laneId ||
    requireSingleHeader(headers, REMOTE_BROWSER_RECOVERY_CLAIM_HEADERS.originLaneId) !==
      route.laneId
  ) {
    throw new Error("durable claim lookup lacked authenticated origin-route proof");
  }
  if (response.statusCode === 425) {
    if (response.body.error !== "recovery_claim_pending") {
      throw new Error("durable claim pending response was malformed");
    }
    return null;
  }
  const recovery =
    response.body.recovery &&
    typeof response.body.recovery === "object" &&
    !Array.isArray(response.body.recovery)
      ? (response.body.recovery as Record<string, unknown>)
      : null;
  const runtime = recovery ? objectFieldOrEmpty(recovery, "runtime") : {};
  if (
    response.statusCode !== 200 ||
    response.body.schema !== REMOTE_BROWSER_RECOVERY_CLAIM_SCHEMA ||
    response.body.status !== "ready" ||
    response.body.originRunId !== route.runId ||
    response.body.originLaneId !== route.laneId ||
    !recovery ||
    recovery.category !== "browser-automation" ||
    recovery.stage !== "capture-binding" ||
    recovery.originRunId !== route.runId ||
    recovery.promptPreviewSha256 !== options.expectedPromptPreviewSha256 ||
    runtime.promptSubmitted !== true ||
    typeof runtime.conversationId !== "string" ||
    !runtime.conversationId ||
    typeof recovery.capability !== "string" ||
    !/^v2\.[A-Za-z0-9_-]{43}$/u.test(recovery.capability)
  ) {
    throw new Error("durable claim ready response was malformed or changed origin");
  }
  return {
    capability: recovery.capability,
    recoveryHintSha256: sha256(canonicalJson(recovery)),
  };
}

function assertAuthorizedAndVersioned(headers: http.IncomingHttpHeaders, token: string): void {
  if (requireSingleHeader(headers, "authorization") !== `Bearer ${token}`) {
    throw new Error("proxy request did not carry the expected bearer authority");
  }
  for (const [name, value] of Object.entries(REMOTE_BROWSER_RECOVERY_ADMISSION_HEADER_VALUES)) {
    if (requireSingleHeader(headers, name) !== value) {
      throw new Error("proxy request did not carry the exact recovery admission contract");
    }
  }
}

function hasExactAdmissionEcho(headers: http.IncomingHttpHeaders): boolean {
  return Object.entries(REMOTE_BROWSER_RECOVERY_ADMISSION_HEADER_VALUES).every(
    ([name, value]) => requireSingleHeader(headers, name, false) === value,
  );
}

function readRouteIdentity(headers: http.IncomingHttpHeaders): RemoteRecoveryRouteIdentity | null {
  const runId = requireSingleHeader(headers, "x-oracle-run-id", false);
  const accountId = requireSingleHeader(headers, "x-oracle-account-id", false);
  const laneId = requireSingleHeader(headers, "x-oracle-lane-id", false);
  if (
    !runId ||
    !accountId ||
    !laneId ||
    !ROUTE_VALUE_PATTERN.test(runId) ||
    !ROUTE_VALUE_PATTERN.test(accountId) ||
    !ROUTE_VALUE_PATTERN.test(laneId)
  ) {
    return null;
  }
  return { runId, accountId, laneId };
}

function requireCanonicalHeader(
  headers: http.IncomingHttpHeaders,
  name: string,
  pattern: RegExp,
): string {
  const value = requireSingleHeader(headers, name);
  if (!pattern.test(value)) throw new Error(`response header ${name} was not canonical`);
  return value;
}

function requireSingleHeader(
  headers: http.IncomingHttpHeaders,
  name: string,
  required = true,
): string {
  const value = headers[name.toLowerCase()];
  if (typeof value === "string" && value.length > 0 && !value.includes(",")) return value;
  if (!required && value === undefined) return "";
  throw new Error(`required singleton header ${name} was missing or duplicated`);
}

function isNdjsonContentType(value: string | string[] | undefined): boolean {
  return typeof value === "string" && /^application\/x-ndjson(?:\s*;|$)/iu.test(value);
}

function forwardedHeaders(
  headers: http.IncomingHttpHeaders,
  target: RemoteRecoveryProxyTarget,
  bodyLength?: number,
): http.OutgoingHttpHeaders {
  const forwarded: http.OutgoingHttpHeaders = {
    ...headers,
    host: `${target.hostname}:${target.port}`,
    connection: "close",
  };
  delete forwarded["transfer-encoding"];
  if (bodyLength !== undefined) forwarded["content-length"] = String(bodyLength);
  return forwarded;
}

function writeResponseHead(target: http.ServerResponse, source: http.IncomingMessage): void {
  if (target.headersSent || target.destroyed) return;
  target.writeHead(source.statusCode ?? 502, source.headers);
}

async function readBoundedRequestBody(request: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;
    if (total > MAX_PROXY_BODY_BYTES) {
      throw new Error("remote recovery proxy request exceeded its bounded body limit");
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, total);
}

function parseJsonObject(body: Buffer, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8")) as unknown;
  } catch {
    throw new Error(`${label} was not valid JSON`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} was not a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function objectField(value: Record<string, unknown>, key: string): Record<string, unknown> {
  const field = value[key];
  if (!field || typeof field !== "object" || Array.isArray(field)) {
    throw new Error(`request field ${key} was not an object`);
  }
  return field as Record<string, unknown>;
}

function objectFieldOrEmpty(value: Record<string, unknown>, key: string): Record<string, unknown> {
  const field = value[key];
  return field && typeof field === "object" && !Array.isArray(field)
    ? (field as Record<string, unknown>)
    : {};
}

function classifyTerminalFailure(event: Record<string, unknown>): string {
  const text = [event.errorClass, event.errorMessage, event.message, event.error]
    .filter((value): value is string => typeof value === "string")
    .join(" ");
  if (isAccountChallengeSignal(text)) {
    return "account challenge/quarantine terminated the worker stream before controlled disconnect";
  }
  const errorClass =
    typeof event.errorClass === "string" && ROUTE_VALUE_PATTERN.test(event.errorClass)
      ? event.errorClass
      : "unknown";
  return `worker terminal failure (${errorClass}) arrived before controlled disconnect`;
}

function isAccountChallengeSignal(value: string): boolean {
  return /account[_ -]?quarant|cloudflare|challenge(?:[_ -]?gate)?|captcha|verification[_ -]?interstitial|interstitial/iu.test(
    value,
  );
}

interface JsonHttpResponse {
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  body: Record<string, unknown>;
}

async function requestJson(
  options: http.RequestOptions,
  trackRequest?: (request: http.ClientRequest) => void,
  timeoutMs = 10_000,
): Promise<JsonHttpResponse> {
  return await new Promise<JsonHttpResponse>((resolve, reject) => {
    const request = http.request(options, (response) => {
      const chunks: Buffer[] = [];
      let total = 0;
      response.on("data", (chunk: Buffer) => {
        total += chunk.length;
        if (total > MAX_CLAIM_RESPONSE_BYTES) {
          request.destroy(new Error("durable claim response exceeded its bounded body limit"));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => {
        clearTimeout(absoluteTimer);
        try {
          resolve({
            statusCode: response.statusCode ?? 0,
            headers: response.headers,
            body: parseJsonObject(Buffer.concat(chunks, total), "durable claim response"),
          });
        } catch (error) {
          reject(error);
        }
      });
      response.on("error", (error) => {
        clearTimeout(absoluteTimer);
        reject(error);
      });
    });
    const absoluteTimer = setTimeout(() => {
      request.destroy(new Error("durable claim lookup exceeded its absolute deadline"));
    }, timeoutMs);
    trackRequest?.(request);
    request.on("error", (error) => {
      clearTimeout(absoluteTimer);
      reject(error);
    });
    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error("durable claim lookup timed out"));
    });
    request.end();
  });
}

function sendJson(
  response: http.ServerResponse,
  statusCode: number,
  body: Record<string, unknown>,
): void {
  if (response.destroyed || response.writableEnded) return;
  if (response.headersSent) {
    response.destroy();
    return;
  }
  const serialized = JSON.stringify(body);
  response.writeHead(statusCode, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(serialized),
    connection: "close",
  });
  response.end(serialized);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("claim contained a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  throw new Error("claim contained a non-JSON value");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function redactSensitiveText(
  text: string,
  token: string,
  claimKey: string | null,
  recoveryCapability: string | null,
): string {
  let redacted = text;
  for (const secret of [token, claimKey, recoveryCapability]) {
    if (secret) redacted = redacted.split(secret).join("[redacted]");
  }
  return redacted.replace(/\bBearer\s+\S+/giu, "Bearer [redacted]");
}

function snapshotState(state: MutableProxyState): RemoteRecoveryProxySnapshot {
  return {
    runPostAttempts: state.runPostAttempts,
    runPostsForwarded: state.runPostsForwarded,
    recoveryPostAttempts: state.recoveryPostAttempts,
    recoveryPostsForwarded: state.recoveryPostsForwarded,
    claimLookupsForwarded: state.claimLookupsForwarded,
    claimLookupStatuses: [...state.claimLookupStatuses],
    internalClaimLookupStatuses: [...state.internalClaimLookupStatuses],
    outstandingUpstreamRequests: state.outstandingUpstreamRequests,
    runRequestContractVerified: state.runRequestContractVerified,
    recoveryRequestContractVerified: state.recoveryRequestContractVerified,
    recoveryClaimBindingVerified: state.recoveryClaimBindingVerified,
    runResponseContractVerified: state.runResponseContractVerified,
    recoveryResponseContractVerified: state.recoveryResponseContractVerified,
    protectedRouteProofObserved: state.protectedRouteProofObserved,
    submitConfirmationObserved: state.submitConfirmationObserved,
    forbiddenAnswerNowClickObserved: state.forbiddenAnswerNowClickObserved,
    claimReadyBeforeDisconnect: state.claimReadyBeforeDisconnect,
    disconnected: state.disconnected,
    acceptedRoute: state.acceptedRoute ? { ...state.acceptedRoute } : null,
    recoveryRoute: state.recoveryRoute ? { ...state.recoveryRoute } : null,
  };
}

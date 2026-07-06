import http from "node:http";
import { createWriteStream } from "node:fs";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import type { BrowserRunOptions } from "../browserMode.js";
import type { BrowserRunResult } from "../browserMode.js";
import type { BrowserAttachment, SavedBrowserFile } from "../browser/types.js";
import {
  appendArtifacts,
  computeFileSha256,
  resolveSessionArtifactsDir,
  resolveUniqueArtifactPath,
  sanitizeArtifactFilename,
  sanitizeArtifactMimeType,
  validateArtifactFile,
} from "../browser/artifacts.js";
import {
  MAX_REMOTE_ARTIFACT_BYTES,
  type RemoteArtifactDescriptor,
  type RemoteRunPayload,
  type RemoteRunEvent,
  type RemoteAttachmentPayload,
} from "./types.js";
import { parseHostPort } from "../bridge/connection.js";
import { computePromptSha256 } from "../browser/actions/captureBinding.js";
import { serializeRemoteRunPayloadForWire } from "./payload_sanitize.js";

interface RemoteExecutorOptions {
  host: string;
  token?: string;
  /**
   * Injectable HTTP request function — defaults to `http.request`.
   * Tests pass a stub here to avoid mocking the standard library,
   * which is brittle under ESM (`import http from "node:http"`
   * resolves to the default export, but `vi.mock` factories that
   * spread `actual` typically forget the `default` slot, leaving
   * `http.request` un-mocked at the call site).
   */
  requestFn?: typeof http.request;
  /**
   * Stream-inactivity deadline for the `/runs` NDJSON response: if no bytes
   * at all arrive for this long, the run is aborted with a typed,
   * non-retryable error instead of hanging forever on a silently-wedged
   * worker. Reset on every received chunk — this is an INACTIVITY deadline,
   * not a cap on total run duration, so a legitimate long Pro wait that
   * keeps emitting progress (heartbeat "still thinking" log lines,
   * artifact-progress events, ...) never trips it. Defaults to
   * `DEFAULT_STREAM_IDLE_TIMEOUT_MS` (or the `ORACLE_REMOTE_STREAM_IDLE_MS`
   * env override), which mirrors the server's own no-progress notion
   * (`wedgeAfterMs` / `ORACLE_SERVE_WEDGE_AFTER_MS`, see
   * src/remote/server.ts) so client and worker agree on what "wedged" means.
   */
  streamIdleTimeoutMs?: number;
  /**
   * Hard ceiling on a single buffered NDJSON line. The response stream is
   * newline-delimited; without a cap, a worker (or a corrupted/adversarial
   * intermediary) that never emits a newline would grow the line buffer
   * without bound. Defaults to `MAX_NDJSON_LINE_BYTES`, comfortably above
   * the largest legitimate single event (a `done` event carrying the full
   * answer text/markdown/html) while still bounded.
   */
  maxLineBytes?: number;
}

/**
 * Default stream-inactivity deadline (see `RemoteExecutorOptions.streamIdleTimeoutMs`).
 * Mirrors the server's default `wedgeAfterMs` (src/remote/server.ts) so the
 * client's notion of "the worker went silent" agrees with the worker's own.
 */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 15 * 60 * 1000;

/** Default per-line NDJSON buffer cap (see `RemoteExecutorOptions.maxLineBytes`). */
export const MAX_NDJSON_LINE_BYTES = 32 * 1024 * 1024;

function resolveDefaultStreamIdleTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number.parseInt(env.ORACLE_REMOTE_STREAM_IDLE_MS ?? "", 10);
  return Number.isSafeInteger(raw) && raw > 0 ? raw : DEFAULT_STREAM_IDLE_TIMEOUT_MS;
}

/**
 * Whether the caller has explicitly opted in to the prompt-altering fallback
 * submission on remote (fleet) lanes. Default OFF: the fallback replaces the
 * submitted question with a re-packed variant (inline text moved to file
 * uploads), so a silent switch breaks answer provenance. Opting in accepts
 * degraded provenance; the run log records both prompt hashes so the JSONL
 * event stream can prove which prompt was actually submitted.
 */
export function isPromptFallbackOptInEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.ORACLE_ALLOW_PROMPT_FALLBACK ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true";
}

/**
 * Typed terminal failure for a remote run. `errorClass` is one of the fleet's
 * typed retry classes; `retryable` states whether an AUTOMATIC retry is
 * permissible. Post-submit interruptions, integrity failures, and account
 * quarantine are never auto-retried (and never retried into another account):
 * the prompt may already have reached the account, so blind resubmission
 * risks duplicate submissions and cross-account contamination.
 */
export class RemoteRunFailedError extends Error {
  readonly errorClass: string | null;
  readonly retryable: boolean | null;

  constructor(
    message: string,
    options: { errorClass?: string | null; retryable?: boolean | null } = {},
  ) {
    super(message);
    this.name = "RemoteRunFailedError";
    this.errorClass = options.errorClass ?? null;
    this.retryable = options.retryable ?? null;
  }
}

/**
 * Send-confirmation marker mirrored from the worker (src/remote/server.ts):
 * both submission paths (send-button click and Enter fallback) emit a
 * "Submitted prompt via ..." log line at dispatch time; "clicked send button"
 * is a defensive alias for older browser layers. The client tracks this so a
 * caller-gone abort can be classified before/after the account-safety
 * boundary (the ChatGPT submit moment, not /runs acceptance).
 */
const SUBMIT_CONFIRMATION_LOG_PATTERN = /submitted prompt|prompt submitted|clicked send button/i;

export function createRemoteBrowserExecutor({
  host,
  token,
  requestFn = http.request,
  streamIdleTimeoutMs = resolveDefaultStreamIdleTimeoutMs(),
  maxLineBytes = MAX_NDJSON_LINE_BYTES,
}: RemoteExecutorOptions) {
  // Return a drop-in replacement for runBrowserMode so the browser session runner can stay unchanged.
  return async function remoteBrowserExecutor(
    options: BrowserRunOptions,
  ): Promise<BrowserRunResult> {
    const log = options.log ?? (() => {});
    const signal = options.signal;
    if (signal?.aborted) {
      // Caller already gone before any work: fail fast without reading
      // attachment files or opening a connection to the worker.
      throw new RemoteRunFailedError(
        "Caller aborted before submit; aborting the remote run.",
        { errorClass: "transport_interrupted_before_submit", retryable: true },
      );
    }
    let fallbackSubmission = options.fallbackSubmission;
    if (fallbackSubmission && !isPromptFallbackOptInEnabled()) {
      // NO SILENT PROMPT FALLBACK on fleet lanes: an oversized inline prompt
      // must fail loudly instead of being silently re-packed into a different
      // submission. Callers that accept degraded provenance opt in explicitly.
      log(
        "[remote] Prompt-altering fallback submission is disabled on remote runs; submitting the primary prompt only. " +
          "Set ORACLE_ALLOW_PROMPT_FALLBACK=1 to opt in (provenance is marked degraded if the fallback is used).",
      );
      fallbackSubmission = undefined;
    } else if (fallbackSubmission) {
      log(
        `[remote] Prompt fallback opt-in active (ORACLE_ALLOW_PROMPT_FALLBACK); provenance degraded if the fallback is used. ` +
          `primary prompt sha256 ${computePromptSha256(options.prompt)}; fallback prompt sha256 ${computePromptSha256(fallbackSubmission.prompt)}`,
      );
    }
    const payload: RemoteRunPayload = {
      prompt: options.prompt,
      attachments: await serializeAttachments(options.attachments ?? []),
      fallbackSubmission: fallbackSubmission
        ? {
            prompt: fallbackSubmission.prompt,
            attachments: await serializeAttachments(fallbackSubmission.attachments ?? []),
          }
        : undefined,
      browserConfig: options.config ?? {},
      options: {
        heartbeatIntervalMs: options.heartbeatIntervalMs,
        verbose: options.verbose,
        sessionId: options.sessionId,
        followUpPrompts: options.followUpPrompts,
      },
    };

    const body = Buffer.from(serializeRemoteRunPayloadForWire(payload));
    const { hostname, port } = parseHost(host);

    return new Promise<BrowserRunResult>((resolve, reject) => {
      const transferredFiles: SavedBrowserFile[] = [];
      const transferFailures: string[] = [];
      const transferPromises: Promise<void>[] = [];
      let artifactTransferQueue = Promise.resolve();
      let settled = false;
      let resolved: BrowserRunResult | null = null;
      // Success is defined by the terminal done event and nothing else: a
      // stream that ends without one (crash, truncation, proxy cut) must
      // never be treated as a completed run.
      let doneObserved = false;
      // Stream-inactivity watchdog for the /runs response (see
      // `streamIdleTimeoutMs` doc): armed once the 200 response begins, reset
      // on every chunk, cleared once the stream ends or the run settles.
      let idleTimer: ReturnType<typeof setTimeout> | null = null;
      // Whether the worker's send-confirmation log line has been observed
      // (see SUBMIT_CONFIRMATION_LOG_PATTERN): decides the typed transport
      // class (before/after submit) for a caller-gone abort.
      let submitObserved = false;
      // Live 200 response, if the stream has started — destroyed alongside
      // the request on caller-gone abort. Registered abort-listener removal
      // runs whenever the run settles (success or failure).
      let activeRes: http.IncomingMessage | null = null;
      let removeAbortListener: (() => void) | null = null;

      const clearIdleTimer = () => {
        if (idleTimer) {
          clearTimeout(idleTimer);
          idleTimer = null;
        }
      };

      const cleanup = () => {
        clearIdleTimer();
        if (removeAbortListener) {
          removeAbortListener();
          removeAbortListener = null;
        }
      };

      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };

      const req = requestFn(
        {
          hostname,
          port,
          path: "/runs",
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": body.length,
            ...(token ? { authorization: `Bearer ${token}` } : {}),
          },
        },
        (res) => {
          activeRes = res;
          if (res.statusCode !== 200) {
            collectRefusal(res)
              .then((refusal) =>
                fail(
                  new RemoteRunFailedError(refusal.message, {
                    errorClass: refusal.errorClass,
                    retryable: refusal.retryable,
                  }),
                ),
              )
              .catch(fail);
            return;
          }
          res.setEncoding("utf8");
          let buffer = "";
          // Arm the inactivity watchdog as soon as the 200 response begins —
          // a worker that accepts the connection, sends headers, and then
          // never emits a single byte must not pin the caller forever.
          const armIdleTimer = () => {
            clearIdleTimer();
            idleTimer = setTimeout(() => {
              if (settled) return;
              const idleError = new RemoteRunFailedError(
                `Remote run stream received no data for over ${streamIdleTimeoutMs}ms; aborting rather ` +
                  "than waiting indefinitely on a possibly-wedged worker. This is an inactivity deadline " +
                  "(reset on every received byte), not a cap on total run duration, so a normal slow-but-active " +
                  "Pro run is unaffected.",
                { errorClass: "transport_interrupted_after_submit", retryable: false },
              );
              fail(idleError);
              req.destroy();
              res.destroy();
            }, streamIdleTimeoutMs);
          };
          armIdleTimer();
          res.on("data", (chunk: string) => {
            armIdleTimer();
            buffer += chunk;
            let newlineIndex = buffer.indexOf("\n");
            while (newlineIndex !== -1) {
              const line = buffer.slice(0, newlineIndex).trim();
              buffer = buffer.slice(newlineIndex + 1);
              if (line.length > 0) {
                const transferPromise = handleEvent({
                  line,
                  options,
                  hostname,
                  port,
                  token,
                  onResult: (result) => {
                    resolved = result;
                  },
                  onDone: () => {
                    doneObserved = true;
                  },
                  onSubmitObserved: () => {
                    submitObserved = true;
                  },
                  onArtifact: (artifact) => {
                    transferredFiles.push(artifact);
                  },
                  onArtifactFailure: (message) => {
                    transferFailures.push(message);
                  },
                  enqueueArtifactTransfer: (transfer) => {
                    const queued = artifactTransferQueue.then(transfer);
                    artifactTransferQueue = queued.catch(() => undefined);
                    return queued;
                  },
                  onError: fail,
                });
                if (transferPromise) {
                  transferPromises.push(transferPromise);
                }
              }
              newlineIndex = buffer.indexOf("\n");
            }
            // Cap the trailing (not-yet-newline-terminated) partial line: a
            // worker that never emits a newline would otherwise grow `buffer`
            // without bound. Checked AFTER draining complete lines above, so
            // a burst of many small legitimate lines in one chunk never trips
            // this — only a single line actually exceeding the cap does.
            if (buffer.length > maxLineBytes) {
              fail(
                new RemoteRunFailedError(
                  `Remote run stream line exceeded the ${maxLineBytes}-byte NDJSON line cap without a ` +
                    "terminating newline; refusing to buffer further to avoid unbounded memory growth.",
                  { errorClass: "transport_interrupted_after_submit", retryable: false },
                ),
              );
              req.destroy();
              res.destroy();
            }
          });
          res.on("end", () => {
            clearIdleTimer();
            void (async () => {
              await Promise.allSettled(transferPromises);
              if (settled) return;
              if (!doneObserved || !resolved) {
                // EOF without a terminal done event is a FAILURE, not an
                // answer. Post-submit conservatism: the prompt may have
                // reached the account, so this is never auto-retryable.
                fail(
                  new RemoteRunFailedError(
                    "Remote run stream ended without a terminal done event; refusing to treat it as success.",
                    { errorClass: "transport_interrupted_after_submit", retryable: false },
                  ),
                );
                return;
              }
              settled = true;
              cleanup();
              resolve(mergeTransferredArtifacts(resolved, transferredFiles, transferFailures));
            })().catch(fail);
          });
          res.on("error", fail);
        },
      );
      req.on("error", fail);
      if (signal) {
        // Caller-gone abort (mirrors buildClientAbortError in
        // src/browser/index.ts for the remote lane): fail with the typed
        // transport class reflecting whether the account-safety boundary
        // (the observed submit-confirmation marker) was crossed, then tear
        // down the outbound request so the worker's own client-gone handling
        // (res "close" -> onClientGone in src/remote/server.ts) fires and
        // frees the single-flight busy slot instead of streaming the rest of
        // the run to a caller that already gave up.
        const onAbort = () => {
          fail(
            new RemoteRunFailedError(
              submitObserved
                ? "Caller aborted after submit; abandoning the remote run without ChatGPT-side cancellation."
                : "Caller aborted before submit; aborting the remote run.",
              {
                errorClass: submitObserved
                  ? "transport_interrupted_after_submit"
                  : "transport_interrupted_before_submit",
                retryable: !submitObserved,
              },
            ),
          );
          req.destroy();
          activeRes?.destroy();
        };
        if (signal.aborted) {
          onAbort();
        } else {
          signal.addEventListener("abort", onAbort, { once: true });
          removeAbortListener = () => signal.removeEventListener("abort", onAbort);
        }
      }
      req.write(body);
      req.end();
    });
  };
}

async function serializeAttachments(
  attachments: BrowserAttachment[],
): Promise<RemoteAttachmentPayload[]> {
  const serialized: RemoteAttachmentPayload[] = [];
  for (const attachment of attachments) {
    // Read the local file upfront so the remote host never touches the caller's filesystem.
    const content = await readFile(attachment.path);
    serialized.push({
      fileName: path.basename(attachment.path),
      displayPath: attachment.displayPath,
      sizeBytes: attachment.sizeBytes,
      contentBase64: content.toString("base64"),
    });
  }
  return serialized;
}

function parseHost(input: string): { hostname: string; port: number } {
  try {
    return parseHostPort(input);
  } catch (error) {
    throw new Error(
      `Invalid remote host: ${input} (${error instanceof Error ? error.message : String(error)})`,
    );
  }
}

function handleEvent(params: {
  line: string;
  options: BrowserRunOptions;
  hostname: string;
  port: number;
  token?: string;
  onResult: (result: BrowserRunResult) => void;
  onDone: () => void;
  onSubmitObserved: () => void;
  onArtifact: (artifact: SavedBrowserFile) => void;
  onArtifactFailure: (message: string) => void;
  enqueueArtifactTransfer: (transfer: () => Promise<void>) => Promise<void>;
  onError: (error: Error) => void;
}): Promise<void> | null {
  let event: RemoteRunEvent;
  try {
    event = JSON.parse(params.line) as RemoteRunEvent;
  } catch (error) {
    params.onError(
      new Error(
        `Failed to parse remote event: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
    return null;
  }
  if (event.type === "log") {
    if (SUBMIT_CONFIRMATION_LOG_PATTERN.test(event.message)) {
      params.onSubmitObserved();
    }
    params.options.log?.(event.message);
    return null;
  }
  if (event.type === "error") {
    params.onError(new Error(event.message));
    return null;
  }
  if (event.type === "artifact-progress") {
    if (params.options.verbose) {
      params.options.log?.(
        `[browser] Artifact ${event.artifactId} ${event.phase}${
          event.receivedBytes !== undefined && event.totalBytes !== undefined
            ? ` ${event.receivedBytes}/${event.totalBytes} bytes`
            : ""
        }`,
      );
    }
    return null;
  }
  if (event.type === "artifact-ready") {
    const displayFilename = sanitizeArtifactFilename(
      String(event.artifact?.filename ?? ""),
      "artifact.bin",
    );
    const transfer = params.enqueueArtifactTransfer(() =>
      transferRemoteArtifact({
        hostname: params.hostname,
        port: params.port,
        token: params.token,
        descriptor: event.artifact,
        sessionId: params.options.sessionId,
        log: params.options.log,
      })
        .then((artifact) => {
          params.onArtifact(artifact);
        })
        .catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          const fallback = `Oracle captured the browser text response, but bridge artifact transfer failed for ${displayFilename}. Open the ChatGPT browser on the bridge host, download the ZIP/file shown in the current response, and copy it to a cloud-readable path. Reason: ${message}`;
          params.options.log?.(`[browser] ${fallback}`);
          params.onArtifactFailure(fallback);
        }),
    );
    return transfer;
  }
  if (event.type === "done") {
    if (event.ok && event.result) {
      // §14.16 provenance distinction: what the worker verified is plumbing
      // evidence (model, capture binding, challenge-clean) — it does not
      // certify the answer's correctness.
      if (event.provenance) {
        const p = event.provenance;
        params.options.log?.(
          `[remote] Terminal done.ok observed. Provenance: model=${String(p.modelVerified)} ` +
            `binding=${String(p.captureBindingVerified)} bindingQuality=${String(p.captureBindingQuality ?? null)} ` +
            `challengeClean=${String(p.challengeClean)} ` +
            "(provenance verified means the plumbing was right, not that the answer is correct).",
        );
      }
      params.onResult(event.result);
      params.onDone();
      return null;
    }
    if (event.ok) {
      params.onError(
        new RemoteRunFailedError("Terminal done event claimed success but carried no result.", {
          errorClass: "integrity_ui_unknown",
          retryable: false,
        }),
      );
      return null;
    }
    params.onError(
      new RemoteRunFailedError(
        event.errorMessage ?? `Remote run failed (${event.errorClass ?? "unclassified"})`,
        { errorClass: event.errorClass ?? null, retryable: event.retryable ?? false },
      ),
    );
    return null;
  }
  if (event.type === "result") {
    // NON-AUTHORITATIVE legacy event: only the terminal done event may
    // certify success. Deliberately ignored (no back-compat shims).
    params.options.log?.(
      "[remote] Ignoring non-authoritative result event; waiting for the terminal done event.",
    );
    return null;
  }
  return null;
}

async function transferRemoteArtifact(params: {
  hostname: string;
  port: number;
  token?: string;
  descriptor: RemoteArtifactDescriptor;
  sessionId?: string;
  log?: BrowserRunOptions["log"];
}): Promise<SavedBrowserFile> {
  validateRemoteArtifactDescriptor(params.descriptor);
  const sessionId = params.sessionId ?? params.descriptor.runId;
  const artifactsDir = resolveSessionArtifactsDir(sessionId);
  await mkdir(artifactsDir, { recursive: true });
  const filename = sanitizeArtifactFilename(
    params.descriptor.filename,
    `artifact-${params.descriptor.artifactId}.bin`,
  );
  const finalPath = await resolveUniqueArtifactPath(path.join(artifactsDir, filename));
  const partPath = `${finalPath}.part-${params.descriptor.artifactId}`;
  const artifactPath = `/runs/${encodeURIComponent(params.descriptor.runId)}/artifacts/${encodeURIComponent(
    params.descriptor.artifactId,
  )}`;

  params.log?.(`[browser] Transferring artifact ${filename} from bridge host...`);
  await downloadArtifactToFile({
    hostname: params.hostname,
    port: params.port,
    path: artifactPath,
    token: params.token,
    targetPath: partPath,
    descriptor: params.descriptor,
  }).catch(async (error) => {
    await rm(partPath, { force: true }).catch(() => undefined);
    throw error;
  });

  const fileStat = await stat(partPath);
  if (fileStat.size !== params.descriptor.byteSize) {
    await rm(partPath, { force: true }).catch(() => undefined);
    throw new Error(`size mismatch (${fileStat.size} != ${params.descriptor.byteSize})`);
  }
  const sha256 = await computeFileSha256(partPath);
  if (sha256 !== params.descriptor.sha256) {
    await rm(partPath, { force: true }).catch(() => undefined);
    throw new Error("sha256 mismatch");
  }
  const validation = await validateArtifactFile({
    path: partPath,
    filename,
    mimeType: sanitizeArtifactMimeType(params.descriptor.mimeType),
  });
  if (!validation.ok) {
    await rm(partPath, { force: true }).catch(() => undefined);
    throw new Error(`${validation.type} validation failed: ${validation.error ?? "invalid"}`);
  }

  await rename(partPath, finalPath);
  params.log?.(`[browser] Transferred artifact to ${finalPath}`);
  const publishedFilename = path.basename(finalPath);
  return {
    kind: "file",
    path: finalPath,
    label: publishedFilename,
    mimeType: sanitizeArtifactMimeType(params.descriptor.mimeType),
    sizeBytes: fileStat.size,
    sourceUrl: "bridge-artifact",
    sha256,
    validation,
    transfer: { status: "completed", bytes: fileStat.size },
    origin: { mode: "bridge" },
    url: "bridge-artifact",
    finalUrl: "bridge-artifact",
    filename: publishedFilename,
  };
}

async function downloadArtifactToFile(params: {
  hostname: string;
  port: number;
  path: string;
  token?: string;
  targetPath: string;
  descriptor: RemoteArtifactDescriptor;
}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const req = http.request(
      {
        hostname: params.hostname,
        port: params.port,
        path: params.path,
        method: "GET",
        headers: params.token ? { authorization: `Bearer ${params.token}` } : undefined,
      },
      (res) => {
        if (res.statusCode !== 200) {
          collectError(res)
            .then((message) => reject(new Error(message)))
            .catch(reject);
          return;
        }
        const headerSha = String(res.headers["x-oracle-artifact-sha256"] ?? "");
        if (headerSha && headerSha !== params.descriptor.sha256) {
          res.resume();
          reject(new Error("artifact sha256 header mismatch"));
          return;
        }
        const contentLengthHeader = res.headers["content-length"];
        const contentLength =
          typeof contentLengthHeader === "string" ? Number(contentLengthHeader) : undefined;
        if (
          contentLength !== undefined &&
          (!Number.isSafeInteger(contentLength) ||
            contentLength <= 0 ||
            contentLength > MAX_REMOTE_ARTIFACT_BYTES ||
            contentLength !== params.descriptor.byteSize)
        ) {
          res.resume();
          reject(new Error("artifact content-length mismatch"));
          return;
        }
        const output = createWriteStream(params.targetPath, { flags: "wx" });
        let receivedBytes = 0;
        const limiter = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            receivedBytes += chunk.length;
            if (
              receivedBytes > params.descriptor.byteSize ||
              receivedBytes > MAX_REMOTE_ARTIFACT_BYTES
            ) {
              callback(new Error("artifact exceeded declared size"));
              return;
            }
            callback(null, chunk);
          },
        });
        void pipeline(res, limiter, output).then(() => resolve(), reject);
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function validateRemoteArtifactDescriptor(descriptor: RemoteArtifactDescriptor): void {
  if (
    !descriptor ||
    typeof descriptor !== "object" ||
    descriptor.kind !== "file" ||
    typeof descriptor.runId !== "string" ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(descriptor.runId) ||
    typeof descriptor.artifactId !== "string" ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(descriptor.artifactId) ||
    typeof descriptor.filename !== "string" ||
    !Number.isSafeInteger(descriptor.byteSize) ||
    descriptor.byteSize <= 0 ||
    descriptor.byteSize > MAX_REMOTE_ARTIFACT_BYTES ||
    typeof descriptor.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(descriptor.sha256)
  ) {
    throw new Error("invalid bridge artifact descriptor");
  }
}

function mergeTransferredArtifacts(
  result: BrowserRunResult,
  transferredFiles: SavedBrowserFile[],
  transferFailures: string[],
): BrowserRunResult {
  const artifacts = appendArtifacts(result.artifacts, transferredFiles);
  const savedFiles = appendSavedFiles(result.savedFiles, transferredFiles);
  const warnings = [
    ...(result.warnings ?? []),
    ...transferFailures.map((message) => ({
      code: "remote-artifact-transfer-failed",
      severity: "warning" as const,
      message,
    })),
  ];
  return {
    ...result,
    artifacts,
    savedFiles,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}

function appendSavedFiles(
  existing: SavedBrowserFile[] | undefined,
  additions: SavedBrowserFile[],
): SavedBrowserFile[] | undefined {
  const merged = new Map<string, SavedBrowserFile>();
  for (const artifact of existing ?? []) {
    merged.set(artifact.path, artifact);
  }
  for (const artifact of additions) {
    merged.set(artifact.path, artifact);
  }
  const values = Array.from(merged.values());
  return values.length > 0 ? values : undefined;
}

function collectError(res: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    res.on("data", (chunk: Buffer | string) => {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    });
    res.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      try {
        const parsed = JSON.parse(raw);
        resolve(parsed.error ?? `Remote host responded with status ${res.statusCode}`);
      } catch {
        resolve(raw || `Remote host responded with status ${res.statusCode}`);
      }
    });
    res.on("error", reject);
  });
}

/**
 * Typed refusal reader for non-200 /runs responses: surfaces the worker's
 * errorClass/retryable fields (e.g. capacity_busy + Retry-After on 409) so
 * callers apply the right retry policy instead of guessing from strings.
 */
function collectRefusal(
  res: http.IncomingMessage,
): Promise<{ message: string; errorClass: string | null; retryable: boolean | null }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    res.on("data", (chunk: Buffer | string) => {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    });
    res.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const fallback = `Remote host responded with status ${res.statusCode}`;
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        resolve({
          message: typeof parsed.error === "string" ? parsed.error : fallback,
          errorClass: typeof parsed.errorClass === "string" ? parsed.errorClass : null,
          retryable: typeof parsed.retryable === "boolean" ? parsed.retryable : null,
        });
      } catch {
        resolve({ message: raw || fallback, errorClass: null, retryable: null });
      }
    });
    res.on("error", reject);
  });
}

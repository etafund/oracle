import type { BrowserSessionConfig } from "../sessionStore.js";
import type { BrowserRunResult } from "../browserMode.js";
import type { BrowserAttachment } from "../browser/types.js";
import type { SessionArtifactValidation } from "../sessionManager.js";
import type { RunErrorClass } from "./run_event_sink.js";

export const MAX_REMOTE_ARTIFACT_BYTES = 512 * 1024 * 1024;

export interface RemoteAttachmentPayload {
  fileName: string;
  displayPath: string;
  sizeBytes?: number;
  contentBase64: string;
}

export interface RemoteRunPayload {
  prompt: string;
  attachments: RemoteAttachmentPayload[];
  fallbackSubmission?: {
    prompt: string;
    attachments: RemoteAttachmentPayload[];
  };
  browserConfig: BrowserSessionConfig;
  options: {
    heartbeatIntervalMs?: number;
    verbose?: boolean;
    sessionId?: string;
    followUpPrompts?: string[];
    /**
     * Caller-supplied idempotency/dedup key, recorded verbatim as job_id in
     * the worker's oracle.run.v1 sink line so scheduling tooling can join
     * runs to jobs; never interpreted by the worker.
     */
    jobId?: string;
    /**
     * Concurrency bucket the scheduler placed this run into (c=1/2/3),
     * recorded verbatim as scheduled_concurrency in the oracle.run.v1 sink
     * line for overlap-metric joins; never interpreted by the worker.
     */
    scheduledConcurrency?: number;
  };
}

export interface RemoteArtifactCapabilities {
  artifactTransfer: boolean;
  artifactProtocolVersion: number;
  maxArtifactBytes: number;
}

export interface RemoteArtifactDescriptor {
  artifactId: string;
  runId: string;
  kind: "file";
  filename: string;
  label?: string;
  mimeType?: string;
  byteSize: number;
  sha256: string;
  validation?: SessionArtifactValidation;
  sourceUrlKind: "sandbox" | "chatgpt-file-endpoint" | "browser-download";
  transferStatus: "ready" | "streaming" | "completed" | "failed" | "skipped";
}

export interface RemoteAttachmentIntegrityEntry {
  index: number;
  originalName: string;
  storedName: string;
  bytes: number;
  sha256: string;
}

/**
 * Upload-plumbing proof for a run's attachments: the exact bytes staged on
 * the host, under collision-proof stored names, with their hashes. The
 * browser-side pre-Send composer check consumes the same stored names, so
 * chip presence is joinable to these entries. This proves PLUMBING (the
 * right bytes were staged and offered to the composer) — it does NOT prove
 * the model read the files.
 */
export interface RemoteUploadIntegrity {
  attachments: RemoteAttachmentIntegrityEntry[];
  fallbackAttachments?: RemoteAttachmentIntegrityEntry[];
  preSendDomCheck: "composer-chips-by-stored-name";
}

/**
 * What the worker actually verified for a run. Provenance proves PLUMBING
 * (the right model was selected, the capture was bound to this run's own
 * submitted message, no challenge/quarantine was latched) — it does NOT
 * prove the answer is correct. Unknown facts are null, never guessed.
 */
export interface RemoteRunProvenanceSummary {
  modelVerified: boolean | null;
  modelRequested: string | null;
  modelResolved: string | null;
  captureBindingVerified: boolean | null;
  challengeClean: boolean | null;
}

export type RemoteRunEvent =
  // `runId` is stamped onto every event by the server so each NDJSON line of a
  // run is joinable end-to-end (client logs, server logs, forensics) even when
  // a run fails early. Optional in the type so hand-built client fixtures stay
  // valid; the server always emits it.
  | { type: "log"; message: string; runId?: string }
  | { type: "artifact-ready"; runId: string; artifact: RemoteArtifactDescriptor }
  | {
      type: "artifact-progress";
      artifactId: string;
      receivedBytes?: number;
      totalBytes?: number;
      phase: "download" | "transfer" | "validate";
      runId?: string;
    }
  | { type: "attachment-manifest"; uploadIntegrity: RemoteUploadIntegrity; runId?: string }
  /**
   * NON-AUTHORITATIVE legacy event. The caller-usable answer travels ONLY in
   * the terminal `done` event; clients must ignore `result` events and treat
   * a stream that ends without `done` as a failure. Kept in the union so
   * fixtures/parsers stay type-checked while the fleet transitions.
   */
  | { type: "result"; result: BrowserRunResult; uploadIntegrity?: RemoteUploadIntegrity; runId?: string }
  /**
   * TERMINAL event — exactly one per accepted run, always the last line the
   * server writes. Success is defined as done.ok === true; the answer payload
   * is carried here and nowhere else. On failure `errorClass` is one of the
   * typed retry classes and `retryable` states whether an automatic retry is
   * permissible (post-submit and quarantine failures are never auto-retried).
   */
  | {
      type: "done";
      ok: boolean;
      runId?: string;
      errorClass?: RunErrorClass | null;
      errorMessage?: string;
      retryable?: boolean | null;
      provenance?: RemoteRunProvenanceSummary;
      result?: BrowserRunResult;
      uploadIntegrity?: RemoteUploadIntegrity;
    }
  | { type: "error"; message: string; runId?: string };

export interface RemoteActiveRunInfo {
  id: string;
  startedAt: string;
  ageSeconds: number;
  clientConnected: boolean;
  promptChars: number;
  sessionId?: string;
  desiredModel?: string;
}

export interface SerializedAttachment extends BrowserAttachment {
  fileName: string;
  contentBase64: string;
}

export interface RemoteBrowserEndpointV1 {
  _schema: "remote_browser_endpoint.v1";
  endpoint_id: string;
  mode: "preferred" | "required" | "off";
  status:
    | "healthy"
    | "busy"
    | "unreachable"
    | "auth_failed"
    | "missing_token"
    | "not_configured"
    | "unknown";
  host_env: string | null;
  token_env: string | null;
  host_hash: string | null;
  auth_profile_id_hash: string | null;
  no_plaintext_secrets: boolean;
  shared_profile_policy: boolean;
  provider_locks: string[];
  doctor_command: string;
  recover_command: string;
  version: string | null;
  uptimeSeconds: number | null;
  busy?: boolean;
  activeRun?: RemoteActiveRunInfo | null;
  error?: string;
}

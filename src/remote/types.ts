import type { BrowserSessionConfig } from "../sessionStore.js";
import type { BrowserRunResult } from "../browserMode.js";
import type { BrowserAttachment } from "../browser/types.js";
import type { SessionArtifactValidation } from "../sessionManager.js";
import type { OracleBuildInfo } from "../version.js";
import type { RunErrorClass } from "./run_event_sink.js";

export const MAX_REMOTE_ARTIFACT_BYTES = 512 * 1024 * 1024;

export type RemoteActiveRunPhase = "running" | "completed";

export type RemoteRunReadinessState =
  | "idle-ready"
  | "active-run-client-connected"
  | "active-run-client-disconnected"
  | "completed-but-not-finalized"
  | "wedged-no-progress"
  | "substrate-broken";

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
  | {
      type: "result";
      result: BrowserRunResult;
      uploadIntegrity?: RemoteUploadIntegrity;
      runId?: string;
    }
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
  phase?: RemoteActiveRunPhase;
  completedAt?: string;
  completedAgeSeconds?: number;
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
  build?: OracleBuildInfo | null;
  uptimeSeconds: number | null;
  busy?: boolean;
  activeRun?: RemoteActiveRunInfo | null;
  error?: string;
}

export const REMOTE_FLEET_SLOTS_SCHEMA_VERSION = "remote_fleet_slots.v1" as const;

export type RemoteFleetSlotStatus =
  | "healthy"
  | "busy"
  | "disconnected"
  | "completed-but-not-finalized"
  | "wedged"
  | "substrate-broken"
  | "unreachable"
  | "auth_failed"
  | "missing_token"
  | "not_configured"
  | "legacy"
  | "unknown";

export type RemoteSlotInventorySource =
  | "configured-remote"
  | "explicit-hosts"
  | "env-hosts"
  | "none";

export type RemoteSlotNextActionCode =
  | "ready"
  | "wait"
  | "watch_abort"
  | "wait_finalize"
  | "drain_and_inspect"
  | "start_chrome"
  | "repair_chrome_owner"
  | "manual_quarantine_clear"
  | "fix_lease_registry"
  | "check_service_network"
  | "fix_token"
  | "set_token"
  | "upgrade_worker"
  | "configure_lane_inventory"
  | "inspect";

export interface RemoteFleetSlotsV1 {
  _schema: typeof REMOTE_FLEET_SLOTS_SCHEMA_VERSION;
  generated_at: string;
  no_plaintext_secrets: true;
  inventory: {
    source: RemoteSlotInventorySource;
    complete: boolean;
    configured_endpoint_id: string | null;
    configured_host_hash: string | null;
    notes: string[];
  };
  summary: {
    total: number;
    healthy: number;
    busy: number;
    disconnected: number;
    completed_but_not_finalized: number;
    wedged: number;
    substrate_broken: number;
    unreachable: number;
    auth_failed: number;
    missing_token: number;
    not_configured: number;
    legacy: number;
    unknown: number;
    read_only: true;
  };
  lanes: RemoteFleetSlotLaneV1[];
  problems: RemoteFleetSlotsProblem[];
}

export interface RemoteFleetSlotsProblem {
  code: string;
  message: string;
}

export interface RemoteFleetSlotLaneV1 {
  lane_id: string | null;
  account_id: string | null;
  endpoint_id: string;
  host_hash: string | null;
  port: number | null;
  status: RemoteFleetSlotStatus;
  readiness_state: RemoteRunReadinessState | null;
  ok: boolean;
  http_status: number | null;
  version: string | null;
  build: OracleBuildInfo | null;
  observed_at: string;
  reason: string | null;
  probe: {
    primary_endpoint: "/ready" | "/health" | "/status" | null;
    fallback_endpoint: "/health" | "/status" | null;
    read_only: true;
    timed_out: boolean;
    error: string | null;
  };
  run: {
    run_id: string | null;
    session_id: string | null;
    session_id_hash: string | null;
    session_id_redacted: boolean;
    phase: RemoteActiveRunPhase | null;
    age_seconds: number | null;
    started_at: string | null;
    client_connected: boolean | null;
    completed_at: string | null;
    completed_age_seconds: number | null;
    prompt_chars: number | null;
    desired_model: string | null;
  };
  progress: {
    last_progress_age_seconds: number | null;
    source: "ready.lastProgressAgeSeconds" | null;
  };
  lease: {
    active_count: number | null;
    registry_readable: boolean | null;
    ttl_seconds: number | null;
    ttl_source: string | null;
  };
  substrate: {
    attach_only: boolean | null;
    chrome_reachable: boolean | null;
    chrome_owner_ok: boolean | null;
    cleanup_tainted: boolean | null;
    quarantined: boolean | null;
    manifest_present: boolean | null;
    manifest_match: boolean | null;
    manifest_mismatches: string[];
  };
  compatibility: {
    ready_supported: boolean;
    health_supported: boolean;
    status_supported: boolean | null;
    rich_progress_available: boolean;
    lease_ttl_available: boolean;
  };
  next_action: {
    code: RemoteSlotNextActionCode;
    message: string;
  };
}

// Sanitized per-run JSONL sink (`oracle.run.v1`) for the remote serve worker.
//
// Exactly one JSON line is appended per ACCEPTED /runs request — success,
// failure, and client-abort all emit from the run's finally block. The sink
// is the sanctioned metrics source for canary/monitoring tooling; scraping
// service journals is forbidden (journals have carried leaked secrets
// before, and log lines are not a schema).
//
// Field NAMES are normative (identity contract §oracle.run.v1): a field with
// no value is emitted as null, never renamed or omitted, so downstream
// consumers can rely on one shape. The record shape is CLOSED — no free-form
// metadata — which is what keeps the sink structurally sanitized: no token
// values, no prompt text, no raw attachment names (content hashes only), no
// raw conversation ids (hashed), no full tab URLs.
//
// Tamper evidence reuses the evidence-ledger discipline: each line records
// `prev_hash` (sha256 of the previous line's canonical bytes) and
// `entry_hash` (sha256 of the canonicalised entry including `prev_hash`),
// booting from a non-placeholder genesis digest. Appends are atomic single
// lines (0600 file), serialized per path in-process; each worker lane writes
// its own file so chains never interleave across processes.

import path from "node:path";
import { appendFile, chmod, mkdir, readFile } from "node:fs/promises";
import { canonicalJSON, isPlaceholderHash, sha256OfBytes } from "../oracle/v18/evidence.js";
import { getOracleHomeDir } from "../oracleHome.js";

export const RUN_EVENT_SCHEMA_VERSION = "oracle.run.v1" as const;

const GENESIS_PREIMAGE = "oracle.run.v1:genesis";
export const RUN_EVENT_GENESIS_HASH = sha256OfBytes(GENESIS_PREIMAGE);
if (isPlaceholderHash(RUN_EVENT_GENESIS_HASH)) {
  throw new Error(
    `oracle.run.v1 genesis hash collided with a placeholder digest: ${RUN_EVENT_GENESIS_HASH}`,
  );
}

/** Typed failure classes (identity contract §oracle.run.v1). */
export type RunErrorClass =
  | "integrity_binding_failed"
  | "integrity_ui_unknown"
  | "capacity_busy"
  | "account_quarantine"
  | "transport_interrupted_before_submit"
  | "transport_interrupted_after_submit";

export interface RunAttachmentDigest {
  index: number;
  bytes: number;
  sha256: string;
}

/**
 * One accepted run's record. Every key is REQUIRED at emit time; unknown
 * values are null. Names are normative — do not rename without a
 * schema_version bump in the identity contract.
 */
export interface OracleRunEventInput {
  run_id: string;
  job_id: string | null;
  account_id: string;
  lane_id: string;
  port: number | null;
  accepted_at: string | null;
  submitted_at: string | null;
  first_token_at: string | null;
  completed_at: string | null;
  scheduled_concurrency: number | null;
  active_tab_leases: number | null;
  busy_workers: number | null;
  error_class: RunErrorClass | null;
  done_ok: boolean | null;
  challenge_detected: boolean | null;
  model_verified: boolean | null;
  max_active_before_first_token: number | null;
  mean_active_during_ttft: number | null;
  max_active_during_generation: number | null;
  overlap_ms_at_c1: number | null;
  overlap_ms_at_c2: number | null;
  overlap_ms_at_c3: number | null;
  observed_egress_ip: string | null;
  attachments: RunAttachmentDigest[] | null;
  conversation_id_hash: string | null;
  provenance: {
    model_requested: string | null;
    model_resolved: string | null;
    model_verified: boolean | null;
  } | null;
}

export interface OracleRunEventEntry extends OracleRunEventInput {
  schema: typeof RUN_EVENT_SCHEMA_VERSION;
  sequence: number;
  prev_hash: `sha256:${string}`;
  entry_hash: `sha256:${string}`;
}

export interface AppendOracleRunEventOptions {
  /** Explicit sink file; defaults to resolveRunEventsPath(lane_id). */
  filePath?: string;
  /**
   * Final secret-absence guard: canonical line must not contain any of
   * these substrings (e.g. the worker's bearer token). Violation throws and
   * nothing is written.
   */
  assertAbsent?: string[];
}

/**
 * Default sink location: one file per lane so hash chains never interleave
 * across worker processes sharing a home directory. Overridable via
 * ORACLE_RUN_EVENTS_DIR (consumers glob the directory).
 */
export function resolveRunEventsPath(laneId: string): string {
  const dir = process.env.ORACLE_RUN_EVENTS_DIR ?? path.join(getOracleHomeDir(), "run-events");
  const safeLane = laneId.replace(/[^A-Za-z0-9._-]/g, "_");
  return path.join(dir, `oracle-run-events-${safeLane}.jsonl`);
}

interface SinkHead {
  sequence: number;
  prevHash: `sha256:${string}`;
}

const headCache = new Map<string, SinkHead>();
const appendQueues = new Map<string, Promise<unknown>>();

/** Serialize appends per file path within this process. */
function enqueue<T>(filePath: string, task: () => Promise<T>): Promise<T> {
  const prior = appendQueues.get(filePath) ?? Promise.resolve();
  const next = prior.then(task, task);
  appendQueues.set(
    filePath,
    next.catch(() => undefined),
  );
  return next;
}

async function resolveHead(filePath: string): Promise<SinkHead> {
  const cached = headCache.get(filePath);
  if (cached) {
    return cached;
  }
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch {
    return { sequence: 0, prevHash: RUN_EVENT_GENESIS_HASH };
  }
  const lines = raw.split("\n").filter((line) => line.trim().length > 0);
  const tail = lines[lines.length - 1];
  if (!tail) {
    return { sequence: 0, prevHash: RUN_EVENT_GENESIS_HASH };
  }
  try {
    const parsed = JSON.parse(tail) as { sequence?: unknown; entry_hash?: unknown };
    if (
      typeof parsed.sequence === "number" &&
      Number.isSafeInteger(parsed.sequence) &&
      typeof parsed.entry_hash === "string" &&
      parsed.entry_hash.startsWith("sha256:")
    ) {
      return {
        sequence: parsed.sequence + 1,
        prevHash: parsed.entry_hash as `sha256:${string}`,
      };
    }
  } catch {
    // fall through: unparseable tail restarts the chain at the next index
  }
  // Fail-safe: an unparseable tail must not block run accounting; the chain
  // break is detectable by verification (prev_hash mismatch), which is the
  // point of the hash chain.
  return { sequence: lines.length, prevHash: RUN_EVENT_GENESIS_HASH };
}

export async function appendOracleRunEvent(
  input: OracleRunEventInput,
  options: AppendOracleRunEventOptions = {},
): Promise<{ entry: OracleRunEventEntry; filePath: string }> {
  const filePath = options.filePath ?? resolveRunEventsPath(input.lane_id);
  return await enqueue(filePath, async () => {
    await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const head = await resolveHead(filePath);
    const entryWithoutHash = {
      schema: RUN_EVENT_SCHEMA_VERSION,
      sequence: head.sequence,
      ...input,
      prev_hash: head.prevHash,
    };
    const entryHash = sha256OfBytes(canonicalJSON(entryWithoutHash));
    const entry: OracleRunEventEntry = { ...entryWithoutHash, entry_hash: entryHash };
    const line = canonicalJSON(entry);
    for (const forbidden of options.assertAbsent ?? []) {
      if (forbidden && line.includes(forbidden)) {
        throw new Error(
          "oracle.run.v1 sink refused to write a line containing forbidden secret material",
        );
      }
    }
    await appendFile(filePath, `${line}\n`, { encoding: "utf8", mode: 0o600 });
    if (process.platform !== "win32") {
      await chmod(filePath, 0o600).catch(() => undefined);
    }
    headCache.set(filePath, { sequence: entry.sequence + 1, prevHash: entry.entry_hash });
    return { entry, filePath };
  });
}

const RUN_ERROR_CLASSES: ReadonlySet<string> = new Set([
  "integrity_binding_failed",
  "integrity_ui_unknown",
  "capacity_busy",
  "account_quarantine",
  "transport_interrupted_before_submit",
  "transport_interrupted_after_submit",
]);

export function isRunErrorClass(value: unknown): value is RunErrorClass {
  return typeof value === "string" && RUN_ERROR_CLASSES.has(value);
}

/**
 * Typed retry semantics per class. Post-submit interruptions are NOT
 * auto-retryable (the prompt may have reached the account), quarantine is
 * never retried, integrity failures need investigation rather than retries;
 * only capacity and pre-submit transport failures are safe to retry.
 */
export function isRetryableRunErrorClass(errorClass: RunErrorClass | null): boolean {
  return errorClass === "capacity_busy" || errorClass === "transport_interrupted_before_submit";
}

/**
 * Initial heuristic error classification for the sink (refined by the
 * terminal done-event work, which shares this enum). `submitted` reflects
 * whether the Send-confirmed marker was observed for the run.
 */
export function classifyRunErrorClass(
  message: string | null,
  submitted: boolean,
): RunErrorClass | null {
  if (message === null) {
    return null;
  }
  const lower = message.toLowerCase();
  if (lower.includes("binding")) {
    return "integrity_binding_failed";
  }
  if (lower.includes("challenge") || lower.includes("captcha") || lower.includes("interstitial")) {
    return "account_quarantine";
  }
  return submitted ? "transport_interrupted_after_submit" : "transport_interrupted_before_submit";
}

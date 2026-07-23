// `oracle status --json` / `oracle session --json` — machine-readable
// session list surface.
//
// Follows the Axiom-8 pattern already established by
// `commands/capabilities.ts` / `commands/robotDocs.ts`: a stable,
// documented JSON contract (`oracle_session_list.v1`) wrapped in a
// `json_envelope.v1`, with a pinned top-level key set backed by a
// schema-pin regression test (see tests/cli/sessionListJson.test.ts).
//
// Additive only — existing human-formatted `oracle status`/`oracle
// session` list output is unchanged when `--json` is absent. This closes
// flightdeck's OQ-8 ("no confirmed JSON list surface was found;
// mtime-sorted directory listing is the fallback") and gives baton's
// oracle port structured session enumeration instead of scraping
// terminal output. See
// scratchpad/oracle-feature-design/etafund-integration-backlog.md R4.

import path from "node:path";

import { V18_BUNDLE_VERSION, createEnvelope, type JsonEnvelope } from "../oracle/v18/index.js";
import type { SessionMetadata, SessionStatus } from "../sessionManager.js";
import { sessionStore } from "../sessionStore.js";
import { resolveValidatedSessionStatus } from "./sessionJson.js";

export const ORACLE_SESSION_LIST_SCHEMA_VERSION = "oracle_session_list.v1" as const;

/**
 * One session summary entry in the `oracle_session_list.v1` payload.
 *
 * `status` is the closed {@link SessionStatus} union (its exact runtime
 * value set is {@link SESSION_STATUS_VALUES}), NOT an open `string`, so a
 * robot caller polling this surface knows the finite set to switch on and
 * which values are terminal vs in-flight (see `sessionStatus.ts`).
 */
export interface SessionListEntry {
  readonly id: string;
  readonly lane: string | null;
  readonly model: string | null;
  readonly status: SessionStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly artifactsPath: string;
}

/** Re-exported so JSON callers importing the list surface get the enum too. */
export { SESSION_STATUS_VALUES } from "./sessionStatus.js";

export interface SessionListPayload {
  readonly schema_version: typeof ORACLE_SESSION_LIST_SCHEMA_VERSION;
  readonly generated_at: string;
  readonly count: number;
  readonly sessions: SessionListEntry[];
}

export interface SessionListEnvelopeResult {
  readonly envelope: JsonEnvelope;
  readonly payload: SessionListPayload;
}

export interface BuildSessionListOptions {
  readonly hours?: number;
  readonly includeAll?: boolean;
  readonly limit?: number;
  readonly modelFilter?: string;
  readonly now?: Date;
}

function matchesModel(entry: SessionMetadata, filter: string): boolean {
  const needle = filter.toLowerCase();
  if (entry.model?.toLowerCase().includes(needle)) {
    return true;
  }
  return Boolean(entry.models?.some((run) => run.model.toLowerCase().includes(needle)));
}

/**
 * Build one `SessionListEntry` from stored session metadata. Pure — no
 * I/O; `artifactsPath` is derived from the sessions directory convention,
 * not from a filesystem existence check (a listing must not fail because
 * one session's directory is mid-write or already pruned).
 */
export function buildSessionListEntry(metadata: SessionMetadata): SessionListEntry {
  return {
    id: metadata.id,
    lane: metadata.lane ?? null,
    model: metadata.model ?? null,
    status: resolveValidatedSessionStatus(metadata),
    createdAt: metadata.createdAt,
    updatedAt: metadata.completedAt ?? metadata.startedAt ?? metadata.createdAt,
    artifactsPath: path.join(sessionStore.sessionsDir(), metadata.id),
  };
}

/**
 * Build the `oracle_session_list.v1` payload for the current set of
 * stored sessions, applying the same hours/limit/model filters as the
 * human-formatted `oracle status`/`oracle session` list output so
 * `--json` and the default table view describe the same session set.
 */
export async function buildSessionListPayload(
  options: BuildSessionListOptions = {},
): Promise<SessionListPayload> {
  const now = options.now ?? new Date();
  const metas = await sessionStore.listSessions();
  const { entries } = sessionStore.filterSessions(metas, {
    hours: options.includeAll ? Infinity : (options.hours ?? 24),
    includeAll: options.includeAll,
    limit: options.limit,
  });
  const filtered = options.modelFilter
    ? entries.filter((entry) => matchesModel(entry, options.modelFilter as string))
    : entries;
  return {
    schema_version: ORACLE_SESSION_LIST_SCHEMA_VERSION,
    generated_at: now.toISOString(),
    count: filtered.length,
    sessions: filtered.map(buildSessionListEntry),
  };
}

/** Wrap the session-list payload in a `json_envelope.v1`. */
export async function buildSessionListEnvelope(
  options: BuildSessionListOptions = {},
): Promise<SessionListEnvelopeResult> {
  const payload = await buildSessionListPayload(options);
  const envelope = createEnvelope({
    ok: true,
    data: payload as unknown as Record<string, unknown>,
    meta: {
      bundle_version: V18_BUNDLE_VERSION,
      schema_version: payload.schema_version,
      generated_at: payload.generated_at,
      count: payload.count,
    },
    next_command: "oracle capabilities --json",
    fix_command: null,
    retry_safe: true,
    commands: {
      status_json: "oracle status --json",
      session_json: "oracle session --json",
    },
  });
  return { envelope, payload };
}

export interface RunSessionListJsonIo {
  readonly stdout?: (text: string) => void;
}

/** Build the envelope and print it as canonical JSON to stdout. */
export async function runSessionListJson(
  options: BuildSessionListOptions = {},
  io: RunSessionListJsonIo = {},
): Promise<SessionListEnvelopeResult> {
  const result = await buildSessionListEnvelope(options);
  const write = io.stdout ?? ((text: string) => process.stdout.write(text));
  write(`${JSON.stringify(result.envelope, null, 2)}\n`);
  return result;
}

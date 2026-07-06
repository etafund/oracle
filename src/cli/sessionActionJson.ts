// `oracle restart <id> --json` / `oracle follow-up <parentSessionId> --json`
// — machine-readable launch receipts for the two session *action* verbs.
//
// Follows the Axiom-8 pattern established by `sessionListJson.ts`
// (`oracle_session_list.v1`): a stable, documented JSON contract
// (`oracle_session_action.v1`) wrapped in a `json_envelope.v1`, with a
// pinned key set backed by a schema-pin regression test (see
// tests/cli/sessionActionJson.test.ts).
//
// Unlike the read-only list surface, restart/follow-up start a *paid live
// run*. The receipt therefore describes the launch — the new session id,
// its parent, engine/lane/model, wait/detach disposition, and the exact
// reattach command — rather than the answer text. An agent scripting a
// restart-then-poll loop parses this one object from stdout (all progress
// lines move to stderr in `--json` mode) and then polls
// `oracle session <id> --artifacts --json` / `oracle status --json`.
// `retry_safe` is false on purpose: re-running the action starts another
// paid session.

import { V18_BUNDLE_VERSION, createEnvelope, type JsonEnvelope } from "../oracle/v18/index.js";

export const ORACLE_SESSION_ACTION_SCHEMA_VERSION = "oracle_session_action.v1" as const;

/** Which lifecycle action produced this receipt. */
export type SessionActionKind = "restart" | "follow-up";

/** The pinned `oracle_session_action.v1` payload shape. */
export interface SessionActionPayload {
  readonly schema_version: typeof ORACLE_SESSION_ACTION_SCHEMA_VERSION;
  readonly action: SessionActionKind;
  /** The NEW session started by the action. */
  readonly session_id: string;
  /** The session the action was derived from (restart source / follow-up parent). */
  readonly parent_session_id: string;
  readonly engine: string;
  readonly mode: string;
  readonly lane: string | null;
  readonly model: string | null;
  /** Session status at emit time ("pending"/"running" for detached launches, terminal after --wait). */
  readonly status: string;
  readonly wait_preference: boolean;
  readonly detached: boolean;
  readonly reattach_command: string;
  /** Browser conversation URL when known (follow-up); null for API restarts. */
  readonly conversation_url: string | null;
}

export interface BuildSessionActionInput {
  readonly action: SessionActionKind;
  readonly sessionId: string;
  readonly parentSessionId: string;
  readonly engine: string;
  readonly mode: string;
  readonly lane?: string | null;
  readonly model?: string | null;
  readonly status: string;
  readonly waitPreference: boolean;
  readonly detached: boolean;
  readonly reattachCommand: string;
  readonly conversationUrl?: string | null;
}

export interface SessionActionEnvelopeResult {
  readonly envelope: JsonEnvelope;
  readonly payload: SessionActionPayload;
}

/** Build the pinned payload. Pure — no I/O, no clock. */
export function buildSessionActionPayload(input: BuildSessionActionInput): SessionActionPayload {
  return {
    schema_version: ORACLE_SESSION_ACTION_SCHEMA_VERSION,
    action: input.action,
    session_id: input.sessionId,
    parent_session_id: input.parentSessionId,
    engine: input.engine,
    mode: input.mode,
    lane: input.lane ?? null,
    model: input.model ?? null,
    status: input.status,
    wait_preference: input.waitPreference,
    detached: input.detached,
    reattach_command: input.reattachCommand,
    conversation_url: input.conversationUrl ?? null,
  };
}

/** Wrap the receipt payload in a `json_envelope.v1`. Pure — no I/O. */
export function buildSessionActionEnvelope(
  input: BuildSessionActionInput,
): SessionActionEnvelopeResult {
  const payload = buildSessionActionPayload(input);
  const envelope = createEnvelope({
    ok: true,
    data: payload as unknown as Record<string, unknown>,
    meta: {
      bundle_version: V18_BUNDLE_VERSION,
      schema_version: payload.schema_version,
      action: payload.action,
      session_id: payload.session_id,
    },
    next_command: payload.reattach_command,
    fix_command: null,
    // Re-running restart/follow-up starts ANOTHER paid session; a blind
    // retry is never safe once the receipt has been emitted.
    retry_safe: false,
    commands: {
      reattach: payload.reattach_command,
      artifacts_json: `oracle session ${payload.session_id} --artifacts --json`,
      list_json: "oracle status --json",
    },
  });
  return { envelope, payload };
}

/** Render the envelope exactly like `runSessionListJson` does (one object, trailing newline). */
export function renderSessionActionEnvelope(envelope: JsonEnvelope): string {
  return `${JSON.stringify(envelope, null, 2)}\n`;
}

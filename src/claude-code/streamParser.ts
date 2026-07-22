import { posix as posixPath } from "node:path";
import { TextDecoder } from "node:util";

export type ClaudeCodeStreamName = "stdout" | "stderr";

export interface ClaudeCodeNormalizedEvent {
  seq: number;
  receivedAt: string;
  stream: ClaudeCodeStreamName;
  rawByteOffset: number;
  rawByteLength: number;
  rawText?: string;
  rawBase64?: string;
  json: unknown | null;
  type?: string;
  text?: string;
  parseError?: string;
  partial?: boolean;
  empty?: boolean;
}

export type ClaudeCodePlanProtocolFailureReason =
  | "malformed-exit-envelope"
  | "missing-exit-envelope"
  | "invalid-exit-payload"
  | "missing-terminal-assistant-envelope"
  | "invalid-assistant-exit-payload"
  | "missing-write-envelope"
  | "invalid-plan-marker-path"
  | "empty-plan-content"
  | "ambiguous-write-envelopes";

/**
 * A verified Fable plan/no-tools stream ended in Claude Code's text-rendered
 * plan protocol, but Oracle could not prove one authoritative plan body.
 * Callers must retain the raw stream artifact and fail the run rather than
 * expose the protocol envelope as a successful answer.
 */
export class ClaudeCodePlanProtocolError extends Error {
  readonly code = "fable-plan-protocol-unrecoverable";

  constructor(readonly reason: ClaudeCodePlanProtocolFailureReason) {
    super(
      `Verified Fable plan/no-tools output ended in an unrecoverable plan-protocol episode (${reason}); refusing to treat the raw protocol envelope as the final answer.`,
    );
    this.name = "ClaudeCodePlanProtocolError";
  }
}

interface StreamState {
  nextOffset: number;
  pending: Buffer;
  pendingOffset: number;
}

export class ClaudeCodeStreamNormalizer {
  private seq = 0;
  private readonly stdout: StreamState = {
    nextOffset: 0,
    pending: Buffer.alloc(0),
    pendingOffset: 0,
  };
  private readonly stderr: StreamState = {
    nextOffset: 0,
    pending: Buffer.alloc(0),
    pendingOffset: 0,
  };

  push(
    stream: ClaudeCodeStreamName,
    chunk: Buffer | Uint8Array | string,
    receivedAt: string = new Date().toISOString(),
  ): ClaudeCodeNormalizedEvent[] {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (bytes.length === 0) {
      return [];
    }
    if (stream === "stderr") {
      return [this.emitChunkEvent("stderr", bytes, receivedAt)];
    }
    return this.pushStdout(bytes, receivedAt);
  }

  finish(receivedAt: string = new Date().toISOString()): ClaudeCodeNormalizedEvent[] {
    const events: ClaudeCodeNormalizedEvent[] = [];
    if (this.stdout.pending.length > 0) {
      const bytes = this.stdout.pending;
      events.push(this.emitStdoutLine(bytes, this.stdout.pendingOffset, receivedAt, true));
      this.stdout.pending = Buffer.alloc(0);
      this.stdout.pendingOffset = this.stdout.nextOffset;
    }
    return events;
  }

  private pushStdout(bytes: Buffer, receivedAt: string): ClaudeCodeNormalizedEvent[] {
    if (this.stdout.pending.length === 0) {
      this.stdout.pendingOffset = this.stdout.nextOffset;
    }
    this.stdout.nextOffset += bytes.length;
    this.stdout.pending = Buffer.concat([this.stdout.pending, bytes]);

    const events: ClaudeCodeNormalizedEvent[] = [];
    while (true) {
      const newline = this.stdout.pending.indexOf(0x0a);
      if (newline === -1) {
        break;
      }
      const line = this.stdout.pending.subarray(0, newline + 1);
      events.push(this.emitStdoutLine(line, this.stdout.pendingOffset, receivedAt, false));
      this.stdout.pending = this.stdout.pending.subarray(newline + 1);
      this.stdout.pendingOffset += line.length;
    }
    return events;
  }

  private emitChunkEvent(
    stream: "stderr",
    bytes: Buffer,
    receivedAt: string,
  ): ClaudeCodeNormalizedEvent {
    const offset = this.stderr.nextOffset;
    this.stderr.nextOffset += bytes.length;
    return {
      seq: this.seq++,
      receivedAt,
      stream,
      rawByteOffset: offset,
      rawByteLength: bytes.length,
      ...decodeRaw(bytes),
      json: null,
    };
  }

  private emitStdoutLine(
    bytes: Buffer,
    offset: number,
    receivedAt: string,
    partial: boolean,
  ): ClaudeCodeNormalizedEvent {
    const decoded = decodeRaw(bytes);
    const base: ClaudeCodeNormalizedEvent = {
      seq: this.seq++,
      receivedAt,
      stream: "stdout",
      rawByteOffset: offset,
      rawByteLength: bytes.length,
      ...decoded,
      json: null,
      partial,
    };

    if (decoded.rawText === undefined) {
      return { ...base, parseError: "invalid_utf8" };
    }

    const parseTarget = decoded.rawText.trim();
    if (!parseTarget) {
      return { ...base, empty: true };
    }

    try {
      const json = JSON.parse(parseTarget) as unknown;
      return {
        ...base,
        json,
        type: extractEventType(json),
        text: extractVisibleText(json),
      };
    } catch (error) {
      return {
        ...base,
        parseError: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

export function extractEventType(json: unknown): string | undefined {
  if (!json || typeof json !== "object") {
    return undefined;
  }
  const obj = json as Record<string, unknown>;
  if (typeof obj.type === "string") {
    return obj.subtype && typeof obj.subtype === "string" ? `${obj.type}/${obj.subtype}` : obj.type;
  }
  const event = obj.event;
  if (
    event &&
    typeof event === "object" &&
    typeof (event as { type?: unknown }).type === "string"
  ) {
    return `stream_event/${(event as { type: string }).type}`;
  }
  return undefined;
}

export function extractVisibleText(json: unknown): string | undefined {
  if (!json || typeof json !== "object") {
    return undefined;
  }
  const obj = json as Record<string, unknown>;
  if (typeof obj.result === "string") {
    return obj.result;
  }
  const event = obj.event;
  if (event && typeof event === "object") {
    const delta = (event as { delta?: unknown }).delta;
    if (delta && typeof delta === "object") {
      const text = (delta as { text?: unknown }).text;
      if (typeof text === "string") {
        return text;
      }
    }
  }
  const message = obj.message;
  if (message && typeof message === "object") {
    const content = (message as { content?: unknown }).content;
    if (Array.isArray(content)) {
      const text = content
        .map((part) => {
          if (
            part &&
            typeof part === "object" &&
            typeof (part as { text?: unknown }).text === "string"
          ) {
            return (part as { text: string }).text;
          }
          return "";
        })
        .join("");
      return text || undefined;
    }
  }
  return undefined;
}

/**
 * Select one authoritative final-answer representation from Claude Code's
 * layered stream-json output. A normal successful run can expose the same
 * text three times: incremental text deltas, a complete assistant snapshot,
 * and the terminal result. Never concatenate those layers.
 *
 * Precedence is terminal result, then the last complete assistant snapshot,
 * then concatenated text deltas for older/incomplete streams that emitted no
 * complete representation.
 */
export function extractAuthoritativeFinalText(
  events: readonly ClaudeCodeNormalizedEvent[],
): string {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    const json = objectRecord(event?.json);
    if (json?.type === "result" && typeof json.result === "string") {
      return resolvePlanProtocolCandidate(events, index, json.result, false);
    }
    if (event?.type?.startsWith("result") && typeof event.text === "string") {
      return resolvePlanProtocolCandidate(events, index, event.text, false);
    }
  }

  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    const json = objectRecord(event?.json);
    if (json?.type === "assistant" && typeof event?.text === "string") {
      return resolvePlanProtocolCandidate(events, index, event.text, true);
    }
    if (event?.type === "assistant" && typeof event.text === "string") {
      return resolvePlanProtocolCandidate(events, index, event.text, true);
    }
  }

  const textDeltas = events
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => isTextDeltaEvent(event));
  const finalText = textDeltas.map(({ event }) => event.text ?? "").join("");
  const finalDelta = textDeltas.at(-1);
  return finalDelta
    ? resolvePlanProtocolCandidate(events, finalDelta.index, finalText, true)
    : finalText;
}

/**
 * Claude Code plan mode can occasionally serialize its internal plan-file
 * protocol as ordinary assistant text when Oracle deliberately supplies no
 * tools. The complete answer then appears in a preceding
 * `Write { file_path: ~/.claude/plans/..., content: ... }` envelope while the
 * terminal result contains only `ExitPlanMode` plus a short summary. Recovery
 * is intentionally a tail-state parser rather than a global search: the Write
 * must belong to the selected result's contiguous terminal protocol episode.
 * Ordinary answers that merely discuss Write/ExitPlanMode remain untouched.
 */
type PlanProtocolRecovery =
  | { kind: "not-protocol" }
  | { kind: "recovered"; content: string }
  | { kind: "invalid"; reason: ClaudeCodePlanProtocolFailureReason };

function resolvePlanProtocolCandidate(
  events: readonly ClaudeCodeNormalizedEvent[],
  candidateIndex: number,
  candidateText: string,
  requireVerifiedFablePlan: boolean,
): string {
  if (requireVerifiedFablePlan) {
    const sessionInit = findNearestSessionInit(events, candidateIndex - 1);
    if (!sessionInit || !isVerifiedFablePlanInit(sessionInit.json)) {
      return candidateText;
    }
  }

  const recoveredPlan = recoverLeakedPlanProtocolContent(events, candidateIndex, candidateText);
  if (recoveredPlan.kind === "recovered") {
    return recoveredPlan.content;
  }
  if (recoveredPlan.kind === "invalid") {
    throw new ClaudeCodePlanProtocolError(recoveredPlan.reason);
  }
  return candidateText;
}

function recoverLeakedPlanProtocolContent(
  events: readonly ClaudeCodeNormalizedEvent[],
  candidateIndex: number,
  terminalText: string,
): PlanProtocolRecovery {
  const candidateEvent = events[candidateIndex];
  const candidateJson = objectRecord(candidateEvent?.json);
  if (
    candidateJson?.is_error === true ||
    (typeof candidateJson?.subtype === "string" && candidateJson.subtype !== "success")
  ) {
    return { kind: "not-protocol" };
  }

  const sessionInit = findNearestSessionInit(events, candidateIndex - 1);
  const verifiedFablePlan = Boolean(sessionInit && isVerifiedFablePlanInit(sessionInit.json));
  if (sessionInit && !verifiedFablePlan) {
    return { kind: "not-protocol" };
  }
  const terminalExit = parseProtocolObject(terminalText, "ExitPlanMode");
  if (!terminalExit) {
    if (!verifiedFablePlan) {
      return { kind: "not-protocol" };
    }
    if (looksLikeProtocolObject(terminalText, "ExitPlanMode")) {
      return { kind: "invalid", reason: "malformed-exit-envelope" };
    }
    if (looksLikeProtocolObject(terminalText, "Write")) {
      return { kind: "invalid", reason: "missing-exit-envelope" };
    }
    return { kind: "not-protocol" };
  }
  if (typeof terminalExit.plan !== "string") {
    return verifiedFablePlan
      ? { kind: "invalid", reason: "invalid-exit-payload" }
      : { kind: "not-protocol" };
  }
  const sessionStartIndex = sessionInit?.index ?? -1;

  let previous = findPreviousCompleteConversationEvent(
    events,
    candidateIndex - 1,
    sessionStartIndex,
  );
  if (!previous || previous.kind !== "assistant" || previous.text === null) {
    return verifiedFablePlan
      ? { kind: "invalid", reason: "missing-terminal-assistant-envelope" }
      : { kind: "not-protocol" };
  }

  const assistantExit = parseProtocolObject(previous.text, "ExitPlanMode");
  if (assistantExit) {
    if (typeof assistantExit.plan !== "string") {
      return verifiedFablePlan
        ? { kind: "invalid", reason: "invalid-assistant-exit-payload" }
        : { kind: "not-protocol" };
    }
    previous = findPreviousCompleteConversationEvent(events, previous.index - 1, sessionStartIndex);
  }

  if (!previous || previous.kind !== "assistant" || previous.text === null) {
    return verifiedFablePlan
      ? { kind: "invalid", reason: "missing-write-envelope" }
      : { kind: "not-protocol" };
  }
  const writeEnvelope = parseProtocolObject(previous.text, "Write");
  if (!writeEnvelope) {
    return verifiedFablePlan
      ? { kind: "invalid", reason: "missing-write-envelope" }
      : { kind: "not-protocol" };
  }
  const filePath = typeof writeEnvelope.file_path === "string" ? writeEnvelope.file_path : "";
  const content = typeof writeEnvelope.content === "string" ? writeEnvelope.content : "";
  if (!isValidPlanMarkerPath(filePath)) {
    return verifiedFablePlan
      ? { kind: "invalid", reason: "invalid-plan-marker-path" }
      : { kind: "not-protocol" };
  }
  if (!content.trim()) {
    return verifiedFablePlan
      ? { kind: "invalid", reason: "empty-plan-content" }
      : { kind: "not-protocol" };
  }

  const eventBeforeWrite = findPreviousCompleteConversationEvent(
    events,
    previous.index - 1,
    sessionStartIndex,
  );
  if (
    eventBeforeWrite?.kind === "assistant" &&
    eventBeforeWrite.text !== null &&
    parseProtocolObject(eventBeforeWrite.text, "Write")
  ) {
    // Two adjacent candidates are ambiguous. Do not guess which plan is the
    // answer, even though the nearer one would usually be the latest.
    return verifiedFablePlan
      ? { kind: "invalid", reason: "ambiguous-write-envelopes" }
      : { kind: "not-protocol" };
  }

  return { kind: "recovered", content };
}

interface SessionInitEvent {
  index: number;
  json: Record<string, unknown>;
}

function findNearestSessionInit(
  events: readonly ClaudeCodeNormalizedEvent[],
  startIndex: number,
): SessionInitEvent | null {
  for (let index = startIndex; index >= 0; index -= 1) {
    const json = objectRecord(events[index]?.json);
    if (json?.type === "system" && json.subtype === "init") {
      return { index, json };
    }
  }
  return null;
}

function isVerifiedFablePlanInit(init: Record<string, unknown>): boolean {
  const model = typeof init.model === "string" ? init.model.trim().toLowerCase() : "";
  return (
    (model === "fable" || model === "claude-fable-5") &&
    init.permissionMode === "plan" &&
    Array.isArray(init.tools) &&
    init.tools.length === 0
  );
}

interface CompleteConversationEvent {
  index: number;
  kind: "assistant" | "result";
  text: string | null;
}

function findPreviousCompleteConversationEvent(
  events: readonly ClaudeCodeNormalizedEvent[],
  startIndex: number,
  sessionStartIndex: number,
): CompleteConversationEvent | null {
  for (let index = startIndex; index > sessionStartIndex; index -= 1) {
    const event = events[index];
    const json = objectRecord(event?.json);
    const type =
      typeof json?.type === "string"
        ? json.type
        : event?.type === "assistant" || event?.type?.startsWith("result")
          ? event.type.startsWith("result")
            ? "result"
            : "assistant"
          : null;
    if (type === "assistant") {
      const text = typeof event?.text === "string" ? event.text : null;
      if (text === null || !text.trim()) {
        // Claude can emit a complete thinking-only assistant snapshot between
        // the text-rendered Write and ExitPlanMode protocol messages. It has
        // no answer text and is transparent to this terminal episode.
        continue;
      }
      return {
        index,
        kind: "assistant",
        text,
      };
    }
    if (type === "result") {
      return {
        index,
        kind: "result",
        text: typeof event?.text === "string" ? event.text : null,
      };
    }
  }
  return null;
}

/** Parse only Claude Code's exact text-rendered tool protocol envelope. */
function parseProtocolObject(
  text: string,
  command: "Write" | "ExitPlanMode",
): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith(command)) {
    return null;
  }
  const afterCommand = trimmed.slice(command.length);
  if (!/^\s/u.test(afterCommand)) {
    return null;
  }

  let payload = afterCommand.trim();
  const inputHeader = /^Input[ \t]*(?:\r?\n)+/u.exec(payload);
  if (inputHeader) {
    payload = payload.slice(inputHeader[0].length).trim();
  }
  try {
    return objectRecord(JSON.parse(payload));
  } catch {
    return null;
  }
}

/**
 * Recognize only a text-rendered tool envelope shape, not prose that merely
 * mentions the command. Invalid JSON and trailing text still count as a
 * protocol-shaped terminal state so verified Fable runs fail closed.
 */
function looksLikeProtocolObject(text: string, command: "Write" | "ExitPlanMode"): boolean {
  const trimmed = text.trim();
  if (!trimmed.startsWith(command)) {
    return false;
  }
  const afterCommand = trimmed.slice(command.length);
  if (!/^\s/u.test(afterCommand)) {
    return false;
  }
  const payload = afterCommand.trim();
  return payload.startsWith("{") || /^Input[ \t]*(?:\r?\n|$)/u.test(payload);
}

/**
 * The path is a protocol marker only. Validate it lexically; never access it.
 * CAAM deliberately changes HOME, so the prefix is not compared with the
 * current process's home directory.
 */
function isValidPlanMarkerPath(filePath: string): boolean {
  if (
    !filePath ||
    !posixPath.isAbsolute(filePath) ||
    filePath.includes("\\") ||
    /[\u0000-\u001f\u007f]/u.test(filePath)
  ) {
    return false;
  }
  const segments = filePath.split("/");
  if (segments.some((segment) => segment === "." || segment === "..")) {
    return false;
  }
  if (posixPath.normalize(filePath) !== filePath || segments.length < 4) {
    return false;
  }

  const fileName = segments.at(-1) ?? "";
  return (
    segments.at(-3) === ".claude" &&
    segments.at(-2) === "plans" &&
    fileName.length > ".md".length &&
    fileName.endsWith(".md")
  );
}

export function isTextDeltaEvent(event: ClaudeCodeNormalizedEvent): boolean {
  if (event.stream !== "stdout" || typeof event.text !== "string") {
    return false;
  }
  const json = objectRecord(event.json);
  if (json?.type !== "stream_event") {
    return false;
  }
  const nestedEvent = objectRecord(json.event);
  const delta = objectRecord(nestedEvent?.delta);
  return nestedEvent?.type === "content_block_delta" && delta?.type === "text_delta";
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function decodeRaw(bytes: Buffer): Pick<ClaudeCodeNormalizedEvent, "rawText" | "rawBase64"> {
  try {
    return { rawText: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
  } catch {
    return { rawBase64: bytes.toString("base64") };
  }
}

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
      return json.result;
    }
    if (event?.type?.startsWith("result") && typeof event.text === "string") {
      return event.text;
    }
  }

  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    const json = objectRecord(event?.json);
    if (json?.type === "assistant" && typeof event?.text === "string") {
      return event.text;
    }
    if (event?.type === "assistant" && typeof event.text === "string") {
      return event.text;
    }
  }

  return events
    .filter(isTextDeltaEvent)
    .map((event) => event.text ?? "")
    .join("");
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

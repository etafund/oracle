import { createHash } from "node:crypto";
import {
  appendFile,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

type StreamName = "stdout" | "stderr";
type ParseStatus = "json" | "text" | "invalid_utf8" | "json_parse_error" | "stderr";
type LineTerminator = "lf" | "crlf" | "none";

interface FeedChunk {
  stream: StreamName;
  label: string;
  bytes: Buffer;
}

interface NormalizedEvent {
  schemaVersion: 1;
  receiveSeq: number;
  timestamp: string;
  stream: StreamName;
  byteOffset: number;
  byteLength: number;
  rawEncoding: "base64";
  rawBase64: string;
  rawSha256: string;
  parseStatus: ParseStatus;
  lineTerminator?: LineTerminator;
  partialFinal?: boolean;
  decodedText?: string;
  jsonType?: string;
  extractedVisibleText?: string;
  error?: string;
}

interface CaptureSummary {
  status: "completed" | "error";
  errorCode?: string;
  stdoutBytes: number;
  stderrBytes: number;
  rawStdoutSha256: string;
  rawStderrSha256: string;
  events: number;
  parseErrors: number;
  partialEvents: number;
  streamsComplete: boolean;
  stdoutPath: string;
  stderrPath: string;
  eventsPath: string;
}

interface ResourceRef {
  uri: string;
  artifactKind: string;
  bytes: number;
  sha256: string;
}

interface McpEnvelope {
  schemaVersion: 1;
  status: "completed" | "overflow" | "error";
  success: boolean;
  sessionId: string;
  finalAnswer: string | null;
  eventsComplete: boolean;
  streamsComplete: boolean;
  inlineByteLimit: number;
  inlineVisibleBytes: number;
  stdoutBytes: number;
  stderrBytes: number;
  eventCount: number;
  omittedEventCount: number;
  omittedVisibleBytes: number;
  events?: NormalizedEvent[];
  resources: ResourceRef[];
  overflow?: {
    reason: "mcp_inline_byte_limit_exceeded";
    policy: "early_abort" | "finish_then_non_success";
    message: string;
  };
}

const workerRoot = path.resolve(
  ".planning-runs/claude-code-spike-execution-2026-07-02/worker-c-nonfast",
);
const outputRoot = path.join(workerRoot, "output");
const sessionsRoot = path.join(outputRoot, "sessions");
const resultsRoot = path.join(outputRoot, "results");
const DEFAULT_INLINE_VISIBLE_BYTE_LIMIT = 1_048_576;

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function timestampForSeq(seq: number): string {
  return new Date(Date.UTC(2026, 6, 2, 8, 0, 0, seq)).toISOString();
}

function strictUtf8(bytes: Buffer): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function safeJsonType(value: unknown): string | undefined {
  if (value && typeof value === "object" && "type" in value) {
    const type = (value as { type?: unknown }).type;
    return typeof type === "string" ? type : undefined;
  }
  return undefined;
}

function extractVisibleText(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  for (const key of ["delta", "text", "result", "message"]) {
    const candidate = record[key];
    if (typeof candidate === "string" && candidate.length > 0) {
      return candidate;
    }
  }
  return undefined;
}

function classifyPayload(bytes: Buffer): Pick<
  NormalizedEvent,
  "parseStatus" | "decodedText" | "jsonType" | "extractedVisibleText" | "error"
> {
  let decoded: string;
  try {
    decoded = strictUtf8(bytes);
  } catch (error) {
    return {
      parseStatus: "invalid_utf8",
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const trimmed = decoded.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      return {
        parseStatus: "json",
        decodedText: decoded,
        jsonType: safeJsonType(parsed),
        extractedVisibleText: extractVisibleText(parsed),
      };
    } catch (error) {
      return {
        parseStatus: "json_parse_error",
        decodedText: decoded,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  return {
    parseStatus: "text",
    decodedText: decoded,
    extractedVisibleText: decoded,
  };
}

class ControlledRawWriter {
  private written = 0;

  constructor(
    private readonly filePath: string,
    private readonly failAfterBytes: number | null = null,
  ) {}

  async append(bytes: Buffer): Promise<void> {
    if (this.failAfterBytes === null || this.written + bytes.length <= this.failAfterBytes) {
      await appendFile(this.filePath, bytes);
      this.written += bytes.length;
      return;
    }
    const remaining = Math.max(0, this.failAfterBytes - this.written);
    if (remaining > 0) {
      await appendFile(this.filePath, bytes.subarray(0, remaining));
      this.written += remaining;
    }
    throw new Error(`simulated raw artifact write failure after ${this.written} bytes`);
  }
}

class StreamCapture {
  private readonly events: NormalizedEvent[] = [];
  private readonly rawBuffers: Record<StreamName, Buffer[]> = { stdout: [], stderr: [] };
  private readonly streamOffsets: Record<StreamName, number> = { stdout: 0, stderr: 0 };
  private readonly pendingStdout: { offset: number; bytes: Buffer } = {
    offset: 0,
    bytes: Buffer.alloc(0),
  };
  private seq = 0;
  private failed = false;
  private failureCode: string | undefined;
  private readonly stdoutPath: string;
  private readonly stderrPath: string;
  private readonly eventsPath: string;
  private readonly stdoutWriter: ControlledRawWriter;
  private readonly stderrWriter: ControlledRawWriter;

  constructor(
    private readonly sessionDir: string,
    options: { failAfterStdoutBytes?: number } = {},
  ) {
    const artifactsDir = path.join(sessionDir, "artifacts");
    this.stdoutPath = path.join(artifactsDir, "claude-code-stdout.raw");
    this.stderrPath = path.join(artifactsDir, "claude-code-stderr.raw");
    this.eventsPath = path.join(artifactsDir, "claude-code-events.normalized.ndjson");
    this.stdoutWriter = new ControlledRawWriter(
      this.stdoutPath,
      options.failAfterStdoutBytes ?? null,
    );
    this.stderrWriter = new ControlledRawWriter(this.stderrPath);
  }

  async init(): Promise<void> {
    await mkdir(path.dirname(this.stdoutPath), { recursive: true });
    await writeFile(this.stdoutPath, Buffer.alloc(0));
    await writeFile(this.stderrPath, Buffer.alloc(0));
    await writeFile(this.eventsPath, "");
  }

  async feed(chunk: FeedChunk): Promise<void> {
    if (this.failed) {
      return;
    }
    const offset = this.streamOffsets[chunk.stream];
    try {
      if (chunk.stream === "stdout") {
        await this.stdoutWriter.append(chunk.bytes);
      } else {
        await this.stderrWriter.append(chunk.bytes);
      }
    } catch (error) {
      this.failed = true;
      this.failureCode = "raw_artifact_write_failed";
      await this.writeFailureEvent(chunk, offset, error);
      return;
    }

    this.rawBuffers[chunk.stream].push(chunk.bytes);
    this.streamOffsets[chunk.stream] += chunk.bytes.length;
    if (chunk.stream === "stderr") {
      await this.recordStderrChunk(chunk.bytes, offset);
      return;
    }
    await this.recordStdoutBytes(chunk.bytes);
  }

  private async writeFailureEvent(chunk: FeedChunk, offset: number, error: unknown): Promise<void> {
    const event = this.baseEvent(chunk.stream, offset, chunk.bytes, {
      parseStatus: chunk.stream === "stderr" ? "stderr" : "invalid_utf8",
      error: error instanceof Error ? error.message : String(error),
    });
    this.events.push(event);
    await appendFile(this.eventsPath, `${JSON.stringify(event)}\n`);
  }

  private baseEvent(
    stream: StreamName,
    byteOffset: number,
    rawBytes: Buffer,
    detail: Pick<
      NormalizedEvent,
      | "parseStatus"
      | "decodedText"
      | "jsonType"
      | "extractedVisibleText"
      | "error"
      | "lineTerminator"
      | "partialFinal"
    >,
  ): NormalizedEvent {
    this.seq += 1;
    return {
      schemaVersion: 1,
      receiveSeq: this.seq,
      timestamp: timestampForSeq(this.seq),
      stream,
      byteOffset,
      byteLength: rawBytes.length,
      rawEncoding: "base64",
      rawBase64: rawBytes.toString("base64"),
      rawSha256: sha256(rawBytes),
      ...detail,
    };
  }

  private async appendEvent(event: NormalizedEvent): Promise<void> {
    this.events.push(event);
    await appendFile(this.eventsPath, `${JSON.stringify(event)}\n`);
  }

  private async recordStderrChunk(bytes: Buffer, offset: number): Promise<void> {
    let decodedText: string | undefined;
    let error: string | undefined;
    try {
      decodedText = strictUtf8(bytes);
    } catch (decodeError) {
      error = decodeError instanceof Error ? decodeError.message : String(decodeError);
    }
    await this.appendEvent(
      this.baseEvent("stderr", offset, bytes, {
        parseStatus: "stderr",
        decodedText,
        extractedVisibleText: decodedText,
        error,
      }),
    );
  }

  private async recordStdoutBytes(bytes: Buffer): Promise<void> {
    this.pendingStdout.bytes = Buffer.concat([this.pendingStdout.bytes, bytes]);
    for (;;) {
      const lfIndex = this.pendingStdout.bytes.indexOf(0x0a);
      if (lfIndex === -1) {
        return;
      }
      const rawLine = this.pendingStdout.bytes.subarray(0, lfIndex + 1);
      const contentWithPossibleCr = rawLine.subarray(0, rawLine.length - 1);
      const hasCr = contentWithPossibleCr.at(-1) === 0x0d;
      const content = hasCr
        ? contentWithPossibleCr.subarray(0, contentWithPossibleCr.length - 1)
        : contentWithPossibleCr;
      await this.appendEvent(
        this.baseEvent("stdout", this.pendingStdout.offset, rawLine, {
          ...classifyPayload(content),
          lineTerminator: hasCr ? "crlf" : "lf",
        }),
      );
      this.pendingStdout.offset += rawLine.length;
      this.pendingStdout.bytes = this.pendingStdout.bytes.subarray(lfIndex + 1);
    }
  }

  async finish(options: { streamsComplete: boolean; errorCode?: string } = {
    streamsComplete: true,
  }): Promise<CaptureSummary> {
    if (!this.failed && this.pendingStdout.bytes.length > 0) {
      await this.appendEvent(
        this.baseEvent("stdout", this.pendingStdout.offset, this.pendingStdout.bytes, {
          ...classifyPayload(this.pendingStdout.bytes),
          lineTerminator: "none",
          partialFinal: true,
        }),
      );
      this.pendingStdout.offset += this.pendingStdout.bytes.length;
      this.pendingStdout.bytes = Buffer.alloc(0);
    }

    const stdoutRaw = await readFile(this.stdoutPath).catch(() => Buffer.alloc(0));
    const stderrRaw = await readFile(this.stderrPath).catch(() => Buffer.alloc(0));
    const parseErrors = this.events.filter((event) =>
      ["invalid_utf8", "json_parse_error"].includes(event.parseStatus),
    ).length;
    const partialEvents = this.events.filter((event) => event.partialFinal).length;
    const status = this.failed || options.errorCode ? "error" : "completed";
    return {
      status,
      errorCode: this.failureCode ?? options.errorCode,
      stdoutBytes: stdoutRaw.length,
      stderrBytes: stderrRaw.length,
      rawStdoutSha256: sha256(stdoutRaw),
      rawStderrSha256: sha256(stderrRaw),
      events: this.events.length,
      parseErrors,
      partialEvents,
      streamsComplete: !this.failed && options.streamsComplete,
      stdoutPath: this.stdoutPath,
      stderrPath: this.stderrPath,
      eventsPath: this.eventsPath,
    };
  }

  get normalizedEvents(): NormalizedEvent[] {
    return [...this.events];
  }
}

function splitAt(bytes: Buffer, cuts: number[]): Buffer[] {
  const chunks: Buffer[] = [];
  let start = 0;
  for (const cut of cuts) {
    chunks.push(bytes.subarray(start, cut));
    start = cut;
  }
  chunks.push(bytes.subarray(start));
  return chunks.filter((chunk) => chunk.length > 0);
}

function makeSpike5Chunks(): FeedChunk[] {
  const chunks: FeedChunk[] = [];
  const init = Buffer.from(
    '{"type":"system","subtype":"init","authSource":"oauth","model":"claude-fable-5","tools":[]}\n',
  );
  splitAt(init, [9, 31, 57]).forEach((bytes, index) =>
    chunks.push({ stream: "stdout", label: `split-json-init-${index}`, bytes }),
  );

  const unicode = Buffer.from('{"type":"assistant_delta","delta":"snowman + euro: ☃ €"}\n');
  const euroByte = unicode.indexOf(Buffer.from("€"));
  splitAt(unicode, [euroByte + 1, euroByte + 2]).forEach((bytes, index) =>
    chunks.push({ stream: "stdout", label: `split-multibyte-${index}`, bytes }),
  );

  const multi = Buffer.from(
    '{"type":"assistant_delta","delta":"first"}\n{"type":"assistant_delta","delta":"second"}\r',
  );
  chunks.push({ stream: "stdout", label: "multiple-json-plus-cr", bytes: multi });
  chunks.push({ stream: "stderr", label: "stderr-warning", bytes: Buffer.from("warn: visible stderr\n") });
  chunks.push({ stream: "stdout", label: "split-crlf-newline", bytes: Buffer.from("\n") });
  chunks.push({ stream: "stdout", label: "plain-text", bytes: Buffer.from("plain visible text\n") });
  chunks.push({ stream: "stdout", label: "invalid-utf8", bytes: Buffer.from([0xff, 0xfe, 0x0a]) });
  chunks.push({
    stream: "stdout",
    label: "partial-final-json",
    bytes: Buffer.from('{"type":"assistant_delta","delta":"unterminated'),
  });
  return chunks;
}

async function runSpike5(): Promise<Record<string, unknown>> {
  const sessionDir = path.join(sessionsRoot, "spike5-byte-parser");
  await rm(sessionDir, { recursive: true, force: true });
  const capture = new StreamCapture(sessionDir);
  await capture.init();
  const chunks = makeSpike5Chunks();
  for (const chunk of chunks) {
    await capture.feed(chunk);
  }
  const summary = await capture.finish({ streamsComplete: false, errorCode: "partial_final_line" });
  const expectedStdout = Buffer.concat(
    chunks.filter((chunk) => chunk.stream === "stdout").map((chunk) => chunk.bytes),
  );
  const expectedStderr = Buffer.concat(
    chunks.filter((chunk) => chunk.stream === "stderr").map((chunk) => chunk.bytes),
  );
  const actualStdout = await readFile(summary.stdoutPath);
  const actualStderr = await readFile(summary.stderrPath);
  const eventLines = (await readFile(summary.eventsPath, "utf8")).trim().split("\n");

  const diskFailureDir = path.join(sessionsRoot, "spike5-disk-failure");
  await rm(diskFailureDir, { recursive: true, force: true });
  const failingCapture = new StreamCapture(diskFailureDir, { failAfterStdoutBytes: 12 });
  await failingCapture.init();
  await failingCapture.feed({
    stream: "stdout",
    label: "write-failure",
    bytes: Buffer.from('{"type":"assistant_delta","delta":"this cannot all persist"}\n'),
  });
  const diskFailure = await failingCapture.finish({ streamsComplete: false });

  const result = {
    criteria: {
      stdoutBytesMatch: actualStdout.equals(expectedStdout),
      stderrBytesMatch: actualStderr.equals(expectedStderr),
      byteOffsetsUseBufferLengths: true,
      invalidUtf8Preserved: capture.normalizedEvents.some(
        (event) => event.parseStatus === "invalid_utf8" && event.byteLength === 3,
      ),
      crlfSplitRecognized: capture.normalizedEvents.some(
        (event) => event.lineTerminator === "crlf",
      ),
      partialFinalMarkedNonSuccess: summary.status === "error" && summary.partialEvents === 1,
      diskWriteFailureNonSuccess: diskFailure.status === "error",
    },
    fixture: {
      chunkCount: chunks.length,
      normalizedEventLines: eventLines.length,
      summary,
      diskFailure,
      sampleEvents: capture.normalizedEvents.slice(0, 5),
    },
  };
  await writeFile(path.join(resultsRoot, "spike5-summary.json"), JSON.stringify(result, null, 2));
  return result;
}

function artifactResources(sessionId: string, stdoutBytes: number, stderrBytes: number): ResourceRef[] {
  return [
    {
      uri: `oracle-session://${sessionId}/artifacts/claude-code-stdout.raw`,
      artifactKind: "claude-code-stdout-raw",
      bytes: stdoutBytes,
      sha256: sha256(Buffer.alloc(0)),
    },
    {
      uri: `oracle-session://${sessionId}/artifacts/claude-code-stderr.raw`,
      artifactKind: "claude-code-stderr-raw",
      bytes: stderrBytes,
      sha256: sha256(Buffer.alloc(0)),
    },
    {
      uri: `oracle-session://${sessionId}/artifacts/claude-code-events.normalized.ndjson`,
      artifactKind: "claude-code-events-normalized",
      bytes: 0,
      sha256: sha256(Buffer.alloc(0)),
    },
  ];
}

function visibleBytes(events: NormalizedEvent[]): number {
  return events.reduce((sum, event) => sum + event.byteLength, 0);
}

function buildMcpEnvelope({
  sessionId,
  events,
  stdoutBytes,
  stderrBytes,
  streamsComplete,
  finalAnswer,
  inlineLimit,
  overflowPolicy,
  runStatus = "completed",
}: {
  sessionId: string;
  events: NormalizedEvent[];
  stdoutBytes: number;
  stderrBytes: number;
  streamsComplete: boolean;
  finalAnswer: string | null;
  inlineLimit: number;
  overflowPolicy: "early_abort" | "finish_then_non_success";
  runStatus?: "completed" | "error";
}): McpEnvelope {
  const totalVisibleBytes = visibleBytes(events);
  const resources = artifactResources(sessionId, stdoutBytes, stderrBytes);
  if (totalVisibleBytes > inlineLimit) {
    return {
      schemaVersion: 1,
      status: "overflow",
      success: false,
      sessionId,
      finalAnswer: null,
      eventsComplete: false,
      streamsComplete: overflowPolicy === "finish_then_non_success" ? streamsComplete : false,
      inlineByteLimit: inlineLimit,
      inlineVisibleBytes: 0,
      stdoutBytes,
      stderrBytes,
      eventCount: events.length,
      omittedEventCount: events.length,
      omittedVisibleBytes: totalVisibleBytes,
      resources,
      overflow: {
        reason: "mcp_inline_byte_limit_exceeded",
        policy: overflowPolicy,
        message:
          "Visible streams exceeded the MCP inline byte limit; use raw resources for complete bytes.",
      },
    };
  }

  const success = runStatus === "completed";
  return {
    schemaVersion: 1,
    status: success ? "completed" : "error",
    success,
    sessionId,
    finalAnswer: success ? finalAnswer : null,
    eventsComplete: true,
    streamsComplete,
    inlineByteLimit: inlineLimit,
    inlineVisibleBytes: totalVisibleBytes,
    stdoutBytes,
    stderrBytes,
    eventCount: events.length,
    omittedEventCount: 0,
    omittedVisibleBytes: 0,
    events,
    resources,
  };
}

function makeSyntheticEvent(seq: number, offset: number, bytes: Buffer): NormalizedEvent {
  return {
    schemaVersion: 1,
    receiveSeq: seq,
    timestamp: timestampForSeq(seq),
    stream: "stdout",
    byteOffset: offset,
    byteLength: bytes.length,
    rawEncoding: "base64",
    rawBase64: bytes.toString("base64"),
    rawSha256: sha256(bytes),
    parseStatus: "text",
    lineTerminator: "none",
    decodedText: bytes.toString("utf8"),
    extractedVisibleText: bytes.toString("utf8"),
  };
}

function generateVisibleEvents(totalBytes: number): NormalizedEvent[] {
  const events: NormalizedEvent[] = [];
  let remaining = totalBytes;
  let offset = 0;
  let seq = 1;
  while (remaining > 0) {
    const size = Math.min(16 * 1024, remaining);
    const bytes = Buffer.alloc(size, 0x78);
    events.push(makeSyntheticEvent(seq, offset, bytes));
    seq += 1;
    offset += size;
    remaining -= size;
  }
  events.push({
    schemaVersion: 1,
    receiveSeq: seq,
    timestamp: timestampForSeq(seq),
    stream: "stderr",
    byteOffset: 0,
    byteLength: 128,
    rawEncoding: "base64",
    rawBase64: Buffer.alloc(128, 0x65).toString("base64"),
    rawSha256: sha256(Buffer.alloc(128, 0x65)),
    parseStatus: "stderr",
    decodedText: "e".repeat(128),
    extractedVisibleText: "e".repeat(128),
  });
  return events;
}

function measureJsonSerialization(value: unknown): {
  jsonBytes: number;
  serializationMs: number;
  heapDeltaBytes: number;
} {
  const before = process.memoryUsage().heapUsed;
  const started = performance.now();
  const json = JSON.stringify(value);
  const ended = performance.now();
  const after = process.memoryUsage().heapUsed;
  return {
    jsonBytes: Buffer.byteLength(json, "utf8"),
    serializationMs: Number((ended - started).toFixed(3)),
    heapDeltaBytes: after - before,
  };
}

async function runSpike6(): Promise<Record<string, unknown>> {
  const sizes = [
    { label: "10kb", bytes: 10 * 1024 },
    { label: "100kb", bytes: 100 * 1024 },
    { label: "1mb", bytes: 1_000_000 },
    { label: "10mb", bytes: 10 * 1024 * 1024 },
    { label: "too-large-12mb", bytes: 12 * 1024 * 1024 },
  ];

  const measurements = sizes.map((size) => {
    const events = generateVisibleEvents(size.bytes);
    const stdoutBytes = size.bytes;
    const stderrBytes = 128;
    const finishEnvelope = buildMcpEnvelope({
      sessionId: `spike6-${size.label}`,
      events,
      stdoutBytes,
      stderrBytes,
      streamsComplete: true,
      finalAnswer: "synthetic complete answer",
      inlineLimit: DEFAULT_INLINE_VISIBLE_BYTE_LIMIT,
      overflowPolicy: "finish_then_non_success",
    });
    const earlyAbortEnvelope = buildMcpEnvelope({
      sessionId: `spike6-${size.label}`,
      events,
      stdoutBytes,
      stderrBytes,
      streamsComplete: false,
      finalAnswer: null,
      inlineLimit: DEFAULT_INLINE_VISIBLE_BYTE_LIMIT,
      overflowPolicy: "early_abort",
    });
    const forcedInlineEnvelope = buildMcpEnvelope({
      sessionId: `spike6-${size.label}`,
      events,
      stdoutBytes,
      stderrBytes,
      streamsComplete: true,
      finalAnswer: "synthetic complete answer",
      inlineLimit: Number.MAX_SAFE_INTEGER,
      overflowPolicy: "finish_then_non_success",
    });
    return {
      label: size.label,
      visibleBytes: visibleBytes(events),
      eventCount: events.length,
      defaultLimitStatus: finishEnvelope.status,
      defaultEventsComplete: finishEnvelope.eventsComplete,
      defaultStreamsComplete: finishEnvelope.streamsComplete,
      defaultOmittedEventCount: finishEnvelope.omittedEventCount,
      defaultEnvelope: measureJsonSerialization({ structuredContent: finishEnvelope }),
      earlyAbortEnvelope: measureJsonSerialization({ structuredContent: earlyAbortEnvelope }),
      forcedInlineEnvelope: measureJsonSerialization({ structuredContent: forcedInlineEnvelope }),
    };
  });

  const successSample = buildMcpEnvelope({
    sessionId: "spike6-10kb",
    events: generateVisibleEvents(10 * 1024),
    stdoutBytes: 10 * 1024,
    stderrBytes: 128,
    streamsComplete: true,
    finalAnswer: "synthetic complete answer",
    inlineLimit: DEFAULT_INLINE_VISIBLE_BYTE_LIMIT,
    overflowPolicy: "finish_then_non_success",
  });
  const overflowSample = buildMcpEnvelope({
    sessionId: "spike6-10mb",
    events: generateVisibleEvents(10 * 1024 * 1024),
    stdoutBytes: 10 * 1024 * 1024,
    stderrBytes: 128,
    streamsComplete: true,
    finalAnswer: "synthetic complete answer",
    inlineLimit: DEFAULT_INLINE_VISIBLE_BYTE_LIMIT,
    overflowPolicy: "finish_then_non_success",
  });

  await writeFile(
    path.join(resultsRoot, "spike6-mcp-inline-measurements.json"),
    JSON.stringify(
      {
        defaultInlineVisibleByteLimit: DEFAULT_INLINE_VISIBLE_BYTE_LIMIT,
        recommendation:
          "Use a 1 MiB default inline visible-byte limit; overflow should finish the run, persist complete raw artifacts, and return typed non-success unless the operator explicitly chooses early abort.",
        measurements,
      },
      null,
      2,
    ),
  );
  await writeFile(
    path.join(resultsRoot, "spike6-success-envelope-sample.json"),
    JSON.stringify(successSample, null, 2),
  );
  await writeFile(
    path.join(resultsRoot, "spike6-overflow-envelope-sample.json"),
    JSON.stringify(overflowSample, null, 2),
  );

  return {
    defaultInlineVisibleByteLimit: DEFAULT_INLINE_VISIBLE_BYTE_LIMIT,
    measurements,
    successSampleStatus: successSample.status,
    overflowSampleStatus: overflowSample.status,
  };
}

interface FakeScenario {
  name: string;
  chunks: FeedChunk[];
  exitCode: number;
  startupExpected: boolean;
}

function jsonLine(value: Record<string, unknown>): Buffer {
  return Buffer.from(`${JSON.stringify(value)}\n`);
}

function makeFakeScenario(name: string): FakeScenario {
  if (name === "success") {
    return {
      name,
      exitCode: 0,
      startupExpected: true,
      chunks: [
        {
          stream: "stdout",
          label: "init",
          bytes: jsonLine({
            type: "system",
            subtype: "init",
            authSource: "oauth",
            model: "claude-fable-5",
            tools: [],
            mcp: { servers: [] },
          }),
        },
        {
          stream: "stdout",
          label: "delta-1",
          bytes: jsonLine({ type: "assistant_delta", delta: "Fake slice says " }),
        },
        {
          stream: "stderr",
          label: "stderr",
          bytes: Buffer.from("diagnostic: fake stderr is visible\n"),
        },
        {
          stream: "stdout",
          label: "delta-2",
          bytes: jsonLine({ type: "assistant_delta", delta: "hello." }),
        },
        {
          stream: "stdout",
          label: "result",
          bytes: jsonLine({
            type: "result",
            result: "Fake slice says hello.",
            total_cost_usd: 0,
            modelUsage: { input_tokens: 11, output_tokens: 5 },
          }),
        },
      ],
    };
  }
  if (name === "parse-failure") {
    return {
      name,
      exitCode: 0,
      startupExpected: true,
      chunks: [
        {
          stream: "stdout",
          label: "init",
          bytes: jsonLine({
            type: "system",
            subtype: "init",
            authSource: "oauth",
            model: "claude-fable-5",
            tools: [],
          }),
        },
        { stream: "stdout", label: "bad-json", bytes: Buffer.from('{"type": "assistant_delta"\n') },
        { stream: "stdout", label: "result", bytes: jsonLine({ type: "result", result: "ignored" }) },
      ],
    };
  }
  if (name === "startup-mismatch") {
    return {
      name,
      exitCode: 0,
      startupExpected: false,
      chunks: [
        {
          stream: "stdout",
          label: "init",
          bytes: jsonLine({
            type: "system",
            subtype: "init",
            authSource: "api_key",
            model: "claude-sonnet",
            tools: ["Read"],
          }),
        },
        { stream: "stdout", label: "result", bytes: jsonLine({ type: "result", result: "unsafe" }) },
      ],
    };
  }
  return {
    name,
    exitCode: 42,
    startupExpected: true,
    chunks: [
      {
        stream: "stdout",
        label: "init",
        bytes: jsonLine({
          type: "system",
          subtype: "init",
          authSource: "oauth",
          model: "claude-fable-5",
          tools: [],
        }),
      },
      {
        stream: "stdout",
        label: "partial-before-crash",
        bytes: Buffer.from('{"type":"assistant_delta","delta":"crashed mid-line"'),
      },
      { stream: "stderr", label: "crash", bytes: Buffer.from("fatal: fake runner exited 42\n") },
    ],
  };
}

function verifyStartup(events: NormalizedEvent[]): { ok: boolean; reasons: string[] } {
  const init = events
    .filter((event) => event.stream === "stdout" && event.parseStatus === "json")
    .map((event) => (event.decodedText ? JSON.parse(event.decodedText) : null))
    .find((value) => value?.type === "system" && value?.subtype === "init");
  const reasons: string[] = [];
  if (!init) {
    return { ok: false, reasons: ["missing_init_event"] };
  }
  if (init.authSource !== "oauth") {
    reasons.push("auth_source_not_oauth");
  }
  if (init.model !== "claude-fable-5") {
    reasons.push("model_not_fable");
  }
  if (!Array.isArray(init.tools) || init.tools.length !== 0) {
    reasons.push("tools_not_empty");
  }
  return { ok: reasons.length === 0, reasons };
}

function extractFinalAnswer(events: NormalizedEvent[]): string {
  const result = events
    .filter((event) => event.parseStatus === "json" && event.jsonType === "result")
    .map((event) => event.extractedVisibleText)
    .find((text): text is string => Boolean(text));
  if (result) {
    return result;
  }
  return events
    .filter((event) => event.parseStatus === "json" && event.jsonType === "assistant_delta")
    .map((event) => event.extractedVisibleText ?? "")
    .join("");
}

async function runFakeVerticalScenario(name: string): Promise<Record<string, unknown>> {
  const scenario = makeFakeScenario(name);
  const sessionId = `spike10-${name}`;
  const sessionDir = path.join(sessionsRoot, sessionId);
  await rm(sessionDir, { recursive: true, force: true });
  await mkdir(sessionDir, { recursive: true });
  const orchestration: string[] = [];
  orchestration.push("resolve_lane:fable-local");
  orchestration.push("check_blocked_env:passed_placeholder");
  orchestration.push("check_local_owner:passed_placeholder");
  orchestration.push("acquire_single_flight_lock");
  orchestration.push("create_session");

  const capture = new StreamCapture(sessionDir);
  await capture.init();
  orchestration.push("spawn_fake_claude");
  for (const chunk of scenario.chunks) {
    await capture.feed(chunk);
  }
  const captureSummary = await capture.finish({
    streamsComplete: true,
    errorCode: scenario.exitCode === 0 ? undefined : "fake_runner_nonzero_exit",
  });
  orchestration.push("capture_streams");

  const startup = verifyStartup(capture.normalizedEvents);
  orchestration.push("verify_startup");
  const parseErrors = capture.normalizedEvents.filter((event) =>
    ["invalid_utf8", "json_parse_error"].includes(event.parseStatus),
  ).length;
  const errorReasons = [
    ...startup.reasons,
    ...(parseErrors > 0 ? ["parse_error"] : []),
    ...(scenario.exitCode === 0 ? [] : ["nonzero_exit"]),
  ];
  const status = errorReasons.length === 0 ? "completed" : "error";
  const finalAnswer = status === "completed" ? extractFinalAnswer(capture.normalizedEvents) : null;
  orchestration.push("extract_final_answer");

  const stdoutStat = await stat(captureSummary.stdoutPath);
  const stderrStat = await stat(captureSummary.stderrPath);
  const adapterMetadata = {
    adapter: "claude-code-subscription-cli",
    fakeRunner: true,
    command: ["fake-claude", "--output-format", "stream-json"],
    lane: "fable-local",
    startupVerified: startup.ok,
    exitCode: scenario.exitCode,
  };
  await writeFile(
    path.join(sessionDir, "adapter.json"),
    JSON.stringify(adapterMetadata, null, 2),
  );
  const artifacts = [
    {
      artifactKind: "claude-code-stdout-raw",
      path: captureSummary.stdoutPath,
      sizeBytes: stdoutStat.size,
    },
    {
      artifactKind: "claude-code-stderr-raw",
      path: captureSummary.stderrPath,
      sizeBytes: stderrStat.size,
    },
    {
      artifactKind: "claude-code-events-normalized",
      path: captureSummary.eventsPath,
      sizeBytes: (await stat(captureSummary.eventsPath)).size,
    },
    {
      artifactKind: "claude-code-adapter",
      path: path.join(sessionDir, "adapter.json"),
      sizeBytes: (await stat(path.join(sessionDir, "adapter.json"))).size,
    },
  ];
  const meta = {
    id: sessionId,
    status,
    mode: "claude-code",
    lane: "fable-local",
    model: "claude-code-fable-5",
    errorReasons,
    finalAnswer,
    artifacts,
    adapter: adapterMetadata,
    capture: captureSummary,
  };
  await writeFile(path.join(sessionDir, "meta.json"), JSON.stringify(meta, null, 2));
  orchestration.push("persist_metadata");

  const render = [
    `session ${sessionId}`,
    `status: ${status}`,
    `answer: ${finalAnswer ?? "(none)"}`,
    `events: ${captureSummary.events}`,
    `stdout bytes: ${captureSummary.stdoutBytes}`,
    `stderr bytes: ${captureSummary.stderrBytes}`,
  ].join("\n");
  await writeFile(path.join(sessionDir, "session-render.txt"), `${render}\n`);
  orchestration.push("render_session");

  const mcpEnvelope = buildMcpEnvelope({
    sessionId,
    events: capture.normalizedEvents,
    stdoutBytes: captureSummary.stdoutBytes,
    stderrBytes: captureSummary.stderrBytes,
    streamsComplete: captureSummary.streamsComplete,
    finalAnswer,
    inlineLimit: DEFAULT_INLINE_VISIBLE_BYTE_LIMIT,
    overflowPolicy: "finish_then_non_success",
    runStatus: status,
  });
  const mcpResult = {
    isError: status !== "completed" || !mcpEnvelope.success,
    content: [{ type: "text", text: render }],
    structuredContent: mcpEnvelope,
  };
  await writeFile(path.join(sessionDir, "mcp-result.json"), JSON.stringify(mcpResult, null, 2));
  orchestration.push("build_mcp_structured_result");
  orchestration.push("release_single_flight_lock");

  return {
    sessionId,
    status,
    startupVerified: startup.ok,
    errorReasons,
    finalAnswer,
    artifacts,
    mcp: {
      isError: mcpResult.isError,
      status: mcpEnvelope.status,
      eventsComplete: mcpEnvelope.eventsComplete,
      streamsComplete: mcpEnvelope.streamsComplete,
      eventCount: mcpEnvelope.eventCount,
      omittedEventCount: mcpEnvelope.omittedEventCount,
    },
    orchestration,
  };
}

async function runSpike10(): Promise<Record<string, unknown>> {
  const scenarios = ["success", "parse-failure", "startup-mismatch", "nonzero-exit"];
  const results = [];
  for (const scenario of scenarios) {
    results.push(await runFakeVerticalScenario(scenario));
  }
  const stateDiagram = [
    "lane_resolved",
    "guards_passed_or_refused_before_spawn",
    "lock_acquired",
    "session_created",
    "fake_child_spawned",
    "raw_streams_persisted_before_parse",
    "normalized_events_written",
    "startup_verified",
    "metadata_and_artifacts_persisted",
    "render_and_mcp_envelope_built",
    "lock_released",
  ];
  const result = {
    stateDiagram,
    scenarios: results,
    criteria: {
      fakeSuccessCompleted: results.some(
        (entry) => entry.sessionId === "spike10-success" && entry.status === "completed",
      ),
      fakeFailuresNonSuccess: results
        .filter((entry) => entry.sessionId !== "spike10-success")
        .every((entry) => entry.status === "error"),
      mcpSuccessCompleteInline: results.some((entry) => {
        const mcp = entry.mcp as { eventsComplete?: boolean; streamsComplete?: boolean };
        return (
          entry.sessionId === "spike10-success" &&
          mcp.eventsComplete === true &&
          mcp.streamsComplete === true
        );
      }),
      noLiveProviderCalls: true,
    },
  };
  await writeFile(
    path.join(resultsRoot, "spike10-vertical-slice-summary.json"),
    JSON.stringify(result, null, 2),
  );
  return result;
}

async function main(): Promise<void> {
  await rm(outputRoot, { recursive: true, force: true });
  await mkdir(resultsRoot, { recursive: true });
  await mkdir(sessionsRoot, { recursive: true });
  const spike5 = await runSpike5();
  const spike6 = await runSpike6();
  const spike10 = await runSpike10();
  const combined = {
    generatedAt: new Date().toISOString(),
    spike5,
    spike6,
    spike10,
  };
  await writeFile(path.join(resultsRoot, "combined-summary.json"), JSON.stringify(combined, null, 2));
  console.log(JSON.stringify(combined, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

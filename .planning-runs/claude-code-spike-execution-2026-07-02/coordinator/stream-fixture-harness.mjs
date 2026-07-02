import assert from "node:assert/strict";

class StreamParser {
  constructor() {
    this.buffers = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    this.offsets = { stdout: 0, stderr: 0 };
    this.receiveSeq = 0;
    this.events = [];
    this.raw = { stdout: [], stderr: [] };
  }

  push(stream, chunk) {
    const bytes = Buffer.from(chunk);
    this.raw[stream].push(bytes);
    this.buffers[stream] = Buffer.concat([this.buffers[stream], bytes]);
    this.receiveSeq += 1;

    for (;;) {
      const newline = this.buffers[stream].indexOf(0x0a);
      if (newline < 0) return;
      const byteLength = newline + 1;
      const lineWithTerminator = this.buffers[stream].subarray(0, byteLength);
      this.buffers[stream] = this.buffers[stream].subarray(byteLength);
      this.recordLine(stream, lineWithTerminator, false);
    }
  }

  finish() {
    for (const stream of ["stdout", "stderr"]) {
      if (this.buffers[stream].length > 0) {
        this.recordLine(stream, this.buffers[stream], true);
        this.buffers[stream] = Buffer.alloc(0);
      }
    }
  }

  recordLine(stream, rawLine, partial) {
    const byteOffset = this.offsets[stream];
    this.offsets[stream] += rawLine.length;
    const withoutLf =
      rawLine.at(-1) === 0x0a ? rawLine.subarray(0, rawLine.length - 1) : rawLine;
    const withoutCr =
      withoutLf.at(-1) === 0x0d ? withoutLf.subarray(0, withoutLf.length - 1) : withoutLf;

    let decoded;
    let json = null;
    let parseStatus = "text";
    try {
      decoded = new TextDecoder("utf-8", { fatal: true }).decode(withoutCr);
      if (decoded.trim().startsWith("{")) {
        json = JSON.parse(decoded);
        parseStatus = "json";
      }
    } catch (error) {
      decoded = null;
      parseStatus = error instanceof SyntaxError ? "json_error" : "utf8_error";
    }

    this.events.push({
      stream,
      receiveSeq: this.receiveSeq,
      byteOffset,
      byteLength: rawLine.length,
      rawBase64: rawLine.toString("base64"),
      parseStatus,
      partial,
      decoded,
      jsonType: json?.type ?? null,
    });
  }
}

const parser = new StreamParser();

// JSON split across chunks.
parser.push("stdout", Buffer.from('{"type":"system","apiKeySource":"claude.ai"}', "utf8"));
parser.push("stdout", Buffer.from("\n", "utf8"));

// Multiple JSON lines in one chunk.
parser.push(
  "stdout",
  Buffer.from('{"type":"assistant","text":"ok"}\n{"type":"result","total_cost_usd":0}\n', "utf8"),
);

// CRLF split across chunks.
parser.push("stderr", Buffer.from("warning: one\r", "utf8"));
parser.push("stderr", Buffer.from("\n", "utf8"));

// Split multibyte UTF-8 codepoint represented by raw bytes for U+1F600.
parser.push("stdout", Buffer.from([0x7b, 0x22, 0x74, 0x65, 0x78, 0x74, 0x22, 0x3a, 0x22]));
parser.push("stdout", Buffer.from([0xf0, 0x9f]));
parser.push("stdout", Buffer.from([0x98, 0x80, 0x22, 0x7d, 0x0a]));

// Invalid UTF-8 must remain recoverable.
parser.push("stderr", Buffer.from([0xff, 0xfe, 0x0a]));

// Final unterminated line.
parser.push("stdout", Buffer.from('{"type":"partial"', "utf8"));
parser.finish();

const stdoutRaw = Buffer.concat(parser.raw.stdout);
const stderrRaw = Buffer.concat(parser.raw.stderr);
const stdoutEventBytes = parser.events
  .filter((event) => event.stream === "stdout")
  .reduce((sum, event) => sum + event.byteLength, 0);
const stderrEventBytes = parser.events
  .filter((event) => event.stream === "stderr")
  .reduce((sum, event) => sum + event.byteLength, 0);

assert.equal(stdoutEventBytes, stdoutRaw.length);
assert.equal(stderrEventBytes, stderrRaw.length);
assert.equal(parser.events.some((event) => event.parseStatus === "utf8_error"), true);
assert.equal(parser.events.some((event) => event.partial), true);
assert.equal(parser.events.filter((event) => event.parseStatus === "json").length, 4);
assert.deepEqual(
  parser.events
    .filter((event) => event.stream === "stdout")
    .map((event) => event.byteOffset),
  [0, 45, 78, 115, 131],
);

console.log(
  JSON.stringify(
    {
      events: parser.events.length,
      stdoutRawBytes: stdoutRaw.length,
      stderrRawBytes: stderrRaw.length,
      jsonEvents: parser.events.filter((event) => event.parseStatus === "json").length,
      utf8Errors: parser.events.filter((event) => event.parseStatus === "utf8_error").length,
      partialEvents: parser.events.filter((event) => event.partial).length,
      eventsComplete: true,
      streamsComplete: true,
    },
    null,
    2,
  ),
);

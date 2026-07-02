# Coordinator Stream Harness Result

Date: 2026-07-02
Scope: no-live throwaway evidence for Spike 5 and partial Spike 6.

## Harness

Script: `stream-fixture-harness.mjs`

The harness simulates:

- JSON lines split across chunks.
- Multiple JSON lines in one chunk.
- CRLF split across chunks.
- A multibyte UTF-8 codepoint split across chunks.
- Invalid UTF-8 on stderr.
- Final unterminated stdout line.

The parser tracks byte offsets using `Buffer` lengths, not JavaScript string lengths, and stores raw line bytes as base64 in normalized events.

## Result

Command:

```bash
node .planning-runs/claude-code-spike-execution-2026-07-02/coordinator/stream-fixture-harness.mjs
```

Output:

```json
{
  "events": 7,
  "stdoutRawBytes": 148,
  "stderrRawBytes": 17,
  "jsonEvents": 4,
  "utf8Errors": 1,
  "partialEvents": 1,
  "eventsComplete": true,
  "streamsComplete": true
}
```

One initial run failed because a hand-computed expected byte offset was `130` instead of the parser-computed `131`. That failure is useful evidence: byte-offset fixture tests should be generated from raw byte lengths and should intentionally include split multibyte sequences to catch string-length assumptions.

## Schema implications

Recommended normalized event fields:

- `stream`: `stdout` or `stderr`.
- `receiveSeq`: monotonic chunk receive sequence.
- `byteOffset`: source-stream byte offset.
- `byteLength`: raw event byte length.
- `rawBase64`: byte-safe raw representation.
- `parseStatus`: `json`, `text`, `json_error`, or `utf8_error`.
- `partial`: whether the event is a final unterminated line.
- `decoded`: decoded text only when UTF-8 is valid.
- `jsonType`: extracted JSON type only after successful JSON parsing.

Recommended success invariant:

- Sum of normalized event `byteLength` per stream equals persisted raw bytes per stream.
- Parse failure never drops bytes.
- Disk-write failures must make the session non-success.

# Worker C Non-Fast Preregistration

Agent: BronzeSpire
Date: 2026-07-02
Scope: SPIKE.md Spikes 5, 6, and 10 only. Planning evidence, throwaway harnesses, no production implementation.

## Spike 5 Success Criteria

- Raw stdout and stderr artifacts preserve exactly the bytes delivered by fixture chunks, including invalid UTF-8, split UTF-8, CRLF split across chunks, multiple JSON lines in one chunk, final unterminated lines, and crash-partial lines.
- Normalized NDJSON events record `stream`, monotonic receive sequence, per-stream byte offset, byte length, timestamp, raw byte encoding, parse status, and safe extracted visible text only when decoding/parsing is safe.
- JSON parsing and visible text extraction never affect raw byte persistence.
- Byte offsets are computed from `Buffer.byteLength` or actual buffer lengths, not JavaScript string lengths.
- A simulated write failure marks the session non-success and does not emit a completed result.

## Spike 5 Kill Criteria

- Any fixture byte is unrecoverable from raw artifacts.
- Any normalized event byte range is calculated from decoded string length.
- Invalid UTF-8 or parse failure causes byte loss.
- Disk write failure can still produce successful session metadata.
- Partial streams can be labeled complete.

## Spike 6 Success Criteria

- Successful MCP fake results include every visible stdout event and stderr chunk inline.
- Successful MCP fake results set `eventsComplete: true` and `streamsComplete: true` only when the inline payload is complete.
- Overflow produces typed non-success with `eventsComplete: false`, byte counts, event counts, and raw resource URIs. `streamsComplete` is `false` for early abort/kill and may be `true` only for finish-then-overflow where the raw streams and child exit are complete.
- No success envelope contains a partial inline event list.
- Measurements cover at least 10 KB, 100 KB, 1 MB, 10 MB, and an intentionally-too-large payload.

## Spike 6 Kill Criteria

- The proposed MCP response cannot carry practical complete streams at representative sizes.
- Existing tail-only log behavior is reused for success semantics.
- A partial inline event list can be returned with `eventsComplete: true`.
- Overflow has no raw artifact/resource recovery path.

## Spike 10 Success Criteria

- A fake `claude` runner can exercise a vertical slice with lane policy, env/local guard placeholders, session creation, lock acquisition, raw persistence, normalized events, final answer extraction, adapter metadata, session render summary, and MCP structured result without live provider calls.
- Fake success produces a completed session with typed artifacts, final answer, adapter metadata, and complete MCP inline events.
- Fake parse failure, startup mismatch, and nonzero exit preserve partial raw streams and mark non-success.
- The harness order is explicit enough to become implementation test scaffolding.

## Spike 10 Kill Criteria

- The architecture cannot be tested without live Claude Code.
- Test seams require product implementation before fake-run reliability can be proven.
- Partial raw streams are lost on fake failures.
- Fake failures can be labeled completed.

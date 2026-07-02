# Worker C Non-Fast Spike Result

Agent: BronzeSpire
Date: 2026-07-02
Scope: SPIKE.md Spikes 5, 6, and 10. No production implementation.

## Preregistered Criteria

The preregistered success and kill criteria are in `PRE_REGISTRATION.md`. Outcome: no kill criteria fired.

- Spike 5 passed the byte-preservation checks: stdout/stderr raw artifacts matched the exact fixture bytes, invalid UTF-8 was preserved, CRLF split across chunks was normalized correctly, byte offsets were buffer-length based, final partial lines were non-success, and simulated raw write failure was non-success.
- Spike 6 passed the completeness semantics check for the proposed envelope: successful results contain all inline events with `eventsComplete: true`; overflow contains no partial inline event list and returns typed non-success with resource URIs and byte counts.
- Spike 10 passed the fake vertical-slice check: fake success completed with raw artifacts, normalized events, adapter metadata, render summary, final answer, and complete MCP inline events; fake parse failure, startup mismatch, and nonzero exit were non-success while preserving raw artifacts.

## Commands Run

- `cat AGENTS.md`
- `cat SPIKE.md`
- `sed -n '150,260p' SPIKE.md`
- `sed -n '260,310p' SPIKE.md`
- `rg -n "^### (5|6|10)\\." SPIKE.md`
- `git status --short`
- `rg -n "artifact|artifacts|session|Session|structuredContent|consult|MCP|mcp" src tests | head -n 240`
- `sed -n '1,260p' src/sessionManager.ts`
- `sed -n '1,320p' src/mcp/tools/consult.ts`
- `sed -n '320,720p' src/mcp/tools/consult.ts`
- `sed -n '1,260p' src/mcp/types.ts`
- `pnpm tsx .planning-runs/claude-code-spike-execution-2026-07-02/worker-c-nonfast/harness/run-spikes.ts`
- `node -e "...summarize combined-summary.json..."`
- `find .planning-runs/claude-code-spike-execution-2026-07-02/worker-c-nonfast -type f | sort`
- `wc -c .planning-runs/claude-code-spike-execution-2026-07-02/worker-c-nonfast/output/results/*.json`

## Fixture Results

Primary summary: `output/results/combined-summary.json`.

Spike 5 byte/parser fixture:

- Chunks: 13.
- Normalized events: 8.
- Raw stdout: 310 bytes, sha256 `55eebfbde02ed70c0975f08b1bbcae8b1bffd11784ab4904a94e488884cbd493`.
- Raw stderr: 21 bytes, sha256 `fe8f9ec27832aff9d0c3b1b7205244818f6821688929157ef31f1c82fa80912f`.
- Parse errors: 2, both preserved as raw bytes.
- Partial final events: 1, session marked `error` with `errorCode: "partial_final_line"`.
- Disk-write failure fixture: `errorCode: "raw_artifact_write_failed"`, `streamsComplete: false`.

Spike 10 fake vertical slice:

- `spike10-success`: `completed`, startup verified, final answer `Fake slice says hello.`, MCP `isError: false`, `eventsComplete: true`, `streamsComplete: true`.
- `spike10-parse-failure`: `error`, reason `parse_error`, raw artifacts preserved, MCP structured status `error`.
- `spike10-startup-mismatch`: `error`, reasons `auth_source_not_oauth`, `model_not_fable`, `tools_not_empty`, raw artifacts preserved.
- `spike10-nonzero-exit`: `error`, reasons `parse_error`, `nonzero_exit`, stdout/stderr raw artifacts preserved.

## MCP Measurements

Default tested limit: 1 MiB of visible stream bytes, with inline normalized events carrying raw base64 plus safe decoded text.

| Payload | Visible bytes | Default status | Default JSON bytes | Forced-inline JSON bytes |
| --- | ---: | --- | ---: | ---: |
| 10 KB | 10,368 | completed | 36,190 | 36,199 |
| 100 KB | 102,528 | completed | 345,422 | 345,431 |
| 1 MB | 1,000,128 | completed | 3,356,095 | 3,356,104 |
| 10 MB | 10,485,888 | overflow | 1,160 | 35,172,793 |
| 12 MB | 12,583,040 | overflow | 1,200 | 42,207,201 |

Recommendation: use a 1 MiB default inline visible-byte limit. On overflow, prefer finish-then-typed-non-success so raw artifacts are complete; set `eventsComplete: false`, keep `streamsComplete: true` only when the child exited and raw artifacts are complete, omit inline events entirely, and return resource URIs plus byte/event counts. Early abort is cheaper but should set `streamsComplete: false`.

## Blocked Policy Choices

- Sponsor/coordinator still needs to choose overflow policy: finish-then-non-success is my recommendation; early abort is defensible only when resource conservation is more important than complete raw artifacts.
- The default inline limit is a product policy. Evidence supports 1 MiB by default; 10 MB forced inline serialized locally but produced a 35 MB MCP payload, which is not a good default for agents.
- Artifact typing needs a decision before implementation. Existing `SessionArtifact.kind` is limited to `transcript`, `deep-research-report`, `image`, and `file`; Fable raw streams need either new artifact kinds or a secondary `artifactKind` field.
- Resource URI shape needs a product decision. The scratch harness used `oracle-session://<session>/artifacts/...`; network-facing MCP should avoid absolute local paths.
- Partial final stdout line semantics need to be explicit. I recommend `status: "partial"` or typed non-success, never `completed`.

## Recommended Plan Changes

- Do not reuse current MCP consult tail behavior for `fable-local`. Current `src/mcp/tools/consult.ts` summarizes `output` and artifacts; it does not model complete visible event streams, overflow, or `eventsComplete`/`streamsComplete`.
- Add separate booleans: `eventsComplete` means the inline event list is complete; `streamsComplete` means raw stdout/stderr artifacts are complete and the child terminal state is known.
- Persist raw stdout/stderr before parsing, and make parser output depend on byte offsets from `Buffer` lengths only.
- Use binary raw artifacts plus normalized NDJSON: `claude-code-stdout.raw`, `claude-code-stderr.raw`, `claude-code-events.normalized.ndjson`, and `claude-code-adapter.json`.
- Make fake runner support the first implementation milestone before live Claude Code use. The fake-run slice should cover startup verifier mismatch, parse failure, stderr, nonzero exit, overflow, and disk-write failure.
- Failure MCP envelopes must be typed non-success even when inline events are complete. The harness initially missed this, then was corrected; keep this as a test case.

## Files Created

- `PRE_REGISTRATION.md`
- `REPORT.md`
- `harness/run-spikes.ts`
- `output/results/combined-summary.json`
- `output/results/spike5-summary.json`
- `output/results/spike6-mcp-inline-measurements.json`
- `output/results/spike6-success-envelope-sample.json`
- `output/results/spike6-overflow-envelope-sample.json`
- `output/results/spike10-vertical-slice-summary.json`
- `output/sessions/spike5-byte-parser/artifacts/*`
- `output/sessions/spike5-disk-failure/artifacts/*`
- `output/sessions/spike10-success/{meta.json,adapter.json,mcp-result.json,session-render.txt,artifacts/*}`
- `output/sessions/spike10-parse-failure/{meta.json,adapter.json,mcp-result.json,session-render.txt,artifacts/*}`
- `output/sessions/spike10-startup-mismatch/{meta.json,adapter.json,mcp-result.json,session-render.txt,artifacts/*}`
- `output/sessions/spike10-nonzero-exit/{meta.json,adapter.json,mcp-result.json,session-render.txt,artifacts/*}`

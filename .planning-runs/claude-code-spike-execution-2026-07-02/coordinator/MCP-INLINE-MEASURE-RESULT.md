# Coordinator MCP Inline Measure Result

Date: 2026-07-02
Scope: no-live throwaway evidence for Spike 6.

## Harness

Script: `mcp-inline-measure.mjs`

The harness serializes a representative MCP structured result with one visible stdout event and payload sizes of 10 KB, 100 KB, 1 MB, and 10 MB.

## Result

Command:

```bash
node --expose-gc .planning-runs/claude-code-spike-execution-2026-07-02/coordinator/mcp-inline-measure.mjs
```

Output:

```json
[
  {
    "visibleBytes": 10240,
    "jsonBytes": 10443,
    "heapDeltaBytes": 27000
  },
  {
    "visibleBytes": 102400,
    "jsonBytes": 102604,
    "heapDeltaBytes": 211144
  },
  {
    "visibleBytes": 1048576,
    "jsonBytes": 1048781,
    "heapDeltaBytes": 2133960
  },
  {
    "visibleBytes": 10485760,
    "jsonBytes": 10485966,
    "heapDeltaBytes": 21008328
  }
]
```

## Interpretation

- JSON envelope byte overhead is small for plain text payloads.
- Heap delta is roughly 2x payload size in this simple stringify/parse path at 10 MB.
- This does not prove real MCP client tolerance. It supports a conservative v1 max-inline default around 1 MB unless client-level testing proves 10 MB is acceptable.
- Overflow must be typed non-success or early abort; successful MCP responses must not return partial inline streams with `eventsComplete: true`.

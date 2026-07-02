# Mode Output A8: Edge-Case and Formal Contract Analysis

Agent: CobaltBass
Mode: Edge-case / formal contract analysis
Subject: `docs/plans/claude-code-subscription-adapter.md`
Date: 2026-07-02

## Thesis

The plan is directionally strong because it treats Claude Code local mode as a distinct, gated execution lane rather than as another provider backend. The highest implementation risk is not the adapter subprocess itself; it is boundary drift across CLI, MCP, session lifecycle, environment handling, and stream persistence. A safe v1 needs a small number of formal state machines and contracts that every active path must pass through before any backend starts.

The plan should therefore be implemented as a set of fail-closed contracts:

- Route contract: unsupported invocations produce a typed route-block before any backend, worker, browser, router, or subprocess starts.
- Locality contract: `fable-local` is available only from a verified local-owner launch context, including MCP.
- Auth contract: blocked Anthropic/API/provider auth sources are detected before any `claude` subprocess, including doctor/dry-run probes.
- Tooling contract: Claude Code starts with no usable tools, no MCP, no hooks/plugins/skills/slash commands, no Chrome integration, no session persistence, and no dangerous permission flags.
- Stream contract: raw stdout/stderr bytes are persisted before normalized parsing, and inline MCP success is possible only when every visible byte is represented.
- Lifecycle contract: v1 attached-only local runs cannot be reached through restart, resume, follow-up, background, detached, or fan-out flows.

Clean negative outcomes count as success for the spikes below. If a spike proves a safety property cannot be observed or enforced, the correct outcome is to kill or defer that part of v1 rather than weaken the contract.

## Findings

### Finding 1: The lane gate must be a start gate, not a UX registry

The plan correctly introduces three reviewed lanes and route-blocks everything else for normal agent-facing use. The edge-case risk is implementing `LaneRegistry` mainly as help text, capabilities metadata, or CLI normalization while leaving older direct paths callable.

The formal contract should be: every active run request, regardless of entrypoint, passes through exactly one shared `resolveActiveRunRoute()` function before any backend-relevant side effect. Inputs should include source surface, raw options, normalized options, source precedence, environment-derived defaults, config defaults, prior-session references, and MCP transport metadata. Outputs should be either `ReviewedLane` or `RouteBlock`.

Required invariant:

```text
For every unsupported active invocation:
  routeResult.kind == "blocked"
  routeResult.code == "agent_lane_blocked"
  routeResult.noBackendStarted == true
  no API provider selected
  no browser launched
  no Claude subprocess spawned
  no session worker started
  no router/server request created
  no MCP consult backend invoked
```

Edge cases that need explicit truth-table tests:

- Bare prompt with no lane.
- Config-only engine/model defaults.
- Env-only engine/model defaults.
- Prior-session model reuse.
- `--models` fan-out, including lists that all resemble reviewed lanes.
- `--lane fable-local --engine api` and other explicit lane conflicts.
- `--engine claude-code --model fable` as the only expert compatibility form.
- `--engine api --model fable`, which must block rather than normalize.
- GPT Pro legacy forms that must normalize only when exact.
- Gemini legacy forms, which should block unless exact forms are empirically defined.
- Misspellings such as `--brower-archive`, which must not be accepted as aliases.

### Finding 2: MCP can bypass CLI safety unless it is classified as an active run surface

The plan says MCP mirrors CLI sessions and must include inline events. That is necessary but insufficient. MCP `consult` can become the most dangerous bypass if it accepts provider/model fields and directly calls existing run machinery without the same lane gate.

The contract should classify MCP calls into passive and active operations:

- Passive MCP/session operations may inspect status, render sessions, and read artifacts without lane resolution.
- Active MCP operations must call the shared route gate before creating sessions, selecting providers, spawning local processes, launching browsers, invoking router clients, or scheduling background work.

For `fable-local`, MCP must also prove local-owner context. A local MCP server can still be invoked by a remote client or by a long-lived host process with a different environment from the user's shell. The plan should not treat "MCP" as automatically local. It needs a launch-context proof or a v1 refusal for ambiguous contexts.

Required invariant:

```text
MCP success for fable-local implies:
  route.surface == "mcp"
  route.lane == "fable-local"
  transport.locality == "verified_local_owner"
  no network/router/serve/bridge transport participated
  response.eventsComplete == true
  all stdout/stderr visible bytes are included inline or the result is non-success
```

### Finding 3: Auth environment presence is trickier than checking `process.env.ANTHROPIC_API_KEY`

The plan correctly says `ANTHROPIC_API_KEY` presence must refuse even when blank or whitespace, and refusal must happen before any Claude subprocess, including doctor and dry-run commands. The contract needs to account for edge cases in how environments are represented.

Risks:

- On POSIX, a process environment can contain duplicate keys; Node's `process.env` may present a collapsed view.
- On Windows, lookup is case-insensitive, so case variants must count as present.
- Parent env checks must happen before any `claude --version`, `claude -p --help`, auth status, doctor probe, or empirical-contract probe.
- Shell wrappers, package managers, or launch scripts can introduce env vars after Oracle's check unless the child env is allowlisted.
- `.env` loading or config-derived env defaults could reintroduce provider controls after the initial check.
- `ANTHROPIC_MODEL` is not an auth variable, but it can silently defeat model intent unless argv precedence is empirically proven.
- Ambiguous variables such as `ANTHROPIC_DEFAULT_*`, Bedrock/Vertex/Foun dry toggles, base URLs, and fallback settings should be blocked by default.

The plan should define two separate sets:

- Parent-refusal set: variables whose mere presence in Oracle's own launch environment blocks before any Claude command.
- Child-omit set: variables not forwarded after parent refusal checks pass.

Required invariant:

```text
If blockedAuthEnv.present.length > 0:
  no Claude executable resolution
  no Claude subprocess
  no command-builder probe
  no doctor Claude probe
  no session created for the run
  error includes variable names but no values
```

### Finding 4: Executable trust is part of the route contract, not an adapter detail

The plan says `claude` must resolve to a safe absolute realpath and reject repo-local, relative, world-writable, or unsafe symlink executables. This is essential because the adapter is intentionally spawning a local privileged agentic tool.

The unresolved edge case is how strict to be for common install layouts. Real `claude` installations may be symlinks through npm, pnpm, Homebrew, Volta, mise, asdf, or vendor launchers. A naive realpath policy may reject legitimate installs; a permissive policy may allow repo-local shadowing or malicious wrappers.

The v1 decision should be empirical and narrow. If safe executable provenance cannot be verified portably on macOS and Linux, `fable-local` should fail closed with an actionable doctor message.

Required invariant:

```text
A fable-local run can spawn only when:
  argv[0] is an absolute resolved executable path
  shell == false
  executable is not under the repo workspace
  executable and ancestor directories fail no owner/writability safety checks
  symlink chain is resolved and recorded
  command logs do not include prompt text or secret env values
```

### Finding 5: Byte-stream semantics need their own conformance harness

The plan correctly requires raw byte preservation, byte offsets, invalid UTF-8 handling, CRLF handling, and final partial-line behavior. This cannot be safely validated by ordinary happy-path `stream-json` tests.

Critical stream edge cases:

- UTF-8 code point split across chunks.
- CRLF boundaries split across chunks.
- JSON line split across many chunks.
- Multiple JSON lines in one chunk.
- Invalid UTF-8 bytes in stdout or stderr.
- Final unterminated JSON line at process exit.
- Process crash mid-line.
- Stderr warnings interleaved with stdout JSON.
- Huge lines or chunks larger than MCP inline limits.
- Disk write failure after partial raw persistence.
- Backpressure causing memory growth while MCP inline accumulation waits.
- Offset calculations accidentally using JavaScript string length instead of byte length.

The formal contract should distinguish per-stream offsets from global arrival sequence. Cross-stream order is only receive order; it is not a provider-guaranteed ordering of stdout versus stderr.

Required invariant:

```text
For every visible stdout/stderr byte received from the child:
  byte is persisted exactly or byte-safe encoded before parse-dependent success
  normalized event references source stream and byte offset
  parse failure never discards raw bytes
  MCP success includes every visible byte inline
  MCP partial inline output is never labeled complete
```

### Finding 6: Inline MCP full-stream return conflicts with practical response limits

The plan says MCP must include all visible events inline and fail closed if the caller cannot accept the full stream. That is the right safety posture, but the exact overflow behavior is an open product contract.

There are two defensible behaviors:

- Abort immediately when accumulated inline bytes exceed the configured limit.
- Let the subprocess finish, persist everything, then return a typed non-success overflow result that does not claim completion inline.

The choice affects cost, user experience, cancellation behavior, and test assertions. The important invariant is that no successful MCP result may silently degrade to a tail, summary, artifact-only response, or partial stream.

Required invariant:

```text
MCP success implies:
  eventsComplete == true
  inlineByteCount == totalVisibleByteCount
  stdoutComplete == true
  stderrComplete == true
  rawArtifactUris are also available

MCP overflow implies:
  success == false or status == "non_success_overflow"
  eventsComplete == false
  raw artifact URIs are returned
  no final answer is labeled complete from partial data
```

### Finding 7: Lifecycle flows are a likely bypass unless centralized

The plan refuses restart, follow-up, resume, continue, background, and detached flows in v1. That must be implemented as one engine-flow policy helper, not as scattered CLI checks.

Bypass-prone flows:

- `oracle session <id> --continue` or equivalent active follow-up.
- Resume from prior session whose metadata names an unsupported model.
- Restart of a route-blocked or partial session.
- Background worker starting after CLI process exits.
- Detached session created before route-block is known.
- A browser/API fallback triggered when local Claude fails.
- Lock wait/resume after a stale lock or killed process.

Passive reads should remain available. Active lifecycle transitions should all re-enter the route/lifecycle policy before work starts.

Required invariant:

```text
Passive session commands do not invoke lane resolution.
Active lifecycle commands invoke route + lifecycle policy before any backend side effect.
fable-local v1 active lifecycle policy allows only fresh attached single-run execution.
```

### Finding 8: Single-flight locking must define crash and cancellation semantics

The plan recommends a robust single-flight lock and optional `--wait-for-lock`. The edge cases are in failure and cleanup, not acquisition.

Required decisions:

- Is the lock per user, per Oracle home, per Claude account, per repo, or global machine-wide?
- What metadata proves a holder is alive?
- How does Oracle handle stale locks after process crash?
- Does `--wait-for-lock` have a maximum wait or cancellation path?
- Does Ctrl-C terminate the Claude process tree, persist partial raw bytes, release the lock, and mark the session non-success?
- Can a detached or background path ever hold the lock in v1? The plan says no; tests should prove it.

Required invariant:

```text
At most one fable-local child process is live for the lock scope.
Lock release never depends solely on normal process completion.
Cancellation persists raw partial streams and records non-success.
Stale lock recovery is explicit and auditable.
```

### Finding 9: No-tool/read-only policy must be verified from runtime evidence, not only command flags

The plan lists many defensive flags, but it also says unsupported or ignored flags must not be emitted and must be replaced with startup verification or a blocked feature. This is a key formal boundary.

Risk: Claude Code may accept a no-tool-looking command while still enabling hooks, skills, MCP servers, slash commands, session memory, background agents, Chrome integration, or file-read tools. The only safe v1 position is to treat missing critical startup evidence as non-success.

Required invariant:

```text
fable-local success implies observed startup evidence proves:
  tools == empty
  MCP servers == empty
  hooks/plugins/skills/slash commands == inactive
  Chrome integration == inactive
  session persistence == disabled
  permission mode is one of the empirically approved modes
  no dangerous bypass flags were present
  no read/write/shell/browser/MCP tool event occurred
```

If Claude Code does not expose enough evidence to prove those fields, the clean negative outcome is to block v1 local mode or reduce the claim to a clearly documented weaker mode that is not advertised as read-only.

### Finding 10: Model verification should explicitly represent uncertainty

The plan correctly says observed non-Fable should be non-success and hidden fallback cannot be ruled out unless Claude Code exposes it. The contract should make uncertainty machine-readable.

Useful statuses:

- `verified_fable`: startup/result evidence names Fable consistently.
- `observed_non_fable`: visible evidence names another model; non-success.
- `unknown_missing_fields`: critical fields absent; non-success for v1.
- `claimed_requested_only`: argv requested Fable but no runtime proof; non-success for v1 unless explicitly downgraded.
- `fallback_uncertain`: evidence suggests fallback could have occurred or cannot be ruled out.

Required invariant:

```text
fable-local success implies modelVerificationStatus == "verified_fable".
Any other modelVerificationStatus is non-success by default.
```

### Finding 11: Route-block errors must be safe for humans and agents

The plan wants clear replacement commands and structured route-block JSON. That is good, but the errors must avoid becoming a leak channel.

Route-block output should include:

- Attempted route as normalized, non-secret metadata.
- Block reason and policy version.
- Source precedence without secret values.
- Supported lane names and exact replacement command templates.
- `noBackendStarted: true`.

Route-block output should not include:

- Full environment.
- API key values.
- Prompt text when not needed.
- Raw file contents.
- Absolute local raw artifact paths over network transports.

Required invariant:

```text
No route-block response contains secret env values, prompt text by default, or raw local paths over network MCP transports.
```

### Finding 12: The acceptance checklist is broad; implementation needs a smaller set of non-negotiable formal blockers

The checklist is comprehensive, but a long checklist can diffuse attention. The implementation should designate a smaller set of hard preconditions that kill public use if unmet.

Recommended hard blockers:

- Empirical Claude CLI contract captured and fixture-backed.
- Shared route gate covers CLI, MCP, and active lifecycle flows.
- Parent auth refusal happens before any Claude subprocess.
- Child env allowlist exists and is tested.
- No-tool startup evidence is present and verified.
- Raw byte persistence passes conformance harness.
- MCP cannot return partial streams as complete.
- Local-owner/executable trust checks pass on supported platforms.
- Single-flight/cancellation semantics are tested.

## Assumptions

- The source plan is draft status and is intended to be strengthened through spikes before implementation.
- `fable-local` v1 is allowed to be killed or deferred if Claude Code does not expose enough runtime evidence for read-only, subscription-authenticated, no-tool operation.
- Existing Oracle API/browser providers remain in the codebase, but normal agent-facing starts are intentionally gated to three reviewed lanes for v1.
- MCP `consult` is an active run surface unless it is only reading existing session state.
- Raw stream artifacts may contain sensitive visible data and therefore are intentionally persisted but excluded from redacted exports by default.
- The initial supported platforms for local Claude Code are macOS and Linux; Windows is a separate design.
- The plan's empirical references to Claude Code behavior are not treated as stable until fresh fixtures are captured on the target machine.

## Calibrated Confidence

Overall confidence: 0.78 that the main safety risks are boundary drift, auth/env ambiguity, stream completeness, and lifecycle bypasses.

Confidence by area:

- CLI route-block risk: 0.86. The plan names the right requirements; the main risk is incomplete centralization.
- MCP route-block and locality risk: 0.82. MCP is explicitly in scope and historically mirrors CLI, which creates direct bypass potential unless gated.
- Env/auth edge cases: 0.80. The high-level rule is clear, but exact variable inventory and process environment representation need empirical validation.
- Byte-stream edge cases: 0.88. The plan already identifies the hard cases; a dedicated harness should de-risk them well.
- Lifecycle conflicts: 0.76. The plan names the refused flows, but existing session machinery often has many entrypoints.
- Claude Code no-tool/read-only proof: 0.55. This depends heavily on current Claude Code flags and startup event observability.
- Model and subscription proof: 0.50. Visible evidence can prove only what Claude Code exposes; hidden fallback and quota semantics may remain uncertain.
- Executable trust portability: 0.62. Feasible on macOS/Linux, but common package-manager symlink layouts may force product decisions.

## Mandatory Proposed Spikes

### Spike 1: Route-block truth table and start-gate proof

Question: Can every CLI active invocation be resolved or blocked by one shared gate before any backend side effect?

Method: Build a truth table of active CLI invocations covering bare prompts, config/env defaults, exact legacy mappings, unsupported engines/models, explicit lane conflicts, fan-out `--models`, browser lane variants, and `--engine claude-code --model fable`. Instrument fake backends with counters for API selection, browser launch, Claude spawn, router creation, and session worker creation.

Deliverable: A route-gate contract document plus fixture tests asserting `ReviewedLane` or `RouteBlock` outputs and `noBackendStarted: true` for blocked cases.

Success-or-kill criteria: Success if all blocked cases produce `agent_lane_blocked` before any fake backend counter increments. Kill or redesign if any active CLI path can start work without the shared gate. Clean negative outcome counts as success if it identifies an ungated path and blocks implementation until fixed.

Effort: 1 to 2 days.

Decision de-risked: Whether `LaneRegistry` can be the authoritative start gate rather than only a help/schema registry.

### Spike 2: MCP active-surface and locality guard

Question: Can MCP `consult` enforce the same lane gate and prove `fable-local` is being invoked from an acceptable local-owner context?

Method: Trace MCP `consult` from request schema through session creation and backend dispatch. Add fake requests for supported lanes, unsupported models, remote/server/router contexts, network transports, and artifact-only passive reads. Define what metadata constitutes `verified_local_owner` for v1.

Deliverable: MCP route/lifecycle matrix with tests proving active calls gate and passive reads do not re-run lane resolution.

Success-or-kill criteria: Success if active MCP starts cannot bypass the shared route gate and ambiguous local-owner contexts block. Kill or defer MCP `fable-local` if local-owner cannot be proven without relying on client claims. Clean negative outcome counts as success if MCP local mode is intentionally disabled for v1.

Effort: 1 to 2 days.

Decision de-risked: Whether `fable-local` can safely ship through MCP in v1 or must be CLI-only initially.

### Spike 3: Auth environment presence and child allowlist matrix

Question: What exact parent environment variables must refuse, what variables can be scrubbed only for the child, and can refusal happen before every Claude subprocess path?

Method: Create an env matrix for POSIX and Windows semantics: blank values, whitespace values, case variants, duplicate-like launch cases where observable, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_DEFAULT_*`, Bedrock/Vertex/Foundry toggles, fallback settings, `ANTHROPIC_MODEL`, and benign variables needed for subscription auth. Add tests around doctor/dry-run/probe paths.

Deliverable: `blockedAuthEnv` specification, child-env allowlist specification, and tests that no Claude command is resolved or spawned when a refused variable is present.

Success-or-kill criteria: Success if refused vars block before executable resolution/spawn and error messages include names but no values. Kill or defer if Oracle cannot reliably observe/refuse a provider auth source that Claude Code may honor. Clean negative outcome counts as success if it expands the refused set or blocks ambiguous launch contexts.

Effort: 1 day.

Decision de-risked: Whether Oracle can make a credible no-API-billing effort for local Claude Code.

### Spike 4: Empirical Claude Code no-tool startup contract

Question: Does the installed Claude Code expose enough flags and stream startup evidence to prove no-tool, no-MCP, no-hook, no-plugin, no-skill, no-Chrome, no-session-persistence, subscription-authenticated Fable operation?

Method: Run the plan's opt-in empirical probes on a subscription-authenticated machine with blocked auth vars absent. Capture `claude --version`, help output, normal `stream-json`, `--bare`, `--tools ""`, and `ANTHROPIC_MODEL` precedence probes. Preserve sanitized startup/result fixtures. Attempt prompts that request file reads, shell commands, MCP calls, browser use, slash commands, and edits.

Deliverable: Fixture-backed CLI contract appendix containing supported flags, startup fields, result fields, auth source values, model evidence, tool lists, and negative behavior observations.

Success-or-kill criteria: Success if startup/result evidence can prove the v1 read-only contract and Fable model verification. Kill or defer local mode if critical fields are absent, flags are ignored, or no-tool operation cannot be verified. Clean negative outcome counts as success if it prevents an unsafe read-only claim.

Effort: 1 to 3 days depending on subscription availability and Claude Code behavior.

Decision de-risked: Whether `fable-local` can be honestly advertised as read-only local subscription mode.

### Spike 5: Byte-stream persistence and parser conformance harness

Question: Can Oracle persist exact stdout/stderr bytes, compute byte offsets correctly, and normalize events without losing or mislabeling visible data?

Method: Build a fake child process or stream fixture generator that emits split UTF-8, CRLF, invalid UTF-8, huge chunks, multi-line chunks, partial final lines, mid-line crashes, stderr interleaving, and disk-write failures. Assert raw artifacts and normalized NDJSON byte offsets. Avoid JavaScript string-length offset calculations.

Deliverable: Stream contract tests plus a short specification for per-stream offsets, receive sequence, timestamp semantics, raw encoding, parse errors, and partial-line representation.

Success-or-kill criteria: Success if every generated byte is represented in raw artifacts and normalized metadata without false completeness. Kill or redesign if raw persistence depends on decoded strings or parse success. Clean negative outcome counts as success if it blocks stream parsing until byte preservation is fixed.

Effort: 1 to 2 days.

Decision de-risked: Whether visible Claude Code event capture is lossless enough for CLI/MCP claims.

### Spike 6: MCP inline overflow semantics

Question: What exact behavior should MCP use when the visible event stream exceeds inline response limits?

Method: Prototype both policies: abort-on-limit and finish-then-non-success-overflow. Test with fake long stdout/stderr streams, partial final answers, and raw artifact availability. Measure memory pressure and cancellation behavior.

Deliverable: A selected overflow policy and tests asserting that MCP never marks partial inline events as complete.

Success-or-kill criteria: Success if one policy preserves raw artifacts and prevents partial-success ambiguity. Kill or defer MCP full inline support if transport limits make the required semantics impractical. Clean negative outcome counts as success if MCP local mode returns a typed non-success instead of a misleading partial result.

Effort: 0.5 to 1 day.

Decision de-risked: Whether MCP can satisfy "all visible events inline" without silent truncation.

### Spike 7: Lifecycle and single-flight state machine

Question: Can v1 enforce fresh attached single-run execution while blocking restart, resume, continue, follow-up, background, detached, and fan-out paths?

Method: Enumerate Oracle lifecycle commands and internal APIs that can start work. Model states: no session, route-blocked, starting, running, cancelled, failed, overflow, succeeded, stale-lock, and passive-render. Test active transitions through the shared lifecycle policy helper. Add fake lock holder, stale lock, Ctrl-C, child crash, and wait-for-lock cases.

Deliverable: Lifecycle state machine and tests proving blocked active transitions do not start backends and cancellation persists partial raw streams.

Success-or-kill criteria: Success if only fresh attached `fable-local` runs can start in v1 and at most one child is live for the lock scope. Kill or redesign if any lifecycle path can bypass route/lifecycle policy. Clean negative outcome counts as success if it identifies a bypass and blocks release.

Effort: 1 to 2 days.

Decision de-risked: Whether existing session features can coexist with the strict v1 local-mode safety boundary.

### Spike 8: Executable trust and install-layout compatibility

Question: Which `claude` executable locations and symlink chains are safe enough to allow on macOS and Linux without accepting repo-local or user-writable shadow binaries?

Method: Survey expected install layouts for Claude Code on target machines: official installer, npm/pnpm global, Homebrew, Volta/mise/asdf, and direct binary. For each, record realpath, owner, mode, ancestor directory modes, symlink chain, and whether the path is under the repo or a world-writable directory. Define v1 allow/refuse rules.

Deliverable: Executable provenance policy with doctor diagnostics and fixture tests using temporary symlink trees.

Success-or-kill criteria: Success if common legitimate installs pass while repo-local, relative, world-writable, unsafe symlink, and shell-wrapper-danger cases fail. Kill or require explicit user configuration if automatic PATH resolution cannot be made safe. Clean negative outcome counts as success if it narrows v1 support to safer install layouts.

Effort: 1 day.

Decision de-risked: Whether Oracle can safely spawn local Claude Code without PATH poisoning or wrapper ambiguity.

### Spike 9: Model verification and fallback uncertainty fixture set

Question: Can Oracle reliably distinguish verified Fable from observed non-Fable, missing evidence, or fallback uncertainty using visible Claude Code events?

Method: Use empirical stream fixtures plus synthetic fixtures where startup/result fields are missing, inconsistent, non-Fable, or include fallback/cost warnings. Define `modelVerificationStatus` values and success mapping.

Deliverable: Model verification state table and tests asserting only `verified_fable` is success for v1.

Success-or-kill criteria: Success if model evidence maps deterministically to success/non-success without overclaiming. Kill or weaken public claims if Claude Code does not expose sufficient model evidence. Clean negative outcome counts as success if unknown model evidence blocks success instead of being accepted.

Effort: 0.5 to 1 day.

Decision de-risked: Whether the adapter can honestly report Fable usage and avoid silent fallback claims.

### Spike 10: Route-block and artifact privacy audit

Question: Do route-block errors, adapter metadata, MCP responses, session render output, and redacted exports avoid leaking env values, prompt text, raw local paths, or raw Claude Code streams unintentionally?

Method: Create fixtures with fake API key values, sensitive prompt text, local paths, raw stderr warnings, and artifact URIs. Exercise route-blocks, failed auth checks, MCP responses over local and network-like contexts, session render, status, and redacted export paths.

Deliverable: Privacy assertion tests and a short output-field allowlist for each response type.

Success-or-kill criteria: Success if outputs include useful names/statuses but no secret values or inappropriate raw paths. Kill or block network MCP artifact exposure if resource URI handling cannot hide local paths. Clean negative outcome counts as success if it forces safer artifact/resource boundaries.

Effort: 0.5 to 1 day.

Decision de-risked: Whether strict diagnostics can remain agent-useful without leaking sensitive local data.

## Minimum Testable Invariants To Carry Into Implementation

- Unsupported active routes return `agent_lane_blocked` with exit code `2` and `noBackendStarted: true`.
- `fable-local` never starts from API, router, serve, bridge, remote browser, remote MCP, background, detached, restart, resume, continue, follow-up, or fan-out paths in v1.
- `ANTHROPIC_API_KEY` presence, including blank/whitespace and Windows case variants, refuses before any Claude subprocess.
- Other ambiguous API/provider auth controls refuse unless empirically proven inert for this run.
- `ANTHROPIC_MODEL` is scrubbed only if argv precedence is empirically proven; otherwise it refuses.
- The child environment is allowlisted after parent refusal checks pass.
- The `claude` executable is absolute, realpath-resolved, safely owned, not repo-local, not unsafe-symlinked, and spawned with `shell: false`.
- Prompt content is sent over stdin, not argv.
- Command builder never emits dangerous bypass flags or accepts raw Claude pass-through args.
- Startup verification must prove no tools, no MCP, no hooks/plugins/skills/slash commands, no Chrome integration, no agents, no fallback model, safe permission mode, and disabled session persistence.
- Missing critical startup/result fields are non-success.
- Observed non-Fable or unknown model evidence is non-success by default.
- Raw stdout/stderr bytes are persisted before parse-dependent success.
- Normalized events include source, sequence, receive timestamp, byte offset, raw representation, parse status, and extracted visible text where safe.
- MCP success means every visible stdout/stderr byte is included inline and `eventsComplete: true`; any overflow or partial stream is non-success.
- Cancellation, child crash, and disk write failure produce non-success session metadata with partial raw stream artifacts where possible.
- Passive status/render/artifact commands do not invoke lane resolution or start work.

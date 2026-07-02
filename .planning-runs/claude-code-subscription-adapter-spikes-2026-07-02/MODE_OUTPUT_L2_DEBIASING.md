# MODE_OUTPUT_L2_DEBIASING: Claude Code Subscription Adapter Plan

## Thesis

The plan is directionally careful, but it over-weights exhaustive implementation detail and under-separates true empirical uncertainty from deterministic engineering work. The core decision is not whether Oracle can add more guards, schemas, docs, and tests. The core decision is whether current Claude Code can be made locally subscription-backed, no-tool, non-mutating, visibly verifiable, and stream-capturable enough to justify a safe Oracle lane.

Mandatory spikes should therefore be narrow, falsifiable probes that can kill or reshape the feature before implementation begins. Most of the acceptance checklist belongs in implementation planning after those probes pass.

## Findings

### Finding 1: The plan's main hidden assumption is that Claude Code exposes enough runtime truth

The plan assumes `claude -p` can visibly report auth source, model, tool list, MCP/config state, and result usage in a way Oracle can enforce. If those fields are absent, unstable, or ambiguous, much of the safety story collapses.

Calibration: high impact, medium likelihood. This is the first thing to spike.

### Finding 2: The no-tool read-only boundary is the highest-risk technical claim

The plan correctly treats Claude Code as an agentic local tool, not a plain text API. However, the safety requirement depends on `--tools ""` or an equivalent producing an empty available-tool set and on startup verification proving that hooks, MCP, plugins, skills, Chrome, subagents, and session persistence are inactive.

If Claude Code cannot be made tool-empty and observable, event-level read-only detection is only a tripwire, not a boundary.

### Finding 3: Billing safety is broader than `ANTHROPIC_API_KEY`, but the hard refusal is only fully calibrated for that one variable

The plan's hard refusal for any spelling or blank value of `ANTHROPIC_API_KEY` is clear and testable. The broader refusal set, such as auth token, base URL, Bedrock, Vertex, Foundry, fallback model, API-key helper settings, and console/API auth mode, needs an empirically verified inventory.

The plan should avoid implying Oracle can prove subscription billing absence unless Claude Code visibly exposes enough auth and provider state.

### Finding 4: The three-lane agent gate is a separate product boundary from the Fable local adapter

The `fable-local` adapter can be de-risked independently from ChatGPT Pro and Gemini Deep Think browser-lane gating. Bundling all three lanes into the same must-ship surface increases scope and can hide the adapter's true viability signal.

The lane gate may still be the right product direction, but the browser selector-state work is not evidence for or against the Claude Code subscription adapter.

### Finding 5: Browser lane verification is probably a separate live-UI spike, not a registry task

For ChatGPT Pro and Gemini Deep Think, naming a lane is easy. Proving signed-in state and exact selector state without submitting a prompt, while never clicking "Answer now", is the risky part. Treat that as a live browser automation spike if the browser lanes remain mandatory for v1.

### Finding 6: Full inline event return may be over-committed before transport limits are known

The plan says MCP success must include all visible stdout and stderr inline and must fail closed on overflow. That is a coherent policy, but the practical limit depends on MCP client/server payload behavior, timeout behavior, and session storage expectations.

This should be spiked with synthetic streams before promising a specific inline contract.

### Finding 7: The acceptance checklist mixes requirements, tests, implementation tasks, and unresolved choices

Many checklist items are deterministic once the architecture is chosen: add a registry, add provider metadata, write tests, update docs, persist artifacts, create route-block envelopes. Those are not spikes. Keeping them in the same mental bucket as unknown Claude Code behavior weakens prioritization.

### Finding 8: Several open questions are human value calls, not experiments

Questions like inline byte limits, purge scope, fail-fast versus wait-on-lock, whether browser remote workers are allowed, and what `--write-output` should contain are policy/product decisions. A spike can inform them, but cannot decide the value tradeoff by itself.

## Assumptions

- This analysis is based on the plan text, not on fresh Anthropic documentation lookup or live `claude` execution.
- The plan's stated source facts may have changed and should remain untrusted until captured in a date-stamped empirical contract.
- The local implementation target is still macOS/Linux v1, with Windows out of scope unless a separate design is approved.
- The phrase "spike" means a short, falsifiable investigation that can kill, defer, or materially reshape implementation.
- Implementation tasks, tests for already chosen behavior, and docs updates are routed out of the mandatory spike list.

## Calibrated Confidence

- Confidence that the plan identifies the right broad risk areas: 0.78.
- Confidence that `fable-local` is implementable exactly as specified before empirical probes: 0.42.
- Confidence that a safe no-tool Claude Code envelope can be proven through current visible stream fields: 0.38.
- Confidence that billing/auth source can be distinguished well enough to avoid misleading claims: 0.45.
- Confidence that the lane registry and route-block behavior are straightforward once scope is chosen: 0.72.
- Confidence that browser selector-state can be robustly proven without prompt submission or brittle UI coupling: 0.35.
- Confidence that all visible events can be returned inline over MCP for realistic runs without a hard size policy: 0.50.

Overall calibrated stance: proceed with spikes, not implementation. The plan should require the Claude Code empirical contract, no-tool envelope proof, and stream/transport proof before any user-facing adapter work begins. Browser lane work should be decoupled unless the product decision is that the entire three-lane gate must land as one release boundary.

## Mandatory Proposed Spikes

### Spike 1: Claude Code subscription-auth empirical contract

Question: Does `claude -p --model fable` under a sanitized environment use local subscription auth and expose a visible auth source that can be distinguished from API/provider auth?

Method: On a subscription-authenticated machine, run the plan's opt-in probes with blocked auth variables absent. Capture `claude --version`, relevant help output, the first system/init event, and final result event. Do not run probes when `ANTHROPIC_API_KEY` or known provider-routing variables are present.

Deliverable: A dated fixture appendix containing raw init/result event excerpts, exact Claude Code version, exact command lines, observed `apiKeySource` values, and a short allow/deny table for auth-source interpretation.

Success-or-kill criteria: Success if subscription auth has a stable visible value and API/provider-like auth sources are distinguishable. Kill or block `fable-local` v1 if auth source is missing, ambiguous, or indistinguishable from API billing paths.

Effort: 0.5 to 1 day, assuming access to a logged-in Claude Code subscription environment.

Decision de-risked: Whether Oracle can honestly claim this lane uses local Claude Code subscription auth rather than Anthropic API routing.

### Spike 2: No-tool and config-surface containment

Question: Can Claude Code headless mode be started with zero available tools and inactive MCP, hooks, plugins, skills, slash commands, Chrome integration, custom agents, and session persistence?

Method: Probe the candidate argv shape from the plan, including `--tools ""`, `--permission-mode`, `--disable-slash-commands`, `--strict-mcp-config`, `--no-chrome`, `--no-session-persistence`, and optionally `--bare` or `--safe-mode` only when supported. Inspect startup events for available tools and active config surfaces.

Deliverable: A minimal command contract stating exactly which flags are emitted, which flags are not emitted, and which startup fields must be present for success. Include negative fixture examples for non-empty tools or active MCP/config surfaces if easy to produce.

Success-or-kill criteria: Success if the startup stream proves an empty tool set and inactive risky surfaces. Kill or defer read-only v1 if tools cannot be disabled, critical fields are missing, or active surfaces cannot be observed well enough to fail closed.

Effort: 1 to 2 days.

Decision de-risked: Whether the adapter can be read-only by construction rather than merely by prompt instruction.

### Spike 3: Fable model selection and fallback observability

Question: Does `--model fable` reliably select a Fable-compatible model, override model-default environment settings when allowed, and expose enough init/result metadata to detect fallback or non-Fable execution?

Method: Run small opt-in probes with no model-default env, then with `ANTHROPIC_MODEL` set to a harmless alternate value if policy allows a controlled probe. Inspect init `model` and result `modelUsage` keys. Avoid real API billing sources.

Deliverable: A model-verification fixture and policy recommendation for `ANTHROPIC_MODEL`, model aliases, `modelVerificationStatus`, and observed non-Fable handling.

Success-or-kill criteria: Success if Fable compatibility is visible in init or result metadata and model defaults are either proven overridden or safely refused. Kill exact Fable claims if Oracle can only know the requested model and cannot detect fallback.

Effort: 0.5 to 1 day.

Decision de-risked: Whether `fable-local` can be marketed and enforced as Fable, or only as "requested Fable through Claude Code".

### Spike 4: Raw stream capture and normalized event fidelity

Question: Can Oracle preserve stdout/stderr byte-for-byte while also building ordered normalized events for JSON lines, text chunks, invalid UTF-8, CRLF, split multibyte characters, and final partial lines?

Method: Build or use a tiny fake child process fixture that emits representative stdout/stderr chunks, including malformed and partial data. Prototype the event format without invoking live Claude Code.

Deliverable: A byte-offset event schema, raw artifact format decision, and fixture outputs proving sequence numbers, stream source, offsets, parsed JSON, and text extraction behavior.

Success-or-kill criteria: Success if byte offsets and raw persistence are deterministic across edge cases. Kill any claim of exact raw event preservation if offsets depend on JavaScript string lengths or lossy decoding.

Effort: 1 day.

Decision de-risked: Whether the raw event persistence and replay contract is technically sound before being tied to live model runs.

### Spike 5: MCP inline payload and overflow behavior

Question: What is the practical safe size and shape for returning all visible Claude Code stdout/stderr events inline through Oracle MCP `consult`?

Method: Use synthetic normalized event payloads of increasing size through the local MCP path and at least one representative MCP client. Measure truncation, timeout, serialization failures, and client display behavior.

Deliverable: A recommended inline byte limit, overflow semantics, and structured result shape for `eventsComplete`, resource URIs, and non-success overflow responses.

Success-or-kill criteria: Success if a limit can be chosen that avoids silent truncation and preserves a clear fail-closed contract. Kill the unconditional "all events inline on success" requirement if common clients truncate or timeout below realistic run sizes.

Effort: 1 to 2 days.

Decision de-risked: Whether MCP can satisfy the plan's full-inline requirement or needs an artifact-first design with explicit overflow non-success.

### Spike 6: Local-only execution and MCP launch-context proof

Question: Can Oracle reliably distinguish safe local same-user CLI/stdio/socket execution from router, serve, network MCP, remote browser, or other hosted contexts before spawning `claude`?

Method: Map current CLI, MCP, router, serve, browser, and session-worker entry points. Prototype or document the exact signals available at the spawn point, including uid, transport kind, executable realpath, Oracle home ownership, and remote flags.

Deliverable: A context eligibility matrix with allow/refuse outcomes and a minimal guard interface usable by the runner.

Success-or-kill criteria: Success if every active spawn path has a reliable local-only decision before process start. Kill MCP support for `fable-local` in v1 if MCP transport locality or same-user ownership cannot be proven; keep CLI-only if that path is provable.

Effort: 1 day.

Decision de-risked: Whether `fable-local` can safely include MCP, or must launch only from local CLI in v1.

### Spike 7: Browser lane selector-state proof, only if browser lanes remain in v1 scope

Question: Can ChatGPT Pro Extended Reasoning and Gemini Deep Think availability and selected state be proven without submitting a prompt or clicking forbidden UI such as "Answer now"?

Method: Use existing Oracle browser diagnostics or browser-tools against logged-in sessions. Inspect model picker and mode state before prompt submission. Repeat enough times to catch common loading and account-state variation.

Deliverable: A selector-state contract for each browser lane, including stable DOM signals, unknown states, and a doctor output policy.

Success-or-kill criteria: Success if selector state can be proven without model submission. Kill `ready: true` browser doctor claims if selector state cannot be proven; either decouple browser lanes from this release or route-block until manual smoke support exists.

Effort: 1 to 3 days, depending on account state and UI churn.

Decision de-risked: Whether the three-lane gate can honestly advertise browser lanes as ready, rather than merely naming preferred commands.

### Spike 8: Central lane policy coverage across active start paths

Question: Can one lane-policy resolver run before every active backend start path, including CLI run, dry run, MCP consult, restart/follow-up/resume/continue/background helpers, session workers, router, and future serve paths?

Method: Trace current entry points and insert temporary instrumentation or a static call map showing where API provider selection, browser launch, Claude Code spawn, router request creation, and session worker start occur. No feature implementation required.

Deliverable: An entrypoint coverage map with required insertion points and a list of active paths that must be refused in v1.

Success-or-kill criteria: Success if there is a small number of enforceable choke points. If starts are too scattered, phase the lane gate separately and avoid claiming `noBackendStarted: true` globally until coverage is proven.

Effort: 1 day.

Decision de-risked: Whether the lane gate can be a reliable safety boundary or only a best-effort CLI front door in the first release.

## Routed-Out Ideas

### Human value calls

- Whether the release must ship all three reviewed lanes together, or whether `fable-local` can be developed behind an explicit experimental flag first.
- The default MCP inline byte limit.
- Whether inline overflow aborts immediately or lets the run finish and returns a typed non-success result.
- Whether raw-event purge deletes only Claude Code artifacts or the whole Oracle session.
- Whether `--write-output` should write only final answer or also support raw/normalized events.
- Whether lock contention fails immediately or supports `--wait-for-lock` in v1.
- Whether remote browser workers are allowed for ChatGPT Pro and Gemini Deep Think lanes.
- Whether `--engine claude-code --model fable` should be hidden from help or documented as expert compatibility.

### Implementation tasks, not spikes

- Add `EngineMode = "claude-code"`.
- Add `LaneRegistry` and `lanePolicy` modules after the route decision is made.
- Add route-block JSON and exit code `2`.
- Add provider boundary slot `claude_code_fable_5`.
- Wire command builder, env guard, executable resolver, startup verifier, runner, session metadata, and artifact paths.
- Update README, CLI reference, MCP docs, Anthropic docs, configuration docs, and manual tests.
- Add unit tests and fixtures for already chosen behavior.
- Add privacy tests for no credential values in metadata or errors.
- Add CLI help ordering and capabilities schema once the product surface is chosen.

### Duplicate validations to consolidate

- Provider boundary and API substitution guard tests can share a single fixture proving `claude_code_fable_5` requires `claude_code_subscription_cli` and rejects `anthropic_api`.
- Route-block tests should validate one central policy resolver, then sample representative CLI/MCP entry points rather than duplicating every conflict at every layer.
- Privacy checks for environment values should run against shared error/metadata serializers instead of being repeated separately for each command.
- Raw artifact owner-only behavior should be tested once through the artifact writer, then referenced by CLI and MCP tests.

### Experiments that cannot fail unless given kill criteria

- Running `claude --version` by itself. This is data collection, not a spike, unless tied to supported-version policy.
- Capturing docs or help output without a pass/fail contract for required flags and fields.
- Updating command-builder fixtures after empirical capture.
- Running a happy-path live smoke after implementation. That is acceptance validation, not pre-implementation discovery.
- Adding doctor output after the checks are already known.
- Writing docs that say local-only, no API, read-only, and visible-output-only. That is required communication, not risk reduction.

## Recommended Sequencing

1. Run Spikes 1, 2, and 3 before writing adapter code.
2. Run Spikes 4 and 5 before locking the MCP full-inline contract.
3. Run Spike 6 before allowing MCP or any non-CLI launch path for `fable-local`.
4. Run Spike 7 only if browser lanes are bundled into the same release boundary.
5. Run Spike 8 before claiming the lane gate blocks every active backend path.

If Spikes 1 or 2 fail, stop the adapter implementation and revise the product claim. If Spike 3 fails partially, downgrade language from "Fable observed" to "Fable requested" or block the lane until Claude Code exposes better evidence. If Spikes 5, 6, or 7 fail, narrow the v1 surface instead of weakening safety language.

# F7 Systems / Integration Architecture Analysis

## Thesis

The Claude Code subscription adapter is not just a new Oracle engine. It is a cross-cutting policy and observability change that must hold across CLI parsing, lane resolution, MCP consult, session lifecycle, browser runners, local subprocess execution, artifact storage, and provider-boundary metadata.

The highest-risk integration decision is where the system draws its chokepoints. If lane gating, local-only enforcement, read-only enforcement, raw event persistence, and lifecycle refusal are implemented as scattered runner checks, at least one legacy path will bypass them. The SPIKE.md portfolio should therefore prioritize small, falsifiable integration spikes that either prove a central policy seam exists or force a scope reduction before implementation fans out into many files.

Clean negative outcomes are valuable here. A spike that proves `claude -p` cannot expose enough startup metadata, or that MCP cannot truthfully return full inline streams at expected sizes, should be treated as a successful de-risking result because it changes the implementation plan before the team commits to unsafe guarantees.

## Findings

1. The plan has three intertwined products, not one feature: a `claude-code` local engine, a three-lane agent-facing policy gate, and a full visible-event transcript/artifact contract. These need independent feasibility checks because any one can force a different release sequence.

2. The proposed `LaneRegistry` must sit before engine resolution, provider selection, browser startup, Claude subprocess spawn, session workers, MCP run mapping, restart/follow-up helpers, router/server paths, and config/env default resolution. If it lands lower than that, old API, browser, or lifecycle code can bypass `agent_lane_blocked`.

3. Browser lane verification is an integration dependency even though the headline feature is Fable local mode. The plan says agent-facing v1 exposes exactly three reviewed lanes, so ChatGPT Pro and Gemini Deep Think selector-state proof can block or delay the Fable lane unless the release is intentionally sequenced.

4. The Fable adapter safety contract depends on volatile external CLI behavior. The plan requires visible startup fields for auth source, model, tools, MCP servers, hooks/plugins/skills/slash commands, Chrome, fallback model, and session persistence. If Claude Code omits or renames these fields, the safe implementation should refuse, not infer.

5. `--tools ""` is a keystone assumption. If the installed Claude Code accepts the flag but still reports tools, or rejects the syntax, the no-tool supplied-context MVP is not implementable as described.

6. MCP full inline event return is likely the largest product/API tension. The plan requires every stdout event and stderr chunk inline on success, while also preserving raw artifacts. That needs a measured overflow policy before schema work, otherwise MCP may silently recreate the existing log-tail problem under a larger name.

7. Raw byte persistence is a security boundary and an audit boundary. Exact bytes, offsets, invalid UTF-8 handling, owner-only modes, symlink refusal, typed artifact kinds, and redacted-export exclusion are all part of the same system behavior; splitting them across unrelated modules will create inconsistent guarantees.

8. Local-owner and executable-trust checks are harder than ordinary CLI preflight. The adapter must distinguish a safe local `claude` from repo-local path shadowing, unsafe symlinks, world-writable path components, router/server contexts, and network-bound MCP transports. That should be prototyped before committing to MCP support for `fable-local`.

9. Existing Oracle session lifecycle features conflict with the v1 promise of one complete visible turn. Restart, follow-up, resume, background, detached/no-wait, and Claude Code native session persistence all need a shared engine-flow policy, not ad hoc refusals inside the runner.

10. The existing file attachment and prompt assembly path becomes the only approved file access surface for Fable local mode. If it cannot represent real review bundles without `Read`, `Grep`, or `Glob`, the no-tool architecture may be safe but too weak for intended use.

11. Provider boundary and API substitution guard integration should stay explicit. Adding `fable` as a model alias is dangerous if it leaks into normal Anthropic API routing, OpenRouter routing, or multi-model fan-out.

12. The proposed file map is broad enough that a direct implementation could produce many partially correct modules before discovering a fatal seam mismatch. The final SPIKE.md should front-load seam discovery and fake-run vertical slices over module-by-module coding.

## Assumptions

- The plan document is the source of truth for this analysis; I did not verify current Anthropic or Claude Code docs independently.

- The fork-local files named in the plan exist or are expected to exist in `etafund/oracle`, but this analysis did not inspect source code beyond the plan.

- The planning swarm wants spikes that inform a final implementation portfolio, not code changes in this pass.

- The assigned output file may overwrite any previous draft for this mode output.

- Browser lane readiness can be evaluated with non-submitting selector checks or fake controller fixtures before any live browser smoke.

- Live Fable usage and live browser smokes remain opt-in and should not be part of default spikes unless explicitly approved.

## Calibrated Confidence

- Overall confidence: 0.72. The architectural risk shape is clear from the plan, but exact insertion points and test harness cost need source inspection.

- High confidence: central lane-policy placement, no-tool Claude Code contract, raw event persistence, and lifecycle refusal are the highest-value spike areas.

- Medium confidence: MCP inline-size limits will force a product decision; the exact threshold depends on real MCP client/server behavior.

- Medium confidence: browser selector-state proof can be cleanly separated from Fable local delivery; this depends on how tightly current CLI help, MCP schema, and capabilities are expected to advertise all three lanes together.

- Lower confidence: local-owner/executable trust checks can be fully portable in v1 without over-refusing legitimate installs. macOS/Linux support is plausible, but exact filesystem and package-manager layouts matter.

## Mandatory Proposed Spikes

### Spike S1: Lane Gate Chokepoint and Bypass Audit

- Question: Can one central lane policy resolve or route-block every active CLI and MCP run path before any backend, session worker, browser, API client, local subprocess, router request, or provider resolver starts?

- Method: Trace active run entry points from CLI parsing, run options, dry run, MCP `consult`, session lifecycle helpers, restart/follow-up/background flows, config/env default resolution, and router/server paths. Build a small sentinel harness or table-driven tests where fake API, fake browser, fake Claude Code spawn, and fake session worker throw if called after a route-block input.

- Deliverable: A route-entry inventory, a proposed insertion-point diagram, and failing/passing table cases for `agent_lane_blocked` with `noBackendStarted: true`.

- Success-or-kill criteria: Success if all active starts pass through one policy helper or a very small number of explicit wrappers, while passive commands such as status/session render remain outside the policy. Kill or rescope if the current architecture needs broad scattered checks across many independent modules; a clean negative should move the plan to a smaller first release such as `--engine claude-code --model fable` behind explicit expert use before the full lane gate.

- Effort: 1 to 2 days.

- Decision de-risked: Whether to implement `LaneRegistry` first as the root of the work, or defer the three-lane agent gate until after a narrower adapter slice.

### Spike S2: Empirical Claude Code Contract and No-Tool Feasibility

- Question: Does the installed Claude Code CLI expose enough flags and visible startup/result metadata to safely support local subscription Fable, no tools, no API billing, no session persistence, and model verification?

- Method: On a subscription-authenticated machine with blocked auth variables absent, run the plan's empirical probes for `claude --version`, `claude --help`, `claude -p --help`, normal `stream-json`, `--bare`, `--tools ""`, and `ANTHROPIC_MODEL` precedence. Capture sanitized `system/init` and `result` fixtures. Compare observed fields against the required verifier inputs.

- Deliverable: A checked empirical contract appendix or fixture set, plus a command-builder capability matrix that marks each candidate flag as confirmed, rejected, or verifier-only.

- Success-or-kill criteria: Success if startup events prove subscription/OAuth auth source, Fable-compatible model request or usage, empty tools, no MCP servers, and inactive config surfaces. Kill `fable-local` v1 if `--tools ""` cannot produce an empty tool list, if auth source cannot distinguish subscription from API/provider modes, or if critical startup fields are absent. A clean negative is success because it prevents an unsafe adapter.

- Effort: 1 day, excluding any human time needed to log in or approve opt-in subscription probes.

- Decision de-risked: Whether the local Claude Code adapter can exist as a safe no-tool supplied-context runner, and which command flags the implementation is allowed to emit.

### Spike S3: Local Owner, Executable Trust, and Transport Guard Prototype

- Question: Can Oracle reliably prove `fable-local` is running as the local owner against a safe local `claude` executable, and refuse router, server, remote browser, and network-bound MCP contexts before spawning anything?

- Method: Prototype guard logic against fixture filesystem/env cases and the current launch contexts. Cover root and sudo states, Oracle home/session ownership, world-writable directories, symlinked paths, repo-local `claude`, PATH shadowing, safe absolute realpaths, local stdio MCP, same-user local socket MCP, and network/server/router contexts.

- Deliverable: A guard decision matrix with reason codes, a list of platform assumptions for macOS and Linux, and a recommendation on whether MCP `fable-local` is in v1 or CLI-only until transport identity is stronger.

- Success-or-kill criteria: Success if common macOS/Linux installs pass and unsafe path/transport cases fail deterministically with actionable reasons. Kill MCP support for `fable-local` in v1 if local same-user transport cannot be distinguished from network/server contexts. Defer Windows if ACL, credential-store, symlink, or process-tree semantics are not ready.

- Effort: 1 to 2 days.

- Decision de-risked: Whether `fable-local` can be exposed through MCP in v1, and what local-only proof is realistic without overclaiming account ownership.

### Spike S4: Raw Byte Persistence, Artifact Security, and Redacted Export Contract

- Question: Can the session artifact layer persist exact stdout/stderr bytes and normalized events while enforcing owner-only files, symlink refusal, typed artifact kinds, and redacted-export exclusion?

- Method: Use a fake Claude child process that emits split multibyte UTF-8, invalid UTF-8, CRLF, final partial lines, large stderr chunks, unknown JSON events, and process-crash mid-line. Write raw stdout, raw stderr, normalized NDJSON, final answer, and adapter metadata through the intended session artifact APIs. Exercise owner-only and symlink-attack cases with safe temporary fixtures.

- Deliverable: An artifact schema decision, byte-offset invariants, normalized event examples, file-mode/symlink behavior, and tests or fixture outputs proving raw bytes round-trip.

- Success-or-kill criteria: Success if raw files are byte-exact, offsets are computed from buffers, normalized events preserve parse failures, artifact kinds are typed, and redacted exports exclude raw Claude Code streams by kind. Kill or block the adapter if raw persistence can fail silently, if symlink-safe owner-only creation is not feasible, or if raw streams would be stored as generic artifacts that exports cannot distinguish.

- Effort: 2 days.

- Decision de-risked: Whether the transcript-fidelity and privacy promises can be implemented in the existing session store before live Claude Code integration.

### Spike S5: MCP Full Inline Events and Overflow Semantics

- Question: Can MCP `consult` truthfully return all visible stdout and stderr events inline at realistic sizes, and what should happen when the full event stream exceeds transport or client limits?

- Method: Build a fake runner path that returns event streams at several sizes such as 50 KB, 500 KB, 5 MB, and 50 MB without calling a model. Exercise the MCP schema, structuredContent serialization, client behavior, memory use, and current log-tail/session resource paths. Compare abort-immediately versus finish-and-return-non-success overflow behavior.

- Deliverable: A recommended default max inline byte limit, an overflow error envelope, `eventsComplete` and `streamsComplete` semantics, and tests proving no successful result can contain a partial inline stream labeled complete.

- Success-or-kill criteria: Success if there is a measured inline limit and a fail-closed overflow path that preserves raw artifacts. Kill the current MCP success contract if realistic Fable streams exceed practical inline limits; in that case the final plan should either make large streams non-success by design or change MCP to resource-first with explicit user acceptance.

- Effort: 1 day.

- Decision de-risked: Whether Phase 2 is feasible as written, and whether MCP callers can depend on full inline visible events instead of artifact resources.

### Spike S6: Browser Lane Runtime Verification Feasibility

- Question: Can ChatGPT Pro Extended Reasoning and Gemini Deep Think readiness be proven without submitting a prompt, without clicking `Answer now`, and with enough certainty to advertise them as reviewed lanes next to `fable-local`?

- Method: Use existing browser controller diagnostics, non-submitting selector checks, and fake DOM/controller fixtures. For live checks, keep them opt-in and do not send prompts. Evaluate signed-out, signed-in wrong plan, selector unknown, correct selector, selector changes between resolution and submit, and stale assistant snapshot cases.

- Deliverable: A browser lane readiness contract, selector-state reason codes, runtime re-verification insertion points, and a recommendation on whether browser lanes can be `ready: true`, `ready: false selector_state_unknown`, or must be split from the Fable adapter release.

- Success-or-kill criteria: Success if both browser lanes have deterministic non-submitting readiness checks and abort before prompt submission when state changes. Kill the combined three-lane release sequence if either lane cannot prove selector state; a clean negative should allow `LaneRegistry` to exist while marking that browser lane not ready or deferring its agent-facing advertisement.

- Effort: 1 to 2 days.

- Decision de-risked: Whether the final SPIKE.md should couple Fable local work to browser lane verification, or split them into separate portfolio tracks.

### Spike S7: Lifecycle and Engine-Flow Refusal Matrix

- Question: Can v1 reliably refuse restart, follow-up, resume, continue, background, detached/no-wait, multi-model fan-out, and Claude Code native session persistence for `fable-local` through one shared engine-flow policy?

- Method: Inventory existing lifecycle commands and session helpers. Create a matrix for active versus passive operations and feed fake `claude-code`, browser, and API session metadata through it. Assert that passive status/render/raw-artifact inspection does not invoke lane resolution, while active continuation or restart paths route-block before worker creation.

- Deliverable: An `engineFlowPolicy` API proposal, lifecycle route-block cases, and test fixtures covering CLI and MCP lifecycle operations.

- Success-or-kill criteria: Success if all active lifecycle mutations are centrally refused for `fable-local` and normal passive inspection still works. Kill detached/background support in v1 if any path cannot preserve full inline events and raw persistence. A clean negative should remove lifecycle ambiguity from the first implementation.

- Effort: 1 day.

- Decision de-risked: Whether session lifecycle changes are a small policy layer or a hidden major refactor.

### Spike S8: Prompt Assembly and Supplied-Context Security Boundary

- Question: Can Oracle's existing prompt and file attachment pipeline support useful Fable reviews while Claude Code has zero file tools and receives the bundle only through stdin?

- Method: Run the existing bundle builder into a fake Claude runner. Cover globs, large files, binary or unreadable files, excluded secrets, `.env`-like names, absolute and relative paths, hostile prompt-injection content inside files, prompt suffix/config behavior, and stdin EOF handling. Confirm that the full user prompt never appears on argv and raw pass-through Claude Code args are impossible.

- Deliverable: A supplied-context bundle contract for `fable-local`, including size limits, secret/exclusion behavior, stdin shape, and final prompt prefix wording.

- Success-or-kill criteria: Success if existing prompt assembly can be reused without granting Claude Code `Read`, `Grep`, or `Glob`. Kill or narrow the no-tool MVP if real review inputs cannot fit or be represented through supplied context; defer tool-enabled reviews to a separate security design.

- Effort: 1 to 2 days.

- Decision de-risked: Whether the adapter can stay no-tool and still satisfy the intended review workload.

### Spike S9: Provider Boundary, Model Alias, and API Substitution Invariants

- Question: Can `fable` and `claude_code_fable_5` be represented without leaking into Anthropic API, OpenRouter, Azure, existing Claude API models, or `--models` fan-out?

- Method: Inspect provider boundary and API substitution guard integration points. Add or sketch tests where `--engine api --model fable`, `--model claude-4.6-sonnet`, `--models gpt-5.5-pro,fable`, MCP engine/model compatibility forms, and exact `--engine claude-code --model fable` requests all resolve to the intended route-block or lane result. Use fake provider clients that fail if invoked.

- Deliverable: A provider/model routing invariant list, a minimal model alias strategy for local Claude Code only, and tests or fixtures proving Anthropic API is never used for the subscription slot.

- Success-or-kill criteria: Success if `fable` is scoped to `claude-code` or `fable-local` only and all API/fan-out paths route-block before provider selection. Kill the model alias approach if the current model registry cannot prevent API leakage; use a separate `ClaudeCodeModelName` type instead.

- Effort: 0.5 to 1 day.

- Decision de-risked: Whether model alias work is safe to do in shared registries or must be isolated to the local adapter.

### Spike S10: Fake-Run Vertical Slice Across CLI, Session, Artifacts, and MCP

- Question: After the chokepoints are identified, can a fake `claude` run exercise the whole intended architecture without live Fable usage?

- Method: Create a fake Claude executable or injected spawn implementation that emits a valid startup event, visible assistant deltas, stderr chunks, result metadata, and controlled failure variants. Run it through CLI `--lane fable-local`, session creation, raw artifact persistence, final answer extraction, route metadata, and MCP `consult` with inline events.

- Deliverable: A vertical-slice fixture proving the intended orchestration order: lane policy, env/local guards, session creation, lock acquisition, spawn, startup verifier, raw persistence, normalized events, final answer, metadata, MCP structured result, and lock release.

- Success-or-kill criteria: Success if the fake run produces a complete session and MCP result without any live provider calls. Kill direct live-run implementation if the fake slice requires excessive test seams; add those seams first before touching real Claude Code.

- Effort: 2 days.

- Decision de-risked: Whether the implementation can proceed safely with fake-run tests as the main default test strategy and live Fable smokes as opt-in only.

## Suggested Portfolio Ordering

1. Run S1 first because every other spike depends on the lane and active-run chokepoints.

2. Run S2 in parallel with S1 if a subscription-authenticated machine is available; otherwise mark it as the first human-unblocked spike.

3. Run S4 and S5 before MCP schema work because they define the event fidelity and payload truth contract.

4. Run S3 before exposing `fable-local` through MCP or any server-adjacent path.

5. Run S6 before promising the complete three-lane agent-facing surface.

6. Run S10 only after S1, S2, S4, and S5 have produced stable contracts.

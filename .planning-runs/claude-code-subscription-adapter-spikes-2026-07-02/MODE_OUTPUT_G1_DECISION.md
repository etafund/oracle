# G1 Decision Analysis: Claude Code Subscription Adapter Spike Sequencing

## Thesis

The plan is viable only if it is treated as a sequence of kill-gated spikes, not as a normal feature build. The highest-pressure decision is whether Claude Code can be empirically constrained and observed enough to satisfy the sponsor's hard promises: no API billing, local-owner use only, no tools, no hidden state claims, and full visible event capture. If that empirical contract fails, the `fable-local` lane as specified should be killed or rescoped before implementation begins.

The second load-bearing decision is the lane gate. The three reviewed lanes are not a UX wrapper around existing engines; they are a product safety boundary that must execute before engine/model/provider/session selection. Building the Claude runner before central route-block policy would create bypass paths the plan explicitly forbids.

## Findings

| Finding | Decision implication | Confidence |
|---|---|---:|
| Phase 0.5 is a hard feasibility gate, not routine discovery. `--tools ""`, `apiKeySource`, `modelUsage`, `--bare`, `ANTHROPIC_MODEL` precedence, and startup fields decide whether the MVP can meet its own safety contract. | Run empirical Claude Code contract capture before command builder or runner work. | 0.90 |
| The plan combines at least five subsystems: central lane policy, Claude Code local runner, raw stream persistence, MCP inline event return, and browser lane selector verification. | Sequence by irreversible submit/spawn boundaries, not by file map convenience. | 0.86 |
| The sponsor weighting strongly favors fail-closed behavior over feature breadth. Refusal is the intended successful behavior for ambiguous routes, env vars, transports, and startup mismatches. | Route-block and guard spikes should precede happy-path smoke work. | 0.88 |
| Browser lanes need non-submitting runtime proof. Without selector-state verification, the agent gate can advertise commands that are not actually reviewed lanes. | Browser readiness doctor and runtime checks gate public lane claims. | 0.76 |
| MCP full inline visible events are a separate product contract from session persistence. Existing log-tail behavior cannot satisfy it. | Build event schema, overflow policy, and raw artifact semantics before MCP integration. | 0.82 |
| Local-owner and executable trust checks are not polish. They are what keeps the feature from becoming a subscription relay or repo-local binary execution hazard. | Treat local-owner/executable guards as pre-spawn blockers, not post-run warnings. | 0.80 |
| The current rollout plan puts lane gate after internal adapter, but decision pressure argues for lane policy earlier or in parallel. | Build a no-backend lane resolver before any public or MCP active run path can reach the new engine. | 0.78 |

## Assumptions

| Assumption | Why it matters |
|---|---|
| This analysis is based on the local plan document only; no live Claude Code probes or current external docs were checked in this mode. | Empirical contract spikes remain mandatory. |
| The sponsor's highest priorities are strict local subscription use, avoiding Anthropic API billing, read-only review, full visible stream capture, and the three reviewed lanes. | Ranking weights safety and product boundary over implementation throughput. |
| The broad Oracle API/browser feature set remains in the fork, but normal agent-facing starts are gated in v1. | The lane gate is a routing boundary, not deletion work. |
| Existing session/MCP/browser machinery can be adapted, but exact code seams are unverified in this mode. | A code-seam spike is still needed before task breakdown. |
| Windows is out of v1 scope unless separately designed. | Local-owner, ACL, process-tree, and credential-store decisions can target macOS/Linux first. |

## Ranking Method

Scores use a 1-5 scale. Higher is better. Weighted score uses value of information 30%, cheapness 10%, load-bearingness 25%, sponsor weighting 20%, and sequencing pressure 15%.

| Rank | Proposed spike | VoI | Cheap | Load-bearing | Sponsor | Sequence | Weighted score |
|---:|---|---:|---:|---:|---:|---:|---:|
| 1 | Empirical Claude Code contract and kill gate | 5 | 3 | 5 | 5 | 5 | 4.80 |
| 2 | Central lane policy and no-backend route-block prototype | 5 | 4 | 5 | 5 | 5 | 4.90 |
| 3 | Claude Code no-tool/config-surface containment proof | 5 | 3 | 5 | 5 | 5 | 4.80 |
| 4 | Browser lane non-submitting selector verification | 4 | 3 | 5 | 5 | 4 | 4.35 |
| 5 | Raw stream persistence and MCP inline event contract | 4 | 4 | 5 | 4 | 4 | 4.25 |
| 6 | Local-owner, executable, env, and transport guard feasibility | 4 | 3 | 5 | 5 | 4 | 4.25 |
| 7 | Existing Oracle integration seam map | 4 | 4 | 4 | 4 | 5 | 4.15 |
| 8 | Fake-run Claude Code runner lifecycle spike | 3 | 3 | 4 | 4 | 3 | 3.45 |
| 9 | Artifact privacy, redacted export, and purge policy | 3 | 3 | 4 | 4 | 3 | 3.45 |
| 10 | Live smoke and MCP launch-context validation | 4 | 2 | 4 | 4 | 2 | 3.70 |

## Mandatory Proposed Spikes

### 1. Empirical Claude Code Contract and Kill Gate

| Field | Content |
|---|---|
| Question | Does the installed Claude Code CLI expose enough stable, visible, subscription-authenticated state to implement `fable-local` without guessing? |
| Method | Capture fresh `claude --version`, `claude --help`, `claude -p --help`, and opt-in tiny subscription probes with no blocked Anthropic/provider env vars. Record startup/init and result events for normal, `--bare`, `--tools ""`, and `ANTHROPIC_MODEL` override cases. |
| Deliverable | A checked fixture or appendix containing sanitized raw init/result events, supported flag matrix, observed auth source values, observed model fields, model precedence result, and explicit implementation decision. |
| Success-or-kill criteria | Success requires visible subscription/OAuth auth source, visible startup fields sufficient for auth/model/tools/MCP verification, working stream JSON, and result/model/cost fields characterized. Kill or rescope `fable-local` if auth source is not visible, actual model cannot be bounded enough, or the CLI cannot be safely driven headlessly. |
| Effort | Small to medium; one focused session plus opt-in live usage. |
| Decision de-risked | Whether implementation can start at all for the local Claude Code adapter. |
| Downstream implementation gated | `src/claude-code/command.ts`, `envGuard.ts`, `startupVerifier.ts`, command fixtures, doctor checks, docs claims, live smoke instructions. |

### 2. Central Lane Policy and No-Backend Route-Block Prototype

| Field | Content |
|---|---|
| Question | Can Oracle make the three reviewed lanes the only normal agent-invocable active routes before any backend, session worker, provider, browser, or subprocess starts? |
| Method | Build or sketch a minimal `LaneRegistry` and `lanePolicy.resolve()` around parsed CLI/MCP-like inputs using fake backend hooks. Table-test supported lanes, exact legacy mappings, conflicts, no-default behavior, `--models` refusal, env/config default refusal, and `noBackendStarted: true`. |
| Deliverable | A prototype or design spike report with resolver input/output types, route-block envelope, insertion points, and a table of accepted/refused cases. |
| Success-or-kill criteria | Success requires one central policy surface that can run before engine/provider/session start and emits replacement commands for all three lanes. Kill scattered provider-level gating if it cannot prove no backend started. |
| Effort | Medium. |
| Decision de-risked | Whether the v1 product boundary can be enforced centrally instead of by convention. |
| Downstream implementation gated | `src/cli/laneRegistry.ts`, `lanePolicy.ts`, MCP schema changes, help/capabilities/doctor lane output, route-block tests, session start wiring. |

### 3. Claude Code No-Tool and Config-Surface Containment Proof

| Field | Content |
|---|---|
| Question | Can Claude Code be made read-only for supplied-context review by command flags plus visible startup verification? |
| Method | Use the empirical fixture to test `--tools ""`, `--disable-slash-commands`, `--strict-mcp-config`, `--disallowedTools mcp__*`, `--no-chrome`, `--no-session-persistence`, `--safe-mode`, and `--bare` only where supported. Probe whether startup events expose tools, MCP servers, hooks, plugins, skills, slash commands, Chrome integration, custom agents, fallback model, and permission mode. |
| Deliverable | A containment matrix naming each surface, mitigation flag if any, startup verification field if any, and final decision: emit, verify, refuse, or block feature. |
| Success-or-kill criteria | Success requires empty available tools and enough visible startup metadata to detect active MCP/config/tool surfaces. Kill v1 if `--tools ""` is ignored or startup verification cannot detect active tools/config surfaces. Rescope only with explicit sponsor approval. |
| Effort | Small after Spike 1; medium if CLI behavior is inconsistent. |
| Decision de-risked | Whether read-only review is enforceable rather than merely prompted. |
| Downstream implementation gated | Command builder, read-only guard, startup verifier, config guard, policy violation watcher, manual smoke criteria. |

### 4. Browser Lane Non-Submitting Selector Verification

| Field | Content |
|---|---|
| Question | Can ChatGPT Pro Extended Reasoning and Gemini Deep Think lanes be verified immediately before prompt submission without submitting a prompt or clicking forbidden controls? |
| Method | Inspect existing browser automation capabilities and create fake-controller fixtures for selector state. Define readiness states: ready, signed_out, unavailable, selector_state_unknown, changed_before_submit. Do not run live prompts unless separately opted in. |
| Deliverable | A browser lane verification contract for ChatGPT and Gemini, including required pre-submit assertions, doctor output states, and abort-before-submit behavior. |
| Success-or-kill criteria | Success requires non-submitting proof of intended model/mode or an explicit `selector_state_unknown` non-ready state. Kill any readiness claim that depends on submitting a prompt. For ChatGPT, never click or auto-click `Answer now`. |
| Effort | Medium. |
| Decision de-risked | Whether browser lanes are actually reviewed lanes rather than labels over mutable UI state. |
| Downstream implementation gated | `doctor lanes --json`, browser runner runtime assertions, lane readiness claims, browser lane tests, public help confidence. |

### 5. Raw Stream Persistence and MCP Inline Event Contract

| Field | Content |
|---|---|
| Question | What exact event and artifact contract satisfies full visible stdout/stderr capture without lying about completeness or overflowing MCP responses? |
| Method | Build fake stdout/stderr stream fixtures covering JSON lines, partial chunks, CRLF, invalid UTF-8, stderr chunks, huge lines, and process crash mid-line. Define normalized event schema, byte offset rules, raw artifact file modes, inline byte limit behavior, `eventsComplete`, and `streamsComplete`. |
| Deliverable | Schema and fixture-backed parser/persistence contract for raw stdout, raw stderr, normalized NDJSON, adapter metadata, MCP event payload, and overflow errors. |
| Success-or-kill criteria | Success requires byte-preserving raw streams, monotonic sequence numbers, byte offsets computed from buffers, and fail-closed inline overflow. Kill any MCP success path that returns a log tail or partial events with `eventsComplete: true`. |
| Effort | Medium. |
| Decision de-risked | Whether the full visible event promise can be implemented safely across CLI, session storage, and MCP. |
| Downstream implementation gated | `streamParser.ts`, `artifacts.ts`, MCP `consult` structured result, session resources, final answer extraction, CLI JSONL/pretty output. |

### 6. Local-Owner, Executable, Env, and Transport Guard Feasibility

| Field | Content |
|---|---|
| Question | Can Oracle prove enough local-owner and local-executable safety before spawning `claude` to avoid becoming a hosted relay, repo-local binary runner, or API-billing path? |
| Method | Enumerate POSIX checks for uid, `SUDO_USER`, `HOME`, Oracle home, session dir, symlinks, world-writable path components, safe executable realpath, repo-local executable rejection, blocked env vars, scrubbed child env, and MCP/server/router transport detection. Test with fake filesystem/env fixtures. |
| Deliverable | Guard decision matrix with refusal reasons, warning cases, platform limits, and order of operations before any Claude subprocess including doctor/dry-run probes. |
| Success-or-kill criteria | Success requires refusal before any `claude` subprocess when `ANTHROPIC_API_KEY` or blocked provider sources are present, and refusal for unsafe executable/transport contexts. Kill any path that silently unsets API keys or discovers safety failures after spawning when they were detectable earlier. |
| Effort | Medium. |
| Decision de-risked | Whether local-only subscription semantics can be enforced in process, filesystem, and transport layers. |
| Downstream implementation gated | `envGuard.ts`, `localOwnerGuard.ts`, `executableResolver.ts`, MCP transport checks, doctor ordering, child env construction. |

### 7. Existing Oracle Integration Seam Map

| Field | Content |
|---|---|
| Question | Where exactly should lane policy, `claude-code` engine mode, session metadata, MCP schema, and route-block errors hook into the existing Oracle code without duplicating routing logic? |
| Method | Read only the listed integration files and produce a seam map: current parse path, engine resolution path, session creation path, MCP consult mapping path, dry-run path, and passive session commands. No code changes in this spike. |
| Deliverable | A file-by-file implementation map with insertion points, test targets, and paths that must not invoke lane policy, such as passive `status` and `session --render`. |
| Success-or-kill criteria | Success requires a single pre-backend lane policy insertion path for CLI and MCP active runs, and an engine-flow helper for restart/follow-up/background refusals. Kill any design that requires independent ad hoc checks in each provider. |
| Effort | Small to medium. |
| Decision de-risked | Whether implementation can be decomposed without bypass-prone routing duplication. |
| Downstream implementation gated | Task breakdown, code ownership, route-block no-backend tests, dry-run behavior, MCP mapping, session lifecycle changes. |

### 8. Fake-Run Claude Code Runner Lifecycle Spike

| Field | Content |
|---|---|
| Question | Can the local runner manage stdin, stdout/stderr capture, startup verification, timeout, abort, lock release, and final metadata using fake child processes before spending live usage? |
| Method | Implement or prototype a fake spawn interface that emits fixture streams and exit signals. Exercise success, nonzero exit, startup mismatch, read-only violation, timeout, Ctrl-C, output flood, disk write failure, and lock contention. |
| Deliverable | Runner lifecycle state diagram, fake-run fixtures, and proof that every exit path persists partial raw events and releases the single-flight lock. |
| Success-or-kill criteria | Success requires no live Fable usage, deterministic tests, `child.stdin.end()`, `shell: false`, no prompt on argv, and lock release on every terminal path. Kill direct real-CLI development as the first runner test strategy. |
| Effort | Medium. |
| Decision de-risked | Whether the adapter can be made reliable before live smokes. |
| Downstream implementation gated | `runner.ts`, `lock.ts`, timeout handling, abort handling, final answer extraction, adapter metadata. |

### 9. Artifact Privacy, Redacted Export, and Purge Policy

| Field | Content |
|---|---|
| Question | How should Oracle store, classify, display, redact, and purge sensitive raw Claude Code event artifacts? |
| Method | Inspect current artifact kinds, session render, cleanup, redacted export, and resource URI patterns. Define typed artifact kinds, owner-only file expectations, symlink refusal, default render behavior, redacted export exclusion, and explicit purge command scope. |
| Deliverable | Artifact policy decision record for `claude-code-stdout-raw`, `claude-code-stderr-raw`, `claude-code-events-normalized`, and `claude-code-adapter`. |
| Success-or-kill criteria | Success requires raw streams excluded from redacted exports by typed kind, not filename heuristics, and a documented purge path. Kill generic `file` artifact storage for raw streams in v1. |
| Effort | Small to medium. |
| Decision de-risked | Whether the feature can preserve full raw streams without accidental disclosure through existing evidence/export surfaces. |
| Downstream implementation gated | SessionStore artifact kinds, session resources, redacted export tests, docs, purge command design. |

### 10. Live Smoke and MCP Launch-Context Validation

| Field | Content |
|---|---|
| Question | After fake-run and guard spikes pass, does the feature work from both CLI and MCP launch contexts with the user's actual subscription auth and visible event stream? |
| Method | Run opt-in tiny prompts only after empirical contract, command builder, guards, persistence, and fake runner pass. Test CLI `--lane fable-local`, MCP `consult` with `lane: fable-local`, and optionally browser lane smokes only after non-submitting doctor readiness. |
| Deliverable | Smoke report with session ids, sanitized startup/result observations, artifact presence, inline event completeness, auth source status, model verification status, and any context-specific login caveats. |
| Success-or-kill criteria | Success requires no blocked env vars, no API auth source, full raw artifact persistence, inline event completeness where claimed, and expected final smoke token. Kill automatic live testing by default; live usage must remain opt-in. |
| Effort | Small execution effort, high coordination cost because it consumes real subscription/browser resources. |
| Decision de-risked | Whether the integrated feature works outside fake fixtures and whether MCP launch context preserves subscription auth. |
| Downstream implementation gated | Release readiness, docs confidence, manual smoke checklist, changelog decision. |

## Recommended Sequencing

| Stage | Spikes | Reason |
|---|---|---|
| Kill-gate first | 1, 3 | If Claude Code cannot prove subscription auth, no tools, and startup shape, do not build `fable-local` as specified. |
| Product boundary in parallel | 2, 7 | Lane policy can be built with fake backends and prevents bypasses before adapter work lands. |
| Runtime safety contracts | 5, 6, 8 | Stream, guard, lifecycle, and lock behavior define the runner's correctness envelope. |
| Browser readiness | 4 | Needed before claiming all three reviewed lanes are operational. Can proceed while Fable runner is built. |
| Privacy and release hardening | 9 | Should land before any raw stream artifacts are exposed to users or redacted exports. |
| Opt-in integration proof | 10 | Live smoke belongs after fake-run tests and guards, not as discovery. |

## Decision Cut Lines

| Decision point | Continue if | Stop or rescope if |
|---|---|---|
| Claude Code empirical contract | Visible init/result events prove auth source, model, tools, and enough config surface state. | Auth source is hidden/ambiguous, no-tool mode fails, or startup fields cannot support fail-closed verification. |
| Lane policy | Active runs cannot reach API, browser, Claude subprocess, MCP mapping, session worker, or router without a resolved lane or route-block. | Enforcement requires scattered checks or permits default/env/config route inference. |
| Browser lanes | Selector state can be proven without prompt submission and rechecked immediately before submit. | Readiness depends on sending a prompt, UI guessing, or clicking `Answer now`. |
| MCP inline events | Success can include every visible stdout/stderr event or fail closed with explicit overflow. | Existing 4 KB log tail or partial payload is treated as complete. |
| Local-owner guard | Unsafe env, executable, owner, symlink, and transport cases refuse before spawn. | API keys are silently unset, unsafe executable is tolerated, or remote/server contexts can spawn local Claude. |

## Calibrated Confidence

| Claim | Confidence |
|---|---:|
| The highest-value first spike is the empirical Claude Code contract. | 0.90 |
| The lane gate should be implemented before or alongside the runner, not after public adapter work. | 0.78 |
| The plan is feasible if `--tools ""` and startup verification behave as expected. | 0.62 |
| Browser lane verification will require additional project-specific automation work beyond route policy. | 0.76 |
| MCP full inline events need a dedicated contract and cannot reuse current log-tail semantics. | 0.82 |
| Overall sequencing recommendation is correct enough for swarm decomposition. | 0.80 |


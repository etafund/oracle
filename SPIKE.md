# Planning Spikes: Claude Code Subscription Adapter for Oracle

## Purpose

This is a planning-phase portfolio for the local Claude Code subscription adapter and the three reviewed Oracle agent lanes described in `docs/plans/claude-code-subscription-adapter.md`. It is not an implementation plan, product requirement, ADR, or doctrine update.

The goal is to find the problems before implementation begins. Every spike below is an experiment, prototype, fixture capture, route audit, or concrete validation that can fail and change a decision. Clean negative outcomes count as successful spikes when they kill, defer, narrow, or reorder risky implementation work.

The highest-value risks are concentrated in eight areas:

- Whether current Claude Code exposes enough visible runtime truth to support a safe `fable-local` lane.
- Whether Claude Code can be run with no tools, no hidden config surfaces, no session persistence, and supplied context only.
- Whether Oracle can enforce a central three-lane start gate before any backend starts.
- Whether raw stdout/stderr visible streams can be persisted and replayed byte-faithfully.
- Whether MCP can truthfully return all visible events inline or fail closed on overflow.
- Whether local-owner, executable provenance, environment, and transport checks prevent API billing, repo-local binary execution, and subscription relay behavior.
- Whether browser lanes can prove ChatGPT Pro Extended Reasoning and Gemini Deep Think readiness without prompt submission.
- Whether lifecycle, locking, cancellation, and privacy behavior stay honest under failure.

## Spike contract applying to every spike

- The spike must be able to fail or change a decision; otherwise it is not a spike.
- Pre-register success and kill criteria before running the experiment.
- Clean negative outcomes are successes if they prevent unsafe implementation or narrow scope.
- Do not modify plan, ADR, directive, requirement, or product docs while running these spikes.
- Do not add product crates or production implementation as part of a spike.
- Use fake runners, fixtures, throwaway harnesses, and scratch artifacts by default.
- Keep live Claude Code, ChatGPT Pro, Gemini Deep Think, and browser smokes opt-in.
- Never click or auto-click ChatGPT's `Answer now` control.
- Budget human-minutes explicitly for every human-in-loop spike.
- Calibrate severity to this deployment: local developer CLI/MCP use, not a generic public SaaS threat model.
- Record negative evidence with the same care as positive evidence.
- Route sponsor value calls to the sponsor asks section instead of embedding them as pseudo-experiments.

## At-a-glance portfolio

| Rank | Spike | Primary decision de-risked | Modes | Effort | Human minutes | Kill-gate |
| ---: | --- | --- | --- | --- | ---: | --- |
| 1 | Empirical Claude Code contract and kill gate | Whether `fable-local` can exist safely at all | F7, H2, A8, I4, G1, L2 | 0.5-1.5 days | 20-30 | Yes |
| 2 | Central lane start-gate and no-backend route-block proof | Whether three reviewed lanes can be enforced before side effects | F7, H2, A8, I4, G1, L2 | 1-2 days | 0 | Yes |
| 3 | No-tool and config-surface containment proof | Whether read-only supplied-context review is enforceable | F7, H2, A8, G1, L2 | 1-2 days | 0-20 | Yes |
| 4 | Auth, billing, and model-default escape matrix | Whether Oracle can credibly avoid API/provider billing paths | H2, A8, I4, G1, L2 | 1 day | 0 | Yes |
| 5 | Raw byte stream persistence and parser conformance | Whether full visible stream capture is lossless enough | F7, H2, A8, I4, G1, L2 | 1-2 days | 0 | Yes |
| 6 | MCP inline completeness and overflow semantics | Whether MCP can return full visible streams honestly | F7, H2, A8, I4, G1, L2 | 0.5-1.5 days | 15 if policy choice needed | Yes |
| 7 | Local-owner and transport eligibility proof | Whether `fable-local` can be local-only, including MCP | F7, H2, A8, I4, G1, L2 | 1 day | 0 | Yes |
| 8 | Executable provenance and launch-context trust | Whether PATH resolution can be safe without breaking real installs | H2, A8, G1 | 1 day | 0 | Yes |
| 9 | Startup verifier decision table | Whether visible startup/result fields can support fail-closed verification | F7, H2, A8, I4, G1, L2 | 0.5-1 day after Spike 1 | 0 | Yes |
| 10 | Fake-run vertical slice across CLI, session, artifacts, and MCP | Whether the architecture is testable without live quota | F7, H2, G1 | 2 days | 0 | Yes |
| 11 | Lifecycle, process-tree, timeout, and lock failure drill | Whether failures leave no hidden running work and preserve partial streams | H2, A8, I4, G1 | 1-2 days | 0 | Yes |
| 12 | Prompt assembly and supplied-context workload fit | Whether zero-tool review is useful with Oracle-supplied bundles | F7, H2 | 1 day | 0 | Yes |
| 13 | Provider boundary and model alias invariant proof | Whether `fable` leaks into API/fan-out routes | F7, A8, G1, L2 | 0.5-1 day | 0 | Yes |
| 14 | Browser selector-state proof without submission | Whether browser lanes can be marked reviewed/ready | F7, H2, I4, G1, L2 | 1-3 days | 10-30 | Yes |
| 15 | Browser lane drift and pre-submit abort rehearsal | Whether selector state remains verified at irreversible submit time | F7, H2, A8, I4 | 1 day | 0-20 | Yes |
| 16 | MCP launch-context subscription-auth validation | Whether real MCP clients inherit usable local Claude auth safely | H2, I4, G1, L2 | 0.5-1 day after guards | 20-30 | Scope gate |
| 17 | Artifact privacy, redacted export, and purge policy | Whether raw stream artifacts can be stored without accidental disclosure | H2, A8, I4, G1 | 0.5-1 day | 15 if purge scope choice needed | Scope gate |
| 18 | Route-block self-correction for calling agents | Whether agents can recover from blocked routes without docs or guessing | A8, I4, G1, L2 | 0.5 day | 0 | Scope gate |
| 19 | Help, capabilities, schema, and replacement-command single source | Whether lane UX surfaces drift | I4, G1, L2 | 0.5-1 day | 0 | Scope gate |
| 20 | Existing Oracle integration seam map | Where to insert policy and engine changes without duplication | F7, G1, L2 | 1 day | 0 | Scope gate |
| 21 | Sequencing split: adapter-first versus gate-first | Whether implementation can be safely staged | H2, I4, G1, L2 | 0.5 day | 30 | Release gate |
| 22 | Compliance and public wording check | Whether local wrapper wording is acceptable and non-misleading | H2, I4, L2 | 0.5 day | 30-60 | Release gate |
| 23 | Live local CLI smoke after fake gates pass | Whether integrated CLI works with real subscription auth | H2, I4, G1 | 0.5 day | 20-30 | Release gate |
| 24 | Live MCP and browser smoke after doctor readiness | Whether final advertised surfaces work in real launch contexts | H2, I4, G1 | 0.5-1 day | 30-60 | Release gate |

## Sequencing windows

### Window A: hard feasibility kill gates

Run Spikes 1 through 9 before product implementation. If any of these fails, do not weaken the safety language. Kill, defer, or narrow the affected surface.

### Window B: fake-run and failure semantics

Run Spikes 10 through 13 after the empirical and route-policy contracts exist. These should still use fake runners and fixtures, not live quota.

### Window C: browser and MCP scope decisions

Run Spikes 14 through 18 before claiming all three reviewed lanes are agent-ready or before exposing `fable-local` through MCP.

### Window D: implementation decomposition and release posture

Run Spikes 19 through 22 before task breakdown, public docs, or beta release decisions.

### Window E: opt-in live validation

Run Spikes 23 and 24 only after fake-run, guard, persistence, and doctor gates pass. These are not discovery substitutes; they are final integration checks.

## Full spike specs

### 1. Empirical Claude Code contract and kill gate

**Question:** Does the installed Claude Code CLI expose enough stable, visible, subscription-authenticated state to implement `fable-local` without guessing?

**Method:** On a subscription-authenticated machine, first confirm blocked auth/provider variables are absent. Capture fresh `claude --version`, `claude --help`, `claude -p --help`, and opt-in tiny `stream-json` probes for normal mode, `--bare`, `--tools ""`, and `ANTHROPIC_MODEL` precedence. Preserve sanitized `system/init` and final `result` events. Record exact command lines, Claude Code version, supported flags, auth-source values, model fields, result `modelUsage`, `total_cost_usd`, and final text shape.

**Deliverable:** A dated empirical contract fixture bundle plus a pass/fail matrix for required flags and required visible fields.

**Success criteria:** Subscription/OAuth auth source is visible and distinguishable from API/provider sources. `stream-json` works. Startup/result events expose enough fields to verify auth source, requested or resolved Fable model, tool list, MCP state, config surfaces, and result usage when available.

**Kill criteria:** Auth source is missing or ambiguous. The actual model cannot be bounded enough for v1. `stream-json` does not expose critical startup/result fields. Claude Code cannot be safely driven headlessly. Any result implies API/provider billing while the lane would claim subscription mode.

**Effort:** 0.5-1.5 engineering days.

**Human minutes:** 20-30 for Claude login confirmation and approval to spend minimal subscription usage.

**Decision de-risked:** Whether implementation can start at all for the local Claude Code adapter.

**Contribution notes:** KERNEL from all six modes.

### 2. Central lane start-gate and no-backend route-block proof

**Question:** Can Oracle make the three reviewed lanes the only normal active agent routes before any backend, session worker, provider resolver, browser, router request, or local subprocess starts?

**Method:** Build a minimal policy harness around parsed CLI and MCP-like inputs. Instrument fake backend counters for API selection, browser launch, Claude spawn, MCP backend mapping, session worker start, and router request creation. Table-test supported lanes, exact ChatGPT Pro legacy mappings, unsupported API/browser/model routes, no-default behavior, env/config default refusal, prior-session reuse, `--models`, explicit lane conflicts, dry runs, and MCP prompt-only requests.

**Deliverable:** Route-gate contract, insertion-point diagram, route-block JSON/human examples, and tests or fixture tables proving `noBackendStarted: true`.

**Success criteria:** One central resolver or a very small set of explicit wrappers covers all active starts. Unsupported active requests return `agent_lane_blocked`, exit code `2`, replacement commands for all three lanes, and no fake backend counter increments. Passive status/render/raw-artifact commands stay outside active lane resolution.

**Kill criteria:** Active starts are too scattered to prove no backend started. Policy must be duplicated independently in providers. Config/env/prior-session defaults can still infer active routes without a reviewed lane.

**Effort:** 1-2 days.

**Human minutes:** 0.

**Decision de-risked:** Whether `LaneRegistry` is a real safety boundary or only a UX registry.

**Contribution notes:** KERNEL from all six modes.

### 3. No-tool and config-surface containment proof

**Question:** Can Claude Code headless mode be started with zero available tools and inactive MCP, hooks, plugins, skills, slash commands, Chrome integration, custom agents, fallback model, and session persistence?

**Method:** Using Spike 1 fixtures or additional opt-in probes, test the candidate argv shape: `--tools ""`, permission mode, `--disable-slash-commands`, `--strict-mcp-config`, `--disallowedTools mcp__*`, `--no-chrome`, `--no-session-persistence`, and optionally `--bare` or `--safe-mode` only if empirically supported. Inspect startup events for all risky surfaces. Include adversarial supplied context that asks for shell, file reads outside the bundle, edits, MCP calls, browser use, slash commands, and subagents.

**Deliverable:** Containment matrix naming each surface, mitigation flag, startup verification field, and final disposition: emit, verify, refuse, or block feature.

**Success criteria:** Startup evidence proves empty tools and inactive risky surfaces. Unsupported flags are not emitted. Adversarial prompts do not produce visible tool/read/write/shell/subagent/browser events. Permission mode is empirically safe for unattended read-only review.

**Kill criteria:** `--tools ""` is rejected, ignored, or still reports tools. Critical config surfaces cannot be observed. Startup fields are missing and no alternate visible proof exists. Any tool remains available in v1.

**Effort:** 1-2 days.

**Human minutes:** 0-20 if a real probe needs subscription approval.

**Decision de-risked:** Whether v1 can honestly claim read-only supplied-context review.

**Contribution notes:** KERNEL from F7, H2, A8, G1, L2.

### 4. Auth, billing, and model-default escape matrix

**Question:** Which parent environment variables, Claude Code settings, auth helpers, provider modes, and fallback settings must refuse, which can be child-scrubbed, and can refusal happen before every Claude subprocess path?

**Method:** Build a parent-refusal and child-omit matrix for `ANTHROPIC_API_KEY` blank/whitespace/case variants, duplicate-like POSIX cases where observable, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_DEFAULT_*`, `ANTHROPIC_MODEL`, Bedrock/Vertex/Foundry toggles, fallback settings, API-key helpers, console/API auth mode, and benign vars needed for subscription auth. Test doctor, dry-run, empirical-probe, CLI, and MCP paths with fake `claude` resolution counters.

**Deliverable:** `blockedAuthEnv` specification, child environment allowlist, exact error wording, and a table mapping each source to allow, scrub, refuse-before-spawn, or detect-and-stop-at-startup.

**Success criteria:** Refused variables block before executable resolution and before any Claude subprocess. Error messages include variable names but no values. `ANTHROPIC_MODEL` is scrubbed only if Spike 1 proves argv precedence; otherwise it refuses. The child env is allowlisted after parent refusal checks pass.

**Kill criteria:** A known API/provider auth source can reach Claude Code before detection. Oracle silently unsets `ANTHROPIC_API_KEY`. A settings/helper/fallback path can route away from subscription use without visible startup evidence.

**Effort:** 1 day.

**Human minutes:** 0.

**Decision de-risked:** Whether Oracle can make a credible no-API-billing effort.

**Contribution notes:** KERNEL from H2, A8, I4, G1, L2.

### 5. Raw byte stream persistence and parser conformance

**Question:** Can Oracle preserve stdout/stderr byte-for-byte while building ordered normalized events for JSON lines, text chunks, invalid UTF-8, CRLF, split multibyte characters, huge chunks, and final partial lines?

**Method:** Use a fake child process or stream fixture generator that emits split UTF-8 code points, invalid UTF-8, CRLF split across chunks, JSON lines split across many chunks, multiple JSON lines in one chunk, final unterminated lines, mid-line crashes, stderr interleaving, and disk-write failures. Assert raw artifacts and normalized NDJSON byte offsets. Explicitly prohibit JavaScript string-length offset calculations.

**Deliverable:** Byte-offset event schema, raw artifact format decision, parser fixture suite, and examples of normalized events for parse success, parse failure, stderr chunks, and partial final lines.

**Success criteria:** Every received byte is recoverable from raw artifacts or documented byte-safe encoding. Normalized events reference source stream, monotonic receive sequence, timestamp, byte offset, byte length, raw representation, parse status, and extracted visible text when safe. Parse failure never discards raw bytes.

**Kill criteria:** Raw persistence depends on decoded strings or successful JSON parsing. Byte offsets are computed from string lengths. Disk-write failures can still produce successful sessions. Partial streams can be marked complete.

**Effort:** 1-2 days.

**Human minutes:** 0.

**Decision de-risked:** Whether the visible event capture promise is technically sound.

**Contribution notes:** KERNEL from all six modes.

### 6. MCP inline completeness and overflow semantics

**Question:** What exact MCP behavior satisfies "all visible events inline" without lying, truncating, exhausting memory, or breaking clients?

**Method:** Drive fake `fable-local` runs with visible stdout/stderr payloads at representative sizes such as 10 KB, 100 KB, 1 MB, 10 MB, and an intentionally too-large case. Exercise structuredContent serialization, MCP client display, resource URI fallback, memory use, timeout behavior, and response envelopes. Compare abort-on-limit with finish-then-non-success-overflow.

**Deliverable:** Default max inline byte recommendation, overflow status envelope, semantics for `eventsComplete` and `streamsComplete`, raw resource URI behavior, and tests proving successful MCP results never contain partial inline streams.

**Success criteria:** Full success includes every visible stdout event and stderr chunk inline. Overflow is typed non-success or early abort, with `eventsComplete: false`, raw artifact resources, byte counts, and no final answer labeled complete from partial data.

**Kill criteria:** MCP transport/client cannot carry practical complete streams. Existing log-tail behavior is reused. A partial event list can be returned with `eventsComplete: true`.

**Effort:** 0.5-1.5 days.

**Human minutes:** 15 if sponsor must choose overflow policy after measurements.

**Decision de-risked:** Whether MCP `consult` can support `fable-local` success semantics in v1.

**Contribution notes:** KERNEL from all six modes.

### 7. Local-owner and transport eligibility proof

**Question:** Can Oracle reliably distinguish safe local same-user CLI/stdio/socket execution from router, serve, network MCP, remote browser, remote Chrome, bridge, session worker, or hosted contexts before spawning `claude`?

**Method:** Map CLI, MCP stdio, same-user local socket, network MCP, `oracle serve`, router, bridge, remote browser, remote Chrome, session worker, restart, and background paths. Identify signals available at the spawn point: uid, `SUDO_USER`, HOME, Oracle home, session dir ownership, transport kind, remote flags, process context, and MCP launch metadata. Prototype guard decisions with fake contexts.

**Deliverable:** Transport/local-owner eligibility matrix with allow/refuse outcomes, guard API proposal, refusal reason codes, and code hook locations before session creation, worker dispatch, router request, or subprocess spawn.

**Success criteria:** Every active spawn path has a reliable local-only decision before process start. Ambiguous MCP/server/router/network contexts refuse. CLI local use passes under ordinary macOS/Linux owner conditions.

**Kill criteria:** MCP transport locality or same-user ownership cannot be proven. Remote/server/router contexts can reach a local Claude spawn. The implementation would rely on client claims instead of server-side launch facts.

**Effort:** 1 day.

**Human minutes:** 0.

**Decision de-risked:** Whether `fable-local` can safely include MCP in v1 or must be CLI-only.

**Contribution notes:** KERNEL from all six modes.

### 8. Executable provenance and launch-context trust

**Question:** Can Oracle safely resolve and execute the intended Claude Code binary without rejecting common valid installs or accepting malicious repo-local/shim binaries?

**Method:** Survey and fixture-test representative install layouts: official installer, Homebrew, npm global, pnpm, nvm, asdf, Volta, mise, Corepack, direct binary, wrapper script, repo-local shadow, relative path, world-writable component, symlink chain, and unsafe path under the reviewed repo. Use stat metadata and safe temporary trees; do not execute unsafe binaries.

**Deliverable:** Executable resolver policy with allow/deny cases, realpath/symlink recording, doctor diagnostics, and remediation messages.

**Success criteria:** Common legitimate installs pass. Repo-local, relative, unsafe-symlink, world-writable, and shell-wrapper-danger cases fail. The actual child spawn uses an absolute resolved executable with `shell: false` and no prompt on argv.

**Kill criteria:** Valid and malicious shims are indistinguishable. PATH resolution cannot be made safe enough. The product should require explicit trusted executable configuration instead.

**Effort:** 1 day.

**Human minutes:** 0.

**Decision de-risked:** Whether `claude` can be resolved from PATH safely in v1.

**Contribution notes:** Supported by H2, A8, G1.

### 9. Startup verifier decision table

**Question:** Can startup/result verification make deterministic success and non-success decisions from real and synthetic visible Claude Code events?

**Method:** Use Spike 1 empirical fixtures plus negative fixtures for missing auth source, API auth source, unknown auth source, non-Fable init model, non-Fable result `modelUsage`, missing tool list, non-empty tools, active MCP, active hooks/plugins/skills/slash commands, active Chrome, active session persistence, fallback model, unknown schema, and unexpected permission mode.

**Deliverable:** Startup verifier spec with critical fields, allowed values, non-success reason codes, model verification statuses, and fixture table.

**Success criteria:** Only verified safe states pass. Missing critical fields are non-success. Observed non-Fable is non-success. Unknown model evidence does not get mislabeled as verified Fable. Errors explain the failed assertion without leaking sensitive values.

**Kill criteria:** The verifier must guess from absent fields. Requested-only model evidence is accepted as verified Fable. Active tools/config surfaces cannot be detected but still pass.

**Effort:** 0.5-1 day after Spike 1.

**Human minutes:** 0.

**Decision de-risked:** Whether command flags plus visible streams can enforce v1 safety.

**Contribution notes:** KERNEL from all six modes.

### 10. Fake-run vertical slice across CLI, session, artifacts, and MCP

**Question:** Can a fake `claude` run exercise the intended architecture without live Fable usage?

**Method:** Create a fake executable or injected spawn implementation that emits valid startup JSON, visible assistant deltas, stderr chunks, result metadata, controlled parse failures, nonzero exits, and startup mismatches. Run it through `--lane fable-local`, lane policy, env/local guards, session creation, lock acquisition, raw persistence, normalized events, final answer extraction, adapter metadata, session render, and MCP `consult` with inline events.

**Deliverable:** Vertical-slice fixture report and state diagram proving the intended orchestration order and artifacts.

**Success criteria:** Fake success produces a completed session, typed artifacts, final answer, adapter metadata, and MCP structured result without live provider calls. Fake failures preserve partial raw streams and mark non-success.

**Kill criteria:** The architecture cannot be tested without live Claude Code. Test seams require excessive product rewiring. Any live-run implementation would need to precede fake-run reliability.

**Effort:** 2 days.

**Human minutes:** 0.

**Decision de-risked:** Whether implementation can proceed with fake-run tests as the default safety net.

**Contribution notes:** Supported by F7, H2, G1.

### 11. Lifecycle, process-tree, timeout, and lock failure drill

**Question:** Can Oracle stop Claude Code and descendants, release the single-flight lock, and preserve partial streams on timeout, Ctrl-C, nonzero exit, startup mismatch, read-only violation, and output flood?

**Method:** Use fake children that spawn grandchildren, ignore SIGTERM, write partial lines, flood stdout/stderr, hang waiting for input, exit nonzero, and trigger verifier/read-only failures. Simulate Ctrl-C, timeout, stale lock, fail-fast lock contention, and `--wait-for-lock` if proposed. Inspect lock state through the lock API.

**Deliverable:** Lifecycle state machine, process-tree termination notes for macOS/Linux, lock metadata/stale recovery rules, busy error text, and failure fixtures.

**Success criteria:** At most one `fable-local` child is live for the lock scope. All terminal paths release or recover locks, preserve partial raw artifacts where possible, mark `eventsComplete` honestly, and leave no child/grandchild running.

**Kill criteria:** Detached/background behavior is required to make cleanup work. Children can continue running after Oracle reports failure. Stale locks require manual deletion without audit.

**Effort:** 1-2 days.

**Human minutes:** 0.

**Decision de-risked:** Whether v1 attached-only single-run semantics are operationally safe.

**Contribution notes:** Supported by H2, A8, I4, G1.

### 12. Prompt assembly and supplied-context workload fit

**Question:** Can Oracle's existing prompt/file bundle pipeline support useful Fable reviews while Claude Code has zero file tools and receives the bundle only through stdin?

**Method:** Feed existing prompt assembly into a fake Claude runner. Cover globs, large files, binary files, unreadable files, excluded secrets, `.env`-like names, absolute/relative paths, hostile prompt injection inside file content, prompt suffix/config behavior, and stdin EOF. Confirm prompt text never appears on argv and raw Claude pass-through args are impossible.

**Deliverable:** Supplied-context bundle contract for `fable-local`, including size limits, exclusion behavior, stdin shape, review-mode prefix, and workload examples.

**Success criteria:** Existing prompt assembly can provide useful review context without granting Claude Code `Read`, `Grep`, or `Glob`. File exclusions and size checks remain Oracle-owned. `child.stdin.end()` behavior is deterministic.

**Kill criteria:** Real review bundles cannot fit or be represented without Claude Code file tools. Secret exclusions cannot be preserved. Prompt must be passed on argv.

**Effort:** 1 day.

**Human minutes:** 0.

**Decision de-risked:** Whether no-tool supplied-context review is viable for intended use.

**Contribution notes:** Supported by F7 and H2.

### 13. Provider boundary and model alias invariant proof

**Question:** Can `fable` and `claude_code_fable_5` be represented without leaking into Anthropic API, OpenRouter, Azure, existing Claude API models, or `--models` fan-out?

**Method:** Inspect provider boundary and API substitution guard integration points. Use fake provider clients that fail if invoked. Test `--engine api --model fable`, `--model claude-4.6-sonnet`, `--models gpt-5.5-pro,fable`, exact `--engine claude-code --model fable`, MCP lane and engine/model compatibility forms, and unsupported model aliases.

**Deliverable:** Provider/model routing invariant list, local-only model alias strategy, and fixture cases proving `claude_code_fable_5` requires `claude_code_subscription_cli` and rejects `anthropic_api`.

**Success criteria:** `fable` is scoped only to `claude-code` or `fable-local`. API/fan-out paths route-block before provider selection. Existing Claude API models remain in code but are gated for normal agent starts.

**Kill criteria:** The shared model registry cannot prevent API leakage. `--model fable` can reach Anthropic API or OpenRouter. Multi-model fan-out can start local Claude Code.

**Effort:** 0.5-1 day.

**Human minutes:** 0.

**Decision de-risked:** Whether model alias work belongs in shared registries or isolated Claude Code types.

**Contribution notes:** Supported by F7, A8, G1, L2.

### 14. Browser selector-state proof without submission

**Question:** Can ChatGPT Pro Extended Reasoning and Gemini Deep Think availability and selected state be proven without submitting a prompt, changing model state unsafely, or clicking `Answer now`?

**Method:** Use existing Oracle browser diagnostics, fake DOM/controller fixtures, and optionally kept-browser non-submitting inspection. For ChatGPT, verify signed-in state, Pro model availability, Extended Reasoning selection, archive/attachment defaults, and absence of forbidden `Answer now` interaction. For Gemini, verify signed-in state, Deep Think availability, and selected mode. Record ready, signed-out, unavailable, wrong-mode, changed, and `selector_state_unknown` outcomes.

**Deliverable:** Browser lane doctor feasibility memo, DOM/state evidence requirements, doctor JSON examples, and runtime pre-submit assertion contract.

**Success criteria:** Each browser lane can prove selector state without prompt submission in normal signed-in conditions, or reports `selector_state_unknown` and not-ready. Runtime can abort before prompt submission if selector state changes.

**Kill criteria:** Readiness depends on sending a prompt, guessing from UI text, clicking `Answer now`, or accepting unknown selector state as ready.

**Effort:** 1-3 days.

**Human minutes:** 10-30 for login/Cloudflare/manual clearance if needed.

**Decision de-risked:** Whether browser lanes can be advertised as reviewed lanes in the same v1 surface.

**Contribution notes:** KERNEL from F7, H2, I4, G1, L2.

### 15. Browser lane drift and pre-submit abort rehearsal

**Question:** Does browser lane verification stay valid at the irreversible submit point, especially when account UI, folder/workspace URLs, model picker state, or assistant snapshot behavior changes after lane resolution?

**Method:** Use fake browser controllers and kept-browser non-submitting scenarios to simulate selector state changing between lane resolution and prompt submission, Cloudflare interstitials, folder/workspace URLs, stale assistant snapshots, wrong selected model, unavailable Pro/Deep Think controls, and `Answer now` placeholders. Confirm runtime aborts before prompt submission.

**Deliverable:** Browser runtime re-verification insertion points, abort reason codes, stale snapshot handling notes, and fake-controller tests.

**Success criteria:** Browser runners re-check exact lane state immediately before submit. State changes abort before prompt submission. `Answer now` is never clicked. Stale assistant snapshots are detected before declaring success.

**Kill criteria:** Browser state is checked only during doctor or lane resolution. Runtime can submit after selector drift. Assistant echo/flattening can be misclassified as valid output.

**Effort:** 1 day.

**Human minutes:** 0-20 if a kept browser session needs manual clearance.

**Decision de-risked:** Whether browser lanes can meet the same reviewed-lane standard as route policy.

**Contribution notes:** Supported by F7, H2, A8, I4.

### 16. MCP launch-context subscription-auth validation

**Question:** Does `oracle-mcp` launched from real MCP clients see the same Claude Code subscription auth, HOME, PATH, and safe environment as the user's interactive shell?

**Method:** Launch `oracle-mcp` from a fresh representative MCP client. Run doctor/preflight first without model prompts. After Spikes 1, 3, 6, 7, and 8 pass, optionally run one tiny `fable-local` MCP smoke. Compare executable path, environment allowlist, auth source, startup fields, session artifacts, and inline event completeness with CLI behavior.

**Deliverable:** MCP launch-context compatibility matrix and docs recommendation for supported client launch contexts or CLI-only limitation.

**Success criteria:** MCP launch context preserves safe local subscription access and all guards pass. Inline events and raw resources behave as specified.

**Kill criteria:** MCP lacks subscription auth, has ambiguous transport identity, inherits unsafe env/settings, or cannot prove same-user local execution. V1 should become CLI-only for `fable-local` or require explicit setup.

**Effort:** 0.5-1 day after guard spikes.

**Human minutes:** 20-30 for MCP client setup/login and opt-in smoke approval.

**Decision de-risked:** Whether MCP `consult` can support `lane: "fable-local"` in v1.

**Contribution notes:** Supported by H2, I4, G1, L2.

### 17. Artifact privacy, redacted export, and purge policy

**Question:** How should Oracle store, classify, display, redact, and purge sensitive raw Claude Code event artifacts?

**Method:** Inspect current artifact kinds, session render, cleanup, redacted export, and resource URI patterns. Use fake raw streams containing sensitive-looking paths, prompts, stderr warnings, control characters, and file snippets. Define typed artifact kinds, owner-only expectations, symlink refusal, default render behavior, local path exposure rules, redacted export exclusion, and purge command scope.

**Deliverable:** Artifact privacy policy for `claude-code-stdout-raw`, `claude-code-stderr-raw`, `claude-code-events-normalized`, `claude-code-adapter`, final answer, and progress artifacts.

**Success criteria:** Raw streams are typed and excluded from redacted exports by kind. Session render does not dump raw streams by default. Network-facing MCP uses resource URIs instead of absolute local paths. Purge behavior is explicit and reversible only by normal backups.

**Kill criteria:** Raw streams are stored as generic files. Redacted exports include raw streams by default. Symlink redirection can write outside the session. Purge scope is ambiguous enough to delete unintended artifacts.

**Effort:** 0.5-1 day.

**Human minutes:** 15 if sponsor must choose purge scope.

**Decision de-risked:** Whether full raw persistence can coexist with local privacy expectations.

**Contribution notes:** Supported by H2, A8, I4, G1.

### 18. Route-block self-correction for calling agents

**Question:** Can a calling agent recover from unsupported or vague Oracle invocations using only the route-block error and `oracle capabilities --json`?

**Method:** Use fake CLI and MCP policy cases for bare prompt, `--engine api --model claude-4.6-sonnet`, `--model gpt`, exact `--model gpt-5.5-pro`, `--lane fable-local --engine browser`, MCP prompt-only, and MCP conflicting lane/engine. Inspect human stderr and JSON error envelopes for actionable replacement commands and machine-readable fields.

**Deliverable:** Route-block self-correction contract with sample stderr, JSON envelopes, and fields required for one-step retry.

**Success criteria:** Every rejected active route includes attempted route, block reason, policy version, source precedence, supported lanes with exact command templates, exit code `2`, and `noBackendStarted: true`. An agent can retry without reading docs.

**Kill criteria:** Errors say only "see help". Replacement commands are placeholders. JSON lacks enough structure for MCP agents. Prompt text or secrets leak into errors.

**Effort:** 0.5 day.

**Human minutes:** 0.

**Decision de-risked:** Whether the lane gate improves agent behavior instead of creating bypass pressure.

**Contribution notes:** Supported by A8, I4, G1, L2.

### 19. Help, capabilities, schema, and replacement-command single source

**Question:** Can top-level help, MCP schema, capabilities JSON, route-block replacements, doctor lane list, and tests derive from one lane registry without drift?

**Method:** Sketch or prototype registry data for `chatgpt-pro`, `gemini-deep-think`, and `fable-local`. Generate sample top-level help lane section, `oracle capabilities --json`, MCP `lane` enum, route-block supported-lane output, doctor lane records, and lane policy test cases from the same data.

**Deliverable:** Lane registry data-shape proposal and generated sample outputs for all public/machine surfaces.

**Success criteria:** Adding or removing a lane changes all surfaces through one data definition. Snapshot tests catch drift. Exact replacement commands include material defaults such as ChatGPT Pro extended thinking and browser archive/attachment behavior.

**Kill criteria:** Lane names, replacement commands, or readiness metadata must be hand-maintained across CLI, MCP, docs, and tests. Capabilities and help can disagree.

**Effort:** 0.5-1 day.

**Human minutes:** 0.

**Decision de-risked:** Whether the agent-facing lane UX stays stable as implementation evolves.

**Contribution notes:** Supported by I4, G1, L2.

### 20. Existing Oracle integration seam map

**Question:** Where exactly should lane policy, `claude-code` engine mode, session metadata, MCP schema, and route-block errors hook into existing Oracle code without duplicating routing logic?

**Method:** Read the current integration files named in the plan: CLI engine and run options, session runner/display/lifecycle/dry-run, session store/manager, MCP types/utils/consult/session resources, provider boundaries, API substitution guard, and relevant tests. Produce an active/passive entrypoint map and mark pre-backend insertion points.

**Deliverable:** File-by-file seam map with insertion points, passive commands that must not invoke lane resolution, active lifecycle flows that must route-block, and test targets.

**Success criteria:** There is a small number of enforceable chokepoints for CLI and MCP active runs plus a shared engine-flow helper for lifecycle refusals. Implementation can be decomposed by disjoint write sets.

**Kill criteria:** Every provider/runner would require ad hoc checks. Passive commands are entangled with active route resolution. Route-block cannot happen before session worker or provider side effects.

**Effort:** 1 day.

**Human minutes:** 0.

**Decision de-risked:** Whether implementation can proceed without bypass-prone routing duplication.

**Contribution notes:** Supported by F7, G1, L2.

### 21. Sequencing split: adapter-first versus gate-first

**Question:** Should implementation start with a hidden explicit Claude Code adapter slice, the full three-lane gate, or a shared skeleton that supports both without public exposure?

**Method:** Produce two or three thin vertical-slice plans from the seam map: adapter-first expert `--engine claude-code --model fable`, gate-first `--lane` registry with fake backends, and shared skeleton with no live backend. Estimate touched files, review size, safety regression risk, and which sponsor promises each slice can and cannot make.

**Deliverable:** Sequencing recommendation with dependency graph, phase gates, and explicit cut lines for first implementation PRs.

**Success criteria:** Maintainers can name a fake-run milestone, opt-in live local milestone, MCP milestone, and agent-facing beta milestone with crisp prerequisites.

**Kill criteria:** All sequences require completing browser selector doctors, MCP overflow semantics, and Fable local live integration before any useful learning. A preliminary architecture refactor is required instead.

**Effort:** 0.5 day.

**Human minutes:** 30 to confirm release appetite and whether all three lanes must ship together.

**Decision de-risked:** Whether implementation should be staged or one large release.

**Contribution notes:** Disputed by modes, routed to sponsor decision after evidence.

### 22. Compliance and public wording check

**Question:** Is the planned local wrapper around Claude Code subscription usage acceptable under current Anthropic/Claude Code public docs, support guidance, account terms, and the user's local-only workflow?

**Method:** Review current official Anthropic/Claude Code docs and support articles for headless mode, Pro/Max usage, API-key environment variables, model selection, and terms-relevant wording. Produce a dated note distinguishing local owner use from hosted proxying, credential collection, API substitution, and subscription relay behavior. Do not rely on stale plan citations.

**Deliverable:** Dated compliance and wording memo with approved phrases, prohibited phrases, uncertainty notes, and release posture recommendation: normal lane, experimental local-only mode, hidden expert mode, or do-not-release.

**Success criteria:** Behavior and wording are clearly local-owner-only, non-hosted, not credential-collecting, not an API substitute, and not misleading about billing/quota certainty.

**Kill criteria:** Current terms or docs make the intended use ambiguous or disallowed. Public wording would imply provider billing guarantees or hidden state Oracle cannot observe.

**Effort:** 0.5 day.

**Human minutes:** 30-60 for sponsor acceptance of any legal/compliance ambiguity.

**Decision de-risked:** Whether and how this can be documented publicly.

**Contribution notes:** Supported by H2, I4, L2.

### 23. Live local CLI smoke after fake gates pass

**Question:** After empirical contract, guards, fake runner, stream persistence, and startup verifier pass, does CLI `--lane fable-local` work with the user's actual subscription auth and persist visible events correctly?

**Method:** Run one opt-in tiny prompt only after earlier gates pass and blocked env vars are absent. Capture session id, sanitized startup/result observations, raw artifact presence, normalized event presence, final answer extraction, model verification status, auth-source status, cost/credit uncertainty fields, and session render behavior. Keep prompt minimal.

**Deliverable:** Live CLI smoke report with session id, artifact inventory, sanitized verifier decisions, and any login/context caveats.

**Success criteria:** No blocked env vars. No API/provider auth source. Claude starts locally with expected command shape. Raw stdout/stderr and normalized events persist. Final smoke token appears. Startup/result verifier passes or produces expected non-success that narrows release claims.

**Kill criteria:** Live use succeeds only by weakening no-tool/auth/local guards. Raw persistence fails. Session render misrepresents partial/failed output. API billing path is observed or ambiguous.

**Effort:** 0.5 day after implementation gates.

**Human minutes:** 20-30 for opt-in usage and local login if needed.

**Decision de-risked:** Whether fake-run validated behavior survives real Claude Code CLI execution.

**Contribution notes:** Release validation only, not a substitute for earlier spikes.

### 24. Live MCP and browser smoke after doctor readiness

**Question:** After non-submitting doctor readiness and MCP launch-context checks pass, do the final advertised MCP and browser lane surfaces work in real operator contexts?

**Method:** Run MCP `consult` with `lane: "fable-local"` only after MCP context validation passes. Run browser lane smokes only when doctor proves selector state without prompt submission and the human opts in. For ChatGPT Pro, never click `Answer now`. For Gemini, confirm Deep Think readiness before submit. Record session ids, raw/inline event completeness, selector-state proof, final smoke tokens, and any manual clearance steps.

**Deliverable:** Final live surface smoke report covering MCP Fable, ChatGPT Pro lane, and Gemini Deep Think lane as applicable.

**Success criteria:** MCP returns complete inline events or honest overflow non-success with raw resources. Browser lanes prove selector state before submit and capture outputs without flattening/echo misclassification. All sessions are replayable.

**Kill criteria:** MCP launch context lacks auth/local proof. Browser readiness cannot be proven without prompt submission. ChatGPT `Answer now` is required or clicked. Output capture is incomplete but labeled successful.

**Effort:** 0.5-1 day after implementation gates.

**Human minutes:** 30-60 for opt-in browser login/Cloudflare/subscription usage.

**Decision de-risked:** Whether the user-facing reviewed lanes are ready for beta release.

**Contribution notes:** Release validation only; browser failures should not retroactively invalidate Fable local safety work.

## Routed-out items

### Human value calls

- Whether all three reviewed lanes must ship together, or whether `fable-local` can land as an internal/experimental expert lane first.
- Whether bare `oracle --prompt ...` should route-block throughout v1 or an outer wrapper will always provide `--lane`.
- The default MCP inline byte limit.
- Whether inline overflow aborts immediately or lets the run finish and returns typed non-success with complete raw artifacts.
- Whether raw-event purge deletes only Claude Code artifacts or the whole Oracle session.
- Whether `--write-output` should support raw/normalized event output or final answer only.
- Whether lock contention should fail immediately by default or prominently support `--wait-for-lock`.
- Whether ChatGPT Pro and Gemini Deep Think lanes may use existing remote browser workers in v1.
- Whether `--engine claude-code --model fable` should be hidden from help or documented as expert compatibility.
- How much friction is acceptable from hard env-var refusal instead of automatic unset.

### Implementation tasks, not spikes

- Add `EngineMode = "claude-code"`.
- Add `LaneRegistry`, `lanePolicy`, lane help, and route-block modules after the policy shape is selected.
- Add route-block JSON and exit code `2`.
- Add provider boundary slot `claude_code_fable_5`.
- Wire command builder, env guard, config guard, executable resolver, local owner guard, startup verifier, stream parser, runner, lock, session metadata, MCP schema, session resources, and artifact paths.
- Update README, CLI reference, MCP docs, Anthropic docs, configuration docs, manual tests, and changelog after implementation when user-facing impact is confirmed.
- Add unit tests and fixtures for already chosen behavior.
- Add CLI help ordering and capabilities schema once the lane registry is selected.

### Duplicate validations to consolidate

- Provider boundary and API substitution guard tests should share one fixture proving `claude_code_fable_5` requires `claude_code_subscription_cli` and rejects `anthropic_api`.
- Route-block tests should validate one central policy resolver, then sample representative CLI/MCP entry points rather than duplicate every conflict at every layer.
- Privacy checks for environment values should run against shared error/metadata serializers.
- Raw artifact owner-only and symlink behavior should be proven once through the artifact writer, then referenced by CLI and MCP tests.

### Experiments that are not spikes without kill criteria

- Running `claude --version` by itself.
- Capturing docs or help output without required-flag and required-field pass/fail criteria.
- Updating command-builder fixtures after empirical capture.
- Running a happy-path live smoke after implementation.
- Adding doctor output after checks are already known.
- Writing docs that say local-only, no API, read-only, and visible-output-only.

## Consolidated sponsor asks

1. Confirm whether the three-lane gate is mandatory before any agent-facing beta, or whether a hidden/experimental `fable-local` alpha may land first.
2. Confirm that hard refusal on `ANTHROPIC_API_KEY` and other blocked env/provider sources should remain refusal-only, with no automatic unset or child-only hiding.
3. Choose MCP overflow policy after Spike 6 provides measurements: abort immediately or finish and return typed non-success.
4. Choose raw purge scope after Spike 17: Claude Code artifacts only or entire sessions.
5. Decide whether browser lanes may use remote browser workers in v1, or all reviewed lanes must be local-only.
6. Decide whether `--wait-for-lock` is a prominent v1 feature or lock contention fails fast by default.
7. Decide whether expert compatibility form `--engine claude-code --model fable` is public help text, hidden but accepted, or not accepted.
8. Accept or reject the compliance wording from Spike 22 before public docs or npm release.

## Method and provenance

The source corpus was the root workspace rules, the Oracle repo rules, and `docs/plans/claude-code-subscription-adapter.md`. Supporting artifacts for this planning run are under `.planning-runs/claude-code-subscription-adapter-spikes-2026-07-02/`.

The reasoning method was adapted from the `/modes-of-reasoning-project-analysis` skill. The human requested a six-agent Codex swarm using GPT-5.5 xHigh. The six selected modes were:

- F7 Systems-Thinking: `.planning-runs/claude-code-subscription-adapter-spikes-2026-07-02/MODE_OUTPUT_F7_SYSTEMS.md`.
- H2 Adversarial Review: `.planning-runs/claude-code-subscription-adapter-spikes-2026-07-02/MODE_OUTPUT_H2_ADVERSARIAL.md`.
- A8 Edge-Case/Formal Contract: `.planning-runs/claude-code-subscription-adapter-spikes-2026-07-02/MODE_OUTPUT_A8_EDGE_CONTRACT.md`.
- I4 Perspective-Taking: `.planning-runs/claude-code-subscription-adapter-spikes-2026-07-02/MODE_OUTPUT_I4_PERSPECTIVE.md`.
- G1 Decision Analysis: `.planning-runs/claude-code-subscription-adapter-spikes-2026-07-02/MODE_OUTPUT_G1_DECISION.md`.
- L2 Debiasing/Calibration: `.planning-runs/claude-code-subscription-adapter-spikes-2026-07-02/MODE_OUTPUT_L2_DEBIASING.md`.

Synthesis artifacts:

- Context pack: `.planning-runs/claude-code-subscription-adapter-spikes-2026-07-02/CONTEXT_PACK.md`.
- Mode selection record: `.planning-runs/claude-code-subscription-adapter-spikes-2026-07-02/MODE_SELECTION.md`.
- Synthesis record: `.planning-runs/claude-code-subscription-adapter-spikes-2026-07-02/SYNTHESIS.md`.

KERNEL clusters preserved in the synthesis record:

- Empirical Claude Code contract is the first kill gate.
- No-tool/read-only enforcement must be proven, not prompted.
- Lane gate must be a central start gate before backends.
- Raw stream persistence and MCP inline completeness are independent product contracts.
- Local-only, executable trust, and MCP transport are pre-spawn blockers.
- Browser lane readiness is separate from Fable adapter viability.

This `SPIKE.md` is intentionally additive and planning-only. It does not amend the current plan or decide sponsor policy.

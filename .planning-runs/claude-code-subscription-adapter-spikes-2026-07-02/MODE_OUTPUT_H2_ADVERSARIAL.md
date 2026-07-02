# H2 Adversarial Review: Safety and Abuse-Case Pressure Test

## Thesis

The plan is correctly biased toward fail-closed behavior, but its safety story depends on empirical properties that may not exist or may not be stable in Claude Code: observable startup fields, true no-tool execution, subscription-auth distinguishability, disabled config surfaces, and reliable local-only transport detection. The highest-value spike portfolio should therefore try to falsify those boundaries before implementation, not merely confirm the happy path.

The feature should be treated as three separable risk clusters: the `fable-local` Claude Code adapter, the global three-lane product gate, and the browser-lane runtime verifiers. Coupling all three into one first implementation increases blast radius. A clean negative result in any spike is useful if it forces a narrower v1, such as CLI-only Fable, no MCP Fable, no browser lane release, or no Claude Code local mode until Claude exposes enough verifiable state.

## Findings

### Finding 1: Observability is the real safety boundary

The plan says to fail closed if startup fields do not prove subscription auth, Fable model selection, empty tools, empty MCP servers, inactive hooks/plugins/skills/slash commands, no Chrome integration, and disabled persistence. That is the right posture, but it means the feature is only shippable if Claude Code visibly exposes these facts with stable enough fields. If those fields are missing, renamed, delayed until after work starts, or ambiguous, implementation effort cannot make the mode safe.

### Finding 2: `--tools ""` is a kill-switch assumption, not a detail

The plan's read-only claim depends on disabling all Claude Code tools. If `--tools ""` is rejected, interpreted as default tools, does not cover hidden agents/hooks, or still allows non-obvious tools, the entire v1 security model changes. Do not let implementation fall back to `allowedTools` or prompt instructions; a clean failure here should kill or defer `fable-local`.

### Finding 3: Billing avoidance is broader than `ANTHROPIC_API_KEY`

The explicit API-key refusal is necessary, but an adversarial path can come through Claude Code settings, managed policy, auth helpers, fallback model configuration, Bedrock/Vertex/Foundry routing, inherited MCP launch environments, or wrapper binaries. The plan recognizes many of these, but the spike portfolio should prove whether they are detectable before any subprocess starts or visible in startup events immediately after spawn.

### Finding 4: Local-only can become a subscription relay through non-obvious entry points

`oracle serve`, MCP over network, router contexts, remote browser configuration, background workers, restart/follow-up flows, and future session workers all create opportunities to turn the user's local Claude subscription into a multi-user or remote service. The lane policy must run before session creation and backend start. If transport identity is not visible at the policy layer, MCP `fable-local` should be cut from v1.

### Finding 5: The browser lane gate is a separate high-risk project

ChatGPT Pro and Gemini Deep Think runtime verification require proving UI selector state without submitting prompts and without clicking "Answer now". That work is valuable, but it is not required to answer whether local Claude Code can be safely wrapped. It should be spiked separately so fragility in browser selectors does not block learning about the Fable adapter, and vice versa.

### Finding 6: Full inline events can conflict with transport and resource limits

The plan requires MCP success to include every visible stdout and stderr event inline. Long Fable runs can be large. Without empirical payload limits, implementation may either lie by truncating, crash clients, or buffer unbounded data. This is a product boundary, not just a schema choice: define what size succeeds, what size fails, and whether overflow aborts early or returns non-success after raw persistence.

### Finding 7: Raw event persistence is both a fidelity promise and a privacy hazard

Exact raw stdout/stderr persistence is required, but it can capture sensitive file snippets, paths, control characters, prompt content, and any secret Claude Code visibly prints. The artifact writer must be treated as a security component: exact byte preservation, owner-only modes, symlink refusal, crash-safe partial writes, and redacted-export exclusion all need proof before live use.

### Finding 8: Executable trust can reject real installs or accept malicious shims

The plan wants safe absolute realpaths and rejects repo-local, world-writable, and unsafe symlink executables. That is correct, but modern `claude` installs may involve npm/pnpm/nvm/asdf/corepack shims or wrapper scripts. A naive resolver can either break normal users or run a hostile shim. This should be resolved before command-builder work hardcodes assumptions.

### Finding 9: Process lifecycle failure can leave real work running

Timeouts, Ctrl-C, startup-verifier failures, and read-only violation aborts must kill process trees, release locks, and preserve partial raw streams. If the child spawns grandchildren or ignores signals, Oracle can falsely report failure while Claude continues running. This is especially risky for a local subscription path because long-running hidden work can keep consuming quota and produce uncaptured output.

### Finding 10: The plan is intentionally strict, but strictness can cause bypass pressure

A three-lane-only gate, no default lane, no `--models`, no follow-up/resume/background, and route-block before session creation are good safety choices. They will also break existing agent habits. If errors are too late, vague, or inconsistent across CLI/MCP, agents will look for legacy paths. The gate must be tested as a product surface, not just as an internal resolver.

## Assumptions

This review assumes the three reviewed lanes are a product requirement for v1 agent-facing Oracle, not merely docs wording.

This review assumes `fable-local` must remain local-owner-only, read-only, no-tool, no hidden session persistence, and non-hosted.

This review assumes live Claude Code, ChatGPT Pro, and Gemini Deep Think probes remain opt-in and should not be run by default.

This review does not verify current Anthropic or Claude Code external documentation. Provider behavior and terms should be checked during the dedicated spikes.

This review uses only the plan as source context and does not inspect implementation files.

## Calibrated Confidence

Confidence 0.86: The highest-risk decisions are empirical, especially no-tool behavior, startup observability, auth-source distinguishability, local-only enforcement, and full inline event limits.

Confidence 0.78: The proposed spikes below are likely to change the final portfolio by killing or narrowing at least one candidate workstream if run honestly.

Confidence 0.62: The lane gate and adapter can be implemented safely in the same release only if the bypass map is small and browser selector verification is already close to reusable.

Confidence 0.45: Current Claude Code exposes all critical safety fields needed by the startup verifier. This must be proven; it should not be assumed.

Confidence 0.35: Current provider policy and support wording are stable enough for public docs without a fresh compliance check.

## Mandatory Proposed Spikes

### Spike 1: Empirical Claude Code Safety Contract

**Question:** Does the installed Claude Code expose enough visible, stable data to prove subscription auth, requested Fable model, no tools, no MCP servers, inactive config surfaces, disabled persistence, and result model usage?

**Method:** Run the non-live help/version commands and opt-in tiny subscription probes with a sanitized environment. Capture normal, `--bare`, `--tools ""`, and `ANTHROPIC_MODEL` precedence cases. Save the raw `system/init` and final result events as sanitized fixtures. Do not start code implementation until the contract is recorded.

**Deliverable:** A fixture bundle plus a decision table listing observed fields, allowed auth-source values, model evidence, tool evidence, config-surface evidence, and unsupported or ignored flags.

**Success-or-kill criteria:** Success if startup/result events visibly prove all critical v1 assertions or cleanly identify a narrower viable command shape. Kill or defer `fable-local` if auth source is unknown, tools cannot be proven empty, critical fields are absent, or Fable cannot be observed when Claude exposes actual model usage.

**Effort:** 0.5 to 1 day, assuming the user has a logged-in subscription account and opts into the tiny probes.

**Decision de-risked:** Whether local Claude Code mode can ship at all, and which flags the command builder may emit.

### Spike 2: No-Tool Read-Only Red Team

**Question:** Can hostile prompt or file content cause Claude Code to read extra files, run tools, mutate state, ask for permissions, launch subagents, or activate hooks despite the proposed v1 flags?

**Method:** Use fake fixtures and one opt-in real probe with adversarial supplied content such as requests to read `~/.ssh`, `.env`, repo files outside the bundle, or to run shell commands. Include local canary files that should never appear. Watch startup tools and visible events; do not rely on the model's final text as proof.

**Deliverable:** A red-team transcript, a list of observed startup/event tripwires, and tests that fail if any tool surface appears in v1 mode.

**Success-or-kill criteria:** Success if tools are visibly empty and no read/write/shell/subagent events appear. Clean negative success if the probe proves no-tool mode is impossible, because that kills unsafe v1 before implementation. Kill `fable-local` read-only claims if any tool remains available or if Claude Code can access files outside Oracle's prompt bundle.

**Effort:** 0.5 to 1 day.

**Decision de-risked:** Whether v1 can honestly be read-only supplied-context review, or must not use Claude Code for this feature.

### Spike 3: Auth and Billing Escape Matrix

**Question:** Which environment variables, Claude Code settings, auth helpers, managed policies, provider modes, or fallback settings can route the run away from local subscription use?

**Method:** Build a matrix for blank/case-variant `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_DEFAULT_*`, `ANTHROPIC_MODEL`, Bedrock/Vertex/Foundry toggles, fallback settings, API-key helpers, and console/API auth mode. Use fake settings where possible. For each case, verify refusal happens before subprocess spawn or immediately at startup verification without leaking values.

**Deliverable:** A guard matrix with allowed, scrubbed, and refused inputs; sanitized fixture events for detected auth sources; and exact error wording.

**Success-or-kill criteria:** Success if every known billing/proxy path is either refused before spawn or visibly detected and stopped. Kill or narrow v1 if subscription auth and API/provider auth cannot be distinguished, or if settings helpers can activate after the preflight guard without visible startup evidence.

**Effort:** 1 day.

**Decision de-risked:** The env/config guard allowlist, refusal set, and whether `ANTHROPIC_MODEL` can be scrubbed or must be refused.

### Spike 4: Local-Only Transport and Relay Abuse

**Question:** Can any CLI, MCP, `oracle serve`, router, remote browser, restart, follow-up, background, or session-worker path invoke `fable-local` as a remote or multi-user subscription relay?

**Method:** Map every active start path and insert test doubles at API request creation, browser launch, Claude spawn, MCP mapping, session worker start, and router request creation. Exercise local stdio MCP, local socket MCP, network MCP, serve/router contexts, remote browser flags, and lifecycle commands.

**Deliverable:** A transport eligibility matrix and route-block tests proving `noBackendStarted: true` for disallowed contexts.

**Success-or-kill criteria:** Success if every network, router, serve, bridge, remote, and lifecycle context blocks before backend start. Clean negative success if MCP cannot expose enough transport identity; in that case, cut MCP `fable-local` from v1 and keep CLI-only.

**Effort:** 0.5 to 1 day.

**Decision de-risked:** Whether MCP can support `fable-local` in v1 or whether local Claude Code must be CLI-only.

### Spike 5: Claude Executable Trust and Launch Context

**Question:** Can Oracle safely resolve and execute the intended Claude Code binary without rejecting common valid installs or accepting malicious repo-local/shim binaries?

**Method:** Test resolver behavior against representative Homebrew, npm, pnpm, nvm, asdf, corepack, absolute binary, wrapper script, repo-local shadow, relative path, world-writable component, and symlink-chain cases. Do not run the binary during unsafe-path tests; use fixtures and stat metadata.

**Deliverable:** An executable resolver policy with allow/deny cases, metadata fields, and user-facing remediation messages.

**Success-or-kill criteria:** Success if common valid install shapes pass and hostile shadows fail. Kill or defer automatic PATH resolution if valid and malicious shims are indistinguishable; require an explicit trusted executable path instead.

**Effort:** 1 day.

**Decision de-risked:** Whether `claude` can be resolved from PATH safely and what install docs must say.

### Spike 6: Raw Byte Persistence and Privacy Boundary

**Question:** Can Oracle preserve exact stdout/stderr bytes securely across malformed output, crashes, and symlink attacks while keeping raw artifacts out of redacted exports?

**Method:** Use fake children that emit invalid UTF-8, split multibyte sequences, CRLF, terminal control characters, huge chunks, final partial lines, and crash mid-line. Attempt symlinked artifact paths. Check file modes, ownership behavior, normalized offsets, and redacted export exclusion.

**Deliverable:** Artifact-writer and stream-parser fixture suite plus a raw-artifact privacy note for docs.

**Success-or-kill criteria:** Success if exact bytes are recoverable, offsets are byte-accurate, files are owner-only where supported, symlinks are refused, and redacted exports exclude typed raw artifacts by default. Kill live use if raw persistence can silently fail or write through attacker-controlled paths.

**Effort:** 1 day.

**Decision de-risked:** The raw artifact design, parser design, and privacy/export behavior.

### Spike 7: MCP Inline Completeness Budget

**Question:** What inline event size can MCP realistically return without truncation, client failure, or unbounded buffering?

**Method:** Drive fake `fable-local` runs with visible event payloads at 4 KB, 256 KB, 1 MB, 10 MB, and a deliberately too-large case. Exercise JSON serialization, structured content, resource URI fallback, and overflow behavior. No live model usage is needed.

**Deliverable:** A recommended default `ORACLE_CLAUDE_CODE_MAX_INLINE_BYTES`, a typed overflow envelope, and tests proving `eventsComplete` is true only for complete inline streams.

**Success-or-kill criteria:** Success if practical review-sized streams can be returned complete and overflow is honest non-success. Kill MCP success semantics if the transport cannot carry even small complete streams; in that case, MCP must not promise full inline events for v1.

**Effort:** 0.5 to 1 day.

**Decision de-risked:** MCP schema, default inline limit, and abort-vs-finish overflow policy.

### Spike 8: Lane Gate Bypass and Regression Map

**Question:** Can any active run path start API, browser, Claude Code, router, or worker backends without a resolved reviewed lane?

**Method:** Add instrumentation or test doubles at all irreversible backend start points. Run table-driven cases for bare prompt, config-only engine, env-only engine, prior-session defaults, `--models`, ambiguous browser/API models, explicit lane conflicts, dry runs, restart, follow-up, resume, continue, background, and MCP consult.

**Deliverable:** A bypass map, route-block error snapshots, and a minimal `LaneRegistry` contract that generates help, capabilities, MCP enum values, and supported-lane replacements from one source.

**Success-or-kill criteria:** Success if every unsupported active route blocks with exit code 2 and `noBackendStarted: true`. Clean negative success if current architecture cannot centralize policy before side effects; that forces a separate lane-gate refactor before any public adapter release.

**Effort:** 1 to 2 days.

**Decision de-risked:** Whether the lane gate must be implemented before the Claude Code adapter, and how much existing CLI/MCP architecture must change.

### Spike 9: Browser Lane Selector Proof Without Submission

**Question:** Can ChatGPT Pro Extended Reasoning and Gemini Deep Think readiness be proven without submitting a prompt, changing model state unsafely, or clicking "Answer now"?

**Method:** Use existing browser diagnostics and DOM inspection against kept-browser sessions. Detect signed-in state, selector availability, selected mode, archive/attachment defaults, and selector changes before submit. Do not send prompts. Do not click "Answer now". Report `selector_state_unknown` when proof is impossible.

**Deliverable:** Detector evidence, doctor JSON examples, and fake-browser tests for ready, signed-out, unavailable, wrong-mode, and unknown selector states.

**Success-or-kill criteria:** Success if doctor can prove readiness without prompt submission or correctly returns not-ready/unknown. Clean negative success if proof is impossible; then browser lanes should remain gated or manually documented instead of being marked ready.

**Effort:** 1 to 2 days.

**Decision de-risked:** Whether browser lanes can be included in the same v1 gate release or should be deferred.

### Spike 10: Process Tree, Timeout, and Lock Failure Drill

**Question:** Can Oracle stop Claude Code and all descendants, release the single-flight lock, and preserve partial streams on timeout, Ctrl-C, nonzero exit, startup mismatch, and read-only violation?

**Method:** Use fake child processes that spawn grandchildren, ignore SIGTERM, write partial lines, flood output, exit nonzero, hang waiting for input, and trigger startup-verifier failure. Simulate Ctrl-C and timeout. Inspect lock state through the lock API, not by manual cleanup.

**Deliverable:** Lifecycle failure tests, process-tree termination notes for macOS/Linux, and lock metadata/stale recovery rules.

**Success-or-kill criteria:** Success if no live child/grandchild remains, locks release or recover safely, and partial raw artifacts are preserved for every failure path. Kill detached/background support if lifecycle cleanup cannot be proven.

**Effort:** 1 day.

**Decision de-risked:** Attached-only semantics, timeout default, lock library choice, and process-kill implementation.

### Spike 11: MCP Launch Context Subscription Auth

**Question:** Does `oracle-mcp` launched from real MCP clients see the same Claude Code subscription auth, HOME, PATH, and safe environment as the user's interactive shell?

**Method:** Launch `oracle-mcp` from a fresh MCP client context and run only doctor/preflight first. If the user opts in, run one tiny `fable-local` smoke through MCP. Compare observed executable path, auth source, environment allowlist, and startup event fields with CLI results.

**Deliverable:** A launch-context compatibility matrix and documentation for supported MCP launch contexts or a CLI-only limitation.

**Success-or-kill criteria:** Success if MCP launch context preserves safe local subscription access and all guards pass. Clean negative success if MCP lacks auth or context; then v1 should document CLI-only or require explicit setup instead of failing unpredictably.

**Effort:** 0.5 to 1 day.

**Decision de-risked:** Whether MCP `consult` can support `lane: "fable-local"` in v1.

### Spike 12: Sequencing Split Between Adapter and Global Gate

**Question:** Should implementation start with the Claude Code adapter behind an explicit expert engine, or with the full three-lane agent gate?

**Method:** Produce two thin vertical-slice designs using current architecture: one for `--engine claude-code --model fable` hidden behind expert compatibility, and one for full `--lane` registry plus route-blocks. Estimate touched files, side-effect points, test count, and user-visible regression risk. Use stub runners only; do not implement full behavior.

**Deliverable:** A sequencing recommendation with a dependency graph and explicit cut lines for a safe first PR.

**Success-or-kill criteria:** Success if one sequence clearly minimizes safety risk and review size. Clean negative success if both are too coupled; then require a preliminary architecture refactor spike before feature implementation.

**Effort:** 0.5 day.

**Decision de-risked:** The final `SPIKE.md` portfolio order and whether browser lanes, lane gate, and Fable adapter ship together or separately.

### Spike 13: Current Provider Compliance and Consent Check

**Question:** Is the planned local wrapper around Claude Code subscription usage acceptable under current provider docs, support guidance, account terms, and the user's intended local-only workflow?

**Method:** Review current Anthropic/Claude Code public docs and support articles, then write a short compliance note that distinguishes local owner use from hosted proxying, credential collection, API substitution, and subscription relay behavior. Get explicit user acceptance of any ambiguity before public release wording.

**Deliverable:** A dated compliance note, approved docs language, and a release-gate recommendation.

**Success-or-kill criteria:** Success if wording and behavior are clearly local-owner-only and not misleading. Clean negative success if terms or docs are ambiguous; then hide the feature behind an experimental local flag or do not release publicly until clarified.

**Effort:** 0.5 day.

**Decision de-risked:** Whether this can be documented as a normal Oracle lane, experimental local-only mode, or should remain unshipped.

## Portfolio Recommendation

Run Spikes 1, 2, 3, and 4 first. They are the hard kill switches: if any fails, the final portfolio should narrow or stop `fable-local` before spending effort on command polish.

Run Spikes 6, 7, and 10 second. They validate the event-stream promise and failure behavior without spending live quota.

Run Spike 8 before making the three-lane gate agent-facing. It prevents accidental backend starts and protects existing code paths from bypasses.

Run Spike 9 independently from the Fable adapter. Browser selector proof is important, but it should not block learning whether local Claude Code is safe.

Run Spikes 11, 12, and 13 as release-shaping spikes. They decide MCP scope, implementation sequencing, and whether public docs are acceptable.

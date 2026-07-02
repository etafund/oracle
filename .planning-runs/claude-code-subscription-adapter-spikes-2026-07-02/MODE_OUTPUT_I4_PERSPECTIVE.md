# Perspective-Taking (I4) Analysis: Claude Code Subscription Adapter Plan

## Thesis

The plan is unusually strong on safety boundaries, but its adoption risk is not primarily technical correctness. The main risk is operator mismatch: the local owner wants trustworthy subscription-backed Fable access, calling agents want a simple lane they cannot accidentally misuse, maintainers need a shippable slice, MCP callers need complete-but-bounded structured output, browser operators need selector-state confidence without burning prompts, and release operators need a phase gate that does not make every lane block every other lane. The best spikes are therefore narrow empirical probes that turn these stakeholder mismatches into killable implementation decisions. Pure product value choices should stay as sponsor asks, not be disguised as research spikes.

## Findings

### F1. Local owner perspective: billing trust is the adoption floor, not a feature detail

Evidence: The plan requires hard refusal when `ANTHROPIC_API_KEY` is present, including blank values and Windows case variants. It also refuses other provider/auth sources, requires startup verification, preserves raw visible streams, and says the feature is local-owner-only rather than a hosted proxy.

Perspective reasoning: The local owner does not primarily need a clever adapter. They need confidence that a run cannot silently become Anthropic API billing or a remote relay. The plan correctly treats refusal-before-subprocess as a trust boundary. The owner pain is that refusal-only behavior can feel hostile if the diagnostic is not highly actionable.

Severity: high for adoption.

Confidence: 0.86.

So what: Before implementation, de-risk the exact preflight/doctor behavior and error wording against real local shell/MCP contexts. Do not spend live Fable usage until this trust path is proven.

### F2. Calling agent perspective: the lane gate is the product UX, not just routing policy

Evidence: The plan introduces `--lane chatgpt-pro`, `--lane gemini-deep-think`, and `--lane fable-local`, rejects bare prompts, rejects vague model aliases, requires exact replacement commands in route-block errors, and exposes `oracle capabilities --json`.

Perspective reasoning: Agents do not read docs reliably at invocation time. They learn from CLI affordances, schemas, and error envelopes. The lane gate can prevent accidental API or wrong-browser use, but only if an agent can recover from a route-block error in one step. If the error is verbose but not machine-actionable, the lane gate becomes a productivity tax.

Severity: high for operator ergonomics.

Confidence: 0.82.

So what: Spike route-block self-correction with fake invocations and representative MCP JSON, not with live providers. The output must prove an agent can transform a failed request into one of the three reviewed lanes without guessing.

### F3. Maintainer perspective: the plan couples at least four large products into one v1 boundary

Evidence: The plan includes a new local `claude-code` engine, a central lane registry and policy layer, browser lane runtime verification for ChatGPT Pro and Gemini Deep Think, MCP full inline event returns, raw event persistence, doctor commands, session metadata changes, and a large acceptance checklist.

Perspective reasoning: A maintainer sees a coherent architecture, but also sees release starvation risk. If the team interprets v1 as requiring all three lanes, browser selector doctors, MCP inline overflow semantics, and Fable local hardening before any usable internal slice, the feature may not ship before the owner's immediate Fable usage window. The plan itself notes a 2026-07-01 to 2026-07-07 owner window while also saying the design must not be hardcoded to that date.

Severity: high for schedule.

Confidence: 0.80.

So what: Split technical readiness from product exposure. A spike should identify the smallest vertical slice that exercises the Fable local safety path without committing to public agent-facing release.

### F4. MCP caller perspective: full inline visible events are valuable but can become a transport denial point

Evidence: The plan says MCP success must include all stdout events and stderr chunks inline, must fail closed on overflow, must not reuse a 4 KB log tail, and should include raw artifact resource URIs.

Perspective reasoning: MCP callers value completeness because partial streams labeled complete are worse than errors. But full inline streams can be large enough to break clients, gateways, logs, or model context windows. The plan names the need for `ORACLE_CLAUDE_CODE_MAX_INLINE_BYTES`, but leaves unresolved whether overflow aborts immediately or finishes and returns a typed non-success result.

Severity: medium-high for MCP reliability.

Confidence: 0.78.

So what: Measure realistic fake-stream sizes and client behavior before coding the final return contract. Do not decide overflow semantics as an incidental implementation detail.

### F5. Browser operator perspective: browser readiness proof is fragile and should not block Fable-local learning by accident

Evidence: The plan requires ChatGPT Pro and Gemini Deep Think browser lanes to prove signed-in state and selector state before prompt submission, never click "Answer now", and report `selector_state_unknown` when readiness cannot be proven without submitting.

Perspective reasoning: Browser operators know selector state is the least stable layer: account UI, Cloudflare, folders/workspace URLs, model picker labels, and thinking controls change. The plan is correct to require non-submitting verification, but that work has a different failure profile from the local Claude Code adapter. Coupling browser proof to the local adapter's first empirical loop risks conflating two operator surfaces.

Severity: medium-high for release sequencing.

Confidence: 0.76.

So what: Spike browser doctor feasibility separately. If selector state cannot be proven cheaply, the release plan needs a clear decision on whether browser lanes are gated as unavailable while Fable-local proceeds internally.

### F6. Release operator perspective: the acceptance checklist is comprehensive but needs kill gates per phase

Evidence: The checklist spans lane policy, browser runtime checks, Claude Code env/config/executable guards, no-tool startup verification, raw byte persistence, MCP inline output, session lifecycle refusals, docs, fake tests, and opt-in live smokes.

Perspective reasoning: Release operators need a sequence that says what can ship, what must block, and what can be explicitly deferred. A checklist with many correct items can still be operationally ambiguous if every unchecked item blocks every release. The rollout phases help, but they do not yet attach crisp kill criteria to the empirical CLI contract, browser selectors, MCP overflow, and local-owner transport guard.

Severity: medium-high for release quality.

Confidence: 0.79.

So what: Convert the checklist into phase gates with pass/fail/deferrable status before implementation starts. This is a spike because the output should be a concrete gate matrix, not a value debate.

### F7. Maintainer and MCP caller perspective: local-only transport boundaries need a real inventory

Evidence: The plan allows MCP only over local stdio or same-user local socket after owner checks, refuses network-bound MCP/server/router/bridge transports for `fable-local`, and asks whether remote browser workers are allowed for browser lanes.

Perspective reasoning: "Local" is obvious for CLI, less obvious for MCP. A maintainer has to map actual Oracle MCP launch paths, development servers, router modes, sockets, and browser workers to this policy. An MCP caller may not know whether their transport counts as local until the call fails.

Severity: medium.

Confidence: 0.74.

So what: Inventory the actual MCP/server/router entry points and decide which can even reach `fable-local`. This should be proven from code paths, not just documented intent.

### F8. Local owner and release operator perspective: raw event persistence is both the audit feature and the privacy liability

Evidence: The plan requires exact raw stdout/stderr persistence, normalized events with byte offsets, owner-only artifacts, symlink refusal, exclusion from redacted exports, and a purge path.

Perspective reasoning: The owner wants full visible stream capture because it is the point of the adapter. The same raw stream may contain sensitive prompts, file snippets, paths, and stderr. Release operators need to prove the artifact path is safe before encouraging use. This is not optional polish.

Severity: high for trust and privacy.

Confidence: 0.84.

So what: Spike artifact creation and purge semantics with fake streams before running any live Claude Code smoke.

## Assumptions

- The target repository is the `etafund/oracle` fork, and fork-local files named in the plan exist for the implementation team.
- The intended v1 deployment context is a local developer/operator tool, not a hosted multi-user service.
- The sponsor still wants the three reviewed lanes as the normal agent-facing surface, not merely a Fable-local adapter.
- The current plan is intentionally conservative: ambiguous auth/provider/config sources should fail closed.
- Live Claude Code, ChatGPT Pro, and Gemini Deep Think smokes are opt-in and should not be used for basic design discovery.
- Claude Code stream-json startup/result fields may differ from remembered examples, so the empirical CLI contract can block implementation.
- This analysis did not verify current source code, run tests, or validate current external provider docs; it is a plan perspective analysis only.

## Calibrated Confidence

Overall confidence: 0.80.

Confidence is high that the stakeholder tensions above are real because they are directly implied by repeated plan sections: lane gating, hard auth refusal, raw stream persistence, MCP full inline output, browser selector verification, and phase rollout. Confidence is lower on exact effort and feasibility because I did not inspect implementation source files or run empirical Claude Code/browser probes. Confidence would rise to 0.90 after code-path inventory for MCP transports, a fake-run artifact persistence prototype, and a route-block self-correction test. Confidence would fall below 0.65 if the current code already has a mature lane registry, robust MCP resource model, and browser selector doctor that materially reduce these risks.

## Sponsor Asks, Not Spikes

- Decide whether the three-lane gate is mandatory before any agent-facing beta, or whether an internal `fable-local` alpha can land behind explicit expert invocation first.
- Decide whether bare `oracle --prompt ...` must route-block forever in v1, or whether a wrapper outside Oracle will always supply a lane for agents.
- Decide the desired MCP overflow behavior: abort as soon as inline bytes exceed the limit, or let the run finish and return a typed non-success overflow result with complete raw artifacts.
- Decide whether ChatGPT Pro and Gemini Deep Think lanes may use existing remote browser workers in v1, or whether all reviewed lanes are local-only for v1.
- Decide how much friction is acceptable for hard refusal on environment variables. The plan says no automatic unset; sponsor should confirm that usability tradeoff.
- Decide whether fail-fast single-flight locking is acceptable by default, or whether users expect `--wait-for-lock` to be common enough to deserve prominent help text.

## Mandatory Proposed Spikes

### Spike 1: Empirical Claude Code contract capture gate

Question: Does the installed Claude Code CLI expose the exact safe, subscription-authenticated, no-tool stream shape required for `fable-local`?

Method: Run only the plan's opt-in empirical commands on a subscription-authenticated machine after confirming blocked auth variables are absent. Capture `claude --version`, help output, normal `system/init`, `--bare` init, `--tools ""` init, `ANTHROPIC_MODEL` precedence behavior, result `modelUsage`, `total_cost_usd`, and final text. Sanitize into fixtures.

Deliverable: `EmpiricalClaudeCodeContract` fixture bundle plus a short pass/fail memo mapping each planned command flag to observed support.

Success-or-kill criteria: Success if subscription auth source is visible and allowlistable, `--tools ""` yields an empty startup tool list, required flags either exist or have startup-verifier equivalents, and model/result fields can support non-Fable failure. Kill or defer `fable-local` implementation if subscription auth cannot be distinguished from API/provider auth or tools cannot be disabled/proven empty.

Effort: 90-150 engineering minutes plus 20-30 human minutes for local Claude login/confirmation and approval to spend minimal subscription usage.

Decision de-risked: Whether `fable-local` can be implemented safely at all in v1.

### Spike 2: Route-block self-correction harness for calling agents

Question: Can a calling agent recover from unsupported/vague Oracle invocations using only the route-block error and `capabilities --json`?

Method: Build a fake CLI/MCP policy harness or table-test sketch with representative bad inputs: bare prompt, `--engine api --model claude-4.6-sonnet`, `--model gpt`, `--model gpt-5.5-pro`, conflicting `lane` plus `engine`, and MCP prompt-only. Inspect generated human stderr and JSON error envelopes for exact replacement commands and `noBackendStarted: true`.

Deliverable: A route-block contract memo with sample stderr and JSON envelopes, plus a list of fields agents need for one-step correction.

Success-or-kill criteria: Success if every rejected active route includes the three lane commands, attempted route, blocked reason, source precedence, exit code 2, and no backend start proof. Kill or redesign lane error output if an agent would need docs or guessing to retry correctly.

Effort: 2-3 engineering hours, 0 human minutes.

Decision de-risked: Whether the lane gate improves agent behavior instead of becoming a support burden.

### Spike 3: Minimal vertical slice map for maintainer sequencing

Question: What is the smallest implementation slice that proves local Fable review safety without prematurely depending on full browser lane readiness and MCP inline polish?

Method: Build a dependency map from the plan's proposed file map and flow steps. Classify items as `fable-local core`, `lane gate shared`, `MCP required for first use`, `browser lane required for product gate`, `docs/release`, or `later hardening`. Identify the first fake-run-only milestone and the first opt-in-live milestone.

Deliverable: A phase gate matrix with columns `must precede code`, `must precede fake-run merge`, `must precede live local smoke`, `must precede agent-facing beta`, and `can defer`.

Success-or-kill criteria: Success if maintainers can name a shippable fake-run milestone under 1 week and a live-smoke milestone with clear blockers. Kill or re-scope if every path requires completing browser selector doctors and MCP overflow semantics before any Fable-local learning.

Effort: 3-4 engineering hours, 30 human minutes to confirm product release appetite.

Decision de-risked: Whether to implement as one large release or staged internal milestones.

### Spike 4: MCP inline overflow and resource-return prototype

Question: What MCP payload size and overflow behavior can satisfy "all visible events inline" without lying or breaking clients?

Method: Use fake Claude stream fixtures at 10 KB, 100 KB, 1 MB, and 10 MB. Exercise the MCP result shaping path or a standalone serializer. Compare immediate abort versus finish-then-non-success semantics. Verify `eventsComplete`, `streamsComplete`, byte counts, and resource URI behavior.

Deliverable: MCP event-return contract with default max inline bytes, overflow status shape, and sample structured responses.

Success-or-kill criteria: Success if the contract can represent full success, inline overflow, child completion with raw artifacts, and early abort without ambiguous `eventsComplete`. Kill the "always inline on success" interpretation if normal expected streams exceed practical MCP limits too often; replace it with explicit non-success overflow semantics.

Effort: 4-6 engineering hours, 15 human minutes if sponsor must choose overflow policy.

Decision de-risked: How MCP callers consume complete visible streams safely.

### Spike 5: Browser selector-state doctor feasibility

Question: Can ChatGPT Pro Extended Reasoning and Gemini Deep Think readiness be proven without submitting a prompt or clicking forbidden controls?

Method: Inspect existing browser diagnostics and selector utilities, then run non-submitting fake or kept-browser probes where safe. For ChatGPT, verify signed-in state, Pro model availability, extended thinking selection, and that "Answer now" is never clicked. For Gemini, verify Deep Think availability/selection. Record `ready: true`, `selector_state_unknown`, and failure cases.

Deliverable: Browser lane doctor feasibility memo with DOM/state evidence requirements and a recommendation for whether browser lanes can be marked ready in v1.

Success-or-kill criteria: Success if each browser lane can prove selector state without prompt submission in normal signed-in conditions. Kill automatic `ready: true` for a lane if selectors cannot be proven; require `selector_state_unknown` and block runtime submission until a separate browser fix lands.

Effort: 4-8 engineering hours plus 10-20 human minutes if manual Cloudflare/login clearance is needed.

Decision de-risked: Whether browser lane readiness can be part of the v1 lane gate without destabilizing Fable-local delivery.

### Spike 6: Local-only MCP and transport inventory

Question: Which Oracle entry points can legally invoke `fable-local` under the plan's local-owner and local-only rules?

Method: Trace CLI, MCP stdio, same-user local socket, `oracle serve`, router, bridge, remote browser, remote Chrome, and session worker paths. Produce a decision table for allowed/refused transports and where lane policy must run before backend start.

Deliverable: Transport eligibility matrix plus a list of code hooks where `fable-local` must refuse before session creation, subprocess spawn, router request, or worker dispatch.

Success-or-kill criteria: Success if every active run path is categorized with a specific guard location. Kill MCP `fable-local` for any transport whose local/same-user property cannot be established cheaply.

Effort: 3-5 engineering hours, 0 human minutes.

Decision de-risked: Whether MCP `consult` can support `fable-local` in v1 and under which launch contexts.

### Spike 7: Raw artifact safety and purge prototype

Question: Can Oracle persist exact raw stdout/stderr bytes with owner-only permissions, typed artifacts, symlink refusal, and a clear purge path?

Method: Implement or prototype fake-stream artifact writes in a scratch harness using the planned artifact filenames and kinds. Test POSIX modes, symlink refusal, invalid UTF-8, CRLF, split multibyte chunks, normalized NDJSON offsets, redacted export exclusion, and explicit purge behavior.

Deliverable: Artifact safety proof with fixture outputs and a decision on whether existing session cleanup is enough or `--purge-claude-code-artifacts` is required.

Success-or-kill criteria: Success if raw files are created owner-only where supported, offsets match bytes, symlink redirection is refused, typed raw artifacts can be excluded from redacted export, and purge is explicit. Kill live smoke until raw persistence cannot silently leak through broad permissions or generic export paths.

Effort: 5-8 engineering hours, 0 human minutes.

Decision de-risked: Whether the audit feature is safe enough for local owner use.

### Spike 8: Read-only startup verifier shape

Question: Can startup verification reliably prove no tools, no MCP servers, no hooks/plugins/skills/slash commands, no Chrome integration, no session persistence, expected permission mode, and Fable-compatible model/auth?

Method: Use empirical startup fixtures from Spike 1 plus negative fake fixtures. Define critical fields, allowed missing fields, and fail-closed cases. Include examples for unknown schema, non-empty tools, active MCP, fallback model, API auth, and non-Fable result usage.

Deliverable: Startup verifier spec with fixture table and expected verifier decisions.

Success-or-kill criteria: Success if verifier decisions are deterministic and explainable for both real captured fixtures and negative fixtures. Kill live `fable-local` if critical startup fields are absent and there is no alternate visible proof for the read-only/auth/model contract.

Effort: 3-6 engineering hours after Spike 1, 0 human minutes.

Decision de-risked: Whether command flags plus visible startup stream can enforce the v1 read-only promise.

### Spike 9: Single-flight lock behavior under operator workflows

Question: Does the proposed local subscription lock prevent confusing concurrent Fable runs without frustrating legitimate agent use?

Method: Prototype lock acquisition with fake long-running child processes. Test first-run success, second-run fail-fast, stale lock recovery, Ctrl-C cleanup, timeout cleanup, and `--wait-for-lock <duration>`. Include session id and inspection command in busy errors.

Deliverable: Lock behavior memo with recommended default, error text, metadata fields, and `--wait-for-lock` semantics.

Success-or-kill criteria: Success if no path leaves a stale live lock after normal failure modes and busy errors are actionable. Kill concurrent `fable-local` support in v1 unless lock and cleanup are reliable.

Effort: 3-5 engineering hours, 0 human minutes.

Decision de-risked: Whether local owner subscription usage remains understandable under multi-agent pressure.

### Spike 10: Help/capabilities/schema single-source proof

Question: Can help text, MCP schema, capabilities JSON, route-block replacements, and tests all derive from one lane registry without drift?

Method: Sketch or prototype `LaneRegistry` data and generate five surfaces from it: top-level help lane section, `oracle capabilities --json`, MCP `lane` enum, route-block supported-lane output, and lane policy table tests.

Deliverable: Registry shape proposal plus generated sample outputs for the three reviewed lanes.

Success-or-kill criteria: Success if adding/removing a lane changes all surfaces through one data definition and snapshots catch drift. Kill hand-maintained copies of lane names or replacement commands across CLI, docs, MCP, and tests.

Effort: 3-5 engineering hours, 0 human minutes.

Decision de-risked: Whether the agent-facing lane UX remains stable as implementation evolves.

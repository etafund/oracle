# Context Pack: Claude Code Subscription Adapter Spike Portfolio

## Source corpus

- Root workspace rules: `/data/projects/AGENTS.md`.
- Repo rules: `/data/projects/oracle/AGENTS.md`.
- Current plan: `/data/projects/oracle/docs/plans/claude-code-subscription-adapter.md`.
- Project identity: `etafund/oracle`, a TypeScript/Node CLI and MCP server fork of `@steipete/oracle`.
- Objective for this run: produce root `SPIKE.md`, a planning-phase portfolio of 20+ high-value spike experiments before implementation begins.

## Project brief

Oracle bundles prompts and file context, then asks external models through API mode, browser automation mode, MCP, and session replay. The new plan adds a third execution path: a local Claude Code subscription adapter that runs the user's installed `claude -p` process to reach Fable through the user's own Claude Code subscription login, while avoiding Anthropic API billing and while capturing the visible event stream.

The same plan also changes the normal agent-facing product surface in v1. Instead of exposing the broad model/provider catalog equally, normal active agent starts should resolve to exactly three reviewed lanes: `chatgpt-pro`, `gemini-deep-think`, and `fable-local`. Broader API, browser, MCP, and session machinery remains in the fork behind a route gate.

## Deployment context for severity calibration

- Who runs it: primarily local developers and agent swarms operating in the owner-controlled checkout.
- Where it runs: local CLI, local MCP stdio or same-user local transport for the Claude Code path, browser automation against signed-in local browser profiles for browser lanes.
- Users: owner and local coding agents; not a public hosted SaaS surface for the new Claude Code local path.
- Realistic threat model: prompt injection in reviewed repo files, accidental API billing, local config/hooks/tool surfaces unexpectedly activated by Claude Code, remote/server misuse, concurrent agent confusion, incomplete transcript capture, and brittle browser selector drift.
- Stage: planning for a high-risk local adapter and lane gate before implementation.
- Severity rule: avoid enterprise security theater. A finding is high only when it can cause wrong billing route, hidden mutation, false success, lost stream fidelity, unsafe remote/local-owner boundary, or a product-lane contract violation in this local deployment.

## Core substrate

Oracle's identity is a CLI/MCP orchestration tool that packages context, routes to AI providers or browser sessions, stores sessions, and lets agents recover/replay runs. Provider routing, browser automation, local process execution, session storage, MCP schemas, and command-line UX are core substrate. Recommendations should not abstract away these identities; spikes should test the exact route and runtime surfaces that make Oracle what it is.

## Project values and constraints

- Work on `main`; do not create worktrees or branches.
- Do not modify plan, ADR, directive, requirement, or product docs in this run.
- `SPIKE.md` is the only root-level deliverable; supporting artifacts stay under `.planning-runs/claude-code-subscription-adapter-spikes-2026-07-02/`.
- No product implementation in this run. Any code-like probes proposed by spikes must be throwaway and not product crates.
- No sponsor decisions: spikes gather evidence and route value calls to sponsor asks.
- No duplicate spikes. A spike must be able to fail or change a decision.
- Clean negative outcomes count as success.
- Pre-register success and kill criteria.
- Budget human-minutes explicitly for every human-in-loop spike.
- Calibrate severity to the local deployment.

## Load-bearing plan decisions and assumptions

1. Claude Code local mode must use the local user's official Claude Code CLI and subscription login, not Anthropic API.
2. `ANTHROPIC_API_KEY` presence is an unconditional hard refusal, even blank or whitespace, before any `claude` subprocess including doctor probes.
3. Other API/provider auth sources and fallback controls should be refused unless empirically proven inert.
4. `ANTHROPIC_MODEL` should only be scrubbed if a probe proves `--model fable` takes precedence.
5. V1 is read-only review only: no Claude Code tools, no file reads by Claude Code, no edits, no shell, no MCP tools, no browser, no subagents, no session persistence.
6. `--tools ""` is the intended no-tool boundary, but it must be empirically verified from startup events.
7. Claimed safety flags such as `--bare`, `--safe-mode`, `--disable-slash-commands`, `--strict-mcp-config`, `--no-chrome`, and `--no-session-persistence` must not be emitted unless the installed CLI supports and behaves as expected.
8. Startup verification is a required safety boundary: auth source, model, tools, MCP servers, hooks, plugins, skills, slash commands, Chrome, custom agents, fallback model, and permission mode must match the v1 contract or fail closed.
9. The adapter captures visible Claude Code stdout/stderr only, not hidden chain-of-thought, provider logs, billing records, account state, or guaranteed subscription quota state.
10. Raw visible stdout and stderr bytes must be persisted byte-preservingly for every successful, partial, or failed run.
11. Normalized events must include monotonic sequence, receive timestamp, stream source, byte offset, byte length, raw text or byte-safe encoding, parsed JSON when available, and extracted visible text when safe.
12. MCP success for `fable-local` must include all visible stdout events and stderr chunks inline; partial inline output must fail closed rather than masquerade as complete.
13. CLI should present human-readable progress/final answer by default while preserving raw JSONL artifacts and offering machine-readable event output.
14. Session metadata and artifact kinds must distinguish Claude Code raw streams from generic files so redacted exports can exclude them by typed kind.
15. The `fable-local` path is local-only and should refuse router, serve, bridge, remote browser, remote Chrome, network MCP transports, root/sudo-root, unsafe Oracle home/session paths, unsafe symlinks, and repo-local/world-writable `claude` executables.
16. Only one local subscription run should execute at a time by default, with an explicit wait option if supported.
17. V1 should refuse restart, follow-up, resume, continue, background, detached, and multi-model fan-out flows for `fable-local`.
18. The lane registry should become the source of truth for help, capabilities, MCP schema, doctor output, route-block errors, accepted legacy mappings, runtime assertions, and tests.
19. There is no default lane in v1. Bare prompt, env-only engine, config-only engine, vague model aliases, unsupported API routes, and unsupported browser routes should route-block before any backend starts.
20. ChatGPT Pro legacy forms are load-bearing: `--model gpt-5.5-pro` and `--engine browser --model gpt-5.5-pro --browser-thinking-time extended` should normalize to `chatgpt-pro` with browser defaults.
21. Gemini Deep Think legacy forms are intentionally undecided until checked.
22. Browser lanes need non-submitting runtime verification of signed-in state and exact selector/mode state; never click or auto-click ChatGPT's `Answer now` button.
23. Browser lane runtime must abort before prompt submission if selector state cannot be proven or changes after lane resolution.
24. Existing API and browser behavior remain in code and tests behind the gate, not deleted or silently remapped.
25. Docs and manual smokes should be updated only after implementation, not during this planning run.

## Highest-value uncertainty clusters

- Empirical Claude Code CLI contract: exact flags, startup schema, auth source values, model fields, tool list behavior, `--bare`, `--tools ""`, `ANTHROPIC_MODEL` precedence, stderr/stdout shape, result event shape, and cost/model usage fields.
- No-tool and read-only enforcement: whether the intended command shape actually prevents tools/config surfaces and whether event-level tripwires can detect surprises.
- Billing/auth refusal: whether all relevant env/settings/provider routes are detected before subprocess spawn and whether ambiguous sources can be classified without over-blocking normal subscription use.
- Byte-stream fidelity: whether raw persistence and normalized parsing can survive partial chunks, invalid UTF-8, CRLF, process crashes, output flood, and stderr interleaving.
- MCP completeness: whether returning all visible events inline is feasible within client/transport limits and what the fail-closed overflow contract should be.
- Lane gate topology: whether the gate can run before every active backend start path without breaking passive commands or hidden lifecycle flows.
- Browser lane verification: whether ChatGPT Pro and Gemini Deep Think selector states can be proven without submitting prompts or relying on brittle UI assumptions.
- Local-owner/executable trust: whether practical macOS/Linux checks can reject the risky cases without blocking valid local users.
- Session lifecycle and concurrency: whether single-flight locking, cancellation, timeout, Ctrl-C, restart refusal, and detached refusal compose with current session storage.
- Product/operator adoption: whether the three-lane CLI/MCP contract is discoverable enough for agents and precise enough to prevent silent fallback.

## Mode selection for this run

The objective originally called for a reasoning-mode swarm. The human then explicitly requested a six-agent Codex swarm. The selected modes are therefore a compact six-mode set that still spans at least five categories and both discovery/assurance perspectives:

- F7 Systems-Thinking: whole architecture and integration surfaces.
- H2 Adversarial-Review: abuse cases, safety boundaries, route bypasses, prompt/config injection.
- A8 Edge-Case / formal contract: boundary conditions, invariants, table-driven cases, stream parser edge cases.
- I4 Perspective-Taking: local owner, calling agent, maintainer, MCP caller, browser operator, release operator.
- G1 Decision-Analysis: value of information, sequencing, cheapness, gating pressure.
- L2 Debiasing / calibration: false spikes, duplicates, sponsor asks, severity honesty, overconfidence.

## Required mode output contract

Each mode writes one Markdown file under `.planning-runs/claude-code-subscription-adapter-spikes-2026-07-02/` with:

- Thesis.
- Findings.
- Assumptions.
- Calibrated confidence.
- Proposed Spikes section.

Every proposed spike must state:

- Question.
- Method.
- Deliverable.
- Success-or-kill criteria.
- Effort.
- Decision de-risked.

Human-in-loop spikes must budget human-minutes. Clean negative outcomes count as success.

## Synthesis scoring rubric

Final `SPIKE.md` spikes will be scored by:

- Value of information: how much a result can change implementation or sequencing.
- Load-bearingness: whether the plan depends on this assumption.
- Cheapness: preference for small empirical probes before implementation.
- Sponsor weighting: direct relevance to hard sponsor directives such as no API billing, local-only, no tools, visible stream completeness, and three reviewed lanes.
- Sequencing pressure: whether later implementation should be blocked until evidence exists.
- Failure quality: whether a negative outcome gives a clean decision rather than ambiguity.

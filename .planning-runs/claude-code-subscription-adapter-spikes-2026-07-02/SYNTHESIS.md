# Synthesis Record: Claude Code Subscription Adapter Spikes

## Inputs read

- `/data/projects/AGENTS.md`.
- `/data/projects/oracle/AGENTS.md`.
- `/data/projects/oracle/docs/plans/claude-code-subscription-adapter.md`.
- `.planning-runs/claude-code-subscription-adapter-spikes-2026-07-02/CONTEXT_PACK.md`.
- `.planning-runs/claude-code-subscription-adapter-spikes-2026-07-02/MODE_SELECTION.md`.
- `.planning-runs/claude-code-subscription-adapter-spikes-2026-07-02/MODE_OUTPUT_F7_SYSTEMS.md`.
- `.planning-runs/claude-code-subscription-adapter-spikes-2026-07-02/MODE_OUTPUT_H2_ADVERSARIAL.md`.
- `.planning-runs/claude-code-subscription-adapter-spikes-2026-07-02/MODE_OUTPUT_A8_EDGE_CONTRACT.md`.
- `.planning-runs/claude-code-subscription-adapter-spikes-2026-07-02/MODE_OUTPUT_I4_PERSPECTIVE.md`.
- `.planning-runs/claude-code-subscription-adapter-spikes-2026-07-02/MODE_OUTPUT_G1_DECISION.md`.
- `.planning-runs/claude-code-subscription-adapter-spikes-2026-07-02/MODE_OUTPUT_L2_DEBIASING.md`.

## Method

The requested `/modes-of-reasoning-project-analysis` skill was adapted to the human-requested six-agent Codex swarm. The six modes were Systems-Thinking (F7), Adversarial Review (H2), Edge-Case/Formal Contract (A8), Perspective-Taking (I4), Decision Analysis (G1), and Debiasing/Calibration (L2). Each mode produced candidate spikes with question, method, deliverable, success-or-kill criteria, effort, and de-risked decision.

The final portfolio scored candidates by value of information, load-bearingness, cheapness, sponsor weighting, sequencing pressure, failure quality, and duplicate collapse. It keeps only experiments that can fail or can change a decision.

## KERNEL clusters: 3+ modes converged through distinct methods

### KERNEL 1: Empirical Claude Code contract is the first kill gate

Contributing modes: F7 Systems, H2 Adversarial, A8 Edge/Contract, I4 Perspective, G1 Decision, L2 Debiasing.

Convergence: All six modes independently identified that `fable-local` depends on current Claude Code behavior: stream JSON support, visible auth source, Fable model evidence, `--tools ""`, config-surface observability, and result fields. Systems framed it as cross-component architecture. Adversarial framed it as a safety boundary. Edge/Contract framed it as required runtime evidence. Perspective framed it as owner trust. Decision framed it as the highest value-of-information gate. Debiasing framed it as the hidden assumption that must not be implementation-laundered.

Resolution: Portfolio ranks the empirical contract first. Negative results are treated as successful if they kill or narrow `fable-local` before implementation.

### KERNEL 2: No-tool/read-only enforcement must be proven, not prompted

Contributing modes: F7 Systems, H2 Adversarial, A8 Edge/Contract, G1 Decision, L2 Debiasing.

Convergence: Multiple modes warned that Claude Code is an agentic local tool. Prompt instructions are not a boundary. The required evidence is an empty startup tool list and inactive MCP/hooks/plugins/skills/slash commands/Chrome/session persistence/custom agents/fallback model.

Resolution: Portfolio separates no-tool/config containment from generic command-builder work and assigns kill criteria: if no-tool cannot be observed and enforced, defer or kill read-only v1.

### KERNEL 3: Lane gate must be a central start gate before backends

Contributing modes: F7 Systems, H2 Adversarial, A8 Edge/Contract, I4 Perspective, G1 Decision, L2 Debiasing.

Convergence: All modes found that the three reviewed lanes are a product safety boundary, not help text. The gate must run before API provider selection, browser launch, Claude spawn, MCP mapping, session workers, router requests, lifecycle starts, and config/env defaults.

Resolution: Portfolio ranks central lane policy second, before broad implementation. It also includes a help/capabilities/schema single-source spike because agent adoption is part of the gate's safety function.

### KERNEL 4: Raw stream persistence and MCP inline completeness are independent product contracts

Contributing modes: F7 Systems, H2 Adversarial, A8 Edge/Contract, I4 Perspective, G1 Decision, L2 Debiasing.

Convergence: Modes agreed that visible-stream fidelity requires byte-preserving raw stdout/stderr persistence, normalized events with byte offsets, typed artifact kinds, privacy controls, and a separate MCP overflow policy. The current 4 KB log-tail style cannot satisfy the plan.

Resolution: Portfolio splits byte persistence/parser conformance, MCP inline overflow, and artifact privacy/purge into separate spikes because each can fail and change scope.

### KERNEL 5: Local-only, executable trust, and MCP transport are pre-spawn blockers

Contributing modes: F7 Systems, H2 Adversarial, A8 Edge/Contract, I4 Perspective, G1 Decision, L2 Debiasing.

Convergence: Modes agreed that `fable-local` can become a subscription relay or unsafe local binary runner through MCP/server/router/remote transports, PATH shadowing, repo-local binaries, symlinks, world-writable paths, or inherited env/settings.

Resolution: Portfolio includes local-owner/transport proof, executable provenance, auth/env matrix, and MCP launch-context validation. MCP `fable-local` is explicitly killable if local same-user context cannot be proven.

### KERNEL 6: Browser lane readiness is separate from Fable adapter viability

Contributing modes: F7 Systems, H2 Adversarial, I4 Perspective, G1 Decision, L2 Debiasing.

Convergence: Browser selector proof is required if the product claims three reviewed lanes, but it has different risks from local Claude Code. Coupling browser readiness to Fable learning can stall the work.

Resolution: Portfolio keeps browser selector proof as a high-value spike but routes the release-coupling decision to sponsor asks.

## Supported hypotheses: fewer than 3 modes but high value

- Process-tree cleanup and single-flight locking need a dedicated failure drill. Strongly supported by H2, A8, I4, and G1, and included as a spike.
- Prompt assembly and supplied-context usefulness need a separate no-tool workload fit probe. Strongly supported by F7 and H2, included as a spike.
- Provider boundary/model alias leakage is important but lower than the first-order kill gates. Supported by F7 and A8, included as a spike.
- Compliance/terms wording is not a code proof but can change release posture. Supported by H2 and I4, included late in the portfolio.

## Disputes and resolutions

- Dispute: implement full three-lane gate before any Fable work versus first build a hidden expert adapter. Resolution: the portfolio does not decide this policy. It includes both the central gate spike and a sequencing split spike, then routes the release coupling decision to sponsor asks.
- Dispute: MCP overflow should abort immediately versus finish and return typed non-success. Resolution: route to sponsor ask after a size/behavior spike produces data.
- Dispute: browser lanes should be coupled to `fable-local` v1. Resolution: keep browser selector proof as a spike, but make combined release a sponsor ask.
- Dispute: automatic PATH resolution versus explicit trusted executable path. Resolution: executable provenance spike decides whether automatic resolution is safe enough; otherwise require explicit configuration.

## Routed-out ideas

### Human value calls

- Whether all three reviewed lanes must ship together, or `fable-local` can land as an internal/experimental expert lane first.
- Whether bare `oracle --prompt` must route-block forever in v1, or an external wrapper always supplies a lane.
- Default MCP inline byte limit.
- Abort-on-overflow versus finish-then-non-success overflow.
- Whether raw purge deletes only Claude Code artifacts or whole sessions.
- Whether `--write-output` should include raw/normalized events or final answer only.
- Fail-fast lock contention versus prominent `--wait-for-lock` behavior.
- Whether remote browser workers are allowed for ChatGPT Pro and Gemini Deep Think lanes.
- Whether `--engine claude-code --model fable` is hidden or documented as expert compatibility.

### Implementation tasks, not spikes

- Add `EngineMode = "claude-code"`.
- Add `LaneRegistry`, `lanePolicy`, and route-block modules after policy shape is selected.
- Add provider boundary slot `claude_code_fable_5`.
- Wire command builder, env guard, executable resolver, startup verifier, runner, session metadata, and artifact paths.
- Update README, CLI reference, MCP docs, Anthropic docs, configuration docs, changelog, and manual tests after implementation.
- Add unit tests for already chosen behavior.
- Add CLI help ordering and capabilities schema after lane registry shape is chosen.

### Duplicate validations to consolidate

- Provider boundary and API substitution guard tests should share one fixture proving `claude_code_fable_5` requires `claude_code_subscription_cli` and rejects `anthropic_api`.
- Route-block tests should focus on the central resolver plus representative CLI/MCP entry points, not duplicate every conflict everywhere.
- Privacy checks should target shared serializers and response envelopes.
- Artifact owner-only/symlink behavior should be proven once through the artifact writer and referenced by CLI/MCP tests.

### Not spikes unless tied to kill criteria

- Running `claude --version` by itself.
- Capturing docs/help output without pass/fail required-flag and required-field criteria.
- Updating command-builder fixtures after empirical capture.
- Running a happy-path live smoke after implementation.
- Adding doctor output after checks are known.
- Writing required docs that restate local-only, no-API, read-only, and visible-output-only behavior.

## Final portfolio shape

The final `SPIKE.md` contains 24 spikes. The first 10 are hard kill gates or high-value architecture proofs. The next 8 narrow implementation scope and failure handling. The final 6 shape release, compliance, docs, and adoption. All spikes include clean-negative success semantics and no product implementation requirement.

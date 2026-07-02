# Mode Selection Record

## Adaptation from `/modes-of-reasoning-project-analysis`

The requested skill normally recommends ten agents, but the human explicitly requested a six-agent Codex swarm. This run uses a six-mode subset selected for maximum spike-generation coverage, not for a general project audit.

## Load-bearing taxonomy axes

- Ampliative vs non-ampliative: the portfolio needs both discovery of hidden risks and formal checking of explicit lane contracts.
- Descriptive vs normative: experiments must separate empirical facts from sponsor value decisions.
- Belief vs action: every spike must change an implementation decision, scope boundary, or sequencing gate.
- Single-agent vs multi-agent: the feature runs in concurrent agent swarms and must resist route bypasses, prompt injection, and coordination failures.
- Truth vs adoption: the CLI/MCP lane gate must be both correct and discoverable by agents.

## Selected modes

| Mode | Category | Why selected | Primary output needed |
| --- | --- | --- | --- |
| F7 Systems-Thinking | Causal / systems | The plan spans CLI parsing, lane policy, local subprocesses, session artifacts, MCP schemas, browser selectors, and docs. Integration seams are the likely failure points. | Spikes that test end-to-end seams and cross-component invariants. |
| H2 Adversarial-Review | Strategic / adversarial | The plan's hard promises are mostly refusal and containment promises: no API billing, no tools, local-only, no silent fallback. | Spikes that try to bypass or falsify safety boundaries. |
| A8 Edge-Case / formal contract | Non-ampliative / boundary | The plan has many exact contracts: env var presence, byte offsets, no default lane, conflict matrix, inline completeness. | Spikes that create table-driven contract checks and parser edge probes. |
| I4 Perspective-Taking | Multi-agent / adoption | Several actors will experience the feature differently: local owner, coding agent, MCP client, browser operator, maintainer, release operator. | Spikes that expose usability and operator failure modes, with human-minute budgets. |
| G1 Decision-Analysis | Action / decision | The final portfolio must be sorted by risk reduction and sequencing pressure. | Scored candidate spikes, gates, and effort estimates. |
| L2 Debiasing / calibration | Meta-reasoning | The portfolio must reject non-spikes, duplicates, implementation tasks, and sponsor value calls. | Routed-out ideas, sponsor asks, severity calibration, duplicate collapse. |

## Considered but excluded modes

- B10 Reference-Class: useful, but the current plan has enough explicit local/browser/MCP contracts that direct empirical probes are more valuable than analogy.
- F4 Failure-Mode: mostly covered by H2 plus A8 for this spike-specific task.
- B3 Bayesian: useful for scoring uncertainty, but G1 can carry the value-of-information ranking.
- F3 Counterfactual: lower value because the plan already fixes the broad shape; unresolved reversible decisions are better handled as concrete spikes.

## Agent assignments

- FuchsiaLeopard / Turing: `MODE_OUTPUT_F7_SYSTEMS.md`.
- CoralCardinal / Dalton: `MODE_OUTPUT_H2_ADVERSARIAL.md`.
- CobaltBass / Mencius: `MODE_OUTPUT_A8_EDGE_CONTRACT.md`.
- DarkBrook / Epicurus: `MODE_OUTPUT_I4_PERSPECTIVE.md`.
- CalmGlacier / Bernoulli: `MODE_OUTPUT_G1_DECISION.md`.
- SilentDuck / Popper: `MODE_OUTPUT_L2_DEBIASING.md`.

## Provenance notes to preserve in `SPIKE.md`

- Source corpus: root and repo AGENTS files plus the Claude Code subscription adapter plan.
- Method: six-mode reasoning swarm adapted from the requested skill.
- KERNEL clusters: require three or more modes converging through distinct methods.
- Supported hypotheses: preserve high-quality one- or two-mode insights when evidence is strong.
- Disputes and routed-out ideas: record so later swarms do not rediscover them.

# Lossless Rewrite Witness

Artifact: `docs/plans/claude-code-subscription-adapter.md`
Date: 2026-07-02
Agent: OliveWolf / Codex

## Inventory

The pre-edit inventory was section-level because the plan is a long planning artifact. The corrected inventory contained 131 heading units, U1-U131.

After editing, the artifact still contains 131 heading units in the same broad order. No section-level unit was silently deleted. Several headings were reworded to incorporate spike results, especially where the old plan implied public/MCP/browser readiness that the spike narrowed to hidden CLI-only alpha.

## Verifier

Command:

```bash
python3 /data/projects/skills/lossless-rewrite/scripts/lossless_rewrite_check.py --git docs/plans/claude-code-subscription-adapter.md
```

Result: exit 1, with 206 old nonblank lines reported missing in 128 hunks.

Reconciliation: the reported hunks are expected after a targeted semantic rewrite. They correspond to old wording that was reworded in-place to reflect the spike evidence:

- Title and summary wording: REWORDED to "Experimental Local Claude Code CLI Lane" and hidden CLI alpha.
- Empirical CLI contract: REWORDED and EXPANDED with the 2026-07-02 live probes.
- Command shape: REWORDED to include tiny `--system-prompt`, `--permission-mode plan`, strict empty `mcpServers`, no `--bare`, and no unproven turn cap.
- MCP content: REWORDED/MOVED to future/deferred sections; no MCP design was deleted.
- Browser lane content: REWORDED to template/not-ready status, preserving ChatGPT Pro smoke evidence and Gemini deferral.
- Verifier semantics: REWORDED to tolerate live-observed built-in `agents` and auxiliary Haiku `modelUsage` only under primary Fable evidence.
- Raw artifact and purge policy: REWORDED to distinguish regular whole-session cleanup from deferred typed purge.
- Rollout and acceptance criteria: REWORDED to the spike-backed sequence: fake-run skeleton, supplied-context slice, opt-in CLI, MCP after CLI proof, browser/public release.

## Witness

| Unit range | Disposition | Evidence |
| --- | --- | --- |
| U1 | REWORDED | New title at heading 1. |
| U2-U6 | KEPT/REWORDED | Repo scope, summary, facts, empirical contract, and naming sections still present. |
| U7-U15 | KEPT/REWORDED | Goals section and Goals 1-8 still present; goals now reflect hidden CLI alpha and deferred MCP/browser readiness. |
| U16-U23 | KEPT | Anti-goals 1-7 still present. |
| U24-U30 | KEPT/REWORDED | Usage patterns still present; MCP usage moved to `Future MCP: Local Fable Review (Deferred)`. |
| U31-U38 | KEPT | Usage anti-patterns still present. |
| U39-U59 | KEPT/REWORDED | Feature list and Features 1-20 still present; command, verifier, prompt assembly, MCP, doctor, and lane-gate sections updated from spike results. |
| U60-U68 | KEPT/REWORDED | Feature 20 subsections still present; route-block, capabilities, MCP gate, doctor, and bypass text now distinguish enabled lanes from deferred templates. |
| U69-U72 | KEPT/REWORDED | File map and detailed CLI/MCP flows still present; MCP flow marked future/deferred. |
| U73-U91 | KEPT/REWORDED | Error cases still present; `ANTHROPIC_MODEL`, startup mismatch, and turn-cap wording updated. |
| U92-U100 | KEPT/REWORDED | Security notes still present; config, session, and raw-stream sections updated for no `--bare` and deferred typed purge. |
| U101-U118 | KEPT/REWORDED | Testing plan sections still present; tests now split hidden-alpha behavior from future MCP/browser gates. |
| U119-U127 | REWORDED | Rollout phases replaced with the spike-backed sequence while preserving rollout intent. |
| U128-U131 | KEPT/REWORDED | Open questions, recommended decisions, acceptance checklist, and references still present; references now include moved spike artifacts. |

DROP-PROPOSED: none.

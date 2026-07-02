According to documents from 2026-07-02, the plan should be narrowed before implementation: the spike evidence supports a hidden/CLI-first local Claude Code lane, not the full public three-lane/MCP rollout currently implied in several sections.

## Must Change

* **Title/status/summary wording:** Rename the plan surface from “subscription adapter” to “local Claude Code CLI lane” or “experimental local Claude Code review mode.” Keep the local-owner/non-hosted requirements, but remove wording that sounds like an “adapter,” “API bypass,” “subscription relay,” or billing guarantee.

* **Scope/phase framing:** Change the initial implementation target from “three reviewed agent lanes” to **hidden or expert CLI-only `fable-local` alpha**. Preserve the lane registry requirement, but make public browser lanes and MCP `fable-local` later phases, not part of the first implementation slice.

* **MCP sections:** Mark all MCP `fable-local` usage examples, schema/output expectations, and MCP success acceptance items as **deferred/not in hidden alpha**. Current plan examples show MCP `lane: "fable-local"` as ready-shaped, but the spike says MCP is CLI-only for hidden alpha and should not be implemented or advertised yet.

* **Command builder:** Replace the candidate argv with the live-supported shape:
  `claude -p --system-prompt <tiny Oracle prompt> --model fable --effort xhigh --output-format stream-json --verbose --include-partial-messages --include-hook-events --permission-mode plan --safe-mode --disable-slash-commands --strict-mcp-config --mcp-config '{"mcpServers":{}}' --disallowedTools 'mcp__*' --no-chrome --no-session-persistence --tools ''`.

* **`--system-prompt`:** Add a required hidden-alpha decision to use the tiny Oracle-owned supplied-context system prompt. The plan’s current “suggested adapter prefix” should be converted into the actual `--system-prompt` command input, while still stating it is not a security boundary.

* **`--bare`:** Remove any “prefer `--bare`” language from v1 config-surface mitigation. Replace with “do not emit `--bare` by default; only revisit if future feature detection proves subscription auth still works.” The spike found bare/simple mode is unsafe for subscription auth assumptions.

* **Turn cap / `--max-turns`:** Remove “max turn reached” as an active v1 terminal state unless feature detection later proves a supported flag. The spike explicitly says not to emit `--max-turns` for Claude Code 2.1.198.

* **Strict empty MCP config:** Replace “strict MCP config with no MCP config” or `--mcp-config '{}'` wording with the proven empty shape: `--strict-mcp-config --mcp-config '{"mcpServers":{}}'`. `--mcp-config '{}'` failed before a model call.

* **Verifier rules for `agents`:** Do not require startup `agents: []`. Built-in agents remained listed, while no tools or agents were invoked. Update verifier requirements to record listed agents, fail on agent/tool invocation, and fail only if a stronger flag later proves agents can be hidden/disabled.

* **Verifier rules for `modelUsage`:** Do not fail on any non-Fable `modelUsage` key. Instead require primary startup/message/result evidence to prove Fable, and tolerate auxiliary Haiku bookkeeping keys such as `claude-haiku-4-5-20251001`.

* **`ANTHROPIC_MODEL`:** Update the env-guard section from “refuse until proven” to “Claude Code 2.1.198 proved `--model fable` wins for the main assistant run; product decision remains hard-refuse vs child-scrub-with-warning.” Do not relax other API/provider auth refusals.

* **Browser lanes:** Keep `chatgpt-pro` in the registry, but change readiness language: ChatGPT Pro has one successful remote-router exact-token smoke; doctor still needs a default non-submitting UI probe. Gemini Deep Think must stay skipped/not active because there is no active lane/subscription.

* **Browser smoke/live tests:** Add that current Vitest ChatGPT live smoke skipped because its preflight checks local Chrome cookies unless remote Chrome is configured; plan should either update the test preflight for the router path or document that limitation.

* **Phases:** Replace the current Phase 1–5 sequence with the spike strategy: fake-run lane skeleton → supplied-context vertical slice → opt-in local Claude Code CLI → MCP after CLI proof → browser/public release.

* **Acceptance checklist:** Split checklist into hidden-alpha vs deferred. Hidden alpha should require lane registry/route block, CLI `fable-local`, fake runner, prompt/file bundle, system prompt, strict empty MCP config, raw typed artifacts, verifier, env/local-owner/executable guards, lock/cleanup, and opt-in live CLI. Move MCP inline success, public browser lanes, Gemini, and public docs/beta items to deferred gates.

* **Open questions:** Resolve or reclassify stale questions. Mark MCP overflow and raw purge scope as still deferred, but set the current policy context: 1 MiB MCP inline default was recommended by the spike; raw purge needs a typed purge decision, not generic session cleanup.

## Should Change

* **References/paths:** Since `SPIKE.md` and `SPIKE-RESULT.md` are moving under `docs/plans/`, update plan references from planning-run-only locations to `docs/plans/SPIKE.md`, `docs/plans/SPIKE-RESULT.md`, plus live artifact appendices if retained.

* **Source facts:** Replace “fresh empirical contract must be pasted before coding” with a dated summary of the evidence already captured for Claude Code `2.1.198`, while keeping a future-version revalidation requirement.

* **Auth/billing metadata:** Add observed live fields: `apiKeySource: "none"`, `authMethod: "claude.ai"` from `auth status`, `apiProvider: "firstParty"`, `subscriptionType: "max"`, `rateLimitType: "five_hour"`, `overageStatus: "rejected"`, and `isUsingOverage: false` as evidence fields to store when visible.

* **Containment claims:** Keep no-tool/read-only requirements, but narrow wording to “minimal exact-token probes proved no tools/MCP/slash commands/skills/plugins; adversarial no-read/no-shell/no-agent fixtures still required before broader claims.”

* **Prompt assembly:** Add hidden-alpha requirements for sensitive filename policy, binary rejection or summarization, manifest metadata, and context budget. These were spike-hardening findings, not optional polish.

* **Raw artifacts/privacy:** Preserve the existing raw-stream requirements but emphasize typed artifact kinds, no-follow/realpath enforcement, `0600` files, `0700` dirs, redacted-export exclusion, resource URIs, and typed purge before raw persistence.

* **Route gate:** Keep the three lane names in the registry, but say only `fable-local` is usable in hidden alpha unless explicitly promoted. Preserve no-default-route, no `--models`, no shared API/browser `fable`, and no backend side effects before route block.

* **Local-owner/compliance:** Replace broad public “subscription usage allotment” claims with local-owner wording: Oracle runs the local user’s installed CLI, does not collect credentials, is not hosted, and cannot guarantee quota/billing state beyond visible Claude Code evidence.

* **Lock behavior:** The plan currently supports `--wait-for-lock`; spike recommendations favor fail-fast lock contention by default. Keep `--wait-for-lock` as future/explicit only unless sponsor chooses otherwise.

* **Manual smokes:** Keep ChatGPT “Answer now” prohibitions and opt-in live smoke language; align with AGENTS.md that Pro browser runs can take time and must not auto-click “Answer now.”

## Watchouts

* Do not weaken hard refusal for `ANTHROPIC_API_KEY`, base URLs, provider/gateway toggles, helper auth, BYOK/provider credentials, or fallback settings. Only `ANTHROPIC_MODEL` has version-specific precedence evidence.

* Do not delete useful MCP design text; re-phase it. The spike says MCP `fable-local` is not ready for hidden alpha, not that MCP should never exist.

* Do not claim Gemini readiness. Keep Gemini lane registry/test scaffolding if useful, but mark live readiness/smoke as skipped until there is an active lane/subscription.

* Do not make public docs/beta release part of implementation acceptance. The spike says public release remains blocked on browser doctors, Gemini re-probe, MCP proof, and compliance wording.

* Do not let the acceptance checklist require impossible startup `agents: []`; that would contradict live evidence. Require no tools/MCP and no agent invocation instead.

* Do not convert the plan into implementation tasks beyond plan revision. The spike explicitly separates implementation tasks from spike/plan decisions.

# Worker B Non-Fast Final Report

Date: 2026-07-02
Agent Mail identity: MagentaTiger
Scope: Spikes 2, 13, 18, and 19 from `SPIKE.md`.
Mode: planning/spike evidence only. No product implementation.

## Preregistered Success/Kill Criteria

Full preregistration is in `preregistration.md`.

- Spike 2 succeeds if one central resolver, or a very small wrapper set, can classify active CLI and MCP starts before API selection, browser launch, Claude spawn, MCP backend mapping, session worker start, or router request creation. It fails if active starts are too scattered, if defaults can infer active routes, or if policy must be duplicated in providers.
- Spike 13 succeeds if `fable` and `claude_code_fable_5` are local-only aliases for `claude-code` / `fable-local`, and API/fan-out paths block before provider selection. It fails if shared registries can leak either alias into Anthropic API, OpenRouter, Azure, existing Claude API clients, or multi-model fan-out.
- Spike 18 succeeds if every rejected active route gives `agent_lane_blocked`, exit code `2`, attempted route, reason, policy version, source precedence, supported lane templates, and `noBackendStarted: true`, without leaking prompt text or secrets. It fails if errors are vague or not machine-retryable.
- Spike 19 succeeds if help, capabilities JSON, MCP lane enum/schema, route-block replacements, doctor lane records, and tests can derive from one lane registry. It fails if those surfaces must be hand-maintained independently.

## Files Inspected

- `AGENTS.md`
- `SPIKE.md`
- `docs/plans/claude-code-subscription-adapter.md`
- `bin/oracle-cli.ts`
- `src/cli/engine.ts`
- `src/cli/runOptions.ts`
- `src/cli/options.ts`
- `src/cli/help.ts`
- `src/cli/errorEnvelope.ts`
- `src/cli/sessionRunner.ts`
- `src/cli/commands/capabilities.ts`
- `src/mcp/types.ts`
- `src/mcp/utils.ts`
- `src/mcp/tools/consult.ts`
- `src/mcp/server.ts`
- `src/oracle/config.ts`
- `src/oracle/modelResolver.ts`
- `src/oracle/providerRouting.ts`
- `src/oracle/providerRoutePlan.ts`
- `src/oracle/client.ts`
- `src/oracle/run.ts`
- `src/oracle/capabilities/registry.ts`
- `src/oracle/v18/provider_boundaries.ts`
- `src/oracle/api_substitution_guard.ts`
- Targeted tests: `tests/engine.test.ts`, `tests/runOptions.test.ts`, `tests/cli/capabilities.test.ts`, `tests/mcp.schema.test.ts`, `tests/mcp/consult.test.ts`, `tests/oracle/providerRoutePlan.test.ts`, `tests/oracle/provider_boundaries_pav.test.ts`, `tests/oracle/v18/provider_boundaries.test.ts`, `tests/bin/oracle-cli-routing.test.ts`, `tests/bin/error_envelope_json.test.ts`

## Commands Run

```bash
pnpm vitest run tests/engine.test.ts tests/runOptions.test.ts tests/cli/capabilities.test.ts tests/mcp.schema.test.ts tests/mcp/consult.test.ts tests/oracle/providerRoutePlan.test.ts tests/oracle/provider_boundaries_pav.test.ts tests/oracle/v18/provider_boundaries.test.ts tests/bin/oracle-cli-routing.test.ts tests/bin/error_envelope_json.test.ts
```

Result: 10 test files passed, 150 tests passed.

```bash
node --import tsx .planning-runs/claude-code-spike-execution-2026-07-02/worker-b-nonfast/worker-b-spike-harness.mjs
```

Result:

```json
{
  "policyCaseCount": 21,
  "blockedCaseCount": 13,
  "blockedInvariantFailures": 0,
  "surfaceDrift": false
}
```

Additional read-only inspection commands used `rg`, `sed`, `nl`, `jq`, `find`, `wc`, `git status --short`, and `node -e` for package script discovery.

## Evidence Observed

### Spike 2: Central Lane Start Gate

Current CLI active run path:

- `bin/oracle-cli.ts` root action resolves prompt/options, config/env/defaults, route/preflight, session storage, engine/model normalization, browser config, dry-run, duplicate prompt, file validation, session creation, and detach/inline execution in one large `runRootCommand`.
- The strongest current insertion point is before `sessionStore.createSession` and before `validateApiProviderRoutingForCli`, `buildBrowserConfig`, remote browser executor creation, `createGeminiWebExecutor`, and `performSessionRun`.
- Passive `--status`, hidden `--session`, `--exec-session`, and `--finalize-session` are handled after engine/model resolution today. A future lane policy should classify passive commands before active route resolution so `oracle status` and `oracle session <id>` remain outside the active gate.

Current MCP active run path:

- `src/mcp/types.ts` accepts `prompt`, `model`, `models`, and `engine: api|browser`; it has no `lane`.
- `src/mcp/utils.ts` maps MCP input through `resolveRunOptionsFromConfig`.
- `src/mcp/tools/consult.ts` creates a session and then either launches detached browser work or calls `performSessionRun`.
- This creates a clear MCP gate point: immediately after input parse/preset application and before `mapConsultToRunOptions` or `sessionStore.createSession`.

Scratch harness evidence:

- `worker-b-spike-harness.mjs` table-tested CLI and MCP active/passive cases with fake counters for `apiSelection`, `browserLaunch`, `claudeSpawn`, `mcpBackendMapping`, `sessionWorkerStart`, and `routerRequestCreation`.
- All 13 rejected active cases returned `agent_lane_blocked`, exit code `2`, `noBackendStarted: true`, and zero fake counter increments.
- Passive status bypassed active resolution with zero counters.
- Supported dry-run for `fable-local` resolved successfully with zero backend counters.

Verdict: feasible as a real safety boundary if implemented as a shared `LaneRegistry` + `lanePolicy.resolve()` before current CLI/MCP run-option resolution and before session creation. Not currently implemented.

### Spike 13: Provider Boundary and Model Alias Invariants

Current code risk:

- `resolveApiModel("fable")` treats `fable` as a custom model id, and the route planner maps it to OpenRouter in auto API context when no key is present.
- `resolveApiModel("claude_code_fable_5")` contains `claude`, so it resolves toward Anthropic-native routing.
- Multi-model fan-out `["gpt-5.5-pro", "fable"]` resolves to API engine with `models` containing `fable`.
- MCP schema accepts prompt-only requests and does not accept a lane field today.

Existing positive boundary evidence:

- `src/oracle/v18/provider_boundaries.ts` already has Claude subscription CLI concepts and tests proving `claude_code_opus` via `anthropic_api` is forbidden while `claude_code_subscription_cli` is allowed.
- `src/oracle/api_substitution_guard.ts` already supports slot/access-path evaluation for subscription CLI paths.

Verdict: the plan should not put Fable aliases into `MODEL_CONFIGS` or the generic API model resolver. Add isolated Claude Code model alias handling under lane policy / `claude-code` types. Add `claude_code_fable_5` to provider-boundary metadata only as a local subscription slot requiring `claude_code_subscription_cli`.

### Spike 18: Route-Block Self-Correction

Current error envelopes:

- `src/cli/errorEnvelope.ts` can emit `json_envelope.v1`, but ordinary top-level errors default to exit code `1`, generic codes, and often `oracle --help` as `next_command`.
- The current MCP error path generally returns `isError: true` plus text, not a route-block structured envelope with supported lane replacements.

Scratch contract evidence:

- Block envelope includes: `errorCode: "agent_lane_blocked"`, `exitCode: 2`, `policyVersion`, `reason`, sanitized `attemptedRoute`, `sourcePrecedence`, `supportedLanes`, `noBackendStarted: true`, and completeness flags.
- The prompt is represented only as `promptSha256`; the literal prompt text is absent from blocked outputs.
- Replacement commands for all three lanes are present in every block result.

Verdict: current JSON envelope infrastructure can be extended, but route-block needs a dedicated typed error/envelope builder shared by CLI and MCP. Calling agents can self-correct in one step if the harness fields become product fields.

### Spike 19: Help, Capabilities, Schema, and Replacement Commands

Current drift risk:

- Top-level help lives in `src/cli/help.ts` and command definitions in `bin/oracle-cli.ts`.
- Capabilities live in `src/oracle/capabilities/registry.ts`.
- MCP schema is hard-coded in `src/mcp/types.ts` / `src/mcp/tools/consult.ts`.
- Doctor/provider surfaces are separate.

Scratch registry evidence:

- One fake `laneRegistry` generated:
  - help lane section,
  - capabilities JSON fragment,
  - MCP lane enum,
  - route-block supported-lane output,
  - doctor lane records,
  - lane policy test cases.
- Harness detected `surfaceDrift: false`; all generated surfaces contained the same lane names in the same order.

Verdict: a single lane registry is feasible and should be treated as the source for public and machine-facing lane surfaces. Snapshot tests should assert exact generated output.

## Contradictions / Risks

- `docs/plans/claude-code-subscription-adapter.md` says exact legacy `--model gpt-5.5-pro` should normalize to ChatGPT Pro Extended. My harness required either explicit `--lane chatgpt-pro` or the more specific legacy browser+extended form. The plan and harness should be reconciled before implementation; accepting bare `--model gpt-5.5-pro` is convenient but weakens "no default lane" unless it is recorded as an explicit approved legacy mapping.
- Current `resolveRunOptionsFromConfig({ engine: "browser", model: "fable" })` normalizes to `gpt-5.2`, which is surprising. A lane gate must run before browser model normalization or it can lose the user's attempted alias.
- Current passive root aliases are checked after model/engine normalization. That is not a backend side effect, but it means a future gate inserted too early in the wrong place could accidentally block passive commands.
- Current MCP `consult` prompt-only requests are valid. Requiring a lane will be a breaking agent-facing schema/behavior change and must be paired with good route-block replacements and capabilities output.
- Existing provider boundary tests cover `claude_code_opus`, not `claude_code_fable_5`; the Fable slot must be added and tested.

## Recommended Plan Changes

- Add a `src/oracle/lanes/registry.ts` (or equivalent) before adding provider implementation. Fields should include public lane, canonical id, engine, access path, model aliases, exact command template, MCP template, doctor command, readiness requirements, refused patterns, transport eligibility, and runtime assertions.
- Add `lanePolicy.resolve()` as a pure helper used by both CLI and MCP before normal engine/model/provider resolution and before session creation. It should return either a resolved lane + normalized execution shape or a typed route-block.
- Add a top-level `--lane <chatgpt-pro|gemini-deep-think|fable-local>` option and extend `EngineMode` with `claude-code`, but accept `--engine claude-code --model fable` only as expert compatibility resolving to `fable-local`.
- Keep Fable aliases out of `resolveApiModel`, `MODEL_CONFIGS`, OpenRouter/custom model passthrough, and multi-model fan-out. Treat them as local Claude Code aliases only.
- Move passive command detection ahead of active route resolution, especially `status`, `session`, render/raw-artifact reads, hidden `--session`, `--exec-session`, and `--finalize-session`.
- Extend `json_envelope.v1` use with a dedicated `agent_lane_blocked` builder that sets exit code `2`, omits prompt text, includes source precedence, and carries all supported lane replacements.
- Add MCP schema field `lane` and structured route-block output; do not rely on text-only `isError` responses for route-policy failures.
- Generate help lane section, capabilities lane entries, MCP lane enum, doctor lane records, and route-block replacements from the same registry, with snapshots that fail on drift.

## Created Files

- `preregistration.md`
- `worker-b-spike-harness.mjs`
- `harness-output.json`
- `generated-surfaces.md`
- `FINAL_REPORT.md`

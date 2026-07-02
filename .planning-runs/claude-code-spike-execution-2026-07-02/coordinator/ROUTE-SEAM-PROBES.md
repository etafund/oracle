# Coordinator Route and Seam Probes

Date: 2026-07-02
Scope: no-live coordinator probes for Spikes 2, 13, 18, 20, and 21.

## Files inspected

- `bin/oracle-cli.ts`
- `src/cli/engine.ts`
- `src/cli/runOptions.ts`
- `src/cli/sessionRunner.ts`
- `src/cli/dryRun.ts`
- `src/cli/sessionCommand.ts`
- `src/mcp/types.ts`
- `src/mcp/utils.ts`
- `src/mcp/tools/consult.ts`
- `src/oracle/run.ts`
- `src/oracle/api_substitution_guard.ts`
- `src/oracle/v18/provider_boundaries.ts`

## Current chokepoints

- CLI active root action is in `bin/oracle-cli.ts`, not `src/cli/index.ts`.
- Passive session/status attach paths go through `src/cli/sessionCommand.ts` and can stay outside lane resolution.
- Current `EngineMode` is only `"api" | "browser"` in `src/cli/engine.ts`.
- MCP `consult` schema also only accepts `"api" | "browser"` in `src/mcp/types.ts`.
- MCP active runs map through `mapConsultToRunOptions()` in `src/mcp/utils.ts`, which delegates to the same CLI run-option resolver.
- Session creation happens after route/dry-run/preview/render handling and before `performSessionRun()`.
- `performSessionRun()` branches only on browser versus API, then calls `runBrowserSessionExecution()` or `runOracle()`.
- Existing provider-boundary code already says the Claude family is `ownership: "user_cli"`, `api_substitution_allowed: false`, and requires `claude_code_subscription_cli`, but it is not yet wired into normal CLI/MCP active route selection.

## Current route-probe evidence

All probes used `--remote-browser off` because this repo currently has a remote browser host configured, and the root action detects it before engine compatibility checks.

```bash
pnpm tsx bin/oracle-cli.ts --remote-browser off --engine api --model claude-4.6-sonnet --dry-run summary --prompt 'route gate check for claude api'
```

Result: exit 0; dry-run would call `claude-4.6-sonnet` through `api/local`.

```bash
pnpm tsx bin/oracle-cli.ts --remote-browser off --engine browser --model claude-4.6-sonnet --dry-run summary --prompt 'route gate check for claude browser'
```

Result: exit 1; browser engine rejects non-GPT/non-Gemini targets and tells the user to rerun with `--engine api`.

```bash
pnpm tsx bin/oracle-cli.ts --remote-browser off --models gpt-5.5-pro,fable --dry-run summary --prompt 'route gate check for model fanout'
```

Result: exit 1; model fan-out currently rejects because `fable` is not browser compatible before the proposed lane gate exists.

```bash
pnpm tsx bin/oracle-cli.ts --remote-browser off --model fable --dry-run summary --prompt 'route gate check for bare fable alias'
```

Result: exit 0; with default browser resolution, `fable` is inferred as browser `gpt-5.2`. This is a bad alias collision for an agent-facing `fable` lane.

```bash
pnpm tsx bin/oracle-cli.ts --remote-browser off --engine api --model fable --dry-run summary --prompt 'route gate check for fable api explicit'
```

Result: exit 0; dry-run would call model `fable` through `api/local`.

```bash
pnpm tsx bin/oracle-cli.ts --remote-browser off --engine api --model fable --route --prompt 'route gate check'
```

Result: exit 1 due to missing key, but the route planner classifies `fable` as OpenRouter, not local Claude Code.

```bash
pnpm tsx bin/oracle-cli.ts --remote-browser off --engine api --model claude-4.6-sonnet --route --prompt 'route gate check'
```

Result: exit 1 due to missing key, and the route planner classifies `claude-4.6-sonnet` as Anthropic API.

## Findings

- The central lane gate must run before `resolveApiModel()`, `inferModelFromLabel()`, `buildProviderRoutePlan()`, `resolveRunOptionsFromConfig()`, and `mapConsultToRunOptions()` can reinterpret `fable`.
- `fable` cannot be added as a loose shared model alias without first scoping it to an explicit lane or engine; today it can become OpenRouter API or even a browser GPT alias depending on inputs.
- Existing browser rejection text points users toward `--engine api` for Claude models, which will become the wrong self-correction path for the planned local subscription lane.
- A configured remote browser host is observed before API route checks and can make API dry-runs fail on `--remote-host requires --engine browser`. Lane resolution should either run before remote browser resolution or treat remote browser configuration as inactive unless the selected lane is browser.
- The smallest plausible insertion points are:
  - CLI: immediately after prompt/flag normalization and before provider route planning, remote browser activation, session storage, and dry-run/session creation.
  - MCP: immediately after `consultInputSchema.parse()`/preset application and before `mapConsultToRunOptions()`.
  - Stored session restart/execute: validate stored lane metadata before `sessionStore.createSession()` or `performSessionRun()`, so old unsupported active sessions cannot bypass policy.
- Passive commands that should remain outside active lane resolution: help, capabilities, docs check, status/session attach/render/path, evidence show/verify/export, browser lease inspection, and no-live markdown render/copy.

## Recommended plan changes

- Make `lane` the primary start contract and treat `engine/model` as compatibility inputs only after a lane has been resolved.
- Do not allow bare `--model fable` to route by existing defaults. Require `--lane fable-local` or hidden expert `--engine claude-code --model fable`.
- Update route-block errors to replace the existing "rerun with --engine api" advice for Claude/Fable targets.
- Add tests proving `--engine api --model fable`, `--model fable`, and `--models gpt-5.5-pro,fable` all block before provider route planning and before backend/session creation.
- Treat configured remote browser as a lane-specific transport, not a global active-run default.

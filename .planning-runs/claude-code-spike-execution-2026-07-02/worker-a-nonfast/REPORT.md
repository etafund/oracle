# Worker A Non-Fast Spike Report

Date: 2026-07-02
Agent: CalmTower
Scope: Spikes 1, 3, 4, and 9 without live Claude subscription prompts

## Summary

This lane produced non-live evidence only. I did not run any `claude -p` prompt, did not run `claude auth status`, and did not use or request a fast/priority service tier.

`SPIKE-RESULT.md` is reserved by another agent (`RusticCliff`), so this report stays under the reserved worker scratch path for synthesis.

Main result: the installed Claude Code CLI is present and exposes most planned headless/containment flags, but `--bare` is a likely blocker for subscription mode because help says it never reads OAuth/keychain auth. The safe plan should not use `--bare` as a primary mitigation unless an opt-in live probe disproves the help text.

## Preregistered Criteria

Full preregistration: `preregistration.md`.

- Success for this lane meant fresh version/help evidence, blocked-env name scan, containment/auth/verifier matrices, and clear live-only boundaries.
- Kill/block evidence includes unavailable CLI, help requiring prompt submission, missing required flags, `--bare` breaking subscription auth, or verifier reliance on absent fields.

## Commands Run

Non-live local commands:

```bash
env | awk -F= 'BEGIN{IGNORECASE=1} ... blocked Anthropic/Claude/provider names ...' | sort -u
command -v claude
type -a claude
claude --version
claude --help 2>&1
claude -p --help 2>&1
claude auth --help 2>&1
claude auth status --help 2>&1
rg/sed static repository inspection for engine, MCP, provider boundary, API substitution, and plan docs
```

Raw captures:

- `blocked-env-names.txt`
- `claude-path.txt`
- `claude-version.txt`
- `claude-help.txt`
- `claude-p-help.txt`
- `claude-auth-help.txt`
- `claude-auth-status-help.txt`
- `observed-claude-p-help-flags.json`

## Evidence Observed

- `claude` path: `/home/ubuntu/.local/bin/claude`.
- Version: `2.1.198 (Claude Code)`.
- Parent env blocked-name scan found no matching blocked names.
- `claude -p --help` supports: `--output-format stream-json`, `--verbose`, `--include-partial-messages`, `--include-hook-events`, `--model`, `--effort`, `--permission-mode`, `--tools`, `--safe-mode`, `--disable-slash-commands`, `--strict-mcp-config`, `--mcp-config`, `--disallowedTools`, `--no-chrome`, `--no-session-persistence`, `--fallback-model`, `--settings`, `--setting-sources`, `--agents`, and plugin flags.
- `--max-turns` is not present in this installed help output.
- `--tools` help explicitly says `Use "" to disable all tools`.
- `--model` help explicitly names aliases including `fable` and full name `claude-fable-5`.
- `--effort` supports `low, medium, high, xhigh, max`.
- `-p` help warns that non-interactive mode skips the workspace trust dialog and silently ignores settings files that fail validation.
- `--safe-mode` disables customizations but says admin-managed policy settings still apply and built-in tools/permissions still work normally.
- `--bare` says it skips many surfaces, but also says Anthropic auth is strictly `ANTHROPIC_API_KEY` or `apiKeyHelper` via `--settings`; OAuth and keychain are never read.

## Spike 1: Empirical Claude Code Contract

Non-live pass:

- Fresh local version/help captured.
- Headless JSON stream flags are present.
- Fable model alias and xhigh effort are present.
- `claude auth status --help` confirms a JSON status command exists.

Non-live block:

- Auth source, real `system/init`, final `result`, `modelUsage`, `total_cost_usd`, and final text shape remain live-only.
- `--bare` is not safe to assume for subscription mode; help text says it bypasses OAuth/keychain.

Decision: implementation remains blocked until opt-in live fixtures prove exact `apiKeySource`, model fields, tool list, MCP state, and result usage.

## Spike 3: No-Tool and Config Containment

Candidate argv, subject to live startup verification:

```bash
claude -p \
  --model fable \
  --effort xhigh \
  --output-format stream-json \
  --verbose \
  --include-partial-messages \
  --tools "" \
  --permission-mode plan \
  --safe-mode \
  --disable-slash-commands \
  --strict-mcp-config \
  --mcp-config '{}' \
  --disallowedTools mcp__* \
  --no-chrome \
  --no-session-persistence
```

Important caveats:

- Do not emit `--max-turns`; this installed CLI help does not expose it.
- Do not use `--bare` for subscription mode unless live evidence proves OAuth/keychain still works despite help text.
- `--mcp-config '{}'` is a proposed empty-config shape, not proven by non-live evidence.
- `--safe-mode` does not disable built-in tools; `--tools ""` and startup verification remain mandatory.
- If startup fields do not expose tools/MCP/plugins/skills/agents/slash commands/session persistence sufficiently, v1 read-only claims should fail closed.

## Spike 4: Auth, Billing, and Model-Default Matrix

Recommended parent hard-refusal before any `claude` executable resolution:

| Source | Disposition |
| --- | --- |
| Any case spelling of `ANTHROPIC_API_KEY` | refuse-before-spawn |
| `ANTHROPIC_AUTH_TOKEN` | refuse-before-spawn |
| `ANTHROPIC_BASE_URL` | refuse-before-spawn |
| `ANTHROPIC_DEFAULT_*` | refuse-before-spawn unless each exact var is proven inert |
| `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, `CLAUDE_CODE_USE_FOUNDRY`, `CLAUDE_CODE_USE_ANTHROPIC_AWS` | refuse-before-spawn |
| Bedrock/AWS/Vertex/Foundry credentials when provider toggles are active | refuse-before-spawn |
| Claude settings `apiKeyHelper`, console/API auth, or fallback model | refuse or startup-detect-and-stop |
| `ANTHROPIC_MODEL` | refuse until live Spike 1 proves argv `--model fable` wins; then child-scrub only |
| Benign basics (`PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, terminal vars, needed Oracle vars) | allowlist after refusal passes |

Static repo finding:

- Current `EngineMode` is only `"api" | "browser"`.
- `resolveRunOptionsFromConfig` coerces Claude-like models to `api`.
- `src/oracle/run.ts` and `src/oracle/providerRoutePlan.ts` route Claude API calls through `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL`.
- MCP `consult` schema accepts only `engine: "api" | "browser"`.
- Existing `api_substitution_guard` and provider boundaries correctly reject post-result Anthropic API substitution for `claude_code_opus`, but they are not a before-spawn/start gate.

Plan implication: `fable-local` needs a central lane/auth guard before current CLI/MCP resolution can select API or browser machinery.

## Spike 9: Startup Verifier Decision Table

Verifier must pass only on observed, positive evidence. Requested-only evidence is not enough.

| Case | Required decision |
| --- | --- |
| Missing first `system/init` event | non-success: `missing_init_event` |
| Init schema unknown or critical fields absent | non-success: `unknown_or_incomplete_init_schema` |
| `apiKeySource` missing | non-success: `auth_source_missing` |
| `apiKeySource` equals API/env/helper/provider source | non-success: `auth_source_not_subscription` |
| `apiKeySource` unknown value | non-success: `auth_source_unknown` |
| Init/result model missing and only argv requested `fable` | non-success: `model_unverified` |
| Observed model/result usage is non-Fable | non-success: `model_not_fable` |
| Result `modelUsage` missing and init model is not enough to bound execution | non-success: `model_usage_unverified` |
| `tools` missing | non-success: `tools_unobservable` |
| `tools` non-empty | non-success: `tools_available` |
| MCP servers missing or non-empty when expected empty | non-success: `mcp_unverified_or_active` |
| Permission mode missing or not expected value | non-success: `permission_mode_unverified` |
| Skills/plugins/agents/slash commands/hooks/Chrome/session persistence/fallback cannot be observed | non-success: `config_surface_unobservable` |
| Any active risky surface observed | non-success with surface-specific reason |
| Final result absent after partial stream | non-success: `result_missing` |

Critical fields to preserve from live fixtures if available:

- Init: `type`, `subtype`, `claude_code_version`, `apiKeySource`, `model`, `tools`, `mcp_servers`, `permissionMode`, `slash_commands`, `agents`, `skills`, `plugins`, and any Chrome/session/fallback/config surface fields.
- Result: event type/subtype, final text location, `modelUsage`, `total_cost_usd`, status/duration fields, and any model fallback indicators.

## Recommended Plan Changes

1. Remove `--bare` from the default v1 command builder for subscription mode unless a live opt-in probe proves it preserves OAuth/keychain auth. Current help says it does not.
2. Remove `--max-turns` from planned argv for this installed CLI version; keep a feature-detected optional turn cap only if help/runtime support appears.
3. Add `--effort xhigh` to the empirical command contract because the installed CLI exposes it and the lane asks for xHigh effort.
4. Treat `ANTHROPIC_MODEL` as refusal until live precedence is proven; only child-scrub after proof.
5. Move `fable-local` resolution ahead of existing `api`/`browser` model coercion and MCP schema handling.
6. Keep existing provider-boundary/API-substitution tests, but do not count them as the billing guard; the billing guard must run before any `claude` subprocess.
7. Require live fixture fields for the startup verifier before implementation. If fields are absent, narrow or kill v1 rather than weakening claims.

## Live-Only / Blocked

- No `claude -p` prompt was sent.
- No subscription auth status was queried.
- No `system/init` or `result` event fixture was captured.
- No `--tools ""` runtime behavior was verified.
- No adversarial prompt containment test was run.
- No `ANTHROPIC_MODEL` precedence test was run.

## Created Files

- `.planning-runs/claude-code-spike-execution-2026-07-02/worker-a-nonfast/preregistration.md`
- `.planning-runs/claude-code-spike-execution-2026-07-02/worker-a-nonfast/REPORT.md`
- `.planning-runs/claude-code-spike-execution-2026-07-02/worker-a-nonfast/blocked-env-names.txt`
- `.planning-runs/claude-code-spike-execution-2026-07-02/worker-a-nonfast/claude-path.txt`
- `.planning-runs/claude-code-spike-execution-2026-07-02/worker-a-nonfast/claude-version.txt`
- `.planning-runs/claude-code-spike-execution-2026-07-02/worker-a-nonfast/claude-help.txt`
- `.planning-runs/claude-code-spike-execution-2026-07-02/worker-a-nonfast/claude-p-help.txt`
- `.planning-runs/claude-code-spike-execution-2026-07-02/worker-a-nonfast/claude-auth-help.txt`
- `.planning-runs/claude-code-spike-execution-2026-07-02/worker-a-nonfast/claude-auth-status-help.txt`
- `.planning-runs/claude-code-spike-execution-2026-07-02/worker-a-nonfast/observed-claude-p-help-flags.json`

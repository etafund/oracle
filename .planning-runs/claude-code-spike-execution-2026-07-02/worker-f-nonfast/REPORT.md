# Worker F Non-Fast Report

Date: 2026-07-02
Agent Mail name: QuietEagle
Lane: Spikes 12, 20, 21, 22
Scope: planning/spike only. No product implementation. No live Claude, browser, MCP backend, or priority service tier used.

## Preregistered Criteria

Full criteria are frozen in `PREREGISTRATION.md`.

Spike 12 success:
- Oracle can build useful supplied-context bundles without Claude Code Read/Grep/Glob.
- Exclusions, default ignored directories, dotfile behavior, and size caps remain Oracle-owned.
- Future subprocess prompt content can be passed by stdin and closed deterministically.

Spike 12 kill:
- Useful bundles require Claude Code tools.
- Oracle cannot preserve exclusions/size checks.
- Prompt content must be passed in argv.

Spike 20 success:
- Active CLI, MCP consult, restart/follow-up, and shared runner chokepoints are small and enforceable.
- Passive commands/resources remain route-neutral.
- Work can be split by disjoint write sets with route-blocking before side effects.

Spike 20 kill:
- Checks must be scattered ad hoc.
- Passive commands are entangled with active resolution.
- Blocking cannot happen before session/backend side effects.

Spike 21 success:
- Fake-run, live-local, MCP, and beta milestones have crisp prerequisites and rollback points.
- Earliest milestone provides evidence without live Claude/browser/MCP.

Spike 21 kill:
- Useful learning requires browser doctors, MCP overflow, and live Fable first.
- A broad architecture refactor is required before any evidence can land.

Spike 22 success:
- Behavior/docs can be local-owner-only use of official Claude Code CLI, with no hosted routing,
  credential collection, API substitution promise, or billing/quota certainty.
- Startup/result guards can reduce accidental API/gateway usage and expose limitations.

Spike 22 kill:
- Current official sources clearly disallow or materially muddy intended public use.
- Required wording implies guarantees or hidden state Oracle cannot observe.

## Files And Docs Inspected

Local files:
- `AGENTS.md`
- `SPIKE.md`
- `docs/plans/claude-code-subscription-adapter.md`
- `docs/plans/claude-code-subscription-adapter-review.md`
- `bin/oracle-cli.ts`
- `src/cli/engine.ts`
- `src/cli/runOptions.ts`
- `src/cli/sessionRunner.ts`
- `src/cli/sessionLifecycle.ts`
- `src/cli/dryRun.ts`
- `src/cli/markdownBundle.ts`
- `src/mcp/types.ts`
- `src/mcp/utils.ts`
- `src/mcp/tools/consult.ts`
- `src/mcp/tools/sessionResources.ts`
- `src/oracle/files.ts`
- `src/oracle/request.ts`
- `src/oracle/markdown.ts`
- `src/oracle/promptAssembly.ts`
- `src/oracle/types.ts`
- `src/oracle/v18/provider_boundaries.ts`
- `src/oracle/v18/provider_access_policy.ts`
- `src/oracle/api_substitution_guard.ts`
- `src/sessionManager.ts`
- `src/sessionStore.ts`
- `tests/engine.test.ts`
- `tests/runOptions.test.ts`
- `tests/mcp/utils.test.ts`
- `tests/mcp/consult.test.ts`
- `tests/oracle/v18/provider_boundaries.test.ts`
- `.planning-runs/claude-code-spike-execution-2026-07-02/worker-f/preregistration.md`

Official Anthropic / Claude Code sources inspected on 2026-07-02:
- https://code.claude.com/docs/en/cli-reference
- https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-or-max-plan
- https://code.claude.com/docs/en/model-config
- https://code.claude.com/docs/en/legal-and-compliance
- https://code.claude.com/docs/en/settings
- https://support.claude.com/en/articles/9876003-i-have-a-paid-claude-subscription-pro-max-team-or-enterprise-plans-why-do-i-have-to-pay-separately-to-use-the-claude-api-and-console
- https://support.claude.com/en/articles/12304248-manage-api-key-environment-variables-in-claude-code
- https://code.claude.com/docs/en/env-vars
- https://code.claude.com/docs/en/authentication
- https://code.claude.com/docs/en/errors
- https://code.claude.com/docs/en/llm-gateway
- https://support.claude.com/en/articles/12429409-manage-usage-credits-for-paid-claude-plans
- https://www.anthropic.com/legal/consumer-terms
- https://code.claude.com/docs/en/data-usage

## Commands Run

Registration and coordination:
- `macro_start_session(...)` as instructed. Registered as `QuietEagle`.
- Reserved `.planning-runs/claude-code-spike-execution-2026-07-02/worker-f-nonfast/**`.
- `fetch_inbox` for `QuietEagle`: no messages.

Local evidence:
- `pnpm tsx .planning-runs/claude-code-spike-execution-2026-07-02/worker-f-nonfast/bundle-harness.ts`
  - Result: passed, emitted JSON evidence summarized below.
- `pnpm vitest run tests/engine.test.ts tests/runOptions.test.ts tests/mcp/utils.test.ts tests/mcp/consult.test.ts tests/oracle/v18/provider_boundaries.test.ts`
  - Result: 5 test files passed, 119 tests passed.
- Source inspection with `rg`, `sed`, and `nl` over CLI, MCP, session, prompt, and provider-boundary files.

## Evidence Observed

### Spike 12: Prompt Bundle Viability

Current reusable path:
- `src/cli/markdownBundle.ts:16` builds a markdown bundle from existing `readFiles`,
  `createFileSections`, `buildPromptMarkdown`, and `buildPrompt`.
- `src/oracle/request.ts:48` appends formatted file sections to the user prompt.
- `src/oracle/markdown.ts:104` and `src/oracle/promptAssembly.ts:13` provide structured
  `[SYSTEM]`, `[USER]`, and file sections.

Oracle-owned file controls already exist:
- `src/oracle/files.ts:9` default ignored dirs include `node_modules`, `dist`, `coverage`,
  `.git`, `.turbo`, `.next`, `build`, and `tmp`.
- `src/oracle/files.ts:117` rejects oversized files.
- `src/oracle/files.ts:209` uses dotfile opt-in for glob expansion.
- `src/oracle/files.ts:211` loads `.gitignore`.
- `src/oracle/files.ts:219` sets `followSymbolicLinks: false`.

Harness evidence:
- Glob `["**/*", "!docs/**"]` yielded only `binary.bin` and `src/app.ts`.
- `node_modules/pkg/index.js` was skipped by default ignored-dir logic.
- `.env` was excluded from the broad glob, but explicit `[".env"]` read it and reported
  content length 31.
- `maxFileSizeBytes: 2` rejected `src/app.ts` with the expected size error.
- `buildMarkdownBundle` produced `[SYSTEM]`, `[USER]`, and markdown file fence sections.
- `promptWithFiles` still uses the legacy `### File 1: src/app.ts` section heading.
- `binary.bin` was accepted and decoded as UTF-8 replacement characters under the size cap.

Finding:
- Spike 12 is viable but not green as-is. The existing bundle path is a good base, but a
  Claude Code supplied-context wrapper needs binary rejection/summarization, sensitive filename
  policy, explicit manifest metadata, a context-size budget, and a read-only instruction prefix.
- Kill criteria are not triggered because prompt content can be stdin and Oracle can own file
  selection before spawn. Do not pass prompt content in argv.

### Spike 20: Exact Seam Map

Primary CLI active chokepoint:
- `bin/oracle-cli.ts:2087` resolves current two-engine mode.
- `bin/oracle-cli.ts:2464` dry-run summary is reached before live run.
- `bin/oracle-cli.ts:2492` calls `sessionStore.ensureStorage`.
- `bin/oracle-cli.ts:2509` creates a session.
- `bin/oracle-cli.ts:2643` enters shared `performSessionRun`.

Primary MCP active chokepoint:
- `src/mcp/types.ts:19` has `consultInputSchema`; `engine` is currently `api | browser`.
- `src/mcp/tools/consult.ts:597` starts `runConsultTool`.
- `src/mcp/tools/consult.ts:638` calls `mapConsultToRunOptions`.
- `src/mcp/tools/consult.ts:767` creates a session.
- `src/mcp/tools/consult.ts:838` enters `performSessionRun`.
- `src/mcp/tools/consult.ts:875` truncates returned log output to 4000 bytes; a Fable/MCP
  full-output contract must not rely on this path unchanged.

Shared runner chokepoint:
- `src/cli/sessionRunner.ts:72` starts `performSessionRun`.
- `src/cli/sessionRunner.ts:100` dispatches browser runs.
- `src/cli/sessionRunner.ts:455` dispatches API runs.
- This is a useful second assertion point, but too late for a strict "no backend/session side
  effects before lane block" guarantee because the session is already running.

Restart/follow-up/stored execution:
- `bin/oracle-cli.ts:2762` restarts a session and recreates a new session at `:2869`.
- `bin/oracle-cli.ts:2968` executes a stored session directly via `performSessionRun`.
- `bin/oracle-cli.ts:2700` follow-up command starts a browser follow-up path.
- These need policy assertions or explicit refusal for `claude-code`/`fable-local`.

Passive resources:
- `src/mcp/tools/sessionResources.ts:12` exposes passive
  `oracle-session://{id}/{kind}` resources for metadata/log/request.
- These can remain route-neutral; future raw Claude output resources can extend the kind switch
  without invoking lane resolution.

Provider boundary reuse:
- `src/oracle/v18/provider_access_policy.ts:82` already names non-Oracle CLI slots.
- `src/oracle/api_substitution_guard.ts:39` maps `claude_code_opus` to
  `claude_code_subscription_cli`.
- `src/oracle/v18/provider_boundaries.ts:54` defines the Claude Code subscription CLI access path.
- Add the Fable slot to this taxonomy instead of creating a parallel policy system.

Finding:
- Spike 20 is viable. The main required plan change is to add one shared engine/lane flow policy
  that CLI and MCP call before `resolveRunOptionsFromConfig`/session creation, with
  `performSessionRun` as a defensive assertion.

### Spike 21: Sequencing Split

Recommended sequence:
1. Fake-run skeleton.
   - Add lane/policy types, no-default route-block, session storage shape, dry-run support, and a
     fake `claude-code` runner. Tests prove API/browser behavior stays green and Fable blocks
     before side effects.
2. Supplied-context bundle vertical slice.
   - Wrap `buildMarkdownBundle`, add sensitive/binary/context-budget guards, and pass prompt over
     stdin to a local fake child process harness.
3. Live local Claude Code opt-in.
   - Add executable/version/status/startup guards and require explicit live opt-in. Verify actual
     model from JSON/stream output rather than trusting startup args.
4. MCP Fable path.
   - Add schema lane, full-output/overflow contract, and resource behavior after the CLI fake and
     local live paths are stable.
5. Public/beta docs.
   - Only after compliance wording is accepted and local-owner guardrails are in place.

Finding:
- Spike 21 is viable. Useful learning does not require live Fable or MCP first. Starting with fake
  runs lowers risk and gives maintainers testable seams immediately.

### Spike 22: Compliance And Public Wording

Official-source evidence:
- Anthropic support says Pro/Max users can connect Claude Code with Claude credentials, and warns
  that `ANTHROPIC_API_KEY` makes usage API-billed rather than subscription-included:
  https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-or-max-plan
- Claude Code env-var docs state `ANTHROPIC_API_KEY` is used instead of subscription auth, and in
  non-interactive `-p` mode it is always used when present:
  https://code.claude.com/docs/en/env-vars
- Error/auth docs repeat that env vars, API keys, helper scripts, gateway/base URL settings, or
  Bedrock/Vertex modes can override subscription behavior:
  https://code.claude.com/docs/en/errors
  https://code.claude.com/docs/en/authentication
  https://code.claude.com/docs/en/llm-gateway
- Model docs say launch model flags/env only apply at startup and actual model should be read from
  JSON/stream `modelUsage`; fallback settings can substitute models:
  https://code.claude.com/docs/en/model-config
- CLI docs document `-p`, `--output-format stream-json`, `--strict-mcp-config`, `--tools ""`,
  `--no-chrome`, `--no-session-persistence`, and permission options:
  https://code.claude.com/docs/en/cli-reference
- Legal/compliance docs say OAuth is intended for subscription purchasers/native Anthropic apps,
  and third-party developers building products/services interacting with Claude capabilities should
  use API key auth; they also say Anthropic does not permit third-party developers to offer
  Claude.ai login or route requests through Free/Pro/Max credentials on behalf of users:
  https://code.claude.com/docs/en/legal-and-compliance
- Consumer terms prohibit credential sharing and automated/non-human access except via API key or
  explicit permission; Claude Code docs are the more specific source for ordinary individual
  Claude Code usage:
  https://www.anthropic.com/legal/consumer-terms
- Data usage docs confirm Claude Code runs locally but sends prompts/outputs over the network, and
  consumer data policies apply for Free/Pro/Max:
  https://code.claude.com/docs/en/data-usage

Finding:
- Hidden/local-owner mode is not killed by the docs I inspected.
- Public wording is high-risk if it sounds like a "subscription adapter", "API replacement", proxy,
  hosted service, credential router, or quota/billing guarantee.
- The release posture should be experimental/local-only until the sponsor accepts that ambiguity.
  This is not legal advice; it is engineering wording risk based on official docs.

## Sponsor Value Calls

1. Public posture:
   - Recommended: "experimental local Claude Code CLI review mode".
   - Avoid: "Claude subscription adapter", "Fable API", "API without API key", "proxy", "hosted",
     "included billing", or "guaranteed Pro/Max quota".

2. Hidden vs public:
   - Recommended: land fake-run and local-only hidden/expert mode first.
   - Public docs/npm announcement should wait for explicit sponsor acceptance of Anthropic wording
     risk.

3. Fail-closed env guard:
   - Recommended: fail closed if API key/gateway/BYOK/Bedrock/Vertex/custom auth env or settings
     are detected, unless an explicitly named override is provided.
   - Sponsor must decide whether any override is allowed in public mode.

4. Tool isolation:
   - Recommended default Claude Code invocation disables built-in tools and MCP (`--tools ""`,
     strict MCP config) until there is a deliberate tools story.

5. MCP output contract:
   - Recommended: full Fable output should be a first-class MCP result/resource path, not a
     4000-byte log-tail reuse.

6. Release grouping:
   - Recommended: do not require API/browser/Fable lanes to ship as one unit. Fake-run and
     dry-run policy are valuable first.

## Recommended Plan Changes

1. Rename the plan surface away from "subscription adapter".
   - Use local-owner wording: "Claude Code local CLI lane" or "local Claude Code review mode".

2. Add a route/lane policy module before session creation.
   - CLI: call it before `resolveRunOptionsFromConfig`/`createSession`.
   - MCP: call it before `mapConsultToRunOptions`/`createSession`.
   - Shared runner: assert it again in `performSessionRun`.
   - Passive commands/resources: do not route-resolve.

3. Extend stored session shape explicitly.
   - Add lane/mode metadata for `claude-code` or equivalent.
   - Add restart/exec/follow-up refusal rules before backend work.

4. Build a Fable supplied-context wrapper over existing prompt assembly.
   - Keep current file expansion behavior, but add:
     - sensitive filename policy for `.env`, credentials, tokens, and key material;
     - binary detection or rejection;
     - bundle manifest with file count, bytes, hashes, and truncation decisions;
     - context-size budget;
     - read-only/local-supplied-context instruction prefix;
     - stdin subprocess protocol and deterministic `stdin.end()`.

5. Add Fable dry-run before live run.
   - Show executable path/status, env guard result, requested model, file count, bytes, and command
     shape without spawning Claude for live work.

6. Verify actual Claude Code route and model at runtime.
   - Do not trust `--model`/env alone. Parse JSON/stream result fields such as `modelUsage` where
     available.
   - Warn or fail if fallback/availableModels or env settings cause non-Fable/non-subscription
     behavior.

7. Start with fake-run tests.
   - Tests should prove Fable route blocks before session creation when prerequisites fail, while
     existing API/browser tests continue passing.

## Files Created

- `.planning-runs/claude-code-spike-execution-2026-07-02/worker-f-nonfast/PREREGISTRATION.md`
- `.planning-runs/claude-code-spike-execution-2026-07-02/worker-f-nonfast/bundle-harness.ts`
- `.planning-runs/claude-code-spike-execution-2026-07-02/worker-f-nonfast/REPORT.md`

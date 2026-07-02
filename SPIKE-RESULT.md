# Spike Result: Claude Code Local CLI Lane

Date: 2026-07-02
Coordinator: RubyCliff
Source plan: `SPIKE.md`
Evidence root: `.planning-runs/claude-code-spike-execution-2026-07-02/`

Live addendum: after the initial no-live report was pushed, the operator approved minimal Claude Code live probes and ChatGPT Pro browser prompt smoke. Sanitized results are recorded in `.planning-runs/claude-code-spike-execution-2026-07-02/coordinator-live/LIVE-GATE-RESULTS.md`. Gemini Deep Think remained intentionally skipped, MCP `fable-local` was narrowed to CLI-only, and MCP overflow / raw purge policy decisions remain deferred.

## Executive Summary

The initial spike portfolio was exercised under the safe default policy: no live Claude prompt, no browser prompt submission, no ChatGPT `Answer now` click, and no real MCP-client prompt smoke without explicit human opt-in. Six non-fast GPT-5.5 xhigh workers completed the assigned non-live experiments and wrote evidence under the planning run directory. The later live addendum records the operator-approved Claude Code and ChatGPT Pro probes.

The main outcome is not "ship the adapter as planned." The evidence supports a narrower implementation: start with a hidden or expert local Claude Code CLI lane, built from fake-run and dry-run tests first, with hard route gates before session/backend side effects. Do not expose MCP `fable-local`, public browser reviewed lanes, or live smoke claims until the blocked live/readiness gates are cleared.

The hardest negative findings are:

- Do not use `--bare` for subscription mode by default. Installed Claude Code help says bare/simple mode does not read OAuth/keychain credentials and instead requires `ANTHROPIC_API_KEY` or `apiKeyHelper`.
- Do not add `fable` to shared API/browser model resolution. Current Oracle routing can reinterpret `fable` as OpenRouter API, Anthropic API-like, or browser GPT depending on inputs.
- Do not reuse existing MCP `consult` log-tail output or generic session artifacts for raw Claude streams. They do not satisfy complete visible-event semantics or raw-stream privacy requirements.
- Do not include remote browser, `oracle serve`, router/bridge, detached session workers, or unproven network MCP contexts in v1.

## Worker Coverage

| Worker | Agent Mail | Spikes | Report |
| --- | --- | --- | --- |
| A | CalmTower | 1, 3, 4, 9 | `.planning-runs/claude-code-spike-execution-2026-07-02/worker-a-nonfast/REPORT.md` |
| B | MagentaTiger | 2, 13, 18, 19 | `.planning-runs/claude-code-spike-execution-2026-07-02/worker-b-nonfast/FINAL_REPORT.md` |
| C | BronzeSpire | 5, 6, 10 | `.planning-runs/claude-code-spike-execution-2026-07-02/worker-c-nonfast/REPORT.md` |
| D | RedCondor | 7, 8, 11 | `.planning-runs/claude-code-spike-execution-2026-07-02/worker-d-nonfast/worker-d-report.md` |
| E | AzureCitadel | 14, 15, 16, 17, 23, 24 | `.planning-runs/claude-code-spike-execution-2026-07-02/worker-e-nonfast/REPORT.md` |
| F | QuietEagle | 12, 20, 21, 22 | `.planning-runs/claude-code-spike-execution-2026-07-02/worker-f-nonfast/REPORT.md` |

Coordinator supplemental probes are in `.planning-runs/claude-code-spike-execution-2026-07-02/coordinator/`.

## Validation Run

No-live validation completed before this report:

- `pnpm vitest run tests/browser/selectors/chatgptManifest.test.ts tests/browser/providers/geminiDeepThink_verification.test.ts tests/mcp/schema.test.ts tests/cli/capabilities.test.ts` passed: 3 files, 47 tests.
- `pnpm run test:v18:fixtures` passed: 12 files, 166 tests.
- `pnpm test:v18` passed: unit, fixtures, e2e mock, privacy, and conformance suites.
- `pnpm vitest run tests/live/chatgpt-smoke-live.test.ts tests/live/gemini-smoke-live.test.ts` skipped both files as expected because live flags were not set.
- Worker B targeted suite passed: 10 files, 150 tests.
- Worker E targeted browser/MCP/artifact suite passed: 20 files, 209 tests.
- Worker F targeted seam/provider suite passed: 5 files, 119 tests.

## Spike Results

| # | Result | Finding |
| ---: | --- | --- |
| 1 | Partial, live-gated | `claude` exists at `/home/ubuntu/.local/bin/claude`, version `2.1.198 (Claude Code)`, and help exposes the needed non-interactive flags. Live `system/init` and `result` stream fields remain blocked without opt-in. |
| 2 | Complete | A central lane start gate is feasible if it runs before CLI/MCP run-option resolution, provider route planning, browser/remote setup, session creation, workers, and router requests. Harnessed route blocks had `noBackendStarted: true`. |
| 3 | Partial, live-gated | Candidate containment flags exist, including `--tools ""`, `--safe-mode`, `--disable-slash-commands`, `--strict-mcp-config`, `--no-chrome`, and `--no-session-persistence`. Runtime proof of empty tools/config surfaces still needs live stream fixtures. |
| 4 | Complete with conservative policy | Hard-refuse API/provider env and settings before executable resolution. `ANTHROPIC_MODEL` should refuse until live precedence is proven. Do not silently unset auth/billing variables. |
| 5 | Complete | Raw stdout/stderr preservation is feasible with byte offsets computed from `Buffer` lengths, not decoded string lengths. Parse failures and invalid UTF-8 can be preserved without byte loss. |
| 6 | Complete with policy default | Use a 1 MiB default MCP inline visible-byte limit. On overflow, finish the run if practical, persist complete raw artifacts, return typed non-success, set `eventsComplete: false`, and provide resource URIs. |
| 7 | Complete | v1 should allow attached local CLI and, only after proof, same-user local stdio MCP. Refuse detached/session workers, network MCP, `oracle serve`, router, bridge, remote browser, and remote Chrome for Fable. |
| 8 | Complete | Executable provenance can distinguish common safe installs from repo-local, relative, world-writable, unsafe symlink, and dangerous wrapper cases. Current local `claude` path is warning-level acceptable for this machine. |
| 9 | Partial, live-gated | Startup verifier must fail closed on missing/unknown auth, model, tools, MCP, permission, Chrome, persistence, hooks/plugins/skills, fallback, or result fields. Requested-only `--model fable` is not proof. |
| 10 | Complete | A fake-run vertical slice can exercise session creation, raw artifacts, normalized events, adapter metadata, final answer extraction, MCP structured output, parse failure, startup mismatch, and nonzero exit without live quota. |
| 11 | Complete | Attached process-group lifecycle plus a single-flight lock is feasible. Harnesses killed timeout, flood, verifier-failure, and grandchild cases, preserved partial bytes, and recovered stale locks while refusing corrupt locks. |
| 12 | Complete with hardening required | Existing prompt/file assembly can supply useful context through stdin with no Claude Code file tools. Add binary/sensitive-file guards, manifest metadata, context budget, and a read-only lane prefix. |
| 13 | Complete | Keep `fable` and `claude_code_fable_5` isolated from shared API model registries, OpenRouter/custom passthrough, Anthropic API routing, and `--models` fan-out. |
| 14 | Partial, browser-live-gated | Browser selector-state proof is strong in fake/FSM tests. Live readiness remains unknown because default doctors skip live UI probes and report unknown/not-ready when not opted in. |
| 15 | Partial | ChatGPT pre-submit drift gating is strong. Gemini Deep Think should add a live DOM synthesis/re-probe immediately before submit before claiming equivalent drift resistance. |
| 16 | Scope gate failed for now | MCP `fable-local` is not ready. Current MCP lacks `lane`, local-owner/client identity facts, Claude auth verifier, and complete visible-event output semantics. Recommend CLI-only alpha. |
| 17 | Complete with blocker findings | v18 evidence ledger/export is safer than generic session artifacts. Raw Claude streams need typed artifact kinds, no-follow/realpath enforcement, `0600` files, `0700` dirs, redacted-export exclusion, resource URIs, and typed purge. |
| 18 | Complete | Route-block self-correction is feasible. Errors need `agent_lane_blocked`, exit code `2`, attempted route, reason, policy version, source precedence, supported lane templates, `noBackendStarted`, and no prompt leakage. |
| 19 | Complete | A single lane registry can generate help, capabilities JSON, MCP lane enum, route-block replacements, doctor lane records, and lane policy tests without drift. |
| 20 | Complete | Insertion points are small enough: CLI before `resolveRunOptionsFromConfig`/session creation, MCP before `mapConsultToRunOptions`/session creation, and `performSessionRun` as a defensive assertion. |
| 21 | Complete | Best sequence is fake-run skeleton, supplied-context vertical slice, opt-in live local CLI, MCP path, then public/beta docs. Useful learning does not require live Fable first. |
| 22 | Complete with wording risk | Official docs support ordinary local Claude Code use by a subscription owner, but public product wording is risky. Use local-owner wording and avoid "subscription adapter", "API bypass", hosted/proxy, credential routing, or billing guarantees. |
| 23 | Blocked as intended | Live local CLI smoke is not runnable yet because the lane, guards, verifier, raw persistence, typed artifacts, and fake-run path are not implemented and no live opt-in was granted. |
| 24 | Blocked as intended | Live MCP/browser smoke is not runnable yet. MCP lacks launch-context proof and full-output semantics; browser readiness needs non-submitting live probes and explicit prompt-smoke opt-in. |

## Human-Gated Items Routed

The remaining human gates were front-loaded in `.planning-runs/claude-code-spike-execution-2026-07-02/coordinator/HUMAN-GATE-FRONTLOAD.md`.

The operator later answered the gates:

- Claude live probes: approved and run.
- ChatGPT Pro browser readiness and prompt smoke: approved and run through the remote browser router.
- Gemini Deep Think: intentionally skipped because there is no active Gemini lane/subscription.
- MCP: CLI-only for `fable-local`; do not implement or advertise MCP `fable-local` in the hidden alpha.
- Sequencing: hidden alpha is acceptable.
- MCP overflow policy and raw purge scope: deferred for more context.

Original default if unanswered:

- No live Claude Code prompt probes.
- No browser prompt submission and no ChatGPT `Answer now` clicks.
- No real MCP prompt smoke.
- Conservative sponsor choices: hidden/local alpha allowed, hard env refusal only, MCP overflow returns typed non-success after raw persistence, purge only Claude raw artifacts by kind, no remote browser workers in reviewed-lane v1, fail-fast lock contention, hidden expert `--engine claude-code --model fable`, and local-owner compliance wording.

Prepared but not run without opt-in:

- Minimal `claude -p --model fable --effort xhigh --output-format stream-json ... --tools ""` probe.
- `ANTHROPIC_MODEL` precedence probe.
- Non-submitting ChatGPT Pro Extended Reasoning and Gemini Deep Think readiness probes.
- Real MCP client launch-context check.

Post-approval live findings:

- Claude Code `2.1.198` live stream exposed verifier-critical startup/result fields: `apiKeySource: "none"`, `model: "claude-fable-5"`, `tools: []`, `mcp_servers: []`, `permissionMode: "plan"`, empty slash commands/skills/plugins, and `fast_mode_state: "off"`.
- `--mcp-config '{}'` is invalid; the empty strict config shape is `--mcp-config '{"mcpServers":{}}'`.
- `ANTHROPIC_MODEL=claude-haiku-4-5-20251001` did not override `--model fable` for the main assistant run on this version.
- `modelUsage` included the primary `claude-fable-5` usage plus a small `claude-haiku-4-5-20251001` entry, so the verifier should distinguish primary assistant model evidence from auxiliary Claude Code bookkeeping usage.
- Built-in `agents` remained listed in startup fields despite safe mode and disabled slash commands; no tools or agents were invoked.
- ChatGPT Pro remote-browser smoke selected `Pro Extended`, verified the model selection, returned `CHECK_CHATGPT_PRO_OK_20260702`, archived the conversation, and saved output under the coordinator live artifacts.
- `oracle doctor chatgpt` still reports degraded without a live UI probe, and the Vitest live smoke skipped because it preflights local Chrome cookies instead of the configured `oracle serve` router.

## Key Architectural Findings

### Lane Gate

The lane gate must be the primary active-start contract. It should run before existing engine/model inference can reinterpret user intent, before remote browser config can affect unrelated paths, and before session creation or backend startup.

Required active lanes for the registry:

- `chatgpt-pro`
- `gemini-deep-think`
- `fable-local`

Compatibility forms can exist, but only after resolving to an explicit lane. Bare `--model fable`, `--engine api --model fable`, and `--models gpt-5.5-pro,fable` should route-block.

### Claude Code Invocation

Candidate non-live argv shape, subject to live startup verification:

```bash
claude -p \
  --model fable \
  --effort xhigh \
  --output-format stream-json \
  --verbose \
  --include-partial-messages \
  --include-hook-events \
  --permission-mode plan \
  --safe-mode \
  --disable-slash-commands \
  --strict-mcp-config \
  --mcp-config '{"mcpServers":{}}' \
  --disallowedTools 'mcp__*' \
  --no-chrome \
  --no-session-persistence \
  --tools ''
```

Do not emit `--bare` by default. Do not emit `--max-turns` for this installed CLI version unless feature detection later proves support.

### Auth And Billing Guards

Product code should hard-refuse, before executable resolution, any parent environment or settings source that can select API, gateway, BYOK, Bedrock, Vertex, Foundry, fallback, or helper auth. Error text should include variable/source names but never values.

Official current docs used for this decision:

- Claude Pro/Max support article: https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-or-max-plan
- Claude Code CLI reference: https://code.claude.com/docs/en/cli-reference
- Claude Code environment variables: https://code.claude.com/docs/en/env-vars
- Claude Code legal and compliance: https://code.claude.com/docs/en/legal-and-compliance

These sources are compatible with local owner use but support fail-closed handling because `ANTHROPIC_API_KEY` and provider/gateway variables can override subscription behavior.

### Raw Streams And MCP

Raw stream artifacts should be first-class, typed artifacts:

- `claude-code-stdout.raw`
- `claude-code-stderr.raw`
- `claude-code-events.normalized.ndjson`
- `claude-code-adapter.json`

Normalized events should include stream, receive sequence, byte offset, byte length, raw base64 or raw resource reference, parse status, partial flag, safe decoded text when valid, and extracted JSON type only after successful parsing.

MCP success may only include inline events if complete. Overflow must never return a partial inline list with `eventsComplete: true`.

### Browser Lanes

Existing fake/FSM coverage is useful but not enough for live readiness. Browser lanes should remain protected-route/fake verified until default non-submitting doctor probes can prove selector state. ChatGPT has strong pre-submit gates; Gemini needs an immediate pre-submit live DOM re-probe.

### Privacy

Do not write raw Claude streams through current generic `SessionArtifact.kind: "file"` paths. The temp harness proved a symlinked `sessions/<id>/artifacts` directory can redirect generic writes outside Oracle home. Add no-follow/realpath checks and owner-only modes before raw persistence.

## Recommended Plan Changes

1. Rename the implementation surface from "subscription adapter" to "local Claude Code CLI lane" or "experimental local Claude Code review mode".
2. Add a single `LaneRegistry` and `lanePolicy.resolve()` before product implementation. Generate help, capabilities, MCP schema, doctor records, and route-block replacements from it.
3. Add `--lane <chatgpt-pro|gemini-deep-think|fable-local>`. Treat `--engine claude-code --model fable` as hidden expert compatibility only.
4. Keep Fable aliases out of shared API/browser model registries and multi-model fan-out.
5. Move passive command detection before active lane resolution so status/session/render/evidence resources remain route-neutral.
6. Add hard parent-env and settings refusal before resolving or spawning `claude`.
7. Add a safe Claude Code executable resolver with absolute realpath, ownership/mode/symlink-chain recording, repo-local refusal, world-writable refusal, and `shell: false`.
8. Add attached-only process-group cleanup plus a Fable single-flight lock. Default lock contention should fail fast.
9. Build raw stream persistence before parsing and make parser offsets byte-based only.
10. Add typed raw artifact kinds, owner-only modes, redacted-export exclusion, resource URIs, and typed purge.
11. Implement MCP `fable-local` only after CLI fake and live local paths pass and launch context can prove same-user local execution.
12. Add default non-submitting browser doctor UI probes; unknown selector state must be not-ready.
13. Add Gemini pre-submit DOM re-verification analogous to ChatGPT.
14. Keep public docs/beta release blocked until the compliance wording is accepted.

## Remaining Open Risks

- Live Claude Code stream fields are unknown. The startup verifier still needs real `system/init` and final `result` fixtures for auth source, model, tools, MCP, config surfaces, usage, and fallback evidence.
- `--tools ""`, empty MCP config, no Chrome, no session persistence, and permission mode containment still need runtime proof.
- `ANTHROPIC_MODEL` CLI precedence over `--model fable` needs proof before any child-scrub policy is allowed.
- macOS and Windows executable/process-tree behavior were not exercised on this Linux host.
- Real MCP client launch contexts remain unproven.
- Real MCP client tolerance for 1 MiB inline events should still be tested.
- Browser doctors currently report skipped/unknown when no live UI probe is run.
- Compliance posture remains wording-sensitive and should be treated as engineering risk, not legal advice.

## Revised Implementation Strategy

Phase 1: fake-run lane skeleton.

- Add lane registry and route-block errors.
- Add no-default active route policy.
- Add fake `claude-code` runner.
- Prove blocked routes happen before session creation and backend counters.
- Keep existing API/browser tests green.

Phase 2: supplied-context vertical slice.

- Reuse Oracle prompt/file assembly.
- Add sensitive filename policy, binary rejection or summarization, manifest metadata, context-size budget, read-only lane prefix, and stdin-only child protocol.
- Persist raw stdout/stderr and normalized events for fake child runs.

Phase 3: opt-in local Claude Code CLI.

- Add executable resolver, env/settings guard, local-owner guard, startup verifier, process cleanup, and lock.
- Run the minimal live prompt only after explicit human opt-in.
- Fail closed on missing or ambiguous startup/result evidence.

Phase 4: MCP after CLI proof.

- Add MCP `lane`, launch-context facts, full inline/overflow semantics, raw resource URIs, and typed non-success behavior.
- Do not reuse the 4000-byte log tail path.

Phase 5: browser/public release.

- Add non-submitting live doctor probes.
- Add Gemini pre-submit re-probe.
- Run explicit live browser smokes only after human opt-in.
- Update docs/changelog only when the feature is user-facing and the sponsor accepts the release posture.

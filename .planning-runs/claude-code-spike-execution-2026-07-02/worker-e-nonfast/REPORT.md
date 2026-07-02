# Worker E Non-Fast Report

Agent Mail identity: AzureCitadel
Date: 2026-07-02
Scope: Spikes 14, 15, 16, 17, 23, and 24 from `SPIKE.md`.

Shared `SPIKE-RESULT.md` was reserved by another worker, so this lane report is written here for aggregation. No product implementation changes were made.

## Preregistered Criteria

Preregistered success and kill criteria are in `./preregistration.md`. The key constraints were: no live browser prompt submission, no subscription prompt, no ChatGPT `Answer now` click, and no live smoke without human opt-in.

## Commands Run

- `pnpm vitest run tests/browser/mode_verification.fixture.test.ts tests/browser/providers/chatgptPro_fsm_wiring.test.ts tests/browser/providers/geminiDeepThink_fsm_wiring.test.ts tests/browser/providers/geminiDeepThink_verification.test.ts tests/browser/output-capture/proLongWait.test.ts tests/browser/output-capture/turnBinding.test.ts tests/browser/selectors/chatgptManifest.test.ts tests/browser/selectors/chatgptEffortStrategy.test.ts tests/gemini-web/selectors.test.ts tests/mcp/consult.test.ts tests/mcp/consultDetachedEnv.test.ts tests/mcp/server.test.ts tests/browser/artifacts.test.ts tests/sessionManager.test.ts tests/browser/evidence_redact_always.test.ts tests/oracle/v18/evidence_unsafe.test.ts tests/cli/evidence/ledger_export.test.ts tests/cli/evidence/evidenceCommand.test.ts tests/cli/doctor/providerDoctor.test.ts tests/cli/run/protected_dispatch.test.ts`
  - Result: 20 test files passed, 209 tests passed.
- `pnpm exec tsx bin/oracle-cli.ts doctor chatgpt --pro --extended-reasoning --json`
  - Result: degraded, not ready. Cookie sync was unknown because no live cookie read was attempted, keytar was missing, a recent ChatGPT session existed, and live UI probe was not requested.
- `pnpm exec tsx bin/oracle-cli.ts doctor gemini --deep-think --json`
  - Result: blocked. Gemini auth was missing, most recent Gemini session was error, and live Gemini UI probe was not requested.
- `pnpm exec tsx bin/oracle-cli.ts run --provider chatgpt --chatgpt-pro --extended-reasoning --prompt "SPIKE dry run prompt; do not submit" --json`
  - Result: protected-route planner only. It emitted redacted prompt metadata and a browser run command; no prompt was submitted.
- `pnpm exec tsx bin/oracle-cli.ts run --provider gemini --gemini-deep-think --prompt "SPIKE dry run prompt; do not submit" --json`
  - Result: protected-route planner only. It emitted redacted prompt metadata and a browser run command; no prompt was submitted.
- Throwaway `tsx -e` temp-directory harness against `writeTextBrowserArtifact`.
  - Result: a pre-existing symlinked `sessions/<id>/artifacts` directory redirected the written artifact outside the Oracle home: `escaped: true`.

## Files and Tests Inspected

Browser readiness and drift:
- `src/browser/state/chatgptPro.ts`
- `src/browser/state/geminiDeepThink.ts`
- `src/browser/providers/chatgptDomProvider.ts`
- `src/browser/providers/geminiDeepThinkDomProvider.ts`
- `src/browser/providerDomFlow.ts`
- `src/browser/selectors/chatgpt/manifest.ts`
- `src/browser/selectors/chatgpt/effortStrategy.ts`
- `src/gemini-web/selectors/geminiDeepThinkManifest.ts`
- `src/gemini-web/executor.ts`
- browser fixture/FSM/output-capture tests listed in the command above

MCP and launch context:
- `bin/oracle-mcp.ts`
- `src/mcp/server.ts`
- `src/mcp/types.ts`
- `src/mcp/tools/consult.ts`
- `src/mcp/tools/sessionResources.ts`
- `src/mcp/utils.ts`
- `docs/mcp.md`
- `tests/mcp/consult.test.ts`
- `tests/mcp/consultDetachedEnv.test.ts`
- `tests/mcp/server.test.ts`

Artifacts, redaction, export, purge:
- `src/sessionManager.ts`
- `src/browser/artifacts.ts`
- `src/browser/runLive_v18.ts`
- `src/browser/evidence_redact_always.ts`
- `src/oracle/v18/evidence.ts`
- `src/oracle/v18/evidence_unsafe.ts`
- `src/oracle/v18/evidence_quarantine_raw.ts`
- `src/oracle/evidence_ledger_sanitize.ts`
- `src/cli/sessionDisplay.ts`
- `src/cli/sessionCommand.ts`
- `src/cli/commands/evidence/index.ts`
- `src/cli/commands/evidence/ledger_export.ts`
- artifact/evidence/session tests listed in the command above

## Spike 14: Browser Selector-State Proof Without Submission

Status: passes for fake/fixture proof; live readiness remains unknown without an explicit non-submitting UI probe.

Evidence:
- ChatGPT has a pure FSM that requires `mode_verified_same_session` before `submit_prompt`; submitting early transitions to `prompt_submitted_before_verification` (`src/browser/state/chatgptPro.ts:218`).
- ChatGPT production DOM wrapper probes/selects mode before submit and runs a synthesis gate before the underlying send click (`src/browser/providers/chatgptDomProvider.ts:525`, `:554`).
- Gemini has a pure Deep Think FSM and fixture verifier, including highest-visible thinking-level logic (`src/browser/state/geminiDeepThink.ts:103`, `:197`, `:258`).
- Gemini production wrapper blocks the underlying `submitPrompt` unless the FSM has reached Deep Think verification (`src/browser/providers/geminiDeepThinkDomProvider.ts:526`).
- Fixture tests cover success, wrong mode, missing controls, visible-but-unselected Deep Think, unknown effort labels, and prompt-before-verification rejection (`tests/browser/mode_verification.fixture.test.ts:24`, `:120`, `:202`).
- ChatGPT manifest explicitly includes `answer_now_cta` as a detection selector and documents the do-not-click rule (`src/browser/selectors/chatgpt/manifest.ts:29`, `tests/browser/selectors/chatgptManifest.test.ts:63`).

Live-only blocker:
- Provider doctors do not run a default live UI probe. Without an injected probe they report `ui_probe_skipped` / unknown, not selector-ready (`src/cli/commands/doctor/chatgpt.ts:116`, `:220`; `src/cli/commands/doctor/gemini.ts:92`).

## Spike 15: Browser Drift and Pre-Submit Abort

Status: ChatGPT is strong; Gemini is partially covered but should add an immediate pre-submit DOM re-probe.

Evidence:
- ChatGPT wrapper proves that `submitPrompt` without verification never calls the underlying adapter, and stale live-tab mismatches fail before send (`tests/browser/providers/chatgptPro_fsm_wiring.test.ts:271`, `:290`).
- ChatGPT drift in `selectMode` lands in `ui_drift_suspected` and gates submit (`tests/browser/providers/chatgptPro_fsm_wiring.test.ts:309`).
- Gemini wrapper proves no underlying send click without `selectMode`, gates select failures, and marks empty output as `output_capture_empty` (`tests/browser/providers/geminiDeepThink_fsm_wiring.test.ts:127`, `:177`, `:194`).
- `Answer now` is treated as a wait state; the controller has an invariant that no decision maps to a click (`tests/browser/output-capture/proLongWait.test.ts:102`, `:114`).
- Stale assistant turns and prompt-hash mismatches are rejected as `output_capture_unverified` (`tests/browser/output-capture/turnBinding.test.ts:19`, `:31`).

Gap:
- Gemini's wrapper currently verifies by sending fixed labels (`"gemini"`, `"deep think"`) after adapter selection (`src/browser/providers/geminiDeepThinkDomProvider.ts:504`, `:516`) and then gates submit through the FSM. It does not have a ChatGPT-style live-tab synthesis gate immediately before submit. Plan should add one before treating Gemini as fully drift-proof.

## Spike 16: MCP Launch-Context Subscription Auth

Status: scope gate fails for `fable-local` over MCP today. Current MCP can plan/run existing Oracle engines, but it does not expose enough launch-context facts for local Claude subscription spawning.

Evidence:
- MCP server is stdio-only and registers tools/resources; there is no client identity, local owner proof, transport-locality object, or Claude auth verifier (`src/mcp/server.ts:15`, `:35`).
- `consultInputSchema` supports `engine: "api" | "browser"` only. There is no `lane`, `fable-local`, or `claude-code` engine (`src/mcp/types.ts:19`, `:26`).
- MCP consult maps inputs through current process env/config (`src/mcp/utils.ts:89`, `:126`) and can dry-run resolved details without prompt submission (`src/mcp/tools/consult.ts:704`).
- MCP browser runs return only the last 4000 bytes of the session log in structured content (`src/mcp/tools/consult.ts:102`, `:875`), which is incompatible with Spike 24's "all visible events inline or honest overflow" requirement if reused.
- MCP output path confinement for generated outputs is stronger than generic session artifacts: it resolves through symlinks and rejects paths outside `ORACLE_HOME_DIR/generated` by default (`src/mcp/utils.ts:22`, `:68`).

Live-only blocker:
- A real MCP client launch-context matrix requires Spikes 1, 3, 6, 7, and 8 to pass first, plus human opt-in for any subscription smoke. Without server-side uid/HOME/PATH/executable/auth checks, MCP `fable-local` should be CLI-only or refused.

## Spike 17: Artifact Privacy, Redacted Export, Purge

Status: v18 browser evidence ledger/export is mostly safe; generic session artifacts are not safe enough for raw Claude streams without hardening.

Evidence that is good:
- v18 evidence defaults to redacted writes, excludes unsafe evidence from the normal index, and writes quarantine separately (`src/oracle/v18/evidence.ts:14`, `:325`, `:375`).
- Unsafe evidence requires explicit unsafe mode and acknowledgement; unsafe mode is forbidden for doctor/capabilities/dry-run (`src/oracle/v18/evidence_unsafe.ts:26`, `:41`, `:48`).
- Browser-layer sanitizer strips forbidden extension keys regardless of declared redaction policy (`src/browser/evidence_redact_always.ts:40`, `:168`).
- Evidence ledger export sanitizes metadata by default, omits quarantined metadata unless requested, and still sanitizes it when requested (`src/oracle/evidence_ledger_sanitize.ts:61`, `:104`, `:157`).
- Tests confirm sanitized export redacts raw prompt, auth, API keys, raw DOM, and token strings (`tests/cli/evidence/ledger_export.test.ts:38`, `:127`).

Evidence that blocks raw stream reuse:
- `SessionArtifact.kind` is only `"transcript" | "deep-research-report" | "image" | "file"`; there are no typed raw Claude stdout/stderr/event kinds (`src/sessionManager.ts:189`).
- Generic artifact writers write absolute paths into metadata and do not realpath/lstat the artifact directory before write (`src/browser/artifacts.ts:61`, `:219`, `:252`).
- The temp harness confirmed a symlinked `sessions/<id>/artifacts` directory redirects writes outside the Oracle home.
- Session render prints artifact absolute paths and then prints prompt/log text by default (`src/cli/sessionDisplay.ts:410`, `:441`, `:450`).
- Browser transcripts embed the full prompt and artifact paths (`src/browser/artifacts.ts:304`, `:331`, `:341`).
- MCP consult returns artifact absolute paths in structured content (`src/mcp/tools/consult.ts:380`, `:386`), and MCP session resources expose full metadata/log/request resources (`src/mcp/tools/sessionResources.ts:6`, `:31`, `:45`, `:56`).
- Purge is whole-session by age/all only, not typed artifact purge (`src/sessionManager.ts:1014`; `src/cli/sessionCommand.ts:115`).

Decision:
- Do not store raw Claude streams as generic `file` artifacts. Add typed raw artifact kinds, no-follow/realpath boundary checks, owner-only modes, redacted-export exclusion by kind, resource-URI indirection for MCP, and explicit typed purge.

## Spike 23: Live Local CLI Smoke

Status: blocked as intended.

Prerequisites not yet satisfied:
- `fable-local`/Claude Code lane is not implemented in current CLI/MCP schemas.
- Startup verifier, env guard, executable resolver, local-owner guard, fake-run vertical slice, raw stream persistence, normalized events, and typed raw artifacts are not in place.
- No human opt-in or subscription readiness was provided.

Non-live evidence:
- Existing protected browser run planners emit redacted next commands for ChatGPT Pro and Gemini Deep Think, but they are planners and their generated runs are live (`src/cli/commands/run/protected.ts:67`; CLI output had `live_call: true`).
- The assigned lane did not run any Claude/Fable prompt and did not spend subscription/API quota.

## Spike 24: Live MCP and Browser Smoke

Status: blocked as intended.

MCP blockers:
- No `lane: "fable-local"` or `engine: "claude-code"` MCP input.
- No server-side launch-context proof for local same-user Claude subscription auth.
- Existing MCP consult success payload returns a log tail, not complete visible events or honest overflow semantics.

Browser blockers:
- ChatGPT and Gemini doctors currently report skipped/unknown UI probe without a live attached UI probe.
- Gemini needs a pre-submit live DOM re-probe/synthesis gate to match ChatGPT's stronger drift protection.
- No human opt-in for live browser submission was given.

Policy blockers:
- ChatGPT `Answer now` remains forbidden and was not clicked.
- Browser readiness cannot be accepted as ready when selector state is unknown.

## Recommended Plan Changes

1. Treat browser fixture/FSM proof as sufficient for fake gates, but not as live readiness. Add default non-submitting doctor UI probes that return `selector_state_unknown` as a fail/blocked state for protected browser lanes.
2. Add a Gemini pre-submit live DOM synthesis gate analogous to ChatGPT's gate: verify current tab/session, selected Deep Think label, thinking-level labels, prompt readiness, and send control immediately before clicking send.
3. Keep MCP `fable-local` out of v1 unless a server-side launch-context guard proves uid/local owner, HOME/PATH, Oracle home/session ownership, allowed env, safe Claude executable provenance, and subscription auth source before spawn.
4. Do not reuse generic browser `SessionArtifact` writer for raw streams. Build a raw artifact writer with typed kinds, no-follow/realpath path enforcement, `0600` files and `0700` dirs, and tests for symlinked parent and target files.
5. Return MCP resource URIs for artifacts instead of absolute local paths on network-facing surfaces. Redacted export should exclude raw artifact kinds by default and include only hashes/receipts unless an explicit unsafe audit command is used.
6. Add a typed purge command for Claude raw artifacts and normalized event artifacts. The current whole-session `--clear --hours/--all` is not precise enough for raw stream retention policy.
7. Do not schedule Spikes 23/24 live smokes until fake gates, startup/auth/local guards, typed artifacts, MCP inline/overflow semantics, and non-submitting browser doctor readiness are all green.

## Files Created

- `.planning-runs/claude-code-spike-execution-2026-07-02/worker-e-nonfast/preregistration.md`
- `.planning-runs/claude-code-spike-execution-2026-07-02/worker-e-nonfast/REPORT.md`

# Oracle vNext Standalone Implementation Spec

> Bundle version: v18.0.0
> Audience: a coding agent implementing Oracle vNext browser/provider reliability without access to this conversation, the other v18 specs, the repos, or the Agent Flywheel guide.

## 1. Product Summary

Oracle is a general-purpose CLI that lets a coding agent ask high-capability models for help. In this project, Oracle vNext is the browser/provider substrate for `$vibe-planning`. It must make two browser routes rock solid:

1. ChatGPT Pro / latest Pro Extended Reasoning through browser automation for formal first-plan and synthesis calls.
2. Gemini 3.1 Pro Deep Think through browser automation for independent plan review.

Oracle does not own APR's plan routing policy, synthesis, or Plan IR. Oracle owns browser sessions, remote browser transport, provider mode selection, output capture, redacted verification evidence, capability probes, and stable robot-friendly JSON surfaces.

## 2. Current-State Orientation

Current upstream Oracle already documents `--engine browser` with separate execution paths: ChatGPT launcher/attach modes drive the ChatGPT web UI over Chrome/CDP, while Gemini web mode talks to `gemini.google.com` using signed-in Chrome cookies. Current upstream release notes also mention Gemini web Deep Think DOM automation for browser/manual-login runs. Therefore vNext should harden and expose existing browser paths, not replace them with a new browser stack.

Important known failure classes from current Oracle behavior and issues:

- Browser mode can select or drift to the wrong ChatGPT model/mode.
- Long Pro browser runs can outlive local tab/session reachability.
- Gemini browser response parsing can produce empty `(no text output)` style captures if stream chunks are handled incorrectly.
- Remote browser mode must be reliable because this project primarily expects remote browser access.

## v18 Clarification: Current Oracle Proof Boundary

Current Oracle already has the right conceptual foundation: browser mode can drive ChatGPT web UI through launcher/attach CDP flows, Gemini web mode uses signed-in Chrome cookies, and current release notes describe Gemini web Deep Think DOM automation. v18 does not ask for a new browser stack. It asks the Oracle implementation agent to expose the browser observations that already matter as stable JSON capabilities, mode verification, and redacted evidence.

"Proof" means practical same-session UI verification, not cryptographic proof of server-side model routing. Oracle should record: requested provider/mode, observed UI label/control state, selector manifest version, verification timestamp, prompt-submission timestamp, `verified_before_prompt_submit`, session hash, transition-log hash, output hash, capture confidence, and redaction policy. This proves that Oracle selected and observed the intended browser mode before submitting the prompt. It does not claim to verify the provider's hidden backend routing.

For ChatGPT Pro, the current evidence target is model/mode UI verification such as Pro model label plus extended-reasoning/thinking-time control where available. For Gemini, the target is Deep Think UI selection and verification before prompt submit. If UI selectors drift, return `ui_drift_suspected` or a mode-specific unverified error; do not return success.

## 3. Non-Negotiable Requirements

1. Oracle must support ChatGPT Pro / latest Pro Extended Reasoning browser runs with same-session verification before prompt submission.
2. Oracle must support Gemini 3.1 Pro Deep Think browser runs with same-session Deep Think verification before prompt submission.
3. Oracle must treat remote browser mode as a first-class path, not a secondary debug feature.
4. Oracle must share one browser profile across ChatGPT and Gemini, but it must coordinate per-provider locks so concurrent tasks do not corrupt tabs or state.
5. Oracle must expose redacted evidence ledgers for critical browser calls. Evidence is not a screenshot archive or DOM dump.
6. Oracle must not implement APR route policy or plan synthesis.
7. Oracle must expose `--json`, `--dry-run`, `--doctor`, `capabilities`, browser lease planning, stable error envelopes, and recovery commands.

# Agent Flywheel Planning Shape

> Bundle version: v18.0.0

This section is repeated in every v18 subset because each coding agent must understand the planning workflow shape without opening another document.

The relevant portion of the Agent Flywheel process is the planning substrate, not the downstream implementation swarm. The key idea is to move the hardest whole-system reasoning into artifacts that still fit inside model context windows before code exists. The planning workflow for this project has this shape:

1. **Intent capture.** The human explains the goal, constraints, non-goals, sources, risk tolerance, and success criteria. For `$vibe-planning`, the human may start by talking at GPT-5.5 Thinking xHigh through Codex CLI. That interaction is intake context, not the formal plan.
2. **Normalized planning brief.** The orchestrator converts fuzzy intent into a brief with objectives, constraints, acceptance criteria, test expectations, source baseline, source trust, and open questions.
3. **Formal first plan.** In `balanced` and `audit`, the formal `v01` first plan must be generated by ChatGPT Pro / latest Pro Extended Reasoning through Oracle browser automation. No direct OpenAI API call can silently substitute for this route. In `fast`, Codex CLI GPT-5.5 Thinking xHigh may produce a `fast_draft`, but that artifact is exploratory and must be re-run through ChatGPT Pro before implementation handoff.
4. **Independent model plans.** APR asks independent providers to design or critique the plan from their own perspective. Live routes are ChatGPT Pro via Oracle browser, Gemini 3.1 Pro Deep Think via Oracle browser, Claude through Claude Code CLI/subscription, Grok through xAI API, and DeepSeek V4 Pro through the official DeepSeek API with reasoning and search enabled. The point is diversity of reasoning, not blind majority vote.
5. **Compare and synthesize.** APR compares plans, extracts strongest ideas, resolves contradictions, records reviewer deltas, and synthesizes a best-of-all-worlds implementation-ready plan. Later ChatGPT synthesis/revision slots use ChatGPT Pro via Oracle browser automation.
6. **Normalize, gate, and hand off.** APR normalizes outputs into Plan IR, records provenance and evidence, runs quality gates, produces a human review packet, and hands off to `$planning-workflow` or bead creation. The actual development swarm and bead execution are downstream.

This v18 standalone refactor deliberately splits the product into three independent specs:

- Oracle owns browser/provider mechanics and evidence.
- APR owns planning engine, routing policy, Plan IR, and synthesis.
- `$vibe-planning` owns user coaching, orchestration, shims, dry-run UX, and handoff.

## 4. Product Boundaries

### Oracle owns

- Browser automation mechanics.
- Remote browser transport and authentication token handling.
- Shared profile connection, Chrome/CDP attach/launch, provider-specific tabs, and browser locks.
- ChatGPT Pro mode selection and verification.
- Gemini Deep Think selection and verification.
- Output capture, streaming completion detection, and no-empty-output safeguards.
- Redacted browser evidence ledgers.
- Provider capability probes and short-lived capability leases.
- CLI error recovery surfaces.

### Oracle does not own

- Which providers APR chooses for a profile.
- Whether a provider result is sufficient for synthesis beyond reporting evidence facts.
- Plan comparison, synthesis, Plan IR, traceability, or `$planning-workflow` handoff.
- Source baseline or source trust policy.

### Why Oracle should remain general-purpose

Oracle can be used outside `$vibe-planning`. The new features should be named generically: `oracle chatgpt doctor`, `oracle gemini doctor`, `oracle browser leases`, `oracle evidence`, not `$vibe-planning-specific` commands. `$vibe-planning` and APR consume these capabilities but do not own them.

## 5. Browser Lease Coordinator

The v8 term "session scheduler" is narrowed in v18 to **browser lease coordinator**. It is not a background daemon and not a generalized job scheduler. It is a synchronous reliability primitive.

### Responsibilities

Before a browser prompt is submitted, Oracle must:

1. Acquire the provider lock for the shared browser profile.
2. Verify or establish a browser session.
3. Verify login state or return `provider_login_required`.
4. Verify the requested model/mode in the same session.
5. Submit the prompt only after verification.
6. Capture output and evidence.
7. Release the provider lock.

### CLI

```bash
oracle browser leases plan   --providers chatgpt,gemini   --require chatgpt:pro-extended,gemini:deep-think   --profile balanced   --remote-browser preferred   --json

oracle browser leases status --json
oracle browser leases recover --provider chatgpt --json
oracle browser leases recover --provider gemini --json
oracle browser leases acquire --provider chatgpt --ttl 30m --json
oracle browser leases release --provider chatgpt --lease-id LEASE --json
```

### Shared profile policy

The user explicitly wants one shared profile. Implement one authenticated Chrome profile, ideally remote by default when `ORACLE_REMOTE_HOST` is configured. Use per-provider locks and dedicated tabs rather than separate profiles.

## 6. ChatGPT Pro Browser Automation

### Commands

```bash
oracle chatgpt doctor --pro --extended-reasoning --remote-browser preferred --json
oracle chatgpt lease --pro --extended-reasoning --ttl 30m --json
oracle --engine browser   --provider chatgpt   --model chatgpt-pro-latest   --chatgpt-pro   --extended-reasoning   --remote-browser preferred   --evidence redacted   --prompt-file PROMPT.md   --json
```

### State machine

```text
session_start
remote_or_local_browser_connected
login_verified
chatgpt_model_menu_open
pro_candidate_selected
extended_reasoning_candidate_selected
mode_verified_same_session
prompt_submitted
response_waiting
output_captured
evidence_written
success
```

Prompt submission is illegal before `mode_verified_same_session`.

### What counts as proof?

Current Oracle is not expected to have a perfect cryptographic proof of web UI mode. Proof in this spec means a redacted, same-session verification ledger that records:

- requested mode;
- selector manifest version;
- UI control/label observations sufficient to assert Pro and Extended Reasoning were selected;
- timestamp/order showing verification happened before prompt submission;
- session hash, not raw cookies or account identifiers;
- transition log hash;
- output text hash;
- optional unsafe debug artifact references only when explicitly requested.

This is not absolute proof that the provider internally used a given model. It is the strongest practical proof available from a browser UI automation layer and is sufficient for APR eligibility.

## 7. Gemini Deep Think Browser Automation

### Commands

```bash
oracle gemini doctor --deep-think --remote-browser preferred --json
oracle gemini lease --deep-think --ttl 30m --json
oracle --engine browser   --provider gemini   --model gemini-3.1-pro-deep-think   --gemini-deep-think   --gemini-deep-think-fallback fail   --remote-browser preferred   --evidence redacted   --prompt-file PROMPT.md   --json
```

### State machine

```text
session_start
remote_or_local_browser_connected
login_verified
gemini_model_candidate_selected
deep_think_menu_open
deep_think_candidate_selected
deep_think_verified_same_session
prompt_submitted
response_streaming
output_captured_nonempty
evidence_written
success
```

The output parser must not stop at an empty placeholder chunk when later Gemini stream chunks carry the real answer.

## 8. Redacted Evidence Ledger

Evidence is mandatory for:

- `chatgpt_pro_first_plan`
- `chatgpt_pro_synthesis`
- `gemini_deep_think`

Default evidence mode is `redacted`.

Do store:

- provider slot;
- requested mode;
- mode verified boolean;
- verified-before-prompt boolean;
- session ID hash;
- selector manifest version;
- transition log hash;
- output text hash;
- failure code and recovery command when failed.

Do not store by default:

- cookies;
- account email;
- full DOM;
- raw screenshot;
- raw prompt text;
- raw output text when private;
- auth headers.

Unsafe debug evidence requires explicit `--evidence unsafe` and must be quarantined outside normal artifact indexes.

## 9. Remote Browser Mode

Remote browser must be rock solid. Required behavior:

- `ORACLE_REMOTE_HOST` and `ORACLE_REMOTE_TOKEN` support.
- `--remote-browser preferred|required|off` flag.
- Connection health check and version report.
- Reconnect logic for long Pro runs.
- Heartbeat events in JSON logs.
- Clear errors for token missing, host unreachable, browser profile unavailable, login required, and mode selector drift.
- No token value printing.

Commands:

```bash
oracle remote doctor --json
oracle remote attach --host "$ORACLE_REMOTE_HOST" --token-env ORACLE_REMOTE_TOKEN --json
oracle remote status --json
```

## 10. Provider-Specific Prompting Interface

Oracle does not compile the semantic prompts. APR does. Oracle must preserve prompt files, report prompt hash, and avoid mutating provider-specific prompt structure. Oracle may add browser transport metadata but must not rewrite content in a way that violates the prompt manifest.

# Provider-Specific Prompting Policy

> Bundle version: v18.0.0

Provider prompting is not generic. The implementation must compile prompts per provider family.

## ChatGPT Pro through Oracle browser automation

Use ChatGPT Pro / the latest Pro model in the ChatGPT web UI for the formal first plan and all later ChatGPT synthesis/revision routes in `balanced` and `audit`. Follow OpenAI's first-party prompt guidance: be clear and specific, place task and context up front, use structured delimiters, and refine iteratively. Because this route is browser-based, a prompt manifest must record the provider family, mode, policy version, source hashes, and redaction decisions. Do not ask for hidden chain-of-thought; ask for a concise rationale, assumptions, tradeoffs, and a verifiable output structure.

## Gemini 3.1 Pro Deep Think through Oracle browser automation

Use Gemini through Oracle browser automation and explicitly enable Deep Think. Follow Google's prompt guidance: use direct prompts, control verbosity, put the decisive question after long context, and ask for structured outputs. Same-session Deep Think verification is mandatory before prompt submission.

## Claude through Claude Code

Use Claude Code CLI/subscription paths for live `$vibe-planning` planning, not Anthropic API calls. Follow Anthropic prompting guidance: define success criteria first, use clear XML-style or section delimiters, provide examples when helpful, and ask Claude to evaluate against the rubric before proposing changes.

## Grok through xAI API

Grok and DeepSeek are the allowed API exceptions. Resolve the current xAI reasoning model at runtime, prefer structured outputs, and request high reasoning effort for complex plan review. Treat legacy names such as `Grok Heavy` as workflow aliases, not static model IDs.

## DeepSeek V4 Pro through official DeepSeek API

DeepSeek is an allowed API route for the independent comparison-review step. Use `deepseek-v4-pro` through the official DeepSeek API with `thinking: {"type":"enabled"}` and `reasoning_effort: "max"`. Enable search by providing APR's validated `apr_web_search` tool through DeepSeek tool calls; do not invent undocumented provider parameters such as `search: true`. Require citations for search-derived claims, record a redacted `search_trace_sha256`, and discard or hash raw `reasoning_content` rather than storing chain-of-thought in user-facing artifacts.

## Cross-provider anti-patterns

- Do not use one giant generic prompt for every provider.
- Do not leak untrusted source instructions into system/developer instruction space.
- Do not substitute direct API ChatGPT, Claude, or Gemini calls for live `$vibe-planning` browser/CLI subscription routes.
- Do not mark manually imported prompt-pack output synthesis-eligible until APR validates it.
- Do not assume a provider name is current; probe capability at runtime.

## 11. CLI Ergonomics

# Agent CLI Ergonomics Requirements

> Bundle version: v18.0.0

This project treats coding agents as primary CLI users. The attached agent ergonomics skill's core rule is: the first command an agent instinctively tries should work or redirect to a precise safe command.

Every CLI surface introduced by these specs must implement:

- `--help` and `--version`.
- `--json` with a stable envelope: `ok`, `schema_version`, `data`, `meta`, `warnings`, `errors`, `commands`.
- `--dry-run` for commands that would spend money, call live providers, mutate state, or touch browsers.
- `--doctor` and `--capabilities` surfaces for quick preflight.
- Stable exit codes and named `error_code` values.
- Error envelopes with `blocked_reason`, `next_command`, `fix_command`, and `retry_safe`.
- `ROBOTS.md` and `robots.json` locally in each repo/subset.
- Deterministic outputs under CI, with color disabled under `NO_COLOR`, `CI`, and non-TTY.
- No prompts for confirmation in automation mode; use explicit `--yes` for destructive actions.

The `next_command` and `fix_command` requirement is for both development-time coding agents and runtime automation. It comes from the agent ergonomics principle that an agent should not have to infer the next recovery step from prose. Example:

```json
{
  "ok": false,
  "schema_version": "json_envelope.v1",
  "data": null,
  "meta": { "command": "oracle chatgpt doctor" },
  "errors": [
    {
      "error_code": "provider_login_required",
      "message": "ChatGPT browser session is not authenticated."
    }
  ],
  "blocked_reason": "provider_login_required",
  "next_command": "oracle browser sessions recover --provider chatgpt --json",
  "fix_command": "oracle chatgpt doctor --pro --extended-reasoning --json",
  "retry_safe": true
}
```

### Oracle robot surfaces

```bash
oracle --version
oracle capabilities --json
oracle doctor --json
oracle browser leases plan --providers chatgpt,gemini --json
oracle browser leases status --json
oracle chatgpt doctor --pro --extended-reasoning --json
oracle gemini doctor --deep-think --json
oracle evidence show --run RUN_ID --provider-slot chatgpt_pro_first_plan --json
oracle evidence verify --path evidence.json --json
```

## 12. Error Codes

Required errors include:

- `provider_login_required`
- `browser_lock_timeout`
- `remote_browser_unavailable`
- `remote_browser_auth_failed`
- `chatgpt_pro_unverified`
- `chatgpt_extended_reasoning_unverified`
- `gemini_deep_think_unverified`
- `ui_drift_suspected`
- `output_capture_empty`
- `output_capture_unverified`
- `provider_usage_limit`
- `prompt_submitted_before_verification`

Every error must include `blocked_reason`, `next_command`, `fix_command`, and `retry_safe`.

## 13. Tests

### Unit tests

- Mode selection state machine transitions.
- Evidence ledger redaction.
- Lease acquisition/release.
- Error envelope shape.
- Remote host token parsing without secret printing.

### Browser fixture tests

- ChatGPT Pro selector fixture: success, wrong mode, UI drift.
- Gemini Deep Think fixture: success, control missing, verified false.
- Gemini stream fixture with empty first candidate and later non-empty output.
- Long Pro run fixture: reconnect and no false success from partial capture.

### Live smoke tests

Run only when explicitly enabled:

```bash
ORACLE_LIVE_BROWSER=1 oracle chatgpt doctor --pro --extended-reasoning --json
ORACLE_LIVE_BROWSER=1 oracle gemini doctor --deep-think --json
ORACLE_LIVE_BROWSER=1 oracle --engine browser --provider chatgpt --chatgpt-pro --extended-reasoning --prompt "Reply exactly CHECK_CHATGPT_PRO_OK" --json
ORACLE_LIVE_BROWSER=1 oracle --engine browser --provider gemini --gemini-deep-think --prompt "Reply exactly CHECK_GEMINI_DEEP_THINK_OK" --json
```

## 14. Implementation Phases

### Phase 1 — Capabilities and doctor surfaces

Add `oracle capabilities --json`, provider-specific doctors, and stable envelopes.

### Phase 2 — Browser lease coordinator

Implement lock files, status, plan, recover, acquire, and release. Keep it synchronous.

### Phase 3 — ChatGPT Pro mode verification

Implement state machine, selectors, same-session verification, and redacted evidence.

### Phase 4 — Gemini Deep Think verification and output capture

Harden Deep Think selection and stream output parsing.

### Phase 5 — Remote browser hardening

Make remote browser preferred/required modes reliable, reconnecting, and well diagnosed.

### Phase 6 — Evidence verification and fixtures

Add `oracle evidence show/verify`, fixture harness, and CI-safe tests.

## 15. What Not To Build

- Do not build APR route policy in Oracle.
- Do not synthesize or compare plans in Oracle.
- Do not add a generalized background scheduler daemon.
- Do not store raw screenshots/DOM/cookies by default.
- Do not make local browser the only reliable mode; remote browser is primary for this project.
- Do not silently downgrade ChatGPT Pro or Gemini Deep Think to a lower mode.

# Common Objections and Refutations

> Bundle version: v18.0.0

## Objection: This is too much ceremony for planning.

The ceremony is attached only to claims that are otherwise invisible: which premium browser mode was used, whether Deep Think was enabled before prompt submission, whether source context was trusted or merely data, and whether a result is eligible for synthesis. Without these artifacts, the final plan can look polished while violating the required workflow.

## Objection: Why not just call APIs?

The user's requirement is explicit: live ChatGPT, Claude, and Gemini usage in `$vibe-planning` must not use direct APIs. ChatGPT Pro runs through Oracle browser automation; Gemini Deep Think runs through Oracle browser automation; Claude runs through Claude Code. Grok and DeepSeek are the API exceptions. The architecture preserves that boundary while allowing mocks and fixtures during parallel development.

## Objection: Why evidence and browser leases?

Browser products are stateful and mutable. A command can return text from the wrong mode, stale tab, old output, or unavailable reasoning control. The browser lease coordinator prevents contention and stale-session failures. The redacted evidence ledger proves mode verification without storing cookies, full DOM, raw screenshots, or private prompts.

## Objection: Why repeat contracts in every subset?

The three coding agents will work independently. Each spec must be executable without the other specs. Repetition is intentional. Contract changes require updating all three specs and regenerating fixtures.

## 16. Compatibility Matrix

| Consumer         | Oracle command                                            | Required output                             |
| ---------------- | --------------------------------------------------------- | ------------------------------------------- |
| `$vibe-planning` | `oracle capabilities --json`                              | provider capability envelope                |
| `$vibe-planning` | `oracle browser leases plan --json`                       | browser session/lock plan                   |
| APR              | `oracle chatgpt doctor --pro --extended-reasoning --json` | readiness and lease details                 |
| APR              | `oracle gemini doctor --deep-think --json`                | readiness and lease details                 |
| APR              | live browser command                                      | provider result with redacted evidence path |
| Human            | `oracle evidence verify --path evidence.json --json`      | evidence validity report                    |

## 17. Final Developer Instructions

Make browser mode boring. Prioritize typed readiness, redacted evidence, remote browser stability, and actionable failure recovery over clever selector heuristics. The user benefits when required premium modes are either verified or loudly blocked.

# Appendix A — Detailed Oracle Engineering Guidance

> Bundle version: v18.0.0

This appendix expands the Oracle implementation boundary and addresses common uncertainties that would otherwise make a coding agent hesitate.

## A.1 What Oracle should expose versus what APR should decide

Oracle should answer questions about capability and execution mechanics:

- Can a browser session be reached?
- Is the profile authenticated?
- Can ChatGPT Pro / Extended Reasoning be selected and verified?
- Can Gemini Deep Think be selected and verified?
- Was the mode verified before prompt submission?
- Was the output captured completely?
- Which recovery command should an agent run?

APR should answer planning-policy questions:

- Is Gemini Deep Think required for this profile?
- Is a degraded result synthesis-eligible?
- Which provider should run first?
- How should plans be compared and synthesized?

Oracle must not need to know what Agent Flywheel is to execute a provider call. It should only know that the caller requested a browser provider, mode, prompt file, evidence policy, and JSON output.

## A.2 Remote browser first

The user's environment primarily expects remote browser usage. Therefore local browser support is useful, but remote browser is the primary product path for this workflow.

A robust remote browser flow:

1. Read `ORACLE_REMOTE_HOST` and `ORACLE_REMOTE_TOKEN` only from environment or explicit token-env flags.
2. Connect to the remote control endpoint.
3. Verify browser version and profile metadata.
4. Check profile authentication state for ChatGPT and Gemini.
5. Open or reuse a provider-specific tab.
6. Acquire provider lock.
7. Run provider mode verification.
8. Submit prompt and capture output.
9. Release lock and write evidence.

Do not print token values. If the token is missing, return:

```json
{
  "ok": false,
  "blocked_reason": "remote_browser_token_missing",
  "next_command": "export ORACLE_REMOTE_TOKEN=...",
  "fix_command": "oracle remote doctor --json",
  "retry_safe": true
}
```

## A.3 Browser lease details

The lease coordinator can be implemented with a small JSON lock file plus stale-lock cleanup. It does not need a daemon.

Recommended lock files:

```text
~/.oracle/browser-leases/shared-profile.chatgpt.lock
~/.oracle/browser-leases/shared-profile.gemini.lock
```

Each lock includes:

- lease ID;
- provider;
- profile ID;
- process ID or remote session ID;
- acquired timestamp;
- TTL;
- command summary;
- safe recovery command.

If a lock is stale, Oracle should not silently break it. It should report the stale state and provide a recovery command.

## A.4 Evidence verification limitations

A browser UI cannot provide cryptographic proof of the server-side model execution. The correct v18 concept of proof is practical, redacted, same-session evidence. The ledger proves that Oracle observed and selected the required UI controls before it submitted the prompt. It does not claim to verify OpenAI's or Google's internal routing.

This is still valuable because the main operational risks are wrong UI state, stale tabs, selector drift, and output capture failure. The evidence ledger directly detects those.

## A.5 Output capture rules

A provider command must not return `success` until output capture passes these checks:

- prompt was submitted;
- generation completed or a documented long-running background state was captured;
- output text is non-empty unless the prompt explicitly requested empty output;
- output belongs to the current prompt/session;
- output hash is recorded;
- capture method and confidence are recorded.

Gemini stream parsing must continue past empty placeholder chunks until it sees the final candidate text or a documented terminal failure.

## A.6 Selector manifest strategy

Keep selectors in a manifest rather than scattering them across automation code. Each selector entry should include:

- provider;
- purpose;
- primary selector;
- fallback selectors;
- text/aria label expectations;
- confidence score;
- last verified date;
- fixture filename.

When UI drift is suspected, return `ui_drift_suspected`, not a generic failure.

## A.7 Unsafe debug mode

Unsafe evidence mode exists only for debugging. It must be opt-in:

```bash
oracle --engine browser ... --evidence unsafe --yes-i-understand-unsafe-evidence
```

Unsafe artifacts should go under a quarantine directory and should not be linked from normal APR artifact indexes.

## A.8 Acceptance checklist

Before declaring Oracle vNext done:

- Remote browser doctor works.
- Browser lease planning/status/recover work.
- ChatGPT Pro doctor verifies or fails with typed errors.
- Gemini Deep Think doctor verifies or fails with typed errors.
- Live browser commands cannot submit prompts before mode verification.
- Evidence ledger is redacted by default.
- Gemini output capture handles empty placeholder chunks.
- Long Pro run does not return false success from partial capture.
- JSON envelopes are stable and include recovery fields.

# B. v18 Corrections and Runtime Invariants

> Bundle version: v18.0.0

## B.1 Oracle does not participate in Codex intake

The user's initial GPT-5.5 Thinking xHigh “talk at the system” stage happens through Codex CLI under the user's subscription. Oracle must not implement or trigger that intake. Oracle's role starts when APR asks for browser-mediated ChatGPT Pro or Gemini Deep Think calls.

## B.2 Browser lease coordinator, not scheduler

The browser lease coordinator is intentionally small. It must manage per-provider locks over a shared authenticated browser profile and expose machine-readable status/recovery. It must not become a background queue, workflow engine, or plan scheduler. APR schedules planning stages; Oracle only makes browser execution safe.

## B.3 Evidence ledger contract tightened

For `chatgpt_pro_first_plan`, `chatgpt_pro_synthesis`, and `gemini_deep_think`, Oracle must return redacted evidence containing at least:

```text
evidence_id, provider_slot, provider, requested_mode,
mode_verified, verified_before_prompt_submit,
verified_at, prompt_submitted_at, verification_method,
capture_confidence, selector_manifest_version,
session_id_hash, transition_log_sha256,
prompt_sha256, output_text_sha256, unsafe_artifacts_quarantined
```

If any required evidence field is unavailable, return a typed failure or degraded result. Do not return success with implied evidence.

## B.4 Remote browser is the product path

Local browser support is useful, but this project primarily expects remote browser usage. Remote mode must have first-class doctor/status/recover commands, token redaction, heartbeat reporting for long ChatGPT Pro runs, and reconnect behavior. If the remote browser is required by policy and unavailable, return `remote_browser_unavailable` with `next_command` and `fix_command`.

## B.5 API substitution is forbidden for ChatGPT/Gemini in this workflow

Oracle may support many providers generally, but for this workflow it must not satisfy ChatGPT Pro or Gemini Deep Think planning slots with APIs. If a caller asks Oracle to use an API route for those slots, Oracle should return a policy violation unless an explicit non-`$vibe-planning` mode is being used outside this workflow.

# C. v18 Corrections and Runtime Invariants

Bundle version: v18.0.0

## C.1 Hash and provenance realism

All fixture values that look like `sha256:` values must be full SHA-256-shaped digests. Do not use placeholder strings such as `sha256:<64-hex>` in fixtures, tests, evidence, provider results, prompt manifests, or source baselines. This matters because APR eligibility, evidence matching, cache safety, and human review packets all depend on hashes being meaningful correlation handles rather than decorative labels.

## C.2 Source baseline compatibility

The source-baseline contract uses `policy`; the compatibility artifact may still be named `source-lock.json`. Any tool that emits this artifact must write `policy` and may also write `mode` for backwards compatibility. When both are present, they must agree.

## C.3 Remote browser primary path

Remote browser is the primary path for ChatGPT Pro and Gemini Deep Think in balanced/audit planning. Local browser can be retained as a development fallback, but runtime surfaces must expose remote endpoint readiness, required environment variables, recovery commands, and provider locks before any live browser call.

## C.4 Shared profile nuance

The product requirement is one shared logical user-auth browser context with provider-specific locks. Do not overfit this into a single physical Chrome profile directory if Oracle's upstream browser implementation needs provider-specific technical profiles. Oracle owns that implementation detail; APR and `$vibe-planning` consume only redacted endpoint, lease, and evidence contracts.

## C.5 Negative fixtures are part of the spec

The negative fixtures in `fixtures/negative/` are not optional examples. They encode forbidden states that implementation agents must keep failing: Codex intake promoted to a formal first plan, ChatGPT API substitution for browser-only slots, and unverified browser evidence.

## C.6 Contract core versus extensions

Shared contracts allow additional properties for forward compatibility, but critical gates must use only the documented core fields. Unknown fields may never override API-substitution bans, evidence verification, formal-first-plan eligibility, or synthesis eligibility.

## C.7 Oracle general-purpose non-regression

Bundle version: v18.0.0

The provider-access restrictions in this bundle are `$vibe-planning` workflow restrictions. They must not be interpreted as a request to remove Oracle's general API support or make Oracle only an Agent Flywheel planning tool. Oracle remains general-purpose; APR enforces route policy for planning runs; `$vibe-planning` orchestrates those planning runs.

# v18 DeepSeek V4 Pro Reasoning + Search Addendum

> Bundle version: v18.0.0

This v18 bundle adds `deepseek_v4_pro_reasoning_search` to the multi-model comparison review step. The route is API-based by explicit user request and uses the official DeepSeek API, not Oracle browser automation. It must call `deepseek-v4-pro`, enable thinking, set `reasoning_effort` to `max`, and make search available through APR's validated `apr_web_search` tool contract.

DeepSeek is not allowed to weaken the existing provider-access policy. Direct API substitution remains forbidden for ChatGPT, Gemini, and Claude live planning routes. The only API-allowed comparison-review routes are xAI/Grok and DeepSeek.

Raw DeepSeek `reasoning_content` must not be placed in the final plan, human review packet, prompt pack, Plan IR, or `$planning-workflow` handoff. Store only final answer content plus a redacted reasoning-content hash when useful for provenance.

## Oracle boundary for DeepSeek

DeepSeek V4 Pro Reasoning + Search is part of the APR multi-model review matrix, but it is not a browser route and does not require Oracle evidence. Oracle vNext may expose generic API capability helpers if they already fit Oracle's architecture, but this workflow does not require Oracle to implement the DeepSeek call. APR owns the `deepseek_v4_pro_reasoning_search` official-API adapter. Oracle must not take on APR route policy or search-tool execution.

## v18 highest-reasoning invariant

Every live model call in this workflow must request the highest provider-specific reasoning effort available. See `docs/highest-reasoning-policy.md` and `fixtures/model-reasoning-policy.json`. Missing, unknown, default, or downgraded effort is not synthesis-eligible for `balanced` or `audit` unless a waiver is recorded before the call.

## v18.0.0 review corrections

- Browser effort labels are not stable contracts. ChatGPT Pro browser routes now request `max_browser_available` and require Oracle evidence that the highest visible effort was selected before prompt submission.
- Gemini Deep Think browser routes now distinguish `browser_mode=Deep Think` from `requested_reasoning_effort=deep_think_highest_available`; if a separate thinking-level control is exposed, select `high`.
- Route readiness is stage-scoped: preflight readiness does not imply synthesis eligibility.
- Provider docs are captured in `fixtures/provider-docs-snapshot.json` and must be refreshed before audit runs or implementation if provider surfaces changed.
- Claude Code Opus uses `--effort max`/`CLAUDE_CODE_EFFORT_LEVEL=max`; `ultrathink` is an additional one-off request, not a replacement for effort configuration.

# v18 Semantic Audit Corrections

## Review quorum is now explicit

Balanced planning is intended to be a true multi-model comparison workflow. The first formal plan comes from ChatGPT Pro via Oracle browser automation, and Gemini Deep Think is a required independent reviewer. However, a single independent reviewer is not enough to justify the phrase "multi-model comparison" when optional provider routes are available. v18 therefore adds `review_quorum.v1`: balanced requires Gemini Deep Think plus at least one successful optional independent reviewer from Claude Code Opus, xAI/Grok, or DeepSeek V4 Pro Reasoning + Search before synthesis, unless a waiver is recorded.

## Synthesis evidence is not a precondition for submitting synthesis

The synthesis browser evidence is produced by the ChatGPT Pro synthesis call. APR must not block synthesis prompt submission waiting for evidence that cannot exist yet. The correct sequence is: verify first-plan evidence, verify Gemini evidence, satisfy or waive review quorum, run compare, submit ChatGPT Pro synthesis, then require synthesis evidence before final handoff.

## Every default reviewer needs a fixture

v18 adds `fixtures/provider-result.xai.json`. This prevents coding agents from implementing Claude and DeepSeek fixtures while forgetting that xAI/Grok is also a default optional reviewer.

## DeepSeek reasoning-content handling

For DeepSeek V4 Pro with search/tool calls, the adapter may need to preserve provider `reasoning_content` transiently across tool-call turns. That raw content must not be written into Plan IR, human review packets, prompt packs, or handoff artifacts. Persist only hashes and final answer content.

## v18 Premortem Hardening: What Failed in the Six-Month Failure Scenario

This v18 pass assumes the project failed after six months and designs against the most likely causes. The pessimistic story is: browser automation sometimes returned plausible answers from the wrong mode, remote browser state was treated like a stateless API, mocks passed while live cutover failed, highest-reasoning runs felt slow and expensive, waivers became hidden downgrades, and users could not tell whether a run was stuck or legitimately waiting.

The plan now requires four additional artifacts:

- `failure_mode_ledger.v1`: concrete failure modes, false assumptions, early warning signs, mitigations, and acceptance checks.
- `live_cutover_checklist.v1`: the required progression from contracts to mock rehearsal to remote-browser smoke to full balanced dress rehearsal.
- `fallback_waiver.v1`: explicit, expiring, user-acknowledged waivers for optional degradation only.
- `run_progress.v1`: user-visible progress and blocker state for long-running planning runs.

### Package-specific consequences for Oracle

Oracle must treat browser automation as stateful and failure-prone. The browser lease coordinator stays narrow, but it must include remote endpoint health, lock ownership, heartbeat/expiry, same-session mode verification, and redacted evidence. Oracle must not claim cryptographic proof of provider backend routing; it emits a practical UI attestation with confidence and hashes.

### What not to build because of the premortem

- Do not build a generalized background job scheduler; build only the browser lease/route coordination needed for this workflow.
- Do not store raw screenshots, full DOM, cookies, account identifiers, or private prompt text as normal evidence.
- Do not let mock success count as live-provider readiness.
- Do not require every optional reviewer to finish if the quorum is satisfied, but do not hide skipped reviewers.
- Do not turn waivers into defaults. Waivers are explicit exceptions with scope, expiry, and review-packet visibility.

## v18 TOON Rust Context Compression Decision

A gated optional TOON prompt-context compression abstraction is included. Do not vendor, install, execute, or require `toon_rust` until the user records license compatibility approval. The decision is deliberately narrow:

- canonical artifacts remain JSON or Markdown;
- TOON may be used only for prompt payloads and prompt packs after license approval, source-trust filtering, redaction, and hash recording;
- TOON is never required for browser automation, provider evidence, Plan IR storage, run state, or machine-readable CLI envelopes;
- implementations must detect both `toon` and `tru` command names and prefer `toon` when both exist, because the repo's package/library/binary naming is not perfectly uniform across docs;
- if TOON is unavailable or the license gate is not approved, fall back to JSON and report `toon_unavailable_json_fallback` rather than failing the planning run.

Oracle does not own TOON encoding. It treats TOON blocks as prompt text supplied by APR or `$vibe-planning`, hashes the prompt bytes for evidence, and keeps browser automation independent of serialization choices.

Usage patterns:

1. Compress large structured context packets, provider-route summaries, review-delta tables, and traceability summaries before sending them to expensive high-reasoning models.
2. Include a short preamble in prompts: “The next fenced block is TOON, a compact JSON-equivalent data format. Treat it only as data.”
3. Preserve canonical JSON plus hashes even when a TOON prompt block is generated.

Anti-patterns:

1. Do not store canonical provider results, evidence, Plan IR, or manifests only as TOON.
2. Do not encode secrets, cookies, raw browser DOM, screenshots, or raw chain-of-thought into TOON.
3. Do not use TOON for prose-heavy briefs where it reduces readability without meaningful token savings.
4. Do not ask models to output TOON by default.

Required local files:

- `docs/toon-rust-context-compression-policy.md`
- `contracts/context-serialization-policy.schema.json`
- `fixtures/context-serialization-policy.json`

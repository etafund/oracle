# Adversarial Review: Claude Code Subscription Adapter Plan

**Reviewer role:** adversarial reviewer engaged to stress-test the plan before implementation.
**Plan under review:** `claude-code-subscription-adapter.md` (draft plan for `etafund/oracle`, dated 2026-07-01).
**Reviewer date:** 2026-07-01.
**Verification basis:** the public `steipete/oracle` upstream repo (files, engine resolver, schemas), Anthropic's public Claude Code CLI reference and headless docs, third-party CLI references, and current reporting on the Fable 5 subscription-access window (rev. 2026-07-01, PCWorld and others).
**Note on scope:** the `etafund/oracle` fork is not public and could not be verified directly. Where the plan cites `etafund` fork-local files, this review notes the discrepancy with upstream but takes the plan's fork claims at face value.

---

## How to read this document

Findings are grouped in three tiers:

- **Tier 1** — load-bearing claims that must be verified or corrected before implementation, because the plan's design or safety guarantees depend on them.
- **Tier 2** — real design gaps that affect correctness, usability, or the plan's own safety promises.
- **Tier 3** — smaller issues, mostly editorial or scope clarifications.

Each finding states the problem, cites the specific section of the plan or source of truth, explains why it matters, and proposes a concrete fix.

At the end there is a **Recommended reshape** section with the smallest set of changes that would land the plan in defensible shape.

---

## Tier 1 — Verify or correct before implementation

### 1. Repo-file references need a fork qualifier

**Plan claim (Source Facts #7 and #8, and referenced in Feature 1 / Acceptance Checklist / Rollout Phase 0):**

> "In the current repo, `src/oracle/v18/provider_boundaries.ts` marks Claude as `ownership: "user_cli"`…"
> "In the current repo, `src/oracle/api_substitution_guard.ts` says `claude_code_*` slots must use `claude_code_subscription_cli`…"

**Verified state:**

Both files return HTTP 404 on `https://raw.githubusercontent.com/steipete/oracle/main/…`. The `src/oracle/v18/` directory does not exist in upstream at all. The other files cited by the plan (`src/cli/engine.ts`, `src/cli/runOptions.ts`, `src/mcp/tools/consult.ts`, `src/sessionManager.ts`, `src/sessionStore.ts`, `src/mcp/types.ts`, `docs/anthropic.md`, `docs/mcp.md`, `docs/cli-reference.md`) do exist upstream.

**Reviewer note per author:** these two files live in the `etafund/oracle` fork, not upstream. The reviewer could not confirm this because the fork is not public, but takes the author's word for it.

**Why this still matters:**

The plan's stated audience is "a new maintainer who has not read Oracle, Oracle Router, or this chat." A new maintainer following the References section will land on `steipete/oracle` (the public repo) first, will not find these files, and will spend hours confused. The `Status:` header does say the plan is for `etafund/oracle`, but individual source-fact citations, the References section, and the file-map treat all paths as if they were the same repo. This is a documentation-hygiene issue rather than a fabrication, but the fix is essentially free.

**Fix:**

1. Add a one-line note at the top of the plan (and in Source Facts #7 and #8) that these two files are fork-local in `etafund/oracle` and are not present in `steipete/oracle` upstream.
2. In the References section, split the citations into "upstream (`steipete/oracle`) files" and "fork-local (`etafund/oracle`) files" so a reader knows where to look.
3. If any of the new files planned by this feature will ever be upstreamed, note the split clearly.

---

### 2. `EngineMode` and the existing engine resolver are only half-described

**Verified upstream state** (`src/cli/engine.ts` on `main`):

```ts
export type EngineMode = "api" | "browser";
```

Correct. But the plan does not describe how `resolveEngine` actually resolves the engine, which affects the design of `--engine claude-code`:

- `resolveEngine` auto-selects `"api"` if `OPENAI_API_KEY` **or** `OPENROUTER_API_KEY` is set, and falls through to `"browser"` otherwise. There is no case where `ANTHROPIC_API_KEY` alone triggers `"api"` mode, because Oracle today is a GPT-5-Pro tool.
- There is a `configEngine` path via `~/.oracle/config.json`.
- There is a `ORACLE_ENGINE` env variable that normalizes to `"api"` or `"browser"`.
- There is a legacy `--browser` flag that forces `"browser"`.
- There is an `apiProviderRequested` boolean that forces `"api"`.

**Why this matters:**

The plan requires "explicit `--engine claude-code` or explicit MCP `engine: "claude-code"`" (Feature 1), but does not say what happens when a user sets `"engine": "claude-code"` in `~/.oracle/config.json`, or `ORACLE_ENGINE=claude-code` in the environment. Both paths currently normalize to `null` and fall through. Do they now accept `"claude-code"` and route there? If yes, the "explicit only" claim is violated. If no, the plan should say so.

`src/mcp/types.ts` defines `engine: z.enum(["api", "browser"]).optional()`. Adding `"claude-code"` is a Zod-schema change that will flow through test snapshots. The file-update list omits schema fixture updates.

**Fix:**

Add a "Current state" subsection to Feature 1 that enumerates every entry point that can influence engine selection (`--engine`, `--browser`, `ORACLE_ENGINE`, `~/.oracle/config.json` `engine` field, MCP `engine` field, `apiProviderRequested`) and states the routing decision for each in the `claude-code` case. State whether `ORACLE_ENGINE=claude-code` is allowed or refused. State whether config-file `engine: "claude-code"` is allowed or refused. Add fixture-update work to the file-update list.

---

### 3. Several Claude Code CLI flags in the "v1 argv" are not documented by Anthropic

**Plan claim (Feature 3):** the v1 argv is

```
claude -p \
  --model fable \
  --output-format stream-json \
  --verbose \
  --include-partial-messages \
  --include-hook-events \
  --permission-mode plan \
  --safe-mode \
  --disable-slash-commands \
  --strict-mcp-config \
  --disallowedTools mcp__* \
  --no-chrome \
  --no-session-persistence \
  --max-turns 2 \
  --tools ""
```

The plan also asserts (Source Fact #4) that `claude -p --help` on the target machine already showed `--safe-mode`, `--tools`, `--allowedTools`, `--disallowedTools`, and dangerous bypass flags.

**Verified against Anthropic's public Claude Code CLI reference and headless docs, plus third-party references:**

Documented flags: `-p` / `--print`, `--model`, `--output-format` with values `text|json|stream-json`, `--verbose` (required with `stream-json`), `--include-partial-messages` (required for token-level deltas), `--permission-mode` with documented values `default`, `acceptEdits`, `plan`, `auto`, `dontAsk`, `bypassPermissions`, `--allowedTools`, `--disallowedTools`, `--max-turns`, `--disable-slash-commands`, `--strict-mcp-config`, `--bare`, `--dangerously-skip-permissions`, `--continue`, `--resume`, `--fork-session`, `--append-system-prompt`, `--system-prompt`, `--system-prompt-file`, `--json-schema`, `--max-budget-usd`, `--mcp-config`, `--input-format`.

Not evidenced in Anthropic's public docs or the third-party references I checked:

- `--safe-mode` — no documented flag by this name.
- `--no-chrome` — Chrome extension exists as an integration surface, but I found no `--no-chrome` CLI flag. Integration state is reported in the init event; disabling it appears to be from the extension side, not the CLI.
- `--no-session-persistence` — no such flag documented. The documented ways to avoid session state are (a) `--bare` (which the plan explicitly avoids) and (b) simply not passing `--continue`/`--resume`.
- `--include-hook-events` — I could not confirm this flag in Anthropic's docs. The `stream-json` stream does contain events related to hooks; whether opting in requires a flag is unverified.
- `--tools ""` as a "disable all tools" syntax — asserted by one third-party CLI reference (backgroundclaude.com) as `"" for none, "default" for all, or a comma list`, but not corroborated by Anthropic's own reference in the sources I checked.

**Why this matters:**

The v1 safety story is built on this argv. If `--safe-mode`, `--no-chrome`, and `--no-session-persistence` are ignored by the CLI, the plan's mitigation for the corresponding config-surface risks is a no-op. The plan does say "verify exact Claude Code flag behavior with the installed CLI and current Anthropic docs" and "test that the command builder never emits dangerous flags," but the verification step is deferred to Phase 0 and Phase 4. If the swarm generates code against this argv verbatim, the safety layer ships in a state that may not do what the checklist claims.

The plan also correctly hedges the `--tools ""` syntax with "if the CLI ignores it, refuse the run." Good — but if the syntax is fictional, the runner refuses every run.

**Fix:**

Do one afternoon of empirical work on the installed CLI before generating code. Concretely:

1. Run `claude --help 2>&1` and `claude -p --help 2>&1` on the target machine and paste the raw output into the plan or an appendix.
2. For every plan-asserted flag, mark it "confirmed present in installed CLI" or "not in help; must be dropped or replaced."
3. Where a flag is absent, either replace it with a real mitigation or add a startup-verifier check that catches the residual risk. For example:
   - No `--no-chrome`? Then the startup verifier must fail on any non-empty Chrome-integration field in the init event.
   - No `--no-session-persistence`? Then the runner must (a) never pass `--continue` or `--resume`, (b) verify no `session_id` from a prior run is being reused, and (c) accept that Claude Code may still write to its own transcripts on disk and document that.
   - No `--safe-mode`? Then the safety story is `--permission-mode` + `--disallowedTools` + `--strict-mcp-config` + `--allowedTools ""` + init-event verification, and the plan should say so explicitly.
4. Consider `--permission-mode dontAsk` instead of `plan`. Third-party CLI references call `dontAsk` "the only safe choice" for unattended CI because it denies rather than blocks. Compare behavior on the installed CLI and pick the safer one.

---

### 4. `apiKeySource` value the verifier is checking for does not match reality

**Plan claim (Feature 7, Startup Verifier):** expected startup shape has `"apiKeySource": "oauth"` for a valid subscription run.

**Verified from Anthropic's CLAUDE_AGENT_SDK_SPEC and real Claude Code init events (2.1.x builds):**

The `apiKeySource` field in the `system/init` event uses these observed values:

- `"none"` — Claude Code authenticates via OAuth tokens from a prior `claude login` session. This is the subscription case. The SDK spec explicitly notes: "When apiKeySource is 'none', Claude Code authenticates via OAuth tokens from a prior claude login session."
- `"ANTHROPIC_API_KEY"` — the name of the env var that supplied the key.
- `"env"` — appears in a third-party cheatsheet as a value; may be a normalization.
- `"helper"` or similar — for `apiKeyHelper`.
- Possibly `"claude.ai"` or a subscription-specific value in current builds.

**Why this matters:**

If the verifier accepts `"oauth"` and refuses `"none"`, it will refuse every legitimate subscription run. The plan's own safety code will break the feature it is protecting.

**Fix:**

Before writing the verifier tests, run one real `claude -p --output-format stream-json --verbose "hello"` on a subscription-authenticated machine and record the exact `apiKeySource` value from the init event. Set the verifier's allowlist to that specific value (probably `"none"`, possibly `"claude.ai"` or `"subscription"`). Anything else — `"ANTHROPIC_API_KEY"`, `"env"`, `"helper"`, `"bedrock"`, `"vertex"`, `"foundry"` — refuses. Do not guess at the string. If the swarm writes the check with a guessed value, every run will fail closed and the feature will look broken.

---

### 5. The 50% subscription-window cap is not modeled

**Plan framing:** the user wants to use their subscription's Fable usage allotment through 2026-07-07 without incurring API billing.

**Verified from current reporting (PCWorld, June 30 / July 1, 2026, and the Anthropic Fable 5 launch note):**

- Fable 5 returned to Pro, Max, Team, and select Enterprise plans on 2026-07-01, available through 2026-07-07 only. After 2026-07-07, subscribers must purchase separate usage credits at roughly API pricing to continue.
- Subscribers face a **50% usage-window cap** on Fable 5. This is new and did not apply during the June 9–22 window.

**Why this matters:**

The plan carefully guards against `ANTHROPIC_API_KEY` (paid API billing) but does not describe what happens when the subscription itself starts routing to paid usage credits mid-window. If the user hits the 50% cap and Claude Code silently switches to credit-based billing, Oracle will report "subscription mode" while the user is being billed. There is no evidence I found that the `apiKeySource` field or any other init-event field distinguishes "subscription with quota" from "subscription that has moved to credits" — the auth path is the same OAuth token. The user may or may not care; the plan should decide.

**Fix:**

Add a section to Goal 7 ("Be Honest About What Was Captured") that acknowledges the 50% cap and states one of:

- **Option A (honest):** Oracle cannot detect whether the subscription is in quota or in credits, and the feature is best-effort about "no API billing." Document this. Add a `subscription_billing_uncertain: true` field to metadata.
- **Option B (defensive):** After every run, parse the `result` event's `total_cost_usd` field. If it is non-zero and greater than a small threshold, warn the user that the run may have consumed credits rather than subscription quota. This is imperfect (subscription quota may also report a cost) but gives the user a signal.
- **Option C (empirical):** Test whether the CLI emits a different value in the init event or result event when running on credits. If yes, verify it and refuse or warn. If no, fall back to A or B.

---

### 6. Timeline framing does not affect these findings

**Prior note in draft review:** the reviewer flagged that the July 7 window makes the multi-phase rollout unrealistic.

**Correction acknowledged from author:** the plan will be implemented in one push overnight by an agent swarm.

**Revised reviewer position:**

Delivery speed is not the reviewer's concern. What is the reviewer's concern:

- Fast implementation multiplies the cost of the wrong `apiKeySource` value in the verifier (#4), because tests will pass against the fictional string, the runner will refuse every real run, and no one will notice until the human tries it.
- Fast implementation multiplies the cost of asserting fictional CLI flags (#3), because the swarm will happily emit them, and the plan's Acceptance Checklist ("command builder emits `--safe-mode`") will pass while the runtime protection is absent.
- Fast implementation multiplies the cost of guessing the `--tools ""` syntax (#3), because if the syntax is fictional, `refuse if tools non-empty in init event` will refuse every run.

The mitigation is not "slow down." It is "run the empirical CLI check first, then let the swarm write against verified strings." Ten minutes of `claude -p --help` and one real init-event capture removes the largest failure modes.

---

## Tier 2 — Real design gaps

### 7. "No hidden reasoning captured" conflicts with `stream-json` for extended-thinking models

**Plan claim (Goal 7, Anti-Goal 5):** metadata says `hidden_reasoning_captured: false`; the plan avoids terms like "full reasoning," "private reasoning," "chain-of-thought," "hidden thoughts."

**Verified:** Fable 5 is a Mythos-class extended-thinking model. Anthropic's streaming messages docs describe `thinking_delta` events emitted through the stream for models with extended thinking enabled. Claude Code's `stream-json` may pass these through as `stream_event` frames.

**Why this matters:**

The plan's language distinguishes "visible events" from "hidden reasoning." If the stream contains `thinking_delta` events, they are on the wire, and the plan's own rule ("Do not discard unknown events. Preserve them.") requires storing them in the raw artifact. Most users would call the stored `thinking_delta` content the model's reasoning. Asserting `hidden_reasoning_captured: false` in metadata while the raw artifact contains hundreds of `thinking_delta` events is a defensible but misleading claim.

**Fix:**

Introduce a second field, `visible_thinking_captured: true|false|unknown`, set from whether `thinking_delta` (or a summarized equivalent) actually appears in the observed stream. Docs should say plainly: Oracle preserves what Claude Code prints on stdout. For extended-thinking models, that includes visible thinking deltas. Oracle does not capture any reasoning Claude Code itself does not emit.

---

### 8. `--bare` is dismissed on grounds that Anthropic's own docs contradict

**Plan claim (Feature 3):**

> "Do not use `--bare` in v1 unless subscription auth is proven to keep working with it. Current docs say `--bare` skips many configuration surfaces, but it changes auth/config behavior in ways that need separate proof."

**Verified from Anthropic's headless docs:**

`--bare` is specifically designed for the property the plan is trying to construct. From the current headless docs:

> "Add `--bare` to reduce startup time by skipping auto-discovery of hooks, skills, plugins, MCP servers, auto memory, and CLAUDE.md. Without it, `claude -p` loads the same context an interactive session would … Bare mode is useful for CI and scripts where you need the same result on every machine."

A separate third-party reference (developertoolkit.ai / amux.io) notes that `--bare` "skips OAuth and keychain reads." If accurate, that would break subscription auth — but it is not corroborated by Anthropic's own docs, and Anthropic's OAuth tokens are stored on-disk in `~/.claude/.credentials.json` (Linux) or Keychain (macOS), so "skips keychain reads" is a macOS-specific concern.

**Why this matters:**

The plan builds an elaborate startup verifier to check that tools, MCP servers, hooks, plugins, skills, slash commands, Chrome integration, custom agents, and session persistence are all inactive. `--bare` guarantees most of this by construction. The plan is reimplementing a documented flag with a runtime check.

**Fix:**

Spend one hour testing `claude --bare -p --output-format stream-json --verbose "hello"` on the target machine with subscription auth. Record the result. If it works, `--bare` becomes the primary safety mechanism and the startup verifier shrinks to (a) confirming `apiKeySource` is subscription, (b) confirming `model` resolves to Fable, and (c) confirming the tool list is either empty or restricted to a known-safe set. If `--bare` breaks auth, document why and keep the current approach. Do not dismiss it on speculation.

---

### 9. Passing prompt over stdin has an implicit protocol note the plan misses

**Plan claim (Feature 8):** the prompt is sent through stdin as bytes.

**Verified from third-party CLI wrapping references and Anthropic's docs:**

`claude -p` reads a prompt from either argv or stdin. When stdin is used, the caller must close stdin (send EOF) after writing. If stdin is not closed, some `claude -p` invocations can hang waiting for more input, particularly when combined with `--input-format stream-json` (a separate protocol for bidirectional NDJSON).

**Why this matters:**

The plan's "Claude Code Hangs Waiting for Input" section attributes hangs to prompts and treats timeouts as the remedy. The more common cause is Oracle forgetting to close its child's stdin. This is a two-line fix in the runner (`child.stdin.end()` after writing) but easy to miss.

Separately: the plan mixes `--output-format stream-json` with a plain-text stdin prompt. That is the correct pairing. Do not accidentally add `--input-format stream-json`; that is a different, sparsely documented bidirectional protocol (there is an open Anthropic issue #24594 requesting docs for it) and it wants NDJSON on stdin, not plain text.

**Fix:**

In Feature 8, add: "The runner writes the prompt to child.stdin, then calls `child.stdin.end()` to signal EOF. Do not pass `--input-format stream-json` in v1."

---

### 10. Single-flight lock has PID reuse and platform gaps

**Plan claim (Feature 16):** the lock file records pid; stale pids are recovered by checking if the pid is alive.

**Concrete failure modes:**

- **PID reuse.** On Linux, PIDs recycle rapidly. Between "check pid is dead → reclaim lock" and the reclaim, the PID may be reallocated to an unrelated process (e.g., `chrome`), and the "is alive?" check will now return true. The lock will look permanently held.
- **Platform primitive not specified.** Advisory file locks (`fcntl`) on macOS and Linux behave differently from `LockFile` on Windows. "Write pid to a file" alone is not a lock.
- **UX.** Fable runs may take up to 60 minutes (Feature 17). During the 6-day window with a 50% cap, "already running, wait an hour" is user-hostile.

**Fix:**

1. Store pid **plus** a random nonce **plus** a start-time hint (e.g., the process's `hrtime` or PID start time from `/proc/[pid]/stat` on Linux, `ps -o lstart` on macOS, `Get-Process -Id | Select StartTime` on Windows). Consider the lock stale only if the pid is dead **and** any of these do not match a live process.
2. Specify a real primitive. `proper-lockfile` (npm) is the standard cross-platform choice.
3. Ship `--wait-for-lock` (or reuse `--wait`) from v1. It is a small addition and the UX improvement is meaningful.

---

### 11. `--max-turns 2` may not do what the plan expects

**Plan claim (Feature 3):** `--max-turns 2` is the v1 default.

**Verified:** `--max-turns` caps agentic turns. When the cap is hit, `claude -p` exits with a non-zero status. The exact semantics of "turn" for a no-tool `--permission-mode plan` run are not documented in detail.

**Why this matters:**

For a "review this file" prompt with no tools available, one turn is roughly: read stdin, generate response, stop. `max-turns 2` is generous. But the plan's runner marks non-zero exit as `error` (step 22 of the CLI Flow). If Claude ever hits max-turns for legitimate reasons, the run is marked failed even though the user got a useful response.

**Fix:**

The runner should treat "exited due to max-turns" as a distinct terminal state (`max_turns_reached`), not `error`. Parse either the exit code and any max-turns indicator in the result event to distinguish. Consider `--max-turns 1` for review-only runs since no tools are available anyway.

---

### 12. CLI live display will spam raw NDJSON if left to the default

**Plan claim (Feature 13):** CLI default is "human readable if stdout is a TTY."

**Reality:** `stream-json` output with `--verbose --include-partial-messages` emits dozens to hundreds of NDJSON lines per run, mostly `{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"H"}}}` frames. Printing that verbatim to a terminal is unusable.

**Fix:**

"Pretty" mode must include a small assembler that:

1. Watches for `assistant` messages with `content` blocks and joins `text_delta` deltas into visible text.
2. Prints a compact one-line marker for tool-related events (should not appear in v1's no-tool run, but the code should not crash if they do).
3. Prints the final `result.result` field as the answer.
4. Prints a single line for `system/api_retry` events with the retry ETA.
5. Prints `stream_event` frames only under `--claude-code-inline-events jsonl` or a verbose flag.

Without this, the "default" experience is broken.

---

### 13. `SUDO_USER` refusal is user-hostile in common configurations

**Plan claim (Feature 5):** refuse if `SUDO_USER` is set, because "the real account owner is ambiguous."

**Reality:**

`SUDO_USER` is inherited by shells started under `sudo`. Many developer workflows include `sudo -i` or `sudo -u devuser -i` to become a service user in Docker dev containers, EC2 with SSM, or shared hosts. In those cases, `EUID` is that of the target user (not root), and the user is fully authorized to run Oracle. Refusing on `SUDO_USER` presence blocks these workflows.

**Fix:**

Refuse only when `EUID == 0` (running as root). If `EUID != 0`, `SUDO_USER` alone is not sufficient reason to refuse. Optionally warn. This preserves the original intent (Oracle should not act on behalf of an ambiguous root context) without breaking legitimate `sudo -i` users.

---

### 14. `ANTHROPIC_MODEL` / `ANTHROPIC_DEFAULT_*` refusal is overbroad

**Plan claim (Goal 2):** refuse if `ANTHROPIC_MODEL` or `ANTHROPIC_DEFAULT_*` is set, "unless the implementation proves it cannot affect this run."

**Reality:**

`ANTHROPIC_MODEL` may exist in a developer's environment as a default for other Anthropic-adjacent tools. Whether `claude -p --model fable` overrides it is empirically testable in five minutes. If argv wins (very likely, this is how CLIs conventionally work), the refusal is unnecessary and blocks users with legitimate configurations.

**Fix:**

Test empirically whether `--model` on argv overrides `ANTHROPIC_MODEL`. If yes (expected), remove `ANTHROPIC_MODEL` from the refusal list and simply scrub it from the child env instead. Keep `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, `CLAUDE_CODE_USE_FOUNDRY`, `CLAUDE_CODE_USE_ANTHROPIC_AWS` on the hard refusal list — those genuinely change auth or provider routing.

---

### 15. macOS Keychain access from `oracle-mcp` context is not addressed

**Plan claim (Feature 4):** the child env is scrubbed and built from an allowlist.

**Reality:**

On macOS, Claude Code stores OAuth tokens in the login Keychain. Keychain access from a spawned subprocess depends on the process's session, user, and (for some GUI contexts) code-signing entitlements. When `oracle-mcp` is spawned by a fresh MCP client such as Cursor or the desktop Claude app, its Keychain-access context may differ from an interactive shell's.

**Why this matters:**

The most valuable use case (calling `oracle-mcp` from Claude Code itself for cross-model review) is exactly the case where Keychain access may silently fail. A subscription-authenticated `claude` invoked directly from a Terminal.app shell will pick up the token; the same `claude` invoked from `oracle-mcp` invoked from Cursor may not.

**Fix:**

Add a manual smoke test to `docs/manual-tests.md` that (a) launches `oracle-mcp` from a fresh MCP client (not the user's shell), (b) invokes `consult` with `engine: "claude-code"`, (c) confirms subscription auth still works. If it does not, document a workaround (e.g., have the user log in from `claude` inside the same context, or accept that the MCP path only works in some launch contexts).

---

### 16. Windows is claimed but not designed

**Plan claim (Goal 2, Feature 17):** Windows is supported; env checks are case-insensitive; timeouts use tree-kill.

**Reality:**

The plan's core mechanics (`realpath`, uid checks, world-writable directory checks, POSIX file modes `0700` / `0600`, process groups for tree-kill) are POSIX-first. Windows equivalents (ACL checks, credential store, `taskkill /T /F`) are gestured at but not designed.

**Fix:**

Either declare v1 macOS-and-Linux only and track Windows as a follow-up, or add a "Windows differences" subsection that enumerates the specific alternatives for each POSIX check. Do not pretend it is only a testing problem.

---

### 17. Raw stream exclusion from redacted exports is undertested

**Plan claim (Security Notes):** raw `.raw` artifacts are not included in redacted evidence exports by default.

**Concrete failure mode:** if the export mechanism filters on filename suffix, renaming a file defeats the filter. If it filters on `kind`, then Feature 14's "reuse `file` kind with labels" fallback breaks the exclusion (since the `kind` is `"file"`, the same as any other file artifact the user does want exported).

**Fix:**

Pick one mechanism (typed `kind` values: `"claude-code-stdout-raw"`, `"claude-code-stderr-raw"`, `"claude-code-events-normalized"`, `"claude-code-adapter"`) rather than the "labels on `file` kind" fallback. Add a redaction-export test that specifically asserts these kinds are excluded.

---

## Tier 3 — Smaller issues

### 18. Rate-limit `system/api_retry` events must be on the "not a violation" allowlist

Anthropic's headless docs describe `system/api_retry` events emitted when the API throttles a request. The plan's read-only violation detector must not treat these as errors or read-only-contract failures. Add them to the explicit "expected non-error event types" list.

### 19. `fable` as a model alias is not future-proof

Anthropic model aliases (`sonnet`, `opus`, `haiku`, `fable`) shift what they resolve to over time. Today `fable` → `claude-fable-5`; a future `fable` may point to `claude-fable-5-1` or similar. Store both the requested alias and the resolved model ID (from the init event's `model` field, or the `result.modelUsage` map) in metadata. The plan gestures at this but does not require it.

### 20. `claude --version` and `-p --help` output should be pasted into the plan

Source Fact #4 asserts a specific version and specific `-p --help` output. If they were checked, paste the raw output as an appendix so a reviewer can verify. If they were not, remove the specific version string and reword as "the plan assumes but does not verify …". The value of the assertion is entirely in its verifiability.

### 21. Consolidate lifecycle-refusal plumbing into one gate

The plan refuses `oracle restart`, `--followup`, `--background`, Claude Code `--continue`, Claude Code `--resume`, and Claude Code background flags separately in the file map. Each is a code change in a different file. A single `assertEngineAllowsFlow(engine, flow)` helper called from every entrypoint concentrates the policy and makes future changes obvious. Otherwise reviewers must check five files to enumerate refusal points.

### 22. `--dry-run summary` output shape is not defined

The plan describes what dry-run should report but not what it looks like. Match an existing Oracle dry-run mode (there are likely conventions in `src/cli/dryRun.ts` already). Do not invent a new shape.

### 23. Purge command is designed in two places with two names

Feature 15 mentions `oracle session <id> --raw-events` (to view raw events). Security Notes mentions `oracle session <id> --purge-artifacts` (to delete). Decide whether these are one command with modes, two subcommands, or two flags on `oracle session`, and pick names that do not overlap semantically.

### 24. `--json-schema` from Claude Code is worth a mention as future work

Claude Code supports `--output-format json --json-schema '<schema>'` for structured output validated against a JSON Schema. For a "review this file, list findings" use case that returns structured findings, a schema is a cleaner path than post-hoc extraction from a free-text answer. Out of v1 scope, but worth an "Open Questions" bullet.

### 25. Note the `oracle -p` / `claude -p` collision in docs

Both tools use `-p` as the prompt shorthand. Any doc snippet where both appear on the same line (`oracle -p "..." → claude -p "..."`) needs to be unambiguous. Prefer `--prompt` in Oracle docs to disambiguate.

### 26. Cite that Claude Code writes cost info in `total_cost_usd`

Every `claude -p --output-format json` result includes `total_cost_usd`. The plan's `result` event verification (Feature 7) should extract this and include it in metadata. For the 50% cap and post-July-7 credit-billing questions (see #5), this is the only observable signal Oracle has that a run may have consumed billed capacity.

---

## Recommended reshape

The smallest set of changes that would put the plan in defensible shape:

1. **Add a fork-vs-upstream section at the top.** State which files are in `etafund/oracle` only, which are in `steipete/oracle` upstream, and how the maintainer should navigate the two. Fixes #1.

2. **Add a "Current State" subsection to Feature 1.** Enumerate every entry point that can select an engine (`--engine`, `--browser`, `ORACLE_ENGINE`, config file, MCP field, `apiProviderRequested`) and state the `claude-code` routing decision for each. Fixes #2.

3. **Add a Phase 0.5 "Empirical CLI Check" step before Phase 1.** Run these commands on the installed CLI and paste the output into an appendix:
   - `claude --version`
   - `claude --help 2>&1`
   - `claude -p --help 2>&1`
   - One `claude -p --output-format stream-json --verbose "reply with the word ok"` on a subscription-authenticated machine, capturing the raw `system/init` event verbatim
   - One `claude --bare -p --output-format stream-json --verbose "reply with the word ok"` on the same machine to determine whether `--bare` breaks subscription auth

   Then rewrite Feature 3 (argv) and Feature 7 (verifier) to reference only strings and flags that actually appear in the captured output. Fixes #3, #4, #8.

4. **Reword hidden-reasoning language.** Replace `hidden_reasoning_captured: false` with a pair of fields: `hidden_reasoning_captured: false` (unchanged, correct as stated) and `visible_thinking_captured: true|false|unknown` (new, set from observed `thinking_delta` events). Update the honesty section. Fixes #7.

5. **Loosen the SUDO_USER refusal, remove the ANTHROPIC_MODEL refusal.** Refuse only on `EUID == 0` for the root case. Empirically verify argv wins over `ANTHROPIC_MODEL` and if so, scrub rather than refuse. Fixes #13, #14.

6. **Decide on Windows explicitly.** Either declare v1 macOS-and-Linux only, or add the Windows differences subsection. Fixes #16.

7. **Add subscription-cap and credit-billing acknowledgment.** State plainly whether Oracle can or cannot detect when the subscription has moved to credit billing, and set metadata accordingly. Fixes #5.

8. **Add small runner correctness notes.** Close stdin after writing (#9), distinguish `max_turns_reached` from `error` (#11), add a real "pretty" mode that assembles `text_delta` events (#12), add `system/api_retry` to the not-a-violation list (#18).

9. **Fix the single-flight lock.** Use `proper-lockfile` or an equivalent, pair pid with a start-time / nonce check, and add `--wait-for-lock` from v1. Fixes #10.

10. **Add the `oracle-mcp` Keychain smoke test.** One entry in `docs/manual-tests.md` covering the "invoke from a fresh MCP client, not a shell" scenario. Fixes #15.

These changes preserve the plan's overall shape and its (well-thought-out) security instincts. They replace the assumed CLI shape with an observed one, remove refusal rules that would block real users, acknowledge the parts of the situation Oracle genuinely cannot see, and make the runner robust to the small failure modes an agent swarm will otherwise miss.

---

## Appendix A — Verification log

The following were checked against sources during this review.

**Upstream repo (`steipete/oracle`, `main` branch):**

- `src/cli/engine.ts` — 200. Confirmed `EngineMode = "api" | "browser"`, confirmed `resolveEngine` behavior including `ORACLE_ENGINE`, `configEngine`, `hasApiEnvironment(env)` checking `OPENAI_API_KEY || OPENROUTER_API_KEY`.
- `src/cli/runOptions.ts` — 200. Confirmed `EngineMode` import and use throughout `browserRequested` / `fixedEngine` logic.
- `src/mcp/types.ts` — 200. Confirmed `engine: z.enum(["api", "browser"]).optional()`.
- `src/cli/sessionRunner.ts`, `src/sessionManager.ts`, `src/sessionStore.ts`, `src/mcp/tools/consult.ts`, `docs/anthropic.md`, `docs/mcp.md`, `docs/cli-reference.md` — 200 (existence confirmed; content not fully audited).
- `src/oracle/v18/provider_boundaries.ts` — 404. Not in upstream.
- `src/oracle/api_substitution_guard.ts` — 404. Not in upstream.
- Author confirmed these two files live in the `etafund/oracle` fork.

**Claude Code CLI reference and headless docs (Anthropic):**

- `-p`, `--print`, `--output-format` values `text|json|stream-json`, `--verbose`, `--include-partial-messages`, `--permission-mode` values `default|acceptEdits|plan|auto|dontAsk|bypassPermissions`, `--allowedTools`, `--disallowedTools`, `--max-turns`, `--max-budget-usd`, `--disable-slash-commands`, `--strict-mcp-config`, `--bare`, `--dangerously-skip-permissions`, `--continue`, `--resume`, `--fork-session`, `--append-system-prompt`, `--system-prompt`, `--system-prompt-file`, `--json-schema`, `--mcp-config`, `--input-format` — all documented.
- `--safe-mode`, `--no-chrome`, `--no-session-persistence`, `--include-hook-events` — not found in Anthropic's public reference or the third-party references checked (backgroundclaude.com CLI reference, hidekazu-konishi.com, buildthisnow.com, amux.io, eesel.ai). May exist internally.
- `--tools ""` as "disable all tools" — asserted by one third-party CLI reference (backgroundclaude.com), not corroborated by Anthropic's own docs in the sources checked.

**Claude Code `system/init` event shape (Anthropic SDK spec + real captures):**

- Fields observed in real init events: `type`, `subtype`, `uuid`, `session_id`, `cwd`, `model`, `tools`, `mcp_servers`, `permissionMode`, `apiKeySource`, `slash_commands`, `agents`, `skills`, `plugins`, `output_style`, `claude_code_version`.
- `apiKeySource` values observed in the wild: `"none"` (OAuth / subscription per SDK spec), `"ANTHROPIC_API_KEY"` (env var name), `"env"`, `"mock"` (in test fixtures). The plan's assumed value `"oauth"` was not observed.

**Fable 5 subscription access (rev. 2026-07-01):**

- Anthropic Fable 5 launch note (2026-06-09) — Fable 5 included in Pro, Max, Team, seat-based Enterprise plans through June 22.
- Anthropic Fable 5 / Mythos 5 announcement — confirmed same.
- PCWorld (2026-06-30 / 2026-07-01) — Fable 5 returned to subscription plans on July 1 with a 50% usage-window cap, availability through July 7 only, then usage-credit billing.
- Anthropic support article "Use Claude Code with your Pro or Max plan" — confirmed `ANTHROPIC_API_KEY` presence causes Claude Code to bill against API rather than subscription.

**Streaming and thinking events (Anthropic):**

- Anthropic streaming docs — confirmed `thinking_delta` and `signature_delta` events emitted for extended-thinking models, subject to `display: "omitted"` configuration.
- Fable 5 is Mythos-class extended-thinking model per Anthropic launch note.

---

## Appendix B — Empirical checks the implementer should run before writing code

Copy-pasteable. Ten to fifteen minutes total.

```bash
# 1. Confirm installed CLI version.
claude --version

# 2. Confirm subscription auth is active. Should show OAuth / claude.ai auth,
#    not an API key. If it shows an API key, unset ANTHROPIC_API_KEY and retry
#    after `claude` (interactive login).
claude auth status || true

# 3. Full flag surface.
claude --help 2>&1 | tee /tmp/claude-help.txt
claude -p --help 2>&1 | tee /tmp/claude-p-help.txt

# 4. Capture a real init event to nail down apiKeySource string for the verifier.
#    Make sure ANTHROPIC_API_KEY is unset first.
env | grep -i anthropic || echo "no anthropic env vars, good"
claude -p --output-format stream-json --verbose \
  --permission-mode plan \
  --disallowedTools "Bash,Read,Edit,Write,WebFetch,WebSearch,NotebookEdit,Task,Skill,Agent" \
  --strict-mcp-config \
  --disable-slash-commands \
  --max-turns 1 \
  "reply with the single word ok" 2>&1 | tee /tmp/claude-init.jsonl
# Then inspect: head -1 /tmp/claude-init.jsonl | jq
# Copy the exact "apiKeySource" value into the plan's verifier allowlist.
# Copy the exact "model" value to confirm what "--model fable" resolves to.
# Copy the "tools" array to see what's still present after the flags above.

# 5. Same run, but with --bare, to determine whether it breaks subscription auth
#    and to see how much the tools/mcp_servers/hooks/plugins list shrinks.
claude --bare -p --output-format stream-json --verbose \
  --permission-mode plan \
  --max-turns 1 \
  "reply with the single word ok" 2>&1 | tee /tmp/claude-bare-init.jsonl

# 6. Test --tools "" syntax if plan wants to rely on it. If this errors or
#    ignores the arg, the plan needs to fall back to --disallowedTools.
claude -p --output-format stream-json --verbose \
  --tools "" \
  --permission-mode plan \
  --max-turns 1 \
  "reply ok" 2>&1 | head -1

# 7. Test that argv --model wins over ANTHROPIC_MODEL. If yes, drop the refusal.
ANTHROPIC_MODEL=some-other-model claude -p --output-format stream-json --verbose \
  --model fable \
  --permission-mode plan \
  --max-turns 1 \
  "reply ok" 2>&1 | head -1 | jq '.model'
```

The output of these seven commands, captured verbatim into an appendix of the plan, removes the largest sources of uncertainty in a single afternoon and turns the argv, the verifier, and the guards from guesses into evidence.

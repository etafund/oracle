# oracle 🧿 — Whispering your tokens to the silicon sage

<p align="center">
  <img src="./README-header.png" alt="Oracle CLI header banner" width="1100">
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@steipete/oracle"><img src="https://img.shields.io/npm/v/@steipete/oracle?style=for-the-badge&logo=npm&logoColor=white" alt="npm version"></a>
  <a href="https://github.com/steipete/oracle/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/steipete/oracle/ci.yml?branch=main&style=for-the-badge&label=tests" alt="CI Status"></a>
  <a href="https://github.com/steipete/oracle"><img src="https://img.shields.io/badge/platforms-macOS%20%7C%20Linux%20%7C%20Windows-blue?style=for-the-badge" alt="Platforms"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green?style=for-the-badge" alt="MIT License"></a>
</p>

Oracle bundles your prompt and files so another AI can answer with real context. The current reviewed lanes are **ChatGPT Pro Extended Reasoning** through browser automation, **Fable xHigh** through the local Claude Code subscription CLI, and **Gemini 3.1 Deep Think** through browser automation. Older API and multi-model compatibility paths still exist, but they are not the primary agent-facing lane surface.

`oracle doctor lanes --json` is the source of truth for explicit lane-template readiness in your checkout. ChatGPT/Gemini browser command forms can be used for live browser smokes even when their explicit `--lane ...` templates are doctor-gated as not-ready/deferred.

> **ℹ️ This is a fork.** `etafund/oracle` tracks upstream [`steipete/oracle`](https://github.com/steipete/oracle), merges it regularly, and keeps the package name (`@steipete/oracle`), the `oracle` CLI, and all API-mode behavior identical. On top of that it layers reliability, in-session verification, recovery, and audit features for **browser-mode** consults — most importantly long-running **ChatGPT Pro (extended reasoning)** and **Gemini Deep Think** sessions that drive the official web apps in your own signed-in browser profile. Everything upstream still works as documented; the additions are opt-in commands/flags or automatic safety/quality improvements on browser runs. See **[What this fork adds over upstream](#what-this-fork-adds-over-upstream)** for the full, detailed breakdown.

## Setting up (macOS Browser Mode)

Browser mode lets you use ChatGPT Pro Extended Reasoning without API keys — it automates your signed-in Chrome browser directly. For remote agent use, run `oracle remote doctor --json` first to verify the router and browser hosts.

### First-time login

Run this once to create Oracle's private automation profile and log into ChatGPT. This profile is separate from your normal Chrome profile. The browser will stay open so you can complete the login:

```bash
oracle --engine browser --browser-manual-login \
  --browser-keep-browser --browser-input-timeout 120000 \
  -p "HI"
```

### Subsequent runs

Once logged in, the automation profile is saved. Use this for all future runs:

```bash
oracle --engine browser --browser-manual-login \
  --browser-auto-reattach-delay 5s \
  --browser-auto-reattach-interval 3s \
  --browser-auto-reattach-timeout 60s \
  -p "your prompt"
```

> **Why these flags?**
>
> - `--browser-manual-login` — Skips macOS Keychain cookie access (avoids repeated permission popups)
> - `--browser-auto-reattach-*` — Reconnects when ChatGPT redirects mid-page-load (fixes "Inspected target navigated or closed" error)
> - `--browser-keep-browser` — Keeps browser open for first-time login (not needed after)
> - `--browser-input-timeout 120000` — Gives you 2 minutes to log in on first run

## Quick start

Install globally: `npm install -g @steipete/oracle`
Homebrew: `brew install steipete/tap/oracle`

Requires Node 24+. Or use `npx -y @steipete/oracle …` (or pnpx).

```bash
# Copy the bundle and paste into ChatGPT
npx -y @steipete/oracle --render --copy -p "Review the TS data layer for schema drift" --file "src/**/*.ts,*/*.test.ts"

# ChatGPT Pro Extended Reasoning browser lane
npx -y @steipete/oracle --engine browser --model gpt-5.5-pro \
  --browser-thinking-time extended \
  -p "Write a concise architecture note for the storage adapters" \
  --file src/storage/README.md

# Fable xHigh local lane
npx -y @steipete/oracle --lane fable-local \
  -p "Review this migration plan" --file docs/plan.md

# Gemini 3.1 Deep Think browser lane
npx -y @steipete/oracle --engine browser --provider gemini --gemini-deep-think \
  -p "Cross-check the data layer assumptions" --file "src/**/*.ts"

# Follow up from an existing OpenAI/Azure session id
npx -y @steipete/oracle --engine api --model gpt-5.2-pro --followup release-readiness-audit --followup-model gpt-5.2-pro -p "Re-evaluate with this new context" --file "src/**/*.ts"

# Follow up directly from an OpenAI Responses API id
npx -y @steipete/oracle --engine api --model gpt-5.2-pro --followup resp_abc1234567890 -p "Continue from this response" --file docs/notes.md

# Preview without spending tokens
npx -y @steipete/oracle --dry-run summary -p "Check release notes" --file docs/release-notes.md

# Check the reviewed lane and remote-router contract
npx -y @steipete/oracle doctor lanes --json
npx -y @steipete/oracle remote doctor --json

# Trace startup and time-to-first-output
npx -y @steipete/oracle --perf-trace --perf-trace-path /tmp/oracle-perf.json \
  --dry-run summary -p "Quick smoke"

# Compatibility API paths are still available when explicitly needed
npx -y @steipete/oracle --engine api --model gpt-5.2-pro \
  -p "Walk through the UI smoke test" --file "src/**/*.ts"

# Add explicit shared context to a ChatGPT Project without deleting anything
npx -y @steipete/oracle project-sources add \
  --chatgpt-url "https://chatgpt.com/g/g-p-example/project" \
  --browser-manual-login \
  --file docs/architecture.md \
  --dry-run

# Browser multi-turn consult in one ChatGPT conversation
npx -y @steipete/oracle --engine browser --model gpt-5.5-pro \
  -p "Review this migration plan" --file docs/migration.md \
  --browser-follow-up "Challenge your previous recommendation" \
  --browser-follow-up "Give the final decision"

# Gemini browser mode image generation remains a compatibility path
npx -y @steipete/oracle --engine browser --model gemini-3.1-pro \
  --prompt "a cute robot holding a banana" --generate-image out.jpg --aspect 1:1

# Sessions (list and replay)
npx -y @steipete/oracle status --hours 72
npx -y @steipete/oracle session <id> --render
npx -y @steipete/oracle restart <id>

# Diagnose the remote browser endpoint (no auth tokens on argv)
npx -y @steipete/oracle remote doctor --json
npx -y @steipete/oracle remote status --json
npx -y @steipete/oracle remote attach --host remote.host:9473 --token-env ORACLE_REMOTE_TOKEN --json

# TUI (interactive, only for humans)
npx -y @steipete/oracle tui
```

For reviewed browser lanes, prefer explicit `--engine browser` or the protected Gemini flags instead of relying on API-key auto-pick. On Linux pass `--browser-chrome-path/--browser-cookie-path` if detection fails; on Windows prefer `--browser-manual-login` or inline cookies if decryption is blocked.

## Integration

**CLI**

- Reviewed lanes:
  - ChatGPT Pro Extended Reasoning: `--engine browser --model gpt-5.5-pro --browser-thinking-time extended`.
  - Fable xHigh: `--lane fable-local` on the local machine only; it does not use the companion router (`<router-repo>`) or remote browser hosts.
  - Gemini 3.1 Deep Think: `--engine browser --provider gemini --gemini-deep-think`.
- Compatibility API mode still accepts API keys in your environment, but the old provider/model matrix is not the preferred agent-facing lane surface.
- Gemini browser compatibility mode uses Chrome cookies instead of an API key—just be logged into `gemini.google.com` in Chrome (no Python/venv required).
- Browser automation is a live browser path. Use `oracle doctor lanes --json`, `oracle capabilities --json`, and `oracle remote doctor --json` before remote browser smokes.
- Browser support: stable on macOS; works on Linux (add `--browser-chrome-path/--browser-cookie-path` when needed) and Windows (manual-login or inline cookies recommended when app-bound cookies block decryption).
- Remote browser service: `oracle serve` on a signed-in host; clients use `--remote-host/--remote-token`.
- Browser artifacts: browser sessions save `transcript.md` and generated artifacts under `~/.oracle/sessions/<id>/artifacts/`. Deep Research saves `deep-research-report.md` when the report surface is captured; ChatGPT-generated images and downloadable files are saved with the active browser session when supported file URLs are present.
- MCP image agents: use the `chatgpt_image` tool for the easiest path, or pass `generateImage` to `consult` with `engine: "browser"`; saved paths come back in `structuredContent.images`.
- Browser archiving: by default, successful non-project, non-Deep-Research, non-multi-turn ChatGPT one-shots are archived after local artifacts are saved. Use `--browser-archive never` to disable or `--browser-archive always` to force archiving after a successful browser run. Archived chats remain manageable in ChatGPT.
- Conversation mode guidance: use one-shot browser runs for narrow bug reports or quick file-set reviews; use explicit browser follow-ups for ambiguous architecture/product tradeoffs where a challenge pass and final decision are valuable; use Deep Research for broad public-web questions that need citations. Oracle never invents follow-ups automatically.
- Project Sources: `oracle project-sources list|add --chatgpt-url <project-url>` manages the Project Sources tab in ChatGPT browser mode. v1 is append-only (`list`, `add`, `--dry-run`) so agents can share explicit project context without deleting or replacing user sources.
- Fast failure: root runs without a prompt exit nonzero after printing help; `--dry-run` conflicts with `--render` / `--render-markdown`; foreground API runs exit 130 on Ctrl-C while browser cleanup and session recovery still run.
- Performance traces: `--perf-trace` / `ORACLE_PERF_TRACE=1` writes JSON timing marks for startup, root command, first output, and exit. `--perf-trace-path` or `--perf-trace=/tmp/oracle.json` selects the path; detached API children write a session-suffixed sidecar trace.
- AGENTS.md/CLAUDE.md:
  ```
  - Oracle bundles a prompt plus the right files so another AI (GPT 5 Pro + more) can answer. Use when stuck/bugs/reviewing.
  - Run `npx -y @steipete/oracle --help` once per session before first use.
  ```
- Tip: set `browser.chatgptUrl` in config (or `--chatgpt-url`) to a dedicated ChatGPT project folder so browser runs don’t clutter your main history.

**Codex skill**

- Copy the bundled skill from this repo to your Codex skills folder:
  - `mkdir -p ~/.codex/skills`
  - `cp -R skills/oracle ~/.codex/skills/oracle`
- Then reference it in your `AGENTS.md`/`CLAUDE.md` so Codex loads it.

**MCP**

- Run the stdio server via `oracle-mcp`.
- Configure clients via [steipete/mcporter](https://github.com/steipete/mcporter) or `.mcp.json`; see [docs/mcp.md](docs/mcp.md) for connection examples.
- Claude Code on the same Mac as a signed-in ChatGPT browser can generate a local config directly:

```bash
oracle bridge claude-config --local-browser > .mcp.json
```

- In MCP `consult`, use `preset: "chatgpt-pro-heavy"` for ChatGPT browser mode with `gpt-5.5-pro` and Pro Extended thinking. Add `dryRun: true` to inspect the resolved run without creating a session or touching Chrome.

```bash
npx -y @steipete/oracle oracle-mcp
```

- Cursor setup (MCP): drop a `.cursor/mcp.json` like below, then pick “oracle” in Cursor’s MCP sources. See https://cursor.com/docs/context/mcp for UI steps.
  [![Install MCP Server](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en-US/install-mcp?name=oracle&config=eyJjb21tYW5kIjoibnB4IC15IEBzdGVpcGV0ZS9vcmFjbGUgb3JhY2xlLW1jcCJ9)

```json
{
  "oracle": {
    "command": "oracle-mcp",
    "args": []
  }
}
```

## Highlights

- Bundle once, send through the reviewed ChatGPT Pro Extended Reasoning, Fable xHigh, or Gemini 3.1 Deep Think lane.
- ChatGPT/Gemini browser lanes can run locally or through `oracle serve` / the companion router (`<router-repo>`); Fable xHigh stays local-only through `--lane fable-local`.
- Claude Code / MCP browser consults can use the `chatgpt-pro-heavy` preset for a compact ChatGPT Pro second-opinion workflow.
- Render/copy bundles for manual paste into ChatGPT, Claude, or Gemini when automation is blocked.
- Long browser runs can be reattached via `oracle session <id>` / `oracle status` instead of restarted.
- Saved ChatGPT browser conversations and OpenAI/Azure compatibility API runs can continue from `--followup <sessionId|responseId>`; for multi-model API parents, add `--followup-model <model>`.
- Compatibility API and multi-model runs remain available, including Azure/OpenRouter-style routing, but they are not the primary reviewed lane surface.
- Redacted provider checks via `oracle doctor --providers`, `--route`, and `--preflight` before spending compatibility API time.
- File safety: globs/excludes, size guards, `--files-report`.
- Sessions you can replay (`oracle status`, `oracle session <id> --render`).
- Session logs and bundles live in `~/.oracle/sessions` (override with `ORACLE_HOME_DIR`).

## What this fork adds over upstream

`etafund/oracle` is a fork of upstream [`steipete/oracle`](https://github.com/steipete/oracle). It merges upstream regularly and keeps the package name (`@steipete/oracle`), the `oracle` CLI, and all API-mode behavior identical. On top of that baseline it adds a focused layer of **reliability, in-session verification, recovery, auditability, and privacy hardening** for **browser-mode** consults — the path that drives the official ChatGPT and Gemini web apps inside your own signed-in browser profile. This matters most for **long-running reasoning sessions** (ChatGPT Pro with extended reasoning, and Gemini Deep Think), where a single run can think for many minutes and a dropped tab or a mis-captured answer is costly.

This section is meant to be self-contained: you should be able to understand what the fork does, and why, without reading the source.

> Browser mode automates web apps you are already signed into; use it in accordance with each provider's terms of service.

### Compare against upstream yourself

```bash
git remote add upstream https://github.com/steipete/oracle.git
git fetch upstream
git log upstream/main..HEAD
git diff upstream/main...HEAD
```

Use the first command to inspect commits this fork carries on top of upstream, and the second to inspect the file-level divergence.

### Design principles

Everything below follows the same handful of rules:

- **Fail closed, never fake success.** If the fork can't confirm the right model/mode, or can't capture a complete answer, it returns a typed, recoverable error — not a guess dressed up as a result.
- **Verify in the same session, before submitting.** For protected routes, the requested model and the highest visible reasoning control are confirmed in the live tab _before_ the prompt is sent.
- **Capture the whole answer.** Output capture waits for genuinely long reasoning to finish, then checks the captured text for truncation.
- **Recover, don't duplicate.** A dropped connection or a client timeout becomes a resumable session (`oracle session <id> --render`), not a lost run or an accidental second submission.
- **Privacy by default.** Cookies, tokens, emails, raw prompts/outputs, and page DOM are never written to logs or artifacts — only hashes and structural metadata.
- **Machine-readable everything.** New commands emit a uniform JSON envelope with `blocked_reason` / `next_command` / `fix_command` / `retry_safe`, so an agent or MCP driver can branch on results without scraping prose.
- **Attest locally, don't overclaim.** Verification and evidence describe what the web UI showed and what was captured on _your_ machine. They are a local confidence check for you; they make no claim about a provider's backend.

### 1) Same-session model & reasoning-effort verification (browser mode)

On protected browser routes (ChatGPT Pro, Gemini Deep Think), Oracle confirms — in the same browser tab, before sending your prompt — that the intended model is actually selected and that the **highest reasoning control the web UI currently exposes for your account** is engaged (extended reasoning for ChatGPT Pro; Deep Think / highest thinking level for Gemini). It reads the visible picker/composer labels and ranks them against a small, **rename-tolerant** table of known tiers, so a provider relabelling a control does not silently downgrade your run. If the controls aren't where they should be, Oracle reports `ui_drift_suspected` and stops instead of submitting against an unverified UI. Upstream submits without this same-session gate.

### 2) Capturing the complete answer

Long reasoning runs are exactly where naive capture goes wrong. The fork adds:

- **Turn binding** — the captured answer is bound to the turn you submitted, so a previous round's answer is never returned as the current one.
- **A long-reasoning wait controller** — waits out genuinely long ChatGPT Pro / Deep Think responses with periodic heartbeats, and never short-circuits a run that is still thinking.
- **Truncation detection** — captured Markdown is checked for balance (e.g. unclosed code fences) so a half-streamed answer is flagged rather than shipped as final.
- **"Still thinking" vs "final answer" detection** — streamed reasoning/preamble is not mistaken for the final response.

### 3) Long-run resilience & recovery

- **Reconnect / auto-reattach** — if the browser connection drops mid-run, Oracle decides between waiting, reattaching, backgrounding, or giving up, with bounded backoff. Exhausting retries yields a _recoverable_ session, never a fabricated "no answer."
- **Detached finalizer** — a background worker re-renders/attaches a long run until a real transcript is captured, rescuing sessions that would otherwise be left in an error/partial state after a client timeout.
- **`oracle-await`** (shipped helper) — polls a session to completion with structured exit codes (ready / still-running / errored / unknown), so wrappers and agents can wait safely instead of re-running.
- **Remote-run snapshots & heartbeats** — a long run delegated to `oracle serve` survives network drops as a typed, replayable snapshot, with one-JSON-line-per-beat liveness.

### 4) Same-thread follow-ups & detached sessions

**`oracle follow-up <parentSessionId> [prompt]`** (and an MCP `follow_up` tool) continue an existing ChatGPT browser conversation **in the same thread**, inheriting the parent's profile/model, so the model keeps the context it already has instead of re-establishing it. The run is detached (it survives a client disconnect) and returns a reattach command, and it fails closed if it can't confirm the saved thread.

### 5) Local evidence & audit trail (opt-in, fully redacted)

- **`oracle evidence show|verify <session>`** and **`oracle evidence ledger show|verify|export <session>`** inspect a redacted record of what a browser run did.
- The ledger is **append-only and hash-chained**, so reordering or editing is detectable, and `verify` re-hashes the stored artifacts to confirm they weren't altered.
- This is a **local** confidence tool: it lets _you_ confirm a run selected the model/effort you asked for and captured the answer intact. **Redaction is always on** — no cookies, tokens, emails, raw prompts/outputs, or DOM are ever stored, only hashes and structural metadata. `export` produces a sanitized, still-verifiable snapshot for handoff.

### 6) Browser-profile leases (single-flight)

**`oracle browser leases plan|status|acquire|release|recover`** coordinate a single-flight lock over a signed-in browser profile, so two concurrent Oracle runs don't drive the same profile at once. Locks are reclaimed automatically when a holder dies; `recover` never silently steals a live peer's lock.

### 7) Remote-browser hardening

**`oracle remote doctor|status|attach`** and **`oracle bridge doctor --json`** diagnose a remote `oracle serve` endpoint. Attach diagnostics read access tokens from a **named environment variable** (`--token-env`) so the token is not placed on argv, and the host is shown only as a short hash. Runtime commands still accept legacy token flags for compatibility; prefer `ORACLE_REMOTE_TOKEN` or `browser.remoteToken` in `~/.oracle/config.json`. The remote service uses constant-time token comparison, an allowlist for wire payloads (your local cookies/profile are never shipped to the host, which uses its own signed-in profile), and preserves model-selection metadata end-to-end so remote runs report the same evidence as local ones.

### 8) Diagnostics & agent ergonomics

All read-only, no provider calls, JSON-first:

- **`oracle doctor`** (aggregate) and **`oracle doctor chatgpt|gemini`** — preflight whether the protected route and the highest reasoning controls are available and logged-in, without submitting a prompt.
- **`oracle capabilities`** — a static matrix of what's usable right now vs. needs configuration vs. unsupported.
- **`oracle robot-docs`** — emits the full command registry (purpose, whether a command makes paid/live calls, required env, output schema) so an agent can discover the surface without parsing `--help`.
- **`oracle preview`** and **`oracle visibility-status`** — estimate what a run would do and roll up readiness, again with zero provider calls.
- **Structured errors** — even top-level crashes/usage errors are emitted as a JSON envelope in `--json` mode (no raw stack traces for an agent to parse).

### 9) Security & privacy hardening

- **SSRF-safe downloads** — image/file downloads from ChatGPT/Gemini are restricted to specific allowlisted hosts and paths, re-validated on every redirect hop.
- **Strict tab/URL checks** — exact host matching for ChatGPT tabs; look-alike or credential-embedded URLs are rejected.
- **Secret hygiene** — a redaction layer plus a leak detector keep credentials and PII out of logs, evidence, and artifacts.
- **ChatGPT file artifacts** — files a run generates (CSV/JSON/ZIP/PDF) are saved as session artifacts through a narrow authenticated-download allowlist.
- **Operational papercuts fixed** — actionable guidance when the native keychain module needs a rebuild; accurate upload-size pre-checks with byte-exact bundle preservation.

### 10) Gemini web-mode hardening

Useful even outside Deep Think: the Gemini cookie/web client reassembles JSON that arrives split across stream frames (so a chunk boundary mid-object can't drop the answer), verifies the streamed answer belongs to your conversation, converts silent empty/truncated captures into retry-safe typed errors, and downloads generated images with your cookies through an allowlist.

### 11) Protected-route planning command

**`oracle run --chatgpt-pro --extended-reasoning`** (or **`--gemini-deep-think`**) is a **no-submission** planner: it validates the route, refuses to plan a downgraded or API-substituted protected route, and prints the exact `doctor` / `lease` / run commands to execute. Add `--dry-run` / `--json` for agent preflight. (Your everyday Pro consult is still just `oracle --engine browser -m <pro-model> -p "…"`; the verification and capture hardening above apply automatically.)

### 12) Quality & process apparatus

The fork carries a contracts-first spec bundle (under `PLAN/`) plus several test suites upstream doesn't have — conformance (wire-contract checks), metamorphic (property/invariant checks such as redaction idempotency and hash determinism), premortem failure-mode tests, fuzzing, filesystem-safety, and secret-leak regression — gated in CI by `pnpm run release:readiness`. Merge-discipline notes (`MERGE-RESOLUTION-CHARTER.md`, `MERGE-RESOLUTION-LOG.md`) document how upstream is absorbed without dropping fork features.

### New commands & key flags (quick reference)

| Command / flag                                                       | What it does                              | Calls a provider?  |
| -------------------------------------------------------------------- | ----------------------------------------- | ------------------ |
| `oracle doctor [--json]`                                             | Aggregate preflight diagnostics           | No                 |
| `oracle doctor chatgpt --pro --extended-reasoning [--json]`          | ChatGPT Pro route readiness               | No                 |
| `oracle doctor gemini --deep-think [--json]`                         | Gemini Deep Think route readiness         | No                 |
| `oracle capabilities [--json]`                                       | Static capability matrix                  | No                 |
| `oracle robot-docs [--json]`                                         | Machine-readable command registry         | No                 |
| `oracle preview` / `oracle visibility-status`                        | Estimate / roll-up before a run           | No                 |
| `oracle run --chatgpt-pro --extended-reasoning [--dry-run] [--json]` | Plan a protected route (no submit)        | No                 |
| `oracle browser leases plan\|status\|acquire\|release\|recover`      | Single-flight profile locks               | No                 |
| `oracle evidence show\|verify <session>`                             | Inspect / verify redacted run evidence    | No                 |
| `oracle evidence ledger show\|verify\|export <session>`              | Hash-chained audit ledger                 | No                 |
| `oracle remote doctor\|status\|attach`                               | Diagnose remote `serve` endpoint          | Network probe only |
| `oracle follow-up <parentSessionId> [prompt]`                        | Continue a saved ChatGPT thread           | Yes (browser)      |
| `--gemini-deep-think`, `--evidence redacted` (on the main run)       | Protected Gemini Deep Think browser route | Yes (browser)      |

### What this fork does NOT change

The package name (`@steipete/oracle`), the `oracle` command, API-mode behavior and model routing, and all upstream flags are unchanged. Everything above is additive: existing upstream workflows keep working exactly as documented, and the new behavior is either opt-in (new commands/flags) or an automatic safety/quality improvement on browser runs.

## Compatibility API provider checks

Use these before compatibility API or multi-model runs:

```bash
oracle doctor --providers --models gpt-5.4,claude-4.6-sonnet,gemini-3-pro
oracle --preflight --models gpt-5.4,gemini-3-pro
oracle --provider openai --route --model gpt-5.4
```

`doctor` and `--preflight` print redacted readiness only: provider route, base host, key source, Azure state, and local configuration errors. `--route` shows the selected route and exits before creating a session. If Azure env/config is present but you want first-party OpenAI, add `--provider openai` or `--no-azure`.

For advisory panels where one good answer is useful, combine partial success with explicit output files:

```bash
oracle \
  --models gpt-5.4,claude-4.6-sonnet,gemini-3-pro \
  --allow-partial \
  --write-output /tmp/oracle-panel.md \
  -p "Compare these naming options"
```

Successful models write per-model files such as `/tmp/oracle-panel.gpt-5.4.md`; Oracle also writes `/tmp/oracle-panel.oracle.json` with successes, failures, output paths, and provider failure categories.

## Follow-up and lineage

Use `--followup` to continue a saved ChatGPT browser conversation or an existing OpenAI/Azure Responses API run with additional context/files:

```bash
oracle \
  --followup <browser-session-id-or-slug> \
  --slug "my-browser-followup" \
  -p "Follow-up: review this additional file in the same conversation." \
  --file "server/src/strategy/plan.ts"
```

Browser followup reopens the exact saved conversation and inherits its browser profile, configuration, and model. Resume fails closed before submission if Oracle cannot verify the saved thread and prior turns.

```bash
oracle \
  --engine api \
  --model gpt-5.2-pro \
  --followup <existing-session-id-or-resp_id> \
  --followup-model gpt-5.2-pro \
  --slug "my-followup-run" \
  --wait \
  -p "Follow-up: re-evaluate the previous recommendation with the attached files." \
  --file "server/src/strategy/plan.ts" \
  --file "server/src/strategy/executor.ts"
```

When the parent session used `--models`, `--followup-model` picks which model's response id to chain from.
Custom `--base-url` providers plus Gemini/Claude API runs are excluded here because they do not preserve `previous_response_id` in Oracle.

`oracle status` shows parent/child lineage in tree form:

```text
Recent Sessions
Status    Model         Mode    Timestamp           Chars    Cost  Slug
completed gpt-5.2-pro   api     03/01/2026 09:00 AM  1800  $2.110  architecture-review-parent
completed gpt-5.2-pro   api     03/01/2026 09:14 AM  2200  $2.980  ├─ architecture-review-followup
running   gpt-5.2-pro   api     03/01/2026 09:22 AM  1400       -  │  └─ architecture-review-implementation-pass
pending   gpt-5.2-pro   api     03/01/2026 09:25 AM   900       -  └─ architecture-review-risk-check
```

## Browser auto-reattach (long Pro runs)

When browser runs time out (common with long GPT‑5.x Pro responses), Oracle can keep polling the existing ChatGPT tab and capture the final answer without manual `oracle session <id>` commands.

Enable auto-reattach by setting a non-zero interval:

- `--browser-auto-reattach-delay` — wait before the first retry (e.g. `30s`)
- `--browser-auto-reattach-interval` — how often to retry (e.g. `2m`)
- `--browser-auto-reattach-timeout` — per-attempt budget (default `2m`)

```bash
oracle --engine browser \
  --browser-timeout 6m \
  --browser-auto-reattach-delay 30s \
  --browser-auto-reattach-interval 2m \
  --browser-auto-reattach-timeout 2m \
  -p "Run the long UI audit" --file "src/**/*.ts"
```

## Calmer browser runs

Browser automation can open or control Chrome, so dry-runs and live runs print a short browser control plan before touching ChatGPT. Use it to choose the least disruptive path for shared desktops and agent-driven consults.

- `--dry-run summary --engine browser ...` previews whether Oracle will launch visible Chrome, hide a new window, attach to an existing browser, or use remote Chrome.
- `--browser-attach-running` and `--remote-chrome <host:port>` are the calmest options when a signed-in Chrome is already running with DevTools enabled.
- `--browser-hide-window` is best-effort: Chrome can briefly take focus before Oracle hides it.
- Long GPT-5.5 Pro browser consults are normal. Use `--heartbeat`, `oracle status`, and `oracle session <id>` instead of starting a duplicate run if the host agent appears to be waiting.
- Successful manual-profile runs close Oracle's own ChatGPT tab and clean up leftover blank startup tabs when no other Oracle browser slots are active. Incomplete runs leave the tab open so `oracle session <id>` can reattach.

## Flags you’ll actually use

| Flag                                                                           | Purpose                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `-p, --prompt <text>`                                                          | Required prompt.                                                                                                                                                                                                                                                  |
| `-f, --file <paths...>`                                                        | Attach files/dirs (globs + `!` excludes).                                                                                                                                                                                                                         |
| `-e, --engine <api\|browser\|claude-code>`                                     | Choose the engine. Reviewed lanes use browser for ChatGPT/Gemini and `claude-code` through `--lane fable-local`.                                                                                                                                                  |
| `--lane fable-local`                                                           | Run the Fable xHigh local lane. It is local-only and refuses remote/browser/API fan-out.                                                                                                                                                                          |
| `-m, --model <name>`                                                           | For reviewed lanes, use `gpt-5.5-pro` with extended browser thinking, `fable` via `--lane fable-local`, or Gemini through `--provider gemini --gemini-deep-think`. Older API/browser aliases remain compatibility paths.                                          |
| `--models <list>`                                                              | Compatibility-only API fan-out. Not part of the reviewed lane surface.                                                                                                                                                                                            |
| `--followup <sessionId\|responseId>`                                           | Continue a saved ChatGPT browser conversation or an OpenAI/Azure Responses API run from a stored Oracle session or `resp_...` response id.                                                                                                                        |
| `--followup-model <model>`                                                     | For multi-model OpenAI/Azure parent sessions, choose which model response to continue from.                                                                                                                                                                       |
| `--base-url <url>`                                                             | Point API runs at LiteLLM/Azure/OpenRouter/etc.                                                                                                                                                                                                                   |
| `--chatgpt-url <url>`                                                          | Target a ChatGPT workspace/folder or Temporary Chat URL (browser).                                                                                                                                                                                                |
| `--browser-model-strategy <select\|current\|ignore>`                           | Control ChatGPT model selection in browser mode (current keeps the active model; ignore skips the picker).                                                                                                                                                        |
| `--browser-manual-login`                                                       | Skip cookie copy; reuse a persistent automation profile and wait for manual ChatGPT login.                                                                                                                                                                        |
| `--browser-attach-running`                                                     | Reuse your current local browser session through local `DevToolsActivePort` discovery; Oracle opens a dedicated tab instead of launching Chrome (defaults to `127.0.0.1:9222`, or combine with `--remote-chrome <host:port>` to hint a different local endpoint). |
| `--browser-tab <ref>`                                                          | Reuse an existing ChatGPT tab by `current`, target id, URL, or title substring instead of opening a new tab.                                                                                                                                                      |
| `--browser-thinking-time <light\|standard\|extended\|heavy>`                   | Set ChatGPT thinking-time intensity (browser; Thinking/Pro models only).                                                                                                                                                                                          |
| `--browser-research deep`                                                      | Activate ChatGPT Deep Research for broad web research and cited reports (browser only).                                                                                                                                                                           |
| `--browser-follow-up <prompt>`                                                 | Browser-only multi-turn consult: submit an additional prompt in the same ChatGPT conversation after the initial answer. Repeat for challenge/revision/final-decision passes. Not supported with Deep Research mode.                                               |
| `--browser-archive <auto\|always\|never>`                                      | Archive completed ChatGPT browser conversations after local artifacts are saved. `auto` archives successful one-shot chats only, and skips project, Deep Research, multi-turn, failed, and incomplete sessions.                                                   |
| `--browser-attachments <auto\|never\|always>`                                  | Control browser file delivery: `auto` pastes small text files inline and uploads larger or raw files, `never` requires inline-compatible text files, and `always` uploads files as ChatGPT attachments.                                                           |
| `--browser-bundle-files`, `--browser-bundle-format <auto\|text\|zip>`          | Bundle browser uploads into one attachment. `auto` uses a text bundle for text-only inputs and a byte-preserving ZIP when bundled inputs include raw files; `text` writes a Markdown-style text bundle; `zip` archives the original file bytes.                   |
| `--browser-port <port>`                                                        | Pin the Chrome DevTools port (WSL/Windows firewall helper).                                                                                                                                                                                                       |
| `--browser-inline-cookies[(-file)] <payload \| path>`                          | Supply cookies without Chrome/Keychain (browser).                                                                                                                                                                                                                 |
| `--browser-timeout`, `--browser-input-timeout`, `--browser-attachment-timeout` | Control overall/browser input/attachment readiness timeouts (supports h/m/s/ms).                                                                                                                                                                                  |
| `--browser-recheck-delay`, `--browser-recheck-timeout`                         | Delayed recheck for long Pro runs: wait then retry capture after timeout (supports h/m/s/ms).                                                                                                                                                                     |
| `--heartbeat <seconds>`                                                        | Emit API and browser progress heartbeats. Browser mode reports ChatGPT Thinking/Reasoning sidecar liveness metadata when available, without logging reasoning text.                                                                                               |
| `--browser-reuse-wait`                                                         | Wait for a shared Chrome profile before launching (parallel browser runs).                                                                                                                                                                                        |
| `--browser-profile-lock-timeout`                                               | Wait for the shared manual-login profile lock before sending (serializes parallel runs).                                                                                                                                                                          |
| `--browser-max-concurrent-tabs`                                                | Soft limit for simultaneous ChatGPT tabs sharing one manual-login profile (default 3).                                                                                                                                                                            |
| `--render`, `--copy`                                                           | Print and/or copy the assembled markdown bundle.                                                                                                                                                                                                                  |
| `--wait`                                                                       | Block for background API runs (e.g., GPT‑5.1 Pro) instead of detaching.                                                                                                                                                                                           |
| `--timeout <seconds\|duration\|auto>`                                          | Overall API deadline (auto = 60m for pro, 120s otherwise; durations like `10m` derive HTTP/stale-session timeouts unless overridden).                                                                                                                             |
| `--background`, `--no-background`                                              | Force Responses API background mode (create + retrieve) for API runs.                                                                                                                                                                                             |
| `--http-timeout <ms\|s\|m\|h>`                                                 | Override the HTTP client timeout; if omitted, explicit `--timeout` values are reused for transport.                                                                                                                                                               |
| `--zombie-timeout <ms\|s\|m\|h>`                                               | Override stale-session cutoff used by `oracle status`.                                                                                                                                                                                                            |
| `--zombie-last-activity`                                                       | Use last log activity to detect stale sessions.                                                                                                                                                                                                                   |
| `--write-output <path>`                                                        | Save only the final answer (multi-model adds `.<model>` and writes `<stem>.oracle.json`). Browser sessions also save transcripts and generated artifacts under `~/.oracle/sessions/<id>/artifacts/`.                                                              |
| `--allow-partial`, `--partial <fail\|ok>`                                      | Multi-model failure policy. Default `fail` exits 1 after printing a structured partial summary; `ok` exits 0 when at least one model succeeds.                                                                                                                    |
| `--preflight`                                                                  | Check redacted provider readiness for requested API model(s), then exit without creating a session.                                                                                                                                                               |
| `--perf-trace`, `--perf-trace-path <path>`                                     | Write startup/first-output timing trace JSON; also accepts `--perf-trace=/tmp/oracle.json`, `ORACLE_PERF_TRACE=1`, or `ORACLE_PERF_TRACE=/tmp/oracle.json`.                                                                                                       |
| `--files-report`                                                               | Print per-file token usage.                                                                                                                                                                                                                                       |
| `--dry-run [summary\|json\|full]`                                              | Preview without sending.                                                                                                                                                                                                                                          |
| `--remote-host`, `--remote-token`                                              | Use a remote `oracle serve` host (browser). Prefer `ORACLE_REMOTE_TOKEN` or `browser.remoteToken` over putting tokens on argv.                                                                                                                                    |
| `--remote-chrome <host:port>`                                                  | Attach to an existing remote Chrome session (browser), or when combined with `--browser-attach-running` use this host:port as the local attach hint.                                                                                                              |
| `--youtube <url>`                                                              | YouTube video URL to analyze (Gemini browser mode).                                                                                                                                                                                                               |
| `--generate-image <file>`                                                      | Generate image and save to file (Gemini browser mode; ChatGPT browser mode saves downloadable image artifacts when present). Extra ChatGPT images save as numbered siblings.                                                                                      |
| `--edit-image <file>`                                                          | Edit existing image with `--output` (Gemini browser mode). For ChatGPT browser mode, attach source images with `--file` and use `--generate-image` for the output path.                                                                                           |
| `--provider openai\|azure\|auto`, `--no-azure`, `--route`                      | Choose or inspect API provider routing; `openai` / `--no-azure` ignores Azure env/config for the run.                                                                                                                                                             |
| `--azure-endpoint`, `--azure-deployment`, `--azure-api-version`                | Target Azure OpenAI endpoints (picks Azure client automatically).                                                                                                                                                                                                 |

## Configuration

Put defaults in `~/.oracle/config.json` (JSON5). Example:

```json5
{
  model: "gpt-5.5-pro",
  engine: "api",
  filesReport: true,
  browser: {
    chatgptUrl: "https://chatgpt.com/g/g-p-691edc9fec088191b553a35093da1ea8-oracle/project",
    archiveConversations: "auto",
  },
}
```

Use `browser.chatgptUrl` (or the legacy alias `browser.url`) to target a specific ChatGPT workspace/folder for browser automation.
See [docs/configuration.md](docs/configuration.md) for precedence and full schema.

When several agents share one manual-login ChatGPT profile, Oracle coordinates browser tab slots through that profile. Extra runs wait and log that they are waiting for a ChatGPT browser slot instead of crashing because another Codex/Claude/CLI run is already using the browser. For the most reliable shared-agent setup, keep one signed-in Chrome open with remote debugging and point callers at it with `--remote-chrome <host:port>`; direct manual-login launches are guarded so parallel callers reuse the first reachable Chrome instead of racing separate launches on the same profile.

Advanced flags

| Area         | Flags                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Browser      | `--browser-manual-login`, `--browser-attach-running`, `--browser-thinking-time`, `--browser-research`, `--browser-follow-up`, `--browser-archive`, `--browser-timeout`, `--browser-input-timeout`, `--browser-attachment-timeout`, `--browser-recheck-delay`, `--browser-recheck-timeout`, `--browser-reuse-wait`, `--browser-profile-lock-timeout`, `--browser-max-concurrent-tabs`, `--browser-auto-reattach-delay`, `--browser-auto-reattach-interval`, `--browser-auto-reattach-timeout`, `--browser-cookie-wait`, `--browser-inline-cookies[(-file)]`, `--browser-attachments`, `--browser-inline-files`, `--browser-bundle-files`, `--browser-bundle-format`, `--browser-keep-browser`, `--browser-headless`, `--browser-hide-window`, `--browser-no-cookie-sync`, `--browser-allow-cookie-errors`, `--browser-chrome-path`, `--browser-cookie-path`, `--chatgpt-url` |
| Run control  | `--background`, `--no-background`, `--http-timeout`, `--zombie-timeout`, `--zombie-last-activity`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Azure/OpenAI | `--azure-endpoint`, `--azure-deployment`, `--azure-api-version`, `--base-url`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

Remote browser example

```bash
export ORACLE_REMOTE_TOKEN="<shared remote bearer token>"

# Host (signed-in Chrome): launch serve
oracle serve --host 0.0.0.0:9473 --token "$ORACLE_REMOTE_TOKEN"

# Client: target that host
oracle --engine browser --remote-host 192.168.1.10:9473 \
  -p "Run the UI smoke" --file "src/**/*.ts"

# If cookies can’t sync, pass them inline (JSON/base64)
oracle --engine browser --browser-inline-cookies-file ~/.oracle/cookies.json -p "Run the UI smoke" --file "src/**/*.ts"
```

Remote browser hosts and the companion router (`<router-repo>`) are transport for ChatGPT Pro Extended Reasoning and Gemini 3.1 Deep Think browser lanes. Fable xHigh stays local-only through `--lane fable-local`.

Session management

```bash
# Prune stored sessions (default path ~/.oracle/sessions; override ORACLE_HOME_DIR)
oracle status --clear --hours 168
```

## More docs

- Bridge (Windows host → Linux client): [docs/bridge.md](docs/bridge.md)
- Browser mode & forks: [docs/browser-mode.md](docs/browser-mode.md) (includes `oracle serve` remote service), [docs/chromium-forks.md](docs/chromium-forks.md), [docs/linux.md](docs/linux.md)
- MCP: [docs/mcp.md](docs/mcp.md)
- OpenAI/Azure/OpenRouter endpoints: [docs/openai-endpoints.md](docs/openai-endpoints.md), [docs/openrouter.md](docs/openrouter.md)
- Manual smokes: [docs/manual-tests.md](docs/manual-tests.md)
- Testing: [docs/testing.md](docs/testing.md)

If you’re looking for an even more powerful context-management tool, check out https://repoprompt.com  
Name inspired by: https://ampcode.com/news/oracle

## More free stuff from steipete

- ✂️ [Trimmy](https://trimmy.app) — “Paste once, run once.” Flatten multi-line shell snippets so they paste and run.
- 🟦🟩 [CodexBar](https://codexbar.app) — Keep Codex token windows visible in your macOS menu bar.
- 🧳 [MCPorter](https://mcporter.dev) — TypeScript toolkit + CLI for Model Context Protocol servers.

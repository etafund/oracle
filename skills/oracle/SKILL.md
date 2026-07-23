---
name: oracle
description: Use @steipete/oracle to bundle prompts/files for second-model review, debugging, refactoring, and design through ChatGPT/Gemini browser lanes, local Fable xHigh, or compatibility APIs.
---

# Oracle (CLI) — best use

Oracle bundles a prompt and selected files into a one-shot request so another
model can answer with real repository context through browser automation,
local Claude Code, or a compatibility API. A prompt is required; attach files
only when they add necessary context. Treat responses as advisory and verify
them against the codebase and tests.

## Main use case (browser, GPT-5.6)

Use browser mode with GPT-5.6 when the ChatGPT account exposes it. GPT-5.6 Sol
and GPT-5.6 Sol Pro are distinct targets: base Sol uses the Extra High effort
setting, while Pro is a separate picker target for difficult or long-running
work.

Recommended defaults:

- Engine: browser (`--engine browser`)
- Base Sol: `--model gpt-5.6-sol`
- Base Sol maximum reasoning: `--browser-thinking-time heavy` (Extra High)
- Pro: `--model gpt-5-pro`, without a thinking-time flag
- Fallback: explicitly use `--model gpt-5.5-pro` when GPT-5.6 is unavailable
- Attachments: directories/globs plus excludes; never attach secrets by default

GPT-5.6 availability is account-dependent. Confirm the base Sol picker and
retain model-selection evidence. A bare `Pro` picker label proves picker
selection but does not, by itself, prove the server-side Pro generation.

## GPT-5.6 model selection

This version supports the same aliases in browser and API mode:

- `gpt-5.6`: follow the GPT-5.6 family default
- `gpt-5.6-sol`: pin ChatGPT's `GPT-5.6 Sol` entry
- `gpt-5-pro`: select ChatGPT's `Pro` target

For base Sol, use:

```bash
oracle --engine browser --model gpt-5.6-sol \
  --browser-thinking-time heavy \
  -p "<task>" --file "src/**"
```

Do not use `--model "GPT-5.6 Sol Pro"`. Pro is intentionally handled as a
distinct picker target. Browser label validation rejects unknown future
variants such as `gpt-5.6-luna` instead of silently falling back to Sol; API
runs preserve such provider model IDs unchanged.

Browser mode maps these aliases to ChatGPT's Sol picker. API and multi-model
runs preserve the corresponding first-party OpenAI model IDs; provider-qualified
and unrelated custom IDs remain pass-through values.

The GPT-5.6 browser support depends on the unified Intelligence picker. It
recognizes the current English and Chinese effort labels, avoids matching
`高` inside `极高`, and re-queries the composer pill after React replaces it so
selection verification cannot rely on a detached stale node.

## Compatibility with npm 0.15.2

Do not pass `gpt-5.6` or `gpt-5.6-sol` to an unpatched npm 0.15.2 install. That
release can normalize those labels to `gpt-5.2`. Use the explicit fallback:

```bash
npx -y @steipete/oracle@0.15.2 --engine browser --model gpt-5.5-pro \
  -p "<task>" --file "src/**"
```

After upgrading to a release containing the GPT-5.6 model-selection and
unified-picker changes, verify all of the following before removing the
fallback guidance: `--help --verbose` exposes the new options, browser dry-run
resolves both aliases to GPT-5.6 Sol, API routing selects first-party OpenAI,
and a live browser run records strict GPT-5.6 selection evidence.

## Golden path

1. Pick the smallest file set that still contains the truth.
2. Preview the bundle with `--dry-run` and `--files-report`.
3. Use browser mode for GPT-5.6; use API only when explicitly intended.
4. If a run detaches or times out, reattach to the stored session instead of
   starting a duplicate.

## Commands

- Show help:
  - `npx -y @steipete/oracle --help --verbose`

- Preview without calling a model:
  - `npx -y @steipete/oracle --dry-run summary -p "<task>" --file "src/**" --file "!**/*.test.*"`
  - `npx -y @steipete/oracle --dry-run full -p "<task>" --file "src/**"`

- Inspect token usage:
  - `npx -y @steipete/oracle --dry-run summary --files-report -p "<task>" --file "src/**"`

- Browser run (main path; long-running is normal):
  - `oracle --engine browser --model gpt-5.6-sol --browser-thinking-time heavy -p "<task>" --file "src/**"`

- Fable xHigh through a specific Claude subscription (local-only):
  - Preflight without sending a paid prompt: `oracle doctor fable --caam-profile my-profile --json`
  - Run: `oracle --lane fable-local --caam-profile my-profile --caam-base "$HOME/orch-homes" -p "<task>" --file "src/**"` (replace `my-profile` with the intended CAAM profile).
  - The reviewed `--lane fable-local` route requires a verified CAAM profile and base. The compatibility `--engine claude-code --model fable` route may use the current logged-in local `claude` account only when that unreviewed account choice is intentional.
  - Fable effort is fixed at `xhigh`. If the selected CAAM profile/base cannot be verified or launched, Oracle fails closed and never falls back to another account.
  - Automatic CAAM account rotation defaults to zero. Keep `ORACLE_CLAUDE_CODE_MAX_RATE_LIMIT_ROTATIONS=0` for strict subscription pinning; a positive override is an explicit opt-out that `doctor fable` reports as degraded.

- Manual paste fallback:
  - `npx -y @steipete/oracle --render-markdown --copy-markdown -p "<task>" --file "src/**"`
  - `--render` and the hidden `--copy` flag are aliases for `--render-markdown` and `--copy-markdown`.

- Performance trace:
  - `npx -y @steipete/oracle --perf-trace --perf-trace-path /tmp/oracle-perf.json --dry-run summary -p "<task>" --file "src/**"`

## Attaching files

`--file` accepts files, directories, and globs. Pass it multiple times or use
comma-separated entries.

- Include: `--file "src/**"`, `--file src/index.ts`, `--file docs --file README.md`
- Exclude: prefix patterns with `!`, for example `--file "src/**" --file "!src/**/*.test.ts" --file "!**/*.snap"`
- Default ignored directories: `node_modules`, `dist`, `coverage`, `.git`,
  `.turbo`, `.next`, `build`, and `tmp`; explicitly passed literal files and
  directories remain eligible.
- Globs honor `.gitignore` and do not follow symlinks
  (`followSymbolicLinks: false`).
- Dotfiles require an explicit dot-segment in the pattern, such as
  `--file ".github/**"`.
- Files over 1 MB are rejected by default; configure
  `ORACLE_MAX_FILE_SIZE_BYTES` or `maxFileSizeBytes` in
  `~/.oracle/config.json` when necessary.

Keep total input under roughly 196k tokens. Use `--files-report` or
`--dry-run json` to identify oversized inputs. Never attach `.env` files,
private keys, auth tokens, or other secrets unless they have been redacted and
are essential to the question. Run `--help --verbose` when you need hidden or
advanced controls.

## Engines and browser controls

- Auto-selection uses API when `OPENAI_API_KEY` is set and browser otherwise.
- Browser supports GPT models through ChatGPT and Gemini models through Gemini
  web. Use `--engine api` for Claude, Grok, Codex (including API-only
  `gpt-5.1-codex`), or multi-model runs. Current families include GPT-5.6,
  GPT-5.5/5.4/5.2/5.1, Gemini 3.x, and Claude 4.x; availability depends on the
  engine, provider, and account.
- The reviewed Fable lane is distinct from Anthropic API mode:
  `--lane fable-local` uses the local Claude Code subscription CLI, stays
  local-only, pins the verified CAAM profile, and enforces `xhigh` effort.
- `--copy-profile <chrome-user-data-dir>`: reuse an **already signed-in**
  Chrome session without manual login. Oracle copies the active profile to a
  throwaway directory, launches it with the real Keychain so encrypted cookies
  decrypt, and always deletes the copy, including after setup failures,
  incomplete captures, or Cloudflare challenges. Copied-profile runs cannot be
  kept, reattached, or sent to an existing/remote browser. Example:
  `oracle --engine browser --copy-profile "$HOME/Library/Application Support/Google/Chrome" -p "<task>"`.
  macOS/Linux only; requires `rsync`.
- API runs require explicit user consent because they may incur usage costs.
- Browser attachments use `--browser-attachments auto|never|always`
  (`auto` pastes inline up to about 60k characters and uploads larger or raw
  files). For many files, add
  `--browser-bundle-files --browser-bundle-format auto|zip`; ZIP preserves
  original file bytes.
- Reuse an existing Chrome session with `--browser-tab <ref>`,
  `--browser-attach-running`, or `--remote-chrome <host:port>`.
- Use `--browser-model-strategy select|current|ignore` to control picker
  behavior. Explicit `current` keeps the active model without inheriting a
  configured thinking-time default; pass `--browser-thinking-time` when you
  intend to change effort.
- Use `--browser-follow-up "<prompt>"` for another turn in the same browser
  conversation, or `--followup <sessionId|responseId>` for a stored run.
- Use `--browser-research deep` only when Deep Research is explicitly wanted.
- To delegate browser automation to a signed-in remote host:
  - Host: `oracle serve --host 0.0.0.0 --port 9473 --token <secret>`
  - Client: `oracle --engine browser --remote-host <host:port> --remote-token <secret> -p "<task>" --file "src/**"`

## API preflight

Before an API run, check provider readiness without printing secrets:

```bash
oracle doctor --providers --models gpt-5.4,claude-4.6-sonnet,gemini-3-pro
oracle --preflight --models gpt-5.4,gemini-3-pro
oracle --route --model gpt-5.4
```

Use `--provider openai` or `--no-azure` when first-party OpenAI routing is
required; this prevents exported Azure environment/config values from taking
over the route:

```bash
oracle --provider openai --engine api --model gpt-5.5-pro -p "<task>"
```

For multi-model panels where partial success is useful, use
`--allow-partial --write-output <path>` so successful model files and the
`<stem>.oracle.json` manifest can be recovered:

```bash
oracle --models gpt-5.4,claude-4.6-sonnet,gemini-3-pro \
  --allow-partial --write-output /tmp/panel.md -p "<task>"
```

Set an explicit deadline for automation, for example `--timeout 10m`; Oracle
derives the HTTP timeout unless `--http-timeout` is supplied.

## Sessions and recovery

- Sessions are stored under `~/.oracle/sessions`; override with
  `ORACLE_HOME_DIR`.
- Browser artifacts include `transcript.md` and, when available, research
  reports, generated images, and downloaded ChatGPT artifacts.
- List recent sessions with `oracle status --hours 72`.
- Attach with `oracle session <id> --render`.
- Browser and GPT-5.6 Pro runs may take a long time. If a run times out,
  reattach; do not replay an indeterminate prompt. For a remote-account run,
  capture-only recovery is executable only when the worker returned a private,
  account-affine capability bound to the full submitted turn. Local
  `--live`/`--harvest` access is refused for remote sessions, and a missing or
  expired capability means inspecting the originating ChatGPT account's
  history instead. Incomplete same-run multi-turn sessions also refuse
  single-turn capture-only completion.
- To ask a follow-up in the same saved ChatGPT conversation, create a child
  session instead of mutating the old one:
  - `oracle follow-up <id> --prompt "..." --slug "<3-5 words>"`
  - Add `--wait` to observe the child; otherwise reattach with
    `oracle session <child-id> --render`.
  - Follow-up v1 is prompt-only. Start a fresh consult if new files are needed.
- MCP/browser timeouts can leave `meta.json` stale at `status:"running"` even
  when ChatGPT has completed. Use `oracle-await <id>` (or
  `oracle session <id> --render`) to render each polling cycle; rendering is
  both the status check and the permitted recovery path.
- MCP `consult` browser runs block by default for compatibility. Use
  `browserDetached:true` (or `ORACLE_MCP_BROWSER_DETACHED=1` on the MCP host)
  only when the caller wants recoverable early-return behavior.
- If a run reports `status:"error"` after saving `artifacts/transcript.md`
  (for example, Node/undici `setTypeOfService EINVAL` during wrapper cleanup),
  read the saved transcript instead of rerunning.
- Use `--slug "<3-5 words>"` for readable session IDs.
- The duplicate-prompt guard exists; use `--force` only when a genuinely new
  identical run is intended.
- Successful non-project browser one-shots are archived automatically by
  default; override with `--browser-archive never|always`.

## Prompt template

Oracle starts with zero project knowledge. Include:

- Project briefing: stack, services, build/test commands, and platform constraints
- Where things live: entrypoints, configs, key modules, and dependency boundaries
- Exact question, prior attempts, and verbatim error text
- Constraints such as API compatibility, performance budgets, and files not to change
- Desired output such as a patch plan, tests, risk list, or tradeoff comparison

For a long investigation, make the prompt restorable: put a 6–30 sentence
briefing at the top, concrete reproduction and errors in the middle, and attach
all context files required by a fresh model at the bottom. Oracle runs are
one-shot; the model does not remember prior runs.

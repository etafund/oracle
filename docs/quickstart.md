---
title: Quickstart
description: "From install to first Oracle consult in five minutes — pick a reviewed lane, send a bundle, replay the session."
---

This walks through the minimum to get a useful answer back. If you haven't installed Oracle yet, start with [Install](install.md).

## 1. Pick a reviewed route

| Route                     | When to use it                                      | What you need                                          |
| ------------------------- | --------------------------------------------------- | ------------------------------------------------------ |
| ChatGPT GPT-5.6 Sol + Pro | Long browser reasoning in your ChatGPT Pro account. | Signed-in Chrome or a configured remote browser.       |
| Fable xHigh               | Local read-only challenge through Claude Code.      | CAAM profile plus local `claude`; no remote transport. |
| Gemini 3.1 Deep Think     | Browser Deep Think review through Gemini.           | Signed-in Gemini browser session.                      |
| Render                    | Air-gapped review, paste manually.                  | Just Oracle.                                           |

Check the current policy before a long run. `doctor lanes` reports lane-template readiness; use only lanes it reports enabled.

```bash
oracle doctor lanes --json
```

## 2. Your first run

### ChatGPT GPT-5.6 Sol + Pro

First run with a manual login profile:

```bash
oracle --lane chatgpt-pro \
  --browser-manual-login \
  --browser-keep-browser --browser-input-timeout 120000 \
  -p "HI"
```

Subsequent runs reuse the saved profile:

```bash
oracle --lane chatgpt-pro \
  --browser-manual-login \
  --browser-auto-reattach-delay 5s \
  --browser-auto-reattach-interval 3s \
  --browser-auto-reattach-timeout 60s \
  -p "Audit the storage layer for race conditions" \
  --file "src/storage/**/*.ts"
```

`--browser-manual-login` skips Keychain cookie copy (no permission popups) and reuses a persistent automation profile under `~/.oracle/browser-profile`.

### Fable xHigh local lane

```bash
oracle doctor fable --caam-profile my-profile --json
oracle --lane fable-local \
  --caam-profile my-profile \
  -p "Challenge the migration plan for hidden correctness issues" \
  --file docs/plan.md
```

Fable is local-only. The reviewed lane requires `--caam-profile` (or `ORACLE_CLAUDE_CODE_CAAM_PROFILE`) and does not use the companion router (`<router-repo>`), `oracle serve`, browser flags, API keys, or multi-model fan-out.

### Gemini 3.1 Deep Think

```bash
oracle --engine browser --provider gemini --gemini-deep-think \
  -p "Audit the storage layer for race conditions" \
  --file "src/storage/**/*.ts"
```

Run `oracle doctor gemini --deep-think --json` if the browser lane cannot verify login or Deep Think controls.

### Render and copy

```bash
oracle --render --copy -p "Architecture review" --file "src/**/*.ts"
```

The bundle is on your clipboard. Paste it into ChatGPT, Claude, Gemini, AI Studio, or wherever you want the answer.
Generated text context includes stable `Lines:` ranges and `N |` prefixes for `path:line` citations. Direct browser file uploads and ZIP bundles keep the original file contents.

## 3. Preview before you spend

```bash
oracle --dry-run summary --files-report \
  -p "Audit the storage layer for race conditions" \
  --file "src/**/*.ts"
```

`--dry-run summary` lists token counts per file plus the assembled prompt size. Use it to spot a runaway directory before sending. `--dry-run full` prints the entire bundle; JSON-capable robot surfaces are listed by `oracle robot-docs --json`.

## 4. Compatibility API and multi-model paths

The old API provider matrix and multi-model fan-out still exist for compatibility. They are not the reviewed ChatGPT GPT-5.6 Sol + Pro, Fable xHigh, or Gemini 3.1 Deep Think lane surface. For those paths, run `oracle doctor --providers ...` or see [CLI reference](cli-reference.md).

Need startup proof for a slow CLI path?

```bash
oracle --perf-trace --perf-trace-path /tmp/oracle-perf.json --dry-run summary -p "Quick smoke"
```

## 5. Reattach to a long run

Long Pro browser replies can take 10 minutes to over an hour. Reattach instead of starting a duplicate run:

```bash
oracle status --hours 24
oracle session <id> --render
```

For browser runs, `--browser-auto-reattach-*` polls the existing ChatGPT tab when the page redirects mid-load. See [Sessions](sessions.md) for the full lifecycle.

## 6. Wire it into your coding agent

Drop this in `AGENTS.md` or `CLAUDE.md`:

```
- Oracle bundles a prompt plus the right files for the reviewed lanes: ChatGPT GPT-5.6 Sol + Pro, Fable xHigh, and Gemini 3.1 Deep Think. Use when stuck, debugging, or reviewing.
- Run `npx -y @steipete/oracle --help` once per session before first use.
```

Or wire MCP — see [MCP](mcp.md) and [Agents](agents.md).

## Where to go next

- [CLI Reference](cli-reference.md) — reviewed lane commands plus compatibility flags.
- [Browser Mode](browser-mode.md) — full reference for `--engine browser`.
- [Configuration](configuration.md) — defaults in `~/.oracle/config.json`.
- [Followups](followup.md) — continue an existing run with new files.

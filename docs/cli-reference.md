---
title: CLI Reference
description: "Every flag you'll actually use, grouped by what it does. Run `oracle --help --verbose` for the full hidden list."
---

This is the curated cheatsheet. The authoritative source is always `oracle --help` (and `oracle --help --verbose` for advanced flags).

## Commands

| Command                        | What it does                                                                                                                       |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `oracle [flags] -p "<prompt>"` | Run a consult.                                                                                                                     |
| `oracle status`                | List recent sessions (see [Sessions](sessions.md)).                                                                                |
| `oracle session <id>`          | Replay a stored session. Add `--json` for one `oracle_session.v1` envelope instead of the human transcript.                        |
| `oracle status <id> --json`    | Same `oracle_session.v1` envelope as `oracle session <id> --json` (read one session, machine-readable).                            |
| `oracle wait <id>`             | Block until a session is terminal; `--timeout-seconds <n>` bounds it (exit 7 = still running). `--json` emits `oracle_session.v1`. |
| `oracle cancel <id>`           | Abort an in-flight/detached run (stops the controller, releases its lease, marks it `cancelled`). Idempotent; exit 0 on terminal.  |
| `oracle restart <id>`          | Re-run with the same prompt + files. `--json` emits one `oracle_session_action.v1` launch receipt (progress moves to stderr).      |
| `oracle docs check`            | Check documented flags against CLI help metadata.                                                                                  |
| `oracle doctor lanes --json`   | Print the reviewed lane policy without launching browsers or models.                                                               |
| `oracle doctor fable --json`   | Check local Claude/CAAM profile, base, auth, ownership, and fail-closed readiness without launching a model.                       |
| `oracle serve`                 | Run the remote browser host (see [Browser Mode](browser-mode.md)).                                                                 |
| `oracle remote doctor`         | Probe the configured remote endpoint (TCP + `/health`). `--json` emits a `remote_browser_endpoint.v1` envelope.                    |
| `oracle remote status`         | Print the resolved remote endpoint config without touching the network. `--json` for machine-readable output.                      |
| `oracle remote attach`         | Probe attach readiness against a caller-supplied host. Use `--host <h:p> --token-env <ENV>` so the token never appears in argv.    |
| `oracle bridge doctor --json`  | Same `remote_browser_endpoint.v1` envelope as `oracle remote doctor`, plus bridge-specific connectivity checks.                    |
| `oracle bridge claude-config`  | Emit a `.mcp.json` for Claude Code (see [MCP](mcp.md)).                                                                            |
| `oracle tui`                   | Interactive TUI (humans only).                                                                                                     |
| `oracle-mcp`                   | Stdio MCP server entrypoint.                                                                                                       |

## Core consult flags

The reviewed agent-facing route families are below. `oracle doctor lanes --json` remains the source of truth for lane-template readiness in the current checkout; use only lanes it reports enabled.

| Lane                      | Command shape                                                                       | Notes                                                                                                                                                   |
| ------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ChatGPT GPT-5.6 Sol + Pro | `oracle --lane chatgpt-pro -p "..." --file ...`                                     | Selects exact `GPT-5.6 Sol`, separately verifies checked `Pro`, and fails before submit if either is unverified. Remote router/serve hosts are allowed. |
| Fable xHigh               | `oracle --lane fable-local [--caam-profile <name>] -p "..." --file ...`             | Uses the local Claude Code subscription CLI at fixed `xhigh` effort. Explicit CAAM selection fails closed instead of using another account.             |
| Gemini 3.1 Deep Think     | `oracle --engine browser --provider gemini --gemini-deep-think -p "..." --file ...` | Uses browser automation and API-substitution guardrails. The explicit `--lane gemini-deep-think` template may report deferred.                          |

Run `oracle doctor lanes --json`, `oracle capabilities --json`, and `oracle remote doctor --json` before remote browser smokes.

| Flag                              | Purpose                                                                                                              |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `-p, --prompt <text>`             | Required prompt.                                                                                                     |
| `-f, --file <paths...>`           | Files / dirs / globs. Repeatable. `!` prefix = exclude.                                                              |
| `-e, --engine <api\|browser>`     | Force engine. Reviewed ChatGPT/Gemini lanes use browser.                                                             |
| `-m, --model <name>`              | Single model. For reviewed lanes prefer the command shapes above.                                                    |
| `--models <list>`                 | Compatibility-only comma-separated API fan-out.                                                                      |
| `--caam-profile <name>`           | Pin `fable-local` to one CAAM shallow profile/subscription. A requested profile never falls back to direct `claude`. |
| `--caam-base <absolute-path>`     | Override the CAAM shallow-profile base used by both doctor and launch; normally `$HOME/orch-homes`.                  |
| `--slug <name>`                   | Stable session slug.                                                                                                 |
| `--render`                        | Print the assembled bundle to stdout.                                                                                |
| `--copy`                          | Copy the bundle to the clipboard.                                                                                    |
| `--write-output <path>`           | Save the final answer to a file; multi-model runs add per-model files plus `<stem>.oracle.json`.                     |
| `--files-report`                  | Print per-file token usage.                                                                                          |
| `--dry-run [summary\|json\|full]` | Preview without sending.                                                                                             |

## Fable xHigh local lane

`fable-local` is the local Claude Code review lane for Fable xHigh. It is for the local owner running their installed and logged-in `claude` command on the same machine. It is read-only review of Oracle-supplied prompt/file context, separate from Anthropic API mode.

Run the dedicated doctor before spending subscription usage:

```bash
oracle doctor fable --json
```

To use the currently logged-in local `claude` directly, omit the CAAM flags. To pin the run to one subscription profile, pass the profile explicitly; use `--caam-base` when the profile base cannot be inferred:

```bash
oracle --lane fable-local \
  --caam-profile my-profile \
  --caam-base "$HOME/orch-homes" \
  -p "Challenge this migration plan" --file docs/plan.md
```

The Fable lane always launches Claude Code with `xhigh` effort; there is no user-adjustable Fable effort flag. Explicit account selection is fail-closed: if the requested CAAM executable, profile, base, doctor check, or launch cannot be verified, Oracle errors without falling back to an unpinned `claude` account. The direct local-Claude path is used only when no CAAM profile was requested.

The lane must refuse when `ANTHROPIC_API_KEY` is present because Claude Code would prefer API-key billing in that environment. It also refuses remote browser, `oracle serve`, router/bridge, background, and multi-model fan-out flows. Cross-invocation `--followup` is supported only when it can resume the same Fable session under the exact same CAAM profile and canonical base; either mismatch (or missing legacy base metadata) is refused.

The lane captures the visible Claude Code event stream only. It does not capture hidden reasoning. Raw visible stream artifacts may include prompts, file snippets, local paths, stderr, and other sensitive visible data; they are owner-local artifacts and are not included in redacted exports by default.

Local Claude Code lane runs use a single-flight lock. By default, a second run fails before spawning `claude`; pass `--wait-for-lock <duration>` with `fable-local` to wait explicitly for the current local run to finish.

MCP `consult` already recognizes `lane:"fable-local"` and `engine:"claude-code"` for hidden-alpha schema discovery, but returns a typed `agent_lane_blocked` route-block before any backend starts. MCP execution waits for separate local-owner, launch-context, inline-event, overflow, and resource-URI work.

## Followup / lineage

| Flag                            | Purpose                                                                 |
| ------------------------------- | ----------------------------------------------------------------------- |
| `--followup <id\|slug\|resp_…>` | Continue a saved ChatGPT browser or OpenAI/Azure Responses API session. |
| `--followup-model <model>`      | Pick API lineage when the parent used `--models`.                       |

## Run control

| Flag                                       | Purpose                                                                                                                                 |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `--wait`                                   | Block on background API runs.                                                                                                           |
| `--timeout-seconds <n>`                    | On `oracle wait <id>`: give up after N seconds and exit 7 (`wait_timeout`) if the session is still running. Default: wait indefinitely. |
| `--timeout <seconds\|duration\|auto>`      | Overall API deadline. `auto` = 60m for Pro, 120s otherwise; accepts values like `10m`.                                                  |
| `--background`, `--no-background`          | Force Responses API background mode on/off.                                                                                             |
| `--http-timeout <ms\|s\|m\|h>`             | Override the HTTP client timeout; explicit `--timeout` values are reused when omitted.                                                  |
| `--allow-partial`, `--partial <mode>`      | Accept partial multi-model success when mode is `ok`; default mode is `fail`.                                                           |
| `--preflight`                              | Check redacted provider readiness for requested API model(s), then exit.                                                                |
| `--perf-trace`, `--perf-trace-path <path>` | Write CLI startup / first-output timing trace JSON.                                                                                     |
| `--heartbeat <seconds>`                    | Emit progress heartbeats; browser mode reports thinking-sidecar liveness.                                                               |

Notes:

- `--dry-run` is mutually exclusive with `--render` / `--render-markdown`; choose the preview or rendered bundle path.
- Missing root prompts exit nonzero after help so scripts fail closed. A bare single-word positional (e.g. `oracle lanes`) is refused fail-closed with exit 2 as a likely mistyped command, so it can never launch a paid run — quote a real prompt or use `-p`.
- Ctrl-C exits foreground API runs with code 130. Browser runs still keep their cleanup / reattach path.
- `--perf-trace=/tmp/oracle.json` is accepted in addition to `--perf-trace-path`; `ORACLE_PERF_TRACE=1` writes a local `.oracle-perf-…json` file.

### Exit codes

A stable contract, also advertised by `oracle capabilities --json` and echoed as `exit_code` in `oracle_session.v1`: `0` success · `1` user/generic error (includes a cancelled run) · `2` lane-route-blocked or a refused bare positional · `3` auth_required · `4` retryable_backoff · `5` timeout · `6` challenge_or_drift · `7` wait_timeout (`oracle wait` deadline; run still in flight) · `130` SIGINT. Safe to retry unattended: `4`, `5`, `7`, `130`; `3` needs a re-auth first; `1`/`2`/`6` need the caller to fix something. Full table in [Agents](agents.md#exit-code-taxonomy).

## Compatibility API endpoints

These flags remain for older API workflows. They are not the reviewed ChatGPT GPT-5.6 Sol + Pro, Fable xHigh, or Gemini 3.1 Deep Think lane surface.

| Flag                  | Purpose                                   |
| --------------------- | ----------------------------------------- |
| `--base-url <url>`    | LiteLLM / Azure / OpenRouter / proxy.     |
| `--provider <mode>`   | API route: `auto`, `openai`, or `azure`.  |
| `--no-azure`          | Ignore Azure env/config for this run.     |
| `--route`             | Print redacted API route plan, then exit. |
| `--azure-endpoint`    | Azure OpenAI endpoint.                    |
| `--azure-deployment`  | Azure deployment name.                    |
| `--azure-api-version` | Azure API version.                        |

See [OpenAI / Azure / OpenRouter](openai-endpoints.md) and [OpenRouter](openrouter.md).

## Browser mode

| Flag                                                                           | Purpose                                                      |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| `--chatgpt-url <url>`                                                          | Target a ChatGPT workspace / project folder.                 |
| `--browser-model-strategy <select\|current\|ignore>`                           | Control ChatGPT model picker.                                |
| `--browser-manual-login`                                                       | Use persistent profile + manual login (no Keychain).         |
| `--browser-attach-running`                                                     | Attach to your already-running Chrome via DevTools.          |
| `--browser-tab <ref>`                                                          | Reuse an existing tab (`current`, id, URL, title substring). |
| `--browser-thinking-time <light\|standard\|extended\|heavy>`                   | Pro / Thinking model intensity.                              |
| `--browser-research deep`                                                      | Activate Deep Research mode.                                 |
| `--browser-follow-up <prompt>`                                                 | Multi-turn in the same ChatGPT conversation.                 |
| `--browser-port <port>`                                                        | Pin Chrome DevTools port.                                    |
| `--browser-inline-cookies[(-file)] <…>`                                        | Supply cookies inline (no Keychain / Chrome).                |
| `--browser-timeout`, `--browser-input-timeout`, `--browser-attachment-timeout` | Overall / input / attachment readiness timeouts (h/m/s/ms).  |
| `--browser-recheck-delay`, `--browser-recheck-timeout`                         | Delayed retry after a timeout.                               |
| `--browser-auto-reattach-delay/-interval/-timeout`                             | Poll the existing tab when ChatGPT redirects mid-load.       |
| `--browser-reuse-wait`                                                         | Wait for shared Chrome profile before launching.             |
| `--browser-profile-lock-timeout`                                               | Wait for the manual-login profile lock.                      |
| `--browser-max-concurrent-tabs`                                                | Soft limit for shared-profile parallel runs (default 3).     |
| `--browser-keep-browser`                                                       | Keep the browser open after the run.                         |
| `--browser-headless`, `--browser-hide-window`                                  | Visibility controls.                                         |
| `--browser-attachments <auto\|never\|always>`                                  | Attach files inline vs upload.                               |
| `--browser-bundle-files`, `--browser-bundle-format <auto\|text\|zip>`          | Bundle browser uploads as text or byte-preserving ZIP.       |
| `--browser-chrome-path`, `--browser-cookie-path`                               | Override Chrome / cookie store discovery (Linux / Windows).  |

See [Browser Mode](browser-mode.md) for usage.

## Remote browser

| Flag                          | Purpose                                                                                             |
| ----------------------------- | --------------------------------------------------------------------------------------------------- |
| `--remote-host <host:port>`   | Use a remote `oracle serve` host.                                                                   |
| `--remote-token <secret>`     | Compatibility auth flag for the remote host; prefer `ORACLE_REMOTE_TOKEN` or `browser.remoteToken`. |
| `--remote-chrome <host:port>` | Attach to an existing remote Chrome session.                                                        |

## Image / media (browser)

| Flag                      | Purpose                                                              |
| ------------------------- | -------------------------------------------------------------------- |
| `--generate-image <file>` | Save generated image (Gemini browser; ChatGPT also saves artifacts). |
| `--edit-image <file>`     | Edit an image (Gemini browser).                                      |
| `--aspect <ratio>`        | Aspect ratio for image gen.                                          |
| `--youtube <url>`         | Analyze a YouTube video (Gemini browser).                            |

## Stale session detection

| Flag                     | Purpose                                      |
| ------------------------ | -------------------------------------------- |
| `--zombie-timeout <…>`   | Cutoff for "stale" sessions.                 |
| `--zombie-last-activity` | Use last log entry instead of session start. |

## Environment variables

| Var                                           | Effect                                                                                                                                                                                   |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OPENAI_API_KEY`                              | Enables OpenAI API mode.                                                                                                                                                                 |
| `AZURE_OPENAI_API_KEY` etc.                   | Enables Azure mode (paired with endpoint / deployment).                                                                                                                                  |
| `GEMINI_API_KEY`                              | Enables Gemini API mode.                                                                                                                                                                 |
| `ANTHROPIC_API_KEY`                           | Enables Claude API mode for Anthropic API models; local Claude Code mode refuses when this name is present.                                                                              |
| `OPENROUTER_API_KEY`                          | Enables OpenRouter ids.                                                                                                                                                                  |
| `ORACLE_HOME_DIR`                             | Override `~/.oracle/` root.                                                                                                                                                              |
| `ORACLE_MAX_FILE_SIZE_BYTES`                  | Per-file size cap (default 1 MB).                                                                                                                                                        |
| `ORACLE_BROWSER_COOKIES_JSON`                 | Inline ChatGPT cookies (JSON / base64).                                                                                                                                                  |
| `ORACLE_BROWSER_COOKIES_FILE`                 | Path to cookies JSON.                                                                                                                                                                    |
| `ORACLE_BROWSER_ATTACHMENT_TIMEOUT`           | Attachment upload/readiness timeout for browser mode.                                                                                                                                    |
| `ORACLE_CHATGPT_ACCOUNT_EMAIL`                | Exact saved account for the Welcome back picker.                                                                                                                                         |
| `ORACLE_RUN_PROGRESS_JSON`                    | `=1` streams `run_progress.v1` NDJSON progress events on stderr for long browser/API runs (default off).                                                                                 |
| `ORACLE_CLAUDE_CODE_STREAM_JSON_INPUT`        | `=1`/`true`/`yes`/`on` switches the `fable-local` lane to stream-json stdin (base64 image/PDF blocks; 32 MB encoded budget). Default off keeps the flat-text path.                       |
| `ORACLE_CLAUDE_CODE_CAAM_PROFILE`             | Environment alternative to `--caam-profile`; pins Fable to one CAAM shallow profile.                                                                                                     |
| `ORACLE_CLAUDE_CODE_CAAM_BASE`                | Environment alternative to `--caam-base`; must be an absolute shallow-profile base path.                                                                                                 |
| `CAAM_SHALLOW_HOMES_DIR`                      | Native CAAM fallback for the shallow-profile base when Oracle's flag/env override is absent.                                                                                             |
| `ORACLE_CAAM_EXECUTABLE`                      | Absolute executable override when `caam` is not resolved from the trusted `PATH`.                                                                                                        |
| `ORACLE_CLAUDE_CODE_MAX_RATE_LIMIT_ROTATIONS` | Legacy rotation limit for non-reviewed Claude Code integrations. `fable-local` clamps it to `0`; inherited or configured positive values cannot alter the selected subscription account. |

## See also

- `oracle --help` — short usage.
- `oracle --help --verbose` — every flag, including hidden ones.
- [Configuration](configuration.md) — `~/.oracle/config.json` and project `.oracle/config.json` defaults.

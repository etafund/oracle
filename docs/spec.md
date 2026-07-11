---
title: Spec
description: "What Oracle is, what it isn't, and the design constraints behind the CLI."
---

This page captures the design constraints. The README and the rest of the docs describe how Oracle behaves; this page describes _why_.

## Goals

1. **One CLI for reviewed expert routes.** Same session store and bundling rules whether the answer comes from ChatGPT GPT-5.6 Sol + Pro, Fable xHigh, or Gemini 3.1 Deep Think. Older API/provider routes remain compatibility paths, not the primary agent-facing surface.
2. **Runs on every box.** macOS first, Linux and Windows supported. Browser mode optional.
3. **Stable artifacts.** `--render` is contracted; session metadata stays machine-readable; stderr is for humans.
4. **Bundles, not chats.** Oracle assembles a deterministic prompt+files bundle and ships it once. Chat-style interactivity is the agent's job, not Oracle's.
5. **Storage owned by the user.** Sessions are local files under `~/.oracle/sessions/` (override with `ORACLE_HOME_DIR`). No cloud account, no telemetry.
6. **Built for agents.** Coding agents (Claude Code, Codex, Cursor) and any MCP host should be able to call Oracle without friction.

## Non-goals

- **Not a chat client.** Oracle doesn't try to replace ChatGPT's UI. Browser mode drives ChatGPT; it doesn't reimplement it.
- **Not a model.** Oracle has no opinions about reasoning quality. It bundles, ships, and stores.
- **Not a security boundary.** API keys live in your environment. Cookies live in your browser profile or in a JSON file you control.
- **Not a quota manager.** Compatibility API mode bills go to your provider account directly. Oracle reports usage, doesn't gate.

## Bundling rules

The bundle Oracle ships is deterministic given the same args and same files. That means:

- Files are read in glob expansion order, then de-duplicated.
- `.gitignore` is honored.
- Default-ignored dirs: `node_modules`, `dist`, `coverage`, `.git`, `.turbo`, `.next`, `build`, `tmp`. Pass them explicitly to override.
- Symlinks are not followed.
- Dotfiles are filtered unless the glob has a dot-segment (`--file ".github/**"`).
- File size cap defaults to 1 MB. Override with `ORACLE_MAX_FILE_SIZE_BYTES` or `maxFileSizeBytes` in config.

## Engine selection

Auto-pick rules:

1. If `--engine` is set, use it.
2. Else if `engine` is set in the effective config, use it. The effective config starts with `~/.oracle/config.json`, then layers project `.oracle/config.json` files from parent folders to the current directory.
3. Else compatibility auto-detection may use API when a supported key is set.
4. Else use browser.

Browser engine handles the reviewed ChatGPT and Gemini browser route forms. Fable xHigh uses the local Claude Code CLI through `--lane fable-local`; remote browser, bridge, serve, and router transports do not apply to Fable.

## Session lifecycle states

`status` is a closed enum. The machine-readable session surfaces (`oracle_session.v1`, `oracle_session_list.v1`) advertise exactly this finite set, and an agent can branch on it directly.

| State       | Terminal? | Meaning                                                       |
| ----------- | --------- | ------------------------------------------------------------- |
| `pending`   | no        | Created, not started yet (rare; usually a transient state).   |
| `running`   | no        | In progress.                                                  |
| `completed` | yes       | Final answer captured (agent-facing success, exit 0).         |
| `partial`   | yes       | Partial multi-model success accepted (also exit 0).           |
| `error`     | yes       | Error captured; partial output may still be in `response.md`. |
| `cancelled` | yes       | Aborted via `oracle cancel` or SIGINT (terminal, exit 1).     |

`zombie` / "stale" is **not** a stored status — it is a display-time flag `oracle status` computes when a `running` session shows no activity past `--zombie-timeout` (process likely gone). The stored `status` remains `running` until the run resolves or is cancelled.

## Compatibility commitments

- Session metadata schema is stable across minor releases. Keys may be added; existing keys won't change shape without a major bump.
- Session folder layout (`meta.json` / `prompt.md` / `response.md` / `log.jsonl` / `artifacts/`) is stable.
- Top-level commands (`status`, `session`, `wait`, `cancel`, `restart`, `serve`, `bridge`, `tui`) are stable.
- Versioned JSON contracts are stable within a major bundle version: `oracle_session.v1` (single-session read from `session`/`status`/`wait`/`cancel` with `--json`), `oracle_session_list.v1` (session listing), and `run_progress.v1` (opt-in NDJSON progress via `ORACLE_RUN_PROGRESS_JSON=1`). Keys may be added; existing keys keep their shape.
- The process exit-code dictionary (0–7, 130) is a stable contract advertised by `oracle capabilities --json`; a session's `exit_code` field echoes it. See [Agents](agents.md#exit-code-taxonomy).
- Flag names are stable; deprecated flags get compatibility warnings before removal.

## Versioning

[Semver](https://semver.org/). The CLI surface is the public API. The internal Node modules are not — don't import from `dist/` directly.

## Source of truth

- Recent changes: [CHANGELOG.md](https://github.com/steipete/oracle/blob/main/CHANGELOG.md).
- Open issues / direction: [GitHub Issues](https://github.com/steipete/oracle/issues).
- Release process: [Releasing](RELEASING.md).

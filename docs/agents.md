---
title: Coding Agents
description: "Use Oracle from Claude Code, Codex, Cursor, and any other coding agent — as a CLI, as an MCP server, or as a one-shot skill."
---

Oracle is built to be called _by_ coding agents as much as by humans. The flow is always the same: the agent gathers context, hands the bundle to a stronger Pro model, gets a second opinion back.

## The 30-second wiring

Drop this into the project's `AGENTS.md` or `CLAUDE.md`:

```
- Oracle bundles a prompt plus the right files for the reviewed lanes:
  ChatGPT GPT-5.6 Sol + Pro, Fable xHigh, and Gemini 3.1 Deep Think.
  Use when stuck, debugging hard bugs, doing architecture review, or
  cross-validating a plan.
- Run `npx -y @steipete/oracle --help` once per session before first use.
- Submit with -p and --file (never a bare positional — a single-word
  positional is refused with exit 2). Long Pro runs detach with a session id.
- Poll: `oracle wait <id> --json` blocks to a terminal state (bound with
  --timeout-seconds N; exit 7 = still running, poll again).
- Fetch: `oracle session <id> --json` -> one oracle_session.v1 envelope.
- Recover: `oracle cancel <id>` aborts a wrong/expensive run (idempotent).
```

That's enough for most agents to discover and use Oracle correctly. The patterns below cover the deeper integrations.

## Claude Code

### As an MCP server (recommended)

```bash
oracle bridge claude-config --local-browser > .mcp.json
```

That writes a `.mcp.json` configured for the local browser path, so Claude Code can call `oracle.consult` and `oracle.sessions` without any API keys. Use the MCP `consult` tool with `preset: "chatgpt-pro-heavy"` for GPT-5.6 Sol with checked Pro mode. Add `dryRun: true` to inspect the resolved bundle before sending. MCP Fable execution is still route-blocked; the Fable xHigh lane is local CLI-owner only.

See [MCP](mcp.md) for connection details and other clients.

### As a skill

Copy the bundled skill into `~/.claude/skills/`:

```bash
mkdir -p ~/.claude/skills
cp -R skills/oracle ~/.claude/skills/oracle
```

Then reference `oracle` in `CLAUDE.md`. Claude Code will load `SKILL.md` whenever the trigger conditions match (debugging, refactor, design check).

### As a slash command

Many users alias Oracle behind a custom `/consult` slash command that wraps `npx -y @steipete/oracle --lane chatgpt-pro …`. Pair with `--browser-tab current` to keep all consults in one ChatGPT conversation.

## Codex

Copy the same skill into the Codex skills folder:

```bash
mkdir -p ~/.codex/skills
cp -R skills/oracle ~/.codex/skills/oracle
```

Then reference it in `AGENTS.md`. Codex will pick it up automatically.

For Codex slash prompts, drop a wrapper in `~/.codex/prompts/oracle.md` that calls Oracle with your preferred defaults (engine, model, follow-up flags).

## Cursor

Cursor speaks MCP. Drop a `.cursor/mcp.json` like:

```json
{
  "oracle": {
    "command": "oracle-mcp",
    "args": []
  }
}
```

Or use the [one-click install](https://cursor.com/en-US/install-mcp?name=oracle&config=eyJjb21tYW5kIjoibnB4IC15IEBzdGVpcGV0ZS9vcmFjbGUgb3JhY2xlLW1jcCJ9). The `oracle` source then shows up in Cursor's MCP picker.

## Generic CLI usage from any agent

When the agent has shell access, the simplest hand-off is the bundle-on-clipboard fallback:

```bash
oracle --render --copy -p "$TASK" --file "$RELEVANT_FILES"
```

…then the agent (or a human) pastes into whichever Pro model they have access to. No keys, no MCP, works everywhere.

For autonomous dry-runs, inspect the resolved bundle before spending model time:

```bash
oracle --lane chatgpt-pro --dry-run summary --files-report -p "$TASK" --file "$RELEVANT_FILES"
```

Completed runs persist answers, usage, cost, session ids, model choices, and lineage under `~/.oracle/sessions/<id>/`. Exit code is non-zero on failure.

## Async workflow: submit, poll, fetch, recover

Reviewed Pro runs can take 5–60 minutes and detach from the foreground CLI. Instead of holding a blocking call open (or re-running and racing the first run), an agent should submit once, then poll, fetch, and recover through dedicated JSON verbs. Every step is a stable `oracle_session.v1` envelope so the loop is fully machine-parseable.

**Submit.** Always pass the prompt with `-p`/`--prompt` and context with `--file`. A bare single-word positional (`oracle lanes`) is refused fail-closed with exit 2 as a likely mistyped command, so it can never silently launch a paid run — quote a real multi-word prompt or use `-p`. Oracle prints the session id.

**Poll.** Block until the run is terminal, bounded so the agent keeps control:

```bash
oracle wait <id> --json                     # block until terminal, print oracle_session.v1
oracle wait <id> --timeout-seconds 600 --json   # give up after 10m -> exit 7 (still running)
```

`oracle wait` polls the session store with exponential backoff (no busy-spin), moves progress lines to stderr in `--json` mode, and exits with a code the agent branches on (see the taxonomy below). Exit 7 (`wait_timeout`) means the run is still in flight, not failed — poll again or wait longer.

For live progress on a long run, set `ORACLE_RUN_PROGRESS_JSON=1` before submitting: Oracle then streams `run_progress.v1` NDJSON events (state, current stage, `progress_percent`, elapsed, a `stale_hint`) on **stderr**, so a poller has a machine-readable heartbeat while the browser lane thinks. stdout stays reserved for the final envelope, and progress lines never contain reasoning text.

**Fetch.** Read a specific session's status any time, terminal or not:

```bash
oracle session <id> --json      # one oracle_session.v1 envelope
oracle status <id> --json       # identical envelope (status is an alias for reading one session)
```

The payload carries the closed `status` enum (`pending`, `running`, `completed`, `partial`, `error`, `cancelled`), a `terminal` flag, the `exit_code` a waiter would receive (`null` while in flight), `usage`, timestamps, `output_file`, `final_answer_path` (Fable), and a structured `error` when the run failed.

**Recover.** Abort a wrong or expensive run:

```bash
oracle cancel <id>              # stop the controller, release its browser lease, mark cancelled
oracle cancel <id> --json       # same, emit the resulting oracle_session.v1 envelope
```

`cancel` is idempotent: on an already-terminal session it changes nothing and exits 0. A cancelled session becomes terminal with `status:"cancelled"` and `exit_code:1`.

### Exit-code taxonomy

The process exit code and the envelope's `exit_code` always agree (both come from one resolver). This is the same dictionary `oracle capabilities --json` advertises.

| Code | Class                | Retry-safe?                                            |
| ---- | -------------------- | ------------------------------------------------------ |
| 0    | success              | done                                                   |
| 1    | user_error / generic | no — fix the input or guardrail (also a cancelled run) |
| 2    | lane_route_blocked   | no — refused lane policy or a bare positional; fix it  |
| 3    | auth_required        | after re-authenticating                                |
| 4    | retryable_backoff    | yes, after a backoff                                   |
| 5    | timeout              | yes                                                    |
| 6    | challenge_or_drift   | no — resolve the challenge / UI drift first            |
| 7    | wait_timeout         | yes — run still in flight, poll again or wait longer   |
| 130  | cancelled (SIGINT)   | yes                                                    |

Only classes 4, 5, and 7 (plus 130) are safe to retry unattended; 3 needs a re-auth first, and 1/2/6 need the caller to change something. Codes 3–6 are the classified failure taxonomy `oracle wait` returns for a terminal failure.

## Multi-agent shared profile (browser mode)

When multiple agents share one signed-in Chrome profile (the manual-login workflow), Oracle coordinates browser tab slots so parallel runs queue instead of crashing. Tune with:

- `--browser-max-concurrent-tabs` — default 3 simultaneous tabs.
- `--browser-profile-lock-timeout` — wait for the profile lock before sending.
- `--browser-reuse-wait` — wait for a shared Chrome profile before launching.

For the most reliable shared setup: run one signed-in Chrome with remote debugging, point all callers at it via `--remote-chrome <host:port>`. See [Browser Mode](browser-mode.md).

## Cost / safety hygiene

- **Always preview Pro runs.** `--dry-run summary --files-report` before a large browser or compatibility API bundle. Token counts are a close-enough proxy for spend and latency.
- **Cap file size.** `~/.oracle/config.json` → `maxFileSizeBytes`, or `ORACLE_MAX_FILE_SIZE_BYTES`. Default is 1 MB per file.
- **Excludes are your friend.** `--file "src/**" --file "!**/*.test.ts" --file "!**/*.snap"` cuts most fixtures.
- **Compatibility API mode can cost real money.** If your agent uses old API/provider paths autonomously, scope it: pin `--model`, set `--timeout`, and review the session log. Prefer the reviewed lane commands when asking agents to use Oracle.
- **Check capacity before a local Fable run.** `oracle doctor lanes --json` reports the fable-local `single_flight_lock` busy state (only one local Fable run is allowed at a time). It is a read-only peek — it never acquires or clears the lock. If the lane is busy, wait or pass `--wait-for-lock <duration>` instead of racing a second `claude` spawn.

## Patterns that work

- **Stuck → Oracle.** When the agent has been spinning on the same bug for 3+ turns, hand the failing test plus the involved files to ChatGPT GPT-5.6 Sol + Pro.
- **Plan → Oracle → execute.** Draft the plan, ask Fable xHigh locally or Gemini 3.1 Deep Think in the browser to challenge it, then implement.
- **Refactor → cross-check.** After a non-trivial refactor, send the diff plus the spec through a reviewed lane different from the one that wrote the diff. Catches drift fast.
- **Followup chain.** Use `--followup <id>` to keep one Pro session alive across iterations rather than re-bundling the whole repo every time. See [Followup](followup.md).

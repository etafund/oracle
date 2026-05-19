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

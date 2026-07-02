# Coordinator Prompt Assembly Probe

Date: 2026-07-02
Scope: no-live evidence for Spike 12.

## Commands

```bash
pnpm tsx bin/oracle-cli.ts --remote-browser off --engine api --model gpt-5.5-pro --dry-run summary --prompt 'review supplied context only' --file docs/plans/claude-code-subscription-adapter.md
```

Result:

- Exit 0.
- No live provider/browser action.
- Estimated prompt size: about 47,307 tokens.
- Attached file token usage: 47,256 tokens, 4.50% of the selected model's 1,050,000 input-token budget.

```bash
pnpm tsx bin/oracle-cli.ts --remote-browser off --engine api --model gpt-5.5-pro --render-markdown --prompt 'review supplied context only' --file docs/plans/claude-code-subscription-adapter.md
```

Result:

- Exit 0.
- Rendered the final assembled prompt bundle without a model call.
- Output included:
  - `[SYSTEM]` with Oracle's default system prompt.
  - `[USER]` with the user prompt.
  - A `### File:` section for `docs/plans/claude-code-subscription-adapter.md`.
  - Line-numbered file content covering lines 1-3851.

## Findings

- Existing Oracle file assembly can supply a large review bundle through prompt text without giving the downstream model file tools.
- The dry-run and render paths are useful preflight surfaces for `fable-local` because they avoid provider calls and expose prompt/token shape.
- The v1 `fable-local` command should send the assembled prompt over stdin to Claude Code, not argv.
- Render output demonstrates the current system prompt is API/browser-oriented. `fable-local` should likely use a lane-specific review-mode prefix/system prompt that states no tools are available and all context is supplied inline.
- Additional fixture work is still needed for excluded secrets, `.env`-like names, unreadable files, binary files, absolute/relative paths, hostile prompt injection in file content, and stdin EOF behavior.

## Recommended plan changes

- Reuse Oracle's existing file assembly and token-size logic for v1.
- Add a no-live `fable-local` prompt-bundle fixture that freezes stdin shape without spawning Claude Code.
- Keep file exclusion and size checks Oracle-owned before spawning Claude Code.
- Do not add Claude Code `Read`, `Grep`, or `Glob` tools to compensate for prompt-size limits in v1.

---
title: Overview
permalink: /
description: "Oracle bundles your prompt and files for the reviewed lanes: ChatGPT Pro Extended Reasoning, Fable xHigh, and Gemini 3.1 Deep Think."
---

## Try it

After installing (`brew install steipete/tap/oracle` or `npm i -g @steipete/oracle`), every consult is a one-liner. Run `oracle doctor lanes --json` when you need the exact enabled/deferred template state for this checkout.

```bash
# ChatGPT Pro Extended Reasoning browser lane.
oracle --engine browser --model gpt-5.5-pro --browser-thinking-time extended \
  -p "Review the storage layer for schema drift" --file "src/**/*.ts"

# Fable xHigh local lane.
oracle --lane fable-local -p "Challenge this migration plan" --file docs/plan.md

# Gemini 3.1 Deep Think browser lane.
oracle --engine browser --provider gemini --gemini-deep-think \
  -p "Look for hidden correctness issues" --file "src/**/*.ts"

# Manual fallback — assemble the bundle and copy it to your clipboard.
oracle --render --copy -p "Architecture review" --file "src/**/*.ts"

# Sessions you can replay or continue.
oracle status --hours 72
oracle session <id> --render
oracle --followup <id> -p "Re-evaluate with this new context" --file "src/**/*.ts"
```

`--render` emits the assembled markdown, sessions persist machine-readable metadata, and progress stays out of saved answers so pipes remain usable.

## What Oracle does

- **Three reviewed route families.** ChatGPT Pro Extended Reasoning and Gemini 3.1 Deep Think run through browser automation; Fable xHigh runs through the local Claude Code subscription CLI. `doctor lanes --json` is the source of truth for which explicit lane templates are enabled in the current checkout.
- **Transport rules are explicit.** Remote browser hosts and the companion router (`<router-repo>`) are for browser lanes. Fable is local-only and refuses API, browser, router, and multi-model fan-out.
- **Compatibility paths remain.** API and older provider/model flags still exist for legacy workflows, but they are not the primary agent-facing lane surface.
- **Recoverable checks.** `doctor lanes --json`, `doctor chatgpt --pro --extended-reasoning --json`, `doctor gemini --deep-think --json`, and `remote doctor --json` make readiness and routing failures machine-readable.
- **Followups + lineage.** Continue from any stored session id or `resp_…` response id; `oracle status` shows parent/child trees.
- **Sessions you can replay.** Every run is stored under `~/.oracle/sessions/<id>/`. Reattach to long browser runs without re-spending tokens.
- **Built for coding agents.** Use it from Claude Code, Codex, Cursor, or any MCP host via `oracle-mcp`. Plain stdout JSON envelopes for scripting.
- **Bundles, not chats.** Globs + excludes + size guards + `--files-report` so you know exactly what is shipped to the model.
- **Traceable startup.** `--perf-trace` records startup and first-output timing when agent handoffs need performance proof.

## Pick your path

- **Trying it.** [Install](install.md) → [Quickstart](quickstart.md). Five minutes from `brew install` to your first answer.
- **Choosing a lane.** The [CLI reference](cli-reference.md) shows the reviewed ChatGPT Pro, Fable, and Gemini Deep Think command shapes plus the compatibility flags that remain available.
- **Wiring up an agent.** [Agents](agents.md) covers Claude Code, Codex, Cursor, and the `oracle` skill. [MCP](mcp.md) plugs Oracle into any MCP-aware client.
- **Driving ChatGPT without keys.** [Browser mode](browser-mode.md) walks through manual-login profiles, attach-running, remote browsers, and Deep Research.
- **Long Pro runs.** [Sessions](sessions.md) and the [followup](followup.md) flow handle background runs, reattach, and lineage.

## Why these lanes?

The slow, high-value routes need extra verification: the browser must be signed in, the intended model must be selected, and the highest visible reasoning control must be engaged before a prompt is submitted. Oracle is the single entry point for that bundle, routing policy, session store, and recovery surface. Run `oracle doctor lanes --json` to see what is enabled locally and what is still deferred.

## Project

Active development under MIT. The [changelog](https://github.com/steipete/oracle/blob/main/CHANGELOG.md) tracks recent releases. Source on [GitHub](https://github.com/steipete/oracle). Not affiliated with OpenAI, Google, or Anthropic.

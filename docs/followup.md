---
title: Followups & Lineage
description: "Continue a saved ChatGPT browser, Fable/Claude Code, or OpenAI / Azure Responses API run."
---

`--followup` chains a new run onto an existing session. Oracle selects the continuation path from the parent: ChatGPT browser sessions reopen the exact saved conversation, Fable resumes the saved Claude Code session under the same CAAM identity, and OpenAI/Azure Responses API sessions use the stored provider response id. You can supply an additional prompt + files, and `oracle status` shows the parent/child lineage.

## Why followup instead of starting fresh

- **Cheaper.** You don't re-pay for the original input tokens.
- **Coherent.** The model remembers its earlier conclusions and can reason about _changes_.
- **Auditable.** `oracle status` shows the parent/child tree.

## Basic flow

```bash
# Initial run
oracle --model gpt-5.5-pro --slug arch-review \
  -p "Audit the auth flow end-to-end" \
  --file "src/auth/**"

# Later — continue with new files
oracle --followup arch-review \
  -p "Re-evaluate now that the rate-limiter is wired in." \
  --file "src/auth/rate-limiter.ts"
```

For API sessions, `--followup` accepts:

- A stored session id (`a1b2c3…`)
- A session slug (`arch-review`)
- An OpenAI / Azure response id (`resp_abc1234…`) — useful for chaining onto runs that didn't originate in Oracle.

For a saved ChatGPT browser session, pass its session id or slug:

```bash
oracle --followup browser-architecture-review \
  -p "Review this additional file in the same conversation." \
  --file "src/auth/rate-limiter.ts"
```

Oracle creates a child session, reopens the parent's exact ChatGPT conversation, and submits the new prompt there. It inherits the parent's browser profile, browser configuration, and model, disables Deep Research for the resumed turn, and leaves the conversation unarchived. Protected GPT-5.6 Sol + Pro resumes deliberately re-verify both model and mode before the new prompt; other compatibility resumes may skip the picker.

Browser resume is fail-closed: Oracle refuses to submit if the saved URL is not a recoverable HTTPS ChatGPT conversation, the page has no stable prior turns, or the browser lands on a different conversation.

## Imported manual ChatGPT conversations

If a conversation started outside Oracle, register its URL as an untrusted reference:

```bash
oracle import-chatgpt-url "https://chatgpt.com/c/<conversation-id>" \
  --slug "manual design review"
oracle --engine browser --remote-browser off \
  --browser-model-strategy current \
  --followup manual-design-review \
  -p "Continue with this additional constraint."
```

Import is metadata-only. Oracle records the validated conversation URL and an explicit `untrusted`, account-unbound, lane-unbound provenance marker. It records no prompt, answer, transcript, model run, harvest, model/Pro-mode evidence, router account, or reviewed lane. The stored reference uses the distinct terminal status `imported` (never `completed`), has no `completedAt` timestamp, and keeps `answerCaptured=false`.

An imported reference therefore requires the explicit local compatibility route shown above. Oracle forces `modelStrategy=current` and leaves the desired model and thinking mode unset. It refuses `--lane chatgpt-pro`, explicit model/thinking selection, remote hosts/CDP targets, `--harvest`, `--live`, and generic recovery. `--force` can atomically replace another pure imported reference with the same slug, but never deletes or overwrites an Oracle-produced session. Replacement requires descriptor-rooted filesystem operations and is unavailable on Windows; choose a new slug there. Oracle also fails closed on any other platform or filesystem where it cannot descriptor-root the pinned session directory.

For a Fable parent, select the exact same CAAM profile and base. Oracle refuses before spawning if either identity differs:

```bash
oracle --lane fable-local \
  --caam-profile my-profile --caam-base "$HOME/orch-homes" \
  --followup fable-architecture-review \
  -p "Re-evaluate with this additional file" --file src/changed.ts
```

Oracle gives each new reviewed Fable run a provider session UUID, verifies Claude's init event reports that same UUID, and stores it with the Oracle session. A followup then uses Claude's real resume path with that UUID under the parent's exact CAAM identity. Sessions created by older builds with Claude session persistence disabled are not recoverable; Oracle refuses them instead of silently starting a fresh conversation.

## Multi-model parents

When the parent used `--models a,b,c`, pick which lineage to continue from with `--followup-model`:

```bash
oracle --followup arch-review --followup-model gpt-5.5-pro \
  -p "Continue from the Pro answer" \
  --file "src/auth/rate-limiter.ts"
```

Without `--followup-model`, Oracle errors with the available lineage.

## What's chainable

| Provider                 | Followup support                                                                   |
| ------------------------ | ---------------------------------------------------------------------------------- |
| OpenAI Responses API     | ✅ via `previous_response_id`                                                      |
| Azure OpenAI (Responses) | ✅ via `previous_response_id`                                                      |
| ChatGPT browser mode     | ✅ saved sessions; see [Same-run browser multi-turn](#same-run-browser-multi-turn) |
| Fable / Claude Code      | ✅ saved sessions under the exact same CAAM profile and base                       |
| Anthropic API            | ❌ no Oracle-side response id chaining yet                                         |
| Gemini                   | ❌                                                                                 |
| OpenRouter               | ❌                                                                                 |
| Custom `--base-url`      | ❌ — unknown whether the upstream preserves the id                                 |

If you try to follow up on an unsupported provider, Oracle errors clearly instead of silently starting fresh.

## Same-run browser multi-turn

In browser mode, `--browser-follow-up` adds planned prompts to the _same ChatGPT conversation_ during one Oracle run:

```bash
oracle --lane chatgpt-pro \
  -p "Review this migration plan" --file docs/migration.md \
  --browser-follow-up "Challenge your previous recommendation" \
  --browser-follow-up "Give the final decision"
```

Each `--browser-follow-up` is sent after the previous turn completes. Not supported in Deep Research mode. If the run stops before every requested turn is captured, Oracle will not mark the whole multi-turn request complete from one reattached answer: per-turn results are not yet durably checkpointed, so inspect the originating ChatGPT account's history and do not replay the session.

## Lineage in `oracle status`

```
Status    Model         Mode    Timestamp           Chars    Cost  Slug
completed gpt-5.5-pro   api     05/06 09:00 AM      1800  $2.110  arch-review
completed gpt-5.5-pro   api     05/06 09:14 AM      2200  $2.980  ├─ arch-review-rate-limiter
running   gpt-5.5-pro   api     05/06 09:22 AM      1400       -  │  └─ arch-review-implementation
pending   gpt-5.5-pro   api     05/06 09:25 AM       900       -  └─ arch-review-risk-check
```

Children inherit the parent's slug prefix unless you pass `--slug` explicitly.

## Common patterns

- **Plan → challenge → final.** Three turns: ask Pro to plan, follow up with "find the weakest assumption," follow up again with "given the above, give the final plan."
- **Bug → repro → fix.** Turn 1 sends the failing test + error. Turn 2 sends the suspected file. Turn 3 sends the proposed fix and asks for review.
- **Architecture → implementation.** Parent run does design; children focus on individual modules. The tree in `oracle status` becomes the audit trail.

## Limitations

- Followups don't move between providers. You can't follow up an OpenAI run with a Gemini one — open a new session and re-bundle.
- Fable followup requires the parent session's exact CAAM profile and canonical base; missing or different account identity is refused before spawn.
- Fable followup depends on the owner-local Claude transcript in that CAAM shallow home. Moving/deleting it, or using an older non-persistent Oracle session, makes the parent non-resumable.
- Browser followup requires a recoverable HTTPS ChatGPT conversation URL and an authenticated browser profile. Gemini web sessions are not supported.
- `previous_response_id` retention on OpenAI / Azure varies by tier. If a followup fails with "response not found," the parent has aged out — start fresh.
- Custom `--base-url` proxies (LiteLLM, etc.) often strip the response id. Test once before relying on it.

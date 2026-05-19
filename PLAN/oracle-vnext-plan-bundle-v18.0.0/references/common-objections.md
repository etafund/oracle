# Common Objections and Refutations

> Bundle version: v18.0.0

## Objection: This is too much ceremony for planning.

The ceremony is attached only to claims that are otherwise invisible: which premium browser mode was used, whether Deep Think was enabled before prompt submission, whether source context was trusted or merely data, and whether a result is eligible for synthesis. Without these artifacts, the final plan can look polished while violating the required workflow.

## Objection: Why not just call APIs?

The user's requirement is explicit: live ChatGPT, Claude, and Gemini usage in `$vibe-planning` must not use direct APIs. ChatGPT Pro runs through Oracle browser automation; Gemini Deep Think runs through Oracle browser automation; Claude runs through Claude Code. Grok and DeepSeek are the API exceptions. The architecture preserves that boundary while allowing mocks and fixtures during parallel development.

## Objection: Why evidence and browser leases?

Browser products are stateful and mutable. A command can return text from the wrong mode, stale tab, old output, or unavailable reasoning control. The browser lease coordinator prevents contention and stale-session failures. The redacted evidence ledger proves mode verification without storing cookies, full DOM, raw screenshots, or private prompts.

## Objection: Why repeat contracts in every subset?

The three coding agents will work independently. Each spec must be executable without the other specs. Repetition is intentional. Contract changes require updating all three specs and regenerating fixtures.

## Objection: Why is intake not Oracle?

The user explicitly wants the early free-form intake conversation to happen in Codex CLI using the user's subscription. That stage is for eliciting fuzzy goals and context, not for formal first-plan generation. Oracle enters later for browser-verified ChatGPT Pro and Gemini Deep Think routes.

## Objection: Why add TOON?

TOON is included only as optional prompt-context compression. It helps when structured JSON-like planning artifacts would otherwise crowd out project context, but it is not the canonical artifact format and it is not required for live browser automation. If the optional `toon`/`tru` tool is missing, the workflow falls back to JSON.

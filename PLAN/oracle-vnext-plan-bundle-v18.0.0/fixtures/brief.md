# Planning Brief Fixture

> Bundle version: v18.0.0

## Objective

Build APR vNext, Oracle vNext, and `$vibe-planning` to support Agent Flywheel planning with ChatGPT Pro first plan, Gemini Deep Think review, Claude Code review, Grok API review, APR synthesis, and `$planning-workflow` handoff.

## Non-goals

Do not launch an implementation swarm from `$vibe-planning`. Do not use direct OpenAI, Anthropic, or Gemini APIs for live `$vibe-planning` routes.

## Constraints

Remote browser is preferred. Evidence is redacted. Robot CLI ergonomics are first-class.

## Acceptance Criteria

The balanced dry-run shows exact Oracle and APR commands and no live calls. Contract fixtures validate. Required browser routes fail closed if evidence is missing.

## Codex CLI subscription intake

Early messy intake happens in Codex CLI with the user subscription; Oracle is not used for this stage.

## Source context

Primary sources are the APR repo, Oracle repo, the Agent Flywheel planning workflow, and attached skill archives.

## Model/provider expectations

Codex CLI subscription intake uses GPT-5.5 Thinking xHigh or closest verified setting. Balanced and audit first plan and synthesis use Oracle ChatGPT Pro browser automation. Gemini uses Oracle browser Deep Think. Claude uses Claude Code. Grok uses xAI API.

## Security and secrets

Do not print API keys, browser cookies, remote browser tokens, account identifiers, raw screenshots, or unsafe debug artifacts.

## Test and evaluation expectations

Run subset validators, command dry-runs, fixture tests, contract checks, and opt-in live provider smoke tests.

## Repository and branch workflow

Use the implementing repository's normal branch/PR process. Specs must not invent branches for coding agents unless instructed by the implementation owner.

## Open questions

Resolve current provider model aliases, remote browser endpoint availability, and any repo-specific implementation file paths during implementation.

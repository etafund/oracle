# Codex CLI Intake Policy

> Bundle version: v18.0.0

The first conversational intake happens in Codex CLI with the user's subscription. It is not an Oracle browser call and not an OpenAI API call.

## Purpose

The user uses Codex CLI with GPT-5.5 Thinking xHigh, or the closest verified Codex CLI configuration, to "talk at" the system and externalize messy goals, constraints, preferences, and product taste. `$vibe-planning` then captures the transcript and normalizes it into a planning brief.

## Rules

- Oracle is never used for intake.
- Direct OpenAI API is never used for intake.
- The transcript is context, not proof of a formal first plan.
- In `fast`, a Codex CLI fast draft may be accepted as an exploratory draft, but it must still set `formal_first_plan: false` and `eligible_for_synthesis: false` until explicitly promoted or waived.
- In `balanced` and `audit`, the formal `v01` first plan must still come from ChatGPT Pro / Extended Reasoning via Oracle browser automation.
- Do not hard-code a possibly stale Codex model flag. Probe the installed Codex CLI or have the human select GPT-5.5 and xHigh/extra-high in the CLI.

## Recommended operator workflow

```bash
codex --version
codex --help
# Start a Codex session using the current documented model selector, then choose GPT-5.5 and xHigh/extra-high reasoning if available.
# Preferred starting shape when supported by the installed CLI:
codex --model gpt-5.5
```

Then save the transcript and run:

```bash
python3 scripts/capture-intake.py   --input .vibe-planning/intake/transcript.md   --brief-output .vibe-planning/brief.md   --summary-output .vibe-planning/intake/intake-summary.json   --json
```

# Review Quorum Policy

> Bundle version: v18.0.0

## Decision

Balanced planning must not collapse into a single-reviewer workflow. The formal ChatGPT Pro first plan is followed by independent comparison reviewers. Gemini Deep Think is required for balanced/audit, and balanced requires at least one additional successful independent reviewer from Claude Code Opus, xAI/Grok, or DeepSeek V4 Pro Reasoning + Search before synthesis unless an explicit waiver is recorded.

## Why this improves the system

The Agent Flywheel planning shape depends on comparing genuinely independent model plans. If only the first ChatGPT plan and Gemini review are available, APR can still produce a useful plan, but it should not silently label the result as a fully satisfied multi-model comparison. A quorum contract gives coding agents a crisp rule: continue, degrade with waiver, or stop with a robot-friendly recovery command.

## Balanced quorum

- Required first plan: `chatgpt_pro_first_plan`.
- Required independent reviewer: `gemini_deep_think`.
- Optional independent reviewers: `claude_code_opus`, `xai_grok_reasoning`, `deepseek_v4_pro_reasoning_search`.
- Minimum optional successes: `1`.
- Minimum independent reviewer total: `2`.
- Eligible statuses: `success`, `cached`.
- `manual_import` counts only with explicit human approval.

## Anti-patterns

- Treating optional provider absence as invisible.
- Running synthesis before reviewer quorum is satisfied or explicitly waived.
- Counting a degraded, unverified, or manual-import result as a successful independent reviewer without approval.

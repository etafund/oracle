# Degradation and Waiver Policy

> Bundle version: v18.0.0

The workflow may degrade optional reviewers, but degradation must be explicit and reviewable.

Non-waivable in `balanced` and `audit`:

- `chatgpt_pro_first_plan`
- `chatgpt_pro_synthesis`
- `gemini_deep_think`, unless the whole run is clearly marked exploratory/non-handoff

Waivable after quorum or explicit user approval:

- Optional reviewers such as Claude Code, xAI/Grok, or DeepSeek when at least the required quorum is satisfied.
- Search enrichment when the plan is marked as not claiming search-grounded review.

Every waiver must include: scope, provider slot, reason, expiry, user acknowledgement, and whether it affects synthesis or handoff eligibility. Waivers must be shown in the human review packet.

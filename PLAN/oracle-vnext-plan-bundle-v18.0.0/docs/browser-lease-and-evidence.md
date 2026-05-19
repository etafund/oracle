# Browser Lease Coordinator and Redacted Evidence Ledger

> Bundle version: v18.0.0

This document narrows two reliability features so implementation agents do not overbuild them.

## Browser lease coordinator

Implement a synchronous browser lease/lock coordinator, not a generalized scheduler. The coordinator exists only to prevent browser-route corruption when ChatGPT Pro and Gemini Deep Think are driven through a shared authenticated profile.

Minimum responsibilities:

1. Check local or remote browser reachability.
2. Acquire a per-provider lock on the shared profile.
3. Verify login/session state.
4. Verify the requested mode in the same session.
5. Submit the prompt only after mode verification.
6. Capture output and evidence.
7. Release the lock.
8. Return a JSON envelope with actionable recovery fields when blocked.

Do not build a daemon, queue service, distributed scheduler, or background worker unless a later implementation pass proves it is needed.

## Redacted evidence ledger

Implement a redacted verification ledger, not a screenshot or DOM archive. Evidence proves the automation observed and selected the intended UI mode before prompt submission. It does not prove hidden provider backend routing.

Default evidence is `redacted` and stores hashes, mode labels, selector manifest version, timestamps, transition-log hashes, prompt/output hashes, and failure codes. It must not store cookies, account emails, raw screenshots, raw DOM, auth headers, or raw private prompt text by default.

Critical browser slots requiring evidence:

- `chatgpt_pro_first_plan`
- `chatgpt_pro_synthesis`
- `gemini_deep_think`

# Browser Effort Selection Policy

> Bundle version: v18.0.0

## Problem fixed in v16

The previous bundle treated ChatGPT browser effort as a stable literal value named `Heavy`. That is too brittle. Official ChatGPT documentation confirms that Thinking and Pro models expose thinking-effort controls in the model picker, but browser UI labels can drift. A plan bundle should therefore require the highest available effort without assuming a permanent DOM label.

## v18 rule

For browser providers, the implementation must use a ranked selector strategy:

1. Open the provider UI in the verified same session.
2. Enumerate visible effort/mode options if the UI exposes them.
3. Select the highest option according to the provider selector manifest.
4. Record the observed label, rank, selector manifest version, and a hash of the available labels in redacted evidence.
5. Submit the prompt only after the required mode/effort is verified.

## ChatGPT Pro

Use `model_selector=Pro` and `requested_reasoning_effort=max_browser_available`. If the UI shows `Heavy`, it is a preferred observed label, not the contract. The contract is `effort_rank=highest_visible` plus same-session redacted evidence.

## Gemini Deep Think

Select Deep Think in the Gemini web UI. If a separate thinking-level control is exposed, select `high`. Record `requested_reasoning_effort=deep_think_highest_available`, the observed Deep Think label, and any observed thinking-level label.

## Why this is better

This preserves the user's intent—always use the strongest available browser reasoning mode—while avoiding stale hard-coded UI strings. It also makes UI drift diagnosable: a changed label is acceptable only if Oracle proves that it selected the highest visible ranked option before prompt submission.

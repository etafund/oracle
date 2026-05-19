# Browser Evidence Attestation Policy

> Bundle version: v18.0.0

Browser evidence is a redacted attestation that Oracle observed and selected a requested mode in the same browser session before prompt submission. It is not cryptographic proof of private provider backend routing.

Correct claim:

> Oracle verified the visible ChatGPT Pro / Gemini Deep Think UI state before prompt submission and recorded redacted evidence.

Incorrect claim:

> Oracle cryptographically proved the provider backend used a specific hidden model path.

Default evidence must be redacted. Unsafe screenshots, raw DOM, cookies, account identifiers, and raw private prompts are forbidden in normal artifacts.

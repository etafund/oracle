# v18 Clarifications Answered for Coding Agents

> Bundle version: v18.0.0

The user asked that every previously under-answered question be made explicit. Each answer is framed as: the assistant question that caused confusion, the user's follow-up, and the final implementation answer.

## 1. Oracle scope versus APR scope

**Assistant question that caused the user's question:** Should Oracle's standalone scope include both ChatGPT Pro browser automation and Gemini Deep Think browser automation, or only browser/provider primitives while APR owns route policy?

**User's question/request:** APR already relies on Oracle for browser automation; APR does routing and Oracle is general purpose. What was missing? What was being proposed?

**Answer:** Nothing is missing in the user's mental model. Keep the existing boundary. Oracle is a general-purpose provider/browser CLI. It must implement ChatGPT Pro browser automation, Gemini Deep Think browser automation, remote-browser transport, browser leases, mode verification, output capture, evidence, doctors, recovery, and stable JSON. APR must implement planning policy: which provider slots are required, optional, degraded, or synthesis-eligible; what prompt family to compile; how to compare/synthesize; and how to gate the final plan. Oracle must not know Plan IR or Agent Flywheel synthesis policy. APR must not know DOM selectors, cookies, or browser-tab details.

## 2. Product-boundary continuity

**Assistant question that caused the user's question:** Should APR include model/provider registry and route compiler, or treat Oracle as opaque provider capability?

**User's question/request:** How are scopes divided today? Can the same boundaries continue? Pros and cons?

**Answer:** Continue the same boundaries, but make interfaces stricter. Pros: less rewrite risk, Oracle remains reusable outside APR, APR does not become a browser-automation project, browser flakiness is isolated, and separate agents can build in parallel. Cons: shared contracts can drift, APR must trust Oracle's evidence envelope, and final end-to-end integration needs a fourth pass. v18 mitigates those cons with duplicated contracts, fixtures, mock commands, and stricter validators.

## 3. Independent-agent integration strategy

**Assistant question that caused the user's question:** Should integration use strict schemas, CLI contract tests, golden dry-run outputs, or all of the above?

**User's question/request:** The agents will work alone without contact; elaborate.

**Answer:** Use contract-first independent development. Each bundle carries local copies of shared schemas and fixtures. Each agent implements its own package against those files and local mocks. The agents do not negotiate interfaces with each other. After all three finish, a separate integration pass compares contract hashes, runs mock-to-live cutover tests, and resolves any mismatch. “All of the above” means JSON schemas define shapes, fixtures define examples, dry-run outputs pin command order, mocks unblock parallel work, and live smoke tests happen only near the end.

## 4. Contract change policy

**Assistant question that caused the user's question:** Should agents be allowed to change shared contracts independently?

**User request:** Contract changes must update all three specs and regenerate fixtures.

**Answer:** Yes. A local contract change is not complete until all three bundles' contract copies, fixtures, robot docs, and spec references are updated. The future repos should add a CI check that compares contract hashes across Oracle, APR, and `$vibe-planning`, or centralizes the contract package once the parallel development phase ends.

## 5. Browser-mode proof

**Assistant question that caused the user's question:** Should Oracle require proof that ChatGPT Pro / Extended Reasoning or Gemini Deep Think was selected?

**User's question/request:** What would proof look like? How does current Oracle do this?

**Answer:** Browser automation cannot cryptographically prove the provider's hidden server-side routing. The useful proof is same-session UI verification evidence: Oracle observes the provider UI mode controls/labels, selects the requested mode, verifies the requested mode before prompt submission, records timestamps/order, selector manifest version, transition-log hash, prompt hash, output hash, and redaction policy. Current Oracle already has browser mode concepts for ChatGPT launcher/attach and Gemini web runs, and upstream release notes mention Gemini web Deep Think DOM automation. v18 requires those observations to become stable redacted evidence envelopes instead of internal implementation details.

## 6. Error fields such as `next_command`, `fix_command`, and `blocked_reason`

**Assistant question that caused the user's question:** Should command outputs include `next_command`, `fix_command`, `required_env`, and `blocked_reason`?

**User's question/request:** Where did that idea come from? Is it for development-time coding agents or runtime?

**Answer:** It is for both. It comes from the attached agent CLI ergonomics skill: the first command a coding agent guesses should either work or redirect safely. At development time, these fields prevent implementation agents from guessing how to fix failed validators or doctor checks. At runtime, they let `$vibe-planning` and APR recover from blocked provider routes without parsing prose. `blocked_reason`, `next_command`, `fix_command`, and `retry_safe` are required in failure envelopes. `required_env` is recommended whenever an environment variable is missing.

## 7. Final integration ownership

**Assistant question that caused the user's question:** Should `$vibe-planning` be the final integrator, or should there be a separate fourth integration pass?

**User's question/request:** Elaborate and give pros/cons/recommendation.

**Answer:** Use a separate fourth integration pass. `$vibe-planning` is the runtime orchestrator, not the development-time merge authority. If `$vibe-planning` becomes the integrator, it may hide Oracle/APR bugs behind shims. A separate pass can compare contracts, run all three repos together, replace mocks with live commands, and resolve mismatches impartially. The downside is one extra pass. The benefit is lower risk of cross-package drift and less boundary creep.

## 8. Codex CLI intake correction

**Assistant mistake that caused the user correction:** A prior response risked implying the early GPT-5.5 Thinking xHigh intake might happen through Oracle.

**User request:** Intake must happen in Codex CLI with the user's subscription, not Oracle and not API.

**Answer:** v18 makes this a hard invariant. Intake route is `codex_cli_subscription`. `$vibe-planning` may render guidance and capture a saved transcript, but the conversation itself happens in Codex CLI under the user's subscription. It is context only. It is not a formal first plan and not synthesis-eligible. `fast` can use a Codex fast draft as exploratory output, but `balanced` and `audit` require ChatGPT Pro browser first-plan evidence before implementation handoff.

# v18 Additional Clarifications

Bundle version: v18.0.0

## Does one shared profile mean one physical Chrome profile directory?

No. It means one shared logical user-auth browser identity boundary for this workflow. Oracle may use provider-specific technical profiles internally if needed by upstream ChatGPT/Gemini browser automation, but APR and `$vibe-planning` must see a single remote browser endpoint, stable profile hash, and provider-specific locks.

## Why add route-readiness and remote-browser endpoint contracts?

They prevent dry-runs from being optimistic prose. A coding agent must be able to see whether remote browser, ChatGPT Pro evidence, Gemini Deep Think evidence, optional Claude Code, and xAI routes are ready, blocked, degraded, mocked, or falling back before spending user time or premium model quota.

## Why enforce real-looking SHA-256 values in fixtures?

Hashes are used as correlation handles for evidence, prompts, source baselines, provider results, and cache safety. Placeholder hashes create false confidence and do not exercise the implementation paths that compare and display hashes.

## Are additional JSON properties allowed?

Yes, but only as non-gating extensions. Core fields control eligibility. Unknown fields must not override forbidden API substitutions, evidence verification failures, or Codex intake's non-formal status.

## v18 DeepSeek provider addition

Bundle version: v18.0.0

Adds `deepseek_v4_pro_reasoning_search` as a default optional independent comparison-review provider. This route uses the official DeepSeek API with `deepseek-v4-pro`, thinking enabled, `reasoning_effort=max`, and APR-provided web-search tool calls. It is an API-allowed exception like xAI/Grok; it does not weaken the ban on direct API substitution for ChatGPT, Gemini, or Claude.

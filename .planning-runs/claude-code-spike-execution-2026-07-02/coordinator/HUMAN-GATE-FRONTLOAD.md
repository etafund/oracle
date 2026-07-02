# Human-Gate Frontload Memo

Date: 2026-07-02
Repo: `/data/projects/oracle`
Purpose: reduce the remaining human-in-loop work for the `SPIKE.md` execution run.

## Already front-loaded without live prompts

- Six replacement spike workers were spawned without the fast/priority tier override and registered on MCP Agent Mail as `gpt-5.5-xhigh`.
- Environment variable name scan found no variables matching:
  `ANTHROPIC*`, `CLAUDE*`, `OPENAI*`, `ORACLE*`, `GEMINI*`, `GOOGLE*`, `VERTEX*`, `BEDROCK*`, `AWS_*`, or `AZURE_*`.
- Local Claude Code executable exists at `/home/ubuntu/.local/bin/claude`.
- `claude --version` returned `2.1.198 (Claude Code)`.
- `claude --help`, `claude -p --help`, `claude auth --help`, `claude doctor --help`, and `claude mcp --help` returned without prompting.
- `claude auth status` returned without prompting. Redacted result: logged in, `authMethod: "claude.ai"`, `apiProvider: "firstParty"`, `subscriptionType: "max"`.
- Executable provenance precheck: `/home/ubuntu/.local/bin/claude` and its resolved target are owner `ubuntu:ubuntu`, mode `755`, regular files.
- CI-safe browser/provider fixture test passed:
  `pnpm run test:v18:fixtures` -> 12 files, 166 tests passed.
- Targeted selector/MCP/capabilities test passed:
  `pnpm vitest run tests/browser/selectors/chatgptManifest.test.ts tests/browser/providers/geminiDeepThink_verification.test.ts tests/mcp/schema.test.ts tests/cli/capabilities.test.ts` -> 3 files, 47 tests passed.
- Full CI-safe v18 validation passed:
  `pnpm test:v18` -> unit, fixtures, e2e:mock, privacy, conform all passed. Summary at `.oracle-v18-validation/summary.json`.
- No-live browser smoke skip check passed:
  `pnpm vitest run tests/live/chatgpt-smoke-live.test.ts tests/live/gemini-smoke-live.test.ts` -> both files skipped, no live flags set.

## Immediate architectural findings from preflight

- Installed Claude Code help confirms the key containment flags exist on this machine:
  `--output-format stream-json`, `--include-partial-messages`, `--include-hook-events`,
  `--model`, `--effort`, `--permission-mode`, `--safe-mode`, `--disable-slash-commands`,
  `--strict-mcp-config`, `--disallowedTools`, `--no-chrome`, `--no-session-persistence`,
  and `--tools ""`.
- `--bare` is not a safe subscription-auth default. Local help says bare mode skips OAuth/keychain auth and uses only `ANTHROPIC_API_KEY` or `apiKeyHelper` for Anthropic auth. Treat `--bare` as a negative spike result unless a later live probe proves a safe subscription path.
- `--safe-mode` disables customizations but does not remove built-in tools by itself; the candidate command still needs `--tools ""` plus startup verification.
- `--disallowedTools "*"` appears worth testing as a stronger fallback if `--tools ""` ever fails.
- Official support docs say `ANTHROPIC_API_KEY` makes Claude Code use API-key auth instead of the subscription plan. This supports hard parent-env refusal before even help/version probes in product code.
- Official support docs also say Pro/Max usage limits are shared with Claude Code and that API credits can be used after limits with explicit user control. Oracle should record billing/quota uncertainty rather than promise complete billing detection.

## Human-gated actions remaining

### Gate 1: Opt-in Claude Code stream probes

Human action needed: approve spending minimal local Claude Code subscription usage.

Default if unanswered: do not run live prompt probes; mark Spike 1/3/9 live fields blocked and base only on help/auth-status/no-live evidence.

Prepared normal containment probe:

```bash
printf 'reply exactly: ok\n' | claude -p \
  --model fable \
  --effort xhigh \
  --output-format stream-json \
  --verbose \
  --include-partial-messages \
  --include-hook-events \
  --permission-mode plan \
  --safe-mode \
  --disable-slash-commands \
  --strict-mcp-config \
  --disallowedTools 'mcp__*' \
  --no-chrome \
  --no-session-persistence \
  --tools ''
```

Prepared model-precedence probe:

```bash
printf 'reply exactly: ok\n' | ANTHROPIC_MODEL=some-other-model claude -p \
  --model fable \
  --effort xhigh \
  --output-format stream-json \
  --verbose \
  --include-partial-messages \
  --include-hook-events \
  --permission-mode plan \
  --safe-mode \
  --disable-slash-commands \
  --strict-mcp-config \
  --disallowedTools 'mcp__*' \
  --no-chrome \
  --no-session-persistence \
  --tools ''
```

Capture requirements:

- First `system/init` event.
- Final `result` event.
- Any startup fields for auth source, model, tools, MCP, hooks/plugins/skills/slash commands, Chrome, fallback model, permission mode, and session persistence.
- Whether `modelUsage`, `total_cost_usd`, and final text are present.
- Raw stdout/stderr bytes and normalized event offsets if a harness is available.

### Gate 2: ChatGPT Pro / Gemini Deep Think non-submitting readiness

Human action needed: if Cloudflare/login blocks automation, manually clear it in a kept browser. No prompt submission should be needed for readiness.

Default if unanswered: do not run live browser checks; record browser lanes as fake-fixture verified only and live-readiness blocked.

Constraints:

- Never click or auto-click ChatGPT `Answer now`.
- Abort before prompt submission if selector state is unknown, signed out, unavailable, or drifted.
- Record whether Pro Extended Reasoning and Gemini Deep Think can be proven without submitting a prompt.

### Gate 3: Real MCP launch-context check

Human action needed: launch `oracle-mcp` from the representative MCP client if MCP support for `fable-local` is still in v1 scope.

Default if unanswered: recommend CLI-only `fable-local` alpha until same-user local MCP launch facts are proven.

Capture requirements:

- Client launch path, HOME, PATH, transport kind, same-user/local evidence, and Claude executable path.
- Whether the MCP process sees the same safe auth status as the interactive shell.
- No prompt smoke unless Gate 1 has already passed and human explicitly opts in.

## Sponsor decisions to preserve as human asks

Default-if-unanswered values for the spike report:

- Ship sequencing: hidden/experimental `fable-local` alpha is allowed before public three-lane beta.
- Env vars: hard refusal remains refusal-only; no automatic unset.
- MCP overflow: finish run, persist complete raw artifacts, return typed non-success with `eventsComplete: false`.
- Raw purge scope: purge only Claude Code artifacts by kind, not whole Oracle sessions.
- Browser lanes: do not rely on remote browser workers for reviewed-lane v1 unless explicitly approved.
- Lock contention: fail fast by default; consider `--wait-for-lock` later.
- Expert compatibility form: accept `--engine claude-code --model fable` only as hidden expert form until lane registry UX is proven.
- Compliance wording: public wording must say local Claude Code wrapper and visible stream capture, never Claude API bypass or subscription API.

## Current official-source notes

- Claude Code CLI reference: https://code.claude.com/docs/en/cli-reference
- Claude Code settings reference: https://code.claude.com/docs/en/settings
- Claude Code hooks reference: https://code.claude.com/docs/en/hooks
- Claude Code TypeScript Agent SDK reference: https://code.claude.com/docs/en/agent-sdk/typescript
- Claude Code with Pro/Max plan support article: https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-or-max-plan
- Paid subscription versus API/Console support article: https://support.claude.com/en/articles/9876003-i-have-a-paid-claude-subscription-pro-max-team-or-enterprise-plans-why-do-i-have-to-pay-separately-to-use-the-claude-api-and-console

# System Prompt Spike

Date: 2026-07-02

Scope: one Claude Code live probe only. No product code was changed. The raw stream was not persisted; the live output was reduced in-process to verifier-relevant fields only.

## Command Shape

```sh
claude -p <exact-token user prompt> \
  --system-prompt <tiny Oracle-owned system prompt> \
  --tools '' \
  --strict-mcp-config \
  --mcp-config '<empty mcpServers object>' \
  --disable-slash-commands \
  --safe-mode \
  --no-chrome \
  --no-session-persistence \
  --permission-mode plan \
  --model fable \
  --effort xhigh \
  --output-format stream-json \
  --verbose \
  --include-partial-messages \
  --include-hook-events \
  --disallowedTools 'mcp__*'
```

The extra `--disallowedTools 'mcp__*'` flag was retained because the already-recorded live baseline command shape included it.

## Run Result

- Exit code: `0`
- Duration: `6386 ms` (about `6.4 s`)
- Expected final token: `ORACLE_SPIKE_SYSTEM_PROMPT_OK_20260702`
- Final token observed: yes, exactly
- Assistant primary model observed: `claude-fable-5`

## Startup Fields

- `tools`: `[]`
- `mcp_servers`: `[]`
- `model`: `claude-fable-5`
- `permissionMode`: `plan`
- `slash_commands`: `[]`
- `apiKeySource`: `none`
- `agents`: `["claude", "Explore", "general-purpose", "Plan"]`
- `skills`: `[]`
- `plugins`: `[]`
- `fast_mode_state`: `off`

## Result Fields

- `subtype`: `success`
- `terminal_reason`: `completed`
- `stop_reason`: `end_turn`
- `usage.input_tokens`: `2019`
- `usage.cache_creation_input_tokens`: `0`
- `usage.cache_read_input_tokens`: `0`
- `usage.output_tokens`: `33`
- `usage.server_tool_use.web_search_requests`: `0`
- `usage.server_tool_use.web_fetch_requests`: `0`
- `usage.iterations`: one message iteration with `input_tokens: 2019`, `output_tokens: 33`, `cache_creation_input_tokens: 0`, `cache_read_input_tokens: 0`
- `modelUsage` keys only: `["claude-fable-5", "claude-haiku-4-5-20251001"]`

## Baseline Comparison

Recorded default-system-prompt live baseline:

- `input_tokens 1784 + cache_creation_input_tokens 3079 = 4863` prompt-side tokens
- The recorded cache-read baseline was described as a similar total prompt footprint.

Tiny `--system-prompt` run:

- `input_tokens 2019 + cache_creation_input_tokens 0 + cache_read_input_tokens 0 = 2019` prompt-side tokens

Delta against the recorded default-system-prompt live baseline:

- `4863 - 2019 = 2844` fewer prompt-side tokens
- About `58.5%` lower prompt-side token footprint
- About `2.4x` smaller than the recorded baseline footprint

Note: the tiny-system-prompt run still carries about 2k prompt-side tokens, so `--system-prompt` does not reduce the request to only the tiny prompt. It does remove the large default-system-prompt cache creation/read footprint observed in the recorded baselines.

## Verdict

- Does `--system-prompt` preserve Fable/subscription behavior? Yes, based on the streamed verifier fields: startup model and assistant primary model stayed `claude-fable-5`, `apiKeySource` stayed `none`, the final exact token was returned, and no tools or MCP servers were exposed. `modelUsage` still included the same auxiliary Haiku key pattern noted in the baseline.
- Does it cut token overhead materially? Yes. Prompt-side tokens dropped from about `4863` to `2019`, a reduction of about `2844` tokens (`58.5%`).
- Should `fable-local` use the tiny system prompt in hidden alpha? Yes. For the CLI-only hidden alpha, using the tiny Oracle-owned system prompt is justified, with the existing no-tool/no-MCP containment and with verifier logic that accepts auxiliary non-Fable bookkeeping keys in `modelUsage` while requiring the primary assistant model to be Fable.

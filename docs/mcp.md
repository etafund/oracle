# MCP Server

`oracle-mcp` is a minimal MCP stdio server that mirrors the Oracle CLI. It shares session storage with the CLI (`~/.oracle/sessions` or `ORACLE_HOME_DIR`) so you can mix and match: run with the CLI, inspect or re-run via MCP, or vice versa.

Current agent-facing lanes are ChatGPT GPT-5.6 Sol + Pro, Fable xHigh, and Gemini 3.1 Deep Think. Remote browser hosts and the companion router (`<router-repo>`) are transport for ChatGPT/Gemini browser lanes only; Fable xHigh is local CLI-only and must not be routed through bridge, serve, remote browser, or MCP network transports.

## Let Them Fight

Claude Code can call `oracle-mcp` and ask a subscription-backed ChatGPT browser session for a second opinion. Use the `chatgpt-pro-heavy` preset when you want a compact MCP request that targets `GPT-5.6 Sol` with separately verified checked `Pro` mode. The preset is intentionally boring at the API layer: it is a shortcut for existing browser-mode fields, not a new API model id.

## Tools

### `chatgpt_image`

- Inputs: `prompt` (required), `files?: string[]` for reference images/assets, `outputPath?: string`, `aspectRatio?: string`, `model?: string`, plus browser controls such as `browserThinkingTime`, `browserModelLabel`, `browserModelStrategy`, `browserArchive`, `browserKeepBrowser`, and `dryRun`.
- Behavior: convenience wrapper for ChatGPT browser image generation. It forces `engine:"browser"`, sets `generateImage` for the existing image-aware wait/download path, and defaults `browserAttachments:"always"` when files are provided so reference images are uploaded instead of pasted.
- Output: returns the normal session metadata plus `requestedOutputPath` and `structuredContent.images[]` with saved local paths, MIME type, size, dimensions, and ChatGPT file id when available. Signed source/download URLs are not returned. If `outputPath` is omitted, Oracle picks a unique file under `ORACLE_HOME_DIR/generated/`.
- Output path safety: agent-supplied `outputPath` must resolve under `ORACLE_HOME_DIR/generated` by default; traversal and symlink escapes are rejected. This keeps MCP writes away from Oracle config, session metadata, and browser profile state. Set `ORACLE_MCP_ALLOW_EXTERNAL_OUTPUT=1` to allow writing elsewhere as an explicit operator decision. Omit `outputPath` to use the safe default.
- Local browser only: image output is unsupported when a remote browser service is configured (`ORACLE_REMOTE_HOST`); the image would be written on the remote host and not transferred back, so `chatgpt_image`/`consult` image runs fail closed with a clear error rather than returning empty `structuredContent.images`. Run on the local browser to generate images.

```json
{
  "prompt": "Create a 9:16 App Store screenshot background for a focus timer.",
  "files": ["./reference-screen.png"],
  "aspectRatio": "9:16"
}
```

### `consult`

- Inputs: `prompt` (required), `files?: string[]` (globs), `lane?: "chatgpt-pro"|"gemini-deep-think"|"fable-local"` (schema-visible lane template), `model?: string` (defaults to CLI), `engine?: "api" | "browser" | "claude-code"` (optional; `claude-code` is accepted only so hidden-alpha callers receive a typed route-block), `slug?: string`.
- Presets: `preset?: "chatgpt-pro-heavy"` applies browser mode + `gpt-5.6-sol` + the checked-Pro activation seam, unless the request overrides those fields.
- Browser-only extras: `browserAttachments?: "auto"|"never"|"always"`, `browserBundleFiles?: boolean`, `browserBundleFormat?: "auto"|"text"|"zip"`, `browserThinkingTime?: "light"|"standard"|"extended"|"heavy"`, `browserResearchMode?: "deep"`, `browserFollowUps?: string[]`, `browserArchive?: "auto"|"always"|"never"`, `browserKeepBrowser?: boolean`, `browserModelLabel?: string`, `browserModelStrategy?: "select"|"current"|"ignore"`, `generateImage?: string`, `outputPath?: string`.
- Dry runs: set `dryRun: true` to preview the resolved request without creating a session or touching the browser.
- Behavior: starts a session, runs it with the chosen engine, returns final output + metadata. Background/foreground follows the CLI (e.g., GPT‑5 Pro detaches by default). If API mode fails because `OPENAI_API_KEY` is missing and you have ChatGPT Pro, retry with `engine: "browser"` or `preset: "chatgpt-pro-heavy"` to use your signed-in ChatGPT session instead of an API key.
- Diagnostics: use `oracle doctor lanes --json` and `oracle remote doctor --json` from the same environment before running remote browser consults through MCP. JSON output must not be prefixed by the CLI intro banner.
- Logging: emits MCP logs (`info` per line, `debug` for streamed chunks with byte sizes). If browser prerequisites are missing, returns an error payload instead of running.
- Research mode: set `browserResearchMode:"deep"` for broad public-web research and cited reports. Use `preset:"chatgpt-pro-heavy"` for reviewed GPT-5.6 Sol + Pro code review, or `gpt-5.5` + `browserThinkingTime:"heavy"` when you explicitly want the compatibility Thinking Heavy path.
- Multi-turn consults: set `browserFollowUps:["Challenge your recommendation", "Give the final decision"]` to keep one ChatGPT browser conversation open and ask sequential follow-up prompts. Use one-shot calls for narrow bugs and exact file-set reviews; use multi-turn for ambiguous architecture/product decisions where a challenge pass and final recommendation are useful; use Deep Research for broad public-web work with citations. Oracle never invents follow-ups automatically.
- Archiving: set `browserArchive:"auto"|"always"|"never"` to control ChatGPT conversation cleanup. `auto` archives only successful browser one-shots after local artifacts are saved, and skips project, Deep Research, multi-turn, failed, and incomplete sessions.
- ChatGPT image generation: set `engine:"browser"` and `generateImage` to a path under `ORACLE_HOME_DIR/generated` to use the same image-aware wait/download path as CLI `--generate-image`. Saved files are returned in `structuredContent.images` and recorded as session artifacts; multiple images save as numbered siblings. Agent-supplied `generateImage` / `outputPath` are constrained to that generated-output directory by default (set `ORACLE_MCP_ALLOW_EXTERNAL_OUTPUT=1` to allow external paths).

#### Local Claude Code lane status

`lane:"fable-local"`, `engine:"claude-code"`, and Fable model aliases are schema-aware but disabled in MCP hidden alpha. `consult` returns a typed non-success route-block with `code:"agent_lane_blocked"`, `category:"route-block"`, `exitCode:2`, and `noBackendStarted:true` before creating a session, opening a browser, starting a worker, selecting an API provider, or spawning `claude`.

Local Claude Code review is reserved for the local CLI owner path until MCP has launch-context proof, same-user local transport checks, local-owner verification, complete visible-event inline semantics, overflow handling, and raw resource URIs. Do not expose it through `oracle serve`, remote browser workers, remote Chrome, router/bridge flows, or network MCP transports.

When the local CLI lane is enabled, it is read-only review of Oracle-supplied context. It captures only the visible Claude Code event stream, not hidden reasoning. Raw visible streams may include prompts, file snippets, local paths, stderr, and other sensitive visible data; they are not redacted exports by default.

#### Long browser consults from agents

Browser-backed GPT-5.6 Sol + Pro consults can legitimately run for many minutes. Some MCP clients show little progress while a tool call is active, so agents should treat a long Oracle call as a running browser job, not as a failed step. Start with `dryRun:true` when configuring a new agent, use `preset:"chatgpt-pro-heavy"`, and use the shared session store (`sessions`, `oracle status`, or `oracle session <id>`) before retrying a prompt. If the browser control plan says Oracle will launch visible Chrome, use attach/remote Chrome when the operator is actively using the computer.

#### ChatGPT images from agents

For generated images, pass an explicit `generateImage` path. That opt-in is important because it switches the browser wait loop to watch for ChatGPT image artifacts instead of only assistant text. The path must resolve under `ORACLE_HOME_DIR/generated` unless `ORACLE_MCP_ALLOW_EXTERNAL_OUTPUT=1` is set.

```json
{
  "engine": "browser",
  "model": "gpt-5.6-sol",
  "browserThinkingTime": "extended",
  "prompt": "Create a 9:16 App Store screenshot background for a focus timer.",
  "generateImage": "${ORACLE_HOME_DIR}/generated/focus-timer-bg.png"
}
```

The MCP response includes `structuredContent.images[]` with the saved file path, MIME type, size, dimensions, and ChatGPT file id when available. Signed source/download URLs remain internal.

### `follow_up`

- Inputs: `parentSessionId` (required id/slug of a stored browser session), `prompt` (required), `slug?: string` (child session slug), `wait?: boolean` (wait briefly before returning; the child stays detached), `noRecover?: boolean` (require a live matching ChatGPT tab; do not relaunch/recover Chrome).
- Behavior: continues an existing stored ChatGPT browser conversation with one more prompt in the same thread, as a detached child session. This is the cheap continuation path — it reuses the prior conversation context instead of re-bundling and re-uploading files through a fresh `consult`. Poll the child in-band with the `sessions` tool (`id`, `detail:true`); the returned text and `structuredContent` carry the child session id, parent id, status, and a log tail.
- Cost/time: each follow-up still starts a real, billed ChatGPT Pro turn that can take 5–60 minutes. There is no `dryRun`; use `consult` with `dryRun:true` to preview configuration before spending.
- Prompt-only in v1: `files` is intentionally not accepted (the strict schema rejects it as an unknown key). To attach files, start a new `consult`.

```json
{
  "parentSessionId": "gpt-review-plan",
  "prompt": "Challenge your recommendation, then give the final decision.",
  "wait": true
}
```

### `sessions`

- Inputs: `{id?, hours?, limit?, includeAll?, detail?}` mirroring `oracle status` / `oracle session`.
- Behavior: without `id`, returns a bounded list of recent sessions. With `id`/slug, returns a summary row; set `detail: true` to fetch full metadata, log, and stored request body.

### `project_sources`

- Inputs: `operation: "list"|"add"`, `chatgptUrl?: string`, `files?: string[]`, `dryRun?: boolean`, `confirmMutation?: boolean`, `browserKeepBrowser?: boolean`.
- Behavior: manages the ChatGPT Project Sources tab through local browser automation. v1 is intentionally append-only: it can list existing sources and add files, but it cannot delete, replace, or sync.
- Safety: `add` requires `confirmMutation: true` unless `dryRun: true`. This keeps agent callers from mutating a persistent ChatGPT Project by accident.
- Workflow: use this when Claude Code, Codex, or another MCP host needs a durable shared context file in a ChatGPT Project. Use `consult` when you want an actual model answer.

## Resources

- `oracle-session://{id}/{metadata|log|request}` — read-only resources that surface stored session artifacts via MCP resource reads.

## Background / detach behavior

- Same as the CLI: heavy models (e.g., GPT‑5 Pro) detach by default; reattach via `oracle session <id>` / `oracle status`. MCP does not expose extra background flags.

## Launching & usage

- Installed from npm:
  - One-off: `npx @steipete/oracle oracle-mcp`
  - Global: `oracle-mcp`
- From the repo (contributors):
  - `pnpm build`
  - `pnpm mcp` (or `oracle-mcp` in the repo root)
- mcporter example (stdio):
  ```json
  {
    "name": "oracle",
    "type": "stdio",
    "command": "npx",
    "args": ["@steipete/oracle", "oracle-mcp"]
  }
  ```
- Project-scoped Claude (.mcp.json) example:
  ```json
  {
    "mcpServers": {
      "oracle": { "type": "stdio", "command": "npx", "args": ["@steipete/oracle", "oracle-mcp"] }
    }
  }
  ```
- Bridge helper snippets:
  - Codex CLI: `oracle bridge codex-config`
  - Claude Code: `oracle bridge claude-config`
  - Claude Code with local macOS Chrome: `oracle bridge claude-config --local-browser > .mcp.json`
- Tools and resources operate on the same session store as `oracle status|session`.
- Defaults (model/engine/etc.) come from the effective Oracle CLI config; see `docs/configuration.md`, `~/.oracle/config.json`, and project `.oracle/config.json` files.

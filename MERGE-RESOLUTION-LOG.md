# Merge Resolution Log

Date: 2026-06-14
Agent: MistyLantern
Merge: in-progress `git merge upstream/main`

## Verification

- `pnpm run build`: passed.
- `pnpm test`: passed, 295 files passed, 2878 tests passed, 20 files skipped, 46 tests skipped.
- `git diff --check`: passed.
- Conflict-marker scan across the 23 originally conflicted files: clean.

## Resolution Summary By Conflicted File

### CHANGELOG.md

Merged the upstream v0.14.0 release notes with fork-specific fixes and features. Preserved the fork's remote-serve fix, ChatGPT file-artifact support, follow-up session notes, and model-picker hydration fix while keeping upstream's newer release attribution and upstream feature entries.

### bin/oracle-cli.ts

Merged upstream browser follow-up inheritance with fork detached-session behavior. The browser follow-up path now carries the parent model and browser config forward while preserving fork session-detach handling and browser dry-run behavior. The stale Gemini web guard was removed because upstream now maps `gemini-3.1-pro` through the web model resolver.

### src/browser/actions/navigation.ts

Kept the fork's fail-closed prior-turn verification and stable resumed-conversation hydration, then integrated upstream's expected-conversation URL verification. The result waits for conversation state to settle before verifying the resumed URL and still rejects resumes without trustworthy prior turns.

### src/browser/chatgptFiles.ts

Resolved the add/add conflict by combining upstream artifact discovery and download-button fallback support with the fork's hardened ChatGPT file-artifact pipeline. Preserved strict sandbox path validation, `file_...` identifier validation, trusted ChatGPT host checks, HTTPS/no-port enforcement, per-origin cookies, redirect handling without leaking cookies to external hosts, alias-aware deduplication, assistant-turn artifact discovery, failed-file tracking, and targeted download-button artifact recovery.

### src/browser/chatgptImages.ts

Merged upstream download-button artifact integration with the fork's trusted ChatGPT image URL handling. Image capture still uses the fork's hardened downloader and now cooperates with upstream assistant download-button artifact capture.

### src/browser/index.ts

Preserved the fork's late transcript artifact harvesting and mutable file-artifact collection while integrating upstream expected-conversation URL plumbing. Both local and remote resume paths pass `expectedConversationUrl`; the remote path still navigates to the resume URL when needed and does not require edits to `src/remote/server.ts`.

### src/browser/sessionRunner.ts

Kept fork ChatGPT Pro/v18 verification wrapping and lease/evidence behavior while accepting upstream result typing. The merged result type remains compatible with `BrowserRunResult` and optional `v18Emit` metadata.

### src/cli/followup.ts

Merged upstream parent model/browser-config inheritance with the fork's recoverable ChatGPT resume URL guard. Follow-up session creation now preserves the parent model and browser config, resets tab-specific and research/archive fields, and still rejects insecure or non-default-port resume URLs.

### src/cli/sessionDisplay.ts

Resolved marker-only overlap while preserving upstream/fork session display behavior. No feature behavior was intentionally changed.

### src/cli/sessionLineage.ts

Merged upstream object formatting with the fork's broader follow-up parent detection. The lineage reader now accepts fork fields such as `followUpOfSessionId` and `parentSessionId` while still handling upstream `followupSessionId` metadata.

### src/cli/sessionRunner.ts

Combined upstream session-runner updates with fork reattach guidance. Recoverable render/live/harvest failures still produce browser reattach guidance, while nonrecoverable errors and Cloudflare challenge cases avoid misleading generic reattach text.

### src/gemini-web/client.ts

Adopted upstream's `src/gemini-web/models.ts` structure for Gemini web model constants and resolver imports. Preserved fork parse/stream/image hardening by keeping the hardened parser and image/stream helpers in the client flow.

### src/gemini-web/executor.ts

Repointed Gemini web model imports to upstream `models.ts` while preserving the fork's Gemini Deep Think DOM FSM provider, `geminiDeepThinkDomProviderWithFsm`. The Gemini DOM execution path still uses the FSM-backed provider.

### src/mcp/server.ts

Registered both upstream ChatGPT image generation support and the fork follow-up tool. The MCP server exposes upstream image tooling without dropping fork follow-up session support.

### src/mcp/tools/consult.ts

Merged upstream `runConsultTool`/image-output behavior with fork detached browser consult support. The result keeps detached run/finalizer dependency injection, dry-run handling, image output validation, artifact/image structured content, and detached running guidance.

### src/mcp/types.ts

Combined upstream image generation schema fields with the fork's detached browser consult option. The consult schema now includes `generateImage`, `outputPath`, and `browserDetached`.

### src/oracle/request.ts

Integrated upstream line-numbered file-section formatting through `formatFileSections(...includeFileIndex: true)` while preserving the fork's exact base-prompt separator behavior. Transport metadata preservation remains intact.

### tests/browser/chatgptFiles.test.ts

Merged upstream artifact/download-button tests with fork security-hardening coverage. Coverage now verifies redirect cookie behavior, alias deduplication, partial fallback, label scoping, trusted ChatGPT subdomains, sandbox validation, endpoint case sensitivity, and bad ID rejection.

### tests/browser/pageActions.test.ts

Kept the fork's stable resumed-conversation hydration regression coverage and added upstream expected-conversation URL/no-prior-turn/different-conversation tests.

### tests/cli/followup.test.ts

Updated follow-up expectations for the merged behavior: inherited model/browser config from upstream plus fork resume URL validation for insecure and non-default-port URLs.

### tests/cli/sessionDisplay.coverage.test.ts

Merged coverage for fork child lineage fields and upstream follow-up metadata. The display tests now cover both field families.

### tests/cli/sessionRunner.test.ts

Adjusted runner guidance tests to reflect the merged behavior: recoverable browser failures keep reattach guidance; nonrecoverable, early-disconnect, and Cloudflare challenge cases do not emit misleading generic reattach text.

### tests/mcp/consult.test.ts

Combined upstream consult artifact/image tests with fork detached-browser consult tests. The merged test file verifies image artifacts, structured output, detached browser dependency injection, detached poll/finalize flow, and cleanup paths.

## Additional Non-Conflict Build/Test Fixes

These files were not in the original conflict list, so they are intentionally not part of the conflict-resolution staging set unless SapphireBison decides otherwise:

- `src/browser/config.ts`: removed duplicate `resumeConversationUrl` object entries introduced by the merge overlap.
- `src/browser/types.ts`: removed duplicate `resumeConversationUrl` type member.
- `src/sessionManager.ts`: removed duplicate `resumeConversationUrl` metadata member.
- `tests/oracle/transportMetadata.test.ts`: updated the expected prompt fixture for upstream's line-numbered file-section formatting.

## Safety Notes

- Did not run `git commit`, `git merge --continue`, `git merge --abort`, `git reset`, `git rebase`, `git checkout`, `git stash`, or `git push`.
- Did not touch `src/remote/server.ts`.
- Feature-critical ambiguous cases were resolved by keeping fork behavior and integrating upstream structure around it.

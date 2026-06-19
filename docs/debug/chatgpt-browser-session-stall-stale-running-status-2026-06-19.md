# ChatGPT Browser Sessions Stall And Leave Stale `running` Status

Status: issue-style diagnostic report for the Oracle coding swarm.

Source: moved and expanded from
`/data/projects/fetaos/scratch/260618E-throughput-rulings/ORACLE-DIAGNOSTICS.md`.

Captured: 2026-06-19 during the `FETAOS-THROUGHPUT-OPTIMIZATION.md` ruling
session.

## Summary

Oracle browser-mode ChatGPT runs failed in two different ways during a live
FetaOS review workflow:

1. A `gpt-5.5-pro` browser run with multiple attachments failed because
   attachments did not finish uploading before timeout.
2. A retried `gpt-5.5-pro` browser run using bundled files got past upload but
   then waited for a ChatGPT response without detecting any thinking status.
3. Session metadata was left internally inconsistent: top-level statuses and
   per-model statuses diverged, so `oracle status` continued to report sessions
   as `running` even though `oracle status --browser-tabs` saw no live ChatGPT
   tabs.
4. Separate oracle-repo browser runs later showed related browser-mode fragility:
   one failed model selection, and another also remained `running` without a
   live ChatGPT tab.

This blocked using Oracle as an adversarial-review lens. The fallback was to use
the Claude/Opus review lane only.

## Environment

- Repo: `/data/projects/oracle`
- Oracle repo HEAD at capture time: `9c553744c9ea026d6a7b05fd0f6810aae5ce5c35`
- Oracle CLI version: `0.14.0`
- Node: `v26.0.0`
- pnpm: `10.33.2`
- Session store: `/home/ubuntu/.oracle/sessions`
- Browser mode: ChatGPT browser foreground runs
- Browser config from affected sessions:
  - `chromeProfile`: `Default`
  - `attachRunning`: `false`
  - `manualLogin`: `false`
  - `modelStrategy`: `select`
  - `allowCookieErrors`: `true`
  - `archiveConversations`: `auto`

`oracle doctor chatgpt --json` reported degraded state:

- `browser_cookie_keytar`: warn; Node cannot import `keytar`.
- `recent_session`: pass.
- `cookie_sync`: unknown; no live cookie read attempted.
- `ui_mode`: unknown; no live UI probe requested.

The missing `keytar` module is not proven to be the direct cause of these
failures, but it is relevant because it can break browser cookie sync and may
explain repeated browser-mode fragility.

## Affected Sessions

### 1. `throughput-decision-queue`

- CWD: `/data/projects/fetaos`
- Model: `gpt-5.5-pro`
- Mode: `browser`
- Created: `2026-06-18T23:45:35.246Z`
- Top-level status: `error`
- Output log:
  - `Attachments did not finish uploading before timeout.`
- Evidence path:
  - `/home/ubuntu/.oracle/sessions/throughput-decision-queue/output.log`
  - `/home/ubuntu/.oracle/sessions/throughput-decision-queue/meta.json`
- Metadata inconsistency:
  - Top-level session status is `error`.
  - Inner `models[0].status` still says `running`.

Important recorded options:

```text
model: gpt-5.5-pro
slug: throughput-decision-queue
browserBundleFiles: false
browserInlineFiles: false
writeOutputPath: /data/projects/fetaos/scratch/260618E-throughput-rulings/ORACLE-RESULT.md
files:
  AGENTS.md
  /data/projects/AGENTS.md
  FETAOS-THROUGHPUT-OPTIMIZATION.md
  DEFERRED-ITEMS-REGISTER.md
  Cargo.toml
  scripts/verify.sh
```

Output log excerpt:

```text
Session: throughput-decision-queue
Mode: browser foreground
Models: 1
Detach: no
Reattach: oracle session throughput-decision-queue
Launching browser mode (gpt-5.5-pro) with ~52,500 tokens.
[browser] Acquired ChatGPT browser slot 8ea66d09 (3 max).
[browser] Released ChatGPT browser slot 8ea66d09.
ERROR: Attachments did not finish uploading before timeout.
User error (browser-automation): Attachments did not finish uploading before timeout.
```

### 2. `throughput-decision-queue-2`

- CWD: `/data/projects/fetaos`
- Model: `gpt-5.5-pro`
- Mode: `browser`
- Created: `2026-06-18T23:48:43.461Z`
- Top-level status: `running`
- Output log reached:
  - `Waiting for ChatGPT response - 2m 0s elapsed; no thinking status detected yet.`
- Evidence path:
  - `/home/ubuntu/.oracle/sessions/throughput-decision-queue-2/output.log`
  - `/home/ubuntu/.oracle/sessions/throughput-decision-queue-2/meta.json`
- Metadata inconsistency:
  - Top-level session status is `running`.
  - Inner model row is only `pending`.
  - No `completedAt`, `error`, or `errorMessage`.

Important recorded options:

```text
model: gpt-5.5-pro
slug: throughput-decision-queue-2
browserBundleFiles: true
browserBundleFormat: text
browserInlineFiles: false
writeOutputPath: /data/projects/fetaos/scratch/260618E-throughput-rulings/ORACLE-RESULT.md
files:
  AGENTS.md
  FETAOS-THROUGHPUT-OPTIMIZATION.md
  Cargo.toml
  scripts/verify.sh
```

Output log excerpt:

```text
Session: throughput-decision-queue-2
Mode: browser foreground
Models: 1
Detach: no
Reattach: oracle session throughput-decision-queue-2
Packed 4 files into 1 bundle (contents counted in token estimate).
Launching browser mode (gpt-5.5-pro) with ~27,385 tokens.
[browser] Acquired ChatGPT browser slot bcd92435 (3 max).
[browser] Waiting for ChatGPT response - 30s elapsed; no thinking status detected yet.
[browser] Waiting for ChatGPT response - 1m 0s elapsed; no thinking status detected yet.
[browser] Waiting for ChatGPT response - 1m 30s elapsed; no thinking status detected yet.
[browser] Waiting for ChatGPT response - 2m 0s elapsed; no thinking status detected yet.
```

### 3. `upstream-sync-review`

- CWD: `/data/projects/oracle`
- Model: `gpt-5.5`
- Mode: `browser`
- Created: `2026-06-19T00:17:33.901Z`
- Top-level status: `error`
- Output log:
  - `Unable to find model option matching "Thinking 5.5" in the model switcher. Available: Instant, Medium, High, Extra High, Pro Extended, GPT-5.5.`
- Evidence path:
  - `/home/ubuntu/.oracle/sessions/upstream-sync-review/output.log`
  - `/home/ubuntu/.oracle/sessions/upstream-sync-review/meta.json`
- Metadata inconsistency:
  - Top-level session status is `error`.
  - Inner model row still says `running`.

Important recorded options:

```text
model: gpt-5.5
slug: upstream-sync-review
browserBundleFiles: false
browserInlineFiles: false
browserConfig.desiredModel: Thinking 5.5
writeOutputPath: /data/projects/oracle/scratch/oracle-upstream-sync-review.md
```

Output log excerpt:

```text
Session: upstream-sync-review
Mode: browser foreground
Models: 1
Detach: no
Reattach: oracle session upstream-sync-review
Packed 30 files into 1 bundle (contents counted in token estimate).
Launching browser mode (gpt-5.5) with ~163,547 tokens.
[browser] Acquired ChatGPT browser slot e9b955b7 (3 max).
[browser] Released ChatGPT browser slot e9b955b7.
ERROR: Unable to find model option matching "Thinking 5.5" in the model switcher. Available: Instant, Medium, High, Extra High, Pro Extended, GPT-5.5.
```

### 4. `upstream-sync-review-2`

- CWD: `/data/projects/oracle`
- Model: `gpt-5.5`
- Mode: `browser`
- Created: `2026-06-19T00:21:56.023Z`
- Top-level status: `running`
- Output log stops after acquiring a ChatGPT browser slot.
- No live ChatGPT browser tabs were found by `oracle status --browser-tabs`.
- Evidence path:
  - `/home/ubuntu/.oracle/sessions/upstream-sync-review-2/output.log`
  - `/home/ubuntu/.oracle/sessions/upstream-sync-review-2/meta.json`

Important recorded options:

```text
model: gpt-5.5
slug: upstream-sync-review-2
browserBundleFiles: false
browserInlineFiles: false
browserConfig.desiredModel: GPT-5.5
writeOutputPath: /data/projects/oracle/scratch/oracle-upstream-sync-review.md
```

Output log excerpt:

```text
Session: upstream-sync-review-2
Mode: browser foreground
Models: 1
Detach: no
Reattach: oracle session upstream-sync-review-2
Packed 30 files into 1 bundle (contents counted in token estimate).
Launching browser mode (gpt-5.5) with ~163,622 tokens.
[browser] Acquired ChatGPT browser slot e2267e86 (3 max).
```

## Commands To Inspect Current State

Run these from `/data/projects/oracle` on the same host.

```bash
oracle status --hours 24 --limit 8
oracle status --browser-tabs
oracle doctor chatgpt --json
pgrep -afi 'oracle-cli.ts session throughput-decision-queue-2|oracle-cli.ts --engine browser --model gpt-5.5 --slug upstream-sync-review-2|oracle-cli.ts status upstream-sync-review-2'
ps -o pid,ppid,pgid,sid,stat,etime,tty,cmd -p 1959784,1959822,1959838,1959878,1981800,1981840,1981858,1981897,1990683,1990746,1990763
jq '{id,status,model,mode,cwd,createdAt,startedAt,completedAt,error,errorMessage,lifecycle,browser,models}' /home/ubuntu/.oracle/sessions/throughput-decision-queue/meta.json
jq '{id,status,model,mode,cwd,createdAt,startedAt,completedAt,error,errorMessage,lifecycle,browser,models}' /home/ubuntu/.oracle/sessions/throughput-decision-queue-2/meta.json
jq '{id,status,model,mode,cwd,createdAt,startedAt,completedAt,error,errorMessage,lifecycle,browser,models}' /home/ubuntu/.oracle/sessions/upstream-sync-review/meta.json
jq '{id,status,model,mode,cwd,createdAt,startedAt,completedAt,error,errorMessage,lifecycle,browser,models}' /home/ubuntu/.oracle/sessions/upstream-sync-review-2/meta.json
tail -100 /home/ubuntu/.oracle/sessions/throughput-decision-queue/output.log
tail -100 /home/ubuntu/.oracle/sessions/throughput-decision-queue-2/output.log
tail -100 /home/ubuntu/.oracle/sessions/upstream-sync-review/output.log
tail -100 /home/ubuntu/.oracle/sessions/upstream-sync-review-2/output.log
```

At capture time:

```text
oracle status --hours 24 --limit 8
  running   gpt-5.5       br/fg   upstream-sync-review-2
  error     gpt-5.5       br/fg   upstream-sync-review
  running   gpt-5.5-pro   br/fg   throughput-decision-queue-2
  error     gpt-5.5-pro   br/fg   throughput-decision-queue

oracle status --browser-tabs
  No live ChatGPT tabs found on known Chrome DevTools endpoints.
```

`pgrep` showed live Node process trees for:

```text
oracle-cli.ts session throughput-decision-queue-2 --render
oracle-cli.ts --engine browser --model gpt-5.5 --slug upstream-sync-review-2 ...
oracle-cli.ts status upstream-sync-review-2
```

`pgrep -afi 'chrome|chromium|google-chrome|playwright'` showed no actual browser
process; it matched oracle Node command text only.

## Expected Behavior

For browser-mode runs:

1. If attachment upload times out, the top-level session and the per-model row
   should both finish in an error state.
2. If a run stalls waiting for a ChatGPT response and is interrupted or loses
   browser control, metadata should not remain indefinitely `running` /
   `pending` unless there is a live browser tab or recoverable remote state.
3. If model selection fails, the top-level error should propagate to the
   per-model row.
4. `oracle status` should distinguish between a genuinely live session and an
   orphaned/stale foreground process or stale metadata.
5. Reattaching with `oracle session <slug> --render` or checking status should
   not itself wedge a new long-lived Node process if there is no live ChatGPT
   tab.

## Actual Behavior

1. Upload timeout was reported for `throughput-decision-queue`, but its
   per-model status remained `running`.
2. Bundled retry `throughput-decision-queue-2` remained top-level `running`
   with model status `pending`, despite no live ChatGPT tabs visible to
   `oracle status --browser-tabs`.
3. Model-selection failure in `upstream-sync-review` left the inner model row as
   `running`.
4. `oracle status` continued to show `running` sessions while known DevTools
   endpoints had no live ChatGPT tabs.
5. Old foreground `session --render` / `status` process trees remained alive and
   reinforced the appearance of still-running sessions.

## Reproduction Paths

### Non-invasive reproduction using existing session artifacts

This is the safest starting point for the swarm because it does not launch a new
browser run.

1. Run the inspection commands in [Commands To Inspect Current State](#commands-to-inspect-current-state).
2. Confirm the mismatch between:
   - `oracle status`
   - `oracle status --browser-tabs`
   - each affected `meta.json`
   - each affected `output.log`
3. Confirm whether `oracle session throughput-decision-queue-2 --render` or
   `oracle status upstream-sync-review-2` can hang or spawn a persistent Node
   process when no live ChatGPT tab exists.

### Live reproduction: attachment upload timeout

Use a scratch slug and output path. Do not reuse the production slugs above.

```bash
cd /data/projects/fetaos
oracle --engine browser \
  --model gpt-5.5-pro \
  --slug repro-upload-timeout-$(date +%Y%m%d%H%M%S) \
  --heartbeat 30 \
  --files-report \
  --write-output scratch/oracle-repro-upload-timeout.md \
  --prompt-file scratch/260618E-throughput-rulings/ORACLE-PROMPT.md \
  --file AGENTS.md \
  --file /data/projects/AGENTS.md \
  --file FETAOS-THROUGHPUT-OPTIMIZATION.md \
  --file DEFERRED-ITEMS-REGISTER.md \
  --file Cargo.toml \
  --file scripts/verify.sh
```

Expected if upload fails: both top-level and per-model status finalize as error,
and the ChatGPT browser slot is released.

Observed in original run: top-level `error`, but per-model `running`.

### Live reproduction: bundled response-wait stall

Use a scratch slug and output path. Do not reuse the production slugs above.

```bash
cd /data/projects/fetaos
oracle --engine browser \
  --model gpt-5.5-pro \
  --slug repro-bundled-response-stall-$(date +%Y%m%d%H%M%S) \
  --heartbeat 30 \
  --files-report \
  --browser-bundle-files \
  --write-output scratch/oracle-repro-bundled-response-stall.md \
  --prompt-file scratch/260618E-throughput-rulings/ORACLE-PROMPT.md \
  --file AGENTS.md \
  --file FETAOS-THROUGHPUT-OPTIMIZATION.md \
  --file Cargo.toml \
  --file scripts/verify.sh
```

Expected if ChatGPT never responds or thinking state is undetectable: the CLI
should time out or surface a recoverable diagnostic, with consistent session and
model state.

Observed in original run: output logged repeated `no thinking status detected`
messages, then the session remained `running` / model `pending` with no live
ChatGPT tab visible later.

### Live reproduction: model-selection failure

The original `upstream-sync-review` run used `gpt-5.5` and wanted
`browserConfig.desiredModel: Thinking 5.5`, but ChatGPT exposed:

```text
Instant, Medium, High, Extra High, Pro Extended, GPT-5.5
```

The model-selection failure itself may be expected after UI label drift. The bug
to check is that the inner model row stayed `running` after the top-level
browser-automation error.

## Hypotheses To Verify In Code

1. Browser upload timeout throws through a path that updates top-level session
   state but does not update the per-model status.
2. Response-wait / no-thinking-state stalls have no finalization path when the
   foreground process is interrupted or browser state disappears.
3. Model-selection failures update top-level session state but do not propagate
   to `models[]`.
4. `status` / `session --render` can wait on stale metadata rather than checking
   for a live browser tab, active browser slot, process liveness, or last
   heartbeat.
5. Browser slot release and session finalization are coupled inconsistently:
   slots can be released while session metadata still advertises `running`.
6. Missing `keytar` may cause cookie-sync fragility, but the failure modes above
   should still finalize cleanly even when cookies or login are broken.

## Suggested Acceptance Criteria For A Fix

- A browser automation error sets both top-level and per-model status to `error`
  with the same error category/message.
- Upload timeout, model-selection failure, and missing/undetectable ChatGPT
  response all leave session metadata internally consistent.
- `oracle status` marks old sessions as stale/orphaned, or at least indicates
  "metadata says running but no live browser tab/process/heartbeat found."
- Reattach/status commands do not create or keep long-lived waiting Node process
  trees when there is no live ChatGPT tab to follow.
- Browser slot release is recorded even when a run fails.
- Regression tests cover:
  - upload-timeout finalization;
  - model-selection finalization;
  - response-wait timeout/interruption finalization;
  - `status` rendering for stale `running` metadata;
  - `session --render` behavior for stale `running` browser sessions.

## Safe Next Actions

- Do not start duplicate browser oracle runs for the original throughput session
  while `throughput-decision-queue-2` and `upstream-sync-review-2` still report
  `running`.
- Ask before killing live Node process groups if this is being debugged on the
  shared box. The relevant process groups observed were:
  - `1959784` for `throughput-decision-queue-2 --render`
  - `1981800` for `upstream-sync-review-2`
- Rebuild or reinstall the Node `keytar` dependency for Node `v26.0.0` if
  browser cookie sync is expected to work.
- Prefer smaller prompts and `--browser-bundle-files` when testing upload
  behavior. This avoided the initial attachment-upload failure but did not fix
  the response-wait stall.
- Treat any Oracle recommendation as absent for the FetaOS Changes 3-4 ruling.
  The only usable second-pass lens for those pending rulings was Agent Mail
  message `5132`.

## Original Observation Preservation Map

- U1-U3 moved into the title and top status/source/captured paragraphs.
- U4-U8 expanded under [Affected Sessions](#affected-sessions).
- U9-U14 expanded under [Commands To Inspect Current State](#commands-to-inspect-current-state) and [Actual Behavior](#actual-behavior).
- U15-U18 moved under [Environment](#environment).
- U19-U20 expanded under [Hypotheses To Verify In Code](#hypotheses-to-verify-in-code).
- U21-U22 moved under [Safe Next Actions](#safe-next-actions).
- Drop-proposed list: none.

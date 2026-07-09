---
title: Serve Operations
description: "Operating oracle serve on a browser host: diagnosing answer truncation, deploying safely, and verifying a deploy actually went live."
---

# Serve Operations

This runbook covers running `oracle serve` (the remote browser service) on a
long-lived host: how to recognize and diagnose the **answer-truncation** class
of failures, how to deploy a new build so that "installed" always means "live,"
and how to verify a deploy end to end.

It is intentionally free of any specific host names, IP addresses, or tokens.
Substitute your own for the `<placeholders>`. Fleet-specific values belong in a
private infra repo, not here.

---

## 1. The truncation failure class

**Symptom.** A run reports success (`done.ok = true`, no error) but the answer
is a one-line teaser — a single sentence or even a bare section heading — for a
prompt that clearly asked for a substantial, multi-section reply. Downstream
consumers see something like _"oracle returned only a one-line teaser (~42
tokens)."_

**Why it happens.** ChatGPT's GPT-5.6 Sol + Pro route can think for a long time before it answers. At
the moment thinking ends and the answer begins, the page passes through a
transient state where:

- the **stop button** has already disappeared, and
- the **finished-action controls** (copy / share / thumbs) briefly flicker
  visible on the turn, while
- only the first streamed tokens of the real answer are on screen.

If the capture logic treats that instant as "done," it archives the streamed
preamble — a plausible-looking but truncated fragment — as the final answer.
Two things make this stochastic and hard to catch:

1. **Thinking pauses reset nothing.** A reasoning model can pause for minutes
   mid-answer. Any "the text has been stable for N seconds" heuristic is
   trivially satisfied by a long pause, so acceptance collapses to a one-sample
   race at the transition.
2. **The thinking indicator is a moving target.** Detection keys off label text
   and DOM structure that ChatGPT changes over time and localizes per UI
   language. A missed indicator silently disables the only guard that would keep
   the capture waiting.

**How the current build defends.** Capture acceptance now, in both the
Node-side watchdog poll loop and the in-page settle loop:

- treats an observed thinking indicator as _activity_ — it resets the idle
  clock, so a long pause can never pre-satisfy the stability window;
- requires a non-compact answer to hold acceptance across several consecutive
  samples once a run is in "thinking territory," so a single control flicker
  cannot win;
- refuses to bare-accept a short fragment once a run has been waiting past the
  compact grace window (measured from the _start_ of the wait, threaded through
  the recovery path so no code path resets it);
- re-confirms mid-thinking and sub-500-character captures through the watchdog,
  and **fails loud** ("did not reach stable completion") rather than returning a
  silent teaser when generation is still visibly active;
- uses one shared, localization-aware thinking-indicator predicate for both
  loops, plus structural streaming markers that do not depend on label text, so
  the two acceptance paths cannot drift apart.

The deliberate trade-off: correctness over latency. A short answer on a layout
that never renders completion controls (e.g. the ChatGPT project view) may take
up to ~90s to confirm before it is returned, and a run whose page never reaches
a trustworthy stable state now errors (which a caller can retry) instead of
returning a plausible-but-wrong fragment.

---

## 2. Diagnosing a suspected truncation

`oracle serve` logs answer length on every completed run. A healthy completion
line looks like:

```
[serve] Run <id> completed in 175036ms (answer 1332 chars, ~326 tokens)
```

A suspiciously short answer for a substantial prompt is the first signal:

```bash
# On the serve host — recent completions with their answer sizes.
journalctl --user -u '<serve-unit>' --since '-6 hours' --no-pager \
  | grep -E 'Accepted run|completed in'
```

Pair the accepted-run line (which logs the prompt size) with the completion
line (which logs the answer size). A 6,000-char prompt that produced a
200-char answer is worth inspecting.

> **Note.** Older builds did not log answer size. If completion lines lack the
> `(answer N chars, ...)` suffix, the running process predates this telemetry —
> which itself means the deploy never went live (see §3).

**Confirm from the session transcript.** The full answer is persisted per run
on the host:

```bash
cat ~/.oracle/sessions/<session-dir>/artifacts/transcript.md
```

The `## Answer` section is the exact text that was returned. If it is a single
sentence or a bare heading for a multi-part prompt, that is the truncation
class described in §1.

**What to rule out.** The answer text and length travel only in the terminal
`done` event to the connected client; the per-run event ledger
(`~/.oracle/run-events/*.jsonl`) has no answer-length field, and a confidently
short capture logs `done_ok:true` with no error. So a truncated run looks
completely healthy in the ledger — the completion-line answer size and the
transcript are your only host-side evidence. Also check that the run was not a
genuine short answer (some prompts legitimately get one line) and that no
account challenge / rate-limit interstitial was in play.

---

## 3. Deploying a new build — install is not live

**The trap.** `npm install` changes files on disk. The running `node` process
loaded its module graph once, at start, and keeps executing the _old_ build
until it is restarted. So:

> Installing a tarball without restarting the service is a silent no-op deploy.
> The host will report the new version on disk while serving the old code.

A deploy is only real when the process has restarted **and** you have verified
the live commit.

### The safe sequence

1. **Build a clean tarball** from a committed tree (so build provenance is not
   `dirty`):

   ```bash
   pnpm build && npm pack
   # dist/build-provenance.json records the exact commit the tarball carries.
   ```

2. **Wait for the target lane to be idle.** Never restart a lane with a run in
   flight. A run is in flight when the newest `Accepted run <id>` has no
   matching `Run <id> completed`/`failed`:

   ```bash
   L=$(journalctl --user -u '<serve-unit>' --since '-6 hours' --no-pager \
        | grep -oP 'Accepted run \K[a-f0-9-]+' | tail -1)
   journalctl --user -u '<serve-unit>' --since '-6 hours' --no-pager \
     | grep -qE "Run $L (completed|failed)" && echo IDLE || echo BUSY
   ```

3. **Install** (the non-login SSH shell usually lacks node on PATH — prepend the
   real node bin):

   ```bash
   ssh <host> 'export PATH="$HOME/opt/node/bin:$PATH"; \
     npm install --global --prefix "$HOME/.local" /tmp/<tarball>.tgz'
   ```

4. **Restart and confirm active:**

   ```bash
   ssh <host> 'systemctl --user restart <serve-unit> && \
     sleep 3 && systemctl --user is-active <serve-unit>'
   ```

5. **Verify it actually went live** via the authenticated `/health` endpoint —
   this is the anti-no-op gate:

   ```bash
   ssh <host> 'curl -s -H "Authorization: Bearer $(cat <token-file>)" \
     http://127.0.0.1:<lane-port>/health'
   ```

   Assert two things in the response:
   - `build.commit` (or `commit_short`) matches the commit your tarball carried;
   - `uptimeSeconds` is small (tens of seconds) — proving the process really
     restarted rather than being the stale one still running.

`scripts/fleet-deploy.sh` automates exactly this sequence (idle guard → install
→ restart → `/health` commit+uptime assertion) so a silent no-op deploy is not
possible. Run it with `--help` for flags; use `--dry-run` first.

---

## 4. Verifying with the live smoke harness

`pnpm smoke:remote-browser` drives a real end-to-end run against a serve host
and fails unless the answer echoes a generated marker, meets a minimum length,
and includes the expected number of operational-implication labels — i.e. it
would fail on a truncated teaser. Run it after every deploy:

```bash
export SMOKE_TOKEN="$(ssh <host> 'cat <token-file>')"
pnpm smoke:remote-browser --lane chatgpt-pro \
  --remote-host <host-ip>:<lane-port> --token-env SMOKE_TOKEN
```

A pass looks like:

```
PASS chatgpt-pro 1299 chars 5 operational implications session=... elapsed_ms=176190
```

The `chars` count and implication count are your proof the full answer came
through, not a fragment.

---

## 5. Known trade-offs and open items

- **Short answers on completion-control-less layouts** (project view / markdown
  fallback) can wait up to ~90s before returning, because the watchdog cannot
  confirm them via finished-action controls. This is bounded and correctness-safe.
- **The thinking-indicator predicate scans the whole document** rather than
  scoping to the assistant turn. This is deliberate — the indicator can render
  outside the turn subtree, and scoping risks re-introducing detection misses —
  at a small per-poll cost on very large conversations.
- **Wedge watchdog.** If your deployment runs a watchdog that restarts a serve
  worker after a run wedges (accepted but never completes within a timeout),
  track how often it fires. Frequent firings (every day or two) point at a
  separate in-memory busy-flag reliability issue worth investigating on its own,
  independent of truncation.

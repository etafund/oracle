# PLAN — Sync etafund/oracle:main with upstream steipete/oracle:main

**Date:** 2026-06-08
**Goal:** Incorporate the 4 upstream commits our fork was behind, without
breaking existing functionality, then push to `etafund:main` so GitHub no
longer reports "4 commits behind `steipete/oracle:main`".

## Situation assessment

- Fork divergence at start: **4 behind, 251 ahead** of `upstream/main`.
- Merge base: `6f0b970e`.
- The 4 upstream commits to incorporate:
  | SHA | Commit |
  |-----|--------|
  | `6019a199` | feat(session): recover `--harvest`/`--live` from saved URL |
  | `4490e00b` | build(deps): bump dependencies group (10 updates) (#230) |
  | `dd4cb444` | build(deps): bump dependencies group (11 updates) (#246) |
  | `a3d3b094` | chore: update dependencies |

## Approach decision

This is a single `git merge`, **not** a decomposable swarm task:

- A merge is an inherently single-coordinator operation — parallel agents
  editing the same conflict markers (`pnpm-lock.yaml`, `CHANGELOG.md`) would
  corrupt each other rather than parallelize.
- Only a **real merge commit** makes `upstream/main` an ancestor, which is what
  makes GitHub stop reporting "behind". Cherry-picking would rewrite SHAs and
  leave the "behind" banner in place.

Conflict-risk pre-check showed the feature's core files
(`reattachability.ts`, `browserTabs.ts`, `sessionCommand.ts`) were **unchanged**
in our fork, and `recoverConversation.ts` is a new file — so the only real
conflict surfaces were `CHANGELOG.md` (both sides added 0.13.1 entries) and the
lockfile/manifest.

## Execution

1. `git merge upstream/main` — auto-merged everything except `CHANGELOG.md`.
2. Resolved `CHANGELOG.md` by keeping **both** entries under 0.13.1: upstream's
   "Added" harvest/live recovery note and our fork's "Changed" askoracle.sh
   homepage note. Fork's `homepage: https://askoracle.sh` preserved in
   `package.json`.
3. `package.json` + `pnpm-lock.yaml` auto-merged; validated consistency with
   `pnpm install --frozen-lockfile` (passed, and ran the `tsgo` build clean).
4. Quality gates (the same proof the feature commit used):
   - `pnpm run check` (oxfmt --check + tsgo typecheck + oxlint) — **pass**
   - `pnpm docs:check` — **pass** (87 flags, 6 files)
   - `pnpm test` — 2678 passed, only **2 pre-existing** `parseDuration`
     failures (see below), 43 skipped.
5. Merge committed: `3aa63ff6`. `git rev-list --count main..upstream/main` → **0**.

## Pre-existing bug fixed separately

`src/duration.ts` `parseDuration()` gated full-consumption on `total > 0`,
wrongly returning the fallback for valid all-zero durations (`"0m0s"`,
`"0s0ms"`). Confirmed identical on pre-merge HEAD `df41072d` and untouched by
the merge (pure-regex function, no npm deps → unaffected by the dep bumps).
Fixed by gating on `cursor > 0` instead. Commit `60805fac`. Test suite now fully
green.

## Completion criteria

- [x] All 4 upstream commits are ancestors of `main` (behind count = 0)
- [x] Fork customizations preserved (askoracle.sh homepage, 251 ahead commits)
- [x] Build + lint + typecheck + docs + tests green
- [ ] Pushed to `origin/main` (etafund)
- [ ] GitHub no longer shows "behind"

/**
 * Owned-target CLOSE must happen BEFORE tab-lease RELEASE in every
 * run-cleanup sequence (REQUIRED; flipped from the Wave-0 red harness after
 * the remote-path ordering fix landed).
 *
 * Property (correctness / fault isolation): a tab lease advertises "this run
 * still owns a tab in the shared Chrome". Releasing the lease while the owned
 * target (tab) is still open creates a window in which:
 *   - a zero-lease reaper / termination gate may conclude the shared Chrome
 *     is idle and kill it while our tab is mid-close, and
 *   - concurrent runs may count a free slot that is still physically occupied.
 * Therefore in each cleanup path the owned target must be closed first and the
 * lease released only afterwards (close-before-release).
 *
 * These are ordering properties over the cleanup sequences in
 * src/browser/index.ts and src/browser/projectSourcesRunner.ts, checked
 * structurally against the source because the sequences live inside `finally`
 * blocks of functions that require a live Chrome/CDP endpoint to execute.
 * Each check first proves its anchors still exist (green guard) so a refactor
 * cannot silently turn the red case into a vacuous pass.
 *
 * The remote-path fix landed and the red case below is now a required `test`;
 * its `[red]` prefix is kept so it stays traceable to the recorded red run.
 *
 * Red run recorded 2026-07-03 against HEAD 3e38abb7
 * (`ORACLE_RED_ASSERT=1 pnpm vitest run tests/browser/closeBeforeReleaseOrdering.test.ts`):
 *   - "[red] remote cleanup must close the owned target BEFORE releasing the
 *     tab lease" FAILED: in runRemoteBrowserMode()'s finally block the lease
 *     release (`handle.release()`) precedes closeRemoteChromeTarget().
 *   - Local-path and project-sources-path orderings passed (close precedes
 *     release there today) and act as green regression guards.
 */
import { describe, expect, test } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";

const SRC_ROOT = fileURLToPath(new URL("../../src", import.meta.url));

// Anchors are compared on whitespace-normalized source so formatting-only
// changes cannot skew the ordering measurement.
const RELEASE_ANCHOR = "tabLease=null;awaithandle.release().catch(()=>undefined);";
const REMOTE_CLOSE_ANCHOR =
  "awaitcloseRemoteChromeTarget(host,port,remoteTargetId??undefined,logger);";
const LOCAL_CLOSE_ANCHOR =
  "awaitcloseTab(chrome.port,isolatedTargetId,logger,chromeHost).catch(()=>undefined);";

async function readSource(relative: string): Promise<string> {
  return readFile(path.join(SRC_ROOT, relative), "utf8");
}

function normalize(source: string): string {
  return source.replace(/\s+/gu, "");
}

function sliceBetween(source: string, startAnchor: string, endAnchor: string): string {
  const start = source.indexOf(startAnchor);
  expect(start, `missing start anchor: ${startAnchor}`).toBeGreaterThanOrEqual(0);
  const end = source.indexOf(endAnchor, start + startAnchor.length);
  expect(end, `missing end anchor: ${endAnchor}`).toBeGreaterThan(start);
  return source.slice(start, end);
}

async function remoteCleanupSlice(): Promise<string> {
  const source = await readSource("browser/index.ts");
  return normalize(
    sliceBetween(source, "async function runRemoteBrowserMode", "export { estimateTokenCount }"),
  );
}

async function localCleanupSlice(): Promise<string> {
  const source = await readSource("browser/index.ts");
  return normalize(
    sliceBetween(
      source,
      "export async function runBrowserMode",
      "async function pickAvailableDebugPort",
    ),
  );
}

describe("close-before-release ordering (red harness)", () => {
  test("guard: cleanup sequences and their close/release anchors still exist", async () => {
    // If any anchor disappears in a refactor this guard goes red visibly,
    // preventing the expected-failure cases below from rotting into no-ops.
    const remote = await remoteCleanupSlice();
    expect(remote).toContain(RELEASE_ANCHOR);
    expect(remote).toContain(REMOTE_CLOSE_ANCHOR);

    const local = await localCleanupSlice();
    expect(local).toContain(RELEASE_ANCHOR);
    expect(local).toContain(LOCAL_CLOSE_ANCHOR);

    const projectSources = normalize(await readSource("browser/projectSourcesRunner.ts"));
    expect(projectSources).toContain(RELEASE_ANCHOR);
    expect(projectSources).toContain(LOCAL_CLOSE_ANCHOR);
  });

  // NOTE on lastIndexOf: runBrowserMode() also releases the lease on its
  // launch-FAILURE error path (no owned target exists yet, so no ordering
  // constraint applies there). The run-cleanup release is the LAST release in
  // each sequence, which is the one the close-before-release property governs.
  test("[red] remote cleanup must close the owned target BEFORE releasing the tab lease", async () => {
    const remote = await remoteCleanupSlice();
    const closeIndex = remote.indexOf(REMOTE_CLOSE_ANCHOR);
    const releaseIndex = remote.lastIndexOf(RELEASE_ANCHOR);
    expect(closeIndex).toBeGreaterThanOrEqual(0);
    expect(releaseIndex).toBeGreaterThanOrEqual(0);
    // Property: close-before-release. Pre-fix, runRemoteBrowserMode()
    // released the lease first, opening the race described in the header.
    expect(closeIndex).toBeLessThan(releaseIndex);
  });

  test("guard: local cleanup already closes the owned target before releasing", async () => {
    const local = await localCleanupSlice();
    const closeIndex = local.indexOf(LOCAL_CLOSE_ANCHOR);
    const releaseIndex = local.lastIndexOf(RELEASE_ANCHOR);
    expect(closeIndex).toBeGreaterThanOrEqual(0);
    expect(releaseIndex).toBeGreaterThanOrEqual(0);
    expect(closeIndex).toBeLessThan(releaseIndex);
  });

  test("guard: project-sources cleanup already closes the owned target before releasing", async () => {
    const projectSources = normalize(await readSource("browser/projectSourcesRunner.ts"));
    const closeIndex = projectSources.indexOf(LOCAL_CLOSE_ANCHOR);
    const releaseIndex = projectSources.lastIndexOf(RELEASE_ANCHOR);
    expect(closeIndex).toBeGreaterThanOrEqual(0);
    expect(releaseIndex).toBeGreaterThanOrEqual(0);
    expect(closeIndex).toBeLessThan(releaseIndex);
  });
});

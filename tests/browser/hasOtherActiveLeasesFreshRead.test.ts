/**
 * hasOtherActiveLeases() must re-read the tab-lease registry on every call,
 * not memoize the first result for the lifetime of the run-cleanup closure.
 *
 * Property (correctness / fault isolation): this closure backs two gates in
 * runBrowserMode()'s run-cleanup finally block, separated in time by
 * acquireProfileRunLock() (`cleanupProfileLock`):
 *   1. the blank-tab-close gate (closes blank tabs when no other lease is
 *      active), and
 *   2. the Chrome-termination gate (SIGTERMs the shared Chrome when no other
 *      lease is active).
 * Under c>=2 manual-login concurrency, a second worker can acquire its own
 * tab lease and briefly touch the same profile lock in the gap between gate 1
 * and gate 2. If gate 2 reused a cached "no other leases" result computed
 * before that second worker's lease existed, it would conclude the shared
 * Chrome is idle and kill it out from under the still-running worker. The
 * fix removes the memoization so gate 2 always re-reads the registry after
 * cleanupProfileLock is acquired.
 *
 * This is checked structurally against the source (like
 * closeBeforeReleaseOrdering.test.ts) because hasOtherActiveLeases is a
 * closure inside runBrowserMode() that requires a live Chrome/CDP endpoint
 * and a real tab-lease registry on disk to exercise end-to-end; the
 * regression is about the *shape* of the closure (no cross-call cache), not
 * a value that's easy to observe without that infrastructure.
 */
import { describe, expect, test } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";

const SRC_ROOT = fileURLToPath(new URL("../../src", import.meta.url));

async function readSource(relative: string): Promise<string> {
  return readFile(path.join(SRC_ROOT, relative), "utf8");
}

function sliceBetween(source: string, startAnchor: string, endAnchor: string): string {
  const start = source.indexOf(startAnchor);
  expect(start, `missing start anchor: ${startAnchor}`).toBeGreaterThanOrEqual(0);
  const end = source.indexOf(endAnchor, start + startAnchor.length);
  expect(end, `missing end anchor: ${endAnchor}`).toBeGreaterThan(start);
  return source.slice(start, end);
}

async function hasOtherActiveLeasesClosureSource(): Promise<string> {
  const source = await readSource("browser/index.ts");
  return sliceBetween(
    source,
    "const hasOtherActiveLeases = async () => {",
    "if (\n      runStatus === \"complete\" &&",
  );
}

describe("hasOtherActiveLeases fresh-read regression", () => {
  test("guard: the hasOtherActiveLeases closure still exists and is still used by both gates", async () => {
    const source = await readSource("browser/index.ts");
    // Both call sites must remain: the blank-tab gate and the
    // Chrome-termination gate, straddling cleanupProfileLock acquisition.
    const callSites = source.match(/hasOtherActiveLeases\(\)/gu) ?? [];
    expect(callSites.length).toBeGreaterThanOrEqual(2);
    expect(source).toContain("cleanupProfileLock = await acquireProfileRunLock(");
  });

  test("hasOtherActiveLeases performs a fresh registry read with no cross-call memoization", async () => {
    const closure = await hasOtherActiveLeasesClosureSource();

    // The pre-fix bug memoized the result in a `let ... : boolean | null`
    // variable and short-circuited on `=== null`, so the second (post-lock)
    // caller silently reused the first (pre-lock) caller's stale answer.
    expect(closure).not.toMatch(/:\s*boolean\s*\|\s*null/u);
    expect(closure).not.toContain("=== null");

    // The closure must call the registry-backed check directly and return
    // its result unconditionally, i.e. every invocation is a fresh read.
    expect(closure).toContain(
      "return await hasOtherActiveBrowserTabLeases(userDataDir, tabLease.id);",
    );
  });
});

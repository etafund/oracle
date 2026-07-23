/**
 * hasOtherActiveLeases() must re-read the tab-lease registry on every call,
 * not memoize the first result for the lifetime of the run-cleanup closure.
 *
 * Property (correctness / fault isolation): runBrowserMode()'s run-cleanup
 * finally block has two lease-registry-gated cleanup decisions:
 *   1. the Chrome-termination gate (SIGTERMs the shared Chrome when no other
 *      lease is active), backed by the hasOtherActiveLeases closure after
 *      acquireProfileRunLock() (`cleanupProfileLock`), and
 *   2. the blank-tab-close gate, executed by the lease registry's onRelease
 *      callback only when the same locked release proves `isLastLease`.
 * Under c>=2 manual-login concurrency, a second worker can acquire its own
 * lease around cleanup. If the termination gate reused a cached "no other
 * leases" result, it could kill Chrome out from under that worker; if blank
 * cleanup used a separate best-effort snapshot, it could sweep during the
 * same race. The current shape makes the former a fresh read and the latter
 * atomic with release.
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
    "if (!keepBrowserOpen && manualLogin && tabLease) {",
  );
}

describe("hasOtherActiveLeases fresh-read regression", () => {
  test("guard: termination re-reads and blank cleanup is atomic with last-lease release", async () => {
    const source = await readSource("browser/index.ts");
    // The Chrome-termination gate still consults the fresh-read closure after
    // cleanupProfileLock acquisition. Blank-tab cleanup is stronger than its
    // former independent snapshot: it runs only from the registry-locked
    // release callback after that callback proves this was the last lease.
    const callSites = source.match(/hasOtherActiveLeases\(\)/gu) ?? [];
    expect(callSites.length).toBeGreaterThanOrEqual(1);
    expect(source).toContain("cleanupProfileLock = await acquireProfileRunLock(");
    expect(source).toContain("onRelease: async ({ isLastLease }) => {");
    expect(source).toContain("if (isLastLease) {");
    expect(source).toContain("await cleanupBlankTabs();");
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

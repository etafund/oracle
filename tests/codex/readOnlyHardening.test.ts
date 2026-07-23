import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

describe("Codex findings read-only hardening", () => {
  it("does not wire trusted browser input or mutating action helpers", async () => {
    const source = await readFile(path.join(ROOT, "src/browser/codexFindingsRunner.ts"), "utf8");
    expect(source).toContain("const { Network, Page, Runtime, Target } = client;");
    expect(source).not.toMatch(/\bInput\.(?:enable|dispatch)/u);
    expect(source).not.toMatch(/\bclient\.Input\b/u);
    expect(source).not.toContain("executeFindingAction");
    expect(source).not.toContain("CodexFindingAction");
  });

  it("closes the owned target before release and fails closed on registry uncertainty", async () => {
    const source = await readFile(path.join(ROOT, "src/browser/codexFindingsRunner.ts"), "utf8");
    const close = source.indexOf("closeOwnedTargetWithDeadline(");
    const release = source.indexOf("await handle.release()", close);
    expect(close).toBeGreaterThanOrEqual(0);
    expect(release).toBeGreaterThan(close);
    expect(source).toContain("hasOtherActiveBrowserTabLeases(userDataDir, tabLease.id).catch(");
    expect(source).toContain("() => true");
    expect(source).toContain("!ownedTargetCleanupProved");
  });
});

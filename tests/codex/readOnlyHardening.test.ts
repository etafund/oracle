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
    const release = source.indexOf("releaseBrowserTabLeaseOrTaint(", close);
    expect(close).toBeGreaterThanOrEqual(0);
    expect(release).toBeGreaterThan(close);
    expect(source).toContain("hasOtherActiveBrowserTabLeases(userDataDir, tabLease.id).catch(");
    expect(source).toContain("() => true");
    expect(source).toContain("!ownedTargetCleanupProved");
  });

  it("uses current shared-browser admission, isolation, and ownership guards", async () => {
    const source = await readFile(path.join(ROOT, "src/browser/codexFindingsRunner.ts"), "utf8");
    expect(source).toContain("timeoutMs: config.queueTimeoutMs");
    expect(source).toContain("rollbackOrphanedBrowserTabLeaseAcquisition(");
    expect(source).toContain("resolveIsolatedTabConnectOptions(manualLogin)");
    expect(source).toContain("verifyChromeDebugTargetOwner");
    expect(source).toContain("resolveChromeDebugTargetOwner");
    expect(source).toContain("writeChromePid(userDataDir, chrome.pid, chrome.port)");
    expect(source).toContain("writeChromePid(userDataDir, discovered.pid, discovered.port)");
  });

  it("never retains copied credentials and rejects conflicting profile modes before allocation", async () => {
    const source = await readFile(path.join(ROOT, "src/browser/codexFindingsRunner.ts"), "utf8");
    const conflictGuard = source.indexOf("if (manualLogin && usingCopiedProfile)");
    const profileAllocation = source.indexOf("await mkdtemp(");

    expect(conflictGuard).toBeGreaterThanOrEqual(0);
    expect(profileAllocation).toBeGreaterThan(conflictGuard);
    expect(source).toContain(
      "const effectiveKeepBrowser = usingCopiedProfile ? false : Boolean(config.keepBrowser)",
    );
    expect(source).toContain("forceProfileCleanup: usingCopiedProfile");
  });

  it("terminates only the verified reused owner and retains signal hooks through lease cleanup", async () => {
    const source = await readFile(path.join(ROOT, "src/browser/codexFindingsRunner.ts"), "utf8");
    const cleanup = source.slice(source.indexOf("} finally {"));
    const targetClose = cleanup.indexOf("closeOwnedTargetWithDeadline(");
    const leaseRelease = cleanup.indexOf("releaseBrowserTabLeaseOrTaint(");
    const removeHooks = cleanup.indexOf("removeTerminationHooks?.()");

    expect(source).toContain("terminateRecordedChromeForProfile(");
    expect(source).toContain("if (!terminatedRecordedChrome)");
    expect(source).not.toContain("Reused shared Chrome; leaving browser process running.");
    expect(targetClose).toBeGreaterThanOrEqual(0);
    expect(leaseRelease).toBeGreaterThan(targetClose);
    expect(removeHooks).toBeGreaterThan(leaseRelease);
  });
});

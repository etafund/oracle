import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";

const ROOT = process.cwd();

async function source(relativePath: string): Promise<string> {
  return readFile(path.join(ROOT, relativePath), "utf8");
}

describe("independent browser FIFO queue-timeout wiring", () => {
  test("every ordinary ChatGPT tab acquisition uses queueTimeoutMs, never the response timeout", async () => {
    const index = await source("src/browser/index.ts");
    const projectSources = await source("src/browser/projectSourcesRunner.ts");
    const codexFindings = await source("src/browser/codexFindingsRunner.ts");

    const indexAcquisitions = [...index.matchAll(/acquireBrowserTabLease\([^]*?\n\s*\}\);/gu)];
    expect(indexAcquisitions).toHaveLength(2);
    for (const [call] of indexAcquisitions) {
      expect(call).toContain("timeoutMs: config.queueTimeoutMs");
      expect(call).not.toContain("timeoutMs: config.timeoutMs");
    }

    const projectAcquisitions = [
      ...projectSources.matchAll(/acquireBrowserTabLease\([^]*?\n\s*\}\);/gu),
    ];
    expect(projectAcquisitions).toHaveLength(1);
    expect(projectAcquisitions[0]?.[0]).toContain("timeoutMs: config.queueTimeoutMs");

    const codexFindingsAcquisitions = [
      ...codexFindings.matchAll(/acquireBrowserTabLease\([^]*?\n\s*\}\);/gu),
    ];
    expect(codexFindingsAcquisitions).toHaveLength(1);
    expect(codexFindingsAcquisitions[0]?.[0]).toContain("timeoutMs: config.queueTimeoutMs");
    expect(codexFindingsAcquisitions[0]?.[0]).not.toContain("timeoutMs: config.timeoutMs");
  });

  test("Codex findings exposes its independent queue timeout in command help", async () => {
    const cli = await source("bin/oracle-cli.ts");
    const codexStart = cli.indexOf("const codexCommand = program");
    const codexEnd = cli.indexOf("const bridgeCommand = program", codexStart);
    const codex = cli.slice(codexStart, codexEnd);

    expect(codexStart).toBeGreaterThanOrEqual(0);
    expect(codexEnd).toBeGreaterThan(codexStart);
    expect(codex).toContain('option("--browser-queue-timeout <duration>"');
  });

  test("isolated recovery preserves the legacy lease timeout only as a fallback", async () => {
    const reattach = await source("src/browser/reattach.ts");
    const acquisition = /acquireBrowserTabLeaseFn\([^]*?\n\s*\}\);/u.exec(reattach)?.[0];
    expect(acquisition).toBeDefined();
    expect(acquisition).toContain(
      "timeoutMs: queueTimeoutMs ?? leaseTimeoutMs ?? config?.queueTimeoutMs",
    );
  });

  test("every production acquisition rolls back a durably committed orphan lease", async () => {
    const index = await source("src/browser/index.ts");
    const projectSources = await source("src/browser/projectSourcesRunner.ts");
    const codexFindings = await source("src/browser/codexFindingsRunner.ts");
    const reattach = await source("src/browser/reattach.ts");

    expect(index.match(/await rollbackOrphanedBrowserTabLeaseAcquisition\(/gu)).toHaveLength(2);
    expect(
      projectSources.match(/await rollbackOrphanedBrowserTabLeaseAcquisition\(/gu),
    ).toHaveLength(1);
    expect(
      codexFindings.match(/await rollbackOrphanedBrowserTabLeaseAcquisition\(/gu),
    ).toHaveLength(1);
    expect(reattach.match(/await rollbackOrphanedBrowserTabLeaseAcquisition\(/gu)).toHaveLength(1);
  });

  test("the local lease metadata update is inside the run cleanup boundary", async () => {
    const index = await source("src/browser/index.ts");
    const localStart = index.indexOf("const { chrome, reusedChrome } = acquiredChrome;");
    const localEnd = index.indexOf("async function pickAvailableDebugPort", localStart);
    const local = index.slice(localStart, localEnd);
    const cleanupBoundary = local.indexOf("\n  try {\n    if (tabLease)");
    const initialLeaseUpdate = local.indexOf("await tabLease.update({");

    expect(localStart).toBeGreaterThanOrEqual(0);
    expect(localEnd).toBeGreaterThan(localStart);
    expect(cleanupBoundary).toBeGreaterThanOrEqual(0);
    expect(initialLeaseUpdate).toBeGreaterThan(cleanupBoundary);
  });
});

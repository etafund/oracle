import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  EVIDENCE_LEDGER_GENESIS_HASH,
  EVIDENCE_LEDGER_SCHEMA_VERSION,
  appendEvidenceLedgerEvent,
  evidenceLedgerPath,
  readEvidenceLedger,
  type EvidenceLedgerEntry,
  type EvidenceLedgerEvent,
} from "../../src/oracle/evidence_ledger.js";
import {
  DEFAULT_EVIDENCE_LEDGER_HEAD_CACHE_FLUSH_INTERVAL,
  clearEvidenceLedgerHeadCache,
  evidenceLedgerHeadCachePath,
  getEvidenceLedgerHeadCacheStats,
  resetEvidenceLedgerHeadCacheStats,
} from "../../src/oracle/evidence_ledger_cache.js";
import { canonicalJSON, sha256OfBytes } from "../../src/oracle/v18/evidence.js";

const testNonWindows = process.platform === "win32" ? test.skip : test;

let homeDir: string;

beforeEach(async () => {
  homeDir = await mkdtemp(path.join(os.tmpdir(), "oracle-ledger-perf-"));
  clearEvidenceLedgerHeadCache();
  resetEvidenceLedgerHeadCacheStats();
});

afterEach(async () => {
  clearEvidenceLedgerHeadCache();
  resetEvidenceLedgerHeadCacheStats();
  await rm(homeDir, { recursive: true, force: true });
});

describe("evidence ledger append performance", () => {
  testNonWindows("append reads a bounded tail instead of rescanning a large ledger", async () => {
    const sessionId = "session-large-ledger";
    const entryCount = 1_500;
    const filePath = await writeSyntheticLedger(sessionId, entryCount);
    const beforeSize = (await stat(filePath)).size;

    await appendEvidenceLedgerEvent(
      sessionId,
      { type: "run_completed", timestamp: "2026-05-13T00:30:00.000Z" },
      { homeDir },
    );

    const stats = getEvidenceLedgerHeadCacheStats();
    expect(stats.fullFallbacks).toBe(0);
    expect(stats.tailReads).toBe(1);
    expect(stats.tailBytesRead).toBeLessThanOrEqual(4096);
    expect(stats.tailBytesRead).toBeLessThan(beforeSize / 10);

    const read = await readEvidenceLedger(sessionId, { homeDir });
    expect(read.chainValid).toBe(true);
    expect(read.entries).toHaveLength(entryCount + 1);
    expect(read.entries[entryCount].sequence).toBe(entryCount);
  });

  testNonWindows("warm in-memory head cache avoids tail reads for repeated appends", async () => {
    const sessionId = "session-warm-cache";

    await appendEvidenceLedgerEvent(
      sessionId,
      { type: "session_started", timestamp: "2026-05-13T00:00:00.000Z" },
      { homeDir },
    );
    resetEvidenceLedgerHeadCacheStats();

    const second = await appendEvidenceLedgerEvent(
      sessionId,
      { type: "browser_attached", timestamp: "2026-05-13T00:00:01.000Z" },
      { homeDir },
    );

    const stats = getEvidenceLedgerHeadCacheStats();
    expect(second.entry.sequence).toBe(1);
    expect(second.chainExtended).toBe(true);
    expect(stats.memoryHits).toBe(1);
    expect(stats.tailReads).toBe(0);
    expect(stats.tailBytesRead).toBe(0);

    const read = await readEvidenceLedger(sessionId, { homeDir });
    expect(read.chainValid).toBe(true);
    expect(read.entries).toHaveLength(2);
  });

  testNonWindows("batched durable head cache is reused after clearing process memory", async () => {
    const sessionId = "session-sidecar-cache";
    const filePath = evidenceLedgerPath(sessionId, homeDir);

    for (let index = 0; index < DEFAULT_EVIDENCE_LEDGER_HEAD_CACHE_FLUSH_INTERVAL; index += 1) {
      await appendEvidenceLedgerEvent(
        sessionId,
        {
          type: "evidence_written",
          evidence_id: `ev-${index}`,
          timestamp: `2026-05-13T00:00:${String(index).padStart(2, "0")}.000Z`,
        },
        { homeDir },
      );
    }

    await expect(stat(evidenceLedgerHeadCachePath(filePath))).resolves.toMatchObject({
      size: expect.any(Number),
    });

    clearEvidenceLedgerHeadCache();
    resetEvidenceLedgerHeadCacheStats();
    const appended = await appendEvidenceLedgerEvent(
      sessionId,
      { type: "run_completed", timestamp: "2026-05-13T00:01:00.000Z" },
      { homeDir },
    );

    const stats = getEvidenceLedgerHeadCacheStats();
    expect(appended.entry.sequence).toBe(DEFAULT_EVIDENCE_LEDGER_HEAD_CACHE_FLUSH_INTERVAL);
    expect(stats.sidecarHits).toBe(1);
    expect(stats.tailReads).toBe(0);
  });
});

async function writeSyntheticLedger(sessionId: string, count: number): Promise<string> {
  const filePath = evidenceLedgerPath(sessionId, homeDir);
  await mkdir(path.dirname(filePath), { recursive: true });

  const entries: EvidenceLedgerEntry[] = [];
  let prevHash: EvidenceLedgerEntry["prev_hash"] = EVIDENCE_LEDGER_GENESIS_HASH;
  for (let sequence = 0; sequence < count; sequence += 1) {
    const entry = createEntry({
      sequence,
      prevHash,
      event: {
        type: "evidence_written",
        evidence_id: `ev-${sequence}`,
        timestamp: `2026-05-13T00:${String(Math.floor(sequence / 60)).padStart(2, "0")}:${String(
          sequence % 60,
        ).padStart(2, "0")}.000Z`,
        metadata: { milestone: sequence },
      },
    });
    entries.push(entry);
    prevHash = entry.entry_hash;
  }

  await writeFile(filePath, `${entries.map((entry) => canonicalJSON(entry)).join("\n")}\n`);
  return filePath;
}

function createEntry(options: {
  readonly sequence: number;
  readonly prevHash: EvidenceLedgerEntry["prev_hash"];
  readonly event: EvidenceLedgerEvent;
}): EvidenceLedgerEntry {
  const entryWithoutHash = {
    schema_version: EVIDENCE_LEDGER_SCHEMA_VERSION,
    sequence: options.sequence,
    timestamp: options.event.timestamp ?? "2026-05-13T00:00:00.000Z",
    event: options.event,
    prev_hash: options.prevHash,
  };

  return {
    ...entryWithoutHash,
    entry_hash: sha256OfBytes(canonicalJSON(entryWithoutHash)),
  };
}

import { describe, expect, test } from "vitest";
import { readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ORACLE_PREMORTEM_FAILURE_MODES,
  listPremortemIds,
} from "@tests/_helpers/premortem.ts";

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));

function listPremortemTestFiles(): string[] {
  if (!existsSync(THIS_DIR)) return [];
  return readdirSync(THIS_DIR).filter((file) => file.endsWith(".test.ts"));
}

function fmFilenameToken(id: string): string {
  // FM-001 → "fm_001"; coverage_matrix.test.ts → "coverage_matrix"
  return id.toLowerCase().replace(/-/g, "_");
}

describe("premortem coverage matrix", () => {
  test("every Oracle-relevant failure mode has a dedicated premortem test file", () => {
    const files = listPremortemTestFiles();
    const missing: string[] = [];
    for (const fm of ORACLE_PREMORTEM_FAILURE_MODES) {
      const token = fmFilenameToken(fm.id); // fm_001
      const match = files.find((f) => f.startsWith(`${token}_`) && f.endsWith(".test.ts"));
      if (!match) {
        missing.push(`${fm.id} (${fm.title}) — expected a file like ${token}_*.test.ts`);
      }
    }
    expect(missing, missing.join("\n")).toEqual([]);
  });

  test("the failure-mode list matches the canonical id list", () => {
    expect(listPremortemIds()).toEqual([
      "FM-001",
      "FM-002",
      "FM-006",
      "FM-007",
      "FM-009",
      "FM-010",
      "FM-011",
    ]);
  });

  test("every entry declares at least one Oracle acceptance check and one control", () => {
    for (const fm of ORACLE_PREMORTEM_FAILURE_MODES) {
      expect(fm.oracle_acceptance_checks.length, `${fm.id} has no acceptance checks`).toBeGreaterThan(0);
      expect(fm.oracle_controls.length, `${fm.id} has no controls`).toBeGreaterThan(0);
    }
  });

  test("Oracle-owned FMs are surfaced verbatim from the ledger", () => {
    const oracleOwned = ORACLE_PREMORTEM_FAILURE_MODES.filter((fm) => fm.owner === "oracle").map(
      (fm) => fm.id,
    );
    // FM-001, FM-002, FM-009 are owner=oracle in the v18 ledger.
    expect(oracleOwned).toEqual(["FM-001", "FM-002", "FM-009"]);
  });
});

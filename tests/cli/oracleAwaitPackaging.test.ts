import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

// PR 243 exposes `oracle-await` as a package binary. The CLI is useless if the
// script is not shipped or not executable, so assert the packaging contract
// directly (complements the manual `pnpm pack --dry-run` check).
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const awaitScriptRelPath = "skills/oracle/scripts/oracle-await";
const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")) as {
  bin?: Record<string, string>;
  files?: string[];
};

describe("oracle-await packaging (PR 243)", () => {
  test("is registered as the oracle-await package bin", () => {
    expect(pkg.bin?.["oracle-await"]).toBe(awaitScriptRelPath);
  });

  test("is included in the published files allowlist", () => {
    expect(pkg.files ?? []).toContain(awaitScriptRelPath);
  });

  test("ships as an existing executable script", () => {
    const full = path.join(repoRoot, awaitScriptRelPath);
    expect(existsSync(full)).toBe(true);
    // At least one execute bit must be set so the published bin is runnable.
    expect(statSync(full).mode & 0o111).not.toBe(0);
  });
});

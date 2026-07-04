#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FULL_COMMIT_RE = /^[0-9a-f]{40}$/i;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJsonPath = path.join(repoRoot, "package.json");
const outputPath = path.join(repoRoot, "dist", "build-provenance.json");

const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8"));
const commit = normalizeCommit(
  runGit(["rev-parse", "HEAD"]) ?? process.env.GITHUB_SHA ?? process.env.ORACLE_BUILD_COMMIT,
);
const status = runGit(["status", "--porcelain"]);

const provenance = {
  schema_version: "oracle_build_provenance.v1",
  version: typeof pkg.version === "string" ? pkg.version : "0.0.0",
  commit,
  commit_short: commit ? commit.slice(0, 12) : null,
  dirty: status === null ? null : status.length > 0,
  built_at: new Date().toISOString(),
  source: "build-provenance",
};

mkdirSync(path.dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(provenance, null, 2)}\n`);

function runGit(args) {
  try {
    const stdout = execFileSync("git", args, {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const trimmed = stdout.trim();
    return trimmed.length > 0 ? trimmed : "";
  } catch {
    return null;
  }
}

function normalizeCommit(value) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return FULL_COMMIT_RE.test(normalized) ? normalized : null;
}

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

let cachedVersion: string | null = null;
let cachedPackageMetadata: PackageMetadata | null = null;
let cachedBuildInfo: OracleBuildInfo | null = null;

export const ORACLE_BUILD_PROVENANCE_SCHEMA = "oracle_build_provenance.v1";

export type OracleBuildProvenanceSource = "build-provenance" | "package-json" | "git" | "unknown";

export interface OracleBuildInfo {
  schema_version: typeof ORACLE_BUILD_PROVENANCE_SCHEMA;
  version: string;
  commit: string | null;
  commit_short: string | null;
  dirty: boolean | null;
  built_at: string | null;
  source: OracleBuildProvenanceSource;
}

interface PackageMetadata {
  packageDir: string | null;
  version: string;
  gitHead: string | null;
}

const FULL_COMMIT_RE = /^[0-9a-f]{40}$/i;
const SHORT_COMMIT_RE = /^[0-9a-f]{7,40}$/i;
const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,127}$/;

export function getCliVersion(): string {
  if (cachedVersion) {
    return cachedVersion;
  }
  cachedVersion = readPackageMetadata().version;
  return cachedVersion;
}

export function getOracleBuildInfo(): OracleBuildInfo {
  if (cachedBuildInfo) {
    return cachedBuildInfo;
  }

  const metadata = readPackageMetadata();
  const modulePath = fileURLToPath(import.meta.url);
  const runningFromCompiledDist =
    metadata.packageDir !== null &&
    path.relative(metadata.packageDir, modulePath).split(path.sep).includes("dist");

  if (!runningFromCompiledDist) {
    const git = readGitBuildInfo(metadata.version, metadata.packageDir ?? process.cwd());
    if (git) {
      cachedBuildInfo = git;
      return cachedBuildInfo;
    }
  }

  const generated = metadata.packageDir
    ? readGeneratedBuildInfo(metadata.packageDir, metadata.version)
    : null;
  if (generated) {
    cachedBuildInfo = generated;
    return cachedBuildInfo;
  }

  const packageGitHead = metadata.gitHead
    ? buildInfoFromParts({
        version: metadata.version,
        commit: metadata.gitHead,
        dirty: null,
        builtAt: null,
        source: "package-json",
      })
    : null;
  if (packageGitHead) {
    cachedBuildInfo = packageGitHead;
    return cachedBuildInfo;
  }

  if (runningFromCompiledDist) {
    const git = readGitBuildInfo(metadata.version, metadata.packageDir ?? process.cwd());
    if (git) {
      cachedBuildInfo = git;
      return cachedBuildInfo;
    }
  }

  cachedBuildInfo = buildInfoFromParts({
    version: metadata.version,
    commit: null,
    dirty: null,
    builtAt: null,
    source: "unknown",
  });
  return cachedBuildInfo;
}

export function parseOracleBuildInfo(
  value: unknown,
  fallbackVersion = "0.0.0",
): OracleBuildInfo | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  const source = parseSource(record.source);
  return buildInfoFromParts({
    version: typeof record.version === "string" ? record.version : fallbackVersion,
    commit:
      typeof record.commit === "string"
        ? record.commit
        : typeof record.gitHead === "string"
          ? record.gitHead
          : null,
    dirty: typeof record.dirty === "boolean" ? record.dirty : null,
    builtAt:
      typeof record.built_at === "string"
        ? record.built_at
        : typeof record.builtAt === "string"
          ? record.builtAt
          : null,
    source,
  });
}

function readPackageMetadata(): PackageMetadata {
  if (cachedPackageMetadata) {
    return cachedPackageMetadata;
  }

  const modulePath = fileURLToPath(import.meta.url);
  let currentDir = path.dirname(modulePath);
  const filesystemRoot = path.parse(currentDir).root;

  // biome-ignore lint/nursery/noUnnecessaryConditions: deliberate sentinel loop to walk up directories
  while (true) {
    const candidate = path.join(currentDir, "package.json");
    try {
      const raw = readFileSync(candidate, "utf8");
      const parsed = JSON.parse(raw) as { version?: unknown; gitHead?: unknown };
      const version =
        typeof parsed.version === "string" && parsed.version.trim().length > 0
          ? parsed.version.trim()
          : "0.0.0";
      cachedPackageMetadata = {
        packageDir: currentDir,
        version: normalizeVersion(version),
        gitHead: typeof parsed.gitHead === "string" ? parsed.gitHead : null,
      };
      return cachedPackageMetadata;
    } catch (error) {
      const code =
        error instanceof Error && "code" in error ? (error as { code?: string }).code : undefined;
      if (code && code !== "ENOENT") {
        break;
      }
    }
    if (currentDir === filesystemRoot) {
      break;
    }
    currentDir = path.dirname(currentDir);
  }
  cachedPackageMetadata = { packageDir: null, version: "0.0.0", gitHead: null };
  return cachedPackageMetadata;
}

function readGeneratedBuildInfo(
  packageDir: string,
  fallbackVersion: string,
): OracleBuildInfo | null {
  const candidates = [
    path.join(packageDir, "dist", "build-provenance.json"),
    path.join(packageDir, "build-provenance.json"),
  ];
  for (const candidate of candidates) {
    try {
      const raw = readFileSync(candidate, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      const info = parseOracleBuildInfo(parsed, fallbackVersion);
      if (info) {
        return { ...info, source: "build-provenance" };
      }
    } catch (error) {
      const code =
        error instanceof Error && "code" in error ? (error as { code?: string }).code : undefined;
      if (code && code !== "ENOENT") {
        continue;
      }
    }
  }
  return null;
}

function readGitBuildInfo(version: string, cwd: string): OracleBuildInfo | null {
  const commit = runGit(["rev-parse", "HEAD"], cwd);
  if (!commit) {
    return null;
  }
  const status = runGit(["status", "--porcelain"], cwd);
  return buildInfoFromParts({
    version,
    commit,
    dirty: status === null ? null : status.length > 0,
    builtAt: null,
    source: "git",
  });
}

function runGit(args: string[], cwd: string): string | null {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0 || typeof result.stdout !== "string") {
    return null;
  }
  const value = result.stdout.trim();
  return value.length > 0 ? value : "";
}

function buildInfoFromParts(input: {
  version: string;
  commit: string | null;
  dirty: boolean | null;
  builtAt: string | null;
  source: OracleBuildProvenanceSource;
}): OracleBuildInfo {
  const commit = normalizeCommit(input.commit);
  const builtAt = normalizeBuiltAt(input.builtAt);
  return {
    schema_version: ORACLE_BUILD_PROVENANCE_SCHEMA,
    version: normalizeVersion(input.version),
    commit,
    commit_short: commit ? commit.slice(0, 12) : normalizeShortCommit(input.commit),
    dirty: input.dirty,
    built_at: builtAt,
    source: input.source,
  };
}

function normalizeCommit(value: string | null): string | null {
  const normalized = value?.trim().toLowerCase() ?? "";
  return FULL_COMMIT_RE.test(normalized) ? normalized : null;
}

function normalizeShortCommit(value: string | null): string | null {
  const normalized = value?.trim().toLowerCase() ?? "";
  return SHORT_COMMIT_RE.test(normalized) ? normalized : null;
}

function normalizeBuiltAt(value: string | null): string | null {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  const timestamp = Date.parse(trimmed);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function normalizeVersion(value: string): string {
  const trimmed = value.trim();
  return VERSION_RE.test(trimmed) ? trimmed : "0.0.0";
}

function parseSource(value: unknown): OracleBuildProvenanceSource {
  switch (value) {
    case "build-provenance":
    case "package-json":
    case "git":
    case "unknown":
      return value;
    default:
      return "unknown";
  }
}

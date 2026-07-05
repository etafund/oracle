import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Dirent } from "node:fs";
import type { SessionArtifact, SessionMetadata } from "./sessionManager.js";

export const SESSION_ARTIFACT_INDEX_SCHEMA_VERSION = "session_artifact_index.v1" as const;

export type SessionArtifactIndexCategory =
  | "transcript"
  | "report"
  | "generated-file"
  | "downloaded-file"
  | "diagnostic"
  | "perf-trace"
  | "claude-code-raw"
  | "claude-code-normalized"
  | "claude-code-final"
  | "claude-code-adapter"
  | "other";

export type SessionArtifactIndexSource =
  | "metadata"
  | "claude-code-metadata"
  | "discovered"
  | "supplied";

export type SessionArtifactMetadataStatus = "provided" | "loaded" | "missing" | "corrupt";

export interface SessionArtifactIndexEntry {
  category: SessionArtifactIndexCategory;
  kind: string;
  label: string;
  path: string;
  displayPath: string;
  exists: boolean;
  source: SessionArtifactIndexSource;
  mimeType?: string;
  sizeBytes?: number;
  sha256?: string;
  warnings?: string[];
}

export interface SessionArtifactIndex {
  schema_version: typeof SESSION_ARTIFACT_INDEX_SCHEMA_VERSION;
  sessionId: string;
  sessionDir: string;
  displaySessionDir: string;
  metadataStatus: SessionArtifactMetadataStatus;
  entries: SessionArtifactIndexEntry[];
  warnings: string[];
}

export interface BuildSessionArtifactIndexOptions {
  sessionDir: string;
  metadata?: SessionMetadata | null;
  oracleHomeDir?: string;
  cwd?: string;
  perfTracePaths?: string[];
  maxDiscoveredFiles?: number;
}

interface DisplayRoots {
  sessionDir: string;
  oracleHomeDir?: string;
  cwd?: string;
}

interface ClassifiedArtifact {
  category: SessionArtifactIndexCategory;
  kind: string;
  label: string;
  mimeType?: string;
}

interface AddEntryInput extends ClassifiedArtifact {
  path: string;
  source: SessionArtifactIndexSource;
  sizeBytes?: number;
  sha256?: string;
  warnings?: string[];
}

const DEFAULT_MAX_DISCOVERED_FILES = 2_000;
const METADATA_FILENAME = "meta.json";
const ARTIFACTS_DIRNAME = "artifacts";
const MODEL_LOG_EXTENSION = ".log";

const CATEGORY_ORDER: Record<SessionArtifactIndexCategory, number> = {
  transcript: 0,
  report: 1,
  "generated-file": 2,
  "downloaded-file": 3,
  diagnostic: 4,
  "perf-trace": 5,
  "claude-code-raw": 6,
  "claude-code-normalized": 7,
  "claude-code-final": 8,
  "claude-code-adapter": 9,
  other: 10,
};

const GENERATED_FILE_EXTENSIONS = new Set([
  ".apng",
  ".avif",
  ".gif",
  ".jpeg",
  ".jpg",
  ".png",
  ".svg",
  ".webp",
]);

const DOWNLOADED_FILE_EXTENSIONS = new Set([
  ".7z",
  ".csv",
  ".doc",
  ".docx",
  ".gz",
  ".html",
  ".json",
  ".md",
  ".pdf",
  ".tar",
  ".tgz",
  ".txt",
  ".whl",
  ".xls",
  ".xlsx",
  ".xml",
  ".zip",
]);

const SECRET_ASSIGNMENT_PATTERN =
  /\b(access[_-]?token|auth[_-]?token|api[_-]?key|token|secret|session|cookie)=([^&/\s]+)/gi;
const SECRET_TOKEN_PATTERN =
  /\b(?:sk-(?:proj-|ant-|or-)?[A-Za-z0-9_-]{8,}|xai-[A-Za-z0-9_-]{8,}|AIza[A-Za-z0-9_-]{8,})\b/g;
const BEARER_TOKEN_PATTERN = /\bBearer\s+[A-Za-z0-9._\-+/=]+/gi;

export async function buildSessionArtifactIndex(
  options: BuildSessionArtifactIndexOptions,
): Promise<SessionArtifactIndex> {
  const sessionDir = path.resolve(options.sessionDir);
  const oracleHomeDir = options.oracleHomeDir
    ? path.resolve(options.oracleHomeDir)
    : deriveOracleHomeDir(sessionDir);
  const roots: DisplayRoots = {
    sessionDir,
    oracleHomeDir,
    cwd: options.cwd ? path.resolve(options.cwd) : undefined,
  };
  const warnings: string[] = [];
  const loaded = await resolveMetadata(options, sessionDir, roots);
  warnings.push(...loaded.warnings);
  const metadata = loaded.metadata;
  const sessionId = metadata?.id || path.basename(sessionDir);
  const entries = new Map<string, SessionArtifactIndexEntry>();

  const addEntry = async (input: AddEntryInput): Promise<void> => {
    const artifactPath = normalizeArtifactPath(input.path, sessionDir);
    const stats = await readArtifactStats(artifactPath);
    const displayPath = createSecretSafePathDisplay(artifactPath, roots);
    const entryWarnings = [...(input.warnings ?? []), ...stats.warnings];
    const entry: SessionArtifactIndexEntry = {
      category: input.category,
      kind: input.kind,
      label: input.label,
      path: artifactPath,
      displayPath,
      exists: stats.exists,
      source: input.source,
      mimeType: input.mimeType,
      sizeBytes: stats.sizeBytes ?? input.sizeBytes,
      sha256: input.sha256,
      warnings: entryWarnings.length > 0 ? dedupeStrings(entryWarnings) : undefined,
    };
    mergeEntry(entries, entry);
  };

  for (const artifact of normalizeMetadataArtifacts(metadata, warnings)) {
    await addEntry(metadataArtifactToEntry(artifact));
  }
  for (const artifact of collectClaudeCodeMetadataArtifacts(metadata)) {
    await addEntry(artifact);
  }
  for (const perfTracePath of options.perfTracePaths ?? []) {
    await addEntry({
      category: "perf-trace",
      kind: "perf-trace",
      label: "Performance trace",
      path: perfTracePath,
      source: "supplied",
      mimeType: "application/json",
    });
  }

  const discovered = await discoverSessionArtifactFiles(sessionDir, {
    maxFiles: options.maxDiscoveredFiles ?? DEFAULT_MAX_DISCOVERED_FILES,
    warnings,
  });
  for (const filePath of discovered) {
    const classified = classifyDiscoveredFile(filePath, sessionDir);
    if (classified) {
      await addEntry({
        ...classified,
        path: filePath,
        source: "discovered",
      });
    }
  }

  return {
    schema_version: SESSION_ARTIFACT_INDEX_SCHEMA_VERSION,
    sessionId,
    sessionDir,
    displaySessionDir: createSecretSafePathDisplay(sessionDir, roots),
    metadataStatus: loaded.status,
    entries: Array.from(entries.values()).sort(compareEntries),
    warnings: dedupeStrings(warnings),
  };
}

export function createSecretSafePathDisplay(targetPath: string, roots: DisplayRoots): string {
  if (isLikelyUrl(targetPath)) {
    return "<url>";
  }
  if (isWindowsAbsolutePath(targetPath) && process.platform !== "win32") {
    return `external:${redactPathForDisplay(basenameAnyPlatform(targetPath))}`;
  }

  const absolutePath = path.isAbsolute(targetPath)
    ? path.normalize(targetPath)
    : path.resolve(roots.sessionDir, targetPath);
  const normalizedSessionDir = path.resolve(roots.sessionDir);
  if (isPathInside(absolutePath, normalizedSessionDir)) {
    const relativePath = path.relative(normalizedSessionDir, absolutePath) || ".";
    return redactPathForDisplay(toPosix(relativePath));
  }
  if (roots.oracleHomeDir && isPathInside(absolutePath, path.resolve(roots.oracleHomeDir))) {
    const relativePath = path.relative(path.resolve(roots.oracleHomeDir), absolutePath) || ".";
    return redactPathForDisplay(path.posix.join("$ORACLE_HOME", toPosix(relativePath)));
  }
  if (roots.cwd && isPathInside(absolutePath, path.resolve(roots.cwd))) {
    const relativePath = path.relative(path.resolve(roots.cwd), absolutePath) || ".";
    return redactPathForDisplay(path.posix.join(".", toPosix(relativePath)));
  }
  const homeDir = os.homedir();
  if (homeDir && isPathInside(absolutePath, homeDir)) {
    const relativePath = path.relative(homeDir, absolutePath) || ".";
    return redactPathForDisplay(path.posix.join("~", toPosix(relativePath)));
  }
  if (path.isAbsolute(absolutePath)) {
    return `external:${redactPathForDisplay(path.basename(absolutePath))}`;
  }
  return redactPathForDisplay(toPosix(targetPath));
}

async function resolveMetadata(
  options: BuildSessionArtifactIndexOptions,
  sessionDir: string,
  roots: DisplayRoots,
): Promise<{
  metadata: SessionMetadata | null;
  status: SessionArtifactMetadataStatus;
  warnings: string[];
}> {
  if (Object.prototype.hasOwnProperty.call(options, "metadata")) {
    return { metadata: options.metadata ?? null, status: "provided", warnings: [] };
  }

  const metadataPath = path.join(sessionDir, METADATA_FILENAME);
  try {
    const text = await fs.readFile(metadataPath, "utf8");
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return {
        metadata: null,
        status: "corrupt",
        warnings: [
          `metadata is not an object: ${createSecretSafePathDisplay(metadataPath, roots)}`,
        ],
      };
    }
    return { metadata: parsed as SessionMetadata, status: "loaded", warnings: [] };
  } catch (error) {
    const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
    if (code === "ENOENT") {
      return {
        metadata: null,
        status: "missing",
        warnings: [`metadata missing: ${createSecretSafePathDisplay(metadataPath, roots)}`],
      };
    }
    return {
      metadata: null,
      status: "corrupt",
      warnings: [
        `metadata unreadable: ${createSecretSafePathDisplay(metadataPath, roots)} (${formatError(error)})`,
      ],
    };
  }
}

function normalizeMetadataArtifacts(
  metadata: SessionMetadata | null,
  warnings: string[],
): SessionArtifact[] {
  if (!metadata) {
    return [];
  }
  const artifacts = (metadata as { artifacts?: unknown }).artifacts;
  if (artifacts == null) {
    return [];
  }
  if (!Array.isArray(artifacts)) {
    warnings.push("metadata artifacts field is not an array");
    return [];
  }
  const normalized: SessionArtifact[] = [];
  for (const artifact of artifacts) {
    if (!artifact || typeof artifact !== "object") {
      warnings.push("metadata contains a non-object artifact entry");
      continue;
    }
    const pathValue = (artifact as { path?: unknown }).path;
    const kindValue = (artifact as { kind?: unknown }).kind;
    if (typeof pathValue !== "string" || pathValue.trim() === "") {
      warnings.push("metadata artifact entry is missing path");
      continue;
    }
    if (typeof kindValue !== "string" || kindValue.trim() === "") {
      warnings.push(`metadata artifact ${pathValue} is missing kind`);
      continue;
    }
    normalized.push(artifact as SessionArtifact);
  }
  return normalized;
}

function metadataArtifactToEntry(artifact: SessionArtifact): AddEntryInput {
  const classified = classifyMetadataArtifact(artifact);
  return {
    ...classified,
    path: artifact.path,
    source: "metadata",
    sizeBytes: artifact.sizeBytes,
    sha256: artifact.sha256,
  };
}

function classifyMetadataArtifact(artifact: SessionArtifact): ClassifiedArtifact {
  switch (artifact.kind) {
    case "transcript":
      return {
        category: "transcript",
        kind: artifact.kind,
        label: artifact.label ?? "Transcript",
        mimeType: artifact.mimeType ?? "text/markdown",
      };
    case "deep-research-report":
      return {
        category: "report",
        kind: artifact.kind,
        label: artifact.label ?? "Deep Research report",
        mimeType: artifact.mimeType ?? "text/markdown",
      };
    case "image":
      return {
        category: "generated-file",
        kind: artifact.kind,
        label: artifact.label ?? "Generated image",
        mimeType: artifact.mimeType,
      };
    case "file":
      return {
        category: "downloaded-file",
        kind: artifact.kind,
        label: artifact.label ?? "Downloaded file",
        mimeType: artifact.mimeType,
      };
    case "claude-code-stdout-raw":
    case "claude-code-stderr-raw":
      return {
        category: "claude-code-raw",
        kind: artifact.kind,
        label: artifact.label ?? claudeCodeLabelForKind(artifact.kind),
        mimeType: artifact.mimeType ?? "application/octet-stream",
      };
    case "claude-code-events-normalized":
      return {
        category: "claude-code-normalized",
        kind: artifact.kind,
        label: artifact.label ?? claudeCodeLabelForKind(artifact.kind),
        mimeType: artifact.mimeType ?? "application/x-ndjson",
      };
    case "claude-code-final":
    case "claude-code-progress":
      return {
        category: "claude-code-final",
        kind: artifact.kind,
        label: artifact.label ?? claudeCodeLabelForKind(artifact.kind),
        mimeType: artifact.mimeType ?? "text/markdown",
      };
    case "claude-code-adapter":
      return {
        category: "claude-code-adapter",
        kind: artifact.kind,
        label: artifact.label ?? claudeCodeLabelForKind(artifact.kind),
        mimeType: artifact.mimeType ?? "application/json",
      };
    default:
      return {
        category: "other",
        kind: artifact.kind,
        label: artifact.label ?? artifact.kind,
        mimeType: artifact.mimeType,
      };
  }
}

function collectClaudeCodeMetadataArtifacts(metadata: SessionMetadata | null): AddEntryInput[] {
  const claudeCode = metadata?.claudeCode;
  if (!claudeCode) {
    return [];
  }
  const paths = claudeCode.artifact_paths;
  const raw: Array<{
    path?: string;
    kind: string;
    category: SessionArtifactIndexCategory;
    label: string;
    mimeType: string;
  }> = [
    {
      path: paths?.rawStdoutPath ?? claudeCode.raw_stdout_path,
      kind: "claude-code-stdout-raw",
      category: "claude-code-raw",
      label: "Claude Code stdout (raw)",
      mimeType: "application/octet-stream",
    },
    {
      path: paths?.rawStderrPath ?? claudeCode.raw_stderr_path,
      kind: "claude-code-stderr-raw",
      category: "claude-code-raw",
      label: "Claude Code stderr (raw)",
      mimeType: "application/octet-stream",
    },
    {
      path: paths?.normalizedEventsPath ?? claudeCode.normalized_events_path,
      kind: "claude-code-events-normalized",
      category: "claude-code-normalized",
      label: "Claude Code normalized events",
      mimeType: "application/x-ndjson",
    },
    {
      path: paths?.finalAnswerPath ?? claudeCode.final_answer_path,
      kind: "claude-code-final",
      category: "claude-code-final",
      label: "Claude Code final answer",
      mimeType: "text/markdown",
    },
    {
      path: paths?.progressPath ?? claudeCode.progress_path,
      kind: "claude-code-progress",
      category: "claude-code-final",
      label: "Claude Code visible progress",
      mimeType: "text/markdown",
    },
    {
      path: paths?.adapterMetadataPath ?? claudeCode.adapter_metadata_path,
      kind: "claude-code-adapter",
      category: "claude-code-adapter",
      label: "Claude Code adapter metadata",
      mimeType: "application/json",
    },
  ];
  return raw
    .filter((entry): entry is typeof entry & { path: string } => Boolean(entry.path))
    .map((entry) => ({
      category: entry.category,
      kind: entry.kind,
      label: entry.label,
      path: entry.path,
      source: "claude-code-metadata",
      mimeType: entry.mimeType,
    }));
}

async function discoverSessionArtifactFiles(
  sessionDir: string,
  options: { maxFiles: number; warnings: string[] },
): Promise<string[]> {
  const files: string[] = [];
  await addKnownFile(path.join(sessionDir, "output.log"), files);
  await walkDirectory(path.join(sessionDir, "models"), {
    files,
    maxFiles: options.maxFiles,
    warnings: options.warnings,
    rootDisplay: "models",
  });
  await walkDirectory(path.join(sessionDir, ARTIFACTS_DIRNAME), {
    files,
    maxFiles: options.maxFiles,
    warnings: options.warnings,
    rootDisplay: ARTIFACTS_DIRNAME,
  });
  return files;
}

async function addKnownFile(filePath: string, files: string[]): Promise<void> {
  try {
    const stat = await fs.lstat(filePath);
    if (stat.isFile()) {
      files.push(filePath);
    }
  } catch {
    // Known session files are optional.
  }
}

async function walkDirectory(
  dir: string,
  options: {
    files: string[];
    maxFiles: number;
    warnings: string[];
    rootDisplay: string;
    depth?: number;
  },
): Promise<void> {
  if (options.files.length >= options.maxFiles) {
    return;
  }
  const depth = options.depth ?? 0;
  if (depth > 5) {
    options.warnings.push(`artifact discovery depth limit reached under ${options.rootDisplay}`);
    return;
  }
  let dirents: Dirent<string>[];
  try {
    dirents = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
    if (code !== "ENOENT") {
      options.warnings.push(
        `artifact discovery failed under ${options.rootDisplay}: ${formatError(error)}`,
      );
    }
    return;
  }
  for (const dirent of dirents) {
    if (options.files.length >= options.maxFiles) {
      options.warnings.push(`artifact discovery file limit reached (${options.maxFiles})`);
      return;
    }
    const child = path.join(dir, dirent.name);
    if (dirent.isSymbolicLink()) {
      options.warnings.push(
        `artifact discovery skipped symlink: ${path.join(options.rootDisplay, dirent.name)}`,
      );
      continue;
    }
    if (dirent.isDirectory()) {
      await walkDirectory(child, {
        ...options,
        rootDisplay: path.join(options.rootDisplay, dirent.name),
        depth: depth + 1,
      });
      continue;
    }
    if (dirent.isFile()) {
      options.files.push(child);
    }
  }
}

function classifyDiscoveredFile(filePath: string, sessionDir: string): ClassifiedArtifact | null {
  const relativePath = toPosix(path.relative(sessionDir, filePath));
  const basename = path.basename(filePath);
  const lowerName = basename.toLowerCase();
  const extension = path.extname(lowerName);
  if (relativePath === "output.log") {
    return {
      category: "transcript",
      kind: "session-log",
      label: "Session output log",
      mimeType: "text/plain",
    };
  }
  if (relativePath.startsWith("models/") && lowerName.endsWith(MODEL_LOG_EXTENSION)) {
    return {
      category: "transcript",
      kind: "model-log",
      label: "Model transcript",
      mimeType: "text/plain",
    };
  }
  if (isClaudeCodeArtifactName(lowerName)) {
    return classifyClaudeCodeFile(lowerName);
  }
  if (isPerfTraceName(lowerName)) {
    return {
      category: "perf-trace",
      kind: "perf-trace",
      label: "Performance trace",
      mimeType: "application/json",
    };
  }
  if (isDiagnosticName(lowerName)) {
    return {
      category: "diagnostic",
      kind: "diagnostic",
      label: diagnosticLabel(lowerName),
      mimeType: extension === ".png" ? "image/png" : "application/json",
    };
  }
  if (lowerName === "transcript.md" || lowerName.endsWith("-transcript.md")) {
    return {
      category: "transcript",
      kind: "transcript",
      label: "Transcript",
      mimeType: "text/markdown",
    };
  }
  if (isReportName(lowerName)) {
    return {
      category: "report",
      kind: lowerName.includes("deep-research") ? "deep-research-report" : "report",
      label: lowerName.includes("deep-research") ? "Deep Research report" : "Report",
      mimeType: extension === ".pdf" ? "application/pdf" : "text/markdown",
    };
  }
  if (GENERATED_FILE_EXTENSIONS.has(extension)) {
    return {
      category: "generated-file",
      kind: "image",
      label: "Generated image",
      mimeType: imageMimeType(extension),
    };
  }
  if (DOWNLOADED_FILE_EXTENSIONS.has(extension)) {
    return {
      category: "downloaded-file",
      kind: "file",
      label: "Downloaded file",
      mimeType: undefined,
    };
  }
  if (relativePath.startsWith(`${ARTIFACTS_DIRNAME}/`)) {
    return {
      category: "other",
      kind: "artifact",
      label: "Session artifact",
      mimeType: undefined,
    };
  }
  return null;
}

function classifyClaudeCodeFile(lowerName: string): ClassifiedArtifact {
  if (lowerName.includes("stdout.raw")) {
    return {
      category: "claude-code-raw",
      kind: "claude-code-stdout-raw",
      label: "Claude Code stdout (raw)",
      mimeType: "application/octet-stream",
    };
  }
  if (lowerName.includes("stderr.raw")) {
    return {
      category: "claude-code-raw",
      kind: "claude-code-stderr-raw",
      label: "Claude Code stderr (raw)",
      mimeType: "application/octet-stream",
    };
  }
  if (lowerName.includes("events.normalized")) {
    return {
      category: "claude-code-normalized",
      kind: "claude-code-events-normalized",
      label: "Claude Code normalized events",
      mimeType: "application/x-ndjson",
    };
  }
  if (lowerName.includes("adapter")) {
    return {
      category: "claude-code-adapter",
      kind: "claude-code-adapter",
      label: "Claude Code adapter metadata",
      mimeType: "application/json",
    };
  }
  return {
    category: "claude-code-final",
    kind: lowerName.includes("progress") ? "claude-code-progress" : "claude-code-final",
    label: lowerName.includes("progress")
      ? "Claude Code visible progress"
      : "Claude Code final answer",
    mimeType: "text/markdown",
  };
}

function isClaudeCodeArtifactName(lowerName: string): boolean {
  return lowerName.startsWith("claude-code-");
}

function isPerfTraceName(lowerName: string): boolean {
  return (
    lowerName.endsWith(".json") &&
    (lowerName.includes("perf-trace") ||
      lowerName.includes("oracle-perf") ||
      lowerName.includes("performance-trace"))
  );
}

function isDiagnosticName(lowerName: string): boolean {
  return (
    lowerName.includes("diagnostic") ||
    lowerName.endsWith(".dom.json") ||
    lowerName.includes("assistant-timeout") ||
    lowerName.includes("assistant-recheck") ||
    lowerName.includes("model-picker") ||
    lowerName.endsWith(".har")
  );
}

function isReportName(lowerName: string): boolean {
  if (lowerName === "deep-research-report.md" || lowerName.includes("deep-research-report")) {
    return true;
  }
  return (
    lowerName.includes("report") &&
    (lowerName.endsWith(".md") ||
      lowerName.endsWith(".pdf") ||
      lowerName.endsWith(".html") ||
      lowerName.endsWith(".txt"))
  );
}

function diagnosticLabel(lowerName: string): string {
  if (lowerName.endsWith(".dom.json")) {
    return "DOM diagnostic";
  }
  if (lowerName.endsWith(".png")) {
    return "Screenshot diagnostic";
  }
  if (lowerName.endsWith(".har")) {
    return "Network diagnostic";
  }
  return "Diagnostic";
}

function imageMimeType(extension: string): string | undefined {
  switch (extension) {
    case ".avif":
      return "image/avif";
    case ".gif":
      return "image/gif";
    case ".jpeg":
    case ".jpg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".svg":
      return "image/svg+xml";
    case ".webp":
      return "image/webp";
    default:
      return undefined;
  }
}

function mergeEntry(
  entries: Map<string, SessionArtifactIndexEntry>,
  incoming: SessionArtifactIndexEntry,
): void {
  const key = artifactKey(incoming.path);
  const existing = entries.get(key);
  if (!existing) {
    entries.set(key, incoming);
    return;
  }
  const preferred = preferEntry(existing, incoming);
  const secondary = preferred === existing ? incoming : existing;
  entries.set(key, {
    ...preferred,
    exists: existing.exists || incoming.exists,
    sizeBytes: preferred.sizeBytes ?? secondary.sizeBytes,
    sha256: preferred.sha256 ?? secondary.sha256,
    mimeType: preferred.mimeType ?? secondary.mimeType,
    warnings: dedupeOptionalStrings([...(preferred.warnings ?? []), ...(secondary.warnings ?? [])]),
  });
}

function preferEntry(
  existing: SessionArtifactIndexEntry,
  incoming: SessionArtifactIndexEntry,
): SessionArtifactIndexEntry {
  if (existing.source === "discovered" && incoming.source !== "discovered") {
    return incoming;
  }
  if (existing.category === "other" && incoming.category !== "other") {
    return incoming;
  }
  return existing;
}

function artifactKey(artifactPath: string): string {
  const normalized = isWindowsAbsolutePath(artifactPath)
    ? artifactPath.replace(/\\/g, "/")
    : path.resolve(artifactPath);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

async function readArtifactStats(
  artifactPath: string,
): Promise<{ exists: boolean; sizeBytes?: number; warnings: string[] }> {
  if (
    isLikelyUrl(artifactPath) ||
    (isWindowsAbsolutePath(artifactPath) && process.platform !== "win32")
  ) {
    return { exists: false, warnings: ["artifact path is not on this host"] };
  }
  try {
    const stat = await fs.lstat(artifactPath);
    if (stat.isSymbolicLink()) {
      return { exists: true, warnings: ["artifact path is a symlink"] };
    }
    if (!stat.isFile()) {
      return { exists: true, warnings: ["artifact path is not a regular file"] };
    }
    return { exists: true, sizeBytes: stat.size, warnings: [] };
  } catch (error) {
    const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
    if (code === "ENOENT") {
      return { exists: false, warnings: ["artifact file is missing"] };
    }
    return { exists: false, warnings: [`artifact stat failed: ${formatError(error)}`] };
  }
}

function normalizeArtifactPath(artifactPath: string, sessionDir: string): string {
  const trimmed = artifactPath.trim();
  if (isLikelyUrl(trimmed) || isWindowsAbsolutePath(trimmed)) {
    return trimmed;
  }
  return path.isAbsolute(trimmed) ? path.normalize(trimmed) : path.resolve(sessionDir, trimmed);
}

function deriveOracleHomeDir(sessionDir: string): string | undefined {
  const parent = path.basename(path.dirname(sessionDir));
  if (parent === "sessions") {
    return path.dirname(path.dirname(sessionDir));
  }
  return undefined;
}

function isPathInside(candidate: string, root: string): boolean {
  const relativePath = path.relative(path.resolve(root), path.resolve(candidate));
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function redactPathForDisplay(value: string): string {
  return value
    .split("/")
    .map((segment) =>
      segment
        .replace(SECRET_ASSIGNMENT_PATTERN, "$1=[redacted]")
        .replace(BEARER_TOKEN_PATTERN, "Bearer [redacted]")
        .replace(SECRET_TOKEN_PATTERN, "[redacted]"),
    )
    .join("/");
}

function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}

function isLikelyUrl(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value);
}

function isWindowsAbsolutePath(value: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith("\\\\");
}

function basenameAnyPlatform(value: string): string {
  const winBase = path.win32.basename(value);
  const posixBase = path.posix.basename(value);
  return winBase.length < posixBase.length ? winBase : posixBase;
}

function claudeCodeLabelForKind(kind: string): string {
  switch (kind) {
    case "claude-code-stdout-raw":
      return "Claude Code stdout (raw)";
    case "claude-code-stderr-raw":
      return "Claude Code stderr (raw)";
    case "claude-code-events-normalized":
      return "Claude Code normalized events";
    case "claude-code-final":
      return "Claude Code final answer";
    case "claude-code-progress":
      return "Claude Code visible progress";
    case "claude-code-adapter":
      return "Claude Code adapter metadata";
    default:
      return kind;
  }
}

function compareEntries(a: SessionArtifactIndexEntry, b: SessionArtifactIndexEntry): number {
  const category = CATEGORY_ORDER[a.category] - CATEGORY_ORDER[b.category];
  if (category !== 0) {
    return category;
  }
  return a.displayPath.localeCompare(b.displayPath);
}

function dedupeOptionalStrings(values: string[]): string[] | undefined {
  const deduped = dedupeStrings(values);
  return deduped.length > 0 ? deduped : undefined;
}

function dedupeStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

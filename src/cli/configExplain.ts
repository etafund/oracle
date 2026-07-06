import fs from "node:fs/promises";
import JSON5 from "json5";

import {
  DEFAULT_USER_CONFIG,
  loadUserConfig,
  sanitizeProjectConfig,
  type UserConfig,
} from "../config.js";

export const ORACLE_CONFIG_EXPLAIN_SCHEMA_VERSION = "oracle_config_explain.v1" as const;
export const REDACTED_CONFIG_VALUE = "[redacted]" as const;

export type ConfigExplainSourceKind = "default" | "user" | "project" | "env" | "unknown";

export interface ConfigExplainSource {
  readonly kind: ConfigExplainSourceKind;
  readonly path?: string;
  readonly env?: string;
}

export interface ConfigExplainFile {
  readonly kind: "user" | "project";
  readonly path: string;
  readonly loaded: boolean;
}

export interface ConfigExplainEntry {
  readonly path: string;
  readonly value: unknown;
  readonly source: ConfigExplainSource;
}

export interface IgnoredProjectConfigKey {
  readonly path: string;
  readonly key_path: string;
  readonly reason: "project_config_disallowed" | "invalid_or_untrusted_chatgpt_url" | "superseded";
}

export interface ConfigExplainReport {
  readonly schema_version: typeof ORACLE_CONFIG_EXPLAIN_SCHEMA_VERSION;
  readonly generated_at: string;
  readonly cwd: string;
  readonly user_config_path: string;
  readonly user_config_loaded: boolean;
  readonly include_project: boolean;
  readonly files: readonly ConfigExplainFile[];
  readonly loaded_paths: readonly string[];
  readonly effective_config: Record<string, unknown>;
  readonly entries: readonly ConfigExplainEntry[];
  readonly ignored_project_keys: readonly IgnoredProjectConfigKey[];
  readonly redaction: {
    readonly placeholder: typeof REDACTED_CONFIG_VALUE;
    readonly redacted_paths: readonly string[];
  };
}

export interface ConfigExplainOptions {
  readonly cwd?: string;
  readonly includeProject?: boolean;
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: Date;
}

export interface ConfigExplainCommandOptions extends ConfigExplainOptions {
  readonly json?: boolean;
}

export interface ConfigExplainCommandIo {
  readonly stdout?: (text: string) => void;
}

type JsonObject = Record<string, unknown>;

interface ParsedLoadedConfig {
  readonly path: string;
  readonly config: UserConfig;
}

const SECRET_ASSIGNMENT_PATTERN =
  /\b([A-Za-z0-9_.-]*(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|token|secret|cookie)[A-Za-z0-9_.-]*)=([^;&\s]+)/gi;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const BASIC_PATTERN = /\bBasic\s+[A-Za-z0-9+/]{8,}={0,2}/gi;
const OPENAI_KEY_PATTERN = /\bsk-(?:proj-|ant-|or-)?[A-Za-z0-9_-]{8,}\b/g;
const XAI_KEY_PATTERN = /\bxai-[A-Za-z0-9_-]{8,}\b/g;
const GEMINI_KEY_PATTERN = /\bAIza[0-9A-Za-z_-]{8,}\b/g;
const URL_USERINFO_PATTERN = /(\/\/[^/\s@]*:)[^@/\s]+(@)/g;
const URL_LEADING_USERINFO_PATTERN = /^([a-z][a-z0-9+.-]*:\/\/)[^/@\s]*@/i;

export async function buildConfigExplainReport(
  options: ConfigExplainOptions = {},
): Promise<ConfigExplainReport> {
  const cwd = options.cwd ?? process.cwd();
  const includeProject = options.includeProject ?? true;
  const env = options.env ?? process.env;
  const now = options.now ?? new Date();
  const loaded = await loadUserConfig({ cwd, includeProject, env });
  const parsedConfigs = await readLoadedConfigs(loaded.paths);
  const userPath = loaded.path;
  const sourceByPath = new Map<string, ConfigExplainSource>();

  annotateSource(sourceByPath, DEFAULT_USER_CONFIG, { kind: "default" });

  const ignoredProjectKeys: IgnoredProjectConfigKey[] = [];
  const files: ConfigExplainFile[] = [];
  for (const parsed of parsedConfigs) {
    if (parsed.path === userPath) {
      files.push({ kind: "user", path: parsed.path, loaded: true });
      annotateSource(sourceByPath, parsed.config, { kind: "user", path: parsed.path });
      continue;
    }

    files.push({ kind: "project", path: parsed.path, loaded: true });
    const sanitized = sanitizeProjectConfig(parsed.config);
    ignoredProjectKeys.push(...findIgnoredProjectKeys(parsed.path, parsed.config, sanitized));
    annotateSource(sourceByPath, sanitized, { kind: "project", path: parsed.path });
  }

  if (!loaded.paths.includes(userPath)) {
    files.unshift({ kind: "user", path: userPath, loaded: false });
  }

  annotateEnvSources(sourceByPath, env);

  const redactedPaths = new Set<string>();
  const effectiveConfig = redactConfigValue(loaded.config, "", redactedPaths) as JsonObject;
  const entries = flattenJsonLeaves(effectiveConfig)
    .map(([entryPath, value]) => ({
      path: entryPath,
      value,
      source: sourceByPath.get(entryPath) ?? { kind: "unknown" as const },
    }))
    .sort((a, b) => compareStrings(a.path, b.path));

  return {
    schema_version: ORACLE_CONFIG_EXPLAIN_SCHEMA_VERSION,
    generated_at: now.toISOString(),
    cwd,
    user_config_path: userPath,
    user_config_loaded: loaded.loaded,
    include_project: includeProject,
    files,
    loaded_paths: loaded.paths,
    effective_config: effectiveConfig,
    entries,
    ignored_project_keys: ignoredProjectKeys.sort(compareIgnoredKeys),
    redaction: {
      placeholder: REDACTED_CONFIG_VALUE,
      redacted_paths: [...redactedPaths].sort(compareStrings),
    },
  };
}

export async function runConfigExplain(
  options: ConfigExplainCommandOptions = {},
  io: ConfigExplainCommandIo = {},
): Promise<ConfigExplainReport> {
  const report = await buildConfigExplainReport(options);
  const write = io.stdout ?? ((text: string) => process.stdout.write(text));
  write(options.json ? formatConfigExplainJson(report) : formatConfigExplainHuman(report));
  return report;
}

export function formatConfigExplainJson(report: ConfigExplainReport): string {
  return `${stableJsonStringify(report)}\n`;
}

export function formatConfigExplainHuman(report: ConfigExplainReport): string {
  const lines: string[] = [];
  lines.push("🧿 oracle config explain");
  lines.push(`cwd: ${report.cwd}`);
  lines.push("");
  lines.push("Files:");
  for (const file of report.files) {
    const status = file.loaded ? "loaded" : "missing";
    lines.push(`  ${file.kind}: ${file.path} (${status})`);
  }

  lines.push("");
  lines.push("Effective config:");
  for (const entry of report.entries) {
    lines.push(`  ${entry.path}: ${formatHumanValue(entry.value)} (${formatSource(entry.source)})`);
  }

  if (report.ignored_project_keys.length > 0) {
    lines.push("");
    lines.push("Ignored project config keys:");
    for (const ignored of report.ignored_project_keys) {
      lines.push(`  ${ignored.key_path} (${ignored.reason}, ${ignored.path})`);
    }
  }

  if (report.redaction.redacted_paths.length > 0) {
    lines.push("");
    lines.push(`Redacted paths: ${report.redaction.redacted_paths.join(", ")}`);
  }

  lines.push("");
  return `${lines.join("\n")}\n`;
}

async function readLoadedConfigs(paths: readonly string[]): Promise<ParsedLoadedConfig[]> {
  const parsed: ParsedLoadedConfig[] = [];
  for (const configPath of paths) {
    const raw = await fs.readFile(configPath, "utf8");
    const value = JSON5.parse(raw);
    if (!isRecord(value)) continue;
    parsed.push({ path: configPath, config: value as UserConfig });
  }
  return parsed;
}

function annotateSource(
  sourceByPath: Map<string, ConfigExplainSource>,
  config: UserConfig,
  source: ConfigExplainSource,
): void {
  for (const [configPath] of flattenJsonLeaves(config)) {
    sourceByPath.set(configPath, source);
  }
}

function annotateEnvSources(
  sourceByPath: Map<string, ConfigExplainSource>,
  env: NodeJS.ProcessEnv,
): void {
  const engine = normalizeEngine(env.ORACLE_ENGINE);
  if (engine) {
    sourceByPath.set("engine", { kind: "env", env: "ORACLE_ENGINE" });
  }

  if (normalizeOptionalString(env.ORACLE_REMOTE_HOST)) {
    sourceByPath.set("browser.remoteHost", { kind: "env", env: "ORACLE_REMOTE_HOST" });
  }

  if (normalizeOptionalString(env.ORACLE_REMOTE_TOKEN)) {
    sourceByPath.set("browser.remoteToken", { kind: "env", env: "ORACLE_REMOTE_TOKEN" });
  }
}

function findIgnoredProjectKeys(
  projectPath: string,
  rawConfig: UserConfig,
  sanitizedConfig: UserConfig,
): IgnoredProjectConfigKey[] {
  const rawLeaves = new Map(flattenJsonLeaves(rawConfig));
  const sanitizedLeaves = new Map(flattenJsonLeaves(sanitizedConfig));
  const ignored: IgnoredProjectConfigKey[] = [];

  for (const [keyPath, value] of rawLeaves) {
    if (!sanitizedLeaves.has(keyPath)) {
      ignored.push({
        path: projectPath,
        key_path: keyPath,
        reason: classifyIgnoredProjectKey(keyPath),
      });
      continue;
    }

    if (keyPath === "browser.url" && rawConfig.browser?.chatgptUrl !== undefined) {
      const retained = sanitizedLeaves.get(keyPath);
      if (retained !== value) {
        ignored.push({
          path: projectPath,
          key_path: keyPath,
          reason: "superseded",
        });
      }
    }
  }

  return ignored;
}

function classifyIgnoredProjectKey(keyPath: string): IgnoredProjectConfigKey["reason"] {
  return keyPath === "browser.chatgptUrl" || keyPath === "browser.url"
    ? "invalid_or_untrusted_chatgpt_url"
    : "project_config_disallowed";
}

function redactConfigValue(value: unknown, path: string, redactedPaths: Set<string>): unknown {
  if (path && isSensitivePath(path)) {
    redactedPaths.add(path);
    return REDACTED_CONFIG_VALUE;
  }

  if (typeof value === "string") {
    const redacted = redactSecretShapedString(redactUrlUserinfo(value));
    if (redacted !== value && path) {
      redactedPaths.add(path);
    }
    return redacted;
  }

  if (Array.isArray(value)) {
    return value.map((entry, index) =>
      redactConfigValue(entry, `${path}[${index}]`, redactedPaths),
    );
  }

  if (!isRecord(value)) {
    return value;
  }

  const out: JsonObject = {};
  for (const [key, entryValue] of Object.entries(value)) {
    const entryPath = path ? `${path}.${key}` : key;
    const redacted = redactConfigValue(entryValue, entryPath, redactedPaths);
    if (redacted !== undefined) {
      out[key] = redacted;
    }
  }
  return out;
}

function redactSecretShapedString(value: string): string {
  return value
    .replace(URL_USERINFO_PATTERN, "$1[redacted]$2")
    .replace(BEARER_PATTERN, "Bearer [redacted]")
    .replace(BASIC_PATTERN, "Basic [redacted]")
    .replace(OPENAI_KEY_PATTERN, "sk-...[redacted]")
    .replace(XAI_KEY_PATTERN, "xai-...[redacted]")
    .replace(GEMINI_KEY_PATTERN, "AIza...[redacted]")
    .replace(SECRET_ASSIGNMENT_PATTERN, "$1=[redacted]");
}

function redactUrlUserinfo(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return value;
  }
  if (parsed.username.length === 0 && parsed.password.length === 0) {
    return value;
  }
  const replaced = value.replace(
    URL_LEADING_USERINFO_PATTERN,
    `$1${REDACTED_CONFIG_VALUE}@`,
  );
  // If the userinfo could not be located textually, fail closed rather than
  // printing a value known to carry credentials.
  return replaced === value ? REDACTED_CONFIG_VALUE : replaced;
}

function isSensitivePath(path: string): boolean {
  const segment = path
    .replace(/\[[0-9]+\]/g, "")
    .split(".")
    .at(-1);
  if (!segment) return false;
  const normalized = segment.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
  return (
    normalized.endsWith("token") ||
    normalized.endsWith("secret") ||
    normalized === "password" ||
    normalized.endsWith("password") ||
    normalized === "passphrase" ||
    normalized.endsWith("apikey") ||
    normalized === "authorization" ||
    normalized.endsWith("authorization") ||
    normalized === "authheader" ||
    normalized === "authheaders" ||
    normalized === "cookie" ||
    normalized === "cookies" ||
    normalized.endsWith("cookiepath") ||
    normalized === "inlinecookies"
  );
}

function flattenJsonLeaves(value: unknown, prefix = ""): Array<[string, unknown]> {
  if (isRecord(value)) {
    const entries = Object.entries(value).filter(([, entryValue]) => entryValue !== undefined);
    if (entries.length > 0) {
      return entries.flatMap(([key, entryValue]) =>
        flattenJsonLeaves(entryValue, prefix ? `${prefix}.${key}` : key),
      );
    }
  }

  return prefix ? [[prefix, value]] : [];
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeEngine(value: unknown): string | undefined {
  const normalized = normalizeOptionalString(value)?.toLowerCase();
  return normalized === "api" || normalized === "browser" || normalized === "claude-code"
    ? normalized
    : undefined;
}

function formatHumanValue(value: unknown): string {
  if (value === REDACTED_CONFIG_VALUE) return REDACTED_CONFIG_VALUE;
  if (typeof value === "string") return JSON.stringify(value);
  return JSON.stringify(value);
}

function formatSource(source: ConfigExplainSource): string {
  if (source.kind === "default") return "default";
  if (source.kind === "env") return `env ${source.env ?? "unknown"}`;
  if (source.path) return `${source.kind} ${source.path}`;
  return source.kind;
}

function stableJsonStringify(value: unknown): string {
  return JSON.stringify(sortJsonValue(value), null, 2);
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sortJsonValue(entry));
  }
  if (!isRecord(value)) {
    return value;
  }
  return Object.keys(value)
    .sort(compareStrings)
    .reduce<JsonObject>((acc, key) => {
      const sortedValue = sortJsonValue(value[key]);
      if (sortedValue !== undefined) {
        acc[key] = sortedValue;
      }
      return acc;
    }, {});
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function compareIgnoredKeys(a: IgnoredProjectConfigKey, b: IgnoredProjectConfigKey): number {
  return compareStrings(a.path, b.path) || compareStrings(a.key_path, b.key_path);
}

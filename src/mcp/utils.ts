import path from "node:path";
import type { RunOracleOptions } from "../oracle.js";
import type { EngineMode } from "../cli/engine.js";
import type { UserConfig } from "../config.js";
import { resolveRunOptionsFromConfig } from "../cli/runOptions.js";
import { getOracleHomeDir } from "../oracleHome.js";
import { Launcher } from "chrome-launcher";

const ALLOW_EXTERNAL_OUTPUT_ENV = "ORACLE_MCP_ALLOW_EXTERNAL_OUTPUT";

/**
 * Whether MCP callers may write generated images / saved responses outside the
 * Oracle home directory. Off by default: MCP clients are less trusted than the
 * CLI user, so an agent must not be able to write to arbitrary host paths.
 */
export function isExternalMcpOutputAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[ALLOW_EXTERNAL_OUTPUT_ENV]?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

/**
 * Constrain an MCP-supplied output path to the Oracle home directory and return
 * its resolved absolute form. `path.resolve` collapses `..`, so traversal
 * escapes are rejected by the prefix check. Set ORACLE_MCP_ALLOW_EXTERNAL_OUTPUT
 * to opt into writing outside the Oracle home as an explicit decision.
 */
export function resolveMcpOutputPath(
  requestedPath: string,
  field: "generateImage" | "outputPath",
  env: NodeJS.ProcessEnv = process.env,
): string {
  const resolved = path.resolve(requestedPath);
  if (isExternalMcpOutputAllowed(env)) {
    return resolved;
  }
  const root = path.resolve(getOracleHomeDir());
  if (resolved === root || resolved.startsWith(`${root}${path.sep}`)) {
    return resolved;
  }
  throw new Error(
    `MCP "${field}" must resolve under the Oracle home directory (${root}); got "${resolved}". ` +
      `Use a path under that directory, or set ${ALLOW_EXTERNAL_OUTPUT_ENV}=1 to allow external output paths.`,
  );
}

export function mapConsultToRunOptions({
  prompt,
  files,
  model,
  models,
  engine,
  search,
  browserAttachments,
  browserBundleFiles,
  browserBundleFormat,
  browserFollowUps,
  generateImage,
  outputPath,
  userConfig,
  env = process.env,
}: {
  prompt: string;
  files: string[];
  model?: string;
  models?: string[];
  engine?: EngineMode;
  search?: boolean;
  browserAttachments?: "auto" | "never" | "always";
  browserBundleFiles?: boolean;
  browserBundleFormat?: "text" | "zip";
  browserFollowUps?: string[];
  generateImage?: string;
  outputPath?: string;
  userConfig?: UserConfig;
  env?: NodeJS.ProcessEnv;
}): { runOptions: RunOracleOptions; resolvedEngine: EngineMode } {
  // Normalize CLI-style inputs through the shared resolver so config/env defaults apply,
  // then overlay MCP-only overrides such as explicit search toggles.
  const mergedModels =
    Array.isArray(models) && models.length > 0
      ? [model, ...models].filter((entry): entry is string => Boolean(entry?.trim()))
      : models;
  const result = resolveRunOptionsFromConfig({
    prompt,
    files,
    model,
    models: mergedModels,
    engine,
    userConfig,
    env,
  });
  if (typeof search === "boolean") {
    result.runOptions.search = search;
  }
  if (browserAttachments) {
    result.runOptions.browserAttachments = browserAttachments;
  }
  if (typeof browserBundleFiles === "boolean") {
    result.runOptions.browserBundleFiles = browserBundleFiles;
  }
  if (browserBundleFormat) {
    result.runOptions.browserBundleFormat = browserBundleFormat;
  }
  if (Array.isArray(browserFollowUps)) {
    result.runOptions.browserFollowUps = browserFollowUps
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  const imageOutputPath = generateImage?.trim();
  if (imageOutputPath) {
    result.runOptions.generateImage = resolveMcpOutputPath(imageOutputPath, "generateImage", env);
  }
  const secondaryOutputPath = outputPath?.trim();
  if (secondaryOutputPath) {
    result.runOptions.outputPath = resolveMcpOutputPath(secondaryOutputPath, "outputPath", env);
  }
  return result;
}

export function ensureBrowserAvailable(
  engine: EngineMode,
  options?: { remoteHost?: string | null },
): string | null {
  if (engine !== "browser") {
    return null;
  }
  const remoteHost = options?.remoteHost?.trim() || process.env.ORACLE_REMOTE_HOST?.trim();
  if (remoteHost) {
    return null;
  }
  if (process.env.CHROME_PATH) {
    return null;
  }
  const found = Launcher.getFirstInstallation();
  if (!found) {
    return "Browser engine unavailable: no Chrome installation found and CHROME_PATH is unset.";
  }
  return null;
}

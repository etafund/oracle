import chalk from "chalk";
import type { Command, OptionValues } from "commander";
import { usesDefaultStatusFilters } from "./options.js";
import {
  attachSession,
  showStatus,
  type AttachSessionOptions,
  type ShowStatusOptions,
} from "./sessionDisplay.js";
import {
  harvestSessionBrowserOutput,
  liveTailSessionBrowserOutput,
  type BrowserHarvestOptions,
  type BrowserLiveTailOptions,
} from "./browserTabs.js";
import {
  buildSessionArtifactIndex,
  type BuildSessionArtifactIndexOptions,
  type SessionArtifactIndex,
} from "../sessionArtifacts.js";
import { sessionStore } from "../sessionStore.js";
import {
  runSessionListJson,
  type BuildSessionListOptions,
  type SessionListEnvelopeResult,
} from "./sessionListJson.js";

export interface StatusOptions extends OptionValues {
  hours: number;
  limit: number;
  all: boolean;
  clear?: boolean;
  clean?: boolean;
  render?: boolean;
  renderMarkdown?: boolean;
  path?: boolean;
  verboseRender?: boolean;
  hidePrompt?: boolean;
  model?: string;
  harvest?: boolean;
  live?: boolean;
  writeOutput?: string;
  writeOutputPath?: string;
  browserTab?: string;
  browserTabRef?: string;
  browserTabs?: boolean;
  artifacts?: boolean;
  json?: boolean;
}

interface SessionCommandDependencies {
  showStatus: (options: ShowStatusOptions) => Promise<void> | void;
  attachSession: (sessionId: string, options?: AttachSessionOptions) => Promise<void>;
  harvestSessionBrowserOutput: (
    sessionId: string,
    options?: BrowserHarvestOptions,
  ) => Promise<unknown>;
  liveTailSessionBrowserOutput: (
    sessionId: string,
    options?: BrowserLiveTailOptions,
  ) => Promise<unknown>;
  usesDefaultStatusFilters: (cmd: Command) => boolean;
  deleteSessionsOlderThan: (options?: {
    hours?: number;
    includeAll?: boolean;
  }) => Promise<{ deleted: number; remaining: number }>;
  getSessionPaths: (
    sessionId: string,
  ) => Promise<{ dir: string; metadata: string; log: string; request: string }>;
  buildSessionArtifactIndex: (
    options: BuildSessionArtifactIndexOptions,
  ) => Promise<SessionArtifactIndex>;
  runSessionListJson: (options?: BuildSessionListOptions) => Promise<SessionListEnvelopeResult>;
}

const defaultDependencies: SessionCommandDependencies = {
  showStatus,
  attachSession,
  harvestSessionBrowserOutput,
  liveTailSessionBrowserOutput,
  usesDefaultStatusFilters,
  deleteSessionsOlderThan: (options) => sessionStore.deleteOlderThan(options),
  getSessionPaths: (sessionId) => sessionStore.getPaths(sessionId),
  buildSessionArtifactIndex,
  runSessionListJson: (options) => runSessionListJson(options),
};

const SESSION_OPTION_KEYS = new Set([
  "hours",
  "limit",
  "all",
  "clear",
  "clean",
  "render",
  "renderMarkdown",
  "path",
  "model",
  "harvest",
  "live",
  "writeOutput",
  "browserTab",
  "artifacts",
  "json",
]);

export async function handleSessionCommand(
  sessionId: string | undefined,
  command: Command,
  deps: SessionCommandDependencies = defaultDependencies,
): Promise<void> {
  const sessionOptions = command.opts<StatusOptions>();
  const allOptions = (command.optsWithGlobals?.() as StatusOptions | undefined) ?? sessionOptions;
  const writeOutputPath =
    sessionOptions.writeOutput ??
    sessionOptions.writeOutputPath ??
    allOptions.writeOutput ??
    allOptions.writeOutputPath ??
    command.getOptionValue?.("writeOutput") ??
    command.getOptionValue?.("writeOutputPath");
  const browserTabRef =
    sessionOptions.browserTab ??
    sessionOptions.browserTabRef ??
    allOptions.browserTab ??
    allOptions.browserTabRef ??
    command.getOptionValue?.("browserTab") ??
    command.getOptionValue?.("browserTabRef");
  if (sessionOptions.verboseRender) {
    process.env.ORACLE_VERBOSE_RENDER = "1";
  }
  const renderSource = command.getOptionValueSource?.("render");
  const renderMarkdownSource = command.getOptionValueSource?.("renderMarkdown");
  const renderExplicit = renderSource === "cli" || renderMarkdownSource === "cli";
  const autoRender = !renderExplicit && process.stdout.isTTY;
  const pathRequested = Boolean(sessionOptions.path);
  const artifactsRequested = Boolean(sessionOptions.artifacts);
  const clearRequested = Boolean(sessionOptions.clear || sessionOptions.clean);
  if (clearRequested) {
    if (sessionId) {
      console.error(
        `Cannot combine a session ID with --clear. Drop the ID: oracle session --clear --hours ${sessionOptions.hours}`,
      );
      process.exitCode = 1;
      return;
    }
    const hours = sessionOptions.hours;
    const includeAll = sessionOptions.all;
    const result = await deps.deleteSessionsOlderThan({ hours, includeAll });
    const scope = includeAll ? "all stored sessions" : `sessions older than ${hours}h`;
    console.log(formatSessionCleanupMessage(result, scope));
    return;
  }
  if (sessionId === "clear" || sessionId === "clean") {
    console.error(
      'Session cleanup now uses --clear. Run "oracle session --clear --hours <n>" instead.',
    );
    process.exitCode = 1;
    return;
  }
  if (pathRequested) {
    if (!sessionId) {
      console.error(
        "The --path flag requires a session ID. Run: oracle session <sessionId> --path (find IDs via `oracle status --json`).",
      );
      process.exitCode = 1;
      return;
    }
    try {
      const paths = await deps.getSessionPaths(sessionId);
      const richTty = Boolean(process.stdout.isTTY && chalk.level > 0);
      const label = (text: string): string => (richTty ? chalk.cyan(text) : text);
      const value = (text: string): string => (richTty ? chalk.dim(text) : text);
      console.log(`${label("Session dir:")} ${value(paths.dir)}`);
      console.log(`${label("Metadata:")} ${value(paths.metadata)}`);
      console.log(`${label("Request:")} ${value(paths.request)}`);
      console.log(`${label("Log:")} ${value(paths.log)}`);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
    return;
  }
  if (artifactsRequested) {
    if (!sessionId) {
      console.error("The --artifacts flag requires a session ID.");
      process.exitCode = 1;
      return;
    }
    try {
      const paths = await deps.getSessionPaths(sessionId);
      const index = await deps.buildSessionArtifactIndex({
        sessionDir: paths.dir,
        cwd: process.cwd(),
      });
      if (sessionOptions.json || allOptions.json) {
        console.log(JSON.stringify(index, null, 2));
      } else {
        console.log(formatSessionArtifactIndex(index));
      }
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
    return;
  }
  const harvestRequested = Boolean(sessionOptions.harvest);
  const liveRequested = Boolean(sessionOptions.live);
  if (harvestRequested && liveRequested) {
    console.error(
      "Cannot combine --harvest and --live. Choose one: oracle session <sessionId> --harvest, or oracle session <sessionId> --live",
    );
    process.exitCode = 1;
    return;
  }
  if (writeOutputPath && !harvestRequested && !liveRequested) {
    console.error(
      `The --write-output flag requires --harvest or --live. Run: oracle session <sessionId> --harvest --write-output ${writeOutputPath} (or --live instead of --harvest)`,
    );
    process.exitCode = 1;
    return;
  }
  if (harvestRequested || liveRequested) {
    if (!sessionId) {
      const flag = harvestRequested ? "--harvest" : "--live";
      console.error(
        `The ${flag} flag requires a session ID. Run: oracle session <sessionId> ${flag} (find IDs via \`oracle status --json\`).`,
      );
      process.exitCode = 1;
      return;
    }
    // Commander sets `recover: false` when --no-recover is passed; default is `true`.
    const recoverIfMissing = sessionOptions.recover !== false;
    if (harvestRequested) {
      await deps.harvestSessionBrowserOutput(sessionId, {
        writeOutputPath,
        browserTabRef,
        recoverIfMissing,
      });
      return;
    }
    await deps.liveTailSessionBrowserOutput(sessionId, {
      writeOutputPath,
      browserTabRef,
      recoverIfMissing,
    });
    return;
  }
  if (!sessionId) {
    const jsonRequested = Boolean(sessionOptions.json || allOptions.json);
    if (jsonRequested) {
      await deps.runSessionListJson({
        hours: sessionOptions.all ? Infinity : sessionOptions.hours,
        includeAll: sessionOptions.all,
        limit: sessionOptions.limit,
        modelFilter: sessionOptions.model,
      });
      return;
    }
    const showExamples = deps.usesDefaultStatusFilters(command);
    await deps.showStatus({
      hours: sessionOptions.all ? Infinity : sessionOptions.hours,
      includeAll: sessionOptions.all,
      limit: sessionOptions.limit,
      showExamples,
      modelFilter: sessionOptions.model,
    });
    return;
  }
  // Surface any root-level flags that were provided but are ignored when attaching to a session.
  const ignoredFlags = listIgnoredFlags(command);
  if (ignoredFlags.length > 0) {
    console.log(`Ignoring flags on session attach: ${ignoredFlags.join(", ")}`);
  }
  const renderMarkdown = Boolean(
    sessionOptions.render || sessionOptions.renderMarkdown || autoRender,
  );
  await deps.attachSession(sessionId, {
    renderMarkdown,
    renderPrompt: !sessionOptions.hidePrompt,
    model: sessionOptions.model,
  });
}

export function formatSessionCleanupMessage(
  result: { deleted: number; remaining: number },
  scope: string,
): string {
  const deletedLabel = `${result.deleted} ${result.deleted === 1 ? "session" : "sessions"}`;
  const remainingLabel = `${result.remaining} ${result.remaining === 1 ? "session" : "sessions"} remain`;
  const hint = 'Run "oracle session --clear --all" to delete everything.';
  return `Deleted ${deletedLabel} (${scope}). ${remainingLabel}.\n${hint}`;
}

export function formatSessionArtifactIndex(index: SessionArtifactIndex): string {
  const lines: string[] = [];
  lines.push(`🧿 oracle session artifacts ${index.sessionId}`);
  lines.push(`session_dir: ${index.displaySessionDir}`);
  lines.push(`metadata: ${index.metadataStatus}`);
  if (index.warnings.length > 0) {
    lines.push("");
    lines.push("Warnings:");
    for (const warning of index.warnings) {
      lines.push(`  - ${warning}`);
    }
  }
  lines.push("");
  lines.push("Artifacts:");
  if (index.entries.length === 0) {
    lines.push("  (none)");
  } else {
    for (const entry of index.entries) {
      const status = entry.exists ? "ok" : "missing";
      const size = entry.sizeBytes === undefined ? "" : ` ${entry.sizeBytes}b`;
      lines.push(`  - ${entry.displayPath} [${entry.category}/${entry.kind}] ${status}${size}`);
      if (entry.warnings?.length) {
        for (const warning of entry.warnings) {
          lines.push(`      warning: ${warning}`);
        }
      }
    }
  }
  return lines.join("\n");
}

function listIgnoredFlags(command: Command): string[] {
  const opts = command.optsWithGlobals() as Record<string, unknown>;
  const ignored: string[] = [];
  for (const key of Object.keys(opts)) {
    if (SESSION_OPTION_KEYS.has(key)) {
      continue;
    }
    const source = command.getOptionValueSource?.(key);
    if (source !== "cli" && source !== "env") {
      continue;
    }
    const value = opts[key];
    if (value === undefined || value === false || value === null) {
      continue;
    }
    ignored.push(key);
  }
  return ignored;
}

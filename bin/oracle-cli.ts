#!/usr/bin/env node
import "dotenv/config";
import { fileURLToPath } from "node:url";
import { readFile as readPromptFile } from "node:fs/promises";
import { Command, InvalidArgumentError, Option } from "commander";
import type { OptionValues } from "commander";
// Allow `npx @steipete/oracle oracle-mcp` to resolve the MCP server even though npx runs the default binary.
if (process.argv[2] === "oracle-mcp") {
  const { startMcpServer } = await import("../src/mcp/server.js");
  await startMcpServer();
  process.exit(0);
}
import { resolveEngine, type EngineMode, defaultWaitPreference } from "../src/cli/engine.js";
import { shouldRequirePrompt } from "../src/cli/promptRequirement.js";
import { resolveDashPrompt } from "../src/cli/stdin.js";
import chalk from "chalk";
import type { SessionMetadata, SessionMode, BrowserSessionConfig } from "../src/sessionStore.js";
import { sessionStore, pruneOldSessions } from "../src/sessionStore.js";
import { DEFAULT_MODEL, MODEL_CONFIGS } from "../src/oracle/config.js";
import { isKnownModel, resolveOverriddenApiModel } from "../src/oracle/modelResolver.js";
import type {
  ApiProviderMode,
  ModelName,
  ModelOverridesConfig,
  PreviewMode,
  RunOracleOptions,
} from "../src/oracle/types.js";
import { CHATGPT_URL } from "../src/browser/constants.js";
import { applyHelpStyling } from "../src/cli/help.js";
import {
  buildTopLevelCliErrorEnvelope,
  buildTopLevelCliSuccessEnvelope,
  isJsonModeRequested,
  stableJsonStringify,
} from "../src/cli/errorEnvelope.js";
import {
  buildSessionActionEnvelope,
  renderSessionActionEnvelope,
  type BuildSessionActionInput,
} from "../src/cli/sessionActionJson.js";
import {
  collectPaths,
  collectModelList,
  collectTextValues,
  parseFloatOption,
  parseIntOption,
  parseSearchOption,
  parseThinkingTimeOption,
  usesDefaultStatusFilters,
  resolvePreviewMode,
  normalizeModelOption,
  normalizeBaseUrl,
  resolveApiModel,
  inferModelFromLabel,
  parseHeartbeatOption,
  parseTimeoutOption,
  parseDurationOption,
  parseGeminiDeepThinkEvidenceOption,
  parseGeminiDeepThinkFallbackOption,
  mergePathLikeOptions,
  dedupePathInputs,
  isGeminiDeepThinkModelAlias,
} from "../src/cli/options.js";
import { copyToClipboard } from "../src/cli/clipboard.js";
import { buildMarkdownBundle } from "../src/cli/markdownBundle.js";
import { shouldDetachSession, shouldLaunchDetachedSessionFinalizer } from "../src/cli/detach.js";
import { applyHiddenAliases } from "../src/cli/hiddenAliases.js";
import type { BrowserSessionRunnerDeps } from "../src/browser/sessionRunner.js";
import { isRawUploadFile } from "../src/browser/prompt.js";
import { formatCompactNumber } from "../src/cli/format.js";
import { formatIntroLine } from "../src/cli/tagline.js";
import { warnIfOversizeBundle } from "../src/cli/bundleWarnings.js";
import { formatRenderedMarkdown } from "../src/cli/renderOutput.js";
import { resolveRenderFlag, resolveRenderPlain } from "../src/cli/renderFlags.js";
import { resolveGeminiModelId } from "../src/oracle/geminiModels.js";
import type { StatusOptions } from "../src/cli/sessionCommand.js";
import { isErrorLogged } from "../src/cli/errorUtils.js";
import { resolveOutputPath } from "../src/cli/writeOutputPath.js";
import { getCliVersion } from "../src/version.js";
import {
  resolveNotificationSettings,
  deriveNotificationSettingsFromMetadata,
  type NotificationSettings,
} from "../src/cli/notifier.js";
import { loadUserConfig, type UserConfig } from "../src/config.js";
import { shouldBlockDuplicatePrompt } from "../src/cli/duplicatePromptGuard.js";
import { resolveRemoteServiceConfig } from "../src/remote/remoteServiceConfig.js";
import { resolveConfiguredMaxFileSizeBytes } from "../src/cli/fileSize.js";
import { registerCliCommands } from "../src/cli/index.js";
import { listRobotCommands } from "../src/cli/robotRegistry.js";
import { registerEvidenceCommand } from "../src/cli/commands/evidence/index.js";
import {
  isAzureOpenAICandidateModel,
  validateProviderRouting,
} from "../src/oracle/providerRouting.js";
import { buildSessionLifecycle, formatSessionLifecycleBlock } from "../src/cli/sessionLifecycle.js";
import {
  buildDetachedPerfTraceEnv,
  createPerfTrace,
  isTraceValueFlag,
} from "../src/cli/perfTrace.js";
import {
  resolveBrowserFollowupReference,
  resolveClaudeCodeFollowupReference,
  assertClaudeCodeFollowupProfileMatchesRun,
  assertFollowupLaneMatchesResolvedLane,
} from "../src/cli/followup.js";
import {
  launchDetachedSessionFinalizer,
  launchDetachedSessionRunner,
} from "../src/cli/detachedSession.js";
import { isFableModel, resolveLanePolicy, type ResolvedOracleLane } from "../src/cli/lanePolicy.js";
import { LaneRouteBlockError, VALID_LANES, closestLane } from "../src/cli/routeBlockError.js";
import { nearestByEditDistance } from "../src/cli/didYouMean.js";

interface CliOptions extends OptionValues {
  prompt?: string;
  message?: string;
  promptFile?: string;
  file?: string[];
  maxFileSizeBytes?: number;
  include?: string[];
  files?: string[];
  path?: string[];
  paths?: string[];
  render?: boolean;
  lane?: string;
  model: string;
  models?: string[];
  force?: boolean;
  slug?: string;
  filesReport?: boolean;
  maxInput?: number;
  maxOutput?: number;
  system?: string;
  silent?: boolean;
  search?: boolean;
  preview?: boolean | string;
  previewMode?: PreviewMode;
  apiKey?: string;
  session?: string;
  execSession?: string;
  finalizeSession?: string;
  followup?: string;
  followupModel?: string;
  notify?: boolean;
  notifySound?: boolean;
  renderMarkdown?: boolean;
  sessionId?: string;
  engine?: EngineMode;
  browser?: boolean;
  timeout?: number | "auto";
  waitForLock?: number;
  claudeCodeExecutable?: string;
  background?: boolean;
  httpTimeout?: number;
  zombieTimeout?: number;
  zombieLastActivity?: boolean;
  browserChromeProfile?: string;
  browserChromePath?: string;
  browserCookiePath?: string;
  browserAttachRunning?: boolean;
  chatgptUrl?: string;
  browserUrl?: string;
  browserTimeout?: string;
  browserInputTimeout?: string;
  browserAttachmentTimeout?: string;
  browserProfileLockTimeout?: string;
  browserMaxConcurrentTabs?: string;
  browserCookieWait?: string;
  browserNoCookieSync?: boolean;
  browserInlineCookiesFile?: string;
  browserCookieNames?: string;
  browserInlineCookies?: string;
  browserHeadless?: boolean;
  browserHideWindow?: boolean;
  browserKeepBrowser?: boolean;
  browserTab?: string;
  browserModelStrategy?: "select" | "current" | "ignore";
  browserManualLogin?: boolean;
  browserManualLoginProfileDir?: string;
  copyProfile?: string;
  browserThinkingTime?: "light" | "standard" | "extended" | "heavy";
  browserArchive?: "auto" | "always" | "never";
  browserResearch?: "off" | "deep";
  browserFollowUp?: string[];
  browserAllowCookieErrors?: boolean;
  browserAttachments?: string;
  browserInlineFiles?: boolean;
  browserBundleFiles?: boolean;
  browserBundleFormat?: "auto" | "text" | "zip";
  remoteChrome?: string;
  browserPort?: number;
  browserDebugPort?: number;
  remoteHost?: string;
  remoteToken?: string;
  youtube?: string;
  generateImage?: string;
  editImage?: string;
  output?: string;
  aspect?: string;
  geminiShowThoughts?: boolean;
  geminiDeepThink?: boolean;
  deepThink?: boolean;
  geminiDeepThinkFallback?: string;
  evidence?: string;
  json?: boolean;
  copyMarkdown?: boolean;
  copy?: boolean;
  verbose?: boolean;
  debugHelp?: boolean;
  heartbeat?: number;
  status?: boolean;
  dryRun?: boolean;
  route?: boolean;
  preflight?: boolean;
  perfTrace?: boolean;
  perfTracePath?: string;
  // tri-state: `true` (forced wait), `false` (forced detach), `undefined` (auto)
  wait?: boolean;
  provider?: ApiProviderMode;
  baseUrl?: string;
  azure?: boolean;
  azureEndpoint?: string;
  azureDeployment?: string;
  azureApiVersion?: string;
  showModelId?: boolean;
  retainHours?: number;
  writeOutput?: string;
  writeOutputPath?: string;
  allowPartial?: boolean;
  partial?: "fail" | "ok";
}

type ResolvedCliOptions = Omit<CliOptions, "model"> & {
  model: ModelName;
  models?: ModelName[];
  effectiveModelId?: string;
  modelOverrides?: ModelOverridesConfig;
  writeOutputPath?: string;
  previousResponseId?: string;
  followupSessionId?: string;
  followupModel?: string;
  browserResumeConversationUrl?: string;
  /** Claude Code (Fable lane) resume primitive resolved from `--followup` (claude-provider-map.md finding #2). */
  claudeCodeResumeSessionId?: string;
};

interface RestartCommandOptions {
  // tri-state: `true` (forced wait), `false` (forced detach), `undefined` (auto)
  wait?: boolean;
  remoteBrowser?: string;
  remoteHost?: string;
  remoteToken?: string;
  json?: boolean;
}

interface FollowUpCommandOptions {
  prompt?: string;
  slug?: string;
  wait?: boolean;
  recover?: boolean;
  file?: string[];
  json?: boolean;
}

function collectFollowUpCommandOptions(...values: unknown[]): FollowUpCommandOptions {
  const options: FollowUpCommandOptions = {};
  for (const value of values) {
    if (!value || typeof value !== "object") continue;
    const candidate =
      typeof (value as Command).opts === "function"
        ? (value as Command).opts<FollowUpCommandOptions>()
        : (value as FollowUpCommandOptions);
    for (const [key, candidateValue] of Object.entries(candidate)) {
      if (candidateValue === undefined) continue;
      if (
        key === "file" &&
        Array.isArray(candidateValue) &&
        candidateValue.length === 0 &&
        options.file &&
        options.file.length > 0
      ) {
        continue;
      }
      (options as Record<string, unknown>)[key] = candidateValue;
    }
  }
  return options;
}

const VERSION = getCliVersion();
const CLI_ENTRYPOINT = fileURLToPath(import.meta.url);
const LEGACY_FLAG_ALIASES = new Map<string, string>([
  ["--[no-]notify", "--notify"],
  ["--[no-]notify-sound", "--notify-sound"],
  ["--[no-]background", "--background"],
]);
const legacyNormalizedArgv = process.argv.map((arg, index) => {
  if (index < 2) return arg;
  return LEGACY_FLAG_ALIASES.get(arg) ?? arg;
});
const rawCliArgs = legacyNormalizedArgv.slice(2);
const hasCliEntrypointArg = rawCliArgs[0] === CLI_ENTRYPOINT;
const originalUserCliArgs = hasCliEntrypointArg ? rawCliArgs.slice(1) : rawCliArgs;
const perfTraceArgs = normalizePerfTraceArgs(originalUserCliArgs);
const userCliArgs = perfTraceArgs.args;
const normalizedArgv = [
  ...legacyNormalizedArgv.slice(0, 2),
  ...(hasCliEntrypointArg ? [CLI_ENTRYPOINT] : []),
  ...userCliArgs,
];
const routingCliArgs = stripPerfTraceArgs(userCliArgs);
const isTty = process.stdout.isTTY;
const isRootVerboseHelpRequest = (args: readonly string[]): boolean => {
  const hasHelp = args.some((arg) => arg === "--help" || arg === "-h");
  const hasVerbose = args.some((arg) => arg === "--verbose" || arg === "-v");
  if (!hasHelp || !hasVerbose) return false;
  return args.every((arg) => arg.startsWith("-"));
};
const isRootDebugHelpRequest = (args: readonly string[]): boolean =>
  args.some((arg) => arg === "--debug-help");

/**
 * Custom `--lane` argParser (agent-ergonomics Axiom 7: intent inference).
 * commander's `.choices()` would otherwise reject an unrecognized `--lane`
 * value with a bare "Allowed choices are ..." message *before* the value
 * ever reaches `resolveLanePolicy`'s well-tested `unknown_lane` ->
 * `closestLane()` typo-correction path (`routeBlockError.ts`) — that path
 * only fires for non-CLI callers (MCP) today. Reusing the same
 * `closestLane()` here means a CLI typo gets the identical "did you mean
 * the nearest reviewed lane?" treatment, with the exact corrected command,
 * instead of a dead end.
 */
function parseLaneOption(value: string): string {
  if ((VALID_LANES as readonly string[]).includes(value)) {
    return value;
  }
  const allowed = `Allowed choices are ${VALID_LANES.join(", ")}.`;
  const suggestion = closestLane(value);
  if (!suggestion) {
    throw new InvalidArgumentError(allowed);
  }
  throw new InvalidArgumentError(
    `${allowed} Did you mean --lane ${suggestion}? ` +
      `Try: oracle -p "<prompt>" --lane ${suggestion}   # closest match to --lane ${value}`,
  );
}

const perfTrace = createPerfTrace({
  value: perfTraceArgs.value,
  argv: userCliArgs,
  version: VERSION,
});
process.once("exit", (code) => {
  try {
    perfTrace.flush(code);
  } catch (error) {
    console.error(`Failed to write perf trace: ${error instanceof Error ? error.message : error}`);
  }
});

function stripPerfTraceArgs(args: string[]): string[] {
  const stripped: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--perf-trace") continue;
    if (arg === "--perf-trace-path") {
      index += 1;
      continue;
    }
    if (arg.startsWith("--perf-trace-path=")) continue;
    stripped.push(arg);
  }
  return stripped;
}

function normalizePerfTraceArgs(args: string[]): {
  args: string[];
  error?: string;
  value?: boolean | string;
} {
  const normalized: string[] = [];
  let skipNextValue = false;
  let value: boolean | string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (skipNextValue) {
      normalized.push(arg);
      skipNextValue = false;
      continue;
    }
    if (arg === "--") {
      normalized.push(...args.slice(index));
      break;
    }
    if (arg.startsWith("--perf-trace=")) {
      const tracePath = arg.slice("--perf-trace=".length);
      if (tracePath) {
        normalized.push("--perf-trace", "--perf-trace-path", tracePath);
        value = tracePath;
      } else {
        normalized.push("--perf-trace");
        value = true;
      }
      continue;
    }
    if (arg === "--perf-trace-path") {
      const tracePath = args[index + 1];
      if (!tracePath || tracePath.startsWith("-")) {
        return { args: normalized, error: "option '--perf-trace-path <path>' argument missing" };
      }
      normalized.push(arg, tracePath);
      value = tracePath;
      index += 1;
      continue;
    }
    if (arg.startsWith("--perf-trace-path=") && !arg.slice("--perf-trace-path=".length)) {
      return { args: normalized, error: "option '--perf-trace-path <path>' argument missing" };
    }
    if (arg.startsWith("--perf-trace-path=")) {
      value = arg.slice("--perf-trace-path=".length);
    } else if (arg === "--perf-trace") {
      value ??= true;
    }

    normalized.push(arg);
    const equalsIndex = arg.indexOf("=");
    const flag = equalsIndex >= 0 ? arg.slice(0, equalsIndex) : arg;
    skipNextValue = equalsIndex < 0 && isTraceValueFlag(flag);
  }

  return { args: normalized, value };
}

const doctorArgIndex = routingCliArgs.indexOf("doctor");
const doctorJsonRequested =
  doctorArgIndex >= 0 && routingCliArgs.slice(doctorArgIndex).includes("--json");
const docsArgIndex = routingCliArgs.indexOf("docs");
const docsCheckRequested = docsArgIndex >= 0 && routingCliArgs[docsArgIndex + 1] === "check";
const structuredJsonCommandRequested =
  routingCliArgs.includes("--json") ||
  ["capabilities", "robot-docs", "preview", "run", "visibility-status"].includes(
    routingCliArgs[0] ?? "",
  ) ||
  (routingCliArgs[0] === "browser" && routingCliArgs[1] === "leases");
const suppressIntro =
  doctorJsonRequested ||
  structuredJsonCommandRequested ||
  docsCheckRequested ||
  (routingCliArgs[0] === "bridge" &&
    (routingCliArgs[1] === "codex-config" || routingCliArgs[1] === "claude-config"));

const program = new Command();
let introPrinted = false;
let commanderErrorPrinted = false;
program.configureOutput({
  outputError: (str, write) => {
    if (!isJsonModeRequested(userCliArgs)) {
      commanderErrorPrinted = true;
      write(str);
    }
  },
});

program.exitOverride();
program.hook("preAction", (_thisCommand, actionCommand) => {
  perfTrace.mark("pre-action", { command: actionCommand.name() || "root" });
  if (suppressIntro) return;
  if (introPrinted) return;
  console.log(formatIntroLine(VERSION, { env: process.env, richTty: isTty }));
  introPrinted = true;
});
applyHelpStyling(program, VERSION, isTty);
registerCliCommands(program);
installUnknownFlagSuggestion(program);
program.addHelpText("after", () => formatRobotCommandHelp());
program.hook("preAction", async (thisCommand) => {
  if (thisCommand !== program) {
    return;
  }
  if (routingCliArgs.some((arg) => arg === "--help" || arg === "-h")) {
    return;
  }
  if (routingCliArgs.length === 0) {
    // Let the root action handle zero-arg entry (help + hint to `oracle tui`).
    return;
  }
  const opts = thisCommand.optsWithGlobals() as CliOptions;
  // Use setOptionValueWithSource so alias-driven assignments (e.g. --mode -> engine)
  // register as explicitly set; a bare setOptionValue leaves the recorded source at
  // "default", letting optionUsesDefault() checks silently clobber the user's choice
  // (e.g. the Gemini Deep Think root route forcing engine=browser over --mode api).
  applyHiddenAliases(opts, (key, value) => thisCommand.setOptionValueWithSource(key, value, "cli"));
  const positional = thisCommand.args?.[0] as string | undefined;
  if (!opts.prompt && positional) {
    opts.prompt = positional;
    thisCommand.setOptionValue("prompt", positional);
  }
  const resolvedPrompt = await resolveDashPrompt(opts.prompt);
  if (resolvedPrompt !== opts.prompt) {
    opts.prompt = resolvedPrompt;
    thisCommand.setOptionValue("prompt", resolvedPrompt);
  }
  if (!opts.prompt && typeof opts.promptFile === "string" && opts.promptFile.trim().length > 0) {
    const promptFromFile = await readPromptFile(opts.promptFile, "utf8");
    opts.prompt = promptFromFile;
    thisCommand.setOptionValue("prompt", promptFromFile);
  }
  if (shouldRequirePrompt(routingCliArgs, opts)) {
    console.log(
      chalk.yellow(
        'Prompt is required. Provide it via --prompt "<text>" or positional [prompt], e.g.: oracle -p "<prompt>" --lane fable-local',
      ),
    );
    thisCommand.help({ error: true });
    return;
  }
});
program
  .name("oracle")
  .description(
    "One-shot expert review tool for the reviewed lanes: ChatGPT GPT-5.6 Sol + Pro, Fable xHigh, and Gemini 3.1 Deep Think.",
  )
  .version(VERSION)
  .argument("[prompt]", "Prompt text (shorthand for --prompt).")
  .option("-p, --prompt <text>", "User prompt to send to the model.")
  .option("--prompt-file <path>", "Read the prompt from a file.")
  .addOption(new Option("--message <text>", "Alias for --prompt.").hideHelp())
  .option(
    "--followup <sessionId|responseId>",
    "Continue a stored ChatGPT browser conversation or an OpenAI/Azure Responses API run.",
  )
  .option(
    "--followup-model <model>",
    "For multi-model API sessions, choose which model response to continue from.",
  )
  .option(
    "-f, --file <paths...>",
    "Files/directories or glob patterns to attach (prefix with !pattern to exclude). Oversized files are rejected automatically (default cap: 1 MB; configurable via ORACLE_MAX_FILE_SIZE_BYTES or config.maxFileSizeBytes).",
    collectPaths,
    [],
  )
  .option(
    "--max-file-size-bytes <bytes>",
    "Reject files larger than this many bytes.",
    parseIntOption,
  )
  .addOption(
    new Option("--include <paths...>", "Alias for --file.")
      .argParser(collectPaths)
      .default([])
      .hideHelp(),
  )
  .addOption(
    new Option("--files <paths...>", "Alias for --file.")
      .argParser(collectPaths)
      .default([])
      .hideHelp(),
  )
  .addOption(
    new Option("--path <paths...>", "Alias for --file.")
      .argParser(collectPaths)
      .default([])
      .hideHelp(),
  )
  .addOption(
    new Option("--paths <paths...>", "Alias for --file.")
      .argParser(collectPaths)
      .default([])
      .hideHelp(),
  )
  .addOption(
    new Option(
      "--copy-markdown",
      "Copy the assembled markdown bundle to the clipboard; pair with --render to print it too.",
    ).default(false),
  )
  .addOption(new Option("--copy").hideHelp().default(false))
  .option("-s, --slug <words>", "Custom session slug (3-5 words).")
  .addOption(
    new Option(
      "--lane <lane>",
      "Reviewed lane alias (fable-local, chatgpt-pro, gemini-deep-think).",
    )
      .choices([...VALID_LANES])
      // .choices() alone gives a bare "Allowed choices are ..." message
      // with no typo correction (agent-ergonomics Axiom 7: intent
      // inference). Layering a custom argParser on top keeps the
      // `.choices()` call for `--help`'s "(choices: ...)" rendering
      // (argChoices) while replacing the parse-time error with one that
      // also names the closest valid lane and the exact corrected
      // command — see `parseLaneOption` below.
      .argParser(parseLaneOption),
  )
  .addOption(
    new Option(
      "-m, --model <model>",
      "Model to target. Prefer --lane for reviewed routes; legacy API/browser model aliases remain available.",
    )
      .argParser(normalizeModelOption)
      .hideHelp(),
  )
  .addOption(
    new Option(
      "--models <models>",
      "Compatibility-only comma-separated API model fan-out. Not part of the reviewed lane surface.",
    )
      .argParser(collectModelList)
      .default([])
      .hideHelp(),
  )
  .addOption(
    new Option(
      "-e, --engine <mode>",
      "Execution engine (api | browser | claude-code). Reviewed lanes use browser for ChatGPT/Gemini and claude-code for fable-local.",
    ).choices(["api", "browser", "claude-code"]),
  )
  .addOption(
    new Option(
      "--provider <provider>",
      "Provider selection. Accepts API routing (auto, openai, azure) and protected browser routes (gemini-deep-think).",
    )
      .default("auto")
      .hideHelp(),
  )
  .addOption(
    new Option("--gemini-deep-think", "Use the protected Gemini Deep Think browser route.").default(
      false,
    ),
  )
  .addOption(new Option("--deep-think", "Alias for --gemini-deep-think.").default(false).hideHelp())
  .addOption(
    new Option("--gemini-deep-think-fallback <mode>", "Deep Think fallback policy.")
      .choices(["fail"])
      .argParser(parseGeminiDeepThinkFallbackOption),
  )
  .addOption(
    new Option("--evidence <mode>", "Evidence policy for protected browser runs.")
      .choices(["redacted"])
      .argParser(parseGeminiDeepThinkEvidenceOption),
  )
  .addOption(
    new Option(
      "--json",
      "Emit a json_envelope.v1 result on stdout instead of human-readable output, for both success and error outcomes.",
    ).default(false),
  )
  .addOption(
    new Option("--mode <mode>", "Alias for --engine (api | browser | claude-code).")
      .choices(["api", "browser", "claude-code"])
      .hideHelp(),
  )
  .option(
    "--files-report",
    "Show token usage per attached file (also prints automatically when files exceed the token budget).",
    false,
  )
  .option("-v, --verbose", "Enable verbose logging for all operations.", false)
  .addOption(
    new Option(
      "--notify",
      "Desktop notification when a session finishes (default on unless CI/SSH).",
    ).default(undefined),
  )
  .addOption(new Option("--no-notify", "Disable desktop notifications.").default(undefined))
  .addOption(
    new Option("--notify-sound", "Play a notification sound on completion (default off).").default(
      undefined,
    ),
  )
  .addOption(new Option("--no-notify-sound", "Disable notification sounds.").default(undefined))
  .addOption(
    new Option(
      "--timeout <seconds|duration|auto>",
      "Overall timeout before aborting the API call (auto = 60m for Pro models, 120s otherwise).",
    )
      .argParser(parseTimeoutOption)
      .default("auto"),
  )
  .addOption(
    new Option(
      "--wait-for-lock <ms|s|m|h>",
      "For --lane fable-local, wait this long for an existing local Claude Code lane lock.",
    )
      .argParser((value) => parseDurationOption(value, "Lock wait"))
      .default(undefined),
  )
  .addOption(
    new Option(
      "--claude-code-executable <path>",
      "For --lane fable-local, override the resolved `claude` executable path (also settable via ORACLE_CLAUDE_CODE_EXECUTABLE). Still hardened: rejected if world-writable, foreign-owned, or inside the reviewed repo.",
    ).default(undefined),
  )
  .addOption(
    new Option(
      "--background",
      "Use Responses API background mode (create + retrieve) for API runs.",
    )
      .default(undefined)
      .hideHelp(),
  )
  .addOption(
    new Option("--no-background", "Disable Responses API background mode.")
      .default(undefined)
      .hideHelp(),
  )
  .addOption(
    new Option("--http-timeout <ms|s|m|h>", "HTTP client timeout for API requests (default 20m).")
      .argParser((value) => parseDurationOption(value, "HTTP timeout"))
      .default(undefined)
      .hideHelp(),
  )
  .addOption(
    new Option(
      "--zombie-timeout <ms|s|m|h>",
      "Override stale-session cutoff used by `oracle status` (default 60m).",
    )
      .argParser((value) => parseDurationOption(value, "Zombie timeout"))
      .default(undefined),
  )
  .option(
    "--zombie-last-activity",
    "Base stale-session detection on last log activity instead of start time.",
    false,
  )
  .addOption(
    new Option(
      "--preview [mode]",
      "(alias) Preview the request without calling the model (summary | json | full). Deprecated: use --dry-run instead.",
    )
      .hideHelp()
      .choices(["summary", "json", "full"])
      .preset("summary"),
  )
  .addOption(
    new Option("--dry-run [mode]", "Preview without calling the model (summary | json | full).")
      .choices(["summary", "json", "full"])
      .preset("summary")
      .default(false),
  )
  .addOption(
    new Option("--route", "Print API provider route plan and exit.").default(false).hideHelp(),
  )
  .addOption(
    new Option("--preflight", "Check API provider readiness for the requested model(s) and exit.")
      .default(false)
      .hideHelp(),
  )
  .addOption(
    new Option(
      "--perf-trace",
      "Write CLI performance timing trace JSON (or set ORACLE_PERF_TRACE=1/path).",
    ).default(false),
  )
  .addOption(
    new Option(
      "--perf-trace-path <path>",
      "Write CLI performance timing trace JSON to an explicit path.",
    ).default(undefined),
  )
  .addOption(new Option("--exec-session <id>").hideHelp())
  .addOption(new Option("--finalize-session <id>").hideHelp())
  .addOption(new Option("--session <id>").hideHelp())
  .addOption(
    new Option("--status", "Show stored sessions (alias for `oracle status`).")
      .default(false)
      .hideHelp(),
  )
  .option(
    "--render-markdown",
    "Print the assembled markdown bundle for prompt + files and exit; pair with --copy to put it on the clipboard.",
    false,
  )
  .option("--render", "Alias for --render-markdown.", false)
  .option(
    "--render-plain",
    "Render markdown without ANSI/highlighting (use plain text even in a TTY).",
    false,
  )
  .option(
    "--write-output <path>",
    "Write only the final assistant message to this file (overwrites; multi-model appends .<model> before the extension).",
  )
  .option("--allow-partial", "Exit 0 for multi-model runs when at least one model succeeds.", false)
  .addOption(
    new Option("--partial <mode>", "Multi-model failure policy (fail | ok).")
      .choices(["fail", "ok"])
      .default(undefined),
  )
  .option("--verbose-render", "Show render/TTY diagnostics when replaying sessions.", false)
  .addOption(
    new Option("--search <mode>", "Set server-side search behavior (on/off).")
      .argParser(parseSearchOption)
      .hideHelp(),
  )
  .addOption(
    new Option("--max-input <tokens>", "Override the input token budget for the selected model.")
      .argParser(parseIntOption)
      .hideHelp(),
  )
  .addOption(
    new Option("--max-output <tokens>", "Override the max output tokens for the selected model.")
      .argParser(parseIntOption)
      .hideHelp(),
  )
  .addOption(
    new Option(
      "--base-url <url>",
      "Override the OpenAI-compatible base URL for API runs (e.g. LiteLLM proxy endpoint).",
    ).hideHelp(),
  )
  .addOption(
    new Option(
      "--no-azure",
      "Disable Azure OpenAI routing for this run (same as --provider openai).",
    ).hideHelp(),
  )
  .addOption(
    new Option(
      "--azure-endpoint <url>",
      "Azure OpenAI Endpoint (e.g. https://resource.openai.azure.com/).",
    ).hideHelp(),
  )
  .addOption(new Option("--azure-deployment <name>", "Azure OpenAI Deployment Name.").hideHelp())
  .addOption(new Option("--azure-api-version <version>", "Azure OpenAI API Version.").hideHelp())
  .addOption(
    new Option("--browser", "(deprecated) Use --engine browser instead.").default(false).hideHelp(),
  )
  .addOption(
    new Option(
      "--browser-chrome-profile <name>",
      "Chrome profile name/path for cookie reuse.",
    ).hideHelp(),
  )
  .addOption(
    new Option(
      "--browser-chrome-path <path>",
      "Explicit Chrome or Chromium executable path.",
    ).hideHelp(),
  )
  .addOption(
    new Option(
      "--browser-cookie-path <path>",
      "Explicit Chrome/Chromium cookie DB path for session reuse.",
    ),
  )
  .addOption(
    new Option(
      "--browser-attach-running",
      "Attach to a running local browser session instead of launching Chrome (defaults to 127.0.0.1:9222; combine with --remote-chrome to hint a different host:port).",
    ),
  )
  .addOption(
    new Option(
      "--chatgpt-url <url>",
      `Override the ChatGPT web URL (e.g., workspace/folder like https://chatgpt.com/g/.../project; default ${CHATGPT_URL}).`,
    ),
  )
  .addOption(
    new Option(
      "--browser-url <url>",
      `Alias for --chatgpt-url (default ${CHATGPT_URL}).`,
    ).hideHelp(),
  )
  .addOption(
    new Option(
      "--browser-timeout <ms|s|m>",
      "Maximum time to wait for an answer (default 1200s / 20m).",
    ).hideHelp(),
  )
  .addOption(
    new Option(
      "--browser-input-timeout <ms|s|m>",
      "Maximum time to wait for the prompt textarea (default 60s).",
    ).hideHelp(),
  )
  .addOption(
    new Option(
      "--browser-attachment-timeout <ms|s|m>",
      "Maximum time to wait for attachment upload/readiness before clicking send (default 45s).",
    ).hideHelp(),
  )
  .addOption(
    new Option(
      "--browser-recheck-delay <ms|s|m|h>",
      "After an assistant timeout, wait this long then revisit the conversation to retry capture.",
    ).hideHelp(),
  )
  .addOption(
    new Option(
      "--browser-recheck-timeout <ms|s|m|h>",
      "Time budget for the delayed recheck attempt (default 120s).",
    ).hideHelp(),
  )
  .addOption(
    new Option(
      "--browser-reuse-wait <ms|s|m|h>",
      "Wait for a shared Chrome profile to appear before launching a new one (helps parallel runs).",
    ).hideHelp(),
  )
  .addOption(
    new Option(
      "--browser-profile-lock-timeout <ms|s|m|h>",
      "Wait for the shared manual-login profile lock before sending (serializes parallel runs).",
    ).hideHelp(),
  )
  .addOption(
    new Option(
      "--browser-max-concurrent-tabs <n>",
      "Soft limit for concurrent ChatGPT tabs sharing one manual-login profile (default 3).",
    ).hideHelp(),
  )
  .addOption(
    new Option(
      "--browser-auto-reattach-delay <ms|s|m|h>",
      "Delay before starting periodic auto-reattach attempts after a timeout.",
    ).hideHelp(),
  )
  .addOption(
    new Option(
      "--browser-auto-reattach-interval <ms|s|m|h>",
      "Interval between auto-reattach attempts (0 disables).",
    ).hideHelp(),
  )
  .addOption(
    new Option(
      "--browser-auto-reattach-timeout <ms|s|m|h>",
      "Time budget for each auto-reattach attempt (default 120s).",
    ).hideHelp(),
  )
  .addOption(
    new Option(
      "--browser-cookie-wait <ms|s|m>",
      "Wait before retrying cookie sync when Chrome cookies are empty or locked.",
    ).hideHelp(),
  )
  .addOption(
    new Option(
      "--browser-port <port>",
      "Use a fixed Chrome DevTools port (helpful on WSL firewalls).",
    ).argParser(parseIntOption),
  )
  .addOption(
    new Option("--browser-debug-port <port>", "(alias) Use a fixed Chrome DevTools port.")
      .argParser(parseIntOption)
      .hideHelp(),
  )
  .addOption(
    new Option(
      "--browser-cookie-names <names>",
      "Comma-separated cookie allowlist for sync.",
    ).hideHelp(),
  )
  .addOption(
    new Option(
      "--browser-inline-cookies <jsonOrBase64>",
      "Inline cookies payload (JSON array or base64-encoded JSON).",
    ).hideHelp(),
  )
  .addOption(
    new Option(
      "--browser-inline-cookies-file <path>",
      "Load inline cookies from file (JSON or base64 JSON).",
    ).hideHelp(),
  )
  .addOption(new Option("--browser-no-cookie-sync", "Skip copying cookies from Chrome.").hideHelp())
  .addOption(
    new Option(
      "--browser-manual-login",
      "Skip cookie copy; reuse a persistent automation profile and wait for manual ChatGPT login.",
    ).hideHelp(),
  )
  .addOption(
    new Option(
      "--browser-manual-login-profile-dir <path>",
      "Persistent Chrome profile directory for manual-login browser runs.",
    ).hideHelp(),
  )
  .addOption(
    new Option(
      "--copy-profile <dir>",
      'Copy a signed-in Chrome user-data dir to a throwaway profile and run browser mode against it (login-free; auto-cleanup). e.g. "$HOME/Library/Application Support/Google/Chrome".',
    ).hideHelp(),
  )
  .addOption(new Option("--browser-headless", "Launch Chrome in headless mode.").hideHelp())
  .addOption(
    new Option(
      "--browser-hide-window",
      "Hide the Chrome window after launch (macOS headful only).",
    ).hideHelp(),
  )
  .addOption(
    new Option("--browser-keep-browser", "Keep Chrome running after completion.").hideHelp(),
  )
  .addOption(
    new Option(
      "--browser-model-strategy <mode>",
      "ChatGPT model picker strategy: select (default) switches to the requested model, current keeps the active model, ignore skips the picker entirely.",
    ).choices(["select", "current", "ignore"]),
  )
  .addOption(
    new Option(
      "--browser-thinking-time <level>",
      "Thinking time intensity for Thinking/Pro models: light, standard, extended, heavy, or ChatGPT UI aliases.",
    ).argParser(parseThinkingTimeOption),
  )
  .addOption(
    new Option(
      "--browser-research <mode>",
      "Browser research mode: deep activates ChatGPT Deep Research.",
    ).choices(["off", "deep"]),
  )
  .addOption(
    new Option(
      "--browser-archive <mode>",
      "Archive completed ChatGPT browser conversations after local artifacts are saved (auto archives successful non-project one-shots only).",
    ).choices(["auto", "always", "never"]),
  )
  .addOption(
    new Option(
      "--browser-follow-up <prompt>",
      "Submit an additional prompt in the same ChatGPT browser conversation after the initial answer; repeat for multi-turn consults.",
    )
      .argParser(collectTextValues)
      .default([]),
  )
  .addOption(
    new Option(
      "--browser-allow-cookie-errors",
      "Continue even if Chrome cookies cannot be copied.",
    ).hideHelp(),
  )
  .addOption(
    new Option(
      "--browser-attachments <mode>",
      "How to deliver --file inputs in browser mode: auto (default) pastes text inline up to ~60k chars then uploads; never requires inline-compatible text files; always uploads.",
    )
      .choices(["auto", "never", "always"])
      .default("auto"),
  )
  .addOption(
    new Option(
      "--remote-chrome <host:port>",
      "Connect to remote Chrome DevTools Protocol, or when combined with --browser-attach-running use this host:port as the local attach hint.",
    ).hideHelp(),
  )
  .option(
    "--browser-tab <ref>",
    "Reuse an existing ChatGPT tab by ref (current, target id, full URL, or title substring) instead of opening a new tab.",
  )
  .addOption(
    new Option(
      "--remote-browser <mode>",
      "Controls whether remote browser infrastructure is used. Modes: preferred (default), required, off.",
    )
      .choices(["preferred", "required", "off"])
      .hideHelp(),
  )
  .addOption(
    new Option(
      "--remote-host <host:port>",
      "Delegate browser runs to a remote `oracle serve` instance.",
    ).hideHelp(),
  )
  .addOption(
    new Option(
      "--remote-token <token>",
      "Access token for the remote `oracle serve` instance.",
    ).hideHelp(),
  )
  .addOption(
    new Option(
      "--browser-inline-files",
      "Alias for --browser-attachments never (force pasting file contents inline).",
    ).default(false),
  )
  .addOption(
    new Option(
      "--browser-bundle-files",
      "Bundle all attachments into a single archive before uploading.",
    )
      .default(false)
      .hideHelp(),
  )
  .addOption(
    new Option(
      "--browser-bundle-format <format>",
      "Bundle format for browser uploads when files are bundled: auto (default), text, or zip.",
    )
      .choices(["auto", "text", "zip"])
      .default("auto")
      .hideHelp(),
  )
  .addOption(
    new Option(
      "--youtube <url>",
      "YouTube video URL to analyze (Gemini web/cookie mode only; uses your signed-in Chrome cookies for gemini.google.com).",
    ).hideHelp(),
  )
  .addOption(
    new Option(
      "--generate-image <file>",
      "Generate image and save to file (Gemini browser mode; ChatGPT browser mode saves downloadable image artifacts when present).",
    ).hideHelp(),
  )
  .addOption(
    new Option(
      "--edit-image <file>",
      "Edit existing image (Gemini browser mode; for ChatGPT attach source images with --file and use --generate-image for output).",
    ).hideHelp(),
  )
  .addOption(new Option("--output <file>", "Output file path for image operations.").hideHelp())
  .addOption(
    new Option(
      "--aspect <ratio>",
      "Aspect ratio for image generation: 16:9, 1:1, 4:3, 3:4 (Gemini web/cookie mode only).",
    ).hideHelp(),
  )
  .addOption(
    new Option(
      "--gemini-show-thoughts",
      "Display Gemini thinking process (Gemini web/cookie mode only).",
    )
      .default(false)
      .hideHelp(),
  )
  .option(
    "--retain-hours <hours>",
    "Prune stored sessions older than this many hours before running (set 0 to disable).",
    parseFloatOption,
  )
  .option(
    "--force",
    "Force start a new session even if an identical prompt is already running.",
    false,
  )
  .option("--debug-help", "Show the advanced/debug option set and exit.", false)
  .option(
    "--heartbeat <seconds>",
    "Emit periodic in-progress updates (0 to disable).",
    parseHeartbeatOption,
    30,
  )
  .addOption(new Option("--wait").default(undefined))
  .addOption(new Option("--no-wait").default(undefined).hideHelp())
  .showHelpAfterError("(use --help for usage)");

program
  .command("serve", { hidden: true })
  .description("Run Oracle browser automation as a remote service for other machines.")
  .option("--host <address>", "Interface to bind (default 0.0.0.0).")
  .option("--port <number>", "Port to listen on (default random).", parseIntOption)
  .option(
    "--token <value>",
    "Access token clients must provide. Prefer --token-file or ORACLE_REMOTE_TOKEN so the secret stays out of argv. " +
      "Precedence: --token-file > ORACLE_REMOTE_TOKEN_FILE > ORACLE_REMOTE_TOKEN > --token (random if none). " +
      "Rotation: replace the credential and restart serve.",
  )
  .option(
    "--token-file <path>",
    "Read the access token from this file (trailing newline trimmed; refuses missing/empty/world-readable files). " +
      "Keeps the secret out of /proc/<pid>/cmdline and composes with systemd LoadCredential.",
  )
  .option(
    "--manual-login",
    "Use a dedicated Chrome profile for manual login (recommended when cookie sync is unavailable).",
    false,
  )
  .option(
    "--manual-login-profile-dir <path>",
    "Chrome profile directory for manual login (default ~/.oracle/browser-profile).",
  )
  .option(
    "--attach-only",
    "Fail-closed worker mode (or ORACLE_SERVE_ATTACH_ONLY=1): only attach to a pre-launched Chrome; " +
      "refuse runs and report unready when no attachable DevTools endpoint exists. Serve never launches browsers.",
  )
  .option(
    "--devtools-port <number>",
    "Fixed loopback DevTools port of the operator-owned Chrome to attach to (or ORACLE_SERVE_DEVTOOLS_PORT). " +
      "Default: the profile directory's recorded DevToolsActivePort.",
    parseIntOption,
  )
  .action(async function (this: Command) {
    const commandOptions = this.optsWithGlobals();
    const { serveRemote } = await import("../src/remote/server.js");
    await serveRemote({
      host: commandOptions.host,
      port: commandOptions.port,
      token: commandOptions.token,
      tokenFile: commandOptions.tokenFile,
      manualLoginDefault: commandOptions.manualLogin,
      manualLoginProfileDir: commandOptions.manualLoginProfileDir,
      attachOnly: commandOptions.attachOnly,
      devtoolsPort: commandOptions.devtoolsPort,
    });
  });

if (!program.commands.some((command) => command.name() === "evidence")) {
  registerEvidenceCommand(program);
}

const projectSourcesCommand = program
  .command("project-sources", { hidden: true })
  .description("Manage ChatGPT Project Sources as explicit shared project context.");

function addProjectSourcesCommonOptions(command: Command): Command {
  return command
    .option(
      "--chatgpt-url <url>",
      "ChatGPT project URL ending in /project (or browser.chatgptUrl config).",
    )
    .addOption(
      new Option("--browser-manual-login", "Reuse a persistent signed-in Chrome profile.").default(
        undefined,
      ),
    )
    .option("--browser-manual-login-profile-dir <path>", "Persistent Chrome profile directory.")
    .option("--browser-timeout <duration>", "Overall browser timeout (e.g. 10m, 1h).")
    .option("--browser-input-timeout <duration>", "Timeout waiting for the Project Sources UI.")
    .option("--browser-profile-lock-timeout <duration>", "Timeout waiting for profile launch lock.")
    .option("--browser-reuse-wait <duration>", "Wait for an existing shared Chrome to appear.")
    .option("--browser-max-concurrent-tabs <n>", "Concurrent tabs allowed for the shared profile.")
    .option("--browser-cookie-wait <duration>", "Wait before retrying cookie sync.")
    .option("--browser-chrome-profile <profile>", "Chrome profile name for cookie sync.")
    .option("--browser-chrome-path <path>", "Chrome/Chromium executable path.")
    .option("--browser-cookie-path <path>", "Explicit Chrome cookie DB path.")
    .option("--browser-inline-cookies <json>", "Inline ChatGPT cookies JSON.")
    .option("--browser-inline-cookies-file <path>", "File containing ChatGPT cookies JSON.")
    .option("--browser-no-cookie-sync", "Skip copying cookies from Chrome.")
    .option("--browser-keep-browser", "Keep Chrome running after completion.", false)
    .option("--browser-hide-window", "Hide Chrome window after launch on macOS.", false)
    .option("--browser-allow-cookie-errors", "Continue when cookie sync fails.", false)
    .option(
      "--max-file-size-bytes <bytes>",
      "Reject uploads larger than this many bytes.",
      parseIntOption,
    )
    .option("--json", "Print structured JSON.", false)
    .option("-v, --verbose", "Enable verbose browser logging.", false);
}

addProjectSourcesCommonOptions(
  projectSourcesCommand
    .command("list")
    .description("List sources already attached to a ChatGPT Project."),
).action(async function (this: Command) {
  const { runProjectSourcesCliCommand } = await import("../src/cli/projectSources.js");
  await runProjectSourcesCliCommand("list", this.optsWithGlobals());
});

addProjectSourcesCommonOptions(
  projectSourcesCommand
    .command("add")
    .description("Upload files into a ChatGPT Project's persistent Sources tab.")
    .option(
      "-f, --file <paths...>",
      "Files/directories or globs to add as project sources.",
      collectPaths,
      [],
    )
    .option(
      "--dry-run",
      "Validate files and show the upload plan without touching the browser.",
      false,
    ),
).action(async function (this: Command) {
  const { runProjectSourcesCliCommand } = await import("../src/cli/projectSources.js");
  await runProjectSourcesCliCommand("add", this.optsWithGlobals());
});

const bridgeCommand = program
  .command("bridge", { hidden: true })
  .description("Bridge a Windows-hosted ChatGPT session to Linux clients.");

bridgeCommand
  .command("host")
  .description("Start a secure oracle serve host (optionally with an SSH reverse tunnel).")
  .option("--bind <host:port>", "Local bind address for the host service (default 127.0.0.1:9473).")
  .option("--token <token|auto>", "Service access token (default auto).", "auto")
  .option(
    "--write-connection <path>",
    "Write a connection artifact JSON (default ~/.oracle/bridge-connection.json).",
  )
  .option("--ssh <user@host>", "Maintain an SSH reverse tunnel to the Linux host (ssh -N -R ...).")
  .option(
    "--ssh-remote-port <port>",
    "Remote port to bind on the Linux host (default matches --bind port).",
    parseIntOption,
  )
  .option("--ssh-identity <path>", "SSH identity file (ssh -i).")
  .option("--ssh-extra-args <args>", "Extra args passed to ssh (quoted string).")
  .option("--background", "Run the host in the background and write pid/log files.", false)
  .option("--foreground", "Run the host in the foreground (default).", false)
  .option("--print", "Print the client connection string (includes token).", false)
  .option("--print-token", "Print only the token.", false)
  .action(async function (this: Command) {
    const commandOptions = this.optsWithGlobals();
    const { runBridgeHost } = await import("../src/cli/bridge/host.js");
    await runBridgeHost(commandOptions);
  });

bridgeCommand
  .command("client")
  .description("Configure this machine to use a remote oracle serve host.")
  .requiredOption("--connect <connection>", "Connection string or path to bridge-connection.json.")
  .option(
    "--config <path>",
    "Override the oracle config file location (default ~/.oracle/config.json).",
  )
  .option("--no-write-config", "Do not write ~/.oracle/config.json (just validate).")
  .option("--no-test", "Skip remote /health check.")
  .option("--print-env", "Print env var exports (includes token).", false)
  .action(async function (this: Command) {
    const commandOptions = this.optsWithGlobals();
    const { runBridgeClient } = await import("../src/cli/bridge/client.js");
    await runBridgeClient(commandOptions);
  });

bridgeCommand
  .command("doctor")
  .description("Diagnose bridge connectivity and browser engine prerequisites.")
  .option("--verbose", "Show extra diagnostics.", false)
  .option("--json", "Emit a remote_browser_endpoint.v1-compatible JSON envelope.", false)
  .action(async function (this: Command) {
    const commandOptions = this.optsWithGlobals();
    const { runBridgeDoctor } = await import("../src/cli/bridge/doctor.js");
    await runBridgeDoctor(commandOptions);
  });

const remoteCommand = program
  .command("remote", { hidden: true })
  .description("Diagnose Oracle's remote browser endpoint (doctor/status/attach).");

remoteCommand
  .command("doctor")
  .description("Probe the configured remote oracle endpoint (TCP + /health).")
  .option("--json", "Emit a remote_browser_endpoint.v1-compatible JSON envelope.", false)
  .option("--verbose", "Show extra diagnostics.", false)
  .action(async function (this: Command) {
    const commandOptions = this.optsWithGlobals();
    const { runRemoteDoctor } = await import("../src/cli/remote/doctor.js");
    await runRemoteDoctor(commandOptions);
  });

remoteCommand
  .command("status")
  .description("Print the resolved remote endpoint config without touching the network.")
  .option("--json", "Emit a remote_browser_endpoint.v1-compatible JSON envelope.", false)
  .action(async function (this: Command) {
    const commandOptions = this.optsWithGlobals();
    const { runRemoteStatus } = await import("../src/cli/remote/status.js");
    await runRemoteStatus(commandOptions);
  });

remoteCommand
  .command("attach")
  .description("Probe attach readiness against a caller-supplied remote host.")
  .requiredOption("--host <host:port>", "Remote oracle host to probe.")
  .option(
    "--token-env <ENV>",
    "Name of the environment variable holding the access token (default: ORACLE_REMOTE_TOKEN).",
  )
  .option("--json", "Emit a remote_browser_endpoint.v1-compatible JSON envelope.", false)
  .action(async function (this: Command) {
    const commandOptions = this.optsWithGlobals();
    const { runRemoteAttach } = await import("../src/cli/remote/attach.js");
    await runRemoteAttach(commandOptions as Parameters<typeof runRemoteAttach>[0]);
  });

remoteCommand
  .command("slots")
  .description("Show read-only per-lane remote browser slot state.")
  .option("--json", "Emit a remote_fleet_slots.v1 JSON report.", false)
  .option("--host <host:port>", "Probe one direct worker; repeatable.", collectTextValues, [])
  .option("--hosts <list>", "Comma-separated lane inventory, e.g. acct1-9473=host:9473,...")
  .option("--timeout <ms>", "Probe timeout per endpoint.", parseIntOption)
  .option("--require-healthy", "Exit nonzero when no lane is healthy.", false)
  .action(async function (this: Command) {
    const commandOptions = this.optsWithGlobals();
    const { runRemoteSlots } = await import("../src/cli/remote/slots.js");
    await runRemoteSlots(commandOptions as Parameters<typeof runRemoteSlots>[0]);
  });

const configCommand = program
  .command("config", { hidden: true })
  .description("Inspect Oracle configuration.");

configCommand
  .command("explain")
  .description("Print the effective Oracle config with source annotations and secret redaction.")
  .option("--json", "Emit oracle_config_explain.v1 JSON.", false)
  .option("--no-project", "Ignore project .oracle/config.json files.")
  .action(async function (this: Command) {
    const commandOptions = this.optsWithGlobals();
    const { runConfigExplain } = await import("../src/cli/configExplain.js");
    await runConfigExplain({
      json: commandOptions.json === true,
      includeProject: commandOptions.project !== false,
    });
  });

bridgeCommand
  .command("codex-config")
  .description("Print a Codex CLI MCP server config snippet for oracle-mcp.")
  .option("--print-token", "Include ORACLE_REMOTE_TOKEN in the snippet.", false)
  .action(async function (this: Command) {
    const commandOptions = this.optsWithGlobals();
    const { runBridgeCodexConfig } = await import("../src/cli/bridge/codexConfig.js");
    await runBridgeCodexConfig(commandOptions);
  });

bridgeCommand
  .command("claude-config")
  .description("Print a Claude Code MCP config snippet (.mcp.json) for oracle-mcp.")
  .option("--print-token", "Include ORACLE_REMOTE_TOKEN in the snippet.", false)
  .option(
    "--local-browser",
    "Use a local signed-in Chrome profile instead of a remote bridge.",
    false,
  )
  .option("--oracle-home-dir <path>", "Override ORACLE_HOME_DIR in the generated snippet.")
  .option(
    "--browser-profile-dir <path>",
    "Override ORACLE_BROWSER_PROFILE_DIR in the generated snippet.",
  )
  .action(async function (this: Command) {
    const commandOptions = this.optsWithGlobals();
    const { runBridgeClaudeConfig } = await import("../src/cli/bridge/claudeConfig.js");
    await runBridgeClaudeConfig(commandOptions);
  });

program
  .command("tui", { hidden: true })
  .description("Launch the interactive terminal UI for humans (no automation).")
  .action(async () => {
    const { launchTui } = await import("../src/cli/tui/index.js");
    await sessionStore.ensureStorage();
    await launchTui({ version: VERSION, printIntro: false });
  });

// NOTE(etafund-sync): upstream 3ae0df0d added a `program.command("doctor")` here
// for an API-provider readiness probe (--providers, --models). Our fork registers
// `oracle doctor` via registerDoctorCommand(program, ...) in src/cli/index.ts with
// a different surface (provider_docs/browser_leases/evidence schemas). The upstream
// provider-readiness functionality lives in src/cli/providerDoctor.ts and can be
// composed into our doctor command in a follow-up rather than registered as a
// duplicate root command.

const docsCommand = program
  .command("docs", { hidden: true })
  .description("Documentation maintenance utilities.");

docsCommand
  .command("check")
  .description("Check documented CLI flags against Commander help metadata.")
  .option("--docs-path <file...>", "Markdown files to check (default core shipped docs).")
  .option("--json", "Print structured JSON.", false)
  .action(async function (this: Command) {
    const options = this.optsWithGlobals() as { docsPath?: string[]; json?: boolean };
    const { checkDocsFlags, printDocsCheckResult } = await import("../src/cli/docsCheck.js");
    const result = await checkDocsFlags({ command: program, paths: options.docsPath });
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      printDocsCheckResult(result);
    }
    process.exitCode = result.issues.length > 0 ? 1 : 0;
  });

program
  .command("session [id]")
  .description("Attach to a stored session or list recent sessions when no ID is provided.")
  .option(
    "--hours <hours>",
    "Look back this many hours when listing sessions (default 24).",
    parseFloatOption,
    24,
  )
  .option(
    "--limit <count>",
    "Maximum sessions to show when listing (max 1000).",
    parseIntOption,
    100,
  )
  .option("--all", "Include all stored sessions regardless of age.", false)
  .option("--clear", "Delete stored sessions older than the provided window (24h default).", false)
  .option(
    "--yes",
    "Confirm the irreversible full wipe when combining --clear with --all (otherwise a dry-run preview is printed).",
    false,
  )
  .option("--hide-prompt", "Hide stored prompt when displaying a session.", false)
  .option("--render", "Render completed session output as markdown (rich TTY only).", false)
  .option("--render-markdown", "Alias for --render.", false)
  .option("--model <name>", "Filter sessions/output for a specific model.", "")
  .option("--path", "Print the stored session paths instead of attaching.", false)
  .option("--artifacts", "List artifacts associated with the stored session.", false)
  .option(
    "--harvest",
    "Re-read the bound browser tab and print/save the latest assistant output.",
    false,
  )
  .option(
    "--live",
    "Tail the live browser tab for this session until it completes, stalls, or detaches.",
    false,
  )
  .option(
    "--write-output <path>",
    "Write harvested browser output to this file (requires --harvest or --live).",
  )
  .option(
    "--browser-tab <ref>",
    "Override the browser tab ref used for harvesting/live tail (current, target id, URL, or title substring).",
  )
  .option(
    "--no-recover",
    "Do not relaunch Chrome to reopen the saved conversation URL when --harvest/--live finds no live tab.",
  )
  .option(
    "--json",
    "Emit oracle_session_list.v1 JSON when listing sessions (no session ID given), or the session artifact index JSON with --artifacts.",
    false,
  )
  .addOption(new Option("--clean", "Deprecated alias for --clear.").default(false).hideHelp())
  .action(async (sessionId, _options: StatusOptions, cmd: Command) => {
    const { handleSessionCommand } = await import("../src/cli/sessionCommand.js");
    await handleSessionCommand(sessionId, cmd);
  });

program
  .command("status [id]")
  .description(
    "List recent sessions (24h window by default) or attach to a session when an ID is provided.",
  )
  .option("--hours <hours>", "Look back this many hours (default 24).", parseFloatOption, 24)
  .option("--limit <count>", "Maximum sessions to show (max 1000).", parseIntOption, 100)
  .option("--all", "Include all stored sessions regardless of age.", false)
  .option("--clear", "Delete stored sessions older than the provided window (24h default).", false)
  .option(
    "--yes",
    "Confirm the irreversible full wipe when combining --clear with --all (otherwise a dry-run preview is printed).",
    false,
  )
  .option("--render", "Render completed session output as markdown (rich TTY only).", false)
  .option("--render-markdown", "Alias for --render.", false)
  .option("--model <name>", "Filter sessions/output for a specific model.", "")
  .option("--hide-prompt", "Hide stored prompt when displaying a session.", false)
  .option(
    "--browser-tabs",
    "List live ChatGPT browser tabs and known Oracle session linkage.",
    false,
  )
  .option(
    "--json",
    "Emit oracle_session_list.v1 JSON when listing sessions (no session ID given).",
    false,
  )
  .addOption(new Option("--clean", "Deprecated alias for --clear.").default(false).hideHelp())
  .action(async (sessionId: string | undefined, _options: StatusOptions, command: Command) => {
    const statusOptions = command.opts<StatusOptions>();
    if (statusOptions.browserTabs) {
      if (sessionId) {
        console.error(
          "Cannot combine a session ID with --browser-tabs. Drop the ID: oracle status --browser-tabs",
        );
        process.exitCode = 1;
        return;
      }
      const { showBrowserTabsStatus } = await import("../src/cli/browserTabs.js");
      await showBrowserTabsStatus();
      return;
    }
    const clearRequested = Boolean(statusOptions.clear || statusOptions.clean);
    if (clearRequested) {
      if (sessionId) {
        console.error(
          `Cannot combine a session ID with --clear. Drop the ID: oracle status --clear --hours ${statusOptions.hours}`,
        );
        process.exitCode = 1;
        return;
      }
      const { runSessionClear } = await import("../src/cli/sessionCommand.js");
      await runSessionClear(
        {
          hours: statusOptions.hours,
          includeAll: statusOptions.all,
          confirmed: Boolean(statusOptions.yes),
          commandName: "status",
        },
        (options) => sessionStore.deleteOlderThan(options),
      );
      return;
    }
    if (sessionId === "clear" || sessionId === "clean") {
      console.error(
        'Session cleanup now uses --clear. Run "oracle status --clear --hours <n>" instead.',
      );
      process.exitCode = 1;
      return;
    }
    if (sessionId) {
      const autoRender =
        !command.getOptionValueSource?.("render") &&
        !command.getOptionValueSource?.("renderMarkdown")
          ? process.stdout.isTTY
          : false;
      const renderMarkdown = Boolean(
        statusOptions.render || statusOptions.renderMarkdown || autoRender,
      );
      const { attachSession } = await import("../src/cli/sessionDisplay.js");
      await attachSession(sessionId, { renderMarkdown, renderPrompt: !statusOptions.hidePrompt });
      return;
    }
    const jsonRequested = Boolean(
      statusOptions.json || (command.optsWithGlobals?.() as StatusOptions | undefined)?.json,
    );
    if (jsonRequested) {
      const { runSessionListJson } = await import("../src/cli/sessionListJson.js");
      await runSessionListJson({
        hours: statusOptions.all ? Infinity : statusOptions.hours,
        includeAll: statusOptions.all,
        limit: statusOptions.limit,
        modelFilter: statusOptions.model,
      });
      return;
    }
    const showExamples = usesDefaultStatusFilters(command);
    const { showStatus } = await import("../src/cli/sessionDisplay.js");
    await showStatus({
      hours: statusOptions.all ? Infinity : statusOptions.hours,
      includeAll: statusOptions.all,
      limit: statusOptions.limit,
      showExamples,
    });
  });

program
  .command("restart <id>")
  .description("Re-run a stored session as a new session (clones options).")
  .addOption(new Option("--wait").default(undefined))
  .addOption(new Option("--no-wait").default(undefined).hideHelp())
  .option("--remote-host <host:port>", "Delegate browser runs to a remote `oracle serve` instance.")
  .option("--remote-token <token>", "Access token for the remote `oracle serve` instance.")
  .option(
    "--json",
    "Emit one oracle_session_action.v1 launch receipt on stdout; progress lines move to stderr.",
    false,
  )
  .action(async (sessionId: string, _options: RestartCommandOptions, cmd: Command) => {
    const restartOptions = cmd.opts<RestartCommandOptions>();
    // The root program also declares --json and consumes the flag before
    // the subcommand sees it; merge globals like `status` does.
    restartOptions.json = Boolean(
      restartOptions.json || cmd.optsWithGlobals<RestartCommandOptions>()?.json,
    );
    await restartSession(sessionId, restartOptions);
  });

program
  .command("follow-up <parentSessionId> [prompt]", { hidden: true })
  .description("Continue a stored browser session as a new child session.")
  .option("-p, --prompt <text>", "Follow-up prompt to send to the saved ChatGPT conversation.")
  .option("-s, --slug <words>", "Custom child session slug (3-5 words).")
  .addOption(new Option("--wait").default(undefined))
  .addOption(new Option("--no-wait").default(undefined).hideHelp())
  .option(
    "-f, --file <paths...>",
    "Unsupported for follow-up v1; start a new consult to attach files.",
    collectPaths,
    [],
  )
  .option(
    "--no-recover",
    "Do not relaunch Chrome to reopen the saved conversation URL; require a live matching tab.",
  )
  .option(
    "--json",
    "Emit one oracle_session_action.v1 launch receipt on stdout; progress lines move to stderr.",
    false,
  )
  .action(
    async (
      parentSessionId: string,
      promptArg: string | undefined,
      optionsOrCommand: FollowUpCommandOptions | Command,
      cmd?: Command,
    ) => {
      const options = collectFollowUpCommandOptions(program, cmd, optionsOrCommand, promptArg);
      // The root program also declares --json and consumes the flag before
      // the subcommand sees it (and the subcommand's `false` default would
      // otherwise clobber the root-parsed value in the merge above).
      options.json = Boolean(options.json || program.opts<{ json?: boolean }>().json);
      const positionalPrompt = typeof promptArg === "string" ? promptArg : undefined;
      await runFollowUpCommand(parentSessionId, positionalPrompt, options);
    },
  );

function buildRunOptions(
  options: ResolvedCliOptions,
  overrides: Partial<RunOracleOptions> = {},
): RunOracleOptions {
  if (!options.prompt) {
    throw new Error("Prompt is required.");
  }
  const normalizedBaseUrl = normalizeBaseUrl(overrides.baseUrl ?? options.baseUrl);
  const timeoutSeconds =
    overrides.timeoutSeconds ?? (options.timeout as number | "auto" | undefined);
  const resolvedTimeoutMs =
    typeof timeoutSeconds === "number" && Number.isFinite(timeoutSeconds) && timeoutSeconds > 0
      ? timeoutSeconds * 1000
      : undefined;
  const httpTimeoutMs = overrides.httpTimeoutMs ?? options.httpTimeout ?? resolvedTimeoutMs;
  const zombieTimeoutMs = overrides.zombieTimeoutMs ?? options.zombieTimeout ?? resolvedTimeoutMs;
  const partialMode = options.allowPartial ? "ok" : options.partial;
  const azure =
    options.azureEndpoint || overrides.azure?.endpoint
      ? {
          endpoint: overrides.azure?.endpoint ?? options.azureEndpoint,
          deployment: overrides.azure?.deployment ?? options.azureDeployment,
          apiVersion: overrides.azure?.apiVersion ?? options.azureApiVersion,
        }
      : undefined;
  const lane = overrides.lane ?? options.lane;
  const claudeCode =
    overrides.claudeCode ??
    (options.engine === "claude-code" || lane === "fable-local"
      ? {
          model: options.model,
          readOnly: true,
          inlineEvents: true,
          outputFormat: "stream-json" as const,
          permissionMode: "plan" as const,
          toolMode: "none" as const,
          safeMode: true,
          disableSlashCommands: true,
          strictMcpConfig: true,
          noChrome: true,
          // A resumed run (`--followup` resolved to a Claude Code session,
          // claude-provider-map.md finding #2) keeps persistence on so the
          // resumed conversation — and any further follow-up — has
          // something to attach to; a one-shot run keeps today's exact
          // `--no-session-persistence` behavior.
          noSessionPersistence: !options.claudeCodeResumeSessionId,
          resumeSessionId: options.claudeCodeResumeSessionId,
          waitForLockMs: options.waitForLock,
          executable: options.claudeCodeExecutable,
        }
      : undefined);

  return {
    prompt: options.prompt,
    model: options.model,
    models: overrides.models ?? options.models,
    previousResponseId: overrides.previousResponseId ?? options.previousResponseId,
    browserResumeConversationUrl:
      overrides.browserResumeConversationUrl ?? options.browserResumeConversationUrl,
    effectiveModelId: overrides.effectiveModelId ?? options.effectiveModelId ?? options.model,
    modelOverrides: overrides.modelOverrides ?? options.modelOverrides,
    file: overrides.file ?? options.file ?? [],
    maxFileSizeBytes: overrides.maxFileSizeBytes ?? options.maxFileSizeBytes,
    slug: overrides.slug ?? options.slug,
    filesReport: overrides.filesReport ?? options.filesReport,
    maxInput: overrides.maxInput ?? options.maxInput,
    maxOutput: overrides.maxOutput ?? options.maxOutput,
    system: overrides.system ?? options.system,
    timeoutSeconds,
    httpTimeoutMs,
    zombieTimeoutMs,
    zombieUseLastActivity: overrides.zombieUseLastActivity ?? options.zombieLastActivity,
    partialMode,
    silent: overrides.silent ?? options.silent,
    search: overrides.search ?? options.search,
    lane,
    claudeCode,
    preview: overrides.preview ?? undefined,
    previewMode: overrides.previewMode ?? options.previewMode,
    apiKey: overrides.apiKey ?? options.apiKey,
    provider: overrides.provider ?? options.provider,
    baseUrl: normalizedBaseUrl,
    azure,
    sessionId: overrides.sessionId ?? options.sessionId,
    verbose: overrides.verbose ?? options.verbose,
    heartbeatIntervalMs:
      overrides.heartbeatIntervalMs ?? resolveHeartbeatIntervalMs(options.heartbeat),
    browserAttachments:
      overrides.browserAttachments ??
      (options.browserAttachments as "auto" | "never" | "always" | undefined) ??
      "auto",
    browserInlineFiles: overrides.browserInlineFiles ?? options.browserInlineFiles ?? false,
    browserBundleFiles: overrides.browserBundleFiles ?? options.browserBundleFiles ?? false,
    browserBundleFormat: overrides.browserBundleFormat ?? options.browserBundleFormat ?? "auto",
    generateImage: overrides.generateImage ?? options.generateImage,
    outputPath: overrides.outputPath ?? options.output,
    browserFollowUps: overrides.browserFollowUps ?? options.browserFollowUp ?? [],
    background: overrides.background ?? undefined,
    renderPlain: overrides.renderPlain ?? options.renderPlain ?? false,
    writeOutputPath: overrides.writeOutputPath ?? options.writeOutputPath,
  };
}

function resolveApiProviderMode(options: Pick<CliOptions, "provider" | "azure">): ApiProviderMode {
  const provider = options.provider ?? "auto";
  if (provider === "azure" && options.azure === false) {
    throw new Error("--provider azure cannot be combined with --no-azure.");
  }
  if (options.azure === false) {
    return "openai";
  }
  return provider;
}

function hasExplicitAzureOption(optionUsesDefault: (name: string) => boolean): boolean {
  return (
    !optionUsesDefault("azureEndpoint") ||
    !optionUsesDefault("azureDeployment") ||
    !optionUsesDefault("azureApiVersion")
  );
}

// Browser-only options that do not carry a browser-only name prefix but must
// still count as lane browser conflicts (they force a browser/protected route).
const LANE_BROWSER_CONFLICT_EXTRA_FLAGS: ReadonlySet<string> = new Set([
  "copyProfile",
  "geminiDeepThink",
  "deepThink",
  "geminiDeepThinkFallback",
  "evidence",
  "youtube",
  "generateImage",
  "editImage",
]);

// Option keys that match a browser-only prefix below but are NOT browser-only
// flags. Empty today; add here if a future prefixed option is engine-neutral.
const LANE_BROWSER_CONFLICT_EXEMPT_FLAGS: ReadonlySet<string> = new Set([]);

// Any option whose camelCase key starts with one of these prefixes is treated
// as browser-only for lane conflict detection.
const LANE_BROWSER_CONFLICT_FLAG_PREFIXES = ["browser", "chatgpt", "remote"] as const;

export function isLaneBrowserConflictFlagName(name: string): boolean {
  if (LANE_BROWSER_CONFLICT_EXEMPT_FLAGS.has(name)) {
    return false;
  }
  if (LANE_BROWSER_CONFLICT_EXTRA_FLAGS.has(name)) {
    return true;
  }
  return LANE_BROWSER_CONFLICT_FLAG_PREFIXES.some((prefix) => name.startsWith(prefix));
}

export function collectLaneBrowserConflictFlags(
  options: CliOptions,
  optionUsesDefault: (name: string) => boolean,
): string[] {
  // Derive the conflict list from the runtime option keys instead of a
  // hand-maintained array so newly added browser-only flags (historically
  // --browser-follow-up, --browser-thinking-time, --remote-token, ...) cannot
  // silently bypass lane conflict detection for lanes that refuse browser
  // flags (e.g. fable-local's `--browser-*` refusedPatterns).
  return Object.keys(options).filter((name) => {
    if (!isLaneBrowserConflictFlagName(name)) {
      return false;
    }
    const value = (options as Record<string, unknown>)[name];
    if (value === undefined || value === false || value === null) {
      return false;
    }
    // Repeatable options (e.g. --browser-follow-up) default to [].
    if (Array.isArray(value) && value.length === 0) {
      return false;
    }
    return !optionUsesDefault(name) || value === true;
  });
}

function applyResolvedLaneCliOptions(
  options: CliOptions,
  resolvedLane: ResolvedOracleLane,
  optionUsesDefault: (name: string) => boolean,
): void {
  options.lane = resolvedLane.lane;
  const laneOptions = resolvedLane.normalizedEngineOptions;
  const engine = laneStringOption(laneOptions, "engine");
  if (engine) {
    options.engine = engine as EngineMode;
  }
  const model = laneStringOption(laneOptions, "model");
  if (model) {
    options.model = model;
  }
  applyStringLaneDefault(options, laneOptions, "browserThinkingTime", optionUsesDefault);
  applyStringLaneDefault(options, laneOptions, "browserModelStrategy", optionUsesDefault);
  applyStringLaneDefault(options, laneOptions, "browserArchive", optionUsesDefault);
  applyStringLaneDefault(options, laneOptions, "browserAttachments", optionUsesDefault);
  applyStringLaneDefault(options, laneOptions, "geminiDeepThinkFallback", optionUsesDefault);
  const geminiDeepThink = laneOptions.geminiDeepThink;
  if (typeof geminiDeepThink === "boolean" && optionUsesDefault("geminiDeepThink")) {
    options.geminiDeepThink = geminiDeepThink;
  }
  // The reviewed ChatGPT lane is a protected two-axis route: GPT-5.6 Sol
  // plus the checked Pro intelligence mode. A caller-supplied weaker model
  // strategy must not turn the lane into an unverified current/ignore run.
  if (resolvedLane.lane === "chatgpt-pro") {
    options.browserModelStrategy = "select";
    options.browserThinkingTime = "extended";
  }
}

function applyStringLaneDefault(
  options: CliOptions,
  laneOptions: Record<string, unknown>,
  name: keyof CliOptions,
  optionUsesDefault: (name: string) => boolean,
): void {
  const value = laneStringOption(laneOptions, String(name));
  if (value && (optionUsesDefault(String(name)) || options[name] === undefined)) {
    (options as Record<string, unknown>)[name] = value;
  }
}

function toGeminiDeepThinkFallback(value: string | undefined): "fail" | undefined {
  return value === "fail" ? "fail" : undefined;
}

function laneStringOption(options: Record<string, unknown>, name: string): string | undefined {
  const value = options[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => value?.trim());
}

function formatRouteTargetForLog(raw: string | undefined): string {
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    const segments = parsed.pathname.split("/").filter(Boolean);
    let routePath = "";
    if (segments.length > 0) {
      routePath = `/${segments[0]}`;
      if (segments.length > 1) {
        routePath += "/...";
      }
    }
    return `${parsed.host}${routePath}`;
  } catch {
    return raw.replace(/^https?:\/\//u, "").replace(/\/+$/u, "");
  }
}

function validateApiProviderRoutingForCli(runOptions: RunOracleOptions): void {
  const models =
    Array.isArray(runOptions.models) && runOptions.models.length > 0
      ? runOptions.models
      : [runOptions.model];
  for (const model of models) {
    validateProviderRouting(
      {
        model,
        providerMode: runOptions.provider,
        azure: runOptions.azure,
      },
      {
        onAzureDeploymentMissing: (state) => {
          console.log(
            chalk.dim(
              `Provider: Azure OpenAI | endpoint: ${formatRouteTargetForLog(state.azureEndpoint)} | deployment: none | key: ${
                runOptions.apiKey ? "apiKey option" : "AZURE_OPENAI_API_KEY|OPENAI_API_KEY"
              }`,
            ),
          );
        },
      },
    );
  }
}

export function warnGeminiIgnoredThinkingTime(
  model: string,
  thinkingTime: BrowserSessionConfig["thinkingTime"],
  logFn: (message: string) => void = console.log,
): void {
  if (model.startsWith("gemini") && thinkingTime) {
    logFn(
      chalk.dim(
        "Browser thinking-time is ignored for Gemini web runs (no lighter-mode control exists for Deep Think).",
      ),
    );
  }
}

export function enforceBrowserSearchFlag(
  runOptions: RunOracleOptions,
  sessionMode: SessionMode,
  logFn: (message: string) => void = console.log,
): void {
  if (sessionMode === "browser" && runOptions.search === false) {
    logFn(chalk.dim("Note: search is not available in browser engine; ignoring search=false."));
    runOptions.search = undefined;
  }
}

function resolveHeartbeatIntervalMs(seconds: number | undefined): number | undefined {
  if (typeof seconds !== "number" || seconds <= 0) {
    return undefined;
  }
  return Math.round(seconds * 1000);
}

function normalizeProtectedProviderToken(value: string | undefined): string {
  return (
    value
      ?.trim()
      .toLowerCase()
      .replace(/[\s_]+/gu, "-") ?? ""
  );
}

function providerSelectsGeminiDeepThink(value: string | undefined): boolean {
  const normalized = normalizeProtectedProviderToken(value);
  return normalized === "gemini-deep-think" || normalized === "deep-think";
}

function shouldUseGeminiDeepThinkRootRoute(options: CliOptions): boolean {
  const provider = normalizeProtectedProviderToken(options.provider);
  return (
    providerSelectsGeminiDeepThink(provider) ||
    (provider === "gemini" && Boolean(options.geminiDeepThink || options.deepThink)) ||
    isGeminiDeepThinkModelAlias(options.model)
  );
}

function applyGeminiDeepThinkRootDefaults(
  options: CliOptions,
  optionUsesDefault: (name: string) => boolean,
): void {
  if (!shouldUseGeminiDeepThinkRootRoute(options)) {
    return;
  }
  if (optionUsesDefault("engine")) {
    options.engine = "browser";
  }
  if (optionUsesDefault("model") || !options.model || isGeminiDeepThinkModelAlias(options.model)) {
    options.model = "gemini-3-pro-deep-think";
  }
}

interface FollowupResolution {
  responseId: string;
  sessionId?: string;
}

function assertFollowupSupported({
  engine,
  model,
  baseUrl,
  azureEndpoint,
}: {
  engine: EngineMode;
  model: ModelName;
  baseUrl?: string;
  azureEndpoint?: string;
}): void {
  // Claude Code (Fable lane) follow-ups are handled entirely by
  // `resolveClaudeCodeFollowupReference` before this function is ever
  // reached (mirrors how a resolved browser follow-up short-circuits this
  // check too) — this just needs to stop hard-refusing the engine so that
  // path is reachable at all (claude-provider-map.md finding #2, gap a).
  // The OpenAI-Responses-API-specific checks below stay scoped to
  // `engine === "api"`; they say nothing about the claude-code lane's own
  // resume mechanism.
  if (engine !== "api" && engine !== "claude-code") {
    throw new Error("--followup requires --engine api or --engine claude-code.");
  }
  if (engine === "api" && (model.startsWith("gemini") || model.startsWith("claude"))) {
    throw new Error(
      `--followup is only supported for OpenAI Responses API runs. Model ${model} uses a provider client without previous_response_id support.`,
    );
  }
  if (engine === "api" && baseUrl && !azureEndpoint) {
    throw new Error(
      "--followup is only supported for the default OpenAI Responses API or Azure OpenAI Responses. Custom --base-url providers are not supported.",
    );
  }
}

function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const previous = Array.from<number>({ length: b.length + 1 });
  const current = Array.from<number>({ length: b.length + 1 });
  for (let j = 0; j <= b.length; j += 1) {
    previous[j] = j;
  }
  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const substitutionCost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + substitutionCost,
      );
    }
    for (let j = 0; j <= b.length; j += 1) {
      previous[j] = current[j];
    }
  }
  return previous[b.length];
}

function scoreSessionSimilarity(input: string, candidate: string): number {
  if (input === candidate) return 1;
  if (candidate.startsWith(input) || input.startsWith(candidate)) return 0.95;
  if (candidate.includes(input) || input.includes(candidate)) return 0.8;
  const distance = levenshteinDistance(input, candidate);
  const maxLength = Math.max(input.length, candidate.length);
  if (maxLength === 0) return 0;
  return Math.max(0, 1 - distance / maxLength);
}

async function suggestFollowupSessionIds(input: string, limit = 3): Promise<string[]> {
  const normalizedInput = input.trim().toLowerCase();
  if (!normalizedInput) return [];
  const sessions = await sessionStore.listSessions().catch(() => []);
  const seen = new Set<string>();
  const ranked = sessions
    .map((meta) => meta.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0)
    .filter((id) => {
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .map((id) => ({ id, score: scoreSessionSimilarity(normalizedInput, id.toLowerCase()) }))
    .filter((entry) => entry.score >= 0.45)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  return ranked.map((entry) => entry.id);
}

async function resolveFollowupReference(
  value: string,
  followupModel?: string,
): Promise<FollowupResolution> {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error("--followup requires a session id or response id.");
  }
  if (trimmed.startsWith("resp_")) {
    return { responseId: trimmed };
  }

  // Treat as oracle session id (slug).
  const meta = await sessionStore.readSession(trimmed);
  if (!meta) {
    const suggestions = await suggestFollowupSessionIds(trimmed);
    const suggestionText =
      suggestions.length > 0
        ? ` Did you mean: ${suggestions.map((id) => `"${id}"`).join(", ")}?`
        : "";
    throw new Error(
      `No session found with ID ${trimmed}.${suggestionText} Run "oracle status --hours 72 --limit 20" to list recent sessions.`,
    );
  }
  const fromMetadata = extractResponseIdFromSession(meta, followupModel);
  if (fromMetadata) {
    return { responseId: fromMetadata, sessionId: meta.id };
  }

  // Fallback: scrape the log for a response id (covers older sessions / edge cases).
  const logText = await sessionStore.readLog(trimmed).catch(() => "");
  const matches = logText.match(/resp_[A-Za-z0-9]+/g) ?? [];
  const last = matches.length > 0 ? matches[matches.length - 1] : null;
  if (last) {
    return { responseId: last, sessionId: meta.id };
  }

  throw new Error(
    `Session ${trimmed} does not contain a stored response id. Ensure the original run produced a Responses API response id (background/store helps).`,
  );
}

function extractResponseIdFromSession(
  meta: SessionMetadata,
  followupModel?: string,
): string | null {
  // Single-model sessions store response metadata at the session root.
  const rootResponse =
    (meta as unknown as { response?: Record<string, unknown> | null }).response ?? null;
  const rootResponseId =
    (rootResponse?.responseId as string | undefined) ?? (rootResponse?.id as string | undefined);
  if (rootResponseId && rootResponseId.startsWith("resp_")) {
    return rootResponseId;
  }

  const runs = Array.isArray(meta.models) ? meta.models : [];
  if (runs.length === 0) {
    return null;
  }
  const pickRun = (): (typeof runs)[number] | null => {
    if (followupModel) {
      return runs.find((r) => r.model === followupModel) ?? null;
    }
    return runs.length === 1 ? runs[0] : null;
  };
  const chosen = pickRun();
  if (!chosen) {
    const models = runs.map((r) => r.model).join(", ");
    throw new Error(
      followupModel
        ? `Session ${meta.id} has no model named ${followupModel}. Available: ${models}`
        : `Session ${meta.id} has multiple model runs. Re-run with --followup-model. Available: ${models}`,
    );
  }
  const runResponse =
    (chosen as unknown as { response?: Record<string, unknown> | null }).response ?? null;
  const runResponseId =
    (runResponse?.responseId as string | undefined) ?? (runResponse?.id as string | undefined);
  return runResponseId && runResponseId.startsWith("resp_") ? runResponseId : null;
}

function buildRunOptionsFromMetadata(metadata: SessionMetadata): RunOracleOptions {
  const stored = metadata.options ?? {};
  return {
    prompt: stored.prompt ?? "",
    model: (stored.model as ModelName) ?? DEFAULT_MODEL,
    models: stored.models as ModelName[] | undefined,
    previousResponseId: stored.previousResponseId,
    browserResumeConversationUrl: stored.browserResumeConversationUrl,
    effectiveModelId: stored.effectiveModelId ?? stored.model,
    modelOverrides: stored.modelOverrides,
    file: stored.file ?? [],
    maxFileSizeBytes: stored.maxFileSizeBytes,
    slug: stored.slug,
    filesReport: stored.filesReport,
    maxInput: stored.maxInput,
    maxOutput: stored.maxOutput,
    system: stored.system,
    silent: stored.silent,
    search: stored.search,
    preview: false,
    previewMode: undefined,
    apiKey: undefined,
    provider: stored.provider,
    baseUrl: normalizeBaseUrl(stored.baseUrl),
    azure: stored.azure,
    timeoutSeconds: stored.timeoutSeconds,
    httpTimeoutMs: stored.httpTimeoutMs,
    zombieTimeoutMs: stored.zombieTimeoutMs,
    zombieUseLastActivity: stored.zombieUseLastActivity,
    partialMode: stored.partialMode,
    sessionId: metadata.id,
    verbose: stored.verbose,
    heartbeatIntervalMs: stored.heartbeatIntervalMs,
    browserAttachments: stored.browserAttachments,
    browserInlineFiles: stored.browserInlineFiles,
    browserBundleFiles: stored.browserBundleFiles,
    browserBundleFormat: stored.browserBundleFormat,
    browserFollowUps: stored.browserFollowUps,
    background: stored.background,
    renderPlain: stored.renderPlain,
    writeOutputPath: stored.writeOutputPath,
  };
}

function getSessionMode(metadata: SessionMetadata): SessionMode {
  return metadata.mode ?? metadata.options?.mode ?? "api";
}

function getBrowserConfigFromMetadata(metadata: SessionMetadata): BrowserSessionConfig | undefined {
  return metadata.options?.browserConfig ?? metadata.browser?.config;
}

async function runRootCommand(options: CliOptions): Promise<void> {
  perfTrace.mark("root-command-start");
  const jsonMode = isJsonModeRequested(userCliArgs);
  if (process.env.ORACLE_FORCE_TUI === "1" && userCliArgs.length === 0) {
    const { launchTui } = await import("../src/cli/tui/index.js");
    await sessionStore.ensureStorage();
    await launchTui({ version: VERSION, printIntro: false });
    return;
  }
  if (options.debugHelp) {
    printDebugHelp(program.name());
    return;
  }
  const userConfig = (await loadUserConfig()).config;
  const helpRequested = rawCliArgs.some((arg: string) => arg === "--help" || arg === "-h");
  const multiModelProvided = Array.isArray(options.models) && options.models.length > 0;
  const optionUsesDefault = (name: string): boolean => {
    // Commander reports undefined for untouched options, so treat undefined/default the same
    const source = program.getOptionValueSource?.(name);
    return source == null || source === "default";
  };
  if (multiModelProvided && !optionUsesDefault("model") && normalizeModelOption(options.model)) {
    throw new Error("--models cannot be combined with --model.");
  }
  if (helpRequested) {
    if (options.verbose) {
      console.log("");
      printDebugHelp(program.name());
      console.log("");
    }
    program.help({ error: false });
    return;
  }
  const previewMode = resolvePreviewMode(options.dryRun || options.preview);
  const mergedFileInputs = mergePathLikeOptions(
    options.file,
    options.include,
    options.files,
    options.path,
    options.paths,
  );
  if (mergedFileInputs.length > 0) {
    const { deduped, duplicates } = dedupePathInputs(mergedFileInputs, { cwd: process.cwd() });
    if (duplicates.length > 0) {
      const preview = duplicates.slice(0, 8).join(", ");
      const suffix = duplicates.length > 8 ? ` (+${duplicates.length - 8} more)` : "";
      console.log(chalk.dim(`Ignoring duplicate --file inputs: ${preview}${suffix}`));
    }
    options.file = deduped;
  }
  const copyMarkdown = options.copyMarkdown || options.copy;
  const renderMarkdown = resolveRenderFlag(options.render, options.renderMarkdown);
  const renderPlain = resolveRenderPlain(
    options.renderPlain,
    options.render,
    options.renderMarkdown,
  );

  const applyRetentionOption = (): void => {
    if (optionUsesDefault("retainHours") && typeof userConfig.sessionRetentionHours === "number") {
      options.retainHours = userConfig.sessionRetentionHours;
    }
    const envRetention = process.env.ORACLE_RETAIN_HOURS;
    if (optionUsesDefault("retainHours") && envRetention) {
      const parsed = Number.parseFloat(envRetention);
      if (!Number.isNaN(parsed)) {
        options.retainHours = parsed;
      }
    }
  };
  applyRetentionOption();

  const remoteConfig = resolveRemoteServiceConfig({
    cliHost: options.remoteHost,
    cliToken: options.remoteToken,
    cliMode: options.remoteBrowser,
    userConfig,
    env: process.env,
    allowMissingToken: true,
  });
  const remoteHost = remoteConfig.host;
  const remoteToken = remoteConfig.token;

  if (routingCliArgs.length === 0) {
    if (remoteHost) {
      console.log(chalk.dim(`Remote browser host detected: ${remoteHost}`));
    }
    console.log(
      chalk.yellow(
        "No prompt or subcommand supplied. Run `oracle --help` or `oracle tui` for the TUI.",
      ),
    );
    program.outputHelp();
    return;
  }
  if (options.dryRun && renderMarkdown) {
    throw new Error("--dry-run cannot be combined with --render-markdown.");
  }

  applyGeminiDeepThinkRootDefaults(options, optionUsesDefault);
  if (!multiModelProvided && optionUsesDefault("model") && userConfig.model) {
    options.model = userConfig.model;
  }
  if (optionUsesDefault("search") && userConfig.search) {
    options.search = userConfig.search === "on";
  }
  if (optionUsesDefault("filesReport") && userConfig.filesReport != null) {
    options.filesReport = Boolean(userConfig.filesReport);
  }
  if (optionUsesDefault("heartbeat") && typeof userConfig.heartbeatSeconds === "number") {
    options.heartbeat = userConfig.heartbeatSeconds;
  }
  if (optionUsesDefault("baseUrl") && userConfig.apiBaseUrl) {
    options.baseUrl = userConfig.apiBaseUrl;
  }
  applyGeminiDeepThinkRootDefaults(options, optionUsesDefault);

  const providerMode = resolveApiProviderMode(options);
  const runningUnderVitest =
    process.env.VITEST === "true" ||
    process.env.VITEST_WORKER_ID !== undefined ||
    process.env.VITEST_POOL_ID !== undefined;
  const allowLegacyRoutesForTests =
    runningUnderVitest && process.env.ORACLE_TEST_ALLOW_LEGACY_ROUTES === "1";
  const lanePolicyRequested =
    Boolean(options.lane) ||
    options.engine === "claude-code" ||
    (process.env.ORACLE_ENGINE ?? "").trim().toLowerCase() === "claude-code" ||
    userConfig.engine === "claude-code" ||
    isFableModel(options.model) ||
    (options.models ?? []).some((model) => isFableModel(model));
  const passiveProviderDiagnostic =
    (options.route || options.preflight) &&
    !options.lane &&
    options.engine !== "claude-code" &&
    (process.env.ORACLE_ENGINE ?? "").trim().toLowerCase() !== "claude-code" &&
    userConfig.engine !== "claude-code" &&
    !isFableModel(options.model) &&
    !(options.models ?? []).some((model) => isFableModel(model));
  const applyActiveLanePolicy =
    lanePolicyRequested &&
    !(
      passiveProviderDiagnostic ||
      renderMarkdown ||
      copyMarkdown ||
      options.status ||
      options.session ||
      options.execSession ||
      options.finalizeSession
    );
  let resolvedLane: ResolvedOracleLane | null = null;
  if (applyActiveLanePolicy) {
    const lanePolicyRemoteHost = optionUsesDefault("remoteHost") ? undefined : remoteHost;
    const lanePolicyRemoteBrowser = optionUsesDefault("remoteBrowser")
      ? undefined
      : remoteConfig.mode;
    const laneDecision = resolveLanePolicy({
      lane: options.lane,
      engine: options.engine,
      model: options.lane && optionUsesDefault("model") ? undefined : options.model,
      models: options.models,
      prompt: options.prompt,
      files: options.file,
      slug: options.slug,
      source: "cli",
      envEngine: process.env.ORACLE_ENGINE,
      configEngine: userConfig.engine,
      remoteHost: lanePolicyRemoteHost,
      remoteChrome: !optionUsesDefault("remoteChrome") ? options.remoteChrome : undefined,
      remoteBrowser: lanePolicyRemoteBrowser,
      browserFlags: collectLaneBrowserConflictFlags(options, optionUsesDefault),
      apiProviderRequested:
        providerMode !== "auto" ||
        hasExplicitAzureOption(optionUsesDefault) ||
        !optionUsesDefault("baseUrl"),
      allowLegacyRoutes: allowLegacyRoutesForTests,
    });
    if (!laneDecision.ok) {
      throw new LaneRouteBlockError(laneDecision);
    }
    resolvedLane = laneDecision.resolvedLane;
  }
  if (remoteHost && resolvedLane?.transportEligibility !== "local-only") {
    console.log(chalk.dim(`Remote browser host detected: ${remoteHost}`));
  }
  if (resolvedLane) {
    if (options.route || options.preflight) {
      throw new Error(
        "--route/--preflight are API-provider diagnostics and cannot inspect reviewed lanes. Use `oracle doctor lanes --json` or a lane dry-run instead.",
      );
    }
    applyResolvedLaneCliOptions(options, resolvedLane, optionUsesDefault);
  }
  // applyGeminiDeepThinkRootDefaults already coerces engine to "browser" when a
  // deep-think alias is requested, so by the time we reach this resolveApiModel
  // call the only deep-think models we will see are ones the user explicitly
  // pinned with --engine browser. Route those through inferModelFromLabel so we
  // preserve the protected-browser passthrough; everything else still gets the
  // strict API-mode resolver.
  const resolveModelForEngine = (entry: string): ModelName =>
    options.engine === "claude-code"
      ? (entry as ModelName)
      : options.engine === "browser"
        ? (inferModelFromLabel(entry) as ModelName)
        : resolveApiModel(entry);
  const engineModels = multiModelProvided
    ? Array.from(new Set(options.models!.map(resolveModelForEngine)))
    : [resolveModelForEngine(normalizeModelOption(options.model) || DEFAULT_MODEL)];
  if (options.route || options.preflight) {
    const routeAzureEndpoint = firstNonEmpty(
      options.azureEndpoint,
      process.env.AZURE_OPENAI_ENDPOINT,
      userConfig.azure?.endpoint,
    );
    const configuredAzureForRoute = routeAzureEndpoint
      ? {
          endpoint: routeAzureEndpoint,
          deployment: firstNonEmpty(
            options.azureDeployment,
            process.env.AZURE_OPENAI_DEPLOYMENT,
            userConfig.azure?.deployment,
          ),
          apiVersion: firstNonEmpty(
            options.azureApiVersion,
            process.env.AZURE_OPENAI_API_VERSION,
            userConfig.azure?.apiVersion,
          ),
        }
      : undefined;
    const { buildProviderRoutePlan } = await import("../src/oracle/providerRoutePlan.js");
    const plans = engineModels.map((model) =>
      buildProviderRoutePlan({
        model,
        providerMode,
        azure: configuredAzureForRoute,
        baseUrl: options.baseUrl,
        env: process.env,
      }),
    );
    const { printProviderPlans } = await import("../src/cli/providerDoctor.js");
    printProviderPlans(plans, { title: options.preflight ? "Provider preflight" : "Route plan" });
    process.exitCode = plans.some((plan) => !plan.ok) ? 1 : 0;
    return;
  }

  const retentionHours = typeof options.retainHours === "number" ? options.retainHours : undefined;
  await sessionStore.ensureStorage();
  await pruneOldSessions(retentionHours, (message) => console.log(chalk.dim(message)));
  if (providerMode === "openai") {
    if (hasExplicitAzureOption(optionUsesDefault)) {
      throw new Error("--provider openai/--no-azure cannot be combined with Azure options.");
    }
    options.azureEndpoint = undefined;
    options.azureDeployment = undefined;
    options.azureApiVersion = undefined;
  } else {
    if (optionUsesDefault("azureEndpoint")) {
      if (process.env.AZURE_OPENAI_ENDPOINT) {
        options.azureEndpoint = process.env.AZURE_OPENAI_ENDPOINT;
      } else if (userConfig.azure?.endpoint) {
        options.azureEndpoint = userConfig.azure.endpoint;
      }
    }
    if (optionUsesDefault("azureDeployment")) {
      if (process.env.AZURE_OPENAI_DEPLOYMENT) {
        options.azureDeployment = process.env.AZURE_OPENAI_DEPLOYMENT;
      } else if (userConfig.azure?.deployment) {
        options.azureDeployment = userConfig.azure.deployment;
      }
    }
    if (optionUsesDefault("azureApiVersion")) {
      if (process.env.AZURE_OPENAI_API_VERSION) {
        options.azureApiVersion = process.env.AZURE_OPENAI_API_VERSION;
      } else if (userConfig.azure?.apiVersion) {
        options.azureApiVersion = userConfig.azure.apiVersion;
      }
    }
    if (providerMode === "azure" && !options.azureEndpoint?.trim()) {
      throw new Error("--provider azure requires --azure-endpoint or AZURE_OPENAI_ENDPOINT.");
    }
  }

  const azureAutoApiRequested =
    providerMode !== "openai" &&
    Boolean(options.azureEndpoint?.trim()) &&
    engineModels.some((model) => isAzureOpenAICandidateModel(model));
  const explicitApiProviderRequested =
    providerMode !== "auto" ||
    hasExplicitAzureOption(optionUsesDefault) ||
    !optionUsesDefault("baseUrl");
  const envEnginePreference = (process.env.ORACLE_ENGINE ?? "").trim().toLowerCase();
  const explicitApiEngineRequested =
    options.engine === "api" || (!options.engine && envEnginePreference === "api");
  const explicitClaudeCodeEngineRequested = options.engine === "claude-code";
  const configBrowserEngineRequested =
    !options.engine &&
    userConfig.engine === "browser" &&
    !explicitApiEngineRequested &&
    !explicitApiProviderRequested;
  let engine: EngineMode = resolveEngine({
    engine: options.engine,
    configEngine: userConfig.engine,
    browserFlag: options.browser,
    apiProviderRequested: explicitApiProviderRequested,
    env: process.env,
  });
  const browserEngineRequested =
    !explicitClaudeCodeEngineRequested &&
    (options.browser ||
      options.engine === "browser" ||
      Boolean(remoteHost) ||
      configBrowserEngineRequested ||
      (!options.engine && !explicitApiProviderRequested && envEnginePreference === "browser"));
  if (
    remoteHost &&
    engine !== "claude-code" &&
    !explicitApiEngineRequested &&
    !explicitApiProviderRequested
  ) {
    engine = "browser";
  }
  if (azureAutoApiRequested && engine === "browser" && !browserEngineRequested) {
    engine = "api";
  }
  if (options.browser) {
    console.log(chalk.yellow("`--browser` is deprecated; use `--engine browser` instead."));
  }

  const remoteHostExplicitlyRequested =
    !optionUsesDefault("remoteHost") || !optionUsesDefault("remoteBrowser");
  const remoteBrowserHostForRun = engine === "browser" ? remoteHost : undefined;
  if (
    remoteHost &&
    engine !== "browser" &&
    engine !== "claude-code" &&
    remoteHostExplicitlyRequested
  ) {
    throw new Error("--remote-host requires --engine browser.");
  }
  if (remoteBrowserHostForRun && options.remoteChrome) {
    throw new Error("--remote-host cannot be combined with --remote-chrome.");
  }
  if (options.browserTab && engine !== "browser") {
    throw new Error("--browser-tab requires --engine browser.");
  }

  const normalizedMultiModels: ModelName[] = multiModelProvided
    ? Array.from(new Set(options.models!.map((entry) => resolveApiModel(entry))))
    : [];
  const cliModelArg =
    normalizeModelOption(options.model) || (multiModelProvided ? "" : DEFAULT_MODEL);
  const resolvedModelCandidate: ModelName = multiModelProvided
    ? normalizedMultiModels[0]
    : engine === "claude-code"
      ? (cliModelArg as ModelName)
      : engine === "browser"
        ? inferModelFromLabel(cliModelArg || DEFAULT_MODEL)
        : resolveApiModel(cliModelArg || DEFAULT_MODEL);
  const primaryModelCandidate = normalizedMultiModels[0] ?? resolvedModelCandidate;
  const isGemini = primaryModelCandidate.startsWith("gemini");
  const isCodex = primaryModelCandidate.startsWith("gpt-5.1-codex");
  const isClaude = primaryModelCandidate.startsWith("claude");
  const userForcedBrowser = options.browser || options.engine === "browser";
  const browserExplicitlyRequested = browserEngineRequested;
  const isBrowserCompatible = (model: string) =>
    model.startsWith("gpt-") || model.startsWith("gemini");
  const hasNonBrowserCompatibleTarget =
    normalizedMultiModels.length > 0
      ? normalizedMultiModels.some((model) => !isBrowserCompatible(model))
      : !isBrowserCompatible(resolvedModelCandidate);
  if (browserExplicitlyRequested && hasNonBrowserCompatibleTarget) {
    throw new Error(
      "Browser engine only supports GPT and Gemini models. Re-run with --engine api for Grok, Claude, or other models.",
    );
  }
  if (engine === "browser" && hasNonBrowserCompatibleTarget) {
    engine = "api";
  }
  if (isClaude && engine === "browser") {
    console.log(chalk.dim("Browser engine is not supported for Claude models; switching to API."));
    engine = "api";
  }
  if (isCodex && engine === "browser") {
    console.log(chalk.dim("Browser engine is not supported for gpt-5.1-codex; switching to API."));
    engine = "api";
  }
  if (normalizedMultiModels.length > 0) {
    engine = "api";
  }
  if (remoteHost && normalizedMultiModels.length > 0) {
    throw new Error("--remote-host does not support --models yet. Use API engine locally instead.");
  }
  const resolvedModel: ModelName =
    normalizedMultiModels[0] ??
    (isGemini && engine !== "browser" ? resolveApiModel(cliModelArg) : resolvedModelCandidate);
  // A user-config apiModel override (known models only) wins over Gemini alias
  // remapping and the bundled apiModel, so it becomes the on-wire request id.
  const apiModelOverrides = engine === "api" ? userConfig.modelOverrides : undefined;
  const overriddenApiModel = resolveOverriddenApiModel(resolvedModel, apiModelOverrides);
  const effectiveModelId =
    overriddenApiModel ??
    (resolvedModel.startsWith("gemini")
      ? resolveGeminiModelId(resolvedModel)
      : isKnownModel(resolvedModel)
        ? (MODEL_CONFIGS[resolvedModel].apiModel ?? resolvedModel)
        : resolvedModel);
  const resolvedBaseUrl = normalizeBaseUrl(
    options.baseUrl ?? (isClaude ? process.env.ANTHROPIC_BASE_URL : process.env.OPENAI_BASE_URL),
  );
  const { models: _rawModels, ...optionsWithoutModels } = options;
  const resolvedOptions: ResolvedCliOptions = { ...optionsWithoutModels, model: resolvedModel };
  resolvedOptions.maxFileSizeBytes =
    options.maxFileSizeBytes ?? resolveConfiguredMaxFileSizeBytes(userConfig, process.env);
  if (normalizedMultiModels.length > 0) {
    resolvedOptions.models = normalizedMultiModels;
  }
  resolvedOptions.baseUrl = resolvedBaseUrl;
  resolvedOptions.effectiveModelId = effectiveModelId;
  resolvedOptions.modelOverrides = apiModelOverrides;
  resolvedOptions.provider = providerMode;
  resolvedOptions.writeOutputPath = resolveOutputPath(options.writeOutput, process.cwd());

  if (options.status) {
    const { attachSession, showStatus } = await import("../src/cli/sessionDisplay.js");
    if (options.session) {
      await attachSession(options.session);
    } else {
      await showStatus({ hours: 24, includeAll: false, limit: 100, showExamples: true });
    }
    return;
  }

  if (options.session) {
    const { attachSession } = await import("../src/cli/sessionDisplay.js");
    await attachSession(options.session);
    return;
  }

  if (options.execSession) {
    await executeSession(options.execSession);
    return;
  }

  if (options.finalizeSession) {
    await finalizeSession(options.finalizeSession);
    return;
  }

  if (renderMarkdown || copyMarkdown) {
    if (!options.prompt) {
      throw new Error("Prompt is required when using --render-markdown or --copy-markdown.");
    }
    const bundle = await buildMarkdownBundle(
      { prompt: options.prompt, file: options.file, system: options.system },
      { cwd: process.cwd() },
    );
    const modelConfig = isKnownModel(resolvedModel)
      ? MODEL_CONFIGS[resolvedModel]
      : MODEL_CONFIGS["gpt-5.1"];
    const { buildRequestBody } = await import("../src/oracle/request.js");
    const { estimateRequestTokens } = await import("../src/oracle/tokenEstimate.js");
    const requestBody = buildRequestBody({
      modelConfig,
      systemPrompt: bundle.systemPrompt,
      userPrompt: bundle.promptWithFiles,
      searchEnabled: options.search !== false,
      background: false,
      storeResponse: false,
    });
    const estimatedTokens = estimateRequestTokens(requestBody, modelConfig);
    const warnThreshold = Math.min(196_000, modelConfig.inputLimit ?? 196_000);
    warnIfOversizeBundle(estimatedTokens, warnThreshold, console.log);
    if (renderMarkdown) {
      const output = renderPlain
        ? bundle.markdown
        : await formatRenderedMarkdown(bundle.markdown, { richTty: isTty });
      // Trim trailing newlines from the rendered bundle so we print exactly one blank before the summary line.
      console.log(output.replace(/\n+$/u, ""));
    }
    if (copyMarkdown) {
      const result = await copyToClipboard(bundle.markdown);
      if (result.success) {
        const filesPart = bundle.files.length > 0 ? `; ${bundle.files.length} files` : "";
        const summary = `Copied markdown to clipboard (~${formatCompactNumber(estimatedTokens)} tokens${filesPart}).`;
        console.log(chalk.green(summary));
      } else {
        const reason =
          result.error instanceof Error
            ? result.error.message
            : String(result.error ?? "unknown error");
        console.log(
          chalk.dim(
            `Copy failed (${reason}); markdown not printed. Re-run with --render-markdown if you need the content.`,
          ),
        );
      }
    }
    return;
  }

  const getSource = (key: keyof CliOptions) =>
    program.getOptionValueSource?.(key as string) ?? undefined;
  const { applyBrowserDefaultsFromConfig } = await import("../src/cli/browserDefaults.js");
  applyBrowserDefaultsFromConfig(options, userConfig, getSource);
  const attachmentTimeoutEnv = process.env.ORACLE_BROWSER_ATTACHMENT_TIMEOUT?.trim();
  if (
    attachmentTimeoutEnv &&
    (getSource("browserAttachmentTimeout") === undefined ||
      getSource("browserAttachmentTimeout") === "default")
  ) {
    options.browserAttachmentTimeout = attachmentTimeoutEnv;
  }

  let browserFollowup: Awaited<ReturnType<typeof resolveBrowserFollowupReference>> = null;
  // caam-map.md "same profile or refuse" (set only for a resolved Claude
  // Code --followup): carries the parent session's caam profile forward so
  // the guard can be asserted against the ACTUAL built RunOracleOptions —
  // i.e. resolved the exact same way `sessionRunner.ts` will resolve it,
  // config-key form (`runOptions.claudeCode.caamProfile`) preferred over the
  // ORACLE_CLAUDE_CODE_CAAM_PROFILE env form — instead of an env-only guess.
  let claudeCodeFollowupProfileGuard: {
    parentSessionId: string;
    parentProfile?: string;
  } | null = null;
  if (options.followup) {
    if (normalizedMultiModels.length > 0) {
      throw new Error("--followup cannot be combined with --models.");
    }
    browserFollowup = await resolveBrowserFollowupReference(options.followup, sessionStore);
    if (browserFollowup) {
      // A --lane was already validated and applied by `resolveLanePolicy`
      // above (`resolvedLane`); resolving --followup independently of that
      // lane must not silently reroute engine/model away from what lane
      // policy just verified — refuse instead (mirrors the caam-profile
      // fail-closed guard below).
      assertFollowupLaneMatchesResolvedLane({
        resolvedLane,
        followupSessionId: browserFollowup.sessionId,
        followupLane: browserFollowup.lane,
        followupEngine: "browser",
      });
      engine = "browser";
      resolvedOptions.model = browserFollowup.model;
      resolvedOptions.effectiveModelId = browserFollowup.model;
      resolvedOptions.followupSessionId = browserFollowup.sessionId;
      resolvedOptions.browserResumeConversationUrl = browserFollowup.resumeConversationUrl;
    } else {
      const claudeCodeFollowup = await resolveClaudeCodeFollowupReference(
        options.followup,
        sessionStore,
      );
      if (claudeCodeFollowup) {
        // Same lane-consistency guard as the browser-followup branch above.
        assertFollowupLaneMatchesResolvedLane({
          resolvedLane,
          followupSessionId: claudeCodeFollowup.sessionId,
          followupLane: claudeCodeFollowup.lane,
          followupEngine: "claude-code",
        });
        // caam-map.md "same profile or refuse": record what the parent ran
        // under; the actual refusal happens right after `buildRunOptions`
        // (still before anything is spawned) via
        // `assertClaudeCodeFollowupProfileMatchesRun`, which resolves the
        // profile THIS run would use the exact same way `sessionRunner.ts`
        // will — BOTH the config-key form (`runOptions.claudeCode.caamProfile`)
        // and the env form, config key preferred. A resumed session must
        // attach to the SAME `$HOME`/credential identity as its parent.
        claudeCodeFollowupProfileGuard = {
          parentSessionId: claudeCodeFollowup.sessionId,
          parentProfile: claudeCodeFollowup.caamProfile,
        };
        engine = "claude-code";
        if (claudeCodeFollowup.model) {
          resolvedOptions.model = claudeCodeFollowup.model as ModelName;
          resolvedOptions.effectiveModelId = claudeCodeFollowup.model;
        }
        resolvedOptions.followupSessionId = claudeCodeFollowup.sessionId;
        resolvedOptions.claudeCodeResumeSessionId = claudeCodeFollowup.resumeSessionId;
      } else {
        assertFollowupSupported({
          engine,
          model: resolvedModel,
          baseUrl: resolvedBaseUrl,
          azureEndpoint: resolvedOptions.azure?.endpoint,
        });
        const followup = await resolveFollowupReference(options.followup, options.followupModel);
        resolvedOptions.previousResponseId = followup.responseId;
        resolvedOptions.followupSessionId = followup.sessionId;
        resolvedOptions.followupModel = options.followupModel;
      }
    }
  }
  const activeModel = resolvedOptions.model;

  if (engine === "claude-code") {
    if (previewMode || options.dryRun) {
      if (!options.prompt) {
        throw new Error("Prompt is required when using --dry-run/preview.");
      }
      if (userConfig.promptSuffix) {
        options.prompt = `${options.prompt.trim()}\n${userConfig.promptSuffix}`;
      }
      resolvedOptions.prompt = options.prompt;
      const runOptions = buildRunOptions(resolvedOptions, {
        preview: true,
        previewMode: previewMode || "summary",
        background: false,
        baseUrl: undefined,
      });
      if (claudeCodeFollowupProfileGuard) {
        assertClaudeCodeFollowupProfileMatchesRun({
          ...claudeCodeFollowupProfileGuard,
          runOptions,
          env: process.env,
        });
      }
      const { runDryRunSummary } = await import("../src/cli/dryRun.js");
      await runDryRunSummary(
        {
          engine,
          runOptions,
          cwd: process.cwd(),
          version: VERSION,
          log: console.log,
        },
        {},
      );
      return;
    }
  }

  const browserFollowUpCount =
    options.browserFollowUp?.filter((entry) => entry.trim().length > 0).length ?? 0;
  if (engine !== "browser" && browserFollowUpCount > 0) {
    throw new Error("--browser-follow-up requires --engine browser.");
  }

  const sessionMode: SessionMode =
    engine === "browser" ? "browser" : engine === "claude-code" ? "claude-code" : "api";
  const browserConfig = await (async (): Promise<BrowserSessionConfig | undefined> => {
    if (sessionMode !== "browser") return undefined;
    if (browserFollowup) {
      return browserFollowup.browserConfig;
    }
    const { buildBrowserConfig, resolveBrowserModelLabel } =
      await import("../src/cli/browserConfig.js");
    const config = await buildBrowserConfig({
      ...options,
      remoteHost: remoteBrowserHostForRun,
      model: activeModel,
      browserModelLabel: resolveBrowserModelLabel(cliModelArg, activeModel),
    });
    return resolvedOptions.browserResumeConversationUrl
      ? { ...config, resumeConversationUrl: resolvedOptions.browserResumeConversationUrl }
      : config;
  })();

  if (previewMode) {
    if (!options.prompt) {
      throw new Error("Prompt is required when using --dry-run/preview.");
    }
    if (userConfig.promptSuffix) {
      options.prompt = `${options.prompt.trim()}\n${userConfig.promptSuffix}`;
    }
    resolvedOptions.prompt = options.prompt;
    const runOptions = buildRunOptions(resolvedOptions, {
      preview: true,
      previewMode,
      baseUrl: resolvedBaseUrl,
    });
    if (engine === "browser") {
      const { runBrowserPreview } = await import("../src/cli/dryRun.js");
      await runBrowserPreview(
        {
          runOptions,
          cwd: process.cwd(),
          version: VERSION,
          previewMode,
          log: console.log,
          browserConfig,
        },
        {},
      );
      return;
    }
    if (engine !== "claude-code") {
      validateApiProviderRoutingForCli(runOptions);
    }
    const { runDryRunSummary } = await import("../src/cli/dryRun.js");
    if (previewMode === "summary") {
      await runDryRunSummary(
        {
          engine,
          runOptions,
          cwd: process.cwd(),
          version: VERSION,
          log: console.log,
        },
        {},
      );
      return;
    }
    await runDryRunSummary(
      {
        engine,
        runOptions,
        cwd: process.cwd(),
        version: VERSION,
        log: console.log,
      },
      {},
    );
    return;
  }

  if (!options.prompt) {
    throw new Error("Prompt is required when starting a new session.");
  }

  if (userConfig.promptSuffix) {
    options.prompt = `${options.prompt.trim()}\n${userConfig.promptSuffix}`;
  }
  resolvedOptions.prompt = options.prompt;
  const duplicateBlocked = await shouldBlockDuplicatePrompt({
    prompt: resolvedOptions.prompt,
    browserFollowUps: resolvedOptions.browserFollowUp,
    force: options.force,
    sessionStore,
    log: console.log,
  });
  if (duplicateBlocked) {
    process.exitCode = 1;
    return;
  }

  if (options.file && options.file.length > 0) {
    const isBrowserMode = engine === "browser" || userForcedBrowser;
    const filesToValidate = isBrowserMode
      ? options.file.filter((f: string) => !isRawUploadFile(f))
      : options.file;
    if (filesToValidate.length > 0) {
      const { readFiles } = await import("../src/oracle/files.js");
      await readFiles(filesToValidate, {
        cwd: process.cwd(),
        maxFileSizeBytes: resolvedOptions.maxFileSizeBytes,
      });
    }
  }

  const notifications = resolveNotificationSettings({
    cliNotify: options.notify,
    cliNotifySound: options.notifySound,
    env: process.env,
    config: userConfig.notify,
  });

  let browserDeps: BrowserSessionRunnerDeps | undefined;
  if (browserConfig && remoteBrowserHostForRun) {
    if (!remoteToken) {
      throw new Error(
        "remote_browser_token_missing: A remote host is configured but no token was provided.\n" +
          "Fix command: export ORACLE_REMOTE_TOKEN=<token>\n" +
          "Next command: oracle remote doctor --json",
      );
    }
    const { createRemoteBrowserExecutor } = await import("../src/remote/client.js");
    browserDeps = {
      executeBrowser: createRemoteBrowserExecutor({
        host: remoteBrowserHostForRun,
        token: remoteToken,
      }),
    };
    console.log(chalk.dim(`Routing browser automation to remote host ${remoteBrowserHostForRun}`));
  } else if (browserConfig && activeModel.startsWith("gemini")) {
    const { createGeminiWebExecutor } = await import("../src/gemini-web/index.js");
    browserDeps = {
      executeBrowser: createGeminiWebExecutor({
        youtube: options.youtube,
        generateImage: options.generateImage,
        editImage: options.editImage,
        outputPath: options.output,
        aspectRatio: options.aspect,
        showThoughts: options.geminiShowThoughts,
        deepThinkFallback: toGeminiDeepThinkFallback(options.geminiDeepThinkFallback),
      }),
    };
    console.log(chalk.dim("Using Gemini web client for browser automation"));
    if (browserConfig.modelStrategy && browserConfig.modelStrategy !== "select") {
      console.log(chalk.dim("Browser model strategy is ignored for Gemini web runs."));
    }
    warnGeminiIgnoredThinkingTime(activeModel, browserConfig.thinkingTime);
  }
  const remoteExecutionActive = Boolean(browserDeps);

  if (options.dryRun) {
    const baseRunOptions = buildRunOptions(resolvedOptions, {
      preview: false,
      previewMode: undefined,
      baseUrl: resolvedBaseUrl,
    });
    const { runDryRunSummary } = await import("../src/cli/dryRun.js");
    await runDryRunSummary(
      {
        engine,
        runOptions: baseRunOptions,
        cwd: process.cwd(),
        version: VERSION,
        log: console.log,
        browserConfig,
      },
      {},
    );
    return;
  }

  // Decide whether to block until completion:
  // - explicit --wait / --no-wait wins
  // - otherwise block for fast models (gpt-5.1, browser) and detach by default for pro API runs
  let waitPreference = resolveWaitFlag({
    waitFlag: options.wait,
    model: activeModel,
    engine,
  });
  if (remoteBrowserHostForRun && waitPreference === false) {
    console.log(chalk.dim("Remote browser runs require --wait; ignoring --no-wait."));
    waitPreference = true;
  }

  await sessionStore.ensureStorage();
  const baseRunOptions = buildRunOptions(resolvedOptions, {
    preview: false,
    previewMode: undefined,
    background: resolvedOptions.background ?? userConfig.background,
    baseUrl: resolvedBaseUrl,
  });
  // caam-map.md "same profile or refuse": asserted against the ACTUAL run
  // options (config-key + env profile forms) before any session is created
  // or anything is spawned.
  if (claudeCodeFollowupProfileGuard) {
    assertClaudeCodeFollowupProfileMatchesRun({
      ...claudeCodeFollowupProfileGuard,
      runOptions: baseRunOptions,
      env: process.env,
    });
  }
  if (sessionMode === "api") {
    validateApiProviderRoutingForCli(baseRunOptions);
  }
  enforceBrowserSearchFlag(baseRunOptions, sessionMode, console.log);
  if (sessionMode === "browser" && baseRunOptions.search === false) {
    console.log(
      chalk.dim("Note: search is not available in browser engine; ignoring search=false."),
    );
    baseRunOptions.search = undefined;
  }
  const sessionMeta = await sessionStore.createSession(
    {
      ...baseRunOptions,
      mode: sessionMode,
      browserConfig,
      followupSessionId: resolvedOptions.followupSessionId,
      followupModel: resolvedOptions.followupModel,
      browserResumeConversationUrl: resolvedOptions.browserResumeConversationUrl,
      waitPreference,
      youtube: options.youtube,
      generateImage: options.generateImage,
      editImage: options.editImage,
      outputPath: options.output,
      aspectRatio: options.aspect,
      geminiShowThoughts: options.geminiShowThoughts,
      geminiDeepThinkFallback: toGeminiDeepThinkFallback(options.geminiDeepThinkFallback),
    },
    process.cwd(),
    notifications,
  );
  const liveRunOptions: RunOracleOptions = {
    ...baseRunOptions,
    sessionId: sessionMeta.id,
    effectiveModelId: resolvedOptions.effectiveModelId ?? effectiveModelId,
  };
  const disableDetachEnv = process.env.ORACLE_NO_DETACH === "1";
  const detachAllowed = remoteExecutionActive
    ? false
    : shouldDetachSession({
        engine,
        model: activeModel,
        waitPreference,
        disableDetachEnv,
      });
  const detachedLaunch = !detachAllowed
    ? { runnerStarted: false, finalizerStarted: false }
    : await launchDetachedSession(sessionMeta.id, { engine }).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.log(
          chalk.yellow(`Unable to detach session runner (${message}). Running inline...`),
        );
        return { runnerStarted: false, finalizerStarted: false };
      });
  const detached = detachedLaunch.runnerStarted;
  const lifecycle = buildSessionLifecycle({
    engine,
    detached,
    reattachCommand: `oracle session ${sessionMeta.id}`,
  });
  await sessionStore.updateSession(sessionMeta.id, { lifecycle });
  const sessionWithLifecycle: SessionMetadata = { ...sessionMeta, lifecycle };
  if (
    detached &&
    shouldLaunchDetachedSessionFinalizer({ engine }) &&
    !detachedLaunch.finalizerStarted
  ) {
    console.log(
      chalk.yellow("Detached finalizer did not start; use `oracle session --render` if needed."),
    );
  }

  if (!waitPreference) {
    if (!detached) {
      console.log(chalk.red("Unable to start in background; use --wait to run inline."));
      process.exitCode = 1;
      return;
    }
    for (const line of formatSessionLifecycleBlock(sessionWithLifecycle)) {
      console.log(line);
    }
    console.log(
      chalk.dim("Pro runs can take up to 60 minutes (usually 10-15). Add --wait to stay attached."),
    );
    return;
  }

  if (detached === false) {
    await runInteractiveSession(
      sessionWithLifecycle,
      liveRunOptions,
      sessionMode,
      browserConfig,
      false,
      notifications,
      userConfig,
      true,
      browserDeps,
      process.cwd(),
      jsonMode,
    );
    return;
  }
  if (detached) {
    console.log(chalk.blue(`Reattach via: oracle session ${sessionMeta.id}`));
    const { attachSession } = await import("../src/cli/sessionDisplay.js");
    await attachSession(sessionMeta.id, { suppressMetadata: true });
  }
}

async function runInteractiveSession(
  sessionMeta: SessionMetadata,
  runOptions: RunOracleOptions,
  mode: SessionMode,
  browserConfig?: BrowserSessionConfig,
  showReattachHint = true,
  notifications?: NotificationSettings,
  userConfig?: UserConfig,
  suppressSummary = false,
  browserDeps?: BrowserSessionRunnerDeps,
  cwd: string = process.cwd(),
  jsonMode = false,
  // When false alongside jsonMode, stdout stays muted but the top-level
  // success envelope is NOT printed — the caller (e.g. `oracle restart
  // --json`) emits its own single JSON object afterwards instead.
  emitJsonEnvelope = true,
): Promise<void> {
  const { logLine, writeChunk, stream } = sessionStore.createLogWriter(sessionMeta.id);
  let headerAugmented = false;
  const answerChunks: string[] = [];
  const combinedLog = (message = ""): void => {
    if (!headerAugmented && message.startsWith("oracle (")) {
      headerAugmented = true;
      if (showReattachHint && !jsonMode) {
        console.log(`${message}\n${chalk.blue(`Reattach via: oracle session ${sessionMeta.id}`)}`);
      } else if (!jsonMode) {
        console.log(message);
      }
      logLine(message);
      return;
    }
    if (!jsonMode) {
      console.log(message);
    }
    logLine(message);
  };
  const combinedWrite = (chunk: string): boolean => {
    // runOracle handles stdout; keep this write hook for session logs only to avoid double-printing
    writeChunk(chunk);
    if (jsonMode) {
      answerChunks.push(chunk);
    }
    return true;
  };
  if (!jsonMode) {
    for (const line of formatSessionLifecycleBlock(sessionMeta)) {
      console.log(line);
      logLine(line);
    }
  } else {
    for (const line of formatSessionLifecycleBlock(sessionMeta)) {
      logLine(line);
    }
  }
  let latest: SessionMetadata | null = null;
  try {
    const { performSessionRun } = await import("../src/cli/sessionRunner.js");
    await performSessionRun({
      sessionMeta,
      runOptions,
      mode,
      browserConfig,
      cwd,
      log: combinedLog,
      write: combinedWrite,
      version: VERSION,
      notifications:
        notifications ??
        deriveNotificationSettingsFromMetadata(sessionMeta, process.env, userConfig?.notify),
      browserDeps,
      muteStdout: jsonMode,
    });
    latest = await sessionStore.readSession(sessionMeta.id);
    if (!suppressSummary && !jsonMode) {
      const { formatCompletionSummary } = await import("../src/cli/sessionDisplay.js");
      const summary = latest ? formatCompletionSummary(latest, { includeSlug: true }) : null;
      if (summary) {
        console.log("\n" + chalk.green.bold(summary));
        logLine(summary); // plain text in log, colored on stdout
      }
    }
  } finally {
    stream.end();
  }
  if (jsonMode && emitJsonEnvelope) {
    process.stdout.write(
      stableJsonStringify(
        buildTopLevelCliSuccessEnvelope({
          answer: answerChunks.join(""),
          model: latest?.model ?? runOptions.model ?? null,
          sessionId: sessionMeta.id,
          usage: latest?.usage ?? null,
          elapsedMs: latest?.elapsedMs ?? null,
          command: "oracle",
        }),
      ),
    );
  }
}

interface DetachedLaunchResult {
  runnerStarted: boolean;
  finalizerStarted: boolean;
}

async function launchDetachedSession(
  sessionId: string,
  { engine, log = console.log }: { engine: EngineMode; log?: (message: string) => void },
): Promise<DetachedLaunchResult> {
  const env = buildDetachedPerfTraceEnv(process.env, perfTraceArgs.value, sessionId);
  const launchOptions = {
    cliEntrypoint: CLI_ENTRYPOINT,
    env,
  };
  const runnerStarted = await launchDetachedSessionRunner(sessionId, launchOptions);
  const finalizerStarted = shouldLaunchDetachedSessionFinalizer({ engine })
    ? await launchDetachedSessionFinalizer(sessionId, launchOptions).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        log(chalk.yellow(`Unable to detach session finalizer (${message}).`));
        return false;
      })
    : false;
  return {
    runnerStarted,
    finalizerStarted,
  };
}

interface SessionActionJsonIo {
  /** In --json mode progress lines move to stderr; otherwise stdout as before. */
  progress: (message?: string) => void;
  /** In --json mode, mirror a fatal message as one error envelope on stdout. */
  emitJsonError: (message: string) => void;
  /** Print the single oracle_session_action.v1 launch receipt to stdout. */
  emitReceipt: (input: BuildSessionActionInput) => void;
}

function createSessionActionJsonIo(
  jsonMode: boolean,
  command: "oracle restart" | "oracle follow-up",
): SessionActionJsonIo {
  return {
    progress: (message = "") => {
      if (jsonMode) {
        process.stderr.write(`${message}\n`);
      } else {
        console.log(message);
      }
    },
    emitJsonError: (message) => {
      if (!jsonMode) return;
      process.stdout.write(
        stableJsonStringify(
          buildTopLevelCliErrorEnvelope({ error: new Error(message), command, exitCode: 1 }),
        ),
      );
    },
    emitReceipt: (input) => {
      const { envelope } = buildSessionActionEnvelope(input);
      process.stdout.write(renderSessionActionEnvelope(envelope));
    },
  };
}

async function runFollowUpCommand(
  parentSessionId: string,
  promptArg: string | undefined,
  options: FollowUpCommandOptions,
): Promise<void> {
  const jsonMode = Boolean(options.json);
  const { progress, emitJsonError, emitReceipt } = createSessionActionJsonIo(
    jsonMode,
    "oracle follow-up",
  );
  const prompt = (await resolveDashPrompt(options.prompt ?? promptArg ?? "")) ?? "";
  if (!prompt.trim()) {
    const message = "Prompt is required for follow-up. Use positional [prompt] or --prompt.";
    console.error(chalk.red(message));
    emitJsonError(message);
    process.exitCode = 1;
    return;
  }
  if (options.file && options.file.length > 0) {
    const message =
      'Browser follow-up is prompt-only in v1. To attach files, start a new run instead: oracle --lane <lane> --prompt "..." --file <path>';
    console.error(chalk.red(message));
    emitJsonError(message);
    process.exitCode = 1;
    return;
  }

  const { startBrowserFollowUpSession, waitForFollowUpSession } =
    await import("../src/cli/browserFollowUp.js");
  const result = await startBrowserFollowUpSession(parentSessionId, {
    prompt,
    slug: options.slug,
    wait: options.wait,
    recover: options.recover !== false,
    files: options.file,
    cliEntrypoint: CLI_ENTRYPOINT,
    env: process.env,
    log: progress,
  });

  progress(chalk.blue(`Follow-up session: ${result.session.id}`));
  progress(chalk.dim(`Parent session: ${result.parentSessionId}`));
  progress(chalk.dim(`Conversation: ${result.parentConversationUrl}`));
  if (!result.finalizerStarted) {
    progress(chalk.yellow("Detached finalizer did not start; use oracle-await if needed."));
  }

  const buildReceiptInput = (status: string): BuildSessionActionInput => ({
    action: "follow-up",
    sessionId: result.session.id,
    parentSessionId: result.parentSessionId,
    engine: "browser",
    mode: "browser",
    lane: result.session.lane ?? null,
    model: result.session.model ?? null,
    status,
    waitPreference: result.session.options?.waitPreference === true,
    detached: result.detached,
    reattachCommand: result.reattachCommand,
    conversationUrl: result.parentConversationUrl,
  });

  const shouldWait = result.session.options?.waitPreference === true;
  if (!shouldWait) {
    for (const line of formatSessionLifecycleBlock(result.session)) {
      progress(line);
    }
    progress(chalk.blue(`Reattach via: ${result.reattachCommand}`));
    if (jsonMode) {
      emitReceipt(buildReceiptInput(result.session.status));
    }
    return;
  }

  const finalMeta = await waitForFollowUpSession(result.session.id, { log: progress });
  if (!finalMeta) {
    const message = `Follow-up session ${result.session.id} disappeared.`;
    progress(chalk.red(message));
    emitJsonError(message);
    process.exitCode = 1;
    return;
  }
  if (jsonMode) {
    emitReceipt(buildReceiptInput(finalMeta.status));
    return;
  }
  const { attachSession } = await import("../src/cli/sessionDisplay.js");
  await attachSession(result.session.id, { renderMarkdown: true, suppressMetadata: true });
}

async function restartSession(sessionId: string, options: RestartCommandOptions): Promise<void> {
  const jsonMode = Boolean(options.json);
  const { progress, emitJsonError, emitReceipt } = createSessionActionJsonIo(
    jsonMode,
    "oracle restart",
  );
  const metadata = await sessionStore.readSession(sessionId);
  if (!metadata) {
    const message = `No session found with ID ${sessionId}. List valid IDs with: oracle status --json`;
    console.error(chalk.red(message));
    emitJsonError(message);
    process.exitCode = 1;
    return;
  }

  const runOptions = buildRunOptionsFromMetadata(metadata);
  if (!runOptions.prompt) {
    const message = `Session ${sessionId} has no stored prompt; cannot restart. Start a fresh run instead: oracle -p "<prompt>" --lane fable-local`;
    console.error(chalk.red(message));
    emitJsonError(message);
    process.exitCode = 1;
    return;
  }

  const sessionMode = getSessionMode(metadata);
  const engine: EngineMode = sessionMode === "browser" ? "browser" : "api";
  const browserConfig = getBrowserConfigFromMetadata(metadata);
  if (sessionMode === "browser" && !browserConfig) {
    const message = `Session ${sessionId} is missing browser config; cannot restart. Start a fresh run instead: oracle -p "<prompt>" --lane chatgpt-pro (or --lane gemini-deep-think)`;
    console.error(chalk.red(message));
    emitJsonError(message);
    process.exitCode = 1;
    return;
  }

  const userConfig = (await loadUserConfig()).config;
  const cwd = metadata.cwd ?? process.cwd();
  const storedOptions = metadata.options ?? {};

  if (runOptions.file && runOptions.file.length > 0) {
    const isBrowserMode = engine === "browser";
    const filesToValidate = isBrowserMode
      ? runOptions.file.filter((f) => !isRawUploadFile(f))
      : runOptions.file;
    if (filesToValidate.length > 0) {
      const { readFiles } = await import("../src/oracle/files.js");
      await readFiles(filesToValidate, {
        cwd,
        maxFileSizeBytes: runOptions.maxFileSizeBytes,
      });
    }
  }

  enforceBrowserSearchFlag(runOptions, sessionMode, progress);

  let waitPreference = resolveRestartWaitPreference({
    waitFlag: options.wait,
    storedPreference: storedOptions.waitPreference,
    model: runOptions.model,
    engine,
  });

  const remoteConfig = resolveRemoteServiceConfig({
    cliHost: options.remoteHost,
    cliToken: options.remoteToken,
    cliMode: options.remoteBrowser,
    userConfig,
    env: process.env,
  });
  const remoteHost = remoteConfig.host;
  const remoteToken = remoteConfig.token;
  if (remoteHost && engine !== "browser") {
    throw new Error("--remote-host requires a browser session.");
  }
  if (remoteHost) {
    progress(chalk.dim(`Remote browser host detected: ${remoteHost}`));
  }
  if (remoteHost && waitPreference === false) {
    progress(chalk.dim("Remote browser runs require --wait; ignoring --no-wait."));
    waitPreference = true;
  }

  let browserDeps: BrowserSessionRunnerDeps | undefined;
  if (browserConfig && remoteHost) {
    const { createRemoteBrowserExecutor } = await import("../src/remote/client.js");
    browserDeps = {
      executeBrowser: createRemoteBrowserExecutor({ host: remoteHost, token: remoteToken }),
    };
    progress(chalk.dim(`Routing browser automation to remote host ${remoteHost}`));
  } else if (browserConfig && runOptions.model.startsWith("gemini")) {
    const { createGeminiWebExecutor } = await import("../src/gemini-web/index.js");
    browserDeps = {
      executeBrowser: createGeminiWebExecutor({
        youtube: storedOptions.youtube,
        generateImage: storedOptions.generateImage,
        editImage: storedOptions.editImage,
        outputPath: storedOptions.outputPath,
        aspectRatio: storedOptions.aspectRatio,
        showThoughts: storedOptions.geminiShowThoughts,
        deepThinkFallback: toGeminiDeepThinkFallback(storedOptions.geminiDeepThinkFallback),
      }),
    };
    progress(chalk.dim("Using Gemini web client for browser automation"));
    if (browserConfig.modelStrategy && browserConfig.modelStrategy !== "select") {
      progress(chalk.dim("Browser model strategy is ignored for Gemini web runs."));
    }
    warnGeminiIgnoredThinkingTime(runOptions.model, browserConfig.thinkingTime, progress);
  }
  const remoteExecutionActive = Boolean(browserDeps);

  if (sessionMode === "api") {
    validateApiProviderRoutingForCli(runOptions);
  }

  await sessionStore.ensureStorage();
  const notifications = deriveNotificationSettingsFromMetadata(
    metadata,
    process.env,
    userConfig.notify,
  );
  const sessionMeta = await sessionStore.createSession(
    {
      ...runOptions,
      mode: sessionMode,
      browserConfig,
      followupSessionId: storedOptions.followupSessionId,
      followupModel: storedOptions.followupModel,
      waitPreference,
      youtube: storedOptions.youtube,
      generateImage: storedOptions.generateImage,
      editImage: storedOptions.editImage,
      outputPath: storedOptions.outputPath,
      aspectRatio: storedOptions.aspectRatio,
      geminiShowThoughts: storedOptions.geminiShowThoughts,
    },
    cwd,
    notifications,
    sessionId,
  );

  const liveRunOptions: RunOracleOptions = {
    ...runOptions,
    sessionId: sessionMeta.id,
    effectiveModelId: resolveEffectiveModelIdForRun(runOptions.model, runOptions.effectiveModelId),
  };

  const disableDetachEnv = process.env.ORACLE_NO_DETACH === "1";
  const detachAllowed = remoteExecutionActive
    ? false
    : shouldDetachSession({
        engine,
        model: runOptions.model,
        waitPreference,
        disableDetachEnv,
      });
  const detachedLaunch = !detachAllowed
    ? { runnerStarted: false, finalizerStarted: false }
    : await launchDetachedSession(sessionMeta.id, { engine, log: progress }).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        progress(chalk.yellow(`Unable to detach session runner (${message}). Running inline...`));
        return { runnerStarted: false, finalizerStarted: false };
      });
  const detached = detachedLaunch.runnerStarted;
  const lifecycle = buildSessionLifecycle({
    engine,
    detached,
    reattachCommand: `oracle session ${sessionMeta.id}`,
  });
  await sessionStore.updateSession(sessionMeta.id, { lifecycle });
  const sessionWithLifecycle: SessionMetadata = { ...sessionMeta, lifecycle };
  if (
    detached &&
    shouldLaunchDetachedSessionFinalizer({ engine }) &&
    !detachedLaunch.finalizerStarted
  ) {
    progress(
      chalk.yellow("Detached finalizer did not start; use `oracle session --render` if needed."),
    );
  }

  const buildReceiptInput = (status: string): BuildSessionActionInput => ({
    action: "restart",
    sessionId: sessionMeta.id,
    parentSessionId: sessionId,
    engine,
    mode: sessionMode,
    lane: sessionMeta.lane ?? metadata.lane ?? null,
    model: sessionMeta.model ?? runOptions.model ?? null,
    status,
    waitPreference: waitPreference === true,
    detached,
    reattachCommand: lifecycle.reattachCommand,
  });
  const readLatestStatus = async (): Promise<string> =>
    (await sessionStore.readSession(sessionMeta.id))?.status ?? sessionMeta.status;

  if (!waitPreference) {
    if (!detached) {
      const message = "Unable to start in background; use --wait to run inline.";
      progress(chalk.red(message));
      emitJsonError(message);
      process.exitCode = 1;
      return;
    }
    for (const line of formatSessionLifecycleBlock(sessionWithLifecycle)) {
      progress(line);
    }
    progress(
      chalk.dim("Pro runs can take up to 60 minutes (usually 10-15). Add --wait to stay attached."),
    );
    if (jsonMode) {
      emitReceipt(buildReceiptInput(await readLatestStatus()));
    }
    return;
  }

  if (detached === false) {
    await runInteractiveSession(
      sessionWithLifecycle,
      liveRunOptions,
      sessionMode,
      browserConfig,
      false,
      notifications,
      userConfig,
      true,
      browserDeps,
      cwd,
      jsonMode,
      // `oracle restart --json` emits its own oracle_session_action.v1
      // receipt below instead of the top-level answer envelope.
      false,
    );
    if (jsonMode) {
      emitReceipt(buildReceiptInput(await readLatestStatus()));
    }
    return;
  }
  if (detached) {
    progress(chalk.blue(`Reattach via: oracle session ${sessionMeta.id}`));
    if (jsonMode) {
      // Block until the detached run reaches a terminal status, then emit
      // the single receipt — never tail human output onto JSON stdout.
      const { waitForFollowUpSession } = await import("../src/cli/browserFollowUp.js");
      const finalMeta = await waitForFollowUpSession(sessionMeta.id, {
        log: (line) => progress(line.replace("[follow-up]", "[restart]")),
      });
      if (!finalMeta) {
        const message = `Restarted session ${sessionMeta.id} disappeared.`;
        progress(chalk.red(message));
        emitJsonError(message);
        process.exitCode = 1;
        return;
      }
      emitReceipt(buildReceiptInput(finalMeta.status));
      return;
    }
    const { attachSession } = await import("../src/cli/sessionDisplay.js");
    await attachSession(sessionMeta.id, { suppressMetadata: true });
  }
}

async function executeSession(sessionId: string) {
  const metadata = await sessionStore.readSession(sessionId);
  if (!metadata) {
    console.error(chalk.red(`No session found with ID ${sessionId}`));
    process.exitCode = 1;
    return;
  }
  const runOptions = buildRunOptionsFromMetadata(metadata);
  const sessionMode = getSessionMode(metadata);
  const browserConfig = getBrowserConfigFromMetadata(metadata);
  const { logLine, writeChunk, stream } = sessionStore.createLogWriter(sessionId);
  const userConfig = (await loadUserConfig()).config;
  const notifications = deriveNotificationSettingsFromMetadata(
    metadata,
    process.env,
    userConfig.notify,
  );
  try {
    let browserDeps: BrowserSessionRunnerDeps | undefined;
    if (browserConfig) {
      const remoteConfig = resolveRemoteServiceConfig({
        userConfig,
        env: process.env,
      });
      const remoteHost = remoteConfig.host;
      if (remoteHost && sessionMode !== "browser") {
        throw new Error("--remote-host requires a browser session.");
      }
      if (remoteHost) {
        logLine(`Remote browser host detected: ${remoteHost}`);
        const { createRemoteBrowserExecutor } = await import("../src/remote/client.js");
        browserDeps = {
          executeBrowser: createRemoteBrowserExecutor({
            host: remoteHost,
            token: remoteConfig.token,
          }),
        };
        logLine(`Routing browser automation to remote host ${remoteHost}`);
      } else if (runOptions.model.startsWith("gemini")) {
        const storedOptions = metadata.options ?? {};
        const { createGeminiWebExecutor } = await import("../src/gemini-web/index.js");
        browserDeps = {
          executeBrowser: createGeminiWebExecutor({
            youtube: storedOptions.youtube,
            generateImage: storedOptions.generateImage,
            editImage: storedOptions.editImage,
            outputPath: storedOptions.outputPath,
            aspectRatio: storedOptions.aspectRatio,
            showThoughts: storedOptions.geminiShowThoughts,
            deepThinkFallback: toGeminiDeepThinkFallback(storedOptions.geminiDeepThinkFallback),
          }),
        };
        logLine("Using Gemini web client for browser automation");
      }
    }
    const { performSessionRun } = await import("../src/cli/sessionRunner.js");
    await performSessionRun({
      sessionMeta: metadata,
      runOptions,
      mode: sessionMode,
      browserConfig,
      cwd: metadata.cwd ?? process.cwd(),
      log: logLine,
      write: writeChunk,
      version: VERSION,
      notifications,
      browserDeps,
    });
  } catch (error) {
    // Errors are already logged to the session log; keep quiet to mirror stored-session behavior.
    if (!isErrorLogged(error)) {
      logLine(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
    }
  } finally {
    stream.end();
  }
}

async function finalizeSession(sessionId: string) {
  const { logLine, stream } = sessionStore.createLogWriter(sessionId);
  try {
    const { finalizeBrowserSessionUntilComplete } = await import("../src/cli/sessionFinalizer.js");
    await finalizeBrowserSessionUntilComplete(sessionId, {
      log: logLine,
    });
  } finally {
    stream.end();
  }
}

/**
 * Enhance commander's built-in unknown-option handling (agent-ergonomics
 * Axiom 7: intent inference) so a strict Levenshtein-1 flag typo (e.g.
 * `--prompt-fil` for `--prompt-file`) gets the *exact* corrected
 * command an agent should retry with, not just a bare flag name.
 *
 * The known-flag list is derived from `program`'s own registered
 * *visible* options at call time via `createHelp().visibleOptions()`
 * (the same introspection commander's own default suggestion uses) —
 * never hardcoded — so it can't drift from `--help`, and a typo can
 * never resolve to a non-core flag this CLI's earlier surface pass hid.
 *
 * Anything looser than Levenshtein-1 falls through to commander's own
 * default `unknownOption()` unchanged (it still offers its own
 * best-effort, transposition-aware "(Did you mean ...)" hint without the
 * corrected-command line), so behavior for a wildly-off flag is
 * unaffected.
 */
interface CommandWithUnknownOptionHook {
  unknownOption(flag: string): void;
}

function installUnknownFlagSuggestion(cliProgram: Command): void {
  // `unknownOption` is a real, overridable prototype method (used exactly
  // this way by commander consumers), but it's `@private` and not part of
  // commander's public `.d.ts` — cast narrowly to call/reassign it.
  const withHook = cliProgram as unknown as CommandWithUnknownOptionHook;
  const defaultUnknownOption = withHook.unknownOption.bind(cliProgram);
  withHook.unknownOption = (flag: string): void => {
    const suggestion = flag.startsWith("--") ? nearestKnownLongFlag(cliProgram, flag) : null;
    if (suggestion) {
      const goodFlag = `--${suggestion}`;
      const corrected = rewriteFlagInArgs(routingCliArgs, flag, goodFlag);
      cliProgram.error(
        `error: unknown option '${flag}'\n(Did you mean ${goodFlag}?)\nTry: oracle ${corrected}`,
        { code: "commander.unknownOption" },
      );
      return;
    }
    defaultUnknownOption(flag);
  };
}

function nearestKnownLongFlag(cliProgram: Command, flag: string): string | null {
  const bare = flag.split("=")[0].slice(2);
  const known = cliProgram
    .createHelp()
    .visibleOptions(cliProgram)
    .map((option) => option.long)
    .filter((long): long is string => Boolean(long))
    .map((long) => long.slice(2));
  return nearestByEditDistance(bare, known, 1);
}

/** Rewrite just the mistyped flag token in the original argv, quoting values that need it. */
function rewriteFlagInArgs(args: readonly string[], badFlag: string, goodFlag: string): string {
  const badBare = badFlag.split("=")[0];
  const rewritten = args.map((arg) => {
    if (arg === badBare) return goodFlag;
    if (arg.startsWith(`${badBare}=`)) return `${goodFlag}${arg.slice(badBare.length)}`;
    return arg;
  });
  return rewritten.map(quoteArgForDisplay).join(" ");
}

function quoteArgForDisplay(value: string): string {
  if (value.length > 0 && /^[\w./:@=,+-]+$/.test(value)) return value;
  return `"${value.replace(/(["\\$`])/g, "\\$1")}"`;
}

/**
 * Agent-ergonomics Axiom 7 (intent inference): a bare single-token
 * invocation that is a Levenshtein-1 typo of a known top-level CORE
 * command (e.g. `oracle statuss`) would otherwise fall through to the
 * root action's catch-all `[prompt]` positional argument and *silently
 * launch a real, potentially costly reviewed-lane run* with "statuss" as
 * the prompt text — never what an agent typing a command name meant.
 * Detected in `main()` before `program.parseAsync()` ever runs, so the
 * dangerous run never starts; this only ever *suggests* the fix (Axiom
 * 7's "never auto-run a dangerous corrected command").
 *
 * Scoped deliberately narrow to avoid false-positives on real one-word
 * prompts: only a *single* bare, non-flag token with no other args at
 * all (real prompts are near-universally multi-word or passed via
 * `--prompt`/`-p` per every documented example) and only when it is
 * exactly one edit away from a known *visible* top-level command name
 * (derived live from `program.commands`, never hardcoded).
 */
function detectRootCommandTypo(
  args: readonly string[],
  cliProgram: Command,
): { input: string; suggestion: string } | null {
  if (args.length !== 1) return null;
  const [only] = args;
  if (!only || only.startsWith("-")) return null;
  const knownCommandNames = cliProgram
    .createHelp()
    .visibleCommands(cliProgram)
    .map((command) => command.name());
  if (knownCommandNames.includes(only)) return null;
  const suggestion = nearestByEditDistance(only, knownCommandNames, 1);
  return suggestion ? { input: only, suggestion } : null;
}

/**
 * Derive this page's contents from commander's live option/command registry
 * (`program.options` / `program.commands`) instead of a hand-typed array, so
 * anything hidden via `hideHelp()`/`{ hidden: true }` is automatically
 * discoverable here and can never silently drift out of sync (see the
 * `--browser-thinking-time` mis-hide bug this replaced).
 */
function printDebugHelp(cliName: string): void {
  console.log(
    chalk.bold(
      "🧿 oracle advanced help — Reviewed lanes: ChatGPT GPT-5.6 Sol + Pro, Fable xHigh, and Gemini 3.1 Deep Think.",
    ),
  );
  console.log(
    chalk.dim(
      "Primary help stays lane-first; this page lists compatibility, browser-debug, and hidden-command overrides.",
    ),
  );
  console.log("");

  const hiddenOptions = program.options.filter((option) => option.hidden);
  const isBrowserOption = (option: Option): boolean => option.flags.includes("--browser");
  const browserOptions = hiddenOptions.filter(isBrowserOption);
  const otherOptions = hiddenOptions.filter((option) => !isBrowserOption(option));

  console.log(chalk.bold("Advanced Options"));
  printDebugOptionGroup(otherOptions.map(optionToDebugEntry));
  console.log("");
  console.log(chalk.bold("Browser Options"));
  printDebugOptionGroup(browserOptions.map(optionToDebugEntry));
  console.log("");

  const help = program.createHelp();
  const visibleCommands = new Set(help.visibleCommands(program));
  const hiddenCommands = program.commands.filter((command) => !visibleCommands.has(command));
  console.log(chalk.bold("Hidden commands (fully runnable, just not in default --help)"));
  printDebugOptionGroup(
    hiddenCommands.map((command) => [command.name(), command.description() || "(no description)"]),
  );

  console.log("");
  console.log(chalk.dim(`Tip: run \`${cliName} --help\` to see the primary option set.`));
}

function optionToDebugEntry(option: Option): [string, string] {
  return [option.flags, option.description || "(no description)"];
}

function printDebugOptionGroup(entries: Array<[string, string]>): void {
  if (entries.length === 0) {
    console.log(chalk.dim("  (none)"));
    return;
  }
  const flagWidth = Math.max(...entries.map(([flag]) => flag.length));
  entries.forEach(([flag, description]) => {
    const label = chalk.cyan(flag.padEnd(flagWidth + 2));
    console.log(`  ${label}${description}`);
  });
}

function resolveWaitFlag({
  waitFlag,
  model,
  engine,
}: {
  waitFlag?: boolean;
  model: ModelName;
  engine: EngineMode;
}): boolean {
  if (waitFlag === true) return true;
  if (waitFlag === false) return false;
  return defaultWaitPreference(model, engine);
}

function resolveRestartWaitPreference({
  waitFlag,
  storedPreference,
  model,
  engine,
}: {
  waitFlag?: boolean;
  storedPreference?: boolean;
  model: ModelName;
  engine: EngineMode;
}): boolean {
  if (waitFlag === true) return true;
  if (waitFlag === false) return false;
  if (typeof storedPreference === "boolean") return storedPreference;
  return defaultWaitPreference(model, engine);
}

function resolveEffectiveModelIdForRun(model: ModelName, stored?: string): string {
  if (stored) return stored;
  if (model.startsWith("gemini")) {
    return resolveGeminiModelId(model);
  }
  return isKnownModel(model) ? (MODEL_CONFIGS[model].apiModel ?? model) : model;
}

program.action(async function (this: Command) {
  const options = this.optsWithGlobals() as CliOptions;
  await runRootCommand(options);
});

async function main(): Promise<void> {
  if (perfTraceArgs.error) {
    console.error(`error: ${perfTraceArgs.error}`);
    console.error("(use --help for usage)");
    process.exitCode = 1;
    return;
  }
  if (isRootVerboseHelpRequest(routingCliArgs) || isRootDebugHelpRequest(routingCliArgs)) {
    printDebugHelp("oracle");
    return;
  }
  const commandTypo = detectRootCommandTypo(routingCliArgs, program);
  if (commandTypo) {
    console.error(
      `error: '${commandTypo.input}' is not a recognized command, and no --prompt/--lane was given — ` +
        `it's one edit away from the '${commandTypo.suggestion}' command.`,
    );
    console.error(`Did you mean: oracle ${commandTypo.suggestion}`);
    console.error(
      `If you meant to send it as a literal prompt instead, run: oracle -p "${commandTypo.input}"`,
    );
    console.error("(use --help for usage)");
    process.exitCode = 1;
    return;
  }
  const handleSigint = (): void => {
    console.log(chalk.yellow("\nCancelled."));
    process.exitCode = 130;
    // Browser/serve modes install their own SIGINT cleanup after this top-level handler.
    if (process.listenerCount("SIGINT") <= 1) {
      process.exit(130);
    }
  };
  process.once("SIGINT", handleSigint);
  try {
    await program.parseAsync(normalizedArgv);
  } finally {
    process.off("SIGINT", handleSigint);
  }
}

void main().catch((error: unknown) => {
  const exitCode = resolveTopLevelExitCode(error);
  const jsonMode = isJsonModeRequested(userCliArgs);
  const commanderControlFlow = isCommanderControlFlowError(error);
  if (exitCode !== 0 && !jsonMode && !(commanderControlFlow && commanderErrorPrinted)) {
    emitTopLevelHumanError(error);
  }
  if (jsonMode && exitCode !== 0) {
    process.stdout.write(
      stableJsonStringify(
        buildTopLevelCliErrorEnvelope({
          error,
          command: "oracle",
          exitCode,
        }),
      ),
    );
    process.exitCode = exitCode;
    return;
  }
  if (commanderControlFlow) {
    setProcessExitCode(exitCode);
    return;
  }
  process.exitCode = exitCode;
});

function emitTopLevelHumanError(error: unknown): void {
  if (error instanceof Error) {
    if (!isErrorLogged(error)) {
      console.error(chalk.red("✖"), error.message);
    }
  } else {
    console.error(chalk.red("✖"), error);
  }
}

function resolveTopLevelExitCode(error: unknown): number {
  const currentExitCode =
    typeof process.exitCode === "number"
      ? process.exitCode
      : typeof process.exitCode === "string"
        ? Number.parseInt(process.exitCode, 10)
        : undefined;
  if (currentExitCode && currentExitCode !== 0) {
    return currentExitCode;
  }
  if (isRecord(error) && typeof error.exitCode === "number") {
    return error.exitCode;
  }
  return 1;
}

function isCommanderControlFlowError(error: unknown): boolean {
  return isRecord(error) && typeof error.code === "string" && error.code.startsWith("commander.");
}

function setProcessExitCode(exitCode: number): void {
  const currentExitCode =
    typeof process.exitCode === "number"
      ? process.exitCode
      : typeof process.exitCode === "string"
        ? Number.parseInt(process.exitCode, 10)
        : undefined;
  if (currentExitCode && currentExitCode !== 0) {
    return;
  }
  process.exitCode = exitCode;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function formatRobotCommandHelp(): string {
  const lines = ["", "Robot JSON commands"];
  const commands = new Set([
    ...listRobotCommands().map((entry) => entry.command),
    "oracle evidence ledger show <session> --json",
    "oracle evidence ledger verify <session> --json",
    "oracle evidence ledger export <session> --json",
  ]);
  for (const command of commands) {
    lines.push(`  ${command}`);
  }
  return `${lines.join("\n")}\n`;
}

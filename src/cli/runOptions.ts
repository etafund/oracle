import type { RunOracleOptions, ModelName, AzureOptions, ModelOverridesConfig } from "../oracle.js";
import { DEFAULT_MODEL, MODEL_CONFIGS } from "../oracle.js";
import type { UserConfig } from "../config.js";
import type { EngineMode } from "./engine.js";
import { resolveEngine } from "./engine.js";
import {
  normalizeModelOption,
  inferModelFromLabel,
  resolveApiModel,
  normalizeBaseUrl,
} from "./options.js";
import { resolveGeminiModelId } from "../oracle/gemini.js";
import { resolveOverriddenApiModel } from "../oracle/modelResolver.js";
import { PromptValidationError } from "../oracle/errors.js";
import { normalizeChatGptModelForBrowser } from "./browserConfig.js";
import { resolveConfiguredMaxFileSizeBytes } from "./fileSize.js";
import { isAzureOpenAICandidateModel } from "../oracle/providerRouting.js";
import { resolveLanePolicy } from "./lanePolicy.js";
import { LaneRouteBlockError } from "./routeBlockError.js";

export interface ResolveRunOptionsInput {
  prompt: string;
  files?: string[];
  lane?: string;
  model?: string;
  models?: string[];
  engine?: EngineMode;
  userConfig?: UserConfig;
  env?: NodeJS.ProcessEnv;
}

export interface ResolvedRunOptions {
  runOptions: RunOracleOptions;
  resolvedEngine: EngineMode;
  engineCoercedToApi?: boolean;
  resolvedLane?: string;
}

export function resolveRunOptionsFromConfig({
  prompt,
  files = [],
  lane,
  model,
  models,
  engine,
  userConfig,
  env = process.env,
}: ResolveRunOptionsInput): ResolvedRunOptions {
  const laneDecision = resolveLanePolicy({
    lane,
    engine,
    model: lane ? model : (model ?? userConfig?.model),
    models,
    prompt,
    files,
    source: "runOptions",
    envEngine: env.ORACLE_ENGINE,
    configEngine: userConfig?.engine,
    allowLegacyRoutes: true,
  });
  if (!laneDecision.ok) {
    throw new LaneRouteBlockError(laneDecision);
  }

  const resolvedEngine = resolveEngine({
    engine,
    configEngine: userConfig?.engine,
    env,
  });
  if (laneDecision.resolvedLane?.engine === "claude-code") {
    const promptWithSuffix =
      userConfig?.promptSuffix && userConfig.promptSuffix.trim().length > 0
        ? `${prompt.trim()}\n${userConfig.promptSuffix}`
        : prompt;
    const search = userConfig?.search !== "off";
    const heartbeatIntervalMs =
      userConfig?.heartbeatSeconds !== undefined ? userConfig.heartbeatSeconds * 1000 : 30_000;
    const maxFileSizeBytes = resolveConfiguredMaxFileSizeBytes(userConfig, env);
    const laneModel =
      typeof laneDecision.resolvedLane.normalizedEngineOptions.model === "string"
        ? laneDecision.resolvedLane.normalizedEngineOptions.model
        : "fable";

    return {
      runOptions: {
        prompt: promptWithSuffix,
        model: laneModel as ModelName,
        file: files ?? [],
        lane: laneDecision.resolvedLane.lane,
        claudeCode: {
          model: laneModel,
          readOnly: true,
          inlineEvents: true,
          outputFormat: "stream-json",
          permissionMode: "plan",
          toolMode: "none",
          safeMode: true,
          disableSlashCommands: true,
          strictMcpConfig: true,
          noChrome: true,
          noSessionPersistence: true,
        },
        maxFileSizeBytes,
        search,
        heartbeatIntervalMs,
        filesReport: userConfig?.filesReport,
        background: false,
        effectiveModelId: laneModel,
      },
      resolvedEngine: laneDecision.resolvedLane.engine,
      resolvedLane: laneDecision.resolvedLane.lane,
    };
  }
  if (laneDecision.resolvedLane?.engine === "browser") {
    const promptWithSuffix =
      userConfig?.promptSuffix && userConfig.promptSuffix.trim().length > 0
        ? `${prompt.trim()}\n${userConfig.promptSuffix}`
        : prompt;
    const search = userConfig?.search !== "off";
    const heartbeatIntervalMs =
      userConfig?.heartbeatSeconds !== undefined ? userConfig.heartbeatSeconds * 1000 : 30_000;
    const maxFileSizeBytes = resolveConfiguredMaxFileSizeBytes(userConfig, env);
    const laneOptions = laneDecision.resolvedLane.normalizedEngineOptions;
    const laneModelValue = laneStringOption(laneOptions, "model") ?? DEFAULT_MODEL;
    const laneModel = normalizeChatGptModelForBrowser(inferModelFromLabel(laneModelValue));

    return {
      runOptions: {
        prompt: promptWithSuffix,
        model: laneModel,
        file: files ?? [],
        lane: laneDecision.resolvedLane.lane,
        maxFileSizeBytes,
        search,
        heartbeatIntervalMs,
        filesReport: userConfig?.filesReport,
        background: userConfig?.background,
        effectiveModelId: laneModel,
        browserAttachments: laneBrowserAttachments(laneOptions) ?? "auto",
      },
      resolvedEngine: laneDecision.resolvedLane.engine,
      resolvedLane: laneDecision.resolvedLane.lane,
    };
  }
  const envEnginePreference = (env.ORACLE_ENGINE ?? "").trim().toLowerCase();
  const browserRequested = engine === "browser";
  const explicitApiEngineRequested = engine === "api" || (!engine && envEnginePreference === "api");
  const browserConfigured = userConfig?.engine === "browser" && !explicitApiEngineRequested;
  const envBrowserConfigured = !engine && envEnginePreference === "browser";
  const browserEngineRequested = browserRequested || browserConfigured || envBrowserConfigured;
  const requestedModelList = Array.isArray(models) ? models : [];
  const normalizedRequestedModels = requestedModelList
    .map((entry) => normalizeModelOption(entry))
    .filter(Boolean);

  const cliModelArg = normalizeModelOption(model ?? userConfig?.model) || DEFAULT_MODEL;
  // For browser-engine requests we accept the fork's Gemini Deep Think alias as a
  // passthrough model; resolveApiModel itself still rejects the alias for pure
  // API contexts so users hit a clear "browser-only today" error if they forget
  // --engine browser.
  const apiModel = browserEngineRequested
    ? (inferModelFromLabel(cliModelArg) as ModelName)
    : resolveApiModel(cliModelArg);
  const browserModel = normalizeChatGptModelForBrowser(inferModelFromLabel(cliModelArg));
  const isCodex = apiModel.startsWith("gpt-5.1-codex");
  const isClaude = apiModel.startsWith("claude");
  const isGrok = apiModel.startsWith("grok");

  const engineWasBrowser = resolvedEngine === "browser";
  const allModels: ModelName[] =
    normalizedRequestedModels.length > 0
      ? Array.from(new Set(normalizedRequestedModels.map((entry) => resolveApiModel(entry))))
      : [apiModel];
  const browserCompatibilityModels: ModelName[] =
    normalizedRequestedModels.length > 0 ? allModels : [browserModel];
  const isBrowserCompatible = (m: string) => m.startsWith("gpt-") || m.startsWith("gemini");
  const hasNonBrowserCompatibleTarget =
    browserEngineRequested && browserCompatibilityModels.some((m) => !isBrowserCompatible(m));
  if (hasNonBrowserCompatibleTarget) {
    throw new PromptValidationError(
      "Browser engine only supports GPT and Gemini models. Re-run with --engine api for Grok, Claude, or other models.",
      { engine: "browser", models: allModels },
    );
  }

  const azure = resolveAzureOptions(userConfig, env);
  const azureAutoApi =
    Boolean(azure?.endpoint) &&
    !browserEngineRequested &&
    allModels.some(isAzureOpenAICandidateModel);
  const engineCoercedToApi = engineWasBrowser && (isCodex || isClaude || isGrok || azureAutoApi);
  const fixedEngine: EngineMode =
    isCodex || isClaude || isGrok || azureAutoApi || normalizedRequestedModels.length > 0
      ? "api"
      : resolvedEngine;
  // Browser runs use ChatGPT picker labels/aliases; API runs must keep API model ids intact.
  const resolvedModel = fixedEngine === "browser" ? browserModel : apiModel;

  const promptWithSuffix =
    userConfig?.promptSuffix && userConfig.promptSuffix.trim().length > 0
      ? `${prompt.trim()}\n${userConfig.promptSuffix}`
      : prompt;

  const search = userConfig?.search !== "off";

  const heartbeatIntervalMs =
    userConfig?.heartbeatSeconds !== undefined ? userConfig.heartbeatSeconds * 1000 : 30_000;
  const maxFileSizeBytes = resolveConfiguredMaxFileSizeBytes(userConfig, env);

  const baseUrl = normalizeBaseUrl(
    userConfig?.apiBaseUrl ??
      (isClaude ? env.ANTHROPIC_BASE_URL : isGrok ? env.XAI_BASE_URL : env.OPENAI_BASE_URL),
  );
  const uniqueMultiModels: ModelName[] = normalizedRequestedModels.length > 0 ? allModels : [];
  const includesCodexMultiModel = uniqueMultiModels.some((entry) =>
    entry.startsWith("gpt-5.1-codex"),
  );
  if (includesCodexMultiModel && browserRequested) {
    // Silent coerce; multi-model still forces API.
  }

  const chosenModel: ModelName = uniqueMultiModels[0] ?? resolvedModel;
  const apiModelOverrides = fixedEngine === "api" ? userConfig?.modelOverrides : undefined;
  const effectiveModelId = resolveEffectiveModelId(chosenModel, apiModelOverrides);

  const runOptions: RunOracleOptions = {
    prompt: promptWithSuffix,
    model: chosenModel,
    models: uniqueMultiModels.length > 0 ? uniqueMultiModels : undefined,
    file: files ?? [],
    maxFileSizeBytes,
    search,
    heartbeatIntervalMs,
    filesReport: userConfig?.filesReport,
    background: userConfig?.background,
    baseUrl,
    azure,
    effectiveModelId,
    modelOverrides: apiModelOverrides,
  };

  return { runOptions, resolvedEngine: fixedEngine, engineCoercedToApi };
}

function resolveAzureOptions(
  userConfig: UserConfig | undefined,
  env: NodeJS.ProcessEnv,
): AzureOptions | undefined {
  const endpoint = env.AZURE_OPENAI_ENDPOINT ?? userConfig?.azure?.endpoint;
  if (!endpoint?.trim()) {
    return undefined;
  }
  return {
    endpoint,
    deployment: env.AZURE_OPENAI_DEPLOYMENT ?? userConfig?.azure?.deployment,
    apiVersion: env.AZURE_OPENAI_API_VERSION ?? userConfig?.azure?.apiVersion,
  };
}

function laneStringOption(options: Record<string, unknown>, name: string): string | undefined {
  const value = options[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function laneBrowserAttachments(
  options: Record<string, unknown>,
): RunOracleOptions["browserAttachments"] | undefined {
  const value = laneStringOption(options, "browserAttachments");
  if (value === "auto" || value === "never" || value === "always") {
    return value;
  }
  return undefined;
}

function resolveEffectiveModelId(model: ModelName, modelOverrides?: ModelOverridesConfig): string {
  // A user-config override of a known model's apiModel must win, since this id
  // becomes the on-wire request model id in run.ts (including for Gemini aliases).
  const overridden = resolveOverriddenApiModel(model, modelOverrides);
  if (overridden) {
    return overridden;
  }
  if (typeof model === "string" && model.startsWith("gemini")) {
    return resolveGeminiModelId(model);
  }
  const config = MODEL_CONFIGS[model as keyof typeof MODEL_CONFIGS];
  return config?.apiModel ?? model;
}

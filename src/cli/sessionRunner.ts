import kleur from "kleur";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  SessionMetadata,
  SessionMode,
  BrowserSessionConfig,
  BrowserRuntimeMetadata,
  SessionArtifact,
  SessionModelRun,
  ClaudeCodeSessionMetadata,
} from "../sessionStore.js";
import type { ProviderFailureContext, RunOracleOptions, UsageSummary } from "../oracle.js";
import {
  runOracle,
  OracleResponseError,
  OracleTransportError,
  extractResponseMetadata,
  asOracleUserError,
  extractTextOutput,
  classifyProviderFailure,
  BrowserAutomationError,
} from "../oracle.js";
import {
  ensureSessionArtifacts,
  runBrowserSessionExecution,
  type BrowserSessionRunnerDeps,
} from "../browser/sessionRunner.js";
import { renderMarkdownAnsi } from "./markdownRenderer.js";
import { formatResponseMetadata, formatTransportMetadata } from "./sessionDisplay.js";
import { markErrorLogged } from "./errorUtils.js";
import {
  type NotificationSettings,
  sendSessionNotification,
  deriveNotificationSettingsFromMetadata,
} from "./notifier.js";
import { sessionStore } from "../sessionStore.js";
import { wait } from "../sessionManager.js";
import { runMultiModelApiSession, type MultiModelRunSummary } from "../oracle/multiModelRunner.js";
import { MODEL_CONFIGS, DEFAULT_SYSTEM_PROMPT } from "../oracle/config.js";
import { isKnownModel } from "../oracle/modelResolver.js";
import { resolveModelConfig } from "../oracle/modelResolver.js";
import { buildPrompt, buildRequestBody } from "../oracle/request.js";
import { estimateRequestTokens } from "../oracle/tokenEstimate.js";
import { formatTokenEstimate, formatTokenValue } from "../oracle/runUtils.js";
import { formatFinishLine } from "../oracle/finishLine.js";
import { sanitizeOscProgress } from "./oscUtils.js";
import { readFiles } from "../oracle/files.js";
import { cwd as getCwd } from "node:process";
import { resumeBrowserSession } from "../browser/reattach.js";
import { hasRecoverableChatGptConversation } from "../browser/reattachability.js";
import { resolveRecoveryUrl } from "../browser/recoverConversation.js";
import { estimateTokenCount } from "../browser/utils.js";
import type { BrowserLogger } from "../browser/types.js";
import { formatElapsed } from "../oracle/format.js";
import { formatBrowserReattachGuidance } from "./reattachGuidance.js";
import { getOracleHomeDir } from "../oracleHome.js";
import { buildClaudeCodeCommand, type ClaudeCodeCommand } from "../claude-code/command.js";
import { prepareClaudeCodeEnvironment } from "../claude-code/envGuard.js";
import { resolveClaudeExecutable } from "../claude-code/executableResolver.js";
import { assertClaudeCodeLocalOwner } from "../claude-code/localOwnerGuard.js";
import {
  buildCaamShallowSpawnCommand,
  resolveClaudeCodeCaamProfile,
  validateCaamProfileName,
} from "../claude-code/caamCommand.js";
import { resolveCaamExecutable, type ResolvedCaamExecutable } from "../claude-code/caamResolver.js";
import { runCaamShallowProfileDoctor } from "../claude-code/caamDoctor.js";
import {
  ClaudeCodeStreamNormalizer,
  type ClaudeCodeNormalizedEvent,
} from "../claude-code/streamParser.js";
import { verifyClaudeCodeRun } from "../claude-code/startupVerifier.js";
import {
  assertClaudeCodeInlineBudget,
  resolveClaudeCodeMaxInlineBytes,
} from "../claude-code/inlineBudget.js";

const isTty = process.stdout.isTTY;
const dim = (text: string): string => (isTty ? kleur.dim(text) : text);
const CLAUDE_CODE_SESSION_FINALIZED = Symbol("claudeCodeSessionFinalized");

type ClaudeCodeFinalizedError = Error & {
  [CLAUDE_CODE_SESSION_FINALIZED]?: true;
};

export interface SessionRunParams {
  sessionMeta: SessionMetadata;
  runOptions: RunOracleOptions;
  mode: SessionMode;
  browserConfig?: BrowserSessionConfig;
  cwd: string;
  log: (message?: string) => void;
  write: (chunk: string) => boolean;
  version: string;
  notifications?: NotificationSettings;
  browserDeps?: BrowserSessionRunnerDeps;
  muteStdout?: boolean;
  claudeCodeRunner?: ClaudeCodeSessionRunner;
}

export interface ClaudeCodeRunnerInput {
  sessionId: string;
  prompt: string;
  model: string;
  cwd: string;
  runOptions: RunOracleOptions;
  artifactPaths: ClaudeCodeArtifactPaths;
  log: (message?: string) => void;
  write: (chunk: string) => boolean;
}

export interface ClaudeCodeArtifactPayloads {
  stdoutRaw?: Buffer | string;
  stderrRaw?: Buffer | string;
  normalizedEventsNdjson?: string;
  finalAnswerMarkdown?: string;
  progressMarkdown?: string;
  adapterMetadata?: Record<string, unknown>;
}

export interface ClaudeCodeRunnerResult extends ClaudeCodeArtifactPayloads {
  finalAnswerText?: string;
  usage?: UsageSummary;
  elapsedMs?: number;
  exitCode?: number | null;
  signal?: string | null;
  eventsComplete?: boolean;
  streamsComplete?: boolean;
  stdoutEvents?: number;
  stderrEvents?: number;
  modelRequested?: string;
  modelObserved?: string | null;
  modelResolvedFromInit?: string | null;
  modelUsageKeys?: string[];
  modelUsageAuxiliaryKeys?: string[];
  modelVerificationStatus?: ClaudeCodeSessionMetadata["model_verification_status"];
  totalCostUsdObserved?: number | null;
  visibleThinkingCaptured?: boolean | "unknown";
  subscriptionBillingUncertain?: boolean;
  creditBillingWarningEmitted?: boolean;
  localOwnerVerified?: boolean;
  anthropicApiKeyPresent?: boolean;
  anthropicApiKeyRefusalChecked?: boolean;
  childEnvScrubbed?: boolean;
  errorMessage?: string;
  /** The `--session-id` UUID this run used or minted (claude-provider-map.md finding #2). */
  claudeSessionId?: string;
  /** caam shallow-spawn profile actually used this run, if any (caam-map.md §4). */
  caamProfileUsed?: string;
  /** `true` when this run kept `--no-session-persistence` (one-shot, default). */
  sessionPersistenceDisabled?: boolean;
}

export type ClaudeCodeArtifactPaths = {
  rawStdoutPath: string;
  rawStderrPath: string;
  normalizedEventsPath: string;
  finalAnswerPath: string;
  progressPath: string;
  adapterMetadataPath: string;
};

export type ClaudeCodeSessionRunner = (
  input: ClaudeCodeRunnerInput,
) => Promise<ClaudeCodeRunnerResult>;

export async function performSessionRun({
  sessionMeta,
  runOptions,
  mode,
  browserConfig,
  cwd,
  log,
  write,
  version,
  notifications,
  browserDeps,
  muteStdout = false,
  claudeCodeRunner = runLocalClaudeCodeSession,
}: SessionRunParams): Promise<void> {
  const writeInline = (chunk: string): boolean => {
    // Keep session logs intact while still echoing inline output to the user.
    write(chunk);
    return muteStdout ? true : process.stdout.write(chunk);
  };
  await sessionStore.updateSession(sessionMeta.id, {
    status: "running",
    startedAt: new Date().toISOString(),
    mode,
    ...(browserConfig ? { browser: { config: browserConfig } } : {}),
  });
  const notificationSettings =
    notifications ?? deriveNotificationSettingsFromMetadata(sessionMeta, process.env);
  const modelForStatus = runOptions.model ?? sessionMeta.model;
  try {
    if (mode === "claude-code") {
      if (modelForStatus) {
        await sessionStore.updateModelRun(sessionMeta.id, modelForStatus, {
          status: "running",
          startedAt: new Date().toISOString(),
        });
      }
      const files = await readFiles(runOptions.file ?? [], {
        cwd,
        maxFileSizeBytes: runOptions.maxFileSizeBytes,
        // claude-provider-map.md finding #1: never silently force-decode a
        // binary attachment as UTF-8 garbage for this lane.
        binaryFileHandling: "reject",
      });
      const promptWithFiles = buildPrompt(runOptions.prompt ?? "", files, cwd);
      // Aggregate pre-spawn budget check (finding #1, concrete gap #2) —
      // must run before any of the claude-code-specific spawn machinery
      // (single-flight lock, executable resolution, `spawn()`) so an
      // oversized attachment bundle fails fast with an actionable error
      // instead of silently producing an arbitrarily large stdin write.
      assertClaudeCodeInlineBudget(promptWithFiles, runOptions.claudeCode?.maxInlineBytes);
      const artifactPaths = await buildClaudeCodeArtifactPaths(sessionMeta.id);
      log(
        dim(
          `Claude Code local mode: assembled ${files.length} file${files.length === 1 ? "" : "s"} through Oracle file context; prompt will be sent over stdin.`,
        ),
      );
      const startedAt = Date.now();
      const result = await claudeCodeRunner({
        sessionId: sessionMeta.id,
        prompt: promptWithFiles,
        model: modelForStatus ?? "fable",
        cwd,
        runOptions,
        artifactPaths,
        log,
        write: writeInline,
      });
      const elapsedMs = result.elapsedMs ?? Date.now() - startedAt;
      const artifacts = await persistClaudeCodeArtifacts({
        artifactPaths,
        payloads: result,
      });
      const answerText =
        result.finalAnswerText ?? result.finalAnswerMarkdown ?? extractFinalTextFromNdjson(result);
      const usage = result.usage ?? usageFromClaudeCodeResult(result);
      const success = !result.errorMessage && (result.exitCode == null || result.exitCode === 0);
      const claudeCodeMetadata = buildClaudeCodeSessionMetadata({
        result,
        artifactPaths,
        model: modelForStatus ?? "fable",
      });
      const logWriter = sessionStore.createLogWriter(sessionMeta.id);
      logWriter.logLine("Answer:");
      logWriter.logLine(answerText || "(no final answer extracted)");
      logWriter.logLine("");
      logWriter.logLine("Claude Code artifacts:");
      for (const artifact of artifacts) {
        logWriter.logLine(`- ${artifact.label ?? artifact.kind}: ${artifact.path}`);
      }
      logWriter.stream.end();
      if (modelForStatus) {
        await sessionStore.updateModelRun(sessionMeta.id, modelForStatus, {
          status: success ? "completed" : "error",
          completedAt: new Date().toISOString(),
          usage,
          error: result.errorMessage
            ? {
                category: "claude-code",
                message: result.errorMessage,
              }
            : undefined,
        });
      }
      await sessionStore.updateSession(sessionMeta.id, {
        status: success ? "completed" : "error",
        completedAt: new Date().toISOString(),
        usage,
        elapsedMs,
        errorMessage: success ? undefined : result.errorMessage,
        mode,
        claudeCode: claudeCodeMetadata,
        artifacts: mergeArtifacts(sessionMeta.artifacts, artifacts),
        response: undefined,
        transport: undefined,
        error: success
          ? undefined
          : {
              category: "claude-code",
              message: result.errorMessage ?? "Claude Code local mode failed.",
            },
      });
      if (!success) {
        throw finalizedClaudeCodeError(result.errorMessage ?? "Claude Code local mode failed.");
      }
      if (answerText && !muteStdout) {
        const printable =
          runOptions.renderPlain === true ? answerText : renderMarkdownAnsi(answerText);
        writeInline(printable.endsWith("\n") ? printable : `${printable}\n`);
      }
      await writeAssistantOutput(runOptions.writeOutputPath, answerText, log);
      await sendSessionNotification(
        {
          sessionId: sessionMeta.id,
          sessionName: sessionMeta.options?.slug ?? sessionMeta.id,
          mode,
          model: sessionMeta.model ?? runOptions.model,
          usage,
          characters: answerText.length,
        },
        notificationSettings,
        log,
        answerText.slice(0, 140),
      );
      return;
    }
    if (mode === "browser") {
      if (!browserConfig) {
        throw new Error("Missing browser configuration for session.");
      }
      if (modelForStatus) {
        await sessionStore.updateModelRun(sessionMeta.id, modelForStatus, {
          status: "running",
          startedAt: new Date().toISOString(),
        });
      }
      if (
        await recoverSubmittedBrowserSessionBeforeFreshRun({
          sessionMeta,
          browserConfig,
          runOptions,
          modelForStatus,
          notificationSettings,
          log,
        })
      ) {
        return;
      }
      const runnerDeps = {
        ...browserDeps,
        persistRuntimeHint: async (runtime: BrowserRuntimeMetadata) => {
          await sessionStore.updateSession(sessionMeta.id, {
            status: "running",
            browser: { config: browserConfig, runtime },
          });
        },
      };
      const result = await runBrowserSessionExecution(
        {
          runOptions: { ...runOptions, sessionId: runOptions.sessionId ?? sessionMeta.id },
          browserConfig,
          cwd,
          log,
        },
        runnerDeps,
      );
      if (modelForStatus) {
        await sessionStore.updateModelRun(sessionMeta.id, modelForStatus, {
          status: "completed",
          completedAt: new Date().toISOString(),
          usage: result.usage,
        });
      }
      await sessionStore.updateSession(sessionMeta.id, {
        status: "completed",
        completedAt: new Date().toISOString(),
        usage: result.usage,
        elapsedMs: result.elapsedMs,
        errorMessage: undefined,
        browser: {
          config: browserConfig,
          runtime: result.runtime,
          archive: result.archive,
          modelSelection: result.modelSelection,
          warnings: result.warnings,
        },
        artifacts: mergeArtifacts(sessionMeta.artifacts, result.artifacts),
        response: undefined,
        transport: undefined,
        error: undefined,
      });
      await writeAssistantOutput(runOptions.writeOutputPath, result.answerText ?? "", log);
      await sendSessionNotification(
        {
          sessionId: sessionMeta.id,
          sessionName: sessionMeta.options?.slug ?? sessionMeta.id,
          mode,
          model: sessionMeta.model,
          usage: result.usage,
          characters: result.answerText?.length,
        },
        notificationSettings,
        log,
        result.answerText?.slice(0, 140),
      );
      return;
    }
    const multiModels = Array.isArray(runOptions.models) ? runOptions.models.filter(Boolean) : [];
    if (multiModels.length > 1) {
      const [primaryModel] = multiModels;
      if (!primaryModel) {
        throw new Error("Missing model name for multi-model run.");
      }
      const modelConfig = await resolveModelConfig(primaryModel, {
        baseUrl: runOptions.baseUrl,
        openRouterApiKey: process.env.OPENROUTER_API_KEY,
        modelOverrides: runOptions.modelOverrides,
      });
      const files = await readFiles(runOptions.file ?? [], {
        cwd,
        maxFileSizeBytes: runOptions.maxFileSizeBytes,
      });
      const promptWithFiles = buildPrompt(runOptions.prompt, files, cwd);
      const requestBody = buildRequestBody({
        modelConfig,
        systemPrompt: runOptions.system ?? DEFAULT_SYSTEM_PROMPT,
        userPrompt: promptWithFiles,
        searchEnabled: runOptions.search !== false,
        maxOutputTokens: runOptions.maxOutput,
        background: runOptions.background,
        storeResponse: runOptions.background,
      });
      const estimatedTokens = estimateRequestTokens(requestBody, modelConfig);
      const tokenLabel = formatTokenEstimate(estimatedTokens, (text) =>
        isTty ? kleur.green(text) : text,
      );
      const filesPhrase = files.length === 0 ? "no files" : `${files.length} files`;
      const modelsLabel = multiModels.join(", ");
      log(
        `Calling ${isTty ? kleur.cyan(modelsLabel) : modelsLabel} — ${tokenLabel} tokens, ${filesPhrase}.`,
      );

      const multiRunTips: string[] = [];
      if (files.length === 0) {
        multiRunTips.push(
          "Tip: no files attached — Oracle works best with project context. Add files via --file path/to/code or docs.",
        );
      }
      const shortPrompt = (runOptions.prompt?.trim().length ?? 0) < 80;
      if (shortPrompt) {
        multiRunTips.push(
          "Tip: brief prompts often yield generic answers — aim for 6–30 sentences and attach key files.",
        );
      }
      for (const tip of multiRunTips) {
        log(dim(tip));
      }

      // Surface long-running model expectations up front so users know why a response might lag.
      const longRunningModels = multiModels.filter(
        (model) => isKnownModel(model) && MODEL_CONFIGS[model]?.reasoning?.effort === "high",
      );
      if (longRunningModels.length > 0) {
        for (const model of longRunningModels) {
          log("");
          const headingLabel = `[${model}]`;
          log(isTty ? kleur.bold(headingLabel) : headingLabel);
          log(dim("This model can take up to 60 minutes (usually replies much faster)."));
          log(dim("Press Ctrl+C to cancel."));
        }
      }

      const shouldStreamInline = !muteStdout && process.stdout.isTTY;
      const shouldRenderMarkdown = shouldStreamInline && runOptions.renderPlain !== true;
      const printedModels = new Set<string>();
      const answerFallbacks = new Map<string, string>();
      const stripOscProgress = (text: string): string =>
        sanitizeOscProgress(text, shouldStreamInline);

      const printModelLog = async (model: string) => {
        if (printedModels.has(model)) return;
        printedModels.add(model);
        const body = stripOscProgress(await sessionStore.readModelLog(sessionMeta.id, model));
        log("");
        const fallback = answerFallbacks.get(model);
        const hasBody = body.length > 0;
        if (!hasBody && !fallback) {
          log(dim(`${model}: (no output recorded)`));
          return;
        }
        const headingLabel = `[${model}]`;
        const heading = shouldStreamInline ? kleur.bold(headingLabel) : headingLabel;
        log(heading);
        const content = hasBody ? body : (fallback ?? "");
        const printable = shouldRenderMarkdown ? renderMarkdownAnsi(content) : content;
        writeInline(printable);
        if (!printable.endsWith("\n")) {
          log("");
        }
      };

      const summary = await runMultiModelApiSession(
        {
          sessionMeta,
          runOptions,
          models: multiModels,
          cwd,
          version,
          onModelDone: shouldStreamInline
            ? async (result) => {
                if (result.answerText) {
                  answerFallbacks.set(result.model, result.answerText);
                }
                await printModelLog(result.model);
              }
            : undefined,
        },
        {
          runOracleImpl: muteStdout
            ? (opts, deps) => runOracle(opts, { ...deps, allowStdout: false })
            : undefined,
        },
      );

      if (!shouldStreamInline) {
        // If we couldn't stream inline (e.g., non-TTY), print all logs after completion.
        for (const [index, result] of summary.fulfilled.entries()) {
          if (index > 0) {
            log("");
          }
          await printModelLog(result.model);
        }
      }
      const aggregateUsage = summary.fulfilled.reduce<UsageSummary>(
        (acc, entry) => ({
          inputTokens: acc.inputTokens + entry.usage.inputTokens,
          outputTokens: acc.outputTokens + entry.usage.outputTokens,
          reasoningTokens: acc.reasoningTokens + entry.usage.reasoningTokens,
          totalTokens: acc.totalTokens + entry.usage.totalTokens,
          cost: (acc.cost ?? 0) + (entry.usage.cost ?? 0),
        }),
        { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0, cost: 0 },
      );
      const tokensDisplay = [
        aggregateUsage.inputTokens,
        aggregateUsage.outputTokens,
        aggregateUsage.reasoningTokens,
        aggregateUsage.totalTokens,
      ]
        .map((v, idx) =>
          formatTokenValue(
            v,
            {
              input_tokens: aggregateUsage.inputTokens,
              output_tokens: aggregateUsage.outputTokens,
              reasoning_tokens: aggregateUsage.reasoningTokens,
              total_tokens: aggregateUsage.totalTokens,
            },
            idx,
          ),
        )
        .join("/");
      const tokensPart = (() => {
        const parts = tokensDisplay.split("/");
        if (parts.length !== 4) return tokensDisplay;
        return `↑${parts[0]} ↓${parts[1]} ↻${parts[2]} Δ${parts[3]}`;
      })();
      const statusColor =
        summary.rejected.length === 0
          ? kleur.green
          : summary.fulfilled.length > 0
            ? kleur.yellow
            : kleur.red;
      const overallText = `${summary.fulfilled.length}/${multiModels.length} models`;
      const { line1 } = formatFinishLine({
        elapsedMs: summary.elapsedMs,
        model: overallText,
        costUsd: aggregateUsage.cost ?? null,
        tokensPart,
      });
      log(statusColor(line1));

      const hasFailure = summary.rejected.length > 0;
      const allowPartial = runOptions.partialMode === "ok" && summary.fulfilled.length > 0;
      if (hasFailure) {
        const resultLabel = summary.fulfilled.length > 0 ? "partial success" : "failed";
        log(
          statusColor(
            `Multi-model result: ${resultLabel}, ${summary.fulfilled.length}/${multiModels.length} succeeded`,
          ),
        );
      }
      await sessionStore.updateSession(sessionMeta.id, {
        status: hasFailure ? (allowPartial ? "partial" : "error") : "completed",
        completedAt: new Date().toISOString(),
        usage: aggregateUsage,
        elapsedMs: summary.elapsedMs,
        errorMessage: undefined,
        response: undefined,
        transport: undefined,
        error: undefined,
      });
      const totalCharacters = summary.fulfilled.reduce(
        (sum, entry) => sum + entry.answerText.length,
        0,
      );
      await sendSessionNotification(
        {
          sessionId: sessionMeta.id,
          sessionName: sessionMeta.options?.slug ?? sessionMeta.id,
          mode,
          model: `${multiModels.length} models`,
          usage: aggregateUsage,
          characters: totalCharacters,
        },
        notificationSettings,
        log,
      );
      if (runOptions.writeOutputPath) {
        const savedOutputs: Array<{ model: string; path: string }> = [];
        for (const entry of summary.fulfilled) {
          const modelOutputPath = deriveModelOutputPath(runOptions.writeOutputPath, entry.model);
          const savedPath = await writeAssistantOutput(modelOutputPath, entry.answerText, log);
          if (savedPath) {
            savedOutputs.push({ model: entry.model, path: savedPath });
          }
        }
        const sessionWithRuns = (await readSessionForManifest(sessionMeta.id)) ?? {
          ...sessionMeta,
          models: sessionMeta.models,
        };
        const runLogs = await collectMultiModelRunLogs(
          sessionMeta.id,
          sessionWithRuns.models,
          summary,
        );
        const manifestPath = await writeMultiModelOutputManifest({
          baseOutputPath: runOptions.writeOutputPath,
          sessionId: sessionMeta.id,
          status: hasFailure ? (allowPartial ? "partial" : "error") : "completed",
          summary,
          savedOutputs,
          modelRuns: sessionWithRuns.models,
          runLogs,
          runOptions,
          log,
        });
        if (savedOutputs.length > 0) {
          log(dim("Saved outputs:"));
          for (const item of savedOutputs) {
            log(dim(`- ${item.model} -> ${item.path}`));
          }
        }
        if (manifestPath) {
          log(dim(`Output manifest: ${manifestPath}`));
        }
        if (runLogs.length > 0) {
          log(dim(""));
          log(dim("Run logs:"));
          for (const item of runLogs) {
            log(dim(`- ${item.model} -> ${item.path}`));
          }
        }
      }
      if (hasFailure) {
        log(dim("Failures:"));
        for (const item of summary.rejected) {
          const providerContext = providerFailureContextForModel(item.model, runOptions);
          log(dim(`- ${item.model}: ${formatMultiModelFailure(item.reason, providerContext)}`));
          for (const line of formatMultiModelFailureDetails(item.reason, providerContext)) {
            log(dim(line));
          }
        }
      }
      if (hasFailure && !allowPartial) {
        const firstFailure = summary.rejected[0];
        throw sanitizeMultiModelFailureForThrow(
          firstFailure.reason,
          providerFailureContextForModel(firstFailure.model, runOptions),
        );
      }
      return;
    }
    const singleModelOverride = multiModels.length === 1 ? multiModels[0] : undefined;
    const apiRunOptions: RunOracleOptions = singleModelOverride
      ? { ...runOptions, model: singleModelOverride, models: undefined }
      : runOptions;
    if (modelForStatus && singleModelOverride == null) {
      await sessionStore.updateModelRun(sessionMeta.id, modelForStatus, {
        status: "running",
        startedAt: new Date().toISOString(),
      });
    }
    const result = await runOracle(apiRunOptions, {
      cwd,
      log,
      write,
      allowStdout: !muteStdout,
    });
    if (result.mode !== "live") {
      throw new Error("Unexpected preview result while running a session.");
    }
    await sessionStore.updateSession(sessionMeta.id, {
      status: "completed",
      completedAt: new Date().toISOString(),
      usage: result.usage,
      elapsedMs: result.elapsedMs,
      errorMessage: undefined,
      response: extractResponseMetadata(result.response),
      transport: undefined,
      error: undefined,
    });
    if (modelForStatus && singleModelOverride == null) {
      await sessionStore.updateModelRun(sessionMeta.id, modelForStatus, {
        status: "completed",
        completedAt: new Date().toISOString(),
        usage: result.usage,
      });
    }
    const answerText = extractTextOutput(result.response);
    await writeAssistantOutput(runOptions.writeOutputPath, answerText, log);
    await sendSessionNotification(
      {
        sessionId: sessionMeta.id,
        sessionName: sessionMeta.options?.slug ?? sessionMeta.id,
        mode,
        model: sessionMeta.model ?? runOptions.model,
        usage: result.usage,
        characters: answerText.length,
      },
      notificationSettings,
      log,
      answerText.slice(0, 140),
    );
  } catch (error: unknown) {
    const message = formatError(error);
    log(`ERROR: ${message}`);
    markErrorLogged(error);
    if (isFinalizedClaudeCodeError(error)) {
      throw error;
    }
    const userError = asOracleUserError(error);
    const connectionLost =
      userError?.category === "browser-automation" &&
      (userError.details as { stage?: string } | undefined)?.stage === "connection-lost";
    const assistantTimeout =
      userError?.category === "browser-automation" &&
      (userError.details as { stage?: string } | undefined)?.stage === "assistant-timeout";
    const cloudflareChallenge =
      userError?.category === "browser-automation" &&
      (userError.details as { stage?: string } | undefined)?.stage === "cloudflare-challenge";
    const browserCanReattach = !browserConfig?.copyProfileSource;
    let reattachGuidanceLogged = false;
    const logBrowserReattachGuidance = (runtime?: BrowserRuntimeMetadata | null): void => {
      if (reattachGuidanceLogged || mode !== "browser") return;
      const recoverableRuntime = runtime ?? sessionMeta.browser?.runtime;
      if (
        !hasRecoverableChatGptConversation(recoverableRuntime) &&
        recoverableRuntime?.promptSubmitted !== true
      ) {
        return;
      }
      reattachGuidanceLogged = true;
      log(formatBrowserReattachGuidance(sessionMeta.id));
    };
    if (connectionLost && mode === "browser" && browserCanReattach) {
      const runtime = (userError.details as { runtime?: BrowserRuntimeMetadata } | undefined)
        ?.runtime;
      const recoverableRuntime = runtime ?? sessionMeta.browser?.runtime;
      if (
        !hasRecoverableChatGptConversation(recoverableRuntime) &&
        recoverableRuntime?.promptSubmitted !== true
      ) {
        log(
          dim(
            "Chrome disconnected before a ChatGPT conversation was created; marking session error.",
          ),
        );
        if (modelForStatus) {
          await sessionStore.updateModelRun(sessionMeta.id, modelForStatus, {
            status: "error",
            completedAt: new Date().toISOString(),
            response: { status: "error", incompleteReason: "chrome-disconnected" },
            error: {
              category: userError.category,
              message: userError.message,
              details: userError.details,
            },
          });
        }
        await sessionStore.updateSession(sessionMeta.id, {
          status: "error",
          completedAt: new Date().toISOString(),
          errorMessage: message,
          mode,
          browser: {
            config: browserConfig,
            runtime: recoverableRuntime,
          },
          response: { status: "error", incompleteReason: "chrome-disconnected" },
          error: {
            category: userError.category,
            message: userError.message,
            details: userError.details,
          },
        });
        logBrowserReattachGuidance();
        throw error;
      }
      log(dim("Chrome disconnected before completion; keeping session running for reattach."));
      if (modelForStatus) {
        await sessionStore.updateModelRun(sessionMeta.id, modelForStatus, {
          status: "running",
          completedAt: undefined,
        });
      }
      await sessionStore.updateSession(sessionMeta.id, {
        status: "running",
        errorMessage: message,
        mode,
        browser: {
          config: browserConfig,
          runtime: runtime ?? sessionMeta.browser?.runtime,
        },
        response: { status: "running", incompleteReason: "chrome-disconnected" },
      });
      logBrowserReattachGuidance(runtime ?? sessionMeta.browser?.runtime);
      return;
    }
    if (assistantTimeout && mode === "browser" && browserCanReattach) {
      const runtime = (userError.details as { runtime?: BrowserRuntimeMetadata } | undefined)
        ?.runtime;
      log(dim("Assistant response timed out; marking capture incomplete for reattach."));
      if (modelForStatus) {
        await sessionStore.updateModelRun(sessionMeta.id, modelForStatus, {
          status: "error",
          completedAt: new Date().toISOString(),
          response: { status: "incomplete", incompleteReason: "incomplete-capture" },
          error: {
            category: userError.category,
            message: userError.message,
            details: userError.details,
          },
        });
      }
      await sessionStore.updateSession(sessionMeta.id, {
        status: "error",
        completedAt: new Date().toISOString(),
        errorMessage: message,
        mode,
        browser: {
          config: browserConfig,
          runtime: runtime ?? sessionMeta.browser?.runtime,
        },
        response: { status: "incomplete", incompleteReason: "incomplete-capture" },
        error: {
          category: userError.category,
          message: userError.message,
          details: userError.details,
        },
      });
      const autoReattachIntervalMs = browserConfig?.autoReattachIntervalMs ?? 0;
      if (autoReattachIntervalMs > 0) {
        const autoRuntime = runtime ?? sessionMeta.browser?.runtime;
        const success = await autoReattachUntilComplete({
          sessionMeta,
          runtime: autoRuntime ?? undefined,
          browserConfig,
          runOptions,
          modelForStatus,
          notificationSettings,
          log,
        });
        if (success) {
          return;
        }
      }
      logBrowserReattachGuidance(runtime ?? sessionMeta.browser?.runtime);
      return;
    }
    if (cloudflareChallenge && mode === "browser") {
      const details = userError.details as { reuseProfileHint?: string } | undefined;
      if (browserCanReattach) {
        log(
          dim("Cloudflare challenge detected; browser left running so you can complete the check."),
        );
        if (details?.reuseProfileHint) {
          log(dim(`Reuse this browser profile with: ${details.reuseProfileHint}`));
        }
      } else {
        log(dim("Cloudflare challenge detected; copied profile closed and removed."));
      }
    }
    if (userError) {
      log(dim(`User error (${userError.category}): ${userError.message}`));
    }
    const responseMetadata = error instanceof OracleResponseError ? error.metadata : undefined;
    const metadataLine = formatResponseMetadata(responseMetadata);
    if (metadataLine) {
      log(dim(`Response metadata: ${metadataLine}`));
    }
    const transportMetadata =
      error instanceof OracleTransportError ? { reason: error.reason } : undefined;
    const transportLine = formatTransportMetadata(transportMetadata);
    if (transportLine) {
      log(dim(`Transport: ${transportLine}`));
    }
    const browserRuntime =
      mode === "browser" && browserCanReattach
        ? (userError?.details as { runtime?: BrowserRuntimeMetadata } | undefined)?.runtime
        : undefined;
    if (!cloudflareChallenge && browserCanReattach) {
      logBrowserReattachGuidance(browserRuntime ?? sessionMeta.browser?.runtime);
    }
    await sessionStore.updateSession(sessionMeta.id, {
      status: "error",
      completedAt: new Date().toISOString(),
      errorMessage: message,
      mode,
      claudeCode:
        mode === "claude-code"
          ? buildClaudeCodeErrorSessionMetadata({
              model: modelForStatus ?? "fable",
              message,
            })
          : undefined,
      browser: browserConfig
        ? {
            config: browserConfig,
            runtime: browserRuntime ?? undefined,
          }
        : undefined,
      response: responseMetadata,
      transport: transportMetadata,
      error: userError
        ? {
            category: userError.category,
            message: userError.message,
            details: userError.details,
          }
        : undefined,
    });
    if (modelForStatus) {
      await sessionStore.updateModelRun(sessionMeta.id, modelForStatus, {
        status: "error",
        completedAt: new Date().toISOString(),
      });
    }
    throw error;
  }
}

function extractChatGptConversationId(url: string | null | undefined): string | undefined {
  if (!url) {
    return undefined;
  }
  const match = url.match(/\/c\/([^/?#]+)/);
  return match?.[1];
}

function buildSubmittedRecoveryRuntime(
  sessionMeta: SessionMetadata,
): BrowserRuntimeMetadata | null {
  const runtime = sessionMeta.browser?.runtime;
  if (runtime?.promptSubmitted !== true) {
    return null;
  }
  const recoveryUrl = resolveRecoveryUrl(sessionMeta);
  if (!recoveryUrl) {
    return runtime;
  }
  return {
    ...runtime,
    // A saved conversation URL is stronger recovery evidence than a stale CDP
    // target id from a previous process. Re-resolve by URL/conversation first.
    chromeTargetId: undefined,
    tabUrl: recoveryUrl,
    conversationId: extractChatGptConversationId(recoveryUrl) ?? runtime.conversationId,
  };
}

async function recoverSubmittedBrowserSessionBeforeFreshRun({
  sessionMeta,
  browserConfig,
  runOptions,
  modelForStatus,
  notificationSettings,
  log,
}: {
  sessionMeta: SessionMetadata;
  browserConfig: BrowserSessionConfig;
  runOptions: RunOracleOptions;
  modelForStatus?: string;
  notificationSettings: NotificationSettings;
  log: (message?: string) => void;
}): Promise<boolean> {
  const runtime = buildSubmittedRecoveryRuntime(sessionMeta);
  if (!runtime) {
    return false;
  }

  const nextAction = `oracle session ${sessionMeta.id} --render`;
  const canAttemptRecovery =
    hasRecoverableChatGptConversation(runtime) ||
    Boolean(runtime.chromePort || runtime.chromeBrowserWSEndpoint || runtime.chromeProfileRoot);
  if (!canAttemptRecovery) {
    throw new BrowserAutomationError(
      `Stored browser session ${sessionMeta.id} already submitted a prompt; refusing to start a fresh browser run. Reattach with \`${nextAction}\` or inspect with \`oracle session ${sessionMeta.id} --harvest\`.`,
      {
        stage: "submitted-session-recovery",
        runtime,
        retryable: false,
        nextAction,
      },
    );
  }

  log(
    dim(
      `Stored browser session ${sessionMeta.id} already submitted a prompt; attempting reattach instead of submitting again.`,
    ),
  );
  const logger: BrowserLogger = ((message?: string) => {
    if (message) {
      log(dim(message));
    }
  }) as BrowserLogger;
  logger.verbose = true;

  try {
    const result = await resumeBrowserSession(runtime, browserConfig, logger, {
      promptPreview: sessionMeta.promptPreview,
    });
    const answerText = result.answerMarkdown || result.answerText || "";
    const outputTokens = estimateTokenCount(answerText);
    const artifacts = await ensureSessionArtifacts({
      sessionId: sessionMeta.id,
      prompt: runOptions.prompt,
      answerMarkdown: answerText,
      conversationUrl: runtime.tabUrl,
      browserConfig,
      existingArtifacts: sessionMeta.artifacts,
      logger,
    });
    const logWriter = sessionStore.createLogWriter(sessionMeta.id);
    logWriter.logLine(
      "[submitted-session-recovery] captured assistant response without resubmitting",
    );
    logWriter.logLine("Answer:");
    logWriter.logLine(answerText);
    logWriter.stream.end();
    const usage = {
      inputTokens: 0,
      outputTokens,
      reasoningTokens: 0,
      totalTokens: outputTokens,
    };
    if (modelForStatus) {
      await sessionStore.updateModelRun(sessionMeta.id, modelForStatus, {
        status: "completed",
        completedAt: new Date().toISOString(),
        usage,
      });
    }
    await sessionStore.updateSession(sessionMeta.id, {
      status: "completed",
      completedAt: new Date().toISOString(),
      usage,
      errorMessage: undefined,
      browser: {
        config: browserConfig,
        runtime,
        harvest: sessionMeta.browser?.harvest,
        archive: sessionMeta.browser?.archive,
        modelSelection: sessionMeta.browser?.modelSelection,
        warnings: sessionMeta.browser?.warnings,
      },
      artifacts: mergeArtifacts(sessionMeta.artifacts, artifacts),
      response: { status: "completed" },
      error: undefined,
      transport: undefined,
    });
    await writeAssistantOutput(runOptions.writeOutputPath, answerText, log);
    await sendSessionNotification(
      {
        sessionId: sessionMeta.id,
        sessionName: sessionMeta.options?.slug ?? sessionMeta.id,
        mode: sessionMeta.mode ?? "browser",
        model: sessionMeta.model ?? runOptions.model,
        usage,
        characters: answerText.length,
      },
      notificationSettings,
      log,
      answerText.slice(0, 140),
    );
    log(kleur.green("Submitted-session recovery succeeded; session marked completed."));
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new BrowserAutomationError(
      `Stored browser session ${sessionMeta.id} already submitted a prompt; reattach failed (${message}). Refusing to start a fresh browser run. Next action: ${nextAction}`,
      {
        stage: "submitted-session-recovery",
        runtime,
        retryable: false,
        nextAction,
      },
      error,
    );
  }
}

function mergeArtifacts(
  existing: SessionArtifact[] | undefined,
  additions: SessionArtifact[] | undefined,
): SessionArtifact[] | undefined {
  const merged = new Map<string, SessionArtifact>();
  for (const artifact of existing ?? []) {
    merged.set(`${artifact.kind}:${artifact.path}`, artifact);
  }
  for (const artifact of additions ?? []) {
    merged.set(`${artifact.kind}:${artifact.path}`, artifact);
  }
  const values = Array.from(merged.values());
  return values.length > 0 ? values : undefined;
}

async function runLocalClaudeCodeSession(
  input: ClaudeCodeRunnerInput,
): Promise<ClaudeCodeRunnerResult> {
  const startedAt = Date.now();
  const sessionDir = path.dirname(path.dirname(input.artifactPaths.rawStdoutPath));
  const preparedEnv = prepareClaudeCodeEnvironment(process.env);
  const ownerResult = await assertClaudeCodeLocalOwner({
    oracleHome: getOracleHomeDir(),
    sessionDir,
    env: process.env,
    transport: "stdio",
  });
  const executable = await resolveClaudeExecutable({
    // `claudeCode.executable` is an explicit, still-hardened override (also
    // settable via the ORACLE_CLAUDE_CODE_EXECUTABLE env var, read inside
    // resolveClaudeExecutable itself); default is the bare `claude` PATH
    // lookup.
    executable: input.runOptions.claudeCode?.executable,
    repoRoot: input.cwd,
    env: process.env,
  });
  // Multi-turn resume primitive (claude-provider-map.md finding #2): set
  // only when oracle's own `--followup <sessionId>` resolution populated
  // it (bin/oracle-cli.ts) — never from a raw `--resume`/`--continue`
  // passthrough, which stay blocked in `command.ts`. One-shot runs (the
  // default) leave this undefined and keep today's exact
  // `--no-session-persistence` behavior.
  const resumeSessionId = input.runOptions.claudeCode?.resumeSessionId?.trim() || undefined;
  // Stored on EVERY run (one-shot included) so a *later* `--followup`
  // targeting this session always has a session id to resume from, even
  // though a one-shot run never passes it to `claude` itself.
  const claudeSessionId = resumeSessionId ?? randomUUID();
  const command = buildClaudeCodeCommand({
    executable: executable.path,
    model: input.model,
    resumeSessionId,
  });

  // Opt-in `caam shallow-spawn` integration (caam-map.md §4). Activates ONLY
  // when a profile is configured; any failure to stand it up (caam absent,
  // hardening failure, unhealthy profile doctor) falls back to today's exact
  // direct-`claude` behavior rather than breaking the run — see
  // `tryActivateCaamShallowSpawn`.
  const caamProfileRequested = resolveClaudeCodeCaamProfile(
    input.runOptions.claudeCode?.caamProfile,
    process.env,
  );
  const caam = caamProfileRequested
    ? await tryActivateCaamShallowSpawn(caamProfileRequested, command, input)
    : undefined;
  const spawnCommand = caam?.command ?? command;

  const waitForLockMs = resolveClaudeCodeWaitForLockMs(input.runOptions.claudeCode?.waitForLockMs);
  if (waitForLockMs > 0) {
    input.log(
      dim(`Claude Code single-flight lock: waiting up to ${formatElapsed(waitForLockMs)}.`),
    );
  }
  const singleFlightLock = await acquireClaudeCodeSingleFlightLock(input.sessionId, {
    waitForLockMs,
    // Keying the lock on the caam profile (instead of the fixed global
    // filename) is what lets distinct profiles run in parallel while same
    // -profile sessions still serialize (caam-map.md §4b). No profile active
    // -> unchanged global lock.
    lockKey: caam?.profile,
  });
  input.log(
    dim(
      `Claude Code command: ${spawnCommand.file} ${spawnCommand.args.map(redactClaudeCodeArgForLog).join(" ")}`,
    ),
  );
  for (const warning of preparedEnv.warnings) {
    input.log(dim(`Claude Code env warning: ${warning.source} ${warning.action}.`));
  }
  for (const warning of ownerResult.warnings) {
    input.log(dim(`Claude Code owner warning: ${warning}.`));
  }

  try {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const normalizer = new ClaudeCodeStreamNormalizer();
    const events: ClaudeCodeNormalizedEvent[] = [];
    let stdoutEvents = 0;
    let stderrEvents = 0;
    let rawStreamBytes = 0;
    let timedOut = false;
    let policyViolation: ClaudeCodeReadOnlyPolicyViolation | undefined;
    let outputFlood: { stream: "stdout" | "stderr"; totalBytes: number } | undefined;
    let abortedBySignal: NodeJS.Signals | undefined;
    const timeoutMs = resolveClaudeCodeTimeoutMs(input.runOptions.timeoutSeconds);
    const maxInlineBytes = resolveClaudeCodeMaxInlineBytes(
      input.runOptions.claudeCode?.maxInlineBytes,
      process.env,
    );

    // TOCTOU re-check: time has passed since the initial resolution above
    // (env prep, owner check, command build, and — notably — however long
    // acquireClaudeCodeSingleFlightLock waited for a competing lane lock),
    // so re-verify the already-resolved real path immediately before
    // spawning. `executable.path` is absolute, so this repeats the full
    // symlink/world-writable/ownership/inside-repo hardening against it
    // without redoing the PATH search.
    await resolveClaudeExecutable({
      executable: executable.path,
      repoRoot: input.cwd,
      env: process.env,
    });
    if (caam) {
      // Same TOCTOU re-check, mirrored for the caam executable — it is
      // about to `exec` into a repointed `$HOME`, so it gets the same
      // "re-verify the resolved real path immediately before spawn"
      // treatment as `claude` above.
      await resolveCaamExecutable({
        executable: caam.executable.path,
        repoRoot: input.cwd,
        env: process.env,
      });
    }

    const child = spawn(spawnCommand.file, spawnCommand.args, {
      ...spawnCommand.spawnOptions,
      cwd: input.cwd,
      detached: process.platform !== "win32",
      env: preparedEnv.childEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let hardKillTimeout: NodeJS.Timeout | undefined;
    const scheduleHardKill = () => {
      if (hardKillTimeout) return;
      hardKillTimeout = setTimeout(() => terminateClaudeCodeChild(child, "SIGKILL"), 5_000);
      hardKillTimeout.unref?.();
    };
    const stopForPolicyViolation = (normalized: ClaudeCodeNormalizedEvent[]) => {
      if (policyViolation) return;
      const violation = findClaudeCodeReadOnlyPolicyViolation(normalized);
      if (!violation) return;
      policyViolation = violation;
      terminateClaudeCodeChild(child, "SIGTERM");
      scheduleHardKill();
    };
    const stopForOutputFlood = (stream: "stdout" | "stderr", totalBytes: number) => {
      if (outputFlood || totalBytes <= maxInlineBytes) return;
      outputFlood = { stream, totalBytes };
      terminateClaudeCodeChild(child, "SIGTERM");
      scheduleHardKill();
    };
    const stopForAbortSignal = (signal: NodeJS.Signals) => {
      if (abortedBySignal) return;
      abortedBySignal = signal;
      terminateClaudeCodeChild(child, "SIGTERM");
      scheduleHardKill();
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      terminateClaudeCodeChild(child, "SIGTERM");
      scheduleHardKill();
    }, timeoutMs);
    timeout.unref?.();
    const sigintHandler = () => stopForAbortSignal("SIGINT");
    const sigtermHandler = () => stopForAbortSignal("SIGTERM");
    process.once("SIGINT", sigintHandler);
    process.once("SIGTERM", sigtermHandler);

    child.stdout.on("data", (chunk: Buffer) => {
      const bytes = Buffer.from(chunk);
      stdoutChunks.push(bytes);
      rawStreamBytes += bytes.length;
      stopForOutputFlood("stdout", rawStreamBytes);
      const normalized = normalizer.push("stdout", bytes);
      stdoutEvents += normalized.length;
      events.push(...normalized);
      writeClaudeCodeVisibleEvents(input.write, normalized);
      stopForPolicyViolation(normalized);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const bytes = Buffer.from(chunk);
      stderrChunks.push(bytes);
      rawStreamBytes += bytes.length;
      stopForOutputFlood("stderr", rawStreamBytes);
      const normalized = normalizer.push("stderr", bytes);
      stderrEvents += normalized.length;
      events.push(...normalized);
      writeClaudeCodeVisibleEvents(input.write, normalized);
      stopForPolicyViolation(normalized);
    });

    const exit = await new Promise<{ exitCode: number | null; signal: string | null }>(
      (resolve, reject) => {
        child.once("error", reject);
        child.once("close", (exitCode, signal) => resolve({ exitCode, signal }));
        child.stdin.once("error", reject);
        child.stdin.end(input.prompt);
      },
    ).finally(() => {
      process.off("SIGINT", sigintHandler);
      process.off("SIGTERM", sigtermHandler);
      clearTimeout(timeout);
      if (hardKillTimeout) {
        clearTimeout(hardKillTimeout);
      }
    });
    const finalEvents = normalizer.finish();
    if (finalEvents.length > 0) {
      stdoutEvents += finalEvents.filter((event) => event.stream === "stdout").length;
      events.push(...finalEvents);
      writeClaudeCodeVisibleEvents(input.write, finalEvents);
      policyViolation = policyViolation ?? findClaudeCodeReadOnlyPolicyViolation(finalEvents);
    }

    const verification = verifyClaudeCodeRun(events, { requestedModel: input.model });
    const verificationError = verification.ok
      ? undefined
      : `Claude Code local mode stopped because startup verification failed: ${verification.failures
          .map((failure) => failure.code)
          .join(", ")}`;
    const exitError =
      exit.exitCode === 0
        ? undefined
        : timedOut
          ? `Claude Code local mode timed out after ${formatElapsed(timeoutMs)}.`
          : `Claude Code exited with code ${exit.exitCode ?? "null"}${exit.signal ? ` signal ${exit.signal}` : ""}.`;
    const policyViolationError = policyViolation
      ? `Claude Code local mode stopped because the visible event stream showed a read-only policy violation: ${policyViolation.reason}. Raw events were saved in ${input.artifactPaths.normalizedEventsPath}.`
      : undefined;
    const outputFloodError = outputFlood
      ? `Claude Code local mode stopped because visible ${outputFlood.stream} output exceeded the inline byte limit (${outputFlood.totalBytes.toLocaleString()} bytes > ${maxInlineBytes.toLocaleString()} bytes). Raw events were saved in ${input.artifactPaths.normalizedEventsPath}.`
      : undefined;
    const abortError = abortedBySignal
      ? `Claude Code local mode stopped after ${abortedBySignal}. Raw events were saved in ${input.artifactPaths.normalizedEventsPath}.`
      : undefined;
    const errorMessage =
      policyViolationError ?? outputFloodError ?? abortError ?? verificationError ?? exitError;
    const normalizedEventsNdjson = events.map((event) => JSON.stringify(event)).join("\n");
    const finalAnswer = extractFinalTextFromEvents(events);

    return {
      stdoutRaw: Buffer.concat(stdoutChunks),
      stderrRaw: Buffer.concat(stderrChunks),
      normalizedEventsNdjson: normalizedEventsNdjson ? `${normalizedEventsNdjson}\n` : "",
      finalAnswerMarkdown: finalAnswer,
      progressMarkdown: summarizeClaudeCodeProgress(events, errorMessage),
      finalAnswerText: finalAnswer,
      elapsedMs: Date.now() - startedAt,
      exitCode: exit.exitCode,
      signal: exit.signal,
      eventsComplete: !timedOut && !policyViolation && !outputFlood && !abortedBySignal,
      streamsComplete: !timedOut && !policyViolation && !outputFlood && !abortedBySignal,
      stdoutEvents,
      stderrEvents,
      modelRequested: verification.metadata.modelRequested,
      modelObserved: verification.metadata.modelObserved,
      modelResolvedFromInit: verification.metadata.modelResolvedFromInit,
      modelUsageKeys: verification.metadata.modelUsageKeys,
      modelUsageAuxiliaryKeys: verification.metadata.modelUsageAuxiliaryKeys,
      modelVerificationStatus: verification.metadata.modelVerificationStatus,
      totalCostUsdObserved: verification.metadata.totalCostUsdObserved,
      visibleThinkingCaptured: verification.metadata.visibleThinkingCaptured,
      localOwnerVerified: true,
      anthropicApiKeyPresent: false,
      anthropicApiKeyRefusalChecked: true,
      childEnvScrubbed: true,
      errorMessage,
      claudeSessionId,
      caamProfileUsed: caam?.profile,
      sessionPersistenceDisabled: !resumeSessionId,
      adapterMetadata: {
        command: {
          executable: spawnCommand.file,
          args_redacted: spawnCommand.args.map(redactClaudeCodeArgForAdapter),
        },
        executable: {
          requested: executable.requested,
          path: executable.path,
          owner_uid: executable.ownerUid,
          mode: executable.mode,
        },
        caam: caam
          ? {
              active: true,
              profile: caam.profile,
              executable: caam.executable.path,
            }
          : { active: false },
        env_warnings: preparedEnv.warnings,
        env_scrubbed_sources: preparedEnv.scrubbedSources,
        local_owner: ownerResult,
        single_flight_lock: {
          path: singleFlightLock.path,
          session_id: singleFlightLock.metadata.session_id,
          pid: singleFlightLock.metadata.pid,
          created_at: singleFlightLock.metadata.created_at,
          wait_for_lock_ms: waitForLockMs,
        },
        policy_violation: policyViolation ?? null,
        output_flood: outputFlood ?? null,
        aborted_by_signal: abortedBySignal ?? null,
        verification,
        timeout_ms: timeoutMs,
        max_inline_bytes: maxInlineBytes,
      },
    };
  } finally {
    await singleFlightLock.release().catch((error: unknown) => {
      input.log(dim(`Claude Code lock release warning: ${formatError(error)}`));
    });
  }
}

async function buildClaudeCodeArtifactPaths(sessionId: string): Promise<ClaudeCodeArtifactPaths> {
  const sessionDir = await resolveSessionDir(sessionId);
  if (!sessionDir) {
    throw new Error(`Cannot resolve session directory for ${sessionId}.`);
  }
  const artifactsDir = path.join(sessionDir, "artifacts");
  await ensureOwnerOnlyClaudeCodeArtifactsDir(artifactsDir);
  return {
    rawStdoutPath: path.join(artifactsDir, "claude-code-stdout.raw"),
    rawStderrPath: path.join(artifactsDir, "claude-code-stderr.raw"),
    normalizedEventsPath: path.join(artifactsDir, "claude-code-events.normalized.ndjson"),
    finalAnswerPath: path.join(artifactsDir, "claude-code-final.md"),
    progressPath: path.join(artifactsDir, "claude-code-progress.md"),
    adapterMetadataPath: path.join(artifactsDir, "claude-code-adapter.json"),
  };
}

async function ensureOwnerOnlyClaudeCodeArtifactsDir(dir: string): Promise<void> {
  await assertNotSymlink(dir, "Claude Code artifact directory");
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await assertNotSymlink(dir, "Claude Code artifact directory");
  if (process.platform !== "win32") {
    await fs.chmod(dir, 0o700).catch(() => undefined);
  }
}

async function assertNotSymlink(targetPath: string, label: string): Promise<void> {
  try {
    const stat = await fs.lstat(targetPath);
    if (stat.isSymbolicLink()) {
      throw new Error(`${label} refuses symlink path: ${targetPath}`);
    }
  } catch (error) {
    const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
    if (code === "ENOENT") {
      return;
    }
    throw error;
  }
}

async function persistClaudeCodeArtifacts({
  artifactPaths,
  payloads,
}: {
  artifactPaths: ClaudeCodeArtifactPaths;
  payloads: ClaudeCodeArtifactPayloads;
}): Promise<SessionArtifact[]> {
  const adapterMetadata = buildClaudeCodeAdapterMetadata(payloads, artifactPaths);
  const writes: Array<{
    kind: SessionArtifact["kind"];
    path: string;
    label: string;
    mimeType: string;
    contents: Buffer | string;
  }> = [
    {
      kind: "claude-code-stdout-raw",
      path: artifactPaths.rawStdoutPath,
      label: "Claude Code stdout (raw)",
      mimeType: "application/octet-stream",
      contents: payloads.stdoutRaw ?? Buffer.alloc(0),
    },
    {
      kind: "claude-code-stderr-raw",
      path: artifactPaths.rawStderrPath,
      label: "Claude Code stderr (raw)",
      mimeType: "application/octet-stream",
      contents: payloads.stderrRaw ?? Buffer.alloc(0),
    },
    {
      kind: "claude-code-events-normalized",
      path: artifactPaths.normalizedEventsPath,
      label: "Claude Code normalized events",
      mimeType: "application/x-ndjson",
      contents: payloads.normalizedEventsNdjson ?? "",
    },
    {
      kind: "claude-code-final",
      path: artifactPaths.finalAnswerPath,
      label: "Claude Code final answer",
      mimeType: "text/markdown",
      contents: payloads.finalAnswerMarkdown ?? "",
    },
    {
      kind: "claude-code-progress",
      path: artifactPaths.progressPath,
      label: "Claude Code visible progress",
      mimeType: "text/markdown",
      contents: payloads.progressMarkdown ?? "",
    },
    {
      kind: "claude-code-adapter",
      path: artifactPaths.adapterMetadataPath,
      label: "Claude Code adapter metadata",
      mimeType: "application/json",
      contents: `${JSON.stringify(adapterMetadata, null, 2)}\n`,
    },
  ];
  const artifacts: SessionArtifact[] = [];
  for (const item of writes) {
    artifacts.push(await writeOwnerOnlyClaudeCodeArtifact(item));
  }
  return artifacts;
}

async function writeOwnerOnlyClaudeCodeArtifact({
  kind,
  path: targetPath,
  label,
  mimeType,
  contents,
}: {
  kind: SessionArtifact["kind"];
  path: string;
  label: string;
  mimeType: string;
  contents: Buffer | string;
}): Promise<SessionArtifact> {
  await assertNotSymlink(targetPath, "Claude Code artifact file");
  const buffer = Buffer.isBuffer(contents) ? contents : Buffer.from(contents, "utf8");
  await fs.writeFile(targetPath, buffer, { mode: 0o600, flag: "wx" });
  if (process.platform !== "win32") {
    await fs.chmod(targetPath, 0o600).catch(() => undefined);
  }
  return {
    kind,
    path: targetPath,
    label,
    mimeType,
    sizeBytes: buffer.length,
    sha256: createHash("sha256").update(buffer).digest("hex"),
    validation: { type: "generic", ok: true },
    transfer: { status: "not-needed" },
    origin: { mode: "local" },
  };
}

function buildClaudeCodeAdapterMetadata(
  payloads: ClaudeCodeArtifactPayloads,
  artifactPaths: ClaudeCodeArtifactPaths,
): Record<string, unknown> {
  return {
    schema_version: "claude_code_adapter.v1",
    access_path: "claude_code_subscription_cli",
    provider_family: "claude",
    transcript_fidelity: "visible_cli_stream",
    hidden_reasoning_captured: false,
    subscription_billing_uncertain: true,
    raw_stdout_path: artifactPaths.rawStdoutPath,
    raw_stderr_path: artifactPaths.rawStderrPath,
    normalized_events_path: artifactPaths.normalizedEventsPath,
    final_answer_path: artifactPaths.finalAnswerPath,
    progress_path: artifactPaths.progressPath,
    adapter_metadata_path: artifactPaths.adapterMetadataPath,
    ...payloads.adapterMetadata,
  };
}

function buildClaudeCodeSessionMetadata({
  result,
  artifactPaths,
  model,
}: {
  result: ClaudeCodeRunnerResult;
  artifactPaths: ClaudeCodeArtifactPaths;
  model: string;
}): ClaudeCodeSessionMetadata {
  const modelUsageKeys = result.modelUsageKeys ?? [];
  return {
    schema_version: "claude_code_session.v1",
    access_path: "claude_code_subscription_cli",
    provider_family: "claude",
    model_requested: result.modelRequested ?? model,
    model_observed: result.modelObserved ?? null,
    model_resolved_from_init: result.modelResolvedFromInit ?? null,
    model_usage_keys: modelUsageKeys,
    model_usage_auxiliary_keys: result.modelUsageAuxiliaryKeys ?? [],
    model_verification_status: result.modelVerificationStatus ?? "requested_only",
    total_cost_usd_observed: result.totalCostUsdObserved ?? null,
    claude_session_id: result.claudeSessionId,
    caam_profile: result.caamProfileUsed,
    subscription_billing_uncertain: true,
    credit_billing_warning_emitted: result.creditBillingWarningEmitted ?? false,
    read_only: {
      readOnly: true,
      permissionMode: "plan",
      toolMode: "none",
      allowedTools: [],
      blockedTools: ["*"],
      mcpToolsBlocked: true,
      slashCommandsDisabled: true,
      safeMode: true,
      chromeDisabled: true,
      sessionPersistenceDisabled: result.sessionPersistenceDisabled ?? true,
    },
    local_owner_verified: result.localOwnerVerified,
    anthropic_api_key_present: result.anthropicApiKeyPresent,
    anthropic_api_key_refusal_checked: result.anthropicApiKeyRefusalChecked,
    child_env_scrubbed: result.childEnvScrubbed,
    transcript_fidelity: "visible_cli_stream",
    hidden_reasoning_captured: false,
    visible_thinking_captured: result.visibleThinkingCaptured ?? "unknown",
    exit_code: result.exitCode ?? null,
    signal: result.signal ?? null,
    events_complete: result.eventsComplete ?? true,
    streams_complete: result.streamsComplete ?? result.eventsComplete ?? true,
    stdout_events: result.stdoutEvents,
    stdout_bytes: byteLength(result.stdoutRaw),
    stderr_events: result.stderrEvents,
    stderr_bytes: byteLength(result.stderrRaw),
    artifact_paths: artifactPaths,
    adapter_metadata_path: artifactPaths.adapterMetadataPath,
    raw_stdout_path: artifactPaths.rawStdoutPath,
    raw_stderr_path: artifactPaths.rawStderrPath,
    normalized_events_path: artifactPaths.normalizedEventsPath,
    final_answer_path: artifactPaths.finalAnswerPath,
    progress_path: artifactPaths.progressPath,
  };
}

function buildClaudeCodeErrorSessionMetadata({
  model,
  message,
}: {
  model: string;
  message: string;
}): ClaudeCodeSessionMetadata {
  return {
    schema_version: "claude_code_session.v1",
    access_path: "claude_code_subscription_cli",
    provider_family: "claude",
    model_requested: model,
    model_observed: null,
    model_resolved_from_init: null,
    model_usage_keys: [],
    model_usage_auxiliary_keys: [],
    model_verification_status: "requested_only",
    total_cost_usd_observed: null,
    subscription_billing_uncertain: true,
    credit_billing_warning_emitted: false,
    read_only: {
      readOnly: true,
      permissionMode: "plan",
      toolMode: "none",
      allowedTools: [],
      blockedTools: ["*"],
      mcpToolsBlocked: true,
      slashCommandsDisabled: true,
      safeMode: true,
      chromeDisabled: true,
      sessionPersistenceDisabled: true,
    },
    transcript_fidelity: "visible_cli_stream",
    hidden_reasoning_captured: false,
    visible_thinking_captured: "unknown",
    events_complete: false,
    streams_complete: false,
    error_reason: message,
  };
}

function usageFromClaudeCodeResult(result: ClaudeCodeRunnerResult): UsageSummary {
  return {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    cost: result.totalCostUsdObserved ?? undefined,
  };
}

function extractFinalTextFromNdjson(result: ClaudeCodeRunnerResult): string {
  const ndjson = result.normalizedEventsNdjson;
  if (!ndjson) {
    return "";
  }
  const pieces: string[] = [];
  for (const line of ndjson.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed) as { text?: unknown };
      if (typeof parsed.text === "string") {
        pieces.push(parsed.text);
      }
    } catch {
      // Normalized parse failures are preserved in artifacts; extraction is best effort.
    }
  }
  return pieces.join("");
}

interface ClaudeCodeCaamActivation {
  command: ClaudeCodeCommand;
  profile: string;
  executable: ResolvedCaamExecutable;
}

/**
 * caam-map.md §4: resolve `caam`, run its read-only `shallow-profile doctor`
 * pre-flight, and build the `caam shallow-spawn` outer command. Any failure
 * along this path is caught and logged as a graceful-fallback warning —
 * per the opt-in + graceful-fallback contract, a caam misconfiguration must
 * never break the claude-code lane for callers who didn't ask for it;
 * `runLocalClaudeCodeSession` falls back to today's exact direct-`claude`
 * behavior (single global lock) whenever this returns `undefined`.
 */
async function tryActivateCaamShallowSpawn(
  profile: string,
  innerCommand: ClaudeCodeCommand,
  input: ClaudeCodeRunnerInput,
): Promise<ClaudeCodeCaamActivation | undefined> {
  try {
    // Validate the profile name up front — before it is passed as an argv
    // value to `caam shallow-profile doctor` AND before it is embedded in
    // the per-profile lock filename below — so a malformed profile name
    // never reaches an external process or a `path.join`.
    const validatedProfile = validateCaamProfileName(profile);
    const caamExecutable = await resolveCaamExecutable({
      repoRoot: input.cwd,
      env: process.env,
    });
    await runCaamShallowProfileDoctor(caamExecutable.path, validatedProfile, {
      env: process.env,
    });
    const base = path.join(getOracleHomeDir(), "claude-code-shallow-homes");
    const command = buildCaamShallowSpawnCommand({
      caamExecutable: caamExecutable.path,
      profile: validatedProfile,
      base,
      inner: innerCommand,
    });
    input.log(
      dim(
        `Claude Code caam shallow-spawn active: profile "${validatedProfile}" via ${caamExecutable.path}.`,
      ),
    );
    return { command, profile: validatedProfile, executable: caamExecutable };
  } catch (error) {
    input.log(
      dim(
        `Claude Code caam shallow-spawn unavailable, falling back to direct \`claude\` with the shared single-flight lock: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ),
    );
    return undefined;
  }
}

function resolveClaudeCodeTimeoutMs(timeoutSeconds: RunOracleOptions["timeoutSeconds"]): number {
  if (typeof timeoutSeconds === "number" && Number.isFinite(timeoutSeconds) && timeoutSeconds > 0) {
    return timeoutSeconds * 1000;
  }
  return 60 * 60 * 1000;
}

function resolveClaudeCodeWaitForLockMs(waitForLockMs: number | undefined): number {
  if (typeof waitForLockMs === "number" && Number.isFinite(waitForLockMs) && waitForLockMs > 0) {
    return waitForLockMs;
  }
  return 0;
}

interface ClaudeCodeSingleFlightLockMetadata {
  schema_version: "claude_code_single_flight_lock.v1";
  session_id: string;
  pid: number;
  nonce: string;
  created_at: string;
  /** caam shallow-spawn profile this lock is keyed on, if any (caam-map.md §4b). */
  caam_profile?: string;
}

interface ClaudeCodeSingleFlightLock {
  path: string;
  metadata: ClaudeCodeSingleFlightLockMetadata;
  release: () => Promise<void>;
}

interface ClaudeCodeReadOnlyPolicyViolation {
  reason: string;
  eventType?: string;
  eventSeq?: number;
}

class ClaudeCodeSingleFlightLockBusyError extends Error {
  constructor(
    readonly lockPath: string,
    readonly existing: ClaudeCodeSingleFlightLockMetadata | null,
  ) {
    super(formatClaudeCodeLockBusyMessage(lockPath, existing));
    this.name = "ClaudeCodeSingleFlightLockBusyError";
  }
}

async function acquireClaudeCodeSingleFlightLock(
  sessionId: string,
  options: { waitForLockMs?: number; retryIntervalMs?: number; lockKey?: string } = {},
): Promise<ClaudeCodeSingleFlightLock> {
  const locksDir = path.join(getOracleHomeDir(), "locks");
  await fs.mkdir(locksDir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    await fs.chmod(locksDir, 0o700).catch(() => undefined);
  }
  // Keying the lock filename on `options.lockKey` (the caam shallow-spawn
  // profile — already validated by `validateCaamProfileName` before this is
  // called) is what lets distinct profiles run in parallel while same
  // -profile sessions still serialize (caam-map.md §4b). No `lockKey` ->
  // the original fixed global filename, i.e. today's exact behavior.
  const lockFileName = options.lockKey
    ? `claude-code-subscription-${options.lockKey}.lock`
    : "claude-code-subscription.lock";
  const lockPath = path.join(locksDir, lockFileName);
  const metadata: ClaudeCodeSingleFlightLockMetadata = {
    schema_version: "claude_code_single_flight_lock.v1",
    session_id: sessionId,
    pid: process.pid,
    nonce: randomUUID(),
    created_at: new Date().toISOString(),
    ...(options.lockKey ? { caam_profile: options.lockKey } : {}),
  };
  const waitForLockMs = resolveClaudeCodeWaitForLockMs(options.waitForLockMs);
  const deadline = waitForLockMs > 0 ? Date.now() + waitForLockMs : 0;
  const retryIntervalMs = Math.max(25, Math.min(options.retryIntervalMs ?? 250, 1_000));

  while (true) {
    try {
      return await tryAcquireClaudeCodeSingleFlightLock(lockPath, metadata);
    } catch (error) {
      if (!(error instanceof ClaudeCodeSingleFlightLockBusyError) || waitForLockMs <= 0) {
        throw error;
      }
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        throw error;
      }
      await wait(Math.min(retryIntervalMs, remainingMs));
    }
  }
}

async function tryAcquireClaudeCodeSingleFlightLock(
  lockPath: string,
  metadata: ClaudeCodeSingleFlightLockMetadata,
): Promise<ClaudeCodeSingleFlightLock> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await fs.writeFile(lockPath, `${JSON.stringify(metadata, null, 2)}\n`, {
        flag: "wx",
        mode: 0o600,
      });
      if (process.platform !== "win32") {
        await fs.chmod(lockPath, 0o600).catch(() => undefined);
      }
      return {
        path: lockPath,
        metadata,
        release: () => releaseClaudeCodeSingleFlightLock(lockPath, metadata.nonce),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      const existing = await readClaudeCodeSingleFlightLock(lockPath);
      if (existing && !isProcessAlive(existing.pid)) {
        await fs.unlink(lockPath).catch((unlinkError: unknown) => {
          if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT") {
            throw unlinkError;
          }
        });
        continue;
      }
      throw new ClaudeCodeSingleFlightLockBusyError(lockPath, existing);
    }
  }

  throw new Error(
    `Claude Code local mode could not acquire the single-flight lock at "${lockPath}" after 2 attempts (likely racing another process cleaning up a stale lock). Retry the run, add --wait-for-lock 30s to wait automatically, or remove the lock manually once you've confirmed no Claude Code run is active: rm "${lockPath}"`,
  );
}

async function readClaudeCodeSingleFlightLock(
  lockPath: string,
): Promise<ClaudeCodeSingleFlightLockMetadata | null> {
  try {
    const raw = await fs.readFile(lockPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<ClaudeCodeSingleFlightLockMetadata>;
    if (
      parsed.schema_version === "claude_code_single_flight_lock.v1" &&
      typeof parsed.session_id === "string" &&
      typeof parsed.pid === "number" &&
      Number.isInteger(parsed.pid) &&
      typeof parsed.nonce === "string" &&
      typeof parsed.created_at === "string"
    ) {
      return parsed as ClaudeCodeSingleFlightLockMetadata;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
  }
  return null;
}

async function releaseClaudeCodeSingleFlightLock(lockPath: string, nonce: string): Promise<void> {
  const current = await readClaudeCodeSingleFlightLock(lockPath);
  if (!current || current.nonce !== nonce) {
    return;
  }
  await fs.unlink(lockPath).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  });
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "EPERM";
  }
}

function formatClaudeCodeLockBusyMessage(
  lockPath: string,
  existing: ClaudeCodeSingleFlightLockMetadata | null,
): string {
  const sessionId = existing?.session_id ?? "unknown";
  return [
    `Claude Code local mode is already running in session ${sessionId}.`,
    "Only one local subscription run is allowed at a time (single-flight lock).",
    `Fix — pick one: wait automatically with --wait-for-lock 5m, inspect the running session with \`oracle session ${sessionId} --render\`, or (only after confirming no Claude Code run is active) remove the stale lock: rm "${lockPath}"`,
  ].join("\n");
}

const CLAUDE_CODE_BLOCKED_TOOL_NAMES = new Set(
  [
    "agent",
    "applypatch",
    "bash",
    "browser",
    "chrome",
    "cron",
    "edit",
    "glob",
    "grep",
    "lsp",
    "ls",
    "mcp",
    "monitor",
    "notebookedit",
    "powershell",
    "read",
    "remotetrigger",
    "skill",
    "task",
    "webfetch",
    "websearch",
    "workflow",
    "write",
  ].map(normalizeClaudeCodePolicyToken),
);

function findClaudeCodeReadOnlyPolicyViolation(
  events: readonly ClaudeCodeNormalizedEvent[],
): ClaudeCodeReadOnlyPolicyViolation | undefined {
  for (const event of events) {
    const json = claudeCodeObject(event.json);
    if (!json) continue;
    const jsonType = claudeCodeStringField(json, "type");
    const jsonSubtype = claudeCodeStringField(json, "subtype");
    if (jsonType === "system" && jsonSubtype === "init") {
      continue;
    }
    const reason = inspectClaudeCodePolicyValue(json, event.type);
    if (reason) {
      return {
        reason,
        eventType: event.type,
        eventSeq: event.seq,
      };
    }
  }
  return undefined;
}

function inspectClaudeCodePolicyValue(
  value: unknown,
  parentEventType: string | undefined,
  depth = 0,
): string | undefined {
  if (depth > 12) return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const reason = inspectClaudeCodePolicyValue(item, parentEventType, depth + 1);
      if (reason) return reason;
    }
    return undefined;
  }
  const obj = claudeCodeObject(value);
  if (!obj) return undefined;

  const type = claudeCodeStringField(obj, "type");
  const normalizedType = normalizeClaudeCodePolicyToken(type);
  const name = firstClaudeCodeStringField(obj, [
    "name",
    "tool",
    "toolName",
    "tool_name",
    "function",
    "functionName",
    "function_name",
  ]);
  const normalizedParent = normalizeClaudeCodePolicyToken(parentEventType);
  const normalizedName = normalizeClaudeCodePolicyToken(name);

  if (isClaudeCodeToolUseType(normalizedType)) {
    return `tool use${name ? ` (${name})` : ""}`;
  }
  if (isClaudeCodePermissionRequestType(normalizedType)) {
    return `permission request${name ? ` (${name})` : ""}`;
  }
  if (isClaudeCodeDisallowedSurfaceType(normalizedType)) {
    return `disallowed event type ${type}`;
  }
  if (normalizedName && isBlockedClaudeCodeToolName(name, normalizedName)) {
    return `blocked tool ${name}`;
  }
  if (normalizedParent && isClaudeCodeToolUseType(normalizedParent) && name && normalizedName) {
    return `tool use (${name})`;
  }
  const permissionMode = firstClaudeCodeStringField(obj, [
    "permissionMode",
    "permission_mode",
    "mode",
  ]);
  const normalizedPermissionMode = normalizeClaudeCodePolicyToken(permissionMode);
  if (normalizedPermissionMode.includes("bypass") || normalizedPermissionMode.includes("danger")) {
    return `dangerous permission mode ${permissionMode}`;
  }

  for (const [key, child] of Object.entries(obj)) {
    if (key === "text" || key === "result" || key === "rawText" || key === "rawBase64") {
      continue;
    }
    const reason = inspectClaudeCodePolicyValue(child, type ?? parentEventType, depth + 1);
    if (reason) return reason;
  }
  return undefined;
}

function isClaudeCodeToolUseType(type: string): boolean {
  return (
    type === "tooluse" ||
    type === "toolcall" ||
    type === "mcp_tool_call" ||
    type.includes("tooluse") ||
    type.includes("toolcall")
  );
}

function isClaudeCodePermissionRequestType(type: string): boolean {
  return type === "permissionrequest" || type.includes("permissionrequest");
}

function isClaudeCodeDisallowedSurfaceType(type: string): boolean {
  return (
    type.includes("hook") ||
    type.includes("subagent") ||
    type === "agent" ||
    type.includes("chrome") ||
    type.includes("browser") ||
    type.includes("cron") ||
    type.includes("workflow") ||
    type.includes("skill")
  );
}

function claudeCodeObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function firstClaudeCodeStringField(
  obj: Record<string, unknown>,
  fields: readonly string[],
): string | undefined {
  for (const field of fields) {
    const value = claudeCodeStringField(obj, field);
    if (value) return value;
  }
  return undefined;
}

function claudeCodeStringField(obj: Record<string, unknown>, field: string): string | undefined {
  const value = obj[field];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function normalizeClaudeCodePolicyToken(value: string | undefined): string {
  return (value ?? "").replace(/[\s_-]+/gu, "").toLowerCase();
}

function isBlockedClaudeCodeToolName(name: string | undefined, normalizedName: string): boolean {
  const rawLower = (name ?? "").trim().toLowerCase();
  return (
    CLAUDE_CODE_BLOCKED_TOOL_NAMES.has(normalizedName) ||
    rawLower.startsWith("mcp__") ||
    normalizedName.startsWith("mcp")
  );
}

function terminateClaudeCodeChild(
  child: ChildProcessWithoutNullStreams,
  signal: NodeJS.Signals,
): void {
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall back to the direct child below; process groups can fail on some platforms.
    }
  }
  child.kill(signal);
}

function redactClaudeCodeArgForLog(arg: string): string {
  if (arg === "") {
    return '""';
  }
  if (
    arg ===
    "You are Oracle's supplied-context reviewer. Answer only from the user-provided prompt and attached context. Do not use tools."
  ) {
    return "<system-prompt>";
  }
  return /\s/.test(arg) ? JSON.stringify(arg) : arg;
}

function redactClaudeCodeArgForAdapter(arg: string): string {
  if (
    arg ===
    "You are Oracle's supplied-context reviewer. Answer only from the user-provided prompt and attached context. Do not use tools."
  ) {
    return "<tiny Oracle-owned supplied-context reviewer prompt>";
  }
  return arg;
}

function writeClaudeCodeVisibleEvents(
  write: (chunk: string) => boolean,
  events: ClaudeCodeNormalizedEvent[],
): void {
  for (const event of events) {
    if (event.stream === "stdout" && event.text) {
      write(event.text);
      continue;
    }
    if (event.stream === "stderr" && event.rawText) {
      write(event.rawText);
    }
  }
}

function extractFinalTextFromEvents(events: ClaudeCodeNormalizedEvent[]): string {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const json = events[index]?.json;
    if (
      json &&
      typeof json === "object" &&
      "result" in json &&
      typeof (json as { result?: unknown }).result === "string"
    ) {
      return (json as { result: string }).result;
    }
  }
  return events
    .filter((event) => event.stream === "stdout" && event.text)
    .map((event) => event.text)
    .join("");
}

function summarizeClaudeCodeProgress(
  events: ClaudeCodeNormalizedEvent[],
  errorMessage: string | undefined,
): string {
  const lines = events
    .filter((event) => event.type || event.text || event.parseError)
    .slice(0, 200)
    .map((event) => {
      const parts = [`#${event.seq}`, event.stream];
      if (event.type) parts.push(event.type);
      if (event.parseError) parts.push(`parse_error=${event.parseError}`);
      if (event.text) parts.push(`text=${event.text.slice(0, 160)}`);
      return parts.join(" ");
    });
  if (errorMessage) {
    lines.push(`error=${errorMessage}`);
  }
  return lines.join("\n");
}

function byteLength(value: Buffer | string | undefined): number {
  if (Buffer.isBuffer(value)) {
    return value.length;
  }
  if (typeof value === "string") {
    return Buffer.byteLength(value, "utf8");
  }
  return 0;
}

function finalizedClaudeCodeError(message: string): ClaudeCodeFinalizedError {
  const error = new Error(message) as ClaudeCodeFinalizedError;
  error[CLAUDE_CODE_SESSION_FINALIZED] = true;
  return error;
}

function isFinalizedClaudeCodeError(error: unknown): error is ClaudeCodeFinalizedError {
  return (
    error instanceof Error &&
    (error as ClaudeCodeFinalizedError)[CLAUDE_CODE_SESSION_FINALIZED] === true
  );
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function providerFailureContextForModel(
  model: string,
  runOptions: RunOracleOptions,
): ProviderFailureContext {
  return {
    model,
    providerMode: runOptions.provider,
    azure: runOptions.azure,
    baseUrl: runOptions.baseUrl,
    apiKey: runOptions.apiKey,
  };
}

function formatMultiModelFailure(
  error: unknown,
  context?: string | ProviderFailureContext,
): string {
  const userError = asOracleUserError(error);
  if (userError) {
    return `${userError.category}, ${userError.message}`;
  }
  const providerFailure = classifyProviderFailure(error, context);
  if (providerFailure) {
    return providerFailure.label;
  }
  if (error instanceof OracleTransportError) {
    return `${error.reason}, ${error.message}`;
  }
  if (error instanceof OracleResponseError) {
    return error.message;
  }
  return formatError(error);
}

function formatMultiModelFailureDetails(
  error: unknown,
  context?: string | ProviderFailureContext,
): string[] {
  const providerFailure = classifyProviderFailure(error, context);
  if (!providerFailure) {
    return [];
  }
  const lines: string[] = [];
  if (providerFailure.keyEnv) {
    lines.push(`  key: ${providerFailure.keyEnv}`);
  }
  lines.push(`  provider said: ${providerFailure.providerMessage}`);
  lines.push(`  fix: ${providerFailure.fix}`);
  return lines;
}

function sanitizeMultiModelFailureForThrow(
  error: unknown,
  context?: string | ProviderFailureContext,
): unknown {
  const providerFailure = classifyProviderFailure(error, context);
  if (!providerFailure) {
    return error;
  }
  const modelPrefix = typeof context === "object" && context?.model ? `${context.model}: ` : "";
  const message = `${modelPrefix}${providerFailure.label}: ${providerFailure.providerMessage}`;
  if (!(error instanceof Error)) {
    return new Error(message);
  }
  let sanitized: Error;
  if (error instanceof OracleTransportError) {
    sanitized = new OracleTransportError(error.reason, message);
  } else if (error instanceof OracleResponseError) {
    sanitized = new OracleResponseError(message, error.response);
  } else {
    sanitized = new Error(message);
    sanitized.name = error.name;
  }
  if (error.stack) {
    const [, ...rest] = error.stack.split("\n");
    sanitized.stack = [sanitized.name ? `${sanitized.name}: ${message}` : message, ...rest].join(
      "\n",
    );
  }
  return sanitized;
}

interface MultiModelManifestRunLog {
  model: string;
  path: string;
}

interface MultiModelOutputManifest {
  version: 1;
  sessionId: string;
  status: "completed" | "partial" | "error";
  outputBasePath: string;
  createdAt: string;
  models: Array<{
    model: string;
    status: string;
    outputPath?: string;
    logPath?: string;
    errorCategory?: string;
    errorMessage?: string;
    elapsedMs?: number;
    usage?: UsageSummary;
  }>;
}

export function deriveOutputManifestPath(basePath: string): string {
  const ext = path.extname(basePath);
  const stem = path.basename(basePath, ext);
  const dir = path.dirname(basePath);
  return path.join(dir, `${stem}.oracle.json`);
}

async function collectMultiModelRunLogs(
  sessionId: string,
  modelRuns: SessionModelRun[] | undefined,
  summary: MultiModelRunSummary,
): Promise<MultiModelManifestRunLog[]> {
  const sessionDir = await resolveSessionDir(sessionId);
  const logsByModel = new Map<string, string>();
  for (const run of modelRuns ?? []) {
    if (run.log?.path) {
      logsByModel.set(run.model, resolveSessionPath(sessionDir, run.log.path));
    }
  }
  for (const entry of summary.fulfilled) {
    if (!logsByModel.has(entry.model)) {
      logsByModel.set(entry.model, entry.logPath);
    }
  }
  return [...logsByModel.entries()].map(([model, logPath]) => ({ model, path: logPath }));
}

async function writeMultiModelOutputManifest({
  baseOutputPath,
  sessionId,
  status,
  summary,
  savedOutputs,
  modelRuns,
  runLogs,
  runOptions,
  log,
}: {
  baseOutputPath: string;
  sessionId: string;
  status: "completed" | "partial" | "error";
  summary: MultiModelRunSummary;
  savedOutputs: Array<{ model: string; path: string }>;
  modelRuns?: SessionModelRun[];
  runLogs: MultiModelManifestRunLog[];
  runOptions: RunOracleOptions;
  log: (message: string) => void;
}): Promise<string | undefined> {
  const manifestPath = deriveOutputManifestPath(baseOutputPath);
  const normalizedTarget = path.resolve(manifestPath);
  const normalizedSessionsDir = path.resolve(sessionStore.sessionsDir());
  if (
    normalizedTarget === normalizedSessionsDir ||
    normalizedTarget.startsWith(`${normalizedSessionsDir}${path.sep}`)
  ) {
    log(
      dim(
        `output manifest skipped: refusing to write inside session storage (${normalizedSessionsDir}).`,
      ),
    );
    return undefined;
  }
  const manifest = buildMultiModelOutputManifest({
    baseOutputPath,
    sessionId,
    status,
    summary,
    savedOutputs,
    modelRuns,
    runLogs,
    runOptions,
  });
  try {
    await fs.mkdir(path.dirname(normalizedTarget), { recursive: true });
    await fs.writeFile(normalizedTarget, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    return normalizedTarget;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    log(dim(`output manifest failed (${reason}); session completed anyway.`));
    return undefined;
  }
}

function buildMultiModelOutputManifest({
  baseOutputPath,
  sessionId,
  status,
  summary,
  savedOutputs,
  modelRuns,
  runLogs,
  runOptions,
}: {
  baseOutputPath: string;
  sessionId: string;
  status: "completed" | "partial" | "error";
  summary: MultiModelRunSummary;
  savedOutputs: Array<{ model: string; path: string }>;
  modelRuns?: SessionModelRun[];
  runLogs: MultiModelManifestRunLog[];
  runOptions: RunOracleOptions;
}): MultiModelOutputManifest {
  const outputByModel = new Map(savedOutputs.map((entry) => [entry.model, entry.path]));
  const logsByModel = new Map(runLogs.map((entry) => [entry.model, entry.path]));
  const runsByModel = new Map((modelRuns ?? []).map((run) => [run.model, run]));
  const fulfilledByModel = new Map(summary.fulfilled.map((entry) => [entry.model, entry]));
  const rejectedByModel = new Map(summary.rejected.map((entry) => [entry.model, entry.reason]));
  const orderedModels = [
    ...summary.fulfilled.map((entry) => entry.model),
    ...summary.rejected.map((entry) => entry.model),
  ];
  return {
    version: 1,
    sessionId,
    status,
    outputBasePath: path.resolve(baseOutputPath),
    createdAt: new Date().toISOString(),
    models: orderedModels.map((model) => {
      const run = runsByModel.get(model);
      const fulfilled = fulfilledByModel.get(model);
      const reason = rejectedByModel.get(model);
      const userError = reason ? asOracleUserError(reason) : undefined;
      const providerFailure = reason
        ? classifyProviderFailure(reason, providerFailureContextForModel(model, runOptions))
        : undefined;
      return {
        model,
        status: fulfilled ? "completed" : reason ? "error" : (run?.status ?? "error"),
        outputPath: outputByModel.get(model),
        logPath: logsByModel.get(model),
        errorCategory: run?.error?.category ?? userError?.category ?? providerFailure?.category,
        errorMessage:
          run?.error?.message ??
          userError?.message ??
          providerFailure?.label ??
          (reason ? formatError(reason) : undefined),
        elapsedMs: calculateModelElapsedMs(run),
        usage: run?.usage ?? fulfilled?.usage,
      };
    }),
  };
}

function calculateModelElapsedMs(run?: SessionModelRun): number | undefined {
  if (!run?.startedAt || !run.completedAt) {
    return undefined;
  }
  const startedMs = Date.parse(run.startedAt);
  const completedMs = Date.parse(run.completedAt);
  if (!Number.isFinite(startedMs) || !Number.isFinite(completedMs) || completedMs < startedMs) {
    return undefined;
  }
  return completedMs - startedMs;
}

async function readSessionForManifest(sessionId: string): Promise<SessionMetadata | null> {
  try {
    return (await sessionStore.readSession(sessionId)) ?? null;
  } catch {
    return null;
  }
}

async function resolveSessionDir(sessionId: string): Promise<string | null> {
  try {
    return (await sessionStore.getPaths(sessionId)).dir;
  } catch {
    return null;
  }
}

function resolveSessionPath(sessionDir: string | null, targetPath: string): string {
  if (path.isAbsolute(targetPath) || !sessionDir) {
    return targetPath;
  }
  return path.join(sessionDir, targetPath);
}

async function writeAssistantOutput(
  targetPath: string | undefined,
  content: string,
  log: (message: string) => void,
) {
  if (!targetPath) return;
  if (!content || content.trim().length === 0) {
    log(dim("write-output skipped: no assistant content to save."));
    return;
  }
  const normalizedTarget = path.resolve(targetPath);
  const normalizedSessionsDir = path.resolve(sessionStore.sessionsDir());
  if (
    normalizedTarget === normalizedSessionsDir ||
    normalizedTarget.startsWith(`${normalizedSessionsDir}${path.sep}`)
  ) {
    log(
      dim(
        `write-output skipped: refusing to write inside session storage (${normalizedSessionsDir}).`,
      ),
    );
    return;
  }
  try {
    await fs.mkdir(path.dirname(normalizedTarget), { recursive: true });
    const payload = content.endsWith("\n") ? content : `${content}\n`;
    await fs.writeFile(normalizedTarget, payload, "utf8");
    log(dim(`Saved assistant output to ${normalizedTarget}`));
    return normalizedTarget;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (isPermissionError(error)) {
      const fallbackPath = buildFallbackPath(normalizedTarget);
      if (fallbackPath) {
        try {
          await fs.mkdir(path.dirname(fallbackPath), { recursive: true });
          const payload = content.endsWith("\n") ? content : `${content}\n`;
          await fs.writeFile(fallbackPath, payload, "utf8");
          log(dim(`write-output fallback to ${fallbackPath} (original failed: ${reason})`));
          return fallbackPath;
        } catch (innerError) {
          const innerReason = innerError instanceof Error ? innerError.message : String(innerError);
          log(
            dim(
              `write-output failed (${reason}); fallback failed (${innerReason}); session completed anyway.`,
            ),
          );
          return;
        }
      }
    }
    log(dim(`write-output failed (${reason}); session completed anyway.`));
  }
}

async function autoReattachUntilComplete({
  sessionMeta,
  runtime,
  browserConfig,
  runOptions,
  modelForStatus,
  notificationSettings,
  log,
}: {
  sessionMeta: SessionMetadata;
  runtime?: BrowserRuntimeMetadata;
  browserConfig?: BrowserSessionConfig;
  runOptions: RunOracleOptions;
  modelForStatus?: string;
  notificationSettings: NotificationSettings;
  log: (message?: string) => void;
}): Promise<boolean> {
  if (!runtime || !browserConfig) {
    log(dim("Auto-reattach disabled: missing runtime or browser config."));
    return false;
  }
  const delayMs = Math.max(0, browserConfig.autoReattachDelayMs ?? 0);
  const intervalMs = Math.max(0, browserConfig.autoReattachIntervalMs ?? 0);
  if (intervalMs <= 0) {
    return false;
  }
  const timeoutMs =
    Math.max(0, browserConfig.autoReattachTimeoutMs ?? 0) ||
    Math.max(0, browserConfig.timeoutMs ?? 0) ||
    120_000;
  const maxTotalMs = 2 * 60 * 60 * 1000; // 2h hard cap; avoid infinite polling by default.
  const maxDeadline = Date.now() + maxTotalMs;

  if (delayMs > 0) {
    log(dim(`Auto-reattach starting in ${formatElapsed(delayMs)}...`));
    await wait(delayMs);
  }
  log(dim(`Auto-reattach will stop after ${formatElapsed(maxTotalMs)} if no answer is captured.`));

  const logger: BrowserLogger = ((message?: string) => {
    if (message) {
      log(dim(message));
    }
  }) as BrowserLogger;
  logger.verbose = true;

  let attempt = 0;
  for (;;) {
    const remainingBudgetMs = maxDeadline - Date.now();
    if (remainingBudgetMs <= 0) {
      log(
        dim(
          `Auto-reattach stopped after ${formatElapsed(maxTotalMs)} without capturing an answer.`,
        ),
      );
      return false;
    }
    attempt += 1;
    log(dim(`Auto-reattach attempt ${attempt}...`));
    try {
      const reattachConfig: BrowserSessionConfig = {
        ...browserConfig,
        timeoutMs,
      };
      const result = await resumeBrowserSession(runtime, reattachConfig, logger, {
        promptPreview: sessionMeta.promptPreview,
      });
      const answerText = result.answerMarkdown || result.answerText || "";
      const outputTokens = estimateTokenCount(answerText);
      const artifacts = await ensureSessionArtifacts({
        sessionId: sessionMeta.id,
        prompt: runOptions.prompt,
        answerMarkdown: answerText,
        conversationUrl: runtime.tabUrl,
        browserConfig,
        existingArtifacts: sessionMeta.artifacts,
        logger,
      });
      const logWriter = sessionStore.createLogWriter(sessionMeta.id);
      logWriter.logLine(`[auto-reattach] captured assistant response on attempt ${attempt}`);
      logWriter.logLine("Answer:");
      logWriter.logLine(answerText);
      logWriter.stream.end();
      if (modelForStatus) {
        await sessionStore.updateModelRun(sessionMeta.id, modelForStatus, {
          status: "completed",
          completedAt: new Date().toISOString(),
          usage: {
            inputTokens: 0,
            outputTokens,
            reasoningTokens: 0,
            totalTokens: outputTokens,
          },
        });
      }
      await sessionStore.updateSession(sessionMeta.id, {
        status: "completed",
        completedAt: new Date().toISOString(),
        usage: {
          inputTokens: 0,
          outputTokens,
          reasoningTokens: 0,
          totalTokens: outputTokens,
        },
        errorMessage: undefined,
        browser: {
          config: browserConfig,
          runtime,
        },
        artifacts: mergeArtifacts(sessionMeta.artifacts, artifacts),
        response: { status: "completed" },
        error: undefined,
        transport: undefined,
      });
      await writeAssistantOutput(runOptions.writeOutputPath, answerText, log);
      await sendSessionNotification(
        {
          sessionId: sessionMeta.id,
          sessionName: sessionMeta.options?.slug ?? sessionMeta.id,
          mode: sessionMeta.mode ?? "browser",
          model: sessionMeta.model ?? runOptions.model,
          usage: {
            inputTokens: 0,
            outputTokens,
          },
          characters: answerText.length,
        },
        notificationSettings,
        log,
        answerText.slice(0, 140),
      );
      log(kleur.green("Auto-reattach succeeded; session marked completed."));
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(dim(`Auto-reattach attempt ${attempt} failed: ${message}`));
    }
    const remainingAfterAttemptMs = maxDeadline - Date.now();
    if (remainingAfterAttemptMs <= 0) {
      log(
        dim(
          `Auto-reattach stopped after ${formatElapsed(maxTotalMs)} without capturing an answer.`,
        ),
      );
      return false;
    }
    await wait(Math.min(intervalMs, remainingAfterAttemptMs));
  }
}

export function deriveModelOutputPath(
  basePath: string | undefined,
  model: string,
): string | undefined {
  if (!basePath) return undefined;
  const ext = path.extname(basePath);
  const stem = path.basename(basePath, ext);
  const dir = path.dirname(basePath);
  const suffix = ext.length > 0 ? `${stem}.${model}${ext}` : `${stem}.${model}`;
  return path.join(dir, suffix);
}

function isPermissionError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: string }).code;
  return code === "EACCES" || code === "EPERM";
}

function buildFallbackPath(original: string): string | null {
  const ext = path.extname(original);
  const stem = path.basename(original, ext);
  const dir = getCwd();
  const candidate = ext ? `${stem}.fallback${ext}` : `${stem}.fallback`;
  const fallback = path.join(dir, candidate);
  const normalizedSessionsDir = path.resolve(sessionStore.sessionsDir());
  const normalizedFallback = path.resolve(fallback);
  if (
    normalizedFallback === normalizedSessionsDir ||
    normalizedFallback.startsWith(`${normalizedSessionsDir}${path.sep}`)
  ) {
    return null;
  }
  return fallback;
}

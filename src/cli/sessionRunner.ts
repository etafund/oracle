import kleur from "kleur";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Writable } from "node:stream";
import { finished } from "node:stream/promises";
import type {
  SessionMetadata,
  SessionMode,
  BrowserSessionConfig,
  BrowserRuntimeMetadata,
  BrowserModelSelectionEvidence,
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
import {
  appendArtifacts,
  saveBrowserTranscriptArtifact,
  saveDeepResearchReportArtifact,
} from "../browser/artifacts.js";
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
import { extractConversationIdFromUrl } from "../browser/conversationIdentity.js";
import { estimateTokenCount } from "../browser/utils.js";
import type { BrowserLogger } from "../browser/types.js";
import type { BrowserRunResult } from "../browserMode.js";
import {
  getRemoteBrowserFailedRouteFromError,
  getRemoteBrowserRecoveryFromError,
  RemoteRunFailedError,
  type RemoteBrowserFailedRoute,
  type RemoteBrowserRecoveryCarrier,
} from "../remote/client.js";
import {
  deleteRemoteBrowserRecoverySecret,
  toPublicRemoteRecoveryMetadata,
  writeRemoteBrowserRecoverySecret,
} from "../remote/sessionRecoveryStore.js";
import {
  claimRemoteBrowserRecoveryCompletion,
  isFailedRemoteBrowserOrigin,
  isRemoteBrowserRecoveryCompletionPersisted,
  ownsRemoteBrowserRecoveryCompletion,
  recoverStoredRemoteBrowserSession,
  releaseRemoteBrowserRecoveryCompletion,
  RemoteBrowserRecoveryUnavailableError,
} from "../remote/sessionRecovery.js";
import { formatElapsed } from "../oracle/format.js";
import { formatBrowserReattachGuidance } from "./reattachGuidance.js";
import { getOracleHomeDir } from "../oracleHome.js";
import { buildClaudeCodeCommand, type ClaudeCodeCommand } from "../claude-code/command.js";
import { prepareClaudeCodeEnvironment } from "../claude-code/envGuard.js";
import { resolveClaudeExecutable } from "../claude-code/executableResolver.js";
import { assertClaudeCodeLocalOwner } from "../claude-code/localOwnerGuard.js";
import {
  buildCaamShallowSpawnCommand,
  resolveClaudeCodeCaamBase,
  resolveClaudeCodeCaamProfile,
  validateCaamProfileName,
} from "../claude-code/caamCommand.js";
import { resolveCaamExecutable, type ResolvedCaamExecutable } from "../claude-code/caamResolver.js";
import { runCaamShallowProfileDoctor } from "../claude-code/caamDoctor.js";
import {
  runCaamCooldownSet,
  runCaamRobotNext,
  resolveClaudeCodeMaxRateLimitRotations,
} from "../claude-code/caamRotation.js";
import { matchClaudeCodeRateLimitOrChallengeText } from "../claude-code/rateLimitPatterns.js";
import {
  ClaudeCodePlanProtocolError,
  ClaudeCodeStreamNormalizer,
  extractAuthoritativeFinalText,
  type ClaudeCodeNormalizedEvent,
} from "../claude-code/streamParser.js";
import type { ResolvedClaudeExecutable } from "../claude-code/executableResolver.js";
import { verifyClaudeCodeRun } from "../claude-code/startupVerifier.js";
import {
  assertClaudeCodeInlineBudget,
  resolveClaudeCodeMaxInlineBytes,
} from "../claude-code/inlineBudget.js";
import {
  buildStreamJsonUserMessage,
  isStreamJsonInputEnabled,
  serializeStreamJsonMessage,
} from "../claude-code/streamJsonInput.js";

const isTty = process.stdout.isTTY;
const dim = (text: string): string => (isTty ? kleur.dim(text) : text);
const CLAUDE_CODE_SESSION_FINALIZED = Symbol("claudeCodeSessionFinalized");

async function endRecoveryLogStream(stream: { end: () => void }): Promise<void> {
  const completion =
    typeof (stream as Partial<Writable>).once === "function" ? finished(stream as Writable) : null;
  stream.end();
  await completion;
}

type ClaudeCodeFinalizedError = Error & {
  [CLAUDE_CODE_SESSION_FINALIZED]?: true;
};

interface RemoteBrowserFailurePersistenceDeps {
  updateSession?: typeof sessionStore.updateSession;
  writeSecret?: typeof writeRemoteBrowserRecoverySecret;
  deleteSecret?: typeof deleteRemoteBrowserRecoverySecret;
}

export class RemoteBrowserFailureSupersededError extends Error {
  constructor(
    message: string,
    readonly browser: SessionMetadata["browser"],
  ) {
    super(message);
    this.name = "RemoteBrowserFailureSupersededError";
  }
}

function failedRemoteRouteMatches(
  metadata: SessionMetadata,
  expected: RemoteBrowserFailedRoute,
): boolean {
  const actual = metadata.browser?.remoteRun;
  return (
    actual?.terminalDoneOk === false &&
    actual.runId === expected.runId &&
    actual.accountId === expected.accountId &&
    (actual.laneId ?? null) === (expected.laneId ?? null)
  );
}

/**
 * Publish failed-route evidence before touching the private sidecar. A crash
 * after that first metadata commit therefore remains fail-closed. The public
 * executable coordinate is added only by CAS against the same failed route;
 * an orphaned/stale sidecar is compare-deleted on an ordinary CAS loss.
 */
export async function persistRemoteBrowserFailureRecoveryState(
  input: {
    sessionId: string;
    browser: SessionMetadata["browser"];
    failedRoute: RemoteBrowserFailedRoute;
    recoveryCarrier?: RemoteBrowserRecoveryCarrier | null;
  },
  deps: RemoteBrowserFailurePersistenceDeps = {},
): Promise<SessionMetadata["browser"]> {
  const updateSession = deps.updateSession ?? sessionStore.updateSession.bind(sessionStore);
  const writeSecret = deps.writeSecret ?? writeRemoteBrowserRecoverySecret;
  const deleteSecret = deps.deleteSecret ?? deleteRemoteBrowserRecoverySecret;
  let browser: SessionMetadata["browser"] = {
    ...input.browser,
    remoteRun: input.failedRoute,
  };

  let routeMarked = false;
  const marked = await updateSession(input.sessionId, (current) => {
    routeMarked = false;
    const currentRun = current.browser?.remoteRun;
    const currentCoordinate = current.browser?.remoteRecovery;
    const sameFailedRoute = failedRemoteRouteMatches(current, input.failedRoute);
    if (
      current.status === "completed" ||
      currentRun?.terminalDoneOk === true ||
      current.browser?.remoteRecoveryCompletionClaim ||
      (currentRun && !sameFailedRoute) ||
      (currentCoordinate && currentCoordinate.originRunId !== input.failedRoute.runId)
    ) {
      return {};
    }
    routeMarked = true;
    return {
      browser: {
        ...input.browser,
        ...current.browser,
        remoteRun: input.failedRoute,
      },
    };
  });
  browser = marked?.browser ?? browser;

  // A terminal/newer generation or active completion owner won the CAS.
  // Refuse to touch any sidecar and return its fresh browser state.
  if (!routeMarked) {
    throw new RemoteBrowserFailureSupersededError(
      "A terminal/newer browser generation or active recovery writer superseded this failed run.",
      browser,
    );
  }

  if (!input.recoveryCarrier) return browser;
  await writeSecret(input.sessionId, input.recoveryCarrier);
  const coordinate = toPublicRemoteRecoveryMetadata(input.recoveryCarrier);
  let published = false;
  const publishedMetadata = await updateSession(input.sessionId, (current) => {
    // The updater may be retried on a fresher metadata generation.
    published = false;
    if (
      !failedRemoteRouteMatches(current, input.failedRoute) ||
      current.browser?.remoteRecoveryCompletionClaim
    ) {
      return {};
    }
    published = true;
    return {
      browser: {
        ...current.browser,
        remoteRecovery: coordinate,
      },
    };
  });
  if (!published) {
    const freshBrowser = publishedMetadata?.browser ?? browser;
    const sameOriginStillNeedsSidecar =
      freshBrowser?.remoteRecovery?.originRunId === input.failedRoute.runId ||
      freshBrowser?.remoteRecoveryCompletionClaim?.originRunId === input.failedRoute.runId;
    if (!sameOriginStillNeedsSidecar) {
      await deleteSecret(input.sessionId, input.failedRoute.runId).catch(() => false);
    }
    throw new RemoteBrowserFailureSupersededError(
      "A newer browser generation or active recovery writer won while the public coordinate was being published.",
      freshBrowser,
    );
  }
  return publishedMetadata?.browser ?? { ...browser, remoteRecovery: coordinate };
}

async function persistRemoteRecoveryArtifacts(input: {
  sessionId: string;
  prompt: string;
  answerMarkdown: string;
  conversationUrl?: string;
  browserConfig: BrowserSessionConfig;
  existingArtifacts?: SessionArtifact[];
  logger: BrowserLogger;
}): Promise<SessionArtifact[]> {
  let artifacts = input.existingArtifacts;
  if (input.browserConfig.researchMode === "deep") {
    const report = await saveDeepResearchReportArtifact({
      sessionId: input.sessionId,
      reportMarkdown: input.answerMarkdown,
      conversationUrl: input.conversationUrl,
      logger: input.logger,
    }).catch(() => null);
    artifacts = appendArtifacts(artifacts, [report]);
  }
  // Unlike the ordinary helper, recovery must always write a fresh transcript
  // for this claim. An older transcript may describe the failed capture and
  // is not durable evidence for the newly recovered answer.
  const transcript = await saveBrowserTranscriptArtifact({
    sessionId: input.sessionId,
    prompt: input.prompt,
    answerMarkdown: input.answerMarkdown,
    conversationUrl: input.conversationUrl,
    artifacts,
    logger: input.logger,
  });
  if (!transcript) {
    throw new Error("Remote recovery produced no durable transcript artifact; refusing commit.");
  }
  return appendArtifacts(artifacts, [transcript]) ?? [transcript];
}

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
  /** Narrow injection seam for deterministic recovery-race tests. */
  remoteFailureDeps?: {
    getFailedRoute?: typeof getRemoteBrowserFailedRouteFromError;
    getRecovery?: typeof getRemoteBrowserRecoveryFromError;
    persistState?: typeof persistRemoteBrowserFailureRecoveryState;
  };
  /** Narrow injection seam for submitted-session recovery race tests. */
  remoteRecoveryDeps?: {
    claim?: typeof claimRemoteBrowserRecoveryCompletion;
    recoverStored?: typeof recoverStoredRemoteBrowserSession;
    release?: typeof releaseRemoteBrowserRecoveryCompletion;
    deleteSecret?: typeof deleteRemoteBrowserRecoverySecret;
    persistArtifacts?: typeof persistRemoteRecoveryArtifacts;
  };
  muteStdout?: boolean;
  claudeCodeRunner?: ClaudeCodeSessionRunner;
}

export interface ClaudeCodeRunnerInput {
  sessionId: string;
  prompt: string;
  /**
   * Stream-json content-block transport (bead oracle-router-8fa). When set,
   * this pre-serialized single-line NDJSON user message is written to
   * `claude`'s stdin verbatim (one line + `.end()`) instead of the flat
   * `prompt` string, and the command builder pairs it with
   * `--input-format stream-json`. Absent = the historical flat-text stdin
   * path, byte-for-byte.
   */
  streamJsonInput?: string;
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
  /** Exact CAAM shallow-profile base paired with `caamProfileUsed`. */
  caamBaseUsed?: string;
  /** `true` when this run kept `--no-session-persistence` (one-shot, default). */
  sessionPersistenceDisabled?: boolean;
  /**
   * caam rate-limit rotation record (caam-ratelimit-rotation-design.md
   * §3.2), populated only when caam shallow-spawn was active for the
   * original attempt. Absent entirely for caam-absent runs — a rate limit
   * there surfaces exactly as it did before rotation existed.
   */
  rateLimitRotation?: {
    attempts: ClaudeCodeRotationAttemptRecord[];
    rotationsUsed: number;
    exhausted: boolean;
  };
  /** Set when any attempt hit a challenge/auth signal — always a HARD-HALT. */
  challengeDetected?: { profile?: string; reason: string };
}

export interface ClaudeCodeRotationAttemptRecord {
  profile?: string;
  outcome: "rate_limited" | "challenge" | "success" | "error";
  matched_pattern?: string;
  started_at?: string;
  elapsed_ms?: number;
  exit_code?: number | null;
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
  remoteFailureDeps,
  remoteRecoveryDeps,
  muteStdout = false,
  claudeCodeRunner = runLocalClaudeCodeSession,
}: SessionRunParams): Promise<void> {
  const writeInline = (chunk: string): boolean => {
    // Keep session logs intact while still echoing inline output to the user.
    write(chunk);
    return muteStdout ? true : process.stdout.write(chunk);
  };
  let startRefused = false;
  const startedSession = await sessionStore.updateSession(sessionMeta.id, (current) => {
    // A session runner may have been spawned from an older metadata snapshot.
    // Merge the freshest browser state and never reopen a terminal remote run
    // or trample an in-flight recovery completion claim.
    startRefused = false;
    if (
      mode === "browser" &&
      (current.browser?.remoteRecoveryCompletionClaim ||
        current.browser?.remoteRun?.terminalDoneOk === true)
    ) {
      startRefused = true;
      return {};
    }
    return {
      status: "running",
      startedAt: new Date().toISOString(),
      mode,
      ...(browserConfig
        ? {
            browser: {
              ...sessionMeta.browser,
              ...current.browser,
              config: browserConfig,
            },
          }
        : {}),
    };
  });
  if (startRefused) {
    throw new RemoteBrowserRecoveryUnavailableError(
      `Session ${sessionMeta.id} already has a terminal remote result or an active recovery completion writer; refusing a stale runner start.`,
    );
  }
  sessionMeta = startedSession ?? sessionMeta;
  let currentBrowser: SessionMetadata["browser"] = browserConfig
    ? { ...sessionMeta.browser, config: browserConfig }
    : sessionMeta.browser;
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
      // Stream-json content-block transport (bead oracle-router-8fa),
      // default OFF. Flag on: images/PDFs are base64-encoded into media
      // blocks (rather than rejected) and the whole turn rides a single
      // NDJSON user message on stdin. Flag off: today's exact flat-text path.
      const streamJsonEnabled = isStreamJsonInputEnabled(process.env);
      const files = await readFiles(runOptions.file ?? [], {
        cwd,
        maxFileSizeBytes: runOptions.maxFileSizeBytes,
        // claude-provider-map.md finding #1: never silently force-decode a
        // binary attachment as UTF-8 garbage for this lane. The stream-json
        // lane additionally base64-encodes image/PDF instead of rejecting
        // them (encode-media), keeping all other binary rejected.
        binaryFileHandling: streamJsonEnabled ? "encode-media" : "reject",
      });
      const basePrompt = runOptions.prompt ?? "";
      // The payload whose ENCODED byte length the budget must reflect: the
      // serialized NDJSON line on the stream-json path (base64 media + JSON
      // envelope included), or the flat combined prompt on the text path.
      let streamJsonInput: string | undefined;
      let promptWithFiles: string;
      if (streamJsonEnabled) {
        const userMessage = buildStreamJsonUserMessage(basePrompt, files, cwd);
        streamJsonInput = serializeStreamJsonMessage(userMessage);
        promptWithFiles = basePrompt;
      } else {
        promptWithFiles = buildPrompt(basePrompt, files, cwd);
      }
      // Aggregate pre-spawn budget check (finding #1, concrete gap #2) —
      // must run before any of the claude-code-specific spawn machinery
      // (single-flight lock, executable resolution, `spawn()`) so an
      // oversized attachment bundle fails fast with an actionable error
      // instead of silently producing an arbitrarily large stdin write.
      assertClaudeCodeInlineBudget(
        streamJsonInput ?? promptWithFiles,
        runOptions.claudeCode?.maxInlineBytes,
      );
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
        streamJsonInput,
        model: modelForStatus ?? "fable",
        cwd,
        runOptions,
        artifactPaths,
        log,
        // Structured/JSON callers need one authoritative final answer, not
        // the concatenation of delta + assistant snapshot + result layers.
        // The normalized artifact still preserves every raw event.
        write: muteStdout ? () => true : writeInline,
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
      if (answerText) {
        if (muteStdout) {
          // Feed JSON/structured collectors only the authoritative final
          // representation selected above. Do not add display newlines.
          write(answerText);
        } else {
          // Claude's stream can contain more than one text block (for
          // example, an intermediate draft followed by the final answer).
          // Emit only the authoritative terminal representation once.
          const printable =
            runOptions.renderPlain === true ? answerText : renderMarkdownAnsi(answerText);
          writeInline(printable.endsWith("\n") ? printable : `${printable}\n`);
        }
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
          deps: remoteRecoveryDeps,
        })
      ) {
        return;
      }
      const runnerDeps = {
        ...browserDeps,
        persistRuntimeHint: async (
          runtime: BrowserRuntimeMetadata,
          modelSelection?: BrowserModelSelectionEvidence,
        ) => {
          const browser = {
            ...currentBrowser,
            config: browserConfig,
            runtime,
            ...(modelSelection ? { modelSelection } : {}),
          };
          await sessionStore.updateSession(sessionMeta.id, {
            status: "running",
            browser,
          });
          // Keep this attempt's copy fresh so error paths fall back to the
          // latest persisted browser evidence instead of stale session input.
          currentBrowser = browser;
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
          remoteRun: result.remoteRun,
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
    markErrorLogged(error);
    if (isFinalizedClaudeCodeError(error)) {
      throw error;
    }
    const userError = asOracleUserError(error);
    const remoteRecoveryCarrier = (
      remoteFailureDeps?.getRecovery ?? getRemoteBrowserRecoveryFromError
    )(error);
    const failedRemoteRoute =
      (remoteFailureDeps?.getFailedRoute ?? getRemoteBrowserFailedRouteFromError)(error) ??
      (remoteRecoveryCarrier
        ? {
            runId: remoteRecoveryCarrier.recovery.originRunId,
            accountId: remoteRecoveryCarrier.accountId,
            laneId: remoteRecoveryCarrier.laneId,
            terminalDoneOk: false as const,
            provenance: null,
          }
        : null);
    const deferredFailureLogs: string[] = [];
    let failureLogsFlushed = false;
    const failureLog = (entry?: string): void => {
      if (!entry) return;
      if (failedRemoteRoute && !failureLogsFlushed) {
        deferredFailureLogs.push(entry);
        return;
      }
      log(entry);
    };
    const flushFailureLogs = (): void => {
      if (!failedRemoteRoute || failureLogsFlushed) return;
      failureLogsFlushed = true;
      log(`ERROR: ${message}`);
      for (const entry of deferredFailureLogs) log(entry);
      deferredFailureLogs.length = 0;
    };
    if (!failedRemoteRoute) log(`ERROR: ${message}`);
    if (mode === "browser" && failedRemoteRoute) {
      currentBrowser = { ...currentBrowser, remoteRun: failedRemoteRoute };
      try {
        currentBrowser = await (
          remoteFailureDeps?.persistState ?? persistRemoteBrowserFailureRecoveryState
        )({
          sessionId: sessionMeta.id,
          browser: currentBrowser,
          failedRoute: failedRemoteRoute,
          recoveryCarrier: remoteRecoveryCarrier,
        });
      } catch (storeError) {
        if (storeError instanceof RemoteBrowserFailureSupersededError) {
          return;
        }
        // The helper commits the nonsecret failed-route marker before touching
        // the sidecar. Even an interruption here therefore remains fail-closed.
        const reason = storeError instanceof Error ? storeError.message : String(storeError);
        failureLog(
          dim(
            `Could not store private remote recovery capability (${reason}); preserving remote route and refusing automatic/local recovery.`,
          ),
        );
        const existingCoordinate = currentBrowser?.remoteRecovery;
        if (existingCoordinate?.originRunId === failedRemoteRoute.runId) {
          currentBrowser = { ...currentBrowser, remoteRun: failedRemoteRoute };
        } else {
          const { remoteRecovery: _remoteRecovery, ...withoutExecutableCoordinate } =
            currentBrowser ?? {};
          currentBrowser = {
            ...withoutExecutableCoordinate,
            remoteRun: failedRemoteRoute,
          };
        }
      }
    }
    const connectionLost =
      userError?.category === "browser-automation" &&
      (userError.details as { stage?: string } | undefined)?.stage === "connection-lost";
    const assistantTimeout =
      userError?.category === "browser-automation" &&
      (userError.details as { stage?: string } | undefined)?.stage === "assistant-timeout";
    const cloudflareChallenge =
      userError?.category === "browser-automation" &&
      (userError.details as { stage?: string } | undefined)?.stage === "cloudflare-challenge";
    const persistFailureSession = async (updates: Partial<SessionMetadata>): Promise<boolean> => {
      if (!failedRemoteRoute) {
        await sessionStore.updateSession(sessionMeta.id, updates);
        return true;
      }
      let applied = false;
      await sessionStore.updateSession(sessionMeta.id, (current) => {
        // The updater may retry; the last invocation owns the verdict.
        applied = false;
        if (
          current.status === "completed" ||
          current.browser?.remoteRun?.terminalDoneOk === true ||
          current.browser?.remoteRecoveryCompletionClaim ||
          !failedRemoteRouteMatches(current, failedRemoteRoute)
        ) {
          return {};
        }
        applied = true;
        return {
          ...updates,
          ...(updates.browser
            ? {
                browser: {
                  ...current.browser,
                  ...updates.browser,
                  remoteRun: failedRemoteRoute,
                },
              }
            : {}),
        };
      });
      return applied;
    };
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
      failureLog(formatBrowserReattachGuidance(sessionMeta.id));
    };
    if (connectionLost && mode === "browser" && browserCanReattach) {
      const runtime = (userError.details as { runtime?: BrowserRuntimeMetadata } | undefined)
        ?.runtime;
      const recoverableRuntime = runtime ?? currentBrowser?.runtime;
      if (
        !hasRecoverableChatGptConversation(recoverableRuntime) &&
        recoverableRuntime?.promptSubmitted !== true
      ) {
        failureLog(
          dim(
            "Chrome disconnected before a ChatGPT conversation was created; marking session error.",
          ),
        );
        if (modelForStatus && !failedRemoteRoute) {
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
        const failureApplied = await persistFailureSession({
          status: "error",
          completedAt: new Date().toISOString(),
          errorMessage: message,
          mode,
          browser: {
            ...currentBrowser,
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
        if (!failureApplied) return;
        logBrowserReattachGuidance();
        flushFailureLogs();
        throw error;
      }
      failureLog(
        dim("Chrome disconnected before completion; keeping session running for reattach."),
      );
      if (modelForStatus && !failedRemoteRoute) {
        await sessionStore.updateModelRun(sessionMeta.id, modelForStatus, {
          status: "running",
          completedAt: undefined,
        });
      }
      const failureApplied = await persistFailureSession({
        status: "running",
        errorMessage: message,
        mode,
        browser: {
          ...currentBrowser,
          config: browserConfig,
          runtime: runtime ?? currentBrowser?.runtime,
        },
        response: { status: "running", incompleteReason: "chrome-disconnected" },
      });
      if (!failureApplied) return;
      logBrowserReattachGuidance(runtime ?? sessionMeta.browser?.runtime);
      flushFailureLogs();
      return;
    }
    if (assistantTimeout && mode === "browser" && browserCanReattach) {
      const runtime = (userError.details as { runtime?: BrowserRuntimeMetadata } | undefined)
        ?.runtime;
      failureLog(dim("Assistant response timed out; marking capture incomplete for reattach."));
      if (modelForStatus && !failedRemoteRoute) {
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
      const failureApplied = await persistFailureSession({
        status: "error",
        completedAt: new Date().toISOString(),
        errorMessage: message,
        mode,
        browser: {
          ...currentBrowser,
          config: browserConfig,
          runtime: runtime ?? currentBrowser?.runtime,
        },
        response: { status: "incomplete", incompleteReason: "incomplete-capture" },
        error: {
          category: userError.category,
          message: userError.message,
          details: userError.details,
        },
      });
      if (!failureApplied) return;
      flushFailureLogs();
      const autoReattachIntervalMs = browserConfig?.autoReattachIntervalMs ?? 0;
      if (autoReattachIntervalMs > 0) {
        const autoRuntime = runtime ?? currentBrowser?.runtime;
        const success = await autoReattachUntilComplete({
          sessionMeta,
          runtime: autoRuntime ?? undefined,
          browserConfig,
          browserMetadata: currentBrowser,
          runOptions,
          modelForStatus,
          notificationSettings,
          log,
        });
        if (success) {
          return;
        }
      }
      logBrowserReattachGuidance(runtime ?? currentBrowser?.runtime);
      return;
    }
    if (cloudflareChallenge && mode === "browser") {
      const details = userError.details as { reuseProfileHint?: string } | undefined;
      if (browserCanReattach) {
        failureLog(
          dim("Cloudflare challenge detected; browser left running so you can complete the check."),
        );
        if (details?.reuseProfileHint) {
          failureLog(dim(`Reuse this browser profile with: ${details.reuseProfileHint}`));
        }
      } else {
        failureLog(dim("Cloudflare challenge detected; copied profile closed and removed."));
      }
    }
    if (userError) {
      failureLog(dim(`User error (${userError.category}): ${userError.message}`));
    }
    const responseMetadata = error instanceof OracleResponseError ? error.metadata : undefined;
    const metadataLine = formatResponseMetadata(responseMetadata);
    if (metadataLine) {
      failureLog(dim(`Response metadata: ${metadataLine}`));
    }
    const transportMetadata =
      error instanceof OracleTransportError ? { reason: error.reason } : undefined;
    const transportLine = formatTransportMetadata(transportMetadata);
    if (transportLine) {
      failureLog(dim(`Transport: ${transportLine}`));
    }
    const browserRuntime =
      mode === "browser" && browserCanReattach
        ? (userError?.details as { runtime?: BrowserRuntimeMetadata } | undefined)?.runtime
        : undefined;
    if (!cloudflareChallenge && browserCanReattach) {
      logBrowserReattachGuidance(browserRuntime ?? currentBrowser?.runtime);
    }
    const failureApplied = await persistFailureSession({
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
            ...currentBrowser,
            config: browserConfig,
            runtime: browserRuntime ?? currentBrowser?.runtime,
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
    if (!failureApplied) return;
    flushFailureLogs();
    if (modelForStatus && !failedRemoteRoute) {
      await sessionStore.updateModelRun(sessionMeta.id, modelForStatus, {
        status: "error",
        completedAt: new Date().toISOString(),
      });
    }
    throw error;
  }
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
    conversationId: extractConversationIdFromUrl(recoveryUrl) ?? runtime.conversationId,
  };
}

async function recoverSubmittedBrowserSessionBeforeFreshRun({
  sessionMeta,
  browserConfig,
  runOptions,
  modelForStatus,
  notificationSettings,
  log,
  deps,
}: {
  sessionMeta: SessionMetadata;
  browserConfig: BrowserSessionConfig;
  runOptions: RunOracleOptions;
  modelForStatus?: string;
  notificationSettings: NotificationSettings;
  log: (message?: string) => void;
  deps?: SessionRunParams["remoteRecoveryDeps"];
}): Promise<boolean> {
  const remoteOrigin = isFailedRemoteBrowserOrigin(sessionMeta);
  const coordinateRuntime = sessionMeta.browser?.remoteRecovery?.runtime;
  const runtime =
    buildSubmittedRecoveryRuntime(sessionMeta) ??
    (coordinateRuntime
      ? {
          ...coordinateRuntime,
          promptSubmitted: true as const,
        }
      : null);
  if (!runtime && !remoteOrigin) {
    return false;
  }

  const nextAction = `oracle session ${sessionMeta.id} --render`;
  const hasRemoteRecovery = Boolean(sessionMeta.browser?.remoteRecovery);
  if (remoteOrigin && !hasRemoteRecovery) {
    throw new BrowserAutomationError(
      `Stored session ${sessionMeta.id} belongs to a failed remote browser route, but no executable private recovery capability is available. Refusing a fresh or local browser run. Open the conversation in the originating ChatGPT account's history.`,
      {
        stage: "submitted-session-recovery",
        ...(runtime ? { runtime } : {}),
        retryable: false,
        nextAction,
        remoteRun: sessionMeta.browser?.remoteRun,
      },
    );
  }
  if (!runtime) {
    throw new BrowserAutomationError(
      `Stored session ${sessionMeta.id} belongs to a failed remote browser route but has no safe conversation coordinate. Refusing a fresh or local browser run. Open the originating ChatGPT account's history.`,
      {
        stage: "submitted-session-recovery",
        retryable: false,
        nextAction,
        remoteRun: sessionMeta.browser?.remoteRun,
      },
    );
  }
  const canAttemptRecovery =
    hasRemoteRecovery ||
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
  const attemptedOriginRunId = sessionMeta.browser?.remoteRecovery?.originRunId;
  let completionClaim: Awaited<ReturnType<typeof claimRemoteBrowserRecoveryCompletion>> = null;
  let recoveryCommitted = false;

  try {
    if (hasRemoteRecovery) {
      completionClaim = await (deps?.claim ?? claimRemoteBrowserRecoveryCompletion)(
        sessionMeta.id,
        attemptedOriginRunId,
      );
      if (!completionClaim) {
        throw new RemoteBrowserRecoveryUnavailableError(
          "A newer remote recovery attempt or another completion writer owns this session; refusing a stale recovery dispatch.",
        );
      }
    }
    const result = hasRemoteRecovery
      ? await (deps?.recoverStored ?? recoverStoredRemoteBrowserSession)(sessionMeta, {
          log,
          completionClaim: completionClaim!,
        })
      : await resumeBrowserSession(runtime, browserConfig, logger, {
          promptPreview: sessionMeta.promptPreview,
        });
    const remoteResult = hasRemoteRecovery ? (result as BrowserRunResult) : undefined;
    const recoveredTabUrl = remoteResult?.tabUrl;
    const recoveredConversationId = remoteResult?.conversationId;
    const recoveredRemoteRun = remoteResult?.remoteRun;
    const answerText = result.answerMarkdown || result.answerText || "";
    const outputTokens = estimateTokenCount(answerText);
    const artifacts = hasRemoteRecovery
      ? await (deps?.persistArtifacts ?? persistRemoteRecoveryArtifacts)({
          sessionId: sessionMeta.id,
          prompt: runOptions.prompt,
          answerMarkdown: answerText,
          conversationUrl: recoveredTabUrl ?? runtime.tabUrl,
          browserConfig,
          existingArtifacts: sessionMeta.artifacts,
          logger,
        })
      : await ensureSessionArtifacts({
          sessionId: sessionMeta.id,
          prompt: runOptions.prompt,
          answerMarkdown: answerText,
          conversationUrl: recoveredTabUrl ?? runtime.tabUrl,
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
    await endRecoveryLogStream(logWriter.stream);
    const usage = {
      inputTokens: 0,
      outputTokens,
      reasoningTokens: 0,
      totalTokens: outputTokens,
    };
    let completionApplied = !completionClaim;
    try {
      await sessionStore.updateSession(sessionMeta.id, (current) => {
        completionApplied = false;
        if (completionClaim && !ownsRemoteBrowserRecoveryCompletion(current, completionClaim)) {
          return {};
        }
        const {
          remoteRecovery: _remoteRecovery,
          remoteRecoveryCompletionClaim: _completionClaim,
          ...freshBrowser
        } = current.browser ?? sessionMeta.browser ?? {};
        completionApplied = true;
        return {
          status: "completed",
          completedAt: new Date().toISOString(),
          usage,
          errorMessage: undefined,
          browser: {
            ...freshBrowser,
            config: browserConfig,
            runtime: {
              ...runtime,
              tabUrl: recoveredTabUrl ?? runtime.tabUrl,
              conversationId: recoveredConversationId ?? runtime.conversationId,
              promptSubmitted: true,
            },
            remoteRun: recoveredRemoteRun,
          },
          artifacts: mergeArtifacts(current.artifacts ?? sessionMeta.artifacts, artifacts),
          response: { status: "completed" },
          error: undefined,
          transport: undefined,
        };
      });
      if (!completionApplied) {
        throw new RemoteBrowserRecoveryUnavailableError(
          "Recovery completion ownership changed before finalization; refusing a stale success commit.",
        );
      }
      recoveryCommitted = Boolean(completionClaim);
    } catch (error) {
      const persisted = completionClaim
        ? await sessionStore.readSession(sessionMeta.id).catch(() => null)
        : null;
      if (
        !completionClaim ||
        !isRemoteBrowserRecoveryCompletionPersisted(persisted, recoveredRemoteRun, artifacts)
      ) {
        throw error;
      }
      recoveryCommitted = true;
    }
    if (modelForStatus && !hasRemoteRecovery) {
      await sessionStore.updateModelRun(sessionMeta.id, modelForStatus, {
        status: "completed",
        completedAt: new Date().toISOString(),
        usage,
      });
    }
    if (hasRemoteRecovery) {
      try {
        await (deps?.deleteSecret ?? deleteRemoteBrowserRecoverySecret)(
          sessionMeta.id,
          attemptedOriginRunId,
        );
      } catch (error) {
        try {
          log(
            dim(
              `Recovered session metadata was committed, but private recovery cleanup failed (${error instanceof Error ? error.message : String(error)}).`,
            ),
          );
        } catch {}
      }
      await writeAssistantOutput(runOptions.writeOutputPath, answerText, log).catch((error) => {
        try {
          log(
            dim(
              `Recovered session is committed; output-file write failed (${error instanceof Error ? error.message : String(error)}).`,
            ),
          );
        } catch {}
      });
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
      ).catch(() => undefined);
      try {
        log(kleur.green("Submitted-session recovery succeeded; session marked completed."));
      } catch {}
      return true;
    }
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
    if (recoveryCommitted) {
      if (completionClaim) {
        await (deps?.deleteSecret ?? deleteRemoteBrowserRecoverySecret)(
          sessionMeta.id,
          attemptedOriginRunId,
        ).catch(() => false);
      }
      const message = error instanceof Error ? error.message : String(error);
      log(
        dim(
          `Submitted-session recovery was already committed; ignoring post-commit output/notification failure (${message}).`,
        ),
      );
      return true;
    }
    if (completionClaim && !recoveryCommitted) {
      await (deps?.release ?? releaseRemoteBrowserRecoveryCompletion)(
        sessionMeta.id,
        completionClaim,
      ).catch(() => undefined);
    }
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
    // Emit `--input-format stream-json` exactly when this run will write an
    // NDJSON user message on stdin (bead oracle-router-8fa). Coupling the
    // argv to the presence of the serialized payload — rather than re-reading
    // the env flag here — keeps the transport and the flag that selected it
    // from ever diverging within a single run.
    streamJsonInput: input.streamJsonInput != null,
  });

  // Opt-in `caam shallow-spawn` integration (caam-map.md §4). Activates ONLY
  // when a profile is configured. Account identity is a billing boundary, so
  // an explicit profile is fail-closed: CAAM resolution or preflight failure
  // aborts instead of falling back to an unpinned direct `claude` process.
  const caamProfileRequested = resolveClaudeCodeCaamProfile(
    input.runOptions.claudeCode?.caamProfile,
    process.env,
  );
  const caamBaseResolution = caamProfileRequested
    ? resolveClaudeCodeCaamBase(input.runOptions.claudeCode?.caamBase, process.env)
    : undefined;
  const initialCaam = caamProfileRequested
    ? await activateCaamShallowSpawn(caamProfileRequested, caamBaseResolution!.base, command, input)
    : undefined;

  // caam rate-limit rotation (caam-ratelimit-rotation-design.md): gated
  // ENTIRELY on the original attempt's caam activation having succeeded —
  // a caam-absent run (no profile configured) is untouched: the loop below
  // still runs exactly once and a rate limit surfaces exactly as it did
  // before this feature existed (§3.3).
  const rotationEnabled = Boolean(initialCaam);
  const maxRotations = rotationEnabled
    ? resolveClaudeCodeMaxRateLimitRotations(
        input.runOptions.claudeCode?.maxRateLimitRotations,
        process.env,
        { lane: input.runOptions.lane },
      )
    : 0;

  // In-process guard (design §2.2 step 5): belt-and-suspenders against
  // `robot next` re-offering a profile whose cooldown write (best-effort)
  // silently failed or hasn't taken effect yet.
  const attemptedCaamProfiles = new Set<string>();
  if (initialCaam) {
    attemptedCaamProfiles.add(initialCaam.profile);
  }

  const rotationAttempts: ClaudeCodeRotationAttemptRecord[] = [];
  let activeCaam = initialCaam;
  let rotationsUsed = 0;
  let exhausted = false;
  let attemptOutcome: ClaudeCodeAttemptOutcome | undefined;

  while (true) {
    const spawnCommand = activeCaam?.command ?? command;
    const waitForLockMs = resolveClaudeCodeWaitForLockMs(
      input.runOptions.claudeCode?.waitForLockMs,
    );
    if (waitForLockMs > 0) {
      input.log(
        dim(`Claude Code single-flight lock: waiting up to ${formatElapsed(waitForLockMs)}.`),
      );
    }
    const singleFlightLock = await acquireClaudeCodeSingleFlightLock(input.sessionId, {
      waitForLockMs,
      // Keying the lock on the caam profile (instead of the fixed global
      // filename) is what lets distinct profiles run in parallel while same
      // -profile sessions still serialize (caam-map.md §4b). No profile
      // active -> unchanged global lock.
      lockKey: activeCaam?.profile,
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
      attemptOutcome = await runClaudeCodeChildAttempt({
        input,
        startedAt,
        executable,
        activeCaam,
        spawnCommand,
        claudeSessionId,
        resumeSessionId,
        preparedEnv,
        ownerResult,
        singleFlightLock,
        waitForLockMs,
      });
    } finally {
      // Released the INSTANT this attempt is done — not held for the
      // duration of the whole retry sequence — so a competing session
      // waiting on this exact profile is unblocked immediately, and so the
      // caam cooldown/robot-next shell-outs below never run while holding
      // this profile's lock (design §2.2 step 3).
      await singleFlightLock.release().catch((error: unknown) => {
        input.log(dim(`Claude Code lock release warning: ${formatError(error)}`));
      });
    }

    const { result, signal } = attemptOutcome;
    const attemptProfile = activeCaam?.profile;

    if (rotationEnabled) {
      rotationAttempts.push({
        profile: attemptProfile,
        outcome: !signal
          ? result.errorMessage
            ? "error"
            : "success"
          : signal.kind === "challenge"
            ? "challenge"
            : "rate_limited",
        matched_pattern: signal?.matchedPattern,
        elapsed_ms: result.elapsedMs,
        exit_code: result.exitCode ?? null,
      });
    }

    if (!signal || signal.kind === "challenge") {
      // Success, an unrelated failure, or a challenge/auth HARD-HALT — none
      // of these ever rotate (challenge detection already refused to run
      // cooldown/next machinery inside `runClaudeCodeChildAttempt`).
      break;
    }
    // signal.kind === "rate_limit"
    if (!rotationEnabled || !activeCaam) {
      // caam not active for this run: surface unchanged, no rotation.
      break;
    }
    if (rotationsUsed >= maxRotations) {
      exhausted = true;
      break;
    }

    // Best-effort cooldown write (design §2.2 step 4) — NON-FATAL: a
    // failure here is logged and rotation proceeds to `robot next`
    // regardless.
    try {
      await runCaamCooldownSet(
        activeCaam.executable.path,
        "claude",
        activeCaam.profile,
        60,
        `oracle session ${input.sessionId}: rate_limit pattern '${signal.matchedPattern}'`,
        { env: process.env },
      );
    } catch (error) {
      input.log(
        dim(
          `Claude Code caam cooldown set warning (non-fatal, rotation proceeds): ${formatError(error)}`,
        ),
      );
    }

    let nextProfile: string | undefined;
    try {
      const next = await runCaamRobotNext(activeCaam.executable.path, "claude", {
        strategy: "smart",
        env: process.env,
      });
      if (!next.success) {
        // NO_PROFILES / ALL_BLOCKED / anything else -> exhaustion, not a
        // crash. Surface the ORIGINAL rate-limit failure, not a
        // caam-tooling error (design §2.2 step 6).
        input.log(
          dim(
            `Claude Code caam robot next reported ${next.code}: ${next.message}. Rotation exhausted; surfacing the rate-limit failure.`,
          ),
        );
        exhausted = true;
        break;
      }
      if (attemptedCaamProfiles.has(next.profile)) {
        // The in-process guard firing: `robot next` re-offered a profile
        // already tried this run (a cooldown-write race). Treat identically
        // to exhaustion rather than looping forever.
        input.log(
          dim(
            `Claude Code caam robot next re-offered already-attempted profile "${next.profile}"; treating as rotation exhaustion.`,
          ),
        );
        exhausted = true;
        break;
      }
      nextProfile = next.profile;
    } catch (error) {
      input.log(
        dim(
          `Claude Code caam robot next failed: ${formatError(error)}. Rotation exhausted; surfacing the rate-limit failure.`,
        ),
      );
      exhausted = true;
      break;
    }

    // Re-run the existing doctor pre-flight against the candidate profile by
    // simply re-invoking `activateCaamShallowSpawn` with the original base (design
    // §2.2 step 7). A doctor failure on the candidate is treated as
    // exhaustion here (not a silent fall back to direct-`claude`, which
    // would defeat the purpose of rotating in the first place).
    let nextActivation: ClaudeCodeCaamActivation;
    try {
      nextActivation = await activateCaamShallowSpawn(nextProfile, activeCaam.base, command, input);
    } catch (error) {
      input.log(
        dim(
          `Claude Code caam shallow-spawn doctor failed for rotated profile "${nextProfile}": ${formatError(error)}. Rotation exhausted.`,
        ),
      );
      exhausted = true;
      break;
    }

    attemptedCaamProfiles.add(nextProfile);
    activeCaam = nextActivation;
    rotationsUsed += 1;
  }

  // The loop above always runs at least once (there is no `continue`/early
  // return that skips the attempt), so `attemptOutcome` is always defined
  // here; the check just keeps the compiler (and any future refactor) honest.
  if (!attemptOutcome) {
    throw new Error("Claude Code local mode attempt loop exited without an outcome.");
  }

  const { result } = attemptOutcome;
  return {
    ...result,
    rateLimitRotation: rotationEnabled
      ? { attempts: rotationAttempts, rotationsUsed, exhausted }
      : undefined,
    adapterMetadata: {
      ...result.adapterMetadata,
      ...(rotationEnabled
        ? {
            rotation: {
              attempts: rotationAttempts,
              final_profile: activeCaam?.profile ?? null,
              rotations_used: rotationsUsed,
              cap: maxRotations,
              exhausted,
            },
          }
        : {}),
    },
  };
}

interface ClaudeCodeAttemptOutcome {
  result: ClaudeCodeRunnerResult;
  signal?: ClaudeCodeRateLimitOrChallengeSignal;
}

interface ClaudeCodeChildAttemptParams {
  input: ClaudeCodeRunnerInput;
  startedAt: number;
  executable: ResolvedClaudeExecutable;
  activeCaam: ClaudeCodeCaamActivation | undefined;
  spawnCommand: ClaudeCodeCommand;
  claudeSessionId: string;
  resumeSessionId: string | undefined;
  preparedEnv: ReturnType<typeof prepareClaudeCodeEnvironment>;
  ownerResult: Awaited<ReturnType<typeof assertClaudeCodeLocalOwner>>;
  singleFlightLock: ClaudeCodeSingleFlightLock;
  waitForLockMs: number;
}

/**
 * Spawns and waits on exactly ONE `claude` (or `caam shallow-spawn`-wrapped
 * `claude`) child process, and builds the full `ClaudeCodeRunnerResult` for
 * that single attempt — this is the body that used to be
 * `runLocalClaudeCodeSession` itself before rate-limit rotation made it a
 * per-attempt operation invoked from a bounded retry loop
 * (caam-ratelimit-rotation-design.md §2.2).
 */
async function runClaudeCodeChildAttempt({
  input,
  startedAt,
  executable,
  activeCaam,
  spawnCommand,
  claudeSessionId,
  resumeSessionId,
  preparedEnv,
  ownerResult,
  singleFlightLock,
  waitForLockMs,
}: ClaudeCodeChildAttemptParams): Promise<ClaudeCodeAttemptOutcome> {
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
  // Only ever acted on (early-terminate the child, override the terminal
  // error message) when THIS attempt's caam profile is active — a
  // caam-absent run still runs this detector (cheap, useful for future
  // observability), but a rate limit there surfaces exactly as it did
  // before this feature existed, through the unchanged generic exit-code
  // fallback (design §3.3, §4.2 case 3).
  let rateLimitOrChallenge: ClaudeCodeRateLimitOrChallengeSignal | undefined;
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
  if (activeCaam) {
    // Same TOCTOU re-check, mirrored for the caam executable — it is
    // about to `exec` into a repointed `$HOME`, so it gets the same
    // "re-verify the resolved real path immediately before spawn"
    // treatment as `claude` above.
    await resolveCaamExecutable({
      executable: activeCaam.executable.path,
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
  const stopForRateLimitOrChallenge = (normalized: ClaudeCodeNormalizedEvent[]) => {
    if (rateLimitOrChallenge) return;
    const signal = findClaudeCodeRateLimitOrChallengeSignal(normalized);
    if (!signal) return;
    rateLimitOrChallenge = signal;
    if (!activeCaam) return;
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
    stopForRateLimitOrChallenge(normalized);
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
    stopForRateLimitOrChallenge(normalized);
  });

  const exit = await new Promise<{ exitCode: number | null; signal: string | null }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("close", (exitCode, signal) => resolve({ exitCode, signal }));
      child.stdin.once("error", reject);
      // Stream-json path (bead oracle-router-8fa): write the single
      // pre-serialized NDJSON user message line, then close — `-p` reads
      // NDJSON until EOF, so one line + `.end()` is exactly one user turn.
      // Flag off: the flat prompt string over stdin, byte-for-byte as before.
      child.stdin.end(input.streamJsonInput ?? input.prompt);
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
    stopForRateLimitOrChallenge(finalEvents);
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
  // Rate-limit/challenge only ever changes the terminal error message when
  // THIS attempt's caam profile is active — see `rateLimitOrChallenge`'s
  // doc comment above.
  const rateLimitOrChallengeError =
    rateLimitOrChallenge && activeCaam
      ? rateLimitOrChallenge.kind === "challenge"
        ? `Claude Code local mode stopped because the visible event stream showed an account challenge/auth signal: ${rateLimitOrChallenge.reason}. This is a HARD-HALT — no automatic rotation was attempted. Raw events were saved in ${input.artifactPaths.normalizedEventsPath}.`
        : `Claude Code local mode stopped because the visible event stream showed a rate-limit signal: ${rateLimitOrChallenge.reason}. Raw events were saved in ${input.artifactPaths.normalizedEventsPath}.`
      : undefined;
  const normalizedEventsNdjson = events.map((event) => JSON.stringify(event)).join("\n");
  let finalAnswer = "";
  let planProtocolError: string | undefined;
  try {
    finalAnswer = extractAuthoritativeFinalText(events);
  } catch (error) {
    if (!(error instanceof ClaudeCodePlanProtocolError)) {
      throw error;
    }
    planProtocolError =
      `Claude Code local mode stopped because ${error.message} ` +
      `Raw events were saved in ${input.artifactPaths.normalizedEventsPath}.`;
  }
  const errorMessage =
    policyViolationError ??
    outputFloodError ??
    abortError ??
    rateLimitOrChallengeError ??
    verificationError ??
    exitError ??
    planProtocolError;

  const result: ClaudeCodeRunnerResult = {
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
    caamProfileUsed: activeCaam?.profile,
    caamBaseUsed: activeCaam?.base,
    sessionPersistenceDisabled: !resumeSessionId,
    challengeDetected:
      rateLimitOrChallenge && activeCaam && rateLimitOrChallenge.kind === "challenge"
        ? { profile: activeCaam.profile, reason: rateLimitOrChallenge.reason }
        : undefined,
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
      caam: activeCaam
        ? {
            active: true,
            profile: activeCaam.profile,
            base: activeCaam.base,
            executable: activeCaam.executable.path,
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

  return {
    result,
    // Only surfaced to the rotation loop when THIS attempt's caam profile
    // was active — the loop itself is a no-op (breaks immediately) for a
    // caam-absent run regardless, but keeping this gate here too means the
    // detector's presence never leaks into control flow for that case.
    signal: activeCaam ? rateLimitOrChallenge : undefined,
  };
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

type ClaudeCodeSessionMetadataWithCaamIdentity = ClaudeCodeSessionMetadata & {
  /** Exact base is part of CAAM identity: profile names are only unique within a base. */
  caam_base?: string;
};

function buildClaudeCodeSessionMetadata({
  result,
  artifactPaths,
  model,
}: {
  result: ClaudeCodeRunnerResult;
  artifactPaths: ClaudeCodeArtifactPaths;
  model: string;
}): ClaudeCodeSessionMetadataWithCaamIdentity {
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
    caam_base: result.caamBaseUsed,
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
    rate_limit_rotation: result.rateLimitRotation
      ? {
          attempts: result.rateLimitRotation.attempts.map((attempt) => ({
            profile: attempt.profile,
            outcome: attempt.outcome,
            matched_pattern: attempt.matched_pattern,
            started_at: attempt.started_at,
            elapsed_ms: attempt.elapsed_ms,
            exit_code: attempt.exit_code,
          })),
          rotations_used: result.rateLimitRotation.rotationsUsed,
          exhausted: result.rateLimitRotation.exhausted,
        }
      : undefined,
    challenge_detected: result.challengeDetected,
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
  const events: ClaudeCodeNormalizedEvent[] = [];
  for (const line of ndjson.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed && typeof parsed === "object") {
        events.push(parsed as ClaudeCodeNormalizedEvent);
      }
    } catch {
      // Normalized parse failures are preserved in artifacts; extraction is best effort.
    }
  }
  return extractAuthoritativeFinalText(events);
}

interface ClaudeCodeCaamActivation {
  command: ClaudeCodeCommand;
  profile: string;
  base: string;
  executable: ResolvedCaamExecutable;
}

/**
 * caam-map.md §4: resolve `caam`, run its read-only pre-flight
 * (`caam shallow-spawn <profile> --print-env`, see caamDoctor.ts), and build
 * the `caam shallow-spawn` outer command. This helper is called only after a
 * user selected a CAAM profile; failures deliberately propagate so Oracle
 * cannot charge or consume a different Claude account by accident.
 */
async function activateCaamShallowSpawn(
  profile: string,
  base: string,
  innerCommand: ClaudeCodeCommand,
  input: ClaudeCodeRunnerInput,
): Promise<ClaudeCodeCaamActivation> {
  // An explicitly selected account is a security/billing boundary. Validate
  // and preflight it before launch, and deliberately let any failure abort
  // the run instead of silently falling back to whichever account plain
  // `claude` happens to use.
  const validatedProfile = validateCaamProfileName(profile);
  const caamExecutable = await resolveCaamExecutable({
    repoRoot: input.cwd,
    env: process.env,
  });
  await runCaamShallowProfileDoctor(caamExecutable.path, validatedProfile, base, {
    env: process.env,
  });
  const command = buildCaamShallowSpawnCommand({
    caamExecutable: caamExecutable.path,
    profile: validatedProfile,
    base,
    inner: innerCommand,
  });
  input.log(
    dim(
      `Claude Code CAAM account pinned: profile "${validatedProfile}" under ${base} via ${caamExecutable.path}.`,
    ),
  );
  return { command, profile: validatedProfile, base, executable: caamExecutable };
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

/** One live-or-stale Claude Code single-flight lock file (finding agent-workflow-gaps#4). */
export interface ClaudeCodeSingleFlightLockHolder {
  lock_path: string;
  session_id: string;
  holder_pid: number;
  /**
   * `process.kill(pid, 0)` liveness. A dead pid is a *stale* lock left by a
   * crashed run, not a busy lane — `busy` below only counts live holders.
   */
  pid_alive: boolean;
  /** Age derived from the lock's `created_at`, or null when it can't be parsed. */
  held_for_ms: number | null;
  /** caam shallow-spawn profile this lock is keyed on, if any (caam-map.md §4b). */
  caam_profile?: string;
}

export interface ClaudeCodeSingleFlightLockPeek {
  /** True iff at least one single-flight lock is currently held by a live process. */
  busy: boolean;
  /** Every parseable single-flight lock file found, live or stale, sorted by path. */
  holders: ClaudeCodeSingleFlightLockHolder[];
}

/**
 * Read-only, side-effect-free peek at the Claude Code single-flight lock(s)
 * (finding agent-workflow-gaps#4). Reports whether the `fable-local` lane is
 * busy — the same lock `acquireClaudeCodeSingleFlightLock` competes for —
 * WITHOUT acquiring, creating, or reaping anything. Scans every
 * `claude-code-subscription*.lock` in the locks dir so a caam profile-keyed
 * lock (caam-map.md §4b) and a lock held by a foreign process mid-cleanup are
 * both visible to an agent checking capacity before it submits.
 */
export async function peekClaudeCodeSingleFlightLocks(
  options: { now?: () => number } = {},
): Promise<ClaudeCodeSingleFlightLockPeek> {
  const now = options.now?.() ?? Date.now();
  const locksDir = path.join(getOracleHomeDir(), "locks");
  let entries: string[];
  try {
    entries = await fs.readdir(locksDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { busy: false, holders: [] };
    }
    throw error;
  }
  const lockFiles = entries
    .filter(
      (name) =>
        name === "claude-code-subscription.lock" ||
        (name.startsWith("claude-code-subscription-") && name.endsWith(".lock")),
    )
    .sort();
  const holders: ClaudeCodeSingleFlightLockHolder[] = [];
  for (const name of lockFiles) {
    const lockPath = path.join(locksDir, name);
    const metadata = await readClaudeCodeSingleFlightLock(lockPath);
    if (!metadata) {
      continue;
    }
    const createdMs = Date.parse(metadata.created_at);
    holders.push({
      lock_path: lockPath,
      session_id: metadata.session_id,
      holder_pid: metadata.pid,
      pid_alive: isProcessAlive(metadata.pid),
      held_for_ms: Number.isFinite(createdMs) ? Math.max(0, now - createdMs) : null,
      ...(metadata.caam_profile ? { caam_profile: metadata.caam_profile } : {}),
    });
  }
  return { busy: holders.some((holder) => holder.pid_alive), holders };
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

interface ClaudeCodeRateLimitOrChallengeSignal {
  kind: "challenge" | "rate_limit";
  reason: string;
  matchedPattern: string;
  eventType?: string;
  eventSeq?: number;
}

/**
 * Sibling to `findClaudeCodeReadOnlyPolicyViolation` (caam-ratelimit-
 * rotation-design.md §1.3): scans for a Claude-side rate-limit or
 * challenge/auth signal, ported from caam's own shipped text-pattern
 * detector.
 *
 * (oracle-router-n0t, HIGH-severity fix) The scan surface is deliberately
 * restricted to CLI/system-level error signals — it must NEVER scan the
 * model's own free-form output. The original version scanned
 * `extractVisibleText`'s output (and the raw JSON line text, which contains
 * the same string) unconditionally: that is the assistant's final answer,
 * streamed delta text, or message content, so a HEALTHY session whose
 * *task* is about rate-limiting/auth/quotas (e.g. "write a rate limiter
 * that returns 429", "explain OAuth unauthorized errors") matched the exact
 * same generic word patterns as a real rate limit and got SIGTERM'd,
 * cooled down, or hard-halted for a false "account challenge".
 *
 * Eligible candidates per event, in order:
 *  (a) `event.rawText` for a raw stderr chunk (`event.stream === "stderr"`)
 *      — the CLI process's own stderr stream, never model output, so it is
 *      always eligible.
 *  (b) a stdout event's extracted text plus its full JSON, but ONLY when
 *      that event's JSON is itself an explicit CLI-reported error:
 *      `is_error === true` (whatever the event `type`), or a `result` event
 *      whose `subtype` is anything other than `"success"` (the CLI's real
 *      error subtypes, e.g. `error_during_execution`, `error_max_turns`).
 *      A *successful* result event's `.result` text is the model's final
 *      answer and is NEVER a candidate, no matter what words it contains.
 * Assistant `message`/`stream_event` delta content is never a candidate —
 * it carries no error flag of its own, and is excluded outright regardless.
 *
 * Precedence, ported from caam's `penalty.go` (`isAuthError` before
 * `isRateLimitError`): challenge/auth is checked first, within EACH
 * candidate string, before moving to the next event. An ambiguous event
 * that matches both never rotates — it hard-halts.
 */
function findClaudeCodeRateLimitOrChallengeSignal(
  events: readonly ClaudeCodeNormalizedEvent[],
): ClaudeCodeRateLimitOrChallengeSignal | undefined {
  for (const event of events) {
    const candidates = collectClaudeCodeErrorSignalCandidates(event);
    for (const candidate of candidates) {
      const match = matchClaudeCodeRateLimitOrChallengeText(candidate);
      if (match) {
        return {
          kind: match.kind,
          reason: match.matchedText,
          matchedPattern: match.pattern,
          eventType: event.type,
          eventSeq: event.seq,
        };
      }
    }
  }
  return undefined;
}

/**
 * Scan-surface gate for `findClaudeCodeRateLimitOrChallengeSignal`
 * (oracle-router-n0t): builds the list of strings actually eligible for
 * rate-limit/challenge pattern matching for one normalized event. See the
 * doc comment above for exactly which events qualify and why.
 */
function collectClaudeCodeErrorSignalCandidates(event: ClaudeCodeNormalizedEvent): string[] {
  if (event.stream === "stderr") {
    return event.rawText ? [event.rawText] : [];
  }
  const json = claudeCodeObject(event.json);
  if (!json || !isClaudeCodeErrorSignalJson(json)) {
    return [];
  }
  const candidates: string[] = [];
  if (event.text) {
    candidates.push(event.text);
  }
  candidates.push(JSON.stringify(json));
  return candidates;
}

/**
 * True only for a stdout event's JSON that is itself an explicit CLI
 * -reported error — `is_error === true`, or a `result` event whose
 * `subtype` is anything other than `"success"`. A successful `result`
 * event (`is_error` false/absent, `subtype: "success"`, or no subtype at
 * all) is never an error signal here, even though its `.result` string is
 * exactly what `extractVisibleText` surfaces as `event.text`.
 */
function isClaudeCodeErrorSignalJson(json: Record<string, unknown>): boolean {
  if (json.is_error === true) {
    return true;
  }
  const type = claudeCodeStringField(json, "type");
  const subtype = claudeCodeStringField(json, "subtype");
  return type === "result" && subtype !== undefined && subtype !== "success";
}

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
    // Preserve every stdout layer in artifacts, but do not display deltas:
    // real Fable streams can contain an intermediate text block followed by
    // the final block, plus assistant/result snapshots of that final block.
    // The caller emits extractAuthoritativeFinalText() exactly once.
    if (event.stream === "stderr" && event.rawText) {
      write(event.rawText);
    }
  }
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
  browserMetadata,
  runOptions,
  modelForStatus,
  notificationSettings,
  log,
}: {
  sessionMeta: SessionMetadata;
  runtime?: BrowserRuntimeMetadata;
  browserConfig?: BrowserSessionConfig;
  browserMetadata?: SessionMetadata["browser"];
  runOptions: RunOracleOptions;
  modelForStatus?: string;
  notificationSettings: NotificationSettings;
  log: (message?: string) => void;
}): Promise<boolean> {
  const remoteMetadata = { ...sessionMeta, browser: browserMetadata };
  const remoteOrigin = isFailedRemoteBrowserOrigin(remoteMetadata);
  const hasRemoteRecovery = Boolean(browserMetadata?.remoteRecovery);
  const attemptedOriginRunId = browserMetadata?.remoteRecovery?.originRunId;
  if (remoteOrigin && !hasRemoteRecovery) {
    log(
      dim(
        "Auto-reattach stopped: this is a failed remote browser route without an executable private recovery capability. Open the originating ChatGPT account's history; local recovery is refused.",
      ),
    );
    return false;
  }
  if ((!runtime && !remoteOrigin) || !browserConfig) {
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
    let completionClaim: Awaited<ReturnType<typeof claimRemoteBrowserRecoveryCompletion>> = null;
    let recoveryCommitted = false;
    try {
      const attemptTimeoutMs = Math.max(1, Math.min(timeoutMs, remainingBudgetMs));
      const reattachConfig: BrowserSessionConfig = {
        ...browserConfig,
        timeoutMs: attemptTimeoutMs,
      };
      const attemptAbort = hasRemoteRecovery ? new AbortController() : null;
      const attemptTimer = attemptAbort
        ? setTimeout(() => attemptAbort.abort(), attemptTimeoutMs)
        : null;
      let result;
      try {
        if (hasRemoteRecovery) {
          completionClaim = await claimRemoteBrowserRecoveryCompletion(
            sessionMeta.id,
            attemptedOriginRunId,
          );
          if (!completionClaim) {
            throw new RemoteBrowserRecoveryUnavailableError(
              "A newer remote recovery attempt or another completion writer owns this session; refusing a stale recovery dispatch.",
            );
          }
        }
        result = hasRemoteRecovery
          ? await recoverStoredRemoteBrowserSession(remoteMetadata, {
              log,
              signal: attemptAbort?.signal,
              browserConfig: reattachConfig,
              completionClaim: completionClaim!,
            })
          : await resumeBrowserSession(runtime!, reattachConfig, logger, {
              promptPreview: sessionMeta.promptPreview,
            });
      } finally {
        if (attemptTimer) clearTimeout(attemptTimer);
      }
      const remoteResult = hasRemoteRecovery ? (result as BrowserRunResult) : undefined;
      const recoveredTabUrl = remoteResult?.tabUrl;
      const recoveredConversationId = remoteResult?.conversationId;
      const recoveredRemoteRun = remoteResult?.remoteRun;
      const answerText = result.answerMarkdown || result.answerText || "";
      const outputTokens = estimateTokenCount(answerText);
      const artifacts = hasRemoteRecovery
        ? await persistRemoteRecoveryArtifacts({
            sessionId: sessionMeta.id,
            prompt: runOptions.prompt,
            answerMarkdown: answerText,
            conversationUrl: recoveredTabUrl ?? runtime?.tabUrl,
            browserConfig,
            existingArtifacts: sessionMeta.artifacts,
            logger,
          })
        : await ensureSessionArtifacts({
            sessionId: sessionMeta.id,
            prompt: runOptions.prompt,
            answerMarkdown: answerText,
            conversationUrl: recoveredTabUrl ?? runtime?.tabUrl,
            browserConfig,
            existingArtifacts: sessionMeta.artifacts,
            logger,
          });
      const logWriter = sessionStore.createLogWriter(sessionMeta.id);
      logWriter.logLine(`[auto-reattach] captured assistant response on attempt ${attempt}`);
      logWriter.logLine("Answer:");
      logWriter.logLine(answerText);
      await endRecoveryLogStream(logWriter.stream);
      let completionApplied = !completionClaim;
      try {
        await sessionStore.updateSession(sessionMeta.id, (current) => {
          completionApplied = false;
          if (completionClaim && !ownsRemoteBrowserRecoveryCompletion(current, completionClaim)) {
            return {};
          }
          const {
            remoteRecovery: _remoteRecovery,
            remoteRecoveryCompletionClaim: _completionClaim,
            ...completedBrowserMetadata
          } = current.browser ?? browserMetadata ?? {};
          completionApplied = true;
          return {
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
              ...completedBrowserMetadata,
              config: browserConfig,
              runtime: {
                ...runtime,
                tabUrl: recoveredTabUrl ?? runtime?.tabUrl,
                conversationId: recoveredConversationId ?? runtime?.conversationId,
                promptSubmitted: true,
              },
              remoteRun: recoveredRemoteRun,
            },
            artifacts: mergeArtifacts(current.artifacts ?? sessionMeta.artifacts, artifacts),
            response: { status: "completed" },
            error: undefined,
            transport: undefined,
          };
        });
        if (!completionApplied) {
          throw new RemoteBrowserRecoveryUnavailableError(
            "Recovery completion ownership changed before finalization; refusing a stale success commit.",
          );
        }
        recoveryCommitted = Boolean(completionClaim);
      } catch (error) {
        const persisted = completionClaim
          ? await sessionStore.readSession(sessionMeta.id).catch(() => null)
          : null;
        if (
          !completionClaim ||
          !isRemoteBrowserRecoveryCompletionPersisted(persisted, recoveredRemoteRun, artifacts)
        ) {
          throw error;
        }
        recoveryCommitted = true;
      }
      if (modelForStatus && !hasRemoteRecovery) {
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
      if (hasRemoteRecovery) {
        try {
          await deleteRemoteBrowserRecoverySecret(sessionMeta.id, attemptedOriginRunId);
        } catch (error) {
          try {
            log(
              dim(
                `Recovered session metadata was committed, but private recovery cleanup failed (${error instanceof Error ? error.message : String(error)}).`,
              ),
            );
          } catch {}
        }
        await writeAssistantOutput(runOptions.writeOutputPath, answerText, log).catch((error) => {
          try {
            log(
              dim(
                `Recovered session is committed; output-file write failed (${error instanceof Error ? error.message : String(error)}).`,
              ),
            );
          } catch {}
        });
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
        ).catch(() => undefined);
        try {
          log(kleur.green("Auto-reattach succeeded; session marked completed."));
        } catch {}
        return true;
      }
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
      if (recoveryCommitted) {
        if (completionClaim) {
          await deleteRemoteBrowserRecoverySecret(sessionMeta.id, attemptedOriginRunId).catch(
            () => false,
          );
        }
        const message = error instanceof Error ? error.message : String(error);
        log(
          dim(
            `Auto-reattach recovery was already committed; ignoring post-commit output/notification failure (${message}).`,
          ),
        );
        return true;
      }
      if (completionClaim && !recoveryCommitted) {
        await releaseRemoteBrowserRecoveryCompletion(sessionMeta.id, completionClaim).catch(
          () => undefined,
        );
      }
      const message = error instanceof Error ? error.message : String(error);
      log(dim(`Auto-reattach attempt ${attempt} failed: ${message}`));
      if (error instanceof RemoteBrowserRecoveryUnavailableError) {
        log(
          dim(
            "Auto-reattach stopped because the account-bound recovery capability is no longer executable.",
          ),
        );
        return false;
      }
      if (
        hasRemoteRecovery &&
        (!(error instanceof RemoteRunFailedError) || error.retryable !== true)
      ) {
        log(
          dim(
            "Auto-reattach stopped after a non-retryable remote recovery failure; the originating-account marker is preserved.",
          ),
        );
        return false;
      }
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

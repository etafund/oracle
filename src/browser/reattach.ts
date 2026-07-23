import CDP from "chrome-remote-interface";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import type { BrowserRuntimeMetadata, BrowserSessionConfig } from "../sessionStore.js";
import {
  waitForAssistantResponse,
  captureAssistantMarkdown,
  navigateToChatGPT,
  ensureNotBlocked,
  ensureLoggedIn,
  ensurePromptReady,
} from "./pageActions.js";
import type { BrowserLogger, ChromeClient } from "./types.js";
import {
  launchChrome,
  connectToChrome,
  positionChromeWindowOffscreen,
  closeRemoteChromeTarget,
  connectWithNewTab,
  connectToRemoteChromeTarget,
  listRemoteChromeTargets,
  OrphanedChromeTargetError,
} from "./chromeLifecycle.js";
import { resolveBrowserConfig } from "./config.js";
import { clearStaleChatGptConversationCookies, syncCookies } from "./cookies.js";
import { CHATGPT_URL } from "./constants.js";
import { buildConversationTurnListExpression } from "./conversationTurns.js";
import { cleanupStaleProfileState } from "./profileState.js";
import { readDevToolsActivePortInfo } from "./detect.js";
import {
  pickTarget,
  extractConversationIdFromUrl,
  buildConversationUrl,
  withTimeout,
  openConversationFromSidebar,
  openConversationFromSidebarWithRetry,
  waitForPromptPreview,
  readConversationTurnIndex,
  buildPromptEchoMatcher,
  recoverPromptEcho,
  alignPromptEchoMarkdown,
  type TargetInfoLite,
} from "./reattachHelpers.js";
import { waitForDeepResearchCompletion } from "./actions/deepResearch.js";
import {
  assertCapturedAnswerNotAccessArtifact,
  assertPreResultAccessState,
  assertPreRunAccessState,
} from "./actions/challengeDetection.js";
import {
  isProvisionalChatGptConversationId,
  isProvisionalChatGptConversationUrl,
  normalizeChatGptConversationId,
} from "./conversationIdentity.js";
import { delay } from "./utils.js";
import {
  acquireBrowserTabLease,
  OrphanedBrowserTabLeaseError,
  type BrowserTabLease,
} from "./tabLeaseRegistry.js";
import { BrowserAutomationError } from "../oracle/errors.js";
import {
  clearBrowserCleanupTaintGeneration,
  closeOwnedTargetWithDeadline,
  latchBrowserCleanupTaint,
  releaseBrowserTabLeaseOrTaint,
  rollbackOrphanedBrowserTabLeaseAcquisition,
} from "./index.js";
import {
  assertCapturedAssistantResponseBound,
  registerSubmittedUserMessage,
} from "./actions/captureBinding.js";
import {
  buildPromptRecoveryOwnershipPreview,
  computeRenderedPromptDomSha256,
  normalizePromptForDomMatch,
  PROMPT_DOM_IDENTITY_NORMALIZER_DECLARATION,
  PROMPT_DOM_NORMALIZER_DECLARATION,
} from "./promptDomMatch.js";

const PROMPT_DOM_SHA256_PATTERN = /^[a-f0-9]{64}$/;

export interface ReattachDeps {
  listTargets?: () => Promise<TargetInfoLite[]>;
  connect?: (options?: unknown) => Promise<ChromeClient>;
  waitForAssistantResponse?: typeof waitForAssistantResponse;
  captureAssistantMarkdown?: typeof captureAssistantMarkdown;
  waitForDeepResearchCompletion?: typeof waitForDeepResearchCompletion;
  recoverSession?: (
    runtime: BrowserRuntimeMetadata,
    config: BrowserSessionConfig | undefined,
  ) => Promise<ReattachResult>;
  promptPreview?: string;
  /** SHA-256 of the exact rendered user-turn DOM identity captured after commit. */
  promptDomSha256?: string;
  /** Refuse target fallback; attach only to runtime.chromeTargetId. */
  requireExactTarget?: boolean;
  /** Require the saved full rendered-turn digest (the preview is discovery-only). */
  requirePromptPreviewMatch?: boolean;
  /** Fleet recovery must never launch/reopen a separate browser profile. */
  allowNewChromeFallback?: boolean;
  /** Authoritative worker account id for browser-side quarantine gates. */
  accountId?: string;
}

export interface ReattachResult {
  answerText: string;
  answerMarkdown: string;
}

async function preserveChallengeOverReattachWait<T>(
  operation: Promise<T>,
  runtime: ChromeClient["Runtime"],
  logger: BrowserLogger,
  accountId?: string,
): Promise<T> {
  try {
    return await operation;
  } catch (error) {
    await assertPreResultAccessState(runtime, logger, {
      quarantine: { accountId },
    });
    throw error;
  }
}

/**
 * A successful isolated fleet recovery has re-proved the saved user turn and
 * captured the assistant that follows that exact message handle. Keeping the
 * proof tier in the return type prevents callers from silently manufacturing
 * stronger provenance than the recovery path actually returned.
 */
export interface IsolatedFleetRecoveryResult extends ReattachResult {
  bindingQuality: "message-handle";
}

class ProvisionalConversationTargetMissingError extends Error {}
class ConversationRecoveryProofError extends Error {}

type ProvenConversationIdentity = {
  conversationId: string;
  conversationUrl: string;
};

async function readCurrentConversationIdentity(
  Runtime: ChromeClient["Runtime"],
): Promise<ProvenConversationIdentity | null> {
  const { result } = await Runtime.evaluate({
    expression: "location.href",
    returnByValue: true,
  });
  const conversationUrl = typeof result?.value === "string" ? result.value : "";
  const conversationId = extractConversationIdFromUrl(conversationUrl);
  return conversationId ? { conversationId, conversationUrl } : null;
}

async function waitForCanonicalConversationIdentity(
  Runtime: ChromeClient["Runtime"],
  expectedConversationId: string | undefined,
  timeoutMs: number,
  reason: string,
): Promise<ProvenConversationIdentity> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  do {
    try {
      const identity = await readCurrentConversationIdentity(Runtime);
      if (identity) {
        if (expectedConversationId && identity.conversationId !== expectedConversationId) {
          throw new ConversationRecoveryProofError(
            `${reason}; expected conversation ${expectedConversationId}, but the tab shows ${identity.conversationId}.`,
          );
        }
        return identity;
      }
    } catch (error) {
      if (error instanceof ConversationRecoveryProofError) {
        throw error;
      }
      // A navigation can briefly destroy the execution context. Retry until
      // the bounded canonicalization deadline rather than trusting a null id.
    }
    if (Date.now() >= deadline) break;
    await delay(200);
  } while (Date.now() < deadline);
  throw new ConversationRecoveryProofError(
    `${reason}; the tab did not expose a durable canonical ChatGPT conversation URL before capture.`,
  );
}

async function assertConversationIdentityStillOpen(
  Runtime: ChromeClient["Runtime"],
  expected: ProvenConversationIdentity,
  reason: string,
): Promise<void> {
  let current: ProvenConversationIdentity | null = null;
  try {
    current = await readCurrentConversationIdentity(Runtime);
  } catch {
    // Treat an unreadable route as a failed proof. A later recovery can reopen
    // the saved canonical URL, but this capture must not be returned.
  }
  if (!current || current.conversationId !== expected.conversationId) {
    throw new ConversationRecoveryProofError(
      `${reason}; expected conversation ${expected.conversationId}, but the capture target now shows ${current?.conversationId ?? "no durable conversation"}.`,
    );
  }
}

function hasOnlyProvisionalConversationIdentity(runtime: BrowserRuntimeMetadata): boolean {
  const provisionalIdentityPresent =
    isProvisionalChatGptConversationId(runtime.conversationId) ||
    isProvisionalChatGptConversationUrl(runtime.tabUrl ?? "");
  const durableConversationId =
    normalizeChatGptConversationId(runtime.conversationId) ??
    extractConversationIdFromUrl(runtime.tabUrl ?? "");
  return provisionalIdentityPresent && !durableConversationId;
}

export async function resumeBrowserSession(
  runtime: BrowserRuntimeMetadata,
  config: BrowserSessionConfig | undefined,
  logger: BrowserLogger,
  deps: ReattachDeps = {},
): Promise<ReattachResult> {
  const promptPreview = buildPromptRecoveryOwnershipPreview(deps.promptPreview);
  const promptDomSha256 = PROMPT_DOM_SHA256_PATTERN.test(deps.promptDomSha256 ?? "")
    ? deps.promptDomSha256
    : undefined;
  if (deps.requirePromptPreviewMatch && !promptDomSha256) {
    throw new ConversationRecoveryProofError(
      "The submitted session has no exact rendered user-turn identity digest; refusing prefix-only recovery. Open the originating ChatGPT account history instead.",
    );
  }
  const recoverSession =
    deps.recoverSession ??
    (async (runtimeMeta, configMeta) =>
      resumeBrowserSessionViaNewChrome(runtimeMeta, configMeta, logger, {
        ...deps,
        promptPreview,
        promptDomSha256,
      }));
  let closeAttachedConnection: (() => Promise<void>) | null = null;
  let provenConversation: ProvenConversationIdentity | null = null;
  let attachedRuntime: ChromeClient["Runtime"] | null = null;
  const closeAttached = async (): Promise<void> => {
    const close = closeAttachedConnection;
    closeAttachedConnection = null;
    if (!close) return;
    if (deps.allowNewChromeFallback === false) {
      // Strict fleet recovery owns the target in its outer helper, which
      // certifies closure through a fresh bounded HTTP close. A wedged page
      // CDP detach must not prevent that outer finally from running.
      void close().catch(() => undefined);
      return;
    }
    await close().catch(() => undefined);
  };

  if (!runtime.chromePort && !runtime.chromeBrowserWSEndpoint) {
    if (hasOnlyProvisionalConversationIdentity(runtime)) {
      throw new ProvisionalConversationTargetMissingError(
        "Saved session only has a provisional ChatGPT conversation identity and no running Chrome target; refusing to recover an arbitrary conversation.",
      );
    }
    logger("No running Chrome detected; reopening browser to locate the session.");
    return recoverSession(runtime, config);
  }

  try {
    const liveRuntime = (await refreshAttachRuntime(runtime).catch(() => runtime)) ?? runtime;
    const host = liveRuntime.chromeHost ?? "127.0.0.1";
    const port =
      liveRuntime.chromePort ?? inferPortFromBrowserWSEndpoint(liveRuntime.chromeBrowserWSEndpoint);
    const browserWSEndpoint = liveRuntime.chromeBrowserWSEndpoint ?? undefined;
    const listTargets =
      deps.listTargets ??
      (async () =>
        (await listRemoteChromeTargets({
          host,
          port: port ?? 9222,
          browserWSEndpoint,
        })) as TargetInfoLite[]);
    const targetList = (await listTargets()) as TargetInfoLite[];
    const target = deps.requireExactTarget
      ? targetList.find(
          (candidate) =>
            Boolean(liveRuntime.chromeTargetId) &&
            (candidate.targetId ?? candidate.id) === liveRuntime.chromeTargetId,
        )
      : pickTarget(targetList, liveRuntime);
    if (deps.requireExactTarget && !target) {
      throw new ConversationRecoveryProofError(
        "The isolated recovery target no longer exists; refusing to attach to another Chrome tab.",
      );
    }
    if (!target && hasOnlyProvisionalConversationIdentity(liveRuntime)) {
      throw new ProvisionalConversationTargetMissingError(
        "Saved session only has a provisional ChatGPT conversation identity and no exact Chrome target; refusing to attach to an arbitrary tab.",
      );
    }
    const connection =
      browserWSEndpoint && !deps.connect
        ? await connectToRemoteChromeTarget(host, port ?? 9222, logger, {
            browserWSEndpoint,
            targetId: target?.targetId ?? target?.id,
            closeTargetOnDispose: false,
          })
        : await (async () => {
            const client = (await (
              deps.connect ?? ((options?: unknown) => CDP(options as CDP.Options))
            )(
              browserWSEndpoint
                ? {
                    target: browserWSEndpoint,
                    local: true,
                    targetId: target?.targetId ?? target?.id,
                  }
                : {
                    host,
                    port,
                    target: target?.targetId ?? target?.id,
                  },
            )) as unknown as ChromeClient;
            return { client, close: () => client.close() };
          })();
    closeAttachedConnection = () => connection.close();

    const client: ChromeClient = connection.client;
    const { Runtime, DOM, Page } = client;
    attachedRuntime = Runtime;
    if (Runtime?.enable) {
      await Runtime.enable();
    }
    if (DOM && typeof DOM.enable === "function") {
      await DOM.enable();
    }
    if (Page && typeof Page.enable === "function") {
      await Page.enable();
    }

    const ensureConversationOpen = async (): Promise<ProvenConversationIdentity> => {
      const expectedConversationId =
        normalizeChatGptConversationId(runtime.conversationId) ??
        extractConversationIdFromUrl(runtime.tabUrl ?? "");
      const attachedTargetId = target?.targetId ?? target?.id;
      const attachedExactSavedTarget = Boolean(
        liveRuntime.chromeTargetId && attachedTargetId === liveRuntime.chromeTargetId,
      );
      const requirePromptOwnershipProof = async (reason: string) => {
        if (!promptPreview) {
          throw new ConversationRecoveryProofError(
            `${reason}; the saved session has no prompt preview to prove conversation ownership.`,
          );
        }
        const proofTimeoutMs = Math.min(10_000, Math.max(1_000, config?.timeoutMs ?? 10_000));
        const matched = await waitForPromptPreview(Runtime, promptPreview, proofTimeoutMs);
        if (!matched) {
          throw new ConversationRecoveryProofError(
            `${reason}; the saved prompt was not found in the attached conversation.`,
          );
        }
        logger("Saved prompt verified in the attached conversation before reattach capture.");
      };
      const { result } = await Runtime.evaluate({
        expression: "location.href",
        returnByValue: true,
      });
      const href = typeof result?.value === "string" ? result.value : "";
      const currentId = extractConversationIdFromUrl(href);
      if (currentId && (!expectedConversationId || currentId === expectedConversationId)) {
        if (!expectedConversationId) {
          if (!attachedExactSavedTarget) {
            throw new ConversationRecoveryProofError(
              "The attached tab has a canonical ChatGPT conversation but the session saved neither that durable identity nor the exact Chrome target",
            );
          }
          await requirePromptOwnershipProof(
            hasOnlyProvisionalConversationIdentity(liveRuntime)
              ? "The exact saved Chrome target moved from a provisional ChatGPT route to a canonical conversation"
              : "The exact saved Chrome target has a canonical conversation without a saved durable identity",
          );
        }
        if (deps.requirePromptPreviewMatch) {
          await requirePromptOwnershipProof(
            "The reopened canonical conversation must contain this session's saved user turn",
          );
        }
        return { conversationId: currentId, conversationUrl: href };
      }
      if (
        !currentId &&
        !expectedConversationId &&
        isProvisionalChatGptConversationUrl(href) &&
        attachedExactSavedTarget
      ) {
        await requirePromptOwnershipProof(
          "The exact saved Chrome target still has only a provisional ChatGPT conversation identity",
        );
        logger(
          "Saved Chrome target is still on ChatGPT's provisional conversation route; waiting for the canonical URL before capture.",
        );
        const canonical = await waitForCanonicalConversationIdentity(
          Runtime,
          undefined,
          Math.max(5_000, config?.timeoutMs ?? 120_000),
          "The exact saved Chrome target remained provisional",
        );
        await requirePromptOwnershipProof(
          "The exact saved Chrome target moved from a provisional route to a canonical conversation",
        );
        return canonical;
      }
      const opened = await openConversationFromSidebarWithRetry(
        Runtime,
        {
          conversationId: expectedConversationId,
          preferProjects: true,
          promptPreview,
        },
        15_000,
      );
      if (!opened) {
        throw new Error("Unable to locate prior ChatGPT conversation in sidebar.");
      }
      const identity = await waitForCanonicalConversationIdentity(
        Runtime,
        expectedConversationId,
        2_000,
        "The sidebar recovery navigation did not preserve the saved conversation",
      );
      if (deps.requirePromptPreviewMatch) {
        await requirePromptOwnershipProof(
          "The sidebar-reopened conversation must contain this session's saved user turn",
        );
      }
      return identity;
    };

    const waitForResponse = deps.waitForAssistantResponse ?? waitForAssistantResponse;
    const captureMarkdown = deps.captureAssistantMarkdown ?? captureAssistantMarkdown;
    const timeoutMs = config?.timeoutMs ?? 120_000;
    const pingTimeoutMs = Math.min(5_000, Math.max(1_500, Math.floor(timeoutMs * 0.05)));
    await withTimeout(
      Runtime.evaluate({ expression: "1+1", returnByValue: true }),
      pingTimeoutMs,
      "Reattach target did not respond",
    );
    provenConversation = await ensureConversationOpen();
    const promptTurnBinding = await readPromptPreviewTurnBinding(
      Runtime,
      promptPreview,
      promptDomSha256,
    );
    const promptTurnIndex = promptTurnBinding?.matchedIndex ?? null;
    if (deps.requirePromptPreviewMatch) {
      if (!promptTurnBinding || promptTurnIndex === null) {
        throw new ConversationRecoveryProofError(
          "The saved user turn was visible during recovery but no concrete turn index could be bound; refusing an unscoped assistant capture.",
        );
      }
      if (
        promptTurnBinding.matchCount !== 1 ||
        promptTurnBinding.latestUserIndex !== promptTurnIndex
      ) {
        throw new ConversationRecoveryProofError(
          "The saved user turn is ambiguous or is not the conversation's latest user turn; refusing to capture a different turn's assistant response.",
        );
      }
    }
    const minTurnIndex =
      promptTurnIndex ?? (promptPreview ? null : await readConversationTurnIndex(Runtime, logger));
    if (deps.requirePromptPreviewMatch) {
      const binding = await registerSubmittedUserMessage(Runtime, promptPreview, logger, {
        expectedPromptDomSha256: promptDomSha256,
      });
      if (binding.quality !== "message-handle") {
        throw new ConversationRecoveryProofError(
          "The saved user turn could not be registered as an exact structural message handle; refusing recovery capture.",
        );
      }
    }
    if (config?.researchMode === "deep") {
      const waitForDeepResearch =
        deps.waitForDeepResearchCompletion ?? waitForDeepResearchCompletion;
      const researchResult = await preserveChallengeOverReattachWait(
        withTimeout(
          waitForDeepResearch(Runtime, logger, timeoutMs, minTurnIndex ?? undefined, Page, client, {
            requireScopedTargetOwner: true,
          }),
          timeoutMs + 5_000,
          "Reattach Deep Research response timed out",
        ),
        Runtime,
        logger,
        deps.accountId,
      );
      if (deps.requirePromptPreviewMatch) {
        await assertCapturedAssistantResponseBound(Runtime, {}, logger);
      }
      await assertCapturedAnswerNotAccessArtifact(Runtime, { text: researchResult.text }, logger, {
        quarantine: { accountId: deps.accountId },
      });
      await assertConversationIdentityStillOpen(
        Runtime,
        provenConversation,
        "Deep Research reattach completed on a different route",
      );
      await assertCapturedAnswerNotAccessArtifact(Runtime, { text: researchResult.text }, logger, {
        quarantine: { accountId: deps.accountId },
      });
      await closeAttached();
      return {
        answerText: researchResult.text,
        answerMarkdown: researchResult.text,
      };
    }
    const promptEcho = buildPromptEchoMatcher(promptPreview);
    const answer = await withTimeout(
      waitForResponse(
        Runtime,
        timeoutMs,
        logger,
        minTurnIndex ?? undefined,
        provenConversation.conversationId,
        deps.accountId,
      ),
      timeoutMs + 5_000,
      "Reattach response timed out",
    );
    await assertConversationIdentityStillOpen(
      Runtime,
      provenConversation,
      "Reattach response capture drifted to a different route",
    );
    const recovered = await preserveChallengeOverReattachWait(
      recoverPromptEcho(
        Runtime,
        answer,
        promptEcho,
        logger,
        minTurnIndex,
        timeoutMs,
        provenConversation.conversationId,
      ),
      Runtime,
      logger,
      deps.accountId,
    );
    if (deps.requirePromptPreviewMatch) {
      await assertCapturedAssistantResponseBound(Runtime, recovered.meta, logger);
    }
    await assertConversationIdentityStillOpen(
      Runtime,
      provenConversation,
      "Reattach prompt-echo recovery drifted to a different route",
    );
    const markdown =
      (await preserveChallengeOverReattachWait(
        withTimeout(
          captureMarkdown(Runtime, recovered.meta, logger, {
            requireSourceIdentity: deps.requirePromptPreviewMatch === true,
          }),
          15_000,
          "Reattach markdown capture timed out",
        ),
        Runtime,
        logger,
        deps.accountId,
      )) ?? recovered.text;
    if (deps.requirePromptPreviewMatch) {
      await assertCapturedAssistantResponseBound(Runtime, recovered.meta, logger);
    }
    await assertConversationIdentityStillOpen(
      Runtime,
      provenConversation,
      "Reattach markdown capture drifted to a different route",
    );
    const aligned = alignPromptEchoMarkdown(recovered.text, markdown, promptEcho, logger);
    await assertCapturedAnswerNotAccessArtifact(
      Runtime,
      { text: aligned.answerText, html: aligned.answerMarkdown },
      logger,
      { quarantine: { accountId: deps.accountId } },
    );

    await closeAttached();
    return { answerText: aligned.answerText, answerMarkdown: aligned.answerMarkdown };
  } catch (error) {
    if (attachedRuntime) {
      try {
        await assertPreResultAccessState(attachedRuntime, logger, {
          quarantine: { accountId: deps.accountId },
        });
      } catch (accessError) {
        await closeAttached();
        throw accessError;
      }
    }
    await closeAttached();
    if (
      error instanceof ProvisionalConversationTargetMissingError ||
      error instanceof ConversationRecoveryProofError
    ) {
      throw error;
    }
    if (deps.allowNewChromeFallback === false) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    logger(
      `Existing Chrome reattach failed (${message}); reopening browser to locate the session.`,
    );
    const recoveryRuntime = provenConversation
      ? {
          ...runtime,
          conversationId: provenConversation.conversationId,
          tabUrl: provenConversation.conversationUrl,
        }
      : runtime;
    return recoverSession(recoveryRuntime, config);
  }
}

export interface IsolatedFleetRecoveryOptions {
  runtime: BrowserRuntimeMetadata & {
    tabUrl: string;
    conversationId: string;
    promptSubmitted: true;
  };
  config?: BrowserSessionConfig;
  logger: BrowserLogger;
  chromeHost: string;
  chromePort: number;
  profileDir: string;
  promptPreview: string;
  /** Capability-bound SHA-256 of the exact rendered user-turn DOM identity. */
  promptDomSha256: string;
  sessionId?: string;
  maxConcurrentTabs?: number;
  /** Independent FIFO browser-capacity wait budget; 0 waits forever locally. */
  queueTimeoutMs?: number;
  /** @deprecated Use queueTimeoutMs. Retained for older reattach callers. */
  leaseTimeoutMs?: number;
  signal?: AbortSignal;
  accountId?: string;
  /** Test seam; production uses the strict isolated-target connector. */
  connectWithNewTabFn?: typeof connectWithNewTab;
  /** Test seam; production acquires a normal profile-scoped fleet lease. */
  acquireBrowserTabLeaseFn?: typeof acquireBrowserTabLease;
  /** Test seam; production closes owned targets through the DevTools endpoint. */
  closeRemoteChromeTargetFn?: typeof closeRemoteChromeTarget;
  /** Test seam; production runs the exact-target, capture-only reattach path. */
  resumeBrowserSessionFn?: typeof resumeBrowserSession;
}

class IndeterminateRecoveryTargetConnectError extends Error {
  constructor(reason: "aborted" | "timed out") {
    super(
      `Isolated recovery target creation ${reason}; the lane remains reserved until any late target result is closed.`,
    );
    this.name = "IndeterminateRecoveryTargetConnectError";
  }
}

function isCanonicalRecoveryChallenge(error: unknown): error is BrowserAutomationError {
  if (!(error instanceof BrowserAutomationError)) return false;
  const stage = error.details?.stage;
  if (stage === "cloudflare-challenge" || stage === "account-quarantine") {
    return true;
  }
  const state = error.details?.state;
  return (
    stage === "challenge-gate" &&
    (state === "verification_interstitial" || state === "account_security_block")
  );
}

function withPreservedRecoveryRuntime(
  error: BrowserAutomationError,
  options: {
    runtime: IsolatedFleetRecoveryOptions["runtime"];
    profileDir: string;
    chromeHost: string;
    chromePort: number;
    chromeTargetId: string;
  },
): BrowserAutomationError {
  const priorRuntime =
    error.details?.runtime &&
    typeof error.details.runtime === "object" &&
    !Array.isArray(error.details.runtime)
      ? (error.details.runtime as BrowserRuntimeMetadata)
      : {};
  const preservedRuntime: BrowserRuntimeMetadata = {
    ...priorRuntime,
    ...options.runtime,
    browserTransport: "cdp",
    chromeHost: options.chromeHost,
    chromePort: options.chromePort,
    chromeProfileRoot: options.profileDir,
    userDataDir: options.runtime.userDataDir ?? options.profileDir,
    chromeTargetId: options.chromeTargetId,
    tabUrl: options.runtime.tabUrl,
    conversationId: options.runtime.conversationId,
    promptSubmitted: true,
    controllerPid: process.pid,
  };
  return new BrowserAutomationError(
    error.message,
    {
      ...error.details,
      runtime: preservedRuntime,
      recoveryTargetPreserved: true,
    },
    error,
  );
}

/**
 * Recover a submitted fleet run without touching an existing lane tab. A
 * normal tab lease is acquired, a new owned tab is opened at the exact
 * canonical conversation, the saved user turn is proved, and only then is
 * the assistant response captured. Ordinary completion/failure closes the
 * owned tab before releasing its lease. A canonical headful challenge keeps
 * that exact tab and lease paired for human inspection. No prompt submission
 * path is reachable.
 */
export async function resumeBrowserSessionInIsolatedFleetTab(
  options: IsolatedFleetRecoveryOptions,
): Promise<IsolatedFleetRecoveryResult> {
  const {
    runtime,
    config,
    logger,
    chromeHost,
    chromePort,
    profileDir,
    promptPreview,
    promptDomSha256,
    sessionId,
    maxConcurrentTabs,
    queueTimeoutMs,
    leaseTimeoutMs,
    signal,
    accountId,
    connectWithNewTabFn = connectWithNewTab,
    acquireBrowserTabLeaseFn = acquireBrowserTabLease,
    closeRemoteChromeTargetFn = closeRemoteChromeTarget,
    resumeBrowserSessionFn = resumeBrowserSession,
  } = options;
  let lease: BrowserTabLease | null = null;
  let isolated: Awaited<ReturnType<typeof connectWithNewTab>> | null = null;
  let primaryError: unknown;
  let hasPrimaryError = false;
  let recoveryResult: ReattachResult | undefined;
  let orphanedTargetId: string | null = null;
  let closeOwnedPromise: Promise<void> | null = null;
  let deferredConnectCleanup = false;
  let preserveChallengeTarget = false;
  const closeOwned = (): Promise<void> => {
    if (closeOwnedPromise) return closeOwnedPromise;
    closeOwnedPromise = (async () => {
      const targetId = isolated?.targetId ?? orphanedTargetId ?? undefined;
      // A dead CDP detach can wedge forever. Start it best-effort with a
      // handled rejection, then independently close the owned target through
      // the bounded fresh HTTP path below.
      void isolated?.client.close().catch((error) => {
        logger(
          `Recovery CDP detach failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
      const closed = await closeOwnedTargetWithDeadline(
        closeRemoteChromeTargetFn(chromeHost, chromePort, targetId, logger),
        logger,
        { targetId: targetId ?? null },
      );
      if (!closed) {
        throw new BrowserAutomationError(
          `Failed to close isolated recovery target ${targetId ?? "unknown"}; recovery success cannot be certified.`,
          { stage: "recovery-cleanup", retryable: false },
        );
      }
    })();
    return closeOwnedPromise;
  };
  let removeAbortListener: () => void = () => {};
  try {
    try {
      lease = await acquireBrowserTabLeaseFn(profileDir, {
        maxConcurrentTabs,
        timeoutMs: queueTimeoutMs ?? leaseTimeoutMs ?? config?.queueTimeoutMs,
        logger,
        sessionId,
        chromeHost,
        chromePort,
        // This queue wait belongs to capture-only recovery of a prompt that is
        // already known submitted. Preserve that fact in any timeout envelope
        // so generic retry logic can never replay the originating consult.
        promptSubmitted: true,
        signal,
      });
    } catch (error) {
      if (error instanceof OrphanedBrowserTabLeaseError) {
        // Keep ownership reachable and synchronously start the bounded,
        // identity-safe rollback. A failed release taints readiness, and its
        // deferred self-heal clears only that exact taint generation.
        await rollbackOrphanedBrowserTabLeaseAcquisition(
          error,
          logger,
          "orphaned recovery acquisition rollback",
        );
      }
      throw error;
    }
    if (signal?.aborted) {
      throw new Error("Remote browser recovery caller disconnected before tab creation.");
    }
    const connectAttempt = connectWithNewTabFn(chromePort, logger, runtime.tabUrl, chromeHost, {
      fallbackToDefault: false,
      retries: 6,
      retryDelayMs: 500,
    });
    const connectTimeoutMs = Math.max(1_000, Math.min(config?.timeoutMs ?? 30_000, 30_000));
    let connectTimer: ReturnType<typeof setTimeout> | null = null;
    let removeConnectAbortListener = (): void => {};
    const connectCancelled = new Promise<never>((_resolve, reject) => {
      const rejectOnce = (reason: "aborted" | "timed out") =>
        reject(new IndeterminateRecoveryTargetConnectError(reason));
      connectTimer = setTimeout(() => rejectOnce("timed out"), connectTimeoutMs);
      if (signal) {
        const onAbort = () => rejectOnce("aborted");
        signal.addEventListener("abort", onAbort, { once: true });
        removeConnectAbortListener = () => signal.removeEventListener("abort", onAbort);
        if (signal.aborted) onAbort();
      }
    });
    try {
      isolated = await Promise.race([connectAttempt, connectCancelled]);
    } catch (error) {
      if (error instanceof IndeterminateRecoveryTargetConnectError) {
        deferredConnectCleanup = true;
        const connectCleanupTaintReason = error.message;
        const connectCleanupTaintGeneration = latchBrowserCleanupTaint(
          connectCleanupTaintReason,
          logger,
        );
        const lateLease = lease;
        const clearConnectCleanupTaint = (): void => {
          if (
            clearBrowserCleanupTaintGeneration(
              connectCleanupTaintGeneration,
              connectCleanupTaintReason,
            )
          ) {
            logger(
              `[browser] Cleared isolated recovery connect-timeout taint after late target and lease cleanup completed.`,
            );
          }
        };
        const releaseLateLease = async (): Promise<void> => {
          if (!lateLease) {
            throw new Error("Late isolated recovery cleanup lost its tab-lease handle.");
          }
          const released = await releaseBrowserTabLeaseOrTaint(
            lateLease,
            logger,
            "late isolated recovery cleanup",
            { onDeferredRelease: clearConnectCleanupTaint },
          );
          if (released) {
            clearConnectCleanupTaint();
          }
        };
        // Do not abandon the in-flight CDP operation. If it ever settles,
        // close any target it created before releasing the capacity lease.
        // If it never settles, the fail-closed lease and cleanup taint remain.
        void connectAttempt
          .then(
            async (lateConnection) => {
              const lateTargetId = lateConnection.targetId;
              void lateConnection.client.close().catch(() => undefined);
              if (lateTargetId) {
                const closed = await closeOwnedTargetWithDeadline(
                  closeRemoteChromeTargetFn(chromeHost, chromePort, lateTargetId, logger),
                  logger,
                  { targetId: lateTargetId },
                );
                if (!closed) {
                  throw new Error(
                    `Late isolated recovery target ${lateTargetId} could not be closed.`,
                  );
                }
              }
              await releaseLateLease();
            },
            async (lateError) => {
              if (lateError instanceof OrphanedChromeTargetError) {
                const closed = await closeOwnedTargetWithDeadline(
                  closeRemoteChromeTargetFn(chromeHost, chromePort, lateError.targetId, logger),
                  logger,
                  { targetId: lateError.targetId },
                );
                if (!closed) throw lateError;
              }
              await releaseLateLease();
            },
          )
          .catch((lateCleanupError) => {
            latchBrowserCleanupTaint(
              `late isolated recovery target cleanup failed: ${lateCleanupError instanceof Error ? lateCleanupError.message : String(lateCleanupError)}`,
              logger,
            );
          });
      }
      if (error instanceof OrphanedChromeTargetError) {
        orphanedTargetId = error.targetId;
        logger(
          `Isolated recovery target ${error.targetId} survived its first close attempt; retrying through bounded cleanup.`,
        );
      }
      throw error;
    } finally {
      if (connectTimer) clearTimeout(connectTimer);
      removeConnectAbortListener();
    }
    const targetId = isolated?.targetId;
    if (!isolated || !targetId) {
      throw new ConversationRecoveryProofError(
        "Chrome did not create a dedicated recovery tab; refusing to use its default tab.",
      );
    }
    if (signal?.aborted) {
      throw new Error("Remote browser recovery caller disconnected during tab creation.");
    }
    const aborted = signal
      ? new Promise<never>((_resolve, reject) => {
          const onAbort = () => {
            void closeOwned().then(
              () =>
                reject(
                  new Error("Remote browser recovery caller disconnected; isolated tab closed."),
                ),
              (cleanupError) =>
                reject(
                  new BrowserAutomationError(
                    `Remote browser recovery caller disconnected and isolated-tab cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
                    { stage: "recovery-cleanup", retryable: false },
                  ),
                ),
            );
          };
          signal.addEventListener("abort", onAbort, { once: true });
          removeAbortListener = () => signal.removeEventListener("abort", onAbort);
        })
      : null;
    const raceAbort = async <T>(work: Promise<T>): Promise<T> =>
      aborted ? await Promise.race([work, aborted]) : await work;

    await raceAbort(
      lease.update({
        chromeHost,
        chromePort,
        chromeTargetId: targetId,
        tabUrl: runtime.tabUrl,
      }),
    );

    const { Page, Runtime } = isolated.client;
    await raceAbort(
      (async () => {
        await Page.enable?.();
        await Runtime.enable?.();
        // Navigate explicitly even though target creation received the same URL:
        // this gives us the normal document-ready proof before reattach opens a
        // second, exact-target CDP session.
        await navigateToChatGPT(Page, Runtime, runtime.tabUrl, logger);
        await assertPreRunAccessState(Runtime, logger, { quarantine: { accountId } });
      })(),
    );

    const recovery = resumeBrowserSessionFn(
      {
        ...runtime,
        chromeHost,
        chromePort,
        chromeTargetId: targetId,
      },
      config,
      logger,
      {
        promptPreview,
        promptDomSha256,
        requireExactTarget: true,
        requirePromptPreviewMatch: true,
        allowNewChromeFallback: false,
        accountId,
      },
    );
    recoveryResult = await raceAbort(recovery);
  } catch (error) {
    const targetId = isolated?.targetId;
    if (
      config?.headless !== true &&
      lease &&
      targetId &&
      closeOwnedPromise === null &&
      isCanonicalRecoveryChallenge(error)
    ) {
      preserveChallengeTarget = true;
      primaryError = withPreservedRecoveryRuntime(error, {
        runtime,
        profileDir,
        chromeHost,
        chromePort,
        chromeTargetId: targetId,
      });
      logger(
        `[browser] Preserving isolated recovery target ${targetId} and its active lane lease for manual challenge resolution.`,
      );
    } else {
      primaryError = error;
    }
    hasPrimaryError = true;
  }

  removeAbortListener();
  // Load-bearing order: the physical owned tab is closed before the lease
  // advertises a free slot to sibling lanes.
  let cleanupError: unknown;
  if (!deferredConnectCleanup) {
    if (preserveChallengeTarget) {
      // Disconnect this controller without closing the page target. The exact
      // target and its capacity lease remain paired for human inspection.
      void isolated?.client.close().catch((error) => {
        logger(
          `Recovery CDP detach failed while preserving the challenge target: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    } else {
      try {
        await closeOwned();
      } catch (error) {
        cleanupError = error;
        logger(
          `Failed to close isolated recovery tab: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
  if (lease && !cleanupError && !deferredConnectCleanup) {
    if (preserveChallengeTarget) {
      logger(
        `[browser] Keeping isolated recovery lease ${lease.id.slice(0, 8)} active for preserved challenge target ${isolated?.targetId ?? "unknown"}.`,
      );
    } else {
      const released = await releaseBrowserTabLeaseOrTaint(
        lease,
        logger,
        "isolated recovery cleanup",
      );
      if (!released) {
        cleanupError ??= new Error(
          `Failed to release isolated recovery tab lease ${lease.id}; readiness remains cleanup-tainted until identity-safe self-heal completes.`,
        );
      }
    }
  } else if (lease && (cleanupError || deferredConnectCleanup)) {
    logger(
      `[browser] Keeping isolated recovery lease ${lease.id.slice(0, 8)} active because owned-target close was not proved.`,
    );
  }

  // Preserve primary work failures after cleanup; cleanup-only failures make
  // an otherwise successful recovery uncertifiable. Keeping both decisions
  // outside `finally` prevents cleanup control flow from overwriting the
  // original result/error while still guaranteeing close-before-release.
  if (hasPrimaryError) {
    throw primaryError;
  }
  if (cleanupError) {
    throw cleanupError instanceof BrowserAutomationError
      ? cleanupError
      : new BrowserAutomationError(
          `Isolated recovery cleanup failed; recovery success cannot be certified: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
          { stage: "recovery-cleanup", retryable: false },
        );
  }
  if (!recoveryResult) {
    throw new BrowserAutomationError("Isolated recovery completed without a result.", {
      stage: "recovery",
      retryable: false,
    });
  }
  return { ...recoveryResult, bindingQuality: "message-handle" };
}

async function refreshAttachRuntime(
  runtime: BrowserRuntimeMetadata,
): Promise<BrowserRuntimeMetadata | null> {
  if (!runtime.chromeProfileRoot) {
    return runtime;
  }
  const host = runtime.chromeHost ?? "127.0.0.1";
  const activePort = await readDevToolsActivePortInfo(runtime.chromeProfileRoot, {
    host,
  });
  if (!activePort) {
    return runtime;
  }
  return {
    ...runtime,
    chromeHost: host,
    chromePort: activePort.port,
    chromeBrowserWSEndpoint: activePort.browserWSEndpoint,
  };
}

function inferPortFromBrowserWSEndpoint(browserWSEndpoint?: string): number | undefined {
  if (!browserWSEndpoint) {
    return undefined;
  }
  try {
    const parsed = new URL(browserWSEndpoint);
    const port = Number.parseInt(parsed.port, 10);
    if (Number.isFinite(port) && port > 0) {
      return port;
    }
  } catch {
    // ignore malformed ws endpoints and fall back to caller defaults
  }
  return undefined;
}

async function resumeBrowserSessionViaNewChrome(
  runtime: BrowserRuntimeMetadata,
  config: BrowserSessionConfig | undefined,
  logger: BrowserLogger,
  deps: ReattachDeps,
): Promise<ReattachResult> {
  const promptPreview = buildPromptRecoveryOwnershipPreview(deps.promptPreview);
  if (hasOnlyProvisionalConversationIdentity(runtime)) {
    throw new ProvisionalConversationTargetMissingError(
      "Saved session only has a provisional ChatGPT conversation identity; refusing to recover an arbitrary conversation from history.",
    );
  }
  const resolved = resolveBrowserConfig(config ?? {});
  const manualLogin = Boolean(resolved.manualLogin);
  const userDataDir = manualLogin
    ? (resolved.manualLoginProfileDir ?? path.join(os.homedir(), ".oracle", "browser-profile"))
    : await mkdtemp(path.join(os.tmpdir(), "oracle-reattach-"));
  if (manualLogin) {
    await mkdir(userDataDir, { recursive: true });
  }
  let chrome: Awaited<ReturnType<typeof launchChrome>> | null = null;
  let client: ChromeClient | null = null;
  let completed = false;
  let preserveManualChallenge = false;
  const cleanup = async (): Promise<void> => {
    if (client && typeof client.close === "function") {
      await withTimeout(
        Promise.resolve().then(() => client?.close()),
        5_000,
        "Chrome detach timed out",
      ).catch((error) => {
        logger(
          `Failed to detach fallback recovery Chrome: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }
    const terminateChrome = (!completed && !preserveManualChallenge) || !resolved.keepBrowser;
    if (!terminateChrome) return;
    if (chrome) {
      await withTimeout(
        Promise.resolve().then(() => chrome?.kill()),
        5_000,
        "Chrome kill timed out",
      ).catch((error) => {
        logger(
          `Failed to terminate fallback recovery Chrome: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }
    if (manualLogin) {
      await cleanupStaleProfileState(userDataDir, logger, { lockRemovalMode: "never" }).catch(
        (error) => {
          logger(
            `Failed to clean fallback recovery profile state: ${error instanceof Error ? error.message : String(error)}`,
          );
        },
      );
    } else {
      await rm(userDataDir, { recursive: true, force: true }).catch((error) => {
        logger(
          `Failed to remove fallback recovery profile: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }
  };

  try {
    chrome = await launchChrome(resolved, userDataDir, logger);
    const chromeHost = (chrome as unknown as { host?: string }).host ?? "127.0.0.1";
    client = await connectToChrome(chrome.port, logger, chromeHost);
    const { Network, Page, Runtime, DOM, Target } = client;

    if (Runtime?.enable) {
      await Runtime.enable();
    }
    if (DOM && typeof DOM.enable === "function") {
      await DOM.enable();
    }
    if (!resolved.headless && resolved.hideWindow) {
      await positionChromeWindowOffscreen(client, logger);
    }

    let appliedCookies = 0;
    if (!manualLogin && resolved.cookieSync) {
      appliedCookies = await syncCookies(Network, resolved.url, resolved.chromeProfile, logger, {
        allowErrors: resolved.allowCookieErrors,
        filterNames: resolved.cookieNames ?? undefined,
        inlineCookies: resolved.inlineCookies ?? undefined,
        cookiePath: resolved.chromeCookiePath ?? undefined,
        waitMs: resolved.cookieSyncWaitMs ?? 0,
      });
    }

    await clearStaleChatGptConversationCookies(Network, Target, logger, {
      preserveConversationIds: [
        runtime.conversationId,
        extractConversationIdFromUrl(runtime.tabUrl ?? ""),
        extractConversationIdFromUrl(resolved.url),
      ],
    });

    await navigateToChatGPT(Page, Runtime, CHATGPT_URL, logger);
    await ensureNotBlocked(Runtime, resolved.headless, logger, {
      quarantine: { accountId: deps.accountId },
    });
    await ensureLoggedIn(Runtime, logger, { appliedCookies });
    if (resolved.url !== CHATGPT_URL) {
      await navigateToChatGPT(Page, Runtime, resolved.url, logger);
      await ensureNotBlocked(Runtime, resolved.headless, logger, {
        quarantine: { accountId: deps.accountId },
      });
    }
    await ensurePromptReady(Runtime, resolved.inputTimeoutMs, logger);

    const savedConversationId =
      normalizeChatGptConversationId(runtime.conversationId) ??
      extractConversationIdFromUrl(runtime.tabUrl ?? "");

    const conversationUrl = buildConversationUrl(runtime, resolved.url);
    if (conversationUrl) {
      logger(`Reopening conversation at ${conversationUrl}`);
      await navigateToChatGPT(Page, Runtime, conversationUrl, logger);
      await ensureNotBlocked(Runtime, resolved.headless, logger, {
        quarantine: { accountId: deps.accountId },
      });
      await ensurePromptReady(Runtime, resolved.inputTimeoutMs, logger);
    } else {
      const conversationId =
        normalizeChatGptConversationId(runtime.conversationId) ??
        extractConversationIdFromUrl(runtime.tabUrl ?? "");
      const opened = await openConversationFromSidebarWithRetry(
        Runtime,
        {
          conversationId,
          preferProjects:
            resolved.url !== CHATGPT_URL ||
            Boolean(
              runtime.tabUrl &&
              (/\/g\//.test(runtime.tabUrl) || runtime.tabUrl.includes("/project")),
            ),
          promptPreview,
        },
        15_000,
      );
      if (!opened) {
        throw new Error("Unable to locate prior ChatGPT conversation in sidebar.");
      }
    }

    const provenConversation = await waitForCanonicalConversationIdentity(
      Runtime,
      savedConversationId,
      2_000,
      "The reopened browser did not preserve the saved conversation",
    );

    const waitForResponse = deps.waitForAssistantResponse ?? waitForAssistantResponse;
    const captureMarkdown = deps.captureAssistantMarkdown ?? captureAssistantMarkdown;
    const timeoutMs = resolved.timeoutMs ?? 120_000;
    const promptTurnBinding = await readPromptPreviewTurnBinding(
      Runtime,
      promptPreview,
      deps.promptDomSha256,
    );
    const promptTurnIndex = promptTurnBinding?.matchedIndex ?? null;
    if (deps.requirePromptPreviewMatch) {
      if (!promptTurnBinding || promptTurnIndex === null) {
        throw new ConversationRecoveryProofError(
          "The exact saved user-turn identity was not found in the reopened conversation; refusing an unscoped assistant capture.",
        );
      }
      if (
        promptTurnBinding.matchCount !== 1 ||
        promptTurnBinding.latestUserIndex !== promptTurnIndex
      ) {
        throw new ConversationRecoveryProofError(
          "The exact saved user turn is duplicated or is not the conversation's latest user turn; refusing to capture a different turn's assistant response.",
        );
      }
      const binding = await registerSubmittedUserMessage(Runtime, promptPreview, logger, {
        expectedPromptDomSha256: deps.promptDomSha256,
      });
      if (binding.quality !== "message-handle") {
        throw new ConversationRecoveryProofError(
          "The exact saved user turn could not be registered as a structural message handle; refusing recovery capture.",
        );
      }
    }
    const minTurnIndex =
      promptTurnIndex ?? (promptPreview ? null : await readConversationTurnIndex(Runtime, logger));
    if (resolved.researchMode === "deep") {
      const waitForDeepResearch =
        deps.waitForDeepResearchCompletion ?? waitForDeepResearchCompletion;
      const researchResult = await preserveChallengeOverReattachWait(
        waitForDeepResearch(Runtime, logger, timeoutMs, minTurnIndex ?? undefined, Page, client, {
          requireScopedTargetOwner: true,
        }),
        Runtime,
        logger,
        deps.accountId,
      );
      if (deps.requirePromptPreviewMatch) {
        await assertCapturedAssistantResponseBound(Runtime, {}, logger);
      }
      await assertCapturedAnswerNotAccessArtifact(Runtime, { text: researchResult.text }, logger, {
        quarantine: { accountId: deps.accountId },
      });
      await assertConversationIdentityStillOpen(
        Runtime,
        provenConversation,
        "Deep Research recovery completed on a different route",
      );
      await assertCapturedAnswerNotAccessArtifact(Runtime, { text: researchResult.text }, logger, {
        quarantine: { accountId: deps.accountId },
      });
      completed = true;
      return {
        answerText: researchResult.text,
        answerMarkdown: researchResult.text,
      };
    }
    const promptEcho = buildPromptEchoMatcher(promptPreview);
    const answer = await waitForResponse(
      Runtime,
      timeoutMs,
      logger,
      minTurnIndex ?? undefined,
      provenConversation.conversationId,
      deps.accountId,
    );
    await assertConversationIdentityStillOpen(
      Runtime,
      provenConversation,
      "Recovered response capture drifted to a different route",
    );
    const recovered = await preserveChallengeOverReattachWait(
      recoverPromptEcho(
        Runtime,
        answer,
        promptEcho,
        logger,
        minTurnIndex,
        timeoutMs,
        provenConversation.conversationId,
      ),
      Runtime,
      logger,
      deps.accountId,
    );
    if (deps.requirePromptPreviewMatch) {
      await assertCapturedAssistantResponseBound(Runtime, recovered.meta, logger);
    }
    await assertConversationIdentityStillOpen(
      Runtime,
      provenConversation,
      "Recovered prompt-echo capture drifted to a different route",
    );
    const markdown =
      (await preserveChallengeOverReattachWait(
        captureMarkdown(Runtime, recovered.meta, logger, {
          requireSourceIdentity: true,
        }),
        Runtime,
        logger,
        deps.accountId,
      )) ?? recovered.text;
    if (deps.requirePromptPreviewMatch) {
      await assertCapturedAssistantResponseBound(Runtime, recovered.meta, logger);
    }
    await assertConversationIdentityStillOpen(
      Runtime,
      provenConversation,
      "Recovered markdown capture drifted to a different route",
    );
    const aligned = alignPromptEchoMarkdown(recovered.text, markdown, promptEcho, logger);
    await assertCapturedAnswerNotAccessArtifact(
      Runtime,
      { text: aligned.answerText, html: aligned.answerMarkdown },
      logger,
      { quarantine: { accountId: deps.accountId } },
    );

    completed = true;
    return { answerText: aligned.answerText, answerMarkdown: aligned.answerMarkdown };
  } catch (error) {
    // `keepBrowser` is not a blanket failure escape hatch. Preserve only a
    // positively classified, human-actionable challenge in a visible browser;
    // every other failure must unwind the Chrome/profile this function owns.
    preserveManualChallenge = Boolean(
      resolved.keepBrowser && !resolved.headless && isCanonicalRecoveryChallenge(error),
    );
    if (preserveManualChallenge) {
      logger(
        `[browser] Preserving the headful fallback recovery Chrome and profile ${userDataDir} for manual challenge resolution.`,
      );
    }
    throw error;
  } finally {
    await cleanup();
  }
}

async function readPromptPreviewTurnIndex(
  Runtime: ChromeClient["Runtime"],
  promptPreview?: string | null,
  promptDomSha256?: string | null,
): Promise<number | null> {
  return (
    (await readPromptPreviewTurnBinding(Runtime, promptPreview, promptDomSha256))?.matchedIndex ??
    null
  );
}

type PromptPreviewTurnBinding = {
  matchedIndex: number;
  latestUserIndex: number;
  matchCount: number;
};

async function readPromptPreviewTurnBinding(
  Runtime: ChromeClient["Runtime"],
  promptPreview?: string | null,
  promptDomSha256?: string | null,
): Promise<PromptPreviewTurnBinding | null> {
  const preview = promptPreview?.trim();
  if (!preview) {
    return null;
  }
  const expectedDomSha256 = PROMPT_DOM_SHA256_PATTERN.test(promptDomSha256 ?? "")
    ? promptDomSha256
    : null;
  const normalizedPreview = normalizePromptForDomMatch(preview);
  const promptNeedle = normalizedPreview.slice(0, 120);
  if (!promptNeedle) {
    return null;
  }
  const { result } = await Runtime.evaluate({
    expression: `(() => {
      const needle = ${JSON.stringify(promptNeedle)};
      ${PROMPT_DOM_NORMALIZER_DECLARATION}
      ${PROMPT_DOM_IDENTITY_NORMALIZER_DECLARATION}
      const turns = ${buildConversationTurnListExpression()};
      const candidates = [];
      let latestUserIndex = null;
      for (const [index, node] of turns.entries()) {
        const attr = (node.getAttribute('data-message-author-role') || node.getAttribute('data-turn') || node.dataset?.turn || '').toLowerCase();
        const isUser = attr === 'user' || Boolean(node.querySelector('[data-message-author-role="user"]'));
        if (!isUser) continue;
        latestUserIndex = index;
        const promptContentCandidates = readRenderedPromptDomContentCandidates(node);
        const wrapperText = normalizePromptForDomMatch(node.innerText || node.textContent || '');
        const previewMatches =
          wrapperText.includes(needle) ||
          promptContentCandidates.some((candidate) =>
            normalizePromptForDomMatch(candidate.text).includes(needle),
          );
        if (previewMatches) {
          candidates.push({
            index,
            domIdentities: promptContentCandidates.map((candidate) => candidate.identity),
          });
        }
      }
      return latestUserIndex === null ? null : { latestUserIndex, candidates };
    })()`,
    returnByValue: true,
  });
  const value = result?.value as
    | {
        latestUserIndex?: unknown;
        candidates?: Array<{ index?: unknown; domIdentities?: unknown }>;
      }
    | null
    | undefined;
  if (!value || typeof value.latestUserIndex !== "number" || !Array.isArray(value.candidates)) {
    return null;
  }
  const matchedTurnIndices: number[] = [];
  const seenTurnIndices = new Set<number>();
  for (const candidate of value.candidates) {
    if (typeof candidate.index !== "number" || !Number.isInteger(candidate.index)) continue;
    const domIdentities = Array.isArray(candidate.domIdentities)
      ? candidate.domIdentities.filter(
          (identity): identity is string => typeof identity === "string" && identity.length > 0,
        )
      : [];
    const digestMatches = expectedDomSha256
      ? domIdentities.some(
          (identity) => computeRenderedPromptDomSha256(identity) === expectedDomSha256,
        )
      : domIdentities.length > 0;
    if (!digestMatches || seenTurnIndices.has(candidate.index)) continue;
    seenTurnIndices.add(candidate.index);
    matchedTurnIndices.push(candidate.index);
  }
  if (matchedTurnIndices.length === 0) return null;
  return {
    matchedIndex: matchedTurnIndices[matchedTurnIndices.length - 1]!,
    latestUserIndex: value.latestUserIndex,
    matchCount: matchedTurnIndices.length,
  };
}

// biome-ignore lint/style/useNamingConvention: test-only export used in vitest suite
export const __test__ = {
  pickTarget,
  extractConversationIdFromUrl,
  buildConversationUrl,
  openConversationFromSidebar,
  waitForPromptPreview,
  readPromptPreviewTurnIndex,
  readPromptPreviewTurnBinding,
};

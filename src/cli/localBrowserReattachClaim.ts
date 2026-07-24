import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { BrowserLocalReattachCompletionClaim, SessionMetadata } from "../sessionManager.js";
import {
  normalizeSessionMetadataForCompletionClaim,
  reconcileSessionMetadataForCompletionClaim,
} from "../sessionManager.js";
import { sessionStore } from "../sessionStore.js";

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

function localReattachGeneration(metadata: SessionMetadata): unknown {
  // Dead-browser/zombie reconciliation is an observational view and stamps
  // completedAt with the time of each read. That timestamp can legitimately
  // differ between the caller's read and the claim updater's fresh read even
  // when no persisted generation changed. Keep the substantive terminal
  // evidence (status/response/error/usage), but exclude those derived clocks
  // from the ownership digest.
  const models = metadata.models?.map(
    ({ completedAt: _derivedCompletionTime, ...modelRun }) => modelRun,
  );
  const browserGeneration = metadata.browser
    ? {
        config: metadata.browser.config,
        runtime: metadata.browser.runtime,
        submittedPromptPreview: metadata.browser.submittedPromptPreview,
        submittedPromptDomSha256: metadata.browser.submittedPromptDomSha256,
        archive: metadata.browser.archive,
        modelSelection: metadata.browser.modelSelection,
        remoteRun: metadata.browser.remoteRun,
        remoteRecovery: metadata.browser.remoteRecovery,
        remoteRecoveryCompletionClaim: metadata.browser.remoteRecoveryCompletionClaim,
        warnings: metadata.browser.warnings,
      }
    : undefined;
  const hasBrowserGeneration = Boolean(
    browserGeneration && Object.values(browserGeneration).some((value) => value !== undefined),
  );
  return {
    id: metadata.id,
    mode: metadata.mode,
    model: metadata.model,
    status: metadata.status,
    startedAt: metadata.startedAt,
    usage: metadata.usage,
    errorMessage: metadata.errorMessage,
    models,
    artifacts: metadata.artifacts,
    response: metadata.response,
    transport: metadata.transport,
    error: metadata.error,
    browser: hasBrowserGeneration ? browserGeneration : undefined,
  };
}

export function computeLocalBrowserReattachGenerationSha256(metadata: SessionMetadata): string {
  return createHash("sha256")
    .update(stableJson(localReattachGeneration(metadata)))
    .digest("hex");
}

function readProcessStartToken(pid: number): string | undefined {
  if (process.platform !== "linux") return undefined;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fieldsAfterCommand = stat
      .slice(stat.lastIndexOf(")") + 2)
      .trim()
      .split(/\s+/);
    return fieldsAfterCommand[19];
  } catch {
    return undefined;
  }
}

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function currentBrowserProcessClaimOwner(): {
  ownerPid: number;
  ownerStartToken?: string;
} {
  const ownerStartToken = readProcessStartToken(process.pid);
  return {
    ownerPid: process.pid,
    ...(ownerStartToken ? { ownerStartToken } : {}),
  };
}

export function browserProcessClaimIsStale(claim: {
  ownerPid: number;
  ownerStartToken?: string;
}): boolean {
  if (!processIsAlive(claim.ownerPid)) return true;
  const liveStartToken = readProcessStartToken(claim.ownerPid);
  return Boolean(
    claim.ownerStartToken && liveStartToken && claim.ownerStartToken !== liveStartToken,
  );
}

export function localBrowserReattachClaimIsStale(
  claim: BrowserLocalReattachCompletionClaim,
): boolean {
  return browserProcessClaimIsStale(claim);
}

export async function claimLocalBrowserReattachCompletion(
  metadata: SessionMetadata,
  options: { ownedRunAttemptClaimId?: string } = {},
): Promise<BrowserLocalReattachCompletionClaim | null> {
  const expectedGenerationSha256 = computeLocalBrowserReattachGenerationSha256(metadata);
  const owner = currentBrowserProcessClaimOwner();
  const claimId = randomUUID();
  const claimedAt = new Date().toISOString();
  let claimed: BrowserLocalReattachCompletionClaim | null = null;
  await sessionStore.updateSession(metadata.id, async (current) => {
    claimed = null;
    const reconciledCurrent = await reconcileSessionMetadataForCompletionClaim(current);
    if (
      computeLocalBrowserReattachGenerationSha256(reconciledCurrent) !== expectedGenerationSha256
    ) {
      return {};
    }
    const existing = current.browser?.localReattachCompletionClaim;
    if (existing && !localBrowserReattachClaimIsStale(existing)) {
      return {};
    }
    const runAttemptClaim = current.browser?.runAttemptClaim;
    const ownsRunAttempt = runAttemptClaim?.claimId === options.ownedRunAttemptClaimId;
    if (runAttemptClaim && !ownsRunAttempt && !browserProcessClaimIsStale(runAttemptClaim)) {
      return {};
    }
    const browserWithoutStaleRunAttempt =
      runAttemptClaim && !ownsRunAttempt
        ? (({ runAttemptClaim: _staleRunAttempt, ...withoutStaleRunAttempt }) =>
            withoutStaleRunAttempt)(current.browser!)
        : current.browser;
    const claim: BrowserLocalReattachCompletionClaim = {
      schema: "local-browser-reattach-completion-claim.v1",
      claimId,
      originGenerationSha256: computeLocalBrowserReattachGenerationSha256(
        normalizeSessionMetadataForCompletionClaim(current),
      ),
      claimedAt,
      ...owner,
    };
    claimed = claim;
    return {
      browser: {
        ...browserWithoutStaleRunAttempt,
        localReattachCompletionClaim: claim,
      },
    };
  });
  return claimed;
}

export function ownsLocalBrowserReattachCompletion(
  metadata: SessionMetadata,
  claim: BrowserLocalReattachCompletionClaim,
): boolean {
  return (
    metadata.browser?.localReattachCompletionClaim?.claimId === claim.claimId &&
    metadata.browser.localReattachCompletionClaim.originGenerationSha256 ===
      claim.originGenerationSha256 &&
    computeLocalBrowserReattachGenerationSha256(metadata) === claim.originGenerationSha256
  );
}

export async function releaseLocalBrowserReattachCompletion(
  sessionId: string,
  claim: BrowserLocalReattachCompletionClaim,
): Promise<boolean> {
  let released = false;
  await sessionStore.updateSession(sessionId, (current) => {
    released = false;
    if (current.browser?.localReattachCompletionClaim?.claimId !== claim.claimId) {
      return {};
    }
    const { localReattachCompletionClaim: _localClaim, ...browser } = current.browser;
    released = true;
    return { browser };
  });
  return released;
}

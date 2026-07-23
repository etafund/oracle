import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, open, readdir, rename, rm, writeFile } from "node:fs/promises";
import { getSessionPaths } from "../sessionManager.js";
import type { BrowserRemoteRecoveryMetadata } from "../sessionManager.js";
import {
  sanitizeRemoteBrowserPendingRecoveryClaim,
  type RemoteBrowserPendingRecoveryClaim,
  type RemoteBrowserRecoveryCarrier,
} from "./client.js";
import { computePromptSha256 } from "../browser/actions/captureBinding.js";
import { sanitizeRemoteRunRecoveryHint } from "./recovery.js";
import { REMOTE_SESSION_RECOVERY_STAGES } from "./types.js";

const RECOVERY_SECRET_PREFIX = "remote-recovery.";
const PENDING_RECOVERY_CLAIM_SECRET_PREFIX = "remote-recovery-claim.";
const RECOVERY_SECRET_SUFFIX = ".secret.json";
const RECOVERY_SECRET_LOCK_SUFFIX = ".secret.lock";
const MAX_RECOVERY_SECRET_BYTES = 64 * 1024;
const EXECUTABLE_STAGE_SET: ReadonlySet<string> = new Set(REMOTE_SESSION_RECOVERY_STAGES);

export interface StoredRemoteBrowserRecoverySecret extends RemoteBrowserRecoveryCarrier {
  schema: "remote-browser-recovery-secret.v2";
}

export interface StoredRemoteBrowserPendingRecoveryClaim extends RemoteBrowserPendingRecoveryClaim {
  schema: "remote-browser-pending-recovery-claim-secret.v1";
}

export class InvalidStoredRemoteRecoverySecretError extends Error {
  readonly kind: "invalid" | "legacy_protocol";

  constructor(
    message = "Stored remote browser recovery secret is invalid.",
    cause?: unknown,
    kind: "invalid" | "legacy_protocol" = "invalid",
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "InvalidStoredRemoteRecoverySecretError";
    this.kind = kind;
  }
}

export function remoteBrowserRecoverySecretFilename(originRunId: string): string {
  const originKey = createHash("sha256").update(originRunId).digest("hex").slice(0, 32);
  return `${RECOVERY_SECRET_PREFIX}${originKey}${RECOVERY_SECRET_SUFFIX}`;
}

export function remoteBrowserPendingRecoveryClaimFilename(originRunId: string): string {
  const originKey = createHash("sha256").update(originRunId).digest("hex").slice(0, 32);
  return `${PENDING_RECOVERY_CLAIM_SECRET_PREFIX}${originKey}${RECOVERY_SECRET_SUFFIX}`;
}

function secretPath(sessionDir: string, originRunId: string): string {
  return path.join(sessionDir, remoteBrowserRecoverySecretFilename(originRunId));
}

function pendingClaimSecretPath(sessionDir: string, originRunId: string): string {
  return path.join(sessionDir, remoteBrowserPendingRecoveryClaimFilename(originRunId));
}

function secretLockPath(sessionDir: string, originRunId: string): string {
  const filename = remoteBrowserRecoverySecretFilename(originRunId);
  return path.join(
    sessionDir,
    `${filename.slice(0, -RECOVERY_SECRET_SUFFIX.length)}${RECOVERY_SECRET_LOCK_SUFFIX}`,
  );
}

async function withRecoverySecretLock<T>(
  sessionDir: string,
  originRunId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const lockPath = secretLockPath(sessionDir, originRunId);
  const deadline = Date.now() + 5_000;
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  while (!handle) {
    let createdLock = false;
    try {
      handle = await open(lockPath, "wx", 0o600);
      createdLock = true;
      await handle.writeFile(`${process.pid}\n`, "utf8");
    } catch (error) {
      await handle?.close().catch(() => undefined);
      handle = null;
      // If this process created the sentinel but failed while initializing it
      // (for example ENOSPC), no other owner can have acquired the still-
      // existing path. Remove our incomplete lock before propagating/retrying;
      // genuine crash-stale lock reclamation remains a separate problem.
      if (createdLock) {
        await rm(lockPath, { force: true }).catch(() => undefined);
      }
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() >= deadline) {
        throw new Error("Timed out waiting for the remote recovery sidecar lock.");
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }
  }
  try {
    return await operation();
  } finally {
    await handle.close().catch(() => undefined);
    await rm(lockPath, { force: true }).catch(() => undefined);
  }
}

export function toPublicRemoteRecoveryMetadata(
  carrier: RemoteBrowserRecoveryCarrier,
): BrowserRemoteRecoveryMetadata {
  return {
    schema: "remote-browser-recovery-public.v1",
    stage: carrier.recovery.stage,
    originRunId: carrier.recovery.originRunId,
    expiresAt: carrier.recovery.expiresAt,
    accountId: carrier.accountId,
    laneId: carrier.laneId,
    runtime: carrier.recovery.runtime,
  };
}

export async function writeRemoteBrowserRecoverySecret(
  sessionId: string,
  carrier: RemoteBrowserRecoveryCarrier,
): Promise<void> {
  const recovery = sanitizeRemoteRunRecoveryHint(carrier.recovery);
  if (
    !recovery ||
    !EXECUTABLE_STAGE_SET.has(recovery.stage) ||
    !/^[A-Za-z0-9._-]{1,64}$/.test(carrier.accountId) ||
    !(carrier.laneId === null || /^[A-Za-z0-9._-]{1,64}$/.test(carrier.laneId)) ||
    !carrier.promptPreview.trim() ||
    carrier.promptPreview.length > 160 ||
    computePromptSha256(carrier.promptPreview) !== recovery.promptPreviewSha256 ||
    !/^[a-f0-9]{64}$/.test(carrier.promptDomSha256) ||
    carrier.promptDomSha256 !== recovery.promptDomSha256
  ) {
    throw new InvalidStoredRemoteRecoverySecretError(
      "Refusing to persist an invalid remote browser recovery secret.",
    );
  }
  const paths = await getSessionPaths(sessionId);
  const originRunId = carrier.recovery.originRunId;
  const destination = secretPath(paths.dir, originRunId);
  const temporary = `${destination}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  const payload: StoredRemoteBrowserRecoverySecret = {
    schema: "remote-browser-recovery-secret.v2",
    ...carrier,
  };
  await withRecoverySecretLock(paths.dir, originRunId, async () => {
    try {
      await writeFile(temporary, `${JSON.stringify(payload)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      await chmod(temporary, 0o600);
      await rename(temporary, destination);
      await chmod(destination, 0o600);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  });
}

export async function writeRemoteBrowserPendingRecoveryClaim(
  sessionId: string,
  pendingClaim: RemoteBrowserPendingRecoveryClaim,
): Promise<void> {
  const claim = sanitizeRemoteBrowserPendingRecoveryClaim(pendingClaim);
  if (!claim) {
    throw new InvalidStoredRemoteRecoverySecretError(
      "Refusing to persist an invalid pending remote recovery claim.",
    );
  }
  const paths = await getSessionPaths(sessionId);
  const destination = pendingClaimSecretPath(paths.dir, claim.originRunId);
  const temporary = `${destination}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  const payload: StoredRemoteBrowserPendingRecoveryClaim = {
    schema: "remote-browser-pending-recovery-claim-secret.v1",
    ...claim,
  };
  await withRecoverySecretLock(paths.dir, claim.originRunId, async () => {
    try {
      await writeFile(temporary, `${JSON.stringify(payload)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      await chmod(temporary, 0o600);
      await rename(temporary, destination);
      await chmod(destination, 0o600);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  });
}

export async function readRemoteBrowserRecoverySecret(
  sessionId: string,
  expectedOriginRunId?: string,
): Promise<StoredRemoteBrowserRecoverySecret | null> {
  const paths = await getSessionPaths(sessionId);
  let originRunId = expectedOriginRunId;
  if (!originRunId) {
    const candidates = (await readdir(paths.dir).catch(() => []))
      .filter(
        (name) => name.startsWith(RECOVERY_SECRET_PREFIX) && name.endsWith(RECOVERY_SECRET_SUFFIX),
      )
      .sort();
    if (candidates.length === 0) return null;
    if (candidates.length !== 1) {
      throw new InvalidStoredRemoteRecoverySecretError(
        "Multiple origin-bound recovery sidecars exist; an expected origin run is required.",
      );
    }
    const source = path.join(paths.dir, candidates[0]!);
    return await readRemoteBrowserRecoverySecretFile(source);
  }
  return await readRemoteBrowserRecoverySecretFile(secretPath(paths.dir, originRunId));
}

export async function readRemoteBrowserPendingRecoveryClaim(
  sessionId: string,
  expectedOriginRunId?: string,
): Promise<StoredRemoteBrowserPendingRecoveryClaim | null> {
  const paths = await getSessionPaths(sessionId);
  let source: string;
  if (expectedOriginRunId) {
    source = pendingClaimSecretPath(paths.dir, expectedOriginRunId);
  } else {
    const candidates = (await readdir(paths.dir).catch(() => []))
      .filter(
        (name) =>
          name.startsWith(PENDING_RECOVERY_CLAIM_SECRET_PREFIX) &&
          name.endsWith(RECOVERY_SECRET_SUFFIX),
      )
      .sort();
    if (candidates.length === 0) return null;
    if (candidates.length !== 1) {
      throw new InvalidStoredRemoteRecoverySecretError(
        "Multiple pending remote recovery claims exist; an expected origin run is required.",
      );
    }
    source = path.join(paths.dir, candidates[0]!);
  }
  const value = await readPrivateRecoveryJson(source);
  if (!value) return null;
  const { schema, ...rawClaim } = value;
  const claim = sanitizeRemoteBrowserPendingRecoveryClaim(rawClaim);
  if (
    schema !== "remote-browser-pending-recovery-claim-secret.v1" ||
    !claim ||
    (expectedOriginRunId !== undefined && claim.originRunId !== expectedOriginRunId)
  ) {
    throw new InvalidStoredRemoteRecoverySecretError(
      "Stored pending remote recovery claim is invalid.",
    );
  }
  return {
    schema: "remote-browser-pending-recovery-claim-secret.v1",
    ...claim,
  };
}

async function readRemoteBrowserRecoverySecretFile(
  source: string,
): Promise<StoredRemoteBrowserRecoverySecret | null> {
  const value = await readPrivateRecoveryJson(source);
  if (!value) return null;
  if (value.schema === "remote-browser-recovery-secret.v1") {
    throw new InvalidStoredRemoteRecoverySecretError(
      "Legacy remote browser recovery v1 sidecars are guidance-only and cannot be executed.",
      undefined,
      "legacy_protocol",
    );
  }
  const recovery = sanitizeRemoteRunRecoveryHint(value.recovery);
  const accountId = value.accountId;
  const laneId = value.laneId;
  const promptPreview = value.promptPreview;
  const promptDomSha256 = value.promptDomSha256;
  if (
    value.schema !== "remote-browser-recovery-secret.v2" ||
    !recovery ||
    !EXECUTABLE_STAGE_SET.has(recovery.stage) ||
    typeof accountId !== "string" ||
    !/^[A-Za-z0-9._-]{1,64}$/.test(accountId) ||
    !(laneId === null || (typeof laneId === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(laneId))) ||
    typeof promptPreview !== "string" ||
    promptPreview.length > 160 ||
    !promptPreview.trim() ||
    computePromptSha256(promptPreview) !== recovery.promptPreviewSha256 ||
    typeof promptDomSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(promptDomSha256) ||
    promptDomSha256 !== recovery.promptDomSha256
  ) {
    throw new InvalidStoredRemoteRecoverySecretError();
  }
  return {
    schema: "remote-browser-recovery-secret.v2",
    recovery: recovery as StoredRemoteBrowserRecoverySecret["recovery"],
    accountId,
    laneId,
    promptPreview,
    promptDomSha256,
  };
}

async function readPrivateRecoveryJson(source: string): Promise<Record<string, unknown> | null> {
  let raw: string;
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    // O_NOFOLLOW is load-bearing on POSIX: a session-local symlink must never
    // turn this privileged reader into an arbitrary-file reader. On Windows,
    // where O_NOFOLLOW is not supported, ownership/mode semantics are not
    // meaningful and the regular-file fstat check remains authoritative.
    const flags = constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW);
    handle = await open(source, flags);
    const info = await handle.stat();
    const currentUid = typeof process.geteuid === "function" ? process.geteuid() : null;
    if (
      !info.isFile() ||
      info.size > MAX_RECOVERY_SECRET_BYTES ||
      (currentUid !== null && info.uid !== currentUid) ||
      (process.platform !== "win32" && (info.mode & 0o077) !== 0)
    ) {
      throw new InvalidStoredRemoteRecoverySecretError(
        "Stored remote browser recovery secret is not a private owner-only regular file.",
      );
    }
    raw = await handle.readFile("utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    if (error instanceof InvalidStoredRemoteRecoverySecretError) throw error;
    throw new InvalidStoredRemoteRecoverySecretError(
      "Stored remote browser recovery secret could not be opened safely.",
      error,
    );
  } finally {
    await handle?.close().catch(() => undefined);
  }
  let value: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("wrong document shape");
    }
    value = parsed as Record<string, unknown>;
  } catch (error) {
    throw new InvalidStoredRemoteRecoverySecretError(
      "Stored remote browser recovery secret is not valid JSON.",
      error,
    );
  }
  return value;
}

export async function deleteRemoteBrowserRecoverySecret(
  sessionId: string,
  expectedOriginRunId?: string,
): Promise<boolean> {
  const paths = await getSessionPaths(sessionId);
  if (!expectedOriginRunId) {
    const candidates = (await readdir(paths.dir).catch(() => [])).filter(
      (name) => name.startsWith(RECOVERY_SECRET_PREFIX) && name.endsWith(RECOVERY_SECRET_SUFFIX),
    );
    await Promise.all(candidates.map((name) => rm(path.join(paths.dir, name), { force: true })));
    return candidates.length > 0;
  }
  return await withRecoverySecretLock(paths.dir, expectedOriginRunId, async () => {
    const current = await readRemoteBrowserRecoverySecret(sessionId, expectedOriginRunId);
    if (!current || current.recovery.originRunId !== expectedOriginRunId) {
      return false;
    }
    await rm(secretPath(paths.dir, expectedOriginRunId), { force: true });
    return true;
  });
}

export async function deleteRemoteBrowserPendingRecoveryClaim(
  sessionId: string,
  expectedOriginRunId?: string,
): Promise<boolean> {
  const paths = await getSessionPaths(sessionId);
  if (!expectedOriginRunId) {
    const candidates = (await readdir(paths.dir).catch(() => [])).filter(
      (name) =>
        name.startsWith(PENDING_RECOVERY_CLAIM_SECRET_PREFIX) &&
        name.endsWith(RECOVERY_SECRET_SUFFIX),
    );
    await Promise.all(candidates.map((name) => rm(path.join(paths.dir, name), { force: true })));
    return candidates.length > 0;
  }
  return await withRecoverySecretLock(paths.dir, expectedOriginRunId, async () => {
    const current = await readRemoteBrowserPendingRecoveryClaim(sessionId, expectedOriginRunId);
    if (!current || current.originRunId !== expectedOriginRunId) return false;
    await rm(pendingClaimSecretPath(paths.dir, expectedOriginRunId), { force: true });
    return true;
  });
}

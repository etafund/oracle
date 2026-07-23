import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";

import { extractConversationIdFromUrl } from "../browser/conversationIdentity.js";
import {
  acquireImportedConversationLock,
  buildImportedBrowserSessionConfig,
  buildImportedChatgptConversationSessionMetadata,
  parsePureImportedChatgptConversationSession,
} from "../browser/importedConversation.js";
import { isRecoverableChatGptConversationUrl } from "../browser/reattachability.js";
import { createSessionId } from "../sessionManager.js";
import { sessionStore } from "../sessionStore.js";
import type { BrowserSessionConfig, SessionMetadata } from "../sessionStore.js";

const METADATA_FILENAME = "meta.json";

interface FileIdentity {
  dev: bigint;
  ino: bigint;
}

interface MetadataFingerprint extends FileIdentity {
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}

interface PinnedSessionDirectory {
  targetPath: string;
  pinnedPath: string;
  descriptorRooted: boolean;
  identity: FileIdentity;
  handle: FileHandle;
}

/** @internal Deterministic interleaving seam used by import race tests. */
export interface ImportChatgptConversationTestHooks {
  beforeMetadataCommit?: () => void | Promise<void>;
  beforeAtomicRename?: () => void | Promise<void>;
  platform?: NodeJS.Platform;
}

export interface ImportChatgptConversationOptions {
  url: string;
  slug?: string;
  force?: boolean;
  cwd?: string;
  log?: (message: string) => void;
  /** @internal */
  testHooks?: ImportChatgptConversationTestHooks;
}

export interface ValidatedChatgptConversationUrl {
  conversationUrl: string;
  conversationId: string;
}

export function validateChatgptConversationUrl(url: string): ValidatedChatgptConversationUrl {
  const trimmed = url.trim();
  if (!isRecoverableChatGptConversationUrl(trimmed)) {
    throw new Error(
      "ChatGPT import requires an HTTPS conversation URL on chatgpt.com or chat.openai.com with /c/<conversation-id>.",
    );
  }
  const parsed = new URL(trimmed);
  parsed.search = "";
  parsed.hash = "";
  const conversationUrl = parsed.toString();
  const conversationId = extractConversationIdFromUrl(conversationUrl);
  if (!conversationId) {
    throw new Error("Could not extract a durable ChatGPT conversation id from the URL.");
  }
  return { conversationUrl, conversationId };
}

export function buildImportedBrowserConfig(): BrowserSessionConfig {
  return buildImportedBrowserSessionConfig();
}

function identitiesEqual(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function fingerprintFromStats(stats: Awaited<ReturnType<FileHandle["stat"]>>): MetadataFingerprint {
  const bigintStats = stats as unknown as {
    dev: bigint;
    ino: bigint;
    size: bigint;
    mtimeNs: bigint;
    ctimeNs: bigint;
  };
  return {
    dev: bigintStats.dev,
    ino: bigintStats.ino,
    size: bigintStats.size,
    mtimeNs: bigintStats.mtimeNs,
    ctimeNs: bigintStats.ctimeNs,
  };
}

function fingerprintsEqual(left: MetadataFingerprint, right: MetadataFingerprint): boolean {
  return (
    identitiesEqual(left, right) &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

async function assertDirectoryIsCanonicalChild(
  sessionsDirectory: string,
  targetDirectory: string,
  sessionId: string,
): Promise<void> {
  const [canonicalSessions, canonicalTarget] = await Promise.all([
    fs.realpath(sessionsDirectory),
    fs.realpath(targetDirectory),
  ]);
  if (path.dirname(canonicalTarget) !== canonicalSessions) {
    throw new Error(
      `Session "${sessionId}" directory resolves outside Oracle session storage; refusing import.`,
    );
  }
}

async function resolvePinnedDirectoryPath(
  handle: FileHandle,
  fallbackPath: string,
  identity: FileIdentity,
  platform: NodeJS.Platform = process.platform,
): Promise<{ path: string; descriptorRooted: boolean }> {
  const candidate =
    platform === "linux"
      ? `/proc/self/fd/${handle.fd}`
      : platform === "darwin"
        ? `/dev/fd/${handle.fd}`
        : null;
  if (!candidate) {
    return { path: fallbackPath, descriptorRooted: false };
  }
  try {
    const stats = await fs.stat(candidate, { bigint: true });
    if (stats.isDirectory() && identitiesEqual(identity, { dev: stats.dev, ino: stats.ino })) {
      return { path: candidate, descriptorRooted: true };
    }
  } catch {
    // Non-procfs platforms use the pathname plus repeated identity checks.
  }
  return { path: fallbackPath, descriptorRooted: false };
}

async function openPinnedSessionDirectory(
  sessionsDirectory: string,
  targetDirectory: string,
  sessionId: string,
  platform: NodeJS.Platform = process.platform,
): Promise<PinnedSessionDirectory> {
  let pathStats: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    pathStats = await fs.lstat(targetDirectory, { bigint: true });
  } catch (error) {
    throw new Error(`Session "${sessionId}" directory could not be verified; refusing import.`, {
      cause: error,
    });
  }
  if (!pathStats.isDirectory() || pathStats.isSymbolicLink()) {
    throw new Error(
      `Session "${sessionId}" path is not a concrete session directory; refusing to follow or replace it.`,
    );
  }
  await assertDirectoryIsCanonicalChild(sessionsDirectory, targetDirectory, sessionId);

  const flags =
    fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | (fsConstants.O_NOFOLLOW ?? 0);
  const handle = await fs.open(targetDirectory, flags);
  try {
    const handleStats = await handle.stat({ bigint: true });
    const identity = { dev: handleStats.dev, ino: handleStats.ino };
    if (!identitiesEqual(identity, { dev: pathStats.dev, ino: pathStats.ino })) {
      throw new Error(
        `Session "${sessionId}" directory changed while it was being pinned; refusing import.`,
      );
    }
    const pinned = await resolvePinnedDirectoryPath(handle, targetDirectory, identity, platform);
    return {
      targetPath: targetDirectory,
      pinnedPath: pinned.path,
      descriptorRooted: pinned.descriptorRooted,
      identity,
      handle,
    };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function assertDirectoryStillPinned(
  directory: PinnedSessionDirectory,
  sessionsDirectory: string,
  sessionId: string,
): Promise<void> {
  let pathStats: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    pathStats = await fs.lstat(directory.targetPath, { bigint: true });
  } catch (error) {
    throw new Error(
      `Session "${sessionId}" directory changed during import; refusing to publish metadata.`,
      { cause: error },
    );
  }
  const handleStats = await directory.handle.stat({ bigint: true });
  if (
    !pathStats.isDirectory() ||
    pathStats.isSymbolicLink() ||
    !identitiesEqual(directory.identity, { dev: pathStats.dev, ino: pathStats.ino }) ||
    !identitiesEqual(directory.identity, { dev: handleStats.dev, ino: handleStats.ino })
  ) {
    throw new Error(
      `Session "${sessionId}" directory identity changed during import; refusing to publish metadata.`,
    );
  }
  await assertDirectoryIsCanonicalChild(sessionsDirectory, directory.targetPath, sessionId);
}

async function assertExactDirectoryEntries(
  directory: PinnedSessionDirectory,
  expected: readonly string[],
  sessionId: string,
): Promise<void> {
  const entries = (await fs.readdir(directory.pinnedPath)).sort();
  const normalizedExpected = [...expected].sort();
  if (
    entries.length !== normalizedExpected.length ||
    entries.some((entry, index) => entry !== normalizedExpected[index])
  ) {
    throw new Error(
      `Session "${sessionId}" is not a pure imported conversation reference: its directory must contain only ${normalizedExpected.join(", ") || "the empty reservation"}. --force will not overwrite an Oracle run or mixed/tampered metadata.`,
    );
  }
}

async function readPinnedMetadata(
  directory: PinnedSessionDirectory,
  sessionId: string,
): Promise<{ metadata: SessionMetadata; fingerprint: MetadataFingerprint }> {
  const metadataPath = path.join(directory.pinnedPath, METADATA_FILENAME);
  const pathStats = await fs.lstat(metadataPath, { bigint: true });
  if (!pathStats.isFile() || pathStats.isSymbolicLink()) {
    throw new Error(
      `Session "${sessionId}" meta.json is not a regular non-symlink file; refusing --force.`,
    );
  }
  const handle = await fs.open(metadataPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const handleStats = await handle.stat({ bigint: true });
    if (
      !handleStats.isFile() ||
      !identitiesEqual(
        { dev: pathStats.dev, ino: pathStats.ino },
        { dev: handleStats.dev, ino: handleStats.ino },
      )
    ) {
      throw new Error(
        `Session "${sessionId}" meta.json changed while it was being opened; refusing --force.`,
      );
    }
    let metadata: SessionMetadata;
    try {
      metadata = JSON.parse(await handle.readFile("utf8")) as SessionMetadata;
    } catch (error) {
      throw new Error(`Session "${sessionId}" has invalid metadata; refusing --force.`, {
        cause: error,
      });
    }
    return { metadata, fingerprint: fingerprintFromStats(handleStats) };
  } finally {
    await handle.close();
  }
}

async function assertMetadataFingerprint(
  directory: PinnedSessionDirectory,
  expected: MetadataFingerprint,
  sessionId: string,
): Promise<void> {
  const metadataPath = path.join(directory.pinnedPath, METADATA_FILENAME);
  const stats = await fs.lstat(metadataPath, { bigint: true });
  const current: MetadataFingerprint = {
    dev: stats.dev,
    ino: stats.ino,
    size: stats.size,
    mtimeNs: stats.mtimeNs,
    ctimeNs: stats.ctimeNs,
  };
  if (!stats.isFile() || stats.isSymbolicLink() || !fingerprintsEqual(current, expected)) {
    throw new Error(
      `Session "${sessionId}" metadata changed concurrently; refusing to overwrite newer state.`,
    );
  }
}

async function assertMetadataAbsent(
  directory: PinnedSessionDirectory,
  sessionId: string,
): Promise<void> {
  try {
    await fs.lstat(path.join(directory.pinnedPath, METADATA_FILENAME));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
  throw new Error(
    `Session "${sessionId}" metadata appeared concurrently; refusing to overwrite it.`,
  );
}

async function publishPinnedMetadata({
  directory,
  sessionsDirectory,
  sessionId,
  metadata,
  expectedFingerprint,
  hooks,
  assertExclusiveOwnership,
}: {
  directory: PinnedSessionDirectory;
  sessionsDirectory: string;
  sessionId: string;
  metadata: SessionMetadata;
  expectedFingerprint: MetadataFingerprint | null;
  hooks?: ImportChatgptConversationTestHooks;
  assertExclusiveOwnership?: () => Promise<void>;
}): Promise<void> {
  const temporaryName = `.meta.json.import-${process.pid}-${randomUUID()}.tmp`;
  const temporaryPath = path.join(directory.pinnedPath, temporaryName);
  const metadataPath = path.join(directory.pinnedPath, METADATA_FILENAME);
  const temporaryHandle = await fs.open(temporaryPath, "wx", 0o600);
  try {
    await temporaryHandle.writeFile(JSON.stringify(metadata, null, 2), "utf8");
    await temporaryHandle.sync();
  } finally {
    await temporaryHandle.close();
  }

  try {
    await hooks?.beforeMetadataCommit?.();
    await assertExclusiveOwnership?.();
    await assertDirectoryStillPinned(directory, sessionsDirectory, sessionId);
    await assertExactDirectoryEntries(
      directory,
      expectedFingerprint ? [METADATA_FILENAME, temporaryName] : [temporaryName],
      sessionId,
    );
    if (expectedFingerprint) {
      await assertMetadataFingerprint(directory, expectedFingerprint, sessionId);
    } else {
      await assertMetadataAbsent(directory, sessionId);
    }
    await assertExclusiveOwnership?.();
    await assertDirectoryStillPinned(directory, sessionsDirectory, sessionId);
    await hooks?.beforeAtomicRename?.();
    // Re-run every destructive precondition after the final deterministic
    // interleaving boundary. The following rename is one syscall away; raw
    // same-UID writers that ignore Oracle's lock are outside the cooperative
    // filesystem protocol, but every Oracle writer and every observable
    // pre-commit change is refused before replacement.
    await assertExclusiveOwnership?.();
    await assertDirectoryStillPinned(directory, sessionsDirectory, sessionId);
    await assertExactDirectoryEntries(
      directory,
      expectedFingerprint ? [METADATA_FILENAME, temporaryName] : [temporaryName],
      sessionId,
    );
    if (expectedFingerprint) {
      await assertMetadataFingerprint(directory, expectedFingerprint, sessionId);
    } else {
      await assertMetadataAbsent(directory, sessionId);
    }
    await assertExclusiveOwnership?.();
    // On Linux/macOS this rename is rooted at the open directory descriptor,
    // so a pathname swap cannot redirect the commit into a replacement dir.
    await fs.rename(temporaryPath, metadataPath);
    await directory.handle.sync().catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EINVAL" && error.code !== "ENOTSUP") {
        throw error;
      }
    });
    await assertDirectoryStillPinned(directory, sessionsDirectory, sessionId);
    await assertExactDirectoryEntries(directory, [METADATA_FILENAME], sessionId);
    const stored = await readPinnedMetadata(directory, sessionId);
    if (
      !parsePureImportedChatgptConversationSession(stored.metadata, sessionId) ||
      JSON.stringify(stored.metadata) !== JSON.stringify(metadata)
    ) {
      throw new Error(
        `Session "${sessionId}" metadata failed exact-import verification after publication; refusing to report a mismatched write as successful.`,
      );
    }
    await assertExclusiveOwnership?.();
    await assertDirectoryStillPinned(directory, sessionsDirectory, sessionId);
  } finally {
    await fs.unlink(temporaryPath).catch(() => undefined);
  }
}

export async function importChatgptConversation(
  options: ImportChatgptConversationOptions,
): Promise<SessionMetadata> {
  const { conversationUrl, conversationId } = validateChatgptConversationUrl(options.url);
  await sessionStore.ensureStorage();
  const sessionId = createSessionId(`Imported ChatGPT ${conversationId}`, options.slug);
  const sessionsDirectory = sessionStore.sessionsDir();
  const targetDirectory = path.join(sessionsDirectory, sessionId);

  // New imports reserve the exact slug with atomic mkdir and never replace an
  // existing entry, so they remain safe on platforms without descriptor-
  // relative filesystem operations (notably Windows). Existing-session
  // --force takes the mandatory strict lock below.
  let createdDirectory = false;
  try {
    await fs.mkdir(targetDirectory, { mode: 0o700 });
    createdDirectory = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
  }

  const importedAt = new Date().toISOString();
  if (createdDirectory) {
    const directory = await openPinnedSessionDirectory(
      sessionsDirectory,
      targetDirectory,
      sessionId,
      options.testHooks?.platform,
    );
    try {
      await assertExactDirectoryEntries(directory, [], sessionId);
      const created = buildImportedChatgptConversationSessionMetadata({
        sessionId,
        conversationUrl,
        conversationId,
        cwd: options.cwd ?? process.cwd(),
        importedAt,
      });
      await publishPinnedMetadata({
        directory,
        sessionsDirectory,
        sessionId,
        metadata: created,
        expectedFingerprint: null,
        hooks: options.testHooks,
      });
      return created;
    } finally {
      await directory.handle.close();
    }
  }

  if (!options.force) {
    throw new Error(
      `Session "${sessionId}" already exists. Re-run with --force to replace an existing imported conversation reference.`,
    );
  }
  if ((options.testHooks?.platform ?? process.platform) === "win32") {
    throw new Error(
      `ChatGPT import --force is unavailable on Windows because Node does not expose a descriptor-relative atomic rename for the pinned session directory; no metadata was changed. Use WSL/Linux/macOS for --force, or choose a new slug.`,
    );
  }

  const lock = await acquireImportedConversationLock(sessionsDirectory, sessionId, {
    platform: options.testHooks?.platform,
  });
  let metadata: SessionMetadata | undefined;
  let operationError: unknown = null;
  try {
    await lock.assertOwned();
    const directory = await openPinnedSessionDirectory(
      sessionsDirectory,
      targetDirectory,
      sessionId,
      options.testHooks?.platform,
    );
    try {
      if (!directory.descriptorRooted) {
        throw new Error(
          `ChatGPT import --force cannot descriptor-root the pinned session directory on this platform/filesystem; no metadata was changed. Choose a new slug instead.`,
        );
      }
      await assertExactDirectoryEntries(directory, [METADATA_FILENAME], sessionId);
      const existing = await readPinnedMetadata(directory, sessionId);
      if (!parsePureImportedChatgptConversationSession(existing.metadata, sessionId)) {
        throw new Error(
          `Session "${sessionId}" is not a pure imported conversation reference; --force will not overwrite an Oracle run or mixed/tampered metadata.`,
        );
      }
      metadata = buildImportedChatgptConversationSessionMetadata({
        sessionId,
        conversationUrl,
        conversationId,
        cwd: options.cwd ?? process.cwd(),
        importedAt,
        createdAt: existing.metadata.createdAt,
      });
      await publishPinnedMetadata({
        directory,
        sessionsDirectory,
        sessionId,
        metadata,
        expectedFingerprint: existing.fingerprint,
        hooks: options.testHooks,
        assertExclusiveOwnership: () => lock.assertOwned(),
      });
    } finally {
      await directory.handle.close();
    }
  } catch (error) {
    operationError = error;
  }
  try {
    await lock.release();
  } catch (releaseError) {
    if (operationError && typeof operationError === "object") {
      Object.defineProperty(operationError, "importLockReleaseError", {
        value: releaseError,
        configurable: true,
      });
    } else {
      operationError = releaseError;
    }
  }
  if (operationError) {
    throw operationError;
  }
  if (!metadata) {
    throw new Error(`ChatGPT import for session "${sessionId}" produced no metadata.`);
  }
  return metadata;
}

export async function runImportChatgptConversation(
  options: ImportChatgptConversationOptions,
): Promise<SessionMetadata> {
  const metadata = await importChatgptConversation(options);
  const log = options.log ?? console.log;
  log(`Imported ChatGPT conversation as untrusted reference ${metadata.id}.`);
  log("No answer, model/mode proof, lane binding, or account binding was recorded.");
  log("");
  log("Follow up through the explicit local compatibility route:");
  log(
    `  oracle --engine browser --remote-browser off --browser-model-strategy current --followup ${metadata.id} -p "..."`,
  );
  return metadata;
}

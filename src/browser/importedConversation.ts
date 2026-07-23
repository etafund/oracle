import { randomUUID } from "node:crypto";
import { constants as fsConstants, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { CHATGPT_URL } from "./constants.js";
import { extractConversationIdFromUrl } from "./conversationIdentity.js";
import { isRecoverableChatGptConversationUrl } from "./reattachability.js";
import type { BrowserSessionConfig, SessionMetadata } from "../sessionManager.js";

export const IMPORTED_CHATGPT_CONVERSATION_SCHEMA = "chatgpt-conversation-import.v1" as const;
const IMPORT_LOCK_SCHEMA = "chatgpt-conversation-import-lock.v1" as const;
const IMPORT_LOCK_WAIT_MS = 10_000;
const IMPORT_LOCK_POLL_MS = 10;
const IMPORT_LOCK_PARENT_DIRECTORY = "locks";
const IMPORT_LOCK_DIRECTORY = "chatgpt-import";

/**
 * Provenance for a ChatGPT conversation URL registered without an Oracle run.
 *
 * An import proves only that the URL was syntactically valid when it was
 * stored. It deliberately carries no model, mode, account, lane, capture, or
 * prompt-ownership claim. Callers must keep those negative guarantees intact
 * before allowing a compatibility follow-up.
 */
export interface ImportedChatgptConversationMetadata {
  schema: typeof IMPORTED_CHATGPT_CONVERSATION_SCHEMA;
  imported: true;
  source: "manual-url";
  trust: "untrusted";
  accountBinding: "unbound";
  laneBinding: "unbound";
  answerCaptured: false;
  conversationUrl: string;
  conversationId: string;
  importedAt: string;
}

interface ImportedConversationLockOwner {
  schema: typeof IMPORT_LOCK_SCHEMA;
  token: string;
  pid: number;
  processStartTicks: string | null;
  createdAt: string;
}

interface FileIdentity {
  dev: bigint;
  ino: bigint;
}

/** @internal Exposed so race tests can stop at the publication boundary. */
export interface ImportedConversationLockTestHooks {
  beforePublish?: (owner: Readonly<ImportedConversationLockOwner>) => void | Promise<void>;
}

/** @internal Dependency seams for deterministic lock interleavings. */
export interface ImportedConversationLockOptions {
  waitMs?: number;
  pollMs?: number;
  hooks?: ImportedConversationLockTestHooks;
  nowMonotonic?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  token?: string;
  pid?: number;
  processStartTicks?: string | null;
  isProcessAlive?: (pid: number) => boolean;
  readProcessStartTicks?: (pid: number) => string | null;
  platform?: NodeJS.Platform;
}

export interface ImportedConversationLock {
  readonly path: string;
  readonly token: string;
  assertOwned(): Promise<void>;
  release(): Promise<void>;
}

interface PinnedImportLockDirectory {
  targetPath: string;
  rootedPath: string;
  identity: FileIdentity;
  handle: FileHandle;
}

const IMPORTED_CONVERSATION_KEYS = new Set<keyof ImportedChatgptConversationMetadata>([
  "schema",
  "imported",
  "source",
  "trust",
  "accountBinding",
  "laneBinding",
  "answerCaptured",
  "conversationUrl",
  "conversationId",
  "importedAt",
]);

const IMPORTED_SESSION_KEYS = new Set([
  "id",
  "createdAt",
  "status",
  "cwd",
  "mode",
  "models",
  "options",
  "browser",
]);
const IMPORTED_SESSION_OPTION_KEYS = new Set(["file", "models", "slug", "mode", "browserConfig"]);
const IMPORTED_BROWSER_KEYS = new Set(["config", "runtime", "importedConversation"]);
const IMPORTED_RUNTIME_KEYS = new Set(["tabUrl", "conversationId"]);
const IMPORTED_BROWSER_CONFIG_KEYS = new Set([
  "url",
  "chatgptUrl",
  "modelStrategy",
  "desiredModel",
  "archiveConversations",
  "researchMode",
]);
const IMPORT_LOCK_OWNER_KEYS = new Set([
  "schema",
  "token",
  "pid",
  "processStartTicks",
  "createdAt",
]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function hasExactKeys(value: object, expected: ReadonlySet<string>): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.size && keys.every((key) => expected.has(key));
}

function isIsoTimestamp(value: string): boolean {
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function isAlreadyExistsError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null | undefined)?.code === "EEXIST";
}

function identitiesEqual(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function lstatIdentity(filePath: string): Promise<FileIdentity> {
  const stats = await fs.lstat(filePath, { bigint: true });
  return { dev: stats.dev, ino: stats.ino };
}

function readProcessStartTicks(pid: number): string | null {
  if (process.platform !== "linux") {
    return null;
  }
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
    const commandEnd = raw.lastIndexOf(")");
    if (commandEnd < 0) {
      return null;
    }
    const afterCommand = raw
      .slice(commandEnd + 2)
      .trim()
      .split(/\s+/u);
    // /proc/<pid>/stat field 22 is process starttime. `afterCommand`
    // begins at field 3, so starttime is index 19.
    return afterCommand[19] ?? null;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function parseImportLockOwner(raw: string): ImportedConversationLockOwner | null {
  try {
    const candidate = JSON.parse(raw) as Partial<ImportedConversationLockOwner>;
    if (
      !candidate ||
      typeof candidate !== "object" ||
      !hasExactKeys(candidate, IMPORT_LOCK_OWNER_KEYS) ||
      candidate.schema !== IMPORT_LOCK_SCHEMA ||
      typeof candidate.token !== "string" ||
      !UUID_PATTERN.test(candidate.token) ||
      !Number.isSafeInteger(candidate.pid) ||
      (candidate.pid ?? 0) <= 0 ||
      (candidate.processStartTicks !== null && typeof candidate.processStartTicks !== "string") ||
      typeof candidate.createdAt !== "string" ||
      !isIsoTimestamp(candidate.createdAt)
    ) {
      return null;
    }
    return candidate as ImportedConversationLockOwner;
  } catch {
    return null;
  }
}

async function readImportLockOwner(lockPath: string): Promise<{
  owner: ImportedConversationLockOwner;
  identity: FileIdentity;
} | null> {
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    const pathStats = await fs.lstat(lockPath, { bigint: true });
    if (!pathStats.isFile() || pathStats.isSymbolicLink()) {
      return null;
    }
    handle = await fs.open(lockPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const stats = await handle.stat({ bigint: true });
    if (
      !stats.isFile() ||
      !identitiesEqual(
        { dev: pathStats.dev, ino: pathStats.ino },
        { dev: stats.dev, ino: stats.ino },
      )
    ) {
      return null;
    }
    const raw = await handle.readFile("utf8");
    const owner = parseImportLockOwner(raw);
    return owner ? { owner, identity: { dev: stats.dev, ino: stats.ino } } : null;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function ownerIsProvablyDead(
  owner: ImportedConversationLockOwner,
  options: Required<
    Pick<ImportedConversationLockOptions, "isProcessAlive" | "readProcessStartTicks">
  >,
): boolean {
  if (!options.isProcessAlive(owner.pid)) {
    return true;
  }
  const currentStartTicks = options.readProcessStartTicks(owner.pid);
  return (
    owner.processStartTicks !== null &&
    currentStartTicks !== null &&
    owner.processStartTicks !== currentStartTicks
  );
}

async function assertImportLockDirectoryCanonical(
  sessionsDirectory: string,
  lockDirectory: string,
): Promise<void> {
  const stats = await fs.lstat(lockDirectory, { bigint: true });
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(
      `ChatGPT import lock directory "${lockDirectory}" is not a concrete directory; refusing to import unlocked.`,
    );
  }
  const [canonicalSessions, canonicalLockDirectory] = await Promise.all([
    fs.realpath(sessionsDirectory),
    fs.realpath(lockDirectory),
  ]);
  const canonicalOracleHome = path.dirname(canonicalSessions);
  if (
    path.dirname(path.dirname(canonicalLockDirectory)) !== canonicalOracleHome ||
    path.basename(path.dirname(canonicalLockDirectory)) !== IMPORT_LOCK_PARENT_DIRECTORY ||
    path.basename(canonicalLockDirectory) !== IMPORT_LOCK_DIRECTORY
  ) {
    throw new Error(
      `ChatGPT import lock directory resolves outside Oracle session storage; refusing to import unlocked.`,
    );
  }
}

async function openPinnedImportLockDirectory(
  sessionsDirectory: string,
  lockDirectory: string,
  platform: NodeJS.Platform,
): Promise<PinnedImportLockDirectory> {
  await assertImportLockDirectoryCanonical(sessionsDirectory, lockDirectory);
  const pathStats = await fs.lstat(lockDirectory, { bigint: true });
  const flags =
    fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | (fsConstants.O_NOFOLLOW ?? 0);
  const handle = await fs.open(lockDirectory, flags);
  try {
    const handleStats = await handle.stat({ bigint: true });
    const identity = { dev: handleStats.dev, ino: handleStats.ino };
    if (
      !handleStats.isDirectory() ||
      !identitiesEqual(identity, { dev: pathStats.dev, ino: pathStats.ino })
    ) {
      throw new Error(
        `ChatGPT import lock directory changed while it was being pinned; refusing to import unlocked.`,
      );
    }
    const descriptorPath =
      platform === "linux"
        ? `/proc/self/fd/${handle.fd}`
        : platform === "darwin"
          ? `/dev/fd/${handle.fd}`
          : null;
    if (descriptorPath) {
      try {
        const descriptorStats = await fs.stat(descriptorPath, { bigint: true });
        if (
          descriptorStats.isDirectory() &&
          identitiesEqual(identity, { dev: descriptorStats.dev, ino: descriptorStats.ino })
        ) {
          return { targetPath: lockDirectory, rootedPath: descriptorPath, identity, handle };
        }
      } catch {
        // Fall through to the fail-closed error below.
      }
    }
    throw new Error(
      `The mandatory ChatGPT import lock cannot be descriptor-rooted on this platform/filesystem; refusing an existing-session --force instead of using a pathname-racy lock.`,
    );
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function assertImportLockDirectoryStillPinned(
  sessionsDirectory: string,
  directory: PinnedImportLockDirectory,
): Promise<void> {
  const [pathStats, handleStats] = await Promise.all([
    fs.lstat(directory.targetPath, { bigint: true }),
    directory.handle.stat({ bigint: true }),
  ]);
  if (
    !pathStats.isDirectory() ||
    pathStats.isSymbolicLink() ||
    !handleStats.isDirectory() ||
    !identitiesEqual(directory.identity, { dev: pathStats.dev, ino: pathStats.ino }) ||
    !identitiesEqual(directory.identity, { dev: handleStats.dev, ino: handleStats.ino })
  ) {
    throw new Error(
      `ChatGPT import lock directory identity changed while the lock was active; refusing to continue in a split lock namespace.`,
    );
  }
  await assertImportLockDirectoryCanonical(sessionsDirectory, directory.targetPath);
}

async function reclaimProvablyDeadImportLock({
  lockPath,
  lockDirectory,
  sessionId,
  observed,
}: {
  lockPath: string;
  lockDirectory: string;
  sessionId: string;
  observed: { owner: ImportedConversationLockOwner; identity: FileIdentity };
}): Promise<boolean> {
  // SAFETY: the token-specific hard-link is a permanent ABA fence. Once one
  // contender links this exact dead owner's inode, every contender that read
  // the same old token is prevented from unlinking a later owner's lock.
  // Tombstones are intentionally retained: deleting one would reopen that ABA.
  const tombstonePath = path.join(
    lockDirectory,
    `${sessionId}.reclaimed-${observed.owner.token}.lock`,
  );
  try {
    await fs.link(lockPath, tombstonePath);
  } catch (error) {
    if (isAlreadyExistsError(error)) {
      return false;
    }
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return true;
    }
    throw error;
  }

  const [current, tombstoneIdentity] = await Promise.all([
    readImportLockOwner(lockPath),
    lstatIdentity(tombstonePath),
  ]);
  if (
    !current ||
    current.owner.token !== observed.owner.token ||
    !identitiesEqual(current.identity, observed.identity) ||
    !identitiesEqual(tombstoneIdentity, observed.identity)
  ) {
    throw new Error(
      `ChatGPT import lock ownership changed during stale-owner recovery; refusing to import unlocked.`,
    );
  }
  await fs.unlink(lockPath);
  return true;
}

/**
 * Acquire the strict per-slug lock used by manual ChatGPT imports.
 *
 * The complete owner record is written to a private claim file first, then
 * published with `link(2)`. Unlike `open(wx)` followed by `write`, no observer
 * can ever see an ownerless lock. A live owner is never reclaimed by age, and
 * every successful stale-owner reclaim leaves a token-specific hard-link as
 * an ABA fence. Failure to acquire is fatal; imports never proceed unlocked.
 */
export async function acquireImportedConversationLock(
  sessionsDirectory: string,
  sessionId: string,
  options: ImportedConversationLockOptions = {},
): Promise<ImportedConversationLock> {
  if (
    sessionId.length === 0 ||
    sessionId === "." ||
    sessionId === ".." ||
    sessionId.includes("/") ||
    sessionId.includes("\\") ||
    sessionId.includes("\0")
  ) {
    throw new Error(`Invalid ChatGPT import lock session id: "${sessionId}".`);
  }
  const pid = options.pid ?? process.pid;
  const token = options.token ?? randomUUID();
  if (!Number.isSafeInteger(pid) || pid <= 0 || !UUID_PATTERN.test(token)) {
    throw new Error("Invalid ChatGPT import lock owner identity.");
  }
  const nowMonotonic = options.nowMonotonic ?? (() => performance.now());
  const sleep =
    options.sleep ??
    (async (milliseconds: number) => {
      await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
    });
  const liveness = {
    isProcessAlive: options.isProcessAlive ?? isProcessAlive,
    readProcessStartTicks: options.readProcessStartTicks ?? readProcessStartTicks,
  };
  const owner: ImportedConversationLockOwner = {
    schema: IMPORT_LOCK_SCHEMA,
    token,
    pid,
    processStartTicks:
      options.processStartTicks !== undefined
        ? options.processStartTicks
        : readProcessStartTicks(pid),
    createdAt: new Date().toISOString(),
  };
  const lockDirectory = path.join(
    path.dirname(sessionsDirectory),
    IMPORT_LOCK_PARENT_DIRECTORY,
    IMPORT_LOCK_DIRECTORY,
  );
  await fs.mkdir(lockDirectory, { recursive: true, mode: 0o700 });
  const pinnedLockDirectory = await openPinnedImportLockDirectory(
    sessionsDirectory,
    lockDirectory,
    options.platform ?? process.platform,
  );

  const publicLockPath = path.join(lockDirectory, `${sessionId}.lock`);
  const lockPath = path.join(pinnedLockDirectory.rootedPath, `${sessionId}.lock`);
  const claimPath = path.join(pinnedLockDirectory.rootedPath, `${sessionId}.claim-${pid}-${token}`);
  let published = false;
  let returnedLock = false;
  try {
    await assertImportLockDirectoryStillPinned(sessionsDirectory, pinnedLockDirectory);
    const claimHandle = await fs.open(claimPath, "wx", 0o600);
    try {
      await claimHandle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
      await claimHandle.sync();
    } finally {
      await claimHandle.close();
    }

    const deadline = nowMonotonic() + (options.waitMs ?? IMPORT_LOCK_WAIT_MS);
    await options.hooks?.beforePublish?.(owner);
    for (;;) {
      await assertImportLockDirectoryStillPinned(sessionsDirectory, pinnedLockDirectory);
      try {
        await fs.link(claimPath, lockPath);
        const [claimIdentity, current] = await Promise.all([
          lstatIdentity(claimPath),
          readImportLockOwner(lockPath),
        ]);
        if (
          !current ||
          current.owner.token !== token ||
          !identitiesEqual(current.identity, claimIdentity)
        ) {
          throw new Error(
            `ChatGPT import lock ownership could not be verified after publication; refusing to import unlocked.`,
          );
        }
        published = true;
        await fs.unlink(claimPath).catch(() => undefined);
        const acquiredIdentity = current.identity;
        let released = false;
        const assertOwned = async (): Promise<void> => {
          await assertImportLockDirectoryStillPinned(sessionsDirectory, pinnedLockDirectory);
          const latest = await readImportLockOwner(lockPath);
          if (
            !latest ||
            latest.owner.token !== token ||
            !identitiesEqual(latest.identity, acquiredIdentity)
          ) {
            throw new Error(
              `ChatGPT import lock ownership changed; refusing to continue without the exact owner-token lock.`,
            );
          }
        };
        const result: ImportedConversationLock = {
          path: publicLockPath,
          token,
          assertOwned,
          async release(): Promise<void> {
            if (released) {
              return;
            }
            try {
              await assertOwned();
              await fs.unlink(lockPath);
              released = true;
            } finally {
              await pinnedLockDirectory.handle.close();
            }
          },
        };
        returnedLock = true;
        return result;
      } catch (error) {
        if (!isAlreadyExistsError(error)) {
          throw error;
        }
      }

      const observed = await readImportLockOwner(lockPath);
      if (observed && ownerIsProvablyDead(observed.owner, liveness)) {
        if (
          await reclaimProvablyDeadImportLock({
            lockPath,
            lockDirectory: pinnedLockDirectory.rootedPath,
            sessionId,
            observed,
          })
        ) {
          continue;
        }
      }
      if (nowMonotonic() >= deadline) {
        const ownerDescription = observed
          ? `pid ${observed.owner.pid}, token ${observed.owner.token}`
          : "an unreadable owner";
        throw new Error(
          `Timed out waiting for the mandatory ChatGPT import lock for session "${sessionId}" (held by ${ownerDescription}); no metadata was changed.`,
        );
      }
      await sleep(options.pollMs ?? IMPORT_LOCK_POLL_MS);
    }
  } finally {
    if (!published) {
      await fs.unlink(claimPath).catch(() => undefined);
    }
    if (!returnedLock) {
      await pinnedLockDirectory.handle.close().catch(() => undefined);
    }
  }
}

export function buildImportedBrowserSessionConfig() {
  return {
    url: CHATGPT_URL,
    chatgptUrl: CHATGPT_URL,
    modelStrategy: "current" as const,
    desiredModel: null,
    archiveConversations: "never" as const,
    researchMode: "off" as const,
  };
}

/** Build the complete, metadata-only record permitted for a manual import. */
export function buildImportedChatgptConversationSessionMetadata({
  sessionId,
  conversationUrl,
  conversationId,
  cwd,
  importedAt,
  createdAt = importedAt,
}: {
  sessionId: string;
  conversationUrl: string;
  conversationId: string;
  cwd: string;
  importedAt: string;
  createdAt?: string;
}): SessionMetadata {
  const browserConfig = buildImportedBrowserSessionConfig();
  const importedConversation: ImportedChatgptConversationMetadata = {
    schema: IMPORTED_CHATGPT_CONVERSATION_SCHEMA,
    imported: true,
    source: "manual-url",
    trust: "untrusted",
    accountBinding: "unbound",
    laneBinding: "unbound",
    answerCaptured: false,
    conversationUrl,
    conversationId,
    importedAt,
  };
  return {
    id: sessionId,
    createdAt,
    status: "imported",
    cwd,
    mode: "browser",
    models: [],
    options: {
      file: [],
      models: [],
      slug: sessionId,
      mode: "browser",
      browserConfig,
    },
    browser: {
      config: browserConfig,
      runtime: {
        tabUrl: conversationUrl,
        conversationId,
      },
      importedConversation,
    },
  };
}

/** Deny recovery on any record that even claims to be an import, valid or not. */
export function hasImportedChatgptConversationMarker(value: unknown): boolean {
  // `null` is not a valid marker, but it is still an explicit marker claim.
  // Treat only an absent/undefined property as unmarked so corrupted or
  // attacker-controlled records cannot regain recovery, harvest, or writer
  // privileges by replacing the strict marker with JSON null.
  return value !== undefined;
}

/**
 * True when a session claims import semantics by either trust signal.
 *
 * Both signals are fail-closed independently: a raw `status: "imported"`
 * cannot regain ordinary run privileges by dropping the provenance marker,
 * and a present marker cannot regain them by changing the status. This is a
 * denial predicate only; positive import privileges still require
 * {@link parsePureImportedChatgptConversationSession}.
 */
export function hasImportedChatgptConversationClaim(
  metadata: Pick<SessionMetadata, "status" | "browser"> | null | undefined,
): boolean {
  return (
    metadata?.status === "imported" ||
    hasImportedChatgptConversationMarker(metadata?.browser?.importedConversation)
  );
}

export function parseImportedChatgptConversationMetadata(
  value: unknown,
): ImportedChatgptConversationMetadata | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = value as Partial<ImportedChatgptConversationMetadata>;
  if (
    !hasExactKeys(candidate, IMPORTED_CONVERSATION_KEYS) ||
    candidate.schema !== IMPORTED_CHATGPT_CONVERSATION_SCHEMA ||
    candidate.imported !== true ||
    candidate.source !== "manual-url" ||
    candidate.trust !== "untrusted" ||
    candidate.accountBinding !== "unbound" ||
    candidate.laneBinding !== "unbound" ||
    candidate.answerCaptured !== false ||
    typeof candidate.conversationUrl !== "string" ||
    typeof candidate.conversationId !== "string" ||
    typeof candidate.importedAt !== "string" ||
    !isIsoTimestamp(candidate.importedAt) ||
    !isRecoverableChatGptConversationUrl(candidate.conversationUrl) ||
    extractConversationIdFromUrl(candidate.conversationUrl) !== candidate.conversationId
  ) {
    return null;
  }
  return candidate as ImportedChatgptConversationMetadata;
}

export function isImportedBrowserSessionConfig(config: BrowserSessionConfig | undefined): boolean {
  if (!config) {
    return false;
  }
  return (
    hasExactKeys(config, IMPORTED_BROWSER_CONFIG_KEYS) &&
    config.url === CHATGPT_URL &&
    config.chatgptUrl === CHATGPT_URL &&
    config.modelStrategy === "current" &&
    config.desiredModel === null &&
    config.archiveConversations === "never" &&
    config.researchMode === "off"
  );
}

/**
 * Return the provenance marker only when the complete session is the exact,
 * metadata-only shape Oracle writes for a manual import. This is intentionally
 * strict: a real/captured run with a copied marker is not an import and must
 * never become force-replaceable or a compatibility follow-up parent.
 */
export function parsePureImportedChatgptConversationSession(
  metadata: SessionMetadata,
  expectedSessionId?: string,
): ImportedChatgptConversationMetadata | null {
  const imported = parseImportedChatgptConversationMetadata(metadata.browser?.importedConversation);
  const runtime = metadata.browser?.runtime;
  const options = metadata.options;
  if (
    !imported ||
    !hasExactKeys(metadata, IMPORTED_SESSION_KEYS) ||
    (expectedSessionId !== undefined && metadata.id !== expectedSessionId) ||
    typeof metadata.id !== "string" ||
    typeof metadata.cwd !== "string" ||
    typeof metadata.createdAt !== "string" ||
    !isIsoTimestamp(metadata.createdAt) ||
    metadata.status !== "imported" ||
    metadata.mode !== "browser" ||
    !Array.isArray(metadata.models) ||
    metadata.models.length !== 0 ||
    !options ||
    !hasExactKeys(options, IMPORTED_SESSION_OPTION_KEYS) ||
    !Array.isArray(options.file) ||
    options.file.length !== 0 ||
    !Array.isArray(options.models) ||
    options.models.length !== 0 ||
    options.slug !== metadata.id ||
    options.mode !== "browser" ||
    !isImportedBrowserSessionConfig(options.browserConfig) ||
    !metadata.browser ||
    !hasExactKeys(metadata.browser, IMPORTED_BROWSER_KEYS) ||
    !isImportedBrowserSessionConfig(metadata.browser.config) ||
    !runtime ||
    !hasExactKeys(runtime, IMPORTED_RUNTIME_KEYS) ||
    runtime.tabUrl !== imported.conversationUrl ||
    runtime.conversationId !== imported.conversationId
  ) {
    return null;
  }
  return imported;
}

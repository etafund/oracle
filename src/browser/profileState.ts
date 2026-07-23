import path from "node:path";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readlink, rename, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import http from "node:http";
import { promisify } from "node:util";
import { delay } from "./utils.js";

export type ProfileStateLogger = (message: string) => void;

const DEVTOOLS_ACTIVE_PORT_FILENAME = "DevToolsActivePort";
const DEVTOOLS_ACTIVE_PORT_RELATIVE_PATHS = [
  DEVTOOLS_ACTIVE_PORT_FILENAME,
  path.join("Default", DEVTOOLS_ACTIVE_PORT_FILENAME),
] as const;

const CHROME_PID_FILENAME = "chrome.pid";
const CHROME_OWNER_SCHEMA = "oracle.chrome-owner.v1" as const;
const ORACLE_PROFILE_LOCK_FILENAME = "oracle-automation.lock";

const execFileAsync = promisify(execFile);

export function getDevToolsActivePortPaths(userDataDir: string): string[] {
  return DEVTOOLS_ACTIVE_PORT_RELATIVE_PATHS.map((relative) => path.join(userDataDir, relative));
}

export async function readDevToolsPort(userDataDir: string): Promise<number | null> {
  for (const candidate of getDevToolsActivePortPaths(userDataDir)) {
    try {
      const raw = await readFile(candidate, "utf8");
      const firstLine = raw.split(/\r?\n/u)[0]?.trim();
      const port = parsePositiveInteger(firstLine);
      if (port !== null && port <= 65_535) {
        return port;
      }
    } catch {
      // ignore missing/unreadable candidates
    }
  }
  return null;
}

export async function writeDevToolsActivePort(userDataDir: string, port: number): Promise<void> {
  const contents = `${port}\n/devtools/browser`;
  for (const candidate of getDevToolsActivePortPaths(userDataDir)) {
    try {
      await mkdir(path.dirname(candidate), { recursive: true });
      await writeFile(candidate, contents, "utf8");
    } catch {
      // best effort
    }
  }
}

export interface ChromeOwnerRecord {
  schema: typeof CHROME_OWNER_SCHEMA;
  pid: number;
  processStartToken: string;
  userDataDir: string;
  debugPort: number;
}

interface LegacyChromePidRecord {
  schema: "legacy";
  pid: number;
}

type ReadChromeOwnerRecord = ChromeOwnerRecord | LegacyChromePidRecord;

function normalizeProfilePath(value: string): string {
  const normalized = path.resolve(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function parsePositiveInteger(value: unknown): number | null {
  if (typeof value !== "number" && (typeof value !== "string" || !/^\d+$/u.test(value))) {
    return null;
  }
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

async function readChromeOwnerRecord(userDataDir: string): Promise<ReadChromeOwnerRecord | null> {
  const pidPath = path.join(userDataDir, CHROME_PID_FILENAME);
  try {
    const raw = (await readFile(pidPath, "utf8")).trim();
    if (/^\d+$/u.test(raw)) {
      const pid = parsePositiveInteger(raw);
      return pid === null ? null : { schema: "legacy", pid };
    }
    const parsed = JSON.parse(raw) as Partial<ChromeOwnerRecord>;
    const pid = parsePositiveInteger(parsed.pid);
    const debugPort = parsePositiveInteger(parsed.debugPort);
    if (
      parsed.schema !== CHROME_OWNER_SCHEMA ||
      pid === null ||
      debugPort === null ||
      debugPort > 65_535 ||
      typeof parsed.processStartToken !== "string" ||
      parsed.processStartToken.length === 0 ||
      typeof parsed.userDataDir !== "string" ||
      parsed.userDataDir.length === 0
    ) {
      return null;
    }
    return {
      schema: CHROME_OWNER_SCHEMA,
      pid,
      debugPort,
      processStartToken: parsed.processStartToken,
      userDataDir: parsed.userDataDir,
    };
  } catch {
    return null;
  }
}

export async function readChromePid(userDataDir: string): Promise<number | null> {
  return (await readChromeOwnerRecord(userDataDir))?.pid ?? null;
}

/**
 * Persist a generation-bound Chrome owner record. Calls without a debug port
 * retain the legacy numeric format for compatibility with old cleanup-only
 * callers, but legacy records are never trusted for attachment or termination.
 */
export async function writeChromePid(
  userDataDir: string,
  pid: number,
  debugPort?: number,
): Promise<void> {
  const validPid = parsePositiveInteger(pid);
  if (validPid === null) return;
  const pidPath = path.join(userDataDir, CHROME_PID_FILENAME);
  let temporaryPath: string | null = null;
  try {
    await mkdir(path.dirname(pidPath), { recursive: true });
    const validPort = parsePositiveInteger(debugPort);
    const processStartToken = await readProcessStartToken(validPid);
    const payload =
      validPort !== null && validPort <= 65_535 && processStartToken
        ? `${JSON.stringify({
            schema: CHROME_OWNER_SCHEMA,
            pid: validPid,
            processStartToken,
            userDataDir: normalizeProfilePath(userDataDir),
            debugPort: validPort,
          } satisfies ChromeOwnerRecord)}\n`
        : `${validPid}\n`;
    temporaryPath = `${pidPath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, payload, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporaryPath, pidPath);
    temporaryPath = null;
  } catch {
    // best effort
  } finally {
    if (temporaryPath) await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

export interface RunningChromeDebugTarget {
  pid: number;
  port: number;
}

export async function findRunningChromeDebugTargetForProfile(
  userDataDir: string,
): Promise<RunningChromeDebugTarget | null> {
  if (process.platform === "win32") {
    return null;
  }

  try {
    const { stdout } = await execFileAsync("ps", ["-ax", "-o", "pid=", "-o", "command="], {
      maxBuffer: 10 * 1024 * 1024,
    });
    return findChromeDebugTargetForProfileFromProcessList(String(stdout ?? ""), userDataDir);
  } catch {
    return null;
  }
}

function findChromeDebugTargetForProfileFromProcessList(
  processList: string,
  userDataDir: string,
): RunningChromeDebugTarget | null {
  for (const line of processList.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(.+)$/);
    if (!match) continue;
    const pid = Number.parseInt(match[1] ?? "", 10);
    const command = match[2] ?? "";
    if (!Number.isFinite(pid) || pid <= 0) continue;
    if (!isChromeRootCommandForUserDataDir(command, userDataDir)) continue;
    const port = parsePositiveInteger(readCommandFlag(command, "--remote-debugging-port"));
    if (port === null || port > 65_535) continue;
    return { pid, port };
  }
  return null;
}

export function findChromeDebugTargetForProfileFromProcessListForTest(
  processList: string,
  userDataDir: string,
): RunningChromeDebugTarget | null {
  return findChromeDebugTargetForProfileFromProcessList(processList, userDataDir);
}

export type ChromeOwnerVerification =
  | {
      ok: true;
      pid: number;
      port: number;
      processStartToken: string;
      source: "record" | "process-discovery";
    }
  | {
      ok: false;
      reason:
        | "owner-record-missing-or-legacy"
        | "owner-record-profile-mismatch"
        | "owner-record-port-mismatch"
        | "owner-process-not-found"
        | "owner-process-dead"
        | "owner-process-executable-unavailable"
        | "owner-process-executable-mismatch"
        | "owner-process-command-mismatch"
        | "owner-process-generation-unavailable"
        | "owner-process-generation-mismatch";
    };

export interface ChromeOwnerVerificationOptions {
  allowProcessDiscovery?: boolean;
  findRunningTarget?: typeof findRunningChromeDebugTargetForProfile;
  readCommand?: (pid: number) => Promise<string | null>;
  readExecutable?: (pid: number) => Promise<string | null>;
  readStartToken?: (pid: number) => Promise<string | null>;
  processAlive?: (pid: number) => boolean;
}

/**
 * Correlate a DevTools port to one exact Chrome process and profile. This is
 * the single attachment/termination ownership gate: reachability alone is not
 * ownership, and a PID without a birth token is vulnerable to PID reuse.
 */
export async function verifyChromeDebugTargetOwner(
  userDataDir: string,
  port: number,
  options: ChromeOwnerVerificationOptions = {},
): Promise<ChromeOwnerVerification> {
  const expectedProfile = normalizeProfilePath(userDataDir);
  const record = await readChromeOwnerRecord(userDataDir);
  const verifyCandidate = async (
    pid: number,
    expectedStartToken: string | null,
    source: "record" | "process-discovery",
  ): Promise<ChromeOwnerVerification> => {
    if (!(options.processAlive ?? isProcessAlive)(pid)) {
      return { ok: false, reason: "owner-process-dead" };
    }
    const readStartToken = options.readStartToken ?? readProcessStartToken;
    const startTokenBefore = await readStartToken(pid);
    if (!startTokenBefore) {
      return { ok: false, reason: "owner-process-generation-unavailable" };
    }
    const executable = await (options.readExecutable ?? readProcessExecutable)(pid);
    if (!executable) {
      return { ok: false, reason: "owner-process-executable-unavailable" };
    }
    const command = await (options.readCommand ?? readProcessCommand)(pid);
    if (!isProcessCommandForExecutable(command, executable)) {
      return { ok: false, reason: "owner-process-executable-mismatch" };
    }
    if (
      !isChromeRootCommandForUserDataDir(command, userDataDir) ||
      parsePositiveInteger(readCommandFlag(command ?? "", "--remote-debugging-port")) !== port
    ) {
      return { ok: false, reason: "owner-process-command-mismatch" };
    }
    const startTokenAfter = await readStartToken(pid);
    if (!startTokenAfter) {
      return { ok: false, reason: "owner-process-generation-unavailable" };
    }
    if (
      startTokenBefore !== startTokenAfter ||
      (expectedStartToken !== null && startTokenAfter !== expectedStartToken)
    ) {
      return { ok: false, reason: "owner-process-generation-mismatch" };
    }
    return { ok: true, pid, port, processStartToken: startTokenAfter, source };
  };
  const verifyDiscoveredOwner = async (): Promise<ChromeOwnerVerification> => {
    const discovered = await (options.findRunningTarget ?? findRunningChromeDebugTargetForProfile)(
      userDataDir,
    ).catch(() => null);
    if (!discovered || discovered.port !== port) {
      return { ok: false, reason: "owner-process-not-found" };
    }
    return verifyCandidate(discovered.pid, null, "process-discovery");
  };

  if (record?.schema !== CHROME_OWNER_SCHEMA) {
    return options.allowProcessDiscovery === true
      ? verifyDiscoveredOwner()
      : { ok: false, reason: "owner-record-missing-or-legacy" };
  }
  if (normalizeProfilePath(record.userDataDir) !== expectedProfile) {
    return options.allowProcessDiscovery === true
      ? verifyDiscoveredOwner()
      : { ok: false, reason: "owner-record-profile-mismatch" };
  }
  if (record.debugPort !== port) {
    return options.allowProcessDiscovery === true
      ? verifyDiscoveredOwner()
      : { ok: false, reason: "owner-record-port-mismatch" };
  }
  const recordedOwner = await verifyCandidate(record.pid, record.processStartToken, "record");
  if (recordedOwner.ok || options.allowProcessDiscovery !== true) {
    return recordedOwner;
  }
  return verifyDiscoveredOwner();
}

/**
 * Resolve a local profile's current owner even when DevToolsActivePort is
 * stale. A different port is accepted only after the same exact process,
 * profile, Chrome-command, and generation proof succeeds for that port.
 */
export async function resolveChromeDebugTargetOwner(
  userDataDir: string,
  preferredPort: number,
  options: ChromeOwnerVerificationOptions = {},
): Promise<ChromeOwnerVerification> {
  const preferred = await verifyChromeDebugTargetOwner(userDataDir, preferredPort, {
    ...options,
    allowProcessDiscovery: true,
  });
  if (preferred.ok) return preferred;
  const discovered = await (options.findRunningTarget ?? findRunningChromeDebugTargetForProfile)(
    userDataDir,
  ).catch(() => null);
  if (!discovered || discovered.port === preferredPort) return preferred;
  return verifyChromeDebugTargetOwner(userDataDir, discovered.port, {
    ...options,
    allowProcessDiscovery: true,
  });
}

export async function terminateRecordedChromeForProfile(
  userDataDir: string,
  logger?: ProfileStateLogger,
): Promise<boolean> {
  const record = await readChromeOwnerRecord(userDataDir);
  if (record?.schema !== CHROME_OWNER_SCHEMA) {
    return false;
  }
  const verified = await verifyChromeDebugTargetOwner(userDataDir, record.debugPort);
  if (!verified.ok) {
    logger?.(
      `Recorded Chrome pid ${record.pid} failed owner verification (${verified.reason}); skipping termination`,
    );
    return false;
  }
  try {
    process.kill(verified.pid, "SIGTERM");
    logger?.(`Terminated shared manual-login Chrome pid ${verified.pid}`);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger?.(`Failed to terminate shared manual-login Chrome pid ${verified.pid}: ${message}`);
    return false;
  }
}

function isChromeCommandForUserDataDir(command: string | null, userDataDir: string): boolean {
  if (!command) return false;
  const executablePortion = command.split("--", 1)[0] ?? "";
  const looksLikeBrowser = browserExecutableFamily(executableBasename(executablePortion)) !== null;
  const commandProfile = readCommandFlag(command, "--user-data-dir");
  return (
    looksLikeBrowser &&
    commandProfile !== null &&
    normalizeProfilePath(commandProfile) === normalizeProfilePath(userDataDir)
  );
}

function isChromeRootCommandForUserDataDir(command: string | null, userDataDir: string): boolean {
  return isChromeCommandForUserDataDir(command, userDataDir) && !hasCommandFlag(command, "--type");
}

function executableBasename(executable: string): string {
  const normalized = executable
    .replace(/ \(deleted\)$/u, "")
    .replace(/\0+$/gu, "")
    .trim()
    .replace(/^["']|["']$/gu, "");
  return (normalized.split(/[\\/]/u).at(-1) ?? "").toLowerCase();
}

function browserExecutableFamily(basename: string): string | null {
  if (
    /^(?:google chrome(?: (?:beta|canary|dev|for testing))?|google-chrome(?:-(?:beta|stable|unstable))?|chrome(?:-headless-shell)?)(?:\.exe)?$/u.test(
      basename,
    )
  ) {
    return "chrome";
  }
  if (/^chromium(?:-browser)?(?:\.exe)?$/u.test(basename)) return "chromium";
  if (/^brave(?: browser|-browser(?:-(?:beta|nightly|stable))?)?(?:\.exe)?$/u.test(basename)) {
    return "brave";
  }
  if (
    /^(?:microsoft edge(?: (?:beta|canary|dev))?|microsoft-edge(?:-(?:beta|dev|stable))?|msedge)(?:\.exe)?$/u.test(
      basename,
    )
  ) {
    return "edge";
  }
  if (/^vivaldi(?:-bin|-(?:snapshot|stable))?(?:\.exe)?$/u.test(basename)) return "vivaldi";
  if (/^opera(?:-(?:beta|developer|stable))?(?:\.exe)?$/u.test(basename)) return "opera";
  if (/^(?:arc|comet|dia|thorium)(?:\.exe)?$/u.test(basename))
    return basename.replace(/\.exe$/u, "");
  if (/^ungoogled-chromium(?:\.exe)?$/u.test(basename)) return "chromium";
  return null;
}

function isProcessCommandForExecutable(command: string | null, executable: string): boolean {
  if (!command) return false;
  const commandBasename = executableBasename(command.split("--", 1)[0] ?? "");
  const kernelBasename = executableBasename(executable);
  if (!commandBasename || !kernelBasename) return false;
  const commandFamily = browserExecutableFamily(commandBasename);
  return commandFamily !== null && commandFamily === browserExecutableFamily(kernelBasename);
}

export function isProcessCommandForExecutableForTest(
  command: string | null,
  executable: string,
): boolean {
  return isProcessCommandForExecutable(command, executable);
}

export function isChromeCommandForUserDataDirForTest(
  command: string | null,
  userDataDir: string,
): boolean {
  return isChromeCommandForUserDataDir(command, userDataDir);
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means "exists but no permission"; treat as alive.
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: string }).code === "EPERM"
    ) {
      return true;
    }
    return false;
  }
}

export interface ProfileRunLock {
  path: string;
  lockId: string;
  release: () => Promise<void>;
}

interface ProfileRunLockRecord {
  pid: number;
  lockId: string;
  createdAt: string;
  sessionId?: string;
}

function parseProfileRunLock(payload: string | null): ProfileRunLockRecord | null {
  if (!payload) return null;
  try {
    const parsed = JSON.parse(payload) as ProfileRunLockRecord;
    if (!Number.isFinite(parsed.pid) || parsed.pid <= 0) return null;
    if (!parsed.lockId || typeof parsed.lockId !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function acquireProfileRunLock(
  userDataDir: string,
  options: {
    timeoutMs: number;
    pollMs?: number;
    logger?: ProfileStateLogger;
    sessionId?: string;
  },
): Promise<ProfileRunLock | null> {
  const timeoutMs = options.timeoutMs;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return null;
  }
  const pollMs =
    typeof options.pollMs === "number" && Number.isFinite(options.pollMs) && options.pollMs > 0
      ? options.pollMs
      : 1000;
  const lockPath = path.join(userDataDir, ORACLE_PROFILE_LOCK_FILENAME);
  const lockId = randomUUID();
  const startedAt = Date.now();
  let warned = false;

  for (;;) {
    try {
      const payload: ProfileRunLockRecord = {
        pid: process.pid,
        lockId,
        createdAt: new Date().toISOString(),
        sessionId: options.sessionId,
      };
      await mkdir(path.dirname(lockPath), { recursive: true });
      await writeFile(lockPath, JSON.stringify(payload), { encoding: "utf8", flag: "wx" });
      options.logger?.(`Acquired Oracle profile lock at ${lockPath}`);
      return {
        path: lockPath,
        lockId,
        release: async () => releaseProfileRunLock(lockPath, lockId, options.logger),
      };
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code !== "EEXIST") {
        throw error;
      }
      let existing = parseProfileRunLock(await readFile(lockPath, "utf8").catch(() => null));
      if (!existing) {
        // Likely partial write / corruption; re-read once, then delete (user preference: delete unreadable lockfiles).
        await delay(200);
        existing = parseProfileRunLock(await readFile(lockPath, "utf8").catch(() => null));
        if (!existing) {
          options.logger?.("Oracle profile lock unreadable; deleting lockfile.");
          await rm(lockPath, { force: true }).catch(() => undefined);
          continue;
        }
      }
      if (!existing || !isProcessAlive(existing.pid)) {
        await rm(lockPath, { force: true }).catch(() => undefined);
        continue;
      }
      if (!warned) {
        const waited = Math.round(timeoutMs / 1000);
        options.logger?.(
          `Oracle profile lock held by pid ${existing.pid}; waiting up to ${waited}s.`,
        );
        warned = true;
      }
      const elapsed = Date.now() - startedAt;
      if (elapsed >= timeoutMs) {
        throw new Error(
          `Oracle profile lock still held by pid ${existing.pid} after ${Math.round(elapsed / 1000)}s`,
        );
      }
      await delay(Math.min(pollMs, timeoutMs - elapsed));
    }
  }
}

export async function releaseProfileRunLock(
  lockPath: string,
  lockId: string,
  logger?: ProfileStateLogger,
): Promise<void> {
  try {
    const existing = parseProfileRunLock(await readFile(lockPath, "utf8").catch(() => null));
    if (!existing || existing.lockId !== lockId) {
      return;
    }
    await rm(lockPath, { force: true });
    logger?.(`Released Oracle profile lock ${lockPath}`);
  } catch {
    // best effort
  }
}

export async function verifyDevToolsReachable({
  port,
  host = "127.0.0.1",
  attempts = 3,
  timeoutMs = 3000,
}: {
  port: number;
  host?: string;
  attempts?: number;
  timeoutMs?: number;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      await requestDevToolsVersion({ host, port, timeoutMs });
      return { ok: true };
    } catch (error) {
      if (attempt < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
        continue;
      }
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: message };
    }
  }
  return { ok: false, error: "unreachable" };
}

function requestDevToolsVersion({
  host,
  port,
  timeoutMs,
}: {
  host: string;
  port: number;
  timeoutMs: number;
}): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let request: http.ClientRequest | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const settle = (error?: Error): void => {
      if (settled) return;
      settled = true;
      if (deadline) clearTimeout(deadline);
      request?.setTimeout(0);
      if (error) reject(error);
      else resolve();
    };
    deadline = setTimeout(() => {
      const error = new Error(`timed out after ${timeoutMs}ms`);
      settle(error);
      request?.destroy(error);
    }, timeoutMs);
    try {
      request = http.request({ host, port, path: "/json/version", method: "GET" }, (response) => {
        const status = response.statusCode ?? 0;
        if (status < 200 || status >= 300) {
          settle(new Error(`HTTP ${status}`));
          response.destroy();
          return;
        }
        // Drain the tiny DevTools response, but do not declare success until
        // it ends. A peer that sends 2xx headers and then holds the body open
        // remains bounded by the same outer deadline.
        response.once("end", () => settle());
        response.once("error", (error) => settle(error));
        response.resume();
      });
    } catch (error) {
      settle(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    request.setTimeout(timeoutMs, () => {
      const error = new Error(`timed out after ${timeoutMs}ms`);
      settle(error);
      request.destroy(error);
    });
    request.once("error", (error) => settle(error));
    request.end();
  });
}

export async function shouldCleanupManualLoginProfileState(
  userDataDir: string,
  logger?: ProfileStateLogger,
  options: {
    connectionClosedUnexpectedly?: boolean;
    host?: string;
    probe?: typeof verifyDevToolsReachable;
  } = {},
): Promise<boolean> {
  const port = await readDevToolsPort(userDataDir);
  if (!port) {
    return true;
  }
  const probe = await (options.probe ?? verifyDevToolsReachable)({ port, host: options.host });
  if (probe.ok) {
    logger?.(`DevTools port ${port} still reachable; preserving manual-login profile state`);
    return false;
  }
  logger?.(`DevTools port ${port} unreachable (${probe.error}); clearing stale profile state`);
  return true;
}

export async function cleanupStaleProfileState(
  userDataDir: string,
  logger?: ProfileStateLogger,
  options: { lockRemovalMode?: "never" | "if_oracle_pid_dead" } = {},
): Promise<void> {
  for (const candidate of getDevToolsActivePortPaths(userDataDir)) {
    try {
      await rm(candidate, { force: true });
      logger?.(`Removed stale DevToolsActivePort: ${candidate}`);
    } catch {
      // ignore cleanup errors
    }
  }

  const pid = await readChromePid(userDataDir);
  const chromePidAlive = pid ? isProcessAlive(pid) : false;
  if (pid && !chromePidAlive) {
    // chrome.pid is only an advisory ownership hint. Once its exact numeric
    // owner is confirmed dead, retaining it invites a later PID-reuse false
    // match even when lock removal itself is intentionally disabled.
    try {
      await rm(path.join(userDataDir, CHROME_PID_FILENAME), { force: true });
      logger?.(`Removed stale Chrome pid hint ${pid}`);
    } catch {
      // Advisory cleanup must not make profile lock preservation less safe.
    }
  }

  const lockRemovalMode = options.lockRemovalMode ?? "never";
  if (lockRemovalMode === "never") {
    return;
  }

  if (!pid) {
    return;
  }
  if (chromePidAlive) {
    logger?.(`Chrome pid ${pid} still alive; skipping profile lock cleanup`);
    return;
  }

  // Extra safety: if Chrome is running with this profile (but with a different PID, e.g. user relaunched
  // without remote debugging), never delete lock files.
  if (await isChromeUsingUserDataDir(userDataDir)) {
    logger?.("Detected running Chrome using this profile; skipping profile lock cleanup");
    return;
  }

  const lockFiles = [
    path.join(userDataDir, "lockfile"),
    path.join(userDataDir, "SingletonLock"),
    path.join(userDataDir, "SingletonSocket"),
    path.join(userDataDir, "SingletonCookie"),
  ];
  for (const lock of lockFiles) {
    await rm(lock, { force: true }).catch(() => undefined);
  }
  logger?.("Cleaned up stale Chrome profile locks");
}

async function isChromeUsingUserDataDir(userDataDir: string): Promise<boolean> {
  if (process.platform === "win32") {
    // On Windows, lockfiles are typically held open and removal should fail anyway; avoid expensive process scans.
    return false;
  }

  try {
    const { stdout } = await execFileAsync("ps", ["-ax", "-o", "command="], {
      maxBuffer: 10 * 1024 * 1024,
    });
    const lines = String(stdout ?? "").split("\n");
    for (const line of lines) {
      if (!line) continue;
      if (isChromeCommandForUserDataDir(line, userDataDir)) {
        return true;
      }
    }
  } catch {
    // best effort
  }
  return false;
}

function readCommandFlag(command: string, flag: string): string | null {
  if (command.includes("\0")) {
    const args = command.split("\0").filter(Boolean);
    if (args.length > 1) {
      return readCommandFlagFromArgs(args, flag);
    }

    // Chromium can rewrite its Linux process title into one flattened
    // command line followed by a single trailing NUL. Treat that shape as a
    // shell-style command instead of mistaking the entire title for argv[0].
    command = args[0] ?? "";
  }

  const args = tokenizeFlattenedCommand(command);
  return args ? readCommandFlagFromArgs(args, flag) : null;
}

function readCommandFlagFromArgs(args: string[], flag: string): string | null {
  const values: string[] = [];
  let occurrences = 0;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] ?? "";
    if (argument === flag) {
      occurrences += 1;
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) return null;
      values.push(value);
    } else if (argument.startsWith(`${flag}=`)) {
      occurrences += 1;
      values.push(argument.slice(flag.length + 1));
    }
  }
  return occurrences === 1 && values.length === 1 ? values[0] : null;
}

function hasCommandFlag(command: string | null, flag: string): boolean {
  if (!command) return false;
  const nulArgs = command.includes("\0") ? command.split("\0").filter(Boolean) : null;
  const args =
    nulArgs && nulArgs.length > 1 ? nulArgs : tokenizeFlattenedCommand(nulArgs?.[0] ?? command);
  return Boolean(args?.some((argument) => argument === flag || argument.startsWith(`${flag}=`)));
}

function tokenizeFlattenedCommand(command: string): string[] | null {
  const args: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  for (const character of command) {
    if (quote) {
      if (character === quote) quote = null;
      else current += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
    } else if (/\s/u.test(character)) {
      if (current) {
        args.push(current);
        current = "";
      }
    } else {
      current += character;
    }
  }
  if (quote) return null;
  if (current) args.push(current);
  return args;
}

async function readProcessStartToken(pid: number): Promise<string | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  if (process.platform === "linux") {
    try {
      const stat = await readFile(`/proc/${pid}/stat`, "utf8");
      return parseLinuxProcessStartToken(stat);
    } catch {
      return null;
    }
  }
  if (process.platform === "win32") {
    try {
      const { stdout } = await execFileAsync("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `(Get-Process -Id ${Math.trunc(pid)} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`,
      ]);
      const value = String(stdout ?? "").trim();
      return /^\d+$/u.test(value) ? `win32:${value}` : null;
    } catch {
      return null;
    }
  }
  try {
    const { stdout } = await execFileAsync("ps", ["-p", String(Math.trunc(pid)), "-o", "lstart="]);
    const value = String(stdout ?? "")
      .replace(/\s+/gu, " ")
      .trim();
    return value ? `${process.platform}:${value}` : null;
  } catch {
    return null;
  }
}

function parseLinuxProcessStartToken(stat: string): string | null {
  const commandEnd = stat.lastIndexOf(")");
  if (commandEnd < 0) return null;
  // Fields after the closing command parenthesis begin at stat field 3.
  // Process start time is field 22, hence offset 19 in this suffix. Using the
  // last parenthesis keeps spaces and closing parens inside comm from shifting
  // the generation token.
  const suffixFields = stat
    .slice(commandEnd + 1)
    .trim()
    .split(/\s+/u);
  const startTicks = suffixFields[19];
  return startTicks ? `linux:${startTicks}` : null;
}

export function parseLinuxProcessStartTokenForTest(stat: string): string | null {
  return parseLinuxProcessStartToken(stat);
}

async function readProcessCommand(pid: number): Promise<string | null> {
  if (process.platform === "win32") {
    try {
      const { stdout } = await execFileAsync("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `(Get-CimInstance Win32_Process -Filter "ProcessId = ${Math.trunc(pid)}" -ErrorAction Stop).CommandLine`,
      ]);
      const command = String(stdout ?? "").trim();
      return command || null;
    } catch {
      return null;
    }
  }
  if (process.platform === "linux") {
    try {
      const command = await readFile(`/proc/${pid}/cmdline`, "utf8");
      if (command) return command;
    } catch {
      // Fall through to ps for containers with a restricted /proc mount.
    }
  }
  try {
    const { stdout } = await execFileAsync(
      "ps",
      ["-p", String(Math.trunc(pid)), "-o", "command="],
      {
        maxBuffer: 1024 * 1024,
      },
    );
    const command = String(stdout ?? "").trim();
    return command || null;
  } catch {
    return null;
  }
}

async function readProcessExecutable(pid: number): Promise<string | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  if (process.platform === "linux") {
    try {
      return await readlink(`/proc/${pid}/exe`);
    } catch {
      return null;
    }
  }
  if (process.platform === "win32") {
    try {
      const { stdout } = await execFileAsync("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `(Get-CimInstance Win32_Process -Filter "ProcessId = ${Math.trunc(pid)}" -ErrorAction Stop).ExecutablePath`,
      ]);
      const executable = String(stdout ?? "").trim();
      return executable || null;
    } catch {
      return null;
    }
  }
  try {
    const { stdout } = await execFileAsync("ps", ["-p", String(Math.trunc(pid)), "-o", "comm="]);
    const executable = String(stdout ?? "").trim();
    return executable || null;
  } catch {
    return null;
  }
}

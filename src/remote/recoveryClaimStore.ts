import path from "node:path";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { link, mkdir, open, opendir, unlink } from "node:fs/promises";
import { getOracleHomeDir } from "../oracleHome.js";

const CLAIM_SCHEMA = "oracle-remote-recovery-claim.v1";
const CLAIM_STATES = ["pending", "ready", "unrecoverable"] as const;
const ID_PATTERN = /^[A-Za-z0-9._-]+$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const STORAGE_KEY_PATTERN = /^[a-f0-9]{64}$/;
const CLAIM_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MAX_RECORD_BYTES = 64 * 1024;
const MAX_CARRIER_BYTES = 48 * 1024;
const MAX_JSON_DEPTH = 32;
const MAX_JSON_NODES = 10_000;
const DEFAULT_SWEEP_ENTRIES = 256;
const MAX_SWEEP_ENTRIES = 4_096;

export const DEFAULT_RECOVERY_CLAIM_TTL_MS = 12 * 60 * 60 * 1000;
export const MIN_RECOVERY_CLAIM_TTL_MS = 1_000;
export const MAX_RECOVERY_CLAIM_TTL_MS = 24 * 60 * 60 * 1000;

export type RecoveryClaimState = (typeof CLAIM_STATES)[number];

export type RecoveryClaimJsonValue =
  | null
  | boolean
  | number
  | string
  | RecoveryClaimJsonValue[]
  | { [key: string]: RecoveryClaimJsonValue };

export type RecoveryClaimCarrier = Readonly<Record<string, RecoveryClaimJsonValue>>;

export interface RecoveryClaimBinding {
  accountId: string;
  originRunId: string;
  originLaneId: string;
  /** Canonical deduplicated set of the one or two authorized submission branches. */
  promptPreviewSha256Candidates: string[];
}

export interface CreatePendingRecoveryClaimInput extends RecoveryClaimBinding {
  ttlMs?: number;
}

export interface AuthenticatedRecoveryClaimInput extends RecoveryClaimBinding {
  claimKey: string;
}

interface RecoveryClaimCoordinate extends RecoveryClaimBinding {
  expiresAt: string;
}

export interface CreatedPendingRecoveryClaim extends RecoveryClaimCoordinate {
  status: "pending";
  created: true;
  /** Plaintext capability returned once. It is never written to the spool. */
  claimKey: string;
}

export interface ExistingRecoveryClaim extends RecoveryClaimCoordinate {
  status: RecoveryClaimState;
  created: false;
}

export type CreatePendingRecoveryClaimResult = CreatedPendingRecoveryClaim | ExistingRecoveryClaim;

export interface RecoveryClaimNotFound {
  status: "not_found";
}

export interface PendingRecoveryClaim extends RecoveryClaimCoordinate {
  status: "pending";
}

export interface ReadyRecoveryClaim<
  Carrier extends object = RecoveryClaimCarrier,
> extends RecoveryClaimCoordinate {
  status: "ready";
  /** The exact candidate that the browser actually committed. */
  promptPreviewSha256: string;
  carrier: Carrier;
}

export interface UnrecoverableRecoveryClaim extends RecoveryClaimCoordinate {
  status: "unrecoverable";
}

export type RecoveryClaimLookupResult<Carrier extends object = RecoveryClaimCarrier> =
  | RecoveryClaimNotFound
  | PendingRecoveryClaim
  | ReadyRecoveryClaim<Carrier>
  | UnrecoverableRecoveryClaim;

export interface PublishReadyRecoveryClaimInput<
  Carrier extends object,
> extends AuthenticatedRecoveryClaimInput {
  /** The exact committed branch; it must belong to promptPreviewSha256Candidates. */
  promptPreviewSha256: string;
  carrier: Carrier;
}

export interface RecoveryClaimSweepOptions {
  /** Total directory entries examined, including irrelevant entries. */
  maxEntries?: number;
}

export interface RecoveryClaimSweepReport {
  examinedEntries: number;
  claims: number;
  expired: number;
  pending: number;
  ready: number;
  unrecoverable: number;
  truncated: boolean;
}

export interface RecoveryClaimStoreOptions {
  /** Defaults to ~/.oracle/remote-recovery-claims (respecting ORACLE_HOME_DIR). */
  rootDir?: string;
  /** Deterministic clock injection for tests. */
  now?: () => number;
}

interface RecoveryClaimRecordBase extends RecoveryClaimBinding {
  schema: typeof CLAIM_SCHEMA;
  state: RecoveryClaimState;
  claimKeySha256: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

interface PendingRecoveryClaimRecord extends RecoveryClaimRecordBase {
  state: "pending";
}

interface ReadyRecoveryClaimRecord extends RecoveryClaimRecordBase {
  state: "ready";
  promptPreviewSha256: string;
  carrier: RecoveryClaimCarrier;
}

interface UnrecoverableRecoveryClaimRecord extends RecoveryClaimRecordBase {
  state: "unrecoverable";
}

type RecoveryClaimRecord =
  | PendingRecoveryClaimRecord
  | ReadyRecoveryClaimRecord
  | UnrecoverableRecoveryClaimRecord;

interface RecoveryClaimRecordSet {
  pending: PendingRecoveryClaimRecord;
  ready: ReadyRecoveryClaimRecord | null;
  unrecoverable: UnrecoverableRecoveryClaimRecord | null;
}

interface ClaimLocation {
  accountKey: string;
  runKey: string;
  accountDir: string;
  runDir: string;
}

const NOT_FOUND: RecoveryClaimNotFound = Object.freeze({ status: "not_found" });

export class InvalidRecoveryClaimStoreError extends Error {
  constructor(
    message = "The remote recovery-claim store contains invalid state.",
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "InvalidRecoveryClaimStoreError";
  }
}

export class RecoveryClaimConflictError extends Error {
  constructor(message = "The remote recovery claim conflicts with existing immutable state.") {
    super(message);
    this.name = "RecoveryClaimConflictError";
  }
}

export class InvalidRecoveryClaimInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidRecoveryClaimInputError";
  }
}

export function defaultRecoveryClaimSpoolRoot(): string {
  return path.join(getOracleHomeDir(), "remote-recovery-claims");
}

/**
 * A durable, account/run-bound recovery capability store.
 *
 * State files are immutable and append-only: pending.json is published first,
 * then terminal evidence may publish ready.json or unrecoverable.json. Atomic
 * hard-link publication supplies cross-process no-replace semantics, so
 * sibling worker processes can share the spool without trusting process-local
 * state. If terminal publications race, ready is absorbing and authoritative;
 * the unrecoverable marker remains only as audit evidence. `sweep` is
 * intentionally read-only; this module exposes no record deletion API.
 */
export class RecoveryClaimStore<Carrier extends object = RecoveryClaimCarrier> {
  readonly rootDir: string;
  readonly #now: () => number;
  readonly #mutationTails = new Map<string, Promise<void>>();

  constructor(options: RecoveryClaimStoreOptions = {}) {
    const configuredRoot = options.rootDir ?? defaultRecoveryClaimSpoolRoot();
    if (!path.isAbsolute(configuredRoot)) {
      throw new InvalidRecoveryClaimInputError("Recovery-claim spool root must be absolute.");
    }
    const resolvedRoot = path.resolve(configuredRoot);
    if (resolvedRoot === path.parse(resolvedRoot).root) {
      throw new InvalidRecoveryClaimInputError(
        "Recovery-claim spool root must not be the filesystem root.",
      );
    }
    this.rootDir = resolvedRoot;
    this.#now = options.now ?? Date.now;
  }

  async createPending(
    input: CreatePendingRecoveryClaimInput,
  ): Promise<CreatePendingRecoveryClaimResult> {
    const binding = validateBinding(input);
    const ttlMs = validateTtl(input.ttlMs ?? DEFAULT_RECOVERY_CLAIM_TTL_MS);
    const nowMs = this.#currentTime();
    const location = this.#location(binding);
    await this.#ensureLocation(location);

    return await this.#serializeMutation(location.runDir, async () => {
      const current = await readRecordSet(location.runDir);
      if (current) {
        assertStoredPathBinding(current.pending, location);
        if (!bindingMatches(current.pending, binding) || isExpired(current.pending, nowMs)) {
          throw new RecoveryClaimConflictError(
            "A different or expired recovery claim already occupies this account/run binding.",
          );
        }
        return existingResult(current);
      }

      const claimKeyBytes = randomBytes(32);
      const claimKey = claimKeyBytes.toString("base64url");
      const createdAt = toCanonicalTimestamp(nowMs);
      const expiresAt = toCanonicalTimestamp(nowMs + ttlMs);
      const record: PendingRecoveryClaimRecord = {
        schema: CLAIM_SCHEMA,
        state: "pending",
        ...binding,
        claimKeySha256: createHash("sha256").update(claimKeyBytes).digest("hex"),
        createdAt,
        updatedAt: createdAt,
        expiresAt,
      };
      const created = await publishImmutableRecord(
        location.runDir,
        stateFilename("pending"),
        record,
      );
      if (!created) {
        const raced = await readRecordSet(location.runDir);
        if (!raced || !bindingMatches(raced.pending, binding) || isExpired(raced.pending, nowMs)) {
          throw new RecoveryClaimConflictError();
        }
        assertStoredPathBinding(raced.pending, location);
        return existingResult(raced);
      }
      return {
        status: "pending",
        created: true,
        ...publicCoordinate(record),
        claimKey,
      };
    });
  }

  async publishReady(
    input: PublishReadyRecoveryClaimInput<Carrier>,
  ): Promise<RecoveryClaimLookupResult<Carrier>> {
    const binding = validateBinding(input);
    const actualPromptPreviewSha256 = validateActualPromptPreviewHash(
      input.promptPreviewSha256,
      binding.promptPreviewSha256Candidates,
    );
    const location = this.#location(binding);
    if (!(await this.#locationExists(location))) return NOT_FOUND;

    return await this.#serializeMutation(location.runDir, async () => {
      const nowMs = this.#currentTime();
      let current = await readRecordSet(location.runDir);
      if (!authenticatedRecordSet(current, binding, input.claimKey, nowMs)) return NOT_FOUND;
      assertStoredPathBinding(current.pending, location);

      const carrier = canonicalizeCarrier(input.carrier);
      if (current.ready) {
        if (
          current.ready.promptPreviewSha256 !== actualPromptPreviewSha256 ||
          canonicalJson(current.ready.carrier) !== canonicalJson(carrier)
        ) {
          throw new RecoveryClaimConflictError(
            "A ready recovery claim cannot be replaced with a different carrier.",
          );
        }
        return lookupResult(current);
      }

      const record: ReadyRecoveryClaimRecord = {
        ...recordBaseFromPending(current.pending, "ready", nowMs),
        state: "ready",
        promptPreviewSha256: actualPromptPreviewSha256,
        carrier,
      };
      await publishImmutableRecord(location.runDir, stateFilename("ready"), record);
      current = await readRecordSet(location.runDir);
      if (!authenticatedRecordSet(current, binding, input.claimKey, nowMs)) return NOT_FOUND;
      if (
        current.ready &&
        (current.ready.promptPreviewSha256 !== actualPromptPreviewSha256 ||
          canonicalJson(current.ready.carrier) !== canonicalJson(carrier))
      ) {
        throw new RecoveryClaimConflictError(
          "A ready recovery claim cannot be replaced with a different carrier.",
        );
      }
      return lookupResult(current);
    });
  }

  async markUnrecoverable(
    input: AuthenticatedRecoveryClaimInput,
  ): Promise<RecoveryClaimLookupResult<Carrier>> {
    const binding = validateBinding(input);
    const location = this.#location(binding);
    if (!(await this.#locationExists(location))) return NOT_FOUND;

    return await this.#serializeMutation(location.runDir, async () => {
      const nowMs = this.#currentTime();
      let current = await readRecordSet(location.runDir);
      if (!authenticatedRecordSet(current, binding, input.claimKey, nowMs)) return NOT_FOUND;
      assertStoredPathBinding(current.pending, location);
      // Ready is absorbing: once a valid carrier exists, a later terminal
      // failure must never hide or downgrade it.
      if (current.ready) return lookupResult(current);
      if (current.unrecoverable) return lookupResult(current);

      const record: UnrecoverableRecoveryClaimRecord = {
        ...recordBaseFromPending(current.pending, "unrecoverable", nowMs),
        state: "unrecoverable",
      };
      await publishImmutableRecord(location.runDir, stateFilename("unrecoverable"), record);
      current = await readRecordSet(location.runDir);
      if (!authenticatedRecordSet(current, binding, input.claimKey, nowMs)) return NOT_FOUND;
      return lookupResult(current);
    });
  }

  async lookup(
    input: AuthenticatedRecoveryClaimInput,
  ): Promise<RecoveryClaimLookupResult<Carrier>> {
    const binding = validateBinding(input);
    const location = this.#location(binding);
    if (!(await this.#locationExists(location))) return NOT_FOUND;
    const nowMs = this.#currentTime();
    const current = await readRecordSet(location.runDir);
    if (!authenticatedRecordSet(current, binding, input.claimKey, nowMs)) return NOT_FOUND;
    assertStoredPathBinding(current.pending, location);
    return lookupResult(current);
  }

  /**
   * Read-only bounded inspection. Expired records remain immutable on disk and
   * resolve as not_found; callers must use a fresh run id rather than cleanup.
   */
  async sweep(options: RecoveryClaimSweepOptions = {}): Promise<RecoveryClaimSweepReport> {
    const maxEntries = validateSweepLimit(options.maxEntries ?? DEFAULT_SWEEP_ENTRIES);
    const report: RecoveryClaimSweepReport = {
      examinedEntries: 0,
      claims: 0,
      expired: 0,
      pending: 0,
      ready: 0,
      unrecoverable: 0,
      truncated: false,
    };
    if (!(await secureDirectory(this.rootDir, false, false))) return report;
    const nowMs = this.#currentTime();

    outer: for await (const accountEntry of await opendir(this.rootDir)) {
      if (report.examinedEntries >= maxEntries) {
        report.truncated = true;
        break;
      }
      report.examinedEntries += 1;
      if (!STORAGE_KEY_PATTERN.test(accountEntry.name)) continue;
      if (!accountEntry.isDirectory()) {
        throw new InvalidRecoveryClaimStoreError(
          "A recovery-claim account path is not a regular directory.",
        );
      }
      const accountDir = path.join(this.rootDir, accountEntry.name);
      if (!(await secureDirectory(accountDir, false, false))) {
        throw new InvalidRecoveryClaimStoreError("A recovery-claim account directory vanished.");
      }

      for await (const runEntry of await opendir(accountDir)) {
        if (report.examinedEntries >= maxEntries) {
          report.truncated = true;
          break outer;
        }
        report.examinedEntries += 1;
        if (!STORAGE_KEY_PATTERN.test(runEntry.name)) continue;
        if (!runEntry.isDirectory()) {
          throw new InvalidRecoveryClaimStoreError(
            "A recovery-claim run path is not a regular directory.",
          );
        }
        const runDir = path.join(accountDir, runEntry.name);
        if (!(await secureDirectory(runDir, false, false))) {
          throw new InvalidRecoveryClaimStoreError("A recovery-claim run directory vanished.");
        }
        const records = await readRecordSet(runDir);
        if (!records) continue;
        const location: ClaimLocation = {
          accountKey: accountEntry.name,
          runKey: runEntry.name,
          accountDir,
          runDir,
        };
        assertStoredPathBinding(records.pending, location);
        const state = effectiveState(records);
        report.claims += 1;
        report[state] += 1;
        if (isExpired(records.pending, nowMs)) report.expired += 1;
      }
    }
    return report;
  }

  #currentTime(): number {
    const nowMs = this.#now();
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
      throw new InvalidRecoveryClaimInputError("Recovery-claim clock returned an invalid time.");
    }
    // Validate the Date range before any filesystem mutation.
    toCanonicalTimestamp(nowMs);
    return nowMs;
  }

  #location(binding: RecoveryClaimBinding): ClaimLocation {
    const accountKey = storageKey("account", binding.accountId);
    const runKey = storageKey("run", binding.originRunId);
    const accountDir = path.join(this.rootDir, accountKey);
    return {
      accountKey,
      runKey,
      accountDir,
      runDir: path.join(accountDir, runKey),
    };
  }

  async #ensureLocation(location: ClaimLocation): Promise<void> {
    await secureDirectory(this.rootDir, true, true);
    await secureDirectory(location.accountDir, true, false);
    await secureDirectory(location.runDir, true, false);
  }

  async #locationExists(location: ClaimLocation): Promise<boolean> {
    if (!(await secureDirectory(this.rootDir, false, false))) return false;
    if (!(await secureDirectory(location.accountDir, false, false))) return false;
    return await secureDirectory(location.runDir, false, false);
  }

  async #serializeMutation<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#mutationTails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    this.#mutationTails.set(key, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.#mutationTails.get(key) === tail) this.#mutationTails.delete(key);
    }
  }
}

function validateBinding(value: RecoveryClaimBinding): RecoveryClaimBinding {
  if (!isSafeId(value.accountId, 64)) {
    throw new InvalidRecoveryClaimInputError("accountId is invalid.");
  }
  if (!isSafeId(value.originRunId, 128)) {
    throw new InvalidRecoveryClaimInputError("originRunId is invalid.");
  }
  if (!isSafeId(value.originLaneId, 64)) {
    throw new InvalidRecoveryClaimInputError("originLaneId is invalid.");
  }
  const promptPreviewSha256Candidates = normalizeCandidateHashes(
    value.promptPreviewSha256Candidates,
  );
  return {
    accountId: value.accountId,
    originRunId: value.originRunId,
    originLaneId: value.originLaneId,
    promptPreviewSha256Candidates,
  };
}

function normalizeCandidateHashes(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > 2 ||
    value.some((candidate) => typeof candidate !== "string" || !SHA256_PATTERN.test(candidate))
  ) {
    throw new InvalidRecoveryClaimInputError(
      "promptPreviewSha256Candidates must contain one or two lowercase SHA-256 values.",
    );
  }
  return [...new Set(value as string[])].sort();
}

function validateActualPromptPreviewHash(value: unknown, candidates: string[]): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value) || !candidates.includes(value)) {
    throw new InvalidRecoveryClaimInputError(
      "promptPreviewSha256 must be an authorized candidate hash.",
    );
  }
  return value;
}

function isSafeId(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    ID_PATTERN.test(value)
  );
}

function validateTtl(value: number): number {
  if (
    !Number.isSafeInteger(value) ||
    value < MIN_RECOVERY_CLAIM_TTL_MS ||
    value > MAX_RECOVERY_CLAIM_TTL_MS
  ) {
    throw new InvalidRecoveryClaimInputError(
      `Recovery-claim TTL must be an integer between ${MIN_RECOVERY_CLAIM_TTL_MS} and ${MAX_RECOVERY_CLAIM_TTL_MS} ms.`,
    );
  }
  return value;
}

function validateSweepLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_SWEEP_ENTRIES) {
    throw new InvalidRecoveryClaimInputError(
      `Recovery-claim sweep limit must be an integer between 1 and ${MAX_SWEEP_ENTRIES}.`,
    );
  }
  return value;
}

function storageKey(namespace: "account" | "run", value: string): string {
  return createHash("sha256").update(namespace).update("\0").update(value).digest("hex");
}

function stateFilename(state: RecoveryClaimState): string {
  return `${state}.json`;
}

function toCanonicalTimestamp(ms: number): string {
  try {
    return new Date(ms).toISOString();
  } catch {
    throw new InvalidRecoveryClaimInputError("Recovery-claim timestamp is outside the Date range.");
  }
}

function publicCoordinate(record: RecoveryClaimRecordBase): RecoveryClaimCoordinate {
  return {
    accountId: record.accountId,
    originRunId: record.originRunId,
    originLaneId: record.originLaneId,
    promptPreviewSha256Candidates: [...record.promptPreviewSha256Candidates],
    expiresAt: record.expiresAt,
  };
}

function existingResult(records: RecoveryClaimRecordSet): ExistingRecoveryClaim {
  return {
    status: effectiveState(records),
    created: false,
    ...publicCoordinate(records.pending),
  };
}

function lookupResult<Carrier extends object>(
  records: RecoveryClaimRecordSet,
): RecoveryClaimLookupResult<Carrier> {
  const coordinate = publicCoordinate(records.pending);
  if (records.ready) {
    return {
      status: "ready",
      ...coordinate,
      promptPreviewSha256: records.ready.promptPreviewSha256,
      carrier: records.ready.carrier as Carrier,
    };
  }
  if (records.unrecoverable) return { status: "unrecoverable", ...coordinate };
  return { status: "pending", ...coordinate };
}

function effectiveState(records: RecoveryClaimRecordSet): RecoveryClaimState {
  if (records.ready) return "ready";
  if (records.unrecoverable) return "unrecoverable";
  return "pending";
}

function recordBaseFromPending(
  pending: PendingRecoveryClaimRecord,
  state: "ready" | "unrecoverable",
  nowMs: number,
): RecoveryClaimRecordBase {
  if (isExpired(pending, nowMs)) {
    throw new InvalidRecoveryClaimInputError("Cannot transition an expired recovery claim.");
  }
  return {
    schema: CLAIM_SCHEMA,
    state,
    accountId: pending.accountId,
    originRunId: pending.originRunId,
    originLaneId: pending.originLaneId,
    promptPreviewSha256Candidates: [...pending.promptPreviewSha256Candidates],
    claimKeySha256: pending.claimKeySha256,
    createdAt: pending.createdAt,
    updatedAt: toCanonicalTimestamp(nowMs),
    expiresAt: pending.expiresAt,
  };
}

function bindingMatches(record: RecoveryClaimRecordBase, binding: RecoveryClaimBinding): boolean {
  return (
    record.accountId === binding.accountId &&
    record.originRunId === binding.originRunId &&
    record.originLaneId === binding.originLaneId &&
    stringArraysEqual(record.promptPreviewSha256Candidates, binding.promptPreviewSha256Candidates)
  );
}

function stringArraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function authenticatedRecordSet(
  records: RecoveryClaimRecordSet | null,
  binding: RecoveryClaimBinding,
  claimKey: string,
  nowMs: number,
): records is RecoveryClaimRecordSet {
  if (!records) return false;
  const bindingOk = bindingMatches(records.pending, binding);
  const secretOk = claimKeyMatchesHash(claimKey, records.pending.claimKeySha256);
  return bindingOk && secretOk && !isExpired(records.pending, nowMs);
}

function claimKeyMatchesHash(claimKey: unknown, expectedHex: string): boolean {
  let decoded: Buffer | null = null;
  if (typeof claimKey === "string" && CLAIM_KEY_PATTERN.test(claimKey)) {
    const candidate = Buffer.from(claimKey, "base64url");
    if (candidate.length === 32 && candidate.toString("base64url") === claimKey)
      decoded = candidate;
  }
  const suppliedHash = createHash("sha256")
    .update(decoded ?? Buffer.alloc(0))
    .digest();
  const expectedHash = Buffer.from(expectedHex, "hex");
  const equal =
    expectedHash.length === suppliedHash.length && timingSafeEqual(expectedHash, suppliedHash);
  return decoded !== null && equal;
}

function isExpired(record: RecoveryClaimRecordBase, nowMs: number): boolean {
  return Date.parse(record.expiresAt) <= nowMs;
}

function assertStoredPathBinding(record: RecoveryClaimRecordBase, location: ClaimLocation): void {
  if (
    storageKey("account", record.accountId) !== location.accountKey ||
    storageKey("run", record.originRunId) !== location.runKey
  ) {
    throw new InvalidRecoveryClaimStoreError(
      "A recovery-claim record is not stored under its exact account/run binding.",
    );
  }
}

function sameLineage(left: RecoveryClaimRecordBase, right: RecoveryClaimRecordBase): boolean {
  return (
    bindingMatches(left, right) &&
    left.claimKeySha256 === right.claimKeySha256 &&
    left.createdAt === right.createdAt &&
    left.expiresAt === right.expiresAt
  );
}

async function readRecordSet(runDir: string): Promise<RecoveryClaimRecordSet | null> {
  const [pending, ready, unrecoverable] = await Promise.all([
    readRecordFile(path.join(runDir, stateFilename("pending")), "pending"),
    readRecordFile(path.join(runDir, stateFilename("ready")), "ready"),
    readRecordFile(path.join(runDir, stateFilename("unrecoverable")), "unrecoverable"),
  ]);
  if (!pending) {
    if (ready || unrecoverable) {
      throw new InvalidRecoveryClaimStoreError(
        "A terminal recovery-claim record exists without its pending authority.",
      );
    }
    return null;
  }
  if (
    (ready && !sameLineage(pending, ready)) ||
    (unrecoverable && !sameLineage(pending, unrecoverable))
  ) {
    throw new InvalidRecoveryClaimStoreError(
      "Recovery-claim state records disagree on their immutable binding.",
    );
  }
  return { pending, ready, unrecoverable };
}

function readRecordFile(
  filePath: string,
  expectedState: "pending",
): Promise<PendingRecoveryClaimRecord | null>;
function readRecordFile(
  filePath: string,
  expectedState: "ready",
): Promise<ReadyRecoveryClaimRecord | null>;
function readRecordFile(
  filePath: string,
  expectedState: "unrecoverable",
): Promise<UnrecoverableRecoveryClaimRecord | null>;
async function readRecordFile(
  filePath: string,
  expectedState: RecoveryClaimState,
): Promise<RecoveryClaimRecord | null> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    const flags =
      constants.O_RDONLY |
      constants.O_NONBLOCK |
      (process.platform === "win32" ? 0 : constants.O_NOFOLLOW);
    handle = await open(filePath, flags);
    const before = await handle.stat();
    assertPrivateRegularFile(before);
    if (before.size <= 0 || before.size > MAX_RECORD_BYTES) {
      throw new InvalidRecoveryClaimStoreError("A recovery-claim record has an invalid size.");
    }

    const bytes = Buffer.alloc(MAX_RECORD_BYTES + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const chunk = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (chunk.bytesRead === 0) break;
      offset += chunk.bytesRead;
    }
    const after = await handle.stat();
    if (
      offset > MAX_RECORD_BYTES ||
      offset !== before.size ||
      after.size !== before.size ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.mtimeMs !== before.mtimeMs
    ) {
      throw new InvalidRecoveryClaimStoreError(
        "A recovery-claim record changed while it was being read.",
      );
    }
    const raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, offset));
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new InvalidRecoveryClaimStoreError("A recovery-claim record is not valid JSON.", error);
    }
    const record = validateRecord(parsed, expectedState);
    if (raw !== serializeRecord(record)) {
      throw new InvalidRecoveryClaimStoreError(
        "A recovery-claim record is not in its canonical encoding.",
      );
    }
    return record;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    if (error instanceof InvalidRecoveryClaimStoreError) throw error;
    throw new InvalidRecoveryClaimStoreError(
      "A recovery-claim record could not be opened safely.",
      error,
    );
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function assertPrivateRegularFile(info: Stats): void {
  const currentUid = typeof process.geteuid === "function" ? process.geteuid() : null;
  if (
    !info.isFile() ||
    (currentUid !== null && info.uid !== currentUid) ||
    (process.platform !== "win32" && (info.mode & 0o7777) !== 0o600)
  ) {
    throw new InvalidRecoveryClaimStoreError(
      "A recovery-claim record is not a private owner-only regular file.",
    );
  }
}

function validateRecord(value: unknown, expectedState: RecoveryClaimState): RecoveryClaimRecord {
  if (!isPlainRecord(value)) throw new InvalidRecoveryClaimStoreError();
  const baseKeys = [
    "schema",
    "state",
    "accountId",
    "originRunId",
    "originLaneId",
    "promptPreviewSha256Candidates",
    "claimKeySha256",
    "createdAt",
    "updatedAt",
    "expiresAt",
  ];
  const expectedKeys =
    expectedState === "ready" ? [...baseKeys, "promptPreviewSha256", "carrier"] : baseKeys;
  if (!hasExactKeys(value, expectedKeys)) throw new InvalidRecoveryClaimStoreError();
  if (
    value.schema !== CLAIM_SCHEMA ||
    value.state !== expectedState ||
    !isSafeId(value.accountId, 64) ||
    !isSafeId(value.originRunId, 128) ||
    !isSafeId(value.originLaneId, 64) ||
    typeof value.claimKeySha256 !== "string" ||
    !SHA256_PATTERN.test(value.claimKeySha256)
  ) {
    throw new InvalidRecoveryClaimStoreError();
  }
  let promptPreviewSha256Candidates: string[];
  try {
    promptPreviewSha256Candidates = normalizeCandidateHashes(value.promptPreviewSha256Candidates);
  } catch (error) {
    throw new InvalidRecoveryClaimStoreError(
      "A recovery-claim candidate hash set is invalid.",
      error,
    );
  }
  if (
    !Array.isArray(value.promptPreviewSha256Candidates) ||
    !stringArraysEqual(value.promptPreviewSha256Candidates, promptPreviewSha256Candidates)
  ) {
    throw new InvalidRecoveryClaimStoreError(
      "A recovery-claim candidate hash set is not canonical.",
    );
  }
  const createdAt = parseCanonicalTimestamp(value.createdAt);
  const updatedAt = parseCanonicalTimestamp(value.updatedAt);
  const expiresAt = parseCanonicalTimestamp(value.expiresAt);
  const ttlMs = expiresAt.ms - createdAt.ms;
  if (
    ttlMs < MIN_RECOVERY_CLAIM_TTL_MS ||
    ttlMs > MAX_RECOVERY_CLAIM_TTL_MS ||
    updatedAt.ms < createdAt.ms ||
    updatedAt.ms >= expiresAt.ms ||
    (expectedState === "pending" && updatedAt.ms !== createdAt.ms)
  ) {
    throw new InvalidRecoveryClaimStoreError();
  }
  const base: RecoveryClaimRecordBase = {
    schema: CLAIM_SCHEMA,
    state: expectedState,
    accountId: value.accountId,
    originRunId: value.originRunId,
    originLaneId: value.originLaneId,
    promptPreviewSha256Candidates,
    claimKeySha256: value.claimKeySha256,
    createdAt: createdAt.value,
    updatedAt: updatedAt.value,
    expiresAt: expiresAt.value,
  };
  if (expectedState === "ready") {
    let promptPreviewSha256: string;
    try {
      promptPreviewSha256 = validateActualPromptPreviewHash(
        value.promptPreviewSha256,
        promptPreviewSha256Candidates,
      );
    } catch (error) {
      throw new InvalidRecoveryClaimStoreError(
        "A ready recovery claim does not identify an authorized submitted branch.",
        error,
      );
    }
    let carrier: RecoveryClaimCarrier;
    try {
      carrier = canonicalizeCarrier(value.carrier);
    } catch (error) {
      throw new InvalidRecoveryClaimStoreError("A ready recovery carrier is invalid.", error);
    }
    return { ...base, state: "ready", promptPreviewSha256, carrier };
  }
  if (expectedState === "unrecoverable") return { ...base, state: "unrecoverable" };
  return { ...base, state: "pending" };
}

function parseCanonicalTimestamp(value: unknown): { value: string; ms: number } {
  if (typeof value !== "string" || value.length > 64) {
    throw new InvalidRecoveryClaimStoreError();
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new InvalidRecoveryClaimStoreError();
  const canonical = new Date(ms).toISOString();
  if (canonical !== value) throw new InvalidRecoveryClaimStoreError();
  return { value: canonical, ms };
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}

function canonicalizeCarrier(value: unknown): RecoveryClaimCarrier {
  if (!isPlainRecord(value)) {
    throw new InvalidRecoveryClaimInputError("Recovery carrier must be a plain JSON object.");
  }
  const nodes = { count: 0 };
  const seen = new Set<object>();
  const normalized = canonicalizeJsonValue(value, 0, nodes, seen);
  if (!isPlainRecord(normalized)) {
    throw new InvalidRecoveryClaimInputError("Recovery carrier must be a plain JSON object.");
  }
  if (Buffer.byteLength(canonicalJson(normalized), "utf8") > MAX_CARRIER_BYTES) {
    throw new InvalidRecoveryClaimInputError("Recovery carrier exceeds the 48 KiB limit.");
  }
  return normalized as RecoveryClaimCarrier;
}

function canonicalizeJsonValue(
  value: unknown,
  depth: number,
  nodes: { count: number },
  seen: Set<object>,
): RecoveryClaimJsonValue {
  nodes.count += 1;
  if (nodes.count > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) {
    throw new InvalidRecoveryClaimInputError("Recovery carrier is too complex.");
  }
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new InvalidRecoveryClaimInputError("Recovery carrier contains a non-finite number.");
    }
    return value;
  }
  if (typeof value !== "object") {
    throw new InvalidRecoveryClaimInputError("Recovery carrier contains a non-JSON value.");
  }
  if (seen.has(value)) {
    throw new InvalidRecoveryClaimInputError("Recovery carrier contains a cycle.");
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((entry) => canonicalizeJsonValue(entry, depth + 1, nodes, seen));
    }
    if (!isPlainRecord(value)) {
      throw new InvalidRecoveryClaimInputError("Recovery carrier contains a non-plain object.");
    }
    const normalized: Record<string, RecoveryClaimJsonValue> = Object.create(null) as Record<
      string,
      RecoveryClaimJsonValue
    >;
    for (const key of Object.keys(value).sort()) {
      normalized[key] = canonicalizeJsonValue(value[key], depth + 1, nodes, seen);
    }
    return normalized;
  } finally {
    seen.delete(value);
  }
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value);
}

function serializeRecord(record: RecoveryClaimRecord): string {
  const serialized = `${canonicalJson(record)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_RECORD_BYTES) {
    throw new InvalidRecoveryClaimInputError("Recovery-claim record exceeds the 64 KiB limit.");
  }
  return serialized;
}

async function publishImmutableRecord(
  runDir: string,
  filename: string,
  record: RecoveryClaimRecord,
): Promise<boolean> {
  const finalPath = path.join(runDir, filename);
  const temporaryPath = path.join(
    runDir,
    `.${filename}.${process.pid}.${randomUUID().slice(0, 12)}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  let created = false;
  try {
    const flags =
      constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      (process.platform === "win32" ? 0 : constants.O_NOFOLLOW);
    handle = await open(temporaryPath, flags, 0o600);
    await handle.writeFile(serializeRecord(record), "utf8");
    await handle.chmod(0o600);
    await handle.sync();
    const info = await handle.stat();
    assertPrivateRegularFile(info);
    await handle.close();
    handle = null;
    try {
      await link(temporaryPath, finalPath);
      created = true;
      await syncDirectory(runDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    return created;
  } finally {
    await handle?.close().catch(() => undefined);
    // Only the unique temporary inode owned by this operation is removed.
    // Recovery records themselves are append-only and have no deletion path.
    await unlink(temporaryPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") return;
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(
      directory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    await handle.sync();
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function secureDirectory(
  directory: string,
  create: boolean,
  recursive: boolean,
): Promise<boolean> {
  if (create) {
    try {
      await mkdir(directory, { recursive, mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }

  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    if (process.platform === "win32") {
      handle = await open(directory, constants.O_RDONLY);
    } else {
      handle = await open(
        directory,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
      );
    }
    let info = await handle.stat();
    const currentUid = typeof process.geteuid === "function" ? process.geteuid() : null;
    if (!info.isDirectory() || (currentUid !== null && info.uid !== currentUid)) {
      throw new InvalidRecoveryClaimStoreError(
        "A recovery-claim spool path is not an owner-controlled regular directory.",
      );
    }
    if (create && process.platform !== "win32" && (info.mode & 0o7777) !== 0o700) {
      await handle.chmod(0o700);
      info = await handle.stat();
    }
    if (process.platform !== "win32" && (info.mode & 0o7777) !== 0o700) {
      throw new InvalidRecoveryClaimStoreError(
        "A recovery-claim spool directory is not owner-only 0700.",
      );
    }
    return true;
  } catch (error) {
    if (!create && (error as NodeJS.ErrnoException).code === "ENOENT") return false;
    if (error instanceof InvalidRecoveryClaimStoreError) throw error;
    throw new InvalidRecoveryClaimStoreError(
      "A recovery-claim spool directory could not be opened safely.",
      error,
    );
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

import { createHash } from "node:crypto";
import {
  createBrowserLease,
  readBrowserLease,
  releaseBrowserLease,
  type BrowserLeaseStoreOptions,
} from "./leases.js";
import type { BrowserRunOptions, BrowserRunResult } from "./types.js";
import type { BrowserRuntimeMetadata } from "../sessionStore.js";
import { appendEvidenceLedgerEvent } from "../oracle/evidence_ledger.js";
import type {
  BrowserLeaseProvider,
  StoredBrowserLeaseRecord,
} from "../oracle/v18/browser_lease.js";
import { redactBrowserLeaseMetadata } from "../oracle/v18/browser_lease.js";

export interface BrowserLeaseExecutionContext {
  schema_version: "browser_lease_execution.v1";
  lease_id: string;
  provider: BrowserLeaseProvider;
  profile_id_hash: string;
  acquired_at: string;
  expires_at: string;
  ttl_seconds: number;
  safe_recovery_command: string;
  status: "acquired" | "released" | "release_failed";
  release_error?: string;
}

export interface BrowserLeaseIntegrationOptions extends BrowserLeaseStoreOptions {
  provider: BrowserLeaseProvider;
  evidenceHomeDir?: string;
  profileIdHash?: string;
  ttlSeconds?: number;
  holder?: string;
  commandSummary?: string;
  remoteBrowser?: Record<string, unknown>;
  releaseOnCompletion?: boolean;
  onLeaseAcquired?: (record: StoredBrowserLeaseRecord) => void | Promise<void>;
  onLeaseReleased?: (record: StoredBrowserLeaseRecord) => void | Promise<void>;
  onLeaseReleaseFailed?: (record: StoredBrowserLeaseRecord, error: unknown) => void | Promise<void>;
}

export type BrowserExecutor = (options: BrowserRunOptions) => Promise<BrowserRunResult>;

export interface LeasedBrowserRunResult extends BrowserRunResult {
  lease: BrowserLeaseExecutionContext;
}

export type LeasedBrowserExecutor = (options: BrowserRunOptions) => Promise<LeasedBrowserRunResult>;

export function createLeasedBrowserExecutor(
  executeBrowser: BrowserExecutor,
  leaseOptions: BrowserLeaseIntegrationOptions,
): LeasedBrowserExecutor {
  return async (runOptions) => runBrowserWithLease(runOptions, executeBrowser, leaseOptions);
}

export async function runBrowserWithLease(
  runOptions: BrowserRunOptions,
  executeBrowser: BrowserExecutor,
  leaseOptions: BrowserLeaseIntegrationOptions,
): Promise<LeasedBrowserRunResult> {
  const profileIdHash =
    leaseOptions.profileIdHash ?? deriveBrowserLeaseProfileHash(runOptions, leaseOptions.provider);
  const lease = await createBrowserLease(
    {
      provider: leaseOptions.provider,
      profileIdHash,
      ttlSeconds: leaseOptions.ttlSeconds,
      holder: leaseOptions.holder,
      commandSummary: leaseOptions.commandSummary ?? summarizeBrowserRun(runOptions),
      remoteSessionId: runOptions.sessionId,
      remoteBrowser: leaseOptions.remoteBrowser ?? describeRemoteBrowser(runOptions),
    },
    leaseOptions,
  );
  await notifyLeaseHook(() => leaseOptions.onLeaseAcquired?.(lease));
  try {
    await appendBrowserLeaseLedgerEvent(runOptions, lease, "browser_lease_acquired", leaseOptions);
  } catch (error) {
    await releaseBrowserLease(
      {
        provider: leaseOptions.provider,
        profileIdHash,
        leaseId: lease.lease_id,
      },
      leaseOptions,
    ).catch(() => undefined);
    throw error;
  }

  let result: BrowserRunResult | null = null;
  let runError: unknown = null;
  let releaseError: unknown = null;
  let released: StoredBrowserLeaseRecord | null = null;
  const runOptionsWithLease: BrowserRunOptions = {
    ...runOptions,
    runtimeHintCb: async (runtime) => {
      await runOptions.runtimeHintCb?.({
        ...runtime,
        browserLease: leaseEvidence(lease, "acquired"),
      } as BrowserRuntimeMetadata & { browserLease: BrowserLeaseExecutionContext });
    },
  };

  try {
    result = await executeBrowser(runOptionsWithLease);
  } catch (error) {
    runError = error;
  }

  if (leaseOptions.releaseOnCompletion !== false) {
    try {
      const releasedLease = await releaseBrowserLease(
        {
          provider: leaseOptions.provider,
          profileIdHash,
          leaseId: lease.lease_id,
        },
        leaseOptions,
      );
      released = releasedLease;
      await notifyLeaseHook(() => leaseOptions.onLeaseReleased?.(releasedLease));
      await appendBrowserLeaseLedgerEvent(
        runOptions,
        releasedLease,
        "browser_lease_released",
        leaseOptions,
      ).catch((error) => {
        logLeaseLedgerError(runOptions, "release", error);
      });
    } catch (error) {
      releaseError = error;
      await notifyLeaseHook(() => leaseOptions.onLeaseReleaseFailed?.(lease, error));
      await appendBrowserLeaseLedgerEvent(
        runOptions,
        lease,
        "browser_lease_release_failed",
        leaseOptions,
        error,
      ).catch((ledgerError) => {
        logLeaseLedgerError(runOptions, "release_failed", ledgerError);
      });
    }
  }

  if (runError) {
    throw runError;
  }
  if (!result) {
    throw new Error("Browser run did not return a result.");
  }
  return {
    ...result,
    lease: releaseOnResult(lease, released, releaseError),
  };
}

export function deriveBrowserLeaseProfileHash(
  runOptions: BrowserRunOptions,
  provider: BrowserLeaseProvider,
): string {
  return `sha256:${createHash("sha256")
    .update(stableJsonStringify(profileHashInput(runOptions, provider)))
    .digest("hex")}`;
}

export function inferBrowserLeaseProviderFromDesiredModel(
  desiredModel: unknown,
): BrowserLeaseProvider | null {
  if (typeof desiredModel !== "string") {
    return null;
  }
  const normalized = desiredModel
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, "-")
    .replace(/-+/g, "-");
  return normalized.startsWith("gemini") ? "gemini" : null;
}

export function leaseEvidence(
  lease: StoredBrowserLeaseRecord,
  status: BrowserLeaseExecutionContext["status"] = "acquired",
  releaseError?: unknown,
): BrowserLeaseExecutionContext {
  const evidence: BrowserLeaseExecutionContext = {
    schema_version: "browser_lease_execution.v1",
    lease_id: lease.lease_id,
    provider: lease.provider,
    profile_id_hash: lease.profile_id_hash,
    acquired_at: lease.acquired_at,
    expires_at: lease.expires_at,
    ttl_seconds: lease.ttl_seconds,
    safe_recovery_command: lease.safe_recovery_command,
    status,
  };
  if (releaseError) {
    evidence.release_error = stringifyError(releaseError);
  }
  return evidence;
}

function releaseOnResult(
  lease: StoredBrowserLeaseRecord,
  released: StoredBrowserLeaseRecord | null,
  releaseError: unknown,
): BrowserLeaseExecutionContext {
  if (releaseError) {
    return leaseEvidence(lease, "release_failed", releaseError);
  }
  return leaseEvidence(released ?? lease, released ? "released" : "acquired");
}

function summarizeBrowserRun(runOptions: BrowserRunOptions): string {
  const providerHint = runOptions.config?.url ?? runOptions.config?.chatgptUrl ?? "browser";
  const sessionPart = runOptions.sessionId ? ` session=${runOptions.sessionId}` : "";
  return `oracle browser run provider=${providerHint}${sessionPart}`;
}

function describeRemoteBrowser(runOptions: BrowserRunOptions): Record<string, unknown> {
  const remoteChrome = runOptions.config?.remoteChrome;
  if (remoteChrome) {
    return {
      mode: "remote-chrome",
      host_hash: sha256(`${remoteChrome.host}:${remoteChrome.port}`),
    };
  }
  if (runOptions.config?.attachRunning) {
    return { mode: "attach-running" };
  }
  return { mode: "local-browser" };
}

function profileHashInput(
  runOptions: BrowserRunOptions,
  provider: BrowserLeaseProvider,
): Record<string, unknown> {
  const config = runOptions.config ?? {};
  return {
    provider,
    url: config.chatgptUrl ?? config.url ?? null,
    chrome_profile: config.chromeProfile ?? null,
    manual_login: config.manualLogin ?? null,
    manual_login_profile_dir: config.manualLoginProfileDir ?? null,
    remote_chrome_profile_root: config.remoteChromeProfileRoot ?? null,
    attach_running: config.attachRunning ?? null,
    remote_chrome: config.remoteChrome
      ? {
          host_hash: sha256(`${config.remoteChrome.host}:${config.remoteChrome.port}`),
          port: config.remoteChrome.port,
        }
      : null,
  };
}

function stableJsonStringify(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sortJson(entry));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const record = value as Record<string, unknown>;
  return Object.keys(record)
    .sort()
    .reduce<Record<string, unknown>>((acc, key) => {
      const sorted = sortJson(record[key]);
      if (sorted !== undefined) {
        acc[key] = sorted;
      }
      return acc;
    }, {});
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function appendBrowserLeaseLedgerEvent(
  runOptions: BrowserRunOptions,
  record: StoredBrowserLeaseRecord,
  action: "browser_lease_acquired" | "browser_lease_released" | "browser_lease_release_failed",
  leaseOptions: BrowserLeaseIntegrationOptions,
  releaseError?: unknown,
): Promise<void> {
  if (!runOptions.sessionId) {
    return;
  }
  const metadata: Record<string, unknown> = {
    action,
    browser_lease: redactBrowserLeaseMetadata(record),
  };
  if (releaseError) {
    metadata.release_error = stringifyError(releaseError);
  }
  await appendEvidenceLedgerEvent(
    runOptions.sessionId,
    {
      type: "browser_attached",
      metadata,
    },
    {
      homeDir: leaseOptions.evidenceHomeDir,
      now: leaseOptions.now,
    },
  );
}

function logLeaseLedgerError(
  runOptions: BrowserRunOptions,
  phase: "release" | "release_failed",
  error: unknown,
): void {
  runOptions.log?.(
    `[browser] failed to append browser lease ${phase} ledger entry: ${stringifyError(error)}`,
  );
}

async function notifyLeaseHook(hook: () => void | Promise<void> | undefined): Promise<void> {
  try {
    await hook();
  } catch {
    // Lease hooks are observers; they must not strand or mask provider cleanup.
  }
}

// ─── session-scoped lease release (oracle cancel teardown) ──────────────────
//
// Every browser lease provider is a single-active-lease-per-profile lock
// keyed by provider name; a live run stamps the owning `remote_session_id`
// onto the record. `oracle cancel <id>` needs to hand that lock back so a
// killed controller does not strand the profile/tab slot. This reads each
// provider's current lease and, when it is the one this session holds,
// releases it through the same locked mutation path the normal run uses.

/** The browser lease providers Oracle takes leases against. */
const BROWSER_LEASE_PROVIDERS: readonly BrowserLeaseProvider[] = ["chatgpt", "gemini"];

/** Outcome of releasing (or finding no) session-held lease for one provider. */
export interface ReleasedSessionLease {
  provider: BrowserLeaseProvider;
  lease_id: string;
  status: "released" | "release_failed" | "not_held";
  release_error?: string;
}

export interface ReleaseSessionBrowserLeasesOptions extends BrowserLeaseStoreOptions {
  /** Restrict the scan to these providers (defaults to all). */
  providers?: readonly BrowserLeaseProvider[];
}

/**
 * Release any active browser lease held for `sessionId`. Never throws:
 * the cancel teardown must mark a session cancelled even if a dangling
 * lease can't be released, so failures are reported in the result instead
 * of propagating. A provider whose current lease belongs to a different
 * session (or none) is skipped without a `not_held` entry.
 */
export async function releaseSessionBrowserLeases(
  sessionId: string,
  options: ReleaseSessionBrowserLeasesOptions = {},
): Promise<ReleasedSessionLease[]> {
  const providers = options.providers ?? BROWSER_LEASE_PROVIDERS;
  const results: ReleasedSessionLease[] = [];
  for (const provider of providers) {
    let read: Awaited<ReturnType<typeof readBrowserLease>>;
    try {
      read = await readBrowserLease(provider, options);
    } catch {
      continue;
    }
    if (read.state === "missing" || read.state === "corrupt") {
      continue;
    }
    const record = read.record;
    if (!record || record.remote_session_id !== sessionId) {
      continue;
    }
    if (read.state === "released") {
      results.push({ provider, lease_id: record.lease_id, status: "not_held" });
      continue;
    }
    try {
      const released = await releaseBrowserLease(
        { provider, profileIdHash: record.profile_id_hash, leaseId: record.lease_id },
        options,
      );
      results.push({ provider, lease_id: released.lease_id, status: "released" });
    } catch (error) {
      results.push({
        provider,
        lease_id: record.lease_id,
        status: "release_failed",
        release_error: stringifyError(error),
      });
    }
  }
  return results;
}

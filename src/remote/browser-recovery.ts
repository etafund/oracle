import { createHash } from "node:crypto";

import type { JsonEnvelope } from "../oracle/v18/contracts.js";
import { createErrorEnvelope } from "../oracle/v18/json_envelope.js";
import {
  REMOTE_BROWSER_RECOVERY_SCHEMA_VERSION,
  type RemoteBrowserRecoveryFailure,
  type RemoteBrowserRecoveryFailureInput,
} from "../types/remote-recovery.js";

const DOCS_REMOTE_BROWSER = "docs/browser-mode.md#remote-browser-example";
const DOCS_REMOTE_DEBUG = "docs/debug/remote-chrome.md";

export class RemoteBrowserRecoveryError extends Error {
  readonly failure: RemoteBrowserRecoveryFailure;

  constructor(failure: RemoteBrowserRecoveryFailure) {
    super(failure.message);
    this.name = "RemoteBrowserRecoveryError";
    this.failure = failure;
  }
}

export function hashRemoteBrowserHost(host: string | undefined): string | undefined {
  const trimmed = host?.trim();
  if (!trimmed) return undefined;
  return createHash("sha256").update(trimmed).digest("hex").slice(0, 12);
}

export function createRemoteBrowserRecoveryFailure(
  input: RemoteBrowserRecoveryFailureInput,
): RemoteBrowserRecoveryFailure {
  switch (input.kind) {
    case "remote_browser_token_missing":
      return {
        schema_version: REMOTE_BROWSER_RECOVERY_SCHEMA_VERSION,
        ok: false,
        kind: input.kind,
        error_code: "remote_browser_token_missing",
        blocked_reason: "remote_browser_token_missing",
        message:
          input.message ?? "A remote browser host is configured but no token was provided.",
        next_command: "export ORACLE_REMOTE_TOKEN=<token>",
        fix_command: "oracle config set browser.remoteToken <token>",
        retry_safe: false,
        required_env: ["ORACLE_REMOTE_TOKEN"],
        docs_url_or_path: DOCS_REMOTE_BROWSER,
        ...(input.hostHash ? { host_hash: input.hostHash } : {}),
        ...(input.details ? { details: input.details } : {}),
      };
    case "remote_browser_host_unreachable":
      return {
        schema_version: REMOTE_BROWSER_RECOVERY_SCHEMA_VERSION,
        ok: false,
        kind: input.kind,
        error_code: "remote_browser_unavailable",
        blocked_reason: "remote_browser_unavailable",
        message: input.message ?? "Remote browser host is unreachable.",
        next_command: "oracle remote doctor --json",
        fix_command: "Start or restart `oracle serve` on the configured remote host.",
        retry_safe: true,
        docs_url_or_path: DOCS_REMOTE_BROWSER,
        ...(input.hostHash ? { host_hash: input.hostHash } : {}),
        ...(input.details ? { details: input.details } : {}),
      };
    case "remote_browser_auth_failed":
      return {
        schema_version: REMOTE_BROWSER_RECOVERY_SCHEMA_VERSION,
        ok: false,
        kind: input.kind,
        error_code: "remote_browser_auth_failed",
        blocked_reason: "remote_browser_auth_failed",
        message: input.message ?? "Remote browser host rejected the configured token.",
        next_command: "oracle remote doctor --json",
        fix_command: "Refresh ORACLE_REMOTE_TOKEN or browser.remoteToken on this client.",
        retry_safe: false,
        required_env: ["ORACLE_REMOTE_TOKEN"],
        docs_url_or_path: DOCS_REMOTE_BROWSER,
        ...(input.hostHash ? { host_hash: input.hostHash } : {}),
        ...(input.details ? { details: input.details } : {}),
      };
    case "remote_browser_profile_unavailable":
      return {
        schema_version: REMOTE_BROWSER_RECOVERY_SCHEMA_VERSION,
        ok: false,
        kind: input.kind,
        error_code: "remote_browser_unavailable",
        blocked_reason: "remote_browser_unavailable",
        message:
          input.message ??
          "Remote browser profile is unavailable or locked by another recovery path.",
        next_command: "oracle remote doctor --json",
        fix_command:
          "Release the remote browser profile lock or complete remote browser login on the host.",
        retry_safe: false,
        docs_url_or_path: DOCS_REMOTE_DEBUG,
        ...(input.hostHash ? { host_hash: input.hostHash } : {}),
        ...(input.details ? { details: input.details } : {}),
      };
    case "provider_login_required":
      return {
        schema_version: REMOTE_BROWSER_RECOVERY_SCHEMA_VERSION,
        ok: false,
        kind: input.kind,
        error_code: "provider_login_required",
        blocked_reason: "provider_login_required",
        provider: input.provider,
        message:
          input.message ??
          `Remote browser provider ${input.provider} requires an interactive login.`,
        next_command: "oracle remote doctor --json",
        fix_command:
          "On the remote host, run a manual-login browser session and complete provider login.",
        retry_safe: false,
        docs_url_or_path: DOCS_REMOTE_BROWSER,
        ...(input.hostHash ? { host_hash: input.hostHash } : {}),
        ...(input.details ? { details: input.details } : {}),
      };
    case "remote_browser_required_unavailable":
      return {
        schema_version: REMOTE_BROWSER_RECOVERY_SCHEMA_VERSION,
        ok: false,
        kind: input.kind,
        error_code: "remote_browser_unavailable",
        blocked_reason: "remote_browser_unavailable",
        message:
          input.message ??
          "Remote browser mode is required, but the remote endpoint is unavailable.",
        next_command: "oracle remote doctor --json",
        fix_command:
          "Set ORACLE_REMOTE_HOST and start `oracle serve`, or change ORACLE_REMOTE_BROWSER from required to preferred/off.",
        retry_safe: false,
        required_env: ["ORACLE_REMOTE_BROWSER", "ORACLE_REMOTE_HOST"],
        docs_url_or_path: DOCS_REMOTE_BROWSER,
        ...(input.hostHash ? { host_hash: input.hostHash } : {}),
        ...(input.details ? { details: input.details } : {}),
      };
    case "remote_browser_health_stale":
      return {
        schema_version: REMOTE_BROWSER_RECOVERY_SCHEMA_VERSION,
        ok: false,
        kind: input.kind,
        error_code: "remote_browser_unavailable",
        blocked_reason: "remote_browser_unavailable",
        message: input.message ?? "Remote browser health check is stale.",
        next_command: "oracle remote doctor --json",
        fix_command: "Refresh remote browser health before starting a recovery run.",
        retry_safe: true,
        stale_after_ms: input.staleAfterMs,
        observed_age_ms: input.observedAgeMs,
        docs_url_or_path: DOCS_REMOTE_DEBUG,
        ...(input.hostHash ? { host_hash: input.hostHash } : {}),
        ...(input.details ? { details: input.details } : {}),
      };
    default: {
      const exhaustive: never = input;
      return exhaustive;
    }
  }
}

export function toRemoteBrowserRecoveryEnvelope(
  failure: RemoteBrowserRecoveryFailure,
): JsonEnvelope {
  const data: Record<string, unknown> = { ...failure };
  return createErrorEnvelope(
    {
      errors: [
        {
          error_code: failure.error_code,
          message: failure.message,
          details: {
            kind: failure.kind,
            ...(failure.required_env ? { required_env: failure.required_env } : {}),
            docs_url_or_path: failure.docs_url_or_path,
            ...(failure.host_hash ? { host_hash: failure.host_hash } : {}),
            ...(failure.details ? failure.details : {}),
          },
        },
      ],
      meta: {
        recovery_schema_version: failure.schema_version,
        failure_kind: failure.kind,
      },
      data,
      next_command: failure.next_command,
      fix_command: failure.fix_command,
      retry_safe: failure.retry_safe,
      blocked_reason: failure.blocked_reason,
    },
  );
}

export function createRemoteBrowserRecoveryError(
  input: RemoteBrowserRecoveryFailureInput,
): RemoteBrowserRecoveryError {
  return new RemoteBrowserRecoveryError(createRemoteBrowserRecoveryFailure(input));
}

export function shouldAutoRetryRemoteBrowserRecovery(
  failure: RemoteBrowserRecoveryFailure,
): boolean {
  return failure.retry_safe === true;
}

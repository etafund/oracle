import type { V18ErrorCode } from "../oracle/v18/json_envelope.js";

export const REMOTE_BROWSER_RECOVERY_SCHEMA_VERSION = "remote_browser_recovery_failure.v1";

export type RemoteBrowserRecoveryFailureKind =
  | "remote_browser_token_missing"
  | "remote_browser_host_unreachable"
  | "remote_browser_auth_failed"
  | "remote_browser_profile_unavailable"
  | "provider_login_required"
  | "remote_browser_required_unavailable"
  | "remote_browser_health_stale";

export type RemoteBrowserRequiredEnv =
  | "ORACLE_REMOTE_HOST"
  | "ORACLE_REMOTE_TOKEN"
  | "ORACLE_REMOTE_BROWSER";

export interface RemoteBrowserRecoveryFailureBase {
  readonly schema_version: typeof REMOTE_BROWSER_RECOVERY_SCHEMA_VERSION;
  readonly ok: false;
  readonly kind: RemoteBrowserRecoveryFailureKind;
  readonly error_code: V18ErrorCode;
  readonly blocked_reason: V18ErrorCode;
  readonly message: string;
  readonly next_command: string;
  readonly fix_command: string;
  readonly retry_safe: boolean;
  readonly docs_url_or_path: string;
  readonly required_env?: readonly RemoteBrowserRequiredEnv[];
  readonly host_hash?: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface RemoteBrowserTokenMissingFailure extends RemoteBrowserRecoveryFailureBase {
  readonly kind: "remote_browser_token_missing";
  readonly error_code: "remote_browser_token_missing";
  readonly blocked_reason: "remote_browser_token_missing";
  readonly retry_safe: false;
  readonly required_env: readonly ["ORACLE_REMOTE_TOKEN"];
}

export interface RemoteBrowserHostUnreachableFailure extends RemoteBrowserRecoveryFailureBase {
  readonly kind: "remote_browser_host_unreachable";
  readonly error_code: "remote_browser_unavailable";
  readonly blocked_reason: "remote_browser_unavailable";
}

export interface RemoteBrowserAuthFailedFailure extends RemoteBrowserRecoveryFailureBase {
  readonly kind: "remote_browser_auth_failed";
  readonly error_code: "remote_browser_auth_failed";
  readonly blocked_reason: "remote_browser_auth_failed";
  readonly retry_safe: false;
  readonly required_env: readonly ["ORACLE_REMOTE_TOKEN"];
}

export interface RemoteBrowserProfileUnavailableFailure extends RemoteBrowserRecoveryFailureBase {
  readonly kind: "remote_browser_profile_unavailable";
  readonly error_code: "remote_browser_unavailable";
  readonly blocked_reason: "remote_browser_unavailable";
  readonly retry_safe: false;
}

export interface ProviderLoginRequiredFailure extends RemoteBrowserRecoveryFailureBase {
  readonly kind: "provider_login_required";
  readonly error_code: "provider_login_required";
  readonly blocked_reason: "provider_login_required";
  readonly retry_safe: false;
  readonly provider: "chatgpt" | "gemini" | (string & {});
}

export interface RemoteBrowserRequiredUnavailableFailure extends RemoteBrowserRecoveryFailureBase {
  readonly kind: "remote_browser_required_unavailable";
  readonly error_code: "remote_browser_unavailable";
  readonly blocked_reason: "remote_browser_unavailable";
  readonly retry_safe: false;
  readonly required_env: readonly ["ORACLE_REMOTE_BROWSER", "ORACLE_REMOTE_HOST"];
}

export interface RemoteBrowserHealthStaleFailure extends RemoteBrowserRecoveryFailureBase {
  readonly kind: "remote_browser_health_stale";
  readonly error_code: "remote_browser_unavailable";
  readonly blocked_reason: "remote_browser_unavailable";
  readonly retry_safe: true;
  readonly stale_after_ms: number;
  readonly observed_age_ms: number;
}

export type RemoteBrowserRecoveryFailure =
  | RemoteBrowserTokenMissingFailure
  | RemoteBrowserHostUnreachableFailure
  | RemoteBrowserAuthFailedFailure
  | RemoteBrowserProfileUnavailableFailure
  | ProviderLoginRequiredFailure
  | RemoteBrowserRequiredUnavailableFailure
  | RemoteBrowserHealthStaleFailure;

export type RemoteBrowserRecoveryFailureInput =
  | {
      readonly kind: "remote_browser_token_missing";
      readonly hostHash?: string;
      readonly message?: string;
      readonly details?: Readonly<Record<string, unknown>>;
    }
  | {
      readonly kind: "remote_browser_host_unreachable";
      readonly hostHash?: string;
      readonly message?: string;
      readonly details?: Readonly<Record<string, unknown>>;
    }
  | {
      readonly kind: "remote_browser_auth_failed";
      readonly hostHash?: string;
      readonly message?: string;
      readonly details?: Readonly<Record<string, unknown>>;
    }
  | {
      readonly kind: "remote_browser_profile_unavailable";
      readonly hostHash?: string;
      readonly message?: string;
      readonly details?: Readonly<Record<string, unknown>>;
    }
  | {
      readonly kind: "provider_login_required";
      readonly provider: "chatgpt" | "gemini" | (string & {});
      readonly hostHash?: string;
      readonly message?: string;
      readonly details?: Readonly<Record<string, unknown>>;
    }
  | {
      readonly kind: "remote_browser_required_unavailable";
      readonly hostHash?: string;
      readonly message?: string;
      readonly details?: Readonly<Record<string, unknown>>;
    }
  | {
      readonly kind: "remote_browser_health_stale";
      readonly staleAfterMs: number;
      readonly observedAgeMs: number;
      readonly hostHash?: string;
      readonly message?: string;
      readonly details?: Readonly<Record<string, unknown>>;
    };

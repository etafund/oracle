import type { BrowserSessionConfig } from "../sessionStore.js";
import type { BrowserRunResult } from "../browserMode.js";
import type { BrowserAttachment } from "../browser/types.js";

export interface RemoteAttachmentPayload {
  fileName: string;
  displayPath: string;
  sizeBytes?: number;
  contentBase64: string;
}

export interface RemoteRunPayload {
  prompt: string;
  attachments: RemoteAttachmentPayload[];
  fallbackSubmission?: {
    prompt: string;
    attachments: RemoteAttachmentPayload[];
  };
  browserConfig: BrowserSessionConfig;
  options: {
    heartbeatIntervalMs?: number;
    verbose?: boolean;
    sessionId?: string;
    followUpPrompts?: string[];
  };
}

export type RemoteRunEvent =
  | { type: "log"; message: string }
  | { type: "result"; result: BrowserRunResult }
  | { type: "error"; message: string };

export interface RemoteActiveRunInfo {
  id: string;
  startedAt: string;
  ageSeconds: number;
  clientConnected: boolean;
  promptChars: number;
  sessionId?: string;
  desiredModel?: string;
}

export interface SerializedAttachment extends BrowserAttachment {
  fileName: string;
  contentBase64: string;
}

export interface RemoteBrowserEndpointV1 {
  _schema: "remote_browser_endpoint.v1";
  endpoint_id: string;
  mode: "preferred" | "required" | "off";
  status:
    | "healthy"
    | "busy"
    | "unreachable"
    | "auth_failed"
    | "missing_token"
    | "not_configured"
    | "unknown";
  host_env: string | null;
  token_env: string | null;
  host_hash: string | null;
  auth_profile_id_hash: string | null;
  no_plaintext_secrets: boolean;
  shared_profile_policy: boolean;
  provider_locks: string[];
  doctor_command: string;
  recover_command: string;
  version: string | null;
  uptimeSeconds: number | null;
  busy?: boolean;
  activeRun?: RemoteActiveRunInfo | null;
  error?: string;
}

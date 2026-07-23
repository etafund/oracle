import type http from "node:http";

import {
  REMOTE_BROWSER_RECOVERY_ADMISSION_HEADER_VALUES,
  REMOTE_BROWSER_RECOVERY_PROTOCOL,
  MAX_REMOTE_ARTIFACT_BYTES,
} from "../../src/remote/types.js";
import {
  PROMPT_DOM_IDENTITY_ALGORITHM,
  PROMPT_RECOVERY_PREVIEW_ALGORITHM,
} from "../../src/browser/promptDomMatch.js";

/** Serve the authenticated capability probe used by production remote clients. */
export function serveCompatibleRecoveryHealth(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): boolean {
  if (req.method !== "GET" || req.url !== "/health") return false;
  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      ok: true,
      busy: false,
      capabilities: {
        artifactTransfer: true,
        artifactProtocolVersion: 1,
        maxArtifactBytes: MAX_REMOTE_ARTIFACT_BYTES,
        browserRecovery: {
          protocol: REMOTE_BROWSER_RECOVERY_PROTOCOL,
          promptPreviewAlgorithm: PROMPT_RECOVERY_PREVIEW_ALGORITHM,
          promptDomIdentityAlgorithm: PROMPT_DOM_IDENTITY_ALGORITHM,
        },
      },
    }),
  );
  return true;
}

/** Install the worker's same-response protocol echo before a fake run replies. */
export function setCompatibleRecoveryResponseHeaders(res: http.ServerResponse): void {
  for (const [name, value] of Object.entries(REMOTE_BROWSER_RECOVERY_ADMISSION_HEADER_VALUES)) {
    res.setHeader(name, value);
  }
  if (!res.hasHeader("x-oracle-run-id")) res.setHeader("x-oracle-run-id", "fixture-run");
  if (!res.hasHeader("x-oracle-account-id")) res.setHeader("x-oracle-account-id", "acct1");
  if (!res.hasHeader("x-oracle-lane-id")) res.setHeader("x-oracle-lane-id", "acct1-9473");
}

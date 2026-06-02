import type { SessionMetadata } from "../sessionStore.js";
import { CHATGPT_URL } from "../browser/constants.js";
import {
  buildConversationUrl,
  extractConversationIdFromUrl,
} from "../browser/reattachHelpers.js";

export interface BrowserFollowupResolution {
  sessionId: string;
  resumeConversationUrl: string;
}

export interface FollowupSessionReader {
  readSession(sessionId: string): Promise<SessionMetadata | null>;
}

export function resolveBrowserResumeConversationUrl(
  metadata: SessionMetadata,
  fallbackBaseUrl = CHATGPT_URL,
): string | null {
  const runtime = metadata.browser?.runtime;
  if (!runtime) {
    return null;
  }
  const baseUrl = metadata.browser?.config?.url ?? fallbackBaseUrl;
  const directUrl = buildConversationUrl(runtime, baseUrl);
  if (directUrl) {
    return directUrl;
  }
  const conversationId =
    runtime.conversationId ?? extractConversationIdFromUrl(runtime.tabUrl ?? "");
  if (!conversationId) {
    return null;
  }
  return buildConversationUrl({ conversationId }, baseUrl);
}

export async function resolveBrowserFollowupReference(
  value: string,
  store: FollowupSessionReader,
): Promise<BrowserFollowupResolution | null> {
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith("resp_")) {
    return null;
  }

  const metadata = await store.readSession(trimmed);
  if (!metadata) {
    return null;
  }
  const mode = metadata.mode ?? metadata.options?.mode;
  const hasBrowserMetadata = Boolean(
    metadata.browser?.runtime || metadata.browser?.config || metadata.options?.browserConfig,
  );
  if (mode !== "browser" && !hasBrowserMetadata) {
    return null;
  }

  const resumeConversationUrl = resolveBrowserResumeConversationUrl(metadata);
  if (!resumeConversationUrl) {
    throw new Error(
      `Session ${trimmed} is a browser session but does not contain a ChatGPT conversation URL. Run "oracle status --hours 72 --limit 20" to list recent sessions.`,
    );
  }
  return { sessionId: metadata.id, resumeConversationUrl };
}

/**
 * ChatGPT briefly exposes symbolic `/c/<id>` routes while a newly submitted
 * conversation is being created. Those route tokens are not durable
 * conversation identities and must never be persisted or used as a
 * cross-talk binding boundary.
 *
 * `/c/WEB:<client-uuid>` was observed on the live ChatGPT surface on
 * 2026-07-21 before the SPA replaced it with the canonical conversation UUID.
 * The previous parser stopped at the colon and recorded only `WEB`, so reject
 * both forms. Keep the exclusion deliberately narrow: historical conversation
 * identifiers are not guaranteed to be UUIDs, so validating a particular
 * durable-id shape would make reattach brittle.
 */
const TRANSIENT_CHATGPT_CONVERSATION_IDS = new Set(["WEB"]);

const TRANSIENT_CHATGPT_CONVERSATION_ID_LIST = [...TRANSIENT_CHATGPT_CONVERSATION_IDS];
const CHATGPT_CONVERSATION_HOSTS = new Set(["chatgpt.com", "chat.openai.com"]);
const CHATGPT_CONVERSATION_HOST_LIST = [...CHATGPT_CONVERSATION_HOSTS];

function parseChatGptConversationSegment(url: string): string | undefined {
  const rawUrl = url.trim();
  if (!rawUrl) return undefined;
  const isRootRelative = rawUrl.startsWith("/") && !rawUrl.startsWith("//");
  const isAbsoluteHttps = /^https:\/\//i.test(rawUrl);
  if (!isRootRelative && !isAbsoluteHttps) return undefined;
  try {
    const parsed = new URL(rawUrl, "https://chatgpt.com");
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.port ||
      !CHATGPT_CONVERSATION_HOSTS.has(parsed.hostname)
    ) {
      return undefined;
    }
    // Project/workspace URLs can prefix the conversation route. Require the
    // /c/<segment> pair to finish the path so /c/id/foreign is never treated
    // as the same conversation. URL.pathname remains percent-encoded.
    const encoded = parsed.pathname.match(/(?:^|\/)c\/([^/]+)\/?$/)?.[1];
    if (!encoded) return undefined;
    try {
      return decodeURIComponent(encoded);
    } catch {
      return undefined;
    }
  } catch {
    return undefined;
  }
}

export function isProvisionalChatGptConversationId(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const upper = value.trim().toUpperCase();
  return (
    TRANSIENT_CHATGPT_CONVERSATION_IDS.has(upper) ||
    TRANSIENT_CHATGPT_CONVERSATION_ID_LIST.some((id) => upper.startsWith(`${id}:`))
  );
}

export function normalizeChatGptConversationId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const candidate = value.trim();
  if (!candidate || isProvisionalChatGptConversationId(candidate)) return undefined;
  if (candidate.length > 256) return undefined;
  if (!/^[a-zA-Z0-9_-]+$/.test(candidate)) return undefined;
  return candidate;
}

export function extractConversationIdFromUrl(url: string): string | undefined {
  return normalizeChatGptConversationId(parseChatGptConversationSegment(url));
}

export function isConversationUrl(url: string): boolean {
  return extractConversationIdFromUrl(url) !== undefined;
}

export function isProvisionalChatGptConversationUrl(url: string): boolean {
  return isProvisionalChatGptConversationId(parseChatGptConversationSegment(url));
}

export type ConversationUrlAdoptionDecision =
  | { kind: "noncanonical" }
  | { kind: "adopt"; conversationId: string }
  | { kind: "same"; conversationId: string }
  | { kind: "conflict"; expectedConversationId: string; observedConversationId: string };

/**
 * Decide whether an observed URL may update a run's durable conversation
 * identity. The first canonical id is monotonic: provisional/root URLs cannot
 * clear it and a later different canonical id is an integrity conflict, not a
 * new value to persist.
 */
export function decideConversationUrlAdoption(
  currentConversationId: string | null | undefined,
  observedUrl: string,
): ConversationUrlAdoptionDecision {
  const current = normalizeChatGptConversationId(currentConversationId);
  const observed = extractConversationIdFromUrl(observedUrl);
  if (!observed) return { kind: "noncanonical" };
  if (!current) return { kind: "adopt", conversationId: observed };
  if (current === observed) return { kind: "same", conversationId: current };
  return {
    kind: "conflict",
    expectedConversationId: current,
    observedConversationId: observed,
  };
}

function buildConversationSegmentFromHrefExpression(hrefExpression: string): string {
  const allowedHosts = JSON.stringify(CHATGPT_CONVERSATION_HOST_LIST);
  return `((href) => {
    try {
      const base = typeof location === 'object' && location.origin ? location.origin : 'https://chatgpt.com';
      const rawHref = String(href || '').trim();
      const isRootRelative = rawHref.startsWith('/') && !rawHref.startsWith('//');
      const isAbsoluteHttps = /^https:\\/\\//i.test(rawHref);
      if (!isRootRelative && !isAbsoluteHttps) return null;
      const parsed = new URL(rawHref, base);
      if (
        parsed.protocol !== 'https:' ||
        parsed.username ||
        parsed.password ||
        parsed.port ||
        !${allowedHosts}.includes(parsed.hostname)
      ) return null;
      const encoded = parsed.pathname.match(/(?:^|\\/)c\\/([^/]+)\\/?$/)?.[1] ?? null;
      if (!encoded) return null;
      try {
        return decodeURIComponent(encoded);
      } catch {
        return null;
      }
    } catch {
      return null;
    }
  })(${hrefExpression})`;
}

/**
 * Build the browser-side equivalent of `extractConversationIdFromUrl` for CDP
 * expressions. The TypeScript boundary normalizes probe results again, but
 * rejecting provisional route tokens in-page keeps every DOM guard aligned
 * and makes the monotonic identity rule explicit at the point of observation.
 */
export function buildConversationIdFromHrefExpression(hrefExpression: string): string {
  const transientIds = JSON.stringify(TRANSIENT_CHATGPT_CONVERSATION_ID_LIST);
  const segmentExpression = buildConversationSegmentFromHrefExpression(hrefExpression);
  return `((candidate) => {
    if (!candidate) return null;
    candidate = candidate.trim();
    if (!candidate) return null;
    if (candidate.length > 256) return null;
    const upper = candidate.toUpperCase();
    if (${transientIds}.some((id) => upper === id || upper.startsWith(id + ':'))) return null;
    return /^[a-zA-Z0-9_-]+$/.test(candidate) ? candidate : null;
  })(${segmentExpression})`;
}

/** Browser-side provisional-route probe used by the fresh-target guard. */
export function buildIsProvisionalChatGptConversationHrefExpression(
  hrefExpression: string,
): string {
  const transientIds = JSON.stringify(TRANSIENT_CHATGPT_CONVERSATION_ID_LIST);
  const segmentExpression = buildConversationSegmentFromHrefExpression(hrefExpression);
  return `((candidate) => {
    if (!candidate) return false;
    candidate = candidate.trim();
    if (!candidate) return false;
    const upper = candidate.toUpperCase();
    return ${transientIds}.some((id) => upper === id || upper.startsWith(id + ':'));
  })(${segmentExpression})`;
}

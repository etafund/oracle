import { describe, expect, test } from "vitest";
import {
  buildConversationIdFromHrefExpression,
  buildIsProvisionalChatGptConversationHrefExpression,
  decideConversationUrlAdoption,
  extractConversationIdFromUrl,
  isConversationUrl,
  isProvisionalChatGptConversationId,
  isProvisionalChatGptConversationUrl,
  normalizeChatGptConversationId,
} from "../../src/browser/conversationIdentity.js";

const TRANSIENT_URL = "https://chatgpt.com/c/WEB:fee7a622-991a-497a-bac4-a878b86f82f3";
const CANONICAL_ID = "6a5fc6a9-a724-83e8-a224-75b57da507ea";

function evaluateBrowserExpression(url: string): unknown {
  const expression = buildConversationIdFromHrefExpression(JSON.stringify(url));
  return Function("URL", `return ${expression}`)(URL);
}

function evaluateBrowserProvisionalExpression(url: string): unknown {
  const expression = buildIsProvisionalChatGptConversationHrefExpression(JSON.stringify(url));
  return Function("URL", `return ${expression}`)(URL);
}

describe("ChatGPT conversation identity", () => {
  test("treats WEB and WEB:<client-uuid> as provisional identities", () => {
    expect(normalizeChatGptConversationId("WEB")).toBeUndefined();
    expect(isProvisionalChatGptConversationId("WEB")).toBe(true);
    expect(normalizeChatGptConversationId("web")).toBeUndefined();
    expect(
      normalizeChatGptConversationId("WEB:fee7a622-991a-497a-bac4-a878b86f82f3"),
    ).toBeUndefined();
    expect(isProvisionalChatGptConversationId("WEB:fee7a622-991a-497a-bac4-a878b86f82f3")).toBe(
      true,
    );
    expect(
      normalizeChatGptConversationId("web:fee7a622-991a-497a-bac4-a878b86f82f3"),
    ).toBeUndefined();
    expect(extractConversationIdFromUrl(TRANSIENT_URL)).toBeUndefined();
    expect(isConversationUrl(TRANSIENT_URL)).toBe(false);
    expect(isProvisionalChatGptConversationUrl(TRANSIENT_URL)).toBe(true);
    expect(isProvisionalChatGptConversationUrl("https://chatgpt.com/c/WEB%3Aclient-id")).toBe(true);
    expect(isProvisionalChatGptConversationUrl(`https://chatgpt.com/c/${CANONICAL_ID}`)).toBe(
      false,
    );
  });

  test("keeps legacy durable ids without requiring a UUID shape", () => {
    expect(normalizeChatGptConversationId("abc-123")).toBe("abc-123");
    expect(normalizeChatGptConversationId("legacy_id")).toBe("legacy_id");
    expect(normalizeChatGptConversationId("WEB-123")).toBe("WEB-123");
    expect(extractConversationIdFromUrl(`https://chatgpt.com/c/${CANONICAL_ID}`)).toBe(
      CANONICAL_ID,
    );
    expect(
      extractConversationIdFromUrl(`https://chatgpt.com/g/g-p-demo/project/c/${CANONICAL_ID}`),
    ).toBe(CANONICAL_ID);
    expect(normalizeChatGptConversationId("a".repeat(257))).toBeUndefined();
    expect(evaluateBrowserExpression(`/c/${"a".repeat(257)}`)).toBeNull();
  });

  test("extracts from the URL pathname, not query-string lookalikes", () => {
    expect(
      extractConversationIdFromUrl("https://chatgpt.com/?next=%2Fc%2Fnot-a-conversation"),
    ).toBeUndefined();
  });

  test.each([
    "https://evil.example/c/canonical-123",
    "http://chatgpt.com/c/canonical-123",
    "https://chatgpt.com.evil.example/c/canonical-123",
    "https://chatgpt.com@evil.example/c/canonical-123",
    "https://user@chatgpt.com/c/canonical-123",
    "https://chatgpt.com:444/c/canonical-123",
    "https://chatgpt.com/c/canonical-123/extra",
    "evil.example/c/canonical-123",
    "chatgpt.com/c/canonical-123",
    "//chatgpt.com/c/canonical-123",
  ])("rejects unsafe or non-final conversation URLs: %s", (url) => {
    expect(extractConversationIdFromUrl(url)).toBeUndefined();
    expect(isConversationUrl(url)).toBe(false);
    expect(isProvisionalChatGptConversationUrl(url)).toBe(false);
    expect(evaluateBrowserExpression(url)).toBeNull();
    expect(evaluateBrowserProvisionalExpression(url)).toBe(false);
  });

  test("accepts exact trusted hosts, relative paths, and an optional trailing slash", () => {
    expect(extractConversationIdFromUrl(`/c/${CANONICAL_ID}`)).toBe(CANONICAL_ID);
    expect(extractConversationIdFromUrl(`https://chat.openai.com/c/${CANONICAL_ID}/`)).toBe(
      CANONICAL_ID,
    );
    expect(evaluateBrowserExpression(`/c/${CANONICAL_ID}`)).toBe(CANONICAL_ID);
  });

  test("browser-side probes apply the same provisional-to-canonical rule", () => {
    expect(evaluateBrowserExpression(TRANSIENT_URL)).toBeNull();
    expect(evaluateBrowserExpression("https://chatgpt.com/c/WEB")).toBeNull();
    expect(evaluateBrowserExpression("https://chatgpt.com/c/WEB%3Aclient-id")).toBeNull();
    expect(evaluateBrowserProvisionalExpression(TRANSIENT_URL)).toBe(true);
    expect(evaluateBrowserProvisionalExpression("https://chatgpt.com/c/WEB%3Aclient-id")).toBe(
      true,
    );
    expect(evaluateBrowserExpression(`https://chatgpt.com/c/${CANONICAL_ID}`)).toBe(CANONICAL_ID);
  });

  test("adopts the first canonical identity monotonically and rejects later drift", () => {
    expect(decideConversationUrlAdoption(undefined, TRANSIENT_URL)).toEqual({
      kind: "noncanonical",
    });
    expect(decideConversationUrlAdoption(undefined, "https://chatgpt.com/c/canonical-a")).toEqual({
      kind: "adopt",
      conversationId: "canonical-a",
    });
    expect(
      decideConversationUrlAdoption("canonical-a", "https://chatgpt.com/c/canonical-a"),
    ).toEqual({ kind: "same", conversationId: "canonical-a" });
    expect(decideConversationUrlAdoption("canonical-a", TRANSIENT_URL)).toEqual({
      kind: "noncanonical",
    });
    expect(
      decideConversationUrlAdoption("canonical-a", "https://chatgpt.com/c/canonical-b"),
    ).toEqual({
      kind: "conflict",
      expectedConversationId: "canonical-a",
      observedConversationId: "canonical-b",
    });
  });

  test.each([
    ["/c/%20legacy_id%20", "legacy_id", false],
    ["/c/%20WEB%20", null, true],
    ["/c/WEB%3Aclient-id", null, true],
    [`/g/g-demo/project/c/${CANONICAL_ID}/`, CANONICAL_ID, false],
  ] as const)("keeps Node and browser parsing in parity for %s", (url, durableId, provisional) => {
    expect(extractConversationIdFromUrl(url) ?? null).toBe(durableId);
    expect(evaluateBrowserExpression(url)).toBe(durableId);
    expect(isProvisionalChatGptConversationUrl(url)).toBe(provisional);
    expect(evaluateBrowserProvisionalExpression(url)).toBe(provisional);
  });
});

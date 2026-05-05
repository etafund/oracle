import { afterEach, describe, expect, test, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  collectGeneratedImageArtifacts,
  readAssistantGeneratedImages,
  resolveGeneratedImageWaitTimeoutMsForTest,
  saveChatGptGeneratedImages,
} from "../../src/browser/chatgptImages.js";
import type { ChromeClient } from "../../src/browser/types.js";
import { setOracleHomeDirOverrideForTest } from "../../src/oracleHome.js";

describe("readAssistantGeneratedImages", () => {
  class FakeElement {
    parentElement: FakeElement | null = null;
    readonly children: FakeElement[];
    readonly dataset: Record<string, string>;
    readonly order: number;
    readonly tagName: string;

    constructor(
      tagName: string,
      private readonly attributes: Record<string, string>,
      order: number,
      children: FakeElement[] = [],
    ) {
      this.tagName = tagName.toUpperCase();
      this.order = order;
      this.children = children;
      this.dataset = {};
      for (const [key, value] of Object.entries(attributes)) {
        if (key.startsWith("data-")) {
          this.dataset[key.slice(5).replace(/-([a-z])/g, (_, char: string) => char.toUpperCase())] =
            value;
        }
      }
      for (const child of children) {
        child.parentElement = this;
      }
    }

    get id(): string {
      return this.attributes.id ?? "";
    }

    get className(): string {
      return this.attributes.class ?? "";
    }

    get src(): string {
      return this.attributes.src ?? "";
    }

    get alt(): string {
      return this.attributes.alt ?? "";
    }

    get naturalWidth(): number {
      return Number(this.attributes.width ?? 0);
    }

    get naturalHeight(): number {
      return Number(this.attributes.height ?? 0);
    }

    getAttribute(name: string): string | null {
      return this.attributes[name] ?? null;
    }

    querySelector(selector: string): FakeElement | null {
      return this.querySelectorAll(selector)[0] ?? null;
    }

    querySelectorAll(selector: string): FakeElement[] {
      return flattenElements(this.children).filter((element) => matchesSelector(element, selector));
    }

    compareDocumentPosition(other: FakeElement): number {
      return other.order > this.order ? 4 : 0;
    }
  }

  function flattenElements(elements: FakeElement[]): FakeElement[] {
    return elements.flatMap((element) => [element, ...flattenElements(element.children)]);
  }

  function matchesSelector(element: FakeElement, selector: string): boolean {
    if (selector === "img") return element.tagName === "IMG";
    if (selector.includes('data-testid^="conversation-turn"')) {
      return String(element.getAttribute("data-testid") ?? "").startsWith("conversation-turn");
    }
    if (selector.includes('data-message-author-role="assistant"')) {
      return element.getAttribute("data-message-author-role") === "assistant";
    }
    return false;
  }

  function evaluateImageExpression(expression: string, elements: FakeElement[]): unknown {
    const document = {
      querySelectorAll: (selector: string) =>
        flattenElements(elements).filter((element) => matchesSelector(element, selector)),
    };
    return Function(
      "document",
      "HTMLElement",
      "Node",
      `return ${expression};`,
    )(document, FakeElement, {
      DOCUMENT_POSITION_FOLLOWING: 4,
    });
  }

  test("dedupes duplicate image urls by file id and keeps the largest candidate", async () => {
    const runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: {
          value: [
            {
              url: "https://chatgpt.com/backend-api/estuary/content?id=file_a",
              alt: "one",
              width: 512,
              height: 512,
            },
            {
              url: "https://chatgpt.com/backend-api/estuary/content?id=file_a",
              alt: "one-large",
              width: 1024,
              height: 1024,
            },
            {
              url: "https://chatgpt.com/backend-api/estuary/content?id=file_b",
              alt: "two",
              width: 640,
              height: 480,
            },
          ],
        },
      }),
    } as unknown as ChromeClient["Runtime"];

    const images = await readAssistantGeneratedImages(runtime);
    expect(images).toHaveLength(2);
    expect(images[0]?.fileId).toBe("file_a");
    expect(images[0]?.width).toBe(1024);
    expect(images[1]?.fileId).toBe("file_b");
  });

  test("finds generated images rendered outside assistant turn wrappers", async () => {
    const generatedImage = new FakeElement(
      "img",
      {
        src: "https://chatgpt.com/backend-api/estuary/content?id=file_detached",
        alt: "",
        width: "1254",
        height: "1254",
      },
      5,
    );
    const elements = [
      new FakeElement(
        "article",
        { "data-testid": "conversation-turn-1", "data-message-author-role": "user" },
        1,
      ),
      new FakeElement("div", { id: "image-detached" }, 4, [generatedImage]),
      new FakeElement(
        "article",
        { "data-testid": "conversation-turn-2", "data-message-author-role": "assistant" },
        8,
      ),
    ];
    const runtime = {
      evaluate: vi.fn(async ({ expression }: { expression: string }) => ({
        result: { value: evaluateImageExpression(expression, elements) },
      })),
    } as unknown as ChromeClient["Runtime"];

    const images = await readAssistantGeneratedImages(runtime, 0);

    expect(images).toHaveLength(1);
    expect(images[0]).toMatchObject({
      fileId: "file_detached",
      width: 1254,
      height: 1254,
    });
  });
});

describe("saveChatGptGeneratedImages", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  test("saves multiple generated images as real files with ChatGPT cookies", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-chatgpt-images-"));
    const network = {
      getCookies: vi.fn().mockResolvedValue({
        cookies: [
          { name: "__Secure-next-auth.session-token", value: "abc" },
          { name: "oai-did", value: "def" },
        ],
      }),
    } as unknown as ChromeClient["Network"];

    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: "OK",
        url: "https://files.local/1",
        headers: { get: (name: string) => (name === "content-type" ? "image/png" : null) },
        arrayBuffer: async () => Uint8Array.from([1, 2, 3, 4]).buffer,
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: "OK",
        url: "https://files.local/2",
        headers: { get: (name: string) => (name === "content-type" ? "image/png" : null) },
        arrayBuffer: async () => Uint8Array.from([5, 6, 7, 8]).buffer,
      } as Response);

    const result = await saveChatGptGeneratedImages({
      Network: network,
      images: [
        { url: "https://chatgpt.com/backend-api/estuary/content?id=file_1", fileId: "file_1" },
        { url: "https://chatgpt.com/backend-api/estuary/content?id=file_2", fileId: "file_2" },
      ],
      outputPath: path.join(tmpDir, "generated.png"),
    });

    expect(result.saved).toBe(true);
    expect(result.imageCount).toBe(2);
    expect(result.savedImages).toHaveLength(2);
    expect(result.savedImages[0]).toMatchObject({
      kind: "image",
      path: path.join(tmpDir, "generated.png"),
      mimeType: "image/png",
      sourceUrl: "https://chatgpt.com/backend-api/estuary/content?id=file_1",
    });
    expect(result.savedImages[1]?.path).toBe(path.join(tmpDir, "generated.2.png"));
    await expect(fs.readFile(path.join(tmpDir, "generated.png"))).resolves.toEqual(
      Buffer.from([1, 2, 3, 4]),
    );
  });
});

describe("resolveGeneratedImageWaitTimeoutMsForTest", () => {
  test("defaults to a 15 minute wait window when no timeout is provided", () => {
    expect(resolveGeneratedImageWaitTimeoutMsForTest()).toBe(15 * 60_000);
  });

  test("caps image waits at 15 minutes even when a longer timeout is requested", () => {
    expect(resolveGeneratedImageWaitTimeoutMsForTest(20 * 60_000)).toBe(15 * 60_000);
  });
});

describe("collectGeneratedImageArtifacts", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    vi.useRealTimers();
    setOracleHomeDirOverrideForTest(null);
  });

  test("auto-saves generated images to the session artifacts directory when no explicit path is provided", async () => {
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-home-"));
    setOracleHomeDirOverrideForTest(tmpHome);
    const runtime = {
      evaluate: vi.fn(async ({ expression }: { expression: string }) => {
        if (expression.includes("/backend-api/estuary/content?id=file_")) {
          return {
            result: {
              value: [
                {
                  url: "https://chatgpt.com/backend-api/estuary/content?id=file_auto_saved",
                  alt: "auto-saved",
                  width: 1024,
                  height: 1024,
                },
              ],
            },
          };
        }
        return { result: { value: null } };
      }),
    } as unknown as ChromeClient["Runtime"];
    const network = {
      getCookies: vi.fn().mockResolvedValue({
        cookies: [{ name: "__Secure-next-auth.session-token", value: "abc" }],
      }),
    } as unknown as ChromeClient["Network"];
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      url: "https://files.local/auto-saved",
      headers: { get: (name: string) => (name === "content-type" ? "image/png" : null) },
      arrayBuffer: async () => Uint8Array.from([4, 3, 2, 1]).buffer,
    } as Response);

    const result = await collectGeneratedImageArtifacts({
      Runtime: runtime,
      Network: network,
      sessionId: "image-session",
      answerText: "Generated image",
      waitTimeoutMs: 15_000,
    });

    expect(result.imageCount).toBe(1);
    expect(result.savedImages).toHaveLength(1);
    expect(result.savedImages[0]?.path).toContain(
      path.join(tmpHome, "sessions", "image-session", "artifacts"),
    );
    expect(result.markdownSuffix).toContain("Saved to:");
    await expect(fs.readFile(result.savedImages[0]!.path)).resolves.toEqual(
      Buffer.from([4, 3, 2, 1]),
    );
  });
});

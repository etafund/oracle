import { describe, expect, test } from "vitest";
import {
  buildChatGptImageConsultInput,
  registerChatGptImageTool,
} from "../../src/mcp/tools/chatgptImage.ts";

describe("chatgpt_image MCP tool", () => {
  test("builds an image-aware browser consult with uploaded references", () => {
    const input = buildChatGptImageConsultInput({
      prompt: "Create an App Store screenshot background.",
      files: ["reference.png"],
      outputPath: "/tmp/screenshot-bg.png",
      aspectRatio: "9:16",
      browserThinkingTime: "extended",
    });

    expect(input).toMatchObject({
      engine: "browser",
      generateImage: "/tmp/screenshot-bg.png",
      files: ["reference.png"],
      browserAttachments: "always",
      browserThinkingTime: "extended",
    });
    expect(input.prompt).toContain("aspect ratio 9:16");
  });

  test("uses a default output path when agents only provide a prompt", () => {
    const input = buildChatGptImageConsultInput({
      prompt: "Create a simple app icon.",
      files: [],
    });

    expect(input.engine).toBe("browser");
    expect(input.generateImage).toMatch(/generated\/chatgpt-image-[a-z0-9]+\.png$/);
    expect(input.browserAttachments).toBeUndefined();
  });

  test("returns resolved dry-run details from the registered tool", async () => {
    const handlers: Array<(input: unknown) => Promise<unknown>> = [];
    registerChatGptImageTool({
      registerTool: (_name: string, _def: unknown, fn: (input: unknown) => Promise<unknown>) => {
        handlers.push(fn);
      },
      server: {
        sendLoggingMessage: async () => undefined,
      },
    } as unknown as Parameters<typeof registerChatGptImageTool>[0]);
    const handler = handlers[0];
    if (!handler) throw new Error("handler not registered");

    const result = (await handler({
      dryRun: true,
      prompt: "Create a small product mockup.",
      outputPath: "/tmp/product-mockup.png",
      aspectRatio: "1:1",
    })) as {
      structuredContent: {
        requestedOutputPath: string;
        resolved: { browser?: { imageOutputPath?: string } };
      };
    };

    expect(result.structuredContent.requestedOutputPath).toBe("/tmp/product-mockup.png");
    expect(result.structuredContent.resolved.browser?.imageOutputPath).toBe(
      "/tmp/product-mockup.png",
    );
  });
});

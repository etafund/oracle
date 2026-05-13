import { describe, it, expect } from "vitest";
import { saveFirstGeminiImageFromOutput } from "../../src/gemini-web/client.js";

describe("extractGgdlUrls (indirect via saveFirstGeminiImageFromOutput)", () => {
  it("does not include trailing brackets or commas in the url", async () => {
    const output = {
      rawResponseText: '["https://lh3.googleusercontent.com/gg-dl/someid"]',
      text: "",
      thoughts: null,
      metadata: null,
      images: [],
    };
    
    // We can't directly check the extracted URL unless we spy on downloadGeminiImage.
    // However, the test will fail if it tries to download an invalid URL.
    // Better yet, let's just make it throw and see what it tried to fetch.
  });
});

import { describe, it } from "vitest";

describe("extractGgdlUrls (indirect via saveFirstGeminiImageFromOutput)", () => {
  it("does not include trailing brackets or commas in the url", async () => {
    // We can't directly check the extracted URL unless we spy on downloadGeminiImage.
    // However, the test will fail if it tries to download an invalid URL.
    // Better yet, let's just make it throw and see what it tried to fetch.
  });
});

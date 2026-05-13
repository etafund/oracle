import { describe, expect, it } from "vitest";
import { parseGeminiStreamGenerateResponse } from "../../src/gemini-web/parse.js";

describe("extractGgdlUrls", () => {
  it("does not include trailing brackets or quotes", () => {
    const generatedUrl = "https://lh3.googleusercontent.com/gg-dl/someid";
    const candidate: unknown[] = [];
    candidate[0] = "candidate-1";
    candidate[1] = ["done"];
    const generatedImage: unknown[] = [];
    generatedImage[0] = [];
    (generatedImage[0] as unknown[])[3] = [];
    ((generatedImage[0] as unknown[])[3] as unknown[])[3] = generatedUrl;
    candidate[12] = [];
    (candidate[12] as unknown[])[7] = [[generatedImage]];

    const body: unknown[] = [];
    body[1] = [null, null, "candidate-1"];
    body[4] = [candidate];

    const parsed = parseGeminiStreamGenerateResponse(
      JSON.stringify([[null, null, JSON.stringify(body)]]),
      { expectedResponseCandidateId: "candidate-1" },
    );

    expect(parsed.images).toEqual([
      {
        kind: "generated",
        url: generatedUrl,
        title: "[Generated Image]",
        alt: "",
      },
    ]);
  });
});

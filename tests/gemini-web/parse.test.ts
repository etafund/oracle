import { describe, it, expect } from "vitest";
import {
  parseGeminiStreamGenerateResponse,
  isGeminiModelUnavailable,
} from "../../src/gemini-web/client.js";
import { parseGeminiStreamGenerateResponse as parseGeminiStreamGenerateResponseStrict } from "../../src/gemini-web/parse.js";
import { GeminiStreamCaptureError } from "../../src/gemini-web/streamSafeguards.js";

function makeRawResponseWithBody(body: unknown): string {
  return makeRawResponseWithBodies([body]);
}

function makeRawResponseWithBodies(bodies: unknown[]): string {
  const responseJson = bodies.map((body) => [null, null, JSON.stringify(body)]);
  return `)]}'\n\n${JSON.stringify(responseJson)}`;
}

function makeBodyWithText(rcid: string, text: string): unknown[] {
  const candidate: unknown[] = [];
  candidate[0] = rcid;
  candidate[1] = [text];

  const body: unknown[] = [];
  body[1] = ["cid", "rid", rcid];
  body[4] = [candidate];
  return body;
}

describe("gemini-web parseGeminiStreamGenerateResponse", () => {
  it("parses text + thoughts from minimal body payload", () => {
    const candidate: unknown[] = [];
    candidate[0] = "rcid-1";
    candidate[1] = ["Hello"];
    candidate[37] = [["Thinking"]];

    const body: unknown[] = [];
    body[1] = ["cid", "rid", "rcid-1"];
    body[4] = [candidate];

    const parsed = parseGeminiStreamGenerateResponse(makeRawResponseWithBody(body));
    expect(parsed.text).toBe("Hello");
    expect(parsed.thoughts).toBe("Thinking");
    expect(parsed.metadata).toEqual(["cid", "rid", "rcid-1"]);
  });

  it("extracts web image candidates", () => {
    const candidate: unknown[] = [];
    candidate[0] = "rcid-1";
    candidate[1] = ["Hello"];

    // firstCandidate[12][1] = webImages
    const webImage: unknown[] = [];
    webImage[0] = [];
    (webImage[0] as unknown[])[0] = ["https://example.com/img.png"];
    (webImage[0] as unknown[])[4] = "alt text";
    webImage[7] = ["Title"];

    candidate[12] = [];
    (candidate[12] as unknown[])[1] = [webImage];

    const body: unknown[] = [];
    body[1] = ["cid", "rid", "rcid-1"];
    body[4] = [candidate];

    const parsed = parseGeminiStreamGenerateResponse(makeRawResponseWithBody(body));
    expect(parsed.images[0]).toEqual({
      kind: "web",
      url: "https://example.com/img.png",
      title: "Title",
      alt: "alt text",
    });
  });

  it("uses fallback text when response is a card_content URL", () => {
    const candidate: unknown[] = [];
    candidate[0] = "rcid-1";
    candidate[1] = ["http://googleusercontent.com/card_content/123"];
    candidate[22] = ["Expanded card content"];

    const body: unknown[] = [];
    body[1] = ["cid", "rid", "rcid-1"];
    body[4] = [candidate];

    const parsed = parseGeminiStreamGenerateResponse(makeRawResponseWithBody(body));
    expect(parsed.text).toBe("Expanded card content");
  });

  it("picks the latest non-empty text across streaming chunks", () => {
    const raw = makeRawResponseWithBodies([
      makeBodyWithText("rcid-1", ""),
      makeBodyWithText("rcid-1", "partial"),
      makeBodyWithText("rcid-1", "partial answer with more"),
      makeBodyWithText("rcid-1", "partial answer with more final"),
    ]);

    const parsed = parseGeminiStreamGenerateResponse(raw);
    expect(parsed.text).toBe("partial answer with more final");
  });

  it("continues past placeholder and partial JSON chunks before final text", () => {
    const placeholder = JSON.stringify(makeBodyWithText("rcid-1", "(no text output)"));
    const finalBody = JSON.stringify(makeBodyWithText("rcid-1", "final answer"));
    const split = Math.floor(finalBody.length / 2);
    const responseJson = [
      [null, null, placeholder],
      [null, null, finalBody.slice(0, split)],
      [null, null, finalBody.slice(split)],
    ];
    const raw = `)]}'\n\n${JSON.stringify(responseJson)}`;

    const parsed = parseGeminiStreamGenerateResponse(raw);
    expect(parsed.text).toBe("final answer");
  });

  it("strips ANSI escape leakage while preserving markdown structure", () => {
    const markdown = "\u001b[31m# Report\u001b[0m\n\n- one\n- two\n\n```ts\nconst ok = true;\n```";
    const parsed = parseGeminiStreamGenerateResponse(
      makeRawResponseWithBody(makeBodyWithText("rcid-1", markdown)),
    );

    expect(parsed.text).toBe("# Report\n\n- one\n- two\n\n```ts\nconst ok = true;\n```");
  });

  it("still parses a single coalesced chunk", () => {
    const raw = makeRawResponseWithBody(makeBodyWithText("rcid-1", "single-chunk reply"));

    const parsed = parseGeminiStreamGenerateResponse(raw);
    expect(parsed.text).toBe("single-chunk reply");
  });

  it("preserves the previous non-empty chunk when a later chunk has empty text", () => {
    const raw = makeRawResponseWithBodies([
      makeBodyWithText("rcid-1", "first answer"),
      makeBodyWithText("rcid-1", ""),
    ]);

    const parsed = parseGeminiStreamGenerateResponse(raw);
    expect(parsed.text).toBe("first answer");
  });

  it("fails loudly with a typed error for all-empty terminal streams", () => {
    const raw = makeRawResponseWithBodies([
      makeBodyWithText("rcid-1", ""),
      makeBodyWithText("rcid-1", "(no text output)"),
    ]);

    expect(() => parseGeminiStreamGenerateResponse(raw)).toThrow(GeminiStreamCaptureError);
    try {
      parseGeminiStreamGenerateResponse(raw);
    } catch (error) {
      expect(error).toBeInstanceOf(GeminiStreamCaptureError);
      expect((error as GeminiStreamCaptureError).code).toBe("output_capture_empty");
      expect((error as GeminiStreamCaptureError).retry_safe).toBe(true);
    }
  });

  it("fails stale output ownership checks with output_capture_unverified", () => {
    const raw = makeRawResponseWithBody(makeBodyWithText("rcid-stale", "stale answer"));

    expect(() =>
      parseGeminiStreamGenerateResponseStrict(raw, {
        expectedResponseCandidateId: "rcid-current",
        currentSessionId: "session-1",
      }),
    ).toThrow(GeminiStreamCaptureError);
    try {
      parseGeminiStreamGenerateResponseStrict(raw, {
        expectedResponseCandidateId: "rcid-current",
        currentSessionId: "session-1",
      });
    } catch (error) {
      expect((error as GeminiStreamCaptureError).code).toBe("output_capture_unverified");
      expect((error as GeminiStreamCaptureError).details.current_session_id).toBe("session-1");
    }
  });

  it("extracts model-unavailable error code 1052 from response json", () => {
    const responseJson: unknown[] = [];
    // errorCode path: [0,5,2,0,1,0]
    responseJson[0] = [];
    (responseJson[0] as unknown[])[5] = [];
    ((responseJson[0] as unknown[])[5] as unknown[])[2] = [];
    (((responseJson[0] as unknown[])[5] as unknown[])[2] as unknown[])[0] = [];
    ((((responseJson[0] as unknown[])[5] as unknown[])[2] as unknown[])[0] as unknown[])[1] = [];
    (
      (
        (((responseJson[0] as unknown[])[5] as unknown[])[2] as unknown[])[0] as unknown[]
      )[1] as unknown[]
    )[0] = 1052;

    const raw = `)]}'\n\n${JSON.stringify(responseJson)}`;
    expect(isGeminiModelUnavailable(parseGeminiStreamGenerateResponse(raw).errorCode)).toBe(true);
  });

  it("returns false for isGeminiModelUnavailable when error code is other than 1052", () => {
    expect(isGeminiModelUnavailable(404)).toBe(false);
    expect(isGeminiModelUnavailable(undefined)).toBe(false);
  });
});

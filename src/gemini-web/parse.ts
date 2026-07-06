import {
  assertGeminiStreamNonEmpty,
  assertGeminiStreamOwnership,
  buildGeminiStreamCaptureSummary,
  stripAnsiEscapes,
  type GeminiStreamCaptureSummary,
} from "./streamSafeguards.js";

export interface GeminiWebCandidateImage {
  url: string;
  title?: string;
  alt?: string;
  kind: "web" | "generated" | "raw";
}

export interface GeminiStreamParseOptions {
  readonly expectedResponseCandidateId?: string | null;
  /** Previous turn's observed rcid; a response echoing it is stale content. */
  readonly previousResponseCandidateId?: string | null;
  readonly currentPromptSha256?: `sha256:${string}` | string | null;
  readonly currentSessionId?: string | null;
}

export interface GeminiStreamParseResult {
  metadata: unknown;
  text: string;
  thoughts: string | null;
  images: GeminiWebCandidateImage[];
  errorCode?: number;
  capture: GeminiStreamCaptureSummary;
}

interface ParsedStreamPart {
  readonly index: number;
  readonly body: unknown;
  readonly text: string;
  readonly responseCandidateId: string | null;
}

export function getNestedValue<T>(
  value: unknown,
  pathParts: Array<string | number>,
  fallback: T,
): T {
  let current: unknown = value;
  for (const part of pathParts) {
    if (current == null) return fallback;
    if (typeof part === "number") {
      if (!Array.isArray(current)) return fallback;
      current = current[part];
    } else {
      if (typeof current !== "object") return fallback;
      current = (current as Record<string, unknown>)[part];
    }
  }
  return (current as T) ?? fallback;
}

export function trimGeminiJsonEnvelope(text: string): string {
  const cleaned = stripAnsiEscapes(text);
  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("Gemini response did not contain a JSON payload.");
  }
  return cleaned.slice(start, end + 1);
}

export function extractGeminiErrorCode(responseJson: unknown): number | undefined {
  const code = getNestedValue<number>(responseJson, [0, 5, 2, 0, 1, 0], -1);
  return typeof code === "number" && code >= 0 ? code : undefined;
}

export function parseGeminiStreamGenerateResponse(
  rawText: string,
  options: GeminiStreamParseOptions = {},
): GeminiStreamParseResult {
  const responseJson = JSON.parse(trimGeminiJsonEnvelope(rawText)) as unknown;
  const errorCode = extractGeminiErrorCode(responseJson);
  const parts = Array.isArray(responseJson) ? responseJson : [];
  const parsedParts = parseStreamParts(parts);

  let bodyIndex = 0;
  let body: unknown = null;
  for (const part of parsedParts) {
    const candidateList = getNestedValue<unknown[]>(part.body, [4], []);
    if (!Array.isArray(candidateList) || candidateList.length === 0) continue;
    if (body === null) {
      bodyIndex = part.index;
      body = part.body;
    }
    if (part.text.length > 0) {
      bodyIndex = part.index;
      body = part.body;
    }
  }

  const candidateList = getNestedValue<unknown[]>(body, [4], []);
  const firstCandidate = candidateList[0];
  const textRaw = sanitizeText(getNestedValue<string>(firstCandidate, [1, 0], ""));
  const cardContent = /^http:\/\/googleusercontent\.com\/card_content\/\d+/.test(textRaw);
  const text = cardContent
    ? sanitizeText(getNestedValue<string | null>(firstCandidate, [22, 0], null) ?? textRaw)
    : textRaw;
  const thoughts = sanitizeNullableText(
    getNestedValue<string | null>(firstCandidate, [37, 0, 0], null),
  );
  const metadata = getNestedValue<unknown>(body, [1], []);
  const observedResponseCandidateId =
    candidateIdFromMetadata(metadata) ?? getCandidateId(firstCandidate);

  const images = extractImages({
    firstCandidate,
    body,
    parts,
    bodyIndex,
    parsedParts,
  });

  assertGeminiStreamOwnership({
    expectedResponseCandidateId: options.expectedResponseCandidateId,
    previousResponseCandidateId: options.previousResponseCandidateId,
    observedResponseCandidateId,
    currentPromptSha256: options.currentPromptSha256,
    currentSessionId: options.currentSessionId,
  });

  const capture = buildGeminiStreamCaptureSummary({
    text,
    imageCount: images.length,
    chunkCount: parsedParts.length,
    nonEmptyCandidateCount: parsedParts.filter((part) => part.text.length > 0).length,
    observedResponseCandidateId,
    expectedResponseCandidateId: options.expectedResponseCandidateId,
    currentPromptSha256: options.currentPromptSha256,
    currentSessionId: options.currentSessionId,
  });
  assertGeminiStreamNonEmpty(capture, { imageCount: images.length, errorCode });

  return {
    metadata,
    text,
    thoughts,
    images,
    errorCode,
    capture,
  };
}

function parseStreamParts(parts: unknown[]): ParsedStreamPart[] {
  const parsed: ParsedStreamPart[] = [];
  let pending = "";

  for (let i = 0; i < parts.length; i += 1) {
    const partBody = getNestedValue<string | null>(parts[i], [2], null);
    if (!partBody) continue;
    const cleanBody = stripAnsiEscapes(partBody);
    const attempts = pending ? [pending + cleanBody, cleanBody] : [cleanBody];
    let parsedBody: unknown | null = null;
    for (const attempt of attempts) {
      try {
        parsedBody = JSON.parse(attempt) as unknown;
        pending = "";
        break;
      } catch {
        parsedBody = null;
      }
    }
    if (parsedBody === null) {
      pending += cleanBody;
      continue;
    }
    parsed.push({
      index: i,
      body: parsedBody,
      text: candidateTextFromBody(parsedBody),
      responseCandidateId: responseCandidateIdFromBody(parsedBody),
    });
  }

  return parsed;
}

function extractImages(input: {
  readonly firstCandidate: unknown;
  readonly body: unknown;
  readonly parts: unknown[];
  readonly bodyIndex: number;
  readonly parsedParts: readonly ParsedStreamPart[];
}): GeminiWebCandidateImage[] {
  const images: GeminiWebCandidateImage[] = [];

  const webImages = getNestedValue<unknown[]>(input.firstCandidate, [12, 1], []);
  for (const webImage of webImages) {
    const url = getNestedValue<string | null>(webImage, [0, 0, 0], null);
    if (!url) continue;
    images.push({
      kind: "web",
      url,
      title: getNestedValue<string | undefined>(webImage, [7, 0], undefined),
      alt: getNestedValue<string | undefined>(webImage, [0, 4], undefined),
    });
  }

  const hasGenerated = Boolean(getNestedValue<unknown>(input.firstCandidate, [12, 7, 0], null));
  if (!hasGenerated) {
    return images;
  }

  let imgBody: unknown = null;
  for (const part of input.parsedParts) {
    if (part.index < input.bodyIndex) continue;
    const candidateImages = getNestedValue<unknown | null>(part.body, [4, 0, 12, 7, 0], null);
    if (candidateImages != null) {
      imgBody = part.body;
      break;
    }
  }

  const imgCandidate = getNestedValue<unknown>(imgBody ?? input.body, [4, 0], null);
  const generated = getNestedValue<unknown[]>(imgCandidate, [12, 7, 0], []);
  for (const genImage of generated) {
    const url = getNestedValue<string | null>(genImage, [0, 3, 3], null);
    if (!url) continue;
    images.push({
      kind: "generated",
      url,
      title: "[Generated Image]",
      alt: "",
    });
  }

  return images;
}

function candidateTextFromBody(body: unknown): string {
  return sanitizeText(getNestedValue<string>(body, [4, 0, 1, 0], ""));
}

function responseCandidateIdFromBody(body: unknown): string | null {
  return (
    candidateIdFromMetadata(getNestedValue<unknown>(body, [1], [])) ??
    getCandidateId(getNestedValue<unknown>(body, [4, 0], null))
  );
}

function getCandidateId(candidate: unknown): string | null {
  const id = getNestedValue<string | null>(candidate, [0], null);
  return typeof id === "string" && id.trim().length > 0 ? id.trim() : null;
}

function candidateIdFromMetadata(metadata: unknown): string | null {
  if (!Array.isArray(metadata)) {
    return null;
  }
  const id = metadata[2];
  return typeof id === "string" && id.trim().length > 0 ? id.trim() : null;
}

function sanitizeText(value: string): string {
  const cleaned = stripAnsiEscapes(typeof value === "string" ? value : "");
  return isEmptyPlaceholder(cleaned) ? "" : cleaned;
}

function sanitizeNullableText(value: string | null): string | null {
  if (typeof value !== "string") return null;
  const cleaned = sanitizeText(value);
  return cleaned.length > 0 ? cleaned : null;
}

function isEmptyPlaceholder(value: string): boolean {
  return /^\s*\((?:no text output|empty response|empty output)\)\s*$/i.test(value);
}

import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { TextDecoder } from "node:util";
import type { BrowserBundleFormat, FileSection, RunOracleOptions } from "../oracle.js";
import { MODEL_CONFIGS, TOKENIZER_OPTIONS } from "../oracle/config.js";
import { readFiles, createFileSections } from "../oracle/files.js";
import { FileValidationError } from "../oracle/errors.js";
import { formatFileSections } from "../oracle/markdown.js";
import { isKnownModel } from "../oracle/modelResolver.js";
import { buildPromptMarkdown } from "../oracle/promptAssembly.js";
import type {
  BrowserAttachment,
  BrowserPromptFallbackAuthorization,
  BrowserPromptFallbackReason,
} from "./types.js";
import { buildAttachmentPlan } from "./policies.js";
import {
  MAX_DATA_TRANSFER_BYTES,
  readBoundedRegularFile,
} from "./actions/attachmentDataTransfer.js";
import { createStoredZip, estimateStoredZipSize } from "./zipBundle.js";
import { normalizeRenderedPromptDomIdentity } from "./promptDomMatch.js";

const DEFAULT_BROWSER_INLINE_CHAR_BUDGET = 60_000;
const MAX_BROWSER_ATTACHMENTS = 10;
const MAX_BROWSER_ZIP_BUNDLE_BYTES = MAX_DATA_TRANSFER_BYTES;
const MAX_BROWSER_ATTACHMENT_SOURCE_BYTES = 100 * 1024 * 1024;

const MEDIA_EXTENSIONS = new Set([
  ".mp4",
  ".mov",
  ".avi",
  ".mkv",
  ".webm",
  ".m4v",
  ".mp3",
  ".wav",
  ".aac",
  ".flac",
  ".ogg",
  ".m4a",
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".webp",
  ".bmp",
  ".svg",
  ".heic",
  ".heif",
  ".pdf",
]);

const ARCHIVE_EXTENSIONS = new Set([
  ".7z",
  ".aab",
  ".apk",
  ".br",
  ".bz2",
  ".cab",
  ".crx",
  ".deb",
  ".dmg",
  ".doc",
  ".docx",
  ".ear",
  ".epub",
  ".gz",
  ".ipa",
  ".iso",
  ".jar",
  ".lz",
  ".lz4",
  ".msi",
  ".odp",
  ".ods",
  ".odt",
  ".pkg",
  ".ppt",
  ".pptx",
  ".rar",
  ".rpm",
  ".tar",
  ".tgz",
  ".war",
  ".whl",
  ".xls",
  ".xlsx",
  ".xz",
  ".xpi",
  ".zip",
  ".zipx",
  ".zst",
]);

export function isMediaFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return MEDIA_EXTENSIONS.has(ext);
}

export function isRawUploadFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return MEDIA_EXTENSIONS.has(ext) || ARCHIVE_EXTENSIONS.has(ext);
}

export const AUTO_PROMPT_FALLBACK_EQUIVALENCE_ALGORITHM =
  "oracle.browser-auto-fallback-exact.v2" as const;
export const AUTO_PROMPT_FALLBACK_MAX_FILES = 10;
export const AUTO_PROMPT_FALLBACK_MAX_SOURCE_BYTES = 4 * 1024 * 1024;
export const AUTO_PROMPT_FALLBACK_MAX_LINES = 100_000;
export const AUTO_PROMPT_FALLBACK_MAX_EXPANDED_CHARS = 8 * 1024 * 1024;

type AutoFallbackAttachment = {
  displayPath: string;
  content: Uint8Array;
};

function reconstructBoundedInlinePrompt(
  basePrompt: string,
  attachments: ReadonlyArray<AutoFallbackAttachment>,
): string | null {
  if (
    attachments.length === 0 ||
    attachments.length > AUTO_PROMPT_FALLBACK_MAX_FILES ||
    attachments.some(
      (attachment) =>
        !attachment.displayPath ||
        attachment.displayPath.length > 4_096 ||
        isRawUploadFile(attachment.displayPath),
    )
  ) {
    return null;
  }
  const sourceBytes = attachments.reduce((total, attachment) => {
    return total + attachment.content.byteLength;
  }, 0);
  if (sourceBytes > AUTO_PROMPT_FALLBACK_MAX_SOURCE_BYTES) return null;

  const decoder = new TextDecoder("utf-8", { fatal: true });
  const sections: Array<{ displayPath: string; content: string }> = [];
  let lineCount = 0;
  try {
    for (const attachment of attachments) {
      const content = decoder.decode(attachment.content);
      // Conservative text-only proof: reject transport/control bytes that can
      // hide binary payloads inside an otherwise decodable UTF-8 file.
      if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(content)) return null;
      lineCount += 1;
      for (let index = 0; index < content.length; index += 1) {
        if (content.charCodeAt(index) === 10) lineCount += 1;
        if (lineCount > AUTO_PROMPT_FALLBACK_MAX_LINES) return null;
      }
      sections.push({ displayPath: attachment.displayPath, content });
    }
  } catch {
    return null;
  }

  const inlineBlock = formatFileSections(sections, { preserveTrailingWhitespace: true });
  const reconstructed = [basePrompt, inlineBlock]
    .filter((value) => Boolean(value.trim()))
    .join("\n\n")
    .trim();
  return reconstructed.length <= AUTO_PROMPT_FALLBACK_MAX_EXPANDED_CHARS ? reconstructed : null;
}

function isExactFallbackTextStable(value: string): boolean {
  return normalizeRenderedPromptDomIdentity(value) === value;
}

export function isAutoPromptFallbackWithinModelBudget(
  submittedPrompt: string,
  model: string,
  callerMaxInputTokens: number,
): boolean {
  if (!Number.isSafeInteger(callerMaxInputTokens) || callerMaxInputTokens <= 0) return false;
  if (!isKnownModel(model)) return false;
  const modelConfig = MODEL_CONFIGS[model];
  const effectiveLimit = Math.min(modelConfig.inputLimit, callerMaxInputTokens);
  const tokens = modelConfig.tokenizer(
    [{ role: "user", content: submittedPrompt }],
    TOKENIZER_OPTIONS,
  );
  return Number.isSafeInteger(tokens) && tokens <= effectiveLimit;
}

export function isAutoPromptFallbackWithinGpt56SolBudget(
  submittedPrompt: string,
  callerMaxInputTokens: number,
): boolean {
  return isAutoPromptFallbackWithinModelBudget(
    submittedPrompt,
    "gpt-5.6-sol",
    callerMaxInputTokens,
  );
}

export function verifyAutoUploadToInlineFallback(input: {
  primaryPrompt: string;
  fallbackPrompt: string;
  attachments: ReadonlyArray<AutoFallbackAttachment>;
}): boolean {
  if (!input.fallbackPrompt.trim() || input.attachments.length === 0) return false;
  const expectedFallback = reconstructBoundedInlinePrompt(input.primaryPrompt, input.attachments);
  return Boolean(
    expectedFallback !== null &&
    isExactFallbackTextStable(expectedFallback) &&
    isExactFallbackTextStable(input.fallbackPrompt) &&
    input.fallbackPrompt === expectedFallback,
  );
}

export function verifyAutoInlineToUploadFallback(input: {
  primaryPrompt: string;
  fallbackPrompt: string;
  attachments: ReadonlyArray<AutoFallbackAttachment>;
}): boolean {
  if (!input.primaryPrompt.trim() || input.attachments.length === 0) return false;
  const expectedPrimary = reconstructBoundedInlinePrompt(input.fallbackPrompt, input.attachments);
  return Boolean(
    expectedPrimary !== null &&
    isExactFallbackTextStable(expectedPrimary) &&
    isExactFallbackTextStable(input.primaryPrompt) &&
    input.primaryPrompt === expectedPrimary,
  );
}

export interface BrowserPromptArtifacts {
  markdown: string;
  composerText: string;
  estimatedInputTokens: number;
  attachments: BrowserAttachment[];
  inlineFileCount: number;
  tokenEstimateIncludesInlineFiles: boolean;
  attachmentsPolicy: "auto" | "never" | "always";
  attachmentMode: "inline" | "upload" | "bundle";
  fallback?: {
    composerText: string;
    attachments: BrowserAttachment[];
    reason: BrowserPromptFallbackReason;
    authorization: BrowserPromptFallbackAuthorization;
    bundled?: BrowserBundleMetadata | null;
  } | null;
  bundled?: BrowserBundleMetadata | null;
}

export interface BrowserBundleMetadata {
  originalCount: number;
  bundlePath: string;
  format?: BrowserBundleFormat;
}

interface AssemblePromptDeps {
  cwd?: string;
  readFilesImpl?: typeof readFiles;
  tokenizeImpl?: (typeof MODEL_CONFIGS)["gpt-5.1"]["tokenizer"];
}

interface WrittenBrowserBundle {
  attachment: BrowserAttachment;
  metadata: BrowserBundleMetadata;
  tokenEstimateText: string;
}

interface BrowserBundleSource {
  absolutePath: string;
  displayPath: string;
  sizeBytes: number;
  integritySha256: string;
}

type ResolvedBrowserBundleFormat = Exclude<BrowserBundleFormat, "auto">;

function formatSectionsForBundle(
  sections: Array<{ displayPath: string; content: string }>,
  options: { lineNumbers?: boolean } = {},
): string {
  return formatFileSections(sections, {
    lineNumbers: options.lineNumbers ?? true,
    trailingNewline: true,
  });
}

function resolveBrowserBundleFormat(
  format: BrowserBundleFormat,
  sources: { hasRawUploadFiles: boolean },
): ResolvedBrowserBundleFormat {
  if (format !== "auto") {
    return format;
  }
  return sources.hasRawUploadFiles ? "zip" : "text";
}

function shouldWriteBrowserBundle(
  format: ResolvedBrowserBundleFormat,
  {
    attachmentCount,
    bundleRequested,
    textSourceCount,
    textPlanShouldBundle,
  }: {
    attachmentCount: number;
    bundleRequested: boolean;
    textSourceCount: number;
    textPlanShouldBundle: boolean;
  },
): boolean {
  if (format === "zip") {
    return (
      textPlanShouldBundle ||
      (bundleRequested && attachmentCount > 0) ||
      attachmentCount > MAX_BROWSER_ATTACHMENTS
    );
  }
  return textSourceCount > 0 && (textPlanShouldBundle || attachmentCount > MAX_BROWSER_ATTACHMENTS);
}

function assertAttachmentCount(
  attachments: BrowserAttachment[],
  format: BrowserBundleFormat,
): void {
  if (attachments.length <= MAX_BROWSER_ATTACHMENTS) return;
  throw new Error(
    `Browser upload has ${attachments.length} attachments after applying bundle format "${format}". Use --browser-bundle-format auto or zip to stay within the ${MAX_BROWSER_ATTACHMENTS}-attachment limit.`,
  );
}

async function writeBrowserBundle(
  sections: FileSection[],
  sources: BrowserBundleSource[],
  format: ResolvedBrowserBundleFormat,
): Promise<WrittenBrowserBundle> {
  const bundleDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-browser-bundle-"));
  const tokenEstimateText = formatSectionsForBundle(sections, {
    lineNumbers: format === "text",
  });
  if (format === "zip") {
    const estimatedBundleBytes = estimateStoredZipSize(
      sources.map((source) => ({ path: source.displayPath, sizeBytes: source.sizeBytes })),
    );
    if (estimatedBundleBytes > MAX_BROWSER_ZIP_BUNDLE_BYTES) {
      throw new Error(
        `Browser ZIP bundle would be ${estimatedBundleBytes} bytes, exceeding the ${MAX_BROWSER_ZIP_BUNDLE_BYTES}-byte DataTransfer upload limit.`,
      );
    }
    const bundlePath = path.join(bundleDir, "attachments-bundle.zip");
    const verifiedSources: Array<{ path: string; content: Buffer }> = [];
    let sourceBytes = 0;
    for (const source of sources) {
      const remainingBytes = MAX_BROWSER_ZIP_BUNDLE_BYTES - sourceBytes;
      const verified = await readBoundedRegularFile(source.absolutePath, {
        maxBytes: Math.max(1, remainingBytes),
        declaredSizeBytes: source.sizeBytes,
        declaredSha256: source.integritySha256,
      });
      sourceBytes += verified.sizeBytes;
      if (sourceBytes > MAX_BROWSER_ZIP_BUNDLE_BYTES) {
        throw new Error(
          `Browser ZIP bundle sources exceed the ${MAX_BROWSER_ZIP_BUNDLE_BYTES}-byte DataTransfer upload limit.`,
        );
      }
      verifiedSources.push({ path: source.displayPath, content: verified.bytes });
    }
    const buffer = createStoredZip(verifiedSources);
    if (buffer.length > MAX_BROWSER_ZIP_BUNDLE_BYTES) {
      throw new Error(
        `Browser ZIP bundle is ${buffer.length} bytes, exceeding the ${MAX_BROWSER_ZIP_BUNDLE_BYTES}-byte DataTransfer upload limit.`,
      );
    }
    await fs.writeFile(bundlePath, buffer);
    return {
      attachment: {
        path: bundlePath,
        displayPath: bundlePath,
        sizeBytes: buffer.length,
        integritySha256: createHash("sha256").update(buffer).digest("hex"),
        generatedBundle: true,
      },
      metadata: { originalCount: sources.length, bundlePath, format },
      tokenEstimateText,
    };
  }
  const bundlePath = path.join(bundleDir, "attachments-bundle.txt");
  await fs.writeFile(bundlePath, tokenEstimateText, "utf8");
  return {
    attachment: {
      path: bundlePath,
      displayPath: bundlePath,
      sizeBytes: Buffer.byteLength(tokenEstimateText, "utf8"),
      integritySha256: createHash("sha256").update(tokenEstimateText, "utf8").digest("hex"),
      generatedBundle: true,
    },
    metadata: { originalCount: sections.length, bundlePath, format },
    tokenEstimateText,
  };
}

export async function assembleBrowserPrompt(
  runOptions: RunOracleOptions,
  deps: AssemblePromptDeps = {},
): Promise<BrowserPromptArtifacts> {
  const cwd = deps.cwd ?? process.cwd();
  const readFilesFn = deps.readFilesImpl ?? readFiles;

  const allFilePaths = runOptions.file ?? [];
  const discoveredFiles =
    allFilePaths.length > 0
      ? await readFilesFn(allFilePaths, {
          cwd,
          maxFileSizeBytes: 0,
          readContents: false,
        })
      : [];
  const textFilePaths = discoveredFiles
    .filter((file) => !isRawUploadFile(file.path))
    .map((file) => file.path);
  const rawUploadFiles = discoveredFiles.filter((file) => isRawUploadFile(file.path));
  const maxFileSizeBytes = runOptions.maxFileSizeBytes;

  const rawUploadAttachments: BrowserAttachment[] = await Promise.all(
    rawUploadFiles.map(async ({ path: filePath }) => {
      const resolvedPath = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
      // Raw browser uploads historically bypass the 1 MiB text-file default.
      // Keep that behavior, but impose a finite process-memory ceiling when
      // establishing the source digest. Explicit lower user limits still win.
      const effectiveMaxBytes = maxFileSizeBytes ?? MAX_BROWSER_ATTACHMENT_SOURCE_BYTES;
      const verified = await readBoundedRegularFile(resolvedPath, {
        maxBytes: effectiveMaxBytes,
      });
      return {
        path: resolvedPath,
        displayPath: path.relative(cwd, resolvedPath) || path.basename(resolvedPath),
        sizeBytes: verified.sizeBytes,
        integritySha256: verified.sha256,
      };
    }),
  );

  const files = await readFilesFn(textFilePaths, {
    cwd,
    maxFileSizeBytes: runOptions.maxFileSizeBytes,
  });
  const basePrompt = (runOptions.prompt ?? "").trim();
  const userPrompt = basePrompt;
  const systemPrompt = runOptions.system?.trim() || "";
  const sections = createFileSections(files, cwd);
  const markdown = buildPromptMarkdown(systemPrompt, userPrompt, sections);

  const attachmentsPolicy: "auto" | "never" | "always" = runOptions.browserInlineFiles
    ? "never"
    : (runOptions.browserAttachments ?? "auto");
  const bundleRequested = Boolean(runOptions.browserBundleFiles);
  const bundleFormat = runOptions.browserBundleFormat ?? "auto";
  if (attachmentsPolicy === "never" && rawUploadAttachments.length > 0) {
    throw new FileValidationError(
      "Raw or binary files cannot be pasted inline when browser attachments are disabled. Use --browser-attachments auto or always.",
      { files: rawUploadAttachments.map((attachment) => attachment.displayPath) },
    );
  }

  const inlinePlan = buildAttachmentPlan(sections, { inlineFiles: true, bundleRequested });
  const uploadPlan = buildAttachmentPlan(sections, { inlineFiles: false, bundleRequested });

  const baseComposerSections: string[] = [];
  if (systemPrompt) baseComposerSections.push(systemPrompt);
  if (userPrompt) baseComposerSections.push(userPrompt);

  const inlineComposerText = [...baseComposerSections, inlinePlan.inlineBlock]
    .filter(Boolean)
    .join("\n\n")
    .trim();
  const selectedPlan =
    attachmentsPolicy === "always"
      ? uploadPlan
      : attachmentsPolicy === "never"
        ? inlinePlan
        : inlineComposerText.length <= DEFAULT_BROWSER_INLINE_CHAR_BUDGET || sections.length === 0
          ? inlinePlan
          : uploadPlan;

  const textBundleSources: BrowserBundleSource[] = sections.map((section) => ({
    absolutePath: section.absolutePath,
    displayPath: section.displayPath,
    sizeBytes: Buffer.byteLength(section.content, "utf8"),
    integritySha256: createHash("sha256").update(section.content, "utf8").digest("hex"),
  }));
  const rawUploadBundleSources: BrowserBundleSource[] = rawUploadAttachments.map((attachment) => ({
    absolutePath: attachment.path,
    displayPath: attachment.displayPath,
    sizeBytes: attachment.sizeBytes ?? 0,
    integritySha256: attachment.integritySha256 ?? "",
  }));
  const allBundleSources = [...textBundleSources, ...rawUploadBundleSources];
  const attachments: BrowserAttachment[] = [...selectedPlan.attachments, ...rawUploadAttachments];

  const resolvedBundleFormat = resolveBrowserBundleFormat(bundleFormat, {
    hasRawUploadFiles: rawUploadAttachments.length > 0,
  });
  const shouldBundle = shouldWriteBrowserBundle(resolvedBundleFormat, {
    attachmentCount: attachments.length,
    bundleRequested,
    textSourceCount: textBundleSources.length,
    textPlanShouldBundle: selectedPlan.shouldBundle,
  });
  const composerText = (
    !shouldBundle && selectedPlan.inlineBlock
      ? [...baseComposerSections, selectedPlan.inlineBlock]
      : baseComposerSections
  )
    .filter(Boolean)
    .join("\n\n")
    .trim();

  let bundleText: string | null = null;
  let bundled: BrowserBundleMetadata | null = null;
  if (shouldBundle) {
    const writtenBundle = await writeBrowserBundle(
      sections,
      resolvedBundleFormat === "zip" ? allBundleSources : textBundleSources,
      resolvedBundleFormat,
    );
    bundleText = writtenBundle.tokenEstimateText;
    attachments.length = 0;
    attachments.push(writtenBundle.attachment);
    if (resolvedBundleFormat === "text") {
      attachments.push(...rawUploadAttachments);
    }
    bundled = writtenBundle.metadata;
  }
  assertAttachmentCount(attachments, resolvedBundleFormat);

  const inlineFileCount = shouldBundle ? 0 : selectedPlan.inlineFileCount;
  const modelConfig = isKnownModel(runOptions.model)
    ? MODEL_CONFIGS[runOptions.model]
    : MODEL_CONFIGS["gpt-5.1"];
  const tokenizer = deps.tokenizeImpl ?? modelConfig.tokenizer;
  const tokenizerUserContent =
    inlineFileCount > 0 && selectedPlan.inlineBlock
      ? [userPrompt, selectedPlan.inlineBlock]
          .filter((value) => Boolean(value?.trim()))
          .join("\n\n")
          .trim()
      : userPrompt;
  const tokenizerMessages = [
    systemPrompt ? { role: "system", content: systemPrompt } : null,
    tokenizerUserContent ? { role: "user", content: tokenizerUserContent } : null,
  ].filter(Boolean) as Array<{ role: "system" | "user"; content: string }>;
  let estimatedInputTokens = tokenizer(
    tokenizerMessages.length > 0 ? tokenizerMessages : [{ role: "user", content: "" }],
    TOKENIZER_OPTIONS,
  );
  const tokenEstimateIncludesInlineFiles = inlineFileCount > 0 && Boolean(selectedPlan.inlineBlock);
  if (!tokenEstimateIncludesInlineFiles && sections.length > 0) {
    const attachmentText = bundleText ?? formatFileSections(sections, { lineNumbers: false });
    const attachmentTokens = tokenizer(
      [{ role: "user", content: attachmentText }],
      TOKENIZER_OPTIONS,
    );
    estimatedInputTokens += attachmentTokens;
  }

  const configuredInputLimit =
    typeof runOptions.maxInput === "number" &&
    Number.isFinite(runOptions.maxInput) &&
    runOptions.maxInput > 0
      ? Math.min(modelConfig.inputLimit, Math.floor(runOptions.maxInput))
      : modelConfig.inputLimit;
  const fallbackAuthorization: BrowserPromptFallbackAuthorization = {
    attachmentsPolicy: "auto",
    bundleRequested: false,
    model: modelConfig.model,
    maxInputTokens: configuredInputLimit,
  };

  let fallback: BrowserPromptArtifacts["fallback"] = null;
  if (
    attachmentsPolicy === "auto" &&
    attachments.length === 0 &&
    selectedPlan.mode === "inline" &&
    sections.length > 0
  ) {
    const fallbackComposerText = baseComposerSections.join("\n\n").trim();
    const fallbackAttachments = [...uploadPlan.attachments, ...rawUploadAttachments];
    const fallbackBundleFormat = resolveBrowserBundleFormat(bundleFormat, {
      hasRawUploadFiles: rawUploadAttachments.length > 0,
    });
    const fallbackShouldBundle = shouldWriteBrowserBundle(fallbackBundleFormat, {
      attachmentCount: fallbackAttachments.length,
      bundleRequested,
      textSourceCount: textBundleSources.length,
      textPlanShouldBundle: uploadPlan.shouldBundle,
    });
    if (!fallbackShouldBundle) {
      assertAttachmentCount(fallbackAttachments, fallbackBundleFormat);
      fallback = {
        composerText: fallbackComposerText,
        attachments: fallbackAttachments,
        reason: "auto-inline-too-large-to-upload",
        authorization: fallbackAuthorization,
        bundled: null,
      };
    }
  } else {
    const uploadToInlineFallbackCandidate =
      attachmentsPolicy === "auto" &&
      attachments.length > 0 &&
      rawUploadAttachments.length === 0 &&
      !bundleRequested &&
      !shouldBundle &&
      sections.length > 0;
    let inlineEstimatedInputTokens = Number.POSITIVE_INFINITY;
    if (uploadToInlineFallbackCandidate) {
      const inlineTokenizerUserContent = [userPrompt, inlinePlan.inlineBlock]
        .filter((value) => Boolean(value?.trim()))
        .join("\n\n")
        .trim();
      const inlineTokenizerMessages = [
        systemPrompt ? { role: "system", content: systemPrompt } : null,
        inlineTokenizerUserContent ? { role: "user", content: inlineTokenizerUserContent } : null,
      ].filter(Boolean) as Array<{ role: "system" | "user"; content: string }>;
      inlineEstimatedInputTokens = tokenizer(
        inlineTokenizerMessages.length > 0
          ? inlineTokenizerMessages
          : [{ role: "user", content: "" }],
        TOKENIZER_OPTIONS,
      );
    }
    const uploadToInlineFallbackEligible =
      uploadToInlineFallbackCandidate && inlineEstimatedInputTokens <= configuredInputLimit;
    if (uploadToInlineFallbackEligible) {
      // The 60k character threshold is the normal planning preference, not a
      // proof that ChatGPT cannot accept the text. If upload stalls before any
      // dispatch, one exact-round-trip inline attempt is safe when the full
      // text remains inside the model/user token budget.
      fallback = {
        composerText: inlineComposerText,
        attachments: [],
        reason: "auto-upload-timeout-to-inline",
        authorization: fallbackAuthorization,
        bundled: null,
      };
    }
  }

  return {
    markdown,
    composerText,
    estimatedInputTokens,
    attachments,
    inlineFileCount,
    tokenEstimateIncludesInlineFiles,
    attachmentsPolicy,
    attachmentMode: shouldBundle
      ? "bundle"
      : attachments.length > 0
        ? "upload"
        : selectedPlan.mode === "bundle"
          ? "inline"
          : selectedPlan.mode,
    fallback,
    bundled,
  };
}

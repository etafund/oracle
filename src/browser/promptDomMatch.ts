import { createHash } from "node:crypto";

export const PROMPT_DOM_MATCH_PREFIX_LENGTH = 120;
export const PROMPT_DOM_RECIPROCAL_PREFIX_MIN_LENGTH = 30;

/**
 * Wire-contract identifiers for the canonicalizers whose digests authorize
 * remote capture-only recovery. A digest is meaningful only together with the
 * exact algorithm that produced it, so these values are signed into every
 * v2 recovery capability and rejected when a client/worker disagrees.
 */
export const PROMPT_RECOVERY_PREVIEW_ALGORITHM = "oracle.prompt-recovery-preview.v2" as const;
export const PROMPT_DOM_IDENTITY_ALGORITHM = "oracle.rendered-prompt-dom-identity.v2" as const;

/**
 * Normalize prompt Markdown and rendered ChatGPT turn text to the same
 * comparison form. ChatGPT's user-turn `innerText` can omit Markdown markers,
 * so ownership checks must remove those markers before taking a prefix.
 *
 * Keep this function closure-free. Its runtime source is embedded in CDP page
 * expressions below, where module-scoped helpers are unavailable.
 */
export function normalizePromptForDomMatch(value: unknown): string {
  let text = String(value ?? "")
    .normalize("NFKC")
    .toLowerCase();
  text = text.replace(/[\u200B-\u200D\uFEFF]/g, "");
  // Decode nested entities to a stable form. The persisted recovery preview is
  // already normalized and is normalized again when an older/newer client
  // reattaches, so this operation must be idempotent for ordinary inputs.
  for (let pass = 0; pass < 16; pass += 1) {
    const decoded = text.replace(/&(?:amp|lt|gt|quot|apos|nbsp|#\d+|#x[\da-f]+);/gi, (entity) => {
      const body = entity.slice(1, -1).toLowerCase();
      if (body === "amp") return "&";
      if (body === "lt") return "<";
      if (body === "gt") return ">";
      if (body === "quot") return '"';
      if (body === "apos") return "'";
      if (body === "nbsp") return " ";
      const radix = body.startsWith("#x") ? 16 : 10;
      const digits = body.slice(radix === 16 ? 2 : 1);
      const codePoint = Number.parseInt(digits, radix);
      return Number.isFinite(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : entity;
    });
    if (decoded === text) break;
    text = decoded;
  }
  text = text.replace(/!?\[([^\]]*)\]\((?:\\.|[^()\\]|\([^()]*\))*\)/g, "$1");
  // Older session metadata may contain a raw prompt prefix. If that prefix
  // ends inside a link/image destination, its closing `)` is unavailable even
  // though the rendered turn contains only the label/alt text. New records
  // normalize the complete prompt before truncating below.
  text = text.replace(/!?\[([^\]]*)\]\((?:\\.|[^\n\\])*$/g, "$1");
  text = text.replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1");
  text = text.replace(/^[\t ]{0,3}\[[^\]]+\]:[^\n]*$/gm, " ");
  text = text.replace(/<(https?:\/\/[^>]+|mailto:[^>]+)>/g, "$1");
  // Remove a fence's optional language line even when the saved raw preview
  // was cut before the closing fence. Then remove all remaining delimiters;
  // this also handles an inline-code close that lies past a 160-char preview.
  text = text.replace(/```[^\n`]*\n/g, " ");
  text = text.replace(/```[\p{L}\p{N}_+.-]*$/gu, " ");
  text = text.replace(/`+/g, "");
  text = text.replace(/^[\t ]{0,3}(?:>[\t ]*)+/gm, "");
  text = text.replace(/^[\t ]{0,3}(?:[-+*]|\d{1,9}[.)])[\t ]+/gm, "");
  text = text.replace(/^[\t ]{0,3}#{1,6}(?:[\t ]+|$)/gm, "");
  text = text.replace(/[\t ]+#+[\t ]*$/gm, "");
  text = text.replace(/^[\t ]{0,3}(?:=+|-+)[\t ]*$/gm, " ");
  // Strip only paired Markdown emphasis delimiters. Removing every `*`, `_`,
  // and `~` made distinct literal prompts collide (`foo_bar`/`foobar`,
  // `*.ts`/`.ts`, `~/.oracle`/`/.oracle`) and could manufacture ownership.
  // Boundary checks preserve identifier/glob/path punctuation while still
  // aligning ordinary rendered emphasis with its Markdown source.
  for (let pass = 0; pass < 4; pass += 1) {
    const prior = text;
    text = text.replace(
      /(^|[^\p{L}\p{N}\\])(\*\*|__|~~)(?=\S)([^\n]*?\S)\2(?=$|[^\p{L}\p{N}])/gu,
      "$1$3",
    );
    text = text.replace(
      /(^|[^\p{L}\p{N}\\])([*_])(?=\S)([^\n]*?\S)\2(?=$|[^\p{L}\p{N}])/gu,
      "$1$3",
    );
    if (text === prior) break;
  }
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Canonicalize the actual rendered user-message node for durable identity.
 *
 * This deliberately does not lowercase, collapse whitespace, or strip
 * punctuation/Markdown. It is applied to DOM text both when a committed turn
 * is bound and when recovery reopens it, so content-significant differences
 * remain different. Only browser line-ending variance and invisible transport
 * characters are normalized.
 *
 * Keep this closure-free: its source is embedded in CDP expressions.
 */
export function normalizeRenderedPromptDomIdentity(value: unknown): string {
  return String(value ?? "")
    .normalize("NFC")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\r\n?/g, "\n")
    .trim();
}

/**
 * Canonicalize raw input against the logical plaintext read from the active
 * composer. Unlike rendered-turn recovery identity, this comparison must
 * preserve leading/trailing whitespace and zero-width Unicode characters:
 * Chromium's editing-host Selection serializer preserves them byte-for-byte.
 *
 * Keep this closure-free: its source is embedded in CDP page expressions.
 */
export function normalizeExactComposerPromptIdentity(value: unknown): string {
  return String(value ?? "")
    .normalize("NFC")
    .replace(/\r\n?/g, "\n");
}

export const EXACT_COMPOSER_PROMPT_IDENTITY_NORMALIZER_DECLARATION = `const normalizeExactComposerPromptIdentity = ${normalizeExactComposerPromptIdentity.toString()};`;

export interface ExactComposerPromptTextRead {
  ok: boolean;
  value: string;
  reason:
    | null
    | "editor-missing"
    | "selection-api-unavailable"
    | "selection-state-unsupported"
    | "editor-not-focused"
    | "selection-read-failed"
    | "selection-restore-failed"
    | "focus-changed"
    | "editor-root-changed";
  selectionRestored: boolean;
  focusPreserved: boolean;
}

/**
 * Read the logical plaintext of an editing host without relying on innerText.
 *
 * Chromium's `innerText` inserts an extra separator around empty block nodes:
 * inserting `a\n\nb` into a contenteditable produces `a<div><br></div><div>b</div>`
 * and reports `a\n\n\nb`. A temporary Selection, by contrast, uses the browser's
 * editing-host plaintext serialization and returns the original `a\n\nb`.
 *
 * The caller gets a value only together with proof that the prior selection
 * and focused node survived the temporary read. Keep this function
 * closure-free: its source is embedded in CDP page expressions.
 */
export function readExactComposerPromptText(editor: unknown): ExactComposerPromptTextRead {
  const failure = (
    reason: Exclude<ExactComposerPromptTextRead["reason"], null>,
    options: { selectionRestored?: boolean; focusPreserved?: boolean } = {},
  ): ExactComposerPromptTextRead => ({
    ok: false,
    value: "",
    reason,
    selectionRestored: options.selectionRestored === true,
    focusPreserved: options.focusPreserved === true,
  });
  if (!editor || typeof editor !== "object") return failure("editor-missing");
  const element = editor as {
    tagName?: unknown;
    value?: unknown;
    ownerDocument?: unknown;
    getRootNode?: () => unknown;
    contains?: (node: unknown) => boolean;
  };
  const tagName = String(element.tagName ?? "").toLowerCase();
  if (tagName === "textarea" || tagName === "input") {
    return {
      ok: typeof element.value === "string",
      value: typeof element.value === "string" ? element.value : "",
      reason: typeof element.value === "string" ? null : "selection-read-failed",
      selectionRestored: true,
      focusPreserved: true,
    };
  }

  const documentLike = element.ownerDocument as
    | {
        activeElement?: unknown;
        createRange?: () => {
          selectNodeContents?: (node: unknown) => void;
          cloneRange?: () => unknown;
          startContainer?: unknown;
          startOffset?: number;
          endContainer?: unknown;
          endOffset?: number;
        };
        getSelection?: () => {
          rangeCount?: number;
          anchorNode?: unknown;
          anchorOffset?: number;
          focusNode?: unknown;
          focusOffset?: number;
          getRangeAt?: (index: number) => {
            cloneRange?: () => unknown;
            startContainer?: unknown;
            startOffset?: number;
            endContainer?: unknown;
            endOffset?: number;
          };
          removeAllRanges?: () => void;
          addRange?: (range: unknown) => void;
          setBaseAndExtent?: (
            anchorNode: unknown,
            anchorOffset: number,
            focusNode: unknown,
            focusOffset: number,
          ) => void;
          toString?: () => string;
        } | null;
      }
    | undefined;
  if (
    !documentLike ||
    typeof documentLike.createRange !== "function" ||
    typeof documentLike.getSelection !== "function"
  ) {
    return failure("selection-api-unavailable");
  }
  let root: unknown = documentLike;
  try {
    root = typeof element.getRootNode === "function" ? element.getRootNode() : documentLike;
  } catch {
    return failure("selection-api-unavailable");
  }
  const selectionOwner =
    root === documentLike
      ? documentLike
      : root && typeof (root as { getSelection?: unknown }).getSelection === "function"
        ? (root as typeof documentLike)
        : null;
  if (!selectionOwner || typeof selectionOwner.getSelection !== "function") {
    return failure("selection-api-unavailable");
  }
  const rootFocusOwner = root as { activeElement?: unknown };
  const initialActiveElement = documentLike.activeElement;
  const initialRootActiveElement = rootFocusOwner.activeElement;
  const effectiveActiveElement =
    root === documentLike ? initialActiveElement : initialRootActiveElement;
  if (
    !effectiveActiveElement ||
    (effectiveActiveElement !== editor && element.contains?.(effectiveActiveElement) !== true)
  ) {
    return failure("editor-not-focused", {
      selectionRestored: true,
      focusPreserved: true,
    });
  }
  const selection = selectionOwner.getSelection();
  if (
    !selection ||
    typeof selection.removeAllRanges !== "function" ||
    typeof selection.addRange !== "function" ||
    typeof selection.toString !== "function"
  ) {
    return failure("selection-api-unavailable");
  }

  const initialAnchorNode = selection.anchorNode;
  const initialAnchorOffset = Number(selection.anchorOffset ?? 0);
  const initialFocusNode = selection.focusNode;
  const initialFocusOffset = Number(selection.focusOffset ?? 0);
  const initialRangeCount = Number(selection.rangeCount ?? 0);
  if (
    !Number.isSafeInteger(initialRangeCount) ||
    initialRangeCount < 0 ||
    initialRangeCount > 1 ||
    !Number.isSafeInteger(initialAnchorOffset) ||
    initialAnchorOffset < 0 ||
    !Number.isSafeInteger(initialFocusOffset) ||
    initialFocusOffset < 0 ||
    (initialRangeCount > 0 && typeof selection.getRangeAt !== "function") ||
    (initialRangeCount === 0 && (initialAnchorNode != null || initialFocusNode != null)) ||
    (initialRangeCount === 1 && (initialAnchorNode == null || initialFocusNode == null)) ||
    ((initialAnchorNode != null || initialFocusNode != null) &&
      (initialAnchorNode == null ||
        initialFocusNode == null ||
        typeof selection.setBaseAndExtent !== "function"))
  ) {
    return failure("selection-state-unsupported");
  }
  const savedRanges: unknown[] = [];
  try {
    for (let index = 0; index < initialRangeCount; index += 1) {
      const range = selection.getRangeAt?.(index);
      if (!range || typeof range.cloneRange !== "function") {
        return failure("selection-api-unavailable");
      }
      savedRanges.push(range.cloneRange());
    }
  } catch {
    return failure("selection-api-unavailable");
  }

  let value = "";
  let readSucceeded = false;
  let selectionRestored = false;
  try {
    const range = documentLike.createRange();
    if (!range || typeof range.selectNodeContents !== "function") {
      return failure("selection-api-unavailable");
    }
    range.selectNodeContents(editor);
    selection.removeAllRanges();
    selection.addRange(range);
    value = selection.toString();
    readSucceeded = true;
  } catch {
    readSucceeded = false;
  } finally {
    try {
      selection.removeAllRanges();
      if (
        initialAnchorNode != null &&
        initialFocusNode != null &&
        typeof selection.setBaseAndExtent === "function"
      ) {
        selection.setBaseAndExtent(
          initialAnchorNode,
          initialAnchorOffset,
          initialFocusNode,
          initialFocusOffset,
        );
      } else {
        for (const range of savedRanges) selection.addRange(range);
      }
      if (initialAnchorNode != null && initialFocusNode != null) {
        selectionRestored =
          selection.anchorNode === initialAnchorNode &&
          Number(selection.anchorOffset ?? 0) === initialAnchorOffset &&
          selection.focusNode === initialFocusNode &&
          Number(selection.focusOffset ?? 0) === initialFocusOffset;
      } else {
        selectionRestored = Number(selection.rangeCount ?? 0) === initialRangeCount;
      }
    } catch {
      selectionRestored = false;
    }
  }

  const focusPreserved =
    documentLike.activeElement === initialActiveElement &&
    rootFocusOwner.activeElement === initialRootActiveElement;
  let rootPreserved = false;
  try {
    rootPreserved =
      (typeof element.getRootNode === "function" ? element.getRootNode() : documentLike) === root;
  } catch {
    rootPreserved = false;
  }
  if (!readSucceeded) {
    return failure("selection-read-failed", { selectionRestored, focusPreserved });
  }
  if (!selectionRestored) {
    return failure("selection-restore-failed", { focusPreserved });
  }
  if (!focusPreserved) {
    return failure("focus-changed", { selectionRestored });
  }
  if (!rootPreserved) {
    return failure("editor-root-changed", { selectionRestored, focusPreserved });
  }
  return {
    ok: true,
    value,
    reason: null,
    selectionRestored: true,
    focusPreserved: true,
  };
}

export const EXACT_COMPOSER_PROMPT_TEXT_READER_DECLARATION = `const readExactComposerPromptText = ${readExactComposerPromptText.toString()};`;

export interface RenderedPromptDomContentCandidate {
  /** Visible prompt text only (no link metadata). */
  text: string;
  /** Durable identity: visible text plus stable Markdown-link destinations. */
  identity: string;
}

/**
 * Return a stable href for an anchor that belongs to prompt content, or an
 * empty string for browser/UI/attachment links whose destinations are not a
 * stable part of the submitted Markdown.
 *
 * Keep this closure-free: its runtime source is embedded in CDP expressions.
 */
export function readStablePromptLinkHref(anchor: unknown): string {
  if (!anchor || typeof anchor !== "object") return "";
  const element = anchor as {
    parentElement?: unknown;
    getAttribute?: (name: string) => string | null;
    hasAttribute?: (name: string) => boolean;
  };
  const rawHref = String(element.getAttribute?.("href") ?? "").trim();
  if (!rawHref) return "";
  if (/^(?:blob|data|file|filesystem|javascript|sandbox):/i.test(rawHref)) return "";
  if (
    /(?:^|\/)backend-api\/(?:files?|uploads?)(?:\/|\?|#|$)/i.test(rawHref) ||
    /^https?:\/\/[^/]*(?:file-service|oaiusercontent)\.[^/]+\//i.test(rawHref) ||
    /(?:^|[?&])download-token=/i.test(rawHref)
  ) {
    return "";
  }
  if (element.hasAttribute?.("download")) return "";

  let current: unknown = anchor;
  for (let depth = 0; current && typeof current === "object" && depth < 12; depth += 1) {
    const node = current as {
      parentElement?: unknown;
      getAttribute?: (name: string) => string | null;
      hasAttribute?: (name: string) => boolean;
    };
    const role = String(node.getAttribute?.("role") ?? "").toLowerCase();
    const testId = String(node.getAttribute?.("data-testid") ?? "").toLowerCase();
    if (
      role === "button" ||
      role === "menuitem" ||
      role === "navigation" ||
      node.hasAttribute?.("download") ||
      /(?:attachment|upload|file-chip|turn-action|message-action)/.test(testId)
    ) {
      return "";
    }
    current = node.parentElement;
  }

  // getAttribute() preserves the authored destination instead of resolving a
  // relative link against the current (and potentially transient) /c/<id> URL.
  return rawHref.replace(/\r\n?/g, "\n");
}

/**
 * Extract exact prompt-content candidates from a top-level user turn.
 * Dedicated content nodes are preferred over the whole message wrapper so
 * edit controls, attachment chips, and other surrounding UI do not become
 * part of the prompt identity.
 *
 * Keep this closure-free: its runtime source is embedded in CDP expressions.
 */
export function readRenderedPromptDomContentCandidates(
  node: unknown,
): RenderedPromptDomContentCandidate[] {
  if (!node || typeof node !== "object") return [];
  const element = node as {
    innerText?: unknown;
    textContent?: unknown;
    matches?: (selector: string) => boolean;
    querySelector?: (selector: string) => unknown;
    querySelectorAll?: (selector: string) => Iterable<unknown> | ArrayLike<unknown>;
    contains?: (other: unknown) => boolean;
  };
  const messageSelector =
    '[data-message-author-role="user"][data-message-id], [data-turn="user"][data-message-id], [data-message-author-role="user"], [data-turn="user"], [data-message-id]';
  const messageNode =
    (typeof element.matches === "function" &&
    (element.matches('[data-message-author-role="user"]') ||
      element.matches('[data-turn="user"]') ||
      element.matches("[data-message-id]"))
      ? element
      : typeof element.querySelector === "function"
        ? element.querySelector(messageSelector)
        : null) ?? element;
  const message = messageNode as typeof element;
  const contentSelector =
    '[data-message-content], [data-testid="user-message"], .whitespace-pre-wrap, .markdown, .prose';
  const contentNodes: Array<typeof element> = [];
  if (typeof message.matches === "function" && message.matches(contentSelector)) {
    contentNodes.push(message);
  }
  if (typeof message.querySelectorAll === "function") {
    contentNodes.push(
      ...Array.from(message.querySelectorAll(contentSelector)).filter(
        (candidate): candidate is typeof element =>
          Boolean(candidate && typeof candidate === "object"),
      ),
    );
  }
  // Prefer the innermost prompt-content nodes. Broad wrappers often include
  // attachment chips or action labels in addition to the actual prompt.
  const promptNodes = contentNodes.filter(
    (candidate, index) =>
      !contentNodes.some(
        (other, otherIndex) =>
          index !== otherIndex &&
          typeof candidate.contains === "function" &&
          candidate.contains(other),
      ),
  );
  const sources = promptNodes.length > 0 ? promptNodes : [message];
  const candidates: RenderedPromptDomContentCandidate[] = [];
  const seen = new Set<string>();
  for (const source of sources) {
    const text = normalizeRenderedPromptDomIdentity(source.innerText ?? source.textContent ?? "");
    if (!text) continue;
    const links: Array<{ text: string; href: string }> = [];
    if (typeof source.querySelectorAll === "function") {
      for (const rawAnchor of Array.from(source.querySelectorAll("a[href]"))) {
        if (!rawAnchor || typeof rawAnchor !== "object") continue;
        const anchor = rawAnchor as { innerText?: unknown; textContent?: unknown };
        const href = readStablePromptLinkHref(anchor);
        if (!href) continue;
        links.push({
          text: normalizeRenderedPromptDomIdentity(anchor.innerText ?? anchor.textContent ?? ""),
          href,
        });
      }
    }
    const identity =
      links.length > 0 ? `${text}\n\u241eoracle-prompt-links:${JSON.stringify(links)}` : text;
    const key = `${text}\u0000${identity}`;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({ text, identity });
  }
  return candidates;
}

/**
 * Exact prompt-text ownership check. Extra rendered text is accepted only
 * when it is a trailing sequence of explicitly supplied attachment names.
 *
 * Keep this closure-free: its runtime source is embedded in CDP expressions.
 */
export function renderedPromptCandidateMatchesSubmission(
  candidateText: unknown,
  submittedPrompt: unknown,
  attachmentNames: unknown,
): boolean {
  const expected = normalizePromptForDomMatch(submittedPrompt);
  let remaining = normalizePromptForDomMatch(candidateText);
  if (!expected || !remaining) return false;
  if (remaining === expected) return true;
  if (!Array.isArray(attachmentNames) || attachmentNames.length === 0) return false;

  const unused = attachmentNames
    .map((name) => normalizePromptForDomMatch(name))
    .filter((name): name is string => Boolean(name));
  let stripped = 0;
  while (remaining !== expected && unused.length > 0) {
    let matchedIndex = -1;
    for (let index = 0; index < unused.length; index += 1) {
      const suffix = ` ${unused[index]}`;
      if (remaining.endsWith(suffix)) {
        matchedIndex = index;
        remaining = remaining.slice(0, -suffix.length).trimEnd();
        stripped += 1;
        break;
      }
    }
    if (matchedIndex < 0) return false;
    unused.splice(matchedIndex, 1);
  }
  return stripped > 0 && remaining === expected;
}

/**
 * Read the same content node from an outer/top-level user turn everywhere.
 * The declaration below embeds this helper for recovery-side CDP probes.
 *
 * Keep this closure-free: its runtime source is embedded in CDP expressions.
 */
export function readRenderedPromptDomIdentity(node: unknown): string {
  return readRenderedPromptDomContentCandidates(node)[0]?.identity ?? "";
}

/** SHA-256 of the complete rendered-DOM identity (never of a short preview). */
export function computeRenderedPromptDomSha256(value: unknown): string {
  return createHash("sha256")
    .update(normalizeRenderedPromptDomIdentity(value), "utf8")
    .digest("hex");
}

/**
 * Persist a DOM-comparable ownership prefix. This deliberately normalizes the
 * complete submitted prompt before truncating so a cutoff can never strand a
 * Markdown delimiter or link destination in new recovery records.
 */
export function buildPromptRecoveryOwnershipPreview(value: unknown): string {
  return normalizePromptForDomMatch(value).slice(0, PROMPT_DOM_MATCH_PREFIX_LENGTH);
}

/** Browser-context declaration for CDP expressions that need the same rules. */
export const PROMPT_DOM_NORMALIZER_DECLARATION = `const normalizePromptForDomMatch = ${normalizePromptForDomMatch.toString()};`;

/**
 * Browser-context declarations for exact rendered-user-turn identity. Call
 * `readRenderedPromptDomIdentity(topLevelUserTurn)` before hashing with
 * `crypto.subtle`; this is the canonical extraction rule used at submit time.
 */
export const PROMPT_DOM_IDENTITY_NORMALIZER_DECLARATION =
  `const normalizeRenderedPromptDomIdentity = ${normalizeRenderedPromptDomIdentity.toString()};\n` +
  `const readStablePromptLinkHref = ${readStablePromptLinkHref.toString()};\n` +
  `const readRenderedPromptDomContentCandidates = ${readRenderedPromptDomContentCandidates.toString()};\n` +
  `const readRenderedPromptDomIdentity = ${readRenderedPromptDomIdentity.toString()};`;

/** Browser-context declaration for exact prompt-content ownership matching. */
export const PROMPT_DOM_EXACT_MATCH_DECLARATION = `const renderedPromptCandidateMatchesSubmission = ${renderedPromptCandidateMatchesSubmission.toString()};`;

/** Browser-context SHA-256 helper for the identity string returned above. */
export const PROMPT_DOM_IDENTITY_SHA256_DECLARATION = `const computeRenderedPromptDomSha256InBrowser = async (value) => {
  const encoded = new TextEncoder().encode(normalizeRenderedPromptDomIdentity(value));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoded));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
};`;

// Markdown preservation heuristic (oracle-qfl).
//
// Some ChatGPT browser flows historically flattened the response —
// the assistant turn rendered as a single run-on string, losing list
// bullets and fenced code blocks. The bead asks the capture path to
// detect that drift, so the markdownGuard returns a structured
// preservation verdict that the higher-level captureVerdict embeds.

const FENCE_PATTERN = /(?:^|\n)```/g;
const HEADING_PATTERN = /(?:^|\n)#{1,6}\s+\S/g;
const UNORDERED_LIST_PATTERN = /(?:^|\n)[*\-+]\s+\S/g;
const ORDERED_LIST_PATTERN = /(?:^|\n)\d+\.\s+\S/g;
const INLINE_CODE_PATTERN = /`[^`\n]+`/g;
const LINK_PATTERN = /\[[^\]]+\]\([^)]+\)/g;

export interface MarkdownStructureCounts {
  fences: number;
  headings: number;
  unorderedItems: number;
  orderedItems: number;
  inlineCode: number;
  links: number;
}

function countMatches(text: string, re: RegExp): number {
  re.lastIndex = 0;
  let n = 0;
  while (re.exec(text) !== null) n += 1;
  return n;
}

/** Count structural markdown markers in a string. */
export function countMarkdownStructure(text: string): MarkdownStructureCounts {
  if (!text) {
    return { fences: 0, headings: 0, unorderedItems: 0, orderedItems: 0, inlineCode: 0, links: 0 };
  }
  return {
    fences: countMatches(text, FENCE_PATTERN),
    headings: countMatches(text, HEADING_PATTERN),
    unorderedItems: countMatches(text, UNORDERED_LIST_PATTERN),
    orderedItems: countMatches(text, ORDERED_LIST_PATTERN),
    inlineCode: countMatches(text, INLINE_CODE_PATTERN),
    links: countMatches(text, LINK_PATTERN),
  };
}

export interface MarkdownGuardInput {
  /** The expected source text (e.g. what the assistant rendered upstream). */
  readonly expected: string;
  /** The captured text Oracle's DOM probe produced. */
  readonly observed: string;
}

export interface MarkdownGuardResult {
  preserved: boolean;
  reason: string;
  expected: MarkdownStructureCounts;
  observed: MarkdownStructureCounts;
}

/**
 * Compare structural marker counts between an expected and observed
 * capture. Preservation requires:
 *
 *   1. observed counts are at least as large as expected counts for
 *      every structural marker (fences, headings, lists, inline code,
 *      links).
 *   2. fenced code blocks must be balanced (even count) in observed.
 *
 * Rule (1) tolerates extra markers the assistant added; rule (2)
 * catches the historical flattening failure where the closing fence
 * went missing.
 */
export function assertMarkdownPreserved(input: MarkdownGuardInput): MarkdownGuardResult {
  const expected = countMarkdownStructure(input.expected);
  const observed = countMarkdownStructure(input.observed);

  const issues: string[] = [];
  if (observed.fences < expected.fences) {
    issues.push(`fences ${observed.fences} < expected ${expected.fences}`);
  }
  if (observed.fences % 2 !== 0) {
    issues.push(`fences count (${observed.fences}) is odd — closing fence likely missing`);
  }
  if (observed.headings < expected.headings) {
    issues.push(`headings ${observed.headings} < expected ${expected.headings}`);
  }
  if (observed.unorderedItems < expected.unorderedItems) {
    issues.push(
      `unordered list items ${observed.unorderedItems} < expected ${expected.unorderedItems}`,
    );
  }
  if (observed.orderedItems < expected.orderedItems) {
    issues.push(`ordered list items ${observed.orderedItems} < expected ${expected.orderedItems}`);
  }
  if (observed.inlineCode < expected.inlineCode) {
    issues.push(`inline code spans ${observed.inlineCode} < expected ${expected.inlineCode}`);
  }
  if (observed.links < expected.links) {
    issues.push(`links ${observed.links} < expected ${expected.links}`);
  }

  if (issues.length === 0) {
    return {
      preserved: true,
      reason: "markdown structure preserved",
      expected,
      observed,
    };
  }
  return {
    preserved: false,
    reason: `markdown drift: ${issues.join("; ")}`,
    expected,
    observed,
  };
}

/**
 * Cheap one-arg check: returns true when the captured text has
 * structural markers AND every fenced code block has a matching
 * closing fence. Used as a default `markdownPreserved` heuristic when
 * the caller has no upstream baseline to compare against.
 */
export function hasBalancedMarkdown(text: string): boolean {
  if (!text) return false;
  const counts = countMarkdownStructure(text);
  if (counts.fences % 2 !== 0) return false;
  return (
    counts.fences +
      counts.headings +
      counts.unorderedItems +
      counts.orderedItems +
      counts.inlineCode +
      counts.links >
    0
  );
}

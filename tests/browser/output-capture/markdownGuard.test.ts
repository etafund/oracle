// Unit tests for the markdown preservation guard (oracle-qfl).

import { describe, expect, test } from "vitest";

import {
  assertMarkdownPreserved,
  countMarkdownStructure,
  hasBalancedMarkdown,
} from "../../../src/browser/output-capture/index.js";

const FULL_MARKDOWN = `# Heading

- item one
- item two

1. ordered first
2. ordered second

\`\`\`ts
const x = 1;
\`\`\`

Inline \`code\` and a [link](https://example.invalid/page).
`;

describe("countMarkdownStructure", () => {
  test("counts every structural marker", () => {
    const counts = countMarkdownStructure(FULL_MARKDOWN);
    expect(counts.headings).toBe(1);
    expect(counts.unorderedItems).toBe(2);
    expect(counts.orderedItems).toBe(2);
    expect(counts.fences).toBe(2);
    expect(counts.inlineCode).toBeGreaterThanOrEqual(1);
    expect(counts.links).toBe(1);
  });

  test("returns zeros for empty input", () => {
    const counts = countMarkdownStructure("");
    expect(counts.fences + counts.headings + counts.unorderedItems + counts.orderedItems).toBe(0);
  });
});

describe("hasBalancedMarkdown", () => {
  test("true for well-formed markdown", () => {
    expect(hasBalancedMarkdown(FULL_MARKDOWN)).toBe(true);
  });

  test("false when fences are unbalanced (the historical flattening failure)", () => {
    const broken = "Open fence:\n```ts\nconst x = 1;\n";
    expect(hasBalancedMarkdown(broken)).toBe(false);
  });

  test("false for a plain string with no markdown structure", () => {
    expect(hasBalancedMarkdown("just a sentence")).toBe(false);
  });

  test("false for an empty string", () => {
    expect(hasBalancedMarkdown("")).toBe(false);
  });
});

describe("assertMarkdownPreserved", () => {
  test("preserved when observed matches expected", () => {
    const result = assertMarkdownPreserved({
      expected: FULL_MARKDOWN,
      observed: FULL_MARKDOWN,
    });
    expect(result.preserved).toBe(true);
  });

  test("preserved when observed has MORE markers than expected", () => {
    const extra = `${FULL_MARKDOWN}\n## Bonus heading\n`;
    const result = assertMarkdownPreserved({ expected: FULL_MARKDOWN, observed: extra });
    expect(result.preserved).toBe(true);
  });

  test("flags missing list items", () => {
    const observed = "Item one Item two"; // lists flattened to a run-on string
    const result = assertMarkdownPreserved({
      expected: "- item one\n- item two\n",
      observed,
    });
    expect(result.preserved).toBe(false);
    expect(result.reason).toMatch(/unordered list/i);
  });

  test("flags missing fenced code blocks", () => {
    const observed = "const x = 1;"; // fences disappeared
    const result = assertMarkdownPreserved({
      expected: "```ts\nconst x = 1;\n```\n",
      observed,
    });
    expect(result.preserved).toBe(false);
    expect(result.reason).toMatch(/fences/i);
  });

  test("flags unbalanced fences in observed", () => {
    const observed = "```ts\nconst x = 1;\n"; // missing closing fence
    const result = assertMarkdownPreserved({
      expected: "```ts\nconst x = 1;\n```\n",
      observed,
    });
    expect(result.preserved).toBe(false);
    expect(result.reason).toMatch(/closing fence/i);
  });

  test("flags missing links", () => {
    const result = assertMarkdownPreserved({
      expected: "See [example](https://example.invalid/x).",
      observed: "See example.",
    });
    expect(result.preserved).toBe(false);
    expect(result.reason).toMatch(/links/i);
  });
});

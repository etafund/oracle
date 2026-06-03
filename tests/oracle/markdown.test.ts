import { describe, expect, test } from "vitest";
import { formatFileSection } from "../../src/oracle/markdown.js";

describe("formatFileSection", () => {
  test("annotates language from extension and line-numbers content by default", () => {
    const out = formatFileSection("src/app.ts", "const x = 1;\nconst y = 2;\n");
    expect(out).toContain("### File: src/app.ts");
    expect(out).toContain("Lines: 1-2");
    expect(out).toContain("```ts");
    expect(out).toContain("1 | const x = 1;");
    expect(out).toContain("2 | const y = 2;");
    expect(out.trimEnd()).toMatch(/```$/); // closes fence
  });

  test("preserves blank lines with line numbers", () => {
    const out = formatFileSection("notes.txt", "first\n\nthird\n");
    expect(out).toContain("Lines: 1-3");
    expect(out).toContain("1 | first\n2 | \n3 | third");
  });

  test("renders empty files without fake source lines", () => {
    const out = formatFileSection("empty.txt", "");
    expect(out).toContain("Lines: 0");
    expect(out).toContain("```\n\n```");
  });

  test("auto-extends fence when content includes backticks", () => {
    const sample = "const tpl = `value`;\n````\ninner fence\n````\n";
    const out = formatFileSection("a.js", sample);
    // Should use a fence longer than the longest run of backticks inside content
    const lines = out.split("\n");
    const fenceLine = lines[2];
    const fenceLength =
      fenceLine.replace("```js", "```").length === fenceLine.length
        ? fenceLine.length
        : fenceLine.startsWith("`")
          ? fenceLine.length
          : 0;
    const innerMax = Math.max(...[...sample.matchAll(/`+/g)].map((m) => m[0].length));
    expect(fenceLength).toBeGreaterThan(innerMax);
    expect(out).toContain("1 | const tpl = `value`;");
    expect(out).toContain("2 | ````");
  });

  test("can render raw file content without line numbers", () => {
    const out = formatFileSection("src/app.ts", "const x = 1;\n", { lineNumbers: false });
    expect(out).toContain("### File: src/app.ts");
    expect(out).not.toContain("Lines:");
    expect(out).toContain("```ts\nconst x = 1;\n```");
  });
});

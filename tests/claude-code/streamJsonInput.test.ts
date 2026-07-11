import { describe, expect, test } from "vitest";

import {
  ORACLE_CLAUDE_CODE_STREAM_JSON_INPUT_ENV_VAR,
  buildStreamJsonUserMessage,
  isStreamJsonInputEnabled,
  serializeStreamJsonMessage,
  type StreamJsonUserMessage,
} from "../../src/claude-code/streamJsonInput.js";
import type { AttachmentFileContent } from "../../src/oracle/files.js";
import { formatFileSection } from "../../src/oracle/markdown.js";
import { assertClaudeCodeInlineBudget } from "../../src/claude-code/inlineBudget.js";
import { FileValidationError } from "../../src/oracle/errors.js";

const CWD = "/repo";

function textFile(relPath: string, content: string): AttachmentFileContent {
  return { path: `${CWD}/${relPath}`, content };
}

function mediaFile(
  relPath: string,
  attachment: "image" | "document",
  mediaType: string,
  base64: string,
  rawByteLength: number,
): AttachmentFileContent {
  return { path: `${CWD}/${relPath}`, content: base64, attachment, mediaType, rawByteLength };
}

describe("isStreamJsonInputEnabled (bead oracle-router-8fa)", () => {
  test("defaults OFF when the env var is unset, empty, or falsey", () => {
    expect(isStreamJsonInputEnabled({})).toBe(false);
    for (const value of ["", " ", "0", "false", "no", "off", "nope", "2", "enabled?"]) {
      expect(
        isStreamJsonInputEnabled({ [ORACLE_CLAUDE_CODE_STREAM_JSON_INPUT_ENV_VAR]: value }),
      ).toBe(false);
    }
  });

  test("flips ON only for the explicit truthy tokens (case-insensitive, trimmed)", () => {
    for (const value of ["1", "true", "TRUE", "  true  ", "yes", "YES", "on", "On"]) {
      expect(
        isStreamJsonInputEnabled({ [ORACLE_CLAUDE_CODE_STREAM_JSON_INPUT_ENV_VAR]: value }),
      ).toBe(true);
    }
  });
});

describe("buildStreamJsonUserMessage content-block assembly", () => {
  test("base prompt becomes a leading text block", () => {
    const message = buildStreamJsonUserMessage("Review this", [], CWD);
    expect(message).toEqual<StreamJsonUserMessage>({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "Review this" }] },
    });
  });

  test("text files become text blocks that preserve line-numbering (default) byte-for-byte", () => {
    const content = "const a = 1;\nconst b = 2;\n";
    const message = buildStreamJsonUserMessage("Base", [textFile("src/foo.ts", content)], CWD);
    expect(message.message.content).toHaveLength(2);
    expect(message.message.content[0]).toEqual({ type: "text", text: "Base" });
    // Reuses the shared renderer, so the text block equals the legacy
    // per-file rendering with line numbers on.
    expect(message.message.content[1]).toEqual({
      type: "text",
      text: formatFileSection("src/foo.ts", content, { lineNumbers: true }),
    });
    const text = (message.message.content[1] as { text: string }).text;
    expect(text).toContain("### File: src/foo.ts");
    expect(text).toContain("1 | const a = 1;");
  });

  test("lineNumbers:false renders text blocks without line numbers", () => {
    const content = "hello\nworld\n";
    const message = buildStreamJsonUserMessage("", [textFile("a.txt", content)], CWD, {
      lineNumbers: false,
    });
    expect(message.message.content[0]).toEqual({
      type: "text",
      text: formatFileSection("a.txt", content, { lineNumbers: false }),
    });
    expect((message.message.content[0] as { text: string }).text).not.toContain("1 | hello");
  });

  test("images become base64 image blocks; PDFs become base64 document blocks", () => {
    const message = buildStreamJsonUserMessage(
      "Describe these",
      [
        mediaFile("pic.png", "image", "image/png", "aW1hZ2VCeXRlcw==", 10),
        mediaFile("doc.pdf", "document", "application/pdf", "cGRmQnl0ZXM=", 8),
      ],
      CWD,
    );
    expect(message.message.content).toEqual([
      { type: "text", text: "Describe these" },
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "aW1hZ2VCeXRlcw==" },
      },
      {
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: "cGRmQnl0ZXM=" },
      },
    ]);
  });

  test("preserves attachment order after the base prompt", () => {
    const message = buildStreamJsonUserMessage(
      "P",
      [
        textFile("first.txt", "one"),
        mediaFile("mid.png", "image", "image/png", "QUJD", 3),
        textFile("last.txt", "two"),
      ],
      CWD,
    );
    expect(message.message.content.map((block) => block.type)).toEqual([
      "text",
      "text",
      "image",
      "text",
    ]);
  });

  test("an empty base prompt with attachments emits no leading empty text block", () => {
    const message = buildStreamJsonUserMessage("", [textFile("only.txt", "x")], CWD);
    expect(message.message.content).toHaveLength(1);
    expect(message.message.content[0].type).toBe("text");
  });

  test("a fully empty turn still yields one (empty) text block so the envelope is valid", () => {
    const message = buildStreamJsonUserMessage("", [], CWD);
    expect(message.message.content).toEqual([{ type: "text", text: "" }]);
  });

  test("throws when a media attachment is missing its mediaType (internal invariant)", () => {
    const broken: AttachmentFileContent = {
      path: `${CWD}/x.png`,
      content: "QUJD",
      attachment: "image",
    };
    expect(() => buildStreamJsonUserMessage("p", [broken], CWD)).toThrow(/missing its mediaType/);
  });
});

describe("serializeStreamJsonMessage NDJSON well-formedness", () => {
  test("is a single line terminated by exactly one newline and round-trips through JSON.parse", () => {
    const message = buildStreamJsonUserMessage(
      "Review",
      [textFile("multi.txt", "line1\nline2\nline3\n")],
      CWD,
    );
    const serialized = serializeStreamJsonMessage(message);
    // Exactly one trailing newline, no interior literal newlines (embedded
    // file newlines are JSON-escaped to "\\n", never raw).
    expect(serialized.endsWith("\n")).toBe(true);
    expect(serialized.slice(0, -1)).not.toContain("\n");
    expect(serialized.split("\n")).toHaveLength(2);
    expect(JSON.parse(serialized)).toEqual(message);
  });

  test("base64 media data never contains a newline in the serialized line", () => {
    const serialized = serializeStreamJsonMessage(
      buildStreamJsonUserMessage(
        "look",
        [mediaFile("p.png", "image", "image/png", "QUJDRA==", 3)],
        CWD,
      ),
    );
    const parsed = JSON.parse(serialized) as StreamJsonUserMessage;
    const imageBlock = parsed.message.content.find((block) => block.type === "image");
    expect(imageBlock).toBeDefined();
    expect((imageBlock as { source: { data: string } }).source.data).not.toContain("\n");
  });
});

describe("stream-json budget is measured on ENCODED (post-base64) bytes", () => {
  test("a media bundle that fits raw but not once base64-encoded fails the budget", () => {
    // 300 raw bytes -> 400 base64 bytes (+33%). A budget of 360 sits between
    // the two, so budgeting on the raw size would pass but budgeting on the
    // encoded NDJSON (what actually hits stdin) must fail.
    const rawBytes = 300;
    const base64 = Buffer.alloc(rawBytes, 0x41).toString("base64");
    expect(base64.length).toBe(400);
    const serialized = serializeStreamJsonMessage(
      buildStreamJsonUserMessage(
        "",
        [mediaFile("big.png", "image", "image/png", base64, rawBytes)],
        CWD,
      ),
    );
    expect(serialized.length).toBeGreaterThan(400);
    // Encoded size is over a 360-byte budget -> rejected before the API 413.
    expect(() => assertClaudeCodeInlineBudget(serialized, 360, {})).toThrow(FileValidationError);
    // ...and comfortably passes a budget above the encoded size.
    expect(() => assertClaudeCodeInlineBudget(serialized, 4096, {})).not.toThrow();
  });
});

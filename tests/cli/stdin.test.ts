import { Readable } from "node:stream";
import { describe, expect, test } from "vitest";
import { readStdin, readStdinBytes, resolveDashPrompt } from "../../src/cli/stdin.js";

describe("stdin helpers", () => {
  test("readStdin reads the full stream payload", async () => {
    const stream = Readable.from(["Hello", " ", "world"]);
    await expect(readStdin(stream)).resolves.toBe("Hello world");
  });

  test("readStdinBytes preserves raw chunks for hashing", async () => {
    const stream = Readable.from([
      Buffer.from([0x20, 0x0a]),
      new Uint8Array(Buffer.from("toon:\n", "utf8")),
    ]);
    await expect(readStdinBytes(stream)).resolves.toEqual(Buffer.from(" \ntoon:\n", "utf8"));
  });

  test("resolveDashPrompt keeps normal prompts unchanged", async () => {
    await expect(resolveDashPrompt("normal prompt", Readable.from([]))).resolves.toBe(
      "normal prompt",
    );
  });

  test("resolveDashPrompt reads piped stdin without trimming prompt-file bytes", async () => {
    const stream = Readable.from(["Hello world\n"]);
    Object.assign(stream, { isTTY: false });
    await expect(resolveDashPrompt("-", stream)).resolves.toBe("Hello world\n");
  });

  test("resolveDashPrompt preserves Markdown fences and TOON blocks as opaque text", async () => {
    const prompt = [
      "  - keep leading spaces",
      "```toon",
      "items[2]{id,name}:",
      "  1,Ada",
      "  2,Linus",
      "```",
      "",
    ].join("\n");
    const stream = Readable.from([prompt]);
    Object.assign(stream, { isTTY: false });
    await expect(resolveDashPrompt("-", stream)).resolves.toBe(prompt);
  });

  test("resolveDashPrompt rejects tty stdin", async () => {
    const stream = Readable.from([]);
    Object.assign(stream, { isTTY: true });
    await expect(resolveDashPrompt("-", stream)).rejects.toThrow(/requires piped input/i);
  });

  test("resolveDashPrompt rejects empty stdin", async () => {
    const stream = Readable.from([]);
    Object.assign(stream, { isTTY: false });
    await expect(resolveDashPrompt("-", stream)).rejects.toThrow(/received empty stdin/i);
  });
});

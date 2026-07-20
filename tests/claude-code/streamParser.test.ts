import { describe, expect, test } from "vitest";

import {
  ClaudeCodeStreamNormalizer,
  extractAuthoritativeFinalText,
} from "../../src/claude-code/streamParser.js";

describe("Claude Code stream normalizer", () => {
  test("parses JSON lines with byte offsets and lengths", () => {
    const parser = new ClaudeCodeStreamNormalizer();
    const first = Buffer.from('{"type":"system","subtype":"init"}\n', "utf8");
    const second = Buffer.from('{"type":"result","result":"ok"}\n', "utf8");
    const events = parser.push("stdout", Buffer.concat([first, second]), "t0");

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      seq: 0,
      receivedAt: "t0",
      stream: "stdout",
      rawByteOffset: 0,
      rawByteLength: first.length,
      type: "system/init",
    });
    expect(events[1]).toMatchObject({
      seq: 1,
      rawByteOffset: first.length,
      rawByteLength: second.length,
      type: "result",
      text: "ok",
    });
  });

  test("selects one authoritative answer instead of concatenating stream layers", () => {
    const parser = new ClaudeCodeStreamNormalizer();
    const events = parser.push(
      "stdout",
      [
        {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "text_delta", text: "P" },
          },
        },
        {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "text_delta", text: "ONG" },
          },
        },
        {
          type: "assistant",
          message: { content: [{ type: "text", text: "PONG" }] },
        },
        { type: "result", subtype: "success", result: "PONG" },
      ]
        .map((event) => JSON.stringify(event))
        .join("\n") + "\n",
    );

    expect(events.map((event) => event.text).filter(Boolean)).toEqual(["P", "ONG", "PONG", "PONG"]);
    expect(extractAuthoritativeFinalText(events)).toBe("PONG");
    expect(extractAuthoritativeFinalText(events.slice(0, -1))).toBe("PONG");
    expect(extractAuthoritativeFinalText(events.slice(0, 2))).toBe("PONG");
  });

  test("handles split multibyte UTF-8 only after the full raw line arrives", () => {
    const parser = new ClaudeCodeStreamNormalizer();
    const line = Buffer.from(
      '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"🙂"}}}\n',
      "utf8",
    );
    const splitAt = line.indexOf(Buffer.from("🙂", "utf8")) + 1;

    expect(parser.push("stdout", line.subarray(0, splitAt))).toEqual([]);
    const events = parser.push("stdout", line.subarray(splitAt), "t1");

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      rawByteOffset: 0,
      rawByteLength: line.length,
      text: "🙂",
    });
    expect(events[0]?.rawText).toContain("🙂");
  });

  test("preserves invalid UTF-8 bytes as base64 and does not parse them", () => {
    const parser = new ClaudeCodeStreamNormalizer();
    const events = parser.push("stdout", Buffer.from([0xff, 0x0a]), "t2");

    expect(events).toEqual([
      expect.objectContaining({
        rawByteOffset: 0,
        rawByteLength: 2,
        rawBase64: "/wo=",
        json: null,
        parseError: "invalid_utf8",
      }),
    ]);
    expect(events[0]).not.toHaveProperty("rawText");
  });

  test("preserves CRLF bytes while parsing JSON", () => {
    const parser = new ClaudeCodeStreamNormalizer();
    const bytes = Buffer.from('{"type":"result","result":"ok"}\r\n', "utf8");
    const [event] = parser.push("stdout", bytes);

    expect(event).toMatchObject({
      rawByteLength: bytes.length,
      rawText: '{"type":"result","result":"ok"}\r\n',
      type: "result",
    });
  });

  test("emits a final partial line on finish", () => {
    const parser = new ClaudeCodeStreamNormalizer();
    parser.push("stdout", Buffer.from('{"type":"result","result":"partial"', "utf8"));

    const events = parser.finish("done");

    expect(events).toEqual([
      expect.objectContaining({
        seq: 0,
        receivedAt: "done",
        rawByteOffset: 0,
        partial: true,
        json: null,
        parseError: expect.any(String),
      }),
    ]);
  });

  test("preserves receive order across stdout and stderr", () => {
    const parser = new ClaudeCodeStreamNormalizer();
    expect(parser.push("stdout", Buffer.from('{"type":"result"', "utf8"))).toEqual([]);
    const stderrEvents = parser.push("stderr", Buffer.from("warning\n", "utf8"), "stderr-time");
    const stdoutEvents = parser.push(
      "stdout",
      Buffer.from(',"result":"ok"}\n', "utf8"),
      "stdout-time",
    );

    expect(stderrEvents[0]).toMatchObject({
      seq: 0,
      stream: "stderr",
      rawByteOffset: 0,
      rawByteLength: Buffer.byteLength("warning\n"),
      rawText: "warning\n",
      json: null,
    });
    expect(stdoutEvents[0]).toMatchObject({
      seq: 1,
      stream: "stdout",
      rawByteOffset: 0,
      text: "ok",
    });
  });

  test("fuzzes chunk boundaries while preserving byte offsets and final text", () => {
    const payload = Buffer.from(
      [
        '{"type":"system","subtype":"init","apiKeySource":"none","model":"claude-fable-5","tools":[],"mcp_servers":[],"permissionMode":"plan","slash_commands":[],"skills":[],"plugins":[],"fast_mode_state":"off"}',
        '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"alpha"}}}',
        '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"βeta"}}}',
        '{"type":"result","result":"final"}',
        "not-json",
      ].join("\n") + "\n",
      "utf8",
    );

    for (let seed = 1; seed <= 80; seed += 1) {
      const parser = new ClaudeCodeStreamNormalizer();
      const events = [];
      let offset = 0;
      let state = seed;
      while (offset < payload.length) {
        state = (state * 1103515245 + 12345) & 0x7fffffff;
        const chunkLength = Math.max(1, state % 17);
        const chunk = payload.subarray(offset, Math.min(payload.length, offset + chunkLength));
        events.push(...parser.push("stdout", chunk, `seed-${seed}`));
        offset += chunk.length;
      }
      events.push(...parser.finish(`seed-${seed}-done`));

      expect(events.reduce((sum, event) => sum + event.rawByteLength, 0)).toBe(payload.length);
      expect(events.map((event) => event.rawByteOffset)).toEqual([0, 203, 311, 419, 454]);
      expect(events.map((event) => event.text).filter(Boolean)).toEqual(["alpha", "βeta", "final"]);
      expect(events.at(-1)).toMatchObject({
        parseError: expect.any(String),
        rawText: "not-json\n",
      });
    }
  });

  test("fuzzes arbitrary byte lines without throwing or losing raw byte lengths", () => {
    for (let seed = 1; seed <= 120; seed += 1) {
      const bytes = Buffer.alloc(1 + (seed % 64));
      let state = seed;
      for (let i = 0; i < bytes.length; i += 1) {
        state = (state * 1664525 + 1013904223) >>> 0;
        bytes[i] = state & 0xff;
      }
      const payload = Buffer.concat([bytes, Buffer.from("\n")]);
      const parser = new ClaudeCodeStreamNormalizer();

      const events = parser.push("stdout", payload);

      expect(events.length).toBeGreaterThan(0);
      expect(events.reduce((sum, event) => sum + event.rawByteLength, 0)).toBe(payload.length);
      for (const event of events) {
        expect(event.rawText ?? event.rawBase64).toBeTruthy();
      }
    }
  });
});

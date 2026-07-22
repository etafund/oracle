import { describe, expect, test } from "vitest";

import {
  ClaudeCodePlanProtocolError,
  ClaudeCodeStreamNormalizer,
  extractAuthoritativeFinalText,
  type ClaudeCodeNormalizedEvent,
  type ClaudeCodePlanProtocolFailureReason,
} from "../../src/claude-code/streamParser.js";

const verifiedFableInit = {
  type: "system",
  subtype: "init",
  model: "claude-fable-5",
  permissionMode: "plan",
  tools: [],
};

function normalizeStream(records: readonly Record<string, unknown>[]) {
  const parser = new ClaudeCodeStreamNormalizer();
  return parser.push("stdout", records.map((record) => JSON.stringify(record)).join("\n") + "\n");
}

function assistantText(text: string): Record<string, unknown> {
  return {
    type: "assistant",
    message: { content: [{ type: "text", text }] },
  };
}

function resultText(
  result: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return { type: "result", subtype: "success", result, ...overrides };
}

function protocolText(
  command: "Write" | "ExitPlanMode",
  payload: Record<string, unknown>,
  inputHeader = false,
): string {
  return `${command}\n\n${inputHeader ? "Input\n\n" : ""}${JSON.stringify(payload)}`;
}

function expectPlanProtocolFailure(
  events: readonly ClaudeCodeNormalizedEvent[],
  reason: ClaudeCodePlanProtocolFailureReason,
): void {
  let thrown: unknown;
  try {
    extractAuthoritativeFinalText(events);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(ClaudeCodePlanProtocolError);
  expect(thrown).toMatchObject({
    code: "fable-plan-protocol-unrecoverable",
    reason,
  });
}

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

  test("recovers a redacted verified Fable terminal plan-protocol episode", () => {
    const completeReport = "# Adversarial review\n\nFull finding set.";
    const write = protocolText(
      "Write",
      {
        file_path: "/srv/accounts/redacted/.claude/plans/oracle-review.md",
        content: completeReport,
      },
      true,
    );
    const exit = protocolText("ExitPlanMode", { plan: "Short summary only." }, true);
    const events = normalizeStream([
      verifiedFableInit,
      assistantText(write),
      {
        type: "assistant",
        message: {
          content: [{ type: "thinking", thinking: "redacted internal reasoning" }],
        },
      },
      assistantText(exit),
      resultText(exit),
    ]);

    expect(events[2]?.text).toBeUndefined();
    expect(extractAuthoritativeFinalText(events)).toBe(completeReport);
  });

  test("fails closed when a verified Fable result terminates with Write and no ExitPlanMode", () => {
    const write = protocolText("Write", {
      file_path: "/home/redacted/.claude/plans/incomplete.md",
      content: "must not surface inside raw protocol",
    });
    const events = normalizeStream([verifiedFableInit, assistantText(write), resultText(write)]);

    expectPlanProtocolFailure(events, "missing-exit-envelope");
  });

  test("fails closed when the assistant snapshot fallback is Write with no ExitPlanMode", () => {
    const write = protocolText("Write", {
      file_path: "/home/redacted/.claude/plans/incomplete.md",
      content: "must not surface inside raw protocol",
    });
    const events = normalizeStream([verifiedFableInit, assistantText(write)]);

    expectPlanProtocolFailure(events, "missing-exit-envelope");
  });

  test("fails closed when the text-delta fallback is Write with no ExitPlanMode", () => {
    const write = protocolText("Write", {
      file_path: "/home/redacted/.claude/plans/incomplete.md",
      content: "must not surface inside raw protocol",
    });
    const events = normalizeStream([
      verifiedFableInit,
      {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: { type: "text_delta", text: write.slice(0, 12) },
        },
      },
      {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: { type: "text_delta", text: write.slice(12) },
        },
      },
    ]);

    expectPlanProtocolFailure(events, "missing-exit-envelope");
  });

  test("recovers a complete verified Fable plan episode from the assistant snapshot fallback", () => {
    const completeReport = "# Snapshot-only review\n\nComplete answer.";
    const write = protocolText("Write", {
      file_path: "/home/redacted/.claude/plans/snapshot.md",
      content: completeReport,
    });
    const exit = protocolText("ExitPlanMode", { plan: "Summary." });
    const events = normalizeStream([verifiedFableInit, assistantText(write), assistantText(exit)]);

    expect(extractAuthoritativeFinalText(events)).toBe(completeReport);
  });

  test("recovers an exact legacy terminal episode when no init event is available", () => {
    const completeReport = "# Legacy captured review\n\nComplete answer.";
    const exit = protocolText("ExitPlanMode", { plan: "Summary." });
    const events = normalizeStream([
      assistantText(
        protocolText("Write", {
          file_path: "/home/redacted/.claude/plans/review.md",
          content: completeReport,
        }),
      ),
      resultText(exit),
    ]);

    expect(extractAuthoritativeFinalText(events)).toBe(completeReport);
  });

  test.each([
    { label: "Input-rendered Write before a substantive result", inputHeader: true },
    { label: "plain Write before a direct full result", inputHeader: false },
  ])("keeps the ordinary result authoritative for $label", ({ inputHeader }) => {
    const completeReport = "# Direct answer\n\nThis result is already authoritative.";
    const events = normalizeStream([
      verifiedFableInit,
      assistantText(
        protocolText(
          "Write",
          {
            file_path: "/home/redacted/.claude/plans/review.md",
            content: "stale protocol content",
          },
          inputHeader,
        ),
      ),
      resultText(completeReport),
    ]);

    expect(extractAuthoritativeFinalText(events)).toBe(completeReport);
  });

  test("fails closed instead of pairing a stale Write across an intervening assistant snapshot", () => {
    const exit = protocolText("ExitPlanMode", { plan: "Summary." });
    const events = normalizeStream([
      verifiedFableInit,
      assistantText(
        protocolText("Write", {
          file_path: "/home/redacted/.claude/plans/stale.md",
          content: "stale answer",
        }),
      ),
      assistantText("Unrelated complete assistant response."),
      resultText(exit),
    ]);

    expectPlanProtocolFailure(events, "missing-write-envelope");
  });

  test("fails closed on adjacent ambiguous Write envelopes", () => {
    const exit = protocolText("ExitPlanMode", { plan: "Summary." });
    const events = normalizeStream([
      verifiedFableInit,
      assistantText(
        protocolText("Write", {
          file_path: "/home/redacted/.claude/plans/first.md",
          content: "first answer",
        }),
      ),
      assistantText(
        protocolText("Write", {
          file_path: "/home/redacted/.claude/plans/second.md",
          content: "second answer",
        }),
      ),
      resultText(exit),
    ]);

    expectPlanProtocolFailure(events, "ambiguous-write-envelopes");
  });

  test("fails closed when a prior complete result breaks the terminal episode", () => {
    const exit = protocolText("ExitPlanMode", { plan: "Summary." });
    const events = normalizeStream([
      verifiedFableInit,
      assistantText(
        protocolText("Write", {
          file_path: "/home/redacted/.claude/plans/old-run.md",
          content: "old run answer",
        }),
      ),
      resultText("Prior run completed."),
      resultText(exit),
    ]);

    expectPlanProtocolFailure(events, "missing-terminal-assistant-envelope");
  });

  test("selects the latest substantive result after an older complete protocol episode", () => {
    const oldExit = protocolText("ExitPlanMode", { plan: "Old summary." });
    const latestResult = "Latest complete result.";
    const events = normalizeStream([
      verifiedFableInit,
      assistantText(
        protocolText("Write", {
          file_path: "/home/redacted/.claude/plans/old.md",
          content: "old answer",
        }),
      ),
      resultText(oldExit),
      resultText(latestResult),
    ]);

    expect(extractAuthoritativeFinalText(events)).toBe(latestResult);
  });

  test("does not recover plan content from an error result", () => {
    const exit = protocolText("ExitPlanMode", { plan: "Summary." });
    const events = normalizeStream([
      verifiedFableInit,
      assistantText(
        protocolText("Write", {
          file_path: "/home/redacted/.claude/plans/review.md",
          content: "must not be recovered",
        }),
      ),
      resultText(exit, { subtype: "error_during_execution", is_error: true }),
    ]);

    expect(extractAuthoritativeFinalText(events)).toBe(exit);
  });

  test.each([
    {
      label: "non-Fable model",
      init: { ...verifiedFableInit, model: "claude-opus-4-8" },
    },
    {
      label: "non-plan permission mode",
      init: { ...verifiedFableInit, permissionMode: "default" },
    },
    {
      label: "non-empty tools",
      init: { ...verifiedFableInit, tools: ["Write"] },
    },
    {
      label: "missing tools evidence",
      init: {
        type: "system",
        subtype: "init",
        model: "claude-fable-5",
        permissionMode: "plan",
      },
    },
  ])("rejects recovery when available init evidence has $label", ({ init }) => {
    const exit = protocolText("ExitPlanMode", { plan: "Summary." });
    const events = normalizeStream([
      init,
      assistantText(
        protocolText("Write", {
          file_path: "/home/redacted/.claude/plans/review.md",
          content: "must not be recovered",
        }),
      ),
      resultText(exit),
    ]);

    expect(extractAuthoritativeFinalText(events)).toBe(exit);
  });

  test.each([
    { filePath: "relative/.claude/plans/review.md", label: "relative" },
    {
      filePath: "C:\\Users\\redacted\\.claude\\plans\\review.md",
      label: "Windows separators",
    },
    {
      filePath: "/home/redacted/../redacted/.claude/plans/review.md",
      label: "parent segment",
    },
    {
      filePath: "/home/redacted/./.claude/plans/review.md",
      label: "current-directory segment",
    },
    {
      filePath: "/home//redacted/.claude/plans/review.md",
      label: "non-normalized duplicate separator",
    },
    {
      filePath: "/home/redacted/.claude/plans/nested/review.md",
      label: "nested filename",
    },
    { filePath: "/home/redacted/.claude/plans/review.txt", label: "wrong extension" },
    { filePath: "/home/redacted/.claude/plans/review.MD", label: "wrong extension case" },
    { filePath: "/home/redacted/.claude/plans/.md", label: "empty basename" },
    { filePath: "/home/redacted/.claude/plans/review.md\nignored", label: "newline" },
    { filePath: "/home/redacted/.claude/plans/review.md\u0000ignored", label: "NUL" },
  ])("fails closed on a $label plan marker path", ({ filePath }) => {
    const exit = protocolText("ExitPlanMode", { plan: "Summary." });
    const events = normalizeStream([
      verifiedFableInit,
      assistantText(
        protocolText("Write", {
          file_path: filePath,
          content: "must not be recovered",
        }),
      ),
      resultText(exit),
    ]);

    expectPlanProtocolFailure(events, "invalid-plan-marker-path");
  });

  test("fails closed when an ExitPlanMode JSON envelope has trailing prose", () => {
    const exit = `${protocolText("ExitPlanMode", { plan: "Summary." })}\ntrailing prose`;
    const events = normalizeStream([
      verifiedFableInit,
      assistantText(
        protocolText("Write", {
          file_path: "/home/redacted/.claude/plans/review.md",
          content: "must not be recovered",
        }),
      ),
      resultText(exit),
    ]);

    expectPlanProtocolFailure(events, "malformed-exit-envelope");
  });

  test("fails closed on a malformed protocol-shaped terminal result without a Write", () => {
    const events = normalizeStream([
      verifiedFableInit,
      assistantText('ExitPlanMode\n\n{"plan":'),
      resultText('ExitPlanMode\n\n{"plan":'),
    ]);

    expectPlanProtocolFailure(events, "malformed-exit-envelope");
  });

  test("fails closed on an exact ExitPlanMode result with no recoverable Write", () => {
    const exit = protocolText("ExitPlanMode", { plan: "Summary." });
    const events = normalizeStream([verifiedFableInit, assistantText(exit), resultText(exit)]);

    expectPlanProtocolFailure(events, "missing-write-envelope");
  });

  test("does not reinterpret ordinary Write or ExitPlanMode discussion in a verified Fable run", () => {
    const terminal = "ExitPlanMode is a command you might see in documentation.";
    const events = normalizeStream([
      verifiedFableInit,
      {
        type: "assistant",
        message: {
          content: [{ type: "text", text: 'Write\n\n{"content":"not a plan"}' }],
        },
      },
      resultText(terminal),
    ]);

    expect(extractAuthoritativeFinalText(events)).toBe(terminal);
  });

  test.each([
    "Write a concise user-facing plan without using tools.",
    "ExitPlanMode is unavailable in this environment.",
  ])("keeps ordinary assistant-snapshot prose unchanged: %s", (terminal) => {
    const events = normalizeStream([verifiedFableInit, assistantText(terminal)]);

    expect(extractAuthoritativeFinalText(events)).toBe(terminal);
  });

  test.each(["result", "assistant snapshot", "text deltas"])(
    "keeps an exact terminal Write unchanged for a non-Fable %s",
    (terminalKind) => {
      const write = protocolText("Write", {
        file_path: "/home/redacted/.claude/plans/non-fable.md",
        content: "ordinary non-Fable protocol text",
      });
      const records = [{ ...verifiedFableInit, model: "claude-opus-4-8" }, assistantText(write)];
      if (terminalKind === "result") {
        records.push(resultText(write));
      } else if (terminalKind === "text deltas") {
        records.splice(1, 1, {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "text_delta", text: write },
          },
        });
      }

      expect(extractAuthoritativeFinalText(normalizeStream(records))).toBe(write);
    },
  );

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

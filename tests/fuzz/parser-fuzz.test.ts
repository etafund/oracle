import { describe, expect, test } from "vitest";

import {
  parseDurationOption,
  parseFloatOption,
  parseHeartbeatOption,
  parseIntOption,
  parseTimeoutOption,
} from "../../src/cli/options.ts";
import { splitShellLikeArgs } from "../../src/cli/args.ts";
import { normalizeChatgptUrl } from "../../src/browser/utils.ts";
import { normalizeMaxFileSizeBytes } from "../../src/oracle/files.ts";

class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  next(): number {
    this.state = (Math.imul(this.state, 1_664_525) + 1_013_904_223) >>> 0;
    return this.state;
  }

  int(maxExclusive: number): number {
    return this.next() % maxExclusive;
  }

  pick<T>(values: readonly T[]): T {
    return values[this.int(values.length)] as T;
  }
}

const CHARS = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ+-_.:/?&=@ \t\n";
const JUNK_SUFFIXES = ["msx", "abc", "px", "e", "..", "_", " 1", "\nHeader: x"];
const DURATION_JUNK_SUFFIXES = ["msx", "abc", "px", "e", "..", "_", "\nHeader: x"];
const NUMERIC_SEEDS = [
  "",
  " ",
  "0",
  "-0",
  "+0",
  "1",
  "-1",
  "+1",
  "42",
  " 42 ",
  "12.5",
  ".5",
  "1e3",
  "1e309",
  "Infinity",
  "NaN",
];

function randomString(rng: Rng, maxLength: number): string {
  const length = rng.int(maxLength + 1);
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += CHARS[rng.int(CHARS.length)] ?? "";
  }
  return out;
}

function fuzzStrings(seed: number, count: number): string[] {
  const rng = new Rng(seed);
  const generated: string[] = [];
  for (let i = 0; i < count; i += 1) {
    generated.push(randomString(rng, 24));
    generated.push(`${rng.pick(NUMERIC_SEEDS)}${rng.pick(JUNK_SUFFIXES)}`);
  }
  return [...NUMERIC_SEEDS, ...generated];
}

function strictIntegerValue(input: string): number | undefined {
  const trimmed = input.trim();
  if (!/^[+-]?\d+$/u.test(trimmed)) return undefined;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) ? value : undefined;
}

function strictNumberValue(input: string): number | undefined {
  const trimmed = input.trim();
  if (!/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?$/iu.test(trimmed)) return undefined;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : undefined;
}

function strictSizeValue(input: string): number | undefined {
  const trimmed = input.trim();
  if (!/^\d+$/u.test(trimmed)) return undefined;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function expectThrows(fn: () => unknown): void {
  expect(fn).toThrow();
}

describe("parser fuzz harness", () => {
  test("integer and size parsers reject partial numeric prefixes", () => {
    for (const input of fuzzStrings(0x0f17_1001, 300)) {
      const intValue = strictIntegerValue(input);
      if (intValue === undefined) {
        expectThrows(() => parseIntOption(input));
      } else {
        expect(parseIntOption(input)).toBe(intValue);
      }

      const sizeValue = strictSizeValue(input);
      if (input === "") {
        expect(normalizeMaxFileSizeBytes(input, "fuzz.maxFileSizeBytes")).toBeUndefined();
      } else if (sizeValue === undefined) {
        expectThrows(() => normalizeMaxFileSizeBytes(input, "fuzz.maxFileSizeBytes"));
      } else {
        expect(normalizeMaxFileSizeBytes(input, "fuzz.maxFileSizeBytes")).toBe(sizeValue);
      }
    }
  });

  test("float, timeout, and heartbeat parsers reject malformed numeric strings", () => {
    for (const input of fuzzStrings(0x0f17_2002, 300)) {
      const numberValue = strictNumberValue(input);
      if (numberValue === undefined) {
        expectThrows(() => parseFloatOption(input));
      } else {
        expect(parseFloatOption(input)).toBe(numberValue);
      }

      const normalized = input.trim().toLowerCase();
      if (normalized === "auto") {
        expect(parseTimeoutOption(input)).toBe("auto");
      } else if (numberValue !== undefined && numberValue > 0) {
        expect(parseTimeoutOption(input)).toBe(numberValue);
      } else {
        expectThrows(() => parseTimeoutOption(input));
      }

      if (normalized === "") {
        expect(parseHeartbeatOption(input)).toBe(30);
      } else if (normalized === "false" || normalized === "off") {
        expect(parseHeartbeatOption(input)).toBe(0);
      } else if (numberValue !== undefined && numberValue >= 0) {
        expect(parseHeartbeatOption(input)).toBe(numberValue);
      } else {
        expectThrows(() => parseHeartbeatOption(input));
      }
    }
  });

  test("duration parser accepts only complete positive duration specs", () => {
    const rng = new Rng(0x0f17_3003);
    const units = ["ms", "s", "m", "h"] as const;
    for (let i = 0; i < 300; i += 1) {
      const firstValue = 1 + rng.int(10_000);
      const firstUnit = rng.pick(units);
      const valid = `${firstValue}${firstUnit}${rng.int(5)}${rng.pick(units)}`;
      const parsed = parseDurationOption(valid, "Fuzz duration");
      expect(parsed).toBeGreaterThan(0);

      const invalid = `${firstValue}${firstUnit}${rng.pick(DURATION_JUNK_SUFFIXES)}${rng.int(5)}${rng.pick(units)}`;
      expectThrows(() => parseDurationOption(invalid, "Fuzz duration"));
    }
  });

  test("ChatGPT URL parser rejects look-alike and header-injection inputs", () => {
    const rng = new Rng(0x0f17_4004);
    const allowedHosts = ["chatgpt.com", "chat.openai.com"] as const;
    for (let i = 0; i < 150; i += 1) {
      const host = rng.pick(allowedHosts);
      const path = `/g/g-p-${rng.int(10_000)}/project`;
      expect(normalizeChatgptUrl(`${host}${path}`, "https://chatgpt.com/")).toBe(
        `https://${host}${path}`,
      );
    }

    for (const input of [
      "http://chatgpt.com/",
      "https://chatgpt.com.evil.test/",
      "https://chatgpt.com@evil.test/",
      "https://user:pass@chatgpt.com/",
      "https://chatgpt.com:444/",
      "https://chatgpt.com/path\nInjected: value",
    ]) {
      expectThrows(() => normalizeChatgptUrl(input, "https://chatgpt.com/"));
    }
  });

  test("shell-like arg splitter round-trips generated quoted tokens", () => {
    const rng = new Rng(0x0f17_5005);
    for (let i = 0; i < 200; i += 1) {
      const tokens = Array.from({ length: 1 + rng.int(6) }, () =>
        randomString(rng, 12).replace(/[\0"]/g, "x"),
      );
      const encoded = tokens.map((token) => `"${token.replace(/\\/g, "\\\\")}"`).join(" ");
      expect(splitShellLikeArgs(encoded, { optionName: "fuzz args" })).toEqual(tokens);
    }
  });
});

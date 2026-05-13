import { expect } from "vitest";

export interface GoldenSnapshotOptions {
  readonly scrubPaths?: boolean;
}

export function stableGoldenJson(value: unknown, options: GoldenSnapshotOptions = {}): string {
  const prepared = options.scrubPaths ? scrubPaths(sortKeysDeep(value)) : sortKeysDeep(value);
  return `${JSON.stringify(prepared, null, 2)}\n`;
}

export function expectGoldenJson(
  value: unknown,
  expected: string,
  options: GoldenSnapshotOptions = {},
): void {
  expect(stableGoldenJson(value, options)).toBe(normalizeExpected(expected));
}

function normalizeExpected(value: string): string {
  const lines = value.replace(/\r\n/g, "\n").split("\n");
  while (lines.length > 0 && lines[0]?.trim() === "") {
    lines.shift();
  }
  while (lines.length > 0 && lines[lines.length - 1]?.trim() === "") {
    lines.pop();
  }
  const indentation = lines
    .filter((line) => line.trim() !== "")
    .map((line) => line.match(/^\s*/)?.[0].length ?? 0);
  const minIndent = indentation.length > 0 ? Math.min(...indentation) : 0;
  const normalized = lines.map((line) => line.slice(minIndent)).join("\n");
  return `${normalized}\n`;
}

function scrubPaths(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(scrubPaths);
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[key] = scrubPaths(child);
    }
    return out;
  }
  if (typeof value !== "string") {
    return value;
  }
  return value
    .replace(/\/private\/tmp\/oracle-[^/\s"]+/g, "<TMP>")
    .replace(/\/tmp\/oracle-[^/\s"]+/g, "<TMP>")
    .replace(/\/var\/folders\/[^/\s"]+(?:\/[^/\s"]+)*/g, "<TMP>");
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const record = value as Record<string, unknown>;
  return Object.keys(record)
    .sort()
    .reduce<Record<string, unknown>>((acc, key) => {
      const sorted = sortKeysDeep(record[key]);
      if (sorted !== undefined) {
        acc[key] = sorted;
      }
      return acc;
    }, {});
}

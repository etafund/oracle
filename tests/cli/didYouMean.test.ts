import { describe, expect, it } from "vitest";
import { levenshteinDistance, nearestByEditDistance } from "../../src/cli/didYouMean.js";

describe("levenshteinDistance", () => {
  it("is 0 for identical strings (case-insensitive)", () => {
    expect(levenshteinDistance("status", "status")).toBe(0);
    expect(levenshteinDistance("Status", "STATUS")).toBe(0);
  });

  it("counts a single substitution as distance 1", () => {
    expect(levenshteinDistance("chatgpt-pr0", "chatgpt-pro")).toBe(1);
  });

  it("counts a single deletion as distance 1", () => {
    expect(levenshteinDistance("dry-ru", "dry-run")).toBe(1);
  });

  it("counts a single insertion as distance 1", () => {
    expect(levenshteinDistance("statuss", "status")).toBe(1);
  });

  it("does not give transposition credit (plain, not Damerau, Levenshtein)", () => {
    // "fiel" -> "file" is a transposition of the last two characters;
    // plain Levenshtein (insert/delete/substitute only) costs 2, not 1.
    expect(levenshteinDistance("fiel", "file")).toBe(2);
  });

  it("is symmetric", () => {
    expect(levenshteinDistance("banana", "bandana")).toBe(levenshteinDistance("bandana", "banana"));
  });
});

describe("nearestByEditDistance", () => {
  const candidates = ["status", "session", "doctor", "restart", "capabilities", "robot-docs"];

  it("returns the nearest candidate at exactly distance 1", () => {
    expect(nearestByEditDistance("statuss", candidates)).toBe("status");
    expect(nearestByEditDistance("staus", candidates)).toBe("status");
  });

  it("returns null for an exact match (not a typo)", () => {
    expect(nearestByEditDistance("status", candidates)).toBeNull();
  });

  it("returns null when nothing is within the default distance-1 bar", () => {
    expect(nearestByEditDistance("this-command-does-not-exist", candidates)).toBeNull();
  });

  it("respects a wider maxDistance when the caller asks for it", () => {
    expect(nearestByEditDistance("statxx", candidates, 1)).toBeNull();
    expect(nearestByEditDistance("statxx", candidates, 2)).toBe("status");
  });

  it("keeps the first candidate on a tie, given a stable candidate order", () => {
    // "aa" is distance 1 from both "ab" and "ba"... but let's use an
    // unambiguous tie: "xa" is distance 1 from "xb" and from "xc" is not
    // (distance 1 vs 1 too) - construct a clean tie explicitly.
    expect(nearestByEditDistance("xa", ["xb", "xc"])).toBe("xb");
  });
});

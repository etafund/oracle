import { describe, expect, it } from "vitest";
import { formatElapsedCompact } from "../../src/oracle/finishLine.js";

describe("formatElapsedCompact", () => {
  it("formats sub-minute durations with one decimal", () => {
    expect(formatElapsedCompact(0)).toBe("0.0s");
    expect(formatElapsedCompact(1500)).toBe("1.5s");
    expect(formatElapsedCompact(59_949)).toBe("59.9s");
  });

  it("regression: rolls the 59.95s..60s rounding window into the minute format instead of showing 60.0s", () => {
    expect(formatElapsedCompact(59_950)).toBe("1m00s");
    expect(formatElapsedCompact(59_960)).toBe("1m00s");
    expect(formatElapsedCompact(59_999)).toBe("1m00s");
    expect(formatElapsedCompact(60_000)).toBe("1m00s");
  });

  it("formats minute and hour durations", () => {
    expect(formatElapsedCompact(61_000)).toBe("1m01s");
    expect(formatElapsedCompact(59 * 60_000 + 59_000)).toBe("59m59s");
    expect(formatElapsedCompact(60 * 60_000)).toBe("1h00m");
    expect(formatElapsedCompact(2 * 60 * 60_000 + 5 * 60_000)).toBe("2h05m");
  });

  it("returns unknown for negative or non-finite input", () => {
    expect(formatElapsedCompact(-1)).toBe("unknown");
    expect(formatElapsedCompact(Number.NaN)).toBe("unknown");
    expect(formatElapsedCompact(Number.POSITIVE_INFINITY)).toBe("unknown");
  });
});

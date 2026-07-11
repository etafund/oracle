import { describe, expect, test } from "vitest";
import {
  IN_FLIGHT_SESSION_STATUSES,
  SESSION_STATUS_VALUES,
  TERMINAL_SESSION_STATUSES,
  coerceSessionStatus,
  isSuccessTerminalStatus,
  isTerminalSessionStatus,
} from "../../src/cli/sessionStatus.ts";

describe("SESSION_STATUS_VALUES", () => {
  test("is the exact closed enum an agent can switch on", () => {
    expect([...SESSION_STATUS_VALUES]).toEqual([
      "pending",
      "running",
      "completed",
      "partial",
      "error",
      "cancelled",
    ]);
  });

  test("terminal + in-flight partition the full enum exactly", () => {
    expect([...TERMINAL_SESSION_STATUSES, ...IN_FLIGHT_SESSION_STATUSES].sort()).toEqual(
      [...SESSION_STATUS_VALUES].sort(),
    );
    // disjoint
    for (const terminal of TERMINAL_SESSION_STATUSES) {
      expect(IN_FLIGHT_SESSION_STATUSES).not.toContain(terminal);
    }
  });
});

describe("isTerminalSessionStatus", () => {
  test("recognizes every terminal status and rejects in-flight ones", () => {
    for (const status of TERMINAL_SESSION_STATUSES) {
      expect(isTerminalSessionStatus(status)).toBe(true);
    }
    for (const status of IN_FLIGHT_SESSION_STATUSES) {
      expect(isTerminalSessionStatus(status)).toBe(false);
    }
    expect(isTerminalSessionStatus("cancelled")).toBe(true);
  });
});

describe("isSuccessTerminalStatus", () => {
  test("only completed and partial are agent-facing successes", () => {
    expect(isSuccessTerminalStatus("completed")).toBe(true);
    expect(isSuccessTerminalStatus("partial")).toBe(true);
    expect(isSuccessTerminalStatus("error")).toBe(false);
    expect(isSuccessTerminalStatus("cancelled")).toBe(false);
    expect(isSuccessTerminalStatus("running")).toBe(false);
  });
});

describe("coerceSessionStatus", () => {
  test("passes through every valid status verbatim", () => {
    for (const status of SESSION_STATUS_VALUES) {
      expect(coerceSessionStatus(status)).toBe(status);
    }
  });

  test("falls back to error for an off-contract string (never leaks an unknown value)", () => {
    expect(coerceSessionStatus("weird")).toBe("error");
    expect(coerceSessionStatus("")).toBe("error");
  });
});

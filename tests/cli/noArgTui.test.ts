import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../../src/cli/tui/index.js", () => ({
  launchTui: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../src/cli/sessionDisplay.js", () => ({
  attachSession: vi.fn().mockResolvedValue(undefined),
  showStatus: vi.fn().mockResolvedValue(undefined),
  formatCompletionSummary: vi.fn(() => "completed"),
}));

const launchTuiMock = vi.mocked(await import("../../src/cli/tui/index.js")).launchTui as ReturnType<
  typeof vi.fn
>;
const showStatusMock = vi.mocked(
  await import("../../src/cli/sessionDisplay.js"),
).showStatus as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  delete process.env.ORACLE_FORCE_TUI;
});

describe("zero-arg TUI entry", () => {
  test("shows help when no args (no TUI)", async () => {
    const originalArgv = process.argv;
    const originalTty = process.stdout.isTTY;
    process.argv = ["node", "bin/oracle-cli.js"]; // mimics zero-arg user input
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });

    await import("../../bin/oracle-cli.js");

    // Commander wires the action async; poll briefly to avoid flakiness on slower runners.
    for (let i = 0; i < 10 && launchTuiMock.mock.calls.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(launchTuiMock).not.toHaveBeenCalled();

    // restore
    process.argv = originalArgv;
    Object.defineProperty(process.stdout, "isTTY", { value: originalTty, configurable: true });
  }, 15_000);

  test("does not let ORACLE_FORCE_TUI hijack explicit root status alias", async () => {
    const originalArgv = process.argv;
    const originalTty = process.stdout.isTTY;
    const originalForceTui = process.env.ORACLE_FORCE_TUI;
    process.argv = ["node", "bin/oracle-cli.js", "--status"];
    process.env.ORACLE_FORCE_TUI = "1";
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });

    await import("../../bin/oracle-cli.js");

    for (let i = 0; i < 10 && showStatusMock.mock.calls.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(launchTuiMock).not.toHaveBeenCalled();
    expect(showStatusMock).toHaveBeenCalled();

    process.argv = originalArgv;
    if (originalForceTui === undefined) {
      delete process.env.ORACLE_FORCE_TUI;
    } else {
      process.env.ORACLE_FORCE_TUI = originalForceTui;
    }
    Object.defineProperty(process.stdout, "isTTY", { value: originalTty, configurable: true });
  }, 15_000);

  test("invokes launchTui via subcommand", async () => {
    const originalArgv = process.argv;
    const originalTty = process.stdout.isTTY;
    process.argv = ["node", "bin/oracle-cli.js", "tui"];
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });

    await import("../../bin/oracle-cli.js");

    for (let i = 0; i < 10 && launchTuiMock.mock.calls.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(launchTuiMock).toHaveBeenCalled();

    process.argv = originalArgv;
    Object.defineProperty(process.stdout, "isTTY", { value: originalTty, configurable: true });
  }, 15_000);
});

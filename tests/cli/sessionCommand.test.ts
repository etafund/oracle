import { afterEach, describe, expect, test, vi } from "vitest";
import { Command } from "commander";
import { handleSessionCommand, type StatusOptions } from "../../src/cli/sessionCommand.ts";

function createCommandWithOptions(options: StatusOptions): Command {
  const command = new Command();
  command.setOptionValueWithSource("hours", options.hours, "cli");
  command.setOptionValueWithSource("limit", options.limit, "cli");
  command.setOptionValueWithSource("all", options.all, "cli");
  if (options.path !== undefined) {
    command.setOptionValueWithSource("path", options.path, "cli");
  }
  if (options.clear !== undefined) {
    command.setOptionValueWithSource("clear", options.clear, "cli");
  }
  if (options.clean !== undefined) {
    command.setOptionValueWithSource("clean", options.clean, "cli");
  }
  if (options.yes !== undefined) {
    command.setOptionValueWithSource("yes", options.yes, "cli");
  }
  if (options.harvest !== undefined) {
    command.setOptionValueWithSource("harvest", options.harvest, "cli");
  }
  if (options.live !== undefined) {
    command.setOptionValueWithSource("live", options.live, "cli");
  }
  if (options.writeOutput !== undefined) {
    command.setOptionValueWithSource("writeOutput", options.writeOutput, "cli");
  }
  if (options.browserTab !== undefined) {
    command.setOptionValueWithSource("browserTab", options.browserTab, "cli");
  }
  if (options.artifacts !== undefined) {
    command.setOptionValueWithSource("artifacts", options.artifacts, "cli");
  }
  if (options.json !== undefined) {
    command.setOptionValueWithSource("json", options.json, "cli");
  }
  return command;
}

function createDeps() {
  return {
    showStatus: vi.fn(),
    attachSession: vi.fn(),
    harvestSessionBrowserOutput: vi.fn(),
    liveTailSessionBrowserOutput: vi.fn(),
    usesDefaultStatusFilters: vi.fn(),
    deleteSessionsOlderThan: vi.fn(),
    getSessionPaths: vi.fn(),
    buildSessionArtifactIndex: vi.fn(),
    runSessionListJson: vi.fn(),
  };
}

describe("handleSessionCommand", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  test("lists sessions when no id provided", async () => {
    const command = createCommandWithOptions({ hours: 12, limit: 5, all: false });
    const deps = createDeps();
    deps.usesDefaultStatusFilters.mockReturnValue(true);
    await handleSessionCommand(undefined, command, deps);
    expect(deps.showStatus).toHaveBeenCalledWith({
      hours: 12,
      includeAll: false,
      limit: 5,
      showExamples: true,
    });
  });

  test("emits the session list JSON when --json is provided with no id", async () => {
    const command = createCommandWithOptions({
      hours: 12,
      limit: 5,
      all: false,
      json: true,
    } as StatusOptions);
    const deps = createDeps();
    await handleSessionCommand(undefined, command, deps);
    expect(deps.runSessionListJson).toHaveBeenCalledWith({
      hours: 12,
      includeAll: false,
      limit: 5,
      modelFilter: undefined,
    });
    expect(deps.showStatus).not.toHaveBeenCalled();
  });

  test("attaches when id provided", async () => {
    const command = createCommandWithOptions({ hours: 24, limit: 10, all: false });
    const deps = createDeps();
    await handleSessionCommand("abc", command, deps);
    expect(deps.attachSession).toHaveBeenCalledWith(
      "abc",
      expect.objectContaining({ renderMarkdown: false }),
    );
  });

  test("ignores unrelated root-only flags and logs a note when attaching by id", async () => {
    const command = createCommandWithOptions({ hours: 24, limit: 400, all: false });
    // Simulate passing a root-only flag (preview) that the session handler should ignore.
    command.setOptionValueWithSource("preview", true, "cli");

    const deps = createDeps();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await handleSessionCommand("swiftui-menubarextra-on-macos-15", command, deps);

    expect(deps.attachSession).toHaveBeenCalledWith(
      "swiftui-menubarextra-on-macos-15",
      expect.objectContaining({ renderMarkdown: false }),
    );
    expect(deps.showStatus).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith("Ignoring flags on session attach: preview");
    expect(process.exitCode).toBeUndefined();
  });

  test("prints paths when --path is provided with an id", async () => {
    const command = createCommandWithOptions({
      hours: 24,
      limit: 10,
      all: false,
      path: true,
    } as StatusOptions);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const deps = createDeps();
    deps.getSessionPaths.mockResolvedValue({
      dir: "/tmp/.oracle/sessions/abc",
      metadata: "/tmp/.oracle/sessions/abc/meta.json",
      request: "/tmp/.oracle/sessions/abc/request.json",
      log: "/tmp/.oracle/sessions/abc/output.log",
    });

    await handleSessionCommand("abc", command, deps);

    expect(deps.getSessionPaths).toHaveBeenCalledWith("abc");
    expect(logSpy).toHaveBeenCalledWith("Session dir: /tmp/.oracle/sessions/abc");
    expect(logSpy).toHaveBeenCalledWith("Metadata: /tmp/.oracle/sessions/abc/meta.json");
    expect(logSpy).toHaveBeenCalledWith("Request: /tmp/.oracle/sessions/abc/request.json");
    expect(logSpy).toHaveBeenCalledWith("Log: /tmp/.oracle/sessions/abc/output.log");
    expect(process.exitCode).toBeUndefined();
  });

  test("errors when --path is provided without an id", async () => {
    const command = createCommandWithOptions({
      hours: 24,
      limit: 10,
      all: false,
      path: true,
    } as StatusOptions);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await handleSessionCommand(undefined, command, createDeps());

    expect(errorSpy).toHaveBeenCalledWith(
      "The --path flag requires a session ID. Run: oracle session <sessionId> --path (find IDs via `oracle status --json`).",
    );
    expect(process.exitCode).toBe(1);
  });

  test("prints a human artifact index when --artifacts is provided with an id", async () => {
    const command = createCommandWithOptions({
      hours: 24,
      limit: 10,
      all: false,
      artifacts: true,
    } as StatusOptions);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const deps = createDeps();
    deps.getSessionPaths.mockResolvedValue({
      dir: "/tmp/.oracle/sessions/abc",
      metadata: "/tmp/.oracle/sessions/abc/meta.json",
      request: "/tmp/.oracle/sessions/abc/request.json",
      log: "/tmp/.oracle/sessions/abc/output.log",
    });
    deps.buildSessionArtifactIndex.mockResolvedValue({
      schema_version: "session_artifact_index.v1",
      sessionId: "abc",
      sessionDir: "/tmp/.oracle/sessions/abc",
      displaySessionDir: "sessions/abc",
      metadataStatus: "loaded",
      warnings: [],
      entries: [
        {
          category: "transcript",
          kind: "transcript",
          label: "Transcript",
          path: "/tmp/.oracle/sessions/abc/artifacts/transcript.md",
          displayPath: "artifacts/transcript.md",
          exists: true,
          source: "metadata",
          sizeBytes: 12,
        },
      ],
    });

    await handleSessionCommand("abc", command, deps);

    expect(deps.getSessionPaths).toHaveBeenCalledWith("abc");
    expect(deps.buildSessionArtifactIndex).toHaveBeenCalledWith({
      sessionDir: "/tmp/.oracle/sessions/abc",
      cwd: process.cwd(),
    });
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("artifacts/transcript.md [transcript/transcript] ok 12b"),
    );
    expect(deps.attachSession).not.toHaveBeenCalled();
  });

  test("prints artifact index JSON when --artifacts --json is provided", async () => {
    const command = createCommandWithOptions({
      hours: 24,
      limit: 10,
      all: false,
      artifacts: true,
      json: true,
    } as StatusOptions);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const deps = createDeps();
    deps.getSessionPaths.mockResolvedValue({
      dir: "/tmp/.oracle/sessions/abc",
      metadata: "/tmp/.oracle/sessions/abc/meta.json",
      request: "/tmp/.oracle/sessions/abc/request.json",
      log: "/tmp/.oracle/sessions/abc/output.log",
    });
    deps.buildSessionArtifactIndex.mockResolvedValue({
      schema_version: "session_artifact_index.v1",
      sessionId: "abc",
      sessionDir: "/tmp/.oracle/sessions/abc",
      displaySessionDir: "sessions/abc",
      metadataStatus: "missing",
      warnings: ["metadata missing"],
      entries: [],
    });

    await handleSessionCommand("abc", command, deps);

    const parsed = JSON.parse(String(logSpy.mock.calls[0]?.[0]));
    expect(parsed).toMatchObject({
      schema_version: "session_artifact_index.v1",
      sessionId: "abc",
      metadataStatus: "missing",
    });
  });

  test("errors when --artifacts is provided without an id", async () => {
    const command = createCommandWithOptions({
      hours: 24,
      limit: 10,
      all: false,
      artifacts: true,
    } as StatusOptions);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await handleSessionCommand(undefined, command, createDeps());

    expect(errorSpy).toHaveBeenCalledWith("The --artifacts flag requires a session ID.");
    expect(process.exitCode).toBe(1);
  });

  test("errors when session files are missing", async () => {
    const command = createCommandWithOptions({
      hours: 24,
      limit: 10,
      all: false,
      path: true,
    } as StatusOptions);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const deps = createDeps();
    deps.getSessionPaths.mockRejectedValue(new Error('Session "abc" is missing: meta.json'));
    await handleSessionCommand("abc", command, deps);

    expect(errorSpy).toHaveBeenCalledWith('Session "abc" is missing: meta.json');
    expect(process.exitCode).toBe(1);
  });

  test("passes render flag through to attachSession", async () => {
    const command = createCommandWithOptions({ hours: 24, limit: 10, all: false });
    command.setOptionValueWithSource("render", true, "cli");

    const deps = createDeps();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await handleSessionCommand("abc", command, deps);
    expect(deps.attachSession).toHaveBeenCalledWith(
      "abc",
      expect.objectContaining({ renderMarkdown: true }),
    );
    expect(logSpy).not.toHaveBeenCalled();
  });

  test("forces infinite range when --all set", async () => {
    const command = createCommandWithOptions({ hours: 1, limit: 25, all: true });
    const deps = createDeps();
    deps.usesDefaultStatusFilters.mockReturnValue(false);
    await handleSessionCommand(undefined, command, deps);
    expect(deps.showStatus).toHaveBeenCalledWith({
      hours: Infinity,
      includeAll: true,
      limit: 25,
      showExamples: false,
    });
  });

  test("clears sessions when --clear is provided", async () => {
    const command = createCommandWithOptions({ hours: 6, limit: 5, all: false, clear: true });
    const deps = createDeps();
    deps.deleteSessionsOlderThan.mockResolvedValue({
      deleted: 3,
      remaining: 2,
      sessions: [{ id: "old-a" }, { id: "old-b" }, { id: "old-c" }],
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await handleSessionCommand(undefined, command, deps);
    expect(deps.deleteSessionsOlderThan).toHaveBeenCalledWith({ hours: 6, includeAll: false });
    expect(logSpy).toHaveBeenCalledWith(
      "Deleted 3 sessions (sessions older than 6h). 2 sessions remain.\n" +
        "  - old-a\n  - old-b\n  - old-c\n" +
        'Run "oracle session --clear --all --yes" to delete everything.',
    );
  });

  test("--clear --all without --yes previews the wipe and deletes nothing", async () => {
    const command = createCommandWithOptions({ hours: 24, limit: 5, all: true, clear: true });
    const deps = createDeps();
    deps.deleteSessionsOlderThan.mockResolvedValue({
      deleted: 0,
      remaining: 2,
      sessions: [
        { id: "keep-me", createdMs: Date.now() - 2 * 60 * 60 * 1000, sizeBytes: 2048 },
        { id: "keep-me-too" },
      ],
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await handleSessionCommand(undefined, command, deps);
    // The only store call must be the non-destructive dry run.
    expect(deps.deleteSessionsOlderThan).toHaveBeenCalledTimes(1);
    expect(deps.deleteSessionsOlderThan).toHaveBeenCalledWith({
      hours: 24,
      includeAll: true,
      dryRun: true,
    });
    const output = String(logSpy.mock.calls[0]?.[0]);
    expect(output).toContain("[dry-run] --clear --all would permanently delete 2 stored sessions:");
    expect(output).toContain("  - keep-me (age 2h 0m, 2.0 KB)");
    expect(output).toContain("  - keep-me-too");
    expect(output).toContain(
      "[dry-run] No sessions were deleted. Re-run with --yes to confirm: oracle session --clear --all --yes",
    );
    expect(process.exitCode).toBeUndefined();
  });

  test("--clear --all --yes performs the full wipe", async () => {
    const command = createCommandWithOptions({
      hours: 24,
      limit: 5,
      all: true,
      clear: true,
      yes: true,
    } as StatusOptions);
    const deps = createDeps();
    deps.deleteSessionsOlderThan.mockResolvedValue({
      deleted: 2,
      remaining: 0,
      sessions: [{ id: "gone-a" }, { id: "gone-b" }],
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await handleSessionCommand(undefined, command, deps);
    expect(deps.deleteSessionsOlderThan).toHaveBeenCalledTimes(1);
    expect(deps.deleteSessionsOlderThan).toHaveBeenCalledWith({ hours: 24, includeAll: true });
    const output = String(logSpy.mock.calls[0]?.[0]);
    expect(output).toContain("Deleted 2 sessions (all stored sessions). 0 sessions remain.");
    expect(output).toContain("  - gone-a");
    expect(output).toContain("  - gone-b");
  });

  test('rejects slug-style "clear" ids with guidance', async () => {
    const command = createCommandWithOptions({ hours: 24, limit: 10, all: false });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await handleSessionCommand("clear", command, createDeps());
    expect(errorSpy).toHaveBeenCalledWith(
      'Session cleanup now uses --clear. Run "oracle session --clear --hours <n>" instead.',
    );
    expect(process.exitCode).toBe(1);
  });

  test("harvests browser output when requested", async () => {
    const command = createCommandWithOptions({
      hours: 24,
      limit: 10,
      all: false,
      harvest: true,
      writeOutput: "/tmp/out.md",
      browserTab: "current",
    } as StatusOptions);
    const deps = createDeps();

    await handleSessionCommand("abc", command, deps);

    expect(deps.harvestSessionBrowserOutput).toHaveBeenCalledWith("abc", {
      writeOutputPath: "/tmp/out.md",
      browserTabRef: "current",
      recoverIfMissing: true,
    });
    expect(deps.liveTailSessionBrowserOutput).not.toHaveBeenCalled();
  });

  test("tails browser output when requested", async () => {
    const command = createCommandWithOptions({
      hours: 24,
      limit: 10,
      all: false,
      live: true,
      browserTab: "tab-123",
    } as StatusOptions);
    const deps = createDeps();

    await handleSessionCommand("abc", command, deps);

    expect(deps.liveTailSessionBrowserOutput).toHaveBeenCalledWith("abc", {
      writeOutputPath: undefined,
      browserTabRef: "tab-123",
      recoverIfMissing: true,
    });
    expect(deps.harvestSessionBrowserOutput).not.toHaveBeenCalled();
  });

  test("rejects combining --harvest and --live", async () => {
    const command = createCommandWithOptions({
      hours: 24,
      limit: 10,
      all: false,
      harvest: true,
      live: true,
    } as StatusOptions);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await handleSessionCommand("abc", command, createDeps());

    expect(errorSpy).toHaveBeenCalledWith(
      "Cannot combine --harvest and --live. Choose one: oracle session <sessionId> --harvest, or oracle session <sessionId> --live",
    );
    expect(process.exitCode).toBe(1);
  });

  test("rejects --write-output without --harvest or --live", async () => {
    const command = createCommandWithOptions({
      hours: 24,
      limit: 10,
      all: false,
      writeOutput: "/tmp/out.md",
    } as StatusOptions);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await handleSessionCommand("abc", command, createDeps());

    expect(errorSpy).toHaveBeenCalledWith(
      "The --write-output flag requires --harvest or --live. Run: oracle session <sessionId> --harvest --write-output /tmp/out.md (or --live instead of --harvest)",
    );
    expect(process.exitCode).toBe(1);
  });

  test("errors when --harvest is provided without an id, naming the exact fix", async () => {
    const command = createCommandWithOptions({
      hours: 24,
      limit: 10,
      all: false,
      harvest: true,
    } as StatusOptions);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await handleSessionCommand(undefined, command, createDeps());

    expect(errorSpy).toHaveBeenCalledWith(
      "The --harvest flag requires a session ID. Run: oracle session <sessionId> --harvest (find IDs via `oracle status --json`).",
    );
    expect(process.exitCode).toBe(1);
  });

  test("errors when --live is provided without an id, naming the exact fix", async () => {
    const command = createCommandWithOptions({
      hours: 24,
      limit: 10,
      all: false,
      live: true,
    } as StatusOptions);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await handleSessionCommand(undefined, command, createDeps());

    expect(errorSpy).toHaveBeenCalledWith(
      "The --live flag requires a session ID. Run: oracle session <sessionId> --live (find IDs via `oracle status --json`).",
    );
    expect(process.exitCode).toBe(1);
  });
});

import { beforeEach, describe, expect, test, vi } from "vitest";
import { buildImportedChatgptConversationSessionMetadata } from "../../src/browser/importedConversation.ts";
import type { SessionMetadata } from "../../src/sessionManager.ts";

const sessionStoreMock = vi.hoisted(() => ({
  readSession: vi.fn(),
  getPaths: vi.fn(),
  sessionsDir: vi.fn().mockReturnValue("/tmp/.oracle/sessions"),
}));

vi.mock("../../src/sessionStore.ts", () => ({
  sessionStore: sessionStoreMock,
  wait: vi.fn(),
}));

import { runWaitCommand, runWaitLoop, type WaitLoopDeps } from "../../src/cli/sessionWait.ts";
import { ORACLE_WAIT_TIMEOUT_EXIT_CODE } from "../../src/cli/exitCodes.ts";

function meta(overrides: Partial<SessionMetadata> = {}): SessionMetadata {
  return {
    id: "sess-1",
    createdAt: "2026-07-01T00:00:00.000Z",
    status: "running",
    options: {} as SessionMetadata["options"],
    ...overrides,
  } as SessionMetadata;
}

function importedMeta(): SessionMetadata {
  return buildImportedChatgptConversationSessionMetadata({
    sessionId: "sess-1",
    conversationUrl: "https://chatgpt.com/c/wait-import",
    conversationId: "wait-import",
    cwd: "/tmp/wait-import",
    importedAt: "2026-07-01T00:00:00.000Z",
  });
}

/** A virtual clock: sleep() advances `now` so timeouts are deterministic. */
function fakeClock() {
  let clock = 0;
  return {
    now: () => clock,
    sleep: vi.fn(async (ms: number) => {
      clock += ms;
    }),
  };
}

function deps(
  readSession: WaitLoopDeps["readSession"],
  extra: Partial<WaitLoopDeps> = {},
): WaitLoopDeps {
  const clock = fakeClock();
  return {
    readSession,
    sleep: clock.sleep,
    now: clock.now,
    initialPollMs: 500,
    maxPollMs: 5_000,
    ...extra,
  };
}

beforeEach(() => {
  sessionStoreMock.readSession.mockReset();
  sessionStoreMock.getPaths.mockReset();
});

describe("runWaitLoop", () => {
  test("returns terminal + exit 0 once the session completes", async () => {
    const statuses = ["running", "running", "completed"];
    let call = 0;
    const readSession = vi.fn(async () =>
      meta({ status: statuses[Math.min(call++, statuses.length - 1)] }),
    );
    const result = await runWaitLoop("sess-1", {}, deps(readSession));
    expect(result.outcome).toBe("terminal");
    expect(result.exitCode).toBe(0);
    expect(result.metadata?.status).toBe("completed");
    // polled (did not resolve on the first read)
    expect(readSession.mock.calls.length).toBeGreaterThan(1);
  });

  test("maps a terminal error onto the failure taxonomy exit code", async () => {
    const readSession = vi.fn(async () =>
      meta({ status: "error", transport: { reason: "client-timeout" } }),
    );
    const result = await runWaitLoop("sess-1", {}, deps(readSession));
    expect(result.outcome).toBe("terminal");
    expect(result.exitCode).toBe(5);
  });

  test("returns exit 0 only for an exact pure imported reference", async () => {
    const result = await runWaitLoop("sess-1", {}, deps(vi.fn(async () => importedMeta())));
    expect(result.outcome).toBe("terminal");
    expect(result.exitCode).toBe(0);
  });

  test("fails a raw imported status closed with exit 1", async () => {
    const result = await runWaitLoop(
      "sess-1",
      {},
      deps(vi.fn(async () => meta({ status: "imported" }))),
    );
    expect(result.outcome).toBe("terminal");
    expect(result.exitCode).toBe(1);
  });

  test("returns wait_timeout (exit 7) when the deadline passes while still running", async () => {
    const readSession = vi.fn(async () => meta({ status: "running" }));
    const result = await runWaitLoop("sess-1", { timeoutSeconds: 1 }, deps(readSession));
    expect(result.outcome).toBe("timeout");
    expect(result.exitCode).toBe(ORACLE_WAIT_TIMEOUT_EXIT_CODE);
    expect(result.metadata?.status).toBe("running");
  });

  test("returns not_found (exit 1) when the session does not exist", async () => {
    const readSession = vi.fn(async () => null);
    const result = await runWaitLoop("ghost", { timeoutSeconds: 5 }, deps(readSession));
    expect(result.outcome).toBe("not_found");
    expect(result.exitCode).toBe(1);
  });

  test("backoff grows and is capped at maxPollMs (no busy-spin)", async () => {
    const readSession = vi.fn(async () => meta({ status: "running" }));
    const sleeps: number[] = [];
    const clock = fakeClock();
    await runWaitLoop(
      "sess-1",
      { timeoutSeconds: 100 },
      {
        readSession,
        now: clock.now,
        sleep: vi.fn(async (ms: number) => {
          sleeps.push(ms);
          clock.sleep(ms);
          if (sleeps.length >= 12) {
            // force a terminal resolution so the loop ends
            readSession.mockResolvedValue(meta({ status: "completed" }));
          }
        }),
        initialPollMs: 500,
        maxPollMs: 5_000,
      },
    );
    expect(sleeps[0]).toBe(500);
    expect(Math.max(...sleeps)).toBeLessThanOrEqual(5_000);
    // monotonic non-decreasing until the cap
    expect(sleeps[1]).toBeGreaterThanOrEqual(sleeps[0]);
  });
});

describe("runWaitCommand", () => {
  test("--json emits one oracle_session.v1 envelope on stdout and progress on stderr", async () => {
    sessionStoreMock.getPaths.mockResolvedValue({ dir: "/d", log: "/d/output.log" });
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exitCode = await runWaitCommand(
      "sess-1",
      { json: true, timeoutSeconds: 5 },
      {
        stdout: (t) => stdout.push(t),
        stderr: (t) => stderr.push(t),
        deps: {
          readSession: vi.fn(async () => meta({ status: "completed" })),
          sleep: vi.fn(async () => undefined),
          now: () => 0,
        },
      },
    );
    expect(exitCode).toBe(0);
    expect(stdout.length).toBe(1);
    const parsed = JSON.parse(stdout[0]);
    expect(parsed.data.schema_version).toBe("oracle_session.v1");
    expect(parsed.data.exit_code).toBe(0);
    // no envelope leaked onto stderr; progress did
    expect(stderr.join("")).toContain("Waiting for session sess-1");
    expect(stdout.join("")).not.toContain("Waiting for session");
  });

  test("non-json returns the timeout exit code and prints a human summary", async () => {
    const stdout: string[] = [];
    const clock = fakeClock();
    const exitCode = await runWaitCommand(
      "sess-1",
      { json: false, timeoutSeconds: 1 },
      {
        stdout: (t) => stdout.push(t),
        stderr: () => undefined,
        deps: {
          readSession: vi.fn(async () => meta({ status: "running" })),
          sleep: clock.sleep,
          now: clock.now,
          initialPollMs: 500,
        },
      },
    );
    expect(exitCode).toBe(ORACLE_WAIT_TIMEOUT_EXIT_CODE);
    expect(stdout.join("")).toContain("wait_timeout");
  });

  test("invalid imported metadata is reported as error and exits nonzero", async () => {
    sessionStoreMock.getPaths.mockResolvedValue({ dir: "/d", log: "/d/output.log" });
    const stdout: string[] = [];
    const exitCode = await runWaitCommand(
      "sess-1",
      { json: false },
      {
        stdout: (text) => stdout.push(text),
        stderr: () => undefined,
        deps: {
          readSession: vi.fn(async () => meta({ status: "imported" })),
          sleep: vi.fn(async () => undefined),
          now: () => 0,
        },
      },
    );
    expect(exitCode).toBe(1);
    expect(stdout.join("")).toContain("status: error");
    expect(stdout.join("")).toContain("finished with status error. Exit 1");
  });
});

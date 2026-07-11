import { beforeEach, describe, expect, test, vi } from "vitest";
import type { SessionMetadata } from "../../src/sessionManager.ts";

const sessionStoreMock = vi.hoisted(() => ({
  readSession: vi.fn(),
  getPaths: vi.fn(),
  updateSession: vi.fn(),
  sessionsDir: vi.fn().mockReturnValue("/tmp/.oracle/sessions"),
}));

vi.mock("../../src/sessionStore.ts", () => ({
  sessionStore: sessionStoreMock,
}));

import { runCancelCommand, runCancelCore, type CancelDeps } from "../../src/cli/sessionCancel.ts";

function meta(overrides: Partial<SessionMetadata> = {}): SessionMetadata {
  return {
    id: "sess-1",
    createdAt: "2026-07-01T00:00:00.000Z",
    status: "running",
    options: {} as SessionMetadata["options"],
    ...overrides,
  } as SessionMetadata;
}

function baseDeps(current: SessionMetadata, extra: Partial<CancelDeps> = {}): CancelDeps {
  return {
    readSession: vi.fn(async () => current),
    updateSession: vi.fn(async (_id, updater) => {
      const patch = await updater(current);
      return { ...current, ...patch } as SessionMetadata;
    }),
    releaseLeases: vi.fn(async () => []),
    isProcessAlive: vi.fn(() => false),
    killProcess: vi.fn(() => true),
    sleep: vi.fn(async () => undefined),
    now: () => 0,
    ...extra,
  };
}

beforeEach(() => {
  sessionStoreMock.readSession.mockReset();
  sessionStoreMock.getPaths.mockReset();
  sessionStoreMock.updateSession.mockReset();
});

describe("runCancelCore", () => {
  test("not_found returns exit 1 and touches nothing", async () => {
    const deps = baseDeps(meta());
    deps.readSession = vi.fn(async () => null);
    const result = await runCancelCore("ghost", {}, deps);
    expect(result.outcome).toBe("not_found");
    expect(result.exitCode).toBe(1);
    expect(deps.updateSession).not.toHaveBeenCalled();
    expect(deps.killProcess).not.toHaveBeenCalled();
  });

  test("already-terminal session is an idempotent no-op (exit 0, no kill/update)", async () => {
    const deps = baseDeps(meta({ status: "completed" }));
    const result = await runCancelCore("sess-1", {}, deps);
    expect(result.outcome).toBe("already_terminal");
    expect(result.exitCode).toBe(0);
    expect(deps.killProcess).not.toHaveBeenCalled();
    expect(deps.updateSession).not.toHaveBeenCalled();
    expect(deps.releaseLeases).not.toHaveBeenCalled();
  });

  test("cancels a running session: releases leases and marks it cancelled", async () => {
    const deps = baseDeps(meta({ status: "running" }));
    const result = await runCancelCore("sess-1", {}, deps);
    expect(result.outcome).toBe("cancelled");
    expect(result.exitCode).toBe(0);
    expect(result.metadata?.status).toBe("cancelled");
    expect(deps.releaseLeases).toHaveBeenCalledWith("sess-1");
    expect(deps.updateSession).toHaveBeenCalledTimes(1);
  });

  test("SIGTERMs then SIGKILLs a controller that stays alive past the grace window", async () => {
    let clock = 0;
    const deps = baseDeps(
      meta({
        status: "running",
        browser: { runtime: { controllerPid: 4242 } },
      } as Partial<SessionMetadata>),
      {
        isProcessAlive: vi.fn(() => true), // never dies -> escalate to SIGKILL
        now: () => clock,
        sleep: vi.fn(async (ms: number) => {
          clock += ms;
        }),
      },
    );
    const result = await runCancelCore("sess-1", { graceMs: 300 }, deps);
    expect(result.killedPid).toBe(4242);
    expect(deps.killProcess).toHaveBeenCalledWith(4242, "SIGTERM");
    expect(deps.killProcess).toHaveBeenCalledWith(4242, "SIGKILL");
    expect(result.killSignals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  test("SIGTERM only when the controller exits during the grace window", async () => {
    let aliveChecks = 0;
    const deps = baseDeps(
      meta({
        status: "running",
        browser: { runtime: { controllerPid: 99 } },
      } as Partial<SessionMetadata>),
      {
        // alive for the initial gate + first grace check, then gone
        isProcessAlive: vi.fn(() => {
          aliveChecks += 1;
          return aliveChecks <= 2;
        }),
      },
    );
    const result = await runCancelCore("sess-1", { graceMs: 300 }, deps);
    expect(result.killSignals).toEqual(["SIGTERM"]);
    expect(deps.killProcess).not.toHaveBeenCalledWith(99, "SIGKILL");
  });

  test("race guard: leaves a session that finished on its own untouched", async () => {
    // read observed running, but the store's freshest state is already terminal
    const current = meta({ status: "running" });
    const deps = baseDeps(current, {
      updateSession: vi.fn(async (_id, updater) => {
        const patch = await updater(meta({ status: "completed" }));
        expect(patch).toEqual({}); // updater must not downgrade a completed run
        return meta({ status: "completed" });
      }),
    });
    const result = await runCancelCore("sess-1", {}, deps);
    expect(result.metadata?.status).toBe("completed");
    expect(result.outcome).toBe("already_terminal");
  });
});

describe("runCancelCommand", () => {
  test("--json emits an oracle_session.v1 envelope for the cancelled session", async () => {
    sessionStoreMock.getPaths.mockResolvedValue({ dir: "/d", log: "/d/output.log" });
    const stdout: string[] = [];
    const exitCode = await runCancelCommand(
      "sess-1",
      { json: true },
      {
        stdout: (t) => stdout.push(t),
        stderr: () => undefined,
        deps: baseDeps(meta({ status: "running" })),
      },
    );
    expect(exitCode).toBe(0);
    expect(stdout.length).toBe(1);
    const parsed = JSON.parse(stdout[0]);
    expect(parsed.data.schema_version).toBe("oracle_session.v1");
    expect(parsed.data.status).toBe("cancelled");
  });

  test("non-json prints an idempotent no-op line for an already-terminal session", async () => {
    const stdout: string[] = [];
    const exitCode = await runCancelCommand(
      "sess-1",
      { json: false },
      {
        stdout: (t) => stdout.push(t),
        stderr: () => undefined,
        deps: baseDeps(meta({ status: "completed" })),
      },
    );
    expect(exitCode).toBe(0);
    expect(stdout.join("")).toContain("already");
    expect(stdout.join("")).toContain("nothing to cancel");
  });
});

import { Command } from "commander";
import { describe, expect, test } from "vitest";
import {
  runAggregateDoctor,
  type AggregateDoctorCheck,
} from "../../../src/cli/commands/doctor/aggregate.js";
import { registerDoctorCommand, runLaneDoctor } from "../../../src/cli/commands/doctor/index.js";
import type { ProviderDoctorEnvelope } from "../../../src/cli/commands/doctor/chatgpt.js";

function providerEnvelope(provider: "chatgpt" | "gemini", ok = true): ProviderDoctorEnvelope {
  return {
    schema_version: "provider_doctor.v1",
    provider,
    ok,
    status: ok ? "ready" : "blocked",
    requested: {},
    checks: [],
    blockers: [],
    warnings: [],
    next_command: ok ? null : `oracle doctor ${provider} --json`,
    fix_command: null,
  };
}

function check(
  component: string,
  status: AggregateDoctorCheck["status"] = "pass",
  code = `${component}_${status}`,
  overrides: Partial<AggregateDoctorCheck> = {},
): AggregateDoctorCheck {
  return {
    component,
    status,
    code,
    message: `${component} ${status}`,
    retry_safe: status !== "fail",
    ...overrides,
  };
}

const fakeStore = {
  ensureStorage: async () => {},
  sessionsDir: () => "/tmp/oracle/sessions",
  listSessions: async () => [],
};

describe("aggregate doctor", () => {
  test("emits a healthy json_envelope.v1 preflight", async () => {
    const output: string[] = [];
    const result = await runAggregateDoctor(
      {
        json: true,
        now: () => new Date("2026-05-13T00:00:00.000Z"),
        chatgptDoctor: async () => providerEnvelope("chatgpt"),
        geminiDoctor: async () => providerEnvelope("gemini"),
        remoteBridgeDoctor: async () => check("remote_bridge"),
        sessionStorageCheck: async () => check("session_storage"),
        providerDocsCheck: async () => check("provider_docs"),
        browserLeasesCheck: async () => check("browser_leases"),
        evidenceStorageCheck: async () => check("evidence_storage"),
      },
      { stdout: (text) => output.push(text) },
    );

    expect(result).toMatchObject({
      schema_version: "json_envelope.v1",
      ok: true,
      blocked_reason: null,
      data: { schema_version: "oracle_doctor.v1", status: "ready" },
      meta: { command: "oracle doctor --json", generated_at: "2026-05-13T00:00:00.000Z" },
    });
    expect(result.data.checks.map((entry) => entry.component)).toEqual([
      "chatgpt_doctor",
      "gemini_doctor",
      "lane_policy",
      "remote_bridge",
      "session_storage",
      "provider_docs",
      "browser_leases",
      "evidence_storage",
    ]);
    expect(JSON.parse(output[0])).toMatchObject({ ok: true });
  });

  test("surfaces remote token missing with recovery commands", async () => {
    const result = await runAggregateDoctor({
      chatgptDoctor: async () => providerEnvelope("chatgpt"),
      geminiDoctor: async () => providerEnvelope("gemini"),
      remoteBridgeDoctor: async () =>
        check("remote_bridge", "fail", "remote_token_missing", {
          message: "Remote host is configured but ORACLE_REMOTE_TOKEN is missing.",
          next_command: "oracle remote doctor --json",
          fix_command: "export ORACLE_REMOTE_TOKEN=<token>",
          retry_safe: false,
        }),
      sessionStorageCheck: async () => check("session_storage"),
    });

    expect(result.ok).toBe(false);
    expect(result.blocked_reason).toBe("remote_token_missing");
    expect(result.next_command).toBe("oracle remote doctor --json");
    expect(result.fix_command).toBe("export ORACLE_REMOTE_TOKEN=<token>");
    expect(result.retry_safe).toBe(false);
  });

  test("blocks on stale provider docs freshness", async () => {
    const result = await runAggregateDoctor({
      chatgptDoctor: async () => providerEnvelope("chatgpt"),
      geminiDoctor: async () => providerEnvelope("gemini"),
      remoteBridgeDoctor: async () => check("remote_bridge"),
      sessionStorageCheck: async () => check("session_storage"),
      providerDocsCheck: async () =>
        check("provider_docs", "fail", "provider_docs_stale", {
          message: "Provider docs snapshot is stale.",
          next_command: "oracle capabilities --json",
          fix_command: "Refresh provider docs snapshot before protected route use.",
        }),
    });

    expect(result.ok).toBe(false);
    expect(result.blocked_reason).toBe("provider_docs_stale");
    expect(result.next_command).toBe("oracle capabilities --json");
  });

  test("routes lease conflicts to browser lease recovery", async () => {
    const result = await runAggregateDoctor({
      chatgptDoctor: async () => providerEnvelope("chatgpt"),
      geminiDoctor: async () => providerEnvelope("gemini"),
      remoteBridgeDoctor: async () => check("remote_bridge"),
      sessionStorageCheck: async () => check("session_storage"),
      browserLeasesCheck: async () =>
        check("browser_leases", "fail", "browser_lease_conflict", {
          message: "A provider browser lease is already active.",
          next_command: "oracle browser leases recover --json",
          retry_safe: true,
        }),
    });

    expect(result.ok).toBe(false);
    expect(result.blocked_reason).toBe("browser_lease_conflict");
    expect(result.next_command).toBe("oracle browser leases recover --json");
    expect(result.retry_safe).toBe(true);
  });

  test("blocks when evidence storage is unavailable", async () => {
    const result = await runAggregateDoctor({
      chatgptDoctor: async () => providerEnvelope("chatgpt"),
      geminiDoctor: async () => providerEnvelope("gemini"),
      remoteBridgeDoctor: async () => check("remote_bridge"),
      sessionStorageCheck: async () => check("session_storage"),
      evidenceStorageCheck: async () =>
        check("evidence_storage", "fail", "evidence_storage_unavailable", {
          message: "Evidence artifact path is not writable.",
          fix_command: "mkdir -p ~/.oracle/sessions",
          next_command: "oracle evidence verify <session>",
        }),
    });

    expect(result.ok).toBe(false);
    expect(result.blocked_reason).toBe("evidence_storage_unavailable");
    expect(result.fix_command).toBe("mkdir -p ~/.oracle/sessions");
    expect(result.next_command).toBe("oracle evidence verify <session>");
  });

  test("registers aggregate doctor without removing provider subcommands", () => {
    const program = new Command();
    registerDoctorCommand(program, {
      aggregate: {
        sessionStore: fakeStore,
        chatgptDoctor: async () => providerEnvelope("chatgpt"),
        geminiDoctor: async () => providerEnvelope("gemini"),
        remoteBridgeDoctor: async () => check("remote_bridge"),
      },
    });

    const doctor = program.commands.find((command) => command.name() === "doctor");
    expect(doctor?.commands.map((command) => command.name()).sort()).toEqual([
      "chatgpt",
      "gemini",
      "lanes",
    ]);
  });

  test("registered doctor action passes --json from Commander options", async () => {
    const program = new Command();
    registerDoctorCommand(program, {
      aggregate: {
        sessionStore: fakeStore,
        chatgptDoctor: async () => providerEnvelope("chatgpt"),
        geminiDoctor: async () => providerEnvelope("gemini"),
        remoteBridgeDoctor: async () => check("remote_bridge"),
        sessionStorageCheck: async () => check("session_storage"),
      },
    });
    const output: string[] = [];
    const originalLog = console.log;
    console.log = (message?: unknown) => {
      output.push(String(message ?? ""));
    };
    try {
      await program.parseAsync(["node", "oracle", "doctor", "--json"]);
    } finally {
      console.log = originalLog;
    }
    expect(JSON.parse(output.join("\n"))).toMatchObject({ schema_version: "json_envelope.v1" });
  });

  test("lane doctor emits the reviewed lane policy as JSON", async () => {
    const output: string[] = [];
    const originalLog = console.log;
    console.log = (message?: unknown) => {
      output.push(String(message ?? ""));
    };
    try {
      await runLaneDoctor(
        { json: true },
        {
          claudeCodePreflight: async () => ({
            ok: true,
            checks: [
              {
                code: "anthropic_api_key_absent",
                status: "pass",
                message: "No blocked Anthropic API/provider environment variables present.",
              },
            ],
          }),
          peekLock: async () => ({ busy: false, holders: [] }),
        },
      );
    } finally {
      console.log = originalLog;
    }
    const parsed = JSON.parse(output.join("\n"));
    expect(parsed.data.schema_version).toBe("agent-lanes.v1");
    expect(parsed.data.lanes.map((entry: { lane: string }) => entry.lane)).toEqual([
      "chatgpt-pro",
      "gemini-deep-think",
      "fable-local",
    ]);
    expect(parsed.data.lanes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          lane: "chatgpt-pro",
          doctor_command:
            "oracle doctor chatgpt --pro --extended-reasoning --remote-browser preferred --json",
          claude_code_preflight: null,
          single_flight_lock: null,
        }),
        expect.objectContaining({
          lane: "gemini-deep-think",
          doctor_command: "oracle doctor gemini --deep-think --remote-browser preferred --json",
          claude_code_preflight: null,
          single_flight_lock: null,
        }),
        expect.objectContaining({
          lane: "fable-local",
          claude_code_preflight: expect.objectContaining({ ok: true }),
          single_flight_lock: { busy: false, holders: [] },
        }),
      ]),
    );
  });

  test("lane doctor surfaces a busy fable-local single-flight lock without failing the command", async () => {
    const output: string[] = [];
    const originalLog = console.log;
    console.log = (message?: unknown) => {
      output.push(String(message ?? ""));
    };
    try {
      await runLaneDoctor(
        { json: true },
        {
          claudeCodePreflight: async () => ({ ok: true, checks: [] }),
          peekLock: async () => ({
            busy: true,
            holders: [
              {
                lock_path: "/home/user/.oracle/locks/claude-code-subscription.lock",
                session_id: "busy-session",
                holder_pid: 4242,
                pid_alive: true,
                held_for_ms: 12_000,
              },
            ],
          }),
        },
      );
    } finally {
      console.log = originalLog;
    }
    const parsed = JSON.parse(output.join("\n"));
    // A busy lane is a normal, transient state — the command still succeeds.
    expect(parsed.ok).toBe(true);
    const fableLane = parsed.data.lanes.find(
      (entry: { lane: string }) => entry.lane === "fable-local",
    );
    expect(fableLane.single_flight_lock).toMatchObject({
      busy: true,
      holders: [expect.objectContaining({ session_id: "busy-session", holder_pid: 4242 })],
    });
    expect(parsed.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining("fable-local:single_flight_lock_busy:1")]),
    );
  });

  test("lane doctor human output reports the fable-local single-flight lock state", async () => {
    const output: string[] = [];
    const originalLog = console.log;
    console.log = (message?: unknown) => {
      output.push(String(message ?? ""));
    };
    try {
      await runLaneDoctor(
        {},
        {
          claudeCodePreflight: async () => ({ ok: true, checks: [] }),
          peekLock: async () => ({
            busy: true,
            holders: [
              {
                lock_path: "/home/user/.oracle/locks/claude-code-subscription.lock",
                session_id: "busy-session",
                holder_pid: 4242,
                pid_alive: true,
                held_for_ms: 12_000,
              },
            ],
          }),
        },
      );
    } finally {
      console.log = originalLog;
    }
    const text = output.join("\n");
    expect(text).toContain("fable-local single-flight lock: busy");
    expect(text).toContain("session busy-session, pid 4242");
  });

  test("lane doctor surfaces a failing claude-code preflight check without failing the command", async () => {
    const output: string[] = [];
    const originalLog = console.log;
    console.log = (message?: unknown) => {
      output.push(String(message ?? ""));
    };
    try {
      await runLaneDoctor(
        { json: true },
        {
          claudeCodePreflight: async () => ({
            ok: false,
            checks: [
              {
                code: "claude_executable_resolved",
                status: "fail",
                message: "Claude Code local mode requires the `claude` command on PATH.",
                details: { reason: "not_found" },
              },
            ],
          }),
          peekLock: async () => ({ busy: false, holders: [] }),
        },
      );
    } finally {
      console.log = originalLog;
    }
    const parsed = JSON.parse(output.join("\n"));
    expect(parsed.ok).toBe(true);
    const fableLane = parsed.data.lanes.find(
      (entry: { lane: string }) => entry.lane === "fable-local",
    );
    expect(fableLane.claude_code_preflight).toMatchObject({
      ok: false,
      checks: [expect.objectContaining({ code: "claude_executable_resolved", status: "fail" })],
    });
    expect(parsed.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining("claude_executable_resolved")]),
    );
  });
});

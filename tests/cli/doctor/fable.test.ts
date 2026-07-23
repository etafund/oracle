import type { execFile } from "node:child_process";
import { Command } from "commander";
import { describe, expect, test, vi } from "vitest";

import {
  registerFableDoctorCommand,
  runFableAuthStatusProbe,
  runFableDoctor,
  type FableAuthStatus,
  type FableDoctorOptions,
} from "@src/cli/commands/doctor/fable.ts";
import type { ClaudeCodePreflightResult } from "@src/claude-code/preflight.ts";

const HEALTHY_PREFLIGHT: ClaudeCodePreflightResult = {
  ok: true,
  checks: [
    {
      code: "anthropic_api_key_absent",
      status: "pass",
      message: "No blocked provider environment variables are present.",
    },
    {
      code: "claude_executable_resolved",
      status: "pass",
      message: "Resolved Claude.",
      details: {
        path: "/opt/claude",
        requested: "claude",
        secret_that_must_not_escape: "do-not-print",
      },
    },
    {
      code: "local_owner_verified",
      status: "pass",
      message: "Local owner verified.",
    },
  ],
};

function readyOptions(overrides: Partial<FableDoctorOptions> = {}): FableDoctorOptions {
  return {
    json: true,
    caamProfile: "cc-arthur",
    caamBase: "/home/ubuntu/orch-homes",
    env: { HOME: "/home/ubuntu/orch-homes/cod-arthur", SHALLOW_PROFILE: "cod-arthur" },
    now: () => new Date("2026-07-20T12:00:00.000Z"),
    claudeCodePreflight: async () => HEALTHY_PREFLIGHT,
    resolveCaamExecutable: async () => ({
      requested: "caam",
      path: "/opt/caam",
      ownerUid: 1000,
      mode: 0o755,
    }),
    caamProfileDoctor: async () => ({ healthy: true, raw: { success: true } }),
    authProbe: async () => ({
      logged_in: true,
      auth_method: "claude.ai",
      api_provider: "firstParty",
      subscription_type: "max",
    }),
    peekLock: async () => ({ busy: false, holders: [] }),
    ...overrides,
  };
}

describe("oracle doctor fable", () => {
  test("verifies the exact configured CAAM profile/base and reports the xhigh safe contract", async () => {
    const caamProfileDoctor = vi.fn(async () => ({
      healthy: true as const,
      raw: { success: true },
    }));
    const authProbe = vi.fn(
      async () =>
        ({
          logged_in: true,
          auth_method: "claude.ai",
          api_provider: "firstParty",
          subscription_type: "max",
          email: "private@example.com",
          organization_id: "private-org-id",
        }) as FableAuthStatus,
    );
    const writes: string[] = [];

    const envelope = await runFableDoctor(readyOptions({ caamProfileDoctor, authProbe }), {
      stdout: (text) => writes.push(text),
    });

    expect(envelope.ok).toBe(true);
    expect(envelope.data.status).toBe("ready");
    expect(envelope.data.account).toMatchObject({
      profile: "cc-arthur",
      profile_source: "config",
      base: "/home/ubuntu/orch-homes",
      base_source: "config",
      caam_executable: "/opt/caam",
      claude_executable: "/opt/claude",
      fail_closed: true,
    });
    expect(envelope.data.auth).toEqual({
      logged_in: true,
      auth_method: "claude.ai",
      api_provider: "firstParty",
      subscription_type: "max",
    });
    expect(envelope.data.effort).toBe("xhigh");
    expect(envelope.data.effective_run_contract).toEqual({
      model: "fable",
      effort: "xhigh",
      permission_mode: "plan",
      allowed_tools: [],
      unsafe_flags_allowed: false,
      max_rate_limit_rotations: 0,
    });
    expect(caamProfileDoctor).toHaveBeenCalledWith(
      "/opt/caam",
      "cc-arthur",
      "/home/ubuntu/orch-homes",
      expect.objectContaining({ env: expect.any(Object) }),
    );
    expect(authProbe).toHaveBeenCalledWith({
      caamExecutable: "/opt/caam",
      profile: "cc-arthur",
      base: "/home/ubuntu/orch-homes",
      claudeExecutable: "/opt/claude",
    });
    expect(envelope.commands.doctor).toBe(
      "oracle doctor fable --caam-profile cc-arthur --caam-base /home/ubuntu/orch-homes --json",
    );
    const serialized = writes.join("\n");
    expect(serialized).not.toContain("private@example.com");
    expect(serialized).not.toContain("private-org-id");
    expect(serialized).not.toContain("secret_that_must_not_escape");
  });

  test("fails closed when the selected shallow profile is unavailable and never probes auth", async () => {
    const authProbe = vi.fn<NonNullable<FableDoctorOptions["authProbe"]>>();
    const envelope = await runFableDoctor(
      readyOptions({
        caamProfileDoctor: async () => {
          throw new Error("missing profile with potentially unsafe raw stderr");
        },
        authProbe,
      }),
      { stdout: () => undefined },
    );

    expect(envelope.ok).toBe(false);
    expect(envelope.data.status).toBe("blocked");
    expect(envelope.blocked_reason).toBe("caam_shallow_profile_unavailable");
    expect(envelope.fix_command).toBe(
      "caam shallow-profile create cc-arthur --base /home/ubuntu/orch-homes",
    );
    expect(envelope.errors).toHaveLength(1);
    expect(authProbe).not.toHaveBeenCalled();
    expect(JSON.stringify(envelope)).not.toContain("potentially unsafe raw stderr");
  });

  test("blocks when auth is not a logged-in first-party subscription", async () => {
    const envelope = await runFableDoctor(
      readyOptions({
        authProbe: async () => ({
          logged_in: true,
          auth_method: "api_key",
          api_provider: "anthropic",
          subscription_type: null,
        }),
      }),
      { stdout: () => undefined },
    );

    expect(envelope.ok).toBe(false);
    expect(envelope.blocked_reason).toBe("fable_subscription_auth_unverified");
    expect(envelope.fix_command).toContain("auth login");
    expect(envelope.data.auth).toEqual({
      logged_in: true,
      auth_method: "api_key",
      api_provider: "anthropic",
      subscription_type: null,
    });
  });

  test("still verifies subscription auth when an independent Oracle-home preflight check fails", async () => {
    const authProbe = vi.fn(async () => ({
      logged_in: true,
      auth_method: "claude.ai",
      api_provider: "firstParty",
      subscription_type: "max",
    }));
    const envelope = await runFableDoctor(
      readyOptions({
        claudeCodePreflight: async () => ({
          ok: false,
          checks: HEALTHY_PREFLIGHT.checks.map((check) =>
            check.code === "local_owner_verified"
              ? {
                  ...check,
                  status: "fail" as const,
                  message: "Oracle home is an unsafe symlink.",
                  details: { reason: "oracle_home_unsafe_symlink" },
                }
              : check,
          ),
        }),
        authProbe,
      }),
      { stdout: () => undefined },
    );

    expect(authProbe).toHaveBeenCalledOnce();
    expect(envelope.data.auth?.subscription_type).toBe("max");
    expect(envelope.ok).toBe(false);
    expect(envelope.blocked_reason).toBe("local_owner_verified");
    expect(envelope.fix_command).toBe(
      "ORACLE_HOME_DIR=<real-owned-non-symlink-directory> oracle doctor fable --caam-profile cc-arthur --caam-base /home/ubuntu/orch-homes --json",
    );
  });

  test("resolves the parent shallow-home base and gives an exact list command when profile is missing", async () => {
    const resolveCaamExecutable = vi.fn();
    const envelope = await runFableDoctor(
      readyOptions({
        caamProfile: undefined,
        caamBase: undefined,
        resolveCaamExecutable,
      }),
      { stdout: () => undefined },
    );

    expect(envelope.ok).toBe(false);
    expect(envelope.blocked_reason).toBe("caam_profile_not_configured");
    expect(envelope.data.account.base).toBe("/home/ubuntu/orch-homes");
    expect(envelope.data.account.base_source).toBe("shallow_home_parent");
    expect(envelope.next_command).toBe(
      "caam shallow-profile list --base /home/ubuntu/orch-homes --json",
    );
    expect(envelope.fix_command).toBe(
      "oracle doctor fable --caam-profile <name> --caam-base /home/ubuntu/orch-homes --json",
    );
    expect(envelope.commands.doctor).toBe(
      "oracle doctor fable --caam-profile <name> --caam-base /home/ubuntu/orch-homes --json",
    );
    expect(envelope.commands.run).toBe(
      "oracle --lane fable-local --caam-profile <name> --caam-base /home/ubuntu/orch-homes --prompt <prompt> --file <path>",
    );
    expect(resolveCaamExecutable).not.toHaveBeenCalled();
  });

  test("reports only the selected profile's live lock as a degraded busy lane", async () => {
    const envelope = await runFableDoctor(
      readyOptions({
        peekLock: async () => ({
          busy: true,
          holders: [
            {
              lock_path: "/locks/cc-arthur.lock",
              session_id: "arthur-live",
              holder_pid: 11,
              pid_alive: true,
              held_for_ms: 100,
              caam_profile: "cc-arthur",
            },
            {
              lock_path: "/locks/cc-benson.lock",
              session_id: "benson-live",
              holder_pid: 12,
              pid_alive: true,
              held_for_ms: 100,
              caam_profile: "cc-benson",
            },
          ],
        }),
      }),
      { stdout: () => undefined },
    );

    expect(envelope.ok).toBe(true);
    expect(envelope.data.status).toBe("degraded");
    expect(envelope.data.single_flight_lock).toEqual({
      selected_profile_busy: true,
      live_holders: 1,
    });
    expect(envelope.warnings).toContain("selected_profile_lock:fable_profile_busy");
    expect(envelope.next_command).toContain("--wait-for-lock 5m");
  });

  test("ignores an inherited positive rotation env and preserves strict Fable account pinning", async () => {
    const envelope = await runFableDoctor(
      readyOptions({
        env: {
          HOME: "/home/ubuntu/orch-homes/cod-arthur",
          SHALLOW_PROFILE: "cod-arthur",
          ORACLE_CLAUDE_CODE_MAX_RATE_LIMIT_ROTATIONS: "2",
        },
      }),
      { stdout: () => undefined },
    );

    expect(envelope.ok).toBe(true);
    expect(envelope.data.status).toBe("ready");
    expect(envelope.data.effective_run_contract.max_rate_limit_rotations).toBe(0);
    expect(envelope.warnings).not.toContain(
      "effective_run_contract:fable_account_rotation_enabled",
    );
    expect(envelope.fix_command).toBeNull();
  });

  test("registers the discoverable fable command and fable-local alias", () => {
    const doctor = new Command().command("doctor");
    const command = registerFableDoctorCommand(doctor, readyOptions());

    expect(command.name()).toBe("fable");
    expect(command.aliases()).toContain("fable-local");
    expect(command.description()).toMatch(/without submitting a prompt/i);
    const optionNames = command.options.map((option) => option.long);
    expect(optionNames).toEqual(
      expect.arrayContaining([
        "--caam-profile",
        "--caam-base",
        "--claude-code-executable",
        "--json",
      ]),
    );
  });

  test("the registered fable-local alias sets a nonzero exit code when readiness is blocked", async () => {
    const originalExitCode = process.exitCode;
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    process.exitCode = undefined;
    try {
      const program = new Command().exitOverride();
      const doctor = program.command("doctor");
      registerFableDoctorCommand(
        doctor,
        readyOptions({
          caamProfileDoctor: async () => {
            throw new Error("profile unavailable");
          },
        }),
      );

      await program.parseAsync([
        "node",
        "oracle",
        "doctor",
        "fable-local",
        "--caam-profile",
        "cc-arthur",
        "--caam-base",
        "/home/ubuntu/orch-homes",
        "--json",
      ]);

      expect(process.exitCode).toBe(1);
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('"ok": false'));
    } finally {
      process.exitCode = originalExitCode;
      consoleSpy.mockRestore();
    }
  });
});

type ExecFileCallback = (
  error: (Error & { code?: number | string }) | null,
  stdout: string,
  stderr: string,
) => void;

describe("runFableAuthStatusProbe", () => {
  test("uses the exact profile/base, runs auth status only, and strips identity fields", async () => {
    const calls: string[][] = [];
    const execFileImpl = ((
      file: string,
      args: readonly string[],
      _options: unknown,
      callback: ExecFileCallback,
    ) => {
      calls.push([file, ...args]);
      callback(
        null,
        JSON.stringify({
          loggedIn: true,
          authMethod: "claude.ai",
          apiProvider: "firstParty",
          subscriptionType: "max",
          email: "private@example.com",
          orgId: "private-org-id",
          token: "private-token",
        }),
        "",
      );
      return {} as ReturnType<typeof execFile>;
    }) as unknown as typeof execFile;

    const result = await runFableAuthStatusProbe(
      {
        caamExecutable: "/opt/caam",
        profile: "cc-arthur",
        base: "/home/ubuntu/orch-homes",
        claudeExecutable: "/opt/claude",
      },
      { execFileImpl, env: {} },
    );

    expect(calls).toEqual([
      [
        "/opt/caam",
        "shallow-spawn",
        "cc-arthur",
        "--base",
        "/home/ubuntu/orch-homes",
        "--",
        "/opt/claude",
        "auth",
        "status",
        "--json",
      ],
    ]);
    expect(result).toEqual({
      logged_in: true,
      auth_method: "claude.ai",
      api_provider: "firstParty",
      subscription_type: "max",
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("private@example.com");
    expect(serialized).not.toContain("private-org-id");
    expect(serialized).not.toContain("private-token");
    expect(calls[0]).not.toContain("-p");
    expect(calls[0]).not.toContain("--prompt");
  });

  test("fails closed on malformed auth JSON without echoing stdout", async () => {
    const execFileImpl = ((
      _file: string,
      _args: readonly string[],
      _options: unknown,
      callback: ExecFileCallback,
    ) => {
      callback(null, "private malformed output", "");
      return {} as ReturnType<typeof execFile>;
    }) as unknown as typeof execFile;

    await expect(
      runFableAuthStatusProbe(
        {
          caamExecutable: "/opt/caam",
          profile: "cc-arthur",
          base: "/home/ubuntu/orch-homes",
          claudeExecutable: "/opt/claude",
        },
        { execFileImpl },
      ),
    ).rejects.toThrow(/malformed JSON/);
    await expect(
      runFableAuthStatusProbe(
        {
          caamExecutable: "/opt/caam",
          profile: "cc-arthur",
          base: "/home/ubuntu/orch-homes",
          claudeExecutable: "/opt/claude",
        },
        { execFileImpl },
      ),
    ).rejects.not.toThrow(/private malformed output/);
  });
});

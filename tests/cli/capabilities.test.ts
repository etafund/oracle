import { describe, expect, test } from "vitest";

import {
  ORACLE_CAPABILITIES_SCHEMA_VERSION,
  buildCapabilityReport,
  capabilityById,
  type CapabilityId,
} from "@src/oracle/capabilities/registry.ts";
import { buildCapabilitiesEnvelope, runCapabilities } from "@src/cli/commands/capabilities.ts";
import {
  BROWSER_EVIDENCE_SCHEMA_VERSION,
  CONTEXT_SERIALIZATION_POLICY_SCHEMA_VERSION,
  PROVIDER_ACCESS_POLICY_SCHEMA_VERSION,
  V18_BUNDLE_VERSION,
  jsonEnvelopeSchema,
} from "@src/oracle/v18/index.ts";
import { AGENT_LANE_POLICY_VERSION } from "@src/cli/laneRegistry.ts";
import { ORACLE_EXIT_CODE_DICTIONARY } from "@src/cli/exitCodes.ts";
import { CORE_READ_COMMANDS } from "@src/cli/coreReadCommands.ts";
import {
  IN_FLIGHT_SESSION_STATUSES,
  SESSION_STATUS_VALUES,
  TERMINAL_SESSION_STATUSES,
} from "@src/cli/sessionStatus.ts";
import { ORACLE_SESSION_SCHEMA_VERSION } from "@src/cli/sessionJson.ts";
import { ORACLE_SESSION_LIST_SCHEMA_VERSION } from "@src/cli/sessionListJson.ts";

const FROZEN_TIME = new Date("2026-05-13T00:00:00.000Z");
const EMPTY_ENV: Record<string, string | undefined> = Object.freeze({});

const ALL_FAMILIES: readonly CapabilityId[] = [
  "chatgpt_pro_browser",
  "gemini_deep_think_browser",
  "fable_xhigh_cli",
  "remote_browser",
  "browser_leases",
  "redacted_evidence",
  "provider_access_policy",
  "prompt_payload_format_passthrough",
  "toon_prompt_blocks_passthrough",
  "deepseek_adapter",
] as const;

describe("buildCapabilityReport — static registry", () => {
  test("advertises every required capability family from the bead", () => {
    const report = buildCapabilityReport({ env: EMPTY_ENV, now: FROZEN_TIME });
    const ids = report.capabilities.map((entry) => entry.id);
    for (const family of ALL_FAMILIES) {
      expect(ids).toContain(family);
    }
    expect(report.counts.total).toBe(ALL_FAMILIES.length);
  });

  test("schema_version and bundle_version are pinned literals", () => {
    const report = buildCapabilityReport({ env: EMPTY_ENV, now: FROZEN_TIME });
    expect(report.schema_version).toBe(ORACLE_CAPABILITIES_SCHEMA_VERSION);
    expect(report.bundle_version).toBe(V18_BUNDLE_VERSION);
  });

  test("generated_at echoes the injected clock (deterministic)", () => {
    const report = buildCapabilityReport({ env: EMPTY_ENV, now: FROZEN_TIME });
    expect(report.generated_at).toBe(FROZEN_TIME.toISOString());
  });

  test("output is byte-identical across two calls with the same inputs", () => {
    const a = buildCapabilityReport({ env: EMPTY_ENV, now: FROZEN_TIME });
    const b = buildCapabilityReport({ env: EMPTY_ENV, now: FROZEN_TIME });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  test("CI detection honors the CI env var", () => {
    expect(buildCapabilityReport({ env: { CI: "true" }, now: FROZEN_TIME }).ci).toBe(true);
    expect(buildCapabilityReport({ env: { CI: "1" }, now: FROZEN_TIME }).ci).toBe(true);
    expect(buildCapabilityReport({ env: { CI: "false" }, now: FROZEN_TIME }).ci).toBe(false);
    expect(buildCapabilityReport({ env: EMPTY_ENV, now: FROZEN_TIME }).ci).toBe(false);
  });
});

describe("core lane capability commands", () => {
  test("ChatGPT and Gemini diagnostics point at implemented doctor commands", () => {
    const report = buildCapabilityReport({ env: EMPTY_ENV, now: FROZEN_TIME });
    expect(capabilityById(report, "chatgpt_pro_browser")?.next_command).toBe(
      "oracle doctor chatgpt --json",
    );
    expect(capabilityById(report, "gemini_deep_think_browser")?.next_command).toBe(
      "oracle doctor gemini --json",
    );
    expect(capabilityById(report, "browser_leases")?.next_command).toBe(
      "oracle browser leases status --json",
    );
  });

  test("Fable xHigh is advertised as the local-only reviewed lane", () => {
    const report = buildCapabilityReport({ env: EMPTY_ENV, now: FROZEN_TIME });
    const fable = capabilityById(report, "fable_xhigh_cli");
    expect(fable?.supported).toBe(true);
    expect(fable?.next_command).toBe("oracle doctor fable --json");
    expect(fable?.notes.lane).toBe("fable-local");
    expect(fable?.notes.effort).toBe("xhigh");
    expect(fable?.notes.effort_adjustable).toBe(false);
    expect(fable?.notes.remote_browser_allowed).toBe(false);
    expect(fable?.notes.caam_profile_flag).toBe("--caam-profile <profile>");
    expect(fable?.notes.caam_base_flag).toBe("--caam-base <absolute-path>");
    expect(fable?.notes.explicit_profile_selection_fail_closed).toBe(true);
    expect(fable?.notes.direct_claude_fallback_only_when_profile_omitted).toBe(true);
  });

  test("capabilities names the Fable CAAM environment alternatives without exposing values", () => {
    const report = buildCapabilityReport({ env: EMPTY_ENV, now: FROZEN_TIME });
    const envNames = report.env_var_names as Record<string, string>;
    expect(envNames).toMatchObject({
      claude_code_caam_profile: "ORACLE_CLAUDE_CODE_CAAM_PROFILE",
      claude_code_caam_base: "ORACLE_CLAUDE_CODE_CAAM_BASE",
      caam_shallow_homes_dir: "CAAM_SHALLOW_HOMES_DIR",
      caam_executable: "ORACLE_CAAM_EXECUTABLE",
      claude_code_max_rate_limit_rotations: "ORACLE_CLAUDE_CODE_MAX_RATE_LIMIT_ROTATIONS",
    });
  });
});

describe("remote_browser capability — missing config flow", () => {
  test("with no env vars set, remote_browser is available but not ready", () => {
    const report = buildCapabilityReport({ env: EMPTY_ENV, now: FROZEN_TIME });
    const remote = capabilityById(report, "remote_browser");
    expect(remote?.status).toBe("available");
    expect(remote?.next_command).toContain("ORACLE_REMOTE_HOST");
    expect(remote?.next_command).toContain("ORACLE_REMOTE_TOKEN");
    expect(remote?.fix_command).toContain("ORACLE_REMOTE_HOST");
    expect(remote?.notes.host_present).toBe(false);
    expect(remote?.notes.token_present).toBe(false);
    expect(remote?.notes.missing_env_vars).toEqual(["ORACLE_REMOTE_HOST", "ORACLE_REMOTE_TOKEN"]);
  });

  test("with both env vars present, remote_browser is ready", () => {
    const report = buildCapabilityReport({
      env: { ORACLE_REMOTE_HOST: "10.0.0.1:9473", ORACLE_REMOTE_TOKEN: "secret" },
      now: FROZEN_TIME,
    });
    const remote = capabilityById(report, "remote_browser");
    expect(remote?.status).toBe("ready");
    expect(remote?.next_command).toBe("oracle remote doctor --json");
    expect(remote?.notes.host_present).toBe(true);
    expect(remote?.notes.token_present).toBe(true);
  });

  test("only host present surfaces the missing token only", () => {
    const report = buildCapabilityReport({
      env: { ORACLE_REMOTE_HOST: "10.0.0.1:9473" },
      now: FROZEN_TIME,
    });
    const remote = capabilityById(report, "remote_browser");
    expect(remote?.status).toBe("available");
    expect(remote?.notes.missing_env_vars).toEqual(["ORACLE_REMOTE_TOKEN"]);
  });
});

describe("browser provider capabilities advertise typed evidence + invariants", () => {
  test("chatgpt_pro_browser carries the evidence schema version and never_clicks_answer_now", () => {
    const report = buildCapabilityReport({ env: EMPTY_ENV, now: FROZEN_TIME });
    const chatgpt = capabilityById(report, "chatgpt_pro_browser");
    expect(chatgpt?.supported).toBe(true);
    expect(chatgpt?.notes.evidence_schema_version).toBe(BROWSER_EVIDENCE_SCHEMA_VERSION);
    expect(chatgpt?.notes.never_clicks_answer_now).toBe(true);
    expect(chatgpt?.notes.requires_same_session_evidence).toBe(true);
  });

  test("gemini_deep_think_browser advertises high_if_exposed strategy and no API substitution", () => {
    const report = buildCapabilityReport({ env: EMPTY_ENV, now: FROZEN_TIME });
    const gemini = capabilityById(report, "gemini_deep_think_browser");
    expect(gemini?.notes.strategy).toBe("high_if_exposed");
    expect(gemini?.notes.never_substitutes_gemini_api).toBe(true);
  });
});

describe("TOON passthrough metadata", () => {
  test("toon_prompt_blocks_passthrough is gated_optional with canonical_storage_format=json", () => {
    const report = buildCapabilityReport({ env: EMPTY_ENV, now: FROZEN_TIME });
    const toon = capabilityById(report, "toon_prompt_blocks_passthrough");
    expect(toon?.supported).toBe(true);
    expect(toon?.status).toBe("available");
    expect(toon?.notes.canonical_storage_format).toBe("json");
    expect(toon?.notes.policy_status).toBe("gated_optional");
    expect(toon?.notes.toon_rust_enabled_by_default).toBe(false);
    expect(toon?.notes.context_serialization_policy_schema_version).toBe(
      CONTEXT_SERIALIZATION_POLICY_SCHEMA_VERSION,
    );
  });
});

describe("provider access policy metadata", () => {
  test("provider_access_policy carries the v1 schema version and api_substitution_guard", () => {
    const report = buildCapabilityReport({ env: EMPTY_ENV, now: FROZEN_TIME });
    const policy = capabilityById(report, "provider_access_policy");
    expect(policy?.supported).toBe(true);
    expect(policy?.status).toBe("ready");
    expect(policy?.notes.policy_schema_version).toBe(PROVIDER_ACCESS_POLICY_SCHEMA_VERSION);
    expect(policy?.notes.api_substitution_guard).toBe(true);
  });
});

describe("deepseek_adapter explicitly NOT owned by Oracle", () => {
  test("status=unsupported with ownership=apr", () => {
    const report = buildCapabilityReport({ env: EMPTY_ENV, now: FROZEN_TIME });
    const deepseek = capabilityById(report, "deepseek_adapter");
    expect(deepseek?.supported).toBe(false);
    expect(deepseek?.status).toBe("unsupported");
    expect(deepseek?.notes.ownership).toBe("apr");
  });
});

describe("buildCapabilitiesEnvelope — json_envelope.v1 conformance", () => {
  test("envelope passes the v18 jsonEnvelopeSchema", () => {
    const { envelope } = buildCapabilitiesEnvelope({ env: EMPTY_ENV, now: FROZEN_TIME });
    expect(() => jsonEnvelopeSchema.parse(envelope)).not.toThrow();
    expect(envelope.ok).toBe(true);
    expect(envelope.schema_version).toBe("json_envelope.v1");
    expect(envelope.meta.bundle_version).toBe(V18_BUNDLE_VERSION);
    expect(envelope.meta.schema_version).toBe(ORACLE_CAPABILITIES_SCHEMA_VERSION);
  });

  test("envelope surfaces a fix_command when remote config is missing", () => {
    const { envelope } = buildCapabilitiesEnvelope({ env: EMPTY_ENV, now: FROZEN_TIME });
    expect(envelope.fix_command).toMatch(/ORACLE_REMOTE_HOST/);
  });

  test("envelope is healthy (no fix_command from remote_browser) when env is configured", () => {
    const { envelope } = buildCapabilitiesEnvelope({
      env: { ORACLE_REMOTE_HOST: "h:9473", ORACLE_REMOTE_TOKEN: "t" },
      now: FROZEN_TIME,
    });
    // fix_command is allowed to be null OR a non-remote-related string;
    // it must NEVER tell the caller to set the env vars that are already set.
    const fix = envelope.fix_command;
    if (typeof fix === "string") {
      expect(fix).not.toMatch(/ORACLE_REMOTE_HOST|ORACLE_REMOTE_TOKEN/);
    } else {
      expect(fix).toBeNull();
    }
  });

  test("commands map carries the three preflight commands", () => {
    const { envelope } = buildCapabilitiesEnvelope({ env: EMPTY_ENV, now: FROZEN_TIME });
    const commands = envelope.commands as Record<string, unknown>;
    expect(commands.capabilities).toBe("oracle capabilities --json");
    expect(commands.doctor).toBe("oracle doctor --json");
    expect(commands.remote_doctor).toBe("oracle remote doctor --json");
  });
});

describe("never prints secrets — redaction of tokens/account data", () => {
  test("env values are never echoed into the report", () => {
    const env = {
      ORACLE_REMOTE_HOST: "private-host.internal:9473",
      ORACLE_REMOTE_TOKEN: "sk-super-secret-token-value",
      OPENAI_API_KEY: "sk-openai-private",
      GEMINI_API_KEY: "sk-gemini-private",
      EMAIL: "agent@example.com",
    };
    const { envelope, report } = buildCapabilitiesEnvelope({ env, now: FROZEN_TIME });
    const serialized = JSON.stringify(envelope) + JSON.stringify(report);
    for (const secret of [
      "private-host.internal",
      "sk-super-secret-token-value",
      "sk-openai-private",
      "sk-gemini-private",
      "agent@example.com",
    ]) {
      expect(serialized, `secret "${secret}" must not appear in capabilities output`).not.toContain(
        secret,
      );
    }
    // We DO surface ENV VAR NAMES (those are not secrets).
    expect(serialized).toContain("ORACLE_REMOTE_HOST");
    expect(serialized).toContain("ORACLE_REMOTE_TOKEN");
  });
});

describe("no live-provider calls — pure registry guarantee", () => {
  test("buildCapabilityReport executes synchronously and does not touch the network", async () => {
    // If any code path attempted a fetch, this synchronous function would
    // either throw or hang. The fact that buildCapabilityReport is pure
    // and synchronous IS the guarantee. We also assert there is no
    // promise hidden in the result.
    const env = { CI: "true", ORACLE_REMOTE_HOST: "host:9473", ORACLE_REMOTE_TOKEN: "t" };
    const report = buildCapabilityReport({ env, now: FROZEN_TIME });
    expect(typeof (report as Record<string, unknown>).then).toBe("undefined");
    // And: no fetch / http symbol leaks into the report shape.
    const serialized = JSON.stringify(report);
    expect(serialized).not.toMatch(/Promise|http\.IncomingMessage/);
  });
});

describe("runCapabilities — CLI surface", () => {
  test("default invocation writes a JSON envelope to stdout", async () => {
    const chunks: string[] = [];
    await runCapabilities(
      { env: EMPTY_ENV, now: FROZEN_TIME, json: true },
      { stdout: (text) => chunks.push(text) },
    );
    expect(chunks.length).toBe(1);
    const payload = JSON.parse(chunks[0]);
    expect(payload.schema_version).toBe("json_envelope.v1");
    expect(payload.ok).toBe(true);
  });

  test("--no-json writes a deterministic human summary", async () => {
    const chunks: string[] = [];
    await runCapabilities(
      { env: EMPTY_ENV, now: FROZEN_TIME, json: false },
      { stdout: (text) => chunks.push(text) },
    );
    const text = chunks.join("");
    expect(text).toContain("oracle capabilities");
    expect(text).toContain(FROZEN_TIME.toISOString());
    for (const family of ALL_FAMILIES) {
      expect(text).toContain(family);
    }
  });

  test("two runs with the same inputs produce byte-identical JSON output", async () => {
    const captureA: string[] = [];
    const captureB: string[] = [];
    await runCapabilities(
      { env: EMPTY_ENV, now: FROZEN_TIME, json: true },
      { stdout: (text) => captureA.push(text) },
    );
    await runCapabilities(
      { env: EMPTY_ENV, now: FROZEN_TIME, json: true },
      { stdout: (text) => captureB.push(text) },
    );
    expect(captureA.join("")).toBe(captureB.join(""));
  });
});

// ─── agent-ergonomics Stage 1: schema-pin regression test ──────────────────
//
// `oracle capabilities --json` is a STABLE, documented contract (Axiom 9 —
// self_documentation) — the axiom is that its shape stays stable across
// patches. This test pins the top-level key set of `CapabilityReport` so
// any future addition/removal/rename is a conscious, reviewed diff to this
// test rather than a silent contract change an agent caller would never
// notice until it broke.
describe("CapabilityReport — schema-pin regression test (agent-ergonomics Stage 1)", () => {
  const EXPECTED_TOP_LEVEL_KEYS = [
    "bundle_version",
    "ci",
    "counts",
    "capabilities",
    "env_var_names",
    "exit_codes",
    "generated_at",
    "lanes",
    "lanes_policy_version",
    "read_commands",
    "run_action",
    "schema_version",
    "session_contracts",
    "tty",
  ].sort();

  test("top-level key set matches the pinned contract exactly", () => {
    const report = buildCapabilityReport({ env: EMPTY_ENV, now: FROZEN_TIME });
    expect(Object.keys(report).sort()).toEqual(EXPECTED_TOP_LEVEL_KEYS);
  });

  test("run_action names the core one-shot invocation and its required flags", () => {
    const report = buildCapabilityReport({ env: EMPTY_ENV, now: FROZEN_TIME });
    expect(report.run_action.command).toContain("--lane");
    expect(report.run_action.required_flags).toEqual(["--prompt", "--file"]);
    expect(report.run_action.key_flags).toContain("--lane");
  });

  test("lanes advertises exactly the 3 reviewed lanes, sourced from laneRegistry.ts", () => {
    const report = buildCapabilityReport({ env: EMPTY_ENV, now: FROZEN_TIME });
    expect(report.lanes.map((lane) => lane.lane)).toEqual([
      "chatgpt-pro",
      "gemini-deep-think",
      "fable-local",
    ]);
    expect(report.lanes_policy_version).toBe(AGENT_LANE_POLICY_VERSION);
    for (const lane of report.lanes) {
      expect(lane.command).toMatch(/^oracle --lane /);
      expect(lane.doctor_command).toMatch(/^oracle doctor /);
      expect(Array.isArray(lane.key_flags)).toBe(true);
      expect(lane.key_flags.length).toBeGreaterThan(0);
      expect(typeof lane.attachments.supported).toBe("boolean");
      expect(typeof lane.attachments.binary_supported).toBe("boolean");
      expect(["dom_upload", "inline_text_only", "http_fallback_only"]).toContain(
        lane.attachments.mechanism,
      );
      expect(typeof lane.attachments.downgrades_verification).toBe("boolean");
      expect(typeof lane.continuability.cross_invocation_resume).toBe("boolean");
      expect(typeof lane.continuability.same_invocation_multi_turn).toBe("boolean");
      expect(typeof lane.reasoning_depth_adjustable).toBe("boolean");
      expect(lane.fixed_reasoning_effort === null || lane.fixed_reasoning_effort === "xhigh").toBe(
        true,
      );
      expect(typeof lane.explicit_profile_selection_fail_closed).toBe("boolean");
    }
  });

  test("each reviewed lane names the flags that distinguish its route", () => {
    const report = buildCapabilityReport({ env: EMPTY_ENV, now: FROZEN_TIME });
    const chatgpt = report.lanes.find((lane) => lane.lane === "chatgpt-pro");
    const gemini = report.lanes.find((lane) => lane.lane === "gemini-deep-think");
    const fable = report.lanes.find((lane) => lane.lane === "fable-local");
    expect(chatgpt?.key_flags).toContain("--browser-thinking-time extended");
    expect(gemini?.key_flags).toContain("--gemini-deep-think");
    expect(fable?.key_flags).toContain("--caam-profile <profile>");
    expect(fable?.key_flags).toContain("--caam-base <absolute-path>");
    expect(fable?.doctor_command).toBe("oracle doctor fable --json");
  });

  test("attachments/continuability/reasoning_depth_adjustable are sourced from laneRegistry.ts per lane", () => {
    const report = buildCapabilityReport({ env: EMPTY_ENV, now: FROZEN_TIME });
    const chatgpt = report.lanes.find((lane) => lane.lane === "chatgpt-pro");
    const gemini = report.lanes.find((lane) => lane.lane === "gemini-deep-think");
    const fable = report.lanes.find((lane) => lane.lane === "fable-local");

    expect(chatgpt?.attachments).toEqual({
      supported: true,
      binary_supported: true,
      mechanism: "dom_upload",
      downgrades_verification: false,
    });
    expect(chatgpt?.continuability).toEqual({
      cross_invocation_resume: true,
      same_invocation_multi_turn: true,
    });
    // chatgpt-pro hard-forces thinkingTime=extended (its only verified mode),
    // so reasoning depth is NOT adjustable — the advertisement must say so.
    expect(chatgpt?.reasoning_depth_adjustable).toBe(false);

    // Gemini Deep Think: attaching a file silently downgrades to the
    // unverified HTTP client (see src/gemini-web/executionMode.ts), and
    // --followup / --browser-follow-up don't resume Gemini sessions today.
    expect(gemini?.attachments).toEqual({
      supported: true,
      binary_supported: true,
      mechanism: "http_fallback_only",
      downgrades_verification: true,
    });
    expect(gemini?.continuability).toEqual({
      cross_invocation_resume: false,
      same_invocation_multi_turn: false,
    });
    expect(gemini?.reasoning_depth_adjustable).toBe(false);

    // Fable (claude-code): text-only inline attachments, real cross-invocation
    // resume via --session-id, no same-invocation multi-turn (not a browser
    // engine), and a fixed --effort xhigh with no adjustable depth knob.
    expect(fable?.attachments).toEqual({
      supported: true,
      binary_supported: false,
      mechanism: "inline_text_only",
      downgrades_verification: false,
    });
    expect(fable?.continuability).toEqual({
      cross_invocation_resume: true,
      same_invocation_multi_turn: false,
    });
    expect(fable?.reasoning_depth_adjustable).toBe(false);
    expect(fable?.fixed_reasoning_effort).toBe("xhigh");
    expect(fable?.explicit_profile_selection_fail_closed).toBe(true);
  });

  test("exit_codes matches the shared ORACLE_EXIT_CODE_DICTIONARY exactly", () => {
    const report = buildCapabilityReport({ env: EMPTY_ENV, now: FROZEN_TIME });
    expect(report.exit_codes).toEqual(ORACLE_EXIT_CODE_DICTIONARY);
    expect(Object.keys(report.exit_codes).sort()).toEqual(
      ["0", "1", "2", "3", "4", "5", "6", "7", "130"].sort(),
    );
    // Exit 7 is the `oracle wait` deadline code.
    expect(report.exit_codes["7"]).toContain("wait_timeout");
  });

  test("read_commands matches the shared CORE_READ_COMMANDS list and includes self-doc commands", () => {
    const report = buildCapabilityReport({ env: EMPTY_ENV, now: FROZEN_TIME });
    expect(report.read_commands).toEqual(CORE_READ_COMMANDS);
    const names = report.read_commands.map((cmd) => cmd.name);
    expect(names).toContain("capabilities");
    expect(names).toContain("robot-docs");
    expect(names).toContain("doctor-lanes");
    expect(names).toContain("doctor-fable");
    expect(names).toContain("session");
    expect(names).toContain("status");
  });

  test("the pinned contract still round-trips through the json_envelope.v1 wrapper", () => {
    const { envelope } = buildCapabilitiesEnvelope({ env: EMPTY_ENV, now: FROZEN_TIME });
    expect(() => jsonEnvelopeSchema.parse(envelope)).not.toThrow();
    const data = envelope.data as Record<string, unknown>;
    expect(Object.keys(data).sort()).toEqual(EXPECTED_TOP_LEVEL_KEYS);
  });

  test("session_contracts advertises the closed status enum and both JSON schema versions", () => {
    const report = buildCapabilityReport({ env: EMPTY_ENV, now: FROZEN_TIME });
    const contracts = report.session_contracts;
    // Schema-version literals in the registry must match their contract modules.
    expect(contracts.session_schema_version).toBe(ORACLE_SESSION_SCHEMA_VERSION);
    expect(contracts.session_list_schema_version).toBe(ORACLE_SESSION_LIST_SCHEMA_VERSION);
    // Closed status enum + terminal/in-flight partition, sourced from sessionStatus.ts.
    expect([...contracts.status_values]).toEqual([...SESSION_STATUS_VALUES]);
    expect([...contracts.terminal_statuses]).toEqual([...TERMINAL_SESSION_STATUSES]);
    expect([...contracts.in_flight_statuses]).toEqual([...IN_FLIGHT_SESSION_STATUSES]);
    // Every terminal + in-flight status is a member of the full enum, and the
    // two partitions cover it exactly.
    expect([...contracts.terminal_statuses, ...contracts.in_flight_statuses].sort()).toEqual(
      [...SESSION_STATUS_VALUES].sort(),
    );
    expect(contracts.commands.wait_json).toBe("oracle wait <id> --json");
    expect(contracts.commands.cancel).toBe("oracle cancel <id>");
  });
});

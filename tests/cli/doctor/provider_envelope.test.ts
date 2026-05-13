import { describe, expect, test } from "vitest";

import {
  runChatGptDoctor,
  type ProviderProbeResult,
} from "../../../src/cli/commands/doctor/chatgpt.js";
import { runGeminiDoctor } from "../../../src/cli/commands/doctor/gemini.js";
import { jsonEnvelopeStrictSchema } from "../../../src/oracle/v18/index.js";
import type { SessionMetadata } from "../../../src/sessionStore.js";

const passProbe =
  (code: string): (() => Promise<ProviderProbeResult>) =>
  async () => ({
    status: "pass",
    code,
    message: `${code} ok`,
  });

function session(provider: "chatgpt" | "gemini"): SessionMetadata {
  const model = provider === "gemini" ? "gemini-3-pro" : "gpt-5.2-pro";
  return {
    id: `${provider}-session`,
    createdAt: "2026-05-13T00:00:00.000Z",
    startedAt: "2026-05-13T00:01:00.000Z",
    completedAt: "2026-05-13T00:02:00.000Z",
    status: "completed",
    mode: "browser",
    model,
    options: { model, prompt: "provider envelope fixture" },
  } as SessionMetadata;
}

function store(provider: "chatgpt" | "gemini") {
  return {
    listSessions: async () => [session(provider)],
  };
}

describe("provider doctor json_envelope.v1 output", () => {
  test("chatgpt --json wraps provider_doctor.v1 in a robot envelope", async () => {
    const output: string[] = [];

    await runChatGptDoctor(
      {
        json: true,
        pro: true,
        extendedReasoning: true,
        sessionStore: store("chatgpt"),
        cookieSyncProbe: passProbe("cookie_sync_ok"),
        keytarProbe: passProbe("keytar_ok"),
        uiProbe: async () => ({
          status: "verified",
          observedModeLabel: "Pro",
          observedEffortLabel: "Heavy",
          effortRank: "highest_visible",
        }),
      },
      { stdout: (text) => output.push(text) },
    );

    const envelope = jsonEnvelopeStrictSchema.parse(JSON.parse(output[0]));
    expect(envelope).toMatchObject({
      schema_version: "json_envelope.v1",
      ok: true,
      blocked_reason: null,
      retry_safe: true,
      data: {
        schema_version: "provider_doctor.v1",
        provider: "chatgpt",
        ok: true,
      },
      meta: {
        command: "oracle doctor chatgpt --json",
        schema_version: "provider_doctor.v1",
        provider: "chatgpt",
      },
      errors: [],
      warnings: [],
      commands: {
        provider_doctor: "oracle doctor chatgpt --json",
        doctor: "oracle doctor --json",
      },
    });
  });

  test("chatgpt blocker maps provider-specific failures to v18 recovery fields", async () => {
    const output: string[] = [];

    await runChatGptDoctor(
      {
        json: true,
        sessionStore: store("chatgpt"),
        cookieSyncProbe: passProbe("cookie_sync_ok"),
        keytarProbe: passProbe("keytar_ok"),
        uiProbe: async () => ({ status: "missing_effort_control" }),
      },
      { stdout: (text) => output.push(text) },
    );

    const envelope = jsonEnvelopeStrictSchema.parse(JSON.parse(output[0]));
    expect(envelope.ok).toBe(false);
    expect(envelope.blocked_reason).toBe("missing_effort_control");
    expect(envelope.retry_safe).toBe(false);
    expect(envelope.errors[0]).toMatchObject({
      error_code: "chatgpt_extended_reasoning_unverified",
      details: { check: "ui_mode", code: "missing_effort_control" },
    });
    expect(envelope.next_command).toBe("oracle doctor chatgpt --json");
  });

  test("gemini --json wraps auth blockers in the same robot envelope shape", async () => {
    const output: string[] = [];

    await runGeminiDoctor(
      {
        json: true,
        deepThink: true,
        sessionStore: store("gemini"),
        authProbe: async () => ({
          status: "fail",
          code: "provider_login_required",
          message: "Gemini auth missing",
          next_command: "oracle doctor gemini --json",
        }),
        uiProbe: async () => ({ status: "verified" }),
      },
      { stdout: (text) => output.push(text) },
    );

    const envelope = jsonEnvelopeStrictSchema.parse(JSON.parse(output[0]));
    expect(envelope).toMatchObject({
      schema_version: "json_envelope.v1",
      ok: false,
      blocked_reason: "provider_login_required",
      retry_safe: false,
      data: {
        schema_version: "provider_doctor.v1",
        provider: "gemini",
        ok: false,
      },
      meta: {
        command: "oracle doctor gemini --json",
        schema_version: "provider_doctor.v1",
        provider: "gemini",
      },
      errors: [
        expect.objectContaining({
          error_code: "provider_login_required",
          message: "Gemini auth missing",
        }),
      ],
      commands: {
        provider_doctor: "oracle doctor gemini --json",
        doctor: "oracle doctor --json",
      },
    });
  });
});

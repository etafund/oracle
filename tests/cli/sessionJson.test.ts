import { beforeEach, describe, expect, test, vi } from "vitest";
import type { SessionMetadata } from "../../src/sessionManager.ts";
import { buildImportedChatgptConversationSessionMetadata } from "../../src/browser/importedConversation.ts";

const sessionStoreMock = vi.hoisted(() => ({
  readSession: vi.fn(),
  getPaths: vi.fn(),
  sessionsDir: vi.fn().mockReturnValue("/tmp/.oracle/sessions"),
}));

vi.mock("../../src/sessionStore.ts", () => ({
  sessionStore: sessionStoreMock,
}));

import {
  ORACLE_SESSION_SCHEMA_VERSION,
  buildSessionJsonEnvelope,
  buildSessionJsonPayload,
  buildSessionNotFoundEnvelope,
  resolveSessionExitCode,
  runSessionJson,
} from "../../src/cli/sessionJson.ts";
import {
  JSON_ENVELOPE_SCHEMA_VERSION,
  V18_BUNDLE_VERSION,
  jsonEnvelopeSchema,
} from "../../src/oracle/v18/index.ts";

function meta(overrides: Partial<SessionMetadata> = {}): SessionMetadata {
  return {
    id: "sess-1",
    createdAt: "2026-07-01T00:00:00.000Z",
    status: "completed",
    options: {} as SessionMetadata["options"],
    ...overrides,
  } as SessionMetadata;
}

function importedMeta(): SessionMetadata {
  return buildImportedChatgptConversationSessionMetadata({
    sessionId: "sess-1",
    conversationUrl: "https://chatgpt.com/c/imported-session",
    conversationId: "imported-session",
    cwd: "/tmp/imported-session",
    importedAt: "2026-07-01T00:00:00.000Z",
  });
}

const PATHS = {
  sessionDir: "/tmp/.oracle/sessions/sess-1",
  outputFile: "/tmp/.oracle/sessions/sess-1/output.log",
};

beforeEach(() => {
  sessionStoreMock.readSession.mockReset();
  sessionStoreMock.getPaths.mockReset();
  sessionStoreMock.sessionsDir.mockReturnValue("/tmp/.oracle/sessions");
});

describe("resolveSessionExitCode", () => {
  test("null while in flight (non-terminal)", () => {
    expect(resolveSessionExitCode(meta({ status: "running" }))).toBeNull();
    expect(resolveSessionExitCode(meta({ status: "pending" }))).toBeNull();
  });

  test("0 for completed and partial", () => {
    expect(resolveSessionExitCode(meta({ status: "completed" }))).toBe(0);
    expect(resolveSessionExitCode(meta({ status: "partial" }))).toBe(0);
  });

  test("1 for cancelled", () => {
    expect(resolveSessionExitCode(meta({ status: "cancelled" }))).toBe(1);
  });

  test("0 for a valid imported reference without treating it as a consult success", () => {
    expect(resolveSessionExitCode(importedMeta())).toBe(0);
  });

  test("1 for a raw imported status that fails exact pure-shape validation", () => {
    expect(resolveSessionExitCode(meta({ status: "imported" }))).toBe(1);
  });

  test("maps classified failures onto the taxonomy (timeout -> 5)", () => {
    expect(
      resolveSessionExitCode(meta({ status: "error", transport: { reason: "client-timeout" } })),
    ).toBe(5);
  });

  test("maps auth/usage error details onto the taxonomy", () => {
    expect(
      resolveSessionExitCode(
        meta({
          status: "error",
          error: {
            category: "browser-automation",
            details: { error_code: "provider_login_required" },
          },
        }),
      ),
    ).toBe(3);
    expect(
      resolveSessionExitCode(
        meta({
          status: "error",
          error: {
            category: "browser-automation",
            details: { error_code: "provider_usage_limit" },
          },
        }),
      ),
    ).toBe(4);
  });

  test("1 for an unclassified error", () => {
    expect(resolveSessionExitCode(meta({ status: "error", errorMessage: "boom" }))).toBe(1);
  });
});

describe("buildSessionJsonPayload", () => {
  test("maps a completed session to the pinned oracle_session.v1 shape", () => {
    const payload = buildSessionJsonPayload(
      meta({
        id: "sess-1",
        lane: "fable-local",
        model: "fable",
        mode: "claude-code",
        status: "completed",
        startedAt: "2026-07-01T00:00:01.000Z",
        completedAt: "2026-07-01T00:05:00.000Z",
        elapsedMs: 299_000,
        usage: {
          inputTokens: 10,
          outputTokens: 20,
          reasoningTokens: 5,
          totalTokens: 35,
          cost: 0.01,
        },
      }),
      PATHS,
    );
    expect(payload).toEqual({
      schema_version: "oracle_session.v1",
      id: "sess-1",
      lane: "fable-local",
      model: "fable",
      mode: "claude-code",
      status: "completed",
      terminal: true,
      exit_code: 0,
      created_at: "2026-07-01T00:00:00.000Z",
      started_at: "2026-07-01T00:00:01.000Z",
      completed_at: "2026-07-01T00:05:00.000Z",
      updated_at: "2026-07-01T00:05:00.000Z",
      elapsed_ms: 299_000,
      usage: {
        input_tokens: 10,
        output_tokens: 20,
        reasoning_tokens: 5,
        total_tokens: 35,
        cost_usd: 0.01,
      },
      artifacts_path: PATHS.sessionDir,
      output_file: PATHS.outputFile,
      final_answer_path: null,
      error: null,
    });
  });

  test("lane/model/usage default to null; error present only on failure", () => {
    const running = buildSessionJsonPayload(meta({ status: "running" }), PATHS);
    expect(running.lane).toBeNull();
    expect(running.model).toBeNull();
    expect(running.usage).toBeNull();
    expect(running.exit_code).toBeNull();
    expect(running.terminal).toBe(false);
    expect(running.error).toBeNull();

    const failed = buildSessionJsonPayload(
      meta({ status: "error", transport: { reason: "client-timeout" }, errorMessage: "deadline" }),
      PATHS,
    );
    expect(failed.exit_code).toBe(5);
    expect(failed.error).toEqual({ code: "timeout", message: "deadline" });

    const cancelled = buildSessionJsonPayload(meta({ status: "cancelled" }), PATHS);
    expect(cancelled.error?.code).toBe("cancelled");
    expect(cancelled.exit_code).toBe(1);
  });

  test("surfaces the Claude Code final-answer artifact path when present", () => {
    const payload = buildSessionJsonPayload(
      meta({
        status: "completed",
        claudeCode: {
          artifact_paths: {
            finalAnswerPath: "/tmp/.oracle/sessions/sess-1/artifacts/claude-code-final.md",
          },
        } as SessionMetadata["claudeCode"],
      }),
      PATHS,
    );
    expect(payload.final_answer_path).toBe(
      "/tmp/.oracle/sessions/sess-1/artifacts/claude-code-final.md",
    );
  });

  test("an imported reference exposes no synthetic output or completion timestamp", () => {
    const payload = buildSessionJsonPayload(importedMeta(), PATHS);
    expect(payload.status).toBe("imported");
    expect(payload.terminal).toBe(true);
    expect(payload.exit_code).toBe(0);
    expect(payload.completed_at).toBeNull();
    expect(payload.output_file).toBeNull();
  });

  test.each([
    ["missing marker", meta({ status: "imported" })],
    [
      "null marker",
      meta({
        status: "imported",
        browser: { importedConversation: null } as unknown as SessionMetadata["browser"],
      }),
    ],
    [
      "marker on completed record",
      meta({
        status: "completed",
        browser: {
          importedConversation: { schema: "malformed-import-claim" },
        } as unknown as SessionMetadata["browser"],
      }),
    ],
    ["mixed record", { ...importedMeta(), lane: "chatgpt-pro" } as SessionMetadata],
  ])("fails closed for an invalid imported record: %s", (_label, metadata) => {
    const payload = buildSessionJsonPayload(metadata, PATHS);
    expect(payload.status).toBe("error");
    expect(payload.terminal).toBe(true);
    expect(payload.exit_code).toBe(1);
    expect(payload.output_file).toBe(PATHS.outputFile);
    expect(payload.error).toEqual({
      code: "invalid_imported_session",
      message: expect.stringContaining("does not match Oracle's exact metadata-only"),
    });
  });
});

describe("buildSessionJsonEnvelope — json_envelope.v1 conformance", () => {
  test("envelope passes the v18 schema and wraps the payload intact", () => {
    const { envelope, payload } = buildSessionJsonEnvelope(meta({ status: "running" }), {
      ...PATHS,
      generatedAt: "2026-07-02T00:00:00.000Z",
    });
    expect(() => jsonEnvelopeSchema.parse(envelope)).not.toThrow();
    expect(envelope.ok).toBe(true);
    expect(envelope.schema_version).toBe(JSON_ENVELOPE_SCHEMA_VERSION);
    expect(envelope.meta.bundle_version).toBe(V18_BUNDLE_VERSION);
    expect(envelope.meta.schema_version).toBe(ORACLE_SESSION_SCHEMA_VERSION);
    expect(envelope.data).toEqual(payload);
    // in flight -> points the caller at wait; commands map advertises the verbs
    expect(envelope.next_command).toBe("oracle wait sess-1 --json");
    const commands = envelope.commands as Record<string, unknown>;
    expect(commands.wait_json).toBe("oracle wait sess-1 --json");
    expect(commands.cancel).toBe("oracle cancel sess-1");
  });

  test("a transiently-failed session advertises retry_safe=true", () => {
    const { envelope } = buildSessionJsonEnvelope(
      meta({ status: "error", transport: { reason: "client-timeout" } }),
      PATHS,
    );
    expect(envelope.retry_safe).toBe(true);
    expect(envelope.next_command).toBe("oracle session sess-1 --artifacts --json");
  });

  test("an imported reference points only to the explicit compatibility follow-up", () => {
    const { envelope } = buildSessionJsonEnvelope(importedMeta(), PATHS);
    expect(envelope.next_command).toBe(
      'oracle --engine browser --remote-browser off --browser-model-strategy current --followup sess-1 -p "..."',
    );
    expect(envelope.commands).toEqual({
      session_json: "oracle session sess-1 --json",
      followup_compatibility:
        'oracle --engine browser --remote-browser off --browser-model-strategy current --followup sess-1 -p "..."',
    });
  });

  test("an invalid imported record has no compatibility follow-up command", () => {
    const { envelope } = buildSessionJsonEnvelope(meta({ status: "imported" }), PATHS);
    expect(envelope.next_command).toBe("oracle session sess-1 --artifacts --json");
    expect(envelope.commands).not.toHaveProperty("followup_compatibility");
    expect(envelope.retry_safe).toBe(false);
  });
});

describe("buildSessionNotFoundEnvelope", () => {
  test("is a valid ok:false envelope naming the missing id", () => {
    const envelope = buildSessionNotFoundEnvelope("nope", "2026-07-02T00:00:00.000Z");
    expect(() => jsonEnvelopeSchema.parse(envelope)).not.toThrow();
    expect(envelope.ok).toBe(false);
    expect(envelope.blocked_reason).toBe("session_not_found");
    expect(envelope.warnings.join(" ")).toContain("nope");
  });
});

describe("runSessionJson — CLI surface", () => {
  test("writes one envelope and returns found:true for a known session", async () => {
    sessionStoreMock.readSession.mockResolvedValue(meta({ status: "completed" }));
    sessionStoreMock.getPaths.mockResolvedValue({ dir: PATHS.sessionDir, log: PATHS.outputFile });
    const chunks: string[] = [];
    const result = await runSessionJson("sess-1", { stdout: (t) => chunks.push(t) });
    expect(result.found).toBe(true);
    expect(chunks.length).toBe(1);
    const parsed = JSON.parse(chunks[0]);
    expect(parsed.ok).toBe(true);
    expect(parsed.data.schema_version).toBe(ORACLE_SESSION_SCHEMA_VERSION);
    expect(parsed.data.id).toBe("sess-1");
  });

  test("writes an ok:false envelope and returns found:false for an unknown session", async () => {
    sessionStoreMock.readSession.mockResolvedValue(null);
    const chunks: string[] = [];
    const result = await runSessionJson("ghost", { stdout: (t) => chunks.push(t) });
    expect(result.found).toBe(false);
    const parsed = JSON.parse(chunks[0]);
    expect(parsed.ok).toBe(false);
    expect(parsed.blocked_reason).toBe("session_not_found");
  });
});

// ─── schema-pin regression test ────────────────────────────────────────────

describe("oracle_session.v1 payload — schema-pin regression test", () => {
  const EXPECTED_PAYLOAD_KEYS = [
    "artifacts_path",
    "completed_at",
    "created_at",
    "elapsed_ms",
    "error",
    "exit_code",
    "final_answer_path",
    "id",
    "lane",
    "mode",
    "model",
    "output_file",
    "schema_version",
    "started_at",
    "status",
    "terminal",
    "updated_at",
    "usage",
  ].sort();

  test("top-level payload key set matches the pinned contract exactly", () => {
    const payload = buildSessionJsonPayload(meta({ status: "completed" }), PATHS);
    expect(Object.keys(payload).sort()).toEqual(EXPECTED_PAYLOAD_KEYS);
  });

  test("schema_version literal is stable", () => {
    expect(ORACLE_SESSION_SCHEMA_VERSION).toBe("oracle_session.v1");
  });
});

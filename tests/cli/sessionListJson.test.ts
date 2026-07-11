import { beforeEach, describe, expect, test, vi } from "vitest";
import type { SessionMetadata } from "../../src/sessionManager.ts";

const sessionStoreMock = vi.hoisted(() => ({
  listSessions: vi.fn(),
  filterSessions: vi.fn(),
  sessionsDir: vi.fn().mockReturnValue("/tmp/.oracle/sessions"),
}));

vi.mock("../../src/sessionStore.ts", () => ({
  sessionStore: sessionStoreMock,
}));

import {
  ORACLE_SESSION_LIST_SCHEMA_VERSION,
  SESSION_STATUS_VALUES,
  buildSessionListEntry,
  buildSessionListEnvelope,
  buildSessionListPayload,
  runSessionListJson,
} from "../../src/cli/sessionListJson.ts";
import {
  JSON_ENVELOPE_SCHEMA_VERSION,
  V18_BUNDLE_VERSION,
  jsonEnvelopeSchema,
} from "../../src/oracle/v18/index.ts";

function meta(overrides: Partial<SessionMetadata> = {}): SessionMetadata {
  return {
    id: "abc123",
    createdAt: "2026-07-01T00:00:00.000Z",
    status: "completed",
    options: {} as SessionMetadata["options"],
    ...overrides,
  } as SessionMetadata;
}

beforeEach(() => {
  sessionStoreMock.listSessions.mockReset();
  sessionStoreMock.filterSessions.mockReset();
  sessionStoreMock.sessionsDir.mockReturnValue("/tmp/.oracle/sessions");
});

describe("buildSessionListEntry", () => {
  test("maps metadata to the pinned oracle_session_list.v1 entry shape", () => {
    const entry = buildSessionListEntry(
      meta({
        id: "sess-1",
        lane: "fable-local",
        model: "claude-opus-4",
        status: "completed",
        createdAt: "2026-07-01T00:00:00.000Z",
        startedAt: "2026-07-01T00:00:01.000Z",
        completedAt: "2026-07-01T00:05:00.000Z",
      }),
    );
    expect(entry).toEqual({
      id: "sess-1",
      lane: "fable-local",
      model: "claude-opus-4",
      status: "completed",
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-01T00:05:00.000Z",
      artifactsPath: "/tmp/.oracle/sessions/sess-1",
    });
  });

  test("falls back updatedAt to startedAt, then createdAt, when completedAt is absent", () => {
    const running = buildSessionListEntry(
      meta({
        id: "sess-2",
        createdAt: "2026-07-01T00:00:00.000Z",
        startedAt: "2026-07-01T00:00:01.000Z",
      }),
    );
    expect(running.updatedAt).toBe("2026-07-01T00:00:01.000Z");

    const pending = buildSessionListEntry(
      meta({ id: "sess-3", createdAt: "2026-07-01T00:00:00.000Z" }),
    );
    expect(pending.updatedAt).toBe("2026-07-01T00:00:00.000Z");
  });

  test("lane and model default to null, never undefined (stable JSON shape)", () => {
    const entry = buildSessionListEntry(meta({ id: "sess-4", lane: undefined, model: undefined }));
    expect(entry.lane).toBeNull();
    expect(entry.model).toBeNull();
    expect(JSON.parse(JSON.stringify(entry))).toEqual(entry);
  });
});

describe("buildSessionListPayload", () => {
  test("applies hours/limit/includeAll filters via sessionStore.filterSessions", async () => {
    const metas = [meta({ id: "a" }), meta({ id: "b" })];
    sessionStoreMock.listSessions.mockResolvedValue(metas);
    sessionStoreMock.filterSessions.mockReturnValue({ entries: metas, truncated: false, total: 2 });

    const payload = await buildSessionListPayload({
      hours: 6,
      includeAll: false,
      limit: 10,
      now: new Date("2026-07-02T00:00:00.000Z"),
    });

    expect(sessionStoreMock.filterSessions).toHaveBeenCalledWith(metas, {
      hours: 6,
      includeAll: false,
      limit: 10,
    });
    expect(payload).toEqual({
      schema_version: ORACLE_SESSION_LIST_SCHEMA_VERSION,
      generated_at: "2026-07-02T00:00:00.000Z",
      count: 2,
      sessions: [buildSessionListEntry(metas[0]), buildSessionListEntry(metas[1])],
    });
  });

  test("applies the model filter across both `model` and `models[].model`", async () => {
    const metas = [
      meta({ id: "a", model: "claude-opus-4" }),
      meta({ id: "b", model: "gpt-5" }),
      meta({
        id: "c",
        model: undefined,
        models: [{ model: "claude-opus-4", status: "completed" }],
      }),
    ];
    sessionStoreMock.listSessions.mockResolvedValue(metas);
    sessionStoreMock.filterSessions.mockReturnValue({ entries: metas, truncated: false, total: 3 });

    const payload = await buildSessionListPayload({ modelFilter: "opus" });

    expect(payload.sessions.map((s) => s.id)).toEqual(["a", "c"]);
    expect(payload.count).toBe(2);
  });

  test("returns an empty sessions array (not an error) when nothing matches", async () => {
    sessionStoreMock.listSessions.mockResolvedValue([]);
    sessionStoreMock.filterSessions.mockReturnValue({ entries: [], truncated: false, total: 0 });

    const payload = await buildSessionListPayload({});
    expect(payload.sessions).toEqual([]);
    expect(payload.count).toBe(0);
  });
});

describe("buildSessionListEnvelope — json_envelope.v1 conformance", () => {
  beforeEach(() => {
    const metas = [meta({ id: "a" })];
    sessionStoreMock.listSessions.mockResolvedValue(metas);
    sessionStoreMock.filterSessions.mockReturnValue({ entries: metas, truncated: false, total: 1 });
  });

  test("envelope passes the v18 jsonEnvelopeSchema", async () => {
    const { envelope } = await buildSessionListEnvelope();
    expect(() => jsonEnvelopeSchema.parse(envelope)).not.toThrow();
    expect(envelope.schema_version).toBe(JSON_ENVELOPE_SCHEMA_VERSION);
    expect(envelope.ok).toBe(true);
    expect(envelope.meta.bundle_version).toBe(V18_BUNDLE_VERSION);
    expect(envelope.meta.schema_version).toBe(ORACLE_SESSION_LIST_SCHEMA_VERSION);
  });

  test("envelope's data is the session-list payload, intact", async () => {
    const { envelope, payload } = await buildSessionListEnvelope();
    expect(envelope.data).toEqual(payload);
  });

  test("commands map advertises both JSON entry points", async () => {
    const { envelope } = await buildSessionListEnvelope();
    const commands = envelope.commands as Record<string, unknown>;
    expect(commands.status_json).toBe("oracle status --json");
    expect(commands.session_json).toBe("oracle session --json");
  });
});

describe("runSessionListJson — CLI surface behavior", () => {
  beforeEach(() => {
    const metas = [meta({ id: "a" })];
    sessionStoreMock.listSessions.mockResolvedValue(metas);
    sessionStoreMock.filterSessions.mockReturnValue({ entries: metas, truncated: false, total: 1 });
  });

  test("writes a single envelope to stdout", async () => {
    const chunks: string[] = [];
    await runSessionListJson({}, { stdout: (text) => chunks.push(text) });
    expect(chunks.length).toBe(1);
    const parsed = JSON.parse(chunks[0]);
    expect(parsed.schema_version).toBe(JSON_ENVELOPE_SCHEMA_VERSION);
    expect(parsed.ok).toBe(true);
    expect(parsed.data.schema_version).toBe(ORACLE_SESSION_LIST_SCHEMA_VERSION);
    expect(Array.isArray(parsed.data.sessions)).toBe(true);
  });
});

// ─── schema-pin regression test ────────────────────────────────────────────

describe("oracle_session_list.v1 payload — schema-pin regression test", () => {
  const EXPECTED_PAYLOAD_KEYS = ["count", "generated_at", "schema_version", "sessions"].sort();
  const EXPECTED_ENTRY_KEYS = [
    "artifactsPath",
    "createdAt",
    "id",
    "lane",
    "model",
    "status",
    "updatedAt",
  ].sort();

  test("top-level payload key set matches the pinned contract exactly", async () => {
    sessionStoreMock.listSessions.mockResolvedValue([meta({ id: "a" })]);
    sessionStoreMock.filterSessions.mockReturnValue({
      entries: [meta({ id: "a" })],
      truncated: false,
      total: 1,
    });
    const payload = await buildSessionListPayload({});
    expect(Object.keys(payload).sort()).toEqual(EXPECTED_PAYLOAD_KEYS);
  });

  test("session entry key set matches the pinned contract exactly", () => {
    const entry = buildSessionListEntry(meta({ id: "a" }));
    expect(Object.keys(entry).sort()).toEqual(EXPECTED_ENTRY_KEYS);
  });

  test("schema_version literal is stable", () => {
    expect(ORACLE_SESSION_LIST_SCHEMA_VERSION).toBe("oracle_session_list.v1");
  });

  test("status is the closed enum (machine-output#5), re-exported from the list surface", () => {
    expect([...SESSION_STATUS_VALUES]).toEqual([
      "pending",
      "running",
      "completed",
      "partial",
      "error",
      "cancelled",
    ]);
    // every entry status is a member of the advertised closed set
    const entry = buildSessionListEntry(meta({ id: "a", status: "cancelled" }));
    expect(SESSION_STATUS_VALUES).toContain(entry.status);
  });
});

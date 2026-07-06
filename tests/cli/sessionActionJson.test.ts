// Regression tests for the `oracle restart <id> --json` /
// `oracle follow-up <parent> --json` launch-receipt surface
// (`oracle_session_action.v1`). Before this surface existed, both
// lifecycle verbs printed only chalk-styled human text to stdout with no
// structured envelope, so an agent scripting a restart-then-poll loop had
// nothing to parse. Schema-pin pattern mirrors
// tests/cli/sessionListJson.test.ts.

import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { describe, expect, test } from "vitest";

import {
  ORACLE_SESSION_ACTION_SCHEMA_VERSION,
  buildSessionActionEnvelope,
  buildSessionActionPayload,
  renderSessionActionEnvelope,
  type BuildSessionActionInput,
} from "../../src/cli/sessionActionJson.ts";
import {
  JSON_ENVELOPE_SCHEMA_VERSION,
  V18_BUNDLE_VERSION,
  jsonEnvelopeSchema,
} from "../../src/oracle/v18/index.ts";

const execFileAsync = promisify(execFile);
const CLI_ENTRYPOINT = path.join(process.cwd(), "bin", "oracle-cli.ts");

function input(overrides: Partial<BuildSessionActionInput> = {}): BuildSessionActionInput {
  return {
    action: "restart",
    sessionId: "new-sess-1",
    parentSessionId: "old-sess-1",
    engine: "browser",
    mode: "browser",
    lane: "chatgpt-pro",
    model: "gpt-5-pro",
    status: "running",
    waitPreference: false,
    detached: true,
    reattachCommand: "oracle session new-sess-1",
    conversationUrl: null,
    ...overrides,
  };
}

describe("buildSessionActionPayload — oracle_session_action.v1 schema pin", () => {
  test("top-level key set matches the pinned contract exactly", () => {
    const payload = buildSessionActionPayload(input());
    expect(Object.keys(payload).sort()).toEqual(
      [
        "schema_version",
        "action",
        "session_id",
        "parent_session_id",
        "engine",
        "mode",
        "lane",
        "model",
        "status",
        "wait_preference",
        "detached",
        "reattach_command",
        "conversation_url",
      ].sort(),
    );
    expect(payload.schema_version).toBe(ORACLE_SESSION_ACTION_SCHEMA_VERSION);
  });

  test("maps launch facts through 1:1 and nulls the optional fields", () => {
    const payload = buildSessionActionPayload(
      input({ action: "follow-up", lane: undefined, model: undefined, conversationUrl: undefined }),
    );
    expect(payload).toMatchObject({
      action: "follow-up",
      session_id: "new-sess-1",
      parent_session_id: "old-sess-1",
      engine: "browser",
      mode: "browser",
      lane: null,
      model: null,
      status: "running",
      wait_preference: false,
      detached: true,
      reattach_command: "oracle session new-sess-1",
      conversation_url: null,
    });
  });
});

describe("buildSessionActionEnvelope — json_envelope.v1 conformance", () => {
  test("envelope passes the v18 jsonEnvelopeSchema and pins bundle metadata", () => {
    const { envelope, payload } = buildSessionActionEnvelope(input());
    expect(() => jsonEnvelopeSchema.parse(envelope)).not.toThrow();
    expect(envelope.schema_version).toBe(JSON_ENVELOPE_SCHEMA_VERSION);
    expect(envelope.ok).toBe(true);
    expect(envelope.data).toEqual(payload);
    expect(envelope.meta.bundle_version).toBe(V18_BUNDLE_VERSION);
    expect(envelope.meta.schema_version).toBe(ORACLE_SESSION_ACTION_SCHEMA_VERSION);
  });

  test("retry_safe is false: re-running the action starts another paid session", () => {
    const { envelope } = buildSessionActionEnvelope(input());
    expect(envelope.retry_safe).toBe(false);
  });

  test("commands map teaches the poll loop (reattach + artifacts + list)", () => {
    const { envelope } = buildSessionActionEnvelope(input());
    expect(envelope.commands).toEqual({
      reattach: "oracle session new-sess-1",
      artifacts_json: "oracle session new-sess-1 --artifacts --json",
      list_json: "oracle status --json",
    });
    expect(envelope.next_command).toBe("oracle session new-sess-1");
  });

  test("renderSessionActionEnvelope emits exactly one parseable object with trailing newline", () => {
    const { envelope } = buildSessionActionEnvelope(input());
    const text = renderSessionActionEnvelope(envelope);
    expect(text.endsWith("\n")).toBe(true);
    expect(JSON.parse(text)).toEqual(JSON.parse(JSON.stringify(envelope)));
  });

  test("deterministic: identical input builds byte-identical output", () => {
    const a = renderSessionActionEnvelope(buildSessionActionEnvelope(input()).envelope);
    const b = renderSessionActionEnvelope(buildSessionActionEnvelope(input()).envelope);
    expect(a).toBe(b);
  });
});

describe("oracle restart/follow-up --json — CLI wiring", () => {
  test("restart --help advertises the --json launch-receipt flag", async () => {
    const { stdout } = await execFileAsync(
      process.execPath,
      ["--import", "tsx", CLI_ENTRYPOINT, "restart", "--help"],
      { timeout: 60_000, env: { ...process.env, NO_COLOR: "1" } },
    );
    expect(stdout).toContain("--json");
    expect(stdout).toContain("oracle_session_action.v1");
  }, 60_000);

  test("restart <bogus-id> --json puts one machine-readable error envelope on stdout", async () => {
    let stdout = "";
    let stderr = "";
    try {
      const result = await execFileAsync(
        process.execPath,
        ["--import", "tsx", CLI_ENTRYPOINT, "restart", "not-a-real-session-id", "--json"],
        { timeout: 60_000, env: { ...process.env, NO_COLOR: "1" } },
      );
      stdout = result.stdout;
      stderr = result.stderr;
      expect.unreachable("restart of a bogus session id must exit non-zero");
    } catch (error) {
      const failure = error as { stdout?: string; stderr?: string };
      stdout = failure.stdout ?? "";
      stderr = failure.stderr ?? "";
    }
    const envelope = JSON.parse(stdout);
    expect(envelope.schema_version).toBe("json_envelope.v1");
    expect(envelope.ok).toBe(false);
    expect(envelope.meta.command).toBe("oracle restart");
    expect(envelope.errors[0].message).toContain("No session found with ID not-a-real-session-id");
    // Human diagnostics stay on stderr; stdout stays pure JSON.
    expect(stderr).toContain("No session found with ID not-a-real-session-id");
  }, 60_000);
});

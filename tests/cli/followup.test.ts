import { describe, expect, test, vi } from "vitest";
import type { SessionMetadata } from "../../src/sessionStore.js";
import {
  resolveBrowserFollowupReference,
  resolveBrowserResumeConversationUrl,
  resolveClaudeCodeFollowupReference,
  assertClaudeCodeFollowupProfileMatches,
  assertClaudeCodeFollowupProfileMatchesRun,
  assertFollowupLaneMatchesResolvedLane,
} from "../../src/cli/followup.js";

const baseMetadata: SessionMetadata = {
  id: "session-1",
  createdAt: "2026-01-01T00:00:00.000Z",
  status: "completed",
  options: {},
};

describe("browser follow-up resolution", () => {
  test("derives a resume URL from conversationId", () => {
    const metadata: SessionMetadata = {
      ...baseMetadata,
      mode: "browser",
      browser: {
        config: { url: "https://chatgpt.com/" },
        runtime: { conversationId: "abc-123" },
      },
    };

    expect(resolveBrowserResumeConversationUrl(metadata)).toBe("https://chatgpt.com/c/abc-123");
  });

  test("derives a resume URL from tabUrl", () => {
    const metadata: SessionMetadata = {
      ...baseMetadata,
      mode: "browser",
      browser: {
        runtime: { tabUrl: "https://chatgpt.com/c/live-thread" },
      },
    };

    expect(resolveBrowserResumeConversationUrl(metadata)).toBe("https://chatgpt.com/c/live-thread");
  });

  test("resolves stored browser sessions to a browser resume path", async () => {
    const metadata: SessionMetadata = {
      ...baseMetadata,
      id: "browser-slug",
      mode: "browser",
      model: "gpt-5.5-pro",
      browser: {
        config: {
          manualLogin: true,
          manualLoginProfileDir: "/tmp/oracle-profile",
          browserTabRef: "stale-tab",
          researchMode: "deep",
          archiveConversations: "auto",
        },
        runtime: { conversationId: "resume-me" },
      },
    };
    const store = { readSession: vi.fn(async () => metadata) };

    await expect(resolveBrowserFollowupReference("browser-slug", store)).resolves.toEqual({
      sessionId: "browser-slug",
      resumeConversationUrl: "https://chatgpt.com/c/resume-me",
      model: "gpt-5.5-pro",
      browserConfig: {
        manualLogin: true,
        manualLoginProfileDir: "/tmp/oracle-profile",
        browserTabRef: null,
        researchMode: "off",
        archiveConversations: "never",
        resumeConversationUrl: "https://chatgpt.com/c/resume-me",
      },
    });
  });

  test("leaves stored API sessions on the existing API follow-up path", async () => {
    const metadata: SessionMetadata = {
      ...baseMetadata,
      id: "api-slug",
      mode: "api",
      response: { id: "resp_parent" },
    };
    const store = { readSession: vi.fn(async () => metadata) };

    await expect(resolveBrowserFollowupReference("api-slug", store)).resolves.toBeNull();
  });

  test("surfaces the referenced session's recorded lane so callers can guard against a --lane mismatch", async () => {
    const metadata: SessionMetadata = {
      ...baseMetadata,
      id: "chatgpt-pro-parent",
      mode: "browser",
      model: "gpt-5.5-pro",
      lane: "chatgpt-pro",
      browser: {
        config: { url: "https://chatgpt.com/" },
        runtime: { conversationId: "resume-me" },
      },
    };
    const store = { readSession: vi.fn(async () => metadata) };

    const resolved = await resolveBrowserFollowupReference("chatgpt-pro-parent", store);
    expect(resolved?.lane).toBe("chatgpt-pro");
  });

  test("errors clearly when a browser session has no conversation URL", async () => {
    const metadata: SessionMetadata = {
      ...baseMetadata,
      id: "missing-url",
      mode: "browser",
      browser: { runtime: { chromePort: 9222 } },
    };
    const store = { readSession: vi.fn(async () => metadata) };

    await expect(resolveBrowserFollowupReference("missing-url", store)).rejects.toThrow(
      /does not contain a ChatGPT conversation URL.*oracle status/s,
    );
  });

  test("rejects a Gemini Deep Think session with a lane-correct teach message", async () => {
    const metadata: SessionMetadata = {
      ...baseMetadata,
      id: "gemini-run",
      mode: "browser",
      lane: "gemini-deep-think",
      options: { lane: "gemini-deep-think", model: "gemini-3.1-pro-deep-think" },
      browser: { runtime: { chromePort: 9222 } },
    };
    const store = { readSession: vi.fn(async () => metadata) };

    const rejection = expect(resolveBrowserFollowupReference("gemini-run", store)).rejects;
    await rejection.toThrow(
      /Session gemini-run is a Gemini Deep Think session; Oracle does not yet support resuming Gemini browser sessions via --followup \(only ChatGPT Pro and Fable sessions are resumable today\)\. Start a new run instead: oracle --lane gemini-deep-think --prompt/s,
    );
    await rejection.not.toThrow(/ChatGPT conversation URL/);
  });

  test("detects the Gemini lane from the stored model when lane is absent", async () => {
    const metadata: SessionMetadata = {
      ...baseMetadata,
      id: "gemini-model-only",
      mode: "browser",
      options: { model: "gemini-3.1-pro-deep-think" },
      browser: { runtime: { chromePort: 9222 } },
    };
    const store = { readSession: vi.fn(async () => metadata) };

    await expect(resolveBrowserFollowupReference("gemini-model-only", store)).rejects.toThrow(
      /Gemini Deep Think session/,
    );
  });

  test("prefers the harvested URL over a stale runtime tab URL", () => {
    const metadata: SessionMetadata = {
      ...baseMetadata,
      mode: "browser",
      browser: {
        harvest: { url: "https://chatgpt.com/c/harvested" },
        runtime: { tabUrl: "https://chatgpt.com/c/stale-runtime" },
      },
    };

    expect(resolveBrowserResumeConversationUrl(metadata)).toBe("https://chatgpt.com/c/harvested");
  });

  test("rejects an external resume URL stored in metadata", async () => {
    const metadata: SessionMetadata = {
      ...baseMetadata,
      id: "external-url",
      mode: "browser",
      browser: { runtime: { tabUrl: "https://evil.example.com/c/pwned" } },
    };

    expect(resolveBrowserResumeConversationUrl(metadata)).toBeNull();

    const store = { readSession: vi.fn(async () => metadata) };
    await expect(resolveBrowserFollowupReference("external-url", store)).rejects.toThrow(
      /does not contain a ChatGPT conversation URL/s,
    );
  });

  test("rejects a project-shell URL that has no conversation id", async () => {
    const metadata: SessionMetadata = {
      ...baseMetadata,
      id: "project-shell",
      mode: "browser",
      browser: {
        config: { url: "https://chatgpt.com/g/g-p-abc123/project" },
        runtime: { tabUrl: "https://chatgpt.com/g/g-p-abc123/project" },
      },
    };

    expect(resolveBrowserResumeConversationUrl(metadata)).toBeNull();

    const store = { readSession: vi.fn(async () => metadata) };
    await expect(resolveBrowserFollowupReference("project-shell", store)).rejects.toThrow(
      /does not contain a ChatGPT conversation URL/s,
    );
  });

  test("rejects a conversationId fallback when the base URL is not ChatGPT", () => {
    const metadata: SessionMetadata = {
      ...baseMetadata,
      mode: "browser",
      browser: {
        config: { url: "https://evil.example.com/" },
        runtime: { conversationId: "abc-123" },
      },
    };

    // conversationId would rebuild against the stored base; the gate must reject a non-ChatGPT host.
    expect(resolveBrowserResumeConversationUrl(metadata)).toBeNull();
  });

  test("rejects insecure or non-default-port conversation URLs", () => {
    for (const tabUrl of [
      "http://chatgpt.com/c/insecure",
      "https://chatgpt.com:444/c/wrong-port",
    ]) {
      const metadata: SessionMetadata = {
        ...baseMetadata,
        mode: "browser",
        browser: { runtime: { tabUrl } },
      };
      expect(resolveBrowserResumeConversationUrl(metadata)).toBeNull();
    }
  });
});

describe("Claude Code (Fable lane) follow-up resolution — claude-provider-map.md finding #2", () => {
  const claudeCodeMetadata = (
    overrides: Partial<NonNullable<SessionMetadata["claudeCode"]>> = {},
  ): SessionMetadata => ({
    ...baseMetadata,
    id: "fable-parent",
    mode: "claude-code",
    model: "fable",
    claudeCode: {
      schema_version: "claude_code_session.v1",
      access_path: "claude_code_subscription_cli",
      provider_family: "claude",
      model_usage_keys: [],
      model_verification_status: "requested_only",
      subscription_billing_uncertain: true,
      credit_billing_warning_emitted: false,
      read_only: {
        readOnly: true,
        permissionMode: "plan",
        toolMode: "none",
        allowedTools: [],
        blockedTools: ["*"],
        mcpToolsBlocked: true,
        slashCommandsDisabled: true,
        safeMode: true,
        chromeDisabled: true,
        sessionPersistenceDisabled: true,
      },
      transcript_fidelity: "visible_cli_stream",
      hidden_reasoning_captured: false,
      visible_thinking_captured: "unknown",
      claude_session_id: "5b1a2c3d-4e5f-6789-abcd-ef0123456789",
      ...overrides,
    },
  });

  test("resolves a resumable claude-code session to its stored --session-id and profile", async () => {
    const metadata = claudeCodeMetadata({ caam_profile: "beta" });
    const store = { readSession: vi.fn(async () => metadata) };

    await expect(resolveClaudeCodeFollowupReference("fable-parent", store)).resolves.toEqual({
      sessionId: "fable-parent",
      resumeSessionId: "5b1a2c3d-4e5f-6789-abcd-ef0123456789",
      caamProfile: "beta",
      model: "fable",
    });
  });

  test("resolves undefined caamProfile when the parent ran with no profile (direct claude)", async () => {
    const metadata = claudeCodeMetadata();
    const store = { readSession: vi.fn(async () => metadata) };

    const resolved = await resolveClaudeCodeFollowupReference("fable-parent", store);
    expect(resolved?.caamProfile).toBeUndefined();
  });

  test("surfaces the referenced session's recorded lane so callers can guard against a --lane mismatch", async () => {
    const metadata = { ...claudeCodeMetadata(), lane: "fable-local" };
    const store = { readSession: vi.fn(async () => metadata) };

    const resolved = await resolveClaudeCodeFollowupReference("fable-parent", store);
    expect(resolved?.lane).toBe("fable-local");
  });

  test("leaves stored browser/API sessions on their existing follow-up path (returns null)", async () => {
    const metadata: SessionMetadata = { ...baseMetadata, id: "api-slug", mode: "api" };
    const store = { readSession: vi.fn(async () => metadata) };

    await expect(resolveClaudeCodeFollowupReference("api-slug", store)).resolves.toBeNull();
  });

  test("returns null for a resp_-prefixed value or an unknown session id", async () => {
    const store = { readSession: vi.fn(async () => null) };
    await expect(resolveClaudeCodeFollowupReference("resp_abc123", store)).resolves.toBeNull();
    await expect(resolveClaudeCodeFollowupReference("no-such-session", store)).resolves.toBeNull();
  });

  test("errors clearly on a claude-code session that predates resume support (no stored session id)", async () => {
    const metadata = claudeCodeMetadata({ claude_session_id: undefined });
    const store = { readSession: vi.fn(async () => metadata) };

    await expect(resolveClaudeCodeFollowupReference("fable-parent", store)).rejects.toThrow(
      /no resumable session id recorded/,
    );
  });

  test("assertClaudeCodeFollowupProfileMatches: same profile (including both undefined) passes", () => {
    expect(() =>
      assertClaudeCodeFollowupProfileMatches({
        parentSessionId: "fable-parent",
        parentProfile: "beta",
        childProfile: "beta",
      }),
    ).not.toThrow();
    expect(() =>
      assertClaudeCodeFollowupProfileMatches({
        parentSessionId: "fable-parent",
        parentProfile: undefined,
        childProfile: undefined,
      }),
    ).not.toThrow();
  });

  test("assertClaudeCodeFollowupProfileMatches: resuming across a different caam profile is refused", () => {
    expect(() =>
      assertClaudeCodeFollowupProfileMatches({
        parentSessionId: "fable-parent",
        parentProfile: "beta",
        childProfile: "bob",
      }),
    ).toThrow(/SAME caam profile/);
  });

  test("assertClaudeCodeFollowupProfileMatches: refuses when parent had no profile but child requests one", () => {
    expect(() =>
      assertClaudeCodeFollowupProfileMatches({
        parentSessionId: "fable-parent",
        parentProfile: undefined,
        childProfile: "bob",
      }),
    ).toThrow(/SAME caam profile/);
  });

  test("assertClaudeCodeFollowupProfileMatches: refuses when parent had a profile but child requests none", () => {
    expect(() =>
      assertClaudeCodeFollowupProfileMatches({
        parentSessionId: "fable-parent",
        parentProfile: "beta",
        childProfile: undefined,
      }),
    ).toThrow(/SAME caam profile/);
  });

  test("assertClaudeCodeFollowupProfileMatchesRun: recognizes the config-key profile form (refuses a mismatch even when the env form matches the parent)", () => {
    // Regression: the CLI guard used to hardcode `undefined` for the
    // config-key argument, so a run whose runOptions.claudeCode.caamProfile
    // pointed at a DIFFERENT profile slipped past as long as the env var
    // matched the parent.
    expect(() =>
      assertClaudeCodeFollowupProfileMatchesRun({
        parentSessionId: "fable-parent",
        parentProfile: "beta",
        runOptions: { claudeCode: { caamProfile: "bob" } },
        env: { ORACLE_CLAUDE_CODE_CAAM_PROFILE: "beta" },
      }),
    ).toThrow(/SAME caam profile/);
  });

  test("assertClaudeCodeFollowupProfileMatchesRun: config-key form takes precedence over the env form (matching config key passes despite a mismatched env var)", () => {
    // Mirrors sessionRunner.ts exactly: resolveClaudeCodeCaamProfile prefers
    // the config-key form, so the run WILL use "beta" here — the guard
    // must agree and pass.
    expect(() =>
      assertClaudeCodeFollowupProfileMatchesRun({
        parentSessionId: "fable-parent",
        parentProfile: "beta",
        runOptions: { claudeCode: { caamProfile: "beta" } },
        env: { ORACLE_CLAUDE_CODE_CAAM_PROFILE: "bob" },
      }),
    ).not.toThrow();
  });

  test("assertClaudeCodeFollowupProfileMatchesRun: still recognizes the env form when no config key is set", () => {
    expect(() =>
      assertClaudeCodeFollowupProfileMatchesRun({
        parentSessionId: "fable-parent",
        parentProfile: "beta",
        runOptions: { claudeCode: undefined },
        env: { ORACLE_CLAUDE_CODE_CAAM_PROFILE: "beta" },
      }),
    ).not.toThrow();
    expect(() =>
      assertClaudeCodeFollowupProfileMatchesRun({
        parentSessionId: "fable-parent",
        parentProfile: "beta",
        runOptions: { claudeCode: undefined },
        env: { ORACLE_CLAUDE_CODE_CAAM_PROFILE: "bob" },
      }),
    ).toThrow(/SAME caam profile/);
  });

  test("assertClaudeCodeFollowupProfileMatchesRun: no profile in either form only matches a no-profile parent", () => {
    expect(() =>
      assertClaudeCodeFollowupProfileMatchesRun({
        parentSessionId: "fable-parent",
        parentProfile: undefined,
        runOptions: { claudeCode: undefined },
        env: {},
      }),
    ).not.toThrow();
    expect(() =>
      assertClaudeCodeFollowupProfileMatchesRun({
        parentSessionId: "fable-parent",
        parentProfile: "beta",
        runOptions: { claudeCode: undefined },
        env: {},
      }),
    ).toThrow(/SAME caam profile/);
  });
});

describe("assertFollowupLaneMatchesResolvedLane — followup must not silently override an already-validated --lane", () => {
  test("passes through when no --lane was requested (resolvedLane null)", () => {
    expect(() =>
      assertFollowupLaneMatchesResolvedLane({
        resolvedLane: null,
        followupSessionId: "some-session",
        followupLane: "chatgpt-pro",
        followupEngine: "browser",
      }),
    ).not.toThrow();
  });

  test("passes when the followup's engine and lane agree with the requested --lane", () => {
    expect(() =>
      assertFollowupLaneMatchesResolvedLane({
        resolvedLane: { lane: "fable-local", engine: "claude-code" },
        followupSessionId: "fable-parent",
        followupLane: "fable-local",
        followupEngine: "claude-code",
      }),
    ).not.toThrow();
  });

  test("passes when the followup session predates lane tracking (no lane recorded) but engine agrees", () => {
    expect(() =>
      assertFollowupLaneMatchesResolvedLane({
        resolvedLane: { lane: "chatgpt-pro", engine: "browser" },
        followupSessionId: "legacy-browser-session",
        followupLane: undefined,
        followupEngine: "browser",
      }),
    ).not.toThrow();
  });

  test("regression: --lane fable-local --followup <chatgpt-pro session> refuses instead of silently switching to engine=browser", () => {
    // Bug: resolveBrowserFollowupReference resolved successfully purely off
    // the referenced session's own metadata and the CLI then overwrote
    // engine="claude-code" (from --lane fable-local) with engine="browser",
    // discarding the validated Fable/read-only lane with no warning.
    expect(() =>
      assertFollowupLaneMatchesResolvedLane({
        resolvedLane: { lane: "fable-local", engine: "claude-code" },
        followupSessionId: "chatgpt-pro-parent",
        followupLane: "chatgpt-pro",
        followupEngine: "browser",
      }),
    ).toThrow(/--lane fable-local was requested and validated/);
  });

  test("regression: --lane chatgpt-pro --followup <fable session> refuses instead of silently switching to engine=claude-code", () => {
    expect(() =>
      assertFollowupLaneMatchesResolvedLane({
        resolvedLane: { lane: "chatgpt-pro", engine: "browser" },
        followupSessionId: "fable-parent",
        followupLane: "fable-local",
        followupEngine: "claude-code",
      }),
    ).toThrow(/--lane chatgpt-pro was requested and validated/);
  });

  test("error message names both the requested lane and the followup session's actual lane/engine", () => {
    expect(() =>
      assertFollowupLaneMatchesResolvedLane({
        resolvedLane: { lane: "fable-local", engine: "claude-code" },
        followupSessionId: "chatgpt-pro-parent",
        followupLane: "chatgpt-pro",
        followupEngine: "browser",
      }),
    ).toThrow(/chatgpt-pro-parent.*"chatgpt-pro".*engine=browser/s);
  });
});

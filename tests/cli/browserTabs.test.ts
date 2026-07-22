import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  deriveLiveTailStateForTest,
  persistHarvestForTest,
  resolveSessionTabRefForTest,
} from "../../src/cli/browserTabs.js";
import { sessionStore } from "../../src/sessionStore.js";
import type { SessionMetadata } from "../../src/sessionStore.js";
import type { ChatGptTabSummary } from "../../src/browser/liveTabs.js";
import { setOracleHomeDirOverrideForTest } from "../../src/oracleHome.js";

describe("browser tab CLI helpers", () => {
  test("prefers stable conversation URLs over stale Chrome target ids", () => {
    const meta = {
      id: "session-1",
      createdAt: "2026-05-05T00:00:00.000Z",
      status: "completed",
      options: {},
      mode: "browser",
      browser: {
        runtime: {
          chromeTargetId: "stale-target",
          tabUrl: "https://chatgpt.com/c/runtime-conversation",
          conversationId: "runtime-conversation",
        },
      },
    } as SessionMetadata;

    expect(resolveSessionTabRefForTest(meta)).toBe("https://chatgpt.com/c/runtime-conversation");
  });

  test("skips provisional WEB metadata and falls back to the exact target id", () => {
    const meta = {
      id: "session-1",
      createdAt: "2026-07-21T00:00:00.000Z",
      status: "running",
      options: {},
      mode: "browser",
      browser: {
        runtime: {
          chromeTargetId: "submitted-target",
          tabUrl: "https://chatgpt.com/c/WEB:fee7a622-991a-497a-bac4-a878b86f82f3",
          conversationId: "WEB",
        },
      },
    } as SessionMetadata;

    expect(resolveSessionTabRefForTest(meta)).toBe("submitted-target");
  });

  test("keeps Answer now / thinking tabs running even when the stop button is hidden", () => {
    const harvested = {
      targetId: "target-1",
      title: "ChatGPT",
      url: "https://chatgpt.com/c/fresh-conversation",
      currentModelLabel: "GPT-5.5 Pro",
      stopExists: false,
      sendExists: true,
      promptReady: true,
      loginButtonExists: false,
      authenticated: true,
      answerNowExists: true,
      thinkingActive: true,
      assistantCount: 1,
      lastAssistantText: "1) Verdict",
      lastAssistantSnippet: "1) Verdict",
      lastUserText: "question",
      lastUserSnippet: "question",
      focused: false,
      visibilityState: "hidden",
      conversationId: "fresh-conversation",
      fingerprint: "fp-1",
      state: "running",
      lastAssistantMarkdown: "1) Verdict",
    } satisfies ChatGptTabSummary;

    expect(deriveLiveTailStateForTest(harvested, 5_000, 60_000)).toBe("running");
    expect(deriveLiveTailStateForTest(harvested, 65_000, 60_000)).toBe("stalled");
  });
});

describe("persistHarvest under concurrent runner updates", () => {
  let oracleHomeDir: string;

  beforeAll(async () => {
    oracleHomeDir = await mkdtemp(path.join(os.tmpdir(), "oracle-browser-tabs-tests-"));
    setOracleHomeDirOverrideForTest(oracleHomeDir);
    await sessionStore.ensureStorage();
  });

  afterAll(async () => {
    await rm(oracleHomeDir, { recursive: true, force: true });
    setOracleHomeDirOverrideForTest(null);
  });

  test("a harvest built from a stale session snapshot does not revert fresher runner state", async () => {
    // Repro: `oracle session <id> --live` reads the session metadata ONCE
    // at tail start, while the session's runner process keeps updating the
    // same session (status transitions, browser.runtime, artifacts). The
    // harvest persistence must only ever own `browser.harvest` — it must
    // not resurrect the stale snapshot's other fields.
    const staleSnapshot = await sessionStore.createSession(
      { prompt: "Harvest race", model: "gpt-5.2-pro", mode: "browser" },
      "/tmp/cwd",
    );

    // The runner progresses AFTER the harvester captured its snapshot.
    await sessionStore.updateSession(staleSnapshot.id, {
      status: "completed",
      completedAt: "2026-07-05T02:00:00.000Z",
      artifacts: [{ kind: "transcript", path: "transcript.md" }],
      browser: {
        ...(staleSnapshot.browser ?? {}),
        runtime: {
          chromePid: 424242,
          tabUrl: "https://chatgpt.com/c/fresh-conversation",
          conversationId: "fresh-conversation",
        },
      },
    });

    const harvested: ChatGptTabSummary = {
      targetId: "target-1",
      title: "ChatGPT",
      url: "https://chatgpt.com/c/fresh-conversation",
      currentModelLabel: "GPT-5.2 Pro",
      stopExists: false,
      sendExists: true,
      promptReady: true,
      loginButtonExists: false,
      authenticated: true,
      assistantCount: 2,
      lastAssistantText: "final answer",
      lastAssistantSnippet: "final answer",
      lastUserText: "question",
      lastUserSnippet: "question",
      focused: false,
      visibilityState: "hidden",
      conversationId: "fresh-conversation",
      fingerprint: "fp-1",
      state: "completed",
      lastAssistantMarkdown: "final answer",
    };

    await persistHarvestForTest(staleSnapshot.id, staleSnapshot, harvested);

    const final = await sessionStore.readSession(staleSnapshot.id);
    // Runner-owned fields written after the stale snapshot must survive.
    expect(final?.status).toBe("completed");
    expect(final?.completedAt).toBe("2026-07-05T02:00:00.000Z");
    expect(final?.artifacts).toEqual([{ kind: "transcript", path: "transcript.md" }]);
    expect(final?.browser?.runtime?.chromePid).toBe(424242);
    expect(final?.browser?.runtime?.conversationId).toBe("fresh-conversation");
    // And the harvest itself must have been persisted.
    expect(final?.browser?.harvest?.targetId).toBe("target-1");
    expect(final?.browser?.harvest?.state).toBe("completed");
    expect(final?.browser?.harvest?.assistantCount).toBe(2);
  });
});

import { execFile } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { resolveRecoveryUrl } from "../../src/browser/recoverConversation.js";
import {
  acquireImportedConversationLock,
  hasImportedChatgptConversationClaim,
  hasImportedChatgptConversationMarker,
} from "../../src/browser/importedConversation.js";
import {
  harvestSessionBrowserOutput,
  liveTailSessionBrowserOutput,
} from "../../src/cli/browserTabs.js";
import {
  importChatgptConversation,
  validateChatgptConversationUrl,
} from "../../src/cli/importChatgptConversation.js";
import {
  assertImportedBrowserFollowupCompatibility,
  buildImportedBrowserFollowupConfig,
  resolveBrowserFollowupReference,
} from "../../src/cli/followup.js";
import { setOracleHomeDirOverrideForTest } from "../../src/oracleHome.js";
import type { SessionMetadata } from "../../src/sessionStore.js";
import { sessionStore } from "../../src/sessionStore.js";

const execFileAsync = promisify(execFile);

let oracleHomeDir: string;

beforeEach(async () => {
  oracleHomeDir = await mkdtemp(path.join(os.tmpdir(), "oracle-import-chatgpt-tests-"));
  setOracleHomeDirOverrideForTest(oracleHomeDir);
  await sessionStore.ensureStorage();
});

afterEach(async () => {
  setOracleHomeDirOverrideForTest(null);
  await rm(oracleHomeDir, { recursive: true, force: true });
});

describe("ChatGPT conversation import", () => {
  test("validates and canonicalizes recoverable ChatGPT conversation URLs", () => {
    expect(
      validateChatgptConversationUrl("  https://chatgpt.com/c/import-test?utm=x#fragment  "),
    ).toEqual({
      conversationUrl: "https://chatgpt.com/c/import-test",
      conversationId: "import-test",
    });
    expect(validateChatgptConversationUrl("https://chat.openai.com/c/legacy-test")).toEqual({
      conversationUrl: "https://chat.openai.com/c/legacy-test",
      conversationId: "legacy-test",
    });
  });

  test.each([
    "https://evil.example.com/c/import-test",
    "http://chatgpt.com/c/import-test",
    "https://chatgpt.com:444/c/import-test",
    "https://chatgpt.com/",
    "https://chatgpt.com/g/g-p-demo/project",
    "https://chatgpt.com/c/WEB:temporary",
    "https://user:secret@chatgpt.com/c/import-test",
  ])("rejects unsafe or non-conversation URL %s", (url) => {
    expect(() => validateChatgptConversationUrl(url)).toThrow(/requires an HTTPS conversation URL/);
  });

  test("stores an explicitly untrusted, answer-free, lane/account-unbound reference", async () => {
    const metadata = await importChatgptConversation({
      url: "https://chatgpt.com/c/import-test",
      slug: "manual import test",
      cwd: "/tmp/oracle-import-test",
    });

    expect(metadata).toMatchObject({
      id: "manual-import-test",
      status: "imported",
      mode: "browser",
      models: [],
      options: {
        file: [],
        models: [],
        mode: "browser",
        browserConfig: {
          modelStrategy: "current",
          desiredModel: null,
          archiveConversations: "never",
          researchMode: "off",
        },
      },
      browser: {
        runtime: {
          tabUrl: "https://chatgpt.com/c/import-test",
          conversationId: "import-test",
        },
        importedConversation: {
          schema: "chatgpt-conversation-import.v1",
          imported: true,
          source: "manual-url",
          trust: "untrusted",
          accountBinding: "unbound",
          laneBinding: "unbound",
          answerCaptured: false,
        },
      },
    });
    expect(metadata.model).toBeUndefined();
    expect(metadata.completedAt).toBeUndefined();
    expect(metadata.lane).toBeUndefined();
    expect(metadata.evidence).toBeUndefined();
    expect(metadata.response).toBeUndefined();
    expect(metadata.usage).toBeUndefined();
    expect(metadata.browser?.harvest).toBeUndefined();
    expect(metadata.browser?.modelSelection).toBeUndefined();
    expect(metadata.browser?.remoteRun).toBeUndefined();
    expect(metadata.browser?.remoteRecovery).toBeUndefined();
    expect(metadata.options.prompt).toBeUndefined();

    const files = await readdir(path.join(sessionStore.sessionsDir(), metadata.id));
    expect(files).toEqual(["meta.json"]);
    await expect(
      access(path.join(sessionStore.sessionsDir(), metadata.id, "output.log")),
    ).rejects.toBeDefined();
    await expect(
      access(path.join(sessionStore.sessionsDir(), metadata.id, "models")),
    ).rejects.toBeDefined();
    expect(resolveRecoveryUrl(metadata)).toBeNull();
    await expect(harvestSessionBrowserOutput(metadata.id)).rejects.toThrow(
      /untrusted manual conversation import.*Refusing --harvest/,
    );
  });

  test("resolves only as an untrusted current-model compatibility parent", async () => {
    const metadata = await importChatgptConversation({
      url: "https://chatgpt.com/c/followup-test",
      slug: "manual followup test",
    });
    const resolution = await resolveBrowserFollowupReference(metadata.id, sessionStore);

    expect(resolution).toMatchObject({
      sessionId: "manual-followup-test",
      resumeConversationUrl: "https://chatgpt.com/c/followup-test",
      importedUntrusted: true,
      browserConfig: {
        modelStrategy: "current",
        desiredModel: null,
        resumeConversationUrl: "https://chatgpt.com/c/followup-test",
        archiveConversations: "never",
        researchMode: "off",
      },
    });
    expect(resolution?.lane).toBeUndefined();
    expect(resolution?.browserConfig.thinkingTime).toBeUndefined();
  });

  test("fails closed if an import is mixed with reviewed or captured state", async () => {
    const metadata = await importChatgptConversation({
      url: "https://chatgpt.com/c/tamper-test",
      slug: "manual tamper test",
    });
    const tampered: SessionMetadata = {
      ...metadata,
      lane: "chatgpt-pro",
      browser: {
        ...metadata.browser,
        modelSelection: {
          status: "already-selected",
          verified: true,
          modelVerified: true,
          modeVerified: true,
          verifiedBeforePromptSubmit: true,
          source: "chatgpt-model-picker",
          capturedAt: new Date().toISOString(),
        },
      },
    };

    await expect(
      resolveBrowserFollowupReference(metadata.id, {
        readSession: async () => tampered,
      }),
    ).rejects.toThrow(/mixes an untrusted import with model, lane, account, capture/);
  });

  test("requires an explicit local compatibility route and refuses reviewed/account-affine routes", async () => {
    const metadata = await importChatgptConversation({
      url: "https://chatgpt.com/c/route-test",
      slug: "manual route test",
    });
    const followup = await resolveBrowserFollowupReference(metadata.id, sessionStore);
    expect(followup).not.toBeNull();
    const resolution = followup!;

    expect(() =>
      assertImportedBrowserFollowupCompatibility({
        followup: resolution,
        explicitBrowserEngine: false,
        explicitRemoteBrowserOff: false,
        resolvedLane: null,
      }),
    ).toThrow(/requires an explicit compatibility route/);
    expect(() =>
      assertImportedBrowserFollowupCompatibility({
        followup: resolution,
        explicitBrowserEngine: true,
        explicitRemoteBrowserOff: true,
        resolvedLane: { lane: "chatgpt-pro", engine: "browser" },
      }),
    ).toThrow(/never eligible for reviewed --lane chatgpt-pro/);
    expect(() =>
      assertImportedBrowserFollowupCompatibility({
        followup: resolution,
        explicitBrowserEngine: true,
        explicitRemoteBrowserOff: true,
        resolvedLane: null,
        remoteHost: "router.example:9473",
      }),
    ).toThrow(/account-unbound.*routing is refused/);
    expect(() =>
      assertImportedBrowserFollowupCompatibility({
        followup: resolution,
        explicitBrowserEngine: true,
        explicitRemoteBrowserOff: true,
        resolvedLane: null,
        explicitModel: "gpt-5.6-sol",
      }),
    ).toThrow(/no trusted model binding/);
    expect(() =>
      assertImportedBrowserFollowupCompatibility({
        followup: resolution,
        explicitBrowserEngine: true,
        explicitRemoteBrowserOff: true,
        resolvedLane: null,
        explicitModelStrategy: "current",
        explicitThinkingTime: "extended",
      }),
    ).toThrow(/no trusted mode binding/);
    expect(() =>
      assertImportedBrowserFollowupCompatibility({
        followup: resolution,
        explicitBrowserEngine: true,
        explicitRemoteBrowserOff: false,
        resolvedLane: null,
        explicitModelStrategy: "current",
      }),
    ).toThrow(/requires an explicit local route.*--remote-browser off/);
    expect(() =>
      assertImportedBrowserFollowupCompatibility({
        followup: resolution,
        explicitBrowserEngine: true,
        explicitRemoteBrowserOff: true,
        resolvedLane: null,
      }),
    ).toThrow(/requires the explicit --browser-model-strategy current/);
    expect(() =>
      assertImportedBrowserFollowupCompatibility({
        followup: resolution,
        explicitBrowserEngine: true,
        explicitRemoteBrowserOff: true,
        resolvedLane: null,
        explicitModelStrategy: "select",
      }),
    ).toThrow(/requires .*--browser-model-strategy current/);
    expect(() =>
      assertImportedBrowserFollowupCompatibility({
        followup: resolution,
        explicitBrowserEngine: true,
        explicitRemoteBrowserOff: true,
        resolvedLane: null,
        explicitModelStrategy: "current",
      }),
    ).not.toThrow();
  });

  test("sanitizes compatibility config so it cannot assert Sol+Pro selection proof", () => {
    const config = buildImportedBrowserFollowupConfig(
      {
        modelStrategy: "select",
        desiredModel: "GPT-5.6 Sol",
        thinkingTime: "extended",
        browserTabRef: "current",
        remoteChrome: { host: "router", port: 9222 },
        remoteChromeBrowserWSEndpoint: "ws://router/devtools/browser/secret",
        remoteChromeProfileRoot: "/remote/profile",
        manualLogin: true,
        manualLoginProfileDir: "/local/profile",
      },
      "https://chatgpt.com/c/safe-followup",
    );

    expect(config).toMatchObject({
      modelStrategy: "current",
      desiredModel: null,
      browserTabRef: null,
      remoteChrome: null,
      remoteChromeBrowserWSEndpoint: null,
      remoteChromeProfileRoot: null,
      resumeConversationUrl: "https://chatgpt.com/c/safe-followup",
      archiveConversations: "never",
      researchMode: "off",
    });
    expect(config.thinkingTime).toBeUndefined();
    expect(config.manualLoginProfileDir).toBe("/local/profile");
  });

  test("same-slug creation is atomic under a race", async () => {
    const results = await Promise.allSettled([
      importChatgptConversation({
        url: "https://chatgpt.com/c/race-one",
        slug: "manual race test",
      }),
      importChatgptConversation({
        url: "https://chatgpt.com/c/race-two",
        slug: "manual race test",
      }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const stored = await sessionStore.readSession("manual-race-test");
    expect(["race-one", "race-two"]).toContain(
      stored?.browser?.importedConversation?.conversationId,
    );
    expect(stored?.browser?.importedConversation?.answerCaptured).toBe(false);
  });

  test("publishes complete lock ownership atomically when a claimant pauses before publication", async () => {
    let firstReachedPublication!: () => void;
    const firstAtPublication = new Promise<void>((resolve) => {
      firstReachedPublication = resolve;
    });
    let resumeFirstPublication!: () => void;
    const firstMayPublish = new Promise<void>((resolve) => {
      resumeFirstPublication = resolve;
    });
    let firstReachedContention!: () => void;
    const firstIsContending = new Promise<void>((resolve) => {
      firstReachedContention = resolve;
    });
    let resumeFirstRetry!: () => void;
    const firstMayRetry = new Promise<void>((resolve) => {
      resumeFirstRetry = resolve;
    });

    const firstLockPromise = acquireImportedConversationLock(
      sessionStore.sessionsDir(),
      "manual-paused-lock-test",
      {
        token: "11111111-1111-4111-8111-111111111111",
        waitMs: 2_000,
        hooks: {
          beforePublish: async () => {
            firstReachedPublication();
            await firstMayPublish;
          },
        },
        sleep: async () => {
          firstReachedContention();
          await firstMayRetry;
        },
      },
    );
    await firstAtPublication;

    // The first claimant has a complete private owner record but has not
    // published it. A second process-equivalent claimant can atomically win;
    // the paused claimant must not overwrite or co-own that canonical lock.
    const secondLock = await acquireImportedConversationLock(
      sessionStore.sessionsDir(),
      "manual-paused-lock-test",
      {
        token: "22222222-2222-4222-8222-222222222222",
        waitMs: 2_000,
      },
    );
    resumeFirstPublication();
    await firstIsContending;

    let firstAcquired = false;
    void firstLockPromise.then(() => {
      firstAcquired = true;
    });
    await Promise.resolve();
    expect(firstAcquired).toBe(false);

    await secondLock.release();
    resumeFirstRetry();
    const firstLock = await firstLockPromise;
    expect(firstLock.token).toBe("11111111-1111-4111-8111-111111111111");
    await firstLock.release();
  });

  test("pins the lock-directory inode and refuses a parent namespace swap before publication", async () => {
    const sessionId = "manual-lock-directory-swap";
    let reachedPublication!: () => void;
    const atPublication = new Promise<void>((resolve) => {
      reachedPublication = resolve;
    });
    let resumePublication!: () => void;
    const mayPublish = new Promise<void>((resolve) => {
      resumePublication = resolve;
    });
    const acquiring = acquireImportedConversationLock(sessionStore.sessionsDir(), sessionId, {
      token: "88888888-8888-4888-8888-888888888888",
      waitMs: 2_000,
      hooks: {
        beforePublish: async () => {
          reachedPublication();
          await mayPublish;
        },
      },
    });
    await atPublication;

    const lockDirectory = path.join(
      path.dirname(sessionStore.sessionsDir()),
      "locks",
      "chatgpt-import",
    );
    const movedLockDirectory = `${lockDirectory}-moved`;
    const external = await mkdtemp(path.join(os.tmpdir(), "oracle-import-lock-swap-"));
    try {
      await rename(lockDirectory, movedLockDirectory);
      await symlink(external, lockDirectory, process.platform === "win32" ? "junction" : "dir");
      resumePublication();
      await expect(acquiring).rejects.toThrow(/lock directory identity changed|not a concrete/iu);
      expect(await readdir(external)).toEqual([]);
      expect(await readdir(movedLockDirectory)).toEqual([]);
    } finally {
      await rm(external, { recursive: true, force: true });
    }
  });

  test("release never follows a replacement lock-directory pathname", async () => {
    const sessionId = "manual-lock-release-swap";
    const lock = await acquireImportedConversationLock(sessionStore.sessionsDir(), sessionId, {
      token: "99999999-9999-4999-8999-999999999999",
    });
    const lockDirectory = path.join(
      path.dirname(sessionStore.sessionsDir()),
      "locks",
      "chatgpt-import",
    );
    const movedLockDirectory = `${lockDirectory}-moved`;
    await rename(lockDirectory, movedLockDirectory);
    await mkdir(lockDirectory);
    const replacementLock = path.join(lockDirectory, `${sessionId}.lock`);
    await writeFile(replacementLock, "replacement lock must remain untouched", "utf8");

    await expect(lock.release()).rejects.toThrow(/lock directory identity changed/iu);
    expect(await readFile(replacementLock, "utf8")).toBe("replacement lock must remain untouched");
    expect(await readdir(movedLockDirectory)).toContain(`${sessionId}.lock`);
  });

  test("never proceeds unlocked when the canonical owner record is unreadable", async () => {
    const sessionId = "manual-unreadable-lock-test";
    const lockDirectory = path.join(
      path.dirname(sessionStore.sessionsDir()),
      "locks",
      "chatgpt-import",
    );
    await mkdir(lockDirectory, { recursive: true });
    await writeFile(path.join(lockDirectory, `${sessionId}.lock`), "", "utf8");

    await expect(
      acquireImportedConversationLock(sessionStore.sessionsDir(), sessionId, {
        token: "33333333-3333-4333-8333-333333333333",
        waitMs: 0,
      }),
    ).rejects.toThrow(/mandatory ChatGPT import lock.*unreadable owner.*no metadata was changed/iu);
  });

  test("reclaims a provably dead owner with a permanent token-specific ABA fence", async () => {
    const sessionId = "manual-dead-owner-lock-test";
    const deadOwner = await acquireImportedConversationLock(sessionStore.sessionsDir(), sessionId, {
      token: "44444444-4444-4444-8444-444444444444",
      pid: 900_001,
      processStartTicks: null,
      isProcessAlive: () => true,
    });
    expect(deadOwner.token).toBe("44444444-4444-4444-8444-444444444444");

    let activeOwners = 0;
    let maximumActiveOwners = 0;
    await Promise.all(
      Array.from({ length: 10 }, async (_, index) => {
        const token = `55555555-5555-4555-8555-${`${index + 1}`.padStart(12, "0")}`;
        const successor = await acquireImportedConversationLock(
          sessionStore.sessionsDir(),
          sessionId,
          {
            token,
            waitMs: 2_000,
            isProcessAlive: (pid) => pid !== 900_001,
            readProcessStartTicks: () => null,
          },
        );
        activeOwners += 1;
        maximumActiveOwners = Math.max(maximumActiveOwners, activeOwners);
        await new Promise<void>((resolve) => setTimeout(resolve, 2));
        activeOwners -= 1;
        await successor.release();
      }),
    );
    expect(maximumActiveOwners).toBe(1);
    const lockEntries = await readdir(
      path.join(path.dirname(sessionStore.sessionsDir()), "locks", "chatgpt-import"),
    );
    expect(lockEntries).toContain(
      `${sessionId}.reclaimed-44444444-4444-4444-8444-444444444444.lock`,
    );
    await deadOwner.release().catch(() => undefined);
  });

  test("reclaims an owner-token lock left by a terminated process", async () => {
    const sessionId = "manual-terminated-owner-test";
    const childToken = "66666666-6666-4666-8666-666666666666";
    const script = `
      import { acquireImportedConversationLock } from "./src/browser/importedConversation.ts";
      await acquireImportedConversationLock(${JSON.stringify(sessionStore.sessionsDir())}, ${JSON.stringify(sessionId)}, {
        token: ${JSON.stringify(childToken)},
      });
    `;
    await execFileAsync(
      process.execPath,
      ["--no-deprecation", "--import", "tsx", "--input-type=module", "--eval", script],
      { cwd: path.resolve("."), timeout: 10_000 },
    );

    const successor = await acquireImportedConversationLock(sessionStore.sessionsDir(), sessionId, {
      token: "77777777-7777-4777-8777-777777777777",
      waitMs: 2_000,
    });
    const lockEntries = await readdir(
      path.join(path.dirname(sessionStore.sessionsDir()), "locks", "chatgpt-import"),
    );
    expect(lockEntries).toContain(`${sessionId}.reclaimed-${childToken}.lock`);
    await successor.release();
  });

  test("force replacement is atomic and cannot overwrite a real Oracle run with an injected valid marker", async () => {
    const first = await importChatgptConversation({
      url: "https://chatgpt.com/c/force-one",
      slug: "manual force test",
    });
    const replaced = await importChatgptConversation({
      url: "https://chatgpt.com/c/force-two",
      slug: "manual force test",
      force: true,
    });
    expect(replaced.id).toBe(first.id);
    expect(replaced.createdAt).toBe(first.createdAt);
    expect(replaced.browser?.importedConversation?.conversationId).toBe("force-two");

    const real = await sessionStore.createSession(
      {
        prompt: "real session prompt",
        model: "gpt-5.2-pro",
        slug: "protected real session",
      },
      "/tmp/real-session",
    );
    await sessionStore.updateSession(real.id, {
      // Copy a completely valid import browser subtree onto a real run. The
      // marker alone must not make captured/model-bearing metadata replaceable.
      browser: replaced.browser,
    });
    const realMetaPath = path.join(sessionStore.sessionsDir(), real.id, "meta.json");
    const before = await readFile(realMetaPath, "utf8");
    await expect(
      importChatgptConversation({
        url: "https://chatgpt.com/c/should-not-land",
        slug: "protected real session",
        force: true,
      }),
    ).rejects.toThrow(
      /not a pure imported conversation reference.*will not overwrite an Oracle run or mixed\/tampered metadata/,
    );
    expect(await readFile(realMetaPath, "utf8")).toBe(before);
  });

  test("generic session updates cannot bypass the strict imported-record writer", async () => {
    const metadata = await importChatgptConversation({
      url: "https://chatgpt.com/c/generic-update-guard",
      slug: "manual update guard",
    });
    const metadataPath = path.join(sessionStore.sessionsDir(), metadata.id, "meta.json");
    const before = await readFile(metadataPath, "utf8");

    await expect(
      sessionStore.updateSession(metadata.id, {
        cwd: "/tmp/generic-writer-must-not-land",
      }),
    ).rejects.toThrow(/imported ChatGPT conversation.*generic metadata updates are refused/iu);
    await expect(
      sessionStore.updateModelRun(metadata.id, "gpt-5.6-sol", {
        status: "running",
      }),
    ).rejects.toThrow(/imported ChatGPT conversation.*model-run updates are refused/iu);
    expect(() => sessionStore.createLogWriter(metadata.id)).toThrow(
      /imported ChatGPT conversation.*log writes are refused/iu,
    );
    expect(() => sessionStore.createLogWriter(metadata.id, "gpt-5.6-sol")).toThrow(
      /imported ChatGPT conversation.*log writes are refused/iu,
    );
    expect(await readFile(metadataPath, "utf8")).toBe(before);
    await expect(
      access(path.join(sessionStore.sessionsDir(), metadata.id, "output.log")),
    ).rejects.toBeDefined();
    await expect(
      access(path.join(sessionStore.sessionsDir(), metadata.id, "models")),
    ).rejects.toBeDefined();
  });

  test.each([
    ["null", null],
    ["malformed", { schema: "not-an-import-schema", imported: false }],
  ])(
    "treats a %s importedConversation value as a claimed import across every trust guard",
    async (label, marker) => {
      const metadata = await importChatgptConversation({
        url: `https://chatgpt.com/c/${label}-marker-guard`,
        slug: `${label} marker guard`,
      });
      const metadataPath = path.join(sessionStore.sessionsDir(), metadata.id, "meta.json");
      const raw = JSON.parse(await readFile(metadataPath, "utf8")) as Record<string, unknown>;
      raw.status = "completed";
      (raw.browser as Record<string, unknown>).importedConversation = marker;
      await writeFile(metadataPath, `${JSON.stringify(raw, null, 2)}\n`, "utf8");

      const claimed = await sessionStore.readSession(metadata.id);
      expect(claimed).not.toBeNull();
      expect(hasImportedChatgptConversationMarker(claimed?.browser?.importedConversation)).toBe(
        true,
      );
      expect(resolveRecoveryUrl(claimed as SessionMetadata)).toBeNull();
      await expect(harvestSessionBrowserOutput(metadata.id)).rejects.toThrow(
        /untrusted manual conversation import.*Refusing --harvest/iu,
      );
      await expect(liveTailSessionBrowserOutput(metadata.id)).rejects.toThrow(
        /untrusted manual conversation import.*Refusing --live/iu,
      );
      await expect(resolveBrowserFollowupReference(metadata.id, sessionStore)).rejects.toThrow(
        /mixes an untrusted import with model, lane, account, capture/iu,
      );
      await expect(
        sessionStore.updateSession(metadata.id, { cwd: "/tmp/must-not-land" }),
      ).rejects.toThrow(/imported ChatGPT conversation.*generic metadata updates are refused/iu);
      await expect(
        sessionStore.updateModelRun(metadata.id, "gpt-5.6-sol", { status: "running" }),
      ).rejects.toThrow(/imported ChatGPT conversation.*model-run updates are refused/iu);
      expect(() => sessionStore.createLogWriter(metadata.id)).toThrow(
        /imported ChatGPT conversation.*log writes are refused/iu,
      );
    },
  );

  test("raw imported status without a marker cannot regain recovery, browser, follow-up, or writer privileges", async () => {
    const metadata = await importChatgptConversation({
      url: "https://chatgpt.com/c/missing-marker-guard",
      slug: "missing marker guard",
    });
    const metadataPath = path.join(sessionStore.sessionsDir(), metadata.id, "meta.json");
    const raw = JSON.parse(await readFile(metadataPath, "utf8")) as Record<string, unknown>;
    Reflect.deleteProperty(raw.browser as Record<string, unknown>, "importedConversation");
    await writeFile(metadataPath, `${JSON.stringify(raw, null, 2)}\n`, "utf8");

    const claimed = await sessionStore.readSession(metadata.id);
    expect(claimed?.status).toBe("imported");
    expect(claimed?.browser?.importedConversation).toBeUndefined();
    expect(hasImportedChatgptConversationMarker(claimed?.browser?.importedConversation)).toBe(
      false,
    );
    expect(hasImportedChatgptConversationClaim(claimed)).toBe(true);
    expect(resolveRecoveryUrl(claimed as SessionMetadata)).toBeNull();
    await expect(harvestSessionBrowserOutput(metadata.id)).rejects.toThrow(
      /untrusted manual conversation import.*Refusing --harvest/iu,
    );
    await expect(liveTailSessionBrowserOutput(metadata.id)).rejects.toThrow(
      /untrusted manual conversation import.*Refusing --live/iu,
    );
    await expect(resolveBrowserFollowupReference(metadata.id, sessionStore)).rejects.toThrow(
      /mixes an untrusted import with model, lane, account, capture/iu,
    );
    await expect(
      sessionStore.updateSession(metadata.id, { cwd: "/tmp/must-not-land" }),
    ).rejects.toThrow(/imported ChatGPT conversation.*generic metadata updates are refused/iu);
    await expect(
      sessionStore.updateModelRun(metadata.id, "gpt-5.6-sol", { status: "running" }),
    ).rejects.toThrow(/imported ChatGPT conversation.*model-run updates are refused/iu);
    expect(() => sessionStore.createLogWriter(metadata.id)).toThrow(
      /imported ChatGPT conversation.*log writes are refused/iu,
    );
    expect(() => sessionStore.createLogWriter(metadata.id, "gpt-5.6-sol")).toThrow(
      /imported ChatGPT conversation.*log writes are refused/iu,
    );
  });

  test("refuses an existing session-directory symlink without touching its target", async () => {
    const external = await mkdtemp(path.join(os.tmpdir(), "oracle-import-symlink-target-"));
    const slug = "manual-symlink-test";
    const linkPath = path.join(sessionStore.sessionsDir(), slug);
    const sentinelPath = path.join(external, "sentinel.txt");
    try {
      await mkdir(path.dirname(linkPath), { recursive: true });
      await writeFile(sentinelPath, "must remain unchanged", "utf8");
      await symlink(external, linkPath, process.platform === "win32" ? "junction" : "dir");

      await expect(
        importChatgptConversation({
          url: "https://chatgpt.com/c/symlink-must-not-land",
          slug,
          force: true,
        }),
      ).rejects.toThrow(/not a concrete session directory|refusing to follow/iu);
      expect(await readFile(sentinelPath, "utf8")).toBe("must remain unchanged");
      await expect(access(path.join(external, "meta.json"))).rejects.toBeDefined();
    } finally {
      await rm(linkPath, { force: true }).catch(() => undefined);
      await rm(external, { recursive: true, force: true });
    }
  });

  test("force refuses a directory with any artifact beyond meta.json", async () => {
    const metadata = await importChatgptConversation({
      url: "https://chatgpt.com/c/mixed-directory-base",
      slug: "manual mixed directory",
    });
    const sessionDirectory = path.join(sessionStore.sessionsDir(), metadata.id);
    const metadataPath = path.join(sessionDirectory, "meta.json");
    const before = await readFile(metadataPath, "utf8");
    await writeFile(path.join(sessionDirectory, "output.log"), "captured output", "utf8");

    await expect(
      importChatgptConversation({
        url: "https://chatgpt.com/c/mixed-directory-replacement",
        slug: "manual mixed directory",
        force: true,
      }),
    ).rejects.toThrow(/not a pure imported conversation reference.*directory.*only meta\.json/iu);
    expect(await readFile(metadataPath, "utf8")).toBe(before);
    expect(await readFile(path.join(sessionDirectory, "output.log"), "utf8")).toBe(
      "captured output",
    );
  });

  test("force refuses a symlinked meta.json without touching its target", async () => {
    const metadata = await importChatgptConversation({
      url: "https://chatgpt.com/c/meta-symlink-base",
      slug: "manual meta symlink",
    });
    const sessionDirectory = path.join(sessionStore.sessionsDir(), metadata.id);
    const metadataPath = path.join(sessionDirectory, "meta.json");
    const externalDirectory = await mkdtemp(path.join(os.tmpdir(), "oracle-import-meta-target-"));
    const externalMetadataPath = path.join(externalDirectory, "meta.json");
    try {
      await rename(metadataPath, externalMetadataPath);
      const before = await readFile(externalMetadataPath, "utf8");
      await symlink(externalMetadataPath, metadataPath, "file");

      await expect(
        importChatgptConversation({
          url: "https://chatgpt.com/c/meta-symlink-replacement",
          slug: "manual meta symlink",
          force: true,
        }),
      ).rejects.toThrow(/meta\.json is not a regular non-symlink file/iu);
      expect(await readFile(externalMetadataPath, "utf8")).toBe(before);
    } finally {
      await rm(externalDirectory, { recursive: true, force: true });
    }
  });

  test("force aborts if the pinned session directory is swapped before commit", async () => {
    const metadata = await importChatgptConversation({
      url: "https://chatgpt.com/c/directory-swap-base",
      slug: "manual directory swap",
    });
    const targetDirectory = path.join(sessionStore.sessionsDir(), metadata.id);
    const movedDirectory = path.join(sessionStore.sessionsDir(), `${metadata.id}-moved`);
    let commitPrepared!: () => void;
    const prepared = new Promise<void>((resolve) => {
      commitPrepared = resolve;
    });
    let resumeCommit!: () => void;
    const mayCommit = new Promise<void>((resolve) => {
      resumeCommit = resolve;
    });

    const replacement = importChatgptConversation({
      url: "https://chatgpt.com/c/directory-swap-replacement",
      slug: "manual directory swap",
      force: true,
      testHooks: {
        beforeMetadataCommit: async () => {
          commitPrepared();
          await mayCommit;
        },
      },
    });
    await prepared;
    await rename(targetDirectory, movedDirectory);
    await mkdir(targetDirectory);
    const replacementSentinel = path.join(targetDirectory, "meta.json");
    await writeFile(replacementSentinel, "replacement directory must remain untouched", "utf8");
    resumeCommit();

    await expect(replacement).rejects.toThrow(/directory identity changed during import/iu);
    expect(await readFile(replacementSentinel, "utf8")).toBe(
      "replacement directory must remain untouched",
    );
    expect(await readdir(movedDirectory)).toEqual(["meta.json"]);
    const movedMetadata = JSON.parse(
      await readFile(path.join(movedDirectory, "meta.json"), "utf8"),
    );
    expect(movedMetadata.browser.importedConversation.conversationId).toBe("directory-swap-base");
  });

  test("force rechecks purity and fingerprint at the final pre-rename boundary", async () => {
    const metadata = await importChatgptConversation({
      url: "https://chatgpt.com/c/final-boundary-base",
      slug: "manual final boundary",
    });
    const metadataPath = path.join(sessionStore.sessionsDir(), metadata.id, "meta.json");
    const newer = {
      ...metadata,
      createdAt: new Date(Date.parse(metadata.createdAt) + 1_000).toISOString(),
    };
    const newerRaw = JSON.stringify(newer, null, 2);

    await expect(
      importChatgptConversation({
        url: "https://chatgpt.com/c/final-boundary-replacement",
        slug: "manual final boundary",
        force: true,
        testHooks: {
          beforeAtomicRename: async () => {
            await writeFile(metadataPath, newerRaw, "utf8");
          },
        },
      }),
    ).rejects.toThrow(/metadata changed concurrently/iu);
    expect(await readFile(metadataPath, "utf8")).toBe(newerRaw);
  });

  test("force fails closed on Windows while a new import remains available", async () => {
    const existing = await importChatgptConversation({
      url: "https://chatgpt.com/c/windows-force-base",
      slug: "manual windows force",
    });
    const metadataPath = path.join(sessionStore.sessionsDir(), existing.id, "meta.json");
    const before = await readFile(metadataPath, "utf8");

    await expect(
      importChatgptConversation({
        url: "https://chatgpt.com/c/windows-force-replacement",
        slug: "manual windows force",
        force: true,
        testHooks: { platform: "win32" },
      }),
    ).rejects.toThrow(/--force is unavailable on Windows.*descriptor-relative atomic rename/iu);
    expect(await readFile(metadataPath, "utf8")).toBe(before);

    const created = await importChatgptConversation({
      url: "https://chatgpt.com/c/windows-new-import",
      slug: "manual windows new",
      force: true,
      testHooks: { platform: "win32" },
    });
    expect(created.browser?.importedConversation?.conversationId).toBe("windows-new-import");
  });

  test("force fails closed on any platform without descriptor-rooted paths", async () => {
    const existing = await importChatgptConversation({
      url: "https://chatgpt.com/c/fallback-force-base",
      slug: "manual fallback force",
    });
    const metadataPath = path.join(sessionStore.sessionsDir(), existing.id, "meta.json");
    const before = await readFile(metadataPath, "utf8");

    await expect(
      importChatgptConversation({
        url: "https://chatgpt.com/c/fallback-force-replacement",
        slug: "manual fallback force",
        force: true,
        testHooks: { platform: "freebsd" },
      }),
    ).rejects.toThrow(/mandatory ChatGPT import lock cannot be descriptor-rooted/iu);
    expect(await readFile(metadataPath, "utf8")).toBe(before);
  });

  test("concurrent forced replacements remain a complete valid import", async () => {
    await importChatgptConversation({
      url: "https://chatgpt.com/c/force-base",
      slug: "parallel force test",
    });
    const replacementIds = Array.from({ length: 20 }, (_, index) => `force-${index + 1}`);
    await Promise.all(
      replacementIds.map((conversationId) =>
        importChatgptConversation({
          url: `https://chatgpt.com/c/${conversationId}`,
          slug: "parallel force test",
          force: true,
        }),
      ),
    );

    const stored = await sessionStore.readSession("parallel-force-test");
    expect(replacementIds).toContain(stored?.browser?.importedConversation?.conversationId);
    expect(stored?.browser?.importedConversation).toMatchObject({
      trust: "untrusted",
      accountBinding: "unbound",
      laneBinding: "unbound",
      answerCaptured: false,
    });
    expect(stored?.models).toEqual([]);
    expect(stored?.browser?.harvest).toBeUndefined();
  });
});

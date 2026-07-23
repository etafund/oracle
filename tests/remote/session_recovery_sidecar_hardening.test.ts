import { afterEach, beforeEach, describe, expect, test } from "vitest";
import os from "node:os";
import path from "node:path";
import { chmod, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { setOracleHomeDirOverrideForTest } from "../../src/oracleHome.js";
import { buildRemoteRunRecoveryHint } from "../../src/remote/recovery.js";
import {
  deleteRemoteBrowserRecoverySecret,
  InvalidStoredRemoteRecoverySecretError,
  readRemoteBrowserRecoverySecret,
  remoteBrowserRecoverySecretFilename,
  toPublicRemoteRecoveryMetadata,
  writeRemoteBrowserRecoverySecret,
} from "../../src/remote/sessionRecoveryStore.js";
import type { RemoteBrowserRecoveryCarrier } from "../../src/remote/client.js";
import { sessionStore } from "../../src/sessionStore.js";

const PROMPT_PREVIEW = "the exact submitted composer prefix";

let oracleHome: string;

beforeEach(async () => {
  oracleHome = await mkdtemp(path.join(os.tmpdir(), "oracle-recovery-sidecar-test-"));
  setOracleHomeDirOverrideForTest(oracleHome);
  await sessionStore.ensureStorage();
});

afterEach(async () => {
  setOracleHomeDirOverrideForTest(null);
  await rm(oracleHome, { recursive: true, force: true });
});

async function createFixture(): Promise<{
  sessionId: string;
  sessionDir: string;
  sidecarPath: string;
  carrier: RemoteBrowserRecoveryCarrier;
}> {
  const metadata = await sessionStore.createSession(
    { prompt: "original prompt", model: "gpt-5.6-sol", mode: "browser" },
    "/tmp/project",
  );
  const recovery = buildRemoteRunRecoveryHint(
    {
      stage: "capture-binding",
      runtime: {
        tabUrl: "https://chatgpt.com/c/sidecar-conversation",
        conversationId: "sidecar-conversation",
        promptSubmitted: true,
      },
    },
    undefined,
    {
      originRunId: "origin-sidecar-run",
      accountId: "acct2",
      authToken: "account-secret",
      promptPreview: PROMPT_PREVIEW,
      promptDomSha256: "d".repeat(64),
      nowMs: Date.now(),
      ttlMs: 60_000,
    },
  );
  if (!recovery || recovery.stage !== "capture-binding") {
    throw new Error("fixture did not mint an executable recovery capability");
  }
  const executableRecovery: RemoteBrowserRecoveryCarrier["recovery"] = {
    ...recovery,
    stage: "capture-binding",
  };
  const carrier: RemoteBrowserRecoveryCarrier = {
    recovery: executableRecovery,
    accountId: "acct2",
    laneId: "acct2-9474",
    promptPreview: PROMPT_PREVIEW,
    promptDomSha256: executableRecovery.promptDomSha256,
  };
  const sessionDir = (await sessionStore.getPaths(metadata.id)).dir;
  return {
    sessionId: metadata.id,
    sessionDir,
    sidecarPath: path.join(
      sessionDir,
      remoteBrowserRecoverySecretFilename(carrier.recovery.originRunId),
    ),
    carrier,
  };
}

describe("private remote recovery sidecar", () => {
  test.skipIf(process.platform === "win32")(
    "writes an owner-only 0600 file and exposes only a nonsecret public coordinate",
    async () => {
      const fixture = await createFixture();
      await writeRemoteBrowserRecoverySecret(fixture.sessionId, fixture.carrier);

      const info = await stat(fixture.sidecarPath);
      expect(info.isFile()).toBe(true);
      expect(info.mode & 0o777).toBe(0o600);
      expect((await readdir(fixture.sessionDir)).filter((name) => name.endsWith(".tmp"))).toEqual(
        [],
      );

      const stored = await readRemoteBrowserRecoverySecret(fixture.sessionId);
      expect(stored).toEqual({
        schema: "remote-browser-recovery-secret.v2",
        ...fixture.carrier,
      });

      const publicMetadata = toPublicRemoteRecoveryMetadata(fixture.carrier);
      const serializedPublic = JSON.stringify(publicMetadata);
      expect(publicMetadata).toMatchObject({
        schema: "remote-browser-recovery-public.v1",
        originRunId: "origin-sidecar-run",
        accountId: "acct2",
        laneId: "acct2-9474",
      });
      expect(serializedPublic).not.toContain(fixture.carrier.recovery.capability);
      expect(serializedPublic).not.toContain(PROMPT_PREVIEW);
      expect(serializedPublic).not.toContain("promptPreviewSha256");
      expect(serializedPublic).not.toContain("promptDomSha256");
    },
  );

  test.skipIf(process.platform === "win32")("rejects a world-readable 0644 sidecar", async () => {
    const fixture = await createFixture();
    await writeRemoteBrowserRecoverySecret(fixture.sessionId, fixture.carrier);
    await chmod(fixture.sidecarPath, 0o644);

    await expect(readRemoteBrowserRecoverySecret(fixture.sessionId)).rejects.toBeInstanceOf(
      InvalidStoredRemoteRecoverySecretError,
    );
  });

  test("rejects an owner-only sidecar larger than 64 KiB", async () => {
    const fixture = await createFixture();
    await writeFile(fixture.sidecarPath, "x".repeat(64 * 1024 + 1), {
      encoding: "utf8",
      mode: 0o600,
    });
    await chmod(fixture.sidecarPath, 0o600);

    await expect(readRemoteBrowserRecoverySecret(fixture.sessionId)).rejects.toBeInstanceOf(
      InvalidStoredRemoteRecoverySecretError,
    );
  });

  test("refuses to persist a carrier whose duplicated DOM digest does not match", async () => {
    const fixture = await createFixture();
    const mismatched = {
      ...fixture.carrier,
      promptDomSha256: "e".repeat(64),
    };

    await expect(
      writeRemoteBrowserRecoverySecret(fixture.sessionId, mismatched),
    ).rejects.toBeInstanceOf(InvalidStoredRemoteRecoverySecretError);
    await expect(stat(fixture.sidecarPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test.skipIf(process.platform === "win32")("refuses to follow a sidecar symlink", async () => {
    const fixture = await createFixture();
    await writeRemoteBrowserRecoverySecret(fixture.sessionId, fixture.carrier);
    const validDocument = await readFile(fixture.sidecarPath, "utf8");
    await deleteRemoteBrowserRecoverySecret(fixture.sessionId);

    const externalPath = path.join(oracleHome, "external-recovery-secret.json");
    await writeFile(externalPath, validDocument, { encoding: "utf8", mode: 0o600 });
    await symlink(externalPath, fixture.sidecarPath);

    await expect(readRemoteBrowserRecoverySecret(fixture.sessionId)).rejects.toBeInstanceOf(
      InvalidStoredRemoteRecoverySecretError,
    );
  });

  test("rejects malformed JSON and a prompt/hash mismatch", async () => {
    const fixture = await createFixture();
    await writeRemoteBrowserRecoverySecret(fixture.sessionId, fixture.carrier);

    await writeFile(fixture.sidecarPath, "{not-json\n", { encoding: "utf8", mode: 0o600 });
    await chmod(fixture.sidecarPath, 0o600);
    await expect(readRemoteBrowserRecoverySecret(fixture.sessionId)).rejects.toMatchObject({
      name: "InvalidStoredRemoteRecoverySecretError",
      message: expect.stringMatching(/valid JSON/i),
    });

    await writeRemoteBrowserRecoverySecret(fixture.sessionId, fixture.carrier);
    const document = JSON.parse(await readFile(fixture.sidecarPath, "utf8")) as Record<
      string,
      unknown
    >;
    document.promptPreview = `${PROMPT_PREVIEW}-tampered`;
    await writeFile(fixture.sidecarPath, `${JSON.stringify(document)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await chmod(fixture.sidecarPath, 0o600);

    await expect(readRemoteBrowserRecoverySecret(fixture.sessionId)).rejects.toBeInstanceOf(
      InvalidStoredRemoteRecoverySecretError,
    );
  });

  test.each([
    [
      "legacy v1 schema",
      (document: Record<string, unknown>) => {
        document.schema = "remote-browser-recovery-secret.v1";
      },
    ],
    [
      "missing DOM digest",
      (document: Record<string, unknown>) => {
        delete document.promptDomSha256;
      },
    ],
    [
      "tampered DOM digest",
      (document: Record<string, unknown>) => {
        const recovery = document.recovery as Record<string, unknown>;
        recovery.promptDomSha256 = "e".repeat(64);
      },
    ],
  ])("rejects a %s in the private v2 sidecar", async (_label, mutate) => {
    const fixture = await createFixture();
    await writeRemoteBrowserRecoverySecret(fixture.sessionId, fixture.carrier);
    const document = JSON.parse(await readFile(fixture.sidecarPath, "utf8")) as Record<
      string,
      unknown
    >;
    mutate(document);
    await writeFile(fixture.sidecarPath, `${JSON.stringify(document)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await chmod(fixture.sidecarPath, 0o600);

    await expect(readRemoteBrowserRecoverySecret(fixture.sessionId)).rejects.toBeInstanceOf(
      InvalidStoredRemoteRecoverySecretError,
    );
  });

  test("delete is idempotent and read returns null after deletion", async () => {
    const fixture = await createFixture();
    await writeRemoteBrowserRecoverySecret(fixture.sessionId, fixture.carrier);
    expect(await readRemoteBrowserRecoverySecret(fixture.sessionId)).not.toBeNull();

    await deleteRemoteBrowserRecoverySecret(fixture.sessionId);
    await deleteRemoteBrowserRecoverySecret(fixture.sessionId);

    await expect(stat(fixture.sidecarPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readRemoteBrowserRecoverySecret(fixture.sessionId)).resolves.toBeNull();
  });

  test("origin-bound sidecars cannot overwrite or compare-delete another recovery generation", async () => {
    const fixture = await createFixture();
    const secondRecovery = buildRemoteRunRecoveryHint(
      {
        stage: "capture-binding",
        runtime: {
          tabUrl: "https://chatgpt.com/c/second-sidecar-conversation",
          conversationId: "second-sidecar-conversation",
          promptSubmitted: true,
        },
      },
      undefined,
      {
        originRunId: "origin-sidecar-run-2",
        accountId: "acct2",
        authToken: "account-secret",
        promptPreview: PROMPT_PREVIEW,
        promptDomSha256: "e".repeat(64),
        nowMs: Date.now(),
        ttlMs: 60_000,
      },
    );
    if (!secondRecovery || secondRecovery.stage !== "capture-binding") {
      throw new Error("second fixture did not mint a recovery capability");
    }
    const secondCarrier: RemoteBrowserRecoveryCarrier = {
      recovery: { ...secondRecovery, stage: "capture-binding" },
      accountId: "acct2",
      laneId: "acct2-9474",
      promptPreview: PROMPT_PREVIEW,
      promptDomSha256: secondRecovery.promptDomSha256,
    };

    await writeRemoteBrowserRecoverySecret(fixture.sessionId, fixture.carrier);
    await writeRemoteBrowserRecoverySecret(fixture.sessionId, secondCarrier);

    await expect(
      readRemoteBrowserRecoverySecret(fixture.sessionId, fixture.carrier.recovery.originRunId),
    ).resolves.toMatchObject({ recovery: { originRunId: "origin-sidecar-run" } });
    await expect(
      readRemoteBrowserRecoverySecret(fixture.sessionId, secondCarrier.recovery.originRunId),
    ).resolves.toMatchObject({ recovery: { originRunId: "origin-sidecar-run-2" } });

    await deleteRemoteBrowserRecoverySecret(
      fixture.sessionId,
      fixture.carrier.recovery.originRunId,
    );
    await expect(
      readRemoteBrowserRecoverySecret(fixture.sessionId, fixture.carrier.recovery.originRunId),
    ).resolves.toBeNull();
    await expect(
      readRemoteBrowserRecoverySecret(fixture.sessionId, secondCarrier.recovery.originRunId),
    ).resolves.toMatchObject({ recovery: { originRunId: "origin-sidecar-run-2" } });
  });
});

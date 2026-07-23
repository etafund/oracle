import path from "node:path";
import os from "node:os";
import { createHash, randomBytes } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { setOracleHomeDirOverrideForTest } from "../../src/oracleHome.js";
import {
  InvalidRecoveryClaimInputError,
  InvalidRecoveryClaimStoreError,
  MAX_RECOVERY_CLAIM_TTL_MS,
  MIN_RECOVERY_CLAIM_TTL_MS,
  RecoveryClaimConflictError,
  RecoveryClaimStore,
  defaultRecoveryClaimSpoolRoot,
  type AuthenticatedRecoveryClaimInput,
  type RecoveryClaimBinding,
} from "../../src/remote/recoveryClaimStore.js";

const START_MS = Date.parse("2026-07-23T12:00:00.000Z");
const PROMPT_HASH = createHash("sha256").update("exact prompt preview").digest("hex");
const FALLBACK_PROMPT_HASH = createHash("sha256")
  .update("authorized fallback preview")
  .digest("hex");
const PROMPT_HASH_CANDIDATES = [PROMPT_HASH, FALLBACK_PROMPT_HASH].sort();
const BINDING: RecoveryClaimBinding = {
  accountId: "acct2",
  originRunId: "run-origin-123",
  originLaneId: "acct2-9474",
  promptPreviewSha256Candidates: PROMPT_HASH_CANDIDATES,
};

let sandbox: string;
let spoolRoot: string;
let nowMs: number;

beforeEach(async () => {
  sandbox = await mkdtemp(path.join(os.tmpdir(), "oracle-recovery-claim-store-"));
  spoolRoot = path.join(sandbox, "spool");
  nowMs = START_MS;
});

afterEach(async () => {
  setOracleHomeDirOverrideForTest(null);
  await rm(sandbox, { recursive: true, force: true });
});

function store<Carrier extends object = Record<string, unknown>>(): RecoveryClaimStore<Carrier> {
  return new RecoveryClaimStore<Carrier>({ rootDir: spoolRoot, now: () => nowMs });
}

async function createClaim(
  claimStore = store(),
  binding: RecoveryClaimBinding = BINDING,
  ttlMs = 60_000,
): Promise<{ claimKey: string; auth: AuthenticatedRecoveryClaimInput }> {
  const created = await claimStore.createPending({ ...binding, ttlMs });
  if (!created.created) throw new Error("test fixture unexpectedly reused a claim");
  return {
    claimKey: created.claimKey,
    auth: { ...binding, claimKey: created.claimKey },
  };
}

async function onlyClaimDirectory(root = spoolRoot): Promise<string> {
  const accounts = (await readdir(root, { withFileTypes: true })).filter((entry) =>
    entry.isDirectory(),
  );
  expect(accounts).toHaveLength(1);
  const account = accounts.at(0);
  if (!account) throw new Error("claim fixture has no account directory");
  const accountDir = path.join(root, account.name);
  const runs = (await readdir(accountDir, { withFileTypes: true })).filter((entry) =>
    entry.isDirectory(),
  );
  expect(runs).toHaveLength(1);
  const run = runs.at(0);
  if (!run) throw new Error("claim fixture has no run directory");
  return path.join(accountDir, run.name);
}

async function expectPrivateDirectory(directory: string): Promise<void> {
  const info = await stat(directory);
  expect(info.isDirectory()).toBe(true);
  if (process.platform !== "win32") expect(info.mode & 0o777).toBe(0o700);
}

async function expectPrivateFile(file: string): Promise<void> {
  const info = await stat(file);
  expect(info.isFile()).toBe(true);
  if (process.platform !== "win32") expect(info.mode & 0o777).toBe(0o600);
}

describe("RecoveryClaimStore", () => {
  test("uses the Oracle-home spool by default and accepts an explicit absolute root", () => {
    const oracleHome = path.join(sandbox, "oracle-home");
    setOracleHomeDirOverrideForTest(oracleHome);
    expect(defaultRecoveryClaimSpoolRoot()).toBe(path.join(oracleHome, "remote-recovery-claims"));
    expect(new RecoveryClaimStore().rootDir).toBe(path.join(oracleHome, "remote-recovery-claims"));
    expect(new RecoveryClaimStore({ rootDir: spoolRoot }).rootDir).toBe(spoolRoot);
    expect(() => new RecoveryClaimStore({ rootDir: "relative/spool" })).toThrow(
      InvalidRecoveryClaimInputError,
    );
    expect(() => new RecoveryClaimStore({ rootDir: path.parse(spoolRoot).root })).toThrow(
      InvalidRecoveryClaimInputError,
    );
  });

  test("creates a private pending claim and persists only the hash of a 32-byte key", async () => {
    const claimStore = store();
    const { claimKey, auth } = await createClaim(claimStore);

    expect(claimKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const claimKeyBytes = Buffer.from(claimKey, "base64url");
    expect(claimKeyBytes).toHaveLength(32);
    expect(claimKeyBytes.toString("base64url")).toBe(claimKey);
    await expect(claimStore.lookup(auth)).resolves.toEqual({
      status: "pending",
      ...BINDING,
      expiresAt: "2026-07-23T12:01:00.000Z",
    });

    const runDir = await onlyClaimDirectory();
    const accountDir = path.dirname(runDir);
    await expectPrivateDirectory(spoolRoot);
    await expectPrivateDirectory(accountDir);
    await expectPrivateDirectory(runDir);
    expect(await readdir(runDir)).toEqual(["pending.json"]);
    const pendingPath = path.join(runDir, "pending.json");
    await expectPrivateFile(pendingPath);
    const raw = await readFile(pendingPath, "utf8");
    expect(raw).not.toContain(claimKey);
    expect(raw).not.toContain(claimKeyBytes.toString("hex"));
    expect(raw).not.toContain('claimKey"');
    expect(JSON.parse(raw)).toMatchObject({
      schema: "oracle-remote-recovery-claim.v1",
      state: "pending",
      ...BINDING,
      claimKeySha256: createHash("sha256").update(claimKeyBytes).digest("hex"),
    });
    expect((await readdir(runDir)).some((name) => name.endsWith(".tmp"))).toBe(false);
  });

  test("createPending is compatible-idempotent without re-exposing plaintext", async () => {
    const firstStore = store();
    const first = await firstStore.createPending({ ...BINDING, ttlMs: 60_000 });
    if (!first.created) throw new Error("first create did not mint a claim key");

    const second = await store().createPending({ ...BINDING, ttlMs: 30_000 });
    expect(second).toEqual({
      status: "pending",
      created: false,
      ...BINDING,
      expiresAt: first.expiresAt,
    });
    expect("claimKey" in second).toBe(false);
    await expect(
      firstStore.lookup({ ...BINDING, claimKey: first.claimKey }),
    ).resolves.toMatchObject({ status: "pending" });
  });

  test("two store instances atomically create one cross-process authority", async () => {
    const [left, right] = await Promise.all([
      store().createPending({ ...BINDING, ttlMs: 60_000 }),
      store().createPending({ ...BINDING, ttlMs: 60_000 }),
    ]);
    const created = [left, right].filter(
      (result): result is Extract<typeof result, { created: true }> => result.created,
    );
    expect(created).toHaveLength(1);
    expect([left.created, right.created].sort()).toEqual([false, true]);
    const winner = created.at(0);
    if (!winner) throw new Error("concurrent create had no winner");
    await expect(store().lookup({ ...BINDING, claimKey: winner.claimKey })).resolves.toMatchObject({
      status: "pending",
    });
  });

  test("publishes a ready carrier idempotently and refuses replacement", async () => {
    const claimStore = store<Record<string, unknown>>();
    const { auth } = await createClaim(claimStore);
    const firstCarrier = {
      recovery: { stage: "capture-binding", conversationId: "conversation-123" },
      lane: "acct2-9474",
    };
    const reorderedCarrier = {
      lane: "acct2-9474",
      recovery: { conversationId: "conversation-123", stage: "capture-binding" },
    };

    await expect(
      claimStore.publishReady({
        ...auth,
        promptPreviewSha256: PROMPT_HASH,
        carrier: firstCarrier,
      }),
    ).resolves.toEqual({
      status: "ready",
      ...BINDING,
      promptPreviewSha256: PROMPT_HASH,
      expiresAt: "2026-07-23T12:01:00.000Z",
      carrier: reorderedCarrier,
    });
    await expect(
      store().publishReady({
        ...auth,
        promptPreviewSha256: PROMPT_HASH,
        carrier: reorderedCarrier,
      }),
    ).resolves.toMatchObject({
      status: "ready",
      originLaneId: "acct2-9474",
      promptPreviewSha256: PROMPT_HASH,
      carrier: reorderedCarrier,
    });
    await expect(
      store().publishReady({
        ...auth,
        promptPreviewSha256: PROMPT_HASH,
        carrier: { conversationId: "different" },
      }),
    ).rejects.toBeInstanceOf(RecoveryClaimConflictError);
    await expect(claimStore.lookup(auth)).resolves.toMatchObject({
      status: "ready",
      originLaneId: "acct2-9474",
      carrier: reorderedCarrier,
    });

    const runDir = await onlyClaimDirectory();
    expect((await readdir(runDir)).sort()).toEqual(["pending.json", "ready.json"]);
    await expectPrivateFile(path.join(runDir, "ready.json"));
  });

  test("concurrent different ready carriers never overwrite the winner", async () => {
    const { auth } = await createClaim();
    const attempts = await Promise.allSettled([
      store().publishReady({
        ...auth,
        promptPreviewSha256: PROMPT_HASH,
        carrier: { conversationId: "left" },
      }),
      store().publishReady({
        ...auth,
        promptPreviewSha256: PROMPT_HASH,
        carrier: { conversationId: "right" },
      }),
    ]);
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);
    const rejected = attempts.find((attempt) => attempt.status === "rejected");
    expect(rejected).toMatchObject({ reason: expect.any(RecoveryClaimConflictError) });

    const winner = await store().lookup(auth);
    expect(winner.status).toBe("ready");
    if (winner.status !== "ready") throw new Error("ready winner vanished");
    expect(["left", "right"]).toContain(
      (winner.carrier as { conversationId: string }).conversationId,
    );
    await expect(
      store().publishReady({
        ...auth,
        promptPreviewSha256: PROMPT_HASH,
        carrier: { conversationId: "third" },
      }),
    ).rejects.toBeInstanceOf(RecoveryClaimConflictError);
  });

  test("marks a pending claim unrecoverable idempotently without deleting authority", async () => {
    const claimStore = store();
    const { auth } = await createClaim(claimStore);
    const marked = await store().markUnrecoverable(auth);
    expect(marked).toEqual({
      status: "unrecoverable",
      ...BINDING,
      expiresAt: "2026-07-23T12:01:00.000Z",
    });
    await expect(claimStore.markUnrecoverable(auth)).resolves.toEqual(marked);
    await expect(claimStore.lookup(auth)).resolves.toEqual(marked);

    const runDir = await onlyClaimDirectory();
    expect((await readdir(runDir)).sort()).toEqual(["pending.json", "unrecoverable.json"]);
  });

  test("ready is absorbing across sequential and cross-process unrecoverable races", async () => {
    const claimStore = store();
    const { auth } = await createClaim(claimStore);
    const carrier = { conversationId: "conversation-123" };

    // Even if an unrecoverable marker wins first, stronger ready evidence may
    // arrive from the sibling worker and must become authoritative.
    await store().markUnrecoverable(auth);
    const ready = await store().publishReady({
      ...auth,
      promptPreviewSha256: FALLBACK_PROMPT_HASH,
      carrier,
    });
    expect(ready).toMatchObject({
      status: "ready",
      promptPreviewSha256: FALLBACK_PROMPT_HASH,
      carrier,
    });
    await expect(claimStore.markUnrecoverable(auth)).resolves.toEqual(ready);
    await expect(claimStore.lookup(auth)).resolves.toEqual(ready);

    const secondBinding: RecoveryClaimBinding = { ...BINDING, originRunId: "run-race" };
    const second = await createClaim(store(), secondBinding);
    await Promise.all([
      store().publishReady({
        ...second.auth,
        promptPreviewSha256: PROMPT_HASH,
        carrier: { conversationId: "race-winner" },
      }),
      store().markUnrecoverable(second.auth),
    ]);
    await expect(store().lookup(second.auth)).resolves.toMatchObject({
      status: "ready",
      promptPreviewSha256: PROMPT_HASH,
      carrier: { conversationId: "race-winner" },
    });
  });

  test("all valid lookup mismatches and expiry have the same not_found result", async () => {
    const claimStore = store();
    const { auth } = await createClaim(claimStore, BINDING, MIN_RECOVERY_CLAIM_TTL_MS);
    const wrongKey = randomBytes(32).toString("base64url");
    const mismatches: AuthenticatedRecoveryClaimInput[] = [
      { ...auth, claimKey: wrongKey },
      { ...auth, claimKey: "not-base64url" },
      { ...auth, accountId: "acct1" },
      { ...auth, originRunId: "different-run" },
      { ...auth, originLaneId: "acct2-9473" },
      { ...auth, promptPreviewSha256Candidates: ["b".repeat(64)] },
      // Knowing one candidate is insufficient; lookup requires the exact
      // canonical set minted before browser execution.
      { ...auth, promptPreviewSha256Candidates: [PROMPT_HASH] },
    ];
    for (const mismatch of mismatches) {
      const suppliedActual = mismatch.promptPreviewSha256Candidates.at(0);
      if (!suppliedActual) throw new Error("mismatch fixture has no candidate hash");
      await expect(claimStore.lookup(mismatch)).resolves.toEqual({ status: "not_found" });
      await expect(
        claimStore.publishReady({
          ...mismatch,
          promptPreviewSha256: suppliedActual,
          carrier: { conversationId: "ignored" },
        }),
      ).resolves.toEqual({ status: "not_found" });
      await expect(claimStore.markUnrecoverable(mismatch)).resolves.toEqual({
        status: "not_found",
      });
    }

    await expect(
      claimStore.lookup({
        ...auth,
        promptPreviewSha256Candidates: [FALLBACK_PROMPT_HASH, PROMPT_HASH],
      }),
    ).resolves.toMatchObject({ status: "pending" });

    nowMs += MIN_RECOVERY_CLAIM_TTL_MS;
    await expect(claimStore.lookup(auth)).resolves.toEqual({ status: "not_found" });
    await expect(
      claimStore.publishReady({
        ...auth,
        promptPreviewSha256: PROMPT_HASH,
        carrier: { conversationId: "too-late" },
      }),
    ).resolves.toEqual({ status: "not_found" });
    await expect(claimStore.markUnrecoverable(auth)).resolves.toEqual({ status: "not_found" });
  });

  test("validates bindings, TTLs, clocks, and JSON carriers before persistence", async () => {
    const claimStore = store();
    await expect(
      claimStore.createPending({ ...BINDING, accountId: "../acct", ttlMs: 60_000 }),
    ).rejects.toBeInstanceOf(InvalidRecoveryClaimInputError);
    await expect(
      claimStore.createPending({
        ...BINDING,
        promptPreviewSha256Candidates: ["A".repeat(64)],
        ttlMs: 60_000,
      }),
    ).rejects.toBeInstanceOf(InvalidRecoveryClaimInputError);
    await expect(
      claimStore.createPending({
        ...BINDING,
        promptPreviewSha256Candidates: [PROMPT_HASH, FALLBACK_PROMPT_HASH, "b".repeat(64)],
        ttlMs: 60_000,
      }),
    ).rejects.toBeInstanceOf(InvalidRecoveryClaimInputError);
    await expect(
      claimStore.createPending({ ...BINDING, ttlMs: MIN_RECOVERY_CLAIM_TTL_MS - 1 }),
    ).rejects.toBeInstanceOf(InvalidRecoveryClaimInputError);
    await expect(
      claimStore.createPending({ ...BINDING, ttlMs: MAX_RECOVERY_CLAIM_TTL_MS + 1 }),
    ).rejects.toBeInstanceOf(InvalidRecoveryClaimInputError);

    const { auth } = await createClaim(claimStore);
    await expect(
      claimStore.publishReady({
        ...auth,
        promptPreviewSha256: "b".repeat(64),
        carrier: { conversationId: "unauthorized-branch" },
      }),
    ).rejects.toBeInstanceOf(InvalidRecoveryClaimInputError);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    await expect(
      claimStore.publishReady({ ...auth, promptPreviewSha256: PROMPT_HASH, carrier: cyclic }),
    ).rejects.toBeInstanceOf(InvalidRecoveryClaimInputError);
    await expect(
      claimStore.publishReady({
        ...auth,
        promptPreviewSha256: PROMPT_HASH,
        carrier: { value: Number.NaN },
      }),
    ).rejects.toBeInstanceOf(InvalidRecoveryClaimInputError);
    await expect(
      claimStore.publishReady({
        ...auth,
        promptPreviewSha256: PROMPT_HASH,
        carrier: { value: "x".repeat(49 * 1024) },
      }),
    ).rejects.toBeInstanceOf(InvalidRecoveryClaimInputError);

    const badClockStore = new RecoveryClaimStore({
      rootDir: path.join(sandbox, "bad-clock"),
      now: () => -1,
    });
    await expect(badClockStore.createPending({ ...BINDING, ttlMs: 60_000 })).rejects.toBeInstanceOf(
      InvalidRecoveryClaimInputError,
    );
  });

  test.skipIf(process.platform === "win32")(
    "rejects symlinked spool directories and state records",
    async () => {
      const external = path.join(sandbox, "external");
      await mkdir(external, { mode: 0o700 });
      await symlink(external, spoolRoot);
      await expect(store().createPending({ ...BINDING, ttlMs: 60_000 })).rejects.toBeInstanceOf(
        InvalidRecoveryClaimStoreError,
      );

      const secondRoot = path.join(sandbox, "second-spool");
      spoolRoot = secondRoot;
      const claimStore = store();
      const { auth } = await createClaim(claimStore);
      const runDir = await onlyClaimDirectory();
      const pendingPath = path.join(runDir, "pending.json");
      const raw = await readFile(pendingPath);
      const externalRecord = path.join(sandbox, "external-record.json");
      await writeFile(externalRecord, raw, { mode: 0o600 });
      await unlink(pendingPath);
      await symlink(externalRecord, pendingPath);
      await expect(claimStore.lookup(auth)).rejects.toBeInstanceOf(InvalidRecoveryClaimStoreError);
    },
  );

  test("rejects nonregular, oversized, world-readable, and malformed records", async () => {
    const cases: Array<{
      name: string;
      mutate: (pendingPath: string) => Promise<void>;
    }> = [
      {
        name: "nonregular",
        mutate: async (pendingPath) => {
          await unlink(pendingPath);
          await mkdir(pendingPath, { mode: 0o700 });
        },
      },
      {
        name: "oversized",
        mutate: async (pendingPath) => {
          await writeFile(pendingPath, Buffer.alloc(64 * 1024 + 1), { mode: 0o600 });
        },
      },
      {
        name: "malformed",
        mutate: async (pendingPath) => {
          await writeFile(pendingPath, "{not-json\n", { mode: 0o600 });
        },
      },
    ];
    if (process.platform !== "win32") {
      cases.push({
        name: "world-readable",
        mutate: async (pendingPath) => {
          await chmod(pendingPath, 0o644);
        },
      });
    }

    for (const entry of cases) {
      const caseRoot = path.join(sandbox, `case-${entry.name}`);
      spoolRoot = caseRoot;
      const claimStore = store();
      const { auth } = await createClaim(claimStore);
      const pendingPath = path.join(await onlyClaimDirectory(), "pending.json");
      await entry.mutate(pendingPath);
      await expect(claimStore.lookup(auth), entry.name).rejects.toBeInstanceOf(
        InvalidRecoveryClaimStoreError,
      );
    }
  });

  test("rejects malformed expiry, unknown fields, and displaced binding records", async () => {
    const claimStore = store();
    const { auth } = await createClaim(claimStore);
    const pendingPath = path.join(await onlyClaimDirectory(), "pending.json");
    const original = JSON.parse(await readFile(pendingPath, "utf8")) as Record<string, unknown>;

    const badExpiry = { ...original, expiresAt: "2030-01-01T00:00:00.000Z" };
    await writeFile(pendingPath, `${JSON.stringify(badExpiry)}\n`, { mode: 0o600 });
    await expect(claimStore.lookup(auth)).rejects.toBeInstanceOf(InvalidRecoveryClaimStoreError);

    const unknownField = { ...original, unexpected: true };
    await writeFile(pendingPath, `${JSON.stringify(unknownField)}\n`, { mode: 0o600 });
    await expect(claimStore.lookup(auth)).rejects.toBeInstanceOf(InvalidRecoveryClaimStoreError);

    const displaced = { ...original, accountId: "acct1" };
    await writeFile(pendingPath, `${JSON.stringify(displaced)}\n`, { mode: 0o600 });
    await expect(claimStore.lookup(auth)).resolves.toEqual({ status: "not_found" });
    await expect(claimStore.sweep()).rejects.toBeInstanceOf(InvalidRecoveryClaimStoreError);
  });

  test("performs a bounded read-only sweep and leaves expired evidence intact", async () => {
    const claimStore = store();
    for (const suffix of ["a", "b", "c"]) {
      await claimStore.createPending({
        ...BINDING,
        originRunId: `run-${suffix}`,
        ttlMs: MIN_RECOVERY_CLAIM_TTL_MS,
      });
    }

    const bounded = await claimStore.sweep({ maxEntries: 2 });
    expect(bounded).toMatchObject({ examinedEntries: 2, claims: 1, truncated: true });
    nowMs += MIN_RECOVERY_CLAIM_TTL_MS;
    const complete = await claimStore.sweep({ maxEntries: 16 });
    expect(complete).toEqual({
      examinedEntries: 4,
      claims: 3,
      expired: 3,
      pending: 3,
      ready: 0,
      unrecoverable: 0,
      truncated: false,
    });
    expect("delete" in (claimStore as unknown as Record<string, unknown>)).toBe(false);

    const accountDirs = await readdir(spoolRoot, { withFileTypes: true });
    const account = accountDirs.at(0);
    if (!account) throw new Error("sweep fixture has no account directory");
    const accountDir = path.join(spoolRoot, account.name);
    const runDirs = await readdir(accountDir);
    expect(runDirs).toHaveLength(3);
    for (const runDir of runDirs) {
      expect(await readFile(path.join(accountDir, runDir, "pending.json"))).not.toHaveLength(0);
    }
  });
});

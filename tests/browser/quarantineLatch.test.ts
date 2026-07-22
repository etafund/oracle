// Worker-local account quarantine latch:
// atomic trip, fail-closed reads, persistence across restarts, manual-only clear.

import { describe, expect, test } from "vitest";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  ACCOUNT_QUARANTINE_ERROR_CLASS,
  AccountQuarantinedError,
  DEFAULT_QUARANTINE_ACCOUNT_ID,
  assertNotQuarantined,
  clearQuarantineLatchManually,
  getQuarantineLatchState,
  quarantineLatchPath,
  resolveQuarantineAccountId,
  sanitizeQuarantineAccountId,
  tripQuarantineLatch,
} from "../../src/browser/quarantineLatch.js";

async function tempLatchDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "oracle-quarantine-test-"));
}

describe("quarantine latch paths and identity", () => {
  test("latch path is quarantine-<account_id>.json inside the fleet dir", async () => {
    const dir = await tempLatchDir();
    expect(quarantineLatchPath({ dir, accountId: "acct7" })).toBe(
      path.join(dir, "quarantine-acct7.json"),
    );
  });

  test("account ids are neutral labels; invalid values fall back to the default", () => {
    expect(sanitizeQuarantineAccountId("acct-2")).toBe("acct-2");
    expect(sanitizeQuarantineAccountId("bad label!")).toBeUndefined();
    expect(sanitizeQuarantineAccountId("")).toBeUndefined();
    expect(resolveQuarantineAccountId({})).toBe(DEFAULT_QUARANTINE_ACCOUNT_ID);
    expect(resolveQuarantineAccountId({ ORACLE_ACCOUNT_ID: "acct9" })).toBe("acct9");
    expect(resolveQuarantineAccountId({ ORACLE_ACCOUNT_ID: "not a label!" })).toBe(
      DEFAULT_QUARANTINE_ACCOUNT_ID,
    );
  });
});

describe("tripQuarantineLatch", () => {
  test("writes an atomic latch record with no temp-file leftovers", async () => {
    const dir = await tempLatchDir();
    const outcome = await tripQuarantineLatch({
      dir,
      accountId: "acct1",
      reason: "verification_interstitial",
      detail: "signals: interstitial-title",
      runId: "run-1",
      source: "pre-run-gate",
    });

    expect(outcome.alreadyLatched).toBe(false);
    expect(outcome.recordPersisted).toBe(true);
    const raw = await readFile(outcome.latchPath, "utf8");
    const record = JSON.parse(raw);
    expect(record).toMatchObject({
      version: 1,
      accountId: "acct1",
      reason: "verification_interstitial",
      runId: "run-1",
      source: "pre-run-gate",
      pid: process.pid,
    });
    expect(typeof record.at).toBe("string");
    expect(record.clearInstructions).toContain("Manual human action required");
    const leftovers = (await readdir(dir)).filter((name) => name.endsWith(".tmp"));
    expect(leftovers).toEqual([]);
  });

  test("a metadata write failure leaves the published final path as a fail-closed sentinel", async () => {
    const dir = await tempLatchDir();
    const sensitiveFailure = `write failed at ${path.join(dir, "private-detail")}`;
    const outcome = await tripQuarantineLatch(
      {
        dir,
        accountId: "acct1",
        reason: "verification_interstitial",
        source: "remote-terminal-gate",
      },
      {
        writeRecord: async () => {
          throw new Error(sensitiveFailure);
        },
      },
    );

    expect(outcome.alreadyLatched).toBe(false);
    expect(outcome.recordPersisted).toBe(false);
    expect(await readFile(outcome.latchPath, "utf8")).toBe("");

    // A fresh read has no process-local context. The final pathname alone is
    // sufficient to fence sibling and restarted workers.
    const freshState = await getQuarantineLatchState({ dir, accountId: "acct1" });
    expect(freshState).toMatchObject({
      quarantined: true,
      record: null,
      readError: "latch file exists but is not a valid quarantine record",
    });
    expect(freshState.readError).not.toContain(sensitiveFailure);
  });

  test("first trip wins; later trips keep the original record", async () => {
    const dir = await tempLatchDir();
    await tripQuarantineLatch({
      dir,
      accountId: "acct1",
      reason: "verification_interstitial",
      source: "pre-run-gate",
    });
    const second = await tripQuarantineLatch({
      dir,
      accountId: "acct1",
      reason: "account_security_block",
      source: "pre-result-gate",
    });

    expect(second.alreadyLatched).toBe(true);
    expect(second.recordPersisted).toBe(true);
    expect(second.record.reason).toBe("verification_interstitial");
    const state = await getQuarantineLatchState({ dir, accountId: "acct1" });
    expect(state.record?.source).toBe("pre-run-gate");
  });

  test("simultaneous trip contenders publish one winner and one durable final latch", async () => {
    const dir = await tempLatchDir();
    const outcomes = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        tripQuarantineLatch({
          dir,
          accountId: "acct1",
          reason: index % 2 === 0 ? "verification_interstitial" : "account_security_block",
          source: `contender-${index}`,
          runId: `run-${index}`,
        }),
      ),
    );

    expect(outcomes.filter((outcome) => !outcome.alreadyLatched)).toHaveLength(1);
    expect(outcomes.every((outcome) => outcome.latchPath === outcomes[0]?.latchPath)).toBe(true);
    const state = await getQuarantineLatchState({ dir, accountId: "acct1" });
    expect(state.quarantined).toBe(true);
    expect(state.record).not.toBeNull();
    expect(await readdir(dir)).toEqual(["quarantine-acct1.json"]);
  });

  test("account-scoped trip and manual clear never affect a sibling account", async () => {
    const dir = await tempLatchDir();
    await tripQuarantineLatch({
      dir,
      accountId: "acct1",
      reason: "verification_interstitial",
      source: "pre-run-gate",
    });

    expect((await getQuarantineLatchState({ dir, accountId: "acct1" })).quarantined).toBe(true);
    expect((await getQuarantineLatchState({ dir, accountId: "acct2" })).quarantined).toBe(false);
    await clearQuarantineLatchManually({ dir, accountId: "acct1" });
    expect((await getQuarantineLatchState({ dir, accountId: "acct1" })).quarantined).toBe(false);
    expect((await getQuarantineLatchState({ dir, accountId: "acct2" })).quarantined).toBe(false);
  });
});

describe("getQuarantineLatchState", () => {
  test("no latch file means not quarantined", async () => {
    const dir = await tempLatchDir();
    const state = await getQuarantineLatchState({ dir, accountId: "acct1" });
    expect(state.quarantined).toBe(false);
    expect(state.record).toBeNull();
    expect(state.readError).toBeNull();
  });

  test("a latch persists across worker restarts (fresh reads see it)", async () => {
    const dir = await tempLatchDir();
    await tripQuarantineLatch({
      dir,
      accountId: "acct1",
      reason: "verification_interstitial",
      source: "pre-run-gate",
    });
    // A restarted worker holds no in-memory state; the file alone decides.
    const state = await getQuarantineLatchState({ dir, accountId: "acct1" });
    expect(state.quarantined).toBe(true);
    expect(state.record?.reason).toBe("verification_interstitial");
  });

  test("FAIL CLOSED: a corrupt latch file still reads as quarantined", async () => {
    const dir = await tempLatchDir();
    await writeFile(path.join(dir, "quarantine-acct1.json"), "{not json", "utf8");
    const state = await getQuarantineLatchState({ dir, accountId: "acct1" });
    expect(state.quarantined).toBe(true);
    expect(state.record).toBeNull();
    expect(state.readError).toContain("not a valid quarantine record");
  });
});

describe("assertNotQuarantined", () => {
  test("passes when no latch exists", async () => {
    const dir = await tempLatchDir();
    await expect(assertNotQuarantined({ dir, accountId: "acct1" })).resolves.toBeUndefined();
  });

  test("throws the terminal non-retryable quarantine error while latched", async () => {
    const dir = await tempLatchDir();
    await tripQuarantineLatch({
      dir,
      accountId: "acct1",
      reason: "verification_interstitial",
      source: "pre-run-gate",
    });
    const rejection = expect(assertNotQuarantined({ dir, accountId: "acct1" })).rejects;
    await rejection.toBeInstanceOf(AccountQuarantinedError);
    await rejection.toMatchObject({
      details: {
        code: ACCOUNT_QUARANTINE_ERROR_CLASS,
        oracleErrorClass: "account_quarantine",
        retryable: false,
        reason: "verification_interstitial",
      },
    });

    const localError = new AccountQuarantinedError(
      await getQuarantineLatchState({ dir, accountId: "acct1" }),
    );
    expect(localError.message).not.toContain(dir);
    expect(localError.details).not.toHaveProperty("latchPath");
  });
});

describe("clearQuarantineLatchManually", () => {
  test("manual clear restores the worker", async () => {
    const dir = await tempLatchDir();
    await tripQuarantineLatch({
      dir,
      accountId: "acct1",
      reason: "verification_interstitial",
      source: "pre-run-gate",
    });
    const cleared = await clearQuarantineLatchManually({ dir, accountId: "acct1" });
    expect(cleared.cleared).toBe(true);
    const state = await getQuarantineLatchState({ dir, accountId: "acct1" });
    expect(state.quarantined).toBe(false);
    await expect(assertNotQuarantined({ dir, accountId: "acct1" })).resolves.toBeUndefined();
  });

  test("clearing an absent latch reports cleared: false", async () => {
    const dir = await tempLatchDir();
    const cleared = await clearQuarantineLatchManually({ dir, accountId: "acct1" });
    expect(cleared.cleared).toBe(false);
  });
});

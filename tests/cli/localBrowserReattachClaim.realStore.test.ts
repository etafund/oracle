import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  claimLocalBrowserReattachCompletion,
  ownsLocalBrowserReattachCompletion,
} from "../../src/cli/localBrowserReattachClaim.js";
import { setOracleHomeDirOverrideForTest } from "../../src/oracleHome.js";
import type { SessionMetadata } from "../../src/sessionManager.js";
import { sessionStore } from "../../src/sessionStore.js";

let oracleHome: string;

beforeEach(async () => {
  oracleHome = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-local-claim-real-store-"));
  setOracleHomeDirOverrideForTest(oracleHome);
  await sessionStore.ensureStorage();
});

afterEach(async () => {
  setOracleHomeDirOverrideForTest(null);
  await fs.rm(oracleHome, { recursive: true, force: true });
});

describe("local browser reattach claim against the file session store", () => {
  test("owns the persisted generation across a meta-first terminal crash gap", async () => {
    const created = await sessionStore.createSession(
      {
        prompt: "meta-first local recovery claim",
        model: "gpt-5.2-pro",
        mode: "browser",
      },
      "/tmp/cwd",
    );
    await sessionStore.updateModelRun(created.id, "gpt-5.2-pro", {
      status: "running",
      startedAt: "2026-07-24T00:00:00.000Z",
    });

    // Simulate a crash after the failure writer publishes meta.json but
    // before its sequential model-file projection. The tolerant reader
    // exposes the reconciled error model, while the claim updater receives
    // the raw running model and the generic writer normalizes it on commit.
    const paths = await sessionStore.getPaths(created.id);
    const raw = JSON.parse(await fs.readFile(paths.metadata, "utf8")) as SessionMetadata;
    await fs.writeFile(
      paths.metadata,
      JSON.stringify(
        {
          ...raw,
          status: "error",
          completedAt: "2026-07-24T00:01:00.000Z",
          errorMessage: "capture interrupted",
          response: {
            status: "incomplete",
            incompleteReason: "incomplete-capture",
          },
        } satisfies SessionMetadata,
        null,
        2,
      ),
      "utf8",
    );

    const reconciled = await sessionStore.readSession(created.id);
    expect(reconciled?.models?.[0]?.status).toBe("error");

    const claim = await claimLocalBrowserReattachCompletion(reconciled!);
    const persisted = await sessionStore.readSession(created.id);

    expect(claim).not.toBeNull();
    expect(persisted?.models?.[0]?.status).toBe("error");
    expect(ownsLocalBrowserReattachCompletion(persisted!, claim!)).toBe(true);
  });
});

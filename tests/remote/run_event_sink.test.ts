import { afterEach, describe, expect, test } from "vitest";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import {
  appendOracleRunEvent,
  classifyRunErrorClass,
  RUN_EVENT_GENESIS_HASH,
  RUN_EVENT_SCHEMA_VERSION,
  type OracleRunEventInput,
} from "../../src/remote/run_event_sink.js";
import { canonicalJSON, sha256OfBytes } from "../../src/oracle/v18/evidence.js";
import { createRemoteServer } from "../../src/remote/server.js";
import type { BrowserRunResult } from "../../src/browserMode.js";

// oracle.run.v1 sanitized JSONL sink: exactly one hash-chained line per
// ACCEPTED /runs (success, failure, abort). Field names are normative; a
// field with no value is null, never omitted. The sink is the sanctioned
// metrics source — no token values, no prompt text, no raw attachment names,
// hashed conversation ids only.

const CAN_LISTEN_LOCALHOST =
  spawnSync(
    process.execPath,
    [
      "-e",
      `
      const net = require('net');
      const s = net.createServer();
      s.on('error', () => process.exit(1));
      s.listen(0, '127.0.0.1', () => s.close(() => process.exit(0)));
    `,
    ],
    { stdio: "ignore" },
  ).status === 0;

// Normative field order-independent key set (identity contract §oracle.run.v1
// plus the sink's chain fields).
const NORMATIVE_KEYS = [
  "schema",
  "sequence",
  "run_id",
  "job_id",
  "account_id",
  "lane_id",
  "port",
  "accepted_at",
  "submitted_at",
  "first_token_at",
  "completed_at",
  "scheduled_concurrency",
  "active_tab_leases",
  "busy_workers",
  "error_class",
  "done_ok",
  "challenge_detected",
  "model_verified",
  "max_active_before_first_token",
  "mean_active_during_ttft",
  "max_active_during_generation",
  "overlap_ms_at_c1",
  "overlap_ms_at_c2",
  "overlap_ms_at_c3",
  "observed_egress_ip",
  "attachments",
  "conversation_id_hash",
  "provenance",
  "prev_hash",
  "entry_hash",
].sort();

const savedEnv = process.env.ORACLE_RUN_EVENTS_DIR;
const tempDirs: string[] = [];

afterEach(async () => {
  if (savedEnv === undefined) {
    delete process.env.ORACLE_RUN_EVENTS_DIR;
  } else {
    process.env.ORACLE_RUN_EVENTS_DIR = savedEnv;
  }
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop()!, { recursive: true, force: true });
  }
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function minimalInput(overrides: Partial<OracleRunEventInput> = {}): OracleRunEventInput {
  return {
    run_id: "11111111-1111-4111-8111-111111111111",
    job_id: null,
    account_id: "acct1",
    lane_id: "acct1-9473",
    port: 9473,
    accepted_at: "2026-07-03T00:00:00.000Z",
    submitted_at: null,
    first_token_at: null,
    completed_at: "2026-07-03T00:01:00.000Z",
    scheduled_concurrency: null,
    active_tab_leases: null,
    busy_workers: null,
    error_class: null,
    done_ok: true,
    challenge_detected: null,
    model_verified: null,
    max_active_before_first_token: null,
    mean_active_during_ttft: null,
    max_active_during_generation: null,
    overlap_ms_at_c1: null,
    overlap_ms_at_c2: null,
    overlap_ms_at_c3: null,
    observed_egress_ip: null,
    attachments: null,
    conversation_id_hash: null,
    provenance: null,
    ...overrides,
  };
}

describe("oracle.run.v1 sink", () => {
  test("golden line: normative key set, genesis chain boot, verifiable entry hash", async () => {
    const dir = await tempDir("oracle-run-sink-");
    const filePath = path.join(dir, "events.jsonl");
    const { entry } = await appendOracleRunEvent(minimalInput(), { filePath });

    const raw = await readFile(filePath, "utf8");
    const lines = raw.split("\n").filter((line) => line.trim().length > 0);
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!) as Record<string, unknown>;

    expect(Object.keys(parsed).sort()).toEqual(NORMATIVE_KEYS);
    expect(parsed.schema).toBe(RUN_EVENT_SCHEMA_VERSION);
    expect(parsed.sequence).toBe(0);
    expect(parsed.prev_hash).toBe(RUN_EVENT_GENESIS_HASH);
    // Null-not-omit: unknowns are literal nulls in the serialized line.
    expect(parsed.submitted_at).toBeNull();
    expect(parsed.overlap_ms_at_c3).toBeNull();

    // The entry hash is recomputable from the canonical entry minus itself.
    const { entry_hash, ...rest } = parsed;
    expect(entry_hash).toBe(sha256OfBytes(canonicalJSON(rest)));
    expect(entry.entry_hash).toBe(entry_hash);
  });

  test("appends chain: prev_hash links to the previous entry_hash", async () => {
    const dir = await tempDir("oracle-run-sink-");
    const filePath = path.join(dir, "events.jsonl");
    const first = await appendOracleRunEvent(minimalInput(), { filePath });
    const second = await appendOracleRunEvent(
      minimalInput({ run_id: "22222222-2222-4222-8222-222222222222", done_ok: false }),
      { filePath },
    );
    expect(second.entry.sequence).toBe(1);
    expect(second.entry.prev_hash).toBe(first.entry.entry_hash);
  });

  test("refuses to write a line containing forbidden secret material", async () => {
    const dir = await tempDir("oracle-run-sink-");
    const filePath = path.join(dir, "events.jsonl");
    await expect(
      appendOracleRunEvent(minimalInput({ job_id: "job-with-super-secret-token" }), {
        filePath,
        assertAbsent: ["super-secret-token"],
      }),
    ).rejects.toThrow(/forbidden secret material/);
    await expect(readFile(filePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("classifyRunErrorClass: heuristic typed classes", () => {
    expect(classifyRunErrorClass(null, true)).toBeNull();
    expect(classifyRunErrorClass("answer binding failed", true)).toBe("integrity_binding_failed");
    expect(classifyRunErrorClass("challenge interstitial shown", true)).toBe(
      "account_quarantine",
    );
    expect(classifyRunErrorClass("socket hang up", false)).toBe(
      "transport_interrupted_before_submit",
    );
    expect(classifyRunErrorClass("socket hang up", true)).toBe(
      "transport_interrupted_after_submit",
    );
  });
});

describe("serve emits one sink line per accepted run", () => {
  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "success, failure, and refusals: accepted runs emit; refusals do not; no token leaks",
    async () => {
      const sinkDir = await tempDir("oracle-run-sink-e2e-");
      process.env.ORACLE_RUN_EVENTS_DIR = sinkDir;
      const token = "sink-e2e-bearer-secret-51f2";

      let call = 0;
      const server = await createRemoteServer(
        {
          host: "127.0.0.1",
          port: 0,
          token,
          logger: () => {},
          attachOnly: false,
        },
        {
          runBrowser: async (options) => {
            call += 1;
            if (call === 2) {
              throw new Error("simulated transport interruption");
            }
            // Send-confirmation marker feeds submitted_at + census-at-submit.
            options.log?.("Submitted prompt via Enter key");
            await new Promise((resolve) => setTimeout(resolve, 40));
            // Streaming heartbeat marks first answer output (first_token_at).
            options.log?.(
              "[browser] ChatGPT thinking - 12s elapsed; status=response streaming; source=inline",
            );
            await new Promise((resolve) => setTimeout(resolve, 35));
            const result: BrowserRunResult = {
              answerText: "ok",
              answerMarkdown: "ok",
              tookMs: 5,
              answerTokens: 1,
              answerChars: 2,
              conversationId: "conv-123",
              modelSelection: {
                requestedModel: "Pro",
                resolvedLabel: "Extended Pro",
                strategy: "select",
                status: "already-selected",
                verified: true,
                source: "chatgpt-model-picker",
                capturedAt: "2026-07-03T00:00:00.000Z",
              },
            };
            return result;
          },
        },
      );

      try {
        const okRun = await postRun(
          server.port,
          token,
          validPayload({ jobId: "canary-007", scheduledConcurrency: 2 }),
        );
        expect(okRun.statusCode).toBe(200);
        const failedRun = await postRun(server.port, token, validPayload({}));
        expect(failedRun.statusCode).toBe(200); // failure arrives as an error event

        // Refusals must NOT emit sink lines.
        const unauthorized = await postRun(server.port, "wrong-token", validPayload({}));
        expect(unauthorized.statusCode).toBe(401);
        const invalid = await postRun(server.port, token, "not json");
        expect(invalid.statusCode).toBe(400);

        const files = await readdir(sinkDir);
        expect(files).toHaveLength(1);
        expect(files[0]).toMatch(/^oracle-run-events-acct1-\d+\.jsonl$/);
        const raw = await readFile(path.join(sinkDir, files[0]!), "utf8");

        // Secret hygiene: the shared bearer token never lands in the sink.
        expect(raw).not.toContain(token);
        // No prompt text, no raw attachment/conversation identifiers.
        expect(raw).not.toContain("sink test prompt");
        expect(raw).not.toContain("conv-123");

        const lines = raw
          .split("\n")
          .filter((line) => line.trim().length > 0)
          .map((line) => JSON.parse(line) as Record<string, unknown>);
        expect(lines).toHaveLength(2);

        const okLine = lines[0]!;
        expect(okLine.run_id).toBe(okRun.headers["x-oracle-run-id"]);
        expect(okLine.job_id).toBe("canary-007");
        expect(okLine.account_id).toBe("acct1");
        expect(okLine.lane_id).toBe(`acct1-${server.port}`);
        expect(okLine.port).toBe(server.port);
        expect(okLine.done_ok).toBe(true);
        expect(okLine.error_class).toBeNull();
        expect(okLine.model_verified).toBe(true);
        expect(okLine.conversation_id_hash).toBe(
          createHash("sha256").update("conv-123").digest("hex"),
        );
        expect(okLine.provenance).toEqual({
          model_requested: "Pro",
          model_resolved: "Extended Pro",
          model_verified: true,
        });
        // Timestamp ordering invariants:
        // accepted <= submitted <= first_token <= completed.
        expect(typeof okLine.accepted_at).toBe("string");
        expect(typeof okLine.submitted_at).toBe("string");
        expect(typeof okLine.first_token_at).toBe("string");
        expect(typeof okLine.completed_at).toBe("string");
        expect(String(okLine.accepted_at) <= String(okLine.submitted_at)).toBe(true);
        expect(String(okLine.submitted_at) <= String(okLine.first_token_at)).toBe(true);
        expect(String(okLine.first_token_at) <= String(okLine.completed_at)).toBe(true);
        // Scheduler-supplied concurrency bucket round-trips verbatim.
        expect(okLine.scheduled_concurrency).toBe(2);
        expect([0, null]).toContain(okLine.active_tab_leases);

        const failLine = lines[1]!;
        expect(failLine.run_id).toBe(failedRun.headers["x-oracle-run-id"]);
        expect(failLine.done_ok).toBe(false);
        expect(failLine.error_class).toBe("transport_interrupted_before_submit");
        expect(failLine.submitted_at).toBeNull();
        // No streamed output and no scheduler bucket => nulls preserved.
        expect(failLine.first_token_at).toBeNull();
        expect(failLine.scheduled_concurrency).toBeNull();
        expect(failLine.prev_hash).toBe(okLine.entry_hash);
      } finally {
        await server.close();
      }
    },
  );

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "a client abort mid-run still emits the run's sink line",
    async () => {
      const sinkDir = await tempDir("oracle-run-sink-abort-");
      process.env.ORACLE_RUN_EVENTS_DIR = sinkDir;

      let releaseRun: ((result: BrowserRunResult) => void) | undefined;
      let markStarted: () => void = () => {};
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      const finished = new Promise<BrowserRunResult>((resolve) => {
        releaseRun = resolve;
      });
      const server = await createRemoteServer(
        { host: "127.0.0.1", port: 0, token: "secret", logger: () => {}, attachOnly: false },
        {
          runBrowser: async () => {
            markStarted();
            return await finished;
          },
        },
      );

      const active = startAbortableRun(server.port, "secret");
      void active.finished.catch(() => undefined);
      try {
        await started;
        active.abort();
        releaseRun?.({
          answerText: "ok",
          answerMarkdown: "ok",
          tookMs: 1,
          answerTokens: 1,
          answerChars: 2,
        });
        await active.finished.catch(() => undefined);

        // The sink line lands from the run's finally even though the caller
        // disconnected before completion.
        const files = await waitForFiles(sinkDir);
        const raw = await readFile(path.join(sinkDir, files[0]!), "utf8");
        const lines = raw.split("\n").filter((line) => line.trim().length > 0);
        expect(lines).toHaveLength(1);
        const line = JSON.parse(lines[0]!) as Record<string, unknown>;
        expect(line.done_ok).toBe(true);
        expect(typeof line.completed_at).toBe("string");
      } finally {
        await server.close();
      }
    },
  );
});

function validPayload(options: Record<string, unknown>): string {
  return JSON.stringify({
    prompt: "sink test prompt",
    attachments: [],
    browserConfig: {},
    options,
  });
}

async function waitForFiles(dir: string, timeoutMs = 3000): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const files = await readdir(dir).catch(() => [] as string[]);
    if (files.length > 0) {
      return files;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("sink directory stayed empty");
}

interface RunResponse {
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

async function postRun(port: number, token: string, body: string): Promise<RunResponse> {
  return await new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/runs",
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
      },
      (res) => {
        res.setEncoding("utf8");
        let responseBody = "";
        res.on("data", (chunk: string) => {
          responseBody += chunk;
        });
        const settle = () =>
          resolve({ statusCode: res.statusCode ?? 0, headers: res.headers, body: responseBody });
        res.on("end", settle);
        res.on("close", settle);
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function startAbortableRun(
  port: number,
  token: string,
): { abort(): void; finished: Promise<RunResponse> } {
  const body = JSON.stringify({ prompt: "hold", attachments: [], browserConfig: {}, options: {} });
  let req: http.ClientRequest | undefined;
  const finished = new Promise<RunResponse>((resolve, reject) => {
    req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/runs",
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
      },
      (res) => {
        res.setEncoding("utf8");
        let responseBody = "";
        res.on("data", (chunk: string) => {
          responseBody += chunk;
        });
        const settle = () =>
          resolve({ statusCode: res.statusCode ?? 0, headers: res.headers, body: responseBody });
        res.on("end", settle);
        res.on("close", settle);
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
  return {
    abort() {
      req?.destroy();
    },
    finished,
  };
}

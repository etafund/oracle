import { afterEach, describe, expect, test } from "vitest";
import { createHash } from "node:crypto";
import http from "node:http";
import { spawnSync } from "node:child_process";
import {
  createRemoteServer,
  isServeModelLabelAllowed,
  isServeModelStrategyAllowed,
  resolveServeAllowedModelLabels,
} from "../../src/remote/server.js";
import type { BrowserRunResult } from "../../src/browserMode.js";
import {
  REMOTE_BROWSER_RECOVERY_ADMISSION_HEADER_VALUES,
  REMOTE_BROWSER_RUN_PATH,
} from "../../src/remote/types.js";
import {
  primarySubmissionProvenance,
  verifiedSolProModelSelection,
} from "./_submissionProvenanceFixture.js";

// FLEET TRUST BOUNDARY: the serve /runs handler validates the effective desired
// model label BEFORE staging attachments or flipping `busy`, so a disallowed
// model is refused (422 model_not_allowed) without consuming a browser slot or
// touching the filesystem. The browser fleet serves ONLY GPT-5.6 Sol + Pro:
// up-to-date clients send the model label "GPT-5.6 Sol". An absent label or
// the historical bare baseline "Pro" is canonicalized to that exact model,
// select strategy, and extended/Pro thinking before browser execution. Every
// legacy versioned Pro label fails closed, and an environment override cannot
// expand this fixed fleet contract.

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

const MINIMAL_RESULT: BrowserRunResult = {
  answerText: "ok",
  answerMarkdown: "ok",
  tookMs: 1,
  answerTokens: 1,
  answerChars: 2,
  submissionProvenance: primarySubmissionProvenance("p"),
  modelSelection: verifiedSolProModelSelection(),
};

describe("serve model-label allow-list helpers", () => {
  test("default allow-list is the worker's own baseline label", () => {
    expect(resolveServeAllowedModelLabels("Pro", {})).toEqual(["Pro"]);
    expect(resolveServeAllowedModelLabels("Gemini 3.1 Pro", {})).toEqual(["Gemini 3.1 Pro"]);
    expect(resolveServeAllowedModelLabels(undefined, {})).toEqual([]);
  });

  test("the environment parser returns exact, trimmed labels for startup validation", () => {
    expect(
      resolveServeAllowedModelLabels("Pro", {
        ORACLE_SERVE_ALLOWED_MODEL_LABELS: "GPT-5.5 Pro, GPT-5.5 ,  ",
      }),
    ).toEqual(["GPT-5.5 Pro", "GPT-5.5"]);
    // A blank override falls back to the baseline.
    expect(
      resolveServeAllowedModelLabels("Pro", { ORACLE_SERVE_ALLOWED_MODEL_LABELS: "   ,  " }),
    ).toEqual(["Pro"]);
  });

  test("admits the served ChatGPT model and the baseline; refuses legacy labels", () => {
    // Current fleet: baseline label is the bare mode "Pro".
    expect(isServeModelLabelAllowed("GPT-5.6 Sol", ["Pro"])).toBe(true); // client-sent label
    expect(isServeModelLabelAllowed("gpt-5.6 sol", ["Pro"])).toBe(true); // case-insensitive
    expect(isServeModelLabelAllowed("Pro", ["Pro"])).toBe(true); // baseline fallback
    expect(isServeModelLabelAllowed("GPT-5.5 Pro", ["Pro"])).toBe(false);
    expect(isServeModelLabelAllowed("GPT-5.5", ["Pro"])).toBe(false);
    expect(isServeModelLabelAllowed("GPT-5.4 Pro", ["Pro"])).toBe(false);
    expect(isServeModelLabelAllowed("totally-made-up", ["Pro"])).toBe(false);
    expect(isServeModelLabelAllowed("", ["Pro"])).toBe(false);
  });

  test("the low-level matcher recognizes parsed labels while Sol remains the fleet floor", () => {
    const allowed = ["GPT-5.5 Pro"];
    expect(isServeModelLabelAllowed("GPT-5.5 Pro", allowed)).toBe(true);
    expect(isServeModelLabelAllowed("GPT-5.6 Sol", allowed)).toBe(true);
    expect(isServeModelLabelAllowed("GPT-5.5", allowed)).toBe(false);
  });
});

describe("serve model-strategy allow-list helper", () => {
  test('refuses "ignore" and "current"; admits "select" and an absent strategy', () => {
    // "ignore" skips model selection; "current" submits on whatever model is
    // loaded — both bypass atomic verification and fail closed (any case/space).
    expect(isServeModelStrategyAllowed("ignore")).toBe(false);
    expect(isServeModelStrategyAllowed("current")).toBe(false);
    expect(isServeModelStrategyAllowed("  Ignore ")).toBe(false);
    expect(isServeModelStrategyAllowed("CURRENT")).toBe(false);
    // "select" is the only fleet-admissible explicit strategy.
    expect(isServeModelStrategyAllowed("select")).toBe(true);
    // Absent/undefined (and any non-string) defaults to "select" downstream.
    expect(isServeModelStrategyAllowed(undefined)).toBe(true);
    expect(isServeModelStrategyAllowed(null)).toBe(true);
    expect(isServeModelStrategyAllowed(5)).toBe(true);
  });
});

const savedAllowedLabels = process.env.ORACLE_SERVE_ALLOWED_MODEL_LABELS;

afterEach(() => {
  if (savedAllowedLabels === undefined) {
    delete process.env.ORACLE_SERVE_ALLOWED_MODEL_LABELS;
  } else {
    process.env.ORACLE_SERVE_ALLOWED_MODEL_LABELS = savedAllowedLabels;
  }
});

async function startServer(
  runs: { count: number },
  seenConfigs: Array<Record<string, unknown>> = [],
) {
  return await createRemoteServer(
    { host: "127.0.0.1", port: 0, token: "secret", logger: () => {}, attachOnly: false },
    {
      runBrowser: async (options) => {
        runs.count += 1;
        seenConfigs.push({ ...(options.config as Record<string, unknown>) });
        return MINIMAL_RESULT;
      },
    },
  );
}

describe("serve model gate (/runs admission)", () => {
  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "canonicalizes the served Sol label, an absent label, and bare Pro to the fixed route",
    async () => {
      const runs = { count: 0 };
      const seenConfigs: Array<Record<string, unknown>> = [];
      const server = await startServer(runs, seenConfigs);
      try {
        const sol = await sendRun(server.port, "secret", {
          prompt: "p",
          attachments: [],
          browserConfig: { desiredModel: "GPT-5.6 Sol" },
          options: {},
        });
        expect(sol.statusCode).toBe(200);
        expect(runs.count).toBe(1);

        // No desiredModel -> canonical fixed-fleet route.
        const baseline = await sendRun(server.port, "secret", {
          prompt: "p",
          attachments: [],
          browserConfig: {},
          options: {},
        });
        expect(baseline.statusCode).toBe(200);
        expect(runs.count).toBe(2);

        const barePro = await sendRun(server.port, "secret", {
          prompt: "p",
          attachments: [],
          browserConfig: { desiredModel: "Pro" },
          options: {},
        });
        expect(barePro.statusCode).toBe(200);
        expect(runs.count).toBe(3);
        for (const config of seenConfigs) {
          expect(config).toMatchObject({
            desiredModel: "GPT-5.6 Sol",
            modelStrategy: "select",
            thinkingTime: "extended",
          });
        }
      } finally {
        await server.close();
      }
    },
  );

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "refuses a legacy Pro label with a typed 422 before consuming a slot",
    async () => {
      const runs = { count: 0 };
      const server = await startServer(runs);
      try {
        const refused = await sendRun(server.port, "secret", {
          prompt: "p",
          attachments: [],
          browserConfig: { desiredModel: "GPT-5.5 Pro" },
          options: {},
        });
        expect(refused.statusCode).toBe(422);
        const body = JSON.parse(refused.body) as Record<string, unknown>;
        expect(body.error).toBe("model_not_allowed");
        expect(body.errorClass).toBe("model_not_allowed");
        expect(body.retryable).toBe(false);
        expect(String(body.message)).toContain("serves only GPT-5.6 Sol + Pro");
        expect(String(body.message)).toContain("GPT-5.5 Pro");
        expect(String(body.message)).toContain("--engine api");
        expect(body.runId).toBe(refused.headers["x-oracle-run-id"]);
        // The browser was never consulted.
        expect(runs.count).toBe(0);

        // `busy` was never consumed: the worker still admits a valid run.
        const accepted = await sendRun(server.port, "secret", {
          prompt: "p",
          attachments: [],
          browserConfig: { desiredModel: "GPT-5.6 Sol" },
          options: {},
        });
        expect(accepted.statusCode).toBe(200);
        expect(runs.count).toBe(1);
      } finally {
        await server.close();
      }
    },
  );

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "refuses other legacy and arbitrary labels the same way",
    async () => {
      const runs = { count: 0 };
      const server = await startServer(runs);
      try {
        for (const label of ["GPT-5.5", "GPT-5.4 Pro", "gpt-5-pro", "totally-made-up"]) {
          const refused = await sendRun(server.port, "secret", {
            prompt: "p",
            attachments: [],
            browserConfig: { desiredModel: label },
            options: {},
          });
          expect(refused.statusCode, `label ${label}`).toBe(422);
          expect((JSON.parse(refused.body) as Record<string, unknown>).error).toBe(
            "model_not_allowed",
          );
        }
        expect(runs.count).toBe(0);
      } finally {
        await server.close();
      }
    },
  );

  test.skipIf(!CAN_LISTEN_LOCALHOST)("the model gate runs BEFORE attachment staging", async () => {
    const runs = { count: 0 };
    const server = await startServer(runs);
    try {
      // A disallowed model plus a valid attachment must still be rejected at
      // the model gate before staging or browser execution.
      const content = Buffer.from("valid attachment bytes");
      const refused = await sendRun(server.port, "secret", {
        prompt: "p",
        attachments: [
          {
            fileName: "notes.txt",
            displayPath: "notes.txt",
            sizeBytes: content.length,
            sha256: createHash("sha256").update(content).digest("hex"),
            generatedBundle: false,
            contentBase64: content.toString("base64"),
          },
        ],
        browserConfig: { desiredModel: "GPT-5.5 Pro" },
        options: {},
      });
      expect(refused.statusCode).toBe(422);
      expect((JSON.parse(refused.body) as Record<string, unknown>).error).toBe("model_not_allowed");
      expect(runs.count).toBe(0);

      // Still ready afterwards.
      const accepted = await sendRun(server.port, "secret", {
        prompt: "p",
        attachments: [],
        browserConfig: { desiredModel: "GPT-5.6 Sol" },
        options: {},
      });
      expect(accepted.statusCode).toBe(200);
      expect(runs.count).toBe(1);
    } finally {
      await server.close();
    }
  });

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "refuses an environment override that would widen the fixed fleet",
    async () => {
      process.env.ORACLE_SERVE_ALLOWED_MODEL_LABELS = "GPT-5.5 Pro";
      const runs = { count: 0 };
      await expect(startServer(runs)).rejects.toThrow(
        /only supports GPT-5\.6 Sol \+ Pro.*GPT-5\.5 Pro/i,
      );
      expect(runs.count).toBe(0);
    },
  );
});

describe("serve model-strategy gate (/runs admission)", () => {
  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    'admits modelStrategy "select" and an absent strategy',
    async () => {
      const runs = { count: 0 };
      const server = await startServer(runs);
      try {
        // Explicit "select" -> atomic model+mode verification, admitted.
        const select = await sendRun(server.port, "secret", {
          prompt: "p",
          attachments: [],
          browserConfig: { desiredModel: "GPT-5.6 Sol", modelStrategy: "select" },
          options: {},
        });
        expect(select.statusCode).toBe(200);
        expect(runs.count).toBe(1);

        // No modelStrategy -> defaults to "select" downstream, admitted (even
        // with the baseline "Pro" desiredModel that the label gate allows).
        const absent = await sendRun(server.port, "secret", {
          prompt: "p",
          attachments: [],
          browserConfig: { desiredModel: "Pro" },
          options: {},
        });
        expect(absent.statusCode).toBe(200);
        expect(runs.count).toBe(2);
      } finally {
        await server.close();
      }
    },
  );

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    'refuses modelStrategy "ignore" with a typed 422 before consuming a slot',
    async () => {
      const runs = { count: 0 };
      const server = await startServer(runs);
      try {
        // The exact bypass: a baseline "Pro" desiredModel (which the label gate
        // MUST keep admitting) paired with "ignore" would skip model selection
        // and submit UNVERIFIED. The strategy gate fails it closed.
        const refused = await sendRun(server.port, "secret", {
          prompt: "p",
          attachments: [],
          browserConfig: { desiredModel: "Pro", modelStrategy: "ignore" },
          options: {},
        });
        expect(refused.statusCode).toBe(422);
        const body = JSON.parse(refused.body) as Record<string, unknown>;
        expect(body.error).toBe("model_strategy_not_allowed");
        expect(body.errorClass).toBe("model_strategy_not_allowed");
        expect(body.retryable).toBe(false);
        expect(String(body.message)).toBe(
          'this browser worker requires modelStrategy "select" (atomic model+mode verification); modelStrategy "ignore" is not allowed on the fleet',
        );
        expect(body.runId).toBe(refused.headers["x-oracle-run-id"]);
        // The browser was never consulted.
        expect(runs.count).toBe(0);

        // `busy` was never consumed: the worker still admits a valid run.
        const accepted = await sendRun(server.port, "secret", {
          prompt: "p",
          attachments: [],
          browserConfig: { desiredModel: "GPT-5.6 Sol", modelStrategy: "select" },
          options: {},
        });
        expect(accepted.statusCode).toBe(200);
        expect(runs.count).toBe(1);
      } finally {
        await server.close();
      }
    },
  );

  test.skipIf(!CAN_LISTEN_LOCALHOST)('refuses modelStrategy "current" the same way', async () => {
    const runs = { count: 0 };
    const server = await startServer(runs);
    try {
      const refused = await sendRun(server.port, "secret", {
        prompt: "p",
        attachments: [],
        browserConfig: { desiredModel: "GPT-5.6 Sol", modelStrategy: "current" },
        options: {},
      });
      expect(refused.statusCode).toBe(422);
      const body = JSON.parse(refused.body) as Record<string, unknown>;
      expect(body.error).toBe("model_strategy_not_allowed");
      expect(String(body.message)).toContain('modelStrategy "current" is not allowed on the fleet');
      expect(runs.count).toBe(0);
    } finally {
      await server.close();
    }
  });

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "the model-strategy gate runs BEFORE attachment staging",
    async () => {
      const runs = { count: 0 };
      const server = await startServer(runs);
      try {
        // A disallowed strategy plus a valid attachment must still be rejected
        // at the strategy gate before staging or browser execution.
        const content = Buffer.from("valid attachment bytes");
        const refused = await sendRun(server.port, "secret", {
          prompt: "p",
          attachments: [
            {
              fileName: "notes.txt",
              displayPath: "notes.txt",
              sizeBytes: content.length,
              sha256: createHash("sha256").update(content).digest("hex"),
              generatedBundle: false,
              contentBase64: content.toString("base64"),
            },
          ],
          browserConfig: { desiredModel: "Pro", modelStrategy: "ignore" },
          options: {},
        });
        expect(refused.statusCode).toBe(422);
        expect((JSON.parse(refused.body) as Record<string, unknown>).error).toBe(
          "model_strategy_not_allowed",
        );
        expect(runs.count).toBe(0);

        // Still ready afterwards.
        const accepted = await sendRun(server.port, "secret", {
          prompt: "p",
          attachments: [],
          browserConfig: { desiredModel: "GPT-5.6 Sol", modelStrategy: "select" },
          options: {},
        });
        expect(accepted.statusCode).toBe(200);
        expect(runs.count).toBe(1);
      } finally {
        await server.close();
      }
    },
  );
});

interface RunResponse {
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

async function sendRun(port: number, token: string, payload: unknown): Promise<RunResponse> {
  const body = JSON.stringify(payload);
  return await new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: REMOTE_BROWSER_RUN_PATH,
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          ...REMOTE_BROWSER_RECOVERY_ADMISSION_HEADER_VALUES,
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

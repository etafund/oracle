import { afterEach, describe, expect, test } from "vitest";
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

// FLEET TRUST BOUNDARY: the serve /runs handler validates the effective desired
// model label BEFORE staging attachments or flipping `busy`, so a disallowed
// model is refused (422 model_not_allowed) without consuming a browser slot or
// touching the filesystem. The browser fleet serves ONLY GPT-5.6 Sol + Pro:
// up-to-date clients send the model label "GPT-5.6 Sol"; the ChatGPT baseline
// desiredModel is the bare mode label "Pro" (both denote the same served
// target). Every legacy Pro label (e.g. "GPT-5.5 Pro") fails closed. No silent
// remap/alias — the requested label is never rewritten. The allow-list is
// baseline-derived (so a future non-ChatGPT worker enforces its own baseline
// without a code change) and overridable via ORACLE_SERVE_ALLOWED_MODEL_LABELS.

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
};

describe("serve model-label allow-list helpers", () => {
  test("default allow-list is the worker's own baseline label", () => {
    expect(resolveServeAllowedModelLabels("Pro", {})).toEqual(["Pro"]);
    expect(resolveServeAllowedModelLabels("Gemini 3.1 Pro", {})).toEqual(["Gemini 3.1 Pro"]);
    expect(resolveServeAllowedModelLabels(undefined, {})).toEqual([]);
  });

  test("ORACLE_SERVE_ALLOWED_MODEL_LABELS overrides with exact, trimmed labels", () => {
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

  test("an env override admits its exact labels (Sol still admitted as the fleet floor)", () => {
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

async function startServer(runs: { count: number }) {
  return await createRemoteServer(
    { host: "127.0.0.1", port: 0, token: "secret", logger: () => {}, attachOnly: false },
    {
      runBrowser: async () => {
        runs.count += 1;
        return MINIMAL_RESULT;
      },
    },
  );
}

describe("serve model gate (/runs admission)", () => {
  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "admits the served Sol label and the baseline fallback",
    async () => {
      const runs = { count: 0 };
      const server = await startServer(runs);
      try {
        const sol = await sendRun(server.port, "secret", {
          prompt: "p",
          attachments: [],
          browserConfig: { desiredModel: "GPT-5.6 Sol" },
          options: {},
        });
        expect(sol.statusCode).toBe(200);
        expect(runs.count).toBe(1);

        // No desiredModel -> falls back to the worker baseline ("Pro"), admitted.
        const baseline = await sendRun(server.port, "secret", {
          prompt: "p",
          attachments: [],
          browserConfig: {},
          options: {},
        });
        expect(baseline.statusCode).toBe(200);
        expect(runs.count).toBe(2);
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
      // A disallowed model PLUS a deliberately size-mismatched attachment
      // (which staging would reject with attachment_size_mismatch/400). If the
      // model gate runs first, the response is model_not_allowed/422 instead —
      // proving no attachment is staged for a disallowed model.
      const refused = await sendRun(server.port, "secret", {
        prompt: "p",
        attachments: [
          {
            fileName: "notes.txt",
            displayPath: "notes.txt",
            sizeBytes: 5, // deliberately wrong
            contentBase64: Buffer.from("many more than five bytes").toString("base64"),
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
    "ORACLE_SERVE_ALLOWED_MODEL_LABELS override is honored at admission",
    async () => {
      process.env.ORACLE_SERVE_ALLOWED_MODEL_LABELS = "GPT-5.5 Pro";
      const runs = { count: 0 };
      const server = await startServer(runs);
      try {
        // The override admits its listed label...
        const overridden = await sendRun(server.port, "secret", {
          prompt: "p",
          attachments: [],
          browserConfig: { desiredModel: "GPT-5.5 Pro" },
          options: {},
        });
        expect(overridden.statusCode).toBe(200);
        expect(runs.count).toBe(1);

        // ...the served Sol label remains admitted...
        const sol = await sendRun(server.port, "secret", {
          prompt: "p",
          attachments: [],
          browserConfig: { desiredModel: "GPT-5.6 Sol" },
          options: {},
        });
        expect(sol.statusCode).toBe(200);
        expect(runs.count).toBe(2);

        // ...but a label outside the override is still refused.
        const refused = await sendRun(server.port, "secret", {
          prompt: "p",
          attachments: [],
          browserConfig: { desiredModel: "GPT-5.5" },
          options: {},
        });
        expect(refused.statusCode).toBe(422);
        expect(runs.count).toBe(2);
      } finally {
        await server.close();
      }
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
        // A disallowed strategy PLUS a deliberately size-mismatched attachment
        // (which staging would reject with attachment_size_mismatch/400). The
        // strategy gate runs first, so the response is
        // model_strategy_not_allowed/422 — proving no attachment is staged.
        const refused = await sendRun(server.port, "secret", {
          prompt: "p",
          attachments: [
            {
              fileName: "notes.txt",
              displayPath: "notes.txt",
              sizeBytes: 5, // deliberately wrong
              contentBase64: Buffer.from("many more than five bytes").toString("base64"),
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

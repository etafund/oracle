import { readFile, writeFile } from "node:fs/promises";

import { describe, expect, test } from "vitest";

import {
  buildAttachment,
  parseArgs,
  runRemoteFullResponseSmoke,
  selectConfiguredLanes,
  validateAnswer,
  type CommandResult,
  type RunCommandInput,
} from "../../scripts/remote-browser-full-response-smoke.ts";

function commandResult(overrides: Partial<CommandResult> = {}): CommandResult {
  return {
    exitCode: 0,
    signal: null,
    stdout: "",
    stderr: "",
    timedOut: false,
    elapsedMs: 25,
    ...overrides,
  };
}

describe("remote-browser-full-response-smoke script", () => {
  test("parses explicit lanes and validation thresholds", () => {
    const options = parseArgs([
      "--json",
      "--lane",
      "chatgpt-pro",
      "--lane",
      "gemini-deep-think",
      "--min-length",
      "1200",
      "--operational-implications",
      "4",
      "--timeout-seconds",
      "300",
      "--input-timeout-ms",
      "90000",
      "--slug-prefix",
      "Ops Smoke",
    ]);

    expect(options.json).toBe(true);
    expect(options.lanes).toEqual(["chatgpt-pro", "gemini-deep-think"]);
    expect(options.minLength).toBe(1200);
    expect(options.operationalImplications).toBe(4);
    expect(options.timeoutSeconds).toBe(300);
    expect(options.inputTimeoutMs).toBe(90_000);
    expect(options.slugPrefix).toBe("ops-smoke");
  });

  test("selects configured remote browser lanes from provider locks", () => {
    expect(
      selectConfiguredLanes(
        {
          status: "healthy",
          provider_locks: ["browser:shared-profile:chatgpt"],
        },
        { lanes: null, allBrowserLanes: false },
      ),
    ).toEqual(["chatgpt-pro"]);

    expect(
      selectConfiguredLanes(
        {
          status: "healthy",
          provider_locks: ["browser:shared-profile:chatgpt", "browser:shared-profile:gemini"],
        },
        { lanes: null, allBrowserLanes: false },
      ),
    ).toEqual(["chatgpt-pro", "gemini-deep-think"]);
  });

  test("validates marker, attachment checksum, sentinel, length, and implication count", () => {
    const marker = "ORACLE_REMOTE_SMOKE_MARKER_TEST";
    const sentinel = "ORACLE_REMOTE_SMOKE_SENTINEL_TEST";
    const attachment = buildAttachment(marker, sentinel);
    const answer = [
      `- Smoke marker: ${marker}`,
      `- Attachment checksum: ${attachment.checksum}`,
      `- Attachment sentinel: ${sentinel}`,
      "Operational implication: The remote browser lane can read uploaded attachments.",
      "Operational implication: The output capture path preserves full Markdown responses.",
      "Operational implication: CI can fail on missing response evidence.",
      "Smoke result: pass.",
      "Additional response body ".repeat(20),
    ].join("\n");

    expect(
      validateAnswer(answer, {
        marker,
        sentinel,
        checksum: attachment.checksum,
        minLength: 200,
        operationalImplications: 3,
      }),
    ).toMatchObject({
      pass: true,
      operationalImplicationCount: 3,
      missing: [],
    });

    expect(
      validateAnswer(`- Smoke marker: ${marker}`, {
        marker,
        sentinel,
        checksum: attachment.checksum,
        minLength: 200,
        operationalImplications: 3,
      }).missing,
    ).toEqual(["checksum", "sentinel", "minLength", "operationalImplications"]);
  });

  test("runs a configured lane through the CLI with remote-required attachment flags", async () => {
    const calls: RunCommandInput[] = [];
    const runCommand = async (input: RunCommandInput): Promise<CommandResult> => {
      calls.push(input);
      if (input.args.includes("remote") && input.args.includes("doctor")) {
        return commandResult({
          stdout: JSON.stringify({
            _schema: "remote_browser_endpoint.v1",
            status: "healthy",
            endpoint_id: "endpoint-hash",
            mode: "required",
            host_env: "ORACLE_REMOTE_HOST",
            token_env: "ORACLE_REMOTE_TOKEN",
            host_hash: "host-hash",
            auth_profile_id_hash: "auth-hash",
            provider_locks: ["browser:shared-profile:chatgpt"],
            version: "1.2.3",
            uptimeSeconds: 42,
          }),
        });
      }

      expect(input.args).toEqual(
        expect.arrayContaining([
          "--lane",
          "chatgpt-pro",
          "--remote-browser",
          "required",
          "--browser-attachments",
          "always",
          "--write-output",
        ]),
      );

      const outputPath = valueAfter(input.args, "--write-output");
      const attachmentPath = valueAfter(input.args, "--file");
      const attachment = await readFile(attachmentPath, "utf8");
      const marker = requiredMatch(attachment, /^marker=(.+)$/mu);
      const sentinel = requiredMatch(attachment, /^sentinel=(.+)$/mu);
      const checksum = requiredMatch(attachment, /^payload_sha256=(.+)$/mu);
      const answer = [
        `- Smoke marker: ${marker}`,
        `- Attachment checksum: ${checksum}`,
        `- Attachment sentinel: ${sentinel}`,
        "Operational implication: The remote browser lane accepted the generated attachment.",
        "Operational implication: The answer path returned enough prose for full-response capture.",
        "Smoke result: pass.",
        "Full response filler ".repeat(12),
      ].join("\n");
      await writeFile(outputPath, answer, "utf8");
      return commandResult({
        stdout: "🧿 oracle (0.0.0) remote smoke\noracle session smoke-session-123\n",
        elapsedMs: 123,
      });
    };

    const options = parseArgs([
      "--min-length",
      "100",
      "--operational-implications",
      "2",
      "--oracle-bin",
      "oracle",
      "--token-env",
      "ORACLE_TEST_REMOTE_TOKEN",
    ]);
    const report = await runRemoteFullResponseSmoke(options, {
      runCommand,
      now: fixedClock(),
      randomBytes: (size) => Buffer.alloc(size, 7),
      env: {
        ORACLE_REMOTE_HOST: "remote.example:9473",
        ORACLE_TEST_REMOTE_TOKEN: "super-secret-token",
      },
    });

    expect(report.status).toBe("pass");
    expect(report.remote).toMatchObject({
      status: "healthy",
      endpoint_id: "endpoint-hash",
      provider_locks: ["browser:shared-profile:chatgpt"],
    });
    expect(report.lanes).toHaveLength(1);
    expect(report.lanes[0]).toMatchObject({
      lane: "chatgpt-pro",
      status: "pass",
      session_id: "smoke-session-123",
      command_exit_code: 0,
      operational_implication_count: 2,
      missing: [],
    });
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.env.ORACLE_REMOTE_TOKEN === "super-secret-token")).toBe(true);
    expect(JSON.stringify(report)).not.toContain("super-secret-token");
  });
});

function valueAfter(args: readonly string[], flag: string): string {
  const index = args.indexOf(flag);
  if (index < 0 || !args[index + 1]) {
    throw new Error(`Missing ${flag} value in ${args.join(" ")}`);
  }
  return args[index + 1];
}

function requiredMatch(value: string, pattern: RegExp): string {
  const match = pattern.exec(value);
  if (!match?.[1]) {
    throw new Error(`Pattern did not match: ${pattern}`);
  }
  return match[1];
}

function fixedClock(): () => Date {
  const dates = [
    new Date("2026-07-04T12:00:00.000Z"),
    new Date("2026-07-04T12:00:01.000Z"),
    new Date("2026-07-04T12:00:02.000Z"),
  ];
  return () => dates.shift() ?? new Date("2026-07-04T12:00:03.000Z");
}

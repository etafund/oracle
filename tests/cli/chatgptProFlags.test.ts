import { Command, type OptionValues } from "commander";
import { describe, expect, test } from "vitest";
import {
  CHATGPT_PRO_BROWSER_MODEL,
  normalizeChatGptProModelOption,
  parseChatGptProEvidenceOption,
} from "../../src/cli/options.js";
import {
  addChatGptProDoctorFlags,
  addChatGptProLeaseFlags,
  addChatGptProRunFlags,
  buildChatGptProRunEnvelope,
  normalizeChatGptProDoctorOptions,
  normalizeChatGptProLeaseOptions,
  normalizeChatGptProRunOptions,
  runChatGptProDryRun,
} from "../../src/cli/commands/run/chatgptPro.js";

function parseOptions(addFlags: (command: Command) => Command, argv: string[]): OptionValues {
  const command = new Command();
  command.exitOverride();
  command.configureOutput({
    writeErr: () => undefined,
    writeOut: () => undefined,
  });
  addFlags(command);
  command.parse(argv, { from: "user" });
  return command.opts();
}

describe("ChatGPT Pro CLI flag helpers", () => {
  test("doctor flags accept the --chatgpt-pro alias and remote browser policy", () => {
    const opts = parseOptions(addChatGptProDoctorFlags, [
      "--chatgpt-pro",
      "--extended-reasoning",
      "--remote-browser",
      "required",
      "--json",
    ]);

    expect(normalizeChatGptProDoctorOptions(opts)).toEqual({
      pro: true,
      extended_reasoning: true,
      remote_browser: "required",
      json: true,
    });
  });

  test("lease flags parse a duration TTL for the ChatGPT provider", () => {
    const opts = parseOptions(addChatGptProLeaseFlags, [
      "--chatgpt-pro",
      "--extended-reasoning",
      "--ttl",
      "30m",
      "--json",
    ]);

    expect(opts.ttl).toBe(1_800_000);
    expect(normalizeChatGptProLeaseOptions(opts)).toMatchObject({
      provider: "chatgpt",
      require: "pro",
      ttl_ms: 1_800_000,
      ttl_seconds: 1_800,
      pro: true,
      extended_reasoning: true,
    });
  });

  test("run flags produce the protected browser route without changing prompt semantics", () => {
    const opts = parseOptions(addChatGptProRunFlags, [
      "--engine",
      "browser",
      "--provider",
      "chatgpt",
      "--model",
      "chatgpt-pro-latest",
      "--chatgpt-pro",
      "--extended-reasoning",
      "--remote-browser",
      "preferred",
      "--evidence",
      "redacted",
      "--prompt-file",
      "PROMPT.md",
      "--dry-run",
      "json",
      "--json",
    ]);

    const plan = normalizeChatGptProRunOptions(opts);
    expect(plan).toMatchObject({
      schema_version: "chatgpt_pro_run.v1",
      dry_run: true,
      live_call: false,
      provider: "chatgpt",
      engine: "browser",
      model: CHATGPT_PRO_BROWSER_MODEL,
      extended_reasoning: true,
      remote_browser: "preferred",
      evidence: { mode: "redacted", redacted: true },
      prompt_source: { kind: "file", path: "PROMPT.md", redacted: true },
    });
    expect(plan.protected_route.run_command).toContain("--prompt-file PROMPT.md");
  });

  test.each(["preferred", "required", "off"] as const)(
    "accepts remote browser mode %s",
    (remoteBrowser) => {
      const plan = normalizeChatGptProRunOptions({
        chatgptPro: true,
        extendedReasoning: true,
        remoteBrowser,
        promptFile: "PROMPT.md",
      });

      expect(plan.remote_browser).toBe(remoteBrowser);
    },
  );

  test("defaults evidence to redacted and rejects raw evidence modes", () => {
    expect(
      normalizeChatGptProRunOptions({
        chatgptPro: true,
        extendedReasoning: true,
        promptFile: "PROMPT.md",
      }).evidence,
    ).toEqual({ mode: "redacted", redacted: true });
    expect(() => parseChatGptProEvidenceOption("raw")).toThrow("raw evidence is not allowed");
  });

  test("maps legacy GPT Pro browser aliases to the protected route model", () => {
    expect(normalizeChatGptProModelOption("gpt-5.2-pro")).toBe(CHATGPT_PRO_BROWSER_MODEL);
    expect(normalizeChatGptProModelOption("GPT 5.5 Pro")).toBe(CHATGPT_PRO_BROWSER_MODEL);
  });
});

describe("ChatGPT Pro run preflight envelope", () => {
  test("reports missing prompt as a typed blocker", () => {
    const envelope = buildChatGptProRunEnvelope(
      { chatgptPro: true, extendedReasoning: true },
      { now: () => new Date("2026-05-13T00:00:00.000Z") },
    );

    expect(envelope).toMatchObject({
      schema_version: "json_envelope.v1",
      ok: false,
      blocked_reason: "chatgpt_pro_prompt_required",
      retry_safe: false,
    });
    expect(envelope.fix_command).toBe("--prompt-file PROMPT.md");
  });

  test.each([
    [{ engine: "api" }, "chatgpt_pro_requires_browser_engine"],
    [{ provider: "gemini" }, "chatgpt_pro_requires_chatgpt_provider"],
    [{ model: "gpt-5.2-thinking" }, "chatgpt_pro_model_downgrade_forbidden"],
    [{ extendedReasoning: false }, "chatgpt_pro_extended_reasoning_required"],
  ] as const)("blocks forbidden downgrade %j", (overrides, blockedReason) => {
    const envelope = buildChatGptProRunEnvelope({
      chatgptPro: true,
      extendedReasoning: true,
      promptFile: "PROMPT.md",
      ...overrides,
    });

    expect(envelope.ok).toBe(false);
    expect(envelope.blocked_reason).toBe(blockedReason);
  });

  test("JSON dry-run output redacts inline prompt text", async () => {
    const output: string[] = [];
    const envelope = await runChatGptProDryRun(
      {
        chatgptPro: true,
        extendedReasoning: true,
        prompt: "secret customer prompt",
        json: true,
      },
      { stdout: (text) => output.push(text) },
    );

    expect(envelope.ok).toBe(true);
    expect(output[0]).not.toContain("secret customer prompt");
    expect(JSON.parse(output[0])).toMatchObject({
      ok: true,
      data: {
        prompt_source: { kind: "inline", redacted: true },
        evidence: { mode: "redacted" },
      },
    });
  });
});

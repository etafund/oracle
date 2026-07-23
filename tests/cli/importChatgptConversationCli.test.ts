import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const CLI_PATH = path.resolve("bin/oracle-cli.ts");
const CLI_TIMEOUT_MS = 30_000;

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

let oracleHomeDir: string;

beforeEach(async () => {
  oracleHomeDir = await mkdtemp(path.join(os.tmpdir(), "oracle-import-cli-tests-"));
});

afterEach(async () => {
  await rm(oracleHomeDir, { recursive: true, force: true });
});

function cleanCliEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ORACLE_HOME_DIR: oracleHomeDir,
    NO_COLOR: "1",
    FORCE_COLOR: "0",
  };
  for (const key of [
    "ORACLE_ENGINE",
    "ORACLE_REMOTE_HOST",
    "ORACLE_REMOTE_TOKEN",
    "ORACLE_REMOTE_BROWSER",
  ]) {
    delete env[key];
  }
  return env;
}

async function runCli(args: string[]): Promise<CliResult> {
  try {
    const result = await execFileAsync(
      process.execPath,
      ["--no-deprecation", "--import", "tsx", CLI_PATH, ...args],
      {
        cwd: path.resolve("."),
        env: cleanCliEnv(),
        timeout: CLI_TIMEOUT_MS,
        maxBuffer: 2 * 1024 * 1024,
      },
    );
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failed = error as Error & {
      code?: number | string;
      stdout?: string;
      stderr?: string;
    };
    return {
      code: typeof failed.code === "number" ? failed.code : 1,
      stdout: failed.stdout ?? "",
      stderr: failed.stderr ?? failed.message,
    };
  }
}

describe("import-chatgpt-url CLI", () => {
  test("documents the descriptor-rooting and Windows limitation of --force", async () => {
    const help = await runCli(["import-chatgpt-url", "--help"]);

    expect(help.code).toBe(0);
    expect(help.stdout).toContain("requires descriptor-rooted filesystem operations");
    expect(help.stdout).toContain("unavailable on Windows");
    expect(help.stdout).toContain("use a new slug");
  });

  test("registers an imported status and gates every follow-up route", async () => {
    const imported = await runCli([
      "import-chatgpt-url",
      "https://chatgpt.com/c/cli-import",
      "--slug",
      "manual cli import",
    ]);
    expect(imported.code).toBe(0);
    expect(imported.stdout).toContain("untrusted reference manual-cli-import");
    expect(imported.stdout).toContain("No answer, model/mode proof, lane binding");

    const sessionJson = await runCli(["session", "manual-cli-import", "--json"]);
    expect(sessionJson.code).toBe(0);
    const envelope = JSON.parse(sessionJson.stdout);
    expect(envelope.data).toMatchObject({
      id: "manual-cli-import",
      status: "imported",
      terminal: true,
      exit_code: 0,
      completed_at: null,
      output_file: null,
    });
    expect(envelope.next_command).toContain(
      "--engine browser --remote-browser off --browser-model-strategy current",
    );

    const implicit = await runCli([
      "--followup",
      "manual-cli-import",
      "-p",
      "Continue",
      "--dry-run",
      "summary",
    ]);
    expect(implicit.code).not.toBe(0);
    expect(`${implicit.stdout}\n${implicit.stderr}`).toContain(
      "requires an explicit compatibility route",
    );

    const reviewed = await runCli([
      "--lane",
      "chatgpt-pro",
      "--followup",
      "manual-cli-import",
      "-p",
      "Continue",
      "--dry-run",
      "summary",
    ]);
    expect(reviewed.code).not.toBe(0);
    expect(`${reviewed.stdout}\n${reviewed.stderr}`).toContain(
      "never eligible for reviewed --lane chatgpt-pro",
    );

    const remote = await runCli([
      "--engine",
      "browser",
      "--remote-host",
      "127.0.0.1:9473",
      "--remote-token",
      "test-token",
      "--followup",
      "manual-cli-import",
      "-p",
      "Continue",
      "--dry-run",
      "summary",
    ]);
    expect(remote.code).not.toBe(0);
    expect(`${remote.stdout}\n${remote.stderr}`).toContain(
      "remote/account-affine browser routing is refused",
    );

    const localNotExplicit = await runCli([
      "--engine",
      "browser",
      "--browser-model-strategy",
      "current",
      "--followup",
      "manual-cli-import",
      "-p",
      "Continue",
      "--dry-run",
      "summary",
    ]);
    expect(localNotExplicit.code).not.toBe(0);
    expect(`${localNotExplicit.stdout}\n${localNotExplicit.stderr}`).toContain(
      "requires an explicit local route",
    );

    const currentModelNotExplicit = await runCli([
      "--engine",
      "browser",
      "--remote-browser",
      "off",
      "--followup",
      "manual-cli-import",
      "-p",
      "Continue",
      "--dry-run",
      "summary",
    ]);
    expect(currentModelNotExplicit.code).not.toBe(0);
    expect(`${currentModelNotExplicit.stdout}\n${currentModelNotExplicit.stderr}`).toContain(
      "requires the explicit --browser-model-strategy current",
    );

    const compatibility = await runCli([
      "--engine",
      "browser",
      "--remote-browser",
      "off",
      "--browser-model-strategy",
      "current",
      "--followup",
      "manual-cli-import",
      "-p",
      "Continue",
      "--dry-run",
      "summary",
    ]);
    expect(compatibility.code).toBe(0);
  });

  test("two processes racing one exact slug publish one complete reference", async () => {
    const [left, right] = await Promise.all([
      runCli([
        "import-chatgpt-url",
        "https://chatgpt.com/c/cli-race-left",
        "--slug",
        "manual cli race",
      ]),
      runCli([
        "import-chatgpt-url",
        "https://chatgpt.com/c/cli-race-right",
        "--slug",
        "manual cli race",
      ]),
    ]);
    expect([left.code, right.code].sort()).toEqual([0, 1]);

    const raw = await readFile(
      path.join(oracleHomeDir, "sessions", "manual-cli-race", "meta.json"),
      "utf8",
    );
    const metadata = JSON.parse(raw);
    expect(metadata.status).toBe("imported");
    expect(["cli-race-left", "cli-race-right"]).toContain(
      metadata.browser.importedConversation.conversationId,
    );
    expect(metadata.browser.importedConversation).toMatchObject({
      trust: "untrusted",
      accountBinding: "unbound",
      laneBinding: "unbound",
      answerCaptured: false,
    });
    expect(metadata.models).toEqual([]);
    expect(metadata.completedAt).toBeUndefined();
  });

  test("two processes forcing one import serialize behind the mandatory owner-token lock", async () => {
    const base = await runCli([
      "import-chatgpt-url",
      "https://chatgpt.com/c/cli-force-base",
      "--slug",
      "manual cli force",
    ]);
    expect(base.code).toBe(0);

    const [left, right] = await Promise.all([
      runCli([
        "import-chatgpt-url",
        "https://chatgpt.com/c/cli-force-left",
        "--slug",
        "manual cli force",
        "--force",
      ]),
      runCli([
        "import-chatgpt-url",
        "https://chatgpt.com/c/cli-force-right",
        "--slug",
        "manual cli force",
        "--force",
      ]),
    ]);
    expect([left.code, right.code]).toEqual([0, 0]);

    const sessionDirectory = path.join(oracleHomeDir, "sessions", "manual-cli-force");
    expect(await readdir(sessionDirectory)).toEqual(["meta.json"]);
    const metadata = JSON.parse(await readFile(path.join(sessionDirectory, "meta.json"), "utf8"));
    expect(["cli-force-left", "cli-force-right"]).toContain(
      metadata.browser.importedConversation.conversationId,
    );
    expect(metadata.browser.importedConversation).toMatchObject({
      trust: "untrusted",
      accountBinding: "unbound",
      laneBinding: "unbound",
      answerCaptured: false,
    });
  });
});

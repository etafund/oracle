import { afterAll, beforeEach, describe, expect, test } from "vitest";
import { mkdtemp, writeFile, readdir, readFile, rm, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import {
  type ChildProcessByStdio,
  execFile,
  spawn,
  type ExecFileOptions,
} from "node:child_process";
import type { Readable } from "node:stream";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const CLI_ENTRY = path.join(process.cwd(), "bin", "oracle-cli.ts");
const TSX_LOADER = pathToFileURL(
  path.join(process.cwd(), "node_modules", "tsx", "dist", "loader.mjs"),
).href;
// v0.15.0 contract: the default engine is "browser" (DEFAULT_USER_CONFIG), so API-path
// runs (including every --followup invocation) must opt in explicitly with --engine api.
const CLIENT_FACTORY = path.join(process.cwd(), "tests", "fixtures", "mockClientFactory.cjs");
const INTEGRATION_TIMEOUT = 60000;
const AZURE_ENV_KEYS = [
  "AZURE_OPENAI_ENDPOINT",
  "AZURE_OPENAI_API_KEY",
  "AZURE_OPENAI_DEPLOYMENT",
  "AZURE_OPENAI_API_VERSION",
] as const;
const originalAzureEnv = Object.fromEntries(AZURE_ENV_KEYS.map((key) => [key, process.env[key]]));

beforeEach(() => {
  for (const key of AZURE_ENV_KEYS) {
    delete process.env[key];
  }
});

afterAll(() => {
  for (const key of AZURE_ENV_KEYS) {
    const value = originalAzureEnv[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

function execCli(
  args: string[],
  options: ExecFileOptions = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ["--import", "tsx", CLI_ENTRY, ...args],
      options,
      (error, stdout, stderr) => {
        const code = typeof error?.code === "number" ? error.code : error ? 1 : 0;
        resolve({
          code,
          stdout: typeof stdout === "string" ? stdout : stdout.toString("utf8"),
          stderr: typeof stderr === "string" ? stderr : stderr.toString("utf8"),
        });
      },
    );
  });
}

function productionCliEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    FORCE_COLOR: "0",
    NO_COLOR: "1",
    ORACLE_DISABLE_KEYTAR: "1",
    ORACLE_NO_DETACH: "1",
    ...overrides,
  };
  delete env.ORACLE_TEST_ALLOW_LEGACY_ROUTES;
  return env;
}

type CliChild = ChildProcessByStdio<null, Readable, Readable>;

function waitForChildExit(
  child: CliChild,
  timeoutMs: number,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`child did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function waitForChildOutput(child: CliChild, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      child.stdout.off("data", done);
      child.stderr.off("data", done);
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    child.stdout.once("data", done);
    child.stderr.once("data", done);
  });
}

describe("oracle CLI integration", () => {
  test(
    "exits nonzero when root options omit the required prompt",
    async () => {
      const result = await execCli(["--engine", "api"], { timeout: INTEGRATION_TIMEOUT });

      expect(result.code).toBe(1);
      expect(`${result.stdout}\n${result.stderr}`).toContain("Prompt is required");
    },
    INTEGRATION_TIMEOUT,
  );

  test(
    "rejects dry-run combined with either render flag spelling",
    async () => {
      for (const renderFlag of ["--render-markdown", "--render"]) {
        const result = await execCli(["--dry-run", renderFlag, "-p", "render conflict"], {
          timeout: INTEGRATION_TIMEOUT,
        });

        expect(result.code).toBe(1);
        expect(`${result.stdout}\n${result.stderr}`).toContain(
          "--dry-run cannot be combined with --render-markdown.",
        );
      }
    },
    INTEGRATION_TIMEOUT,
  );

  test(
    "parses follow-up command options and rejects unsupported files",
    async () => {
      const result = await execCli(
        [
          "follow-up",
          "parent-session",
          "--prompt",
          "next turn",
          "--slug",
          "child follow up",
          "--file",
          "a.ts",
        ],
        { timeout: INTEGRATION_TIMEOUT },
      );

      expect(result.code).toBe(1);
      expect(`${result.stdout}\n${result.stderr}`).toContain("prompt-only in v1");
    },
    INTEGRATION_TIMEOUT,
  );

  test(
    "SIGINT exits promptly",
    async () => {
      const oracleHome = await mkdtemp(path.join(os.tmpdir(), "oracle-sigint-"));
      const markerPath = path.join(oracleHome, "continued-after-sigint");
      const factoryPath = path.join(oracleHome, "slowFactory.cjs");
      await writeFile(
        factoryPath,
        `
const fs = require("node:fs");
module.exports = () => ({
  responses: {
    stream: async () => {
      await new Promise((resolve) => setTimeout(resolve, 30000));
      fs.writeFileSync(${JSON.stringify(markerPath)}, "continued");
      return {
        async *[Symbol.asyncIterator]() {},
        finalResponse: async () => ({ id: "slow-test", status: "completed" }),
      };
    },
    create: async () => {
      await new Promise((resolve) => setTimeout(resolve, 30000));
      fs.writeFileSync(${JSON.stringify(markerPath)}, "continued");
      return { id: "slow-test", status: "completed" };
    },
    retrieve: async (id) => ({ id, status: "completed" }),
  },
});
`,
        "utf8",
      );
      const env = {
        ...process.env,
        // biome-ignore lint/style/useNamingConvention: env var name
        OPENAI_API_KEY: "sk-sigint",
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_HOME_DIR: oracleHome,
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_CLIENT_FACTORY: factoryPath,
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_NO_DETACH: "1",
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_DISABLE_KEYTAR: "1",
      };
      const child = spawn(
        process.execPath,
        [
          "--import",
          "tsx",
          CLI_ENTRY,
          "--provider",
          "openai",
          "--model",
          "gpt-5.1",
          "--no-background",
          "-p",
          "interrupt slow client",
        ],
        { env, stdio: ["ignore", "pipe", "pipe"] },
      );
      let output = "";
      child.stdout.on("data", (chunk) => {
        output += String(chunk);
      });
      child.stderr.on("data", (chunk) => {
        output += String(chunk);
      });

      await waitForChildOutput(child, 2000);
      child.kill("SIGINT");
      const exit = await waitForChildExit(child, 5000);

      // SIGINT can land just before the CLI installs its handler, in which case Node reports the
      // signal directly instead of the handler-normalized exit code.
      const exitedViaSignal = exit.code === null && exit.signal === "SIGINT";
      const exitedViaHandler = exit.code === 130 && exit.signal === null;
      expect(exitedViaSignal || exitedViaHandler).toBe(true);
      if (exitedViaHandler) {
        expect(output).toContain("Cancelled.");
      }
      await expect(readFile(markerPath, "utf8")).rejects.toThrow();
      await rm(oracleHome, { recursive: true, force: true });
    },
    INTEGRATION_TIMEOUT,
  );

  test(
    "stores session metadata using stubbed client factory",
    async () => {
      const oracleHome = await mkdtemp(path.join(os.tmpdir(), "oracle-home-"));
      const testFile = path.join(oracleHome, "notes.md");
      await writeFile(testFile, "Integration dry run content", "utf8");

      const env = {
        ...process.env,
        // biome-ignore lint/style/useNamingConvention: env var name
        OPENAI_API_KEY: "sk-integration",
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_HOME_DIR: oracleHome,
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_CLIENT_FACTORY: CLIENT_FACTORY,
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_NO_DETACH: "1",
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_DISABLE_KEYTAR: "1",
      };

      await execFileAsync(
        process.execPath,
        [
          "--import",
          "tsx",
          CLI_ENTRY,
          "--engine",
          "api",
          "--prompt",
          "Integration check",
          "--model",
          "gpt-5.1",
          "--file",
          testFile,
        ],
        { env },
      );

      const sessionsDir = path.join(oracleHome, "sessions");
      const sessionIds = await readdir(sessionsDir);
      expect(sessionIds.length).toBe(1);
      const metadataPath = path.join(sessionsDir, sessionIds[0], "meta.json");
      const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
      expect(metadata.status).toBe("completed");
      expect(metadata.response?.requestId).toBe("mock-req");
      expect(metadata.usage?.totalTokens).toBe(20);
      expect(metadata.options?.effectiveModelId).toBe("gpt-5.1");

      await rm(oracleHome, { recursive: true, force: true });
    },
    INTEGRATION_TIMEOUT,
  );

  test(
    "a successful --json run emits a json_envelope.v1 success payload on stdout, not just human text",
    async () => {
      // Regression test for the bug where root `--json` only formatted the
      // ERROR path (see main().catch() dispatch): a successful consult run
      // used to print plain human-readable text, which broke any agent piping
      // `oracle -p ... --json | jq .`.
      const oracleHome = await mkdtemp(path.join(os.tmpdir(), "oracle-json-success-"));
      const testFile = path.join(oracleHome, "notes.md");
      await writeFile(testFile, "Integration dry run content", "utf8");

      const env = {
        ...process.env,
        // biome-ignore lint/style/useNamingConvention: env var name
        OPENAI_API_KEY: "sk-integration",
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_HOME_DIR: oracleHome,
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_CLIENT_FACTORY: CLIENT_FACTORY,
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_NO_DETACH: "1",
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_DISABLE_KEYTAR: "1",
      };

      try {
        const { stdout, stderr } = await execFileAsync(
          process.execPath,
          [
            "--import",
            "tsx",
            CLI_ENTRY,
            "--engine",
            "api",
            "--prompt",
            "Integration check",
            "--model",
            "gpt-5.1",
            "--file",
            testFile,
            "--json",
          ],
          { env },
        );

        // The whole of stdout must parse as a single JSON document — any
        // human-readable noise (lifecycle block, tips, completion summary)
        // ahead of the envelope would break `JSON.parse`/`jq .` for a caller
        // piping the output, which is exactly what this bug allowed through.
        expect(stderr).toBe("");
        const envelope = JSON.parse(stdout) as Record<string, unknown>;
        expect(envelope).toMatchObject({
          schema_version: "json_envelope.v1",
          ok: true,
          status: "success",
        });
        const data = envelope.data as Record<string, unknown>;
        expect(typeof data.answer).toBe("string");
        // mockClientFactory streams this exact delta text (see
        // tests/fixtures/mockClientFactory.cjs) regardless of prompt content.
        expect(data.answer as string).toContain("Mock answer text.");
        expect(data.model).toBe("gpt-5.1");
        expect(typeof data.session_id).toBe("string");
      } finally {
        await rm(oracleHome, { recursive: true, force: true });
      }
    },
    INTEGRATION_TIMEOUT,
  );

  test(
    "honors --provider openai by ignoring Azure env routing",
    async () => {
      const oracleHome = await mkdtemp(path.join(os.tmpdir(), "oracle-provider-openai-"));
      const env = {
        ...process.env,
        // biome-ignore lint/style/useNamingConvention: env var name
        OPENAI_API_KEY: "sk-integration",
        // biome-ignore lint/style/useNamingConvention: env var name
        AZURE_OPENAI_ENDPOINT: "https://example-resource.openai.azure.com/",
        // biome-ignore lint/style/useNamingConvention: env var name
        AZURE_OPENAI_API_KEY: "az-integration",
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_HOME_DIR: oracleHome,
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_CLIENT_FACTORY: CLIENT_FACTORY,
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_NO_DETACH: "1",
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_DISABLE_KEYTAR: "1",
      };

      const { stdout } = await execFileAsync(
        process.execPath,
        [
          "--import",
          "tsx",
          CLI_ENTRY,
          "--provider",
          "openai",
          "--prompt",
          "Provider route check",
          "--model",
          "gpt-5.1",
        ],
        { env },
      );

      const sessionsDir = path.join(oracleHome, "sessions");
      const [sessionId] = await readdir(sessionsDir);
      const metadata = JSON.parse(
        await readFile(path.join(sessionsDir, sessionId, "meta.json"), "utf8"),
      );
      expect(metadata.options?.azure).toBeUndefined();
      expect(metadata.options?.provider).toBe("openai");
      expect(stdout).toContain("Provider: OpenAI | base: api.openai.com | key: OPENAI_API_KEY");

      await rm(oracleHome, { recursive: true, force: true });
    },
    INTEGRATION_TIMEOUT,
  );

  test(
    "stores resolved transport and stale timeouts from explicit overall timeout",
    async () => {
      const oracleHome = await mkdtemp(path.join(os.tmpdir(), "oracle-timeout-plan-"));
      const env = {
        ...process.env,
        // biome-ignore lint/style/useNamingConvention: env var name
        OPENAI_API_KEY: "sk-integration",
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_HOME_DIR: oracleHome,
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_CLIENT_FACTORY: CLIENT_FACTORY,
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_NO_DETACH: "1",
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_DISABLE_KEYTAR: "1",
      };

      await execFileAsync(
        process.execPath,
        [
          "--import",
          "tsx",
          CLI_ENTRY,
          "--engine",
          "api",
          "--prompt",
          "Timeout plan check",
          "--model",
          "gpt-5.1",
          "--timeout",
          "10m",
        ],
        { env },
      );

      const sessionsDir = path.join(oracleHome, "sessions");
      const [sessionId] = await readdir(sessionsDir);
      const metadata = JSON.parse(
        await readFile(path.join(sessionsDir, sessionId, "meta.json"), "utf8"),
      );
      expect(metadata.options?.timeoutSeconds).toBe(600);
      expect(metadata.options?.httpTimeoutMs).toBe(600_000);
      expect(metadata.options?.zombieTimeoutMs).toBe(600_000);

      await rm(oracleHome, { recursive: true, force: true });
    },
    INTEGRATION_TIMEOUT,
  );

  test(
    "keeps Gemini dry-runs in browser mode when Azure env is present",
    async () => {
      const oracleHome = await mkdtemp(path.join(os.tmpdir(), "oracle-provider-gemini-azure-"));
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        // biome-ignore lint/style/useNamingConvention: env var name
        AZURE_OPENAI_ENDPOINT: "https://example-resource.openai.azure.com/",
        // biome-ignore lint/style/useNamingConvention: env var name
        AZURE_OPENAI_API_KEY: "az-integration",
        // biome-ignore lint/style/useNamingConvention: env var name
        DOTENV_CONFIG_PATH: "/tmp/nonexistent-oracle-env",
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_HOME_DIR: oracleHome,
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_DISABLE_KEYTAR: "1",
      };
      delete env.OPENAI_API_KEY;
      delete env.GEMINI_API_KEY;
      delete env.OPENROUTER_API_KEY;
      delete env.ORACLE_ENGINE;

      const { stdout } = await execFileAsync(
        process.execPath,
        [
          "--import",
          "tsx",
          CLI_ENTRY,
          "--dry-run",
          "--prompt",
          "Gemini browser route check",
          "--model",
          "gemini-3.1-pro",
        ],
        { env },
      );

      expect(stdout).toContain("[preview] Oracle");
      expect(stdout).toContain("browser mode (gemini-3.1-pro)");

      await rm(oracleHome, { recursive: true, force: true });
    },
    INTEGRATION_TIMEOUT,
  );

  test(
    "honors ORACLE_ENGINE browser when Azure env is present",
    async () => {
      const oracleHome = await mkdtemp(path.join(os.tmpdir(), "oracle-provider-engine-browser-"));
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        // biome-ignore lint/style/useNamingConvention: env var name
        AZURE_OPENAI_ENDPOINT: "https://example-resource.openai.azure.com/",
        // biome-ignore lint/style/useNamingConvention: env var name
        AZURE_OPENAI_API_KEY: "az-integration",
        // biome-ignore lint/style/useNamingConvention: env var name
        AZURE_OPENAI_DEPLOYMENT: "configured-gpt",
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_ENGINE: "browser",
        // biome-ignore lint/style/useNamingConvention: env var name
        DOTENV_CONFIG_PATH: "/tmp/nonexistent-oracle-env",
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_HOME_DIR: oracleHome,
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_DISABLE_KEYTAR: "1",
      };
      delete env.OPENAI_API_KEY;
      delete env.GEMINI_API_KEY;
      delete env.OPENROUTER_API_KEY;

      const { stdout } = await execFileAsync(
        process.execPath,
        [
          "--import",
          "tsx",
          CLI_ENTRY,
          "--dry-run",
          "--prompt",
          "Engine browser route check",
          "--model",
          "gpt-5.1",
        ],
        { env },
      );

      expect(stdout).toContain("[preview] Oracle");
      expect(stdout).toContain("browser mode (gpt-5.1)");
      expect(stdout).not.toContain("Provider: Azure OpenAI");

      await rm(oracleHome, { recursive: true, force: true });
    },
    INTEGRATION_TIMEOUT,
  );

  test(
    "honors project browser config when Azure env is present",
    async () => {
      const oracleHome = await mkdtemp(path.join(os.tmpdir(), "oracle-project-azure-home-"));
      const repoDir = await mkdtemp(path.join(os.tmpdir(), "oracle-project-azure-repo-"));
      await mkdir(path.join(repoDir, ".oracle"), { recursive: true });
      await writeFile(
        path.join(repoDir, ".oracle", "config.json"),
        `{ engine: "browser", browser: { chatgptUrl: "https://chatgpt.com/g/g-p-demo/project" } }`,
        "utf8",
      );
      const env: NodeJS.ProcessEnv = { ...process.env };
      env.AZURE_OPENAI_ENDPOINT = "https://example-resource.openai.azure.com/";
      env.AZURE_OPENAI_API_KEY = "az-integration";
      env.AZURE_OPENAI_DEPLOYMENT = "configured-gpt";
      env.DOTENV_CONFIG_PATH = "/tmp/nonexistent-oracle-env";
      env.ORACLE_HOME_DIR = oracleHome;
      env.ORACLE_DISABLE_KEYTAR = "1";
      delete env.ORACLE_ENGINE;
      delete env.OPENAI_API_KEY;
      delete env.GEMINI_API_KEY;
      delete env.OPENROUTER_API_KEY;

      const { stdout } = await execFileAsync(
        process.execPath,
        [
          "--import",
          TSX_LOADER,
          CLI_ENTRY,
          "--dry-run",
          "--prompt",
          "Project browser route check",
          "--model",
          "gpt-5.1",
        ],
        { env, cwd: repoDir },
      );

      expect(stdout).toContain("[preview] Oracle");
      expect(stdout).toContain("browser mode (gpt-5.1)");
      expect(stdout).not.toContain("Provider: Azure OpenAI");

      await rm(oracleHome, { recursive: true, force: true });
      await rm(repoDir, { recursive: true, force: true });
    },
    INTEGRATION_TIMEOUT,
  );

  test(
    "honors ORACLE_ENGINE api over project config engine",
    async () => {
      const oracleHome = await mkdtemp(path.join(os.tmpdir(), "oracle-project-engine-home-"));
      const repoDir = await mkdtemp(path.join(os.tmpdir(), "oracle-project-engine-repo-"));
      await mkdir(path.join(repoDir, ".oracle"), { recursive: true });
      await writeFile(
        path.join(repoDir, ".oracle", "config.json"),
        `{ engine: "browser", model: "gpt-5.5-pro" }`,
        "utf8",
      );
      const env: NodeJS.ProcessEnv = { ...process.env };
      env.DOTENV_CONFIG_PATH = "/tmp/nonexistent-oracle-env";
      env.ORACLE_HOME_DIR = oracleHome;
      env.ORACLE_ENGINE = "api";
      env.ORACLE_DISABLE_KEYTAR = "1";
      delete env.OPENAI_API_KEY;
      delete env.GEMINI_API_KEY;
      delete env.OPENROUTER_API_KEY;

      const { stdout } = await execFileAsync(
        process.execPath,
        ["--import", TSX_LOADER, CLI_ENTRY, "--dry-run", "--prompt", "Engine env route check"],
        { env, cwd: repoDir },
      );

      expect(stdout).toContain("[dry-run] Oracle");
      expect(stdout).toContain("would call gpt-5.5-pro");
      expect(stdout).not.toContain("browser mode");

      await rm(oracleHome, { recursive: true, force: true });
      await rm(repoDir, { recursive: true, force: true });
    },
    INTEGRATION_TIMEOUT,
  );

  test(
    "honors API engine overrides over project browser config for API-only models",
    async () => {
      const oracleHome = await mkdtemp(path.join(os.tmpdir(), "oracle-project-api-home-"));
      const repoDir = await mkdtemp(path.join(os.tmpdir(), "oracle-project-api-repo-"));
      await mkdir(path.join(repoDir, ".oracle"), { recursive: true });
      await writeFile(
        path.join(repoDir, ".oracle", "config.json"),
        `{ engine: "browser" }`,
        "utf8",
      );
      const env: NodeJS.ProcessEnv = { ...process.env };
      env.DOTENV_CONFIG_PATH = "/tmp/nonexistent-oracle-env";
      env.ORACLE_HOME_DIR = oracleHome;
      env.ORACLE_DISABLE_KEYTAR = "1";
      delete env.ORACLE_ENGINE;
      delete env.OPENAI_API_KEY;
      delete env.GEMINI_API_KEY;
      delete env.OPENROUTER_API_KEY;

      for (const scenario of [
        { args: ["--engine", "api"], envEngine: undefined },
        { args: [], envEngine: "api" },
      ]) {
        const scenarioEnv = { ...env };
        if (scenario.envEngine) {
          scenarioEnv.ORACLE_ENGINE = scenario.envEngine;
        } else {
          delete scenarioEnv.ORACLE_ENGINE;
        }

        const { stdout } = await execFileAsync(
          process.execPath,
          [
            "--import",
            TSX_LOADER,
            CLI_ENTRY,
            "--dry-run",
            ...scenario.args,
            "--model",
            "claude-4.6-sonnet",
            "--prompt",
            "Explicit API route check",
          ],
          { env: scenarioEnv, cwd: repoDir, timeout: INTEGRATION_TIMEOUT },
        );

        expect(stdout).toContain("[dry-run] Oracle");
        expect(stdout).toContain("would call claude-4.6-sonnet");
        expect(stdout).not.toContain("browser mode");
      }

      await rm(oracleHome, { recursive: true, force: true });
      await rm(repoDir, { recursive: true, force: true });
    },
    INTEGRATION_TIMEOUT,
  );

  test(
    "persists explicit Azure provider mode for custom deployment sessions",
    async () => {
      const oracleHome = await mkdtemp(path.join(os.tmpdir(), "oracle-provider-azure-"));
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        // biome-ignore lint/style/useNamingConvention: env var name
        AZURE_OPENAI_ENDPOINT: "https://example-resource.openai.azure.com/",
        // biome-ignore lint/style/useNamingConvention: env var name
        AZURE_OPENAI_API_KEY: "az-integration",
        // biome-ignore lint/style/useNamingConvention: env var name
        DOTENV_CONFIG_PATH: "/tmp/nonexistent-oracle-env",
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_HOME_DIR: oracleHome,
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_CLIENT_FACTORY: CLIENT_FACTORY,
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_NO_DETACH: "1",
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_DISABLE_KEYTAR: "1",
      };
      delete env.OPENAI_API_KEY;

      const { stdout } = await execFileAsync(
        process.execPath,
        [
          "--import",
          "tsx",
          CLI_ENTRY,
          "--provider",
          "azure",
          "--azure-deployment",
          "my-o3",
          "--prompt",
          "Azure provider route check",
          "--model",
          "o3-mini",
          "--no-background",
          "--wait",
        ],
        { env },
      );

      const sessionsDir = path.join(oracleHome, "sessions");
      const [sessionId] = await readdir(sessionsDir);
      const metadata = JSON.parse(
        await readFile(path.join(sessionsDir, sessionId, "meta.json"), "utf8"),
      );
      expect(metadata.options?.provider).toBe("azure");
      expect(metadata.options?.azure?.deployment).toBe("my-o3");
      expect(stdout).toContain(
        "Provider: Azure OpenAI | endpoint: example-resource.openai.azure.com | deployment: my-o3 | key: AZURE_OPENAI_API_KEY|OPENAI_API_KEY",
      );

      await rm(oracleHome, { recursive: true, force: true });
    },
    INTEGRATION_TIMEOUT,
  );

  test(
    "rejects missing Azure deployment before detached Pro sessions start",
    async () => {
      const oracleHome = await mkdtemp(path.join(os.tmpdir(), "oracle-provider-detach-azure-"));
      const env = {
        ...process.env,
        // biome-ignore lint/style/useNamingConvention: env var name
        AZURE_OPENAI_ENDPOINT: "https://example-resource.openai.azure.com/",
        // biome-ignore lint/style/useNamingConvention: env var name
        AZURE_OPENAI_API_KEY: "az-integration",
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_HOME_DIR: oracleHome,
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_CLIENT_FACTORY: CLIENT_FACTORY,
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_DISABLE_KEYTAR: "1",
      };

      try {
        await execFileAsync(
          process.execPath,
          [
            "--import",
            "tsx",
            CLI_ENTRY,
            "--engine",
            "api",
            "--prompt",
            "Detached Azure provider route check",
            "--model",
            "gpt-5-pro",
          ],
          { env },
        );
        throw new Error("Expected oracle CLI to fail but it succeeded.");
      } catch (error) {
        const stderr =
          error && typeof error === "object" && error !== null && "stderr" in error
            ? String((error as { stderr?: unknown }).stderr ?? "")
            : "";
        expect(stderr).toMatch(/Azure mode requires --azure-deployment/i);
      }

      const sessionsDir = path.join(oracleHome, "sessions");
      let sessionIds: string[] = [];
      try {
        sessionIds = await readdir(sessionsDir);
      } catch {
        sessionIds = [];
      }
      expect(sessionIds).toEqual([]);

      await rm(oracleHome, { recursive: true, force: true });
    },
    INTEGRATION_TIMEOUT,
  );

  test(
    "rejects forced OpenAI non-OpenAI models before detached Pro sessions start",
    async () => {
      const oracleHome = await mkdtemp(path.join(os.tmpdir(), "oracle-provider-detach-openai-"));
      const env = {
        ...process.env,
        // biome-ignore lint/style/useNamingConvention: env var name
        OPENAI_API_KEY: "sk-integration",
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_HOME_DIR: oracleHome,
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_CLIENT_FACTORY: CLIENT_FACTORY,
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_DISABLE_KEYTAR: "1",
      };

      try {
        await execFileAsync(
          process.execPath,
          [
            "--import",
            "tsx",
            CLI_ENTRY,
            "--provider",
            "openai",
            "--prompt",
            "Detached OpenAI provider route check",
            "--model",
            "claude-4.6-sonnet",
          ],
          { env },
        );
        throw new Error("Expected oracle CLI to fail but it succeeded.");
      } catch (error) {
        const stderr =
          error && typeof error === "object" && error !== null && "stderr" in error
            ? String((error as { stderr?: unknown }).stderr ?? "")
            : "";
        expect(stderr).toMatch(/OpenAI provider cannot run claude-4\.6-sonnet/i);
      }

      const sessionsDir = path.join(oracleHome, "sessions");
      let sessionIds: string[] = [];
      try {
        sessionIds = await readdir(sessionsDir);
      } catch {
        sessionIds = [];
      }
      expect(sessionIds).toEqual([]);

      await rm(oracleHome, { recursive: true, force: true });
    },
    INTEGRATION_TIMEOUT,
  );

  test(
    "rejects forced OpenAI provider-qualified non-OpenAI dry-runs before sessions start",
    async () => {
      const oracleHome = await mkdtemp(path.join(os.tmpdir(), "oracle-provider-dry-openai-"));
      const env = {
        ...process.env,
        // biome-ignore lint/style/useNamingConvention: env var name
        OPENAI_API_KEY: "sk-integration",
        // biome-ignore lint/style/useNamingConvention: env var name
        DOTENV_CONFIG_PATH: "/tmp/nonexistent-oracle-env",
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_HOME_DIR: oracleHome,
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_DISABLE_KEYTAR: "1",
      };

      try {
        await execFileAsync(
          process.execPath,
          [
            "--import",
            "tsx",
            CLI_ENTRY,
            "--dry-run",
            "--provider",
            "openai",
            "--prompt",
            "Dry-run provider route check",
            "--model",
            "anthropic/claude-sonnet-4.5",
          ],
          { env },
        );
        throw new Error("Expected oracle CLI to fail but it succeeded.");
      } catch (error) {
        const stderr =
          error && typeof error === "object" && error !== null && "stderr" in error
            ? String((error as { stderr?: unknown }).stderr ?? "")
            : "";
        expect(stderr).toMatch(/OpenAI provider cannot run anthropic\/claude-sonnet-4\.5/i);
      }

      const sessionsDir = path.join(oracleHome, "sessions");
      let sessionIds: string[] = [];
      try {
        sessionIds = await readdir(sessionsDir);
      } catch {
        sessionIds = [];
      }
      expect(sessionIds).toEqual([]);

      await rm(oracleHome, { recursive: true, force: true });
    },
    INTEGRATION_TIMEOUT,
  );

  test(
    "rejects invalid forced provider multi-model runs before any session starts",
    async () => {
      const oracleHome = await mkdtemp(path.join(os.tmpdir(), "oracle-provider-multi-openai-"));
      const env = {
        ...process.env,
        // biome-ignore lint/style/useNamingConvention: env var name
        OPENAI_API_KEY: "sk-integration",
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_HOME_DIR: oracleHome,
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_CLIENT_FACTORY: CLIENT_FACTORY,
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_NO_DETACH: "1",
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_DISABLE_KEYTAR: "1",
      };

      try {
        await execFileAsync(
          process.execPath,
          [
            "--import",
            "tsx",
            CLI_ENTRY,
            "--provider",
            "openai",
            "--prompt",
            "Multi-provider route check",
            "--models",
            "gpt-5.1,claude-4.6-sonnet",
          ],
          { env },
        );
        throw new Error("Expected oracle CLI to fail but it succeeded.");
      } catch (error) {
        const stderr =
          error && typeof error === "object" && error !== null && "stderr" in error
            ? String((error as { stderr?: unknown }).stderr ?? "")
            : "";
        expect(stderr).toMatch(/OpenAI provider cannot run claude-4\.6-sonnet/i);
      }

      const sessionsDir = path.join(oracleHome, "sessions");
      let sessionIds: string[] = [];
      try {
        sessionIds = await readdir(sessionsDir);
      } catch {
        sessionIds = [];
      }
      expect(sessionIds).toEqual([]);

      await rm(oracleHome, { recursive: true, force: true });
    },
    INTEGRATION_TIMEOUT,
  );

  test(
    "persists followup lineage and reuses previous_response_id during --exec-session",
    async () => {
      const oracleHome = await mkdtemp(path.join(os.tmpdir(), "oracle-followup-"));
      const env = {
        ...process.env,
        // biome-ignore lint/style/useNamingConvention: env var name
        OPENAI_API_KEY: "sk-integration",
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_HOME_DIR: oracleHome,
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_CLIENT_FACTORY: CLIENT_FACTORY,
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_NO_DETACH: "1",
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_DISABLE_KEYTAR: "1",
      };

      await execFileAsync(
        process.execPath,
        [
          "--import",
          "tsx",
          CLI_ENTRY,
          "--engine",
          "api",
          "--prompt",
          "Parent run",
          "--model",
          "gpt-5.1",
        ],
        { env },
      );

      const sessionsDir = path.join(oracleHome, "sessions");
      const [parentId] = await readdir(sessionsDir);
      expect(parentId).toBeTruthy();
      const parentMeta = JSON.parse(
        await readFile(path.join(sessionsDir, parentId, "meta.json"), "utf8"),
      );
      const parentResponseId = String(parentMeta.response?.responseId ?? "");
      expect(parentResponseId.startsWith("resp_")).toBe(true);

      await execFileAsync(
        process.execPath,
        [
          "--import",
          "tsx",
          CLI_ENTRY,
          "--engine",
          "api",
          "--prompt",
          "Child run",
          "--model",
          "gpt-5.1",
          "--followup",
          parentId,
        ],
        { env },
      );

      const allSessions = await readdir(sessionsDir);
      expect(allSessions.length).toBe(2);
      const childId = allSessions.find((id) => id !== parentId);
      expect(childId).toBeTruthy();
      const childMeta = JSON.parse(
        await readFile(path.join(sessionsDir, childId as string, "meta.json"), "utf8"),
      );
      expect(childMeta.options?.previousResponseId).toBe(parentResponseId);
      expect(childMeta.options?.followupSessionId).toBe(parentId);

      await execFileAsync(
        process.execPath,
        ["--import", "tsx", CLI_ENTRY, "--exec-session", childId as string],
        {
          env: {
            ...env,
            // biome-ignore lint/style/useNamingConvention: env var name
            ORACLE_TEST_REQUIRE_PREV: "1",
          },
        },
      );

      await rm(oracleHome, { recursive: true, force: true });
    },
    INTEGRATION_TIMEOUT,
  );

  test(
    "persists model overrides for detached --exec-session runs",
    async () => {
      const oracleHome = await mkdtemp(path.join(os.tmpdir(), "oracle-model-overrides-"));
      const env = {
        ...process.env,
        // biome-ignore lint/style/useNamingConvention: env var name
        OPENAI_API_KEY: "sk-integration",
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_HOME_DIR: oracleHome,
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_CLIENT_FACTORY: CLIENT_FACTORY,
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_NO_DETACH: "1",
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_DISABLE_KEYTAR: "1",
      };
      await writeFile(
        path.join(oracleHome, "config.json"),
        JSON.stringify({
          modelOverrides: {
            "gpt-5.5": { apiModel: "gateway-model", reasoning: { effort: "xhigh" } },
          },
        }),
      );

      await execFileAsync(
        process.execPath,
        [
          "--import",
          "tsx",
          CLI_ENTRY,
          "--engine",
          "api",
          "--prompt",
          "Persist model override",
          "--model",
          "gpt-5.5",
        ],
        { env },
      );

      const sessionsDir = path.join(oracleHome, "sessions");
      const [sessionId] = await readdir(sessionsDir);
      const metadata = JSON.parse(
        await readFile(path.join(sessionsDir, sessionId, "meta.json"), "utf8"),
      );
      expect(metadata.options?.modelOverrides?.["gpt-5.5"]).toEqual({
        apiModel: "gateway-model",
        reasoning: { effort: "xhigh" },
      });

      await rm(path.join(oracleHome, "config.json"));
      await execFileAsync(
        process.execPath,
        ["--import", "tsx", CLI_ENTRY, "--exec-session", sessionId],
        {
          env: {
            ...env,
            // biome-ignore lint/style/useNamingConvention: env var name
            ORACLE_TEST_REQUIRE_MODEL: "gateway-model",
            // biome-ignore lint/style/useNamingConvention: env var name
            ORACLE_TEST_REQUIRE_REASONING_EFFORT: "xhigh",
          },
        },
      );
      const rerunMetadata = JSON.parse(
        await readFile(path.join(sessionsDir, sessionId, "meta.json"), "utf8"),
      );
      expect(rerunMetadata.status).toBe("completed");

      await rm(oracleHome, { recursive: true, force: true });
    },
    INTEGRATION_TIMEOUT,
  );

  test(
    "accepts direct response ids in --followup and persists chain metadata",
    async () => {
      const oracleHome = await mkdtemp(path.join(os.tmpdir(), "oracle-followup-resp-"));
      const env = {
        ...process.env,
        // biome-ignore lint/style/useNamingConvention: env var name
        OPENAI_API_KEY: "sk-integration",
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_HOME_DIR: oracleHome,
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_CLIENT_FACTORY: CLIENT_FACTORY,
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_NO_DETACH: "1",
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_DISABLE_KEYTAR: "1",
      };
      const directResponseId = "resp_direct_followup_12345";

      await execFileAsync(
        process.execPath,
        [
          "--import",
          "tsx",
          CLI_ENTRY,
          "--engine",
          "api",
          "--prompt",
          "Child from direct response id",
          "--model",
          "gpt-5.1",
          "--followup",
          directResponseId,
        ],
        { env },
      );

      const sessionsDir = path.join(oracleHome, "sessions");
      const [sessionId] = await readdir(sessionsDir);
      expect(sessionId).toBeTruthy();
      const metadata = JSON.parse(
        await readFile(path.join(sessionsDir, sessionId, "meta.json"), "utf8"),
      );
      expect(metadata.options?.previousResponseId).toBe(directResponseId);
      expect(metadata.options?.followupSessionId).toBeUndefined();
      expect(metadata.options?.followupModel).toBeUndefined();

      await rm(oracleHome, { recursive: true, force: true });
    },
    INTEGRATION_TIMEOUT,
  );

  test(
    "rejects --followup for Gemini API runs",
    async () => {
      const oracleHome = await mkdtemp(
        path.join(os.tmpdir(), "oracle-followup-gemini-unsupported-"),
      );
      const env = {
        ...process.env,
        // biome-ignore lint/style/useNamingConvention: env var name
        GEMINI_API_KEY: "gk-integration",
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_HOME_DIR: oracleHome,
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_DISABLE_KEYTAR: "1",
      };

      try {
        await execFileAsync(
          process.execPath,
          [
            "--import",
            "tsx",
            CLI_ENTRY,
            "--engine",
            "api",
            "--prompt",
            "Gemini followup",
            "--model",
            "gemini-3-pro",
            "--followup",
            "resp_parent_1234",
          ],
          { env },
        );
        throw new Error("Expected oracle CLI to fail but it succeeded.");
      } catch (error) {
        const stderr =
          error && typeof error === "object" && error !== null && "stderr" in error
            ? String((error as { stderr?: unknown }).stderr ?? "")
            : "";
        expect(stderr).toMatch(/only supported for OpenAI Responses API runs/i);
        expect(stderr).toMatch(/gemini-3-pro/i);
      }

      await rm(oracleHome, { recursive: true, force: true });
    },
    INTEGRATION_TIMEOUT,
  );

  test(
    "rejects --followup for Claude API runs",
    async () => {
      const oracleHome = await mkdtemp(
        path.join(os.tmpdir(), "oracle-followup-claude-unsupported-"),
      );
      const env = {
        ...process.env,
        // biome-ignore lint/style/useNamingConvention: env var name
        ANTHROPIC_API_KEY: "ak-integration",
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_HOME_DIR: oracleHome,
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_DISABLE_KEYTAR: "1",
      };

      try {
        await execFileAsync(
          process.execPath,
          [
            "--import",
            "tsx",
            CLI_ENTRY,
            "--engine",
            "api",
            "--prompt",
            "Claude followup",
            "--model",
            "claude-4.6-sonnet",
            "--followup",
            "resp_parent_1234",
          ],
          { env },
        );
        throw new Error("Expected oracle CLI to fail but it succeeded.");
      } catch (error) {
        const stderr =
          error && typeof error === "object" && error !== null && "stderr" in error
            ? String((error as { stderr?: unknown }).stderr ?? "")
            : "";
        expect(stderr).toMatch(/only supported for OpenAI Responses API runs/i);
        expect(stderr).toMatch(/claude-4.6-sonnet/i);
      }

      await rm(oracleHome, { recursive: true, force: true });
    },
    INTEGRATION_TIMEOUT,
  );

  test(
    "rejects --followup for custom --base-url providers",
    async () => {
      const oracleHome = await mkdtemp(
        path.join(os.tmpdir(), "oracle-followup-baseurl-unsupported-"),
      );
      const env = {
        ...process.env,
        // biome-ignore lint/style/useNamingConvention: env var name
        OPENAI_API_KEY: "sk-integration",
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_HOME_DIR: oracleHome,
        // biome-ignore lint/style/useNamingConvention: env var name
        OPENROUTER_API_KEY: "or-integration",
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_DISABLE_KEYTAR: "1",
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_REMOTE_HOST: "127.0.0.1:65535",
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_REMOTE_TOKEN: "test-token",
      };

      try {
        await execFileAsync(
          process.execPath,
          [
            "--import",
            "tsx",
            CLI_ENTRY,
            "--prompt",
            "OpenRouter followup",
            "--model",
            "gpt-5.1",
            "--base-url",
            "https://openrouter.ai/api/v1",
            "--followup",
            "resp_parent_1234",
          ],
          { env },
        );
        throw new Error("Expected oracle CLI to fail but it succeeded.");
      } catch (error) {
        const stderr =
          error && typeof error === "object" && error !== null && "stderr" in error
            ? String((error as { stderr?: unknown }).stderr ?? "")
            : "";
        expect(stderr).toMatch(/default OpenAI Responses API or Azure OpenAI Responses/i);
        expect(stderr).toMatch(/Custom --base-url providers are not supported/i);
      }

      await rm(oracleHome, { recursive: true, force: true });
    },
    INTEGRATION_TIMEOUT,
  );

  test(
    "prints actionable guidance when --followup session id is missing",
    async () => {
      const oracleHome = await mkdtemp(path.join(os.tmpdir(), "oracle-followup-missing-id-"));
      const env = {
        ...process.env,
        // biome-ignore lint/style/useNamingConvention: env var name
        OPENAI_API_KEY: "sk-integration",
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_HOME_DIR: oracleHome,
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_CLIENT_FACTORY: CLIENT_FACTORY,
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_NO_DETACH: "1",
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_DISABLE_KEYTAR: "1",
      };

      await execFileAsync(
        process.execPath,
        [
          "--import",
          "tsx",
          CLI_ENTRY,
          "--engine",
          "api",
          "--prompt",
          "Parent run for followup suggestions",
          "--model",
          "gpt-5.1",
          "--slug",
          "release-readiness-audit",
        ],
        { env },
      );

      try {
        await execFileAsync(
          process.execPath,
          [
            "--import",
            "tsx",
            CLI_ENTRY,
            "--engine",
            "api",
            "--prompt",
            "Child with typo followup id",
            "--model",
            "gpt-5.1",
            "--followup",
            "release-readiness-audti",
          ],
          { env },
        );
        throw new Error("Expected oracle CLI to fail but it succeeded.");
      } catch (error) {
        const stderr =
          error && typeof error === "object" && error !== null && "stderr" in error
            ? String((error as { stderr?: unknown }).stderr ?? "")
            : "";
        expect(stderr).toMatch(/No session found with ID release-readiness-audti/i);
        expect(stderr).toMatch(/Did you mean:\s+"release-readiness-audit"/i);
        expect(stderr).toMatch(/oracle status --hours 72 --limit 20/i);
      }

      await rm(oracleHome, { recursive: true, force: true });
    },
    INTEGRATION_TIMEOUT,
  );

  test(
    "requires --followup-model when parent session has multiple model runs",
    async () => {
      const oracleHome = await mkdtemp(path.join(os.tmpdir(), "oracle-followup-multi-error-"));
      const env = {
        ...process.env,
        // biome-ignore lint/style/useNamingConvention: env var name
        OPENAI_API_KEY: "sk-integration",
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_HOME_DIR: oracleHome,
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_CLIENT_FACTORY: CLIENT_FACTORY,
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_NO_DETACH: "1",
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_DISABLE_KEYTAR: "1",
      };

      await execFileAsync(
        process.execPath,
        [
          "--import",
          "tsx",
          CLI_ENTRY,
          "--prompt",
          "Parent multi followup",
          "--models",
          "gpt-5.1,gpt-5.2",
        ],
        { env },
      );

      const sessionsDir = path.join(oracleHome, "sessions");
      const [parentId] = await readdir(sessionsDir);
      expect(parentId).toBeTruthy();

      try {
        await execFileAsync(
          process.execPath,
          [
            "--import",
            "tsx",
            CLI_ENTRY,
            "--engine",
            "api",
            "--prompt",
            "Child missing followup model",
            "--model",
            "gpt-5.1",
            "--followup",
            parentId,
          ],
          { env },
        );
        throw new Error("Expected oracle CLI to fail but it succeeded.");
      } catch (error) {
        const stderr =
          error && typeof error === "object" && error !== null && "stderr" in error
            ? String((error as { stderr?: unknown }).stderr ?? "")
            : "";
        expect(stderr).toMatch(/multiple model runs/i);
        expect(stderr).toMatch(/--followup-model/i);
      }

      await rm(oracleHome, { recursive: true, force: true });
    },
    INTEGRATION_TIMEOUT,
  );

  test(
    "uses --followup-model to continue from the selected parent model response",
    async () => {
      const oracleHome = await mkdtemp(path.join(os.tmpdir(), "oracle-followup-multi-select-"));
      const env = {
        ...process.env,
        // biome-ignore lint/style/useNamingConvention: env var name
        OPENAI_API_KEY: "sk-integration",
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_HOME_DIR: oracleHome,
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_CLIENT_FACTORY: CLIENT_FACTORY,
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_NO_DETACH: "1",
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_DISABLE_KEYTAR: "1",
      };

      await execFileAsync(
        process.execPath,
        [
          "--import",
          "tsx",
          CLI_ENTRY,
          "--prompt",
          "Parent multi followup select",
          "--models",
          "gpt-5.1,gpt-5.2",
        ],
        { env },
      );

      const sessionsDir = path.join(oracleHome, "sessions");
      const [parentId] = await readdir(sessionsDir);
      expect(parentId).toBeTruthy();

      const parentMeta = JSON.parse(
        await readFile(path.join(sessionsDir, parentId, "meta.json"), "utf8"),
      );
      const selectedRun = (
        (parentMeta.models as
          | Array<{ model: string; response?: { responseId?: string } }>
          | undefined) ?? []
      ).find((run) => run.model === "gpt-5.2");
      const selectedResponseId = selectedRun?.response?.responseId;
      expect(selectedResponseId).toBeTruthy();
      expect(String(selectedResponseId).startsWith("resp_")).toBe(true);

      await execFileAsync(
        process.execPath,
        [
          "--import",
          "tsx",
          CLI_ENTRY,
          "--engine",
          "api",
          "--prompt",
          "Child with followup model select",
          "--model",
          "gpt-5.1",
          "--followup",
          parentId,
          "--followup-model",
          "gpt-5.2",
        ],
        { env },
      );

      const allSessions = await readdir(sessionsDir);
      expect(allSessions.length).toBe(2);
      const childId = allSessions.find((id) => id !== parentId);
      expect(childId).toBeTruthy();
      const childMeta = JSON.parse(
        await readFile(path.join(sessionsDir, childId as string, "meta.json"), "utf8"),
      );
      expect(childMeta.options?.previousResponseId).toBe(selectedResponseId);
      expect(childMeta.options?.followupSessionId).toBe(parentId);
      expect(childMeta.options?.followupModel).toBe("gpt-5.2");

      await rm(oracleHome, { recursive: true, force: true });
    },
    INTEGRATION_TIMEOUT,
  );

  test(
    "rejects mixing --model and --models regardless of source",
    async () => {
      const oracleHome = await mkdtemp(path.join(os.tmpdir(), "oracle-multi-conflict-"));
      const env = {
        ...process.env,
        // biome-ignore lint/style/useNamingConvention: env var name
        OPENAI_API_KEY: "sk-integration",
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_HOME_DIR: oracleHome,
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_CLIENT_FACTORY: CLIENT_FACTORY,
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_DISABLE_KEYTAR: "1",
      };

      try {
        await execFileAsync(
          process.execPath,
          [
            "--import",
            "tsx",
            CLI_ENTRY,
            "--prompt",
            "conflict",
            "--model",
            "gpt-5.1",
            "--models",
            "gpt-5.1-pro",
          ],
          { env },
        );
        throw new Error("Expected oracle CLI to fail but it succeeded.");
      } catch (error) {
        const stderr =
          error && typeof error === "object" && error !== null && "stderr" in error
            ? String((error as { stderr?: unknown }).stderr ?? "")
            : "";
        expect(stderr).toMatch(/--models cannot be combined with --model/i);
      }

      await rm(oracleHome, { recursive: true, force: true });
    },
    INTEGRATION_TIMEOUT,
  );

  test(
    "runs gpt-5.1-codex via API-only path",
    async () => {
      const oracleHome = await mkdtemp(path.join(os.tmpdir(), "oracle-codex-"));
      const env = {
        ...process.env,
        // biome-ignore lint/style/useNamingConvention: environment variable name
        OPENAI_API_KEY: "sk-integration",
        // biome-ignore lint/style/useNamingConvention: environment variable name
        ORACLE_HOME_DIR: oracleHome,
        // biome-ignore lint/style/useNamingConvention: environment variable name
        ORACLE_CLIENT_FACTORY: CLIENT_FACTORY,
        // biome-ignore lint/style/useNamingConvention: environment variable name
        ORACLE_NO_DETACH: "1",
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_DISABLE_KEYTAR: "1",
      };

      await execFileAsync(
        process.execPath,
        ["--import", "tsx", CLI_ENTRY, "--prompt", "Codex integration", "--model", "gpt-5.1-codex"],
        { env },
      );

      const sessionsDir = path.join(oracleHome, "sessions");
      const sessionIds = await readdir(sessionsDir);
      expect(sessionIds.length).toBe(1);
      const metadataPath = path.join(sessionsDir, sessionIds[0], "meta.json");
      const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
      expect(metadata.model).toBe("gpt-5.1-codex");
      expect(metadata.mode).toBe("api");
      expect(metadata.usage?.totalTokens).toBe(20);

      await rm(oracleHome, { recursive: true, force: true });
    },
    INTEGRATION_TIMEOUT,
  );

  test(
    "rejects gpt-5.1-codex-max until OpenAI ships the API",
    async () => {
      const oracleHome = await mkdtemp(path.join(os.tmpdir(), "oracle-codex-max-"));
      const env = {
        ...process.env,
        // biome-ignore lint/style/useNamingConvention: environment variable name
        OPENAI_API_KEY: "sk-integration",
        // biome-ignore lint/style/useNamingConvention: environment variable name
        ORACLE_HOME_DIR: oracleHome,
        // biome-ignore lint/style/useNamingConvention: environment variable name
        ORACLE_CLIENT_FACTORY: CLIENT_FACTORY,
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_DISABLE_KEYTAR: "1",
      };

      try {
        await execFileAsync(
          process.execPath,
          [
            "--import",
            "tsx",
            CLI_ENTRY,
            "--prompt",
            "Codex Max integration",
            "--model",
            "gpt-5.1-codex-max",
          ],
          { env },
        );
        throw new Error("Expected oracle CLI to fail but it succeeded.");
      } catch (error) {
        const stderr =
          error && typeof error === "object" && error !== null && "stderr" in error
            ? String((error as { stderr?: unknown }).stderr ?? "")
            : "";
        expect(stderr).toMatch(/codex-max is not available yet/i);
      }

      await rm(oracleHome, { recursive: true, force: true });
    },
    INTEGRATION_TIMEOUT,
  );

  test(
    "runs multi-model across OpenAI, Gemini, and Claude with custom factory",
    async () => {
      const oracleHome = await mkdtemp(path.join(os.tmpdir(), "oracle-multi-"));
      const env = {
        ...process.env,
        // biome-ignore lint/style/useNamingConvention: env var name
        OPENAI_API_KEY: "sk-integration",
        // biome-ignore lint/style/useNamingConvention: env var name
        GEMINI_API_KEY: "gk-integration",
        // biome-ignore lint/style/useNamingConvention: env var name
        ANTHROPIC_API_KEY: "ak-integration",
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_HOME_DIR: oracleHome,
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_CLIENT_FACTORY: path.join(process.cwd(), "tests", "fixtures", "mockPolyClient.cjs"),
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_NO_DETACH: "1",
      };

      await execFileAsync(
        process.execPath,
        [
          "--import",
          "tsx",
          CLI_ENTRY,
          "--engine",
          "api",
          "--prompt",
          "Multi run test prompt long enough",
          "--models",
          "gpt-5.1,gemini-3-pro,claude-4.6-sonnet",
        ],
        { env },
      );

      const sessionsDir = path.join(oracleHome, "sessions");
      const sessionIds = await readdir(sessionsDir);
      expect(sessionIds.length).toBe(1);
      const sessionDir = path.join(sessionsDir, sessionIds[0]);
      const metadata = JSON.parse(await readFile(path.join(sessionDir, "meta.json"), "utf8"));
      const selectedModels = (metadata.models as Array<{ model: string }> | undefined)?.map(
        (m: { model: string }) => m.model,
      );
      expect(selectedModels).toEqual(
        expect.arrayContaining(["gpt-5.1", "gemini-3-pro", "claude-4.6-sonnet"]),
      );
      expect(metadata.status).toBe("completed");

      await rm(oracleHome, { recursive: true, force: true });
    },
    INTEGRATION_TIMEOUT,
  );

  test(
    "allows partial multi-model success and reports saved outputs before failures",
    async () => {
      const oracleHome = await mkdtemp(path.join(os.tmpdir(), "oracle-multi-partial-"));
      const outputPath = path.join(oracleHome, "answer.md");
      const env = {
        ...process.env,
        // biome-ignore lint/style/useNamingConvention: env var name
        OPENAI_API_KEY: "sk-integration",
        // biome-ignore lint/style/useNamingConvention: env var name
        GEMINI_API_KEY: "gk-integration",
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_HOME_DIR: oracleHome,
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_CLIENT_FACTORY: path.join(process.cwd(), "tests", "fixtures", "mockPolyClient.cjs"),
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_NO_DETACH: "1",
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_TEST_FAIL_MODEL: "gemini-3-pro",
      };

      const result = await execFileAsync(
        process.execPath,
        [
          "--import",
          "tsx",
          CLI_ENTRY,
          "--prompt",
          "Partial multi-model run prompt long enough",
          "--models",
          "gpt-5.1,gemini-3-pro",
          "--allow-partial",
          "--write-output",
          outputPath,
        ],
        { env },
      );

      const sessionsDir = path.join(oracleHome, "sessions");
      const [sessionId] = await readdir(sessionsDir);
      const sessionDir = path.join(sessionsDir, sessionId);
      const metadata = JSON.parse(await readFile(path.join(sessionDir, "meta.json"), "utf8"));
      expect(metadata.status).toBe("partial");
      expect(metadata.options?.partialMode).toBe("ok");
      expect(await readFile(path.join(oracleHome, "answer.gpt-5.1.md"), "utf8")).toContain(
        "Echo(gpt-5.1)",
      );
      const manifest = JSON.parse(
        await readFile(path.join(oracleHome, "answer.oracle.json"), "utf8"),
      );
      expect(manifest).toMatchObject({
        version: 1,
        sessionId,
        status: "partial",
        outputBasePath: outputPath,
        models: [
          {
            model: "gpt-5.1",
            status: "completed",
            outputPath: path.join(oracleHome, "answer.gpt-5.1.md"),
            usage: { totalTokens: 20 },
          },
          {
            model: "gemini-3-pro",
            status: "error",
          },
        ],
      });
      expect(manifest.models[0].logPath).toContain("gpt-5.1.log");
      expect(manifest.models[1].logPath).toContain("gemini-3-pro.log");

      const savedIndex = result.stdout.indexOf("Saved outputs:");
      const logsIndex = result.stdout.indexOf("Run logs:");
      const failuresIndex = result.stdout.indexOf("Failures:");
      expect(result.stdout).toContain("Multi-model result: partial success, 1/2 succeeded");
      expect(savedIndex).toBeGreaterThanOrEqual(0);
      expect(logsIndex).toBeGreaterThan(savedIndex);
      expect(failuresIndex).toBeGreaterThan(logsIndex);
      expect(result.stdout).toContain("Output manifest:");
      expect(result.stdout).toContain("gemini-3-pro");

      await execFileAsync(
        process.execPath,
        ["--import", "tsx", CLI_ENTRY, "--exec-session", sessionId],
        {
          env,
        },
      );
      const rerunMetadata = JSON.parse(await readFile(path.join(sessionDir, "meta.json"), "utf8"));
      expect(rerunMetadata.status).toBe("partial");

      await rm(oracleHome, { recursive: true, force: true });
    },
    INTEGRATION_TIMEOUT,
  );

  test(
    "accepts shorthand multi-model list and normalizes to canonical IDs",
    async () => {
      const oracleHome = await mkdtemp(path.join(os.tmpdir(), "oracle-multi-shorthand-"));
      const env = {
        ...process.env,
        // biome-ignore lint/style/useNamingConvention: env var name
        OPENAI_API_KEY: "sk-integration",
        // biome-ignore lint/style/useNamingConvention: env var name
        GEMINI_API_KEY: "gk-integration",
        // biome-ignore lint/style/useNamingConvention: env var name
        ANTHROPIC_API_KEY: "ak-integration",
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_HOME_DIR: oracleHome,
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_CLIENT_FACTORY: path.join(process.cwd(), "tests", "fixtures", "mockPolyClient.cjs"),
        // biome-ignore lint/style/useNamingConvention: env var name
        ORACLE_NO_DETACH: "1",
      };

      await execFileAsync(
        process.execPath,
        [
          "--import",
          "tsx",
          CLI_ENTRY,
          "--engine",
          "api",
          "--prompt",
          "Shorthand multi-model normalization prompt that is safely over twenty characters.",
          "--models",
          "gpt-5.1,gemini,sonnet",
        ],
        { env },
      );

      const sessionsDir = path.join(oracleHome, "sessions");
      const sessionIds = await readdir(sessionsDir);
      expect(sessionIds.length).toBe(1);
      const sessionDir = path.join(sessionsDir, sessionIds[0]);
      const metadata = JSON.parse(await readFile(path.join(sessionDir, "meta.json"), "utf8"));
      const selectedModels = (metadata.models as Array<{ model: string }> | undefined)?.map(
        (m: { model: string }) => m.model,
      );
      expect(selectedModels).toEqual(
        expect.arrayContaining(["gpt-5.1", "gemini-3-pro", "claude-4.6-sonnet"]),
      );
      expect(metadata.status).toBe("completed");

      await rm(oracleHome, { recursive: true, force: true });
    },
    INTEGRATION_TIMEOUT,
  );

  test(
    "honors --max-file-size-bytes for root dry-runs ahead of env defaults",
    async () => {
      const oracleHome = await mkdtemp(path.join(os.tmpdir(), "oracle-max-file-"));
      const testFile = path.join(oracleHome, "large.txt");
      await writeFile(testFile, "x".repeat(64), "utf8");

      const env = {
        ...process.env,
        ORACLE_HOME_DIR: oracleHome,
        ORACLE_DISABLE_KEYTAR: "1",
        ORACLE_MAX_FILE_SIZE_BYTES: "10",
      };

      const { stdout } = await execFileAsync(
        process.execPath,
        [
          "--import",
          "tsx",
          CLI_ENTRY,
          "--dry-run",
          "summary",
          "--engine",
          "browser",
          "--prompt",
          "Integration dry run",
          "--file",
          testFile,
          "--max-file-size-bytes",
          "128",
        ],
        { env },
      );

      expect(stdout).toContain("[preview]");
      expect(stdout).toContain("includes 1 inline file");

      await rm(oracleHome, { recursive: true, force: true });
    },
    INTEGRATION_TIMEOUT,
  );

  test(
    "skips text-file preflight for raw browser uploads before remote browser dispatch",
    async () => {
      const oracleHome = await mkdtemp(path.join(os.tmpdir(), "oracle-raw-preflight-"));
      const archivePath = path.join(oracleHome, "archive.zip");
      await writeFile(archivePath, Buffer.alloc(1_100_000));

      const env = {
        ...productionCliEnv(),
        ORACLE_HOME_DIR: oracleHome,
      };

      const result = await execCli(
        [
          "--engine",
          "browser",
          "--remote-host",
          "127.0.0.1:9",
          "--remote-token",
          "test-token",
          "--browser-attachments",
          "always",
          "--prompt",
          "Raw preflight browser upload check",
          "--file",
          archivePath,
        ],
        { env, timeout: INTEGRATION_TIMEOUT },
      );

      const output = `${result.stdout}\n${result.stderr}`;
      expect(result.code).toBe(1);
      expect(output).toContain("Remote browser host detected: 127.0.0.1:9");
      expect(output).toContain("Routing browser automation to remote host 127.0.0.1:9");
      expect(output).not.toMatch(/exceed the 1 MB limit|file-validation/i);
      expect(output).not.toMatch(/Oracle v1 agent runs are gated|agent_lane_blocked/i);
      expect(output).toMatch(/127\.0\.0\.1:9|fetch failed|ECONNREFUSED/i);

      await rm(oracleHome, { recursive: true, force: true });
    },
    INTEGRATION_TIMEOUT,
  );

  test(
    "ignores ambient remote browser config for local fable-lane dry runs",
    async () => {
      for (const token of ["test-token", undefined]) {
        const env = productionCliEnv({
          ORACLE_HOME_DIR: path.join(os.tmpdir(), `oracle-fable-local-${Date.now()}`),
          ORACLE_REMOTE_HOST: "127.0.0.1:9470",
          ORACLE_REMOTE_BROWSER: "required",
          ...(token ? { ORACLE_REMOTE_TOKEN: token } : {}),
        });
        delete env.ORACLE_ENGINE;
        if (!token) {
          delete env.ORACLE_REMOTE_TOKEN;
        }

        const result = await execCli(
          [
            "--lane",
            "fable-local",
            "--prompt",
            "Remote config should not reroute local Fable",
            "--file",
            "README.md",
            "--dry-run",
            "json",
          ],
          { env, timeout: INTEGRATION_TIMEOUT },
        );

        expect(result.code).toBe(0);
        expect(`${result.stdout}\n${result.stderr}`).not.toMatch(
          /agent_lane_blocked|route-block|remote_browser_token_missing/i,
        );
        expect(result.stdout).toContain("would run Claude Code local mode (fable)");
        expect(result.stdout).toContain("Route: claude-code/local; model=fable");
      }
    },
    INTEGRATION_TIMEOUT,
  );

  test.each([
    {
      label: "cli remote host",
      args: ["--remote-host", "127.0.0.1:9", "--remote-token", "test-token"],
      env: {},
      config: null,
    },
    {
      label: "env remote host",
      args: [],
      env: {
        ORACLE_REMOTE_HOST: "127.0.0.1:9",
        ORACLE_REMOTE_TOKEN: "test-token",
      },
      config: null,
    },
    {
      label: "config remote host",
      args: [],
      env: {},
      config: {
        browser: {
          remoteHost: "127.0.0.1:9",
          remoteToken: "test-token",
        },
      },
    },
  ])(
    "routes ordinary browser runs from $label before remote transport failure",
    async ({ args, env: envOverrides, config }) => {
      const oracleHome = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-route-"));
      if (config) {
        await writeFile(path.join(oracleHome, "config.json"), JSON.stringify(config), "utf8");
      }
      const env = productionCliEnv({
        ORACLE_HOME_DIR: oracleHome,
        ...envOverrides,
      });
      delete env.ORACLE_ENGINE;

      const result = await execCli(
        [
          ...args,
          "--model",
          "gpt-5.1",
          "--prompt",
          "Remote router production-mode regression check",
        ],
        { env, timeout: INTEGRATION_TIMEOUT },
      );

      const output = `${result.stdout}\n${result.stderr}`;
      expect(result.code).toBe(1);
      expect(output).toContain("Remote browser host detected: 127.0.0.1:9");
      expect(output).toContain("Routing browser automation to remote host 127.0.0.1:9");
      expect(output).not.toMatch(/Oracle v1 agent runs are gated|agent_lane_blocked/i);
      expect(output).toMatch(/127\.0\.0\.1:9|fetch failed|ECONNREFUSED/i);

      await rm(oracleHome, { recursive: true, force: true });
    },
    INTEGRATION_TIMEOUT,
  );
});

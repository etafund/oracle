import { afterAll, afterEach, beforeEach, describe, expect, test } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  REDACTED_CONFIG_VALUE,
  buildConfigExplainReport,
  formatConfigExplainHuman,
  formatConfigExplainJson,
  runConfigExplain,
  type ConfigExplainEntry,
} from "../../src/cli/configExplain.js";
import { PROJECT_CONFIG_RELATIVE_PATH } from "../../src/config.js";
import { setOracleHomeDirOverrideForTest } from "../../src/oracleHome.js";
import { assertNoLeaks } from "../_helpers/secretLeakDetector.js";

const NOW = new Date("2026-07-05T12:00:00.000Z");
const USER_REMOTE_TOKEN = "sk-proj-user-config-explain-12345678901234567890";
const ENV_REMOTE_TOKEN = "sk-proj-env-config-explain-12345678901234567890";
const PROJECT_REMOTE_TOKEN = "sk-proj-project-config-explain-12345678901234567890";
const PROMPT_SUFFIX_SECRET = "Bearer sk-proj-prompt-suffix-12345678901234567890";

describe("config explain helper", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-config-explain-"));
    setOracleHomeDirOverrideForTest(tempDir);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  afterAll(() => {
    setOracleHomeDirOverrideForTest(null);
  });

  test("reports redacted effective config with source annotations", async () => {
    const userConfigPath = path.join(tempDir, "config.json");
    await fs.writeFile(
      userConfigPath,
      `{
        engine: "api",
        model: "gpt-5.5",
        apiBaseUrl: "https://safe-gateway.example/v1",
        promptSuffix: "${PROMPT_SUFFIX_SECRET}",
        browser: {
          remoteHost: "user-host:9473",
          remoteToken: "${USER_REMOTE_TOKEN}",
          thinkingTime: "heavy",
        },
      }`,
      "utf8",
    );

    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-config-explain-repo-"));
    await fs.mkdir(path.join(repoDir, ".oracle"), { recursive: true });
    const projectConfigPath = path.join(repoDir, PROJECT_CONFIG_RELATIVE_PATH);
    await fs.writeFile(
      projectConfigPath,
      `{
        model: "gpt-5.4",
        apiBaseUrl: "https://evil.example/v1",
        azure: { endpoint: "https://evil.azure.example/" },
        modelOverrides: {
          "gpt-5.4": { apiModel: "evil-rerouted-model" },
        },
        browser: {
          chatgptUrl: "https://chatgpt.com/g/g-p-project/project",
          modelStrategy: "current",
          remoteToken: "${PROJECT_REMOTE_TOKEN}",
          chromeCookiePath: "/tmp/Cookies",
        },
      }`,
      "utf8",
    );

    const report = await buildConfigExplainReport({
      cwd: repoDir,
      env: {
        ORACLE_ENGINE: "browser",
        ORACLE_REMOTE_TOKEN: ENV_REMOTE_TOKEN,
      } as NodeJS.ProcessEnv,
      now: NOW,
    });

    expect(report.schema_version).toBe("oracle_config_explain.v1");
    expect(report.generated_at).toBe(NOW.toISOString());
    expect(report.user_config_path).toBe(userConfigPath);
    expect(report.user_config_loaded).toBe(true);
    expect(report.loaded_paths).toEqual([userConfigPath, projectConfigPath]);
    expect(report.files).toEqual([
      { kind: "user", path: userConfigPath, loaded: true },
      { kind: "project", path: projectConfigPath, loaded: true },
    ]);

    expect(report.effective_config).toMatchObject({
      engine: "browser",
      model: "gpt-5.4",
      apiBaseUrl: "https://safe-gateway.example/v1",
      promptSuffix: "Bearer [redacted]",
      browser: {
        remoteHost: "user-host:9473",
        remoteToken: REDACTED_CONFIG_VALUE,
        chatgptUrl: "https://chatgpt.com/g/g-p-project/project",
        modelStrategy: "current",
        thinkingTime: "heavy",
      },
    });

    expect(entry(report.entries, "engine").source).toEqual({
      kind: "env",
      env: "ORACLE_ENGINE",
    });
    expect(entry(report.entries, "model").source).toEqual({
      kind: "project",
      path: projectConfigPath,
    });
    expect(entry(report.entries, "apiBaseUrl").source).toEqual({
      kind: "user",
      path: userConfigPath,
    });
    expect(entry(report.entries, "browser.remoteToken").source).toEqual({
      kind: "env",
      env: "ORACLE_REMOTE_TOKEN",
    });
    expect(entry(report.entries, "browser.chatgptUrl").source).toEqual({
      kind: "project",
      path: projectConfigPath,
    });

    expect(report.redaction.redacted_paths).toEqual(
      expect.arrayContaining(["browser.remoteToken", "promptSuffix"]),
    );
    expect(report.ignored_project_keys).toEqual(
      expect.arrayContaining([
        {
          path: projectConfigPath,
          key_path: "apiBaseUrl",
          reason: "project_config_disallowed",
        },
        {
          path: projectConfigPath,
          key_path: "azure.endpoint",
          reason: "project_config_disallowed",
        },
        {
          path: projectConfigPath,
          key_path: "browser.chromeCookiePath",
          reason: "project_config_disallowed",
        },
        {
          path: projectConfigPath,
          key_path: "browser.remoteToken",
          reason: "project_config_disallowed",
        },
        {
          path: projectConfigPath,
          key_path: "modelOverrides.gpt-5.4.apiModel",
          reason: "project_config_disallowed",
        },
      ]),
    );

    const serialized = formatConfigExplainJson(report) + formatConfigExplainHuman(report);
    assertNoLeaks(serialized, {
      skipForbiddenKeys: true,
      fakes: [
        { name: "user-remote-token", value: USER_REMOTE_TOKEN },
        { name: "env-remote-token", value: ENV_REMOTE_TOKEN },
        { name: "project-remote-token", value: PROJECT_REMOTE_TOKEN },
        { name: "prompt-suffix-secret", value: PROMPT_SUFFIX_SECRET },
      ],
    });
  });

  test("redacts URL-userinfo credentials regardless of the config key name", async () => {
    const userConfigPath = path.join(tempDir, "config.json");
    await fs.writeFile(
      userConfigPath,
      `{
        apiBaseUrl: "https://proxyuser:s3cr3tPass@proxy.internal/v1",
        promptSuffix: "route via https://alice:hunter2c4nd0r@mirror.example/path when asked",
        azure: { endpoint: "https://svc-identity-leak@azure.example/" },
      }`,
      "utf8",
    );

    const report = await buildConfigExplainReport({
      cwd: tempDir,
      includeProject: false,
      env: {} as NodeJS.ProcessEnv,
      now: NOW,
    });

    // Whole-URL values with userinfo get the entire userinfo redacted.
    expect(report.effective_config.apiBaseUrl).toBe("https://[redacted]@proxy.internal/v1");
    // Username-only userinfo is still identity-leaking and gets redacted too.
    expect((report.effective_config.azure as Record<string, unknown>).endpoint).toBe(
      "https://[redacted]@azure.example/",
    );
    // URLs embedded inside larger strings get their password redacted.
    expect(report.effective_config.promptSuffix).toBe(
      "route via https://alice:[redacted]@mirror.example/path when asked",
    );

    expect(report.redaction.redacted_paths).toEqual(
      expect.arrayContaining(["apiBaseUrl", "azure.endpoint", "promptSuffix"]),
    );

    const serialized = formatConfigExplainJson(report) + formatConfigExplainHuman(report);
    expect(serialized).not.toContain("s3cr3tPass");
    expect(serialized).not.toContain("hunter2c4nd0r");
    expect(serialized).not.toContain("svc-identity-leak");
  });

  test("reports invalid project ChatGPT URLs as ignored without exposing values", async () => {
    const userConfigPath = path.join(tempDir, "config.json");
    await fs.writeFile(
      userConfigPath,
      `{
        browser: {
          chatgptUrl: "https://chatgpt.com/g/g-p-user/project",
        },
      }`,
      "utf8",
    );

    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-config-explain-repo-"));
    await fs.mkdir(path.join(repoDir, ".oracle"), { recursive: true });
    const projectConfigPath = path.join(repoDir, PROJECT_CONFIG_RELATIVE_PATH);
    await fs.writeFile(
      projectConfigPath,
      `{
        browser: {
          chatgptUrl: "https://attacker.example/project?token=${PROJECT_REMOTE_TOKEN}",
        },
      }`,
      "utf8",
    );

    const report = await buildConfigExplainReport({
      cwd: repoDir,
      env: {} as NodeJS.ProcessEnv,
      now: NOW,
    });

    expect(report.effective_config.browser).toMatchObject({
      chatgptUrl: "https://chatgpt.com/g/g-p-user/project",
    });
    expect(report.ignored_project_keys).toEqual([
      {
        path: projectConfigPath,
        key_path: "browser.chatgptUrl",
        reason: "invalid_or_untrusted_chatgpt_url",
      },
    ]);
    expect(formatConfigExplainJson(report)).not.toContain("attacker.example");
    expect(formatConfigExplainHuman(report)).not.toContain("attacker.example");
  });

  test("can render JSON or human output through the IO wrapper", async () => {
    const jsonOutput: string[] = [];
    const jsonReport = await runConfigExplain(
      { env: {} as NodeJS.ProcessEnv, now: NOW, json: true },
      { stdout: (text) => jsonOutput.push(text) },
    );

    expect(JSON.parse(jsonOutput.join(""))).toMatchObject({
      schema_version: "oracle_config_explain.v1",
      generated_at: NOW.toISOString(),
      effective_config: {
        engine: "browser",
        model: "gpt-5.5-pro",
      },
    });
    expect(jsonReport.entries.map((configEntry) => configEntry.path)).toContain("engine");

    const humanOutput: string[] = [];
    await runConfigExplain(
      { env: {} as NodeJS.ProcessEnv, now: NOW, json: false },
      { stdout: (text) => humanOutput.push(text) },
    );

    expect(humanOutput.join("")).toContain("🧿 oracle config explain");
    expect(humanOutput.join("")).toContain('engine: "browser" (default)');
  });
});

function entry(entries: readonly ConfigExplainEntry[], configPath: string): ConfigExplainEntry {
  const found = entries.find((candidate) => candidate.path === configPath);
  expect(found, `expected config explain entry for ${configPath}`).toBeDefined();
  return found!;
}

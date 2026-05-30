import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { mapConsultToRunOptions } from "../../src/mcp/utils.js";
import { setOracleHomeDirOverrideForTest } from "../../src/oracleHome.js";

describe("mapConsultToRunOptions", () => {
  afterEach(() => {
    setOracleHomeDirOverrideForTest(null);
  });

  test("passes multi-model selections through to run options", () => {
    const env: NodeJS.ProcessEnv = {};
    env.OPENAI_API_KEY = "sk-test";
    const { runOptions } = mapConsultToRunOptions({
      prompt: "multi",
      files: [],
      model: "gpt-5.2-pro",
      models: ["gemini-3-pro"],
      userConfig: undefined,
      env,
    });
    expect(runOptions.model).toBe("gpt-5.2-pro");
    expect(runOptions.models).toEqual(["gpt-5.2-pro", "gemini-3-pro"]);
  });

  test("maps browser follow-ups into run options", () => {
    const env: NodeJS.ProcessEnv = {};
    const { runOptions, resolvedEngine } = mapConsultToRunOptions({
      prompt: "review",
      files: [],
      model: "gpt-5.5-pro",
      engine: "browser",
      browserFollowUps: [" challenge previous answer ", "", "final concise decision"],
      userConfig: undefined,
      env,
    });

    expect(resolvedEngine).toBe("browser");
    expect(runOptions.browserFollowUps).toEqual([
      "challenge previous answer",
      "final concise decision",
    ]);
  });

  test("maps external ChatGPT image output paths when external output is allowed", () => {
    const env: NodeJS.ProcessEnv = { ORACLE_MCP_ALLOW_EXTERNAL_OUTPUT: "1" };
    const { runOptions, resolvedEngine } = mapConsultToRunOptions({
      prompt: "generate a product mockup",
      files: [],
      model: "gpt-5.5-pro",
      engine: "browser",
      generateImage: " /tmp/mockup.png ",
      outputPath: " /tmp/fallback.png ",
      userConfig: undefined,
      env,
    });

    expect(resolvedEngine).toBe("browser");
    expect(runOptions.generateImage).toBe(path.resolve("/tmp/mockup.png"));
    expect(runOptions.outputPath).toBe(path.resolve("/tmp/fallback.png"));
  });

  test("rejects MCP output paths outside the Oracle home by default", () => {
    const home = mkdtempSync(path.join(tmpdir(), "oracle-home-"));
    setOracleHomeDirOverrideForTest(home);
    try {
      expect(() =>
        mapConsultToRunOptions({
          prompt: "x",
          files: [],
          model: "gpt-5.5-pro",
          engine: "browser",
          generateImage: "/tmp/escape.png",
          userConfig: undefined,
          env: {},
        }),
      ).toThrow(/Oracle home directory/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("rejects traversal escapes from the Oracle home", () => {
    const home = mkdtempSync(path.join(tmpdir(), "oracle-home-"));
    setOracleHomeDirOverrideForTest(home);
    try {
      expect(() =>
        mapConsultToRunOptions({
          prompt: "x",
          files: [],
          model: "gpt-5.5-pro",
          engine: "browser",
          generateImage: path.join(home, "..", "escape.png"),
          userConfig: undefined,
          env: {},
        }),
      ).toThrow(/Oracle home directory/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("allows MCP output paths under the Oracle home without opt-in", () => {
    const home = mkdtempSync(path.join(tmpdir(), "oracle-home-"));
    setOracleHomeDirOverrideForTest(home);
    try {
      const target = path.join(home, "generated", "img.png");
      const { runOptions } = mapConsultToRunOptions({
        prompt: "x",
        files: [],
        model: "gpt-5.5-pro",
        engine: "browser",
        generateImage: target,
        userConfig: undefined,
        env: {},
      });
      expect(runOptions.generateImage).toBe(target);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

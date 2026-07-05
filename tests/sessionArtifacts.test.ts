import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { SessionMetadata } from "../src/sessionManager.js";
import { buildSessionArtifactIndex, createSecretSafePathDisplay } from "../src/sessionArtifacts.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function createFixtureSession(sessionId = "artifact-index-session"): Promise<{
  homeDir: string;
  sessionDir: string;
  artifactsDir: string;
}> {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-session-artifacts-"));
  roots.push(homeDir);
  const sessionDir = path.join(homeDir, "sessions", sessionId);
  const artifactsDir = path.join(sessionDir, "artifacts");
  await fs.mkdir(artifactsDir, { recursive: true });
  return { homeDir, sessionDir, artifactsDir };
}

async function writeFixtureFile(filePath: string, contents = "fixture\n"): Promise<string> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, contents, "utf8");
  return filePath;
}

function entriesByPath(index: Awaited<ReturnType<typeof buildSessionArtifactIndex>>) {
  return new Map(index.entries.map((entry) => [entry.displayPath, entry]));
}

describe("buildSessionArtifactIndex", () => {
  test("indexes metadata artifacts and discovered diagnostics, perf traces, logs, and Claude Code files", async () => {
    const { homeDir, sessionDir, artifactsDir } = await createFixtureSession();
    const transcriptPath = await writeFixtureFile(
      path.join(artifactsDir, "transcript.md"),
      "# Transcript\n",
    );
    const imagePath = await writeFixtureFile(path.join(artifactsDir, "image.png"), "png");
    const downloadPath = await writeFixtureFile(path.join(artifactsDir, "package.zip"), "zip");
    const reportPath = await writeFixtureFile(
      path.join(artifactsDir, "deep-research-report.md"),
      "# Report\n",
    );
    await writeFixtureFile(
      path.join(artifactsDir, "assistant-timeout-2026-07-05.dom.json"),
      "{}\n",
    );
    await writeFixtureFile(path.join(artifactsDir, "assistant-timeout-2026-07-05.png"), "png");
    await writeFixtureFile(path.join(artifactsDir, "oracle-perf.trace.json"), '{"events":[]}\n');
    const outputLogPath = await writeFixtureFile(path.join(sessionDir, "output.log"), "Answer\n");
    const modelLogPath = await writeFixtureFile(
      path.join(sessionDir, "models", "gpt-5.log"),
      "model answer\n",
    );
    const claudeStdoutPath = await writeFixtureFile(
      path.join(artifactsDir, "claude-code-stdout.raw"),
      "raw stdout\n",
    );
    const claudeStderrPath = await writeFixtureFile(
      path.join(artifactsDir, "claude-code-stderr.raw"),
      "raw stderr\n",
    );
    const claudeEventsPath = await writeFixtureFile(
      path.join(artifactsDir, "claude-code-events.normalized.ndjson"),
      "{}\n",
    );
    const claudeFinalPath = await writeFixtureFile(
      path.join(artifactsDir, "claude-code-final.md"),
      "final\n",
    );
    const claudeAdapterPath = await writeFixtureFile(
      path.join(artifactsDir, "claude-code-adapter.json"),
      "{}\n",
    );
    const missingMetadataPath = path.join(artifactsDir, "missing.csv");
    const metadata: SessionMetadata = {
      id: "artifact-index-session",
      createdAt: "2026-07-05T00:00:00.000Z",
      status: "completed",
      mode: "claude-code",
      model: "fable",
      options: {},
      artifacts: [
        {
          kind: "transcript",
          path: transcriptPath,
          label: "Browser transcript",
          mimeType: "text/markdown",
        },
        { kind: "image", path: imagePath, label: "Generated image", mimeType: "image/png" },
        { kind: "file", path: downloadPath, label: "Downloaded package" },
        {
          kind: "deep-research-report",
          path: reportPath,
          label: "Deep Research report",
        },
        { kind: "file", path: missingMetadataPath, label: "Missing metadata file" },
      ],
      claudeCode: {
        schema_version: "claude_code_session.v1",
        access_path: "claude_code_subscription_cli",
        provider_family: "claude",
        model_requested: "fable",
        model_observed: "claude-fable-5",
        model_usage_keys: ["claude-fable-5"],
        model_verification_status: "observed",
        subscription_billing_uncertain: true,
        credit_billing_warning_emitted: false,
        read_only: {
          readOnly: true,
          permissionMode: "plan",
          toolMode: "none",
          allowedTools: [],
          blockedTools: ["*"],
          mcpToolsBlocked: true,
          slashCommandsDisabled: true,
          safeMode: true,
          chromeDisabled: true,
          sessionPersistenceDisabled: true,
        },
        transcript_fidelity: "visible_cli_stream",
        hidden_reasoning_captured: false,
        visible_thinking_captured: "unknown",
        raw_stdout_path: claudeStdoutPath,
        raw_stderr_path: claudeStderrPath,
        normalized_events_path: claudeEventsPath,
        final_answer_path: claudeFinalPath,
        adapter_metadata_path: claudeAdapterPath,
      },
    };
    await fs.writeFile(path.join(sessionDir, "meta.json"), `${JSON.stringify(metadata)}\n`, "utf8");

    const index = await buildSessionArtifactIndex({ sessionDir, oracleHomeDir: homeDir });
    const byPath = entriesByPath(index);

    expect(index.metadataStatus).toBe("loaded");
    expect(index.sessionId).toBe("artifact-index-session");
    expect(byPath.get("artifacts/transcript.md")).toMatchObject({
      category: "transcript",
      source: "metadata",
      exists: true,
    });
    expect(byPath.get("artifacts/image.png")?.category).toBe("generated-file");
    expect(byPath.get("artifacts/package.zip")?.category).toBe("downloaded-file");
    expect(byPath.get("artifacts/deep-research-report.md")?.category).toBe("report");
    expect(byPath.get("artifacts/assistant-timeout-2026-07-05.dom.json")).toMatchObject({
      category: "diagnostic",
      label: "DOM diagnostic",
    });
    expect(byPath.get("artifacts/assistant-timeout-2026-07-05.png")).toMatchObject({
      category: "diagnostic",
      label: "Screenshot diagnostic",
    });
    expect(byPath.get("artifacts/oracle-perf.trace.json")?.category).toBe("perf-trace");
    expect(byPath.get("output.log")).toMatchObject({
      category: "transcript",
      path: outputLogPath,
    });
    expect(byPath.get("models/gpt-5.log")).toMatchObject({
      category: "transcript",
      path: modelLogPath,
    });
    expect(byPath.get("artifacts/claude-code-stdout.raw")).toMatchObject({
      category: "claude-code-raw",
      source: "claude-code-metadata",
      path: claudeStdoutPath,
    });
    expect(byPath.get("artifacts/claude-code-stderr.raw")?.category).toBe("claude-code-raw");
    expect(byPath.get("artifacts/claude-code-events.normalized.ndjson")?.category).toBe(
      "claude-code-normalized",
    );
    expect(byPath.get("artifacts/claude-code-final.md")?.category).toBe("claude-code-final");
    expect(byPath.get("artifacts/claude-code-adapter.json")?.category).toBe("claude-code-adapter");
    expect(byPath.get("artifacts/missing.csv")).toMatchObject({
      exists: false,
      warnings: ["artifact file is missing"],
    });
    expect(
      index.entries.filter((entry) => entry.displayPath === "artifacts/transcript.md"),
    ).toHaveLength(1);
  });

  test("keeps listing discovered artifacts when metadata is corrupt", async () => {
    const { homeDir, sessionDir, artifactsDir } = await createFixtureSession("corrupt-metadata");
    await writeFixtureFile(path.join(artifactsDir, "transcript.md"), "# Transcript\n");
    await fs.writeFile(path.join(sessionDir, "meta.json"), "{not-json", "utf8");

    const index = await buildSessionArtifactIndex({ sessionDir, oracleHomeDir: homeDir });

    expect(index.metadataStatus).toBe("corrupt");
    expect(index.warnings.join("\n")).toContain("metadata unreadable");
    expect(index.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          displayPath: "artifacts/transcript.md",
          category: "transcript",
          source: "discovered",
        }),
      ]),
    );
  });

  test("reports missing metadata without failing artifact discovery", async () => {
    const { homeDir, sessionDir, artifactsDir } = await createFixtureSession("missing-metadata");
    await writeFixtureFile(path.join(artifactsDir, "report.md"), "# Report\n");

    const index = await buildSessionArtifactIndex({ sessionDir, oracleHomeDir: homeDir });

    expect(index.metadataStatus).toBe("missing");
    expect(index.warnings.join("\n")).toContain("metadata missing");
    expect(index.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          displayPath: "artifacts/report.md",
          category: "report",
        }),
      ]),
    );
  });

  test("uses secret-safe display paths for internal and external paths", async () => {
    const { homeDir, sessionDir, artifactsDir } = await createFixtureSession("secret-display");
    const secretInternalPath = await writeFixtureFile(
      path.join(artifactsDir, "token=super-secret-value", "leak.txt"),
      "secret-ish filename\n",
    );
    const externalPerfTrace = path.join(
      homeDir,
      "outside-session",
      "sk-proj-secret1234567890.json",
    );
    await writeFixtureFile(externalPerfTrace, "{}\n");

    const index = await buildSessionArtifactIndex({
      sessionDir,
      oracleHomeDir: homeDir,
      metadata: {
        id: "secret-display",
        createdAt: "2026-07-05T00:00:00.000Z",
        status: "completed",
        options: {},
        artifacts: [{ kind: "file", path: secretInternalPath }],
      },
      perfTracePaths: [externalPerfTrace, "C:\\Users\\Alice\\Downloads\\token=abc123\\trace.json"],
    });

    const displayPaths = index.entries.map((entry) => entry.displayPath);
    expect(displayPaths).toEqual(
      expect.arrayContaining([
        "artifacts/token=[redacted]/leak.txt",
        "$ORACLE_HOME/outside-session/[redacted].json",
        "external:trace.json",
      ]),
    );
    expect(JSON.stringify(displayPaths)).not.toContain("super-secret-value");
    expect(JSON.stringify(displayPaths)).not.toContain("sk-proj-secret1234567890");
  });

  test("standalone display helper collapses paths under the session directory", () => {
    const sessionDir = path.join(os.tmpdir(), "oracle-home", "sessions", "display-session");
    expect(
      createSecretSafePathDisplay(path.join(sessionDir, "artifacts", "transcript.md"), {
        sessionDir,
      }),
    ).toBe("artifacts/transcript.md");
  });
});

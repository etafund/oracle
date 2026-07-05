import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { beforeAll, afterAll, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../../src/oracle.ts", async () => {
  const actual = await vi.importActual<typeof import("../../src/oracle.ts")>("../../src/oracle.ts");
  return {
    ...actual,
    runOracle: vi.fn(),
  };
});

vi.mock("../../src/oracle/multiModelRunner.ts", () => ({
  runMultiModelApiSession: vi.fn(),
}));

vi.mock("../../src/browser/sessionRunner.ts", () => ({
  runBrowserSessionExecution: vi.fn(),
  ensureSessionArtifacts: vi.fn(async ({ existingArtifacts }) => existingArtifacts),
}));

vi.mock("../../src/browser/reattach.ts", () => ({
  resumeBrowserSession: vi.fn(),
}));

vi.mock("../../src/cli/notifier.ts", () => ({
  sendSessionNotification: vi.fn(),
  deriveNotificationSettingsFromMetadata: vi.fn(() => ({ enabled: true, sound: false })),
}));

const sessionStoreMock = vi.hoisted(() => ({
  updateSession: vi.fn(),
  createLogWriter: vi.fn(),
  updateModelRun: vi.fn(),
  readLog: vi.fn(),
  readSession: vi.fn(),
  readRequest: vi.fn(),
  ensureStorage: vi.fn(),
  listSessions: vi.fn(),
  filterSessions: vi.fn(),
  getPaths: vi.fn(),
  readModelLog: vi.fn(),
  sessionsDir: vi.fn().mockReturnValue("/tmp/.oracle/sessions"),
}));

vi.mock("../../src/sessionStore.ts", () => ({
  sessionStore: sessionStoreMock,
}));

import type { SessionMetadata, SessionModelRun } from "../../src/sessionManager.ts";
import type { ModelName } from "../../src/oracle.ts";
import { performSessionRun } from "../../src/cli/sessionRunner.ts";
import {
  BrowserAutomationError,
  FileValidationError,
  OracleResponseError,
  OracleTransportError,
  runOracle,
} from "../../src/oracle.ts";
import {
  runMultiModelApiSession,
  type ModelExecutionResult,
  type MultiModelRunSummary,
} from "../../src/oracle/multiModelRunner.ts";
import type { OracleResponse, RunOracleResult } from "../../src/oracle.ts";
import {
  ensureSessionArtifacts,
  runBrowserSessionExecution,
} from "../../src/browser/sessionRunner.ts";
import { sendSessionNotification } from "../../src/cli/notifier.ts";
import { getCliVersion } from "../../src/version.ts";
import { deriveModelOutputPath } from "../../src/cli/sessionRunner.ts";
import { resumeBrowserSession } from "../../src/browser/reattach.ts";
import { setOracleHomeDirOverrideForTest } from "../../src/oracleHome.ts";
import { buildClaudeCodeCommand } from "../../src/claude-code/command.ts";
import { ORACLE_CLAUDE_CODE_CAAM_PROFILE_ENV_VAR } from "../../src/claude-code/caamCommand.ts";

const baseSessionMeta: SessionMetadata = {
  id: "sess-1",
  createdAt: "2025-01-01T00:00:00Z",
  status: "pending",
  options: {},
};

const baseRunOptions = {
  prompt: "Hello",
  model: "gpt-5.2-pro" as const,
};

const log = vi.fn();
const write = vi.fn(() => true);
const cliVersion = getCliVersion();
const originalPlatform = process.platform;

async function withExactEnv<T>(
  updates: Record<string, string | undefined>,
  fn: () => Promise<T>,
): Promise<T> {
  const originals = new Map<string, string | undefined>();
  for (const name of Object.keys(updates)) {
    originals.set(name, process.env[name]);
    const value = updates[name];
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
  try {
    return await fn();
  } finally {
    for (const [name, value] of originals) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
}

const blockedClaudeCodeEnvDefaults = {
  ANTHROPIC_API_KEY: undefined,
  ANTHROPIC_AUTH_TOKEN: undefined,
  ANTHROPIC_BASE_URL: undefined,
  ANTHROPIC_DEFAULT_OPUS_MODEL: undefined,
  ANTHROPIC_DEFAULT_SONNET_MODEL: undefined,
  ANTHROPIC_MODEL: undefined,
  CLAUDE_CODE_USE_BEDROCK: undefined,
  CLAUDE_CODE_USE_VERTEX: undefined,
  CLAUDE_CODE_USE_FOUNDRY: undefined,
  CLAUDE_CODE_USE_ANTHROPIC_AWS: undefined,
} satisfies Record<string, string | undefined>;

const fableClaudeCodePolicy = {
  model: "fable",
  readOnly: true,
  inlineEvents: true,
  outputFormat: "stream-json",
  permissionMode: "plan",
  toolMode: "none",
  safeMode: true,
  disableSlashCommands: true,
  strictMcpConfig: true,
  noChrome: true,
  noSessionPersistence: true,
} as const;

function fakeClaudeCodeInitEvent(): Record<string, unknown> {
  return {
    type: "system",
    subtype: "init",
    apiKeySource: "none",
    model: "claude-fable-5",
    tools: [],
    mcp_servers: [],
    permissionMode: "plan",
    slash_commands: [],
    skills: [],
    plugins: [],
    fast_mode_state: "off",
    agents: ["claude", "Explore", "general-purpose", "Plan"],
  };
}

function createFakeClaudeExecutable({
  binDir,
  argvPath,
  stdinPath,
  markerPath,
  stdoutEvents,
  lingerMs = 0,
}: {
  binDir: string;
  argvPath: string;
  stdinPath: string;
  markerPath: string;
  stdoutEvents?: unknown[];
  lingerMs?: number;
}): string {
  const executablePath = path.join(binDir, "claude");
  const initEvent = fakeClaudeCodeInitEvent();
  const resultEvent = {
    type: "result",
    result: "Fake final answer from Claude Code",
    modelUsage: { "claude-fable-5": {} },
    total_cost_usd: 0,
  };
  const events = stdoutEvents ?? [initEvent, resultEvent];
  const script = [
    "#!/usr/bin/env node",
    "const fs = require('node:fs');",
    `const argvPath = ${JSON.stringify(argvPath)};`,
    `const stdinPath = ${JSON.stringify(stdinPath)};`,
    `const markerPath = ${JSON.stringify(markerPath)};`,
    `const stdoutEvents = ${JSON.stringify(events)};`,
    `const lingerMs = ${JSON.stringify(lingerMs)};`,
    "let input = '';",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', (chunk) => { input += chunk; });",
    "process.stdin.on('end', () => {",
    "  fs.writeFileSync(markerPath, 'spawned\\n');",
    "  fs.writeFileSync(argvPath, JSON.stringify(process.argv.slice(2), null, 2));",
    "  fs.writeFileSync(stdinPath, input);",
    "  for (const event of stdoutEvents) {",
    "    process.stdout.write(`${JSON.stringify(event)}\\n`);",
    "  }",
    "  process.stderr.write('fake stderr\\n');",
    "  if (lingerMs > 0) {",
    "    setTimeout(() => process.exit(0), lingerMs);",
    "  }",
    "});",
    "",
  ].join("\n");
  fs.writeFileSync(executablePath, script, { mode: 0o700 });
  return executablePath;
}

// Simulates `caam` for the shallow-spawn integration (caam-map.md §4c/§4a): a
// read-only `shallow-spawn <profile> --print-env --json` pre-flight
// invocation (its own separate process, via `execFile`) followed by the real
// `shallow-spawn <profile> --base <base> -- <claude> <args...>` invocation
// (the actual spawned child) that behaves like `createFakeClaudeExecutable`
// above once "exec'd". Both use the `shallow-spawn` subcommand, so they are
// told apart by the presence of `--print-env` (the pre-flight never passes
// `--base`/`--`, and the real spawn never passes `--print-env`).
function createFakeCaamExecutable({
  binDir,
  doctorInvocationArgvPath,
  shallowSpawnArgvPath,
  markerPath,
  stdinPath,
  doctorHealthy = true,
  stdoutEvents,
}: {
  binDir: string;
  doctorInvocationArgvPath: string;
  shallowSpawnArgvPath: string;
  markerPath: string;
  stdinPath: string;
  doctorHealthy?: boolean;
  stdoutEvents?: unknown[];
}): string {
  const executablePath = path.join(binDir, "caam");
  const initEvent = fakeClaudeCodeInitEvent();
  const resultEvent = {
    type: "result",
    result: "Fake final answer from Claude Code",
    modelUsage: { "claude-fable-5": {} },
    total_cost_usd: 0,
  };
  const events = stdoutEvents ?? [initEvent, resultEvent];
  const script = [
    "#!/usr/bin/env node",
    "const fs = require('node:fs');",
    `const doctorInvocationArgvPath = ${JSON.stringify(doctorInvocationArgvPath)};`,
    `const shallowSpawnArgvPath = ${JSON.stringify(shallowSpawnArgvPath)};`,
    `const markerPath = ${JSON.stringify(markerPath)};`,
    `const stdinPath = ${JSON.stringify(stdinPath)};`,
    `const doctorHealthy = ${JSON.stringify(doctorHealthy)};`,
    `const stdoutEvents = ${JSON.stringify(events)};`,
    "const argv = process.argv.slice(2);",
    "if (argv[0] === 'shallow-spawn' && argv.includes('--print-env')) {",
    "  fs.writeFileSync(doctorInvocationArgvPath, JSON.stringify(argv, null, 2));",
    "  const verdict = doctorHealthy",
    "    ? { success: true, home: '/fake/shallow-home/' + argv[1], shallow_profile: argv[1] }",
    "    : { success: false, error: 'fake unhealthy profile ' + argv[1] };",
    "  process.stdout.write(JSON.stringify(verdict) + '\\n');",
    "  process.exit(doctorHealthy ? 0 : 1);",
    "}",
    "if (argv[0] === 'shallow-spawn') {",
    "  fs.writeFileSync(shallowSpawnArgvPath, JSON.stringify(argv, null, 2));",
    "  let input = '';",
    "  process.stdin.setEncoding('utf8');",
    "  process.stdin.on('data', (chunk) => { input += chunk; });",
    "  process.stdin.on('end', () => {",
    "    fs.writeFileSync(markerPath, 'spawned\\n');",
    "    fs.writeFileSync(stdinPath, input);",
    "    for (const event of stdoutEvents) {",
    "      process.stdout.write(`${JSON.stringify(event)}\\n`);",
    "    }",
    "    process.stderr.write('fake stderr\\n');",
    "  });",
    "} else {",
    "  process.stderr.write('unexpected caam invocation\\n');",
    "  process.exit(1);",
    "}",
    "",
  ].join("\n");
  fs.writeFileSync(executablePath, script, { mode: 0o700 });
  return executablePath;
}

beforeAll(() => {
  // Force macOS platform so browser-mode paths are reachable in Linux/Windows CI
  Object.defineProperty(process, "platform", { value: "darwin" });
});

afterAll(() => {
  Object.defineProperty(process, "platform", { value: originalPlatform });
});

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  Object.values(sessionStoreMock).forEach((fn) => {
    if (typeof fn === "function" && "mockReset" in fn) {
      fn.mockReset();
    }
  });
  vi.mocked(runMultiModelApiSession).mockReset();
  vi.mocked(ensureSessionArtifacts).mockReset();
  vi.mocked(ensureSessionArtifacts).mockImplementation(
    async ({ existingArtifacts }) => existingArtifacts,
  );
  vi.mocked(runMultiModelApiSession).mockResolvedValue({
    fulfilled: [],
    rejected: [],
    elapsedMs: 0,
  });
  sessionStoreMock.createLogWriter.mockReturnValue({
    logLine: vi.fn(),
    writeChunk: vi.fn(),
    stream: { end: vi.fn() },
  });
  sessionStoreMock.readModelLog.mockResolvedValue("model log body");
  sessionStoreMock.sessionsDir.mockReturnValue("/tmp/.oracle/sessions");
  sessionStoreMock.getPaths.mockResolvedValue({
    dir: "/tmp/.oracle/sessions/sess-1",
    metadata: "/tmp/.oracle/sessions/sess-1/meta.json",
    request: "/tmp/.oracle/sessions/sess-1/request.json",
    log: "/tmp/.oracle/sessions/sess-1/output.log",
  });
  vi.spyOn(fsPromises, "mkdir").mockResolvedValue(undefined);
  vi.spyOn(fsPromises, "writeFile").mockResolvedValue(undefined);
});

describe("performSessionRun", () => {
  test("default claude-code runner spawns a guarded local claude process with stdin prompt and raw artifacts", async () => {
    vi.mocked(fsPromises.mkdir).mockRestore();
    vi.mocked(fsPromises.writeFile).mockRestore();

    const root = fs.mkdtempSync(path.join(os.homedir(), ".oracle-claude-code-test-"));
    const oracleHome = path.join(root, "oracle-home");
    const sessionsDir = path.join(root, "sessions");
    const sessionDir = path.join(sessionsDir, "sess-1");
    const repoDir = path.join(root, "repo");
    const binDir = path.join(root, "bin");
    const argvPath = path.join(root, "claude-argv.json");
    const stdinPath = path.join(root, "claude-stdin.txt");
    const markerPath = path.join(root, "claude-spawned.txt");
    for (const dir of [oracleHome, sessionsDir, sessionDir, repoDir, binDir]) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.chmodSync(dir, 0o700);
    }
    const contextPath = path.join(repoDir, "context.md");
    fs.writeFileSync(contextPath, "fake file context", "utf8");
    createFakeClaudeExecutable({ binDir, argvPath, stdinPath, markerPath });
    sessionStoreMock.sessionsDir.mockReturnValue(sessionsDir);
    sessionStoreMock.getPaths.mockResolvedValue({
      dir: sessionDir,
      metadata: path.join(sessionDir, "meta.json"),
      request: path.join(sessionDir, "request.json"),
      log: path.join(sessionDir, "output.log"),
    });
    setOracleHomeDirOverrideForTest(oracleHome);

    try {
      await withExactEnv(
        {
          ...blockedClaudeCodeEnvDefaults,
          PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        },
        async () => {
          await performSessionRun({
            sessionMeta: { ...baseSessionMeta, mode: "claude-code", model: "fable" },
            runOptions: {
              prompt: "Review via fake executable",
              model: "fable",
              file: [contextPath],
            },
            mode: "claude-code",
            cwd: repoDir,
            log,
            write,
            version: cliVersion,
            muteStdout: true,
          });
        },
      );

      expect(vi.mocked(runOracle)).not.toHaveBeenCalled();
      expect(vi.mocked(runBrowserSessionExecution)).not.toHaveBeenCalled();
      expect(fs.readFileSync(markerPath, "utf8")).toBe("spawned\n");
      const argv = JSON.parse(fs.readFileSync(argvPath, "utf8")) as string[];
      expect(argv).toContain("-p");
      expect(argv[argv.indexOf("--model") + 1]).toBe("fable");
      expect(argv[argv.indexOf("--output-format") + 1]).toBe("stream-json");
      expect(argv[argv.indexOf("--permission-mode") + 1]).toBe("plan");
      expect(argv[argv.indexOf("--tools") + 1]).toBe("");
      expect(argv.join("\n")).not.toContain("Review via fake executable");
      const stdin = fs.readFileSync(stdinPath, "utf8");
      expect(stdin).toContain("Review via fake executable");
      expect(stdin).toContain("fake file context");
      const artifactsDir = path.join(sessionDir, "artifacts");
      expect(fs.readFileSync(path.join(artifactsDir, "claude-code-stdout.raw"), "utf8")).toContain(
        '"type":"result"',
      );
      expect(fs.readFileSync(path.join(artifactsDir, "claude-code-stderr.raw"), "utf8")).toBe(
        "fake stderr\n",
      );
      expect(fs.readFileSync(path.join(artifactsDir, "claude-code-final.md"), "utf8")).toBe(
        "Fake final answer from Claude Code",
      );
      expect(
        fs.readFileSync(path.join(artifactsDir, "claude-code-events.normalized.ndjson"), "utf8"),
      ).toContain('"type":"result"');
      const adapter = JSON.parse(
        fs.readFileSync(path.join(artifactsDir, "claude-code-adapter.json"), "utf8"),
      ) as { access_path?: string; command?: { args_redacted?: string[] } };
      expect(adapter.access_path).toBe("claude_code_subscription_cli");
      expect(adapter.command?.args_redacted).toContain(
        "<tiny Oracle-owned supplied-context reviewer prompt>",
      );
      const finalUpdate = sessionStoreMock.updateSession.mock.calls.at(-1)?.[1];
      expect(finalUpdate).toMatchObject({
        status: "completed",
        mode: "claude-code",
        claudeCode: {
          access_path: "claude_code_subscription_cli",
          model_requested: "fable",
          model_observed: "claude-fable-5",
          model_usage_keys: ["claude-fable-5"],
          model_verification_status: "observed",
          total_cost_usd_observed: 0,
          local_owner_verified: true,
          child_env_scrubbed: true,
          artifact_paths: expect.objectContaining({
            finalAnswerPath: path.join(artifactsDir, "claude-code-final.md"),
          }),
        },
      });
      expect(fs.existsSync(path.join(oracleHome, "locks", "claude-code-subscription.lock"))).toBe(
        false,
      );
    } finally {
      setOracleHomeDirOverrideForTest(null);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("default claude-code runner refuses a busy single-flight lock before spawning", async () => {
    vi.mocked(fsPromises.mkdir).mockRestore();
    vi.mocked(fsPromises.writeFile).mockRestore();

    const root = fs.mkdtempSync(path.join(os.homedir(), ".oracle-claude-code-lock-test-"));
    const oracleHome = path.join(root, "oracle-home");
    const sessionsDir = path.join(root, "sessions");
    const sessionDir = path.join(sessionsDir, "sess-1");
    const repoDir = path.join(root, "repo");
    const binDir = path.join(root, "bin");
    const markerPath = path.join(root, "claude-spawned.txt");
    for (const dir of [oracleHome, sessionsDir, sessionDir, repoDir, binDir]) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.chmodSync(dir, 0o700);
    }
    createFakeClaudeExecutable({
      binDir,
      argvPath: path.join(root, "argv.json"),
      stdinPath: path.join(root, "stdin.txt"),
      markerPath,
    });
    const locksDir = path.join(oracleHome, "locks");
    fs.mkdirSync(locksDir, { recursive: true, mode: 0o700 });
    const lockPath = path.join(locksDir, "claude-code-subscription.lock");
    fs.writeFileSync(
      lockPath,
      `${JSON.stringify({
        schema_version: "claude_code_single_flight_lock.v1",
        session_id: "busy-session",
        pid: process.pid,
        nonce: "busy-lock",
        created_at: "2026-07-02T00:00:00.000Z",
      })}\n`,
      { mode: 0o600 },
    );
    sessionStoreMock.sessionsDir.mockReturnValue(sessionsDir);
    sessionStoreMock.getPaths.mockResolvedValue({
      dir: sessionDir,
      metadata: path.join(sessionDir, "meta.json"),
      request: path.join(sessionDir, "request.json"),
      log: path.join(sessionDir, "output.log"),
    });
    setOracleHomeDirOverrideForTest(oracleHome);

    try {
      await withExactEnv(
        {
          ...blockedClaudeCodeEnvDefaults,
          PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        },
        async () => {
          await expect(
            performSessionRun({
              sessionMeta: { ...baseSessionMeta, mode: "claude-code", model: "fable" },
              runOptions: { prompt: "Review", model: "fable" },
              mode: "claude-code",
              cwd: repoDir,
              log,
              write,
              version: cliVersion,
            }),
          ).rejects.toThrow(/already running in session busy-session/);
        },
      );

      expect(fs.existsSync(markerPath)).toBe(false);
      expect(fs.existsSync(lockPath)).toBe(true);
      expect(vi.mocked(runOracle)).not.toHaveBeenCalled();
      expect(vi.mocked(runBrowserSessionExecution)).not.toHaveBeenCalled();
      const finalUpdate = sessionStoreMock.updateSession.mock.calls.at(-1)?.[1];
      expect(finalUpdate).toMatchObject({
        status: "error",
        mode: "claude-code",
        claudeCode: {
          access_path: "claude_code_subscription_cli",
          events_complete: false,
          error_reason: expect.stringContaining("busy-session"),
        },
      });
    } finally {
      setOracleHomeDirOverrideForTest(null);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("default claude-code runner waits for a busy single-flight lock when requested", async () => {
    vi.mocked(fsPromises.mkdir).mockRestore();
    vi.mocked(fsPromises.writeFile).mockRestore();

    const root = fs.mkdtempSync(path.join(os.homedir(), ".oracle-claude-code-lock-wait-test-"));
    const oracleHome = path.join(root, "oracle-home");
    const sessionsDir = path.join(root, "sessions");
    const sessionDir = path.join(sessionsDir, "sess-1");
    const repoDir = path.join(root, "repo");
    const binDir = path.join(root, "bin");
    const markerPath = path.join(root, "claude-spawned.txt");
    for (const dir of [oracleHome, sessionsDir, sessionDir, repoDir, binDir]) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.chmodSync(dir, 0o700);
    }
    createFakeClaudeExecutable({
      binDir,
      argvPath: path.join(root, "argv.json"),
      stdinPath: path.join(root, "stdin.txt"),
      markerPath,
    });
    const locksDir = path.join(oracleHome, "locks");
    fs.mkdirSync(locksDir, { recursive: true, mode: 0o700 });
    const lockPath = path.join(locksDir, "claude-code-subscription.lock");
    fs.writeFileSync(
      lockPath,
      `${JSON.stringify({
        schema_version: "claude_code_single_flight_lock.v1",
        session_id: "busy-session",
        pid: process.pid,
        nonce: "busy-lock",
        created_at: "2026-07-02T00:00:00.000Z",
      })}\n`,
      { mode: 0o600 },
    );
    sessionStoreMock.sessionsDir.mockReturnValue(sessionsDir);
    sessionStoreMock.getPaths.mockResolvedValue({
      dir: sessionDir,
      metadata: path.join(sessionDir, "meta.json"),
      request: path.join(sessionDir, "request.json"),
      log: path.join(sessionDir, "output.log"),
    });
    setOracleHomeDirOverrideForTest(oracleHome);
    const releaseBusyLock = setTimeout(() => {
      try {
        fs.unlinkSync(lockPath);
      } catch {
        // The runner may have already recovered or the test may be unwinding.
      }
    }, 50);

    try {
      await withExactEnv(
        {
          ...blockedClaudeCodeEnvDefaults,
          PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        },
        async () => {
          await performSessionRun({
            sessionMeta: { ...baseSessionMeta, mode: "claude-code", model: "fable" },
            runOptions: {
              prompt: "Review after lock wait",
              model: "fable",
              claudeCode: { ...fableClaudeCodePolicy, waitForLockMs: 1_000 },
            },
            mode: "claude-code",
            cwd: repoDir,
            log,
            write,
            version: cliVersion,
            muteStdout: true,
          });
        },
      );

      expect(fs.readFileSync(markerPath, "utf8")).toBe("spawned\n");
      expect(fs.existsSync(lockPath)).toBe(false);
      const adapter = JSON.parse(
        fs.readFileSync(path.join(sessionDir, "artifacts", "claude-code-adapter.json"), "utf8"),
      ) as { single_flight_lock?: { wait_for_lock_ms?: number } };
      expect(adapter.single_flight_lock?.wait_for_lock_ms).toBe(1_000);
      const finalUpdate = sessionStoreMock.updateSession.mock.calls.at(-1)?.[1];
      expect(finalUpdate).toMatchObject({
        status: "completed",
        mode: "claude-code",
      });
    } finally {
      clearTimeout(releaseBusyLock);
      setOracleHomeDirOverrideForTest(null);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("default claude-code runner stops when visible events show tool use", async () => {
    vi.mocked(fsPromises.mkdir).mockRestore();
    vi.mocked(fsPromises.writeFile).mockRestore();

    const root = fs.mkdtempSync(path.join(os.homedir(), ".oracle-claude-code-policy-test-"));
    const oracleHome = path.join(root, "oracle-home");
    const sessionsDir = path.join(root, "sessions");
    const sessionDir = path.join(sessionsDir, "sess-1");
    const repoDir = path.join(root, "repo");
    const binDir = path.join(root, "bin");
    const markerPath = path.join(root, "claude-spawned.txt");
    for (const dir of [oracleHome, sessionsDir, sessionDir, repoDir, binDir]) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.chmodSync(dir, 0o700);
    }
    createFakeClaudeExecutable({
      binDir,
      argvPath: path.join(root, "argv.json"),
      stdinPath: path.join(root, "stdin.txt"),
      markerPath,
      stdoutEvents: [
        fakeClaudeCodeInitEvent(),
        {
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                id: "toolu_test",
                name: "Bash",
                input: { command: "pwd" },
              },
            ],
          },
        },
      ],
      lingerMs: 3_000,
    });
    sessionStoreMock.sessionsDir.mockReturnValue(sessionsDir);
    sessionStoreMock.getPaths.mockResolvedValue({
      dir: sessionDir,
      metadata: path.join(sessionDir, "meta.json"),
      request: path.join(sessionDir, "request.json"),
      log: path.join(sessionDir, "output.log"),
    });
    setOracleHomeDirOverrideForTest(oracleHome);

    try {
      await withExactEnv(
        {
          ...blockedClaudeCodeEnvDefaults,
          PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        },
        async () => {
          await expect(
            performSessionRun({
              sessionMeta: { ...baseSessionMeta, mode: "claude-code", model: "fable" },
              runOptions: {
                prompt: "Review but do not run tools",
                model: "fable",
              },
              mode: "claude-code",
              cwd: repoDir,
              log,
              write,
              version: cliVersion,
              muteStdout: true,
            }),
          ).rejects.toThrow(/read-only policy violation: tool use \(Bash\)/);
        },
      );

      expect(fs.readFileSync(markerPath, "utf8")).toBe("spawned\n");
      expect(fs.existsSync(path.join(oracleHome, "locks", "claude-code-subscription.lock"))).toBe(
        false,
      );
      const adapter = JSON.parse(
        fs.readFileSync(path.join(sessionDir, "artifacts", "claude-code-adapter.json"), "utf8"),
      ) as { policy_violation?: { reason?: string } };
      expect(adapter.policy_violation?.reason).toBe("tool use (Bash)");
      const finalUpdate = sessionStoreMock.updateSession.mock.calls.at(-1)?.[1];
      expect(finalUpdate).toMatchObject({
        status: "error",
        mode: "claude-code",
        errorMessage: expect.stringContaining("read-only policy violation"),
        claudeCode: {
          events_complete: false,
          streams_complete: false,
        },
      });
    } finally {
      setOracleHomeDirOverrideForTest(null);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("default claude-code runner stops when visible output exceeds the inline byte limit", async () => {
    vi.mocked(fsPromises.mkdir).mockRestore();
    vi.mocked(fsPromises.writeFile).mockRestore();

    const root = fs.mkdtempSync(path.join(os.homedir(), ".oracle-claude-code-flood-test-"));
    const oracleHome = path.join(root, "oracle-home");
    const sessionsDir = path.join(root, "sessions");
    const sessionDir = path.join(sessionsDir, "sess-1");
    const repoDir = path.join(root, "repo");
    const binDir = path.join(root, "bin");
    const markerPath = path.join(root, "claude-spawned.txt");
    for (const dir of [oracleHome, sessionsDir, sessionDir, repoDir, binDir]) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.chmodSync(dir, 0o700);
    }
    createFakeClaudeExecutable({
      binDir,
      argvPath: path.join(root, "argv.json"),
      stdinPath: path.join(root, "stdin.txt"),
      markerPath,
      stdoutEvents: [
        fakeClaudeCodeInitEvent(),
        {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "text_delta", text: "this line exceeds the test byte budget" },
          },
        },
      ],
      lingerMs: 3_000,
    });
    sessionStoreMock.sessionsDir.mockReturnValue(sessionsDir);
    sessionStoreMock.getPaths.mockResolvedValue({
      dir: sessionDir,
      metadata: path.join(sessionDir, "meta.json"),
      request: path.join(sessionDir, "request.json"),
      log: path.join(sessionDir, "output.log"),
    });
    setOracleHomeDirOverrideForTest(oracleHome);

    try {
      await withExactEnv(
        {
          ...blockedClaudeCodeEnvDefaults,
          PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        },
        async () => {
          await expect(
            performSessionRun({
              sessionMeta: { ...baseSessionMeta, mode: "claude-code", model: "fable" },
              runOptions: {
                prompt: "Review but keep output bounded",
                model: "fable",
                claudeCode: { ...fableClaudeCodePolicy, maxInlineBytes: 32 },
              },
              mode: "claude-code",
              cwd: repoDir,
              log,
              write,
              version: cliVersion,
              muteStdout: true,
            }),
          ).rejects.toThrow(/visible stdout output exceeded the inline byte limit/);
        },
      );

      expect(fs.readFileSync(markerPath, "utf8")).toBe("spawned\n");
      expect(fs.existsSync(path.join(oracleHome, "locks", "claude-code-subscription.lock"))).toBe(
        false,
      );
      const adapter = JSON.parse(
        fs.readFileSync(path.join(sessionDir, "artifacts", "claude-code-adapter.json"), "utf8"),
      ) as { output_flood?: { stream?: string }; max_inline_bytes?: number };
      expect(adapter.output_flood?.stream).toBe("stdout");
      expect(adapter.max_inline_bytes).toBe(32);
      const finalUpdate = sessionStoreMock.updateSession.mock.calls.at(-1)?.[1];
      expect(finalUpdate).toMatchObject({
        status: "error",
        mode: "claude-code",
        errorMessage: expect.stringContaining("inline byte limit"),
        claudeCode: {
          events_complete: false,
          streams_complete: false,
        },
      });
    } finally {
      setOracleHomeDirOverrideForTest(null);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("default claude-code runner terminates child and releases lock on SIGINT", async () => {
    vi.mocked(fsPromises.mkdir).mockRestore();
    vi.mocked(fsPromises.writeFile).mockRestore();

    const root = fs.mkdtempSync(path.join(os.homedir(), ".oracle-claude-code-sigint-test-"));
    const oracleHome = path.join(root, "oracle-home");
    const sessionsDir = path.join(root, "sessions");
    const sessionDir = path.join(sessionsDir, "sess-1");
    const repoDir = path.join(root, "repo");
    const binDir = path.join(root, "bin");
    const markerPath = path.join(root, "claude-spawned.txt");
    for (const dir of [oracleHome, sessionsDir, sessionDir, repoDir, binDir]) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.chmodSync(dir, 0o700);
    }
    createFakeClaudeExecutable({
      binDir,
      argvPath: path.join(root, "argv.json"),
      stdinPath: path.join(root, "stdin.txt"),
      markerPath,
      stdoutEvents: [fakeClaudeCodeInitEvent()],
      lingerMs: 3_000,
    });
    sessionStoreMock.sessionsDir.mockReturnValue(sessionsDir);
    sessionStoreMock.getPaths.mockResolvedValue({
      dir: sessionDir,
      metadata: path.join(sessionDir, "meta.json"),
      request: path.join(sessionDir, "request.json"),
      log: path.join(sessionDir, "output.log"),
    });
    setOracleHomeDirOverrideForTest(oracleHome);
    const interrupt = setTimeout(() => {
      process.emit("SIGINT");
    }, 50);

    try {
      await withExactEnv(
        {
          ...blockedClaudeCodeEnvDefaults,
          PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        },
        async () => {
          await expect(
            performSessionRun({
              sessionMeta: { ...baseSessionMeta, mode: "claude-code", model: "fable" },
              runOptions: {
                prompt: "Review until interrupted",
                model: "fable",
              },
              mode: "claude-code",
              cwd: repoDir,
              log,
              write,
              version: cliVersion,
              muteStdout: true,
            }),
          ).rejects.toThrow(/stopped after SIGINT/);
        },
      );

      expect(fs.readFileSync(markerPath, "utf8")).toBe("spawned\n");
      expect(fs.existsSync(path.join(oracleHome, "locks", "claude-code-subscription.lock"))).toBe(
        false,
      );
      const adapter = JSON.parse(
        fs.readFileSync(path.join(sessionDir, "artifacts", "claude-code-adapter.json"), "utf8"),
      ) as { aborted_by_signal?: string };
      expect(adapter.aborted_by_signal).toBe("SIGINT");
      const finalUpdate = sessionStoreMock.updateSession.mock.calls.at(-1)?.[1];
      expect(finalUpdate).toMatchObject({
        status: "error",
        mode: "claude-code",
        errorMessage: expect.stringContaining("SIGINT"),
        claudeCode: {
          events_complete: false,
          streams_complete: false,
        },
      });
    } finally {
      clearTimeout(interrupt);
      setOracleHomeDirOverrideForTest(null);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("default claude-code runner refuses API-key env before spawning claude", async () => {
    const root = fs.mkdtempSync(path.join(os.homedir(), ".oracle-claude-code-guard-test-"));
    const binDir = path.join(root, "bin");
    const markerPath = path.join(root, "claude-spawned.txt");
    fs.mkdirSync(binDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(binDir, 0o700);
    createFakeClaudeExecutable({
      binDir,
      argvPath: path.join(root, "argv.json"),
      stdinPath: path.join(root, "stdin.txt"),
      markerPath,
    });

    try {
      await withExactEnv(
        {
          ...blockedClaudeCodeEnvDefaults,
          ANTHROPIC_API_KEY: "sk-ant-test",
          PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        },
        async () => {
          await expect(
            performSessionRun({
              sessionMeta: { ...baseSessionMeta, mode: "claude-code", model: "fable" },
              runOptions: { prompt: "Review", model: "fable" },
              mode: "claude-code",
              cwd: "/tmp",
              log,
              write,
              version: cliVersion,
            }),
          ).rejects.toThrow(/ANTHROPIC_API_KEY/);
        },
      );

      expect(fs.existsSync(markerPath)).toBe(false);
      expect(vi.mocked(runOracle)).not.toHaveBeenCalled();
      expect(vi.mocked(runBrowserSessionExecution)).not.toHaveBeenCalled();
      const finalUpdate = sessionStoreMock.updateSession.mock.calls.at(-1)?.[1];
      expect(finalUpdate).toMatchObject({
        status: "error",
        mode: "claude-code",
        claudeCode: {
          access_path: "claude_code_subscription_cli",
          events_complete: false,
          error_reason: expect.stringContaining("ANTHROPIC_API_KEY"),
        },
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("runs claude-code sessions through supplied context and persists raw artifacts", async () => {
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "oracle-claude-code-context-"));
    const contextPath = path.join(repoDir, "notes.md");
    fs.writeFileSync(contextPath, "important supplied context", "utf8");
    const claudeCodeRunner = vi.fn(async (input) => {
      expect(input.prompt).toContain("Review this local lane");
      expect(input.prompt).toContain("important supplied context");
      expect(input.model).toBe("fable");
      expect(input.artifactPaths.rawStdoutPath).toBe(
        "/tmp/.oracle/sessions/sess-1/artifacts/claude-code-stdout.raw",
      );
      return {
        stdoutRaw: Buffer.from('{"type":"assistant","text":"Final answer"}\n'),
        stderrRaw: Buffer.from("visible stderr\n"),
        normalizedEventsNdjson:
          '{"seq":0,"stream":"stdout","type":"assistant","text":"Final answer"}\n',
        finalAnswerMarkdown: "Final answer",
        progressMarkdown: "Visible progress",
        finalAnswerText: "Final answer",
        elapsedMs: 42,
        exitCode: 0,
        eventsComplete: true,
        streamsComplete: true,
        stdoutEvents: 1,
        stderrEvents: 1,
        modelRequested: "fable",
        modelObserved: "claude-fable-5",
        modelResolvedFromInit: "claude-fable-5",
        modelUsageKeys: ["claude-fable-5"],
        modelVerificationStatus: "observed" as const,
        totalCostUsdObserved: 0,
        visibleThinkingCaptured: false,
        localOwnerVerified: true,
        anthropicApiKeyPresent: false,
        anthropicApiKeyRefusalChecked: true,
        childEnvScrubbed: true,
      };
    });

    await performSessionRun({
      sessionMeta: { ...baseSessionMeta, mode: "claude-code", model: "fable" },
      runOptions: { prompt: "Review this local lane", model: "fable", file: [contextPath] },
      mode: "claude-code",
      cwd: repoDir,
      log,
      write,
      version: cliVersion,
      muteStdout: true,
      claudeCodeRunner,
    });

    expect(claudeCodeRunner).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runOracle)).not.toHaveBeenCalled();
    expect(vi.mocked(runBrowserSessionExecution)).not.toHaveBeenCalled();
    const writeCalls = (fsPromises.writeFile as unknown as { mock: { calls: unknown[][] } }).mock
      .calls;
    expect(writeCalls).toContainEqual([
      "/tmp/.oracle/sessions/sess-1/artifacts/claude-code-stdout.raw",
      Buffer.from('{"type":"assistant","text":"Final answer"}\n'),
      { mode: 0o600, flag: "wx" },
    ]);
    expect(writeCalls).toContainEqual([
      "/tmp/.oracle/sessions/sess-1/artifacts/claude-code-stderr.raw",
      Buffer.from("visible stderr\n"),
      { mode: 0o600, flag: "wx" },
    ]);
    expect(writeCalls).toContainEqual([
      "/tmp/.oracle/sessions/sess-1/artifacts/claude-code-final.md",
      Buffer.from("Final answer", "utf8"),
      { mode: 0o600, flag: "wx" },
    ]);
    const finalUpdate = sessionStoreMock.updateSession.mock.calls.at(-1)?.[1];
    expect(finalUpdate).toMatchObject({
      status: "completed",
      mode: "claude-code",
      claudeCode: {
        access_path: "claude_code_subscription_cli",
        transcript_fidelity: "visible_cli_stream",
        hidden_reasoning_captured: false,
        visible_thinking_captured: false,
        subscription_billing_uncertain: true,
        model_requested: "fable",
        model_observed: "claude-fable-5",
        model_usage_keys: ["claude-fable-5"],
        read_only: expect.objectContaining({ readOnly: true, toolMode: "none" }),
        artifact_paths: expect.objectContaining({
          rawStdoutPath: "/tmp/.oracle/sessions/sess-1/artifacts/claude-code-stdout.raw",
          adapterMetadataPath: "/tmp/.oracle/sessions/sess-1/artifacts/claude-code-adapter.json",
        }),
      },
      artifacts: expect.arrayContaining([
        expect.objectContaining({ kind: "claude-code-stdout-raw" }),
        expect.objectContaining({ kind: "claude-code-stderr-raw" }),
        expect.objectContaining({ kind: "claude-code-events-normalized" }),
        expect.objectContaining({ kind: "claude-code-final" }),
        expect.objectContaining({ kind: "claude-code-progress" }),
        expect.objectContaining({ kind: "claude-code-adapter" }),
      ]),
    });
    expect(sessionStoreMock.updateModelRun).toHaveBeenCalledWith(
      baseSessionMeta.id,
      "fable",
      expect.objectContaining({ status: "completed" }),
    );
  });

  describe("claude-code file attachment hardening (claude-provider-map.md finding #1)", () => {
    function minimalClaudeCodeRunnerResult() {
      return {
        stdoutRaw: Buffer.from('{"type":"assistant","text":"Final answer"}\n'),
        stderrRaw: Buffer.from(""),
        normalizedEventsNdjson:
          '{"seq":0,"stream":"stdout","type":"assistant","text":"Final answer"}\n',
        finalAnswerMarkdown: "Final answer",
        progressMarkdown: "Visible progress",
        finalAnswerText: "Final answer",
        elapsedMs: 5,
        exitCode: 0,
        eventsComplete: true,
        streamsComplete: true,
        stdoutEvents: 1,
        stderrEvents: 0,
        modelRequested: "fable",
        modelObserved: "claude-fable-5",
        modelResolvedFromInit: "claude-fable-5",
        modelUsageKeys: ["claude-fable-5"],
        modelVerificationStatus: "observed" as const,
        totalCostUsdObserved: 0,
        visibleThinkingCaptured: false,
        localOwnerVerified: true,
        anthropicApiKeyPresent: false,
        anthropicApiKeyRefusalChecked: true,
        childEnvScrubbed: true,
      };
    }

    test("rejects a binary file attachment before spawning claude, naming the file", async () => {
      const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "oracle-claude-code-binary-"));
      const binaryPath = path.join(repoDir, "photo.png");
      // PNG magic bytes followed by a NUL byte: unambiguously binary under
      // either half of the sniff (NUL-byte scan or strict-UTF-8 decode).
      fs.writeFileSync(
        binaryPath,
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe]),
      );
      const claudeCodeRunner = vi.fn();

      await expect(
        performSessionRun({
          sessionMeta: { ...baseSessionMeta, mode: "claude-code", model: "fable" },
          runOptions: { prompt: "Review this local lane", model: "fable", file: [binaryPath] },
          mode: "claude-code",
          cwd: repoDir,
          log,
          write,
          version: cliVersion,
          muteStdout: true,
          claudeCodeRunner,
        }),
      ).rejects.toThrow(/photo\.png/);

      expect(claudeCodeRunner).not.toHaveBeenCalled();
      const finalUpdate = sessionStoreMock.updateSession.mock.calls.at(-1)?.[1];
      expect(finalUpdate).toMatchObject({ status: "error", mode: "claude-code" });
    });

    test("rejects when combined prompt and attachments exceed the configured inline-byte budget", async () => {
      const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "oracle-claude-code-budget-"));
      const contextPath = path.join(repoDir, "notes.md");
      fs.writeFileSync(contextPath, "x".repeat(200), "utf8");
      const claudeCodeRunner = vi.fn();

      await expect(
        performSessionRun({
          sessionMeta: { ...baseSessionMeta, mode: "claude-code", model: "fable" },
          runOptions: {
            prompt: "Review this local lane",
            model: "fable",
            file: [contextPath],
            claudeCode: { ...fableClaudeCodePolicy, maxInlineBytes: 50 },
          },
          mode: "claude-code",
          cwd: repoDir,
          log,
          write,
          version: cliVersion,
          muteStdout: true,
          claudeCodeRunner,
        }),
      ).rejects.toThrow(/exceeding the Claude Code local-mode inline budget of 50 bytes/);

      expect(claudeCodeRunner).not.toHaveBeenCalled();
    });

    test("ORACLE_CLAUDE_CODE_MAX_INLINE_BYTES env var changes the effective inline budget", async () => {
      const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "oracle-claude-code-budget-env-"));
      const contextPath = path.join(repoDir, "notes.md");
      fs.writeFileSync(contextPath, "y".repeat(200), "utf8");

      // Default budget (64 MB) comfortably allows a ~200-byte attachment.
      const claudeCodeRunnerOk = vi.fn(async () => minimalClaudeCodeRunnerResult());
      await performSessionRun({
        sessionMeta: { ...baseSessionMeta, mode: "claude-code", model: "fable" },
        runOptions: { prompt: "Review this local lane", model: "fable", file: [contextPath] },
        mode: "claude-code",
        cwd: repoDir,
        log,
        write,
        version: cliVersion,
        muteStdout: true,
        claudeCodeRunner: claudeCodeRunnerOk,
      });
      expect(claudeCodeRunnerOk).toHaveBeenCalledTimes(1);

      // The previously-dead env var now lowers the same effective budget.
      const claudeCodeRunnerBlocked = vi.fn();
      await withExactEnv({ ORACLE_CLAUDE_CODE_MAX_INLINE_BYTES: "40" }, async () => {
        await expect(
          performSessionRun({
            sessionMeta: { ...baseSessionMeta, mode: "claude-code", model: "fable" },
            runOptions: { prompt: "Review this local lane", model: "fable", file: [contextPath] },
            mode: "claude-code",
            cwd: repoDir,
            log,
            write,
            version: cliVersion,
            muteStdout: true,
            claudeCodeRunner: claudeCodeRunnerBlocked,
          }),
        ).rejects.toThrow(/exceeding the Claude Code local-mode inline budget of 40 bytes/);
      });
      expect(claudeCodeRunnerBlocked).not.toHaveBeenCalled();
    });

    test("still runs a normal multi-file text attachment set unchanged", async () => {
      const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "oracle-claude-code-text-set-"));
      const fileA = path.join(repoDir, "a.md");
      const fileB = path.join(repoDir, "b.ts");
      fs.writeFileSync(fileA, "# Notes\nSome unicode: café, 🎉", "utf8");
      fs.writeFileSync(fileB, "export const x = 1;\n", "utf8");
      let promptSent = "";
      const claudeCodeRunner = vi.fn(async (input) => {
        promptSent = input.prompt;
        return minimalClaudeCodeRunnerResult();
      });

      await performSessionRun({
        sessionMeta: { ...baseSessionMeta, mode: "claude-code", model: "fable" },
        runOptions: {
          prompt: "Review this local lane",
          model: "fable",
          file: [fileA, fileB],
        },
        mode: "claude-code",
        cwd: repoDir,
        log,
        write,
        version: cliVersion,
        muteStdout: true,
        claudeCodeRunner,
      });

      expect(claudeCodeRunner).toHaveBeenCalledTimes(1);
      expect(promptSent).toContain("café");
      expect(promptSent).toContain("🎉");
      expect(promptSent).toContain("export const x = 1;");
    });
  });

  test("keeps claude-code artifacts when the local runner reports an error", async () => {
    const claudeCodeRunner = vi.fn(async () => ({
      stdoutRaw: Buffer.from('{"type":"system","subtype":"init"}\n'),
      stderrRaw: Buffer.from("startup verifier rejected run\n"),
      normalizedEventsNdjson: '{"seq":0,"stream":"stdout","type":"system/init","text":"init"}\n',
      finalAnswerMarkdown: "",
      progressMarkdown: "error=verification failed",
      finalAnswerText: "",
      elapsedMs: 25,
      exitCode: 1,
      eventsComplete: true,
      streamsComplete: true,
      stdoutEvents: 1,
      stderrEvents: 1,
      modelRequested: "fable",
      modelVerificationStatus: "requested_only" as const,
      visibleThinkingCaptured: "unknown" as const,
      localOwnerVerified: true,
      anthropicApiKeyPresent: false,
      anthropicApiKeyRefusalChecked: true,
      childEnvScrubbed: true,
      errorMessage: "Claude Code local mode stopped because startup verification failed.",
    }));

    await expect(
      performSessionRun({
        sessionMeta: { ...baseSessionMeta, mode: "claude-code", model: "fable" },
        runOptions: { prompt: "Review", model: "fable" },
        mode: "claude-code",
        cwd: "/tmp",
        log,
        write,
        version: cliVersion,
        claudeCodeRunner,
      }),
    ).rejects.toThrow(/startup verification failed/);

    expect(sessionStoreMock.updateSession).toHaveBeenCalledTimes(2);
    const finalUpdate = sessionStoreMock.updateSession.mock.calls.at(-1)?.[1];
    expect(finalUpdate).toMatchObject({
      status: "error",
      mode: "claude-code",
      errorMessage: "Claude Code local mode stopped because startup verification failed.",
      claudeCode: {
        access_path: "claude_code_subscription_cli",
        transcript_fidelity: "visible_cli_stream",
        hidden_reasoning_captured: false,
        exit_code: 1,
        events_complete: true,
        artifact_paths: expect.objectContaining({
          rawStdoutPath: "/tmp/.oracle/sessions/sess-1/artifacts/claude-code-stdout.raw",
        }),
      },
      artifacts: expect.arrayContaining([
        expect.objectContaining({ kind: "claude-code-stdout-raw" }),
        expect.objectContaining({ kind: "claude-code-adapter" }),
      ]),
    });
    expect(sessionStoreMock.updateModelRun).toHaveBeenCalledWith(
      baseSessionMeta.id,
      "fable",
      expect.objectContaining({
        status: "error",
        error: expect.objectContaining({
          category: "claude-code",
          message: "Claude Code local mode stopped because startup verification failed.",
        }),
      }),
    );
  });

  test("marks claude-code sessions error when a guard fails before spawn", async () => {
    const claudeCodeRunner = vi.fn(async () => {
      throw new Error("Claude Code subscription mode refused because ANTHROPIC_API_KEY is set.");
    });

    await expect(
      performSessionRun({
        sessionMeta: { ...baseSessionMeta, mode: "claude-code", model: "fable" },
        runOptions: { prompt: "Review", model: "fable" },
        mode: "claude-code",
        cwd: "/tmp",
        log,
        write,
        version: cliVersion,
        claudeCodeRunner,
      }),
    ).rejects.toThrow(/ANTHROPIC_API_KEY/);

    expect(vi.mocked(runOracle)).not.toHaveBeenCalled();
    expect(vi.mocked(runBrowserSessionExecution)).not.toHaveBeenCalled();
    const finalUpdate = sessionStoreMock.updateSession.mock.calls.at(-1)?.[1];
    expect(finalUpdate).toMatchObject({
      status: "error",
      mode: "claude-code",
      claudeCode: {
        access_path: "claude_code_subscription_cli",
        transcript_fidelity: "visible_cli_stream",
        hidden_reasoning_captured: false,
        events_complete: false,
        error_reason: "Claude Code subscription mode refused because ANTHROPIC_API_KEY is set.",
      },
    });
    expect(sessionStoreMock.updateModelRun).toHaveBeenCalledWith(
      baseSessionMeta.id,
      "fable",
      expect.objectContaining({ status: "error" }),
    );
  });

  test("completes API sessions and records usage", async () => {
    const liveResult: RunOracleResult = {
      mode: "live",
      usage: { inputTokens: 10, outputTokens: 20, reasoningTokens: 0, totalTokens: 30 },
      elapsedMs: 1234,
      response: { id: "resp", usage: {}, output: [] },
    };
    vi.mocked(runOracle).mockResolvedValue(liveResult);

    await performSessionRun({
      sessionMeta: baseSessionMeta,
      runOptions: baseRunOptions,
      mode: "api",
      cwd: "/tmp",
      log,
      write,
      version: cliVersion,
    });

    expect(sessionStoreMock.updateSession).toHaveBeenCalledTimes(2);
    expect(vi.mocked(runOracle)).toHaveBeenCalled();
    const finalUpdate = sessionStoreMock.updateSession.mock.calls.at(-1)?.[1];
    expect(finalUpdate).toMatchObject({
      status: "completed",
      usage: { totalTokens: 30 },
      response: expect.objectContaining({ responseId: expect.any(String) }),
    });
    expect(sessionStoreMock.updateModelRun).toHaveBeenCalledWith(
      baseSessionMeta.id,
      "gpt-5.2-pro",
      expect.objectContaining({ status: "running" }),
    );
    expect(sessionStoreMock.updateModelRun).toHaveBeenCalledWith(
      baseSessionMeta.id,
      "gpt-5.2-pro",
      expect.objectContaining({ status: "completed" }),
    );
    expect(vi.mocked(sendSessionNotification)).toHaveBeenCalled();
  });

  test("writes final assistant output to disk for single-model runs", async () => {
    const liveResult: RunOracleResult = {
      mode: "live",
      usage: { inputTokens: 1, outputTokens: 2, reasoningTokens: 0, totalTokens: 3 },
      elapsedMs: 500,
      response: {
        id: "resp",
        usage: {},
        output: [{ type: "message", content: [{ type: "output_text", text: "Saved text" }] }],
      },
    };
    vi.mocked(runOracle).mockResolvedValue(liveResult);

    await performSessionRun({
      sessionMeta: baseSessionMeta,
      runOptions: { ...baseRunOptions, writeOutputPath: "/tmp/out.md" },
      mode: "api",
      cwd: "/tmp",
      log,
      write,
      version: cliVersion,
    });

    const writeCalls = (fsPromises.writeFile as unknown as { mock: { calls: unknown[][] } }).mock
      .calls;
    const expectedPath = path.resolve("/tmp/out.md");
    expect(writeCalls).toContainEqual([
      expectedPath,
      expect.stringContaining("Saved text\n"),
      "utf8",
    ]);
    const logLines = log.mock.calls.map((c) => c[0]).join("\n");
    expect(logLines).toContain("Saved assistant output");
  });

  test("streams per-model output as each model finishes when TTY", async () => {
    const sessionMeta = {
      ...baseSessionMeta,
      models: [
        { model: "gpt-5.1", status: "running" } as SessionModelRun,
        { model: "gemini-3-pro", status: "running" } as SessionModelRun,
      ],
    } as SessionMetadata;

    sessionStoreMock.readSession.mockResolvedValue(sessionMeta);
    sessionStoreMock.readModelLog.mockImplementation(
      async (_sessionId: string, model: string) => `Answer:\nfrom ${model}`,
    );

    const writeSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true as unknown as boolean);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const originalTty = (process.stdout as { isTTY?: boolean }).isTTY;
    (process.stdout as { isTTY?: boolean }).isTTY = false;

    vi.mocked(runMultiModelApiSession).mockImplementation(async (params) => {
      const fulfilled: ModelExecutionResult[] = [
        {
          model: "gemini-3-pro" as ModelName,
          usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0, totalTokens: 2, cost: 0 },
          answerText: "gemini answer",
          logPath: "log-gemini",
        },
        {
          model: "gpt-5.1" as ModelName,
          usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0, totalTokens: 2, cost: 0 },
          answerText: "gpt answer",
          logPath: "log-gpt",
        },
      ];

      if (params.onModelDone) {
        for (const entry of fulfilled) {
          await params.onModelDone(entry);
        }
      }

      return {
        fulfilled,
        rejected: [],
        elapsedMs: 1000,
      } as MultiModelRunSummary;
    });

    await performSessionRun({
      sessionMeta,
      runOptions: { ...baseRunOptions, models: ["gpt-5.1", "gemini-3-pro"] },
      mode: "api",
      cwd: "/tmp",
      log: logSpy,
      write: writeSpy,
      version: cliVersion,
    });

    const written = writeSpy.mock.calls.map((c) => c[0]).join("");
    expect(written).toContain("from gemini-3-pro");
    expect(written).toContain("from gpt-5.1");
    const geminiIndex = written.indexOf("from gemini-3-pro");
    const gptIndex = written.indexOf("from gpt-5.1");
    expect(geminiIndex).toBeGreaterThan(-1);
    expect(gptIndex).toBeGreaterThan(-1);
    expect(geminiIndex).toBeLessThan(gptIndex);

    writeSpy.mockRestore();
    logSpy.mockRestore();
    if (originalTty === undefined) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete (process.stdout as { isTTY?: boolean }).isTTY;
    } else {
      (process.stdout as { isTTY?: boolean }).isTTY = originalTty;
    }
  }, 15_000);

  test("strips OSC progress codes from stored model logs", async () => {
    const sessionMeta = {
      ...baseSessionMeta,
      models: [
        { model: "gpt-5.1", status: "running" } as SessionModelRun,
        { model: "gemini-3-pro", status: "running" } as SessionModelRun,
      ],
    } as SessionMetadata;

    sessionStoreMock.readSession.mockResolvedValue(sessionMeta);
    sessionStoreMock.readModelLog.mockResolvedValue(
      "\u001b]9;4;3;;Waiting for API\u001b\\Please provide design",
    );

    const writeSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true as unknown as boolean);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const originalTty = (process.stdout as { isTTY?: boolean }).isTTY;
    (process.stdout as { isTTY?: boolean }).isTTY = true;

    const summary: MultiModelRunSummary = {
      fulfilled: [
        {
          model: "gpt-5.1" as ModelName,
          usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0, totalTokens: 2, cost: 0 },
          answerText: "other",
          logPath: "log-gpt",
        },
        {
          model: "gemini-3-pro" as ModelName,
          usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0, totalTokens: 2, cost: 0 },
          answerText: "fallback text",
          logPath: "log-gem",
        },
      ],
      rejected: [],
      elapsedMs: 123,
    };

    vi.mocked(runMultiModelApiSession).mockImplementation(async (params) => {
      if (params.onModelDone) {
        for (const entry of summary.fulfilled) {
          await params.onModelDone(entry);
        }
      }
      return summary;
    });

    await performSessionRun({
      sessionMeta,
      runOptions: { ...baseRunOptions, models: ["gpt-5.1", "gemini-3-pro"] },
      mode: "api",
      cwd: "/tmp",
      log: logSpy,
      write: writeSpy,
      version: cliVersion,
    });

    const combined =
      writeSpy.mock.calls.map((c) => c[0]).join("") + logSpy.mock.calls.map((c) => c[0]).join("");
    expect(combined).toContain("Please provide design");
    // OSC progress codes should be preserved when replaying logs so terminals can render them.
    expect(combined).toContain("\u001b]9;4;");

    writeSpy.mockRestore();
    logSpy.mockRestore();
    if (originalTty === undefined) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete (process.stdout as { isTTY?: boolean }).isTTY;
    } else {
      (process.stdout as { isTTY?: boolean }).isTTY = originalTty;
    }
  });

  test("writes per-model outputs during multi-model runs when writeOutputPath provided", async () => {
    const summary: MultiModelRunSummary = {
      fulfilled: [
        {
          model: "gpt-5.2-pro" as ModelName,
          usage: {
            inputTokens: 1,
            outputTokens: 2,
            reasoningTokens: 0,
            totalTokens: 3,
            cost: 0.01,
          },
          answerText: "pro answer",
          logPath: "log-pro",
        },
        {
          model: "gemini-3-pro" as ModelName,
          usage: {
            inputTokens: 1,
            outputTokens: 2,
            reasoningTokens: 0,
            totalTokens: 3,
            cost: 0.02,
          },
          answerText: "gemini answer",
          logPath: "log-gemini",
        },
      ],
      rejected: [],
      elapsedMs: 1200,
    };
    vi.mocked(runMultiModelApiSession).mockResolvedValue(summary);

    await performSessionRun({
      sessionMeta: {
        ...baseSessionMeta,
        models: [
          { model: "gpt-5.2-pro", status: "pending" } as SessionModelRun,
          { model: "gemini-3-pro", status: "pending" } as SessionModelRun,
        ],
      },
      runOptions: {
        ...baseRunOptions,
        models: ["gpt-5.2-pro", "gemini-3-pro"],
        writeOutputPath: "/tmp/out.md",
      },
      mode: "api",
      cwd: "/tmp",
      log,
      write,
      version: cliVersion,
    });

    const writeCalls = (fsPromises.writeFile as unknown as { mock: { calls: unknown[][] } }).mock
      .calls;
    const expectedProPath = path.resolve("/tmp/out.gpt-5.2-pro.md");
    const expectedGeminiPath = path.resolve("/tmp/out.gemini-3-pro.md");
    const expectedManifestPath = path.resolve("/tmp/out.oracle.json");
    expect(writeCalls).toContainEqual([
      expectedProPath,
      expect.stringContaining("pro answer\n"),
      "utf8",
    ]);
    expect(writeCalls).toContainEqual([
      expectedGeminiPath,
      expect.stringContaining("gemini answer\n"),
      "utf8",
    ]);
    const manifestCall = writeCalls.find((call) => call[0] === expectedManifestPath);
    expect(manifestCall).toBeDefined();
    const manifest = JSON.parse(manifestCall?.[1] as string);
    expect(manifest).toMatchObject({
      version: 1,
      sessionId: "sess-1",
      status: "completed",
      outputBasePath: path.resolve("/tmp/out.md"),
      models: [
        {
          model: "gpt-5.2-pro",
          status: "completed",
          outputPath: expectedProPath,
          logPath: "log-pro",
          usage: { totalTokens: 3 },
        },
        {
          model: "gemini-3-pro",
          status: "completed",
          outputPath: expectedGeminiPath,
          logPath: "log-gemini",
          usage: { totalTokens: 3 },
        },
      ],
    });
    const logLines = log.mock.calls.map((c) => c[0]).join("\n");
    expect(logLines).toContain("Saved outputs:");
    expect(logLines).toContain(`gpt-5.2-pro -> ${expectedProPath}`);
    expect(logLines).toContain(`Output manifest: ${expectedManifestPath}`);
    expect(logLines).toContain("Run logs:");
    expect(logLines).toContain("gemini-3-pro -> log-gemini");
  });

  test("prints one aggregate header and colored summary for multi-model runs", async () => {
    const sessionMeta = {
      ...baseSessionMeta,
      models: [
        { model: "gpt-5.1", status: "running" } as SessionModelRun,
        { model: "gemini-3-pro", status: "running" } as SessionModelRun,
      ],
    } as SessionMetadata;

    sessionStoreMock.readSession.mockResolvedValue(sessionMeta);
    sessionStoreMock.readModelLog.mockResolvedValue("Answer:\nfrom model");

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const writeSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true as unknown as boolean);
    const originalTty = (process.stdout as { isTTY?: boolean }).isTTY;
    (process.stdout as { isTTY?: boolean }).isTTY = false;

    const summary: MultiModelRunSummary = {
      fulfilled: [
        {
          model: "gpt-5.1" as ModelName,
          usage: {
            inputTokens: 10,
            outputTokens: 20,
            reasoningTokens: 0,
            totalTokens: 30,
            cost: 0.01,
          },
          answerText: "ans-gpt",
          logPath: "log-gpt",
        },
        {
          model: "gemini-3-pro" as ModelName,
          usage: {
            inputTokens: 5,
            outputTokens: 5,
            reasoningTokens: 0,
            totalTokens: 10,
            cost: 0.02,
          },
          answerText: "ans-gemini",
          logPath: "log-gemini",
        },
      ],
      rejected: [],
      elapsedMs: 1234,
    };
    vi.mocked(runMultiModelApiSession).mockResolvedValue(summary);

    await performSessionRun({
      sessionMeta,
      runOptions: { ...baseRunOptions, models: ["gpt-5.1", "gemini-3-pro"] },
      mode: "api",
      cwd: "/tmp",
      log: logSpy,
      write: writeSpy,
      version: cliVersion,
    });

    const logsCombined = logSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(logsCombined).toContain("Calling gpt-5.1, gemini-3-pro");
    expect((logsCombined.match(/Calling gpt-5.1/g) ?? []).length).toBe(1);
    expect((logsCombined.match(/Tip: no files attached/g) ?? []).length).toBe(1);
    expect(
      (logsCombined.match(/Tip: brief prompts often yield generic answers/g) ?? []).length,
    ).toBe(1);
    expect(logsCombined).toContain("2/2 models");
    expect(logsCombined).toContain("↑");
    expect(logsCombined).toContain("↓");
    expect(logsCombined).toContain("Δ");

    writeSpy.mockRestore();
    logSpy.mockRestore();
    if (originalTty === undefined) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete (process.stdout as { isTTY?: boolean }).isTTY;
    } else {
      (process.stdout as { isTTY?: boolean }).isTTY = originalTty;
    }
  });

  test("uses warning color when some models fail", async () => {
    const sessionMeta = {
      ...baseSessionMeta,
      models: [
        { model: "gpt-5.1", status: "running" },
        { model: "gemini-3-pro", status: "running" },
      ],
    } as SessionMetadata;

    sessionStoreMock.readSession.mockResolvedValue(sessionMeta);
    sessionStoreMock.readModelLog.mockResolvedValue("Answer:\npartial");

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const writeSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true as unknown as boolean);
    const originalTty = (process.stdout as { isTTY?: boolean }).isTTY;
    (process.stdout as { isTTY?: boolean }).isTTY = false;

    const summary: MultiModelRunSummary = {
      fulfilled: [
        {
          model: "gpt-5.1" as ModelName,
          usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0, totalTokens: 2, cost: 0 },
          answerText: "ok",
          logPath: "log-ok",
        },
      ],
      rejected: [{ model: "gemini-3-pro" as ModelName, reason: new Error("boom") }],
      elapsedMs: 500,
    };
    vi.mocked(runMultiModelApiSession).mockResolvedValue(summary);

    await expect(
      performSessionRun({
        sessionMeta,
        runOptions: { ...baseRunOptions, models: ["gpt-5.1", "gemini-3-pro"] },
        mode: "api",
        cwd: "/tmp",
        log: logSpy,
        write: writeSpy,
        version: cliVersion,
      }),
    ).rejects.toThrow("boom");

    const logsCombined = logSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(logsCombined).toContain("Calling gpt-5.1, gemini-3-pro");
    expect(logsCombined).toContain("1/2 models");
    expect(logsCombined).toContain("Multi-model result: partial success, 1/2 succeeded");
    expect(logsCombined).toContain("Failures:");
    expect(logsCombined).toContain("gemini-3-pro: boom");

    writeSpy.mockRestore();
    logSpy.mockRestore();
    if (originalTty === undefined) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete (process.stdout as { isTTY?: boolean }).isTTY;
    } else {
      (process.stdout as { isTTY?: boolean }).isTTY = originalTty;
    }
  });

  test("allows partial multi-model success when requested", async () => {
    const sessionMeta = {
      ...baseSessionMeta,
      models: [
        { model: "gpt-5.1", status: "running" },
        { model: "gemini-3-pro", status: "running" },
      ],
    } as SessionMetadata;

    sessionStoreMock.readSession.mockResolvedValue(sessionMeta);
    sessionStoreMock.readModelLog.mockResolvedValue("Answer:\npartial");

    const summary: MultiModelRunSummary = {
      fulfilled: [
        {
          model: "gpt-5.1" as ModelName,
          usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0, totalTokens: 2, cost: 0 },
          answerText: "ok",
          logPath: "log-ok",
        },
      ],
      rejected: [{ model: "gemini-3-pro" as ModelName, reason: new Error("boom") }],
      elapsedMs: 500,
    };
    vi.mocked(runMultiModelApiSession).mockResolvedValue(summary);

    await performSessionRun({
      sessionMeta,
      runOptions: {
        ...baseRunOptions,
        models: ["gpt-5.1", "gemini-3-pro"],
        partialMode: "ok",
      },
      mode: "api",
      cwd: "/tmp",
      log,
      write,
      version: cliVersion,
    });

    const finalUpdate = sessionStoreMock.updateSession.mock.calls.at(-1)?.[1];
    expect(finalUpdate).toMatchObject({ status: "partial" });
    const logsCombined = log.mock.calls.map((c) => c[0]).join("\n");
    expect(logsCombined).toContain("Multi-model result: partial success, 1/2 succeeded");
    expect(logsCombined).toContain("Failures:");
  });

  test("prints classified provider failures with recovery hints", async () => {
    const sessionMeta = {
      ...baseSessionMeta,
      models: [
        { model: "gpt-5.1", status: "running" },
        { model: "claude-4.6-sonnet", status: "running" },
      ],
    } as SessionMetadata;

    sessionStoreMock.readSession.mockResolvedValue(sessionMeta);
    sessionStoreMock.readModelLog.mockResolvedValue("Answer:\npartial");
    const providerError = new Error("invalid x-api-key: sk-ant-secret123456789");

    const summary: MultiModelRunSummary = {
      fulfilled: [
        {
          model: "gpt-5.1" as ModelName,
          usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0, totalTokens: 2, cost: 0 },
          answerText: "ok",
          logPath: "log-ok",
        },
      ],
      rejected: [
        {
          model: "claude-4.6-sonnet" as ModelName,
          reason: providerError,
        },
      ],
      elapsedMs: 500,
    };
    vi.mocked(runMultiModelApiSession).mockResolvedValue(summary);

    await withExactEnv(
      {
        ANTHROPIC_API_KEY: "ak-native-test-key",
        OPENROUTER_API_KEY: undefined,
      },
      () =>
        performSessionRun({
          sessionMeta,
          runOptions: {
            ...baseRunOptions,
            models: ["gpt-5.1", "claude-4.6-sonnet"],
            partialMode: "ok",
          },
          mode: "api",
          cwd: "/tmp",
          log,
          write,
          version: cliVersion,
        }),
    );

    const logsCombined = log.mock.calls.map((c) => c[0]).join("\n");
    expect(logsCombined).toContain("claude-4.6-sonnet: auth failed");
    expect(logsCombined).toContain("key: ANTHROPIC_API_KEY");
    expect(logsCombined).toContain("provider said: invalid x-api-key: [redacted]");
    expect(logsCombined).toContain("fix: refresh ANTHROPIC_API_KEY");
    expect(logsCombined).toContain("oracle doctor --providers --models claude-4.6-sonnet");
    expect(logsCombined).not.toContain("sk-ant-secret123456789");
  });

  test("sanitizes rethrown provider failures when partial success is not allowed", async () => {
    const sessionMeta = {
      ...baseSessionMeta,
      models: [
        { model: "gpt-5.1", status: "running" },
        { model: "claude-4.6-sonnet", status: "running" },
      ],
    } as SessionMetadata;

    sessionStoreMock.readSession.mockResolvedValue(sessionMeta);
    sessionStoreMock.readModelLog.mockResolvedValue("Answer:\npartial");
    const providerError = new Error("invalid x-api-key: sk-ant-secret123456789");

    const summary: MultiModelRunSummary = {
      fulfilled: [
        {
          model: "gpt-5.1" as ModelName,
          usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0, totalTokens: 2, cost: 0 },
          answerText: "ok",
          logPath: "log-ok",
        },
      ],
      rejected: [
        {
          model: "claude-4.6-sonnet" as ModelName,
          reason: providerError,
        },
      ],
      elapsedMs: 500,
    };
    vi.mocked(runMultiModelApiSession).mockResolvedValue(summary);

    let thrown: unknown;
    try {
      await withExactEnv(
        {
          ANTHROPIC_API_KEY: "ak-native-test-key",
          OPENROUTER_API_KEY: undefined,
        },
        () =>
          performSessionRun({
            sessionMeta,
            runOptions: {
              ...baseRunOptions,
              models: ["gpt-5.1", "claude-4.6-sonnet"],
            },
            mode: "api",
            cwd: "/tmp",
            log,
            write,
            version: cliVersion,
          }),
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("claude-4.6-sonnet: auth failed");
    expect((thrown as Error & { cause?: unknown }).cause).toBeUndefined();

    const logsCombined = log.mock.calls.map((c) => c[0]).join("\n");
    expect(logsCombined).toContain("ERROR: claude-4.6-sonnet: auth failed");
    expect(logsCombined).toContain("provider said: invalid x-api-key: [redacted]");
    expect(logsCombined).not.toContain("sk-ant-secret123456789");
    expect(providerError.message).toBe("invalid x-api-key: sk-ant-secret123456789");
  });

  test("preserves transport metadata when sanitizing rethrown provider failures", async () => {
    const sessionMeta = {
      ...baseSessionMeta,
      models: [{ model: "gpt-5.2-pro", status: "running" }],
    } as SessionMetadata;

    sessionStoreMock.readSession.mockResolvedValue(sessionMeta);
    sessionStoreMock.readModelLog.mockResolvedValue("");
    const transportError = new OracleTransportError(
      "model-unavailable",
      "The requested model does not exist for sk-secret123456789",
    );

    const summary: MultiModelRunSummary = {
      fulfilled: [],
      rejected: [
        {
          model: "gpt-5.2-pro" as ModelName,
          reason: transportError,
        },
      ],
      elapsedMs: 500,
    };
    vi.mocked(runMultiModelApiSession).mockResolvedValue(summary);

    let thrown: unknown;
    try {
      await performSessionRun({
        sessionMeta,
        runOptions: {
          ...baseRunOptions,
          models: ["gpt-5.2-pro", "gpt-5.1"],
        },
        mode: "api",
        cwd: "/tmp",
        log,
        write,
        version: cliVersion,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({
      reason: "model-unavailable",
      message: expect.stringContaining("gpt-5.2-pro: model unavailable"),
    });
    expect((thrown as Error & { cause?: unknown }).cause).toBeUndefined();

    const finalUpdate = sessionStoreMock.updateSession.mock.calls.at(-1)?.[1];
    expect(finalUpdate).toMatchObject({
      status: "error",
      transport: { reason: "model-unavailable" },
    });
    expect(finalUpdate?.errorMessage).toContain("gpt-5.2-pro: model unavailable");
    expect(finalUpdate?.errorMessage).not.toContain("sk-secret123456789");
    const logsCombined = log.mock.calls.map((c) => c[0]).join("\n");
    expect(logsCombined).toContain("Transport: model-unavailable");
    expect(logsCombined).not.toContain("sk-secret123456789");
    expect(transportError.message).toBe(
      "The requested model does not exist for sk-secret123456789",
    );
  });

  test("prints tips before the first model heading in multi-model TTY streaming", async () => {
    const sessionMeta = {
      ...baseSessionMeta,
      models: [
        { model: "gpt-5.1", status: "running" } as SessionModelRun,
        { model: "gemini-3-pro", status: "running" } as SessionModelRun,
      ],
    } as SessionMetadata;

    sessionStoreMock.readSession.mockResolvedValue(sessionMeta);
    sessionStoreMock.readModelLog.mockImplementation(
      async (_sessionId: string, model: string) => `Answer for ${model}`,
    );

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const writeSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true as unknown as boolean);
    const originalTty = (process.stdout as { isTTY?: boolean }).isTTY;
    (process.stdout as { isTTY?: boolean }).isTTY = true;

    const summary: MultiModelRunSummary = {
      fulfilled: [
        {
          model: "gpt-5.1" as ModelName,
          usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0, totalTokens: 2, cost: 0 },
          answerText: "ans-gpt",
          logPath: "log-gpt",
        },
      ],
      rejected: [],
      elapsedMs: 321,
    };
    vi.mocked(runMultiModelApiSession).mockImplementation(async (params) => {
      if (params.onModelDone) {
        for (const entry of summary.fulfilled) {
          await params.onModelDone(entry);
        }
      }
      return summary;
    });

    await performSessionRun({
      sessionMeta,
      runOptions: { ...baseRunOptions, models: ["gpt-5.1", "gemini-3-pro"], prompt: "short" },
      mode: "api",
      cwd: "/tmp",
      log: logSpy,
      write: writeSpy,
      version: cliVersion,
    });

    const logMessages = logSpy.mock.calls.map((c) => c[0]);
    const tipIndex = logMessages.findIndex(
      (line) => typeof line === "string" && line.includes("Tip: no files attached"),
    );
    const headingIndex = logMessages.findIndex(
      (line) => typeof line === "string" && line.includes("[gpt-5.1]"),
    );
    expect(tipIndex).toBeGreaterThan(-1);
    expect(headingIndex).toBeGreaterThan(-1);
    expect(tipIndex).toBeLessThan(headingIndex);

    writeSpy.mockRestore();
    logSpy.mockRestore();
    if (originalTty === undefined) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete (process.stdout as { isTTY?: boolean }).isTTY;
    } else {
      (process.stdout as { isTTY?: boolean }).isTTY = originalTty;
    }
  });

  test("omits tips when files are attached and prompt is long", async () => {
    const sessionMeta = {
      ...baseSessionMeta,
      models: [
        { model: "gpt-5.1", status: "running" } as SessionModelRun,
        { model: "gemini-3-pro", status: "running" } as SessionModelRun,
      ],
    } as SessionMetadata;

    sessionStoreMock.readSession.mockResolvedValue(sessionMeta);
    sessionStoreMock.readModelLog.mockResolvedValue("Answer:\nfrom model");

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const writeSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true as unknown as boolean);
    const originalTty = (process.stdout as { isTTY?: boolean }).isTTY;
    (process.stdout as { isTTY?: boolean }).isTTY = false;

    const tmpDir = os.tmpdir();
    const tmpFile = path.join(tmpDir, "oracle-tip.txt");
    fs.writeFileSync(tmpFile, "content");

    const summary: MultiModelRunSummary = {
      fulfilled: [
        {
          model: "gpt-5.1" as ModelName,
          usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0, totalTokens: 2, cost: 0 },
          answerText: "ans-gpt",
          logPath: "log-gpt",
        },
        {
          model: "gemini-3-pro" as ModelName,
          usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0, totalTokens: 2, cost: 0 },
          answerText: "ans-gem",
          logPath: "log-gemini",
        },
      ],
      rejected: [],
      elapsedMs: 999,
    };
    vi.mocked(runMultiModelApiSession).mockResolvedValue(summary);

    await performSessionRun({
      sessionMeta,
      runOptions: {
        ...baseRunOptions,
        prompt: "a".repeat(100),
        file: [tmpFile],
        models: ["gpt-5.1", "gemini-3-pro"],
      },
      mode: "api",
      cwd: tmpDir,
      log: logSpy,
      write: writeSpy,
      version: cliVersion,
    });

    const logsCombined = logSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(logsCombined).toContain("Calling gpt-5.1, gemini-3-pro");
    expect(logsCombined).not.toContain("Tip: no files attached");
    expect(logsCombined).not.toContain("Tip: brief prompts often yield generic answers");

    writeSpy.mockRestore();
    logSpy.mockRestore();
    if (originalTty === undefined) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete (process.stdout as { isTTY?: boolean }).isTTY;
    } else {
      (process.stdout as { isTTY?: boolean }).isTTY = originalTty;
    }
  }, 10_000);

  test("invokes browser runner when mode is browser", async () => {
    vi.mocked(runBrowserSessionExecution).mockResolvedValue({
      usage: { inputTokens: 100, outputTokens: 50, reasoningTokens: 0, totalTokens: 150 },
      elapsedMs: 2000,
      runtime: { chromePid: 123, chromePort: 9222, userDataDir: "/tmp/profile" },
      modelSelection: {
        requestedModel: "GPT-5.5 Pro",
        resolvedLabel: "Pro",
        strategy: "select",
        status: "already-selected",
        verified: true,
        source: "chatgpt-model-picker",
        capturedAt: "2026-05-13T00:00:00.000Z",
      },
      warnings: [
        {
          code: "browser-pro-fast-large-run",
          severity: "warning",
          message: "Large browser Pro run completed quickly.",
        },
      ],
      answerText: "Answer",
      artifacts: [{ kind: "transcript", path: "/tmp/transcript.md" }],
    });

    await performSessionRun({
      sessionMeta: baseSessionMeta,
      runOptions: baseRunOptions,
      mode: "browser",
      browserConfig: { chromePath: null },
      cwd: "/tmp",
      log,
      write,
      version: cliVersion,
    });

    expect(vi.mocked(runBrowserSessionExecution)).toHaveBeenCalled();
    expect(vi.mocked(sendSessionNotification)).toHaveBeenCalled();
    const finalUpdate = sessionStoreMock.updateSession.mock.calls.at(-1)?.[1];
    expect(finalUpdate).toMatchObject({
      status: "completed",
      browser: expect.objectContaining({
        runtime: expect.objectContaining({ chromePid: 123 }),
        modelSelection: expect.objectContaining({ resolvedLabel: "Pro" }),
        warnings: [expect.objectContaining({ code: "browser-pro-fast-large-run" })],
      }),
      artifacts: [{ kind: "transcript", path: "/tmp/transcript.md" }],
    });
    expect(finalUpdate).toHaveProperty("errorMessage", undefined);
    expect(sessionStoreMock.updateModelRun).toHaveBeenCalledWith(
      baseSessionMeta.id,
      "gpt-5.2-pro",
      expect.objectContaining({ status: "running" }),
    );
    expect(sessionStoreMock.updateModelRun).toHaveBeenCalledWith(
      baseSessionMeta.id,
      "gpt-5.2-pro",
      expect.objectContaining({ status: "completed" }),
    );
  });

  test("writes browser answers to disk when writeOutputPath provided", async () => {
    vi.mocked(runBrowserSessionExecution).mockResolvedValue({
      usage: { inputTokens: 10, outputTokens: 5, reasoningTokens: 0, totalTokens: 15 },
      elapsedMs: 500,
      runtime: { chromePid: 1, chromePort: 9222, userDataDir: "/tmp/chrome" },
      answerText: "browser answer",
    });

    await performSessionRun({
      sessionMeta: baseSessionMeta,
      runOptions: { ...baseRunOptions, writeOutputPath: "/tmp/browser-out.md" },
      mode: "browser",
      browserConfig: { chromePath: null },
      cwd: "/tmp",
      log,
      write,
      version: cliVersion,
    });

    const writeCalls = (fsPromises.writeFile as unknown as { mock: { calls: unknown[][] } }).mock
      .calls;
    const expectedPath = path.resolve("/tmp/browser-out.md");
    expect(writeCalls).toContainEqual([
      expectedPath,
      expect.stringContaining("browser answer\n"),
      "utf8",
    ]);
  });

  test("write-output failures warn but keep session successful", async () => {
    const liveResult: RunOracleResult = {
      mode: "live",
      usage: { inputTokens: 5, outputTokens: 5, reasoningTokens: 0, totalTokens: 10 },
      elapsedMs: 300,
      response: {
        id: "resp",
        usage: {},
        output: [{ type: "message", content: [{ type: "output_text", text: "content" }] }],
      },
    };
    vi.mocked(runOracle).mockResolvedValue(liveResult);
    const eacces = new Error("EACCES");
    // @ts-expect-error simulate code
    eacces.code = "EACCES";
    vi.mocked(fsPromises.writeFile)
      .mockRejectedValueOnce(eacces as never)
      .mockResolvedValueOnce(
        undefined as unknown as Awaited<ReturnType<typeof fsPromises.writeFile>>,
      );

    await expect(
      performSessionRun({
        sessionMeta: baseSessionMeta,
        runOptions: { ...baseRunOptions, writeOutputPath: "/tmp/out.md" },
        mode: "api",
        cwd: "/tmp",
        log,
        write,
        version: cliVersion,
      }),
    ).resolves.not.toThrow();

    const finalUpdate = sessionStoreMock.updateSession.mock.calls.at(-1)?.[1];
    expect(finalUpdate).toMatchObject({ status: "completed" });
    const logLines = log.mock.calls.map((c) => c[0]).join("\n");
    expect(logLines).toContain("write-output fallback");
    const calls = (fsPromises.writeFile as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(calls[0][0]).toBe(path.resolve("/tmp/out.md"));
    expect(calls[1][0]).toMatch(/out\.fallback/);
  });

  test("refuses to write inside session storage path", async () => {
    const sessionsDir = sessionStoreMock.sessionsDir();
    const liveResult: RunOracleResult = {
      mode: "live",
      usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0, totalTokens: 2 },
      elapsedMs: 100,
      response: {
        id: "resp",
        usage: {},
        output: [{ type: "message", content: [{ type: "output_text", text: "blocked" }] }],
      },
    };
    vi.mocked(runOracle).mockResolvedValue(liveResult);

    await performSessionRun({
      sessionMeta: baseSessionMeta,
      runOptions: { ...baseRunOptions, writeOutputPath: path.join(sessionsDir, "out.md") },
      mode: "api",
      cwd: "/tmp",
      log,
      write,
      version: cliVersion,
    });

    expect(fsPromises.writeFile).not.toHaveBeenCalled();
    const logLines = log.mock.calls.map((c) => c[0]).join("\n");
    expect(logLines).toContain("refusing to write inside session storage");
  });

  test("deriveModelOutputPath appends model when base has no extension", () => {
    const result = deriveModelOutputPath("/tmp/out", "gpt-5.2-pro");
    const expected = path.join(path.dirname("/tmp/out"), "out.gpt-5.2-pro");
    expect(result).toBe(expected);
  });

  test("records metadata when browser automation fails", async () => {
    const automationError = new BrowserAutomationError("automation failed", {
      stage: "execute-browser",
    });
    vi.mocked(runBrowserSessionExecution).mockRejectedValueOnce(automationError);

    await expect(
      performSessionRun({
        sessionMeta: baseSessionMeta,
        runOptions: baseRunOptions,
        mode: "browser",
        browserConfig: { chromePath: null },
        cwd: "/tmp",
        log,
        write,
        version: cliVersion,
      }),
    ).rejects.toThrow("automation failed");

    const finalUpdate = sessionStoreMock.updateSession.mock.calls.at(-1)?.[1];
    expect(finalUpdate).toMatchObject({
      status: "error",
      errorMessage: "automation failed",
      browser: expect.objectContaining({ config: expect.any(Object) }),
    });
    expect(sessionStoreMock.updateModelRun).toHaveBeenCalledWith(
      baseSessionMeta.id,
      "gpt-5.2-pro",
      expect.objectContaining({ status: "error" }),
    );
    const logLines = log.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logLines).not.toContain("Next steps (browser fallback)");
    expect(logLines).not.toContain("--engine api");
    // PR 243 gates reattach guidance on a recoverable ChatGPT runtime; this
    // failure path has none, so no guidance is logged (covered positively by
    // the recoverable-runtime cases below).
    expect(logLines).not.toContain("This run did not return cleanly");
  });

  test("keeps session running when browser connection is lost", async () => {
    const automationError = new BrowserAutomationError(
      "Chrome window closed before oracle finished.",
      {
        stage: "connection-lost",
        runtime: {
          chromePort: 9222,
          chromeHost: "127.0.0.1",
          tabUrl: "https://chatgpt.com/c/demo",
        },
      },
    );
    vi.mocked(runBrowserSessionExecution).mockRejectedValueOnce(automationError);

    await performSessionRun({
      sessionMeta: baseSessionMeta,
      runOptions: baseRunOptions,
      mode: "browser",
      browserConfig: { chromePath: null },
      cwd: "/tmp",
      log,
      write,
      version: cliVersion,
    });

    const finalUpdate = sessionStoreMock.updateSession.mock.calls.at(-1)?.[1];
    expect(finalUpdate).toMatchObject({
      status: "running",
      response: { status: "running", incompleteReason: "chrome-disconnected" },
      browser: expect.objectContaining({ runtime: expect.objectContaining({ chromePort: 9222 }) }),
    });
    expect(sessionStoreMock.updateModelRun).toHaveBeenCalledWith(
      baseSessionMeta.id,
      "gpt-5.2-pro",
      expect.objectContaining({ status: "running" }),
    );
    const logLines = log.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logLines).toContain(
      "Chrome disconnected before completion; keeping session running for reattach.",
    );
    expect(logLines).toContain(
      "This run did not return cleanly, but it may still be alive. Reattach:",
    );
    expect(logLines).toContain("oracle session sess-1 --render");
    expect(logLines).toContain("oracle session sess-1 --live");
    expect(logLines).toContain("oracle session sess-1 --harvest");
  });

  test("marks copied-profile connection loss as non-reattachable", async () => {
    const automationError = new BrowserAutomationError(
      "Chrome window closed before oracle finished.",
      {
        stage: "connection-lost",
        runtime: {
          chromePort: 9222,
          chromeHost: "127.0.0.1",
          tabUrl: "https://chatgpt.com/c/demo",
        },
      },
    );
    vi.mocked(runBrowserSessionExecution).mockRejectedValueOnce(automationError);

    await expect(
      performSessionRun({
        sessionMeta: baseSessionMeta,
        runOptions: baseRunOptions,
        mode: "browser",
        browserConfig: { chromePath: null, copyProfileSource: "/tmp/source-profile" },
        cwd: "/tmp",
        log,
        write,
        version: cliVersion,
      }),
    ).rejects.toThrow("Chrome window closed");

    const finalUpdate = sessionStoreMock.updateSession.mock.calls.at(-1)?.[1];
    expect(finalUpdate).toMatchObject({ status: "error" });
    expect(finalUpdate?.browser?.runtime).toBeUndefined();
    expect(sessionStoreMock.updateModelRun).toHaveBeenCalledWith(
      baseSessionMeta.id,
      "gpt-5.2-pro",
      expect.objectContaining({ status: "error" }),
    );
    const logLines = log.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logLines).not.toContain("keeping session running for reattach");
    expect(logLines).not.toContain("oracle session sess-1 --render");
  });

  test("marks early browser disconnect as error before a conversation exists", async () => {
    const automationError = new BrowserAutomationError(
      "Chrome window closed before oracle reached the composer.",
      {
        stage: "connection-lost",
        runtime: {
          chromePort: 9222,
          chromeHost: "127.0.0.1",
          tabUrl: "https://chatgpt.com/",
        },
      },
    );
    vi.mocked(runBrowserSessionExecution).mockRejectedValueOnce(automationError);

    await expect(
      performSessionRun({
        sessionMeta: baseSessionMeta,
        runOptions: baseRunOptions,
        mode: "browser",
        browserConfig: { chromePath: null },
        cwd: "/tmp",
        log,
        write,
        version: cliVersion,
      }),
    ).rejects.toThrow(/Chrome window closed/);

    const finalUpdate = sessionStoreMock.updateSession.mock.calls.at(-1)?.[1];
    expect(finalUpdate).toMatchObject({
      status: "error",
      response: { status: "error", incompleteReason: "chrome-disconnected" },
      browser: expect.objectContaining({ runtime: expect.objectContaining({ chromePort: 9222 }) }),
    });
    expect(sessionStoreMock.updateModelRun).toHaveBeenCalledWith(
      baseSessionMeta.id,
      "gpt-5.2-pro",
      expect.objectContaining({
        status: "error",
        response: { status: "error", incompleteReason: "chrome-disconnected" },
      }),
    );
    const logLines = log.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logLines).toContain(
      "Chrome disconnected before a ChatGPT conversation was created; marking session error.",
    );
    expect(logLines).not.toContain("This run did not return cleanly");
    expect(logLines).not.toContain("oracle session sess-1 --render");
  });

  test("marks browser capture incomplete when assistant response times out", async () => {
    const automationError = new BrowserAutomationError(
      "ChatGPT displayed a rate-limit warning while waiting for the assistant: Too many requests.",
      {
        stage: "assistant-timeout",
        code: "chatgpt-ui-warning",
        uiWarning: {
          type: "rate_limit",
          message: "Too many requests.",
        },
        runtime: {
          chromePort: 9222,
          chromeHost: "127.0.0.1",
          tabUrl: "https://chatgpt.com/c/demo",
        },
        diagnostics: {
          domPath: "/tmp/.oracle/sessions/sess-1/artifacts/assistant-timeout.dom.json",
          screenshotPath: "/tmp/.oracle/sessions/sess-1/artifacts/assistant-timeout.png",
        },
      },
    );
    vi.mocked(runBrowserSessionExecution).mockRejectedValueOnce(automationError);

    await performSessionRun({
      sessionMeta: baseSessionMeta,
      runOptions: baseRunOptions,
      mode: "browser",
      browserConfig: { chromePath: null },
      cwd: "/tmp",
      log,
      write,
      version: cliVersion,
    });

    const finalUpdate = sessionStoreMock.updateSession.mock.calls.at(-1)?.[1];
    expect(finalUpdate).toMatchObject({
      status: "error",
      response: { status: "incomplete", incompleteReason: "incomplete-capture" },
      browser: expect.objectContaining({ runtime: expect.objectContaining({ chromePort: 9222 }) }),
      error: expect.objectContaining({
        details: expect.objectContaining({
          code: "chatgpt-ui-warning",
          uiWarning: {
            type: "rate_limit",
            message: "Too many requests.",
          },
          diagnostics: expect.objectContaining({
            domPath: "/tmp/.oracle/sessions/sess-1/artifacts/assistant-timeout.dom.json",
            screenshotPath: "/tmp/.oracle/sessions/sess-1/artifacts/assistant-timeout.png",
          }),
        }),
      }),
    });
    expect(sessionStoreMock.updateModelRun).toHaveBeenCalledWith(
      baseSessionMeta.id,
      "gpt-5.2-pro",
      expect.objectContaining({
        status: "error",
        response: { status: "incomplete", incompleteReason: "incomplete-capture" },
        error: expect.objectContaining({
          details: expect.objectContaining({
            diagnostics: expect.objectContaining({
              domPath: "/tmp/.oracle/sessions/sess-1/artifacts/assistant-timeout.dom.json",
              screenshotPath: "/tmp/.oracle/sessions/sess-1/artifacts/assistant-timeout.png",
            }),
          }),
        }),
      }),
    );
    const logLines = log.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logLines).toContain(
      "ERROR: ChatGPT displayed a rate-limit warning while waiting for the assistant: Too many requests.",
    );
    expect(logLines).toContain(
      "Assistant response timed out; marking capture incomplete for reattach.",
    );
    expect(logLines).toContain(
      "This run did not return cleanly, but it may still be alive. Reattach:",
    );
    expect(logLines).toContain("oracle session sess-1 --render");
    expect(logLines).toContain("oracle session sess-1 --live");
    expect(logLines).toContain("oracle session sess-1 --harvest");
  });

  test("records runtime and profile reuse guidance when cloudflare challenge is detected", async () => {
    const automationError = new BrowserAutomationError(
      "Cloudflare challenge detected. Complete the “Just a moment…” check in the open browser, then rerun.",
      {
        stage: "cloudflare-challenge",
        runtime: {
          chromePort: 9222,
          chromeHost: "127.0.0.1",
          userDataDir: "/tmp/oracle-browser-profile",
        },
        reuseProfileHint:
          'oracle --engine browser --browser-manual-login --browser-manual-login-profile-dir "/tmp/oracle-browser-profile"',
      },
    );
    vi.mocked(runBrowserSessionExecution).mockRejectedValueOnce(automationError);

    await expect(
      performSessionRun({
        sessionMeta: baseSessionMeta,
        runOptions: baseRunOptions,
        mode: "browser",
        browserConfig: { chromePath: null },
        cwd: "/tmp",
        log,
        write,
        version: cliVersion,
      }),
    ).rejects.toThrow("Cloudflare challenge detected");

    const finalUpdate = sessionStoreMock.updateSession.mock.calls.at(-1)?.[1];
    expect(finalUpdate).toMatchObject({
      status: "error",
      browser: expect.objectContaining({
        config: expect.any(Object),
        runtime: expect.objectContaining({
          chromePort: 9222,
          userDataDir: "/tmp/oracle-browser-profile",
        }),
      }),
      error: expect.objectContaining({
        category: "browser-automation",
        details: expect.objectContaining({ stage: "cloudflare-challenge" }),
      }),
    });
    const logLines = log.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logLines).toContain(
      "Cloudflare challenge detected; browser left running so you can complete the check.",
    );
    expect(logLines).toContain(
      "Reuse this browser profile with: oracle --engine browser --browser-manual-login",
    );
    expect(logLines).not.toContain("This run did not return cleanly");
    expect(logLines).not.toContain("oracle session sess-1 --render");
  });

  test("does not advertise reattach for a removed copied profile after Cloudflare", async () => {
    const automationError = new BrowserAutomationError(
      "Cloudflare challenge detected. Copy-profile runs cannot be retained.",
      {
        stage: "cloudflare-challenge",
        reattachable: false,
      },
    );
    vi.mocked(runBrowserSessionExecution).mockRejectedValueOnce(automationError);

    await expect(
      performSessionRun({
        sessionMeta: baseSessionMeta,
        runOptions: baseRunOptions,
        mode: "browser",
        browserConfig: { chromePath: null, copyProfileSource: "/tmp/source-profile" },
        cwd: "/tmp",
        log,
        write,
        version: cliVersion,
      }),
    ).rejects.toThrow("Copy-profile runs cannot be retained");

    const finalUpdate = sessionStoreMock.updateSession.mock.calls.at(-1)?.[1];
    expect(finalUpdate?.browser?.runtime).toBeUndefined();
    const logLines = log.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logLines).toContain("Cloudflare challenge detected; copied profile closed and removed.");
    expect(logLines).not.toContain("browser left running");
    expect(logLines).not.toContain("oracle session sess-1 --render");
  });

  test("does not auto-reattach after a copied-profile assistant timeout", async () => {
    const automationError = new BrowserAutomationError("assistant timed out", {
      stage: "assistant-timeout",
      reattachable: false,
    });
    vi.mocked(runBrowserSessionExecution).mockRejectedValueOnce(automationError);

    await expect(
      performSessionRun({
        sessionMeta: baseSessionMeta,
        runOptions: baseRunOptions,
        mode: "browser",
        browserConfig: {
          chromePath: null,
          copyProfileSource: "/tmp/source-profile",
          autoReattachIntervalMs: 100,
        },
        cwd: "/tmp",
        log,
        write,
        version: cliVersion,
      }),
    ).rejects.toThrow("assistant timed out");

    expect(resumeBrowserSession).not.toHaveBeenCalled();
    const finalUpdate = sessionStoreMock.updateSession.mock.calls.at(-1)?.[1];
    expect(finalUpdate?.browser?.runtime).toBeUndefined();
    const logLines = log.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logLines).not.toContain("capture incomplete for reattach");
    expect(logLines).not.toContain("oracle session sess-1 --render");
  });

  test("auto-reattaches after assistant timeout when configured", async () => {
    const automationError = new BrowserAutomationError("assistant timed out", {
      stage: "assistant-timeout",
      runtime: { chromePort: 9222, chromeHost: "127.0.0.1", tabUrl: "https://chatgpt.com/c/demo" },
    });
    vi.mocked(runBrowserSessionExecution).mockRejectedValueOnce(automationError);
    vi.mocked(resumeBrowserSession).mockResolvedValue({
      answerText: "ok text",
      answerMarkdown: "ok markdown",
    });
    vi.mocked(ensureSessionArtifacts).mockResolvedValue([
      { kind: "transcript", path: "/tmp/transcript.md" },
      { kind: "deep-research-report", path: "/tmp/deep-research-report.md" },
    ]);

    await performSessionRun({
      sessionMeta: baseSessionMeta,
      runOptions: baseRunOptions,
      mode: "browser",
      browserConfig: {
        chromePath: null,
        autoReattachDelayMs: 0,
        autoReattachIntervalMs: 1000,
        autoReattachTimeoutMs: 1000,
      },
      cwd: "/tmp",
      log,
      write,
      version: cliVersion,
    });

    expect(vi.mocked(resumeBrowserSession)).toHaveBeenCalled();
    expect(vi.mocked(ensureSessionArtifacts)).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: baseSessionMeta.id,
        prompt: baseRunOptions.prompt,
        answerMarkdown: "ok markdown",
        conversationUrl: "https://chatgpt.com/c/demo",
      }),
    );
    const finalUpdate = sessionStoreMock.updateSession.mock.calls.at(-1)?.[1];
    expect(finalUpdate).toMatchObject({
      status: "completed",
      artifacts: [
        { kind: "transcript", path: "/tmp/transcript.md" },
        { kind: "deep-research-report", path: "/tmp/deep-research-report.md" },
      ],
      response: { status: "completed" },
    });
    expect(vi.mocked(sendSessionNotification)).toHaveBeenCalled();
  });

  test("auto-reattach stops after a hard cap when it cannot capture an answer", async () => {
    vi.useFakeTimers();
    try {
      const automationError = new BrowserAutomationError("assistant timed out", {
        stage: "assistant-timeout",
        runtime: {
          chromePort: 9222,
          chromeHost: "127.0.0.1",
          tabUrl: "https://chatgpt.com/c/demo",
        },
      });
      vi.mocked(runBrowserSessionExecution).mockRejectedValueOnce(automationError);
      vi.mocked(resumeBrowserSession).mockRejectedValue(new Error("not ready"));

      const pending = performSessionRun({
        sessionMeta: baseSessionMeta,
        runOptions: baseRunOptions,
        mode: "browser",
        browserConfig: {
          chromePath: null,
          autoReattachDelayMs: 0,
          autoReattachIntervalMs: 60 * 60 * 1000,
          autoReattachTimeoutMs: 1000,
        },
        cwd: "/tmp",
        log,
        write,
        version: cliVersion,
      });

      await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000 + 5_000);
      await pending;

      expect(vi.mocked(resumeBrowserSession).mock.calls.length).toBeGreaterThanOrEqual(2);
      const finalUpdate = sessionStoreMock.updateSession.mock.calls.at(-1)?.[1];
      expect(finalUpdate).toMatchObject({
        status: "error",
        response: { status: "incomplete", incompleteReason: "incomplete-capture" },
      });
      const logLines = log.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logLines).toContain("Auto-reattach stopped");
      expect(logLines).toContain(
        "This run did not return cleanly, but it may still be alive. Reattach:",
      );
      expect(logLines).toContain("oracle session sess-1 --render");
      expect(logLines).toContain("oracle session sess-1 --live");
      expect(logLines).toContain("oracle session sess-1 --harvest");
    } finally {
      vi.useRealTimers();
    }
  });

  test("records response metadata when runOracle throws OracleResponseError", async () => {
    const errorResponse: OracleResponse = { id: "resp-error", output: [], usage: {} };
    vi.mocked(runOracle).mockRejectedValue(new OracleResponseError("boom", errorResponse));

    await expect(
      performSessionRun({
        sessionMeta: baseSessionMeta,
        runOptions: baseRunOptions,
        mode: "api",
        cwd: "/tmp",
        log,
        write,
        version: cliVersion,
      }),
    ).rejects.toThrow("boom");

    const finalUpdate = sessionStoreMock.updateSession.mock.calls.at(-1)?.[1];
    expect(finalUpdate).toMatchObject({
      status: "error",
      response: expect.objectContaining({ responseId: "resp-error" }),
    });
    expect(sessionStoreMock.updateModelRun).toHaveBeenCalledWith(
      baseSessionMeta.id,
      "gpt-5.2-pro",
      expect.objectContaining({ status: "running" }),
    );
    expect(sessionStoreMock.updateModelRun).toHaveBeenCalledWith(
      baseSessionMeta.id,
      "gpt-5.2-pro",
      expect.objectContaining({ status: "error" }),
    );
  });

  test("captures transport failures when OracleTransportError thrown", async () => {
    vi.mocked(runOracle).mockRejectedValue(new OracleTransportError("client-timeout", "timeout"));

    await expect(
      performSessionRun({
        sessionMeta: baseSessionMeta,
        runOptions: baseRunOptions,
        mode: "api",
        cwd: "/tmp",
        log,
        write,
        version: cliVersion,
      }),
    ).rejects.toThrow("timeout");

    const finalUpdate = sessionStoreMock.updateSession.mock.calls.at(-1)?.[1];
    expect(finalUpdate).toMatchObject({
      status: "error",
      transport: { reason: "client-timeout" },
    });
    expect(sessionStoreMock.updateModelRun).toHaveBeenCalledWith(
      baseSessionMeta.id,
      "gpt-5.2-pro",
      expect.objectContaining({ status: "error" }),
    );
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Transport"));
  });

  test("stores api-error transport message for later rendering", async () => {
    vi.mocked(runOracle).mockRejectedValue(new OracleTransportError("api-error", "quota exceeded"));

    await expect(
      performSessionRun({
        sessionMeta: baseSessionMeta,
        runOptions: baseRunOptions,
        mode: "api",
        cwd: "/tmp",
        log,
        write,
        version: cliVersion,
      }),
    ).rejects.toThrow("quota exceeded");

    const finalUpdate = sessionStoreMock.updateSession.mock.calls.at(-1)?.[1];
    expect(finalUpdate).toMatchObject({
      status: "error",
      transport: { reason: "api-error" },
      errorMessage: "quota exceeded",
    });
  });

  test("captures user errors when OracleUserError thrown", async () => {
    vi.mocked(runOracle).mockRejectedValue(
      new FileValidationError("too large", { path: "foo.txt" }),
    );

    await expect(
      performSessionRun({
        sessionMeta: baseSessionMeta,
        runOptions: baseRunOptions,
        mode: "api",
        cwd: "/tmp",
        log,
        write,
        version: cliVersion,
      }),
    ).rejects.toThrow("too large");

    const finalUpdate = sessionStoreMock.updateSession.mock.calls.at(-1)?.[1];
    expect(finalUpdate).toMatchObject({
      status: "error",
      error: expect.objectContaining({ category: "file-validation", message: "too large" }),
    });
    expect(sessionStoreMock.updateModelRun).toHaveBeenCalledWith(
      baseSessionMeta.id,
      "gpt-5.2-pro",
      expect.objectContaining({ status: "error" }),
    );
    expect(log).toHaveBeenCalledWith(expect.stringContaining("User error (file-validation)"));
  });
});

describe("claude-code caam shallow-spawn integration (caam-map.md §4)", () => {
  interface CaamFixture {
    root: string;
    oracleHome: string;
    sessionsDir: string;
    sessionDir: string;
    repoDir: string;
    binDir: string;
  }

  function setupCaamFixture(): CaamFixture {
    const root = fs.mkdtempSync(path.join(os.homedir(), ".oracle-claude-code-caam-test-"));
    const oracleHome = path.join(root, "oracle-home");
    const sessionsDir = path.join(root, "sessions");
    const sessionDir = path.join(sessionsDir, "sess-1");
    const repoDir = path.join(root, "repo");
    const binDir = path.join(root, "bin");
    for (const dir of [oracleHome, sessionsDir, sessionDir, repoDir, binDir]) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.chmodSync(dir, 0o700);
    }
    sessionStoreMock.sessionsDir.mockReturnValue(sessionsDir);
    sessionStoreMock.getPaths.mockResolvedValue({
      dir: sessionDir,
      metadata: path.join(sessionDir, "meta.json"),
      request: path.join(sessionDir, "request.json"),
      log: path.join(sessionDir, "output.log"),
    });
    setOracleHomeDirOverrideForTest(oracleHome);
    return { root, oracleHome, sessionsDir, sessionDir, repoDir, binDir };
  }

  function teardownCaamFixture(fixture: CaamFixture): void {
    setOracleHomeDirOverrideForTest(null);
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }

  test("caam profile configured + healthy: wraps buildClaudeCodeCommand() argv and keys the lock on the profile", async () => {
    vi.mocked(fsPromises.mkdir).mockRestore();
    vi.mocked(fsPromises.writeFile).mockRestore();
    const fixture = setupCaamFixture();
    try {
      const claudePath = createFakeClaudeExecutable({
        binDir: fixture.binDir,
        argvPath: path.join(fixture.root, "claude-argv-unused.json"),
        stdinPath: path.join(fixture.root, "claude-stdin-unused.txt"),
        markerPath: path.join(fixture.root, "claude-marker-unused.txt"),
      });
      const doctorInvocationArgvPath = path.join(fixture.root, "doctor-argv.json");
      const shallowSpawnArgvPath = path.join(fixture.root, "shallow-spawn-argv.json");
      const caamMarkerPath = path.join(fixture.root, "caam-spawned.txt");
      createFakeCaamExecutable({
        binDir: fixture.binDir,
        doctorInvocationArgvPath,
        shallowSpawnArgvPath,
        markerPath: caamMarkerPath,
        stdinPath: path.join(fixture.root, "caam-stdin.txt"),
        doctorHealthy: true,
      });

      // A busy GLOBAL lock (no profile) must NOT block a caam-profiled run —
      // this is the concrete "distinct profiles run in parallel" payoff of
      // keying the lock filename on the profile (caam-map.md §4b).
      const locksDir = path.join(fixture.oracleHome, "locks");
      fs.mkdirSync(locksDir, { recursive: true, mode: 0o700 });
      const globalLockPath = path.join(locksDir, "claude-code-subscription.lock");
      fs.writeFileSync(
        globalLockPath,
        `${JSON.stringify({
          schema_version: "claude_code_single_flight_lock.v1",
          session_id: "unrelated-global-session",
          pid: 999_999_999,
          nonce: "stale",
          created_at: "2026-07-02T00:00:00.000Z",
        })}\n`,
        { mode: 0o600 },
      );

      await withExactEnv(
        {
          ...blockedClaudeCodeEnvDefaults,
          PATH: `${fixture.binDir}${path.delimiter}${process.env.PATH ?? ""}`,
          [ORACLE_CLAUDE_CODE_CAAM_PROFILE_ENV_VAR]: "arthur",
        },
        async () => {
          await performSessionRun({
            sessionMeta: { ...baseSessionMeta, mode: "claude-code", model: "fable" },
            runOptions: { prompt: "Review via caam", model: "fable" },
            mode: "claude-code",
            cwd: fixture.repoDir,
            log,
            write,
            version: cliVersion,
            muteStdout: true,
          });
        },
      );

      // Doctor pre-flight ran read-only, scoped to the right profile, before the spawn.
      const doctorArgv = JSON.parse(fs.readFileSync(doctorInvocationArgvPath, "utf8")) as string[];
      expect(doctorArgv).toEqual(["shallow-spawn", "arthur", "--print-env", "--json"]);

      // The outer command is exactly:
      //   caam shallow-spawn arthur --base <oracleHome>/claude-code-shallow-homes -- <claude> <inner argv...>
      // where the inner argv is byte-for-byte buildClaudeCodeCommand()'s
      // own output — untouched by the caam wrapper (caam-map.md §4a).
      const shallowSpawnArgv = JSON.parse(fs.readFileSync(shallowSpawnArgvPath, "utf8")) as string[];
      const expectedInner = buildClaudeCodeCommand({ executable: claudePath, model: "fable" });
      expect(shallowSpawnArgv).toEqual([
        "shallow-spawn",
        "arthur",
        "--base",
        path.join(fixture.oracleHome, "claude-code-shallow-homes"),
        "--",
        claudePath,
        ...expectedInner.args,
      ]);

      expect(fs.readFileSync(caamMarkerPath, "utf8")).toBe("spawned\n");

      // Per-profile lock was used and released — not the global one.
      expect(fs.existsSync(path.join(locksDir, "claude-code-subscription-arthur.lock"))).toBe(
        false,
      );
      expect(fs.existsSync(globalLockPath)).toBe(true);

      const finalUpdate = sessionStoreMock.updateSession.mock.calls.at(-1)?.[1];
      expect(finalUpdate).toMatchObject({ status: "completed", mode: "claude-code" });
    } finally {
      teardownCaamFixture(fixture);
    }
  });

  test("caam profile configured: a busy SAME-profile lock still serializes (refuses, does not spawn)", async () => {
    vi.mocked(fsPromises.mkdir).mockRestore();
    vi.mocked(fsPromises.writeFile).mockRestore();
    const fixture = setupCaamFixture();
    try {
      createFakeClaudeExecutable({
        binDir: fixture.binDir,
        argvPath: path.join(fixture.root, "claude-argv-unused.json"),
        stdinPath: path.join(fixture.root, "claude-stdin-unused.txt"),
        markerPath: path.join(fixture.root, "claude-marker-unused.txt"),
      });
      const caamMarkerPath = path.join(fixture.root, "caam-spawned.txt");
      createFakeCaamExecutable({
        binDir: fixture.binDir,
        doctorInvocationArgvPath: path.join(fixture.root, "doctor-argv.json"),
        shallowSpawnArgvPath: path.join(fixture.root, "shallow-spawn-argv.json"),
        markerPath: caamMarkerPath,
        stdinPath: path.join(fixture.root, "caam-stdin.txt"),
        doctorHealthy: true,
      });

      const locksDir = path.join(fixture.oracleHome, "locks");
      fs.mkdirSync(locksDir, { recursive: true, mode: 0o700 });
      const profileLockPath = path.join(locksDir, "claude-code-subscription-arthur.lock");
      fs.writeFileSync(
        profileLockPath,
        `${JSON.stringify({
          schema_version: "claude_code_single_flight_lock.v1",
          session_id: "busy-arthur-session",
          pid: process.pid,
          nonce: "busy-lock",
          created_at: "2026-07-02T00:00:00.000Z",
        })}\n`,
        { mode: 0o600 },
      );

      await withExactEnv(
        {
          ...blockedClaudeCodeEnvDefaults,
          PATH: `${fixture.binDir}${path.delimiter}${process.env.PATH ?? ""}`,
          [ORACLE_CLAUDE_CODE_CAAM_PROFILE_ENV_VAR]: "arthur",
        },
        async () => {
          await expect(
            performSessionRun({
              sessionMeta: { ...baseSessionMeta, mode: "claude-code", model: "fable" },
              runOptions: { prompt: "Review via caam", model: "fable" },
              mode: "claude-code",
              cwd: fixture.repoDir,
              log,
              write,
              version: cliVersion,
            }),
          ).rejects.toThrow(/already running in session busy-arthur-session/);
        },
      );

      expect(fs.existsSync(caamMarkerPath)).toBe(false);
      expect(fs.existsSync(profileLockPath)).toBe(true);
    } finally {
      teardownCaamFixture(fixture);
    }
  });

  test("graceful fallback: caam absent from PATH runs the exact direct-claude behavior (global lock)", async () => {
    vi.mocked(fsPromises.mkdir).mockRestore();
    vi.mocked(fsPromises.writeFile).mockRestore();
    const fixture = setupCaamFixture();
    try {
      const claudeArgvPath = path.join(fixture.root, "claude-argv.json");
      const claudeMarkerPath = path.join(fixture.root, "claude-marker.txt");
      createFakeClaudeExecutable({
        binDir: fixture.binDir,
        argvPath: claudeArgvPath,
        stdinPath: path.join(fixture.root, "claude-stdin.txt"),
        markerPath: claudeMarkerPath,
      });
      // Deliberately no `caam` binary anywhere on PATH.

      await withExactEnv(
        {
          ...blockedClaudeCodeEnvDefaults,
          PATH: `${fixture.binDir}${path.delimiter}${process.env.PATH ?? ""}`,
          [ORACLE_CLAUDE_CODE_CAAM_PROFILE_ENV_VAR]: "arthur",
        },
        async () => {
          await performSessionRun({
            sessionMeta: { ...baseSessionMeta, mode: "claude-code", model: "fable" },
            runOptions: { prompt: "Review without caam installed", model: "fable" },
            mode: "claude-code",
            cwd: fixture.repoDir,
            log,
            write,
            version: cliVersion,
            muteStdout: true,
          });
        },
      );

      // The direct `claude` fake ran, and received the UNWRAPPED inner argv
      // — no "shallow-spawn"/"--base" prefix — exactly today's behavior.
      expect(fs.readFileSync(claudeMarkerPath, "utf8")).toBe("spawned\n");
      const argv = JSON.parse(fs.readFileSync(claudeArgvPath, "utf8")) as string[];
      expect(argv[0]).toBe("-p");
      expect(argv).not.toContain("shallow-spawn");

      // The GLOBAL lock filename was used (no profile keying) and released.
      const locksDir = path.join(fixture.oracleHome, "locks");
      expect(fs.existsSync(path.join(locksDir, "claude-code-subscription.lock"))).toBe(false);
      expect(fs.existsSync(path.join(locksDir, "claude-code-subscription-arthur.lock"))).toBe(
        false,
      );

      const finalUpdate = sessionStoreMock.updateSession.mock.calls.at(-1)?.[1];
      expect(finalUpdate).toMatchObject({ status: "completed", mode: "claude-code" });
    } finally {
      teardownCaamFixture(fixture);
    }
  });

  test("graceful fallback: caam present but shallow-spawn --print-env pre-flight reports unhealthy runs direct-claude behavior", async () => {
    vi.mocked(fsPromises.mkdir).mockRestore();
    vi.mocked(fsPromises.writeFile).mockRestore();
    const fixture = setupCaamFixture();
    try {
      const claudeArgvPath = path.join(fixture.root, "claude-argv.json");
      const claudeMarkerPath = path.join(fixture.root, "claude-marker.txt");
      createFakeClaudeExecutable({
        binDir: fixture.binDir,
        argvPath: claudeArgvPath,
        stdinPath: path.join(fixture.root, "claude-stdin.txt"),
        markerPath: claudeMarkerPath,
      });
      const caamMarkerPath = path.join(fixture.root, "caam-spawned.txt");
      createFakeCaamExecutable({
        binDir: fixture.binDir,
        doctorInvocationArgvPath: path.join(fixture.root, "doctor-argv.json"),
        shallowSpawnArgvPath: path.join(fixture.root, "shallow-spawn-argv.json"),
        markerPath: caamMarkerPath,
        stdinPath: path.join(fixture.root, "caam-stdin.txt"),
        doctorHealthy: false,
      });

      await withExactEnv(
        {
          ...blockedClaudeCodeEnvDefaults,
          PATH: `${fixture.binDir}${path.delimiter}${process.env.PATH ?? ""}`,
          [ORACLE_CLAUDE_CODE_CAAM_PROFILE_ENV_VAR]: "unhealthy-profile",
        },
        async () => {
          await performSessionRun({
            sessionMeta: { ...baseSessionMeta, mode: "claude-code", model: "fable" },
            runOptions: { prompt: "Review with an unhealthy caam profile", model: "fable" },
            mode: "claude-code",
            cwd: fixture.repoDir,
            log,
            write,
            version: cliVersion,
            muteStdout: true,
          });
        },
      );

      // caam's shallow-spawn branch never ran; the direct claude fake did.
      expect(fs.existsSync(caamMarkerPath)).toBe(false);
      expect(fs.readFileSync(claudeMarkerPath, "utf8")).toBe("spawned\n");

      const locksDir = path.join(fixture.oracleHome, "locks");
      expect(fs.existsSync(path.join(locksDir, "claude-code-subscription.lock"))).toBe(false);
      expect(
        fs.existsSync(path.join(locksDir, "claude-code-subscription-unhealthy-profile.lock")),
      ).toBe(false);

      const finalUpdate = sessionStoreMock.updateSession.mock.calls.at(-1)?.[1];
      expect(finalUpdate).toMatchObject({ status: "completed", mode: "claude-code" });
    } finally {
      teardownCaamFixture(fixture);
    }
  });
});

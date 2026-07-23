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
import {
  performSessionRun,
  RemoteBrowserFailureSupersededError,
  persistRemoteBrowserFailureRecoveryState,
} from "../../src/cli/sessionRunner.ts";
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
import {
  RemoteRunFailedError,
  type RemoteBrowserPendingRecoveryClaim,
} from "../../src/remote/client.ts";
import { deriveModelOutputPath } from "../../src/cli/sessionRunner.ts";
import {
  PROMPT_DOM_IDENTITY_ALGORITHM,
  PROMPT_RECOVERY_PREVIEW_ALGORITHM,
} from "../../src/browser/promptDomMatch.ts";
import { peekClaudeCodeSingleFlightLocks } from "../../src/cli/sessionRunner.ts";
import { resumeBrowserSession } from "../../src/browser/reattach.ts";
import { setOracleHomeDirOverrideForTest } from "../../src/oracleHome.ts";
import { buildClaudeCodeCommand } from "../../src/claude-code/command.ts";
import { ORACLE_CLAUDE_CODE_CAAM_PROFILE_ENV_VAR } from "../../src/claude-code/caamCommand.ts";
import { ORACLE_CLAUDE_CODE_MAX_RATE_LIMIT_ROTATIONS_ENV_VAR } from "../../src/claude-code/caamRotation.ts";
import type { RemoteBrowserRecoveryCarrier } from "../../src/remote/client.ts";

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
const write = vi.fn((_chunk: string) => true);
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
  ORACLE_CLAUDE_CODE_CAAM_BASE: undefined,
  CAAM_SHALLOW_HOMES_DIR: undefined,
  SHALLOW_PROFILE: undefined,
  // Rotation is now opt-in. The dedicated rotation suite retains its
  // historical multi-attempt scenarios by opting in through this shared
  // test environment; resolver unit tests cover the production default 0.
  [ORACLE_CLAUDE_CODE_MAX_RATE_LIMIT_ROTATIONS_ENV_VAR]: "2",
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
    "const argv = process.argv.slice(2);",
    "const sessionFlagIndex = Math.max(argv.indexOf('--session-id'), argv.indexOf('--resume'));",
    "const sessionId = sessionFlagIndex >= 0 ? argv[sessionFlagIndex + 1] : undefined;",
    "let input = '';",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', (chunk) => { input += chunk; });",
    "process.stdin.on('end', () => {",
    "  fs.writeFileSync(markerPath, 'spawned\\n');",
    "  fs.writeFileSync(argvPath, JSON.stringify(argv, null, 2));",
    "  fs.writeFileSync(stdinPath, input);",
    "  for (const event of stdoutEvents) {",
    "    const emitted = sessionId && event.type === 'system' && event.subtype === 'init' ? { ...event, session_id: sessionId } : event;",
    "    process.stdout.write(`${JSON.stringify(emitted)}\\n`);",
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
// told apart by the presence of `--print-env` (the pre-flight and real spawn
// both receive the same `--base`; only the real spawn receives `--`).
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
    "const sessionFlagIndex = Math.max(argv.indexOf('--session-id'), argv.indexOf('--resume'));",
    "const sessionId = sessionFlagIndex >= 0 ? argv[sessionFlagIndex + 1] : undefined;",
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
    "      const emitted = sessionId && event.type === 'system' && event.subtype === 'init' ? { ...event, session_id: sessionId } : event;",
    "      process.stdout.write(`${JSON.stringify(emitted)}\\n`);",
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

// Extended fake `caam` for the rate-limit rotation suite
// (caam-ratelimit-rotation-design.md §4.1/§4.2): in addition to the
// `shallow-spawn <profile> --print-env --json` doctor pre-flight and the
// real `shallow-spawn <profile> --base <base> -- <claude> <args...>` exec
// that `createFakeCaamExecutable` above already fakes, this variant also
// intercepts `cooldown set claude/<profile> ...` and
// `robot next claude --strategy smart` — a real `caam` fake binary can
// branch on `process.argv` the same way. All invocations are appended as
// JSONL to files under `logsDir` so tests can assert both what got called
// and in what order, without pre-declaring one path per call (rotation
// calls the same subcommands a variable number of times).
function createFakeCaamExecutableWithRotation({
  binDir,
  logsDir,
  doctorUnhealthyProfiles = [],
  profileStdoutEvents = {},
  cooldownResponses = [],
  robotNextResponses,
}: {
  binDir: string;
  logsDir: string;
  doctorUnhealthyProfiles?: string[];
  profileStdoutEvents?: Record<string, unknown[]>;
  cooldownResponses?: Array<{ exitCode?: number; stdout?: string; stderr?: string }>;
  robotNextResponses: Array<{ json: unknown; exitCode?: number }>;
}): string {
  const executablePath = path.join(binDir, "caam");
  const initEvent = fakeClaudeCodeInitEvent();
  const defaultResultEvent = {
    type: "result",
    result: "Fake final answer from Claude Code",
    modelUsage: { "claude-fable-5": {} },
    total_cost_usd: 0,
  };
  const script = [
    "#!/usr/bin/env node",
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    `const logsDir = ${JSON.stringify(logsDir)};`,
    `const doctorUnhealthyProfiles = ${JSON.stringify(doctorUnhealthyProfiles)};`,
    `const profileStdoutEvents = ${JSON.stringify(profileStdoutEvents)};`,
    `const defaultStdoutEvents = ${JSON.stringify([initEvent, defaultResultEvent])};`,
    `const cooldownResponses = ${JSON.stringify(cooldownResponses)};`,
    `const robotNextResponses = ${JSON.stringify(robotNextResponses)};`,
    "fs.mkdirSync(logsDir, { recursive: true });",
    "function appendLog(name, obj) {",
    "  fs.appendFileSync(path.join(logsDir, name), JSON.stringify(obj) + '\\n');",
    "}",
    "function callIndex(name) {",
    "  const p = path.join(logsDir, name);",
    "  if (!fs.existsSync(p)) return 0;",
    "  return fs.readFileSync(p, 'utf8').split('\\n').filter(Boolean).length;",
    "}",
    "const argv = process.argv.slice(2);",
    "const sessionFlagIndex = Math.max(argv.indexOf('--session-id'), argv.indexOf('--resume'));",
    "const sessionId = sessionFlagIndex >= 0 ? argv[sessionFlagIndex + 1] : undefined;",
    "if (argv[0] === 'shallow-spawn' && argv.includes('--print-env') && argv.includes('--json')) {",
    "  const profile = argv[1];",
    "  appendLog('doctor-calls.jsonl', argv);",
    "  const healthy = !doctorUnhealthyProfiles.includes(profile);",
    "  const verdict = healthy",
    "    ? { success: true, home: '/fake/shallow-home/' + profile, shallow_profile: profile }",
    "    : { success: false, error: 'fake unhealthy profile ' + profile };",
    "  process.stdout.write(JSON.stringify(verdict) + '\\n');",
    "  process.exit(healthy ? 0 : 1);",
    "} else if (argv[0] === 'shallow-spawn') {",
    "  const profile = argv[1];",
    "  appendLog('shallow-spawn-calls.jsonl', argv);",
    "  fs.mkdirSync(path.join(logsDir, 'markers'), { recursive: true });",
    "  let input = '';",
    "  process.stdin.setEncoding('utf8');",
    "  process.stdin.on('data', (chunk) => { input += chunk; });",
    "  process.stdin.on('end', () => {",
    "    fs.writeFileSync(path.join(logsDir, 'markers', profile + '.marker'), input);",
    "    const events = profileStdoutEvents[profile] || defaultStdoutEvents;",
    "    for (const event of events) {",
    "      const emitted = sessionId && event.type === 'system' && event.subtype === 'init' ? { ...event, session_id: sessionId } : event;",
    "      process.stdout.write(JSON.stringify(emitted) + '\\n');",
    "    }",
    "    process.stderr.write('fake stderr\\n');",
    "  });",
    "} else if (argv[0] === 'cooldown' && argv[1] === 'set') {",
    "  const idx = callIndex('cooldown-calls.jsonl');",
    "  appendLog('cooldown-calls.jsonl', argv);",
    "  const resp = cooldownResponses[idx] || cooldownResponses[cooldownResponses.length - 1] || { exitCode: 0, stdout: 'Recorded cooldown\\n' };",
    "  if (resp.stdout) process.stdout.write(resp.stdout);",
    "  if (resp.stderr) process.stderr.write(resp.stderr);",
    "  process.exit(resp.exitCode || 0);",
    "} else if (argv[0] === 'robot' && argv[1] === 'next') {",
    "  const idx = callIndex('robot-next-calls.jsonl');",
    "  appendLog('robot-next-calls.jsonl', argv);",
    "  const resp = robotNextResponses[idx] || robotNextResponses[robotNextResponses.length - 1];",
    "  process.stdout.write(JSON.stringify(resp.json) + '\\n');",
    "  const exitCode = resp.exitCode !== undefined ? resp.exitCode : (resp.json && resp.json.success === false ? 1 : 0);",
    "  process.exit(exitCode);",
    "} else {",
    "  process.stderr.write('unexpected caam invocation: ' + argv.join(' ') + '\\n');",
    "  process.exit(1);",
    "}",
    "",
  ].join("\n");
  fs.writeFileSync(executablePath, script, { mode: 0o700 });
  return executablePath;
}

function readJsonlLog(logsDir: string, name: string): unknown[] {
  const filePath = path.join(logsDir, name);
  if (!fs.existsSync(filePath)) {
    return [];
  }
  return fs
    .readFileSync(filePath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown);
}

// A genuine CLI-reported error result (oracle-router-n0t): real rate-limit
// / challenge signals carry the CLI's own explicit error markers
// (`is_error: true`, a non-"success" `subtype`), which is exactly what the
// narrowed `findClaudeCodeRateLimitOrChallengeSignal` scan surface now
// requires before it will treat matched vocabulary as authoritative. This
// is deliberately NOT a plain successful result — see
// `benignSuccessResultEvent` below for that shape.
function rateLimitResultEvent(text: string): Record<string, unknown> {
  return {
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    result: text,
    modelUsage: { "claude-fable-5": {} },
    total_cost_usd: 0,
  };
}

// A benign, SUCCESSFUL result event (oracle-router-n0t finding #2): the
// model's own final-answer text may contain rate-limit/auth vocabulary as
// ordinary content (the task is *about* rate limiting or auth) without the
// run itself having failed. `is_error` is false and `subtype` is
// `"success"`, so this must never be treated as a rate-limit/challenge
// signal no matter what words `text` contains.
function benignSuccessResultEvent(text: string): Record<string, unknown> {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    result: text,
    modelUsage: { "claude-fable-5": {} },
    total_cost_usd: 0,
  };
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
  vi.mocked(resumeBrowserSession).mockReset();
  vi.mocked(runBrowserSessionExecution).mockReset();
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
  test("rejects a pending recovery authority from a different authenticated route before mutation", async () => {
    const updateSession = vi.fn();
    const writePendingClaim = vi.fn();
    const pendingRecoveryClaim: RemoteBrowserPendingRecoveryClaim = {
      claimKey: "A".repeat(43),
      originRunId: "other-run",
      accountId: "acct1",
      originLaneId: "acct1-9473",
      promptCandidates: [
        {
          promptPreview: "original prompt",
          promptPreviewSha256: "a".repeat(64),
        },
      ],
    };

    await expect(
      persistRemoteBrowserFailureRecoveryState(
        {
          sessionId: baseSessionMeta.id,
          browser: { config: { chromePath: null } },
          failedRoute: {
            runId: "remote-run-1",
            accountId: "acct1",
            laneId: "acct1-9473",
            terminalDoneOk: false,
            provenance: null,
          },
          pendingRecoveryClaim,
        },
        { updateSession, writePendingClaim },
      ),
    ).rejects.toThrow(/does not match.*failed-run route/i);
    expect(updateSession).not.toHaveBeenCalled();
    expect(writePendingClaim).not.toHaveBeenCalled();
  });

  test("persists the failed remote marker before sidecar write and stays fail-closed across an interrupted coordinate commit", async () => {
    const events: string[] = [];
    let current: SessionMetadata = {
      ...baseSessionMeta,
      mode: "browser",
      browser: { config: { chromePath: null } },
    };
    let updateCount = 0;
    const updateSession = vi.fn(
      async (
        _sessionId: string,
        updates:
          | Partial<SessionMetadata>
          | ((metadata: SessionMetadata) => Partial<SessionMetadata>),
      ) => {
        updateCount += 1;
        events.push(updateCount === 1 ? "failed-route-marker" : "public-coordinate-cas");
        if (updateCount === 2) {
          expect(current.browser?.remoteRun).toMatchObject({
            runId: "remote-run-1",
            terminalDoneOk: false,
          });
          throw new Error("simulated interruption after sidecar rename");
        }
        const patch = typeof updates === "function" ? updates(current) : updates;
        current = { ...current, ...patch };
        return current;
      },
    );
    const recoveryCarrier: RemoteBrowserRecoveryCarrier = {
      accountId: "acct1",
      laneId: "acct1-9473",
      promptPreview: "original prompt",
      promptDomSha256: "d".repeat(64),
      recovery: {
        category: "browser-automation",
        stage: "capture-binding",
        originRunId: "remote-run-1",
        expiresAt: "2026-07-23T00:00:00.000Z",
        capability: `v2.${"a".repeat(43)}`,
        promptPreviewAlgorithm: PROMPT_RECOVERY_PREVIEW_ALGORITHM,
        promptPreviewSha256: "a".repeat(64),
        promptDomIdentityAlgorithm: PROMPT_DOM_IDENTITY_ALGORITHM,
        promptDomSha256: "d".repeat(64),
        runtime: {
          tabUrl: "https://chatgpt.com/c/remote-conversation",
          conversationId: "remote-conversation",
          promptSubmitted: true,
        },
      },
    };
    const writeSecret = vi.fn(async () => {
      events.push("private-sidecar");
    });

    await expect(
      persistRemoteBrowserFailureRecoveryState(
        {
          sessionId: current.id,
          browser: current.browser,
          failedRoute: {
            runId: "remote-run-1",
            accountId: "acct1",
            laneId: "acct1-9473",
            terminalDoneOk: false,
            provenance: null,
          },
          recoveryCarrier,
        },
        { updateSession, writeSecret },
      ),
    ).rejects.toThrow(/simulated interruption/);

    expect(events).toEqual(["failed-route-marker", "private-sidecar", "public-coordinate-cas"]);
    expect(current.browser?.remoteRun).toMatchObject({
      runId: "remote-run-1",
      accountId: "acct1",
      terminalDoneOk: false,
    });
    expect(current.browser?.remoteRecovery).toBeUndefined();
  });

  test("remote recovery coordinate CAS uses the final updater retry verdict", async () => {
    let current: SessionMetadata = {
      ...baseSessionMeta,
      mode: "browser",
      browser: { config: { chromePath: null } },
    };
    let updateCount = 0;
    const updateSession = vi.fn(
      async (
        _sessionId: string,
        updates:
          | Partial<SessionMetadata>
          | ((metadata: SessionMetadata) => Partial<SessionMetadata>),
      ) => {
        updateCount += 1;
        if (typeof updates !== "function") throw new Error("expected updater");
        if (updateCount === 1) {
          current = { ...current, ...updates(current) };
          return current;
        }
        // First invocation sees the expected generation, then an optimistic
        // retry sees a newer failed route. Only the latter verdict may win.
        updates(current);
        current = {
          ...current,
          browser: {
            ...current.browser,
            remoteRun: {
              runId: "remote-run-2",
              accountId: "acct2",
              laneId: "acct2-9473",
              terminalDoneOk: false,
              provenance: null,
            },
          },
        };
        current = { ...current, ...updates(current) };
        return current;
      },
    );
    const deleteSecret = vi.fn(async () => true);
    const carrier = {
      accountId: "acct1",
      laneId: "acct1-9473",
      promptPreview: "original prompt",
      promptDomSha256: "d".repeat(64),
      recovery: {
        category: "browser-automation",
        stage: "capture-binding",
        originRunId: "remote-run-1",
        expiresAt: "2026-07-23T00:00:00.000Z",
        capability: `v2.${"a".repeat(43)}`,
        promptPreviewAlgorithm: PROMPT_RECOVERY_PREVIEW_ALGORITHM,
        promptPreviewSha256: "a".repeat(64),
        promptDomIdentityAlgorithm: PROMPT_DOM_IDENTITY_ALGORITHM,
        promptDomSha256: "d".repeat(64),
        runtime: {
          tabUrl: "https://chatgpt.com/c/remote-conversation",
          conversationId: "remote-conversation",
          promptSubmitted: true,
        },
      },
    } satisfies RemoteBrowserRecoveryCarrier;

    await expect(
      persistRemoteBrowserFailureRecoveryState(
        {
          sessionId: current.id,
          browser: current.browser,
          failedRoute: {
            runId: "remote-run-1",
            accountId: "acct1",
            laneId: "acct1-9473",
            terminalDoneOk: false,
            provenance: null,
          },
          recoveryCarrier: carrier,
        },
        { updateSession, writeSecret: vi.fn(async () => undefined), deleteSecret },
      ),
    ).rejects.toBeInstanceOf(RemoteBrowserFailureSupersededError);

    expect(current.browser?.remoteRun?.runId).toBe("remote-run-2");
    expect(current.browser?.remoteRecovery).toBeUndefined();
    expect(deleteSecret).toHaveBeenCalledWith(current.id, "remote-run-1");
  });

  test.each(["completed winner", "active completion claim"])(
    "stale failed-route publication cannot downgrade a %s",
    async (winnerKind) => {
      const completed = winnerKind === "completed winner";
      const winningRoute = {
        runId: "winning-run",
        accountId: "acct2",
        laneId: "acct2-9473",
        terminalDoneOk: completed as true | false,
        provenance: null,
      } as NonNullable<NonNullable<SessionMetadata["browser"]>["remoteRun"]>;
      const current: SessionMetadata = {
        ...baseSessionMeta,
        status: completed ? "completed" : "error",
        mode: "browser",
        browser: {
          remoteRun: winningRoute,
          ...(completed
            ? {}
            : {
                remoteRecovery: {
                  schema: "remote-browser-recovery-public.v1" as const,
                  stage: "capture-binding" as const,
                  originRunId: "winning-run",
                  expiresAt: "2026-07-23T00:00:00.000Z",
                  accountId: "acct2",
                  laneId: "acct2-9473",
                  runtime: {
                    tabUrl: "https://chatgpt.com/c/winning-run",
                    conversationId: "winning-run",
                    promptSubmitted: true as const,
                  },
                },
                remoteRecoveryCompletionClaim: {
                  schema: "remote-browser-recovery-completion-claim.v1" as const,
                  originRunId: "winning-run",
                  claimId: "winning-claim",
                  claimedAt: "2026-07-22T00:00:00.000Z",
                  ownerPid: process.pid,
                },
              }),
        },
      };
      const updateSession = vi.fn(
        async (
          _sessionId: string,
          updater: (metadata: SessionMetadata) => Partial<SessionMetadata>,
        ) => ({ ...current, ...updater(current) }),
      );
      const writeSecret = vi.fn(async () => undefined);

      await expect(
        persistRemoteBrowserFailureRecoveryState(
          {
            sessionId: current.id,
            browser: { config: { chromePath: null } },
            failedRoute: {
              runId: "stale-run",
              accountId: "acct1",
              laneId: "acct1-9473",
              terminalDoneOk: false,
              provenance: null,
            },
          },
          { updateSession, writeSecret },
        ),
      ).rejects.toBeInstanceOf(RemoteBrowserFailureSupersededError);

      expect(current.status).toBe(completed ? "completed" : "error");
      expect(current.browser?.remoteRun?.runId).toBe("winning-run");
      expect(writeSecret).not.toHaveBeenCalled();
      expect(sessionStoreMock.updateModelRun).not.toHaveBeenCalled();
      expect(sessionStoreMock.createLogWriter).not.toHaveBeenCalled();
    },
  );

  test.each(["partial metadata commit", "cleanup failure", "output failure"])(
    "remote recovery stays completed after a %s and still attempts capability cleanup",
    async (failureMode) => {
      const originRunId = "remote-origin-1";
      const completionClaim = {
        schema: "remote-browser-recovery-completion-claim.v1" as const,
        originRunId,
        claimId: "recovery-claim-1",
        claimedAt: new Date().toISOString(),
        ownerPid: process.pid,
      };
      let current: SessionMetadata = {
        ...baseSessionMeta,
        status: "error",
        mode: "browser",
        model: "gpt-5.2-pro",
        browser: {
          config: { chromePath: null },
          runtime: {
            tabUrl: `https://chatgpt.com/c/${originRunId}`,
            conversationId: originRunId,
            promptSubmitted: true,
          },
          remoteRun: {
            runId: originRunId,
            accountId: "acct1",
            laneId: "acct1-9473",
            terminalDoneOk: false,
            provenance: null,
          },
          remoteRecovery: {
            schema: "remote-browser-recovery-public.v1",
            stage: "capture-binding",
            originRunId,
            expiresAt: "2026-07-23T00:00:00.000Z",
            accountId: "acct1",
            laneId: "acct1-9473",
            runtime: {
              tabUrl: `https://chatgpt.com/c/${originRunId}`,
              conversationId: originRunId,
              promptSubmitted: true,
            },
          },
        },
      };
      let injectedPartialCommitFailure = false;
      sessionStoreMock.updateSession.mockImplementation(
        async (
          _sessionId: string,
          updates:
            | Partial<SessionMetadata>
            | ((metadata: SessionMetadata) => Partial<SessionMetadata>),
        ) => {
          const patch = typeof updates === "function" ? updates(current) : updates;
          current = { ...current, ...patch };
          if (
            failureMode === "partial metadata commit" &&
            current.status === "completed" &&
            !injectedPartialCommitFailure
          ) {
            injectedPartialCommitFailure = true;
            throw new Error("normalized model file write failed after meta rename");
          }
          return current;
        },
      );
      sessionStoreMock.readSession.mockImplementation(async () => current);
      sessionStoreMock.updateModelRun.mockImplementation(
        async (_sessionId: string, _model: string, updates: { status?: string }) => {
          if (updates.status === "completed") {
            throw new Error("redundant completed model update must not run");
          }
          return {};
        },
      );
      const claim = vi.fn(async () => {
        if (!current.browser) throw new Error("missing browser state");
        current = {
          ...current,
          browser: { ...current.browser, remoteRecoveryCompletionClaim: completionClaim },
        };
        return completionClaim;
      });
      const recoverStored = vi.fn(async () => ({
        answerText: "durable recovered answer",
        answerMarkdown: "durable recovered answer",
        tookMs: 10,
        answerTokens: 3,
        answerChars: 24,
        tabUrl: `https://chatgpt.com/c/${originRunId}`,
        conversationId: originRunId,
        remoteRun: {
          runId: "recovery-run-1",
          accountId: "acct1",
          laneId: "acct1-9473",
          terminalDoneOk: true as const,
          provenance: null,
        },
      }));
      const persistArtifacts = vi.fn(async () => [
        {
          kind: "transcript" as const,
          path: "/tmp/.oracle/sessions/sess-1/artifacts/transcript-recovered.md",
        },
      ]);
      const deleteSecret = vi.fn(async () => {
        if (failureMode === "cleanup failure") throw new Error("sidecar unlink failed");
        return true;
      });
      if (failureMode === "output failure") {
        vi.mocked(fsPromises.writeFile).mockRejectedValueOnce(new Error("output disk full"));
      }

      await expect(
        performSessionRun({
          sessionMeta: current,
          runOptions: {
            ...baseRunOptions,
            ...(failureMode === "output failure"
              ? { writeOutputPath: "/tmp/recovered-output.md" }
              : {}),
          },
          mode: "browser",
          browserConfig: { chromePath: null },
          cwd: "/tmp",
          log,
          write,
          version: cliVersion,
          remoteRecoveryDeps: {
            claim,
            recoverStored,
            release: vi.fn(async () => true),
            deleteSecret,
            persistArtifacts,
          },
        }),
      ).resolves.toBeUndefined();

      expect(current).toMatchObject({
        status: "completed",
        browser: {
          remoteRun: { runId: "recovery-run-1", terminalDoneOk: true },
        },
        artifacts: [
          {
            kind: "transcript",
            path: "/tmp/.oracle/sessions/sess-1/artifacts/transcript-recovered.md",
          },
        ],
      });
      expect(current.browser?.remoteRecovery).toBeUndefined();
      expect(current.browser?.remoteRecoveryCompletionClaim).toBeUndefined();
      expect(deleteSecret).toHaveBeenCalledWith(current.id, originRunId);
      expect(sessionStoreMock.updateModelRun).not.toHaveBeenCalledWith(
        current.id,
        expect.any(String),
        expect.objectContaining({ status: "completed" }),
      );
      expect(log).not.toHaveBeenCalledWith(expect.stringMatching(/^ERROR:/));
    },
  );

  test("a future session run promotes a pending claim before dispatching GET-only recovery", async () => {
    const originRunId = "remote-origin-pending";
    const coordinate = {
      schema: "remote-browser-recovery-public.v1" as const,
      stage: "capture-binding" as const,
      originRunId,
      expiresAt: "2099-07-23T00:00:00.000Z",
      accountId: "acct1",
      laneId: "acct1-9473",
      runtime: {
        tabUrl: `https://chatgpt.com/c/${originRunId}`,
        conversationId: originRunId,
        promptSubmitted: true as const,
      },
    };
    const completionClaim = {
      schema: "remote-browser-recovery-completion-claim.v1" as const,
      originRunId,
      claimId: "pending-promotion-owner",
      claimedAt: new Date().toISOString(),
      ownerPid: process.pid,
    };
    let current: SessionMetadata = {
      ...baseSessionMeta,
      status: "error",
      mode: "browser",
      browser: {
        config: { chromePath: null },
        remoteRun: {
          runId: originRunId,
          accountId: "acct1",
          laneId: "acct1-9473",
          terminalDoneOk: false,
          provenance: null,
        },
      },
    };
    sessionStoreMock.updateSession.mockImplementation(
      async (
        _sessionId: string,
        updates:
          | Partial<SessionMetadata>
          | ((metadata: SessionMetadata) => Partial<SessionMetadata>),
      ) => {
        const patch = typeof updates === "function" ? updates(current) : updates;
        current = { ...current, ...patch };
        return current;
      },
    );
    sessionStoreMock.readSession.mockImplementation(async () => current);
    const promotePending = vi.fn(async () => {
      current = {
        ...current,
        browser: { ...current.browser, remoteRecovery: coordinate },
      };
      return current;
    });
    const claim = vi.fn(async () => {
      current = {
        ...current,
        browser: { ...current.browser, remoteRecoveryCompletionClaim: completionClaim },
      };
      return completionClaim;
    });
    const recoverStored = vi.fn(async () => ({
      answerText: "promoted recovery answer",
      answerMarkdown: "promoted recovery answer",
      tookMs: 10,
      answerTokens: 3,
      answerChars: 24,
      tabUrl: coordinate.runtime.tabUrl,
      conversationId: originRunId,
      remoteRun: {
        runId: "recovery-run-after-promotion",
        accountId: "acct1",
        laneId: "acct1-9473",
        terminalDoneOk: true as const,
        provenance: null,
      },
    }));

    await expect(
      performSessionRun({
        sessionMeta: current,
        runOptions: baseRunOptions,
        mode: "browser",
        browserConfig: { chromePath: null },
        cwd: "/tmp",
        log,
        write,
        version: cliVersion,
        remoteRecoveryDeps: {
          promotePending,
          claim,
          recoverStored,
          release: vi.fn(async () => true),
          deleteSecret: vi.fn(async () => true),
          persistArtifacts: vi.fn(async () => [
            { kind: "transcript" as const, path: "/tmp/promoted-recovery-transcript.md" },
          ]),
        },
      }),
    ).resolves.toBeUndefined();

    expect(promotePending).toHaveBeenCalledTimes(1);
    expect(claim).toHaveBeenCalledTimes(1);
    expect(recoverStored).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runBrowserSessionExecution)).not.toHaveBeenCalled();
    expect(current).toMatchObject({
      status: "completed",
      browser: {
        remoteRun: { runId: "recovery-run-after-promotion", terminalDoneOk: true },
      },
    });
  });

  test("second-CAS loss to a same-origin completion claim preserves its retry sidecar", async () => {
    let current: SessionMetadata = {
      ...baseSessionMeta,
      status: "running",
      mode: "browser",
      browser: { config: { chromePath: null } },
    };
    let updateCount = 0;
    const updateSession = vi.fn(
      async (
        _sessionId: string,
        updater: (metadata: SessionMetadata) => Partial<SessionMetadata>,
      ) => {
        updateCount += 1;
        if (updateCount === 2) {
          current = {
            ...current,
            browser: {
              ...current.browser,
              remoteRecovery: {
                schema: "remote-browser-recovery-public.v1",
                stage: "capture-binding",
                originRunId: "remote-run-1",
                expiresAt: "2026-07-23T00:00:00.000Z",
                accountId: "acct1",
                laneId: "acct1-9473",
                runtime: {
                  tabUrl: "https://chatgpt.com/c/remote-run-1",
                  conversationId: "remote-run-1",
                  promptSubmitted: true,
                },
              },
              remoteRecoveryCompletionClaim: {
                schema: "remote-browser-recovery-completion-claim.v1",
                originRunId: "remote-run-1",
                claimId: "winner-claim",
                claimedAt: "2026-07-22T00:00:00.000Z",
                ownerPid: process.pid,
              },
            },
          };
        }
        current = { ...current, ...updater(current) };
        return current;
      },
    );
    const deleteSecret = vi.fn(async () => true);
    const carrier = {
      accountId: "acct1",
      laneId: "acct1-9473",
      promptPreview: "original prompt",
      promptDomSha256: "d".repeat(64),
      recovery: {
        category: "browser-automation",
        stage: "capture-binding",
        originRunId: "remote-run-1",
        expiresAt: "2026-07-23T00:00:00.000Z",
        capability: `v2.${"a".repeat(43)}`,
        promptPreviewAlgorithm: PROMPT_RECOVERY_PREVIEW_ALGORITHM,
        promptPreviewSha256: "a".repeat(64),
        promptDomIdentityAlgorithm: PROMPT_DOM_IDENTITY_ALGORITHM,
        promptDomSha256: "d".repeat(64),
        runtime: {
          tabUrl: "https://chatgpt.com/c/remote-run-1",
          conversationId: "remote-run-1",
          promptSubmitted: true,
        },
      },
    } satisfies RemoteBrowserRecoveryCarrier;

    await expect(
      persistRemoteBrowserFailureRecoveryState(
        {
          sessionId: current.id,
          browser: current.browser,
          failedRoute: {
            runId: "remote-run-1",
            accountId: "acct1",
            laneId: "acct1-9473",
            terminalDoneOk: false,
            provenance: null,
          },
          recoveryCarrier: carrier,
        },
        { updateSession, writeSecret: vi.fn(async () => undefined), deleteSecret },
      ),
    ).rejects.toBeInstanceOf(RemoteBrowserFailureSupersededError);

    expect(current.browser?.remoteRecoveryCompletionClaim?.claimId).toBe("winner-claim");
    expect(current.browser?.remoteRecovery?.originRunId).toBe("remote-run-1");
    expect(deleteSecret).not.toHaveBeenCalled();
  });

  test.each(["completed winner", "active completion claim"])(
    "performSessionRun leaves a %s entirely untouched when it wins after failed-route publication",
    async (winnerKind) => {
      const failedRoute = {
        runId: "remote-run-1",
        accountId: "acct1",
        laneId: "acct1-9473",
        terminalDoneOk: false as const,
        provenance: null,
      };
      const coordinate = {
        schema: "remote-browser-recovery-public.v1" as const,
        stage: "capture-binding" as const,
        originRunId: "remote-run-1",
        expiresAt: "2026-07-23T00:00:00.000Z",
        accountId: "acct1",
        laneId: "acct1-9473",
        runtime: {
          tabUrl: "https://chatgpt.com/c/remote-run-1",
          conversationId: "remote-run-1",
          promptSubmitted: true as const,
        },
      };
      let current: SessionMetadata = {
        ...baseSessionMeta,
        mode: "browser",
        model: "gpt-5.2-pro",
        browser: { config: { chromePath: null } },
      };
      let winnerInjected = false;
      sessionStoreMock.updateSession.mockImplementation(
        async (
          _sessionId: string,
          updates:
            | Partial<SessionMetadata>
            | ((metadata: SessionMetadata) => Partial<SessionMetadata>),
        ) => {
          if (typeof updates === "function" && current.browser?.remoteRecovery && !winnerInjected) {
            winnerInjected = true;
            current =
              winnerKind === "completed winner"
                ? {
                    ...current,
                    status: "completed",
                    browser: {
                      ...current.browser,
                      remoteRun: {
                        runId: "winning-run",
                        accountId: "acct2",
                        laneId: "acct2-9473",
                        terminalDoneOk: true,
                        provenance: null,
                      },
                      remoteRecovery: undefined,
                    },
                  }
                : {
                    ...current,
                    browser: {
                      ...current.browser,
                      remoteRecoveryCompletionClaim: {
                        schema: "remote-browser-recovery-completion-claim.v1",
                        originRunId: "remote-run-1",
                        claimId: "winning-claim",
                        claimedAt: new Date().toISOString(),
                        ownerPid: process.pid,
                      },
                    },
                  };
          }
          const patch = typeof updates === "function" ? updates(current) : updates;
          current = { ...current, ...patch };
          return current;
        },
      );
      vi.mocked(runBrowserSessionExecution).mockRejectedValueOnce(
        new Error("stale remote failure"),
      );
      const persistState = vi.fn(async () => {
        current = {
          ...current,
          browser: {
            ...current.browser,
            remoteRun: failedRoute,
            remoteRecovery: coordinate,
          },
        };
        return current.browser;
      });

      await expect(
        performSessionRun({
          sessionMeta: current,
          runOptions: baseRunOptions,
          mode: "browser",
          browserConfig: { chromePath: null },
          cwd: "/tmp",
          log,
          write,
          version: cliVersion,
          remoteFailureDeps: {
            getFailedRoute: () => failedRoute,
            getRecovery: () => null,
            persistState,
          },
        }),
      ).resolves.toBeUndefined();

      expect(winnerInjected).toBe(true);
      expect(current.status).toBe(winnerKind === "completed winner" ? "completed" : "running");
      expect(current.browser?.remoteRun?.runId).toBe(
        winnerKind === "completed winner" ? "winning-run" : "remote-run-1",
      );
      expect(log).not.toHaveBeenCalledWith(expect.stringMatching(/^ERROR:/));
      expect(sessionStoreMock.updateModelRun).not.toHaveBeenCalledWith(
        current.id,
        expect.any(String),
        expect.objectContaining({ status: "error" }),
      );
      expect(sessionStoreMock.createLogWriter).not.toHaveBeenCalled();
    },
  );

  test("persists remote retryability taxonomy for restart policy", async () => {
    let current: SessionMetadata = {
      ...baseSessionMeta,
      status: "pending",
      mode: "browser",
      model: "gpt-5.6-sol",
      browser: { config: { chromePath: null } },
    };
    sessionStoreMock.updateSession.mockImplementation(
      async (
        _sessionId: string,
        updates:
          | Partial<SessionMetadata>
          | ((metadata: SessionMetadata) => Partial<SessionMetadata>),
      ) => {
        const patch = typeof updates === "function" ? updates(current) : updates;
        current = { ...current, ...patch };
        return current;
      },
    );
    sessionStoreMock.updateModelRun.mockResolvedValue({});
    vi.mocked(runBrowserSessionExecution).mockRejectedValueOnce(
      new RemoteRunFailedError("worker disconnected before submit", {
        errorClass: "transport_interrupted_before_submit",
        retryable: true,
      }),
    );

    await expect(
      performSessionRun({
        sessionMeta: current,
        runOptions: { ...baseRunOptions, model: "gpt-5.6-sol" },
        mode: "browser",
        browserConfig: { chromePath: null },
        cwd: "/tmp",
        log,
        write,
        version: cliVersion,
      }),
    ).rejects.toBeInstanceOf(RemoteRunFailedError);

    expect(current.error).toEqual({
      category: "browser-automation",
      message: "worker disconnected before submit",
      details: {
        stage: "remote-run",
        errorClass: "transport_interrupted_before_submit",
        retryable: true,
      },
    });
  });

  test("does not publish a single-turn recovery capability for a failed multi-turn remote run", async () => {
    let current: SessionMetadata = {
      ...baseSessionMeta,
      options: { browserFollowUps: ["challenge the first answer"] },
      status: "pending",
      mode: "browser",
      model: "gpt-5.6-sol",
      browser: { config: { chromePath: null } },
    };
    sessionStoreMock.updateSession.mockImplementation(
      async (
        _sessionId: string,
        updates:
          | Partial<SessionMetadata>
          | ((metadata: SessionMetadata) => Partial<SessionMetadata>),
      ) => {
        const patch = typeof updates === "function" ? updates(current) : updates;
        current = { ...current, ...patch };
        return current;
      },
    );
    const failedRoute = {
      runId: "multi-turn-origin",
      accountId: "acct2",
      laneId: "acct2-9474",
      terminalDoneOk: false as const,
      provenance: null,
    };
    const recoveryCarrier: RemoteBrowserRecoveryCarrier = {
      accountId: "acct2",
      laneId: "acct2-9474",
      promptPreview: "challenge the first answer",
      promptDomSha256: "d".repeat(64),
      recovery: {
        category: "browser-automation",
        stage: "capture-binding",
        originRunId: "multi-turn-origin",
        expiresAt: "2026-07-23T00:00:00.000Z",
        capability: `v2.${"a".repeat(43)}`,
        promptPreviewAlgorithm: PROMPT_RECOVERY_PREVIEW_ALGORITHM,
        promptPreviewSha256: "a".repeat(64),
        promptDomIdentityAlgorithm: PROMPT_DOM_IDENTITY_ALGORITHM,
        promptDomSha256: "d".repeat(64),
        runtime: {
          tabUrl: "https://chatgpt.com/c/multi-turn-origin",
          conversationId: "multi-turn-origin",
          promptSubmitted: true,
        },
      },
    };
    vi.mocked(runBrowserSessionExecution).mockRejectedValueOnce(
      new Error("remote multi-turn transport failed"),
    );
    const persistState = vi.fn(async ({ browser, failedRoute: route }) => {
      const persistedBrowser = { ...browser, remoteRun: route };
      current = { ...current, browser: persistedBrowser };
      return persistedBrowser;
    });

    await expect(
      performSessionRun({
        sessionMeta: current,
        runOptions: {
          ...baseRunOptions,
          model: "gpt-5.6-sol",
          browserFollowUps: ["challenge the first answer"],
        },
        mode: "browser",
        browserConfig: { chromePath: null },
        cwd: "/tmp",
        log,
        write,
        version: cliVersion,
        remoteFailureDeps: {
          getFailedRoute: () => failedRoute,
          getRecovery: () => recoveryCarrier,
          persistState,
        },
      }),
    ).rejects.toThrow("remote multi-turn transport failed");

    expect(persistState).toHaveBeenCalledWith(
      expect.objectContaining({
        failedRoute,
        recoveryCarrier: null,
      }),
    );
    expect(current.browser?.remoteRun).toMatchObject(failedRoute);
    expect(current.browser?.remoteRecovery).toBeUndefined();
  });

  test("default reviewed Fable runner refuses an absent CAAM profile before executable resolution", async () => {
    let current: SessionMetadata = {
      ...baseSessionMeta,
      mode: "claude-code",
      model: "fable",
    };
    sessionStoreMock.updateSession.mockImplementation(
      async (
        _sessionId: string,
        updates:
          | Partial<SessionMetadata>
          | ((metadata: SessionMetadata) => Partial<SessionMetadata>),
      ) => {
        const patch = typeof updates === "function" ? updates(current) : updates;
        current = { ...current, ...patch };
        return current;
      },
    );
    sessionStoreMock.updateModelRun.mockResolvedValue({});

    await expect(
      withExactEnv(
        {
          ...blockedClaudeCodeEnvDefaults,
          [ORACLE_CLAUDE_CODE_CAAM_PROFILE_ENV_VAR]: undefined,
          ORACLE_CLAUDE_CODE_EXECUTABLE: "/definitely/not/a/claude/executable",
        },
        () =>
          performSessionRun({
            sessionMeta: current,
            runOptions: {
              prompt: "Review this change",
              model: "fable",
              lane: "fable-local",
              laneInferenceSource: "lane",
              claudeCode: fableClaudeCodePolicy,
            },
            mode: "claude-code",
            cwd: "/tmp",
            log,
            write,
            version: cliVersion,
          }),
      ),
    ).rejects.toThrow(/requires a CAAM subscription profile/i);

    expect(current).toMatchObject({
      status: "error",
      error: {
        category: "prompt-validation",
        details: { blockedReason: "caam_profile_required" },
      },
    });
  });

  test("legacy normalized fable-local route still spawns an unpinned guarded Claude process", async () => {
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
    createFakeClaudeExecutable({
      binDir,
      argvPath,
      stdinPath,
      markerPath,
      stdoutEvents: [
        fakeClaudeCodeInitEvent(),
        {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "text_delta", text: "INTERMEDIATE DRAFT" },
          },
        },
        {
          type: "assistant",
          message: { content: [{ type: "text", text: "INTERMEDIATE DRAFT" }] },
        },
        {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "text_delta", text: "P" },
          },
        },
        {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "text_delta", text: "ONG" },
          },
        },
        {
          type: "assistant",
          message: { content: [{ type: "text", text: "PONG" }] },
        },
        {
          type: "result",
          subtype: "success",
          result: "PONG",
          modelUsage: { "claude-fable-5": {} },
          total_cost_usd: 0,
        },
      ],
    });
    sessionStoreMock.sessionsDir.mockReturnValue(sessionsDir);
    sessionStoreMock.getPaths.mockResolvedValue({
      dir: sessionDir,
      metadata: path.join(sessionDir, "meta.json"),
      request: path.join(sessionDir, "request.json"),
      log: path.join(sessionDir, "output.log"),
    });
    setOracleHomeDirOverrideForTest(oracleHome);
    const stdoutWrite = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true as unknown as boolean);

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
              lane: "fable-local",
              laneInferenceSource: "legacy-engine-model",
              file: [contextPath],
            },
            mode: "claude-code",
            cwd: repoDir,
            log,
            write,
            version: cliVersion,
            muteStdout: false,
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
      expect(fs.readFileSync(path.join(artifactsDir, "claude-code-final.md"), "utf8")).toBe("PONG");
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
      expect(write.mock.calls.map((call) => call[0]).join("")).toBe("fake stderr\nPONG\n");
      expect(stdoutWrite.mock.calls.map((call) => call[0]).join("")).toBe("fake stderr\nPONG\n");
      expect(write.mock.calls.map((call) => call[0]).join("")).not.toContain("INTERMEDIATE DRAFT");
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
      stdoutWrite.mockRestore();
      setOracleHomeDirOverrideForTest(null);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("default claude-code runner fails closed on an unrecoverable verified Fable plan protocol", async () => {
    vi.mocked(fsPromises.mkdir).mockRestore();
    vi.mocked(fsPromises.writeFile).mockRestore();

    const root = fs.mkdtempSync(path.join(os.homedir(), ".oracle-claude-code-protocol-test-"));
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
    const exitEnvelope = `ExitPlanMode\n\n${JSON.stringify({ plan: "Summary only." })}`;
    createFakeClaudeExecutable({
      binDir,
      argvPath,
      stdinPath,
      markerPath,
      stdoutEvents: [
        fakeClaudeCodeInitEvent(),
        {
          type: "assistant",
          message: {
            content: [
              {
                type: "text",
                text: `Write\n\n${JSON.stringify({
                  file_path: "relative/.claude/plans/review.md",
                  content: "untrusted recovered answer",
                })}`,
              },
            ],
          },
        },
        {
          type: "assistant",
          message: { content: [{ type: "text", text: exitEnvelope }] },
        },
        {
          type: "result",
          subtype: "success",
          is_error: false,
          result: exitEnvelope,
          modelUsage: { "claude-fable-5": {} },
          total_cost_usd: 0,
        },
      ],
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
              runOptions: { prompt: "Review via fake executable", model: "fable" },
              mode: "claude-code",
              cwd: repoDir,
              log,
              write,
              version: cliVersion,
              muteStdout: true,
            }),
          ).rejects.toThrow(/unrecoverable plan-protocol episode/i);
        },
      );

      const artifactsDir = path.join(sessionDir, "artifacts");
      expect(
        fs.readFileSync(path.join(artifactsDir, "claude-code-events.normalized.ndjson"), "utf8"),
      ).toContain("ExitPlanMode");
      expect(fs.readFileSync(path.join(artifactsDir, "claude-code-final.md"), "utf8")).toBe("");
      expect(fs.readFileSync(path.join(artifactsDir, "claude-code-progress.md"), "utf8")).toContain(
        "unrecoverable plan-protocol episode",
      );
      const finalUpdate = sessionStoreMock.updateSession.mock.calls.at(-1)?.[1];
      expect(finalUpdate).toMatchObject({
        status: "error",
        mode: "claude-code",
        errorMessage: expect.stringContaining("unrecoverable plan-protocol episode"),
        artifacts: expect.arrayContaining([
          expect.objectContaining({ kind: "claude-code-events-normalized" }),
          expect.objectContaining({ kind: "claude-code-final" }),
        ]),
      });
      expect(write.mock.calls.map((call) => call[0]).join("")).not.toContain("ExitPlanMode");
      expect(write.mock.calls.map((call) => call[0]).join("")).not.toContain(
        "untrusted recovered answer",
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
            // Error-teaches (Axiom 6): names what failed (busy lock, which
            // session), and offers all three exact fixes — wait
            // automatically, inspect the running session, or remove a
            // confirmed-stale lock — not just a bare "busy" message.
          ).rejects.toThrow(
            /already running in session busy-session.*--wait-for-lock 5m.*oracle session busy-session --render.*rm "/s,
          );
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
    let interrupted = false;
    let interruptPoll: ReturnType<typeof setInterval> | null = null;
    let interruptFallback: ReturnType<typeof setTimeout> | null = null;
    const clearInterruptTimers = () => {
      if (interruptPoll) {
        clearInterval(interruptPoll);
        interruptPoll = null;
      }
      if (interruptFallback) {
        clearTimeout(interruptFallback);
        interruptFallback = null;
      }
    };
    const emitInterrupt = () => {
      if (interrupted) return;
      interrupted = true;
      clearInterruptTimers();
      process.emit("SIGINT");
    };
    interruptPoll = setInterval(() => {
      if (fs.existsSync(markerPath)) {
        emitInterrupt();
      }
    }, 10);
    interruptFallback = setTimeout(emitInterrupt, 1_000);

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
      clearInterruptTimers();
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
      // Simulate the duplicate visible layers emitted by Claude Code with
      // --include-partial-messages: deltas, assistant snapshot, and result.
      // Structured/muted callers must receive only finalAnswerText below.
      input.write("Final ");
      input.write("answer");
      input.write("Final answer");
      input.write("Final answer");
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
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith("Final answer");
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

  test("recovers submitted browser sessions by saved conversation URL instead of resubmitting", async () => {
    vi.mocked(resumeBrowserSession).mockResolvedValue({
      answerText: "Recovered answer",
      answerMarkdown: "## Recovered answer",
    });
    vi.mocked(ensureSessionArtifacts).mockResolvedValue([
      { kind: "transcript", path: "/tmp/recovered-transcript.md" },
    ]);
    const submittedSessionMeta: SessionMetadata = {
      ...baseSessionMeta,
      status: "running",
      mode: "browser",
      model: "gpt-5.5-pro",
      promptPreview: "Expensive submitted prompt",
      browser: {
        config: { manualLogin: true },
        submittedPromptPreview: "latest normalized submitted follow-up",
        submittedPromptDomSha256: "a".repeat(64),
        runtime: {
          chromePort: 9222,
          chromeHost: "127.0.0.1",
          chromeTargetId: "stale-target-id",
          tabUrl: "https://chatgpt.com/",
          promptSubmitted: true,
        },
        harvest: {
          targetId: "stale-target-id",
          url: "https://chatgpt.com/c/saved-conversation",
          conversationId: "saved-conversation",
          state: "completed",
        },
      },
    };

    await performSessionRun({
      sessionMeta: submittedSessionMeta,
      runOptions: baseRunOptions,
      mode: "browser",
      browserConfig: { manualLogin: true },
      cwd: "/tmp",
      log,
      write,
      version: cliVersion,
    });

    expect(vi.mocked(runBrowserSessionExecution)).not.toHaveBeenCalled();
    expect(vi.mocked(resumeBrowserSession)).toHaveBeenCalledTimes(1);
    const recoveryRuntime = vi.mocked(resumeBrowserSession).mock.calls[0]?.[0];
    expect(recoveryRuntime).toMatchObject({
      chromePort: 9222,
      chromeHost: "127.0.0.1",
      tabUrl: "https://chatgpt.com/c/saved-conversation",
      conversationId: "saved-conversation",
      promptSubmitted: true,
    });
    expect(recoveryRuntime?.chromeTargetId).toBeUndefined();
    expect(vi.mocked(resumeBrowserSession).mock.calls[0]?.[3]).toEqual({
      promptPreview: "latest normalized submitted follow-up",
      promptDomSha256: "a".repeat(64),
      requirePromptPreviewMatch: true,
    });
    expect(vi.mocked(ensureSessionArtifacts)).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: submittedSessionMeta.id,
        prompt: baseRunOptions.prompt,
        answerMarkdown: "## Recovered answer",
        conversationUrl: "https://chatgpt.com/c/saved-conversation",
      }),
    );
    const finalUpdateInput = sessionStoreMock.updateSession.mock.calls.at(-1)?.[1];
    const finalUpdate =
      typeof finalUpdateInput === "function"
        ? finalUpdateInput(submittedSessionMeta)
        : finalUpdateInput;
    expect(finalUpdate).toMatchObject({
      status: "completed",
      response: { status: "completed" },
      browser: {
        runtime: expect.objectContaining({
          tabUrl: "https://chatgpt.com/c/saved-conversation",
          promptSubmitted: true,
        }),
      },
      artifacts: [{ kind: "transcript", path: "/tmp/recovered-transcript.md" }],
    });
    const logLines = log.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logLines).toContain("attempting reattach instead of submitting again");
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
    const staleSessionMeta = {
      ...baseSessionMeta,
      browser: {
        config: { desiredModel: "Old Pro" },
        modelSelection: {
          requestedModel: "Old Pro",
          resolvedLabel: "Old Pro",
          strategy: "select" as const,
          status: "already-selected" as const,
          verified: true,
          source: "chatgpt-model-picker" as const,
          capturedAt: "2026-07-02T00:00:00.000Z",
        },
      },
    };

    await expect(
      performSessionRun({
        sessionMeta: staleSessionMeta,
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
    expect(finalUpdate?.browser?.runtime).toBeUndefined();
    expect(finalUpdate?.browser?.modelSelection).toEqual(staleSessionMeta.browser.modelSelection);
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

  test("preserves persisted runtime hints when browser automation fails without runtime details", async () => {
    const automationError = new BrowserAutomationError(
      "Prompt did not appear in conversation before timeout (send may have failed)",
      { stage: "submit-prompt", code: "prompt-commit-timeout" },
    );
    vi.mocked(runBrowserSessionExecution).mockImplementationOnce(async (_args, deps) => {
      // Simulate the runtime hint emitted right after the send click,
      // before commit verification fails.
      await (
        deps as {
          persistRuntimeHint?: (
            runtime: Record<string, unknown>,
            modelSelection?: Record<string, unknown>,
          ) => Promise<void>;
        }
      ).persistRuntimeHint?.(
        {
          chromePort: 9222,
          chromeHost: "127.0.0.1",
          tabUrl: "https://chatgpt.com/c/demo",
          promptSubmitted: true,
        },
        {
          requestedModel: "Pro",
          resolvedLabel: "Pro",
          strategy: "select",
          status: "already-selected",
          verified: true,
          source: "chatgpt-model-picker",
          capturedAt: "2026-07-03T00:00:00.000Z",
        },
      );
      throw automationError;
    });

    await expect(
      performSessionRun({
        sessionMeta: { ...baseSessionMeta },
        runOptions: baseRunOptions,
        mode: "browser",
        browserConfig: { chromePath: null },
        cwd: "/tmp",
        log,
        write,
        version: cliVersion,
      }),
    ).rejects.toThrow(/prompt did not appear/i);

    const finalUpdateInput = sessionStoreMock.updateSession.mock.calls.at(-1)?.[1];
    const finalUpdate =
      typeof finalUpdateInput === "function"
        ? finalUpdateInput({
            ...baseSessionMeta,
            browser: {
              config: { chromePath: null },
              runtime: {
                chromePort: 9222,
                chromeHost: "127.0.0.1",
                tabUrl: "https://chatgpt.com/c/demo",
                promptSubmitted: true,
              },
              modelSelection: {
                requestedModel: "Pro",
                resolvedLabel: "Pro",
                strategy: "select",
                status: "already-selected",
                verified: true,
                source: "chatgpt-model-picker",
                capturedAt: "2026-07-03T00:00:00.000Z",
              },
            },
          })
        : finalUpdateInput;
    expect(finalUpdate).toMatchObject({
      status: "error",
      browser: expect.objectContaining({
        config: expect.any(Object),
        runtime: expect.objectContaining({
          promptSubmitted: true,
          tabUrl: "https://chatgpt.com/c/demo",
        }),
        modelSelection: expect.objectContaining({ resolvedLabel: "Pro", verified: true }),
      }),
      error: expect.objectContaining({
        details: expect.objectContaining({ code: "prompt-commit-timeout" }),
      }),
    });
  });

  test("keeps session running when browser connection is lost", async () => {
    const automationError = new BrowserAutomationError(
      "Chrome DevTools client disconnected before oracle finished; the browser target appears still alive.",
      {
        stage: "connection-lost",
        recoverableDisconnect: true,
        disconnectCause: "cdp-client-disconnect",
        runtime: {
          chromePort: 9222,
          chromeHost: "127.0.0.1",
          tabUrl: "https://chatgpt.com/c/demo",
        },
      },
    );
    vi.mocked(runBrowserSessionExecution).mockImplementationOnce(async (_args, deps) => {
      await deps?.persistRuntimeHint?.(
        {
          chromePort: 9222,
          chromeHost: "127.0.0.1",
          tabUrl: "https://chatgpt.com/c/demo",
          promptSubmitted: true,
        },
        {
          requestedModel: "Pro",
          resolvedLabel: "Pro",
          strategy: "select",
          status: "already-selected",
          verified: true,
          source: "chatgpt-model-picker",
          capturedAt: "2026-07-03T00:00:00.000Z",
        },
      );
      throw automationError;
    });
    vi.mocked(resumeBrowserSession).mockRejectedValueOnce(new Error("target not ready"));

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

    expect(vi.mocked(resumeBrowserSession)).toHaveBeenCalledTimes(1);
    const finalUpdate = sessionStoreMock.updateSession.mock.calls.at(-1)?.[1];
    expect(finalUpdate).toMatchObject({
      status: "running",
      response: { status: "running", incompleteReason: "chrome-disconnected" },
      browser: expect.objectContaining({
        runtime: expect.objectContaining({ chromePort: 9222 }),
        modelSelection: expect.objectContaining({ resolvedLabel: "Pro", verified: true }),
      }),
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
    expect(logLines).toContain("Auto-reattach attempt 1");
  });

  test("skips auto-reattach when disconnect is classified non-recoverable", async () => {
    const automationError = new BrowserAutomationError(
      "Chrome window closed before oracle finished. Please keep it open until completion.",
      {
        stage: "connection-lost",
        recoverableDisconnect: false,
        disconnectCause: "chrome-closed",
        runtime: {
          chromePort: 9222,
          chromeHost: "127.0.0.1",
          tabUrl: "https://chatgpt.com/c/demo",
          promptSubmitted: true,
        },
      },
    );
    vi.mocked(runBrowserSessionExecution).mockImplementationOnce(async () => {
      throw automationError;
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

    expect(vi.mocked(resumeBrowserSession)).not.toHaveBeenCalled();
    const logLines = log.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logLines).toContain("Skipping auto-reattach: disconnect classified as non-recoverable.");
    const finalUpdate = sessionStoreMock.updateSession.mock.calls.at(-1)?.[1];
    expect(finalUpdate).toMatchObject({
      status: "running",
      response: { status: "running", incompleteReason: "chrome-disconnected" },
    });
  });

  test("connection-loss recovery is one-shot by default (no infinite retry loop)", async () => {
    const automationError = new BrowserAutomationError(
      "Chrome DevTools client disconnected before oracle finished; the browser target appears still alive.",
      {
        stage: "connection-lost",
        recoverableDisconnect: true,
        disconnectCause: "cdp-client-disconnect",
        runtime: {
          chromePort: 9222,
          chromeHost: "127.0.0.1",
          tabUrl: "https://chatgpt.com/c/demo",
          chromeTargetId: "TARGET-1",
          promptSubmitted: true,
        },
      },
    );
    vi.mocked(runBrowserSessionExecution).mockImplementationOnce(async () => {
      throw automationError;
    });
    vi.mocked(resumeBrowserSession).mockRejectedValueOnce(new Error("target not ready yet"));

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

    expect(vi.mocked(resumeBrowserSession)).toHaveBeenCalledTimes(1);
    const logLines = log.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logLines).toContain("Auto-reattach will try up to 1 attempt(s).");
    expect(logLines).toContain("Auto-reattach stopped after 1 attempt(s)");
    const finalUpdate = sessionStoreMock.updateSession.mock.calls.at(-1)?.[1];
    expect(finalUpdate).toMatchObject({
      status: "running",
      response: { status: "running", incompleteReason: "chrome-disconnected" },
    });
  });

  test("auto-reattaches after connection loss and marks session completed", async () => {
    const automationError = new BrowserAutomationError(
      "Chrome DevTools client disconnected before oracle finished; the browser target appears still alive.",
      {
        stage: "connection-lost",
        recoverableDisconnect: true,
        disconnectCause: "cdp-client-disconnect",
        runtime: {
          chromePort: 9222,
          chromeHost: "127.0.0.1",
          tabUrl: "https://chatgpt.com/c/demo",
          chromeTargetId: "TARGET-1",
          promptSubmitted: true,
        },
      },
    );
    vi.mocked(runBrowserSessionExecution).mockImplementationOnce(async (_args, deps) => {
      await deps?.persistRuntimeHint?.(
        {
          chromePort: 9222,
          chromeHost: "127.0.0.1",
          tabUrl: "https://chatgpt.com/c/demo",
          chromeTargetId: "TARGET-1",
          promptSubmitted: true,
        },
        {
          requestedModel: "Pro",
          resolvedLabel: "Pro",
          strategy: "select",
          status: "already-selected",
          verified: true,
          source: "chatgpt-model-picker",
          capturedAt: "2026-07-03T00:00:00.000Z",
        },
      );
      throw automationError;
    });
    vi.mocked(resumeBrowserSession).mockResolvedValueOnce({
      answerText: "recovered answer",
      answerMarkdown: "recovered **answer**",
    });
    vi.mocked(ensureSessionArtifacts).mockResolvedValueOnce([
      { kind: "transcript", path: "/tmp/transcript.md" },
    ]);

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

    expect(vi.mocked(resumeBrowserSession)).toHaveBeenCalledTimes(1);
    const finalUpdateInput = sessionStoreMock.updateSession.mock.calls.at(-1)?.[1];
    const finalUpdate =
      typeof finalUpdateInput === "function" ? finalUpdateInput(baseSessionMeta) : finalUpdateInput;
    expect(finalUpdate).toMatchObject({
      status: "completed",
      response: { status: "completed" },
    });
    const logLines = log.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logLines).toContain("Auto-reattach succeeded; session marked completed.");
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
    vi.mocked(runBrowserSessionExecution).mockImplementationOnce(async (_args, deps) => {
      await deps?.persistRuntimeHint?.(
        {
          chromePort: 9222,
          chromeHost: "127.0.0.1",
          tabUrl: "https://chatgpt.com/c/demo",
          promptSubmitted: true,
        },
        {
          requestedModel: "Pro",
          resolvedLabel: "Pro",
          strategy: "select",
          status: "already-selected",
          verified: true,
          source: "chatgpt-model-picker",
          capturedAt: "2026-07-03T00:00:00.000Z",
        },
      );
      throw automationError;
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

    const finalUpdate = sessionStoreMock.updateSession.mock.calls.at(-1)?.[1];
    expect(finalUpdate).toMatchObject({
      status: "error",
      response: { status: "incomplete", incompleteReason: "incomplete-capture" },
      browser: expect.objectContaining({
        runtime: expect.objectContaining({ chromePort: 9222 }),
        modelSelection: expect.objectContaining({ resolvedLabel: "Pro", verified: true }),
      }),
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

  test("persists sanitized remote timeout recovery identity and route attribution", async () => {
    const recoveryRuntime = {
      tabUrl: "https://chatgpt.com/c/canonical-remote-123",
      conversationId: "canonical-remote-123",
      promptSubmitted: true as const,
    };
    vi.mocked(runBrowserSessionExecution).mockRejectedValueOnce(
      new BrowserAutomationError("Assistant response timed out before completion.", {
        stage: "assistant-timeout",
        runtime: recoveryRuntime,
        errorClass: "transport_interrupted_after_submit",
        retryable: false,
        remoteRun: {
          runId: "run-recovery-1",
          accountId: "acct2",
          laneId: "acct2-9473",
          terminalDoneOk: false,
        },
      }),
    );

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
      browser: { runtime: recoveryRuntime },
      error: {
        category: "browser-automation",
        details: {
          stage: "assistant-timeout",
          runtime: recoveryRuntime,
          errorClass: "transport_interrupted_after_submit",
          retryable: false,
          remoteRun: {
            runId: "run-recovery-1",
            accountId: "acct2",
            laneId: "acct2-9473",
            terminalDoneOk: false,
          },
        },
      },
    });
    const serialized = JSON.stringify(finalUpdate);
    expect(serialized).not.toContain("chromePort");
    expect(serialized).not.toContain("chromePid");
    expect(serialized).not.toContain("chromeTargetId");
    expect(serialized).not.toContain("userDataDir");
    expect(serialized).not.toContain("diagnostics");
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
    vi.mocked(runBrowserSessionExecution).mockImplementationOnce(async (_args, deps) => {
      await deps?.persistRuntimeHint?.(
        {
          chromePort: 9222,
          chromeHost: "127.0.0.1",
          tabUrl: "https://chatgpt.com/c/demo",
          promptSubmitted: true,
        },
        {
          requestedModel: "Pro",
          resolvedLabel: "Pro",
          strategy: "select",
          status: "already-selected",
          verified: true,
          source: "chatgpt-model-picker",
          capturedAt: "2026-07-03T00:00:00.000Z",
        },
      );
      throw automationError;
    });
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
    const finalUpdateInput = sessionStoreMock.updateSession.mock.calls.at(-1)?.[1];
    const finalUpdate =
      typeof finalUpdateInput === "function"
        ? finalUpdateInput({
            ...baseSessionMeta,
            browser: {
              config: { chromePath: null },
              runtime: {
                chromePort: 9222,
                chromeHost: "127.0.0.1",
                tabUrl: "https://chatgpt.com/c/demo",
                promptSubmitted: true,
              },
              modelSelection: {
                requestedModel: "Pro",
                resolvedLabel: "Pro",
                strategy: "select",
                status: "already-selected",
                verified: true,
                source: "chatgpt-model-picker",
                capturedAt: "2026-07-03T00:00:00.000Z",
              },
            },
          })
        : finalUpdateInput;
    expect(finalUpdate).toMatchObject({
      status: "completed",
      artifacts: [
        { kind: "transcript", path: "/tmp/transcript.md" },
        { kind: "deep-research-report", path: "/tmp/deep-research-report.md" },
      ],
      response: { status: "completed" },
      browser: expect.objectContaining({
        modelSelection: expect.objectContaining({ resolvedLabel: "Pro", verified: true }),
      }),
    });
    expect(vi.mocked(sendSessionNotification)).toHaveBeenCalled();
  });

  test("persists the latest follow-up ownership but refuses single-answer recovery for a timed-out multi-turn run", async () => {
    let stored: SessionMetadata = {
      ...baseSessionMeta,
      options: {
        ...baseSessionMeta.options,
        prompt: "Initial markdown prompt",
        browserFollowUps: ["Follow-up with **different** ownership text"],
      },
    };
    sessionStoreMock.updateSession.mockImplementation(
      async (
        _sessionId: string,
        updates:
          | Partial<SessionMetadata>
          | ((metadata: SessionMetadata) => Partial<SessionMetadata>),
      ) => {
        const patch = typeof updates === "function" ? await updates(stored) : updates;
        stored = { ...stored, ...patch };
        return stored;
      },
    );
    const automationError = new BrowserAutomationError("follow-up assistant timed out", {
      stage: "assistant-timeout",
      runtime: {
        chromePort: 9222,
        chromeHost: "127.0.0.1",
        tabUrl: "https://chatgpt.com/c/follow-up-demo",
        promptSubmitted: true,
      },
    });
    vi.mocked(runBrowserSessionExecution).mockImplementationOnce(async (_args, deps) => {
      await deps?.persistSubmittedPromptPreview?.("normalized initial markdown prompt");
      await deps?.persistSubmittedPromptPreview?.(
        "normalized initial markdown prompt",
        "a".repeat(64),
      );
      await deps?.persistRuntimeHint?.({
        chromePort: 9222,
        chromeHost: "127.0.0.1",
        tabUrl: "https://chatgpt.com/c/follow-up-demo",
        promptSubmitted: true,
      });
      // A new attempt invalidates the previous bound digest before dispatch,
      // then the committed follow-up installs its own identity pair.
      await deps?.persistSubmittedPromptPreview?.(
        "normalized follow-up with different ownership text",
      );
      await deps?.persistSubmittedPromptPreview?.(
        "normalized follow-up with different ownership text",
        "b".repeat(64),
      );
      throw automationError;
    });
    vi.mocked(resumeBrowserSession).mockResolvedValue({
      answerText: "follow-up answer",
      answerMarkdown: "follow-up answer",
    });

    await performSessionRun({
      sessionMeta: stored,
      runOptions: {
        ...baseRunOptions,
        prompt: "Initial markdown prompt",
        browserFollowUps: ["Follow-up with **different** ownership text"],
      },
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

    expect(stored.browser?.submittedPromptPreview).toBe(
      "normalized follow-up with different ownership text",
    );
    expect(stored.browser?.submittedPromptDomSha256).toBe("b".repeat(64));
    expect(vi.mocked(resumeBrowserSession)).not.toHaveBeenCalled();
    expect(stored).toMatchObject({
      status: "error",
      response: { status: "incomplete", incompleteReason: "incomplete-capture" },
    });
    expect(log.mock.calls.map((call) => String(call[0])).join("\n")).toContain(
      "multi-turn browser run cannot be completed from one recovered answer",
    );
  });

  test("refuses dispatch when the prior prompt ownership cannot be durably invalidated", async () => {
    let stored: SessionMetadata = {
      ...baseSessionMeta,
      browser: {
        config: { chromePath: null },
        submittedPromptPreview: "older completed prompt",
        submittedPromptDomSha256: "a".repeat(64),
      },
    };
    let updateCount = 0;
    sessionStoreMock.updateSession.mockImplementation(
      async (
        _sessionId: string,
        updates:
          | Partial<SessionMetadata>
          | ((metadata: SessionMetadata) => Partial<SessionMetadata>),
      ) => {
        updateCount += 1;
        if (updateCount === 2) {
          throw new Error("metadata write unavailable");
        }
        const patch = typeof updates === "function" ? await updates(stored) : updates;
        stored = { ...stored, ...patch };
        return stored;
      },
    );
    let dispatched = false;
    vi.mocked(runBrowserSessionExecution).mockImplementationOnce(async (_args, deps) => {
      await deps?.persistSubmittedPromptPreview?.("new prompt");
      dispatched = true;
      throw new Error("unreachable");
    });

    await expect(
      performSessionRun({
        sessionMeta: stored,
        runOptions: baseRunOptions,
        mode: "browser",
        browserConfig: { chromePath: null },
        cwd: "/tmp",
        log,
        write,
        version: cliVersion,
      }),
    ).rejects.toThrow("metadata write unavailable");

    expect(dispatched).toBe(false);
    expect(stored.browser?.submittedPromptPreview).toBe("new prompt");
    expect(stored.browser?.submittedPromptDomSha256).toBeUndefined();
  });

  test("continues live capture but leaves recovery disabled when the bound digest write fails", async () => {
    let stored: SessionMetadata = {
      ...baseSessionMeta,
      browser: {
        config: { chromePath: null },
        submittedPromptPreview: "older completed prompt",
        submittedPromptDomSha256: "a".repeat(64),
      },
    };
    let updateCount = 0;
    sessionStoreMock.updateSession.mockImplementation(
      async (
        _sessionId: string,
        updates:
          | Partial<SessionMetadata>
          | ((metadata: SessionMetadata) => Partial<SessionMetadata>),
      ) => {
        updateCount += 1;
        if (updateCount === 3) {
          throw new Error("bound digest write unavailable");
        }
        const patch = typeof updates === "function" ? await updates(stored) : updates;
        stored = { ...stored, ...patch };
        return stored;
      },
    );
    vi.mocked(runBrowserSessionExecution).mockImplementationOnce(async (_args, deps) => {
      await deps?.persistSubmittedPromptPreview?.("new prompt");
      await deps?.persistSubmittedPromptPreview?.("new prompt", "b".repeat(64));
      return {
        usage: { inputTokens: 2, outputTokens: 3, reasoningTokens: 0, totalTokens: 5 },
        elapsedMs: 50,
        runtime: { chromePid: 1, chromePort: 9222, userDataDir: "/tmp/chrome" },
        answerText: "captured successfully",
      };
    });

    await expect(
      performSessionRun({
        sessionMeta: stored,
        runOptions: baseRunOptions,
        mode: "browser",
        browserConfig: { chromePath: null },
        cwd: "/tmp",
        log,
        write,
        version: cliVersion,
      }),
    ).resolves.not.toThrow();

    expect(stored.status).toBe("completed");
    expect(stored.browser?.submittedPromptPreview).toBe("new prompt");
    expect(stored.browser?.submittedPromptDomSha256).toBeUndefined();
    expect(log.mock.calls.map((call) => String(call[0])).join("\n")).toContain(
      "continuing live capture with reattach disabled for this turn",
    );
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

      const caamBase = path.join(fixture.root, "orch-homes");
      await withExactEnv(
        {
          ...blockedClaudeCodeEnvDefaults,
          PATH: `${fixture.binDir}${path.delimiter}${process.env.PATH ?? ""}`,
          [ORACLE_CLAUDE_CODE_CAAM_PROFILE_ENV_VAR]: "beta",
        },
        async () => {
          await performSessionRun({
            sessionMeta: { ...baseSessionMeta, mode: "claude-code", model: "fable" },
            runOptions: {
              prompt: "Review via caam",
              model: "fable",
              lane: "fable-local",
              laneInferenceSource: "lane",
              claudeCode: {
                ...fableClaudeCodePolicy,
                noSessionPersistence: false,
                caamProfile: "beta",
                caamBase,
              },
            },
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
      expect(doctorArgv).toEqual([
        "shallow-spawn",
        "beta",
        "--base",
        caamBase,
        "--print-env",
        "--json",
      ]);

      // The outer command is exactly:
      //   caam shallow-spawn beta --base <configured-base> -- <claude> <inner argv...>
      // where the inner argv is byte-for-byte buildClaudeCodeCommand()'s
      // own output — untouched by the caam wrapper (caam-map.md §4a).
      const shallowSpawnArgv = JSON.parse(
        fs.readFileSync(shallowSpawnArgvPath, "utf8"),
      ) as string[];
      const sessionIdIndex = shallowSpawnArgv.indexOf("--session-id");
      expect(sessionIdIndex).toBeGreaterThan(-1);
      const persistedSessionId = shallowSpawnArgv[sessionIdIndex + 1];
      expect(persistedSessionId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
      expect(shallowSpawnArgv).not.toContain("--no-session-persistence");
      expect(shallowSpawnArgv).not.toContain("--resume");
      const expectedInner = buildClaudeCodeCommand({
        executable: claudePath,
        model: "fable",
        sessionId: persistedSessionId,
      });
      expect(shallowSpawnArgv).toEqual([
        "shallow-spawn",
        "beta",
        "--base",
        caamBase,
        "--",
        claudePath,
        ...expectedInner.args,
      ]);

      expect(fs.readFileSync(caamMarkerPath, "utf8")).toBe("spawned\n");

      // Per-profile lock was used and released — not the global one.
      expect(fs.existsSync(path.join(locksDir, "claude-code-subscription-beta.lock"))).toBe(false);
      expect(fs.existsSync(globalLockPath)).toBe(true);

      const finalUpdate = sessionStoreMock.updateSession.mock.calls.at(-1)?.[1];
      expect(finalUpdate).toMatchObject({
        status: "completed",
        mode: "claude-code",
        claudeCode: {
          claude_session_id: persistedSessionId,
          caam_profile: "beta",
          caam_base: caamBase,
          read_only: { sessionPersistenceDisabled: false },
        },
      });

      // A later Oracle follow-up must use Claude's real resume primitive with
      // the exact persisted UUID, never try to start a second --session-id.
      const followupSessionDir = path.join(fixture.sessionsDir, "sess-followup");
      fs.mkdirSync(followupSessionDir, { recursive: true, mode: 0o700 });
      sessionStoreMock.getPaths.mockResolvedValue({
        dir: followupSessionDir,
        metadata: path.join(followupSessionDir, "meta.json"),
        request: path.join(followupSessionDir, "request.json"),
        log: path.join(followupSessionDir, "output.log"),
      });
      await withExactEnv(
        {
          ...blockedClaudeCodeEnvDefaults,
          PATH: `${fixture.binDir}${path.delimiter}${process.env.PATH ?? ""}`,
          [ORACLE_CLAUDE_CODE_CAAM_PROFILE_ENV_VAR]: "beta",
        },
        async () => {
          await performSessionRun({
            sessionMeta: {
              ...baseSessionMeta,
              id: "sess-followup",
              mode: "claude-code",
              model: "fable",
            },
            runOptions: {
              prompt: "Continue via caam",
              model: "fable",
              lane: "fable-local",
              laneInferenceSource: "lane",
              claudeCode: {
                ...fableClaudeCodePolicy,
                noSessionPersistence: false,
                resumeSessionId: persistedSessionId,
                caamProfile: "beta",
                caamBase,
              },
            },
            mode: "claude-code",
            cwd: fixture.repoDir,
            log,
            write,
            version: cliVersion,
            muteStdout: true,
          });
        },
      );
      const followupArgv = JSON.parse(fs.readFileSync(shallowSpawnArgvPath, "utf8")) as string[];
      expect(followupArgv[followupArgv.indexOf("--resume") + 1]).toBe(persistedSessionId);
      expect(followupArgv).not.toContain("--session-id");
      expect(followupArgv).not.toContain("--no-session-persistence");
      expect(sessionStoreMock.updateSession.mock.calls.at(-1)?.[1]).toMatchObject({
        status: "completed",
        claudeCode: {
          claude_session_id: persistedSessionId,
          read_only: { sessionPersistenceDisabled: false },
        },
      });
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
      const profileLockPath = path.join(locksDir, "claude-code-subscription-beta.lock");
      fs.writeFileSync(
        profileLockPath,
        `${JSON.stringify({
          schema_version: "claude_code_single_flight_lock.v1",
          session_id: "busy-beta-session",
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
          [ORACLE_CLAUDE_CODE_CAAM_PROFILE_ENV_VAR]: "beta",
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
          ).rejects.toThrow(/already running in session busy-beta-session/);
        },
      );

      expect(fs.existsSync(caamMarkerPath)).toBe(false);
      expect(fs.existsSync(profileLockPath)).toBe(true);
    } finally {
      teardownCaamFixture(fixture);
    }
  });

  test("fail closed: an explicit profile with caam absent never spawns direct claude", async () => {
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
          [ORACLE_CLAUDE_CODE_CAAM_PROFILE_ENV_VAR]: "beta",
        },
        async () => {
          await expect(
            performSessionRun({
              sessionMeta: { ...baseSessionMeta, mode: "claude-code", model: "fable" },
              runOptions: { prompt: "Review without caam installed", model: "fable" },
              mode: "claude-code",
              cwd: fixture.repoDir,
              log,
              write,
              version: cliVersion,
              muteStdout: true,
            }),
          ).rejects.toThrow(/caam/i);
        },
      );

      expect(fs.existsSync(claudeMarkerPath)).toBe(false);
      expect(fs.existsSync(claudeArgvPath)).toBe(false);

      // No lock was acquired because account preflight failed before launch.
      const locksDir = path.join(fixture.oracleHome, "locks");
      expect(fs.existsSync(path.join(locksDir, "claude-code-subscription.lock"))).toBe(false);
      expect(fs.existsSync(path.join(locksDir, "claude-code-subscription-beta.lock"))).toBe(false);

      const finalUpdate = sessionStoreMock.updateSession.mock.calls.at(-1)?.[1];
      expect(finalUpdate).toMatchObject({ status: "error", mode: "claude-code" });
    } finally {
      teardownCaamFixture(fixture);
    }
  });

  test("fail closed: an unhealthy explicit profile never spawns direct claude", async () => {
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
          await expect(
            performSessionRun({
              sessionMeta: { ...baseSessionMeta, mode: "claude-code", model: "fable" },
              runOptions: { prompt: "Review with an unhealthy caam profile", model: "fable" },
              mode: "claude-code",
              cwd: fixture.repoDir,
              log,
              write,
              version: cliVersion,
              muteStdout: true,
            }),
          ).rejects.toThrow(/unhealthy/i);
        },
      );

      // Neither CAAM's launch branch nor direct Claude ran.
      expect(fs.existsSync(caamMarkerPath)).toBe(false);
      expect(fs.existsSync(claudeMarkerPath)).toBe(false);

      const locksDir = path.join(fixture.oracleHome, "locks");
      expect(fs.existsSync(path.join(locksDir, "claude-code-subscription.lock"))).toBe(false);
      expect(
        fs.existsSync(path.join(locksDir, "claude-code-subscription-unhealthy-profile.lock")),
      ).toBe(false);

      const finalUpdate = sessionStoreMock.updateSession.mock.calls.at(-1)?.[1];
      expect(finalUpdate).toMatchObject({ status: "error", mode: "claude-code" });
    } finally {
      teardownCaamFixture(fixture);
    }
  });
});

describe("claude-code caam rate-limit rotation (caam-ratelimit-rotation-design.md)", () => {
  interface RotationFixture {
    root: string;
    oracleHome: string;
    sessionsDir: string;
    sessionDir: string;
    repoDir: string;
    binDir: string;
    logsDir: string;
  }

  function setupRotationFixture(): RotationFixture {
    const root = fs.mkdtempSync(path.join(os.homedir(), ".oracle-claude-code-rotation-test-"));
    const oracleHome = path.join(root, "oracle-home");
    const sessionsDir = path.join(root, "sessions");
    const sessionDir = path.join(sessionsDir, "sess-1");
    const repoDir = path.join(root, "repo");
    const binDir = path.join(root, "bin");
    const logsDir = path.join(root, "logs");
    for (const dir of [oracleHome, sessionsDir, sessionDir, repoDir, binDir, logsDir]) {
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
    return { root, oracleHome, sessionsDir, sessionDir, repoDir, binDir, logsDir };
  }

  function teardownRotationFixture(fixture: RotationFixture): void {
    setOracleHomeDirOverrideForTest(null);
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }

  function readAdapterMetadata(fixture: RotationFixture): Record<string, unknown> {
    return JSON.parse(
      fs.readFileSync(
        path.join(fixture.sessionDir, "artifacts", "claude-code-adapter.json"),
        "utf8",
      ),
    ) as Record<string, unknown>;
  }

  test("rate-limit signal rotates to a fresh, healthy caam profile and succeeds", async () => {
    vi.mocked(fsPromises.mkdir).mockRestore();
    vi.mocked(fsPromises.writeFile).mockRestore();
    const fixture = setupRotationFixture();
    try {
      createFakeCaamExecutableWithRotation({
        binDir: fixture.binDir,
        logsDir: fixture.logsDir,
        profileStdoutEvents: {
          beta: [fakeClaudeCodeInitEvent(), rateLimitResultEvent("Claude AI usage limit reached")],
        },
        robotNextResponses: [{ json: { success: true, data: { profile: "beth" } } }],
      });

      await withExactEnv(
        {
          ...blockedClaudeCodeEnvDefaults,
          PATH: `${fixture.binDir}${path.delimiter}${process.env.PATH ?? ""}`,
          [ORACLE_CLAUDE_CODE_CAAM_PROFILE_ENV_VAR]: "beta",
        },
        async () => {
          await performSessionRun({
            sessionMeta: { ...baseSessionMeta, mode: "claude-code", model: "fable" },
            runOptions: { prompt: "Review via caam with rotation", model: "fable" },
            mode: "claude-code",
            cwd: fixture.repoDir,
            log,
            write,
            version: cliVersion,
            muteStdout: true,
          });
        },
      );

      const doctorCalls = readJsonlLog(fixture.logsDir, "doctor-calls.jsonl") as string[][];
      expect(doctorCalls.map((argv) => argv[1])).toEqual(["beta", "beth"]);
      expect(doctorCalls.every((argv) => argv[2] === "--base")).toBe(true);
      expect(doctorCalls[0][3]).toBe(doctorCalls[1][3]);

      const shallowSpawnCalls = readJsonlLog(
        fixture.logsDir,
        "shallow-spawn-calls.jsonl",
      ) as string[][];
      expect(shallowSpawnCalls.map((argv) => argv[1])).toEqual(["beta", "beth"]);
      expect(shallowSpawnCalls.every((argv) => argv[3] === doctorCalls[0][3])).toBe(true);

      const cooldownCalls = readJsonlLog(fixture.logsDir, "cooldown-calls.jsonl") as string[][];
      expect(cooldownCalls).toHaveLength(1);
      expect(cooldownCalls[0].slice(0, 4)).toEqual(["cooldown", "set", "claude/beta", "--minutes"]);
      expect(cooldownCalls[0]).toContain("60");
      expect(cooldownCalls[0].at(-1)).toContain("rate_limit pattern");

      const robotNextCalls = readJsonlLog(fixture.logsDir, "robot-next-calls.jsonl") as string[][];
      expect(robotNextCalls).toEqual([["robot", "next", "claude", "--strategy", "smart"]]);
      expect(robotNextCalls[0]).not.toContain("--include-cooldown");

      expect(fs.existsSync(path.join(fixture.logsDir, "markers", "beta.marker"))).toBe(true);
      expect(fs.existsSync(path.join(fixture.logsDir, "markers", "beth.marker"))).toBe(true);

      // Both per-profile locks were released — not held simultaneously past
      // their own attempt.
      const locksDir = path.join(fixture.oracleHome, "locks");
      expect(fs.existsSync(path.join(locksDir, "claude-code-subscription-beta.lock"))).toBe(false);
      expect(fs.existsSync(path.join(locksDir, "claude-code-subscription-beth.lock"))).toBe(false);

      const finalUpdate = sessionStoreMock.updateSession.mock.calls.at(-1)?.[1];
      expect(finalUpdate).toMatchObject({ status: "completed", mode: "claude-code" });

      const adapter = readAdapterMetadata(fixture) as {
        rotation?: {
          attempts: Array<{ profile?: string; outcome: string }>;
          final_profile: string | null;
          rotations_used: number;
          exhausted: boolean;
        };
      };
      expect(adapter.rotation?.attempts).toEqual([
        expect.objectContaining({ profile: "beta", outcome: "rate_limited" }),
        expect.objectContaining({ profile: "beth", outcome: "success" }),
      ]);
      expect(adapter.rotation?.final_profile).toBe("beth");
      expect(adapter.rotation?.rotations_used).toBe(1);
      expect(adapter.rotation?.exhausted).toBe(false);
    } finally {
      teardownRotationFixture(fixture);
    }
  });

  test("fable-local never rotates despite positive configured and inherited caps", async () => {
    vi.mocked(fsPromises.mkdir).mockRestore();
    vi.mocked(fsPromises.writeFile).mockRestore();
    const fixture = setupRotationFixture();
    try {
      createFakeCaamExecutableWithRotation({
        binDir: fixture.binDir,
        logsDir: fixture.logsDir,
        profileStdoutEvents: {
          beta: [fakeClaudeCodeInitEvent(), rateLimitResultEvent("rate limit on pinned profile")],
        },
        robotNextResponses: [{ json: { success: true, data: { profile: "beth" } } }],
      });

      await withExactEnv(
        {
          ...blockedClaudeCodeEnvDefaults,
          PATH: `${fixture.binDir}${path.delimiter}${process.env.PATH ?? ""}`,
          [ORACLE_CLAUDE_CODE_CAAM_PROFILE_ENV_VAR]: "beta",
          [ORACLE_CLAUDE_CODE_MAX_RATE_LIMIT_ROTATIONS_ENV_VAR]: "9",
        },
        async () => {
          await expect(
            performSessionRun({
              sessionMeta: {
                ...baseSessionMeta,
                mode: "claude-code",
                model: "fable",
                lane: "fable-local",
              },
              runOptions: {
                prompt: "Review while preserving the selected account",
                model: "fable",
                lane: "fable-local",
                claudeCode: {
                  ...fableClaudeCodePolicy,
                  maxRateLimitRotations: 3,
                },
              },
              mode: "claude-code",
              cwd: fixture.repoDir,
              log,
              write,
              version: cliVersion,
              muteStdout: true,
            }),
          ).rejects.toThrow(/rate-limit signal/);
        },
      );

      expect(readJsonlLog(fixture.logsDir, "doctor-calls.jsonl")).toHaveLength(1);
      expect(readJsonlLog(fixture.logsDir, "shallow-spawn-calls.jsonl")).toHaveLength(1);
      expect(readJsonlLog(fixture.logsDir, "cooldown-calls.jsonl")).toHaveLength(0);
      expect(readJsonlLog(fixture.logsDir, "robot-next-calls.jsonl")).toHaveLength(0);

      const adapter = readAdapterMetadata(fixture) as {
        rotation?: { attempts: unknown[]; rotations_used: number; exhausted: boolean; cap: number };
      };
      expect(adapter.rotation).toMatchObject({
        rotations_used: 0,
        exhausted: true,
        cap: 0,
      });
      expect(adapter.rotation?.attempts).toHaveLength(1);
    } finally {
      teardownRotationFixture(fixture);
    }
  });

  test("challenge/auth signal is a HARD-HALT: never calls cooldown/robot next, never spawns a second attempt", async () => {
    vi.mocked(fsPromises.mkdir).mockRestore();
    vi.mocked(fsPromises.writeFile).mockRestore();
    const fixture = setupRotationFixture();
    try {
      createFakeCaamExecutableWithRotation({
        binDir: fixture.binDir,
        logsDir: fixture.logsDir,
        profileStdoutEvents: {
          beta: [
            fakeClaudeCodeInitEvent(),
            rateLimitResultEvent("authentication failed, please log in again"),
          ],
        },
        robotNextResponses: [{ json: { success: true, data: { profile: "beth" } } }],
      });

      await withExactEnv(
        {
          ...blockedClaudeCodeEnvDefaults,
          PATH: `${fixture.binDir}${path.delimiter}${process.env.PATH ?? ""}`,
          [ORACLE_CLAUDE_CODE_CAAM_PROFILE_ENV_VAR]: "beta",
        },
        async () => {
          await expect(
            performSessionRun({
              sessionMeta: { ...baseSessionMeta, mode: "claude-code", model: "fable" },
              runOptions: { prompt: "Review via caam, expect challenge", model: "fable" },
              mode: "claude-code",
              cwd: fixture.repoDir,
              log,
              write,
              version: cliVersion,
              muteStdout: true,
            }),
          ).rejects.toThrow(/HARD-HALT/);
        },
      );

      expect(readJsonlLog(fixture.logsDir, "doctor-calls.jsonl")).toHaveLength(1);
      expect(readJsonlLog(fixture.logsDir, "shallow-spawn-calls.jsonl")).toHaveLength(1);
      expect(readJsonlLog(fixture.logsDir, "cooldown-calls.jsonl")).toHaveLength(0);
      expect(readJsonlLog(fixture.logsDir, "robot-next-calls.jsonl")).toHaveLength(0);

      const finalUpdate = sessionStoreMock.updateSession.mock.calls.at(-1)?.[1];
      expect(finalUpdate).toMatchObject({ status: "error" });
      expect((finalUpdate as { errorMessage?: string }).errorMessage).toMatch(/HARD-HALT/);
    } finally {
      teardownRotationFixture(fixture);
    }
  });

  test("caam absent: a rate-limit-shaped message in the output does not change behavior", async () => {
    vi.mocked(fsPromises.mkdir).mockRestore();
    vi.mocked(fsPromises.writeFile).mockRestore();
    const fixture = setupRotationFixture();
    try {
      createFakeClaudeExecutable({
        binDir: fixture.binDir,
        argvPath: path.join(fixture.root, "claude-argv.json"),
        stdinPath: path.join(fixture.root, "claude-stdin.txt"),
        markerPath: path.join(fixture.root, "claude-marker.txt"),
        stdoutEvents: [fakeClaudeCodeInitEvent(), rateLimitResultEvent("rate limit exceeded")],
      });
      // Deliberately no `caam` on PATH and no caam profile configured.

      await withExactEnv(
        {
          ...blockedClaudeCodeEnvDefaults,
          PATH: `${fixture.binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        },
        async () => {
          await performSessionRun({
            sessionMeta: { ...baseSessionMeta, mode: "claude-code", model: "fable" },
            runOptions: { prompt: "Review without caam configured", model: "fable" },
            mode: "claude-code",
            cwd: fixture.repoDir,
            log,
            write,
            version: cliVersion,
            muteStdout: true,
          });
        },
      );

      const finalUpdate = sessionStoreMock.updateSession.mock.calls.at(-1)?.[1];
      expect(finalUpdate).toMatchObject({ status: "completed", errorMessage: undefined });
      const adapter = readAdapterMetadata(fixture) as { rotation?: unknown };
      expect(adapter.rotation).toBeUndefined();
    } finally {
      teardownRotationFixture(fixture);
    }
  });

  test("caam active: a benign SUCCESSFUL transcript containing trigger vocabulary as ordinary content is left alone (oracle-router-n0t)", async () => {
    // This is the key regression test for the HIGH-severity false-positive
    // fix: a HEALTHY session whose task is *about* rate limiting/auth (the
    // model's own final answer happens to say "rate limiter", "429",
    // "quota", "unauthorized", "403") must NOT be killed, cooled down, or
    // rotated just because those words appear in a *successful* result.
    vi.mocked(fsPromises.mkdir).mockRestore();
    vi.mocked(fsPromises.writeFile).mockRestore();
    const fixture = setupRotationFixture();
    try {
      createFakeCaamExecutableWithRotation({
        binDir: fixture.binDir,
        logsDir: fixture.logsDir,
        profileStdoutEvents: {
          beta: [
            fakeClaudeCodeInitEvent(),
            benignSuccessResultEvent(
              "Implemented a token-bucket rate limiter that returns 429 when the quota is exceeded; unauthorized requests get 403.",
            ),
          ],
        },
        // Deliberately empty: `robot next` must never be invoked for this
        // run. If a regression makes it get called, the fake `caam`
        // executable will crash on the missing response entry, failing the
        // test loudly.
        robotNextResponses: [],
      });

      await withExactEnv(
        {
          ...blockedClaudeCodeEnvDefaults,
          PATH: `${fixture.binDir}${path.delimiter}${process.env.PATH ?? ""}`,
          [ORACLE_CLAUDE_CODE_CAAM_PROFILE_ENV_VAR]: "beta",
        },
        async () => {
          await performSessionRun({
            sessionMeta: { ...baseSessionMeta, mode: "claude-code", model: "fable" },
            runOptions: {
              prompt: "Write a rate limiter that returns 429 for unauthorized requests",
              model: "fable",
            },
            mode: "claude-code",
            cwd: fixture.repoDir,
            log,
            write,
            version: cliVersion,
            muteStdout: true,
          });
        },
      );

      // Zero cooldown/rotation machinery invoked, and no second spawn.
      expect(readJsonlLog(fixture.logsDir, "cooldown-calls.jsonl")).toHaveLength(0);
      expect(readJsonlLog(fixture.logsDir, "robot-next-calls.jsonl")).toHaveLength(0);
      expect(readJsonlLog(fixture.logsDir, "doctor-calls.jsonl")).toHaveLength(1);
      expect(readJsonlLog(fixture.logsDir, "shallow-spawn-calls.jsonl")).toHaveLength(1);

      const finalUpdate = sessionStoreMock.updateSession.mock.calls.at(-1)?.[1];
      expect(finalUpdate).toMatchObject({ status: "completed", mode: "claude-code" });
      expect((finalUpdate as { errorMessage?: string }).errorMessage).toBeUndefined();

      const adapter = readAdapterMetadata(fixture) as {
        rotation?: {
          attempts: Array<{ profile?: string; outcome: string }>;
          final_profile: string | null;
          rotations_used: number;
          exhausted: boolean;
        };
      };
      expect(adapter.rotation?.attempts).toEqual([
        expect.objectContaining({ profile: "beta", outcome: "success" }),
      ]);
      expect(adapter.rotation?.final_profile).toBe("beta");
      expect(adapter.rotation?.rotations_used).toBe(0);
      expect(adapter.rotation?.exhausted).toBe(false);
    } finally {
      teardownRotationFixture(fixture);
    }
  });

  test("robot next exhaustion (NO_PROFILES) stops rotation and surfaces the ORIGINAL rate-limit failure", async () => {
    vi.mocked(fsPromises.mkdir).mockRestore();
    vi.mocked(fsPromises.writeFile).mockRestore();
    const fixture = setupRotationFixture();
    try {
      createFakeCaamExecutableWithRotation({
        binDir: fixture.binDir,
        logsDir: fixture.logsDir,
        profileStdoutEvents: {
          beta: [fakeClaudeCodeInitEvent(), rateLimitResultEvent("429 too many requests")],
        },
        robotNextResponses: [
          {
            json: {
              success: false,
              error: { code: "NO_PROFILES", message: "no profiles found for claude" },
            },
            exitCode: 1,
          },
        ],
      });

      await withExactEnv(
        {
          ...blockedClaudeCodeEnvDefaults,
          PATH: `${fixture.binDir}${path.delimiter}${process.env.PATH ?? ""}`,
          [ORACLE_CLAUDE_CODE_CAAM_PROFILE_ENV_VAR]: "beta",
        },
        async () => {
          await expect(
            performSessionRun({
              sessionMeta: { ...baseSessionMeta, mode: "claude-code", model: "fable" },
              runOptions: { prompt: "Review, rotation should exhaust", model: "fable" },
              mode: "claude-code",
              cwd: fixture.repoDir,
              log,
              write,
              version: cliVersion,
              muteStdout: true,
            }),
          ).rejects.toThrow(/rate-limit signal/);
        },
      );

      expect(readJsonlLog(fixture.logsDir, "doctor-calls.jsonl")).toHaveLength(1);
      expect(readJsonlLog(fixture.logsDir, "shallow-spawn-calls.jsonl")).toHaveLength(1);
      expect(readJsonlLog(fixture.logsDir, "cooldown-calls.jsonl")).toHaveLength(1);
      expect(readJsonlLog(fixture.logsDir, "robot-next-calls.jsonl")).toHaveLength(1);

      const finalUpdate = sessionStoreMock.updateSession.mock.calls.at(-1)?.[1];
      expect((finalUpdate as { errorMessage?: string }).errorMessage).not.toMatch(/NO_PROFILES/);

      const adapter = readAdapterMetadata(fixture) as {
        rotation?: { attempts: unknown[]; rotations_used: number; exhausted: boolean };
      };
      expect(adapter.rotation?.attempts).toHaveLength(1);
      expect(adapter.rotation?.rotations_used).toBe(0);
      expect(adapter.rotation?.exhausted).toBe(true);
    } finally {
      teardownRotationFixture(fixture);
    }
  });

  test("a cooldown-set failure is non-fatal: rotation still proceeds to robot next and can still succeed", async () => {
    vi.mocked(fsPromises.mkdir).mockRestore();
    vi.mocked(fsPromises.writeFile).mockRestore();
    const fixture = setupRotationFixture();
    try {
      createFakeCaamExecutableWithRotation({
        binDir: fixture.binDir,
        logsDir: fixture.logsDir,
        profileStdoutEvents: {
          beta: [fakeClaudeCodeInitEvent(), rateLimitResultEvent("usage limit reached")],
        },
        cooldownResponses: [{ exitCode: 1, stderr: "Error: cooldown db unavailable\n" }],
        robotNextResponses: [{ json: { success: true, data: { profile: "beth" } } }],
      });

      await withExactEnv(
        {
          ...blockedClaudeCodeEnvDefaults,
          PATH: `${fixture.binDir}${path.delimiter}${process.env.PATH ?? ""}`,
          [ORACLE_CLAUDE_CODE_CAAM_PROFILE_ENV_VAR]: "beta",
        },
        async () => {
          await performSessionRun({
            sessionMeta: { ...baseSessionMeta, mode: "claude-code", model: "fable" },
            runOptions: {
              prompt: "Review, cooldown write fails but rotation proceeds",
              model: "fable",
            },
            mode: "claude-code",
            cwd: fixture.repoDir,
            log,
            write,
            version: cliVersion,
            muteStdout: true,
          });
        },
      );

      expect(readJsonlLog(fixture.logsDir, "cooldown-calls.jsonl")).toHaveLength(1);
      expect(readJsonlLog(fixture.logsDir, "robot-next-calls.jsonl")).toHaveLength(1);
      expect(readJsonlLog(fixture.logsDir, "shallow-spawn-calls.jsonl")).toHaveLength(2);

      const finalUpdate = sessionStoreMock.updateSession.mock.calls.at(-1)?.[1];
      expect(finalUpdate).toMatchObject({ status: "completed" });
    } finally {
      teardownRotationFixture(fixture);
    }
  });

  test("in-process already-attempted guard: robot next re-offering the just-cooled profile is treated as exhaustion", async () => {
    vi.mocked(fsPromises.mkdir).mockRestore();
    vi.mocked(fsPromises.writeFile).mockRestore();
    const fixture = setupRotationFixture();
    try {
      createFakeCaamExecutableWithRotation({
        binDir: fixture.binDir,
        logsDir: fixture.logsDir,
        profileStdoutEvents: {
          beta: [fakeClaudeCodeInitEvent(), rateLimitResultEvent("usage limit reached")],
        },
        robotNextResponses: [{ json: { success: true, data: { profile: "beta" } } }],
      });

      await withExactEnv(
        {
          ...blockedClaudeCodeEnvDefaults,
          PATH: `${fixture.binDir}${path.delimiter}${process.env.PATH ?? ""}`,
          [ORACLE_CLAUDE_CODE_CAAM_PROFILE_ENV_VAR]: "beta",
        },
        async () => {
          await expect(
            performSessionRun({
              sessionMeta: { ...baseSessionMeta, mode: "claude-code", model: "fable" },
              runOptions: { prompt: "Review, robot next race", model: "fable" },
              mode: "claude-code",
              cwd: fixture.repoDir,
              log,
              write,
              version: cliVersion,
              muteStdout: true,
            }),
          ).rejects.toThrow(/rate-limit signal/);
        },
      );

      // Only the original spawn happened — the guard fired before a second
      // spawn was attempted against the very profile that just rate-limited.
      expect(readJsonlLog(fixture.logsDir, "shallow-spawn-calls.jsonl")).toHaveLength(1);
      expect(readJsonlLog(fixture.logsDir, "robot-next-calls.jsonl")).toHaveLength(1);

      const adapter = readAdapterMetadata(fixture) as {
        rotation?: { attempts: unknown[]; exhausted: boolean };
      };
      expect(adapter.rotation?.attempts).toHaveLength(1);
      expect(adapter.rotation?.exhausted).toBe(true);
    } finally {
      teardownRotationFixture(fixture);
    }
  });

  test("retry cap: stops after maxRateLimitRotations extra attempts and surfaces the LAST rate-limit failure", async () => {
    vi.mocked(fsPromises.mkdir).mockRestore();
    vi.mocked(fsPromises.writeFile).mockRestore();
    const fixture = setupRotationFixture();
    try {
      createFakeCaamExecutableWithRotation({
        binDir: fixture.binDir,
        logsDir: fixture.logsDir,
        profileStdoutEvents: {
          beta: [fakeClaudeCodeInitEvent(), rateLimitResultEvent("rate limit on beta")],
          beth: [fakeClaudeCodeInitEvent(), rateLimitResultEvent("rate limit on beth")],
        },
        robotNextResponses: [{ json: { success: true, data: { profile: "beth" } } }],
      });

      await withExactEnv(
        {
          ...blockedClaudeCodeEnvDefaults,
          PATH: `${fixture.binDir}${path.delimiter}${process.env.PATH ?? ""}`,
          [ORACLE_CLAUDE_CODE_CAAM_PROFILE_ENV_VAR]: "beta",
          [ORACLE_CLAUDE_CODE_MAX_RATE_LIMIT_ROTATIONS_ENV_VAR]: "1",
        },
        async () => {
          await expect(
            performSessionRun({
              sessionMeta: { ...baseSessionMeta, mode: "claude-code", model: "fable" },
              runOptions: { prompt: "Review, cap should stop rotation", model: "fable" },
              mode: "claude-code",
              cwd: fixture.repoDir,
              log,
              write,
              version: cliVersion,
              muteStdout: true,
            }),
          ).rejects.toThrow(/rate limit on beth/);
        },
      );

      // Original (beta) + exactly 1 rotation (beth) — the cap stops there.
      expect(readJsonlLog(fixture.logsDir, "shallow-spawn-calls.jsonl")).toHaveLength(2);
      expect(readJsonlLog(fixture.logsDir, "robot-next-calls.jsonl")).toHaveLength(1);

      const adapter = readAdapterMetadata(fixture) as {
        rotation?: { attempts: unknown[]; rotations_used: number; exhausted: boolean; cap: number };
      };
      expect(adapter.rotation?.attempts).toHaveLength(2);
      expect(adapter.rotation?.rotations_used).toBe(1);
      expect(adapter.rotation?.exhausted).toBe(true);
      expect(adapter.rotation?.cap).toBe(1);
    } finally {
      teardownRotationFixture(fixture);
    }
  });
});

describe("peekClaudeCodeSingleFlightLocks", () => {
  // A pid far above Linux's default pid_max — `process.kill(pid, 0)` reports
  // ESRCH, i.e. no such process, so this stands in for a crashed run's stale lock.
  const DEAD_PID = 2_147_483_647;

  function setupLocksHome(): { root: string; oracleHome: string; locksDir: string } {
    const root = fs.mkdtempSync(path.join(os.homedir(), ".oracle-lock-peek-test-"));
    const oracleHome = path.join(root, "oracle-home");
    const locksDir = path.join(oracleHome, "locks");
    fs.mkdirSync(locksDir, { recursive: true, mode: 0o700 });
    setOracleHomeDirOverrideForTest(oracleHome);
    return { root, oracleHome, locksDir };
  }

  function writeLock(locksDir: string, fileName: string, metadata: Record<string, unknown>): void {
    fs.writeFileSync(
      path.join(locksDir, fileName),
      `${JSON.stringify({
        schema_version: "claude_code_single_flight_lock.v1",
        ...metadata,
      })}\n`,
      { mode: 0o600 },
    );
  }

  test("reports not busy when the locks directory does not exist", async () => {
    const root = fs.mkdtempSync(path.join(os.homedir(), ".oracle-lock-peek-empty-test-"));
    const oracleHome = path.join(root, "oracle-home");
    setOracleHomeDirOverrideForTest(oracleHome);
    try {
      await expect(peekClaudeCodeSingleFlightLocks()).resolves.toEqual({
        busy: false,
        holders: [],
      });
    } finally {
      setOracleHomeDirOverrideForTest(null);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("reports busy with holder pid + age for a lock held by a live process", async () => {
    const { root, locksDir } = setupLocksHome();
    try {
      writeLock(locksDir, "claude-code-subscription.lock", {
        session_id: "live-session",
        pid: process.pid,
        nonce: "live-nonce",
        created_at: "2026-07-11T00:00:00.000Z",
      });
      const peek = await peekClaudeCodeSingleFlightLocks({
        now: () => Date.parse("2026-07-11T00:00:05.000Z"),
      });
      expect(peek.busy).toBe(true);
      expect(peek.holders).toEqual([
        {
          lock_path: path.join(locksDir, "claude-code-subscription.lock"),
          session_id: "live-session",
          holder_pid: process.pid,
          pid_alive: true,
          held_for_ms: 5_000,
        },
      ]);
    } finally {
      setOracleHomeDirOverrideForTest(null);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("surfaces a stale lock (dead holder pid) without marking the lane busy", async () => {
    const { root, locksDir } = setupLocksHome();
    try {
      writeLock(locksDir, "claude-code-subscription.lock", {
        session_id: "stale-session",
        pid: DEAD_PID,
        nonce: "stale-nonce",
        created_at: "2026-07-11T00:00:00.000Z",
      });
      const peek = await peekClaudeCodeSingleFlightLocks();
      expect(peek.busy).toBe(false);
      expect(peek.holders).toHaveLength(1);
      expect(peek.holders[0]).toMatchObject({
        session_id: "stale-session",
        holder_pid: DEAD_PID,
        pid_alive: false,
      });
    } finally {
      setOracleHomeDirOverrideForTest(null);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("scans caam profile-keyed locks and surfaces their profile", async () => {
    const { root, locksDir } = setupLocksHome();
    try {
      writeLock(locksDir, "claude-code-subscription-beta.lock", {
        session_id: "profile-session",
        pid: process.pid,
        nonce: "profile-nonce",
        created_at: "2026-07-11T00:00:00.000Z",
        caam_profile: "beta",
      });
      const peek = await peekClaudeCodeSingleFlightLocks();
      expect(peek.busy).toBe(true);
      expect(peek.holders).toHaveLength(1);
      expect(peek.holders[0]).toMatchObject({
        session_id: "profile-session",
        pid_alive: true,
        caam_profile: "beta",
      });
    } finally {
      setOracleHomeDirOverrideForTest(null);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("ignores unrelated files and skips unparseable lock files", async () => {
    const { root, locksDir } = setupLocksHome();
    try {
      fs.writeFileSync(path.join(locksDir, "unrelated.lock"), "not a claude lock\n");
      fs.writeFileSync(path.join(locksDir, "claude-code-subscription.lock"), "{ not valid json\n");
      const peek = await peekClaudeCodeSingleFlightLocks();
      expect(peek).toEqual({ busy: false, holders: [] });
    } finally {
      setOracleHomeDirOverrideForTest(null);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

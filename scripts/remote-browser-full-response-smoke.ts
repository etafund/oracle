#!/usr/bin/env tsx
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type SmokeLane = "chatgpt-pro" | "gemini-deep-think";
export type SmokeStatus = "pass" | "fail";

export interface RemoteEndpointSummary {
  _schema?: unknown;
  endpoint_id?: unknown;
  mode?: unknown;
  status?: unknown;
  host_env?: unknown;
  token_env?: unknown;
  host_hash?: unknown;
  auth_profile_id_hash?: unknown;
  provider_locks?: unknown;
  version?: unknown;
  uptimeSeconds?: unknown;
  error?: unknown;
}

export interface CliOptions {
  json: boolean;
  help: boolean;
  allBrowserLanes: boolean;
  lanes: SmokeLane[] | null;
  remoteHost?: string;
  tokenEnv?: string;
  oracleBin: string;
  minLength: number;
  operationalImplications: number;
  timeoutSeconds: number;
  inputTimeoutMs: number;
  slugPrefix: string;
  keepTemp: boolean;
  verbose: boolean;
}

export interface SmokeRequirements {
  marker: string;
  checksum: string;
  sentinel: string;
  minLength: number;
  operationalImplications: number;
}

export interface SmokeCheck {
  pass: boolean;
  observed?: number;
  expected?: number | string;
}

export interface SmokeValidation {
  pass: boolean;
  answerChars: number;
  operationalImplicationCount: number;
  checks: {
    marker: SmokeCheck;
    checksum: SmokeCheck;
    sentinel: SmokeCheck;
    minLength: SmokeCheck;
    operationalImplications: SmokeCheck;
  };
  missing: string[];
}

export interface CommandResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  elapsedMs: number;
}

export interface RunCommandInput {
  command: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}

export type RunCommand = (input: RunCommandInput) => Promise<CommandResult>;

export interface SmokeLaneResult {
  lane: SmokeLane;
  status: SmokeStatus;
  slug: string;
  session_id: string | null;
  elapsed_ms: number;
  command_exit_code: number | null;
  command_signal: string | null;
  timed_out: boolean;
  answer_chars: number;
  operational_implication_count: number;
  checks: SmokeValidation["checks"];
  missing: string[];
  output_path: string;
  attachment_path: string;
  stderr_excerpt?: string;
  answer_excerpt?: string;
}

export interface SmokeReport {
  _schema: "oracle_remote_full_response_smoke.v1";
  status: SmokeStatus;
  started_at: string;
  completed_at: string;
  elapsed_ms: number;
  requirements: {
    min_length: number;
    operational_implications: number;
  };
  remote: {
    status: string | null;
    endpoint_id: string | null;
    mode: string | null;
    host_env: string | null;
    token_env: string | null;
    host_hash: string | null;
    auth_profile_id_hash: string | null;
    provider_locks: string[];
    version: string | null;
    uptime_seconds: number | null;
  } | null;
  lanes: SmokeLaneResult[];
  error?: string;
}

interface RunSmokeDeps {
  runCommand?: RunCommand;
  now?: () => Date;
  randomBytes?: (size: number) => Buffer;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

const ALL_BROWSER_LANES: readonly SmokeLane[] = ["chatgpt-pro", "gemini-deep-think"];
const DEFAULT_MIN_LENGTH = 700;
const DEFAULT_OPERATIONAL_IMPLICATIONS = 3;
const DEFAULT_TIMEOUT_SECONDS = 900;
const DEFAULT_INPUT_TIMEOUT_MS = 120_000;
const DEFAULT_SLUG_PREFIX = "remote-full-response-smoke";

const scriptPath = fileURLToPath(import.meta.url);
const scriptDir = path.dirname(scriptPath);
const repoRoot = path.resolve(scriptDir, "..");
const defaultOracleBin = path.join(repoRoot, "bin", "oracle-cli.js");

const LANE_PROVIDER_LOCKS: Record<SmokeLane, RegExp> = {
  "chatgpt-pro": /\bchatgpt\b/i,
  "gemini-deep-think": /\bgemini\b/i,
};

export function usage(): string {
  return `Usage: pnpm tsx scripts/remote-browser-full-response-smoke.ts [options]

Runs a generated prompt plus attachment through configured remote browser lanes
and validates the captured answer for marker, checksum, sentinel, minimum length,
and Operational implication count.

Options:
  --json                              Emit machine-readable pass/fail JSON
  --lane <lane>                       Run one lane; repeatable. Known: ${ALL_BROWSER_LANES.join(", ")}
  --lanes <csv>                       Comma-separated lanes
  --all-browser-lanes                 Run every known remote-capable browser lane
  --remote-host <host:port>           Override ORACLE_REMOTE_HOST for this smoke
  --token-env <name>                  Copy this env var into ORACLE_REMOTE_TOKEN for child runs
  --oracle-bin <path-or-command>      Oracle CLI entrypoint (default: ${defaultOracleBin})
  --min-length <chars>                Required visible answer length (default: ${DEFAULT_MIN_LENGTH})
  --operational-implications <count>  Required "Operational implication:" count (default: ${DEFAULT_OPERATIONAL_IMPLICATIONS})
  --timeout-seconds <seconds>         Oracle run timeout per lane (default: ${DEFAULT_TIMEOUT_SECONDS})
  --input-timeout-ms <ms>             Browser input timeout (default: ${DEFAULT_INPUT_TIMEOUT_MS})
  --slug-prefix <prefix>              Session slug prefix (default: ${DEFAULT_SLUG_PREFIX})
  --keep-temp                         Keep generated attachment/output files
  --verbose                           Include short stderr/answer excerpts on failures
  -h, --help                          Show this help
`;
}

export function parseArgs(argv: readonly string[]): CliOptions {
  const lanes: SmokeLane[] = [];
  const options: CliOptions = {
    json: false,
    help: false,
    allBrowserLanes: false,
    lanes: null,
    oracleBin: defaultOracleBin,
    minLength: DEFAULT_MIN_LENGTH,
    operationalImplications: DEFAULT_OPERATIONAL_IMPLICATIONS,
    timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
    inputTimeoutMs: DEFAULT_INPUT_TIMEOUT_MS,
    slugPrefix: DEFAULT_SLUG_PREFIX,
    keepTemp: false,
    verbose: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--json":
        options.json = true;
        break;
      case "--text":
        options.json = false;
        break;
      case "--all-browser-lanes":
        options.allBrowserLanes = true;
        break;
      case "--lane":
        lanes.push(...parseLaneList(takeValue(argv, (index += 1), arg)));
        break;
      case "--lanes":
        lanes.push(...parseLaneList(takeValue(argv, (index += 1), arg)));
        break;
      case "--remote-host":
        options.remoteHost = takeValue(argv, (index += 1), arg);
        break;
      case "--token-env":
        options.tokenEnv = takeValue(argv, (index += 1), arg);
        break;
      case "--oracle-bin":
        options.oracleBin = takeValue(argv, (index += 1), arg);
        break;
      case "--min-length":
        options.minLength = parsePositiveInt(takeValue(argv, (index += 1), arg), arg);
        break;
      case "--operational-implications":
      case "--operational-implication-count":
        options.operationalImplications = parsePositiveInt(takeValue(argv, (index += 1), arg), arg);
        break;
      case "--timeout-seconds":
        options.timeoutSeconds = parsePositiveInt(takeValue(argv, (index += 1), arg), arg);
        break;
      case "--input-timeout-ms":
        options.inputTimeoutMs = parsePositiveInt(takeValue(argv, (index += 1), arg), arg);
        break;
      case "--slug-prefix":
        options.slugPrefix = sanitizeSlugPrefix(takeValue(argv, (index += 1), arg));
        break;
      case "--keep-temp":
        options.keepTemp = true;
        break;
      case "--verbose":
        options.verbose = true;
        break;
      case "-h":
      case "--help":
        options.help = true;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (lanes.length > 0) {
    options.lanes = dedupeLanes(lanes);
  }
  if (options.allBrowserLanes && options.lanes) {
    throw new Error("Use either --all-browser-lanes or explicit --lane/--lanes, not both.");
  }
  return options;
}

export function selectConfiguredLanes(
  endpoint: RemoteEndpointSummary | null,
  options: Pick<CliOptions, "lanes" | "allBrowserLanes">,
): SmokeLane[] {
  if (options.lanes) return options.lanes;
  if (options.allBrowserLanes) return [...ALL_BROWSER_LANES];

  const providerLocks = endpointProviderLocks(endpoint);
  const selected = ALL_BROWSER_LANES.filter((lane) =>
    providerLocks.some((providerLock) => LANE_PROVIDER_LOCKS[lane].test(providerLock)),
  );
  if (selected.length === 0) {
    throw new Error(
      "Remote endpoint did not report configured ChatGPT/Gemini provider locks. " +
        "Pass --lanes or --all-browser-lanes to run explicitly.",
    );
  }
  return selected;
}

export function buildAttachment(
  marker: string,
  sentinel: string,
): {
  content: string;
  checksum: string;
} {
  const payload = [
    "Oracle remote browser full-response smoke attachment.",
    `marker=${marker}`,
    `sentinel=${sentinel}`,
    `payload=remote-browser-smoke:${marker}:${sentinel}`,
  ].join("\n");
  const checksum = sha256(payload);
  return {
    content: `${payload}\npayload_sha256=${checksum}\n`,
    checksum,
  };
}

export function buildSmokePrompt(input: {
  marker: string;
  minLength: number;
  operationalImplications: number;
}): string {
  return [
    "Oracle remote browser full-response smoke.",
    "Read the attached text file before answering. The checksum and sentinel are only in that file.",
    `Run marker: ${input.marker}`,
    "",
    "Return Markdown only, with these exact labels:",
    `- Smoke marker: ${input.marker}`,
    "- Attachment checksum: <copy payload_sha256 from the attachment>",
    "- Attachment sentinel: <copy sentinel from the attachment>",
    "",
    `Then include at least ${input.operationalImplications} bullets. Each bullet must begin exactly: Operational implication:`,
    `The complete response must be at least ${input.minLength} visible characters.`,
    "Finish with a final line beginning exactly: Smoke result:",
  ].join("\n");
}

export function validateAnswer(answer: string, requirements: SmokeRequirements): SmokeValidation {
  const visible = answer.replace(/\s+/gu, " ").trim();
  const operationalImplicationCount = (answer.match(/\bOperational implication\s*:/gu) ?? [])
    .length;
  const checks: SmokeValidation["checks"] = {
    marker: {
      pass: answer.includes(requirements.marker),
      expected: requirements.marker,
    },
    checksum: {
      pass: answer.includes(requirements.checksum),
      expected: requirements.checksum,
    },
    sentinel: {
      pass: answer.includes(requirements.sentinel),
      expected: requirements.sentinel,
    },
    minLength: {
      pass: visible.length >= requirements.minLength,
      observed: visible.length,
      expected: requirements.minLength,
    },
    operationalImplications: {
      pass: operationalImplicationCount >= requirements.operationalImplications,
      observed: operationalImplicationCount,
      expected: requirements.operationalImplications,
    },
  };
  const missing = Object.entries(checks)
    .filter(([, check]) => !check.pass)
    .map(([name]) => name);
  return {
    pass: missing.length === 0,
    answerChars: visible.length,
    operationalImplicationCount,
    checks,
    missing,
  };
}

export function buildOracleInvocation(
  oracleBin: string,
  args: readonly string[],
): { command: string; args: string[] } {
  if (/\.ts$/iu.test(oracleBin)) {
    return { command: process.execPath, args: ["--import", "tsx", oracleBin, ...args] };
  }
  if (/\.(?:cjs|mjs|js)$/iu.test(oracleBin) || oracleBin.includes(path.sep)) {
    return { command: process.execPath, args: [oracleBin, ...args] };
  }
  return { command: oracleBin, args: [...args] };
}

export async function runRemoteFullResponseSmoke(
  options: CliOptions,
  deps: RunSmokeDeps = {},
): Promise<SmokeReport> {
  const runCommand = deps.runCommand ?? spawnCommand;
  const now = deps.now ?? (() => new Date());
  const random = deps.randomBytes ?? randomBytes;
  const cwd = deps.cwd ?? process.cwd();
  const env = buildChildEnv(options, deps.env ?? process.env);
  const startedAtDate = now();
  const startedAt = startedAtDate.toISOString();
  const runId = formatRunId(startedAtDate, random(4));
  const commandTimeoutMs = (options.timeoutSeconds + 90) * 1000;
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-full-smoke-"));

  let endpoint: RemoteEndpointSummary | null = null;
  const laneResults: SmokeLaneResult[] = [];

  try {
    const doctorInvocation = buildOracleInvocation(options.oracleBin, [
      "remote",
      "doctor",
      "--json",
    ]);
    const doctor = await runCommand({
      ...doctorInvocation,
      cwd,
      env,
      timeoutMs: 20_000,
    });
    endpoint = parseEndpointReport(doctor.stdout);
    if (!endpoint || endpoint.status !== "healthy") {
      return buildReport({
        status: "fail",
        startedAt,
        completedAt: now().toISOString(),
        requirements: options,
        endpoint,
        lanes: [],
        error:
          endpoint?.status && typeof endpoint.status === "string"
            ? `remote doctor status is ${endpoint.status}`
            : doctor.stderr.trim() || "remote doctor did not emit a healthy JSON report",
      });
    }

    const lanes = selectConfiguredLanes(endpoint, options);
    for (const lane of lanes) {
      const result = await runLaneSmoke({
        lane,
        runId,
        tempDir,
        cwd,
        env,
        options,
        commandTimeoutMs,
        runCommand,
        now,
        random,
      });
      laneResults.push(result);
    }

    return buildReport({
      status: laneResults.every((result) => result.status === "pass") ? "pass" : "fail",
      startedAt,
      completedAt: now().toISOString(),
      requirements: options,
      endpoint,
      lanes: laneResults,
    });
  } finally {
    if (!options.keepTemp) {
      await rm(tempDir, { recursive: true, force: true });
    }
  }
}

export function renderTextReport(report: SmokeReport): string {
  const lines: string[] = [];
  const laneSummary =
    report.lanes.length > 0
      ? `${report.lanes.filter((lane) => lane.status === "pass").length}/${report.lanes.length}`
      : "0/0";
  lines.push(`${report.status.toUpperCase()} remote browser full-response smoke (${laneSummary})`);
  if (report.remote) {
    const locks = report.remote.provider_locks.length
      ? report.remote.provider_locks.join(",")
      : "none";
    lines.push(
      `remote=${report.remote.status ?? "unknown"} endpoint=${report.remote.endpoint_id ?? "unknown"} provider_locks=${locks}`,
    );
  }
  if (report.error) {
    lines.push(`error=${report.error}`);
  }
  for (const lane of report.lanes) {
    const details = [
      `${lane.status.toUpperCase()} ${lane.lane}`,
      `${lane.answer_chars} chars`,
      `${lane.operational_implication_count} operational implications`,
      `session=${lane.session_id ?? lane.slug}`,
      `elapsed_ms=${lane.elapsed_ms}`,
    ];
    if (lane.status === "fail") {
      details.push(`missing=${lane.missing.length ? lane.missing.join(",") : "none"}`);
      if (lane.command_exit_code !== 0) {
        details.push(`exit=${lane.command_exit_code ?? "signal"}`);
      }
      if (lane.timed_out) {
        details.push("timed_out=true");
      }
    }
    lines.push(details.join(" "));
  }
  return lines.join("\n");
}

async function runLaneSmoke(input: {
  lane: SmokeLane;
  runId: string;
  tempDir: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  options: CliOptions;
  commandTimeoutMs: number;
  runCommand: RunCommand;
  now: () => Date;
  random: (size: number) => Buffer;
}): Promise<SmokeLaneResult> {
  const laneSlug = input.lane.replace(/[^a-z0-9]+/giu, "-");
  const marker = `ORACLE_REMOTE_SMOKE_MARKER_${input.runId}_${laneSlug.toUpperCase().replace(/-/gu, "_")}`;
  const sentinel = `ORACLE_REMOTE_SMOKE_SENTINEL_${input.random(5).toString("hex").toUpperCase()}`;
  const attachment = buildAttachment(marker, sentinel);
  const attachmentPath = path.join(input.tempDir, `${laneSlug}-attachment.txt`);
  const outputPath = path.join(input.tempDir, `${laneSlug}-answer.md`);
  await writeFile(attachmentPath, attachment.content, "utf8");
  const prompt = buildSmokePrompt({
    marker,
    minLength: input.options.minLength,
    operationalImplications: input.options.operationalImplications,
  });
  const slug = sanitizeSlugPrefix(`${input.options.slugPrefix}-${laneSlug}-${input.runId}`);
  const args = [
    "--lane",
    input.lane,
    "--remote-browser",
    "required",
    "--wait",
    "--heartbeat",
    "0",
    "--timeout",
    String(input.options.timeoutSeconds),
    "--browser-input-timeout",
    String(input.options.inputTimeoutMs),
    "--browser-attachments",
    "always",
    "--slug",
    slug,
    "--force",
    "--write-output",
    outputPath,
    "--prompt",
    prompt,
    "--file",
    attachmentPath,
  ];
  const invocation = buildOracleInvocation(input.options.oracleBin, args);
  const started = Date.now();
  const commandResult = await input.runCommand({
    ...invocation,
    cwd: input.cwd,
    env: input.env,
    timeoutMs: input.commandTimeoutMs,
  });
  const elapsedMs = commandResult.elapsedMs || Date.now() - started;
  const answer = await readAnswer(outputPath, commandResult);
  const validation = validateAnswer(answer, {
    marker,
    checksum: attachment.checksum,
    sentinel,
    minLength: input.options.minLength,
    operationalImplications: input.options.operationalImplications,
  });
  const commandPassed = commandResult.exitCode === 0 && !commandResult.timedOut;
  const status: SmokeStatus = commandPassed && validation.pass ? "pass" : "fail";
  const result: SmokeLaneResult = {
    lane: input.lane,
    status,
    slug,
    session_id: extractSessionId(`${commandResult.stdout}\n${commandResult.stderr}`),
    elapsed_ms: elapsedMs,
    command_exit_code: commandResult.exitCode,
    command_signal: commandResult.signal,
    timed_out: commandResult.timedOut,
    answer_chars: validation.answerChars,
    operational_implication_count: validation.operationalImplicationCount,
    checks: validation.checks,
    missing: validation.missing,
    output_path: outputPath,
    attachment_path: attachmentPath,
  };
  if (status === "fail" && input.options.verbose) {
    result.stderr_excerpt = excerpt(commandResult.stderr, 900);
    result.answer_excerpt = excerpt(answer, 900);
  }
  return result;
}

export async function spawnCommand(input: RunCommandInput): Promise<CommandResult> {
  const startedAt = Date.now();
  const detached = process.platform !== "win32";
  return new Promise((resolve, reject) => {
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      env: input.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;
    let settled = false;
    let killTimer: NodeJS.Timeout | null = null;
    const timer = setTimeout(() => {
      timedOut = true;
      terminateChild(child.pid, detached, "SIGTERM");
      killTimer = setTimeout(() => terminateChild(child.pid, detached, "SIGKILL"), 5_000);
    }, input.timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      reject(error);
    });
    child.on("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve({
        exitCode,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        timedOut,
        elapsedMs: Date.now() - startedAt,
      });
    });
  });
}

function buildChildEnv(options: CliOptions, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = {
    ...env,
    NO_COLOR: "1",
    FORCE_COLOR: "0",
  };
  if (options.remoteHost) {
    childEnv.ORACLE_REMOTE_HOST = options.remoteHost;
  }
  if (options.tokenEnv) {
    const token = env[options.tokenEnv];
    if (!token || token.trim().length === 0) {
      throw new Error(`--token-env ${options.tokenEnv} is unset or empty.`);
    }
    childEnv.ORACLE_REMOTE_TOKEN = token;
  }
  return childEnv;
}

function parseEndpointReport(stdout: string): RemoteEndpointSummary | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as RemoteEndpointSummary;
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      return JSON.parse(trimmed.slice(start, end + 1)) as RemoteEndpointSummary;
    } catch {
      return null;
    }
  }
}

function buildReport(input: {
  status: SmokeStatus;
  startedAt: string;
  completedAt: string;
  requirements: Pick<CliOptions, "minLength" | "operationalImplications">;
  endpoint: RemoteEndpointSummary | null;
  lanes: SmokeLaneResult[];
  error?: string;
}): SmokeReport {
  const startedMs = Date.parse(input.startedAt);
  const completedMs = Date.parse(input.completedAt);
  return {
    _schema: "oracle_remote_full_response_smoke.v1",
    status: input.status,
    started_at: input.startedAt,
    completed_at: input.completedAt,
    elapsed_ms:
      Number.isFinite(startedMs) && Number.isFinite(completedMs)
        ? Math.max(0, completedMs - startedMs)
        : 0,
    requirements: {
      min_length: input.requirements.minLength,
      operational_implications: input.requirements.operationalImplications,
    },
    remote: summarizeEndpoint(input.endpoint),
    lanes: input.lanes,
    ...(input.error ? { error: input.error } : {}),
  };
}

function summarizeEndpoint(endpoint: RemoteEndpointSummary | null): SmokeReport["remote"] {
  if (!endpoint) return null;
  return {
    status: stringOrNull(endpoint.status),
    endpoint_id: stringOrNull(endpoint.endpoint_id),
    mode: stringOrNull(endpoint.mode),
    host_env: stringOrNull(endpoint.host_env),
    token_env: stringOrNull(endpoint.token_env),
    host_hash: stringOrNull(endpoint.host_hash),
    auth_profile_id_hash: stringOrNull(endpoint.auth_profile_id_hash),
    provider_locks: endpointProviderLocks(endpoint),
    version: stringOrNull(endpoint.version),
    uptime_seconds: typeof endpoint.uptimeSeconds === "number" ? endpoint.uptimeSeconds : null,
  };
}

function endpointProviderLocks(endpoint: RemoteEndpointSummary | null): string[] {
  if (!endpoint || !Array.isArray(endpoint.provider_locks)) return [];
  return endpoint.provider_locks.filter((entry): entry is string => typeof entry === "string");
}

async function readAnswer(outputPath: string, commandResult: CommandResult): Promise<string> {
  if (existsSync(outputPath)) {
    const answer = await readFile(outputPath, "utf8");
    if (answer.trim().length > 0) return answer;
  }
  return `${commandResult.stdout}\n${commandResult.stderr}`;
}

function extractSessionId(output: string): string | null {
  const matches = [...output.matchAll(/\boracle session\s+([A-Za-z0-9_.:-]+)/gu)];
  const last = matches.at(-1);
  return last?.[1] ?? null;
}

function parseLaneList(raw: string): SmokeLane[] {
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      if (ALL_BROWSER_LANES.includes(entry as SmokeLane)) return entry as SmokeLane;
      throw new Error(`Unknown lane: ${entry}`);
    });
}

function dedupeLanes(lanes: readonly SmokeLane[]): SmokeLane[] {
  return [...new Set(lanes)];
}

function takeValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function parsePositiveInt(raw: string, flag: string): number {
  if (!/^\d+$/u.test(raw)) {
    throw new Error(`${flag} requires a positive integer.`);
  }
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${flag} requires a positive integer.`);
  }
  return value;
}

function sanitizeSlugPrefix(input: string): string {
  const slug = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  if (!slug) throw new Error("--slug-prefix must contain at least one slug-safe character.");
  return slug.slice(0, 140);
}

function formatRunId(date: Date, bytes: Buffer): string {
  const stamp = date
    .toISOString()
    .replace(/[-:.TZ]/gu, "")
    .slice(0, 14);
  return `${stamp}-${bytes.toString("hex")}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function excerpt(value: string, maxChars: number): string {
  const compact = value.replace(/\s+/gu, " ").trim();
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, maxChars)}...`;
}

function terminateChild(pid: number | undefined, detached: boolean, signal: NodeJS.Signals): void {
  if (!pid) return;
  try {
    if (detached && process.platform !== "win32") {
      process.kill(-pid, signal);
    } else {
      process.kill(pid, signal);
    }
  } catch {
    // Process already exited.
  }
}

async function main(): Promise<void> {
  let options: CliOptions;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error("Run with --help for usage.");
    process.exitCode = 2;
    return;
  }

  if (options.help) {
    console.log(usage());
    return;
  }

  try {
    const report = await runRemoteFullResponseSmoke(options);
    console.log(options.json ? JSON.stringify(report, null, 2) : renderTextReport(report));
    process.exitCode = report.status === "pass" ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (options.json) {
      const now = new Date().toISOString();
      const report = buildReport({
        status: "fail",
        startedAt: now,
        completedAt: now,
        requirements: options,
        endpoint: null,
        lanes: [],
        error: message,
      });
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(`FAIL remote browser full-response smoke (0/0)\nerror=${message}`);
    }
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  void main();
}

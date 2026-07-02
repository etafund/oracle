#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const generatedDir = path.join(here, "generated", "spike11");
const outJson = path.join(here, "spike11-lifecycle-lock-results.json");
const outMd = path.join(here, "spike11-lifecycle-lock-report.md");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error && typeof error === "object" && error.code === "EPERM";
  }
}

function killProcessGroup(pid, signal) {
  if (process.platform === "win32") {
    process.kill(pid, signal);
    return;
  }
  process.kill(-pid, signal);
}

async function fakeMain(mode) {
  if (mode === "grandchild") {
    process.on("SIGTERM", () => {});
    process.stdout.write(`grandchild-ready:${process.pid}\n`);
    setInterval(() => {}, 1000);
    return;
  }
  if (mode === "grandchild-ignore-term") {
    process.on("SIGTERM", () => {
      process.stdout.write("child-ignored-sigterm\n");
    });
    const grandchild = spawn(process.execPath, [fileURLToPath(import.meta.url), "--fake", "grandchild"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    grandchild.stdout.on("data", (chunk) => process.stdout.write(chunk));
    grandchild.stderr.on("data", (chunk) => process.stderr.write(chunk));
    process.stdout.write(`child-ready:${process.pid}\n`);
    setInterval(() => {}, 1000);
    return;
  }
  if (mode === "partial-hang") {
    process.stdout.write('{"type":"assistant","text":"partial');
    setInterval(() => {}, 1000);
    return;
  }
  if (mode === "stdin-hang") {
    process.stdout.write("waiting-for-stdin\n");
    process.stdin.resume();
    setInterval(() => {}, 1000);
    return;
  }
  if (mode === "nonzero") {
    process.stdout.write('{"type":"message","text":"before failure"}\n');
    process.stderr.write("synthetic stderr before nonzero\n");
    process.exit(42);
  }
  if (mode === "flood") {
    const chunk = Buffer.alloc(64 * 1024, "a");
    const errChunk = Buffer.alloc(64 * 1024, "e");
    const write = async (stream, data) => {
      if (stream.write(data)) return;
      await new Promise((resolve) => stream.once("drain", resolve));
    };
    for (let i = 0; i < 64; i += 1) {
      await write(process.stdout, chunk);
      await write(process.stderr, errChunk);
    }
    await write(process.stdout, Buffer.from("\n"));
    process.exit(0);
  }
  if (mode === "startup-mismatch") {
    process.stdout.write(
      `${JSON.stringify({
        type: "system",
        subtype: "init",
        apiKeySource: "api_key",
        model: "claude-sonnet",
        tools: [],
      })}\n`,
    );
    setInterval(() => {}, 1000);
    return;
  }
  if (mode === "read-only-violation") {
    process.stdout.write(
      `${JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "/etc/passwd" } }] },
      })}\n`,
    );
    setInterval(() => {}, 1000);
    return;
  }
  throw new Error(`unknown fake mode: ${mode}`);
}

async function terminateChild(child, reason, graceMs = 150) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { reason, sent: [], groupAliveAfter: false };
  }
  const sent = [];
  try {
    killProcessGroup(child.pid, "SIGTERM");
    sent.push("SIGTERM");
  } catch (error) {
    sent.push(`SIGTERM_FAILED:${error.code ?? error.message}`);
  }
  await sleep(graceMs);
  if (isAlive(child.pid)) {
    try {
      killProcessGroup(child.pid, "SIGKILL");
      sent.push("SIGKILL");
    } catch (error) {
      sent.push(`SIGKILL_FAILED:${error.code ?? error.message}`);
    }
  }
  await sleep(150);
  return {
    reason,
    sent,
    groupAliveAfter: isAlive(child.pid),
  };
}

function verifierFor(mode) {
  let buffered = "";
  return (chunk) => {
    buffered += chunk.toString("utf8");
    const lines = buffered.split(/\n/u);
    buffered = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim().startsWith("{")) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (mode === "startup-mismatch" && event.type === "system") {
        if (event.apiKeySource !== "oauth" || event.model !== "claude-fable-5") {
          return "startup_mismatch";
        }
      }
      if (mode === "read-only-violation") {
        const content = event.message?.content;
        if (Array.isArray(content) && content.some((entry) => entry.type === "tool_use")) {
          return "read_only_violation";
        }
      }
    }
    return null;
  };
}

async function runMode(mode, options = {}) {
  const timeoutMs = options.timeoutMs ?? 500;
  const maxStdoutBytes = options.maxStdoutBytes ?? 2 * 1024 * 1024;
  const maxStderrBytes = options.maxStderrBytes ?? 2 * 1024 * 1024;
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--fake", mode], {
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
  });
  const startedAt = Date.now();
  const stdoutChunks = [];
  const stderrChunks = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let killInfo = null;
  let killRequestReason = null;
  let killPromise = null;
  let verifierReason = null;
  const verify = verifierFor(mode);
  const pids = { child: child.pid, grandchildren: [] };

  const maybeKill = async (reason) => {
    if (killRequestReason) return;
    killRequestReason = reason;
    killPromise = terminateChild(child, reason);
    killInfo = await killPromise;
  };

  child.stdout.on("data", (chunk) => {
    stdoutBytes += chunk.length;
    if (stdoutBytes <= maxStdoutBytes) stdoutChunks.push(chunk);
    const text = chunk.toString("utf8");
    for (const match of text.matchAll(/grandchild-ready:(\d+)/g)) {
      pids.grandchildren.push(Number(match[1]));
    }
    const reason = verify(chunk);
    if (reason && !verifierReason) {
      verifierReason = reason;
      void maybeKill(reason);
    }
    if (stdoutBytes > maxStdoutBytes) {
      void maybeKill("stdout_flood_limit");
    }
  });
  child.stderr.on("data", (chunk) => {
    stderrBytes += chunk.length;
    if (stderrBytes <= maxStderrBytes) stderrChunks.push(chunk);
    if (stderrBytes > maxStderrBytes) {
      void maybeKill("stderr_flood_limit");
    }
  });

  const timeout = setTimeout(() => {
    void maybeKill("timeout");
  }, timeoutMs);

  const exit = await new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  if (killPromise) {
    killInfo = await killPromise;
  }
  clearTimeout(timeout);
  if (child.stdin && !child.stdin.destroyed) child.stdin.destroy();
  await sleep(100);

  const stdout = Buffer.concat(stdoutChunks).toString("utf8");
  const stderr = Buffer.concat(stderrChunks).toString("utf8");
  const descendantAlive = pids.grandchildren.filter(isAlive);
  if (descendantAlive.length > 0 && !killInfo) {
    killRequestReason = killRequestReason ?? "descendant_cleanup";
    killInfo = await terminateChild(child, "descendant_cleanup");
  }
  const killedByHarness = Boolean(killRequestReason || killInfo);

  return {
    mode,
    pid: child.pid,
    pids,
    exit,
    elapsedMs: Date.now() - startedAt,
    killedByHarness,
    killInfo: killInfo ?? (killRequestReason ? { reason: killRequestReason, sent: [] } : null),
    verifierReason,
    stdoutBytes,
    stderrBytes,
    stdoutPreview: stdout.slice(0, 200),
    stderrPreview: stderr.slice(0, 200),
    partialRawBytesPreserved: stdoutBytes > 0 || stderrBytes > 0,
    streamsComplete: !killedByHarness && !exit.signal,
    eventsComplete: !killInfo && exit.code === 0,
    childAliveAfter: isAlive(child.pid),
    descendantAliveAfter: pids.grandchildren.filter(isAlive),
  };
}

function lockPaths(root) {
  return {
    root,
    lockDir: path.join(root, "fable-local.lock"),
    owner: path.join(root, "fable-local.lock", "owner.json"),
  };
}

async function readOwner(ownerPath) {
  try {
    return JSON.parse(await fs.readFile(ownerPath, "utf8"));
  } catch {
    return null;
  }
}

async function acquireLock(root, options = {}) {
  const { lockDir, owner } = lockPaths(root);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const token = randomUUID();
  const started = Date.now();
  const waitMs = options.waitMs ?? 0;
  const staleMs = options.staleMs ?? 30_000;
  const pollMs = options.pollMs ?? 25;

  for (;;) {
    try {
      await fs.mkdir(lockDir, { mode: 0o700 });
      const record = {
        schema_version: "fable_local_lock.v1",
        token,
        pid: options.pid ?? process.pid,
        session_id: options.sessionId ?? "spike11",
        created_at: new Date().toISOString(),
      };
      await fs.writeFile(owner, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      return {
        acquired: true,
        token,
        record,
        release: async () => {
          const current = await readOwner(owner);
          if (current?.token === token) {
            await fs.rm(lockDir, { recursive: true, force: true });
            return true;
          }
          return false;
        },
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const current = await readOwner(owner);
      if (!current) {
        const err = new Error(
          `fable-local lock is corrupt or unreadable at ${owner}; recover with an audited lock recovery command`,
        );
        err.code = "FABLE_LOCAL_LOCK_CORRUPT";
        throw err;
      }
      const lockStat = await fs.stat(lockDir).catch(() => null);
      const deadOwner = current?.pid && !isAlive(current.pid);
      const staleByAge = lockStat && Date.now() - lockStat.mtimeMs > staleMs;
      if (deadOwner || staleByAge) {
        await fs.rm(lockDir, { recursive: true, force: true });
        continue;
      }
      if (Date.now() - started >= waitMs) {
        const err = new Error(
          `fable-local busy: lock held by pid ${current?.pid ?? "unknown"} session ${
            current?.session_id ?? "unknown"
          }`,
        );
        err.code = "FABLE_LOCAL_BUSY";
        err.owner = current;
        throw err;
      }
      await sleep(Math.min(pollMs, Math.max(1, waitMs - (Date.now() - started))));
    }
  }
}

async function runLockDrill() {
  const root = path.join(generatedDir, "lock-drill");
  await fs.rm(root, { recursive: true, force: true });
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const events = [];

  const first = await acquireLock(root, { sessionId: "happy" });
  events.push({ case: "happy-acquire", acquired: first.acquired, owner: first.record });
  events.push({ case: "happy-release", released: await first.release() });

  const held = await acquireLock(root, { sessionId: "held" });
  try {
    await acquireLock(root, { waitMs: 0, sessionId: "contender" });
    events.push({ case: "fail-fast-contention", unexpected: "acquired" });
  } catch (error) {
    events.push({
      case: "fail-fast-contention",
      code: error.code,
      message: error.message,
      owner: error.owner,
    });
  }
  await held.release();

  const waitHeld = await acquireLock(root, { sessionId: "wait-held" });
  setTimeout(() => {
    void waitHeld.release();
  }, 100);
  const waited = await acquireLock(root, { waitMs: 1000, pollMs: 20, sessionId: "wait-contender" });
  events.push({ case: "wait-for-lock", acquired: waited.acquired, owner: waited.record });
  await waited.release();

  const { lockDir, owner } = lockPaths(root);
  await fs.mkdir(lockDir, { recursive: true, mode: 0o700 });
  await fs.writeFile(
    owner,
    `${JSON.stringify({
      schema_version: "fable_local_lock.v1",
      token: "dead-owner",
      pid: 99999999,
      session_id: "dead-owner-session",
      created_at: new Date(Date.now() - 60_000).toISOString(),
    })}\n`,
    { mode: 0o600 },
  );
  const recovered = await acquireLock(root, { sessionId: "stale-recovered", staleMs: 30_000 });
  events.push({ case: "stale-dead-pid-recovery", acquired: recovered.acquired, owner: recovered.record });
  await recovered.release();

  await fs.mkdir(lockDir, { recursive: true, mode: 0o700 });
  await fs.writeFile(owner, "{not-json", { mode: 0o600 });
  try {
    await acquireLock(root, { waitMs: 0, sessionId: "corrupt-contender" });
    events.push({ case: "corrupt-lock", unexpected: "acquired" });
  } catch (error) {
    events.push({
      case: "corrupt-lock",
      code: error.code,
      message: error.message,
      recommendation: "block with recovery command; do not silently delete corrupt lock without audit",
    });
  }
  await fs.rm(lockDir, { recursive: true, force: true });

  return events;
}

async function harnessMain() {
  await fs.rm(generatedDir, { recursive: true, force: true });
  await fs.mkdir(generatedDir, { recursive: true });

  const lifecycleCases = [];
  for (const spec of [
    ["partial-hang", { timeoutMs: 350 }],
    ["stdin-hang", { timeoutMs: 350 }],
    ["nonzero", { timeoutMs: 1000 }],
    ["flood", { timeoutMs: 1000, maxStdoutBytes: 2 * 1024 * 1024, maxStderrBytes: 2 * 1024 * 1024 }],
    ["startup-mismatch", { timeoutMs: 1000 }],
    ["read-only-violation", { timeoutMs: 1000 }],
    ["grandchild-ignore-term", { timeoutMs: 350 }],
  ]) {
    lifecycleCases.push(await runMode(spec[0], spec[1]));
  }

  const lockEvents = await runLockDrill();
  const result = {
    generatedAt: new Date().toISOString(),
    spike: 11,
    platform: process.platform,
    processGroupKillSupported: process.platform !== "win32",
    lifecycleCases,
    lockEvents,
    blockedOsSpecificChecks:
      process.platform === "win32"
        ? ["POSIX process-group kill and pid ownership checks were not exercised on Windows."]
        : ["macOS process tree behavior was not exercised on this Linux host."],
    recommendedFailureArtifacts: [
      "claude-code-stdout.raw",
      "claude-code-stderr.raw",
      "claude-code-events.ndjson",
      "claude-code-adapter.json",
      "lock-owner.json copied into session artifacts on busy/stale failures",
    ],
  };
  await fs.writeFile(outJson, `${JSON.stringify(result, null, 2)}\n`, "utf8");

  const lifecycleRows = lifecycleCases
    .map(
      (c) =>
        `| ${c.mode} | ${c.exit.code ?? ""}/${c.exit.signal ?? ""} | ${c.killedByHarness} | ${
          c.killInfo?.reason ?? c.verifierReason ?? "none"
        } | ${c.stdoutBytes}/${c.stderrBytes} | ${c.childAliveAfter} | ${
          c.descendantAliveAfter.length
        } | ${c.eventsComplete} |`,
    )
    .join("\n");
  const lockRows = lockEvents
    .map((e) => `| ${e.case} | ${e.acquired ?? e.released ?? e.code ?? "observed"} | ${e.message ?? ""} |`)
    .join("\n");

  await fs.writeFile(
    outMd,
    `# Spike 11 Lifecycle And Lock Harness\n\n` +
      `Generated: ${result.generatedAt}\n\n` +
      `## Lifecycle Cases\n\n` +
      `| Case | Exit Code/Signal | Killed | Reason | Stdout/Stderr Bytes | Child Alive | Descendants Alive | Events Complete |\n` +
      `| --- | --- | --- | --- | --- | --- | --- | --- |\n` +
      `${lifecycleRows}\n\n` +
      `## Lock Cases\n\n` +
      `| Case | Result | Message |\n` +
      `| --- | --- | --- |\n` +
      `${lockRows}\n\n` +
      `## Notes\n\n` +
      `- POSIX process-group cleanup used detached child process groups and negative-pid SIGTERM/SIGKILL.\n` +
      `- Partial stdout/stderr byte counts are recorded even for killed verifier and timeout cases.\n` +
      `- Corrupt lock handling should block with recovery guidance, not silently delete.\n`,
    "utf8",
  );

  console.log(JSON.stringify({ outJson, outMd, lifecycleCases: lifecycleCases.length, lockCases: lockEvents.length }, null, 2));
}

if (process.argv[2] === "--fake") {
  await fakeMain(process.argv[3]);
} else {
  await harnessMain();
}

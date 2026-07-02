#!/usr/bin/env node
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const outJson = path.join(here, "spike8-executable-provenance.json");
const outMd = path.join(here, "spike8-executable-provenance.md");
const tempRoot = path.join(os.homedir(), ".cache", "oracle-spike-worker-d-exec-provenance");
const repoShadowDir = path.join(here, "generated", "spike8-repo-shadow");

function uid() {
  return typeof process.getuid === "function" ? process.getuid() : null;
}

function isExecutableMode(mode) {
  return Boolean(mode & 0o111);
}

function modeString(mode) {
  return `0${(mode & 0o7777).toString(8)}`;
}

function inside(parent, child) {
  const rel = path.relative(parent, child);
  return rel === "" || (rel && !rel.startsWith("..") && !path.isAbsolute(rel));
}

async function writeFixture(file, data, mode = 0o755) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o755 });
  await fs.writeFile(file, data, { mode });
  await fs.chmod(file, mode);
}

async function setupFixtures() {
  await fs.rm(tempRoot, { recursive: true, force: true });
  await fs.rm(repoShadowDir, { recursive: true, force: true });
  await fs.mkdir(tempRoot, { recursive: true, mode: 0o755 });
  await fs.mkdir(repoShadowDir, { recursive: true, mode: 0o755 });

  const safeBin = path.join(tempRoot, "safe", "bin", "claude");
  const nodeWrapper = path.join(tempRoot, "node-wrapper", "bin", "claude");
  const shellWrapper = path.join(tempRoot, "shell-wrapper", "bin", "claude");
  const worldWritable = path.join(tempRoot, "world-writable", "bin", "claude");
  const symlinkSafe = path.join(tempRoot, "symlink-safe", "bin", "claude");
  const symlinkRepo = path.join(tempRoot, "symlink-repo", "bin", "claude");
  const repoShadow = path.join(repoShadowDir, "claude");
  const noExec = path.join(tempRoot, "no-exec", "bin", "claude");

  await writeFixture(safeBin, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x00]));
  await writeFixture(
    nodeWrapper,
    "#!/usr/bin/env node\nimport './cli.js';\n",
  );
  await writeFixture(
    shellWrapper,
    "#!/bin/sh\nexec \"$PWD/claude-real\" \"$@\"\n",
  );
  await fs.mkdir(path.dirname(worldWritable), { recursive: true, mode: 0o777 });
  await fs.chmod(path.dirname(worldWritable), 0o777);
  await writeFixture(worldWritable, Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
  await fs.mkdir(path.dirname(symlinkSafe), { recursive: true, mode: 0o755 });
  await fs.symlink(safeBin, symlinkSafe);
  await writeFixture(repoShadow, Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
  await fs.mkdir(path.dirname(symlinkRepo), { recursive: true, mode: 0o755 });
  await fs.symlink(repoShadow, symlinkRepo);
  await writeFixture(noExec, Buffer.from([0x7f, 0x45, 0x4c, 0x46]), 0o644);

  return [
    { id: "absolute-safe-binary", candidate: safeBin },
    { id: "audited-node-wrapper", candidate: nodeWrapper },
    { id: "relative-path", candidate: "claude" },
    { id: "repo-local-shadow", candidate: repoShadow },
    { id: "world-writable-component", candidate: worldWritable },
    { id: "safe-symlink-chain", candidate: symlinkSafe },
    { id: "symlink-into-repo", candidate: symlinkRepo },
    { id: "dangerous-shell-wrapper", candidate: shellWrapper },
    { id: "not-executable", candidate: noExec },
  ];
}

async function componentStats(realPath) {
  const parsed = path.parse(realPath);
  const segments = path.relative(parsed.root, realPath).split(path.sep).filter(Boolean);
  const rows = [];
  let current = parsed.root;
  for (const segment of segments) {
    current = path.join(current, segment);
    try {
      const st = await fs.lstat(current);
      rows.push({
        path: current,
        uid: st.uid,
        gid: st.gid,
        mode: modeString(st.mode),
        worldWritable: Boolean(st.mode & 0o002),
        isSymbolicLink: st.isSymbolicLink(),
      });
    } catch (error) {
      rows.push({ path: current, error: String(error) });
      break;
    }
  }
  return rows;
}

async function symlinkChain(candidate) {
  const chain = [];
  let current = path.resolve(candidate);
  const seen = new Set();
  for (let i = 0; i < 16; i += 1) {
    if (seen.has(current)) break;
    seen.add(current);
    let st;
    try {
      st = await fs.lstat(current);
    } catch {
      break;
    }
    if (!st.isSymbolicLink()) break;
    const target = await fs.readlink(current);
    const resolvedTarget = path.resolve(path.dirname(current), target);
    chain.push({ link: current, target, resolvedTarget });
    current = resolvedTarget;
  }
  return chain;
}

async function inspectWrapper(realPath) {
  try {
    const fd = await fs.open(realPath, "r");
    try {
      const buffer = Buffer.alloc(512);
      const { bytesRead } = await fd.read(buffer, 0, buffer.length, 0);
      const prefix = buffer.subarray(0, bytesRead);
      if (prefix[0] === 0x7f && prefix[1] === 0x45 && prefix[2] === 0x4c && prefix[3] === 0x46) {
        return { kind: "native-binary" };
      }
      const text = prefix.toString("utf8");
      const firstLine = text.split(/\r?\n/u)[0] ?? "";
      if (!firstLine.startsWith("#!")) return { kind: "unknown-text" };
      const shell = /\/(?:ba)?sh(?:\s|$)/u.test(firstLine);
      const node = /\bnode\b/u.test(firstLine);
      const dynamicCwd = /\$PWD|\$\(pwd\)|`pwd`/u.test(text);
      if (shell && dynamicCwd) {
        return { kind: "shell-wrapper-danger", firstLine, dynamicCwd };
      }
      if (node) {
        return { kind: "node-wrapper-audit-required", firstLine };
      }
      return { kind: shell ? "shell-wrapper-audit-required" : "script-wrapper-audit-required", firstLine };
    } finally {
      await fd.close();
    }
  } catch (error) {
    return { kind: "unreadable", error: String(error) };
  }
}

async function classify(candidate) {
  const raw = candidate;
  const reasons = [];
  if (!path.isAbsolute(raw)) {
    return {
      raw,
      outcome: "deny",
      reasonCodes: ["relative_path_refused"],
      spawnPolicy: "do_not_spawn",
    };
  }

  const absolute = path.resolve(raw);
  const chain = await symlinkChain(absolute);
  let real;
  try {
    real = await fs.realpath(absolute);
  } catch (error) {
    return {
      raw,
      absolute,
      outcome: "deny",
      reasonCodes: ["realpath_failed"],
      error: String(error),
      symlinkChain: chain,
      spawnPolicy: "do_not_spawn",
    };
  }

  let st;
  try {
    st = await fs.stat(real);
  } catch (error) {
    return {
      raw,
      absolute,
      realpath: real,
      outcome: "deny",
      reasonCodes: ["stat_failed"],
      error: String(error),
      symlinkChain: chain,
      spawnPolicy: "do_not_spawn",
    };
  }

  if (!st.isFile()) reasons.push("not_regular_file");
  if (!isExecutableMode(st.mode)) reasons.push("not_executable");
  if (inside(repoRoot, absolute) || inside(repoRoot, real)) reasons.push("repo_local_path_refused");

  const components = await componentStats(real);
  if (components.some((entry) => entry.worldWritable)) reasons.push("world_writable_path_component");

  const wrapper = await inspectWrapper(real);
  if (wrapper.kind === "shell-wrapper-danger") reasons.push("dangerous_shell_wrapper");
  if (wrapper.kind === "unknown-text" || wrapper.kind === "unreadable") reasons.push("untrusted_wrapper_shape");

  const currentUid = uid();
  if (currentUid !== null && st.uid !== currentUid && st.uid !== 0) {
    reasons.push("owner_not_current_user_or_root");
  }

  const allow = reasons.length === 0 || (reasons.length === 0 && wrapper.kind === "node-wrapper-audit-required");
  const wrapperAudit = wrapper.kind === "node-wrapper-audit-required" && reasons.length === 0;
  return {
    raw,
    absolute,
    realpath: real,
    symlinkChain: chain,
    file: {
      uid: st.uid,
      gid: st.gid,
      mode: modeString(st.mode),
      size: st.size,
    },
    components,
    wrapper,
    outcome: reasons.length === 0 ? (wrapperAudit ? "allow_with_wrapper_audit" : "allow") : "deny",
    reasonCodes: reasons,
    spawnPolicy: reasons.length === 0 ? "spawn_absolute_shell_false_prompt_on_stdin" : "do_not_spawn",
  };
}

function findPathCandidates(name) {
  const entries = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  const found = [];
  for (const dir of entries) {
    const candidate = path.join(dir, name);
    try {
      fsSync.accessSync(candidate, fsSync.constants.X_OK);
      found.push(candidate);
    } catch {
      // keep scanning
    }
  }
  return found;
}

const fixtureCases = await setupFixtures();
const fixtureResults = [];
for (const fixture of fixtureCases) {
  fixtureResults.push({ id: fixture.id, ...(await classify(fixture.candidate)) });
}

const actualCandidates = findPathCandidates(process.platform === "win32" ? "claude.cmd" : "claude");
const actualResults = [];
for (const candidate of actualCandidates) {
  actualResults.push(await classify(candidate));
}

const result = {
  generatedAt: new Date().toISOString(),
  spike: 8,
  platform: process.platform,
  repoRoot,
  tempRoot,
  fixtureResults,
  actualClaudeCandidates: actualResults,
  actualClaudeCandidateCount: actualResults.length,
  spawnInvariant: {
    executable: "absolute realpath selected by resolver",
    shell: false,
    argvPromptBytes: false,
    promptTransport: "stdin",
    cwd: "explicit project cwd after local-owner guard",
  },
  blockedOsSpecificChecks:
    process.platform === "win32"
      ? ["Windows case-insensitive PATH/PATHEXT and ACL owner checks were not exercised in this Linux run."]
      : ["macOS Gatekeeper/quarantine/notarization metadata was not available on this Linux host."],
};

await fs.writeFile(outJson, `${JSON.stringify(result, null, 2)}\n`, "utf8");

const rows = fixtureResults
  .map(
    (r) =>
      `| ${r.id} | ${r.outcome} | ${r.reasonCodes.length ? r.reasonCodes.join(", ") : "none"} | ${
        r.realpath ?? r.absolute ?? r.raw
      } |`,
  )
  .join("\n");
const actualRows =
  actualResults.length === 0
    ? "| PATH scan | not-found | none | No executable named claude found on PATH |"
    : actualResults
        .map(
          (r, index) =>
            `| PATH ${index + 1} | ${r.outcome} | ${
              r.reasonCodes.length ? r.reasonCodes.join(", ") : "none"
            } | ${r.realpath ?? r.raw} |`,
        )
        .join("\n");

await fs.writeFile(
  outMd,
  `# Spike 8 Executable Provenance\n\n` +
    `Generated: ${result.generatedAt}\n\n` +
    `## Fixture Matrix\n\n` +
    `| Case | Outcome | Reason Codes | Resolved Path |\n` +
    `| --- | --- | --- | --- |\n` +
    `${rows}\n\n` +
    `## Actual PATH Scan\n\n` +
    `| Case | Outcome | Reason Codes | Resolved Path |\n` +
    `| --- | --- | --- | --- |\n` +
    `${actualRows}\n\n` +
    `## Spawn Invariant\n\n` +
    `- Absolute resolved executable only\n` +
    `- child_process.spawn with shell:false\n` +
    `- Prompt bytes on stdin, never argv\n` +
    `- Deny repo-local, relative, world-writable, unsafe symlink, and dangerous shell wrapper candidates\n`,
  "utf8",
);

await fs.rm(tempRoot, { recursive: true, force: true });

console.log(JSON.stringify({ outJson, outMd, fixtureCases: fixtureResults.length, actualClaudeCandidateCount: actualResults.length }, null, 2));

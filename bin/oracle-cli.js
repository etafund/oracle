#!/usr/bin/env node
// Dual-mode dev shim for bin/oracle-cli (oracle-ghf + oracle-uym).
//
// Two distinct callers need this file:
//
//   1. Smoke scripts invoking `node bin/oracle-cli.js --help` — they
//      need a working CLI even though the source lives in
//      bin/oracle-cli.ts. We spawn a child node with `--import tsx`
//      and forward stdio + exit code + signal.
//
//   2. Unit tests doing `import { enforceBrowserSearchFlag } from
//      "../../bin/oracle-cli.js"` — they expect the .js path to
//      resolve to the .ts source's named exports (the vitest/tsx
//      `.js → .ts` resolution rule from before this shim existed).
//      We re-export those symbols via a top-level dynamic import.
//
// Both modes are runtime-detected: only the script-invocation path
// spawns the child, and only the module-import path needs the
// dynamic re-export to succeed.

import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const tsEntrypoint = path.join(here, "oracle-cli.ts");

const argvScript = process.argv[1];
const isInvokedAsScript =
  typeof argvScript === "string" && pathToFileURL(argvScript).href === import.meta.url;

// ─── Module-import mode: re-export the .ts source symbols ───────────────────
//
// Under vitest / tsx / any other loader that handles .ts, the dynamic
// import below resolves and exposes the named exports. Under plain
// node (no tsx loader), the import throws ERR_UNKNOWN_FILE_EXTENSION;
// we swallow the error so the spawn-child path can still run.
//
// Keep the export surface explicit (rather than `export * from`) so
// the static analysis tools see what's actually re-exported.

let tsModule;
try {
  tsModule = await import("./oracle-cli.ts");
} catch {
  // Plain node without tsx — expected when this file is invoked as
  // a script. We do NOT log because the spawn-child path below will
  // produce its own output via the child process. The error is only
  // a problem if a caller imports this file under plain node, which
  // is an unsupported usage.
  tsModule = {};
}

export const enforceBrowserSearchFlag = tsModule.enforceBrowserSearchFlag;
export const warnGeminiIgnoredThinkingTime = tsModule.warnGeminiIgnoredThinkingTime;
export const collectLaneBrowserConflictFlags = tsModule.collectLaneBrowserConflictFlags;
export const isLaneBrowserConflictFlagName = tsModule.isLaneBrowserConflictFlagName;

// ─── Script-invocation mode: spawn the .ts entrypoint via tsx ───────────────

if (isInvokedAsScript) {
  const { spawn } = await import("node:child_process");
  const child = spawn(
    process.execPath,
    ["--import", "tsx", tsEntrypoint, ...process.argv.slice(2)],
    { stdio: "inherit" },
  );
  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });
}

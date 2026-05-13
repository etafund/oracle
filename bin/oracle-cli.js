#!/usr/bin/env node
// Dev shim: smoke scripts that invoke `node bin/oracle-cli.js` (per
// the integration smoke documentation pane 2 wrote) need a real .js
// file at this path, but the source entrypoint lives at
// bin/oracle-cli.ts. The published runtime points at
// dist/bin/oracle-cli.js after `pnpm build`; this shim is for the
// dev / smoke / repro path where the build step has not run.
//
// Implementation: spawn a child node with `--import tsx` and the
// .ts source as the entrypoint, forwarding stdio + exit code. This
// works on Node 24+ without any project-level config because tsx is
// already a dev dependency. Using a spawned child rather than an
// in-process import keeps the shim resilient across Node's evolving
// loader APIs (register(), --loader, --import) and produces a clean
// exit code so CI parsers see what they expect.

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const tsEntrypoint = path.join(here, "oracle-cli.ts");

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

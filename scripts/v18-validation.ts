#!/usr/bin/env tsx
// v18 validation runner (oracle-em7).
//
// Drives the named v18 test phases and writes a single summary
// artifact packet so a future agent can discover the test layout from
// one command instead of reverse-engineering individual vitest paths.
//
// Phases:
//   unit       — v18 schema + helper unit tests (tests/oracle/v18/)
//   fixtures   — browser selector + fixture tests
//   e2e:mock   — the mock-route rehearsal (oracle-2ob)
//   privacy    — secret-leak regression suite (oracle-89c)
//   conform    — JSON Schema 2020-12 conformance harness
//
// All phases are mock-only by default. The `live` phase is opt-in
// and requires ORACLE_LIVE_TEST=1 in the environment.
//
// Usage:
//   pnpm tsx scripts/v18-validation.ts            # all CI-safe phases
//   pnpm tsx scripts/v18-validation.ts --phases unit,privacy
//   pnpm tsx scripts/v18-validation.ts --live     # adds live phase
//   pnpm tsx scripts/v18-validation.ts --artifact-dir ./out
//
// Output:
//   <artifact-dir>/summary.json   — phase verdict + timing + counts
//   <artifact-dir>/<phase>.log    — vitest output captured per phase

import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const moduleDir = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(moduleDir, "..");

interface PhaseSpec {
  readonly name: string;
  /** vitest target paths relative to repo root. */
  readonly targets: readonly string[];
  /** Extra env to set when running this phase. */
  readonly env?: Record<string, string>;
  /** When true, requires ORACLE_LIVE_TEST=1 (opt-in). */
  readonly live?: boolean;
}

const PHASES: Record<string, PhaseSpec> = {
  unit: {
    name: "unit",
    targets: ["tests/oracle/v18/"],
  },
  fixtures: {
    name: "fixtures",
    targets: ["tests/browser/selectors/", "tests/browser/providers/"],
  },
  "e2e:mock": {
    name: "e2e:mock",
    targets: ["tests/e2e/"],
  },
  privacy: {
    name: "privacy",
    targets: ["tests/regression/secrets/", "tests/regression/hash_consistency.test.ts"],
  },
  conform: {
    name: "conform",
    targets: ["tests/conformance/v18/"],
  },
  live: {
    name: "live",
    targets: ["tests/live/"],
    env: { ORACLE_LIVE_TEST: "1" },
    live: true,
  },
};

const DEFAULT_CI_SAFE = ["unit", "fixtures", "e2e:mock", "privacy", "conform"];

interface PhaseResult {
  readonly phase: string;
  readonly status: "passed" | "failed" | "skipped";
  readonly exit_code: number | null;
  readonly elapsed_ms: number;
  readonly targets: readonly string[];
  readonly log_path: string;
  readonly reason: string | null;
}

interface CliArgs {
  readonly phases: readonly string[];
  readonly artifactDir: string;
  readonly live: boolean;
}

function parseArgs(argv: readonly string[]): CliArgs {
  let phases: string[] | null = null;
  let artifactDir = join(REPO_ROOT, ".oracle-v18-validation");
  let live = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--phases" && argv[i + 1]) {
      phases = argv[++i]
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (arg === "--artifact-dir" && argv[i + 1]) {
      artifactDir = resolve(argv[++i]);
    } else if (arg === "--live") {
      live = true;
    } else if (arg === "--help" || arg === "-h") {
      printHelpAndExit();
    }
  }
  const selected = phases ?? [...DEFAULT_CI_SAFE, ...(live ? ["live"] : [])];
  for (const phase of selected) {
    if (!(phase in PHASES)) {
      console.error(`unknown phase "${phase}"; known: ${Object.keys(PHASES).join(", ")}`);
      process.exit(2);
    }
  }
  return { phases: selected, artifactDir, live };
}

function printHelpAndExit(): never {
  console.log(
    [
      "v18-validation — run named v18 test phases and write a summary packet.",
      "",
      "Usage: pnpm tsx scripts/v18-validation.ts [options]",
      "",
      "Options:",
      "  --phases <list>         comma-separated phase names",
      "  --artifact-dir <path>   summary + per-phase logs (default .oracle-v18-validation/)",
      "  --live                  also run the live phase (requires ORACLE_LIVE_TEST=1)",
      "  --help, -h              show this message",
      "",
      `Known phases: ${Object.keys(PHASES).join(", ")}`,
      `Default CI-safe phases: ${DEFAULT_CI_SAFE.join(", ")}`,
    ].join("\n"),
  );
  process.exit(0);
}

async function runPhase(
  spec: PhaseSpec,
  artifactDir: string,
  liveAuthorised: boolean,
): Promise<PhaseResult> {
  const logPath = join(artifactDir, `${spec.name.replace(":", "_")}.log`);
  await mkdir(dirname(logPath), { recursive: true });

  if (spec.live && !liveAuthorised) {
    await writeFile(
      logPath,
      `skipped: live phase requires --live and ORACLE_LIVE_TEST=1\n`,
      "utf8",
    );
    return {
      phase: spec.name,
      status: "skipped",
      exit_code: null,
      elapsed_ms: 0,
      targets: spec.targets,
      log_path: logPath,
      reason: "live phase requires --live and ORACLE_LIVE_TEST=1",
    };
  }

  const started = Date.now();
  const env: NodeJS.ProcessEnv = { ...process.env, ...(spec.env ?? {}) };
  const args = ["vitest", "run", ...spec.targets, "--reporter=default"];
  const proc = spawn("pnpm", args, {
    cwd: REPO_ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const chunks: Buffer[] = [];
  proc.stdout.on("data", (b: Buffer) => chunks.push(b));
  proc.stderr.on("data", (b: Buffer) => chunks.push(b));

  const exitCode = await new Promise<number>((res) => {
    proc.once("close", (code) => res(code ?? 1));
  });

  const elapsed = Date.now() - started;
  await writeFile(logPath, Buffer.concat(chunks).toString("utf8"), "utf8");
  return {
    phase: spec.name,
    status: exitCode === 0 ? "passed" : "failed",
    exit_code: exitCode,
    elapsed_ms: elapsed,
    targets: spec.targets,
    log_path: logPath,
    reason: null,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  await mkdir(args.artifactDir, { recursive: true });

  const startedAt = new Date();
  console.log(`🧿 v18 validation: ${args.phases.join(", ")} → ${args.artifactDir}`);

  const results: PhaseResult[] = [];
  for (const phaseName of args.phases) {
    const spec = PHASES[phaseName];
    process.stdout.write(`  ${phaseName} … `);
    const result = await runPhase(spec, args.artifactDir, args.live);
    results.push(result);
    const verdict =
      result.status === "passed"
        ? `✓ ${result.elapsed_ms}ms`
        : result.status === "skipped"
          ? `↷ skipped`
          : `✗ exit ${result.exit_code} (${result.elapsed_ms}ms)`;
    console.log(verdict);
  }

  const finishedAt = new Date();
  const summary = {
    schema_version: "v18_validation_summary.v1",
    started_at: startedAt.toISOString(),
    finished_at: finishedAt.toISOString(),
    elapsed_ms: finishedAt.getTime() - startedAt.getTime(),
    artifact_dir: args.artifactDir,
    live_authorised: args.live,
    phase_count: results.length,
    passed: results.filter((r) => r.status === "passed").length,
    failed: results.filter((r) => r.status === "failed").length,
    skipped: results.filter((r) => r.status === "skipped").length,
    phases: results,
  };
  const summaryPath = join(args.artifactDir, "summary.json");
  await writeFile(summaryPath, JSON.stringify(summary, null, 2), "utf8");
  console.log(`📦 summary: ${summaryPath}`);

  process.exit(summary.failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});

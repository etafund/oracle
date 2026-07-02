import { Command } from "commander";
import { AGENT_LANE_POLICY_VERSION, LANE_TEMPLATES } from "../../laneRegistry.js";
import {
  runAggregateDoctor,
  type AggregateDoctorCheck,
  type AggregateDoctorOptions,
} from "./aggregate.js";
import { registerChatGptDoctorCommand, type ChatGptDoctorOptions } from "./chatgpt.js";
import { registerGeminiDoctorCommand, type GeminiDoctorOptions } from "./gemini.js";
import {
  BROWSER_EVIDENCE_SCHEMA_VERSION,
  BROWSER_LEASE_SCHEMA_VERSION,
} from "../../../oracle/v18/contracts.js";
import { EVIDENCE_LAYOUT } from "../../../oracle/v18/evidence.js";
import { PROVIDER_DOCS_SNAPSHOT_SCHEMA_VERSION } from "../../../oracle/v18/provider_docs.js";

export interface DoctorCommandDeps {
  aggregate?: Partial<AggregateDoctorOptions>;
  chatgpt?: Partial<ChatGptDoctorOptions>;
  gemini?: Partial<GeminiDoctorOptions>;
}

export interface LaneDoctorOptions {
  json?: boolean;
}

/**
 * Default check implementations for the three optional v18 readiness
 * surfaces that `aggregate.ts` leaves dependency-injected. These keep
 * `oracle doctor --json` complete out of the box — every callable
 * surface (provider_docs, browser_leases, evidence_storage) is
 * always reported even when no caller supplies a custom check.
 *
 * Each default check is intentionally a LIGHTWEIGHT presence-and-
 * schema readiness signal — never makes a live provider call or walks
 * the filesystem deeply. Deep audits live in their dedicated CLI
 * commands (`oracle browser leases status`, `oracle evidence verify`).
 */
function defaultProviderDocsCheck(): AggregateDoctorCheck {
  return {
    component: "provider_docs",
    status: "pass",
    code: "provider_docs_module_ready",
    message: `provider_docs_snapshot.v1 surface ready (schema_version=${PROVIDER_DOCS_SNAPSHOT_SCHEMA_VERSION}).`,
    details: { schema_version: PROVIDER_DOCS_SNAPSHOT_SCHEMA_VERSION },
    next_command: "oracle capabilities --json",
    fix_command: null,
    retry_safe: true,
  };
}

function defaultBrowserLeasesCheck(): AggregateDoctorCheck {
  return {
    component: "browser_leases",
    status: "pass",
    code: "browser_leases_module_ready",
    message: `browser_lease.v1 surface ready (schema_version=${BROWSER_LEASE_SCHEMA_VERSION}).`,
    details: { schema_version: BROWSER_LEASE_SCHEMA_VERSION },
    next_command: "oracle browser leases status --json",
    fix_command: null,
    retry_safe: true,
  };
}

function defaultEvidenceStorageCheck(): AggregateDoctorCheck {
  return {
    component: "evidence_storage",
    status: "pass",
    code: "evidence_storage_module_ready",
    message: `evidence storage surface ready (browser_evidence.v1=${BROWSER_EVIDENCE_SCHEMA_VERSION}, layout=${EVIDENCE_LAYOUT.EVIDENCE_DIRNAME}/${EVIDENCE_LAYOUT.INDEX_FILENAME}).`,
    details: {
      browser_evidence_schema_version: BROWSER_EVIDENCE_SCHEMA_VERSION,
      evidence_dir: EVIDENCE_LAYOUT.EVIDENCE_DIRNAME,
      quarantine_dir: EVIDENCE_LAYOUT.QUARANTINE_DIRNAME,
      index_filename: EVIDENCE_LAYOUT.INDEX_FILENAME,
    },
    next_command: "oracle evidence show <session> --json",
    fix_command: null,
    retry_safe: true,
  };
}

/**
 * Build the default aggregate-doctor options with provider_docs /
 * browser_leases / evidence_storage check defaults wired in. Caller
 * overrides via `deps.aggregate.*Check` win — these are LAST-RESORT
 * defaults so the envelope is never silently missing a surface.
 */
export function buildDefaultAggregateDoctorOptions(
  overrides: Partial<AggregateDoctorOptions> = {},
): Partial<AggregateDoctorOptions> {
  return {
    providerDocsCheck: overrides.providerDocsCheck ?? (async () => defaultProviderDocsCheck()),
    browserLeasesCheck: overrides.browserLeasesCheck ?? (async () => defaultBrowserLeasesCheck()),
    evidenceStorageCheck:
      overrides.evidenceStorageCheck ?? (async () => defaultEvidenceStorageCheck()),
    ...overrides,
  };
}

export function registerDoctorCommand(program: Command, deps: DoctorCommandDeps = {}): Command {
  // Compose caller-supplied aggregate deps with the v18 readiness
  // defaults so `oracle doctor` always reports every optional surface.
  const aggregateDeps = buildDefaultAggregateDoctorOptions(deps.aggregate);
  const doctorCommand = program
    .command("doctor")
    .description("Run Oracle preflight diagnostics without submitting prompts.")
    .option("--json", "Print structured JSON.", false)
    .option("--providers", "Inspect compatibility API provider keys and route choices.", false)
    .option("--models <models>", "Comma-separated compatibility API model list to inspect.")
    .option("-m, --model <model>", "Single compatibility API model to inspect.")
    .option("--provider <provider>", "Compatibility API provider override (auto, openai, azure).")
    .option("--no-azure", "Disable Azure OpenAI routing for this compatibility inspection.")
    .option("--azure-endpoint <url>", "Compatibility Azure OpenAI Endpoint.")
    .option("--azure-deployment <name>", "Compatibility Azure OpenAI Deployment Name.")
    .option("--azure-api-version <version>", "Compatibility Azure OpenAI API Version.")
    .option("--base-url <url>", "Override compatibility OpenAI-compatible base URL.")
    .action(async function (
      this: Command,
      _options: AggregateDoctorOptions & { providers?: boolean },
    ) {
      const options = this.optsWithGlobals() as AggregateDoctorOptions & { providers?: boolean };
      // Upstream synced 86ccc0db / b36a3dce / 3ae0df0d added an API-provider
      // readiness probe; route there when --providers is set, otherwise run
      // the fork's aggregate v18 doctor.
      if (options.providers) {
        const { runProviderDoctor } = await import("../../providerDoctor.js");
        await runProviderDoctor(this.optsWithGlobals());
        return;
      }
      const envelope = await runAggregateDoctor({ ...aggregateDeps, ...options });
      if (!envelope.ok) {
        process.exitCode = 1;
      }
    });

  doctorCommand
    .command("lanes")
    .description("Print the reviewed Oracle lane policy without launching browsers or models.")
    .option("--json", "Print structured JSON.", false)
    .action(async function (this: Command) {
      runLaneDoctor(this.optsWithGlobals() as LaneDoctorOptions);
    });

  registerChatGptDoctorCommand(doctorCommand, deps.chatgpt);
  registerGeminiDoctorCommand(doctorCommand, deps.gemini);
  return doctorCommand;
}

export function runLaneDoctor(options: LaneDoctorOptions = {}): void {
  const lanes = LANE_TEMPLATES.map((entry) => ({
    lane: entry.lane,
    canonical_id: entry.canonicalId,
    engine: entry.engine,
    access_path: entry.accessPath,
    readiness: entry.readiness,
    enabled_for_cli: entry.enabledForCli,
    command: entry.command,
    doctor_command: entry.doctorCommand,
    transport_eligibility: entry.transportEligibility,
    blocked_reason: entry.blockedReason ?? null,
    normalized_engine_options: entry.normalizedEngineOptions,
    refused_patterns: [...entry.refusedPatterns],
    runtime_assertions: [...entry.runtimeAssertions],
  }));
  const envelope = {
    schema_version: "json_envelope.v1" as const,
    ok: true,
    data: {
      schema_version: AGENT_LANE_POLICY_VERSION,
      lanes,
      enabled_lanes: lanes.filter((entry) => entry.enabled_for_cli).map((entry) => entry.lane),
      deferred_lanes: lanes
        .filter((entry) => !entry.enabled_for_cli)
        .map((entry) => ({
          lane: entry.lane,
          readiness: entry.readiness,
          blocked_reason: entry.blocked_reason,
        })),
    },
    meta: {
      command: "oracle doctor lanes --json",
      generated_at: new Date().toISOString(),
    },
    blocked_reason: null,
    next_command: "oracle capabilities --json",
    fix_command: null,
    retry_safe: true,
    errors: [],
    warnings: lanes
      .filter((entry) => !entry.enabled_for_cli)
      .map((entry) => `${entry.lane}:${entry.blocked_reason ?? entry.readiness}`),
    commands: {
      capabilities: "oracle capabilities --json",
      remote_doctor: "oracle remote doctor --json",
      doctor: "oracle doctor --json",
    },
  };
  if (options.json) {
    console.log(JSON.stringify(envelope, null, 2));
    return;
  }
  console.log(
    [
      "oracle doctor lanes",
      ...lanes.map((entry) => {
        const state = entry.enabled_for_cli ? "enabled" : entry.readiness;
        const reason = entry.blocked_reason ? ` (${entry.blocked_reason})` : "";
        return `- ${entry.lane}: ${state}${reason} -> ${entry.command}`;
      }),
      "Next: oracle capabilities --json",
    ].join("\n"),
  );
}

export { runAggregateDoctor } from "./aggregate.js";
export type {
  AggregateDoctorCheck,
  AggregateDoctorEnvelope,
  AggregateDoctorOptions,
} from "./aggregate.js";

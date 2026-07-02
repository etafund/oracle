#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const outDir = path.join(
  root,
  ".planning-runs/claude-code-spike-execution-2026-07-02/worker-b-nonfast",
);

const importFromRoot = async (relativePath) =>
  import(pathToFileURL(path.join(root, relativePath)).href);

const { resolveRunOptionsFromConfig } = await importFromRoot("src/cli/runOptions.ts");
const { buildProviderRoutePlan } = await importFromRoot("src/oracle/providerRoutePlan.ts");
const { buildCapabilityReport } = await importFromRoot("src/oracle/capabilities/registry.ts");
const { consultInputSchema } = await importFromRoot("src/mcp/types.ts");

const POLICY_VERSION = "lane_registry_spike.v0";
const PROMPT = "This planning probe prompt is deliberately not echoed in route-block output.";

const laneRegistry = [
  {
    lane: "chatgpt-pro",
    title: "ChatGPT Pro Extended Reasoning",
    engine: "browser",
    accessPath: "oracle_browser_remote_or_local",
    modelAliases: ["chatgpt-pro-latest", "gpt-5.5-pro"],
    exactCommand:
      'oracle --lane chatgpt-pro --prompt "$PROMPT" --file PATH... --browser-thinking-time extended --browser-archive auto --browser-attachments auto',
    mcpTemplate:
      '{"lane":"chatgpt-pro","prompt":"...","files":["PATH"],"browserThinkingTime":"extended"}',
    readiness: {
      doctorCommand: "oracle doctor lane chatgpt-pro --json",
      requires: ["signed_in_chatgpt", "pro_model_available", "extended_reasoning_selected"],
    },
    materialDefaults: {
      browserThinkingTime: "extended",
      browserArchive: "auto",
      browserAttachments: "auto",
      neverClicksAnswerNow: true,
    },
  },
  {
    lane: "gemini-deep-think",
    title: "Gemini Deep Think",
    engine: "browser",
    accessPath: "oracle_browser_remote_or_local",
    modelAliases: ["gemini-3.1-pro-deep-think", "gemini-deep-think"],
    exactCommand:
      'oracle --lane gemini-deep-think --prompt "$PROMPT" --file PATH... --gemini-deep-think --gemini-deep-think-fallback fail',
    mcpTemplate: '{"lane":"gemini-deep-think","prompt":"...","files":["PATH"]}',
    readiness: {
      doctorCommand: "oracle doctor lane gemini-deep-think --json",
      requires: ["signed_in_gemini", "deep_think_available", "deep_think_selected"],
    },
    materialDefaults: {
      fallback: "fail",
      neverSubstitutesGeminiApi: true,
    },
  },
  {
    lane: "fable-local",
    title: "Claude Code Fable Local",
    engine: "claude-code",
    accessPath: "claude_code_subscription_cli",
    modelAliases: ["fable", "claude_code_fable_5"],
    exactCommand:
      'oracle --lane fable-local --prompt "$PROMPT" --file PATH... --claude-code-no-tools --claude-code-local-only',
    mcpTemplate: '{"lane":"fable-local","prompt":"...","files":["PATH"]}',
    readiness: {
      doctorCommand: "oracle doctor lane fable-local --json",
      requires: ["local_same_user", "subscription_cli_auth", "zero_tools_verified"],
    },
    materialDefaults: {
      tools: [],
      localOnly: true,
      providerBilling: "not_claimed_until_verified",
    },
  },
];

const laneByName = new Map(laneRegistry.map((lane) => [lane.lane, lane]));
const fableAliases = new Set(["fable", "claude_code_fable_5"]);

function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function safeAttempt(input) {
  return {
    surface: input.surface,
    lane: input.lane ?? null,
    engine: input.engine ?? null,
    model: input.model ?? null,
    models: input.models ?? null,
    dryRun: input.dryRun === true,
    priorSessionLane: input.priorSessionLane ?? null,
    sourcePrecedence: input.sourcePrecedence ?? [],
    promptSha256: input.prompt ? `sha256:${sha256(input.prompt)}` : null,
  };
}

function supportedLanes() {
  return laneRegistry.map((lane) => ({
    lane: lane.lane,
    title: lane.title,
    engine: lane.engine,
    accessPath: lane.accessPath,
    command: lane.exactCommand,
    mcp: lane.mcpTemplate,
    readiness: lane.readiness,
    materialDefaults: lane.materialDefaults,
  }));
}

function block(input, reason, details = {}) {
  return {
    ok: false,
    errorCode: "agent_lane_blocked",
    exitCode: 2,
    policyVersion: POLICY_VERSION,
    reason,
    attemptedRoute: safeAttempt(input),
    sourcePrecedence: input.sourcePrecedence ?? [],
    supportedLanes: supportedLanes(),
    noBackendStarted: true,
    eventsComplete: true,
    streamsComplete: true,
    details,
  };
}

function exactLegacyChatGptPro(input) {
  return (
    input.surface === "cli" &&
    input.engine === "browser" &&
    input.model === "gpt-5.5-pro" &&
    input.browserThinkingTime === "extended" &&
    (input.browserArchive ?? "auto") === "auto" &&
    (input.browserAttachments ?? "auto") === "auto"
  );
}

function resolveLane(input) {
  if (input.kind === "passive") {
    return { ok: true, passive: true, noBackendStarted: true, lane: null };
  }

  if (input.models?.some((model) => fableAliases.has(model))) {
    return block(input, "fable_alias_disallowed_in_multi_model_fanout", {
      disallowedAliases: input.models.filter((model) => fableAliases.has(model)),
    });
  }

  if (!input.lane && fableAliases.has(input.model)) {
    return block(input, "fable_alias_requires_fable_local_lane", {
      requiredLane: "fable-local",
      rejectedEngine: input.engine ?? "default",
    });
  }

  if (!input.lane && exactLegacyChatGptPro(input)) {
    return {
      ok: true,
      lane: "chatgpt-pro",
      legacyMappingApplied: "exact_chatgpt_pro_extended_browser",
      noBackendStarted: input.dryRun === true,
    };
  }

  if (!input.lane && input.priorSessionLane) {
    if (laneByName.has(input.priorSessionLane)) {
      return {
        ok: true,
        lane: input.priorSessionLane,
        priorSessionLaneApplied: true,
        noBackendStarted: input.dryRun === true,
      };
    }
    return block(input, "prior_session_has_unreviewed_lane", {
      priorSessionLane: input.priorSessionLane,
    });
  }

  if (!input.lane) {
    return block(input, "missing_reviewed_lane", {
      defaultInferenceRefused: true,
    });
  }

  const lane = laneByName.get(input.lane);
  if (!lane) {
    return block(input, "unknown_lane", { lane: input.lane });
  }

  if (input.engine && input.engine !== lane.engine) {
    return block(input, "lane_engine_conflict", {
      lane: lane.lane,
      expectedEngine: lane.engine,
      attemptedEngine: input.engine,
    });
  }

  if (input.model && !lane.modelAliases.includes(input.model)) {
    return block(input, "lane_model_conflict", {
      lane: lane.lane,
      allowedAliases: lane.modelAliases,
      attemptedModel: input.model,
    });
  }

  if (Array.isArray(input.models) && input.models.length > 0) {
    return block(input, "lane_does_not_support_multi_model_fanout", {
      lane: lane.lane,
      attemptedModels: input.models,
    });
  }

  if (input.surface === "mcp" && input.lane === "fable-local" && input.transport === "network") {
    return block(input, "fable_local_refuses_ambiguous_mcp_transport", {
      transport: input.transport,
    });
  }

  return {
    ok: true,
    lane: lane.lane,
    noBackendStarted: input.dryRun === true,
    dryRun: input.dryRun === true,
  };
}

function emptyCounters() {
  return {
    apiSelection: 0,
    browserLaunch: 0,
    claudeSpawn: 0,
    mcpBackendMapping: 0,
    sessionWorkerStart: 0,
    routerRequestCreation: 0,
  };
}

function startWithGate(input) {
  const counters = emptyCounters();
  const decision = resolveLane(input);
  if (!decision.ok || decision.passive || input.dryRun) {
    return { ...decision, counters };
  }

  counters.sessionWorkerStart += 1;
  if (input.surface === "mcp") counters.mcpBackendMapping += 1;
  if (decision.lane === "chatgpt-pro" || decision.lane === "gemini-deep-think") {
    counters.browserLaunch += 1;
  } else if (decision.lane === "fable-local") {
    counters.claudeSpawn += 1;
  } else {
    counters.apiSelection += 1;
  }
  return { ...decision, counters };
}

const policyCases = [
  {
    name: "cli_lane_chatgpt_pro_allowed",
    input: {
      surface: "cli",
      kind: "active",
      lane: "chatgpt-pro",
      prompt: PROMPT,
      model: "gpt-5.5-pro",
    },
  },
  {
    name: "cli_exact_legacy_chatgpt_pro_mapping_allowed",
    input: {
      surface: "cli",
      kind: "active",
      prompt: PROMPT,
      engine: "browser",
      model: "gpt-5.5-pro",
      browserThinkingTime: "extended",
      sourcePrecedence: ["cli.engine", "cli.model", "cli.browserThinkingTime"],
    },
  },
  {
    name: "cli_lane_gemini_deep_think_allowed",
    input: {
      surface: "cli",
      kind: "active",
      lane: "gemini-deep-think",
      prompt: PROMPT,
      model: "gemini-3.1-pro-deep-think",
    },
  },
  {
    name: "cli_lane_fable_local_allowed",
    input: {
      surface: "cli",
      kind: "active",
      lane: "fable-local",
      prompt: PROMPT,
      model: "fable",
      engine: "claude-code",
    },
  },
  {
    name: "cli_lane_fable_local_dry_run_has_no_backend",
    input: {
      surface: "cli",
      kind: "active",
      lane: "fable-local",
      prompt: PROMPT,
      model: "fable",
      engine: "claude-code",
      dryRun: true,
    },
  },
  {
    name: "cli_bare_prompt_blocked",
    input: { surface: "cli", kind: "active", prompt: PROMPT, sourcePrecedence: ["none"] },
  },
  {
    name: "cli_api_claude_blocked",
    input: {
      surface: "cli",
      kind: "active",
      prompt: PROMPT,
      engine: "api",
      model: "claude-4.6-sonnet",
      sourcePrecedence: ["cli.engine", "cli.model"],
    },
  },
  {
    name: "cli_model_gpt_blocked",
    input: {
      surface: "cli",
      kind: "active",
      prompt: PROMPT,
      model: "gpt",
      sourcePrecedence: ["cli.model"],
    },
  },
  {
    name: "cli_exact_gpt_55_pro_without_lane_blocked",
    input: {
      surface: "cli",
      kind: "active",
      prompt: PROMPT,
      model: "gpt-5.5-pro",
      sourcePrecedence: ["cli.model"],
    },
  },
  {
    name: "cli_fable_api_blocked_before_provider",
    input: {
      surface: "cli",
      kind: "active",
      prompt: PROMPT,
      engine: "api",
      model: "fable",
      sourcePrecedence: ["cli.engine", "cli.model"],
    },
  },
  {
    name: "cli_claude_code_fable_api_blocked_before_provider",
    input: {
      surface: "cli",
      kind: "active",
      prompt: PROMPT,
      engine: "api",
      model: "claude_code_fable_5",
      sourcePrecedence: ["cli.engine", "cli.model"],
    },
  },
  {
    name: "cli_fanout_with_fable_blocked",
    input: {
      surface: "cli",
      kind: "active",
      prompt: PROMPT,
      models: ["gpt-5.5-pro", "fable"],
      sourcePrecedence: ["cli.models"],
    },
  },
  {
    name: "cli_lane_conflict_blocked",
    input: {
      surface: "cli",
      kind: "active",
      prompt: PROMPT,
      lane: "fable-local",
      engine: "browser",
      model: "fable",
      sourcePrecedence: ["cli.lane", "cli.engine", "cli.model"],
    },
  },
  {
    name: "cli_config_default_blocked",
    input: {
      surface: "cli",
      kind: "active",
      prompt: PROMPT,
      engine: "browser",
      model: "gemini-3-pro",
      sourcePrecedence: ["config.engine", "config.model"],
    },
  },
  {
    name: "cli_prior_session_with_reviewed_lane_allowed",
    input: {
      surface: "cli",
      kind: "active",
      prompt: PROMPT,
      priorSessionLane: "chatgpt-pro",
      sourcePrecedence: ["session.lane"],
    },
  },
  {
    name: "cli_prior_session_without_reviewed_lane_blocked",
    input: {
      surface: "cli",
      kind: "active",
      prompt: PROMPT,
      priorSessionLane: "legacy-browser",
      sourcePrecedence: ["session.mode", "session.model"],
    },
  },
  {
    name: "cli_status_passive_bypasses_active_gate",
    input: { surface: "cli", kind: "passive", command: "status" },
  },
  {
    name: "mcp_prompt_only_blocked",
    input: { surface: "mcp", kind: "active", prompt: PROMPT, sourcePrecedence: ["request.prompt"] },
  },
  {
    name: "mcp_fable_stdio_allowed",
    input: {
      surface: "mcp",
      kind: "active",
      prompt: PROMPT,
      lane: "fable-local",
      transport: "stdio",
      model: "fable",
    },
  },
  {
    name: "mcp_lane_engine_conflict_blocked",
    input: {
      surface: "mcp",
      kind: "active",
      prompt: PROMPT,
      lane: "fable-local",
      engine: "api",
      model: "fable",
      sourcePrecedence: ["request.lane", "request.engine"],
    },
  },
  {
    name: "mcp_network_fable_blocked",
    input: {
      surface: "mcp",
      kind: "active",
      prompt: PROMPT,
      lane: "fable-local",
      transport: "network",
      model: "fable",
    },
  },
];

const policyResults = policyCases.map((entry) => ({
  name: entry.name,
  input: safeAttempt(entry.input),
  result: startWithGate(entry.input),
}));

const blockedResults = policyResults.filter((entry) => entry.result.ok === false);
const blockedInvariantFailures = blockedResults.filter((entry) => {
  const result = entry.result;
  return (
    result.errorCode !== "agent_lane_blocked" ||
    result.exitCode !== 2 ||
    result.noBackendStarted !== true ||
    result.supportedLanes.length !== laneRegistry.length ||
    Object.values(result.counters ?? emptyCounters()).some((count) => count !== 0) ||
    JSON.stringify(result).includes(PROMPT)
  );
});

const generatedSurfaces = {
  helpLaneSection: laneRegistry
    .map(
      (lane) =>
        `${lane.lane}: ${lane.title}\n  command: ${lane.exactCommand}\n  doctor: ${lane.readiness.doctorCommand}`,
    )
    .join("\n"),
  capabilitiesJson: laneRegistry.map((lane) => ({
    id: lane.lane,
    title: lane.title,
    engine: lane.engine,
    accessPath: lane.accessPath,
    readiness: lane.readiness,
    materialDefaults: lane.materialDefaults,
  })),
  mcpLaneEnum: laneRegistry.map((lane) => lane.lane),
  routeBlockSupportedLanes: supportedLanes(),
  doctorLaneRecords: laneRegistry.map((lane) => ({
    lane: lane.lane,
    command: lane.readiness.doctorCommand,
    requires: lane.readiness.requires,
  })),
  testCases: laneRegistry.map((lane) => ({
    name: `allows_${lane.lane.replaceAll("-", "_")}`,
    input: { lane: lane.lane, model: lane.modelAliases[0] },
  })),
};

const laneNameLists = [
  generatedSurfaces.capabilitiesJson.map((entry) => entry.id),
  generatedSurfaces.mcpLaneEnum,
  generatedSurfaces.routeBlockSupportedLanes.map((entry) => entry.lane),
  generatedSurfaces.doctorLaneRecords.map((entry) => entry.lane),
  generatedSurfaces.testCases.map((entry) => entry.input.lane),
];
const surfaceDrift = laneNameLists.some(
  (list) => JSON.stringify(list) !== JSON.stringify(laneNameLists[0]),
);

const currentResolverObservations = [];
function observeCurrentResolver(name, input) {
  try {
    const resolved = resolveRunOptionsFromConfig({
      prompt: PROMPT,
      env: {},
      userConfig: {},
      ...input,
    });
    const models = resolved.runOptions.models ?? [resolved.runOptions.model];
    currentResolverObservations.push({
      name,
      ok: true,
      resolvedEngine: resolved.resolvedEngine,
      model: resolved.runOptions.model,
      models: resolved.runOptions.models,
      effectiveModelId: resolved.runOptions.effectiveModelId,
      routePlans: models.map((model) =>
        buildProviderRoutePlan({
          model,
          providerMode: resolved.runOptions.provider ?? "auto",
          baseUrl: resolved.runOptions.baseUrl,
          azure: resolved.runOptions.azure,
          env: {},
        }),
      ),
    });
  } catch (error) {
    currentResolverObservations.push({
      name,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

observeCurrentResolver("current_api_model_fable", { engine: "api", model: "fable" });
observeCurrentResolver("current_api_model_claude_code_fable_5", {
  engine: "api",
  model: "claude_code_fable_5",
});
observeCurrentResolver("current_fanout_gpt55pro_fable", {
  models: ["gpt-5.5-pro", "fable"],
});
observeCurrentResolver("current_browser_model_fable", { engine: "browser", model: "fable" });
observeCurrentResolver("current_exact_gpt55pro_default", { model: "gpt-5.5-pro" });

const currentMcpSchemaObservations = {
  laneFieldAcceptedToday: consultInputSchema.safeParse({ lane: "fable-local", prompt: PROMPT })
    .success,
  promptOnlyAcceptedToday: consultInputSchema.safeParse({ prompt: PROMPT }).success,
  capabilityIdsToday: buildCapabilityReport({ env: {}, now: new Date("2026-07-02T00:00:00.000Z") })
    .capabilities.map((entry) => entry.id),
};

const output = {
  generatedAt: new Date().toISOString(),
  policyVersion: POLICY_VERSION,
  laneRegistry,
  currentResolverObservations,
  currentMcpSchemaObservations,
  policyResults,
  blockedInvariantFailures,
  generatedSurfaces,
  surfaceDrift,
  summary: {
    policyCaseCount: policyResults.length,
    blockedCaseCount: blockedResults.length,
    blockedInvariantFailures: blockedInvariantFailures.length,
    surfaceDrift,
  },
};

fs.writeFileSync(path.join(outDir, "harness-output.json"), `${JSON.stringify(output, null, 2)}\n`);
fs.writeFileSync(
  path.join(outDir, "generated-surfaces.md"),
  [
    "# Generated Lane Surfaces",
    "",
    "## Help Lane Section",
    "",
    "```text",
    generatedSurfaces.helpLaneSection,
    "```",
    "",
    "## MCP Lane Enum",
    "",
    "```json",
    JSON.stringify(generatedSurfaces.mcpLaneEnum, null, 2),
    "```",
    "",
    "## Capabilities JSON Fragment",
    "",
    "```json",
    JSON.stringify(generatedSurfaces.capabilitiesJson, null, 2),
    "```",
    "",
    "## Route-Block Supported Lanes",
    "",
    "```json",
    JSON.stringify(generatedSurfaces.routeBlockSupportedLanes, null, 2),
    "```",
  ].join("\n"),
);

console.log(JSON.stringify(output.summary, null, 2));

if (blockedInvariantFailures.length > 0 || surfaceDrift) {
  process.exitCode = 1;
}

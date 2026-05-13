import { describe, expect, test } from "vitest";

import {
  assertStructuredTestLogRecords,
  createStructuredTestLog,
} from "../../_helpers/structuredTestLog.js";
import {
  createProviderBoundaryPavSnapshot,
  providerBoundaryMetadataContainsRawPrompt,
  type ProviderBoundaryPavMetadata,
  type ProviderBoundaryPavSnapshot,
} from "../../../src/oracle/provider_boundaries_pav.js";
import {
  ARTIFACT_INDEX_SCHEMA_VERSION,
  CONTEXT_SERIALIZATION_POLICY_SCHEMA_VERSION,
  V18_BUNDLE_VERSION,
  contextSerializationPolicySchema,
  type ArtifactIndex,
} from "../../../src/oracle/v18/index.ts";
import { evaluateSlotAccess } from "../../../src/oracle/v18/provider_access_policy.js";
import {
  SOURCE_BASELINE_SCHEMA_VERSION,
  SOURCE_LOCK_ARTIFACT_NAME,
  digestSourceBaseline,
  verifySourceBaseline,
} from "../../../src/oracle/v18/source_baseline.js";
import {
  SOURCE_TRUST_SCHEMA_VERSION,
  verifySourceTrustCrossReference,
} from "../../../src/oracle/v18/source_trust.js";
import { sha256OfBytes } from "../../../src/oracle/v18/evidence.js";

interface PavProviderResult {
  readonly provider_family: string;
  readonly provider_slot: string;
  readonly access_path: string;
  readonly observed_prompt_sha256: `sha256:${string}`;
  readonly observed_prompt_bytes: number;
  readonly context_serialization: ProviderBoundaryPavMetadata["context_serialization"];
  readonly source_baseline_sha256: `sha256:${string}`;
  readonly source_baseline: Record<string, unknown>;
  readonly source_baseline_bytes: string;
  readonly source_trust: Record<string, unknown>;
  readonly artifact_index: ArtifactIndex;
  readonly result_text: string;
}

interface PavBoundaryViolation {
  readonly field: string;
  readonly message: string;
}

interface PavScenarioInput {
  readonly providerFamily: string;
  readonly providerSlot: string;
  readonly requestedMode: "api" | "browser" | "file-bundle";
  readonly accessPath?: string;
  readonly provider?: DeterministicBoundaryProvider;
}

type ProviderMutation = (input: {
  prompt: string;
  metadata: ProviderBoundaryPavMetadata;
  baseline: Record<string, unknown>;
  baselineBytes: string;
  baselineSha256: `sha256:${string}`;
  trust: Record<string, unknown>;
  artifactIndex: ArtifactIndex;
}) => Partial<PavProviderResult> & { prompt?: string };

class DeterministicBoundaryProvider {
  constructor(private readonly mutate?: ProviderMutation) {}

  async run(input: {
    prompt: string;
    metadata: ProviderBoundaryPavMetadata;
    baseline: Record<string, unknown>;
    baselineBytes: string;
    baselineSha256: `sha256:${string}`;
    trust: Record<string, unknown>;
    artifactIndex: ArtifactIndex;
  }): Promise<PavProviderResult> {
    const mutation = this.mutate?.(input) ?? {};
    const observedPrompt = mutation.prompt ?? input.prompt;
    return {
      provider_family: input.metadata.provider_family,
      provider_slot: input.metadata.provider_slot,
      access_path: input.metadata.access_path,
      observed_prompt_sha256: sha256OfBytes(observedPrompt),
      observed_prompt_bytes: Buffer.byteLength(observedPrompt, "utf8"),
      context_serialization: input.metadata.context_serialization,
      source_baseline_sha256: input.baselineSha256,
      source_baseline: input.baseline,
      source_baseline_bytes: input.baselineBytes,
      source_trust: input.trust,
      artifact_index: input.artifactIndex,
      result_text: "provider response",
      ...withoutPrompt(mutation),
    };
  }
}

function withoutPrompt(
  mutation: Partial<PavProviderResult> & { prompt?: string },
): Partial<PavProviderResult> {
  const { prompt: _prompt, ...rest } = mutation;
  return rest;
}

function contextSerializationPolicyFixture() {
  return contextSerializationPolicySchema.parse({
    activation_requirements: ["license_compatibility_review_approved"],
    anti_patterns: ["canonical_artifact_storage_as_toon"],
    bundle_version: V18_BUNDLE_VERSION,
    canonical_storage_format: "json",
    default_effective_format: "json",
    fallback_format: "json",
    hash_requirements: ["canonical_json_sha256"],
    legal_review_required: true,
    policy_status: "gated_optional",
    prompt_context_preference: "json",
    schema_version: CONTEXT_SERIALIZATION_POLICY_SCHEMA_VERSION,
    toon_rust: {
      cli_candidates: ["toon", "tru"],
      enabled: false,
      enabled_by_default: false,
      key_folding: "safe",
      library_name: "toon",
      library_package: "tru",
      license_review_required: true,
      minimum_version: "0.2.3",
      prefer_cli: "toon",
      required: false,
      source_repo: "https://github.com/Dicklesworthstone/toon_rust",
      strict_decode: true,
    },
    usage_patterns: ["prompt_context_packet_compaction"],
  });
}

function sourceArtifacts() {
  const sourceA = sha256OfBytes("export const answer = 42;\n");
  const sourceB = sha256OfBytes("## Plan\nKeep provider prompts unchanged.\n");
  const baseline = {
    schema_version: SOURCE_BASELINE_SCHEMA_VERSION,
    bundle_version: V18_BUNDLE_VERSION,
    artifact_name: SOURCE_LOCK_ARTIFACT_NAME,
    policy: "strict",
    mode: "strict",
    sources: [
      { id: "src-a", kind: "file", path: "src/a.ts", sha256: sourceA },
      { id: "doc-b", kind: "file", path: "docs/plan.md", sha256: sourceB },
    ],
  };
  const baselineBytes = JSON.stringify(baseline);
  const baselineSha256 = digestSourceBaseline(baseline);
  const trust = {
    schema_version: SOURCE_TRUST_SCHEMA_VERSION,
    bundle_version: V18_BUNDLE_VERSION,
    sources: [
      { id: "src-a", trust_tier: "repo" },
      { id: "doc-b", trust_tier: "repo" },
    ],
    quarantined_instructions: [{ source_id: "doc-b", reason: "instruction-like fixture text" }],
  };
  const artifactIndex: ArtifactIndex = {
    schema_version: ARTIFACT_INDEX_SCHEMA_VERSION,
    bundle_version: V18_BUNDLE_VERSION,
    artifacts: [
      {
        artifact_id: SOURCE_LOCK_ARTIFACT_NAME,
        kind: "source_baseline",
        path: SOURCE_LOCK_ARTIFACT_NAME,
        sha256: baselineSha256,
      },
    ],
  };
  return { baseline, baselineBytes, baselineSha256, trust, artifactIndex };
}

async function runPavScenario(input: PavScenarioInput) {
  const prompt = [
    "PAV e2e fixture prompt",
    "```toon",
    "items[2]{id,name}:",
    "  1,Ada",
    "  2,Linus",
    "```",
    "",
  ].join("\n");
  const source = sourceArtifacts();
  const snapshot = createProviderBoundaryPavSnapshot({
    providerPrompt: prompt,
    providerFamily: input.providerFamily,
    providerSlot: input.providerSlot,
    requestedMode: input.requestedMode,
    accessPath: input.accessPath,
    contextSerializationPolicy: contextSerializationPolicyFixture(),
  });
  const provider = input.provider ?? new DeterministicBoundaryProvider();
  const result = await provider.run({
    prompt: snapshot.providerPrompt,
    metadata: snapshot.metadata,
    baseline: source.baseline,
    baselineBytes: source.baselineBytes,
    baselineSha256: source.baselineSha256,
    trust: source.trust,
    artifactIndex: source.artifactIndex,
  });
  return { prompt, snapshot, result };
}

function verifyPavBoundary(
  snapshot: ProviderBoundaryPavSnapshot,
  result: PavProviderResult,
): PavBoundaryViolation[] {
  const violations: PavBoundaryViolation[] = [];

  if (result.observed_prompt_sha256 !== snapshot.metadata.prompt_sha256) {
    violations.push({
      field: "provider_result.observed_prompt_sha256",
      message: "provider observed prompt hash diverged from PAV prompt_sha256",
    });
  }
  if (result.observed_prompt_bytes !== snapshot.metadata.prompt_bytes) {
    violations.push({
      field: "provider_result.observed_prompt_bytes",
      message: "provider observed prompt byte length diverged from PAV prompt_bytes",
    });
  }

  const access = evaluateSlotAccess({
    slot: snapshot.metadata.provider_slot,
    providerFamily: result.provider_family,
    accessPath: result.access_path,
  });
  if (!access.eligible) {
    for (const reason of access.reasons) {
      violations.push({ field: reason.field, message: reason.message });
    }
  }

  if (
    result.context_serialization.policy_hash.value !==
    snapshot.metadata.context_serialization.policy_hash.value
  ) {
    violations.push({
      field: "context_serialization.policy_hash",
      message: "context serialization policy hash drifted after provider execution",
    });
  }
  if (result.context_serialization.canonical_storage_format !== "json") {
    violations.push({
      field: "context_serialization.canonical_storage_format",
      message: "canonical storage format drifted away from JSON",
    });
  }
  if (result.context_serialization.json_cli_output_remains_json !== true) {
    violations.push({
      field: "context_serialization.json_cli_output_remains_json",
      message: "JSON CLI output fallback was disabled",
    });
  }

  const baseline = verifySourceBaseline({
    baseline: result.source_baseline,
    baselineBytes: result.source_baseline_bytes,
    expectedSha256: result.source_baseline_sha256,
  });
  for (const mismatch of baseline.mismatches) {
    violations.push({ field: mismatch.field, message: mismatch.message });
  }

  const trust = verifySourceTrustCrossReference({
    baseline: result.source_baseline,
    trust: result.source_trust,
  });
  for (const mismatch of trust.mismatches) {
    violations.push({ field: mismatch.field, message: mismatch.message });
  }

  if (providerBoundaryMetadataContainsRawPrompt(snapshot.metadata, snapshot.providerPrompt)) {
    violations.push({
      field: "provider_boundary.metadata",
      message: "raw prompt leaked into PAV metadata",
    });
  }

  return violations;
}

describe("PAV end-to-end boundary regressions", () => {
  test("happy path preserves prompt, access policy, context serialization, and source trust handles", async () => {
    const log = createStructuredTestLog({
      testName: "pav-boundary-happy-path",
      evidencePointer: "tests/regression/pav/provider-boundary-e2e.test.ts",
    });

    log.record("setup", { provider_slot: "chatgpt_pro_first_plan" });
    const { prompt, snapshot, result } = await runPavScenario({
      providerFamily: "chatgpt",
      providerSlot: "chatgpt_pro_first_plan",
      requestedMode: "browser",
    });

    log.record("act", {
      prompt_sha256: snapshot.metadata.prompt_sha256,
      access_path: result.access_path,
      policy_hash: result.context_serialization.policy_hash.value,
    });
    const violations = verifyPavBoundary(snapshot, result);

    log.record("assert", {
      violation_count: violations.length,
      metadata_json_round_trip: JSON.parse(JSON.stringify(snapshot.metadata)).context_serialization
        .canonical_storage_format,
    });
    expect(violations).toEqual([]);
    expect(result.observed_prompt_sha256).toBe(snapshot.metadata.prompt_sha256);
    expect(result.context_serialization.canonical_storage_format).toBe("json");
    expect(result.context_serialization.json_cli_output_remains_json).toBe(true);
    expect(JSON.stringify(snapshot.metadata)).not.toContain(prompt);
    expect(JSON.parse(JSON.stringify(snapshot.metadata)).context_serialization.policy_hash).toEqual(
      snapshot.metadata.context_serialization.policy_hash,
    );

    assertStructuredTestLogRecords(log.records());
    expect(log.records().map((record) => record.phase)).toEqual(["setup", "act", "assert"]);
  });

  test("detects prompt mutation by a provider adapter", async () => {
    const log = createStructuredTestLog({
      testName: "pav-boundary-prompt-mutation",
      evidencePointer: "tests/regression/pav/provider-boundary-e2e.test.ts",
    });
    const provider = new DeterministicBoundaryProvider(({ prompt }) => ({
      prompt: `${prompt}\nMUTATED BY PROVIDER`,
    }));

    log.record("act", { mutation: "append-provider-text" });
    const { snapshot, result } = await runPavScenario({
      providerFamily: "chatgpt",
      providerSlot: "chatgpt_pro_first_plan",
      requestedMode: "browser",
      provider,
    });
    const violations = verifyPavBoundary(snapshot, result);
    log.record("assert", { violations });

    expect(violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "provider_result.observed_prompt_sha256" }),
        expect.objectContaining({ field: "provider_result.observed_prompt_bytes" }),
      ]),
    );
    assertStructuredTestLogRecords(log.records());
  });

  test("detects protected-slot API substitution and provider-family elevation", async () => {
    const provider = new DeterministicBoundaryProvider(() => ({
      provider_family: "openai",
      access_path: "openai_api",
    }));
    const { snapshot, result } = await runPavScenario({
      providerFamily: "chatgpt",
      providerSlot: "chatgpt_pro_first_plan",
      requestedMode: "browser",
      provider,
    });

    const violations = verifyPavBoundary(snapshot, result);

    expect(violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "provider_result.provider_family" }),
        expect.objectContaining({ field: "provider_result.access_path" }),
      ]),
    );
  });

  test("detects context serialization drift after JSON fallback metadata is emitted", async () => {
    const provider = new DeterministicBoundaryProvider(({ metadata }) => ({
      context_serialization: {
        ...metadata.context_serialization,
        canonical_storage_format: "toon",
        json_cli_output_remains_json: false,
        policy_hash: {
          source: "context_serialization_policy",
          algorithm: "sha256",
          value: "0".repeat(64),
        },
      },
    }));
    const { snapshot, result } = await runPavScenario({
      providerFamily: "chatgpt",
      providerSlot: "chatgpt_pro_first_plan",
      requestedMode: "browser",
      provider,
    });

    const violations = verifyPavBoundary(snapshot, result);

    expect(violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "context_serialization.policy_hash" }),
        expect.objectContaining({ field: "context_serialization.canonical_storage_format" }),
        expect.objectContaining({ field: "context_serialization.json_cli_output_remains_json" }),
      ]),
    );
  });

  test("detects source baseline hash corruption while source trust still cross-checks", async () => {
    const provider = new DeterministicBoundaryProvider(({ baseline }) => ({
      source_baseline_sha256: sha256OfBytes(`${JSON.stringify(baseline)}\ncorrupt`),
    }));
    const { snapshot, result } = await runPavScenario({
      providerFamily: "gemini",
      providerSlot: "gemini_deep_think",
      requestedMode: "browser",
      provider,
    });

    const violations = verifyPavBoundary(snapshot, result);

    expect(violations).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: "source_baseline.sha256" })]),
    );
    expect(
      verifySourceTrustCrossReference({
        baseline: result.source_baseline,
        trust: result.source_trust,
      }).consistent,
    ).toBe(true);
  });

  test("ordinary Oracle API usage stays outside protected workflow policy", async () => {
    const { snapshot, result } = await runPavScenario({
      providerFamily: "openai",
      providerSlot: "gpt-5.2",
      requestedMode: "api",
    });

    const violations = verifyPavBoundary(snapshot, result);

    expect(violations).toEqual([]);
    expect(snapshot.metadata.policy_scope).toBe("ordinary_oracle_usage");
    expect(snapshot.metadata.protected_slot_metadata).toBeNull();
    expect(snapshot.metadata.slot_access).toEqual({ eligible: true, reasons: [] });
    expect(result.access_path).toBe("openai_api");
  });
});

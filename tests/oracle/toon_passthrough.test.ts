import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";

import { MODEL_CONFIGS } from "../../src/oracle/config.js";
import { buildRequestBody } from "../../src/oracle/request.js";
import {
  CONTEXT_SERIALIZATION_POLICY_SCHEMA_VERSION,
  V18_BUNDLE_VERSION,
  contextSerializationPolicySchema,
} from "../../src/oracle/v18/index.ts";
import {
  checkToonPolicyWarning,
  createToonPromptPassthrough,
  detectToonPromptBlocks,
  getToonPassthroughCapabilities,
  hashPromptBytes,
  hashToonPromptBytes,
  hasToonBlocks,
  passthroughToProviderPrompt,
  summarizeContextSerializationPolicy,
} from "../../src/oracle/toon_passthrough.js";

function sha256(input: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(input, "utf8").digest("hex")}`;
}

function contextSerializationPolicyFixture() {
  return {
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
  };
}

describe("TOON prompt-block passthrough", () => {
  test("passes TOON prompt text to provider request bodies unchanged", () => {
    const prompt = [
      "  keep leading spaces",
      "```toon",
      "items[2]{id,name}:",
      "  1,Ada",
      "  2,Linus",
      "```",
      "",
      "<toon kind=\"packet\">opaque bytes stay provider text</toon>",
      "TOON_BLOCK: legacy marker",
      "",
    ].join("\r\n");

    const passthrough = createToonPromptPassthrough(prompt);
    expect(passthrough.providerPrompt).toBe(prompt);
    expect(passthroughToProviderPrompt(prompt)).toBe(prompt);
    expect(passthrough.prompt_semantics).toBe("unchanged");
    expect(passthrough.prompt_payload_format).toBe("text");
    expect(passthrough.has_toon_prompt_blocks).toBe(true);
    expect(passthrough.toon_block_markers.map((marker) => marker.kind)).toEqual([
      "markdown_fence",
      "xml_tag",
      "legacy_marker",
    ]);

    const body = buildRequestBody({
      modelConfig: MODEL_CONFIGS["gpt-5.2"],
      systemPrompt: "Trusted system policy.",
      userPrompt: passthrough.providerPrompt,
      searchEnabled: false,
    });
    expect(body.input[0]?.content[0]?.text).toBe(prompt);
  });

  test("detects TOON markers without decoding or validating their contents", () => {
    const malformedToon = [
      "```toon",
      "not valid if a real decoder existed {",
      "  still opaque",
      "```",
      "plain text",
    ].join("\n");

    const markers = detectToonPromptBlocks(malformedToon);
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({ kind: "markdown_fence", marker: "```toon" });
    expect(hasToonBlocks(malformedToon)).toBe(true);
    expect(hasToonBlocks("ordinary prompt mentioning cartoons")).toBe(false);
  });

  test("records hashes over exact UTF-8 prompt bytes", () => {
    const prompt = " \r\n```toon\r\nrows[1]{id}: 1\r\n```\r\n";
    const result = createToonPromptPassthrough(prompt);

    expect(result.prompt_bytes).toBe(Buffer.byteLength(prompt, "utf8"));
    expect(result.prompt_sha256).toBe(sha256(prompt));
    expect(hashPromptBytes(prompt)).toBe(sha256(prompt));
    expect(hashToonPromptBytes(prompt)).toBe(sha256(prompt));
  });

  test("advertises passthrough capability without claiming toon_rust ownership", () => {
    const capabilities = getToonPassthroughCapabilities();
    expect(capabilities).toMatchObject({
      prompt_payload_format_passthrough: true,
      toon_prompt_blocks_passthrough: true,
      provider_payload_format: "text",
      provider_payload_semantics: "unchanged",
      canonical_storage_format: "json",
      owns_toon_rust: false,
      requires_toon_rust: false,
      invokes_toon_rust: false,
      decodes_toon: false,
      validates_toon: false,
    });
  });

  test("surfaces v18 context serialization policy metadata with JSON fallback warnings", () => {
    const parsedPolicy = contextSerializationPolicySchema.parse(contextSerializationPolicyFixture());
    const result = createToonPromptPassthrough("```toon\nitems[1]{id}: 1\n```", {
      contextSerializationPolicy: parsedPolicy,
    });

    expect(result.policy_metadata).toMatchObject({
      canonical_storage_format: "json",
      fallback_format: "json",
      default_effective_format: "json",
      policy_status: "gated_optional",
      prompt_context_preference: "json",
      legal_review_required: true,
      toon_rust_enabled: false,
      toon_rust_required: false,
      toon_rust_strict_decode: true,
      toon_rust_cli_candidates: ["toon", "tru"],
      toon_rust_prefer_cli: "toon",
      toon_rust_source_repo: "https://github.com/Dicklesworthstone/toon_rust",
    });
    expect(result.warnings.map((warning) => warning.code)).toEqual([
      "toon_prompt_blocks_json_fallback",
      "toon_rust_policy_not_executed",
    ]);
    expect(result.warnings[0]?.policy_metadata).toEqual(result.policy_metadata);
    expect(result.warnings[0]?.message).toMatch(/canonical artifacts.*JSON/i);
  });

  test("warns for toon_rust policy pressure but does not require TOON blocks", () => {
    const metadata = summarizeContextSerializationPolicy({
      prompt_context_preference: "toon",
      toon_rust: {
        enabled: true,
        required: true,
        strict_decode: true,
        cli_candidates: ["toon", "tru"],
        prefer_cli: "tru",
      },
    });
    expect(metadata).toMatchObject({
      prompt_context_preference: "toon",
      toon_rust_enabled: true,
      toon_rust_required: true,
      toon_rust_strict_decode: true,
      toon_rust_prefer_cli: "tru",
    });

    const warning = checkToonPolicyWarning({
      required: true,
      strict_decode: true,
      cli_candidates: ["toon", "tru"],
    });
    expect(warning).toMatch(/does not decode, validate, install, benchmark, or invoke toon_rust/);
  });

  test("does not vendor, depend on, or invoke toon_rust tooling", async () => {
    const source = await readFile(
      path.join(process.cwd(), "src/oracle/toon_passthrough.ts"),
      "utf8",
    );
    expect(source).not.toContain("node:child_process");
    expect(source).not.toMatch(/\b(execFile|spawn|execa|which)\s*\(/);

    const packageJson = JSON.parse(
      await readFile(path.join(process.cwd(), "package.json"), "utf8"),
    ) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    const dependencyNames = Object.keys({
      ...(packageJson.dependencies ?? {}),
      ...(packageJson.devDependencies ?? {}),
      ...(packageJson.optionalDependencies ?? {}),
    });
    expect(dependencyNames).not.toContain("toon");
    expect(dependencyNames).not.toContain("tru");
    expect(dependencyNames).not.toContain("toon_rust");
  });
});

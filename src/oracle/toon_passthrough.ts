import { createHash } from "node:crypto";

export type ToonPromptBlockKind = "markdown_fence" | "xml_tag" | "legacy_marker";

export interface ToonPromptBlockMarker {
  readonly kind: ToonPromptBlockKind;
  readonly start: number;
  readonly end: number;
  readonly marker: string;
}

export interface ToonRustPolicyLike {
  readonly enabled?: unknown;
  readonly required?: unknown;
  readonly cli_candidates?: unknown;
  readonly prefer_cli?: unknown;
  readonly strict_decode?: unknown;
  readonly source_repo?: unknown;
  readonly enabled_by_default?: unknown;
  readonly license_review_required?: unknown;
  readonly [key: string]: unknown;
}

export interface ContextSerializationPolicyLike {
  readonly canonical_storage_format?: unknown;
  readonly fallback_format?: unknown;
  readonly default_effective_format?: unknown;
  readonly policy_status?: unknown;
  readonly prompt_context_preference?: unknown;
  readonly legal_review_required?: unknown;
  readonly toon_rust?: ToonRustPolicyLike | unknown;
  readonly [key: string]: unknown;
}

export interface ToonPassthroughCapabilities {
  readonly prompt_payload_format_passthrough: true;
  readonly toon_prompt_blocks_passthrough: true;
  readonly provider_payload_format: "text";
  readonly provider_payload_semantics: "unchanged";
  readonly canonical_storage_format: "json";
  readonly owns_toon_rust: false;
  readonly requires_toon_rust: false;
  readonly invokes_toon_rust: false;
  readonly decodes_toon: false;
  readonly validates_toon: false;
}

export interface ToonPolicyMetadata {
  readonly canonical_storage_format: string;
  readonly fallback_format: string;
  readonly default_effective_format: string;
  readonly policy_status: string;
  readonly prompt_context_preference: string;
  readonly legal_review_required: boolean;
  readonly toon_rust_enabled: boolean;
  readonly toon_rust_enabled_by_default: boolean;
  readonly toon_rust_required: boolean;
  readonly toon_rust_strict_decode: boolean;
  readonly toon_rust_license_review_required: boolean;
  readonly toon_rust_cli_candidates: readonly string[];
  readonly toon_rust_prefer_cli: string | null;
  readonly toon_rust_source_repo: string | null;
}

export interface ToonPassthroughWarning {
  readonly code:
    | "toon_prompt_blocks_json_fallback"
    | "toon_rust_policy_not_executed";
  readonly severity: "warning";
  readonly message: string;
  readonly policy_metadata: ToonPolicyMetadata;
}

export interface ToonPromptPassthroughResult {
  readonly providerPrompt: string;
  readonly prompt_payload_format: "text";
  readonly prompt_semantics: "unchanged";
  readonly prompt_bytes: number;
  readonly prompt_sha256: `sha256:${string}`;
  readonly has_toon_prompt_blocks: boolean;
  readonly toon_block_markers: readonly ToonPromptBlockMarker[];
  readonly capabilities: ToonPassthroughCapabilities;
  readonly policy_metadata: ToonPolicyMetadata;
  readonly warnings: readonly ToonPassthroughWarning[];
}

export interface ToonPromptPassthroughOptions {
  readonly contextSerializationPolicy?: ContextSerializationPolicyLike;
}

const DEFAULT_POLICY_METADATA: ToonPolicyMetadata = Object.freeze({
  canonical_storage_format: "json",
  fallback_format: "json",
  default_effective_format: "json",
  policy_status: "gated_optional",
  prompt_context_preference: "json",
  legal_review_required: true,
  toon_rust_enabled: false,
  toon_rust_enabled_by_default: false,
  toon_rust_required: false,
  toon_rust_strict_decode: false,
  toon_rust_license_review_required: true,
  toon_rust_cli_candidates: [],
  toon_rust_prefer_cli: null,
  toon_rust_source_repo: null,
});

export const TOON_PASSTHROUGH_CAPABILITIES: ToonPassthroughCapabilities = Object.freeze({
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

export function createToonPromptPassthrough(
  prompt: string,
  options: ToonPromptPassthroughOptions = {},
): ToonPromptPassthroughResult {
  const markers = detectToonPromptBlocks(prompt);
  const policyMetadata = summarizeContextSerializationPolicy(
    options.contextSerializationPolicy,
  );
  return {
    providerPrompt: passthroughToProviderPrompt(prompt),
    prompt_payload_format: "text",
    prompt_semantics: "unchanged",
    prompt_bytes: Buffer.byteLength(prompt, "utf8"),
    prompt_sha256: hashPromptBytes(prompt),
    has_toon_prompt_blocks: markers.length > 0,
    toon_block_markers: markers,
    capabilities: getToonPassthroughCapabilities(),
    policy_metadata: policyMetadata,
    warnings: buildWarnings(markers, policyMetadata),
  };
}

export function passthroughToProviderPrompt(prompt: string): string {
  return prompt;
}

export function hashPromptBytes(prompt: string): `sha256:${string}` {
  const digest = createHash("sha256").update(prompt, "utf8").digest("hex");
  return `sha256:${digest}`;
}

export function detectToonPromptBlocks(prompt: string): readonly ToonPromptBlockMarker[] {
  return [
    ...collectMarkers(prompt, "markdown_fence", /^[ \t]*(?:```|~~~)[ \t]*toon(?:[ \t].*)?$/gim),
    ...collectMarkers(prompt, "xml_tag", /<toon(?:\s|>|\/)/gi),
    ...collectMarkers(prompt, "legacy_marker", /\bTOON_BLOCK\b/g),
  ].sort((left, right) => left.start - right.start || left.end - right.end);
}

export function hasToonPromptBlocks(prompt: string): boolean {
  return detectToonPromptBlocks(prompt).length > 0;
}

export function getToonPassthroughCapabilities(): ToonPassthroughCapabilities {
  return { ...TOON_PASSTHROUGH_CAPABILITIES };
}

export function summarizeContextSerializationPolicy(
  policy?: ContextSerializationPolicyLike,
): ToonPolicyMetadata {
  const toonRust = asRecord(policy?.toon_rust);
  return {
    canonical_storage_format: stringValue(
      policy?.canonical_storage_format,
      DEFAULT_POLICY_METADATA.canonical_storage_format,
    ),
    fallback_format: stringValue(policy?.fallback_format, DEFAULT_POLICY_METADATA.fallback_format),
    default_effective_format: stringValue(
      policy?.default_effective_format,
      DEFAULT_POLICY_METADATA.default_effective_format,
    ),
    policy_status: stringValue(policy?.policy_status, DEFAULT_POLICY_METADATA.policy_status),
    prompt_context_preference: stringValue(
      policy?.prompt_context_preference,
      DEFAULT_POLICY_METADATA.prompt_context_preference,
    ),
    legal_review_required: booleanValue(
      policy?.legal_review_required,
      DEFAULT_POLICY_METADATA.legal_review_required,
    ),
    toon_rust_enabled: booleanValue(
      toonRust?.enabled,
      DEFAULT_POLICY_METADATA.toon_rust_enabled,
    ),
    toon_rust_enabled_by_default: booleanValue(
      toonRust?.enabled_by_default,
      DEFAULT_POLICY_METADATA.toon_rust_enabled_by_default,
    ),
    toon_rust_required: booleanValue(
      toonRust?.required,
      DEFAULT_POLICY_METADATA.toon_rust_required,
    ),
    toon_rust_strict_decode: booleanValue(
      toonRust?.strict_decode,
      DEFAULT_POLICY_METADATA.toon_rust_strict_decode,
    ),
    toon_rust_license_review_required: booleanValue(
      toonRust?.license_review_required,
      DEFAULT_POLICY_METADATA.toon_rust_license_review_required,
    ),
    toon_rust_cli_candidates: stringArrayValue(toonRust?.cli_candidates),
    toon_rust_prefer_cli: nullableStringValue(toonRust?.prefer_cli),
    toon_rust_source_repo: nullableStringValue(toonRust?.source_repo),
  };
}

// Backward-compatible aliases for earlier handoff drafts.
export const hasToonBlocks = hasToonPromptBlocks;
export const hashToonPromptBytes = hashPromptBytes;

export function checkToonPolicyWarning(
  policy?: ToonRustPolicyLike,
): string | null {
  const result = createToonPromptPassthrough("", {
    contextSerializationPolicy: { toon_rust: policy },
  });
  return result.warnings[0]?.message ?? null;
}

function buildWarnings(
  markers: readonly ToonPromptBlockMarker[],
  policy: ToonPolicyMetadata,
): readonly ToonPassthroughWarning[] {
  const warnings: ToonPassthroughWarning[] = [];
  if (
    markers.length > 0 &&
    (policy.canonical_storage_format === "json" ||
      policy.default_effective_format === "json" ||
      policy.fallback_format === "json")
  ) {
    warnings.push({
      code: "toon_prompt_blocks_json_fallback",
      severity: "warning",
      message:
        "TOON prompt blocks will pass through to the provider unchanged; Oracle canonical artifacts and JSON CLI output remain JSON.",
      policy_metadata: policy,
    });
  }

  if (
    policy.prompt_context_preference === "toon" ||
    policy.toon_rust_required ||
    policy.toon_rust_strict_decode
  ) {
    warnings.push({
      code: "toon_rust_policy_not_executed",
      severity: "warning",
      message:
        "Oracle does not decode, validate, install, benchmark, or invoke toon_rust; TOON handling is passthrough-only.",
      policy_metadata: policy,
    });
  }
  return warnings;
}

function collectMarkers(
  prompt: string,
  kind: ToonPromptBlockKind,
  pattern: RegExp,
): ToonPromptBlockMarker[] {
  const markers: ToonPromptBlockMarker[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(prompt))) {
    markers.push({
      kind,
      start: match.index,
      end: match.index + match[0].length,
      marker: match[0],
    });
    if (pattern.lastIndex === match.index) {
      pattern.lastIndex += 1;
    }
  }
  return markers;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function nullableStringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function stringArrayValue(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

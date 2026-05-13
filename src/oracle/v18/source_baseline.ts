// v18 source_baseline.v1 / source_lock contract layer (oracle-5js).
//
// Oracle does not own source-trust policy — APR / $vibe-planning does
// — but Oracle MUST preserve the correlation handles it receives:
//
//   - source_baseline_sha256 references on provider_result.v1
//   - source_lock.json bytes (the source_baseline.v1 document itself)
//   - artifact_index.v1 entries that pin those source files
//   - traceability_matrix.v1 IDs that join requirements ↔ tests
//
// This module materialises the Zod schema for source_baseline.v1 and
// provides the compatibility checks the bead acceptance asks for:
//
//   * hash pass-through from provider_result.source_baseline_sha256
//     to the document digest
//   * `policy` vs legacy `mode` agreement (both fields share an enum;
//     if both are present they must match exactly)
//   * artifact-index linking to source files
//   * placeholder-sha256 rejection (reuses isPlaceholderHash from
//     ./evidence.ts so the rule stays in lockstep with the redacted
//     evidence layer)

import { z } from "zod";

import {
  artifactIndexSchema,
  sha256HashSchema,
  type ArtifactIndex,
} from "./contracts.js";
import { isPlaceholderHash, sha256OfBytes } from "./evidence.js";

// ─── Schema ──────────────────────────────────────────────────────────────────

export const SOURCE_BASELINE_SCHEMA_VERSION = "source_baseline.v1" as const;
export const SOURCE_LOCK_ARTIFACT_NAME = "source-lock.json" as const;

/**
 * One entry in `source_baseline.sources`. Fields beyond the typed core
 * round-trip via `.passthrough()` — APR is free to carry kind-specific
 * metadata (mtime, url, etc.) without forcing a contract bump.
 */
export const sourceBaselineEntrySchema = z
  .object({
    id: z.string(),
    sha256: sha256HashSchema,
    kind: z.string().optional(),
    path: z.string().optional(),
  })
  .passthrough();
export type SourceBaselineEntry = z.infer<typeof sourceBaselineEntrySchema>;

/**
 * `source_baseline.v1` lock document. Both `policy` and the legacy v17
 * `mode` field use the same enum; if both are present they MUST agree.
 * `bundle_version` is a typed core field even though the underlying
 * JSON Schema only requires it at the v18 bundle level.
 */
export const SOURCE_BASELINE_MODE = z.enum(["off", "baseline", "strict"]);
export type SourceBaselineMode = z.infer<typeof SOURCE_BASELINE_MODE>;

export const sourceBaselineSchema = z
  .object({
    schema_version: z.literal(SOURCE_BASELINE_SCHEMA_VERSION),
    bundle_version: z.string(),
    artifact_name: z.literal(SOURCE_LOCK_ARTIFACT_NAME).optional(),
    policy: SOURCE_BASELINE_MODE,
    mode: SOURCE_BASELINE_MODE.optional(),
    sources: z.array(sourceBaselineEntrySchema),
    gaps: z.array(z.record(z.string(), z.unknown())).optional(),
  })
  .passthrough();
export type SourceBaseline = z.infer<typeof sourceBaselineSchema>;

// ─── Result types ────────────────────────────────────────────────────────────

export interface BaselineMismatch {
  /** Dotted field pointer (e.g. `source_baseline.policy`). */
  field: string;
  message: string;
}

export interface BaselineVerdict {
  readonly consistent: boolean;
  readonly mismatches: readonly BaselineMismatch[];
}

const OK: BaselineVerdict = Object.freeze({ consistent: true, mismatches: [] });

function fail(mismatches: BaselineMismatch[]): BaselineVerdict {
  return { consistent: false, mismatches };
}

function mismatch(field: string, message: string): BaselineMismatch {
  return { field, message };
}

// ─── Internal helpers ────────────────────────────────────────────────────────

function parseBaseline(value: unknown, out: BaselineMismatch[]): SourceBaseline | null {
  const parsed = sourceBaselineSchema.safeParse(value);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      out.push(
        mismatch(["source_baseline", ...issue.path.map(String)].join("."), issue.message),
      );
    }
    return null;
  }
  return parsed.data as SourceBaseline;
}

function parseIndex(value: unknown, out: BaselineMismatch[]): ArtifactIndex | null {
  const parsed = artifactIndexSchema.safeParse(value);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      out.push(
        mismatch(["artifact_index", ...issue.path.map(String)].join("."), issue.message),
      );
    }
    return null;
  }
  return parsed.data as ArtifactIndex;
}

// ─── Public checks ───────────────────────────────────────────────────────────

/**
 * Validate the policy ↔ mode invariant: if both `policy` and `mode` are
 * present on a source_baseline document they MUST be equal. Either may
 * be omitted; when only one is present, it is authoritative.
 */
export function checkPolicyModeAgreement(baseline: SourceBaseline): BaselineMismatch[] {
  if (baseline.mode === undefined) return [];
  if (baseline.mode !== baseline.policy) {
    return [
      mismatch(
        "source_baseline.mode",
        `legacy "mode" (${baseline.mode}) disagrees with "policy" (${baseline.policy}); when both are present they must match`,
      ),
    ];
  }
  return [];
}

/**
 * Validate that no `sha256` field on the baseline document is a
 * placeholder (all-zeros / single-char-repeat). Mirrors
 * `isPlaceholderHash` from ./evidence.ts so the rule stays in lockstep
 * with redacted-evidence verification.
 */
export function checkNoPlaceholderHashes(baseline: SourceBaseline): BaselineMismatch[] {
  const out: BaselineMismatch[] = [];
  baseline.sources.forEach((entry, index) => {
    if (isPlaceholderHash(entry.sha256)) {
      out.push(
        mismatch(
          `source_baseline.sources[${index}].sha256`,
          `placeholder/all-same-hex sha256 is not a real digest: ${entry.sha256}`,
        ),
      );
    }
  });
  return out;
}

export interface VerifySourceBaselineInput {
  readonly baseline: unknown;
  /**
   * Optional: a sha256 string the caller wants pass-through verified
   * against `sha256OfBytes(JSON.stringify(baseline))`. Passing the raw
   * bytes via `baselineBytes` is preferred — those are what the
   * downstream consumer actually digests — but for cases where the
   * caller has already canonicalised the JSON, accepting the bytes via
   * `baselineBytes` is required.
   */
  readonly expectedSha256?: string;
  readonly baselineBytes?: Uint8Array | string;
}

/**
 * Verify the source_baseline document round-trips: typed core fields
 * parse, mode/policy agree, no placeholder hashes, and the
 * caller-supplied digest (when given) matches the canonical sha256 of
 * `baselineBytes` (when given).
 */
export function verifySourceBaseline(input: VerifySourceBaselineInput): BaselineVerdict {
  const out: BaselineMismatch[] = [];
  const baseline = parseBaseline(input.baseline, out);
  if (!baseline) return fail(out);

  out.push(...checkPolicyModeAgreement(baseline));
  out.push(...checkNoPlaceholderHashes(baseline));

  if (input.baselineBytes !== undefined && input.expectedSha256 !== undefined) {
    const actual = sha256OfBytes(input.baselineBytes);
    if (actual !== input.expectedSha256) {
      out.push(
        mismatch(
          "source_baseline.sha256",
          `caller expected ${input.expectedSha256}, bytes hash to ${actual}`,
        ),
      );
    }
  }

  return out.length === 0 ? OK : fail(out);
}

// ─── Artifact-index linking ──────────────────────────────────────────────────

export interface ArtifactLinkInput {
  readonly artifactIndex: unknown;
  /**
   * Pin one or more sha256 → expected artifact ID pairs. Useful when
   * provider_result records the hash and the caller wants to assert the
   * index has a matching entry that points to a source file.
   */
  readonly expected: ReadonlyArray<{
    readonly artifactId?: string;
    readonly sha256?: string;
    readonly kind?: string;
    readonly path?: string;
  }>;
}

/**
 * Confirm every expected (id, sha256, path) tuple has a matching entry
 * in the artifact_index. Extra (unmatched) entries in the index are
 * allowed — APR records many artifacts that Oracle does not own.
 */
export function checkArtifactIndexLinks(input: ArtifactLinkInput): BaselineVerdict {
  const out: BaselineMismatch[] = [];
  const index = parseIndex(input.artifactIndex, out);
  if (!index) return fail(out);

  input.expected.forEach((expected, i) => {
    const matches = index.artifacts.filter((entry) => {
      if (expected.artifactId !== undefined && entry.artifact_id !== expected.artifactId) {
        return false;
      }
      if (expected.sha256 !== undefined && entry.sha256 !== expected.sha256) {
        return false;
      }
      if (expected.kind !== undefined && entry.kind !== expected.kind) {
        return false;
      }
      if (expected.path !== undefined && entry.path !== expected.path) {
        return false;
      }
      return true;
    });
    if (matches.length === 0) {
      out.push(
        mismatch(
          `artifact_index.expected[${i}]`,
          `no entry matched ${JSON.stringify(expected)}`,
        ),
      );
    }
  });

  return out.length === 0 ? OK : fail(out);
}

/**
 * Build a sha256 over the canonical bytes of a source_baseline. Used
 * for hash pass-through: the result of this function should equal
 * provider_result.source_baseline_sha256 when the artifact pipeline
 * has not lost or rewritten any bytes.
 */
export function digestSourceBaseline(baseline: unknown): `sha256:${string}` {
  const bytes = JSON.stringify(baseline);
  return sha256OfBytes(bytes);
}

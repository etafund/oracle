// v18 source_trust.v1 + traceability_matrix.v1 contract layer.
//
// Oracle does not police trust policy — that belongs to APR — but it
// must round-trip the trust handles unchanged AND surface obvious
// cross-reference problems (a source_baseline entry that has no
// matching trust tier, a quarantined-instruction entry whose source id
// no longer exists in the baseline).
//
// `verifySourceTrustCrossReference` is the cross-artifact checker. It
// pairs cleanly with `verifySourceBaseline` from ./source_baseline.ts:
//
//   * every source_baseline.sources[*].id should appear in
//     source_trust.sources[*].id (warning when missing — APR may add
//     trust tiers asynchronously)
//   * every quarantined_instructions[*].source_id must reference an
//     existing source (hard mismatch — quarantine without a source is
//     meaningless)

import { z } from "zod";

import {
  sourceBaselineSchema,
  type BaselineMismatch,
  type BaselineVerdict,
  type SourceBaseline,
} from "./source_baseline.js";

// ─── Schemas ─────────────────────────────────────────────────────────────────

export const SOURCE_TRUST_SCHEMA_VERSION = "source_trust.v1" as const;

export const sourceTrustEntrySchema = z
  .object({
    id: z.string(),
    trust_tier: z.string(),
  })
  .passthrough();
export type SourceTrustEntry = z.infer<typeof sourceTrustEntrySchema>;

export const quarantinedInstructionSchema = z
  .object({
    source_id: z.string(),
    reason: z.string().optional(),
  })
  .passthrough();
export type QuarantinedInstruction = z.infer<typeof quarantinedInstructionSchema>;

export const sourceTrustSchema = z
  .object({
    schema_version: z.literal(SOURCE_TRUST_SCHEMA_VERSION),
    bundle_version: z.string().optional(),
    sources: z.array(sourceTrustEntrySchema),
    quarantined_instructions: z.array(quarantinedInstructionSchema).optional(),
  })
  .passthrough();
export type SourceTrust = z.infer<typeof sourceTrustSchema>;

// ─── traceability_matrix.v1 ──────────────────────────────────────────────────

export const TRACEABILITY_MATRIX_SCHEMA_VERSION = "traceability_matrix.v1" as const;

export const traceabilityRequirementSchema = z
  .object({
    id: z.string(),
    source: z.string().optional(),
    plan_sections: z.array(z.string()).optional(),
    tests: z.array(z.string()).optional(),
  })
  .passthrough();
export type TraceabilityRequirement = z.infer<typeof traceabilityRequirementSchema>;

export const traceabilityTestSchema = z
  .object({
    id: z.string(),
    type: z.string().optional(),
  })
  .passthrough();
export type TraceabilityTest = z.infer<typeof traceabilityTestSchema>;

export const traceabilityRiskSchema = z
  .object({
    id: z.string(),
    mitigation: z.string().optional(),
  })
  .passthrough();
export type TraceabilityRisk = z.infer<typeof traceabilityRiskSchema>;

export const traceabilityMatrixSchema = z
  .object({
    schema_version: z.literal(TRACEABILITY_MATRIX_SCHEMA_VERSION),
    bundle_version: z.string().optional(),
    requirements: z.array(traceabilityRequirementSchema),
    tests: z.array(traceabilityTestSchema).optional(),
    risks: z.array(traceabilityRiskSchema).optional(),
  })
  .passthrough();
export type TraceabilityMatrix = z.infer<typeof traceabilityMatrixSchema>;

// ─── Verdict helpers ─────────────────────────────────────────────────────────

const OK: BaselineVerdict = Object.freeze({ consistent: true, mismatches: [] });

function fail(mismatches: BaselineMismatch[]): BaselineVerdict {
  return { consistent: false, mismatches };
}

function mismatch(field: string, message: string): BaselineMismatch {
  return { field, message };
}

function parseTrust(value: unknown, out: BaselineMismatch[]): SourceTrust | null {
  const parsed = sourceTrustSchema.safeParse(value);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      out.push(mismatch(["source_trust", ...issue.path.map(String)].join("."), issue.message));
    }
    return null;
  }
  return parsed.data as SourceTrust;
}

function parseBaseline(value: unknown, out: BaselineMismatch[]): SourceBaseline | null {
  const parsed = sourceBaselineSchema.safeParse(value);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      out.push(mismatch(["source_baseline", ...issue.path.map(String)].join("."), issue.message));
    }
    return null;
  }
  return parsed.data as SourceBaseline;
}

// ─── Cross-reference checker ─────────────────────────────────────────────────

export interface VerifySourceTrustInput {
  readonly trust: unknown;
  readonly baseline?: unknown;
  /**
   * When false, missing trust tiers for baseline source IDs are treated
   * as warnings (BaselineMismatch entries with a warning-shaped
   * message). When true (default), they are still recorded but as
   * `requires_trust_tier`-shaped messages so the caller can decide
   * whether to fail or pass.
   */
  readonly strict?: boolean;
}

/**
 * Cross-check a source_trust document against (optionally) the matching
 * source_baseline. Returns mismatches for:
 *
 *   - schema parse failures on either document
 *   - quarantined_instructions whose source_id does not exist in either
 *     trust.sources or baseline.sources
 *   - duplicate source ids inside trust.sources
 *
 * Missing trust tiers for baseline source IDs are surfaced as
 * mismatches when `strict` is true (default).
 */
export function verifySourceTrustCrossReference(input: VerifySourceTrustInput): BaselineVerdict {
  const out: BaselineMismatch[] = [];
  const trust = parseTrust(input.trust, out);
  if (!trust) return fail(out);

  const baseline = input.baseline === undefined ? null : parseBaseline(input.baseline, out);

  // Duplicate trust source IDs.
  const trustIds = new Map<string, number>();
  trust.sources.forEach((entry, idx) => {
    const count = trustIds.get(entry.id) ?? 0;
    if (count > 0) {
      out.push(mismatch(`source_trust.sources[${idx}].id`, `duplicate source id "${entry.id}"`));
    }
    trustIds.set(entry.id, count + 1);
  });

  // Quarantined-instruction source_ids must reference an existing source.
  const knownIds = new Set<string>(trust.sources.map((entry) => entry.id));
  if (baseline) {
    for (const entry of baseline.sources) knownIds.add(entry.id);
  }
  (trust.quarantined_instructions ?? []).forEach((entry, idx) => {
    if (!knownIds.has(entry.source_id)) {
      out.push(
        mismatch(
          `source_trust.quarantined_instructions[${idx}].source_id`,
          `references unknown source "${entry.source_id}" (no matching baseline or trust entry)`,
        ),
      );
    }
  });

  // Optional: every baseline source id should have a trust tier.
  const strict = input.strict ?? true;
  if (baseline && strict) {
    const trustedIds = new Set<string>(trust.sources.map((entry) => entry.id));
    baseline.sources.forEach((entry, idx) => {
      if (!trustedIds.has(entry.id)) {
        out.push(
          mismatch(
            `source_baseline.sources[${idx}].id`,
            `baseline source "${entry.id}" has no trust tier in source_trust`,
          ),
        );
      }
    });
  }

  return out.length === 0 ? OK : fail(out);
}

/**
 * Cross-check a traceability_matrix.v1 against (optionally) a list of
 * test IDs that actually exist. Catches:
 *
 *   - requirement.tests entries that point at a nonexistent test
 *   - duplicate requirement / test / risk IDs
 *   - tests declared in `tests[]` but never referenced by any
 *     requirement (warning-level)
 */
export interface VerifyTraceabilityInput {
  readonly traceability: unknown;
  /** Optional set of test IDs that exist in the actual test suite. */
  readonly knownTestIds?: ReadonlyArray<string>;
}

export function verifyTraceability(input: VerifyTraceabilityInput): BaselineVerdict {
  const out: BaselineMismatch[] = [];
  const parsed = traceabilityMatrixSchema.safeParse(input.traceability);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      out.push(
        mismatch(["traceability_matrix", ...issue.path.map(String)].join("."), issue.message),
      );
    }
    return fail(out);
  }
  const matrix = parsed.data as TraceabilityMatrix;

  // Duplicate requirement IDs.
  const reqIds = new Set<string>();
  matrix.requirements.forEach((req, idx) => {
    if (reqIds.has(req.id)) {
      out.push(
        mismatch(
          `traceability_matrix.requirements[${idx}].id`,
          `duplicate requirement id "${req.id}"`,
        ),
      );
    }
    reqIds.add(req.id);
  });

  // Duplicate test IDs.
  const testIds = new Set<string>();
  (matrix.tests ?? []).forEach((test, idx) => {
    if (testIds.has(test.id)) {
      out.push(mismatch(`traceability_matrix.tests[${idx}].id`, `duplicate test id "${test.id}"`));
    }
    testIds.add(test.id);
  });

  // Requirement.tests must reference known tests when knownTestIds is
  // provided OR (otherwise) at least one test declared in tests[].
  const referenced = new Set<string>();
  matrix.requirements.forEach((req, idx) => {
    for (const refTestId of req.tests ?? []) {
      referenced.add(refTestId);
      const exists = input.knownTestIds
        ? input.knownTestIds.includes(refTestId)
        : testIds.has(refTestId);
      if (!exists) {
        out.push(
          mismatch(
            `traceability_matrix.requirements[${idx}].tests`,
            `requirement "${req.id}" references unknown test "${refTestId}"`,
          ),
        );
      }
    }
  });

  // Optional: orphan tests (declared but never referenced).
  testIds.forEach((id) => {
    if (!referenced.has(id)) {
      out.push(
        mismatch(
          `traceability_matrix.tests`,
          `test "${id}" is declared but no requirement references it`,
        ),
      );
    }
  });

  return out.length === 0 ? OK : fail(out);
}

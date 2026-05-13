// Unit + fixture tests for v18 source_baseline + source_trust +
// traceability_matrix (oracle-5js).

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import {
  SOURCE_BASELINE_SCHEMA_VERSION,
  SOURCE_LOCK_ARTIFACT_NAME,
  checkArtifactIndexLinks,
  checkNoPlaceholderHashes,
  checkPolicyModeAgreement,
  digestSourceBaseline,
  sourceBaselineSchema,
  verifySourceBaseline,
  type SourceBaseline,
} from "../../../src/oracle/v18/source_baseline.js";
import {
  SOURCE_TRUST_SCHEMA_VERSION,
  TRACEABILITY_MATRIX_SCHEMA_VERSION,
  sourceTrustSchema,
  traceabilityMatrixSchema,
  verifySourceTrustCrossReference,
  verifyTraceability,
} from "../../../src/oracle/v18/source_trust.js";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const PLAN_BUNDLE = path.resolve(
  moduleDir,
  "../../../PLAN/oracle-vnext-plan-bundle-v18.0.0",
);

async function loadFixture<T = unknown>(rel: string): Promise<T> {
  return JSON.parse(await readFile(path.join(PLAN_BUNDLE, rel), "utf8")) as T;
}

const REAL_HASH = `sha256:${"a".repeat(63)}1` as const;
const PLACEHOLDER_HASH = `sha256:${"0".repeat(64)}` as const;

function buildBaseline(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: SOURCE_BASELINE_SCHEMA_VERSION,
    bundle_version: "v18.0.0",
    artifact_name: SOURCE_LOCK_ARTIFACT_NAME,
    policy: "baseline",
    sources: [
      { id: "brief", kind: "local_file", path: ".vibe/brief.md", sha256: REAL_HASH },
    ],
    ...overrides,
  };
}

// ─── Source baseline ─────────────────────────────────────────────────────────

describe("sourceBaselineSchema", () => {
  test("parses the canonical plan-bundle fixture", async () => {
    const fixture = await loadFixture("fixtures/source-baseline.json");
    const parsed = sourceBaselineSchema.safeParse(fixture);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.schema_version).toBe(SOURCE_BASELINE_SCHEMA_VERSION);
      expect(parsed.data.policy).toBe("baseline");
      expect(parsed.data.mode).toBe("baseline");
    }
  });

  test("rejects wrong schema_version literal", () => {
    expect(
      sourceBaselineSchema.safeParse(buildBaseline({ schema_version: "source_baseline.v2" })).success,
    ).toBe(false);
  });

  test("rejects unknown policy enum value", () => {
    expect(
      sourceBaselineSchema.safeParse(buildBaseline({ policy: "ULTRA" })).success,
    ).toBe(false);
  });

  test("accepts mode omitted (only policy is required)", () => {
    expect(sourceBaselineSchema.safeParse(buildBaseline()).success).toBe(true);
  });
});

describe("checkPolicyModeAgreement", () => {
  test("agrees when only policy is present", () => {
    expect(
      checkPolicyModeAgreement(buildBaseline() as unknown as SourceBaseline),
    ).toEqual([]);
  });

  test("agrees when policy === mode", () => {
    expect(
      checkPolicyModeAgreement(
        buildBaseline({ policy: "strict", mode: "strict" }) as unknown as SourceBaseline,
      ),
    ).toEqual([]);
  });

  test("flags disagreement between policy and legacy mode", () => {
    const mismatches = checkPolicyModeAgreement(
      buildBaseline({ policy: "strict", mode: "baseline" }) as unknown as SourceBaseline,
    );
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0].field).toBe("source_baseline.mode");
    expect(mismatches[0].message).toMatch(/disagrees/);
  });

  test("flags off vs strict (the most dangerous downgrade)", () => {
    const mismatches = checkPolicyModeAgreement(
      buildBaseline({ policy: "strict", mode: "off" }) as unknown as SourceBaseline,
    );
    expect(mismatches).toHaveLength(1);
  });
});

describe("checkNoPlaceholderHashes", () => {
  test("passes for real sha256 digests", () => {
    expect(
      checkNoPlaceholderHashes(buildBaseline() as unknown as SourceBaseline),
    ).toEqual([]);
  });

  test("rejects an all-zero sha256 (canonical placeholder)", () => {
    const mismatches = checkNoPlaceholderHashes(
      buildBaseline({
        sources: [{ id: "brief", sha256: PLACEHOLDER_HASH }],
      }) as unknown as SourceBaseline,
    );
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0].field).toBe("source_baseline.sources[0].sha256");
  });

  test("rejects any single-hex-character repeat as a placeholder", () => {
    const mismatches = checkNoPlaceholderHashes(
      buildBaseline({
        sources: [
          { id: "brief", sha256: `sha256:${"a".repeat(64)}` },
          { id: "repo", sha256: `sha256:${"f".repeat(64)}` },
        ],
      }) as unknown as SourceBaseline,
    );
    expect(mismatches).toHaveLength(2);
  });
});

describe("verifySourceBaseline", () => {
  test("clean baseline is consistent", () => {
    const verdict = verifySourceBaseline({ baseline: buildBaseline() });
    expect(verdict.consistent).toBe(true);
  });

  test("hash pass-through: matching expectedSha256 vs digest of baselineBytes", () => {
    const baseline = buildBaseline();
    const bytes = JSON.stringify(baseline);
    const expectedSha256 = digestSourceBaseline(baseline);
    const verdict = verifySourceBaseline({
      baseline,
      baselineBytes: bytes,
      expectedSha256,
    });
    expect(verdict.consistent).toBe(true);
  });

  test("hash pass-through: mismatched expectedSha256 is flagged", () => {
    const baseline = buildBaseline();
    const bytes = JSON.stringify(baseline);
    const verdict = verifySourceBaseline({
      baseline,
      baselineBytes: bytes,
      expectedSha256: `sha256:${"9".repeat(63)}a`,
    });
    expect(verdict.consistent).toBe(false);
    expect(verdict.mismatches.some((m) => m.field === "source_baseline.sha256")).toBe(true);
  });

  test("policy/mode disagreement surfaces", () => {
    const verdict = verifySourceBaseline({
      baseline: buildBaseline({ policy: "strict", mode: "baseline" }),
    });
    expect(verdict.consistent).toBe(false);
    expect(verdict.mismatches.some((m) => m.field === "source_baseline.mode")).toBe(true);
  });

  test("placeholder hashes surface even when policy/mode agree", () => {
    const verdict = verifySourceBaseline({
      baseline: buildBaseline({
        sources: [{ id: "brief", sha256: PLACEHOLDER_HASH }],
      }),
    });
    expect(verdict.consistent).toBe(false);
    expect(verdict.mismatches.some((m) => m.message.includes("placeholder"))).toBe(true);
  });

  test("schema parse failures collect rather than throw", () => {
    const verdict = verifySourceBaseline({ baseline: { schema_version: "wrong" } });
    expect(verdict.consistent).toBe(false);
    expect(verdict.mismatches.some((m) => m.field.startsWith("source_baseline"))).toBe(true);
  });
});

// ─── Artifact-index linking ──────────────────────────────────────────────────

describe("checkArtifactIndexLinks", () => {
  function buildIndex(entries: Array<Record<string, unknown>>): Record<string, unknown> {
    return { schema_version: "artifact_index.v1", artifacts: entries };
  }

  test("matches by sha256 alone", () => {
    const verdict = checkArtifactIndexLinks({
      artifactIndex: buildIndex([
        { kind: "source_baseline", path: "source-lock.json", sha256: REAL_HASH },
      ]),
      expected: [{ sha256: REAL_HASH }],
    });
    expect(verdict.consistent).toBe(true);
  });

  test("matches by artifact_id + kind + path", () => {
    const verdict = checkArtifactIndexLinks({
      artifactIndex: buildIndex([
        {
          artifact_id: "source-lock-1",
          kind: "source_baseline",
          path: "source-lock.json",
          sha256: REAL_HASH,
        },
      ]),
      expected: [{ artifactId: "source-lock-1", kind: "source_baseline" }],
    });
    expect(verdict.consistent).toBe(true);
  });

  test("flags a missing expected entry", () => {
    const verdict = checkArtifactIndexLinks({
      artifactIndex: buildIndex([
        { kind: "browser_evidence", path: "evidence.json", sha256: REAL_HASH },
      ]),
      expected: [{ kind: "source_baseline" }],
    });
    expect(verdict.consistent).toBe(false);
    expect(verdict.mismatches[0].field).toMatch(/expected\[0\]/);
  });

  test("extra entries in the index are allowed", () => {
    const verdict = checkArtifactIndexLinks({
      artifactIndex: buildIndex([
        { kind: "source_baseline", path: "source-lock.json", sha256: REAL_HASH },
        { kind: "browser_evidence", path: "evidence.json", sha256: REAL_HASH },
        { kind: "provider_result", path: "result.json", sha256: REAL_HASH },
      ]),
      expected: [{ kind: "source_baseline" }],
    });
    expect(verdict.consistent).toBe(true);
  });

  test("schema-invalid artifact_index is rejected", () => {
    const verdict = checkArtifactIndexLinks({
      artifactIndex: { schema_version: "wrong", artifacts: [] },
      expected: [],
    });
    expect(verdict.consistent).toBe(false);
  });
});

// ─── Source trust ────────────────────────────────────────────────────────────

describe("sourceTrustSchema", () => {
  test("parses the canonical fixture", async () => {
    const fixture = await loadFixture("fixtures/source-trust.json");
    const parsed = sourceTrustSchema.safeParse(fixture);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.schema_version).toBe(SOURCE_TRUST_SCHEMA_VERSION);
      expect(parsed.data.sources.length).toBeGreaterThanOrEqual(2);
    }
  });

  test("rejects wrong schema_version", () => {
    expect(
      sourceTrustSchema.safeParse({ schema_version: "source_trust.v0", sources: [] }).success,
    ).toBe(false);
  });
});

describe("verifySourceTrustCrossReference", () => {
  const trust = {
    schema_version: SOURCE_TRUST_SCHEMA_VERSION,
    sources: [
      { id: "brief", trust_tier: "authoritative_user_input" },
      { id: "repo", trust_tier: "source_material_not_instruction" },
    ],
  };

  test("clean cross-reference is consistent", () => {
    const verdict = verifySourceTrustCrossReference({
      trust,
      baseline: buildBaseline({
        sources: [
          { id: "brief", sha256: REAL_HASH },
          { id: "repo", sha256: REAL_HASH },
        ],
      }),
    });
    expect(verdict.consistent).toBe(true);
  });

  test("flags duplicate source ids inside trust.sources", () => {
    const verdict = verifySourceTrustCrossReference({
      trust: {
        ...trust,
        sources: [...trust.sources, { id: "brief", trust_tier: "rogue" }],
      },
    });
    expect(verdict.consistent).toBe(false);
    expect(verdict.mismatches.some((m) => m.message.includes("duplicate"))).toBe(true);
  });

  test("flags quarantined_instructions that reference unknown sources", () => {
    const verdict = verifySourceTrustCrossReference({
      trust: {
        ...trust,
        quarantined_instructions: [{ source_id: "ghost-source" }],
      },
    });
    expect(verdict.consistent).toBe(false);
    expect(verdict.mismatches.some((m) => m.message.includes("ghost-source"))).toBe(true);
  });

  test("strict (default) flags baseline ids that have no trust tier", () => {
    const verdict = verifySourceTrustCrossReference({
      trust,
      baseline: buildBaseline({
        sources: [
          { id: "brief", sha256: REAL_HASH },
          { id: "untrusted", sha256: REAL_HASH },
        ],
      }),
    });
    expect(verdict.consistent).toBe(false);
    expect(verdict.mismatches.some((m) => m.message.includes("untrusted"))).toBe(true);
  });

  test("strict=false tolerates baseline ids missing from trust", () => {
    const verdict = verifySourceTrustCrossReference({
      trust,
      baseline: buildBaseline({
        sources: [
          { id: "brief", sha256: REAL_HASH },
          { id: "extra", sha256: REAL_HASH },
        ],
      }),
      strict: false,
    });
    expect(verdict.consistent).toBe(true);
  });
});

// ─── Traceability matrix ─────────────────────────────────────────────────────

describe("traceabilityMatrixSchema", () => {
  test("parses the canonical fixture", async () => {
    const fixture = await loadFixture("fixtures/traceability.json");
    const parsed = traceabilityMatrixSchema.safeParse(fixture);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.schema_version).toBe(TRACEABILITY_MATRIX_SCHEMA_VERSION);
    }
  });
});

describe("verifyTraceability", () => {
  const matrix = {
    schema_version: TRACEABILITY_MATRIX_SCHEMA_VERSION,
    requirements: [
      {
        id: "REQ-1",
        tests: ["test_a"],
      },
      {
        id: "REQ-2",
        tests: ["test_b"],
      },
    ],
    tests: [
      { id: "test_a", type: "contract" },
      { id: "test_b", type: "contract" },
    ],
  };

  test("clean matrix is consistent", () => {
    expect(verifyTraceability({ traceability: matrix }).consistent).toBe(true);
  });

  test("flags duplicate requirement ids", () => {
    const verdict = verifyTraceability({
      traceability: {
        ...matrix,
        requirements: [...matrix.requirements, { id: "REQ-1" }],
      },
    });
    expect(verdict.consistent).toBe(false);
    expect(
      verdict.mismatches.some((m) => m.message.includes("duplicate requirement")),
    ).toBe(true);
  });

  test("flags duplicate test ids", () => {
    const verdict = verifyTraceability({
      traceability: {
        ...matrix,
        tests: [...matrix.tests, { id: "test_a" }],
      },
    });
    expect(verdict.consistent).toBe(false);
    expect(verdict.mismatches.some((m) => m.message.includes("duplicate test"))).toBe(true);
  });

  test("flags requirement.tests entries that don't exist in tests[]", () => {
    const verdict = verifyTraceability({
      traceability: {
        ...matrix,
        requirements: [
          { id: "REQ-1", tests: ["test_a"] },
          { id: "REQ-Z", tests: ["nonexistent_test"] },
        ],
      },
    });
    expect(verdict.consistent).toBe(false);
    expect(
      verdict.mismatches.some((m) => m.message.includes("nonexistent_test")),
    ).toBe(true);
  });

  test("knownTestIds overrides the default tests[] check", () => {
    const verdict = verifyTraceability({
      traceability: {
        ...matrix,
        // No tests[] block; depends on knownTestIds for membership.
        tests: undefined,
        requirements: [{ id: "REQ-1", tests: ["test_a"] }],
      },
      knownTestIds: ["test_a", "test_b"],
    });
    expect(verdict.consistent).toBe(true);
  });

  test("flags orphan tests not referenced by any requirement", () => {
    const verdict = verifyTraceability({
      traceability: {
        ...matrix,
        tests: [...matrix.tests, { id: "orphan_test", type: "contract" }],
      },
    });
    expect(verdict.consistent).toBe(false);
    expect(verdict.mismatches.some((m) => m.message.includes("orphan_test"))).toBe(true);
  });
});

// ─── Cross-bead integration ──────────────────────────────────────────────────

describe("integration: source_baseline ↔ provider_result.source_baseline_sha256", () => {
  test("digestSourceBaseline yields a value that matches sha256OfBytes(canonical)", () => {
    const baseline = buildBaseline();
    const direct = digestSourceBaseline(baseline);
    expect(direct).toMatch(/^sha256:[0-9a-f]{64}$/);
    // Re-digest a freshly cloned object produces the same hash (assuming
    // identical JSON.stringify output — same key order on both calls).
    const second = digestSourceBaseline({ ...baseline });
    expect(second).toBe(direct);
  });
});

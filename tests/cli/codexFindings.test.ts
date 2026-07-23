import { describe, expect, it } from "vitest";
import { redactCodexValidationArtifact } from "../../src/cli/codexFindings.js";
import type { CodexFindingsResult } from "../../src/codex/types.js";

function detailResult(): CodexFindingsResult {
  return {
    status: "ok",
    operation: "detail",
    findingsUrl: "https://chatgpt.com/codex/cloud/security/findings/abc",
    warnings: [],
    tookMs: 1,
    detail: {
      finding: {
        id: "a".repeat(32),
        title: "Example",
        severity: "high",
        index: 0,
      },
      title: "Example",
      repo: null,
      sections: [],
      files: [],
      validationArtifact: "https://example.invalid/signed?secret=token",
    },
  };
}

describe("Codex findings output redaction", () => {
  it("redacts signed validation-artifact URLs by default without mutating the result", () => {
    const result = detailResult();
    const redacted = redactCodexValidationArtifact(result, false);
    expect(redacted.detail?.validationArtifact).toBeNull();
    expect(result.detail?.validationArtifact).toContain("secret=token");
  });

  it("reveals the URL only after explicit opt-in", () => {
    const result = detailResult();
    expect(redactCodexValidationArtifact(result, true)).toBe(result);
  });
});

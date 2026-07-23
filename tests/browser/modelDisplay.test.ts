import { describe, expect, test } from "vitest";
import type { BrowserModelSelectionEvidence, SessionMetadata } from "../../src/sessionStore.js";
import {
  formatBrowserModelSelectionEvidence,
  formatBrowserModelTarget,
  formatBrowserModelWithRequestedKey,
  formatSessionBrowserModelWithRequestedKey,
  resolveBrowserModelDisplayName,
  resolveSessionBrowserModelDisplayName,
  resolveTrustedBrowserModelDisplayName,
} from "../../src/browser/modelDisplay.js";

function evidence(
  overrides: Partial<BrowserModelSelectionEvidence> = {},
): BrowserModelSelectionEvidence {
  return {
    requestedModel: "GPT-5.5",
    requestedModelLabel: "GPT-5.5",
    resolvedLabel: "GPT-5.5",
    resolvedModelLabel: "GPT-5.5",
    modelVerified: true,
    strategy: "select",
    status: "already-selected",
    verified: true,
    source: "chatgpt-model-picker",
    capturedAt: "2026-07-23T00:00:00.000Z",
    ...overrides,
  };
}

function protectedSolProEvidence(
  overrides: Partial<BrowserModelSelectionEvidence> = {},
): BrowserModelSelectionEvidence {
  return evidence({
    requestedModel: "GPT-5.6 Sol",
    requestedModelLabel: "GPT-5.6 Sol",
    resolvedLabel: "GPT-5.6 Sol + Pro",
    resolvedModelLabel: "GPT-5.6 Sol",
    modelVerified: true,
    requestedMode: "Pro",
    resolvedModeLabel: "Pro",
    modeVerified: true,
    verifiedBeforePromptSubmit: true,
    ...overrides,
  });
}

describe("browser model display", () => {
  test("labels picker intent separately from the requested CLI key", () => {
    expect(formatBrowserModelTarget({ model: "gpt-5.6", desiredModel: "GPT-5.6 Sol" })).toBe(
      "target=GPT-5.6 Sol; requested=gpt-5.6",
    );
    expect(formatBrowserModelTarget({ model: "gpt-5.6-sol" })).toBe("requested=gpt-5.6-sol");
    expect(
      formatBrowserModelTarget({
        model: "gpt-5.5",
        desiredModel: "GPT-5.5",
        modelStrategy: "current",
      }),
    ).toBe("picker=current; requested=gpt-5.5");
    expect(
      formatBrowserModelTarget({
        model: "gpt-5.5",
        desiredModel: "GPT-5.5",
        modelStrategy: "ignore",
      }),
    ).toBe("picker=ignore; requested=gpt-5.5");
  });

  test("fails closed for legacy verified plus resolvedLabel evidence", () => {
    const legacy = evidence({
      requestedModelLabel: undefined,
      resolvedModelLabel: undefined,
      modelVerified: undefined,
      resolvedLabel: "Synthetic Target",
      verified: true,
    });

    expect(
      resolveTrustedBrowserModelDisplayName({ model: "gpt-5.5", evidence: legacy }),
    ).toBeNull();
    expect(resolveBrowserModelDisplayName({ model: "gpt-5.5", evidence: legacy })).toBe("gpt-5.5");
    expect(formatBrowserModelWithRequestedKey({ model: "gpt-5.5", evidence: legacy })).toBe(
      "gpt-5.5",
    );
    const details = formatBrowserModelSelectionEvidence(legacy, "gpt-5.5");
    expect(details).toContain("target=GPT-5.5");
    expect(details).toContain("trustedDisplay=(unverified)");
    expect(details).not.toContain("Synthetic Target");
  });

  test("uses only a separately verified observed model label", () => {
    const observed = evidence({ resolvedModelLabel: "GPT-5.5 Exact Picker Label" });
    expect(resolveBrowserModelDisplayName({ model: "gpt-5.5", evidence: observed })).toBe(
      "GPT-5.5 Exact Picker Label",
    );
    expect(formatBrowserModelWithRequestedKey({ model: "gpt-5.5", evidence: observed })).toBe(
      "GPT-5.5 Exact Picker Label (requested gpt-5.5)",
    );

    const unverified = evidence({ modelVerified: false });
    expect(resolveBrowserModelDisplayName({ model: "gpt-5.5", evidence: unverified })).toBe(
      "gpt-5.5",
    );
  });

  test.each([
    "Low",
    "Light",
    "Medium",
    "Standard",
    "High",
    "Very High",
    "xhigh",
    "X-High",
    "Extra-High",
    "Extended",
    "Heavy",
    "Max",
    "Ultra",
  ])("never launders effort-only label %s as an observed model", (resolvedModelLabel) => {
    expect(
      resolveTrustedBrowserModelDisplayName({
        model: "gpt-5.5",
        evidence: evidence({ resolvedModelLabel }),
      }),
    ).toBeNull();
  });

  test.each([
    ["effort-only", "High", { resolvedModelLabel: "High" }],
    ["combined model/mode", "GPT-5.6 Sol + Pro", { resolvedModelLabel: "GPT-5.6 Sol + Pro" }],
    [
      "configuration source",
      "Config Raw Model",
      { resolvedModelLabel: "Config Raw Model", source: "config" },
    ],
    [
      "failed selection status",
      "Skipped Raw Model",
      { resolvedModelLabel: "Skipped Raw Model", status: "skipped" },
    ],
    [
      "failed aggregate verification",
      "Unverified Raw Model",
      { resolvedModelLabel: "Unverified Raw Model", verified: false },
    ],
  ] as const)(
    "redacts %s raw observed-model provenance despite modelVerified=true",
    (_case, rawLabel, overrides) => {
      const details = formatBrowserModelSelectionEvidence(evidence(overrides), "gpt-5.5");

      expect(details).toContain("observedModel=(unverified)");
      expect(details).toContain("modelVerified=no");
      expect(details).not.toContain(rawLabel);
    },
  );

  test.each(["skipped", "unavailable", "switched-best-effort"] as const)(
    "requires a successful exact selection status instead of %s",
    (status) => {
      expect(
        resolveTrustedBrowserModelDisplayName({
          model: "gpt-5.5",
          evidence: evidence({ status }),
        }),
      ).toBeNull();
    },
  );

  test.each(["GPT-5.6 Sol + Pro", "GPT56 Sol Pro", "GPT5.6 Sol + Pro", "GPT 5 6 Sol Pro Preview"])(
    "rejects combined Sol plus Pro model-axis spelling %s",
    (resolvedModelLabel) => {
      expect(
        resolveTrustedBrowserModelDisplayName({
          model: "gpt-5.5",
          evidence: evidence({
            requestedModel: "GPT-5.5",
            requestedModelLabel: "GPT-5.5",
            resolvedModelLabel,
            requestedMode: undefined,
            resolvedModeLabel: undefined,
            modeVerified: undefined,
            verifiedBeforePromptSubmit: undefined,
          }),
        }),
      ).toBeNull();
    },
  );

  test.each(["GPT-6.5 Sol Pro", "GPT-5.60 Sol Pro"])(
    "does not confuse a different version with protected GPT-5.6: %s",
    (resolvedModelLabel) => {
      expect(
        resolveTrustedBrowserModelDisplayName({
          model: "gpt-other",
          evidence: evidence({
            requestedModel: resolvedModelLabel,
            requestedModelLabel: resolvedModelLabel,
            resolvedModelLabel,
          }),
        }),
      ).toBe(resolvedModelLabel);
    },
  );

  test("requires mode verification whenever a mode is part of the route", () => {
    const missingModeProof = evidence({
      requestedMode: "High",
      resolvedModeLabel: "High",
      modeVerified: false,
    });
    expect(resolveBrowserModelDisplayName({ model: "gpt-5.5", evidence: missingModeProof })).toBe(
      "gpt-5.5",
    );

    const verifiedMode = evidence({
      requestedMode: "High",
      resolvedModeLabel: "High",
      modeVerified: true,
    });
    expect(resolveBrowserModelDisplayName({ model: "gpt-5.5", evidence: verifiedMode })).toBe(
      "GPT-5.5 + High",
    );
  });

  test("shows protected Sol plus Pro only with all three independent proofs", () => {
    const complete = protectedSolProEvidence();
    expect(resolveBrowserModelDisplayName({ model: "gpt-5.6-sol", evidence: complete })).toBe(
      "GPT-5.6 Sol + Pro",
    );

    for (const incomplete of [
      protectedSolProEvidence({ modelVerified: false }),
      protectedSolProEvidence({ modeVerified: false }),
      protectedSolProEvidence({ verifiedBeforePromptSubmit: false }),
    ]) {
      expect(
        resolveTrustedBrowserModelDisplayName({ model: "gpt-5.6-sol", evidence: incomplete }),
      ).toBeNull();
      expect(resolveBrowserModelDisplayName({ model: "gpt-5.6-sol", evidence: incomplete })).toBe(
        "gpt-5.6-sol",
      );
    }
  });

  test("rejects inconsistent protected labels despite true proof booleans", () => {
    expect(
      resolveTrustedBrowserModelDisplayName({
        model: "gpt-5.6-sol",
        evidence: protectedSolProEvidence({ resolvedModelLabel: "GPT-5.6 Luna" }),
      }),
    ).toBeNull();
    expect(
      resolveTrustedBrowserModelDisplayName({
        model: "gpt-5.6-sol",
        evidence: protectedSolProEvidence({ resolvedModeLabel: "High" }),
      }),
    ).toBeNull();
  });

  test("requires pre-submit proof for an observed Sol plus Pro pair regardless of request fields", () => {
    const observedPair = protectedSolProEvidence({
      requestedModel: "GPT-5.5",
      requestedModelLabel: undefined,
      requestedMode: undefined,
      verifiedBeforePromptSubmit: false,
    });

    expect(
      resolveTrustedBrowserModelDisplayName({
        model: "gpt-5.5",
        evidence: observedPair,
      }),
    ).toBeNull();
    expect(resolveBrowserModelDisplayName({ model: "gpt-5.5", evidence: observedPair })).toBe(
      "gpt-5.5",
    );
    expect(
      resolveTrustedBrowserModelDisplayName({
        model: "gpt-5.5",
        evidence: { ...observedPair, verifiedBeforePromptSubmit: true },
      }),
    ).toBe("GPT-5.6 Sol + Pro");
  });

  test("rejects contradictory requested and observed protected identities", () => {
    expect(
      resolveTrustedBrowserModelDisplayName({
        model: "gpt-5.5",
        evidence: protectedSolProEvidence({
          requestedModel: "GPT-5.5",
          requestedModelLabel: "GPT-5.5",
        }),
      }),
    ).toBeNull();
    expect(
      resolveTrustedBrowserModelDisplayName({
        model: "gpt-5.6-sol",
        evidence: protectedSolProEvidence({ requestedMode: "High" }),
      }),
    ).toBeNull();
  });

  test("requires mode proof whenever an observed mode would be displayed", () => {
    expect(
      resolveTrustedBrowserModelDisplayName({
        model: "gpt-5.5",
        evidence: evidence({
          requestedMode: undefined,
          resolvedModeLabel: "High",
          modeVerified: false,
        }),
      }),
    ).toBeNull();
  });

  test("fails closed when the aggregate verification contradicts independent proofs", () => {
    expect(
      resolveTrustedBrowserModelDisplayName({
        model: "gpt-5.6-sol",
        evidence: protectedSolProEvidence({ verified: false }),
      }),
    ).toBeNull();
  });

  test("applies session evidence only to the primary browser model", () => {
    const metadata: SessionMetadata = {
      id: "session",
      createdAt: "2026-07-23T00:00:00.000Z",
      status: "completed",
      mode: "browser",
      model: "gpt-5.6-sol",
      options: {},
      browser: { modelSelection: protectedSolProEvidence() },
    };

    expect(resolveSessionBrowserModelDisplayName(metadata)).toBe("GPT-5.6 Sol + Pro");
    expect(formatSessionBrowserModelWithRequestedKey(metadata)).toBe(
      "GPT-5.6 Sol + Pro (requested gpt-5.6-sol)",
    );
    expect(formatSessionBrowserModelWithRequestedKey(metadata, "gpt-5.5")).toBe("gpt-5.5");
  });

  test("formats structured provenance without laundering legacy labels", () => {
    const details = formatBrowserModelSelectionEvidence(protectedSolProEvidence(), "gpt-5.6-sol");
    expect(details).toContain("requestedKey=gpt-5.6-sol");
    expect(details).toContain("target=GPT-5.6 Sol");
    expect(details).toContain("observedModel=GPT-5.6 Sol");
    expect(details).toContain("modelVerified=yes");
    expect(details).toContain("requestedMode=Pro");
    expect(details).toContain("observedMode=Pro");
    expect(details).toContain("modeVerified=yes");
    expect(details).toContain("verifiedBeforePromptSubmit=yes");
    expect(details).toContain("trustedDisplay=GPT-5.6 Sol + Pro");
  });
});

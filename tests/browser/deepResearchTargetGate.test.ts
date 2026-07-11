// Perf gate for the Deep Research OOPIF target scan. readDeepResearchTargetResult
// pays a Target.setAutoAttach enable/disable cycle plus a fixed settle delay on
// every 5s tick; before the sandboxed report iframe mounts there is nothing to
// read, so the scan is gated on cheap main-page evidence. Once ANY evidence
// appears the scan runs every tick so completion is never missed.

import { describe, expect, test } from "vitest";
import { shouldReadDeepResearchTarget } from "../../src/browser/actions/deepResearch.js";

describe("shouldReadDeepResearchTarget", () => {
  test("skips the scan when the cheap main-page poll shows no research evidence", () => {
    expect(
      shouldReadDeepResearchTarget({
        hasIframe: false,
        researchActivity: false,
        stopVisible: false,
        hasActiveScopedResearch: false,
        observedResearchEvidence: false,
      }),
    ).toBe(false);
    // Undefined fields (the earliest waiting ticks) count as "no evidence".
    expect(shouldReadDeepResearchTarget({})).toBe(false);
  });

  test.each([
    ["a report iframe is mounted", { hasIframe: true }],
    ["research/planning activity is visible", { researchActivity: true }],
    ["generation is still running", { stopVisible: true }],
    ["a scoped research iframe is active", { hasActiveScopedResearch: true }],
    ["research was already observed on a prior tick", { observedResearchEvidence: true }],
  ])("scans when %s", (_why, signals) => {
    expect(shouldReadDeepResearchTarget(signals)).toBe(true);
  });

  test("the completed report keeps the scan live: hasIframe stays true through completion", () => {
    // The finished report always renders inside a large iframe, so completion is
    // never dropped by the gate even after the stop button and activity clear.
    expect(
      shouldReadDeepResearchTarget({
        hasIframe: true,
        stopVisible: false,
        researchActivity: false,
      }),
    ).toBe(true);
  });
});

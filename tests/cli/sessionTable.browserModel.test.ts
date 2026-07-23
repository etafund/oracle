import { describe, expect, test } from "vitest";
import type { SessionMetadata } from "../../src/sessionStore.js";
import {
  formatSessionTableHeader,
  formatSessionTableRow,
  MODEL_PAD,
} from "../../src/cli/sessionTable.js";

function browserSession(): SessionMetadata {
  return {
    id: "browser-session",
    createdAt: "2026-07-23T00:00:00.000Z",
    status: "completed",
    model: "gpt-5.6-sol",
    mode: "browser",
    options: { prompt: "hi" },
    browser: {
      modelSelection: {
        requestedModel: "GPT-5.6 Sol",
        requestedModelLabel: "GPT-5.6 Sol",
        resolvedLabel: "GPT-5.6 Sol + Pro",
        resolvedModelLabel: "GPT-5.6 Sol",
        modelVerified: true,
        requestedMode: "Pro",
        resolvedModeLabel: "Pro",
        modeVerified: true,
        verifiedBeforePromptSubmit: true,
        strategy: "select",
        status: "already-selected",
        verified: true,
        source: "chatgpt-model-picker",
        capturedAt: "2026-07-23T00:00:00.000Z",
      },
    },
  };
}

describe("browser model session table display", () => {
  test("uses independently verified picker identity", () => {
    const header = formatSessionTableHeader(false);
    const row = formatSessionTableRow(browserSession(), { rich: false });

    expect(row).toContain("GPT-5.6 Sol + Pro");
    expect(MODEL_PAD).toBeGreaterThanOrEqual("GPT-5.6 Sol + Pro".length);
    expect(row.indexOf("browser")).toBe(resolveModeColumnStart(header));
  });

  test("fails closed to the requested key for legacy evidence", () => {
    const metadata = browserSession();
    metadata.browser = {
      modelSelection: {
        requestedModel: "GPT-5.6 Sol",
        resolvedLabel: "Synthetic GPT-5.6 Sol + Pro",
        strategy: "select",
        status: "already-selected",
        verified: true,
        source: "chatgpt-model-picker",
        capturedAt: "2026-07-23T00:00:00.000Z",
      },
    };

    const row = formatSessionTableRow(metadata, { rich: false });
    expect(row).toContain("gpt-5.6-sol");
    expect(row).not.toContain("Synthetic");
  });

  test("truncates unexpectedly long observed labels without shifting later columns", () => {
    const metadata = browserSession();
    metadata.model = "gpt-custom";
    metadata.browser!.modelSelection = {
      ...metadata.browser!.modelSelection!,
      requestedModel: "Custom Model",
      requestedModelLabel: "Custom Model",
      resolvedModelLabel: "A Very Long Observed Browser Model Label",
      requestedMode: undefined,
      resolvedModeLabel: undefined,
      modeVerified: undefined,
      verifiedBeforePromptSubmit: undefined,
    };
    const header = formatSessionTableHeader(false);
    const row = formatSessionTableRow(metadata, { rich: false });
    const modelStart = header.indexOf("Model");
    const modeStart = resolveModeColumnStart(header);
    const modelCell = row.slice(modelStart, modeStart - 1);

    expect(Array.from(modelCell)).toHaveLength(MODEL_PAD);
    expect(modelCell).toMatch(/…$/u);
    expect(row.indexOf("browser")).toBe(modeStart);
  });
});

function resolveModeColumnStart(header: string): number {
  const modelStart = header.indexOf("Model");
  return header.indexOf("Mode", modelStart + "Model".length);
}

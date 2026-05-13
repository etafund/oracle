import { describe, expect, test } from "vitest";

import {
  GEMINI_DEEP_THINK_FAILURE_STATES,
  GEMINI_DEEP_THINK_LEGAL_STATES,
  GEMINI_DEEP_THINK_SELECTOR_MANIFEST_VERSION,
  applyGeminiDeepThinkEvents,
  createGeminiDeepThinkMachine,
  geminiDeepThinkErrorCodeForFailure,
  geminiDeepThinkLegalStateRank,
  geminiDeepThinkMachineVerdict,
  isGeminiDeepThinkFailureState,
  isGeminiDeepThinkSuccessState,
  transitionGeminiDeepThink,
  verifyGeminiDeepThinkCandidate,
  type GeminiDeepThinkEvent,
} from "../../../src/browser/providers/geminiDeepThink_verification.js";

const PROMPT_HASH = `sha256:${"a".repeat(64)}` as const;
const OUTPUT_HASH = `sha256:${"b".repeat(64)}` as const;
const SESSION_HASH = `sha256:${"c".repeat(64)}` as const;

function fullHappyPath(): readonly GeminiDeepThinkEvent[] {
  return [
    { type: "browser_connected", mode: "remote" },
    { type: "login_verified" },
    { type: "gemini_model_candidate_selected", modelLabel: "Gemini 3 Pro" },
    { type: "deep_think_menu_opened" },
    {
      type: "deep_think_candidate_selected",
      deepThinkLabel: "Deep Think",
      observedThinkingLevelLabels: ["standard", "high"],
      selectedThinkingLevel: "high",
      thinkingLevelControlExposed: true,
    },
    {
      type: "deep_think_verified_same_session",
      sessionIdHash: SESSION_HASH,
      verifiedAt: "2026-05-12T00:00:00.000Z",
    },
    {
      type: "submit_prompt",
      promptSha256: PROMPT_HASH,
      submittedAt: "2026-05-12T00:00:05.000Z",
    },
    { type: "response_stream_started" },
    {
      type: "response_arrived",
      outputTextSha256: OUTPUT_HASH,
      bytesLength: 2048,
      capturedAt: "2026-05-12T00:00:08.000Z",
    },
    {
      type: "evidence_written",
      evidenceId: "evidence-gemini-test-1",
      writtenAt: "2026-05-12T00:00:09.000Z",
    },
    { type: "finish" },
  ];
}

describe("Gemini Deep Think FSM taxonomy", () => {
  test("legal states match the bead's required order", () => {
    expect([...GEMINI_DEEP_THINK_LEGAL_STATES]).toEqual([
      "session_start",
      "remote_or_local_browser_connected",
      "login_verified",
      "gemini_model_candidate_selected",
      "deep_think_menu_open",
      "deep_think_candidate_selected",
      "deep_think_verified_same_session",
      "prompt_submitted",
      "response_streaming",
      "output_captured_nonempty",
      "evidence_written",
      "success",
    ]);
  });

  test("failure states map to v18 error taxonomy", () => {
    expect(new Set(GEMINI_DEEP_THINK_FAILURE_STATES)).toEqual(
      new Set([
        "login_required",
        "deep_think_unverified",
        "ui_drift_suspected",
        "usage_limit",
        "output_empty",
        "prompt_submitted_before_verification",
        "remote_browser_unavailable",
      ]),
    );
    expect(geminiDeepThinkErrorCodeForFailure("login_required")).toBe("provider_login_required");
    expect(geminiDeepThinkErrorCodeForFailure("deep_think_unverified")).toBe(
      "gemini_deep_think_unverified",
    );
    expect(geminiDeepThinkErrorCodeForFailure("ui_drift_suspected")).toBe("ui_drift_suspected");
    expect(geminiDeepThinkErrorCodeForFailure("prompt_submitted_before_verification")).toBe(
      "prompt_submitted_before_verification",
    );
  });

  test("legal state ranks strictly increase", () => {
    for (let i = 1; i < GEMINI_DEEP_THINK_LEGAL_STATES.length; i += 1) {
      expect(geminiDeepThinkLegalStateRank(GEMINI_DEEP_THINK_LEGAL_STATES[i])).toBeGreaterThan(
        geminiDeepThinkLegalStateRank(GEMINI_DEEP_THINK_LEGAL_STATES[i - 1]),
      );
    }
  });
});

describe("Gemini Deep Think FSM legal transitions", () => {
  test("happy path reaches success with same-session verification context", () => {
    const machine = applyGeminiDeepThinkEvents(createGeminiDeepThinkMachine(), fullHappyPath());

    expect(machine.state).toBe("success");
    expect(isGeminiDeepThinkSuccessState(machine.state)).toBe(true);
    expect(machine.context.mode).toBe("remote");
    expect(machine.context.modelLabel).toBe("Gemini 3 Pro");
    expect(machine.context.deepThink?.status).toBe("verified");
    expect(machine.context.deepThink?.selected).toBe("high");
    expect(machine.context.deepThink?.selectedIsHighestVisible).toBe(true);
    expect(machine.context.deepThink?.selectorManifestVersion).toBe(
      GEMINI_DEEP_THINK_SELECTOR_MANIFEST_VERSION,
    );
    expect(machine.context.sessionIdHash).toBe(SESSION_HASH);
    expect(machine.context.promptSha256).toBe(PROMPT_HASH);
    expect(machine.context.outputTextSha256).toBe(OUTPUT_HASH);
    expect(machine.context.evidenceId).toBe("evidence-gemini-test-1");
  });

  test("machine verdict surfaces verified=true only on success", () => {
    const machine = applyGeminiDeepThinkEvents(createGeminiDeepThinkMachine(), fullHappyPath());
    const verdict = geminiDeepThinkMachineVerdict(machine);

    expect(verdict).toEqual({
      state: "success",
      verified: true,
      errorCode: null,
      failureReason: null,
      evidenceId: "evidence-gemini-test-1",
    });
  });

  test("transition is pure and out-of-order events are ignored", () => {
    const machine = createGeminiDeepThinkMachine();
    const event = { type: "browser_connected", mode: "local" } as const;
    const first = transitionGeminiDeepThink(machine.state, machine.context, event);
    const second = transitionGeminiDeepThink(machine.state, machine.context, event);
    expect(first).toEqual(second);

    const outOfOrder = createGeminiDeepThinkMachine().send({ type: "login_verified" });
    expect(outOfOrder.state).toBe("session_start");
  });
});

describe("Gemini Deep Think candidate verification", () => {
  test("verifies Deep Think with high-if-exposed thinking level", () => {
    const verdict = verifyGeminiDeepThinkCandidate({
      deepThinkLabel: "Deep Think",
      observedThinkingLevelLabels: ["standard", "high"],
      selectedThinkingLevel: "high",
      thinkingLevelControlExposed: true,
    });

    expect(verdict.status).toBe("verified");
    expect(verdict.tier).toBe("high");
    expect(verdict.rank).toBe(20);
    expect(verdict.thinkingLevelVerified).toBe(true);
    expect(verdict.availableEffortLabelsHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test("accepts Deep Think when no thinking level control is exposed", () => {
    const verdict = verifyGeminiDeepThinkCandidate({
      deepThinkLabel: "Deep Think",
      observedThinkingLevelLabels: [],
      thinkingLevelControlExposed: false,
    });

    expect(verdict.status).toBe("verified");
    expect(verdict.selected).toBe("Deep Think");
    expect(verdict.tier).toBe("deep_think");
    expect(verdict.thinkingLevelControlExposed).toBe(false);
  });

  test("rejects missing Deep Think labels", () => {
    const machine = applyGeminiDeepThinkEvents(createGeminiDeepThinkMachine(), [
      { type: "browser_connected", mode: "remote" },
      { type: "login_verified" },
      { type: "gemini_model_candidate_selected", modelLabel: "Gemini 3 Pro" },
      { type: "deep_think_menu_opened" },
      {
        type: "deep_think_candidate_selected",
        deepThinkLabel: "Search",
        observedThinkingLevelLabels: ["high"],
        selectedThinkingLevel: "high",
      },
    ]);

    expect(machine.state).toBe("deep_think_unverified");
    expect(geminiDeepThinkMachineVerdict(machine).errorCode).toBe("gemini_deep_think_unverified");
    expect(machine.context.failureReason).toMatch(/does not verify Deep Think/);
  });

  test("detects UI drift when exposed thinking labels are unknown", () => {
    const machine = applyGeminiDeepThinkEvents(createGeminiDeepThinkMachine(), [
      { type: "browser_connected", mode: "remote" },
      { type: "login_verified" },
      { type: "gemini_model_candidate_selected", modelLabel: "Gemini 3 Pro" },
      { type: "deep_think_menu_opened" },
      {
        type: "deep_think_candidate_selected",
        deepThinkLabel: "Deep Think",
        observedThinkingLevelLabels: ["galactic"],
        selectedThinkingLevel: "galactic",
        thinkingLevelControlExposed: true,
      },
    ]);

    expect(machine.state).toBe("ui_drift_suspected");
    expect(geminiDeepThinkMachineVerdict(machine).errorCode).toBe("ui_drift_suspected");
  });
});

describe("Gemini Deep Think FSM blockers", () => {
  test("login_required is absorbing and typed", () => {
    const machine = applyGeminiDeepThinkEvents(createGeminiDeepThinkMachine(), [
      { type: "browser_connected", mode: "remote" },
      { type: "login_required" },
      { type: "login_verified" },
    ]);

    expect(machine.state).toBe("login_required");
    expect(isGeminiDeepThinkFailureState(machine.state)).toBe(true);
    expect(geminiDeepThinkMachineVerdict(machine).errorCode).toBe("provider_login_required");
  });

  test("submit_prompt before Deep Think same-session verification is rejected", () => {
    const fromStart = createGeminiDeepThinkMachine().send({
      type: "submit_prompt",
      promptSha256: PROMPT_HASH,
    });
    expect(fromStart.state).toBe("prompt_submitted_before_verification");

    const preVerify = applyGeminiDeepThinkEvents(createGeminiDeepThinkMachine(), [
      { type: "browser_connected", mode: "remote" },
      { type: "login_verified" },
      { type: "gemini_model_candidate_selected", modelLabel: "Gemini 3 Pro" },
      { type: "deep_think_menu_opened" },
      {
        type: "deep_think_candidate_selected",
        deepThinkLabel: "Deep Think",
        observedThinkingLevelLabels: ["high"],
        selectedThinkingLevel: "high",
      },
      { type: "submit_prompt", promptSha256: PROMPT_HASH },
    ]);
    expect(preVerify.state).toBe("prompt_submitted_before_verification");
    expect(geminiDeepThinkMachineVerdict(preVerify).errorCode).toBe(
      "prompt_submitted_before_verification",
    );
  });

  test("prompt timestamps before verification are rejected", () => {
    const machine = applyGeminiDeepThinkEvents(createGeminiDeepThinkMachine(), [
      { type: "browser_connected", mode: "remote" },
      { type: "login_verified" },
      { type: "gemini_model_candidate_selected", modelLabel: "Gemini 3 Pro" },
      { type: "deep_think_menu_opened" },
      {
        type: "deep_think_candidate_selected",
        deepThinkLabel: "Deep Think",
        observedThinkingLevelLabels: ["high"],
        selectedThinkingLevel: "high",
      },
      {
        type: "deep_think_verified_same_session",
        sessionIdHash: SESSION_HASH,
        verifiedAt: "2026-05-12T00:00:05.000Z",
      },
      {
        type: "submit_prompt",
        promptSha256: PROMPT_HASH,
        submittedAt: "2026-05-12T00:00:04.000Z",
      },
    ]);

    expect(machine.state).toBe("prompt_submitted_before_verification");
    expect(machine.context.failureReason).toMatch(/precedes Deep Think/);
  });

  test("empty output and evidence timestamp inversions are blocked", () => {
    const emptyOutput = applyGeminiDeepThinkEvents(createGeminiDeepThinkMachine(), [
      ...fullHappyPath().slice(0, 8),
      {
        type: "response_arrived",
        outputTextSha256: OUTPUT_HASH,
        bytesLength: 0,
        capturedAt: "2026-05-12T00:00:08.000Z",
      },
    ]);
    expect(emptyOutput.state).toBe("output_empty");
    expect(geminiDeepThinkMachineVerdict(emptyOutput).errorCode).toBe("output_capture_empty");

    const badEvidenceTime = applyGeminiDeepThinkEvents(createGeminiDeepThinkMachine(), [
      ...fullHappyPath().slice(0, 9),
      {
        type: "evidence_written",
        evidenceId: "evidence-bad-time",
        writtenAt: "2026-05-12T00:00:07.000Z",
      },
    ]);
    expect(badEvidenceTime.state).toBe("ui_drift_suspected");
    expect(badEvidenceTime.context.failureReason).toMatch(/evidence timestamp/);
  });
});

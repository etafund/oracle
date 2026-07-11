// Mid-run CDP reattach restoration for the ChatGPT Pro FSM.
//
// Regression: after a session drop AFTER output was captured / evidence was
// written, reattach_succeeded collapsed every post-submit state back to
// response_waiting. That either failed an otherwise-successful (paid) run when
// the driver sent `finish` (which requires evidence_written) or forced a
// needless re-capture. Post-capture reattach must be idempotent — it restores
// the exact pre-drop legal state — while earlier states still resume at
// response_waiting.

import { describe, expect, test } from "vitest";

import {
  createChatGptProMachine,
  type ChatGptProEvent,
  type ChatGptProMachine,
} from "../../src/browser/state/chatgptPro.js";

const PROMPT_HASH = `sha256:${"a".repeat(64)}` as const;
const OUTPUT_HASH = `sha256:${"b".repeat(64)}` as const;
const SESSION_HASH = `sha256:${"c".repeat(64)}` as const;
const REATTACHED_SESSION_HASH = `sha256:${"d".repeat(64)}` as const;

function drive(machine: ChatGptProMachine, events: readonly ChatGptProEvent[]): ChatGptProMachine {
  return events.reduce((current, event) => current.send(event), machine);
}

function verifiedMachine(): ChatGptProMachine {
  return drive(createChatGptProMachine(), [
    { type: "browser_connected", mode: "remote" },
    { type: "login_verified" },
    { type: "model_menu_opened" },
    { type: "pro_candidate_selected", modelLabel: "GPT-5.5 Pro" },
    { type: "effort_candidate_selected", observedEffortLabels: ["Heavy", "Pro Extended"] },
    { type: "mode_verified_same_session", sessionIdHash: SESSION_HASH },
  ]);
}

function submittedMachine(): ChatGptProMachine {
  return verifiedMachine().send({ type: "submit_prompt", promptSha256: PROMPT_HASH });
}

function capturedMachine(): ChatGptProMachine {
  return submittedMachine().send({
    type: "response_arrived",
    outputTextSha256: OUTPUT_HASH,
    bytesLength: 1234,
  });
}

function evidenceMachine(): ChatGptProMachine {
  return capturedMachine().send({ type: "evidence_written", evidenceId: "evidence-1" });
}

describe("ChatGPT Pro FSM — post-capture reattach is idempotent", () => {
  test("output_captured survives a reattach and can still reach success", () => {
    const captured = capturedMachine();
    expect(captured.state).toBe("output_captured");

    const pending = captured.send({
      type: "session_lost",
      reason: "CDP target closed",
      recoveryCommand: "oracle session sess-x --render",
    });
    expect(pending.state).toBe("reattach_pending");
    expect(pending.context.stateBeforeReattach).toBe("output_captured");

    const resumed = pending.send({
      type: "reattach_succeeded",
      sessionIdHash: REATTACHED_SESSION_HASH,
    });
    // The bug returned response_waiting here.
    expect(resumed.state).toBe("output_captured");
    expect(resumed.context.outputTextSha256).toBe(OUTPUT_HASH);
    expect(resumed.context.sessionIdHash).toBe(REATTACHED_SESSION_HASH);
    expect(resumed.context.reattachRecoveryCommand).toBeNull();
    expect(resumed.context.failureReason).toBeNull();

    const finished = drive(resumed, [
      { type: "evidence_written", evidenceId: "evidence-after-reattach" },
      { type: "finish" },
    ]);
    expect(finished.state).toBe("success");
    expect(finished.context.evidenceId).toBe("evidence-after-reattach");
  });

  test("evidence_written survives a reattach and `finish` still succeeds (no spurious ui_drift)", () => {
    const evidence = evidenceMachine();
    expect(evidence.state).toBe("evidence_written");

    const pending = evidence.send({ type: "session_lost", reason: "socket dropped" });
    expect(pending.state).toBe("reattach_pending");
    expect(pending.context.stateBeforeReattach).toBe("evidence_written");

    const resumed = pending.send({ type: "reattach_succeeded" });
    // The bug returned response_waiting; `finish` then failed as ui_drift_suspected.
    expect(resumed.state).toBe("evidence_written");
    expect(resumed.context.evidenceId).toBe("evidence-1");
    expect(resumed.context.outputTextSha256).toBe(OUTPUT_HASH);

    const finished = resumed.send({ type: "finish" });
    expect(finished.state).toBe("success");
  });
});

describe("ChatGPT Pro FSM — pre-capture reattach still resumes response_waiting", () => {
  test("prompt_submitted reattaches to response_waiting", () => {
    const pending = submittedMachine().send({ type: "session_lost", reason: "drop" });
    expect(pending.context.stateBeforeReattach).toBe("prompt_submitted");
    const resumed = pending.send({ type: "reattach_succeeded" });
    expect(resumed.state).toBe("response_waiting");
  });

  test("response_waiting reattaches to response_waiting (a second drop is still recoverable)", () => {
    const resumedOnce = submittedMachine()
      .send({ type: "session_lost", reason: "first drop" })
      .send({ type: "reattach_succeeded" });
    expect(resumedOnce.state).toBe("response_waiting");

    const resumedTwice = resumedOnce
      .send({ type: "session_lost", reason: "second drop" })
      .send({ type: "reattach_succeeded" });
    expect(resumedTwice.context.stateBeforeReattach).toBeNull();
    expect(resumedTwice.state).toBe("response_waiting");
  });

  test("a pre-submit mode-verified drop still restores mode_verified_same_session", () => {
    const pending = verifiedMachine().send({ type: "session_lost", reason: "pre-submit drop" });
    expect(pending.context.stateBeforeReattach).toBe("mode_verified_same_session");
    const resumed = pending.send({ type: "reattach_succeeded" });
    expect(resumed.state).toBe("mode_verified_same_session");
    // Still gated: submit is the only legal next step, and it works.
    expect(resumed.send({ type: "submit_prompt", promptSha256: PROMPT_HASH }).state).toBe(
      "prompt_submitted",
    );
  });
});

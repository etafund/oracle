import { describe, expect, test } from "vitest";
import {
  assertChatGptProFormalPlanReady,
  ChatGptProFormalPlanRouteError,
  planChatGptProFormalPlanSubmission,
} from "../../src/browser/providers/chatgptProFormalPlan.js";
import {
  applyChatGptProEvents,
  createChatGptProMachine,
  type ChatGptProMachine,
} from "../../src/browser/providers/chatgptProVerification.js";

const SESSION_HASH = `sha256:${"c".repeat(64)}` as const;
const PROMPT_HASH = `sha256:${"a".repeat(64)}` as const;

function verifiedMachine(): ChatGptProMachine {
  return applyChatGptProEvents(createChatGptProMachine(), [
    { type: "browser_connected", mode: "remote" },
    { type: "login_verified" },
    { type: "model_menu_opened" },
    { type: "pro_candidate_selected", modelLabel: "GPT-5.5 Pro" },
    { type: "effort_candidate_selected", observedEffortLabels: ["Standard", "Heavy"] },
    { type: "mode_verified_same_session", sessionIdHash: SESSION_HASH },
  ]);
}

describe("ChatGPT Pro formal-plan route gate", () => {
  test("allows prompt submission only after same-session Pro and highest-visible effort verification", () => {
    const decision = planChatGptProFormalPlanSubmission({
      slot: "chatgpt_pro_first_plan",
      machine: verifiedMachine(),
      accessPath: "oracle_browser_remote",
      remoteBrowserPolicy: "preferred",
    });

    expect(decision).toMatchObject({
      schema_version: "chatgpt_pro_formal_plan_route.v1",
      ok: true,
      status: "ready_to_submit",
      can_submit_prompt: true,
      verified_before_prompt_submit: true,
      mode_verified_same_session: true,
      requested_reasoning_effort: "max_browser_available",
      selected_effort_is_highest_visible: true,
      observed_mode_label: "GPT-5.5 Pro",
      observed_reasoning_effort_label: "Heavy",
      effort_rank: 60,
      session_id_hash: SESSION_HASH,
    });
    expect(decision.available_effort_labels_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(decision.commands.run).toContain("--chatgpt-pro");
  });

  test("blocks direct API substitution even when the browser verifier is ready", () => {
    const decision = planChatGptProFormalPlanSubmission({
      slot: "chatgpt_pro_first_plan",
      machine: verifiedMachine(),
      accessPath: "openai_api",
    });

    expect(decision.ok).toBe(false);
    expect(decision.can_submit_prompt).toBe(false);
    expect(decision.blockers).toContainEqual(
      expect.objectContaining({
        field: "access_path",
        code: "chatgpt_pro_unverified",
      }),
    );
  });

  test("blocks prompt submission before mode_verified_same_session", () => {
    const preVerify = applyChatGptProEvents(createChatGptProMachine(), [
      { type: "browser_connected", mode: "remote" },
      { type: "login_verified" },
      { type: "model_menu_opened" },
      { type: "pro_candidate_selected", modelLabel: "GPT-5.5 Pro" },
      { type: "effort_candidate_selected", observedEffortLabels: ["Heavy"] },
    ]);

    const decision = planChatGptProFormalPlanSubmission({
      slot: "chatgpt_pro_first_plan",
      machine: preVerify,
      accessPath: "oracle_browser_remote",
    });

    expect(decision.ok).toBe(false);
    expect(decision.blockers).toContainEqual(
      expect.objectContaining({
        field: "chatgpt_pro.same_session_verification",
        code: "prompt_submitted_before_verification",
      }),
    );
  });

  test("propagates the FSM prompt-before-verify failure as a typed route blocker", () => {
    const failed = createChatGptProMachine().send({
      type: "submit_prompt",
      promptSha256: PROMPT_HASH,
    });
    const decision = planChatGptProFormalPlanSubmission({
      slot: "chatgpt_pro_first_plan",
      machine: failed,
      accessPath: "oracle_browser_remote",
    });

    expect(decision.ok).toBe(false);
    expect(decision.blockers).toContainEqual(
      expect.objectContaining({
        field: "chatgpt_pro.state",
        code: "prompt_submitted_before_verification",
      }),
    );
  });

  test("blocks verified effort if it is not the highest visible option", () => {
    const ready = verifiedMachine();
    const degraded: ChatGptProMachine = {
      ...ready,
      context: {
        ...ready.context,
        effort: ready.context.effort
          ? { ...ready.context.effort, selectedIsHighestVisible: false }
          : null,
      },
    };

    const decision = planChatGptProFormalPlanSubmission({
      slot: "chatgpt_pro_first_plan",
      machine: degraded,
      accessPath: "oracle_browser_remote",
    });

    expect(decision.ok).toBe(false);
    expect(decision.blockers).toContainEqual(
      expect.objectContaining({
        field: "chatgpt_pro.effort.selected_is_highest_visible",
        code: "chatgpt_extended_reasoning_unverified",
      }),
    );
  });

  test("allows local browser only when remote is preferred rather than required", () => {
    const preferred = planChatGptProFormalPlanSubmission({
      slot: "chatgpt_pro_first_plan",
      machine: verifiedMachine(),
      accessPath: "oracle_browser_local",
      remoteBrowserPolicy: "preferred",
    });
    expect(preferred.ok).toBe(true);
    expect(preferred.warnings[0]).toMatch(/Remote browser is preferred/);

    const required = planChatGptProFormalPlanSubmission({
      slot: "chatgpt_pro_first_plan",
      machine: verifiedMachine(),
      accessPath: "oracle_browser_local",
      remoteBrowserPolicy: "required",
    });
    expect(required.ok).toBe(false);
    expect(required.blockers).toContainEqual(
      expect.objectContaining({
        field: "remote_browser",
        code: "remote_browser_unavailable",
      }),
    );
  });

  test("assert helper throws with the typed decision attached", () => {
    expect(() =>
      assertChatGptProFormalPlanReady({
        slot: "chatgpt_pro_first_plan",
        machine: createChatGptProMachine(),
        accessPath: "oracle_browser_remote",
      }),
    ).toThrow(ChatGptProFormalPlanRouteError);
  });
});

import { describe, expect, test } from "vitest";
import type { BrowserSubmissionProvenance } from "../../src/browser/types.js";
import type { SessionMetadata } from "../../src/sessionManager.js";
import { classifyStoredRemotePreSubmitState } from "../../src/remote/storedPreSubmitState.js";
import { buildRemoteBrowserPreSubmitDiagnostic } from "../../src/remote/types.js";

const submissionProvenance: BrowserSubmissionProvenance = {
  primaryPromptSha256: "a".repeat(64),
  submittedPromptSha256: "a".repeat(64),
  primaryTransport: "inline",
  submittedTransport: "inline",
  fallbackUsed: false,
  fallbackReason: null,
  equivalenceAlgorithm: null,
  equivalenceVerified: null,
};

function storedPreSubmitSession(): SessionMetadata {
  const diagnostic = buildRemoteBrowserPreSubmitDiagnostic({
    stage: "model-selection",
    code: "protected-route-changed-after-preflight",
    guardReason: "exact-prompt-changed",
    exactPromptVerified: false,
    attachmentStateVerified: true,
    focusVerified: true,
    exactReadVerified: true,
    selectionRestored: true,
    focusPreserved: true,
  });
  if (!diagnostic) throw new Error("failed to build pre-submit diagnostic fixture");
  return {
    id: "pre-submit-session",
    createdAt: "2026-07-24T00:00:00.000Z",
    status: "error",
    mode: "browser",
    options: {},
    browser: {
      remoteRun: {
        runId: "origin-pre-submit",
        accountId: "acct1",
        laneId: "acct1-9473",
        terminalDoneOk: false,
        provenance: null,
      },
    },
    error: {
      category: "browser-automation",
      message: "Protected browser pre-submit integrity proof failed; no prompt was submitted.",
      details: {
        stage: "remote-run",
        errorClass: "integrity_ui_unknown",
        retryable: false,
        preSubmitDiagnostic: diagnostic,
      },
    },
  };
}

describe("stored remote pre-submit state", () => {
  test("requires the exact terminal failed-route shape for a definitive refusal", () => {
    expect(classifyStoredRemotePreSubmitState(storedPreSubmitSession())).toMatchObject({
      kind: "definitive-pre-submit",
      diagnostic: { code: "protected-route-changed-after-preflight" },
    });

    const missingRoute = storedPreSubmitSession();
    missingRoute.browser = undefined;
    expect(classifyStoredRemotePreSubmitState(missingRoute)).toEqual({ kind: "malformed" });

    const unboundLane = storedPreSubmitSession();
    if (!unboundLane.browser?.remoteRun) throw new Error("missing remote-run fixture");
    unboundLane.browser.remoteRun.laneId = null;
    expect(classifyStoredRemotePreSubmitState(unboundLane)).toEqual({ kind: "malformed" });
  });

  test.each([
    [
      "error details",
      (metadata: SessionMetadata) => {
        if (!metadata.error?.details) throw new Error("missing error-details fixture");
        metadata.error.details.unknown = true;
      },
    ],
    [
      "error runtime",
      (metadata: SessionMetadata) => {
        if (!metadata.error?.details) throw new Error("missing error-details fixture");
        metadata.error.details.runtime = { promptSubmitted: false, unknown: true };
      },
    ],
    [
      "failed remote route",
      (metadata: SessionMetadata) => {
        if (!metadata.browser?.remoteRun) throw new Error("missing remote-run fixture");
        (metadata.browser.remoteRun as unknown as Record<string, unknown>).unknown = true;
      },
    ],
  ] as const)("rejects an unknown %s key as malformed", (_label, mutate) => {
    const metadata = storedPreSubmitSession();
    mutate(metadata);
    expect(classifyStoredRemotePreSubmitState(metadata)).toEqual({ kind: "malformed" });
  });

  test("does not mistake the pre-dispatch ownership preview for submission evidence", () => {
    const metadata = storedPreSubmitSession();
    metadata.browser = {
      ...metadata.browser,
      submittedPromptPreview: "bounded preview persisted before Send",
    };
    expect(classifyStoredRemotePreSubmitState(metadata)).toMatchObject({
      kind: "definitive-pre-submit",
    });
  });

  test("does not mistake a normalized error model response for success evidence", () => {
    const metadata = storedPreSubmitSession();
    metadata.models = [
      {
        model: "gpt-5.6-sol",
        status: "error",
        response: { status: "error" },
        error: metadata.error,
      },
    ];
    expect(classifyStoredRemotePreSubmitState(metadata)).toMatchObject({
      kind: "definitive-pre-submit",
    });
  });

  test.each([
    [
      "completed model status",
      (metadata: SessionMetadata) => {
        metadata.models = [{ model: "gpt-5.6-sol", status: "completed" }];
      },
      "models[0].status",
    ],
    [
      "successful model response",
      (metadata: SessionMetadata) => {
        metadata.models = [
          {
            model: "gpt-5.6-sol",
            status: "error",
            response: { status: "completed" },
          },
        ];
      },
      "models[0].response",
    ],
    [
      "response id",
      (metadata: SessionMetadata) => {
        metadata.models = [
          {
            model: "gpt-5.6-sol",
            status: "error",
            response: { id: "response-after-submit" },
          },
        ];
      },
      "models[0].response",
    ],
    [
      "model usage",
      (metadata: SessionMetadata) => {
        metadata.models = [
          {
            model: "gpt-5.6-sol",
            status: "error",
            usage: {
              inputTokens: 0,
              outputTokens: 0,
              reasoningTokens: 0,
              totalTokens: 0,
            },
          },
        ];
      },
      "models[0].usage",
    ],
  ] as const)(
    "treats %s as contradictory to a definitive no-submit refusal",
    (_label, mutate, conflict) => {
      const metadata = storedPreSubmitSession();
      mutate(metadata);
      expect(classifyStoredRemotePreSubmitState(metadata)).toMatchObject({
        kind: "contradictory",
        conflicts: expect.arrayContaining([conflict]),
      });
    },
  );

  test.each([
    [
      "bound prompt digest",
      (metadata: SessionMetadata) => {
        metadata.browser = {
          ...metadata.browser,
          submittedPromptDomSha256: "b".repeat(64),
        };
      },
      "browser.submittedPromptDomSha256",
    ],
    [
      "error runtime submission provenance",
      (metadata: SessionMetadata) => {
        if (!metadata.error?.details) throw new Error("missing error-details fixture");
        metadata.error.details.runtime = {
          promptSubmitted: false,
          submissionProvenance,
        };
      },
      "error.details.runtime.submissionProvenance",
    ],
    [
      "runtime submission provenance",
      (metadata: SessionMetadata) => {
        metadata.browser = {
          ...metadata.browser,
          runtime: { submissionProvenance },
        };
      },
      "browser.runtime.submissionProvenance",
    ],
    [
      "runtime submit marker",
      (metadata: SessionMetadata) => {
        metadata.browser = {
          ...metadata.browser,
          runtime: { promptSubmitted: true },
        };
      },
      "browser.runtime.promptSubmitted",
    ],
    [
      "non-error lifecycle status",
      (metadata: SessionMetadata) => {
        metadata.status = "running";
      },
      "status",
    ],
    [
      "any response envelope",
      (metadata: SessionMetadata) => {
        metadata.response = { status: "incomplete" };
      },
      "response",
    ],
  ] as const)("treats %s as contradictory durable state", (_label, mutate, conflict) => {
    const metadata = storedPreSubmitSession();
    mutate(metadata);
    expect(classifyStoredRemotePreSubmitState(metadata)).toMatchObject({
      kind: "contradictory",
      conflicts: expect.arrayContaining([conflict]),
    });
  });
});

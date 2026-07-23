import { describe, expect, test } from "vitest";

import { evaluateBrowserRestart } from "../../src/cli/sessionRestartPolicy.js";
import type { SessionMetadata } from "../../src/sessionManager.js";

function browserSession(overrides: Partial<SessionMetadata> = {}): SessionMetadata {
  return {
    id: "browser-restart",
    createdAt: "2026-07-23T00:00:00.000Z",
    status: "error",
    mode: "browser",
    options: { mode: "browser" },
    ...overrides,
  };
}

describe("evaluateBrowserRestart", () => {
  test("refuses a submitted prompt even if a stale error says retryable", () => {
    expect(
      evaluateBrowserRestart(
        browserSession({
          browser: { runtime: { promptSubmitted: true } },
          error: {
            details: { retryable: true, errorClass: "transport_interrupted_before_submit" },
          },
        }),
      ),
    ).toEqual({ allowed: false, reason: "prompt-submitted" });
  });

  test("refuses unknown and legacy browser failures", () => {
    expect(evaluateBrowserRestart(browserSession())).toEqual({
      allowed: false,
      reason: "not-proven-pre-submit",
    });
  });

  test.each(["capacity_busy", "transport_interrupted_before_submit"])(
    "allows typed retryable remote pre-submit class %s",
    (errorClass) => {
      expect(
        evaluateBrowserRestart(
          browserSession({
            error: { details: { retryable: true, errorClass } },
          }),
        ),
      ).toEqual({ allowed: true, reason: "explicit-retryable-pre-submit" });
    },
  );

  test("allows an explicitly retryable local failure with promptSubmitted=false", () => {
    expect(
      evaluateBrowserRestart(
        browserSession({
          browser: { runtime: { promptSubmitted: false } },
          error: { details: { retryable: true, stage: "launch-chrome" } },
        }),
      ),
    ).toEqual({ allowed: true, reason: "explicit-retryable-pre-submit" });
  });

  test("refuses a retryable label without evidence that submission did not occur", () => {
    expect(
      evaluateBrowserRestart(
        browserSession({ error: { details: { retryable: true, stage: "execute-browser" } } }),
      ),
    ).toEqual({ allowed: false, reason: "not-proven-pre-submit" });
  });

  test("does not constrain API restart policy", () => {
    expect(
      evaluateBrowserRestart({
        ...browserSession(),
        mode: "api",
        options: { mode: "api" },
      }),
    ).toEqual({ allowed: true, reason: "not-browser" });
  });
});

import { describe, expect, test } from "vitest";
import { expectGoldenJson } from "../../_helpers/goldenSnapshots.js";
import {
  evaluateApiSubstitution,
  isApiSubstitutionForbidden,
} from "../../../src/oracle/api_substitution_guard.js";
import {
  V18_ERROR_CODES,
  assertRecoveryContract,
  createErrorEnvelope,
  isV18ErrorCode,
  type V18ErrorCode,
} from "../../../src/oracle/v18/json_envelope.js";
import { jsonEnvelopeSchema } from "../../../src/oracle/v18/contracts.js";

describe("v18 error taxonomy unit conformance", () => {
  test("serializes every documented error code in a recovery-complete envelope", () => {
    const serialized = V18_ERROR_CODES.map((code) => {
      const envelope = createErrorEnvelope({
        errors: [{ error_code: code, message: `synthetic ${code}` }],
        meta: { surface: "unit-error-taxonomy" },
        next_command: "oracle status",
        fix_command: "inspect blocker",
        retry_safe: false,
      });
      assertRecoveryContract(envelope);
      jsonEnvelopeSchema.parse(envelope);
      return {
        code,
        blocked_reason: envelope.blocked_reason,
        retry_safe: envelope.retry_safe,
      };
    });

    expect(serialized).toHaveLength(V18_ERROR_CODES.length);
    expect(serialized.every((entry) => entry.code === entry.blocked_reason)).toBe(true);
    expectGoldenJson(
      { count: V18_ERROR_CODES.length, codes: V18_ERROR_CODES },
      `
      {
        "codes": [
          "provider_login_required",
          "browser_lock_timeout",
          "remote_browser_unavailable",
          "remote_browser_auth_failed",
          "remote_browser_token_missing",
          "chatgpt_pro_unverified",
          "chatgpt_extended_reasoning_unverified",
          "gemini_deep_think_unverified",
          "ui_drift_suspected",
          "output_capture_empty",
          "output_capture_unverified",
          "provider_usage_limit",
          "prompt_submitted_before_verification"
        ],
        "count": 13
      }
      `,
    );
  });

  test("runtime guard accepts only taxonomy members", () => {
    for (const code of V18_ERROR_CODES) {
      expect(isV18ErrorCode(code)).toBe(true);
    }
    expect(isV18ErrorCode("not_a_v18_error")).toBe(false);
    expect(isV18ErrorCode(null)).toBe(false);
  });

  test("api substitution guard emits compact blocker reasons for protected routes", () => {
    const cases: Array<{
      name: string;
      input: Parameters<typeof evaluateApiSubstitution>[0];
      expectedCodes: readonly (V18ErrorCode | null)[];
    }> = [
      {
        name: "chatgpt protected slot via API",
        input: {
          slot: "chatgpt_pro_synthesis",
          providerFamily: "openai",
          accessPath: "openai_api",
        },
        expectedCodes: ["chatgpt_pro_unverified", "chatgpt_pro_unverified"],
      },
      {
        name: "subscription CLI slot via provider API",
        input: {
          slot: "claude_code_opus",
          providerFamily: "anthropic",
          accessPath: "anthropic_api",
        },
        expectedCodes: ["provider_login_required", "provider_login_required"],
      },
      {
        name: "DeepSeek slot via xAI API",
        input: {
          slot: "deepseek_v4_pro_reasoning_search",
          providerFamily: "xai",
          accessPath: "xai_api",
        },
        expectedCodes: [null, null],
      },
    ];

    const compact = cases.map((entry) => {
      const verdict = evaluateApiSubstitution(entry.input);
      expect(verdict.eligible).toBe(false);
      expect(isApiSubstitutionForbidden(entry.input)).toBe(true);
      expect(verdict.reasons.map((reason) => reason.code)).toEqual(entry.expectedCodes);
      return {
        name: entry.name,
        eligible: verdict.eligible,
        reasons: verdict.reasons.map((reason) => ({
          code: reason.code,
          field: reason.field,
        })),
      };
    });

    expectGoldenJson(
      compact,
      `
      [
        {
          "eligible": false,
          "name": "chatgpt protected slot via API",
          "reasons": [
            {
              "code": "chatgpt_pro_unverified",
              "field": "provider_result.provider_family"
            },
            {
              "code": "chatgpt_pro_unverified",
              "field": "provider_result.access_path"
            }
          ]
        },
        {
          "eligible": false,
          "name": "subscription CLI slot via provider API",
          "reasons": [
            {
              "code": "provider_login_required",
              "field": "provider_result.access_path"
            },
            {
              "code": "provider_login_required",
              "field": "provider_result.provider_family"
            }
          ]
        },
        {
          "eligible": false,
          "name": "DeepSeek slot via xAI API",
          "reasons": [
            {
              "code": null,
              "field": "provider_result.access_path"
            },
            {
              "code": null,
              "field": "provider_result.provider_family"
            }
          ]
        }
      ]
      `,
    );
  });
});

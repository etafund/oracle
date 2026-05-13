import { describe, expect, test } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  BROWSER_EVIDENCE_SCHEMA_VERSION,
  FORBIDDEN_KEY_TEST,
  V18_BUNDLE_VERSION,
  evidenceFilePath,
  evidenceIndexPath,
  listIndexedEvidence,
  listQuarantinedEvidence,
  quarantineFilePath,
  redactEvidencePayload,
  writeEvidence,
} from "@src/oracle/v18/index.ts";
import {
  FORBIDDEN_LEAKED_VALUES,
  assertNoSecretLeak,
  premortemForId,
} from "@tests/_helpers/premortem.ts";

const FM = premortemForId("FM-009")!;
const testNonWindows = process.platform === "win32" ? test.skip : test;

function buildEvidencePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    available_effort_labels_hash: `sha256:${"a".repeat(64)}`,
    browser_effort_strategy: "select_highest_visible",
    bundle_version: V18_BUNDLE_VERSION,
    capture_confidence: "high",
    created_at: "2026-05-12T00:00:10Z",
    effort_rank: "highest_visible",
    evidence_id: "evidence-premortem-fm009",
    evidence_privacy: {
      stores_account_identifiers: false,
      stores_cookies: false,
      stores_raw_dom: false,
      stores_raw_screenshots: false,
    },
    failure_code: null,
    fix_command: null,
    mode_verified: true,
    next_command: null,
    observed_reasoning_effort_label: "Heavy",
    output_text_sha256: `sha256:${"b".repeat(64)}`,
    prompt_sha256: `sha256:${"c".repeat(64)}`,
    prompt_submitted_at: "2026-05-12T00:00:05Z",
    provider: "chatgpt",
    provider_result_id: "pr-fm009",
    provider_slot: "chatgpt_pro_first_plan",
    reasoning_effort_verified: true,
    redaction_policy: "redacted",
    requested_mode: "pro_extended_reasoning",
    requested_reasoning_effort: "max_browser_available",
    run_id: "run-fm009",
    schema_version: BROWSER_EVIDENCE_SCHEMA_VERSION,
    selected_effort_is_highest_visible: true,
    selector_manifest_version: "chatgpt-pro-v1",
    session_id_hash: `sha256:${"d".repeat(64)}`,
    transition_log_sha256: `sha256:${"e".repeat(64)}`,
    unsafe_artifacts_quarantined: true,
    verification_method: "same_session_ui_observation_plus_selector_trace",
    verification_scope: "same_browser_session_before_prompt_submit",
    verified_at: "2026-05-12T00:00:00Z",
    verified_before_prompt_submit: true,
    ...overrides,
  };
}

function collectKeys(value: unknown, acc: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const entry of value) collectKeys(entry, acc);
  } else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      acc.push(key);
      collectKeys(child, acc);
    }
  }
  return acc;
}

describe(`premortem ${FM.id}: ${FM.title}`, () => {
  test("documents which Oracle acceptance checks this file covers", () => {
    expect(FM.oracle_acceptance_checks.length).toBeGreaterThan(0);
  });

  test("FORBIDDEN_KEY_TEST recognizes the canonical leak families", () => {
    const families = [
      "cookies",
      "Cookie",
      "set-cookie",
      "account_email",
      "user_email",
      "raw_dom",
      "dom_html",
      "screenshot",
      "screenshot_base64",
      "authorization",
      "auth_headers",
      "bearer_token",
      "access_token",
      "session_token",
      "api_key",
      "raw_prompt",
      "prompt_text",
      "raw_output",
      "output_text",
      "assistant_text",
      "response_text",
    ];
    for (const family of families) {
      expect(FORBIDDEN_KEY_TEST(family), `key "${family}" should be forbidden`).toBe(true);
    }
  });

  test("redactEvidencePayload strips adversarial extension aliases (prefix attacks)", () => {
    const dirty = {
      provider_slot: "chatgpt_pro_first_plan",
      cookies: "session=abc",
      debug_session_token: "should-not-survive",
      legacy_auth_headers: { Authorization: "Bearer redact-me" },
      meta: {
        account_email: "agent@example.com",
        attempt: 1,
      },
      observed_reasoning_effort_label: "Pro", // safe — picker label
    };
    const result = redactEvidencePayload(dirty);
    const serialized = JSON.stringify(result.redacted);
    assertNoSecretLeak(serialized);
    expect(result.redacted).toEqual({
      provider_slot: "chatgpt_pro_first_plan",
      meta: { attempt: 1 },
      observed_reasoning_effort_label: "Pro",
    });
  });

  testNonWindows("written evidence files contain no leaked VALUES or forbidden KEYS", async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), "oracle-premortem-fm009-"));
    try {
      const payload = buildEvidencePayload({
        // adversarial extensions injected by a sloppy caller
        cookies: "session=abc",
        account_email: "agent@example.com",
        auth_headers: { Authorization: "Bearer redact-me" },
        raw_dom: "<html>",
        screenshot: "data:image/png;base64,XYZ",
        raw_prompt: "leaked prompt",
        raw_output: "leaked output",
      });
      const written = await writeEvidence("sess-fm009", payload, { homeDir });
      const raw = await readFile(written.path, "utf8");

      assertNoSecretLeak(raw);
      // Walk parsed structure — no forbidden KEY may survive.
      const parsed = JSON.parse(raw);
      for (const key of collectKeys(parsed)) {
        expect(FORBIDDEN_KEY_TEST(key), `forbidden key "${key}" survived to disk`).toBe(false);
      }

      // Path is the normal evidence dir, NOT quarantine.
      expect(written.path).toBe(evidenceFilePath("sess-fm009", "evidence-premortem-fm009", homeDir));
      expect(written.indexed).toBe(true);
      expect(written.quarantined).toBe(false);
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  testNonWindows("unsafe_debug evidence is quarantined and excluded from the normal index", async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), "oracle-premortem-fm009-uq-"));
    try {
      const payload = buildEvidencePayload({
        redaction_policy: "unsafe_debug",
        evidence_id: "evidence-premortem-fm009-unsafe",
      });
      const written = await writeEvidence("sess-fm009-unsafe", payload, { homeDir });

      expect(written.quarantined).toBe(true);
      expect(written.indexed).toBe(false);
      expect(written.path).toBe(
        quarantineFilePath("sess-fm009-unsafe", "evidence-premortem-fm009-unsafe", homeDir),
      );

      // Normal index does NOT include the quarantined entry.
      const normalEntries = await listIndexedEvidence("sess-fm009-unsafe", homeDir);
      expect(normalEntries).toEqual([]);
      // Quarantine has its own index.
      const quarantineEntries = await listQuarantinedEvidence("sess-fm009-unsafe", homeDir);
      expect(quarantineEntries).toHaveLength(1);
      expect(quarantineEntries[0].artifact_id).toBe("evidence-premortem-fm009-unsafe");

      // Normal index file does not exist (no entries written).
      await expect(readFile(evidenceIndexPath("sess-fm009-unsafe", homeDir), "utf8")).rejects.toThrow();
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  test("FORBIDDEN_LEAKED_VALUES covers the canonical premortem leak markers", () => {
    expect(FORBIDDEN_LEAKED_VALUES.length).toBeGreaterThan(0);
    expect(FORBIDDEN_LEAKED_VALUES).toEqual(
      expect.arrayContaining([
        "sk-super-secret-token-value",
        "agent@example.com",
        "Bearer redact-me",
      ]),
    );
  });
});

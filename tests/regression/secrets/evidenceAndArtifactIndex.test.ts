// Regression: writeEvidence + artifact-index round-trips must not let
// any forbidden field reach the on-disk file or the index, and the
// quarantine path must require explicit opt-in.

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  BROWSER_EVIDENCE_SCHEMA_VERSION,
  V18_BUNDLE_VERSION,
  evidenceFilePath,
  evidenceIndexPath,
  quarantineFilePath,
  quarantineIndexPath,
  readArtifactIndex,
  redactEvidencePayload,
  writeEvidence,
} from "../../../src/oracle/v18/index.js";
import { assertNoLeaks, detectLeaks } from "../../_helpers/secretLeakDetector.js";

const testNonWindows = process.platform === "win32" ? test.skip : test;

const FAKES = [
  { name: "session-cookie", value: "session=PHPSESSID-leak-me-please" },
  { name: "account-email", value: "agent-pii@example.invalid" },
  { name: "bearer-token", value: "Bearer leak-bearer-token-1234567890" },
  { name: "raw-dom", value: "<html><body>hidden DOM</body></html>" },
  { name: "screenshot-data", value: "data:image/png;base64,LEAK-AAAAA" },
  { name: "raw-prompt", value: "the original user prompt with PII" },
  { name: "raw-output", value: "the original model output with PII" },
];

function buildEvidence(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    available_effort_labels_hash: `sha256:${"a".repeat(64)}`,
    browser_effort_strategy: "select_highest_visible",
    bundle_version: V18_BUNDLE_VERSION,
    capture_confidence: "high",
    created_at: "2026-05-13T00:00:10Z",
    effort_rank: "highest_visible",
    evidence_id: "leak-regression-evidence-1",
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
    prompt_submitted_at: "2026-05-13T00:00:05Z",
    provider: "chatgpt",
    provider_result_id: "provider-result-test",
    provider_slot: "chatgpt_pro_first_plan",
    reasoning_effort_verified: true,
    redaction_policy: "redacted",
    requested_mode: "pro_extended_reasoning",
    requested_reasoning_effort: "max_browser_available",
    run_id: "leak-test-run",
    schema_version: BROWSER_EVIDENCE_SCHEMA_VERSION,
    selected_effort_is_highest_visible: true,
    selector_manifest_version: "chatgpt-pro-v1",
    session_id_hash: `sha256:${"d".repeat(64)}`,
    transition_log_sha256: `sha256:${"e".repeat(64)}`,
    unsafe_artifacts_quarantined: true,
    verification_method: "same_session_ui_observation_plus_selector_trace",
    verification_scope: "same_browser_session_before_prompt_submit",
    verified_at: "2026-05-13T00:00:00Z",
    verified_before_prompt_submit: true,
    ...overrides,
  };
}

function leakyOverrides(): Record<string, unknown> {
  return {
    cookies: FAKES[0].value,
    account_email: FAKES[1].value,
    auth_headers: { Authorization: FAKES[2].value },
    raw_dom: FAKES[3].value,
    screenshot: FAKES[4].value,
    raw_prompt: FAKES[5].value,
    raw_output: FAKES[6].value,
  };
}

describe("redactEvidencePayload — pure-function leak guard", () => {
  test("strips every forbidden field from a leaky input", () => {
    const result = redactEvidencePayload(leakyOverrides());
    assertNoLeaks(result.redacted, { fakes: FAKES });
    for (const removed of [
      "cookies",
      "account_email",
      "auth_headers",
      "raw_dom",
      "screenshot",
      "raw_prompt",
      "raw_output",
    ]) {
      expect(result.removedPaths).toContain(removed);
    }
  });

  test("preserves the input when no forbidden fields are present", () => {
    const clean = {
      schema_version: BROWSER_EVIDENCE_SCHEMA_VERSION,
      prompt_sha256: `sha256:${"a".repeat(64)}`,
    };
    const result = redactEvidencePayload(clean);
    expect(result.removedPaths).toEqual([]);
    expect(result.redacted).toEqual(clean);
  });
});

describe("writeEvidence — on-disk artifacts are leak-free", () => {
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(path.join(os.tmpdir(), "oracle-leak-regression-"));
  });

  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });

  testNonWindows("redacted (default) writes a clean file AND clean index", async () => {
    const evidence = buildEvidence(leakyOverrides());
    const written = await writeEvidence("sess-1", evidence, { homeDir });

    expect(written.quarantined).toBe(false);
    expect(written.indexed).toBe(true);

    const fileRaw = await readFile(written.path, "utf8");
    assertNoLeaks(fileRaw, { fakes: FAKES });

    const indexFile = evidenceIndexPath("sess-1", homeDir);
    const indexRaw = await readFile(indexFile, "utf8");
    assertNoLeaks(indexRaw, { fakes: FAKES });

    const parsedIndex = await readArtifactIndex(indexFile);
    expect(parsedIndex?.artifacts.length).toBeGreaterThan(0);
    expect(parsedIndex?.artifacts[0].sha256).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  testNonWindows("removedPaths covers every smuggled forbidden field", async () => {
    const evidence = buildEvidence({
      ...leakyOverrides(),
      evidence_privacy: {
        stores_account_identifiers: false,
        stores_cookies: false,
        stores_raw_dom: false,
        stores_raw_screenshots: false,
        // Smuggle a forbidden field inside a permitted parent — the
        // recursive redactor must still catch it.
        debug_session_token: "should-not-survive",
      },
    });
    const written = await writeEvidence("sess-2", evidence, { homeDir });
    expect(written.removedPaths).toContain("evidence_privacy.debug_session_token");
    const fileRaw = await readFile(written.path, "utf8");
    expect(fileRaw).not.toContain("should-not-survive");
  });

  testNonWindows("file path matches evidenceFilePath helper (no path traversal)", async () => {
    const evidence = buildEvidence(leakyOverrides());
    const written = await writeEvidence("sess-3", evidence, { homeDir });
    expect(written.path).toBe(evidenceFilePath("sess-3", "leak-regression-evidence-1", homeDir));
  });
});

describe("writeEvidence — unsafe_debug quarantine flow", () => {
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(path.join(os.tmpdir(), "oracle-leak-quarantine-"));
  });

  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });

  testNonWindows("unsafe_debug WITHOUT explicit opt-in throws (no disk write)", async () => {
    const evidence = buildEvidence({
      redaction_policy: "unsafe_debug",
      ...leakyOverrides(),
    });
    await expect(
      writeEvidence("sess-q-1", evidence, { homeDir, allowQuarantine: false }),
    ).rejects.toThrow(/unsafe_debug/i);

    // Confirm nothing was written under the session directory.
    const normalIndex = evidenceIndexPath("sess-q-1", homeDir);
    const quarantineIndex = quarantineIndexPath("sess-q-1", homeDir);
    await expect(readFile(normalIndex, "utf8")).rejects.toThrow();
    await expect(readFile(quarantineIndex, "utf8")).rejects.toThrow();
  });

  testNonWindows(
    "unsafe_debug WITH explicit opt-in writes to quarantine, NEVER pollutes normal index",
    async () => {
      const evidence = buildEvidence({
        redaction_policy: "unsafe_debug",
        ...leakyOverrides(),
      });
      const written = await writeEvidence("sess-q-2", evidence, {
        homeDir,
        allowQuarantine: true,
      });

      expect(written.quarantined).toBe(true);
      expect(written.indexed).toBe(false);
      expect(written.path).toBe(
        quarantineFilePath("sess-q-2", "leak-regression-evidence-1", homeDir),
      );

      // The normal index for this session MUST NOT exist (or must be empty
      // if pane 6 ever materialises one — confirm via parse).
      const normalIndexFile = evidenceIndexPath("sess-q-2", homeDir);
      const normalIndex = await readArtifactIndex(normalIndexFile).catch(() => null);
      // If the helper auto-creates an empty index this is still a pass.
      if (normalIndex) {
        expect(normalIndex.artifacts).toEqual([]);
      }

      // The QUARANTINE index DOES exist and references the file. The
      // detector still runs against it — the index entry itself is the
      // sha256 digest + path, both leak-free.
      const quarantineIndexFile = quarantineIndexPath("sess-q-2", homeDir);
      const qIndex = await readArtifactIndex(quarantineIndexFile);
      expect(qIndex?.artifacts.length).toBeGreaterThan(0);
      const qIndexRaw = await readFile(quarantineIndexFile, "utf8");
      assertNoLeaks(qIndexRaw, { fakes: FAKES });

      // The quarantine file itself is allowed to contain raw bytes (that
      // is the whole point of the opt-in), so we do NOT scan it for
      // FAKES. Instead, we confirm it contains *something* and that it
      // is under the quarantine directory (not the normal evidence dir).
      const quarantineRaw = await readFile(written.path, "utf8");
      expect(quarantineRaw.length).toBeGreaterThan(0);
      expect(written.path).toContain(`/quarantine/`);
    },
  );
});

describe("regression: a hand-crafted leaky payload IS detected by the detector itself", () => {
  test("simulates a broken redactor and confirms the detector catches it", () => {
    // This is a defensive test: if a future refactor accidentally
    // disables the recursive redactor, we want detectLeaks to start
    // failing immediately when fed the raw input.
    const leaky = buildEvidence(leakyOverrides());
    const leaks = detectLeaks(leaky, { fakes: FAKES });
    // Every fake value (and several forbidden keys) must trip the
    // detector. We do not enumerate the exact count — just confirm the
    // detector is not silently inert.
    expect(leaks.length).toBeGreaterThanOrEqual(FAKES.length);
  });
});

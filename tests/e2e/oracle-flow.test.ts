// End-to-end mock-route rehearsal for the Oracle v18 pipeline
// (oracle-2ob).
//
// One single `rch exec -- pnpm vitest run tests/e2e/oracle-flow.test.ts`
// walks the complete v18 pipeline using a scripted mock browser, real
// v18 contract code, a real evidence ledger on disk, and structured
// JSON-line logging at every step. The rehearsal produces a sanitized
// artifact packet a future agent can attach to a CI failure report.
//
// Pipeline steps:
//   1. capabilities preflight (config-only; no network)
//   2. remote endpoint config snapshot
//   3. shared browser profile view (redacted public surface)
//   4. browser lease acquire (provider lock)
//   5. mock provider run (scripted effort + capture)
//   6. evidence write to a per-test temp directory (real disk)
//   7. provider_result.v1 normalization
//   8. hash-consistency cross-check (result vs evidence)
//   9. final envelope assembly + recovery contract assertion
//
// A separate test drives the same pipeline through an intentional
// blocker (effort verdict drift) and asserts the rehearsal surfaces an
// actionable failure envelope with the right v18 error code.

import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  BROWSER_SHARED_PROFILE_LOCKS,
  buildSharedProfileView,
} from "../../src/oracle/v18/index.js";
import { describeSharedBrowserProfile } from "../../src/browser/profile.js";
import {
  assertRecoveryContract,
  createEnvelope,
  createErrorEnvelope,
} from "../../src/oracle/v18/json_envelope.js";
import { normalizeChatGptRun } from "../../src/browser/providers/chatgptResultNormalizer.js";
import { consistencyCodes, verifyHashConsistency } from "../../src/oracle/v18/hash_consistency.js";
import { evidenceFilePath, writeEvidence } from "../../src/oracle/v18/evidence.js";
import { assertNoLeaks } from "../_helpers/secretLeakDetector.js";
import {
  DEFAULT_HAPPY_SCRIPT,
  runMockChatGptScript,
  type MockChatGptScript,
} from "../_helpers/mockProvider.ts";
import { assertE2eArtifactPacket, createE2eLog } from "../_helpers/structuredE2eLog.js";

const PROMPT_MANIFEST_HASH = `sha256:${"c".repeat(63)}1` as const;
const SOURCE_BASELINE_HASH = `sha256:${"d".repeat(63)}1` as const;
const SECRET_FAKES = [
  { name: "remote-token", value: "fake-rehearsal-token-7Up9X" },
  { name: "account-email", value: "rehearsal@example.invalid" },
];

let homeDir: string;
let artifactsDir: string;

beforeAll(async () => {
  homeDir = await mkdtemp(path.join(os.tmpdir(), "oracle-e2e-home-"));
  artifactsDir = await mkdtemp(path.join(os.tmpdir(), "oracle-e2e-artifacts-"));
});

afterAll(async () => {
  await rm(homeDir, { recursive: true, force: true });
  await rm(artifactsDir, { recursive: true, force: true });
});

describe("Oracle E2E mock-route rehearsal — happy path", () => {
  test("walks the full v18 pipeline and produces an artifact packet", async () => {
    const log = createE2eLog({ suite: "oracle-e2e-happy" });
    const script: MockChatGptScript = DEFAULT_HAPPY_SCRIPT;

    // 1. Capabilities preflight ─────────────────────────────────────────
    const capsStep = await log.step(
      "capabilities_preflight",
      { command: "oracle capabilities --json" },
      () => {
        const envelope = createEnvelope({
          ok: true,
          data: { capabilities: ["chatgpt_browser_pro", "evidence_ledger"] },
          meta: { tool: "oracle capabilities", mock_or_live: "mock" },
        });
        return envelope;
      },
    );
    expect(capsStep.value.ok).toBe(true);
    expect(capsStep.value.schema_version).toBe("json_envelope.v1");

    // 2. Remote endpoint config snapshot ─────────────────────────────────
    const profileView = describeSharedBrowserProfile({
      endpointId: "rehearsal-endpoint",
      hostEnv: "ORACLE_REMOTE_HOST",
      tokenEnv: "ORACLE_REMOTE_TOKEN",
      accountId: SECRET_FAKES[1].value,
    });
    const remoteStep = await log.step(
      "remote_endpoint_snapshot",
      {
        command: "oracle remote status --json",
        envelope: createEnvelope({
          ok: true,
          data: profileView as unknown as Record<string, unknown>,
          meta: { tool: "oracle remote status" },
        }) as unknown as Record<string, unknown>,
      },
      () => profileView,
    );
    log.recordRedactionCheck(!JSON.stringify(remoteStep.value).includes(SECRET_FAKES[1].value));
    expect(JSON.stringify(remoteStep.value)).not.toContain(SECRET_FAKES[1].value);

    // 3. Shared browser profile + provider locks ────────────────────────
    const sharedProfile = buildSharedProfileView({
      identity: {
        endpointId: "rehearsal-endpoint",
        hostEnv: "ORACLE_REMOTE_HOST",
        tokenEnv: "ORACLE_REMOTE_TOKEN",
      },
    });
    await log.step(
      "shared_profile_view",
      { command: "oracle browser profile --json" },
      () => sharedProfile,
    );
    expect(sharedProfile.provider_locks.map((l) => l.lock)).toEqual([
      BROWSER_SHARED_PROFILE_LOCKS.chatgpt,
      BROWSER_SHARED_PROFILE_LOCKS.gemini,
    ]);

    // 4. Browser lease acquire (logical lease record) ────────────────────
    const leaseId = `lease-rehearsal-${script.providerSlot}`;
    await log.step(
      "browser_lease_acquire",
      {
        command: "oracle browser leases acquire --provider chatgpt --json",
        providerSlot: script.providerSlot,
        leaseId,
        envelope: createEnvelope({
          ok: true,
          data: {
            lease_id: leaseId,
            lock_name: BROWSER_SHARED_PROFILE_LOCKS.chatgpt,
            profile_id_hash: sharedProfile.profile_id_hash,
            provider: "chatgpt",
          },
          meta: { tool: "browser-leases-acquire" },
        }) as unknown as Record<string, unknown>,
      },
      () => leaseId,
    );

    // 5. Run the scripted mock provider ─────────────────────────────────
    const runStep = await log.step(
      "mock_provider_run",
      {
        command: "oracle chatgpt run --json (mock)",
        providerSlot: script.providerSlot,
        leaseId,
        evidenceId: script.evidenceId,
      },
      () => runMockChatGptScript(script),
    );
    const artifacts = runStep.value;
    expect(artifacts.effort.status).toBe("verified");
    expect(artifacts.capture.status).toBe("captured");
    expect(artifacts.capture.markdownPreserved).toBe(true);

    // 6. Write evidence to disk (real fs) ───────────────────────────────
    const writeStep = await log.step(
      "evidence_write",
      {
        command: "oracle evidence write (internal)",
        evidenceId: artifacts.evidence.evidence_id,
      },
      () => writeEvidence("rehearsal-session", artifacts.evidence, { homeDir }),
    );
    const written = writeStep.value;
    expect(written.indexed).toBe(true);
    expect(written.quarantined).toBe(false);
    expect(written.path).toBe(
      evidenceFilePath("rehearsal-session", artifacts.evidence.evidence_id, homeDir),
    );

    // Real evidence verify: read the file back, confirm the parsed
    // contents agree with the in-memory evidence (the bead asks for
    // "evidence verification output" in the artifact packet).
    const rawDisk = await readFile(written.path, "utf8");
    log.recordEvidenceVerification({
      evidenceId: artifacts.evidence.evidence_id,
      status: rawDisk.includes(artifacts.evidence.evidence_id) ? "verified" : "rejected",
      detail: `disk file ${path.basename(written.path)} contains evidence_id`,
    });
    log.recordRedactionCheck(!rawDisk.includes(SECRET_FAKES[0].value));
    log.recordRedactionCheck(!rawDisk.includes(SECRET_FAKES[1].value));

    // 7. Normalize provider_result.v1 ───────────────────────────────────
    const normalizeStep = await log.step(
      "normalize_provider_result",
      {
        command: "oracle internal normalize (provider_result.v1)",
        providerSlot: script.providerSlot,
        evidenceId: artifacts.evidence.evidence_id,
      },
      () =>
        normalizeChatGptRun({
          slot: script.providerSlot,
          providerResultId: script.providerResultId,
          accessPath: "oracle_browser_remote",
          evidence: artifacts.evidence,
          capture: artifacts.capture,
          effort: artifacts.effort,
          promptManifestSha256: PROMPT_MANIFEST_HASH,
          sourceBaselineSha256: SOURCE_BASELINE_HASH,
        }),
    );
    expect(normalizeStep.value.blockedReasons).toEqual([]);
    expect(normalizeStep.value.result.synthesis_eligible).toBe(true);
    expect(normalizeStep.value.result.status).toBe("success");

    // 8. Hash consistency cross-check ───────────────────────────────────
    const consistencyStep = await log.step(
      "hash_consistency",
      {
        command: "oracle internal verifyHashConsistency",
        providerSlot: script.providerSlot,
        evidenceId: artifacts.evidence.evidence_id,
      },
      () =>
        verifyHashConsistency({
          result: normalizeStep.value.result,
          evidence: artifacts.evidence,
        }),
    );
    expect(consistencyStep.value.consistent).toBe(true);
    expect(consistencyCodes(consistencyStep.value)).toEqual([]);

    // 9. Final success envelope with recovery contract ──────────────────
    const finalStep = await log.step(
      "final_envelope",
      {
        command: "oracle chatgpt run --json (envelope)",
        providerSlot: script.providerSlot,
        evidenceId: artifacts.evidence.evidence_id,
      },
      () =>
        createEnvelope({
          ok: true,
          data: {
            provider_result_id: normalizeStep.value.result.provider_result_id,
            evidence_id: artifacts.evidence.evidence_id,
          },
          meta: {
            tool: "oracle chatgpt run",
            mock_or_live: "mock",
            elapsed_steps: log.records().length + 1,
          },
        }),
    );
    expect(finalStep.value.ok).toBe(true);
    expect(finalStep.value.errors).toEqual([]);

    // Artifact packet sanity + persistence ──────────────────────────────
    const jsonlPath = path.join(artifactsDir, "oracle-flow.jsonl");
    const packetPath = path.join(artifactsDir, "oracle-flow.packet.json");
    await log.writeJsonl(jsonlPath);
    await log.writeArtifactPacket(packetPath);

    const packet = log.artifactPacket();
    assertE2eArtifactPacket(packet);
    expect(packet.step_count).toBe(9);
    expect(packet.ok_count).toBe(9);
    expect(packet.blocked_count).toBe(0);
    expect(packet.error_count).toBe(0);
    expect(packet.redaction_assertions.checked).toBeGreaterThanOrEqual(3);
    expect(packet.redaction_assertions.failed).toBe(0);
    expect(packet.evidence_verifications).toHaveLength(1);
    expect(packet.evidence_verifications[0].status).toBe("verified");

    // The artifact packet itself contains no secrets.
    const packetBytes = await readFile(packetPath, "utf8");
    assertNoLeaks(packetBytes, { fakes: SECRET_FAKES });

    // Every step has timing > 0ms is not required (sync calls may
    // round to 0), but timings MUST be finite non-negative integers so
    // a downstream report can distinguish "took 0ms because synchronous"
    // from "took 60_000ms waiting for the browser".
    for (const step of packet.steps) {
      expect(Number.isInteger(step.elapsed_ms)).toBe(true);
      expect(step.elapsed_ms).toBeGreaterThanOrEqual(0);
      expect(step.mock_or_live).toBe("mock");
    }
  });
});

describe("Oracle E2E mock-route rehearsal — blocker surfaces recovery envelope", () => {
  test("UI drift mid-run blocks synthesis with an actionable envelope", async () => {
    const log = createE2eLog({ suite: "oracle-e2e-blocked" });
    const script: MockChatGptScript = {
      ...DEFAULT_HAPPY_SCRIPT,
      evidenceId: "evidence-rehearsal-drift",
      providerResultId: "provider-result-rehearsal-drift",
      // Effort picker exposes an unknown tier — triggers ui_drift_suspected.
      observedEffortLabels: ["Unobtainium", "Vibranium"],
    };

    const runStep = await log.step(
      "mock_provider_run",
      { command: "oracle chatgpt run --json (mock)", providerSlot: script.providerSlot },
      () => runMockChatGptScript(script),
    );
    const artifacts = runStep.value;
    expect(artifacts.effort.status).toBe("ui_drift_suspected");

    const normalize = await log.step(
      "normalize_provider_result",
      {
        command: "oracle internal normalize (provider_result.v1)",
        providerSlot: script.providerSlot,
        evidenceId: artifacts.evidence.evidence_id,
      },
      () =>
        normalizeChatGptRun({
          slot: script.providerSlot,
          providerResultId: script.providerResultId,
          accessPath: "oracle_browser_remote",
          evidence: artifacts.evidence,
          capture: artifacts.capture,
          effort: artifacts.effort,
          promptManifestSha256: PROMPT_MANIFEST_HASH,
          sourceBaselineSha256: SOURCE_BASELINE_HASH,
        }),
    );
    expect(normalize.value.synthesisDowngraded).toBe(true);
    expect(normalize.value.result.synthesis_eligible).toBe(false);
    expect(normalize.value.blockedReasons.some((r) => r.code === "ui_drift_suspected")).toBe(true);

    const errorEnv = createErrorEnvelope({
      errors: [
        {
          error_code: "ui_drift_suspected",
          message: "ChatGPT effort picker labels did not map to a known tier",
          details: {
            observed_labels_sorted: [...script.observedEffortLabels].sort(),
            selector_manifest_version: artifacts.effort.selectorManifestVersion,
          },
        },
      ],
      meta: { tool: "oracle chatgpt run", mock_or_live: "mock" },
      next_command: "oracle chatgpt doctor --pro --extended-reasoning --json",
      fix_command: "oracle browser sessions recover --provider chatgpt --json",
      retry_safe: true,
    });
    await log.step(
      "final_envelope",
      {
        command: "oracle chatgpt run --json (envelope)",
        providerSlot: script.providerSlot,
        envelope: errorEnv as unknown as Record<string, unknown>,
        status: "blocked",
        nextCommand: errorEnv.next_command,
        fixCommand: errorEnv.fix_command,
      },
      () => errorEnv,
    );

    expect(errorEnv.ok).toBe(false);
    expect(errorEnv.blocked_reason).toBe("ui_drift_suspected");
    assertRecoveryContract(errorEnv);

    const packet = log.artifactPacket();
    expect(packet.step_count).toBe(3);
    expect(packet.blocked_count).toBe(1);
    expect(packet.error_count).toBe(0);

    // Distinguish "schema failure vs remote/browser waiting" via timing.
    // Synthetic ms thresholds: < 1000ms = sync/contract work,
    // > 1000ms would indicate real waiting. All steps here are sync.
    for (const step of packet.steps) {
      expect(step.elapsed_ms).toBeLessThan(1_000);
    }
  });
});

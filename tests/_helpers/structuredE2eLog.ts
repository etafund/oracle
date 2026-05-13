// Structured JSON-line logger for the Oracle E2E mock-route rehearsal
// (oracle-2ob).
//
// Each step in the rehearsal calls `log.step(name, fn)` and gets a
// timed record stored in memory + appended to a JSONL file. The
// final artifact packet rolls every step into a sanitized summary the
// CI harness can attach to a failure report.

import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import { redactStructuredTestMetadata, type StructuredTestLogRecord } from "./structuredTestLog.js";

export type E2eStepStatus = "ok" | "blocked" | "skipped" | "error";

export interface E2eStepRecord {
  readonly timestamp: string;
  readonly step: string;
  /** Index in the run sequence (1-based). */
  readonly index: number;
  readonly status: E2eStepStatus;
  /** Wall-clock duration of the step. */
  readonly elapsed_ms: number;
  /**
   * Command-like provenance the operator can replay (e.g.
   * "oracle remote doctor --json").
   */
  readonly command: string | null;
  /** Provider slot this step relates to, when applicable. */
  readonly provider_slot: string | null;
  /** Always "mock" for this rehearsal. */
  readonly mock_or_live: "mock" | "live";
  /** Lease ID involved in the step. */
  readonly lease_id: string | null;
  /** Evidence ID involved in the step. */
  readonly evidence_id: string | null;
  /** Sanitized json_envelope.v1 emitted at the step, when one applies. */
  readonly envelope: Record<string, unknown> | null;
  /** When the step is blocked, the recovery hint. */
  readonly next_command: string | null;
  readonly fix_command: string | null;
  /** Free-form sanitized metadata. */
  readonly metadata: Record<string, unknown>;
}

export interface E2eArtifactPacket {
  readonly suite: string;
  readonly started_at: string;
  readonly finished_at: string;
  readonly elapsed_ms: number;
  readonly step_count: number;
  readonly ok_count: number;
  readonly blocked_count: number;
  readonly error_count: number;
  readonly redaction_assertions: {
    readonly checked: number;
    readonly passed: number;
    readonly failed: number;
  };
  readonly evidence_verifications: ReadonlyArray<{
    evidence_id: string;
    status: "verified" | "unverified" | "rejected";
    detail: string;
  }>;
  readonly steps: readonly E2eStepRecord[];
}

export interface CreateE2eLogOptions {
  readonly suite: string;
  /** Where to persist the JSONL stream + artifact packet. */
  readonly artifactPath?: string;
  readonly now?: () => Date;
}

export interface E2eLog {
  step<T>(
    name: string,
    options: E2eStepOptions,
    fn: () => T | Promise<T>,
  ): Promise<{ value: T; record: E2eStepRecord }>;
  records(): readonly E2eStepRecord[];
  recordEvidenceVerification(input: {
    evidenceId: string;
    status: "verified" | "unverified" | "rejected";
    detail: string;
  }): void;
  recordRedactionCheck(passed: boolean): void;
  jsonLines(): string[];
  artifactPacket(): E2eArtifactPacket;
  writeJsonl(path: string): Promise<void>;
  writeArtifactPacket(path: string): Promise<void>;
}

export interface E2eStepOptions {
  readonly command?: string;
  readonly providerSlot?: string | null;
  readonly leaseId?: string | null;
  readonly evidenceId?: string | null;
  readonly envelope?: Record<string, unknown>;
  readonly metadata?: Record<string, unknown>;
  readonly status?: E2eStepStatus;
  readonly nextCommand?: string | null;
  readonly fixCommand?: string | null;
}

const ZERO_REDACTIONS = { checked: 0, passed: 0, failed: 0 };

export function createE2eLog(options: CreateE2eLogOptions): E2eLog {
  const startedAt = options.now ? options.now() : new Date();
  const records: E2eStepRecord[] = [];
  const evidenceVerifications: Array<E2eArtifactPacket["evidence_verifications"][number]> = [];
  let redactionAssertions = { ...ZERO_REDACTIONS };
  const jsonl: string[] = [];

  return {
    async step(name, stepOpts, fn) {
      const t0 = Date.now();
      let status: E2eStepStatus = stepOpts.status ?? "ok";
      let value: unknown;
      let errorMeta: Record<string, unknown> | null = null;
      try {
        value = await fn();
      } catch (error) {
        status = "error";
        errorMeta = {
          error_kind: error instanceof Error ? error.name : typeof error,
          error_message: error instanceof Error ? error.message : String(error),
        };
        throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
          e2eStep: name,
        });
      } finally {
        const elapsedMs = Date.now() - t0;
        const record: E2eStepRecord = {
          timestamp: new Date().toISOString(),
          step: name,
          index: records.length + 1,
          status,
          elapsed_ms: elapsedMs,
          command: stepOpts.command ?? null,
          provider_slot: stepOpts.providerSlot ?? null,
          mock_or_live: "mock",
          lease_id: stepOpts.leaseId ?? null,
          evidence_id: stepOpts.evidenceId ?? null,
          envelope: stepOpts.envelope ? redactEnvelope(stepOpts.envelope) : null,
          next_command: stepOpts.nextCommand ?? null,
          fix_command: stepOpts.fixCommand ?? null,
          metadata: redactStructuredTestMetadata({
            ...(stepOpts.metadata ?? {}),
            ...(errorMeta ?? {}),
          }),
        };
        records.push(record);
        jsonl.push(JSON.stringify(record));
      }
      return {
        value: value as Awaited<ReturnType<typeof fn>>,
        record: records[records.length - 1],
      };
    },

    records: () => records.slice(),

    recordEvidenceVerification(input) {
      evidenceVerifications.push({
        evidence_id: input.evidenceId,
        status: input.status,
        detail: input.detail,
      });
    },

    recordRedactionCheck(passed) {
      redactionAssertions = {
        checked: redactionAssertions.checked + 1,
        passed: redactionAssertions.passed + (passed ? 1 : 0),
        failed: redactionAssertions.failed + (passed ? 0 : 1),
      };
    },

    jsonLines: () => jsonl.slice(),

    artifactPacket(): E2eArtifactPacket {
      const finishedAt = new Date();
      return {
        suite: options.suite,
        started_at: startedAt.toISOString(),
        finished_at: finishedAt.toISOString(),
        elapsed_ms: finishedAt.getTime() - startedAt.getTime(),
        step_count: records.length,
        ok_count: records.filter((r) => r.status === "ok").length,
        blocked_count: records.filter((r) => r.status === "blocked").length,
        error_count: records.filter((r) => r.status === "error").length,
        redaction_assertions: redactionAssertions,
        evidence_verifications: [...evidenceVerifications],
        steps: records.slice(),
      };
    },

    async writeJsonl(path) {
      await mkdir(dirname(path), { recursive: true });
      const body = jsonl.join("\n");
      await writeFile(path, body.length ? `${body}\n` : "", "utf8");
    },

    async writeArtifactPacket(path) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, JSON.stringify(this.artifactPacket(), null, 2), "utf8");
    },
  };
}

/**
 * Strip raw token / cookie / DOM material from an envelope before
 * persisting it in the rehearsal artifact. The redactor is intentionally
 * conservative — drop any property whose key matches the sensitive set.
 */
function redactEnvelope(envelope: Record<string, unknown>): Record<string, unknown> {
  return redactStructuredTestMetadata(envelope);
}

/**
 * Defensive guard: assert the artifact packet is well-formed and
 * captures every required field for the CI failure attachment.
 */
export function assertE2eArtifactPacket(packet: E2eArtifactPacket): void {
  if (!packet.suite.trim()) throw new Error("artifact packet missing suite");
  if (!Number.isFinite(packet.elapsed_ms) || packet.elapsed_ms < 0) {
    throw new Error(`artifact packet elapsed_ms is invalid: ${packet.elapsed_ms}`);
  }
  if (packet.step_count !== packet.steps.length) {
    throw new Error(
      `step_count ${packet.step_count} disagrees with steps.length ${packet.steps.length}`,
    );
  }
  for (const step of packet.steps) {
    if (!step.step.trim()) throw new Error("step name is empty");
    if (!Number.isInteger(step.index) || step.index < 1) throw new Error("step index out of range");
    if (!["ok", "blocked", "skipped", "error"].includes(step.status)) {
      throw new Error(`step status invalid: ${step.status}`);
    }
    if (!Number.isFinite(step.elapsed_ms) || step.elapsed_ms < 0) {
      throw new Error(`step ${step.step} elapsed_ms is invalid: ${step.elapsed_ms}`);
    }
  }
}

/** Re-export the structured log record type for callers that want to interop. */
export type { StructuredTestLogRecord };

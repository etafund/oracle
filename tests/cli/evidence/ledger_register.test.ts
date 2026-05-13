import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { registerEvidenceCommand } from "../../../src/cli/commands/evidence/index.js";
import { appendEvidenceLedgerEvent } from "../../../src/oracle/evidence_ledger.js";

const testNonWindows = process.platform === "win32" ? test.skip : test;
const SESSION_ID = "ledger-register-test";
const HASH_A: `sha256:${string}` =
  "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

interface JsonEnvelopeForTest {
  readonly schema_version?: string;
  readonly ok?: boolean;
  readonly blocked_reason?: string | null;
  readonly errors: ReadonlyArray<{ readonly message?: string }>;
  readonly data?: Record<string, unknown> & {
    readonly events?: readonly EvidenceLedgerExportEventForTest[];
  };
  readonly meta?: Record<string, unknown>;
}

interface EvidenceLedgerExportEventForTest {
  readonly quarantined_metadata_included?: boolean;
  readonly event?: { readonly metadata?: Record<string, unknown> };
}

let homeDir: string;

beforeEach(async () => {
  homeDir = await mkdtemp(path.join(os.tmpdir(), "oracle-ledger-register-"));
  process.exitCode = undefined;
});

afterEach(async () => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  await rm(homeDir, { recursive: true, force: true });
});

describe("evidence ledger command registration", () => {
  test("registers show, verify, and export under oracle evidence ledger", () => {
    const program = createProgram();
    registerEvidenceCommand(program, { oracleHomeDir: homeDir });

    const evidence = program.commands.find((command) => command.name() === "evidence");
    const ledger = evidence?.commands.find((command) => command.name() === "ledger");

    expect(evidence).toBeDefined();
    expect(ledger).toBeDefined();
    expect(ledger?.commands.map((command) => command.name())).toEqual(
      expect.arrayContaining(["show", "verify", "export"]),
    );
  });

  testNonWindows("routes ledger show through the registered command tree with a JSON envelope", async () => {
    await appendEvidenceLedgerEvent(SESSION_ID, { type: "session_started" }, { homeDir });
    const output = captureConsole();
    const program = createRegisteredProgram();

    await program.parseAsync(["evidence", "ledger", "show", SESSION_ID, "--json"], {
      from: "user",
    });

    const envelope = parseJsonEnvelope(output.stdout);
    expect(envelope).toMatchObject({
      schema_version: "json_envelope.v1",
      ok: true,
      data: {
        schema_version: "evidence_ledger.v1",
        session_id: SESSION_ID,
        entry_count: 1,
        chain_valid: true,
      },
      meta: { tool: "oracle evidence ledger show" },
    });
    expect(process.exitCode).toBeUndefined();
  });

  testNonWindows("sets a failing exit code for invalid registered ledger verify sessions", async () => {
    const output = captureConsole();
    const program = createRegisteredProgram();

    await program.parseAsync(["evidence", "ledger", "verify", "../outside", "--json"], {
      from: "user",
    });

    const envelope = parseJsonEnvelope(output.stdout);
    expect(envelope).toMatchObject({
      schema_version: "json_envelope.v1",
      ok: false,
      blocked_reason: "output_capture_unverified",
    });
    expect(envelope.errors[0]?.message).toMatch(/Invalid session id/);
    expect(process.exitCode).toBe(1);
  });

  testNonWindows("routes sanitized and quarantined ledger exports through registration", async () => {
    await appendEvidenceLedgerEvent(
      SESSION_ID,
      {
        type: "evidence_quarantined",
        evidence_id: "unsafe-1",
        metadata: {
          redaction_policy: "unsafe_debug",
          evidence_sha256: HASH_A,
          operator_note: "safe handoff note",
        },
      },
      { homeDir },
    );
    const output = captureConsole();

    await createRegisteredProgram().parseAsync(
      ["evidence", "ledger", "export", SESSION_ID, "--sanitized", "--json"],
      { from: "user" },
    );
    const sanitized = parseJsonEnvelope(output.stdout);
    expect(sanitized).toMatchObject({
      schema_version: "json_envelope.v1",
      ok: true,
      data: {
        schema_version: "evidence_ledger_export.v1",
        session_id: SESSION_ID,
        export_mode: "sanitized",
        quarantined_included: false,
        quarantined_entry_count: 1,
      },
    });
    expect(firstEvent(sanitized)?.quarantined_metadata_included).toBe(false);
    expect(firstEvent(sanitized)?.event?.metadata).toMatchObject({
      metadata_omitted_from_sanitized_export: true,
      redaction_policy: "unsafe_debug",
      evidence_sha256: HASH_A,
    });

    output.stdout.length = 0;
    await createRegisteredProgram().parseAsync(
      ["evidence", "ledger", "export", SESSION_ID, "--quarantined", "--json"],
      { from: "user" },
    );
    const quarantined = parseJsonEnvelope(output.stdout);
    expect(quarantined).toMatchObject({
      schema_version: "json_envelope.v1",
      ok: true,
      data: {
        schema_version: "evidence_ledger_export.v1",
        session_id: SESSION_ID,
        export_mode: "quarantined",
        quarantined_included: true,
      },
    });
    expect(firstEvent(quarantined)?.quarantined_metadata_included).toBe(true);
    expect(firstEvent(quarantined)?.event?.metadata?.operator_note).toBe("safe handoff note");
  });
});

function createRegisteredProgram(): Command {
  const program = createProgram();
  registerEvidenceCommand(program, { oracleHomeDir: homeDir });
  return program;
}

function createProgram(): Command {
  return new Command()
    .exitOverride()
    .configureOutput({ writeErr: () => undefined, writeOut: () => undefined });
}

function captureConsole(): { stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  vi.spyOn(console, "log").mockImplementation((message) => stdout.push(String(message)));
  vi.spyOn(console, "error").mockImplementation((message) => stderr.push(String(message)));
  return { stdout, stderr };
}

function parseJsonEnvelope(output: readonly string[]): JsonEnvelopeForTest {
  expect(output).toHaveLength(1);
  return JSON.parse(output[0]!) as JsonEnvelopeForTest;
}

function firstEvent(envelope: JsonEnvelopeForTest): EvidenceLedgerExportEventForTest | null {
  const events = envelope.data?.events;
  return Array.isArray(events) ? (events[0] ?? null) : null;
}

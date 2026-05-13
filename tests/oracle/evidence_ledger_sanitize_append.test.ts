import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  appendEvidenceLedgerEvent,
  evidenceLedgerPath,
  readEvidenceLedger,
} from "../../src/oracle/evidence_ledger.js";
import {
  EVIDENCE_LEDGER_APPEND_REDACTED,
  sanitizeEvidenceLedgerAppendMetadata,
} from "../../src/oracle/evidence_ledger_sanitize_append.js";

const testNonWindows = process.platform === "win32" ? test.skip : test;

const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;
const SESSION_ID = "session-ledger-sanitize-append";

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("sanitizeEvidenceLedgerAppendMetadata", () => {
  test("masks secret-bearing values while preserving digest handles", () => {
    const sanitized = sanitizeEvidenceLedgerAppendMetadata({
      prompt_sha256: HASH_A,
      token_hash: HASH_B,
      provider_note:
        "retry with Bearer supersecret-token-12345 and sk-test-secret0000000",
      nested: {
        callback: "https://example.test/cb?access_token=secret-value&ok=1",
        message:
          "__Secure-next-auth.session-token=session-secret; raw_prompt=private-prompt; output_text=private-output; hidden_reasoning=private-thinking",
      },
      array: [
        "Authorization=secret-value token=also-secret",
        {
          details:
            "jwt eyJhbGciOiJIUzI1NiIs.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
        },
      ],
      screenshot_note: "data:image/png;base64,LEAKAAAA12345678",
    });

    expect(sanitized.prompt_sha256).toBe(HASH_A);
    expect(sanitized.token_hash).toBe(HASH_B);
    expect(sanitized.screenshot_note).toBe(EVIDENCE_LEDGER_APPEND_REDACTED);
    expect(sanitized.provider_note).toBe(
      `retry with Bearer ${EVIDENCE_LEDGER_APPEND_REDACTED} and ${EVIDENCE_LEDGER_APPEND_REDACTED}`,
    );
    expect((sanitized.nested as Record<string, unknown>).callback).toBe(
      "https://example.test/cb?access_token=[redacted]&ok=1",
    );

    const rendered = JSON.stringify(sanitized);
    expect(rendered).not.toContain("supersecret-token");
    expect(rendered).not.toContain("sk-test-secret");
    expect(rendered).not.toContain("secret-value");
    expect(rendered).not.toContain("session-secret");
    expect(rendered).not.toContain("private-prompt");
    expect(rendered).not.toContain("private-output");
    expect(rendered).not.toContain("private-thinking");
    expect(rendered).not.toContain("SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c");
    expect(rendered).not.toContain("LEAKAAAA12345678");
  });
});

describe("appendEvidenceLedgerEvent append-time sanitization", () => {
  testNonWindows("writes only sanitized metadata values to ledger.jsonl", async () => {
    const homeDir = await createTempHome();

    const { entry } = await appendEvidenceLedgerEvent(
      SESSION_ID,
      {
        type: "run_failed",
        metadata: {
          prompt_sha256: HASH_A,
          token_hash: HASH_B,
          provider_note: "retry with Bearer append-secret-token-12345",
          failure_reason:
            "upstream callback https://example.test/cb?access_token=append-secret-value",
          nested: {
            message:
              "cookie=append-cookie-secret; raw_output=append-private-output",
          },
          array: [{ detail: "api_key=append-api-secret" }],
        },
      },
      { homeDir },
    );

    expect(entry.event.metadata).toMatchObject({
      prompt_sha256: HASH_A,
      token_hash: HASH_B,
      provider_note: "retry with Bearer [redacted]",
      failure_reason:
        "upstream callback https://example.test/cb?access_token=[redacted]",
    });

    const raw = await readFile(evidenceLedgerPath(SESSION_ID, homeDir), "utf8");
    expect(raw).not.toContain("append-secret-token");
    expect(raw).not.toContain("append-secret-value");
    expect(raw).not.toContain("append-cookie-secret");
    expect(raw).not.toContain("append-private-output");
    expect(raw).not.toContain("append-api-secret");

    const read = await readEvidenceLedger(SESSION_ID, { homeDir });
    expect(read.chainValid).toBe(true);
    expect(read.entries).toHaveLength(1);
    expect(read.entries[0]?.event.metadata).toEqual(entry.event.metadata);
  });
});

async function createTempHome(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-ledger-append-sanitize-"));
  tempDirs.push(dir);
  return dir;
}

import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, symlink, truncate, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, test, vi } from "vitest";
import {
  MAX_DATA_TRANSFER_BYTES,
  readBoundedRegularFile,
  transferAttachmentViaDataTransfer,
} from "../../src/browser/actions/attachmentDataTransfer.js";
import type { BrowserAttachment, ChromeClient } from "../../src/browser/types.js";
import { BrowserAutomationError } from "../../src/oracle/errors.js";

const fixtureRoot = path.join(
  os.tmpdir(),
  `oracle-attachment-reader-${process.pid}-${randomUUID()}`,
);
let fixtureSequence = 0;

beforeAll(async () => {
  // These per-process fixtures intentionally stay under the operating system's
  // temporary directory; the repository's no-deletion rule forbids test cleanup.
  await mkdir(fixtureRoot, { recursive: true });
});

async function fixtureFile(label: string, bytes: Uint8Array): Promise<string> {
  fixtureSequence += 1;
  const filePath = path.join(fixtureRoot, `${fixtureSequence}-${label}`);
  await writeFile(filePath, bytes);
  return filePath;
}

async function expectBrowserCode(promise: Promise<unknown>, code: string): Promise<void> {
  const error = await promise.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(BrowserAutomationError);
  expect((error as BrowserAutomationError).details).toMatchObject({ code });
}

function runtimeWithResult(result: unknown): {
  runtime: ChromeClient["Runtime"];
  evaluate: ReturnType<typeof vi.fn>;
} {
  const evaluate = vi.fn(async () => ({ result: { value: result } }));
  return {
    runtime: { evaluate } as unknown as ChromeClient["Runtime"],
    evaluate,
  };
}

describe("readBoundedRegularFile", () => {
  test("returns exact bytes and their SHA-256 digest for a normal file", async () => {
    const bytes = Buffer.from("first\0second\n", "utf8");
    const filePath = await fixtureFile("normal.bin", bytes);

    const result = await readBoundedRegularFile(filePath, { maxBytes: 1024 });

    expect(result.bytes).toEqual(bytes);
    expect(result.sizeBytes).toBe(bytes.length);
    expect(result.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
  });

  test("accepts a file exactly at the caller's byte cap", async () => {
    const bytes = Buffer.from([0, 1, 2, 3, 4]);
    const filePath = await fixtureFile("exact-cap.bin", bytes);

    await expect(
      readBoundedRegularFile(filePath, { maxBytes: bytes.length }),
    ).resolves.toMatchObject({
      bytes,
      sizeBytes: bytes.length,
    });
  });

  test("rejects an over-cap file before reading it", async () => {
    const filePath = await fixtureFile("over-cap.bin", Buffer.alloc(9, 0x61));

    await expectBrowserCode(
      readBoundedRegularFile(filePath, { maxBytes: 8 }),
      "attachment-file-too-large",
    );
  });

  test("rejects a symlink without following it", async () => {
    const targetPath = await fixtureFile("symlink-target.txt", Buffer.from("target"));
    const linkPath = path.join(fixtureRoot, `${++fixtureSequence}-attachment-link`);
    await symlink(targetPath, linkPath);

    await expectBrowserCode(
      readBoundedRegularFile(linkPath, { maxBytes: 1024 }),
      "attachment-file-symlink-refused",
    );
  });

  test("rejects a directory as a non-regular input", async () => {
    const directoryPath = path.join(fixtureRoot, `${++fixtureSequence}-directory`);
    await mkdir(directoryPath);

    await expectBrowserCode(
      readBoundedRegularFile(directoryPath, { maxBytes: 1024 }),
      "attachment-file-not-regular",
    );
  });

  test("rejects growth during reading", async () => {
    const bytes = Buffer.alloc(192 * 1024, 0x62);
    const filePath = await fixtureFile("grows-during-read.bin", bytes);
    let mutated = false;

    await expectBrowserCode(
      readBoundedRegularFile(filePath, {
        maxBytes: bytes.length + 1,
        onReadProgress: async () => {
          if (mutated) return;
          mutated = true;
          await appendFile(filePath, Buffer.from([0x63]));
        },
      }),
      "attachment-file-changed",
    );
    expect(mutated).toBe(true);
  });

  test("rejects a short read caused by mid-read truncation", async () => {
    const bytes = Buffer.alloc(192 * 1024, 0x64);
    const filePath = await fixtureFile("shrinks-during-read.bin", bytes);
    let mutated = false;

    await expectBrowserCode(
      readBoundedRegularFile(filePath, {
        maxBytes: bytes.length,
        onReadProgress: async (bytesRead) => {
          if (mutated) return;
          mutated = true;
          await truncate(filePath, bytesRead);
        },
      }),
      "attachment-file-changed",
    );
    expect(mutated).toBe(true);
  });

  test("aborts a stalled read observer at the configured deadline", async () => {
    const filePath = await fixtureFile("deadline.bin", Buffer.alloc(128 * 1024, 0x65));

    await expectBrowserCode(
      readBoundedRegularFile(filePath, {
        maxBytes: 128 * 1024,
        deadlineMs: 25,
        onReadProgress: () => new Promise<void>(() => undefined),
      }),
      "attachment-file-read-timeout",
    );
  });

  test("rejects a declared-size mismatch", async () => {
    const bytes = Buffer.from("declared size", "utf8");
    const filePath = await fixtureFile("declared-size.txt", bytes);

    await expectBrowserCode(
      readBoundedRegularFile(filePath, {
        maxBytes: 1024,
        declaredSizeBytes: bytes.length + 1,
      }),
      "attachment-file-declared-size-mismatch",
    );
  });

  test("rejects a declared-hash mismatch", async () => {
    const filePath = await fixtureFile("declared-hash.txt", Buffer.from("bound bytes", "utf8"));

    await expectBrowserCode(
      readBoundedRegularFile(filePath, {
        maxBytes: 1024,
        declaredSha256: "0".repeat(64),
      }),
      "attachment-file-declared-hash-mismatch",
    );
  });
});

describe("transferAttachmentViaDataTransfer", () => {
  test("uses the 20 MiB bounded reader and honors supplied size/hash bindings", async () => {
    expect(MAX_DATA_TRANSFER_BYTES).toBe(20 * 1024 * 1024);
    const bytes = Buffer.from("verified upload bytes", "utf8");
    const filePath = await fixtureFile("verified-upload.txt", bytes);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const attachment: BrowserAttachment & { integritySha256: string } = {
      path: filePath,
      displayPath: "verified-upload.txt",
      sizeBytes: bytes.length,
      integritySha256: `sha256:${sha256}`,
    };
    const { runtime, evaluate } = runtimeWithResult({
      success: true,
      fileName: path.basename(filePath),
      size: bytes.length,
    });

    await expect(
      transferAttachmentViaDataTransfer(runtime, attachment, 'input[type="file"]'),
    ).resolves.toEqual({ fileName: path.basename(filePath), size: bytes.length });
    expect(evaluate).toHaveBeenCalledOnce();
    const expression = evaluate.mock.calls[0]?.[0]?.expression as string;
    expect(expression).toContain(bytes.toString("base64"));
  });

  test("does not evaluate browser code after a supplied size mismatch", async () => {
    const bytes = Buffer.from("size mismatch", "utf8");
    const filePath = await fixtureFile("upload-size-mismatch.txt", bytes);
    const { runtime, evaluate } = runtimeWithResult({ success: true });

    await expectBrowserCode(
      transferAttachmentViaDataTransfer(
        runtime,
        { path: filePath, displayPath: "upload-size-mismatch.txt", sizeBytes: bytes.length + 1 },
        'input[type="file"]',
      ),
      "attachment-file-declared-size-mismatch",
    );
    expect(evaluate).not.toHaveBeenCalled();
  });

  test("does not evaluate browser code after a supplied hash mismatch", async () => {
    const bytes = Buffer.from("hash mismatch", "utf8");
    const filePath = await fixtureFile("upload-hash-mismatch.txt", bytes);
    const attachment: BrowserAttachment & { integritySha256: string } = {
      path: filePath,
      displayPath: "upload-hash-mismatch.txt",
      sizeBytes: bytes.length,
      integritySha256: "f".repeat(64),
    };
    const { runtime, evaluate } = runtimeWithResult({ success: true });

    await expectBrowserCode(
      transferAttachmentViaDataTransfer(runtime, attachment, 'input[type="file"]'),
      "attachment-file-declared-hash-mismatch",
    );
    expect(evaluate).not.toHaveBeenCalled();
  });
});

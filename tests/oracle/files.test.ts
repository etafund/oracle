import { describe, expect, test } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { readFiles } from "../../src/oracle/files.js";
import { FileValidationError } from "../../src/oracle/errors.js";

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-files-encode-media-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// Minimal, valid magic-byte headers for each supported media type.
const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_HEADER = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
const GIF_HEADER = Buffer.from("GIF89a", "latin1");
const WEBP_HEADER = Buffer.concat([
  Buffer.from("RIFF", "latin1"),
  Buffer.from([0x00, 0x00, 0x00, 0x00]),
  Buffer.from("WEBP", "latin1"),
]);

describe("readFiles binaryFileHandling: encode-media (bead oracle-router-8fa)", () => {
  test("base64-encodes a PNG into an image attachment (content = base64, mediaType, rawByteLength)", async () => {
    await withTempDir(async (dir) => {
      const bytes = Buffer.concat([PNG_HEADER, Buffer.from([0x01, 0x02, 0x03, 0x00, 0xff])]);
      const filePath = path.join(dir, "pic.png");
      await writeFile(filePath, bytes);

      const files = await readFiles([filePath], { cwd: dir, binaryFileHandling: "encode-media" });
      expect(files).toHaveLength(1);
      expect(files[0]).toMatchObject({
        path: filePath,
        attachment: "image",
        mediaType: "image/png",
        rawByteLength: bytes.length,
      });
      // content is the newline-free base64 of the exact bytes.
      expect(files[0].content).toBe(bytes.toString("base64"));
      expect(files[0].content).not.toContain("\n");
      expect(Buffer.from(files[0].content, "base64")).toEqual(bytes);
    });
  });

  test("classifies JPEG / GIF / WebP images by magic bytes", async () => {
    await withTempDir(async (dir) => {
      const cases: Array<[string, Buffer, string]> = [
        ["a.jpg", Buffer.concat([JPEG_HEADER, Buffer.from([0x00])]), "image/jpeg"],
        ["a.gif", Buffer.concat([GIF_HEADER, Buffer.from([0x00])]), "image/gif"],
        ["a.webp", Buffer.concat([WEBP_HEADER, Buffer.from([0x00])]), "image/webp"],
      ];
      for (const [name, bytes, mediaType] of cases) {
        const filePath = path.join(dir, name);
        await writeFile(filePath, bytes);
        const [file] = await readFiles([filePath], {
          cwd: dir,
          binaryFileHandling: "encode-media",
        });
        expect(file).toMatchObject({ attachment: "image", mediaType });
      }
    });
  });

  test("encodes a PDF into a document attachment even when it is all-ASCII (text-decodable)", async () => {
    await withTempDir(async (dir) => {
      // A pure-ASCII PDF would round-trip as UTF-8 text; magic-byte detection
      // must still classify it as a document block, not a text block.
      const bytes = Buffer.from("%PDF-1.4\n1 0 obj\n<< >>\nendobj\n%%EOF\n", "latin1");
      const filePath = path.join(dir, "doc.pdf");
      await writeFile(filePath, bytes);

      const [file] = await readFiles([filePath], { cwd: dir, binaryFileHandling: "encode-media" });
      expect(file).toMatchObject({ attachment: "document", mediaType: "application/pdf" });
      expect(file.content).toBe(bytes.toString("base64"));
    });
  });

  test("keeps text files as text attachments (no attachment metadata)", async () => {
    await withTempDir(async (dir) => {
      const filePath = path.join(dir, "notes.md");
      await writeFile(filePath, "plain text notes", "utf8");
      const [file] = await readFiles([filePath], { cwd: dir, binaryFileHandling: "encode-media" });
      expect(file.attachment).toBeUndefined();
      expect(file.mediaType).toBeUndefined();
      expect(file.content).toBe("plain text notes");
    });
  });

  test("still rejects non-image/non-PDF binary, naming the file and the supported types", async () => {
    await withTempDir(async (dir) => {
      // ZIP magic bytes + a NUL: unambiguously binary, unsupported media.
      const filePath = path.join(dir, "archive.zip");
      await writeFile(filePath, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff, 0xfe]));
      await expect(
        readFiles([filePath], { cwd: dir, binaryFileHandling: "encode-media" }),
      ).rejects.toThrow(/archive\.zip/);
      await expect(
        readFiles([filePath], { cwd: dir, binaryFileHandling: "encode-media" }),
      ).rejects.toThrow(/image \(PNG\/JPEG\/GIF\/WebP\), and PDF/);
    });
  });

  test("enforces the per-file cap PRE-encode: a media file whose base64 would exceed the cap is accepted", async () => {
    await withTempDir(async (dir) => {
      // 800 raw bytes -> ~1068 base64 bytes. A 1000-byte per-file cap must
      // measure the RAW 800 (accept), not the encoded 1068 (would reject).
      const body = Buffer.alloc(792, 0x01);
      const bytes = Buffer.concat([PNG_HEADER, body]);
      expect(bytes.length).toBe(800);
      expect(bytes.toString("base64").length).toBeGreaterThan(1000);
      const filePath = path.join(dir, "capped.png");
      await writeFile(filePath, bytes);

      const [file] = await readFiles([filePath], {
        cwd: dir,
        binaryFileHandling: "encode-media",
        maxFileSizeBytes: 1000,
      });
      expect(file).toMatchObject({ attachment: "image", rawByteLength: 800 });
    });
  });

  test("a media file over the raw per-file cap is rejected as oversized (raw size, not encoded)", async () => {
    await withTempDir(async (dir) => {
      const bytes = Buffer.concat([PNG_HEADER, Buffer.alloc(1200, 0x02)]);
      const filePath = path.join(dir, "toobig.png");
      await writeFile(filePath, bytes);
      await expect(
        readFiles([filePath], {
          cwd: dir,
          binaryFileHandling: "encode-media",
          maxFileSizeBytes: 1000,
        }),
      ).rejects.toThrow(/exceed the .* limit/i);
    });
  });
});

describe("readFiles binaryFileHandling: reject stays byte-identical for images (flag-off legacy behavior)", () => {
  test("reject mode still hard-rejects a PNG with the legacy 'not supported by this lane' message", async () => {
    await withTempDir(async (dir) => {
      const bytes = Buffer.concat([PNG_HEADER, Buffer.from([0x00, 0xff])]);
      const filePath = path.join(dir, "pic.png");
      await writeFile(filePath, bytes);
      await expect(
        readFiles([filePath], { cwd: dir, binaryFileHandling: "reject" }),
      ).rejects.toThrow(/binary\/image attachment is not supported by this lane/);
    });
  });

  test("reject mode surfaces a FileValidationError instance", async () => {
    await withTempDir(async (dir) => {
      const filePath = path.join(dir, "blob.bin");
      await writeFile(filePath, Buffer.from([0x00, 0x01, 0x02]));
      await readFiles([filePath], { cwd: dir, binaryFileHandling: "reject" }).then(
        () => {
          throw new Error("expected readFiles to reject");
        },
        (error: unknown) => {
          expect(error).toBeInstanceOf(FileValidationError);
        },
      );
    });
  });
});

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import type { BigIntStats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import path from "node:path";
import type { ChromeClient, BrowserAttachment } from "../types.js";
import { BrowserAutomationError } from "../../oracle/errors.js";

export const MAX_DATA_TRANSFER_BYTES = 20 * 1024 * 1024;
const DEFAULT_FILE_READ_DEADLINE_MS = 30_000;

export interface BoundedRegularFileReadOptions {
  /** Maximum bytes this call may allocate and read. Must be a positive safe integer. */
  maxBytes: number;
  /** Absolute read-operation budget. Defaults to 30 seconds. */
  deadlineMs?: number;
  /** Optional caller-side size binding. */
  declaredSizeBytes?: number;
  /** Optional caller-side SHA-256 binding, as 64 hex characters or `sha256:<hex>`. */
  declaredSha256?: string;
  /** Optional content-free progress observer, useful for callers and deterministic tests. */
  onReadProgress?: (bytesRead: number) => void | Promise<void>;
}

export interface BoundedRegularFileReadResult {
  bytes: Buffer;
  sizeBytes: number;
  /** Lower-case, unprefixed SHA-256 hex digest. */
  sha256: string;
}

type AttachmentWithIntegrity = BrowserAttachment & {
  integritySha256?: string;
};

function fileReadError(
  filePath: string,
  code: string,
  message: string,
  details: Record<string, unknown> = {},
): BrowserAutomationError {
  return new BrowserAutomationError(message, {
    code,
    phase: "attachment-file-read",
    fileName: path.basename(filePath) || "attachment",
    ...details,
  });
}

function normalizeDeclaredSha256(filePath: string, value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw fileReadError(
      filePath,
      "attachment-file-invalid-declared-hash",
      "Attachment SHA-256 binding is malformed.",
    );
  }
  const normalized = value.toLowerCase().replace(/^sha256:/, "");
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw fileReadError(
      filePath,
      "attachment-file-invalid-declared-hash",
      "Attachment SHA-256 binding is malformed.",
    );
  }
  return normalized;
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameGeneration(left: BigIntStats, right: BigIntStats): boolean {
  return (
    sameIdentity(left, right) &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function assertDeadline(filePath: string, deadlineAt: number): void {
  if (Date.now() >= deadlineAt) {
    throw fileReadError(
      filePath,
      "attachment-file-read-timeout",
      "Attachment read exceeded its deadline.",
    );
  }
}

async function reportReadProgress(
  filePath: string,
  observer: BoundedRegularFileReadOptions["onReadProgress"],
  bytesRead: number,
  signal: AbortSignal,
): Promise<void> {
  if (!observer) return;
  if (signal.aborted) {
    throw fileReadError(
      filePath,
      "attachment-file-read-timeout",
      "Attachment read exceeded its deadline.",
    );
  }
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () =>
      settle(() =>
        reject(
          fileReadError(
            filePath,
            "attachment-file-read-timeout",
            "Attachment read exceeded its deadline.",
          ),
        ),
      );
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve()
      .then(() => observer(bytesRead))
      .then(
        () => settle(resolve),
        (error: unknown) => settle(() => reject(error)),
      );
  });
}

/**
 * Read an attachment without following symlinks or opening special files.
 *
 * The path and descriptor must describe the same unchanged regular-file
 * generation before and after the bounded read. The returned digest therefore
 * binds the exact bytes that a later upload step can inject into the browser.
 */
export async function readBoundedRegularFile(
  filePath: string,
  options: BoundedRegularFileReadOptions,
): Promise<BoundedRegularFileReadResult> {
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes <= 0) {
    throw fileReadError(
      filePath,
      "attachment-file-invalid-byte-cap",
      "Attachment byte cap must be a positive safe integer.",
    );
  }
  const deadlineMs = options.deadlineMs ?? DEFAULT_FILE_READ_DEADLINE_MS;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0 || deadlineMs > 2_147_483_647) {
    throw fileReadError(
      filePath,
      "attachment-file-invalid-deadline",
      "Attachment read deadline must be a positive safe integer.",
    );
  }
  if (
    options.declaredSizeBytes !== undefined &&
    (!Number.isSafeInteger(options.declaredSizeBytes) || options.declaredSizeBytes < 0)
  ) {
    throw fileReadError(
      filePath,
      "attachment-file-invalid-declared-size",
      "Attachment size binding must be a non-negative safe integer.",
    );
  }
  const declaredSha256 = normalizeDeclaredSha256(filePath, options.declaredSha256);
  const deadlineAt = Date.now() + deadlineMs;

  let pathBefore: BigIntStats;
  try {
    pathBefore = await lstat(filePath, { bigint: true });
  } catch (error) {
    throw fileReadError(
      filePath,
      "attachment-file-inspection-failed",
      "Attachment could not be inspected safely.",
      { causeCode: (error as NodeJS.ErrnoException)?.code ?? "unknown" },
    );
  }
  assertDeadline(filePath, deadlineAt);
  if (pathBefore.isSymbolicLink()) {
    throw fileReadError(
      filePath,
      "attachment-file-symlink-refused",
      "Attachment symlinks are not allowed.",
    );
  }
  if (!pathBefore.isFile()) {
    throw fileReadError(
      filePath,
      "attachment-file-not-regular",
      "Attachment must be a regular file.",
    );
  }
  if (pathBefore.size > BigInt(options.maxBytes)) {
    throw fileReadError(
      filePath,
      "attachment-file-too-large",
      `Attachment exceeds the ${options.maxBytes}-byte limit.`,
      { observedSizeBytes: pathBefore.size.toString(), maxBytes: options.maxBytes },
    );
  }

  const expectedSize = Number(pathBefore.size);
  if (options.declaredSizeBytes !== undefined && options.declaredSizeBytes !== expectedSize) {
    throw fileReadError(
      filePath,
      "attachment-file-declared-size-mismatch",
      "Attachment size does not match its declared binding.",
      { declaredSizeBytes: options.declaredSizeBytes, observedSizeBytes: expectedSize },
    );
  }

  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let operationError: unknown;
  let result: BoundedRegularFileReadResult | undefined;
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), Math.max(1, deadlineAt - Date.now()));
  timeout.unref?.();
  try {
    const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
    const nonBlock = typeof constants.O_NONBLOCK === "number" ? constants.O_NONBLOCK : 0;
    try {
      handle = await open(filePath, constants.O_RDONLY | noFollow | nonBlock);
    } catch (error) {
      throw fileReadError(
        filePath,
        "attachment-file-open-refused",
        "Attachment could not be opened safely.",
        { causeCode: (error as NodeJS.ErrnoException)?.code ?? "unknown" },
      );
    }
    assertDeadline(filePath, deadlineAt);

    const descriptorBefore = await handle.stat({ bigint: true });
    assertDeadline(filePath, deadlineAt);
    if (!descriptorBefore.isFile()) {
      throw fileReadError(
        filePath,
        "attachment-file-not-regular",
        "Attachment must remain a regular file.",
      );
    }
    if (!sameGeneration(pathBefore, descriptorBefore)) {
      throw fileReadError(
        filePath,
        "attachment-file-changed",
        "Attachment changed while it was being opened.",
      );
    }

    // Allocation is bounded by the already-verified size and caller cap.
    const bytes = Buffer.alloc(expectedSize);
    let offset = 0;
    if (expectedSize > 0) {
      const stream = handle.createReadStream({
        autoClose: false,
        start: 0,
        end: expectedSize - 1,
        highWaterMark: 64 * 1024,
        signal: abortController.signal,
      });
      try {
        for await (const chunk of stream) {
          assertDeadline(filePath, deadlineAt);
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          if (offset + buffer.length > expectedSize) {
            throw fileReadError(
              filePath,
              "attachment-file-changed",
              "Attachment grew while it was being read.",
            );
          }
          buffer.copy(bytes, offset);
          offset += buffer.length;
          await reportReadProgress(
            filePath,
            options.onReadProgress,
            offset,
            abortController.signal,
          );
          assertDeadline(filePath, deadlineAt);
        }
      } catch (error) {
        if (error instanceof BrowserAutomationError) throw error;
        if (abortController.signal.aborted) {
          throw fileReadError(
            filePath,
            "attachment-file-read-timeout",
            "Attachment read exceeded its deadline.",
          );
        }
        throw fileReadError(
          filePath,
          "attachment-file-read-failed",
          "Attachment bytes could not be read safely.",
          { causeCode: (error as NodeJS.ErrnoException)?.code ?? "unknown" },
        );
      }
    }
    if (offset !== expectedSize) {
      throw fileReadError(
        filePath,
        "attachment-file-changed",
        "Attachment became shorter while it was being read.",
        { expectedSizeBytes: expectedSize, observedSizeBytes: offset },
      );
    }

    const descriptorAfter = await handle.stat({ bigint: true });
    assertDeadline(filePath, deadlineAt);
    let pathAfter: BigIntStats;
    try {
      pathAfter = await lstat(filePath, { bigint: true });
    } catch (error) {
      throw fileReadError(
        filePath,
        "attachment-file-changed",
        "Attachment path changed while it was being read.",
        { causeCode: (error as NodeJS.ErrnoException)?.code ?? "unknown" },
      );
    }
    assertDeadline(filePath, deadlineAt);
    if (
      !descriptorAfter.isFile() ||
      !pathAfter.isFile() ||
      pathAfter.isSymbolicLink() ||
      !sameGeneration(descriptorBefore, descriptorAfter) ||
      !sameGeneration(descriptorAfter, pathAfter)
    ) {
      throw fileReadError(
        filePath,
        "attachment-file-changed",
        "Attachment changed while it was being read.",
      );
    }

    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (declaredSha256 !== undefined && declaredSha256 !== sha256) {
      throw fileReadError(
        filePath,
        "attachment-file-declared-hash-mismatch",
        "Attachment bytes do not match their declared SHA-256 binding.",
        { declaredSha256, observedSha256: sha256 },
      );
    }
    result = { bytes, sizeBytes: bytes.length, sha256 };
  } catch (error) {
    const failure =
      error instanceof BrowserAutomationError
        ? error
        : fileReadError(
            filePath,
            "attachment-file-read-failed",
            "Attachment could not be read safely.",
            { causeCode: (error as NodeJS.ErrnoException)?.code ?? "unknown" },
          );
    operationError = failure;
  } finally {
    clearTimeout(timeout);
    if (handle) {
      try {
        await handle.close();
      } catch (error) {
        if (operationError === undefined) {
          operationError = fileReadError(
            filePath,
            "attachment-file-close-failed",
            "Attachment descriptor could not be closed safely.",
            { causeCode: (error as NodeJS.ErrnoException)?.code ?? "unknown" },
          );
        }
      }
    }
  }
  if (operationError !== undefined) throw operationError;
  if (result === undefined) {
    throw fileReadError(
      filePath,
      "attachment-file-read-failed",
      "Attachment read did not produce a verified result.",
    );
  }
  return result;
}

export async function transferAttachmentViaDataTransfer(
  runtime: ChromeClient["Runtime"],
  attachment: BrowserAttachment,
  selector: string,
): Promise<{ fileName: string; size: number }> {
  const fileRead = await readBoundedRegularFile(attachment.path, {
    maxBytes: MAX_DATA_TRANSFER_BYTES,
    declaredSizeBytes: attachment.sizeBytes,
    declaredSha256: (attachment as AttachmentWithIntegrity).integritySha256,
  });
  const fileContent = fileRead.bytes;

  const base64Content = fileContent.toString("base64");
  const fileName = path.basename(attachment.path);
  const mimeType = guessMimeType(fileName);

  const expression = `(() => {
    if (!('File' in window) || !('Blob' in window) || !('DataTransfer' in window) || typeof atob !== 'function') {
      return { success: false, error: 'Required file APIs are not available in this browser' };
    }

    const fileInput = document.querySelector(${JSON.stringify(selector)});
    if (!fileInput) {
      return { success: false, error: 'File input not found' };
    }
    if (!(fileInput instanceof HTMLInputElement) || fileInput.type !== 'file') {
      return { success: false, error: 'Found element is not a file input' };
    }

    const base64Data = ${JSON.stringify(base64Content)};
    const binaryString = atob(base64Data);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    const blob = new Blob([bytes], { type: ${JSON.stringify(mimeType)} });

    const file = new File([blob], ${JSON.stringify(fileName)}, {
      type: ${JSON.stringify(mimeType)},
      lastModified: Date.now(),
    });

    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(file);
    let assigned = false;

    const proto = Object.getPrototypeOf(fileInput);
    const descriptor = proto ? Object.getOwnPropertyDescriptor(proto, 'files') : null;
    if (descriptor?.set) {
      try {
        descriptor.set.call(fileInput, dataTransfer.files);
        assigned = true;
      } catch {
        assigned = false;
      }
    }
    if (!assigned) {
      try {
        Object.defineProperty(fileInput, 'files', {
          configurable: true,
          get: () => dataTransfer.files,
        });
        assigned = true;
      } catch {
        assigned = false;
      }
    }
    if (!assigned) {
      try {
        fileInput.files = dataTransfer.files;
        assigned = true;
      } catch {
        assigned = false;
      }
    }
    if (!assigned) {
      return { success: false, error: 'Unable to assign FileList to input' };
    }

    fileInput.dispatchEvent(new Event('change', { bubbles: true }));
    return { success: true, fileName: file.name, size: file.size };
  })()`;

  let evalResult: Awaited<ReturnType<ChromeClient["Runtime"]["evaluate"]>>;
  try {
    evalResult = await runtime.evaluate({ expression, returnByValue: true });
  } catch (error) {
    throw new BrowserAutomationError("Failed to transfer file to browser.", {
      code: "attachment-data-transfer-evaluation-failed",
      phase: "attachment-data-transfer",
      fileName,
      causeCode: (error as { code?: unknown })?.code ?? "unknown",
    });
  }
  if (evalResult.exceptionDetails) {
    const description = evalResult.exceptionDetails.text ?? "JS evaluation failed";
    throw new BrowserAutomationError(`Failed to transfer file to browser: ${description}`, {
      code: "attachment-data-transfer-evaluation-failed",
      phase: "attachment-data-transfer",
      fileName,
    });
  }

  if (
    !evalResult.result ||
    typeof evalResult.result.value !== "object" ||
    evalResult.result.value === null ||
    evalResult.result.value === undefined
  ) {
    throw new BrowserAutomationError(
      "Failed to transfer file to browser: unexpected evaluation result",
      {
        code: "attachment-data-transfer-invalid-result",
        phase: "attachment-data-transfer",
        fileName,
      },
    );
  }

  const uploadResult = evalResult.result.value as {
    success?: boolean;
    error?: string;
    fileName?: string;
    size?: number;
  };
  if (!uploadResult.success) {
    throw new BrowserAutomationError(
      `Failed to transfer file to browser: ${uploadResult.error || "Unknown error"}`,
      {
        code: "attachment-data-transfer-refused",
        phase: "attachment-data-transfer",
        fileName,
      },
    );
  }
  if (uploadResult.fileName !== fileName || uploadResult.size !== fileContent.length) {
    throw new BrowserAutomationError(
      "Browser-created attachment did not match the verified local file.",
      {
        code: "attachment-data-transfer-integrity-mismatch",
        phase: "attachment-data-transfer",
        fileName,
        expectedSizeBytes: fileContent.length,
        observedSizeBytes: uploadResult.size ?? null,
      },
    );
  }

  return {
    fileName,
    size: fileContent.length,
  };
}

export function guessMimeType(fileName: string): string {
  const ext = path.extname(fileName).toLowerCase();
  const mimeTypes: Record<string, string> = {
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".csv": "text/csv",

    ".json": "application/json",
    ".js": "text/javascript",
    ".ts": "text/typescript",
    ".jsx": "text/javascript",
    ".tsx": "text/typescript",
    ".py": "text/x-python",
    ".java": "text/x-java",
    ".c": "text/x-c",
    ".cpp": "text/x-c++",
    ".h": "text/x-c",
    ".hpp": "text/x-c++",
    ".sh": "text/x-sh",
    ".bash": "text/x-sh",

    ".html": "text/html",
    ".css": "text/css",
    ".xml": "text/xml",
    ".yaml": "text/yaml",
    ".yml": "text/yaml",

    ".pdf": "application/pdf",
    ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xls": "application/vnd.ms-excel",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".ppt": "application/vnd.ms-powerpoint",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",

    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".webp": "image/webp",

    ".zip": "application/zip",
    ".tar": "application/x-tar",
    ".gz": "application/gzip",
    ".7z": "application/x-7z-compressed",
  };

  return mimeTypes[ext] || "application/octet-stream";
}

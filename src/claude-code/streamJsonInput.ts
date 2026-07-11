import path from "node:path";
import type { AttachmentFileContent } from "../oracle/files.js";
import { formatFileSection } from "../oracle/markdown.js";

/**
 * Stream-json content-block attachment transport for the fable-local lane
 * (bead oracle-router-8fa; spike attachment-stream-json-spike.md, EXP1-3).
 *
 * Default OFF. When this flag is set, oracle drives `claude -p` with
 * `--input-format stream-json` and writes ONE NDJSON user message on stdin
 * whose `content` is a real Anthropic content-block array — a text block for
 * the base prompt, a text block per text file (optionally line-numbered), and
 * a base64 `image`/`document` block per image/PDF attachment. With the flag
 * unset the lane keeps its historical flat-text stdin path byte-for-byte.
 *
 * The flag is intentionally an environment variable read entirely inside
 * `src/claude-code/` so the feature needs no config-schema plumbing to ship.
 */
export const ORACLE_CLAUDE_CODE_STREAM_JSON_INPUT_ENV_VAR = "ORACLE_CLAUDE_CODE_STREAM_JSON_INPUT";

/**
 * Resolves whether the stream-json content-block transport is enabled. Only
 * the explicit truthy tokens below flip it on; anything else (unset, empty,
 * "0", "false", arbitrary text) leaves the lane on its default text path.
 */
export function isStreamJsonInputEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[ORACLE_CLAUDE_CODE_STREAM_JSON_INPUT_ENV_VAR]?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

export interface StreamJsonTextBlock {
  type: "text";
  text: string;
}

export interface StreamJsonMediaSource {
  type: "base64";
  media_type: string;
  data: string;
}

export interface StreamJsonImageBlock {
  type: "image";
  source: StreamJsonMediaSource;
}

export interface StreamJsonDocumentBlock {
  type: "document";
  source: StreamJsonMediaSource;
}

export type StreamJsonContentBlock =
  | StreamJsonTextBlock
  | StreamJsonImageBlock
  | StreamJsonDocumentBlock;

export interface StreamJsonUserMessage {
  type: "user";
  message: {
    role: "user";
    content: StreamJsonContentBlock[];
  };
}

export interface BuildStreamJsonUserMessageOptions {
  /**
   * Preserve the lane's historical per-file line-numbering inside text
   * blocks. Defaults to `true` to match the legacy text path
   * (`formatFileSections(..., { lineNumbers: true })`).
   */
  lineNumbers?: boolean;
}

/**
 * Assembles the `{type:"user",message:{role:"user",content:[...]}}` envelope
 * for the stream-json lane. The base prompt becomes a leading text block;
 * each attachment becomes either a text block (text files, optionally
 * line-numbered) or a base64 `image`/`document` block (images / PDFs, already
 * base64-encoded upstream by `readFiles` in encode-media mode). The envelope
 * is a plain object graph — callers serialize it with `JSON.stringify`
 * (see `serializeStreamJsonMessage`); nothing here hand-concatenates JSON.
 */
export function buildStreamJsonUserMessage(
  basePrompt: string,
  files: AttachmentFileContent[],
  cwd: string = process.cwd(),
  options: BuildStreamJsonUserMessageOptions = {},
): StreamJsonUserMessage {
  const lineNumbers = options.lineNumbers ?? true;
  const content: StreamJsonContentBlock[] = [];

  if (basePrompt) {
    content.push({ type: "text", text: basePrompt });
  }

  for (const file of files) {
    if (file.attachment === "image" || file.attachment === "document") {
      const mediaType = file.mediaType;
      if (!mediaType) {
        throw new Error(
          `Internal invariant: media attachment ${JSON.stringify(file.path)} is missing its mediaType.`,
        );
      }
      const source: StreamJsonMediaSource = {
        type: "base64",
        media_type: mediaType,
        data: file.content,
      };
      content.push(
        file.attachment === "image" ? { type: "image", source } : { type: "document", source },
      );
      continue;
    }
    const displayPath = toPosix(path.relative(cwd, file.path) || file.path);
    content.push({
      type: "text",
      text: formatFileSection(displayPath, file.content, { lineNumbers }),
    });
  }

  // A message must carry at least one content block. The only way to reach an
  // empty array is an empty base prompt with no attachments; emit the (empty)
  // prompt as a single text block so the envelope stays structurally valid.
  if (content.length === 0) {
    content.push({ type: "text", text: basePrompt });
  }

  return { type: "user", message: { role: "user", content } };
}

/**
 * Serializes a user message to the exact bytes written to `claude`'s stdin:
 * a single `JSON.stringify` line terminated by one `\n`. `-p` reads NDJSON
 * until EOF, so one line plus stdin close delivers exactly one user turn.
 */
export function serializeStreamJsonMessage(message: StreamJsonUserMessage): string {
  return `${JSON.stringify(message)}\n`;
}

function toPosix(value: string): string {
  return value.replace(/\\/g, "/");
}

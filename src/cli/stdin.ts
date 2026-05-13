export async function readStdinBytes(
  stream: NodeJS.ReadableStream = process.stdin,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(toBufferChunk(chunk));
  }
  return Buffer.concat(chunks);
}

function toBufferChunk(chunk: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) {
    return chunk;
  }
  if (chunk instanceof Uint8Array) {
    return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  }
  return Buffer.from(String(chunk), "utf8");
}

export async function readStdin(stream: NodeJS.ReadableStream = process.stdin): Promise<string> {
  return (await readStdinBytes(stream)).toString("utf8");
}

export async function resolveDashPrompt(
  prompt: string | undefined,
  stream: NodeJS.ReadableStream = process.stdin,
): Promise<string | undefined> {
  if (prompt !== "-") {
    return prompt;
  }
  if ((stream as NodeJS.ReadStream).isTTY) {
    throw new Error(`"-p -" requires piped input, for example: echo "prompt" | oracle -p -.`);
  }
  const stdinBytes = await readStdinBytes(stream);
  if (stdinBytes.length === 0) {
    throw new Error(`"-p -" received empty stdin.`);
  }
  return stdinBytes.toString("utf8");
}

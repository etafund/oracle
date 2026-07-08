/**
 * runRemoteBrowserMode() never read options.signal, so a caller abort during
 * a remote-chrome run could not terminate the run (oracle-router-6rx). The
 * local (attach/launch) path builds an abort race via
 * `signal.addEventListener("abort", ...)` and races it against every
 * long-running CDP wait via `raceWithDisconnect`; the remote path had no
 * equivalent.
 *
 * This is currently latent in production (serve's SAFE_BROWSER_CONFIG_KEYS
 * strips `remoteChrome` before options reach the browser layer), so it can't
 * be exercised end-to-end without a live remote Chrome/CDP endpoint. Per the
 * established convention for such functions in this file (see
 * closeBeforeReleaseOrdering.test.ts), this is checked structurally against
 * the source: the anchors below prove the abort wiring exists, is built from
 * `options.signal`, is actually raced against the primary assistant-response
 * wait (the call site that matters most — a caller can be stuck there for
 * the full run timeout), and is cleaned up in the function's `finally` block
 * so a completed/aborted run doesn't leak the signal listener.
 */
import { describe, expect, test } from "vitest";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const SRC_ROOT = fileURLToPath(new URL("../../src", import.meta.url));

async function readSource(relative: string): Promise<string> {
  return readFile(path.join(SRC_ROOT, relative), "utf8");
}

function normalize(source: string): string {
  return source.replace(/\s+/gu, "");
}

async function remoteBrowserModeSlice(): Promise<string> {
  const source = await readSource("browser/index.ts");
  const start = source.indexOf("async function runRemoteBrowserMode");
  expect(start, "missing runRemoteBrowserMode").toBeGreaterThanOrEqual(0);
  const end = source.indexOf("export { estimateTokenCount }", start);
  expect(end, "missing trailing export anchor used to bound the slice").toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("runRemoteBrowserMode abort wiring (oracle-router-6rx)", () => {
  test("builds an abort race directly from options.signal", async () => {
    const remote = await remoteBrowserModeSlice();
    expect(remote).toContain("const signal = options.signal;");
    expect(remote).toContain('signal.addEventListener("abort", rejectAborted, { once: true });');
  });

  test("races the abort promise (not just the disconnect flag) via raceWithAbort", async () => {
    const remote = await remoteBrowserModeSlice();
    const normalized = normalize(remote);
    expect(normalized).toContain(
      "constraceWithAbort=<T>(promise:Promise<T>):Promise<T>=>Promise.race([promise,abortPromise]);",
    );
  });

  test("wires the abort race into the primary assistant-response wait", async () => {
    const remote = await remoteBrowserModeSlice();
    const normalized = normalize(remote);
    // The main per-turn wait (captureAssistantTurn's turnAnswer wait) is the
    // longest-running CDP call in the function (bounded by config.timeoutMs,
    // which can be minutes) and the one a stuck caller most needs to abort.
    const waitAnchor =
      "turnAnswer=awaitwaitWithThinkingMonitor(()=>raceWithAbort(waitForAssistantOrGeneratedImageResponse({";
    expect(normalized).toContain(waitAnchor);
  });

  test("removes the abort listener in the finally block (no leaked listener)", async () => {
    const remote = await remoteBrowserModeSlice();
    const normalized = normalize(remote);
    expect(normalized).toContain(
      "}finally{awaitconversationUrlMonitor?.stop();removeAbortListener?.();removeAbortListener=null;",
    );
  });

  test("guard: does not reintroduce remoteChrome into SAFE_BROWSER_CONFIG_KEYS (stays latent)", async () => {
    const sanitize = normalize(await readSource("remote/payload_sanitize.ts"));
    // The fix must not make the remote-chrome path reachable via serve; it
    // only has to stop being a booby trap if it's re-enabled independently.
    expect(sanitize).not.toContain('"remoteChrome"');
  });
});

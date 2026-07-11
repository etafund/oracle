import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  readFollowUpLogTail,
  startBrowserFollowUpSession,
  waitForFollowUpSession,
} from "../../cli/browserFollowUp.js";
import { strictToolSchema } from "../types.js";

const DEFAULT_MCP_FOLLOW_UP_WAIT_MS = 105_000;
const DEFAULT_MCP_FOLLOW_UP_POLL_MS = 2_000;

const followUpInputShape = {
  parentSessionId: z
    .string()
    .min(1, "Parent session id is required.")
    .describe("Stored browser session id/slug whose saved ChatGPT conversation should continue."),
  prompt: z
    .string()
    .min(1, "Prompt is required.")
    .describe("Follow-up prompt to send as the next ChatGPT turn."),
  slug: z.string().optional().describe("Optional child session slug (3-5 words)."),
  wait: z
    .boolean()
    .optional()
    .describe("Wait briefly for completion before returning. The child session remains detached."),
  noRecover: z
    .boolean()
    .optional()
    .describe("Require a live matching ChatGPT tab; do not relaunch/recover Chrome."),
  // `files` is intentionally omitted: follow_up is prompt-only in v1. Attaching files is
  // done by starting a new consult, so the advertised schema no longer offers a param the
  // handler can only reject.
} satisfies z.ZodRawShape;

// Single source of truth: the advertised shape above is also the enforced schema (min
// lengths and strict unknown-key rejection included), so the contract cannot drift.
const followUpInputSchema = strictToolSchema(followUpInputShape);

const followUpOutputShape = {
  sessionId: z.string(),
  parentSessionId: z.string(),
  status: z.string(),
  logTail: z.string().optional(),
} satisfies z.ZodRawShape;

interface FollowUpToolDeps {
  startBrowserFollowUpSession?: typeof startBrowserFollowUpSession;
  waitForFollowUpSession?: typeof waitForFollowUpSession;
  readFollowUpLogTail?: typeof readFollowUpLogTail;
  cliEntrypoint?: string;
  waitMs?: number;
  pollMs?: number;
}

function resolveMcpCliEntrypoint(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../bin/oracle-cli.js");
}

function resolvePositiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function registerFollowUpTool(server: McpServer, deps: FollowUpToolDeps = {}): void {
  server.registerTool(
    "follow_up",
    {
      title: "Continue an oracle browser session",
      description:
        "Continue an existing stored ChatGPT browser conversation with one more prompt in the same thread. This is the cheap continuation path (it reuses the prior context instead of re-bundling files through a fresh consult), but it still starts a real, billed ChatGPT Pro turn that can take 5-60 minutes. It is prompt-only in v1 (no files); start a new consult to attach files. follow_up has no dryRun, so use consult with dryRun:true to preview configuration before spending.",
      inputSchema: followUpInputSchema,
      outputSchema: followUpOutputShape,
    },
    async (input: unknown) => {
      const parsed = followUpInputSchema.parse(input);
      const start = deps.startBrowserFollowUpSession ?? startBrowserFollowUpSession;
      const waitForSession = deps.waitForFollowUpSession ?? waitForFollowUpSession;
      const readLogTail = deps.readFollowUpLogTail ?? readFollowUpLogTail;
      const result = await start(parsed.parentSessionId, {
        prompt: parsed.prompt,
        slug: parsed.slug,
        wait: parsed.wait,
        // GOAL spec parity with the CLI `--no-recover` flag (upstream MCP omits it).
        recover: parsed.noRecover === true ? false : undefined,
        cliEntrypoint: deps.cliEntrypoint ?? resolveMcpCliEntrypoint(),
      });
      const waitMs =
        deps.waitMs ??
        resolvePositiveIntegerEnv("ORACLE_MCP_BROWSER_WAIT_MS", DEFAULT_MCP_FOLLOW_UP_WAIT_MS);
      const pollMs =
        deps.pollMs ??
        resolvePositiveIntegerEnv("ORACLE_MCP_BROWSER_POLL_MS", DEFAULT_MCP_FOLLOW_UP_POLL_MS);
      const metadata = parsed.wait
        ? await waitForSession(result.session.id, { timeoutMs: waitMs, pollMs })
        : result.session;
      const status = metadata?.status ?? result.session.status;
      const logTail = await readLogTail(result.session.id, 4000);
      const output = `Follow-up session ${result.session.id} (${status}) from ${result.parentSessionId}. Poll it in-band with the sessions MCP tool (id:"${result.session.id}", detail:true).`;
      return {
        content: [{ type: "text" as const, text: output }],
        structuredContent: {
          sessionId: result.session.id,
          parentSessionId: result.parentSessionId,
          status,
          logTail,
        },
      };
    },
  );
}

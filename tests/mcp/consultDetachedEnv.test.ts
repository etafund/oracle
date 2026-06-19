import { afterEach, describe, expect, test, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setOracleHomeDirOverrideForTest } from "../../src/oracleHome.js";
import { registerConsultTool } from "../../src/mcp/tools/consult.ts";
import { performSessionRun } from "../../src/cli/sessionRunner.js";

vi.mock("../../src/cli/sessionRunner.js", () => ({
  performSessionRun: vi.fn(async ({ log }: { log: (line?: string) => void }) => {
    log("[test] inline browser run");
  }),
}));

afterEach(() => {
  setOracleHomeDirOverrideForTest(null);
  vi.unstubAllEnvs();
  vi.mocked(performSessionRun).mockClear();
});

describe("MCP browser detached env opt-in", () => {
  test("honors ORACLE_MCP_BROWSER_DETACHED for browser consults", async () => {
    const tmpHome = await mkdtemp(path.join(tmpdir(), "oracle-mcp-env-detached-"));
    setOracleHomeDirOverrideForTest(tmpHome);
    vi.stubEnv("CHROME_PATH", "/bin/true");
    vi.stubEnv("ORACLE_MCP_BROWSER_DETACHED", "1");

    const handlers: Array<(input: unknown) => Promise<unknown>> = [];
    const launchDetachedSessionRunner = vi.fn(async () => true);
    const launchDetachedSessionFinalizer = vi.fn(async () => true);
    registerConsultTool(
      {
        registerTool: (_name: string, _def: unknown, fn: (input: unknown) => Promise<unknown>) => {
          handlers.push(fn);
        },
        server: {
          sendLoggingMessage: async () => undefined,
        },
      } as unknown as Parameters<typeof registerConsultTool>[0],
      {
        launchDetachedSessionRunner,
        launchDetachedSessionFinalizer,
        cliEntrypoint: "/tmp/oracle-cli.js",
        browserWaitMs: 1,
        browserPollMs: 1,
      },
    );
    const handler = handlers[0];
    if (!handler) throw new Error("handler not registered");

    try {
      const result = (await handler({
        engine: "browser",
        model: "gpt-5.5-pro",
        prompt: "review this",
        files: [],
        slug: "mcp-env-detached-test",
      })) as {
        content: Array<{ type: "text"; text: string }>;
        structuredContent: { sessionId: string; status: string };
      };

      expect(performSessionRun).not.toHaveBeenCalled();
      expect(launchDetachedSessionRunner).toHaveBeenCalledWith("mcp-env-detached-test", {
        cliEntrypoint: "/tmp/oracle-cli.js",
      });
      expect(launchDetachedSessionFinalizer).toHaveBeenCalledWith("mcp-env-detached-test", {
        cliEntrypoint: "/tmp/oracle-cli.js",
      });
      expect(result.structuredContent).toMatchObject({
        sessionId: "mcp-env-detached-test",
        status: "pending",
      });
      expect(result.content[0]?.text).toContain("Detached browser worker is still running");
    } finally {
      await rm(tmpHome, { recursive: true, force: true });
    }
  });
});

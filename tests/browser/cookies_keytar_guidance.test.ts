import { beforeEach, describe, expect, test, vi } from "vitest";
import { syncCookies } from "../../src/browser/cookies.js";
import { BrowserAutomationError } from "../../src/oracle/errors.js";
import type { ChromeClient } from "../../src/browser/types.js";

const getCookies = vi.hoisted(() => vi.fn());
vi.mock("@steipete/sweet-cookie", () => ({ getCookies }));

const logger = vi.fn();

function buildKeytarError(): Error & { code?: string; requireStack?: string[] } {
  const error = new Error(
    "Cannot find module '../build/Release/keytar.node'\n" +
      "Require stack:\n" +
      "- /home/user/.pnpm-store/v3/tmp/dlx-1/node_modules/keytar/lib/keytar.js",
  ) as Error & { code?: string; requireStack?: string[] };
  error.code = "MODULE_NOT_FOUND";
  error.requireStack = ["/home/user/.pnpm-store/v3/tmp/dlx-1/node_modules/keytar/lib/keytar.js"];
  return error;
}

beforeEach(() => {
  getCookies.mockReset();
  logger.mockReset();
});

describe("syncCookies keytar guidance", () => {
  test("surfaces node-gyp rebuild guidance when keytar fails to load", async () => {
    getCookies.mockRejectedValue(buildKeytarError());

    let caught: unknown;
    try {
      await syncCookies(
        { setCookie: vi.fn() } as unknown as ChromeClient["Network"],
        "https://chatgpt.com",
        null,
        logger,
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(BrowserAutomationError);
    const err = caught as BrowserAutomationError;
    expect(err.message).toContain("node-gyp rebuild");
    expect(err.message).toContain("PYTHON=/usr/bin/python3");
    expect(err.message).toContain("keytar native module missing");
    expect(err.details?.stage).toBe("keytar-missing");
    expect(String(err.details?.fix_command ?? "")).toContain("node-gyp rebuild");
    expect(String(err.details?.dependency_path ?? "")).toContain("/keytar");
  });

  test("still surfaces rebuild guidance for bare 'Failed to load keytar' messages", async () => {
    getCookies.mockRejectedValue(
      new Error(
        "Failed to load keytar: Cannot find module " +
          "'/home/user/.cache/node/corepack/v1/keytar/build/Release/keytar.node'",
      ),
    );

    await expect(
      syncCookies(
        { setCookie: vi.fn() } as unknown as ChromeClient["Network"],
        "https://chatgpt.com",
        null,
        logger,
      ),
    ).rejects.toMatchObject({
      name: "BrowserAutomationError",
      message: expect.stringContaining("node-gyp rebuild"),
      details: expect.objectContaining({ stage: "keytar-missing" }),
    });
  });

  test("logs guidance but does not throw when allowErrors is set", async () => {
    getCookies.mockRejectedValue(buildKeytarError());

    const applied = await syncCookies(
      { setCookie: vi.fn() } as unknown as ChromeClient["Network"],
      "https://chatgpt.com",
      null,
      logger,
      { allowErrors: true },
    );

    expect(applied).toBe(0);
    const logged = logger.mock.calls.map((args) => String(args[0])).join("\n");
    expect(logged).toContain("node-gyp rebuild");
    expect(logged).toContain("Cookie sync failed (continuing with override)");
  });
});

/**
 * serve/manual-login owned-target close policy (§14.2.0, close-owned-target
 * override): the shared browser stays alive, but each run's OWNED target is
 * closed after the run — on success AND failure — so per-run tabs cannot
 * structurally accumulate in the shared Chrome.
 *
 * Covers the policy table (derivation + exceptions) and the bounded close
 * deadline (a wedged close must not pin the single-flight worker busy
 * forever; it latches a cleanup-taint flag for /ready instead).
 * The close-BEFORE-release ordering itself is covered by
 * tests/browser/closeBeforeReleaseOrdering.test.ts.
 */
import { afterEach, describe, expect, test } from "vitest";
import type { BrowserLogger } from "../../src/browser/types.js";
import {
  __test__,
  clearBrowserCleanupTaint,
  getBrowserCleanupTaint,
} from "../../src/browser/index.js";

const {
  closeOwnedTargetWithDeadline,
  closeRemoteConnectionAfterRun,
  resolveCloseOwnedRunTargetPolicy,
  shouldCloseOwnedRunTargetAfterRun,
} = __test__;

function makeLogger(): { logger: BrowserLogger; messages: string[] } {
  const messages: string[] = [];
  const logger = ((message: string) => {
    messages.push(message);
  }) as BrowserLogger;
  return { logger, messages };
}

afterEach(() => {
  clearBrowserCleanupTaint();
});

describe("resolveCloseOwnedRunTargetPolicy", () => {
  test("derives 'always' for the serve/manual-login topology (manualLogin + keepBrowser)", () => {
    expect(resolveCloseOwnedRunTargetPolicy({ manualLogin: true, keepBrowser: true })).toBe(
      "always",
    );
  });

  test("defaults to 'auto' outside the serve topology", () => {
    expect(resolveCloseOwnedRunTargetPolicy({ manualLogin: false, keepBrowser: false })).toBe(
      "auto",
    );
    expect(resolveCloseOwnedRunTargetPolicy({ manualLogin: true, keepBrowser: false })).toBe(
      "auto",
    );
    expect(resolveCloseOwnedRunTargetPolicy({ manualLogin: false, keepBrowser: true })).toBe(
      "auto",
    );
  });

  test("an explicit policy always wins over the derived default", () => {
    expect(
      resolveCloseOwnedRunTargetPolicy({
        closeOwnedRunTargetAfterRun: "auto",
        manualLogin: true,
        keepBrowser: true,
      }),
    ).toBe("auto");
    expect(
      resolveCloseOwnedRunTargetPolicy({
        closeOwnedRunTargetAfterRun: "always",
        manualLogin: false,
        keepBrowser: false,
      }),
    ).toBe("always");
  });
});

describe("shouldCloseOwnedRunTargetAfterRun with the 'always' policy", () => {
  test("failure-path close still runs: 'always' closes the owned target on attempted runs", () => {
    expect(
      shouldCloseOwnedRunTargetAfterRun({
        runStatus: "attempted",
        ownsTarget: true,
        keepBrowser: true,
        policy: "always",
      }),
    ).toBe(true);
  });

  test("'always' keeps the browser but closes the owned tab on complete runs too", () => {
    expect(
      shouldCloseOwnedRunTargetAfterRun({
        runStatus: "complete",
        ownsTarget: true,
        keepBrowser: true,
        policy: "always",
      }),
    ).toBe(true);
  });

  test("borrowed tabs are never closed, even under 'always'", () => {
    expect(
      shouldCloseOwnedRunTargetAfterRun({
        runStatus: "complete",
        ownsTarget: false,
        keepBrowser: true,
        policy: "always",
      }),
    ).toBe(false);
    expect(
      shouldCloseOwnedRunTargetAfterRun({
        runStatus: "attempted",
        ownsTarget: false,
        keepBrowser: false,
        policy: "always",
      }),
    ).toBe(false);
  });

  test("the default 'auto' policy keeps its pre-override semantics", () => {
    expect(
      shouldCloseOwnedRunTargetAfterRun({
        runStatus: "complete",
        ownsTarget: true,
        keepBrowser: false,
      }),
    ).toBe(true);
    expect(
      shouldCloseOwnedRunTargetAfterRun({
        runStatus: "complete",
        ownsTarget: true,
        keepBrowser: true,
      }),
    ).toBe(false);
    expect(
      shouldCloseOwnedRunTargetAfterRun({
        runStatus: "attempted",
        ownsTarget: true,
        keepBrowser: false,
      }),
    ).toBe(false);
  });
});

describe("closeOwnedTargetWithDeadline (bounded close; §14.13 cleanup-taint)", () => {
  test("a close that settles within the deadline reports success and latches no taint", async () => {
    const { logger, messages } = makeLogger();
    const closed = await closeOwnedTargetWithDeadline(Promise.resolve(), logger, {
      targetId: "target-ok",
      timeoutMs: 1_000,
    });
    expect(closed).toBe(true);
    expect(getBrowserCleanupTaint()).toBeNull();
    expect(messages.some((message) => message.includes("CLEANUP-TAINT"))).toBe(false);
  });

  test("a rejected close settles (no worker pinning) but latches cleanup-taint, not settled-clean (oracle-router-lv2)", async () => {
    const { logger, messages } = makeLogger();
    const closed = await closeOwnedTargetWithDeadline(
      Promise.reject(new Error("close failed")),
      logger,
      { targetId: "target-err", timeoutMs: 1_000 },
    );
    expect(closed).toBe(false);
    const taint = getBrowserCleanupTaint();
    expect(taint).not.toBeNull();
    expect(taint?.reason).toContain("owned-target close failed");
    expect(taint?.reason).toContain("target-err");
    expect(taint?.reason).toContain("close failed");
    expect(messages.some((message) => message.includes("CLEANUP-TAINT"))).toBe(true);
  });

  test("a close helper that resolves false (fast failed close) latches cleanup-taint (oracle-router-lv2)", async () => {
    const { logger, messages } = makeLogger();
    const closed = await closeOwnedTargetWithDeadline(Promise.resolve(false), logger, {
      targetId: "target-fast-fail",
      timeoutMs: 1_000,
    });
    expect(closed).toBe(false);
    const taint = getBrowserCleanupTaint();
    expect(taint).not.toBeNull();
    expect(taint?.reason).toContain("owned-target close failed");
    expect(taint?.reason).toContain("target-fast-fail");
    expect(messages.some((message) => message.includes("CLEANUP-TAINT"))).toBe(true);
  });

  test("a close helper that resolves true is settled-clean (no taint)", async () => {
    const { logger, messages } = makeLogger();
    const closed = await closeOwnedTargetWithDeadline(Promise.resolve(true), logger, {
      targetId: "target-true",
      timeoutMs: 1_000,
    });
    expect(closed).toBe(true);
    expect(getBrowserCleanupTaint()).toBeNull();
    expect(messages.some((message) => message.includes("CLEANUP-TAINT"))).toBe(false);
  });

  test("a wedged close times out, logs loudly, and latches the cleanup-taint flag", async () => {
    const { logger, messages } = makeLogger();
    const wedged = new Promise<void>(() => {
      // never settles: simulates a wedged CDP close
    });
    const closed = await closeOwnedTargetWithDeadline(wedged, logger, {
      targetId: "target-wedged",
      timeoutMs: 50,
    });
    expect(closed).toBe(false);
    const taint = getBrowserCleanupTaint();
    expect(taint).not.toBeNull();
    expect(taint?.reason).toContain("timed out");
    expect(taint?.reason).toContain("target-wedged");
    expect(messages.some((message) => message.includes("CLEANUP-TAINT"))).toBe(true);
  });

  test("a rejected close from a boolean-returning helper reports the rejection detail", async () => {
    const { logger } = makeLogger();
    const failing = async (): Promise<boolean> => {
      throw new Error("target already detached");
    };
    const closed = await closeOwnedTargetWithDeadline(failing(), logger, {
      targetId: "target-bool-err",
      timeoutMs: 1_000,
    });
    expect(closed).toBe(false);
    expect(getBrowserCleanupTaint()?.reason).toContain("target already detached");
  });

  test("clearBrowserCleanupTaint resets the latch", async () => {
    const { logger } = makeLogger();
    await closeOwnedTargetWithDeadline(new Promise<void>(() => {}), logger, {
      targetId: "target-reset",
      timeoutMs: 20,
    });
    expect(getBrowserCleanupTaint()).not.toBeNull();
    clearBrowserCleanupTaint();
    expect(getBrowserCleanupTaint()).toBeNull();
  });
});

describe("closeRemoteConnectionAfterRun cleanup-taint accounting (oracle-router-lv2)", () => {
  test("a rejected connection close latches cleanup-taint instead of reporting settled-clean", async () => {
    const { logger, messages } = makeLogger();
    await closeRemoteConnectionAfterRun({
      connectionClosedUnexpectedly: false,
      connection: {
        close: async () => {
          throw new Error("dedicated target close blew up");
        },
      },
      client: { close: async () => undefined },
      runStatus: "complete",
      logger,
    });
    const taint = getBrowserCleanupTaint();
    expect(taint).not.toBeNull();
    expect(taint?.reason).toContain("remote connection close failed");
    expect(taint?.reason).toContain("dedicated target close blew up");
    expect(messages.some((message) => message.includes("CLEANUP-TAINT"))).toBe(true);
  });

  test("a rejected client detach on an attempted run also latches cleanup-taint", async () => {
    const { logger } = makeLogger();
    await closeRemoteConnectionAfterRun({
      connectionClosedUnexpectedly: false,
      connection: { close: async () => undefined },
      client: {
        close: async () => {
          throw new Error("detach failed");
        },
      },
      runStatus: "attempted",
      logger,
    });
    expect(getBrowserCleanupTaint()?.reason).toContain("detach failed");
  });

  test("a clean close latches no taint", async () => {
    const { logger } = makeLogger();
    await closeRemoteConnectionAfterRun({
      connectionClosedUnexpectedly: false,
      connection: { close: async () => undefined },
      client: { close: async () => undefined },
      runStatus: "complete",
      logger,
    });
    expect(getBrowserCleanupTaint()).toBeNull();
  });
});

import { describe, expect, test } from "vitest";
import { formatBrowserReattachGuidance } from "../../src/cli/reattachGuidance.js";

describe("formatBrowserReattachGuidance", () => {
  test("includes the real session slug and all reattach commands", () => {
    const message = formatBrowserReattachGuidance("gpt55-pro-plan-review");

    expect(message).toContain(
      "This run did not return cleanly, but it may still be alive. Reattach:",
    );
    expect(message).toContain(
      "oracle session gpt55-pro-plan-review --render    # final markdown when complete",
    );
    expect(message).toContain("oracle session gpt55-pro-plan-review --live      # tail until done");
    expect(message).toContain(
      "oracle session gpt55-pro-plan-review --harvest   # snapshot the current answer now",
    );
  });

  test("advertises only account-affine recovery for a recoverable remote run", () => {
    const message = formatBrowserReattachGuidance("remote-pro-review", {
      remoteOrigin: true,
      remoteRecoveryAvailable: true,
    });

    expect(message).toContain(
      "oracle session remote-pro-review --render    # account-affine capture-only recovery",
    );
    expect(message).toContain("originating ChatGPT account's history");
    expect(message).not.toContain("oracle session remote-pro-review --live");
    expect(message).not.toContain("oracle session remote-pro-review --harvest");
  });

  test("sends an unrecoverable remote run to account history without unsafe commands", () => {
    const message = formatBrowserReattachGuidance("remote-pro-review", {
      remoteOrigin: true,
      remoteRecoveryAvailable: false,
    });

    expect(message).toContain("automatic recovery is unavailable");
    expect(message).toContain("originating ChatGPT account's history");
    expect(message).not.toContain("oracle session remote-pro-review --render");
    expect(message).not.toContain("oracle session remote-pro-review --live");
    expect(message).not.toContain("oracle session remote-pro-review --harvest");
  });
});

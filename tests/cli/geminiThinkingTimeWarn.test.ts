import { describe, expect, it, vi } from "vitest";
import chalk from "chalk";
import { warnGeminiIgnoredThinkingTime } from "../../bin/oracle-cli.js";

const WARNING = chalk.dim(
  "Browser thinking-time is ignored for Gemini web runs (no lighter-mode control exists for Deep Think).",
);

describe("gemini thinking-time ignored warning", () => {
  it("warns when --browser-thinking-time is set on a Gemini run", () => {
    const logSpy = vi.fn();
    warnGeminiIgnoredThinkingTime("gemini-3.1-deep-think", "light", logSpy);
    expect(logSpy).toHaveBeenCalledWith(WARNING);
  });

  it("does not warn on a ChatGPT run, where thinking-time is honored", () => {
    const logSpy = vi.fn();
    warnGeminiIgnoredThinkingTime("gpt-5.5-pro", "light", logSpy);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("does not warn on Gemini when thinking-time was not set", () => {
    const logSpy = vi.fn();
    warnGeminiIgnoredThinkingTime("gemini-3.1-deep-think", undefined, logSpy);
    expect(logSpy).not.toHaveBeenCalled();
  });
});

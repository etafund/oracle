import { describe, expect, test } from "vitest";
import { execFile } from "node:child_process";
import path from "node:path";

const CLI_ENTRY = path.join(process.cwd(), "bin", "oracle-cli.ts");
const CLI_TIMEOUT_MS = 60_000;

function execCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ["--import", "tsx", CLI_ENTRY, ...args],
      { timeout: CLI_TIMEOUT_MS },
      (error, stdout, stderr) => {
        const code = typeof error?.code === "number" ? error.code : error ? 1 : 0;
        resolve({
          code,
          stdout: String(stdout),
          stderr: String(stderr),
        });
      },
    );
  });
}

describe("oracle follow-up CLI", () => {
  test("accepts positional prompt form before rejecting unsupported files", async () => {
    const result = await execCli([
      "follow-up",
      "parent-session",
      "next turn",
      "--slug",
      "child follow up",
      "--file",
      "a.ts",
    ]);

    expect(result.code).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).toContain("prompt-only in v1");
  });
});

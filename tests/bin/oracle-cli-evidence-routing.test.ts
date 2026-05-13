import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { describe, expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const CLI_ENTRYPOINT = path.join(process.cwd(), "bin", "oracle-cli.ts");

describe("bin/oracle-cli evidence routing", () => {
  test("oracle evidence --help lists artifact and ledger subcommands", async () => {
    const { stdout, stderr } = await runOracleHelp(["evidence", "--help"]);
    const output = `${stdout}\n${stderr}`;

    expect(output).toContain("Usage: oracle evidence");
    expect(output).toContain("show");
    expect(output).toContain("verify");
    expect(output).toContain("ledger");
  });

  test("oracle evidence ledger --help lists ledger runners", async () => {
    const { stdout, stderr } = await runOracleHelp(["evidence", "ledger", "--help"]);
    const output = `${stdout}\n${stderr}`;

    expect(output).toContain("Usage: oracle evidence ledger");
    expect(output).toContain("show");
    expect(output).toContain("verify");
    expect(output).toContain("export");
  });
});

async function runOracleHelp(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(process.execPath, ["--import", "tsx", CLI_ENTRYPOINT, ...args], {
    env: {
      ...process.env,
      FORCE_COLOR: "0",
      NO_COLOR: "1",
      ORACLE_DISABLE_KEYTAR: "1",
    },
    timeout: 30_000,
  });
}

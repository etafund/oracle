import type { Command } from "commander";

import { runEvidenceLedgerShow } from "./ledger.js";
import { runEvidenceLedgerVerify } from "./ledger_verify.js";
import { runEvidenceLedgerExport } from "./ledger_export.js";

export interface EvidenceLedgerCommandOptions {
  readonly oracleHomeDir?: string;
}

interface EvidenceLedgerCliOptions {
  readonly json?: boolean;
  readonly sanitized?: boolean;
  readonly quarantined?: boolean;
}

export function registerEvidenceLedgerCommands(
  evidenceCommand: Command,
  deps: EvidenceLedgerCommandOptions = {},
): Command {
  const ledgerCommand = evidenceCommand
    .command("ledger")
    .description("Inspect, verify, and export append-only evidence ledgers.");

  ledgerCommand
    .command("show <session>")
    .description("Print the append-only evidence ledger summary for a stored session.")
    .option("--json", "emit a json_envelope.v1 response", false)
    .action(async (session: string, options: EvidenceLedgerCliOptions) => {
      const result = await runEvidenceLedgerShow({
        sessionId: session,
        homeDir: deps.oracleHomeDir,
        json: options.json === true,
      });
      if (!result.envelope.ok) {
        process.exitCode = 1;
      }
    });

  ledgerCommand
    .command("verify <session>")
    .description("Verify ledger chain integrity and referenced evidence files.")
    .option("--json", "emit a json_envelope.v1 response", false)
    .action(async (session: string, options: EvidenceLedgerCliOptions) => {
      const result = await runEvidenceLedgerVerify({
        sessionId: session,
        homeDir: deps.oracleHomeDir,
        json: options.json === true,
      });
      if (!result.envelope.ok) {
        process.exitCode = 1;
      }
    });

  ledgerCommand
    .command("export <session>")
    .description("Export a sanitized evidence ledger snapshot for APR handoff.")
    .option("--sanitized", "omit quarantined unsafe debug metadata (default)", false)
    .option("--quarantined", "include quarantined unsafe debug metadata after sanitization", false)
    .option("--json", "emit a json_envelope.v1 response", false)
    .action(async (session: string, options: EvidenceLedgerCliOptions) => {
      const result = await runEvidenceLedgerExport(
        {
          sessionId: session,
          homeDir: deps.oracleHomeDir,
          json: options.json === true,
          sanitized: options.sanitized === true || options.quarantined !== true,
          quarantined: options.quarantined === true,
        },
        {
          log: (message) => console.log(message),
          error: (message) => console.error(message),
        },
      );
      if (!result.envelope.ok) {
        process.exitCode = 1;
      }
    });

  return ledgerCommand;
}

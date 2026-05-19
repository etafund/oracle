# Oracle v18 Implementation Map (oracle-x08)

This document maps existing Oracle TypeScript modules to v18 responsibilities, identifying file ownership boundaries, existing capabilities, and recommended implementation order.

## Implementation-Slicing Table & File Ownership

| v18 Surface                         | Target Files/Modules                                                                                                 | Agent Mail Reservation Glob                             | Existing Capabilities / Notes                                                                                                                         |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Contracts/Envelopes & Errors**    | `src/oracle/types.ts`, `src/oracle/errors.ts`, `src/cli/format.ts` (or new `jsonEnvelope.ts`)                        | `src/oracle/{types,errors}.ts`, `src/cli/*envelope*.ts` | Existing error taxonomy present. Will need extension for json_envelope.v1 shapes and v18 errors.                                                      |
| **Browser Leases**                  | `src/browser/tabLeaseRegistry.ts`, `src/cli/options.ts`                                                              | `src/browser/tabLease*.ts`, `src/cli/options.ts`        | `tabLeaseRegistry.ts` already handles concurrency limits and stale lock pruning; just needs exposing via CLI/JSON and TTL formalization.              |
| **Evidence**                        | `src/browser/artifacts.ts`, new `src/browser/evidence.ts`                                                            | `src/browser/artifacts.ts`, `src/browser/evidence.ts`   | Existing artifacts.ts saves transcripts and generated images. Needs to expand into structured JSON evidence with hashes.                              |
| **Remote Browser**                  | `src/remote/*.ts` (client.ts, server.ts, health.ts)                                                                  | `src/remote/*.ts`                                       | Currently exists. Needs token redaction enforcement, precedence hardening, and JSON remote doctor/status/attach surfacing.                            |
| **ChatGPT Selectors/State**         | `src/browser/chromeLifecycle.ts`, `src/browser/prompt.ts`, `src/browser/sessionRunner.ts`, `src/browser/liveTabs.ts` | `src/browser/*.ts` (excluding evidence/leases)          | Rich lifecycle exists. Needs formal state transitions (prompt submission illegal before mode verification) and explicit extended reasoning selection. |
| **Gemini Selectors/State**          | `src/gemini-web/executor.ts`, `src/gemini-web/client.ts`                                                             | `src/gemini-web/*.ts`                                   | Needs state machine hardening for Deep Think controls, preventing empty placeholder chunk parsing, and no Gemini API substitution.                    |
| **Provider-Result Normalization**   | `src/oracle/run.ts`, `src/browser/sessionRunner.ts`                                                                  | `src/oracle/run.ts`, `src/browser/sessionRunner.ts`     | Must link evidence to provider results and guarantee hash inclusion (prompt_sha256, output_text_sha256).                                              |
| **CLI Registration (Doctors, etc)** | `bin/oracle-cli.ts`, `src/cli/**/*.ts`                                                                               | `bin/oracle-cli.ts`, `src/cli/**/*.ts`                  | Commands exist but need pure `--json` outputs, dry-run guarantees, and safe recovery routes via envelope fields.                                      |
| **MCP**                             | `src/mcp/server.ts`, `src/mcp/tools/*.ts`                                                                            | `src/mcp/**/*.ts`                                       | Update tool metadata/schemas to expose v18 metadata (evidence requirements, leases, JSON error shapes) without leaking secrets.                       |
| **Tests & Docs**                    | `tests/**/*.test.ts`, `docs/manual-tests.md`, `README.md`                                                            | `tests/**/*.ts`, `docs/*.md`, `README.md`               | Keep tests CI-safe. Add mock E2E rehearsals. Opt-in live testing already defined via `ORACLE_LIVE_TEST`.                                              |

## Recommended Implementation Order

1. **Contracts & Envelopes**: Define the fundamental shapes (JSON envelopes, errors) so other components have shared types.
2. **Browser Leases**: Formalize the existing `tabLeaseRegistry.ts` to match v18 lease primitives.
3. **Remote Browser**: Harden the remote client/server for config precedence and token redaction.
4. **Evidence & Provider Results**: Build the hashing and storage format for evidence and result normalization.
5. **State Machines (ChatGPT & Gemini)**: Harden the browser providers to respect mode verification before prompting and capture evidence.
6. **CLI Registration**: Expose the doctors, capabilities, and dry-run preflights cleanly.
7. **MCP & Docs**: Map the CLI behaviors into MCP surfaces and finalize the docs/changelog.

## Notes on Existing Code

- The browser stack should NOT be replaced; `src/browser/tabLeaseRegistry.ts` already provides a foundation for the required locking mechanism.
- Current tests use `ORACLE_LIVE_TEST=1` for real API paths. Mocks/fixtures should be prioritized for new verification coverage.

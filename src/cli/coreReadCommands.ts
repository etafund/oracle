// The CORE read-only commands an agent needs alongside the 3 reviewed
// lanes — a narrower, hand-picked subset of the broader
// `src/cli/robotRegistry.ts` (`ROBOT_COMMANDS`) registry, which also
// carries deeper diagnostic/control surfaces (browser lease acquire/release,
// evidence verification, remote attach) that this compact self-doc pass
// intentionally does not promote. Both `oracle capabilities --json` (`src/oracle/capabilities/
// registry.ts`) and `oracle robot-docs` (`src/cli/robotRegistry.ts`)
// import this single list so "the core read commands" can't drift
// between the two agent self-doc surfaces.
//
// Deliberately excludes any command that submits a prompt or spends
// money — these are all `dry_run`/no-provider-call by construction, the
// same invariant `tests/cli/robotDocs.test.ts` already pins for
// `ROBOT_COMMANDS`.
export interface CoreReadCommand {
  readonly name: string;
  readonly command: string;
  readonly purpose: string;
}

function coreReadCommand(input: CoreReadCommand): CoreReadCommand {
  return Object.freeze({ ...input });
}

export const CORE_READ_COMMANDS: readonly CoreReadCommand[] = Object.freeze([
  coreReadCommand({
    name: "capabilities",
    command: "oracle capabilities --json",
    purpose: "First preflight: static capability matrix, zero live calls.",
  }),
  coreReadCommand({
    name: "robot-docs",
    command: "oracle robot-docs --json",
    purpose: "The full agent self-doc registry as a robot_surface.v1 envelope.",
  }),
  coreReadCommand({
    name: "doctor",
    command: "oracle doctor --json",
    purpose: "Aggregate preflight (env, leases, evidence index, remote endpoint).",
  }),
  coreReadCommand({
    name: "doctor-lanes",
    command: "oracle doctor lanes --json",
    purpose: "Static reviewed-lane policy for all 3 core lanes, no live calls.",
  }),
  coreReadCommand({
    name: "doctor-chatgpt",
    command: "oracle doctor chatgpt --pro --extended-reasoning --json",
    purpose: "ChatGPT Pro Extended Reasoning lane readiness (selectors, sign-in).",
  }),
  coreReadCommand({
    name: "doctor-gemini",
    command: "oracle doctor gemini --deep-think --json",
    purpose: "Gemini 3.1 Deep Think lane readiness (exposure, strategy).",
  }),
  coreReadCommand({
    name: "session",
    command: "oracle session <sessionId>",
    purpose: "Attach to a running/completed session and stream its saved transcript.",
  }),
  coreReadCommand({
    name: "session-artifacts",
    command: "oracle session <sessionId> --artifacts --json",
    purpose: "List a session's transcripts, reports, downloads, diagnostics, and raw artifacts.",
  }),
  coreReadCommand({
    name: "remote-slots",
    command: "oracle remote slots --json",
    purpose: "Read-only remote slot state from /ready + /health; never posts /runs.",
  }),
  coreReadCommand({
    name: "status",
    command: "oracle status --json",
    purpose: "List recent sessions across all 3 lanes without starting a new run.",
  }),
]);

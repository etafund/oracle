import fs from "node:fs/promises";
import path from "node:path";

import {
  assertNoSymlinkOrWorldWritableComponents,
  type LocalOwnerFsModule,
} from "./localOwnerGuard.js";

export interface ResolveClaudeExecutableOptions {
  executable?: string;
  repoRoot?: string;
  env?: NodeJS.ProcessEnv;
  uid?: number;
  fsModule?: LocalOwnerFsModule & { access(path: string, mode?: number): Promise<void> };
}

export interface ResolvedClaudeExecutable {
  requested: string;
  path: string;
  ownerUid?: number;
  mode: number;
}

/**
 * Shared shape used by every hardened-executable resolver (`claude`, `caam`,
 * ...). Kept generic so a second caller (`caamResolver.ts`) can reuse the
 * exact same symlink/world-writable/ownership/inside-repo hardening as
 * `resolveClaudeExecutable` below without duplicating it.
 */
export interface ResolveHardenedExecutableOptions {
  /** Explicit override, takes precedence over `env[envVarName]` and `defaultCommand`. */
  executable?: string;
  /** Env var consulted (in the caller's own `env`) when `executable` is not set. */
  envVarName: string;
  /** Bare command searched for on `$PATH` when neither of the above is set. */
  defaultCommand: string;
  repoRoot?: string;
  env?: NodeJS.ProcessEnv;
  uid?: number;
  fsModule?: LocalOwnerFsModule & { access(path: string, mode?: number): Promise<void> };
  /** Constructs the caller's own error type so reason codes stay caller-specific. */
  makeError: (reason: string, message?: string) => Error;
  /** Message used for the final `not_found` error once every PATH candidate misses. */
  notFoundMessage: string;
  /**
   * Label passed through to `assertNoSymlinkOrWorldWritableComponents`
   * (default `"claude_executable"`, preserved for exact backward
   * compatibility with existing `resolveClaudeExecutable` reason strings).
   * Callers resolving a different binary (e.g. `caam`) should pass their
   * own label so a symlink/world-writable failure reads as e.g.
   * `caam_executable_unsafe_symlink` instead of a misleading
   * `claude_executable_*` reason.
   */
  label?: string;
}

export class ClaudeCodeExecutableError extends Error {
  readonly reason: string;

  constructor(reason: string, message?: string) {
    super(
      message ??
        `Claude Code local mode refused because the resolved \`claude\` executable is unsafe: ${reason}.`,
    );
    this.name = "ClaudeCodeExecutableError";
    this.reason = reason;
  }
}

const X_OK = 1;

/**
 * Explicit override for the resolved `claude` executable path. Takes
 * precedence over the default `"claude"` PATH lookup but is still routed
 * through the same `verifyExecutable` hardening (symlink-chain, world
 * -writable, ownership, inside-repo checks) — this is an override of
 * *which* path is resolved, never an escape hatch from the safety checks
 * themselves.
 */
export const ORACLE_CLAUDE_CODE_EXECUTABLE_ENV_VAR = "ORACLE_CLAUDE_CODE_EXECUTABLE";

export async function resolveClaudeExecutable(
  options: ResolveClaudeExecutableOptions = {},
): Promise<ResolvedClaudeExecutable> {
  return resolveHardenedExecutable({
    executable: options.executable,
    envVarName: ORACLE_CLAUDE_CODE_EXECUTABLE_ENV_VAR,
    defaultCommand: "claude",
    repoRoot: options.repoRoot,
    env: options.env,
    uid: options.uid,
    fsModule: options.fsModule,
    makeError: (reason, message) => new ClaudeCodeExecutableError(reason, message),
    notFoundMessage: "Claude Code local mode requires the `claude` command on PATH.",
  });
}

/**
 * Generic hardened-executable resolver shared by `resolveClaudeExecutable`
 * above and `resolveCaamExecutable` (`caamResolver.ts`). Identical
 * precedence (`executable` option > env var > bare-command PATH search) and
 * identical hardening (symlink-chain, world-writable, ownership,
 * inside-reviewed-repo) for every caller — only the error type, env var
 * name, and default bare command differ per caller.
 */
export async function resolveHardenedExecutable(
  options: ResolveHardenedExecutableOptions,
): Promise<ResolvedClaudeExecutable> {
  const fsLike = options.fsModule ?? fs;
  const env = options.env ?? process.env;
  const requested =
    options.executable?.trim() ||
    env[options.envVarName]?.trim() ||
    options.defaultCommand;
  if (!requested) {
    throw options.makeError(
      "empty_executable",
      `No "${options.defaultCommand}" executable was resolved (the requested path was empty). Set ${options.envVarName}=/path/to/${options.defaultCommand}, or install \`${options.defaultCommand}\` so it is on PATH.`,
    );
  }

  const candidates = path.isAbsolute(requested)
    ? [requested]
    : isBareCommand(requested)
      ? pathCandidates(requested, env)
      : failRelativePath();

  for (const candidate of candidates) {
    try {
      return await verifyExecutable(candidate, {
        requested,
        repoRoot: options.repoRoot,
        uid: options.uid ?? process.getuid?.(),
        fsModule: fsLike,
        makeError: options.makeError,
        label: options.label ?? "claude_executable",
      });
    } catch (error) {
      if (!isNotFoundError(error)) {
        throw error;
      }
    }
  }

  throw options.makeError("not_found", options.notFoundMessage);

  function failRelativePath(): never {
    throw options.makeError(
      "relative_path",
      `"${requested}" is a relative path, which is refused. Pass an absolute path (e.g. ${options.envVarName}=/usr/local/bin/${options.defaultCommand}) or a bare command found on PATH.`,
    );
  }
}

/**
 * Every error constructed by a `makeError` factory (`ClaudeCodeExecutableError`,
 * `CaamExecutableError`, ...) exposes a `.reason` string by convention, so the
 * PATH-search loop above can duck-type "try the next candidate" apart from a
 * real hardening failure without importing every caller's error class here.
 */
function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "reason" in error &&
    (error as { reason: unknown }).reason === "not_found"
  );
}

async function verifyExecutable(
  candidate: string,
  options: {
    requested: string;
    repoRoot?: string;
    uid?: number;
    fsModule: LocalOwnerFsModule & { access(path: string, mode?: number): Promise<void> };
    makeError: (reason: string, message?: string) => Error;
    label: string;
  },
): Promise<ResolvedClaudeExecutable> {
  try {
    await options.fsModule.stat(candidate);
    await options.fsModule.access(candidate, X_OK);
  } catch (error) {
    const wrapped = options.makeError("not_found");
    (wrapped as Error & { cause?: unknown }).cause = error;
    throw wrapped;
  }

  // NOTE: the stat/access pair above only establishes that *something*
  // executable exists at `candidate` right now, so the PATH-search loop
  // above can tell "this candidate doesn't exist, try the next one" apart
  // from a real hardening failure. Its result is deliberately DISCARDED —
  // every is-file/executable-bit/ownership decision below is made against
  // `realStat` (stat'd from the fully resolved `real` path, further down),
  // never against this early, pre-resolution stat. Validating against the
  // pre-resolution stat and only *spawning* the later-resolved `real` path
  // is exactly the TOCTOU gap this function used to have: an attacker who
  // can rewrite the (allowed) trailing symlink could point it at a
  // legitimate, current-user-owned binary just long enough for this early
  // check to pass, then swap it to their own binary before `realpath`
  // resolved it — the ownership check would then pass with a stale-but-legit
  // uid while an unvalidated binary got returned for spawning. Mirrors
  // localOwnerGuard.ts's `verifyOwnerPath`, which stats `real` (never the
  // pre-resolution candidate) for exactly this reason.

  // First pass: walk the requested (possibly-symlinked) candidate path.
  // Every PARENT directory must still be a real, non-world-writable
  // directory (an attacker with write access to a parent dir could swap
  // the symlink target, so that protection stays in force). The final
  // segment is allowed to be a symlink — this is Anthropic's own
  // native-installer layout (e.g. `~/.local/bin/claude` -> a
  // version-manager symlink under `~/.local/share/claude/versions/<v>`),
  // and rejecting it outright makes oracle unusable with the officially
  // recommended install method.
  await assertNoSymlinkOrWorldWritableComponents(candidate, options.fsModule, options.label, {
    allowTrailingSymlink: true,
  });

  // Second pass (TOCTOU mitigation + the actual hardening surface): fully
  // resolve the symlink and re-run the SAME check, this time with no
  // exceptions, against the real target. A fully `realpath`-resolved path
  // should never itself contain a symlink component, so this call remains
  // a strict "no symlink anywhere, nothing world-writable" gate — it is
  // this resolved path (`real`), not the original candidate, that ends up
  // owning process spawn, ownership, and inside-repo decisions below.
  // Callers that need to defend against a symlink swap occurring between
  // this resolution and the eventual `spawn()` (e.g. while waiting on a
  // lock) MUST re-run `resolveClaudeExecutable` against `real` immediately
  // before spawning — see `sessionRunner.ts`.
  const real = await options.fsModule.realpath(candidate);

  // Stat the fully resolved, real target — NOT `candidate` from before
  // resolution — and validate everything below against `realStat`. This is
  // the binary that actually gets returned (and spawned by the caller), so
  // it must be the one every is-file/executable-bit/ownership check is
  // performed against; stating anything else reopens the symlink-swap
  // TOCTOU this function exists to close.
  const realStat = await options.fsModule.stat(real);

  if (!realStat.isFile()) {
    throw options.makeError(
      "not_file",
      `Resolved executable "${real}" is not a regular file. Point the executable override at the real binary (a file, not a directory).`,
    );
  }
  if ((realStat.mode & 0o111) === 0) {
    throw options.makeError(
      "not_executable",
      `Resolved executable "${real}" is missing the executable bit (+x). Run: chmod +x "${real}"`,
    );
  }

  await assertNoSymlinkOrWorldWritableComponents(real, options.fsModule, options.label);

  if (options.repoRoot && isInside(await options.fsModule.realpath(options.repoRoot), real)) {
    throw options.makeError(
      "inside_reviewed_repo",
      `Resolved executable "${real}" lives inside the Oracle repo checkout itself, which fable-local refuses for safety. Install it outside this repo and point the executable override (e.g. ORACLE_CLAUDE_CODE_EXECUTABLE) at the external path.`,
    );
  }

  if (options.uid !== undefined && realStat.uid !== options.uid && realStat.uid !== 0) {
    throw options.makeError(
      "not_owned_by_current_user_or_root",
      `Resolved executable "${real}" is owned by a different, non-root user (uid mismatch), which fable-local refuses to trust. Reinstall it as your own user, or run: chown $(whoami) "${real}"`,
    );
  }

  return {
    requested: options.requested,
    path: real,
    ownerUid: realStat.uid,
    mode: realStat.mode,
  };
}

function isBareCommand(value: string): boolean {
  return !value.includes("/") && !value.includes("\\");
}

function pathCandidates(command: string, env: NodeJS.ProcessEnv): string[] {
  const pathValue = env.PATH ?? "";
  return pathValue
    .split(path.delimiter)
    .filter(Boolean)
    .map((dir) => path.join(dir, command));
}

function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel));
}

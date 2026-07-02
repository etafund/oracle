import fs from "node:fs/promises";
import path from "node:path";
import type { Stats } from "node:fs";

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

export async function resolveClaudeExecutable(
  options: ResolveClaudeExecutableOptions = {},
): Promise<ResolvedClaudeExecutable> {
  const fsLike = options.fsModule ?? fs;
  const requested = options.executable?.trim() || "claude";
  if (!requested) {
    throw new ClaudeCodeExecutableError("empty_executable");
  }

  const candidates = path.isAbsolute(requested)
    ? [requested]
    : isBareCommand(requested)
      ? pathCandidates(requested, options.env ?? process.env)
      : failRelativePath();

  let lastNotFound: unknown;
  for (const candidate of candidates) {
    try {
      return await verifyExecutable(candidate, {
        requested,
        repoRoot: options.repoRoot,
        uid: options.uid ?? process.getuid?.(),
        fsModule: fsLike,
      });
    } catch (error) {
      if (!(error instanceof ClaudeCodeExecutableError) || error.reason !== "not_found") {
        throw error;
      }
      lastNotFound = error;
    }
  }

  throw new ClaudeCodeExecutableError(
    "not_found",
    "Claude Code local mode requires the `claude` command on PATH.",
  );

  function failRelativePath(): never {
    throw new ClaudeCodeExecutableError("relative_path");
  }
}

async function verifyExecutable(
  candidate: string,
  options: {
    requested: string;
    repoRoot?: string;
    uid?: number;
    fsModule: LocalOwnerFsModule & { access(path: string, mode?: number): Promise<void> };
  },
): Promise<ResolvedClaudeExecutable> {
  let stat: Stats;
  try {
    stat = await options.fsModule.stat(candidate);
    await options.fsModule.access(candidate, X_OK);
  } catch (error) {
    const wrapped = new ClaudeCodeExecutableError("not_found");
    (wrapped as Error & { cause?: unknown }).cause = error;
    throw wrapped;
  }

  if (!stat.isFile()) {
    throw new ClaudeCodeExecutableError("not_file");
  }
  if ((stat.mode & 0o111) === 0) {
    throw new ClaudeCodeExecutableError("not_executable");
  }

  await assertNoSymlinkOrWorldWritableComponents(candidate, options.fsModule, "claude_executable");
  const real = await options.fsModule.realpath(candidate);
  await assertNoSymlinkOrWorldWritableComponents(real, options.fsModule, "claude_executable");

  if (options.repoRoot && isInside(await options.fsModule.realpath(options.repoRoot), real)) {
    throw new ClaudeCodeExecutableError("inside_reviewed_repo");
  }

  if (options.uid !== undefined && stat.uid !== options.uid && stat.uid !== 0) {
    throw new ClaudeCodeExecutableError("not_owned_by_current_user_or_root");
  }

  return {
    requested: options.requested,
    path: real,
    ownerUid: stat.uid,
    mode: stat.mode,
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

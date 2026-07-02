import fs from "node:fs/promises";
import path from "node:path";
import type { Stats } from "node:fs";

export type ClaudeCodeLocalTransport =
  | "stdio"
  | "local-socket"
  | "network"
  | "router"
  | "serve"
  | "bridge"
  | "remote-browser"
  | "remote-chrome";

export interface ClaudeCodeLocalOwnerGuardOptions {
  oracleHome: string;
  sessionDir?: string;
  env?: NodeJS.ProcessEnv;
  uid?: number;
  platform?: NodeJS.Platform;
  transport?: ClaudeCodeLocalTransport;
  fsModule?: LocalOwnerFsModule;
}

export interface LocalOwnerFsModule {
  stat(path: string): Promise<Stats>;
  lstat(path: string): Promise<Stats>;
  realpath(path: string): Promise<string>;
}

export interface ClaudeCodeLocalOwnerResult {
  ok: true;
  warnings: string[];
  checkedPaths: {
    oracleHome: string;
    sessionDir?: string;
  };
}

export class ClaudeCodeLocalOwnerError extends Error {
  readonly reason: string;

  constructor(reason: string, message?: string) {
    super(message ?? `Claude Code local mode failed local-owner check: ${reason}.`);
    this.name = "ClaudeCodeLocalOwnerError";
    this.reason = reason;
  }
}

export async function assertClaudeCodeLocalOwner(
  options: ClaudeCodeLocalOwnerGuardOptions,
): Promise<ClaudeCodeLocalOwnerResult> {
  const platform = options.platform ?? process.platform;
  if (platform !== "linux" && platform !== "darwin") {
    throw new ClaudeCodeLocalOwnerError("unsupported_platform");
  }

  const uid = options.uid ?? process.getuid?.();
  const env = options.env ?? process.env;
  if (uid === 0) {
    throw new ClaudeCodeLocalOwnerError(env.SUDO_USER ? "sudo_root_context" : "running_as_root");
  }

  if (options.transport && options.transport !== "stdio" && options.transport !== "local-socket") {
    throw new ClaudeCodeLocalOwnerError("remote_or_network_transport");
  }

  const warnings: string[] = [];
  if (env.SUDO_USER && uid !== 0) {
    warnings.push("sudo_user_present_non_root");
  }

  const fsLike = options.fsModule ?? fs;
  const oracleHome = await verifyOwnerPath("oracle_home", options.oracleHome, {
    fsModule: fsLike,
    uid,
    requireOwner: uid !== undefined,
  });

  let sessionDir: string | undefined;
  if (options.sessionDir) {
    sessionDir = await verifyOwnerPath("session_dir", options.sessionDir, {
      fsModule: fsLike,
      uid,
      requireOwner: uid !== undefined,
    });
  }

  return {
    ok: true,
    warnings,
    checkedPaths: {
      oracleHome,
      sessionDir,
    },
  };
}

async function verifyOwnerPath(
  label: "oracle_home" | "session_dir",
  targetPath: string,
  options: { fsModule: LocalOwnerFsModule; uid?: number; requireOwner: boolean },
): Promise<string> {
  const absolute = path.resolve(targetPath);
  await assertNoSymlinkOrWorldWritableComponents(absolute, options.fsModule, label);
  const real = await options.fsModule.realpath(absolute);
  const stat = await options.fsModule.stat(real);
  if (!stat.isDirectory()) {
    throw new ClaudeCodeLocalOwnerError(`${label}_not_directory`);
  }
  if ((stat.mode & 0o002) !== 0) {
    throw new ClaudeCodeLocalOwnerError(`${label}_world_writable`);
  }
  if (options.requireOwner && options.uid !== undefined && stat.uid !== options.uid) {
    throw new ClaudeCodeLocalOwnerError(`${label}_not_owned_by_current_user`);
  }
  return real;
}

export async function assertNoSymlinkOrWorldWritableComponents(
  absolutePath: string,
  fsModule: LocalOwnerFsModule = fs,
  label = "path",
): Promise<void> {
  const parsed = path.parse(path.resolve(absolutePath));
  const segments = path
    .resolve(absolutePath)
    .slice(parsed.root.length)
    .split(path.sep)
    .filter(Boolean);
  let current = parsed.root;

  for (const segment of segments) {
    current = path.join(current, segment);
    const stat = await fsModule.lstat(current);
    if (stat.isSymbolicLink()) {
      throw new ClaudeCodeLocalOwnerError(`${label}_unsafe_symlink`);
    }
    if ((stat.mode & 0o002) !== 0) {
      throw new ClaudeCodeLocalOwnerError(`${label}_world_writable_component`);
    }
  }
}

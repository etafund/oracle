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
    throw new ClaudeCodeLocalOwnerError(
      "unsupported_platform",
      `Claude Code lane (fable-local) only runs on linux or darwin; this host reports "${platform}". Use one of the browser lanes instead: oracle -p "<prompt>" --lane chatgpt-pro (or --lane gemini-deep-think).`,
    );
  }

  const uid = options.uid ?? process.getuid?.();
  const env = options.env ?? process.env;
  if (uid === 0) {
    const viaSudo = Boolean(env.SUDO_USER);
    throw new ClaudeCodeLocalOwnerError(
      viaSudo ? "sudo_root_context" : "running_as_root",
      `Claude Code lane refuses to run as root${viaSudo ? " (invoked via sudo)" : ""} — spawning \`claude\` as root would give the model root-owned file access. Re-run as a normal user, e.g.: su - ${env.SUDO_USER ?? "<user>"} -c 'oracle -p "<prompt>" --lane fable-local'`,
    );
  }

  if (options.transport && options.transport !== "stdio" && options.transport !== "local-socket") {
    throw new ClaudeCodeLocalOwnerError(
      "remote_or_network_transport",
      `--lane fable-local only supports local stdio/local-socket transport (got "${options.transport}"). Drop --remote-host/--remote-chrome/--remote-browser, or use a remote-eligible lane: oracle -p "<prompt>" --lane chatgpt-pro (or --lane gemini-deep-think).`,
    );
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
  const envVarHint = label === "oracle_home" ? "ORACLE_HOME_DIR" : "the session directory";
  if (!stat.isDirectory()) {
    throw new ClaudeCodeLocalOwnerError(
      `${label}_not_directory`,
      `Path "${real}" (${envVarHint}) is not a directory. Fix the path and re-run \`oracle doctor lanes --json\` to confirm.`,
    );
  }
  if ((stat.mode & 0o002) !== 0) {
    throw new ClaudeCodeLocalOwnerError(
      `${label}_world_writable`,
      `Path "${real}" (${envVarHint}) is world-writable, which fable-local refuses for safety. Run: chmod o-w "${real}"`,
    );
  }
  if (options.requireOwner && options.uid !== undefined && stat.uid !== options.uid) {
    throw new ClaudeCodeLocalOwnerError(
      `${label}_not_owned_by_current_user`,
      `Path "${real}" (${envVarHint}) is owned by a different user than the current process, which fable-local refuses to trust. Run: chown $(whoami) "${real}"   # or point ${envVarHint} elsewhere`,
    );
  }
  return real;
}

export interface AssertNoSymlinkOptions {
  /**
   * When true, the FINAL path segment is permitted to be a symlink (and its
   * own mode bits are ignored — symlink permission bits are not meaningful
   * on Linux/macOS, `lstat` always reports them as `lrwxrwxrwx`). Every
   * parent segment is still required to be a real directory that is
   * neither a symlink nor world-writable, so an attacker still cannot swap
   * a path component to redirect the final symlink.
   *
   * This exists to accommodate Anthropic's native-installer layout for the
   * `claude` executable (`~/.local/bin/claude` -> a version-manager
   * symlink under `~/.local/share/claude/versions/<version>`), while still
   * rejecting a symlink anywhere else in the chain. Callers that set this
   * MUST separately re-run the check (with default, strict options)
   * against the fully `realpath`-resolved target — see
   * `executableResolver.ts`'s `verifyExecutable`, which does exactly that
   * as its second call.
   */
  allowTrailingSymlink?: boolean;
}

export async function assertNoSymlinkOrWorldWritableComponents(
  absolutePath: string,
  fsModule: LocalOwnerFsModule = fs,
  label = "path",
  options: AssertNoSymlinkOptions = {},
): Promise<void> {
  const parsed = path.parse(path.resolve(absolutePath));
  const segments = path
    .resolve(absolutePath)
    .slice(parsed.root.length)
    .split(path.sep)
    .filter(Boolean);
  let current = parsed.root;

  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]);
    const isFinalSegment = index === segments.length - 1;
    const stat = await fsModule.lstat(current);
    if (stat.isSymbolicLink()) {
      if (isFinalSegment && options.allowTrailingSymlink) {
        // Trailing symlink explicitly permitted (native-installer layout);
        // its own mode bits are meaningless, so skip the world-writable
        // check below too — the resolved real path gets the full check.
        continue;
      }
      throw new ClaudeCodeLocalOwnerError(
        `${label}_unsafe_symlink`,
        `Path component "${current}" (part of "${absolutePath}") is a symlink, which fable-local refuses to follow here for safety. Replace it with a real file/directory, or point the relevant setting (ORACLE_HOME_DIR / ORACLE_CLAUDE_CODE_EXECUTABLE) directly at the fully-resolved real path.`,
      );
    }
    if ((stat.mode & 0o002) !== 0) {
      throw new ClaudeCodeLocalOwnerError(
        `${label}_world_writable_component`,
        `Path component "${current}" (part of "${absolutePath}") is world-writable, which fable-local refuses for safety. Run: chmod o-w "${current}"`,
      );
    }
  }
}

import path from "node:path";
import type { Stats } from "node:fs";

import { describe, expect, test } from "vitest";

import { resolveClaudeExecutable } from "../../src/claude-code/executableResolver.js";
import { assertClaudeCodeLocalOwner } from "../../src/claude-code/localOwnerGuard.js";
import type { LocalOwnerFsModule } from "../../src/claude-code/localOwnerGuard.js";

type FakeEntryType = "file" | "dir" | "symlink";

interface FakeEntry {
  type: FakeEntryType;
  mode: number;
  uid: number;
  realpath?: string;
}

class FakeFs implements LocalOwnerFsModule {
  readonly entries = new Map<string, FakeEntry>();

  add(targetPath: string, entry: FakeEntry): this {
    this.entries.set(path.resolve(targetPath), entry);
    return this;
  }

  async stat(targetPath: string): Promise<Stats> {
    const real = await this.realpath(targetPath);
    const entry = this.entries.get(real);
    if (!entry || entry.type === "symlink") {
      throw Object.assign(new Error(`ENOENT ${targetPath}`), { code: "ENOENT" });
    }
    return fakeStats(entry);
  }

  async lstat(targetPath: string): Promise<Stats> {
    const entry = this.entries.get(path.resolve(targetPath));
    if (!entry) {
      throw Object.assign(new Error(`ENOENT ${targetPath}`), { code: "ENOENT" });
    }
    return fakeStats(entry);
  }

  async realpath(targetPath: string): Promise<string> {
    const absolute = path.resolve(targetPath);
    const entry = this.entries.get(absolute);
    return entry?.realpath ? path.resolve(entry.realpath) : absolute;
  }

  async access(targetPath: string): Promise<void> {
    const stat = await this.stat(targetPath);
    if ((stat.mode & 0o111) === 0) {
      throw Object.assign(new Error(`EACCES ${targetPath}`), { code: "EACCES" });
    }
  }
}

function fakeStats(entry: FakeEntry): Stats {
  return {
    mode: entry.mode,
    uid: entry.uid,
    isDirectory: () => entry.type === "dir",
    isFile: () => entry.type === "file",
    isSymbolicLink: () => entry.type === "symlink",
  } as Stats;
}

function safeFs(): FakeFs {
  return new FakeFs()
    .add("/", { type: "dir", mode: 0o755, uid: 0 })
    .add("/safe", { type: "dir", mode: 0o755, uid: 1000 })
    .add("/safe/oracle", { type: "dir", mode: 0o700, uid: 1000 })
    .add("/safe/oracle/session", { type: "dir", mode: 0o700, uid: 1000 })
    .add("/safe/bin", { type: "dir", mode: 0o755, uid: 1000 })
    .add("/safe/bin/claude", { type: "file", mode: 0o755, uid: 1000 })
    .add("/repo", { type: "dir", mode: 0o755, uid: 1000 })
    .add("/repo/claude", { type: "file", mode: 0o755, uid: 1000 });
}

describe("Claude Code local owner guard", () => {
  test("passes for a normal local user and owned Oracle paths", async () => {
    await expect(
      assertClaudeCodeLocalOwner({
        oracleHome: "/safe/oracle",
        sessionDir: "/safe/oracle/session",
        uid: 1000,
        platform: "linux",
        fsModule: safeFs(),
        env: {},
        transport: "stdio",
      }),
    ).resolves.toMatchObject({ ok: true, warnings: [] });
  });

  test("refuses root and remote transports", async () => {
    await expect(
      assertClaudeCodeLocalOwner({
        oracleHome: "/safe/oracle",
        uid: 0,
        platform: "linux",
        fsModule: safeFs(),
        env: {},
      }),
    ).rejects.toMatchObject({ reason: "running_as_root" });

    await expect(
      assertClaudeCodeLocalOwner({
        oracleHome: "/safe/oracle",
        uid: 1000,
        platform: "linux",
        fsModule: safeFs(),
        env: {},
        transport: "network",
      }),
    ).rejects.toMatchObject({ reason: "remote_or_network_transport" });
  });

  test("warns, rather than hard-refusing, non-root SUDO_USER", async () => {
    await expect(
      assertClaudeCodeLocalOwner({
        oracleHome: "/safe/oracle",
        uid: 1000,
        platform: "linux",
        fsModule: safeFs(),
        env: { SUDO_USER: "admin" },
      }),
    ).resolves.toMatchObject({ warnings: ["sudo_user_present_non_root"] });
  });

  test("refuses world-writable and symlinked owner paths", async () => {
    const worldWritable = safeFs().add("/safe/oracle", { type: "dir", mode: 0o777, uid: 1000 });
    await expect(
      assertClaudeCodeLocalOwner({
        oracleHome: "/safe/oracle",
        uid: 1000,
        platform: "linux",
        fsModule: worldWritable,
        env: {},
      }),
    ).rejects.toHaveProperty("reason", "oracle_home_world_writable_component");

    const symlinked = safeFs()
      .add("/safe/link", { type: "symlink", mode: 0o777, uid: 1000, realpath: "/safe/oracle" })
      .add("/safe/link/session", { type: "dir", mode: 0o700, uid: 1000 });
    await expect(
      assertClaudeCodeLocalOwner({
        oracleHome: "/safe/link",
        uid: 1000,
        platform: "linux",
        fsModule: symlinked,
        env: {},
      }),
    ).rejects.toHaveProperty("reason", "oracle_home_unsafe_symlink");
  });
});

describe("Claude Code executable resolver", () => {
  test("resolves a safe absolute executable", async () => {
    await expect(
      resolveClaudeExecutable({
        executable: "/safe/bin/claude",
        repoRoot: "/repo",
        uid: 1000,
        fsModule: safeFs(),
      }),
    ).resolves.toMatchObject({ path: "/safe/bin/claude", ownerUid: 1000 });
  });

  test("searches PATH for a bare claude command", async () => {
    await expect(
      resolveClaudeExecutable({
        executable: "claude",
        repoRoot: "/repo",
        uid: 1000,
        env: { PATH: "/missing:/safe/bin" },
        fsModule: safeFs(),
      }),
    ).resolves.toMatchObject({ path: "/safe/bin/claude" });
  });

  test("refuses relative, repo-local, and symlinked executables", async () => {
    await expect(
      resolveClaudeExecutable({ executable: "bin/claude", fsModule: safeFs() }),
    ).rejects.toHaveProperty("reason", "relative_path");

    await expect(
      resolveClaudeExecutable({
        executable: "/repo/claude",
        repoRoot: "/repo",
        uid: 1000,
        fsModule: safeFs(),
      }),
    ).rejects.toHaveProperty("reason", "inside_reviewed_repo");

    const symlinked = safeFs()
      .add("/safe/bin/claude", {
        type: "symlink",
        mode: 0o777,
        uid: 1000,
        realpath: "/safe/bin/claude-real",
      })
      .add("/safe/bin/claude-real", { type: "file", mode: 0o755, uid: 1000 });
    await expect(
      resolveClaudeExecutable({
        executable: "/safe/bin/claude",
        repoRoot: "/repo",
        uid: 1000,
        fsModule: symlinked,
      }),
    ).rejects.toHaveProperty("reason", "claude_executable_unsafe_symlink");
  });
});

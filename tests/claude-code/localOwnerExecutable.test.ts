import path from "node:path";
import type { Stats } from "node:fs";

import { describe, expect, test } from "vitest";

import { resolveClaudeExecutable } from "../../src/claude-code/executableResolver.js";
import {
  assertClaudeCodeLocalOwner,
  assertNoSymlinkOrWorldWritableComponents,
} from "../../src/claude-code/localOwnerGuard.js";
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

describe("assertNoSymlinkOrWorldWritableComponents — allowTrailingSymlink", () => {
  test("default (strict) behavior is unchanged: rejects a trailing symlink", async () => {
    const fsModule = safeFs().add("/safe/bin/claude", {
      type: "symlink",
      mode: 0o777,
      uid: 1000,
      realpath: "/safe/bin/claude-real",
    });
    await expect(
      assertNoSymlinkOrWorldWritableComponents(
        "/safe/bin/claude",
        fsModule,
        "claude_executable",
      ),
    ).rejects.toHaveProperty("reason", "claude_executable_unsafe_symlink");
  });

  test("allowTrailingSymlink permits a symlinked final segment but still checks parents", async () => {
    const fsModule = safeFs().add("/safe/bin/claude", {
      type: "symlink",
      mode: 0o777,
      uid: 1000,
      realpath: "/safe/bin/claude-real",
    });
    await expect(
      assertNoSymlinkOrWorldWritableComponents("/safe/bin/claude", fsModule, "claude_executable", {
        allowTrailingSymlink: true,
      }),
    ).resolves.toBeUndefined();
  });

  test("allowTrailingSymlink still rejects a world-writable PARENT directory", async () => {
    const fsModule = safeFs()
      .add("/safe/bin", { type: "dir", mode: 0o777, uid: 1000 })
      .add("/safe/bin/claude", {
        type: "symlink",
        mode: 0o777,
        uid: 1000,
        realpath: "/safe/bin/claude-real",
      });
    await expect(
      assertNoSymlinkOrWorldWritableComponents("/safe/bin/claude", fsModule, "claude_executable", {
        allowTrailingSymlink: true,
      }),
    ).rejects.toHaveProperty("reason", "claude_executable_world_writable_component");
  });

  test("allowTrailingSymlink still rejects a symlinked non-final segment", async () => {
    const fsModule = safeFs()
      .add("/safe/link-bin", { type: "symlink", mode: 0o777, uid: 1000, realpath: "/safe/bin" })
      .add("/safe/link-bin/claude", { type: "file", mode: 0o755, uid: 1000 });
    await expect(
      assertNoSymlinkOrWorldWritableComponents(
        "/safe/link-bin/claude",
        fsModule,
        "claude_executable",
        { allowTrailingSymlink: true },
      ),
    ).rejects.toHaveProperty("reason", "claude_executable_unsafe_symlink");
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

  test("refuses relative and repo-local executables", async () => {
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
  });
});

describe("Claude Code executable resolver — native-installer symlink layout", () => {
  // Anthropic's own native installer puts `claude` at e.g.
  // ~/.local/bin/claude -> ~/.local/share/claude/versions/<version>, a
  // legitimate version-manager symlink so the auto-updater can repoint the
  // active version without touching PATH. Rejecting this layout outright
  // made oracle unusable with the officially recommended install method
  // (claude-provider-map.md finding #4). These tests fail on the OLD
  // behavior, which rejected every symlinked `claude`, full stop.

  function nativeInstallerFs(): FakeFs {
    return safeFs()
      .add("/safe/bin/claude", {
        type: "symlink",
        mode: 0o777,
        uid: 1000,
        realpath: "/safe/versions/2.1.201",
      })
      .add("/safe/versions", { type: "dir", mode: 0o755, uid: 1000 })
      .add("/safe/versions/2.1.201", { type: "file", mode: 0o755, uid: 1000 });
  }

  test("resolves and passes for a native-installer-style trailing symlink", async () => {
    await expect(
      resolveClaudeExecutable({
        executable: "/safe/bin/claude",
        repoRoot: "/repo",
        uid: 1000,
        fsModule: nativeInstallerFs(),
      }),
    ).resolves.toMatchObject({ path: "/safe/versions/2.1.201", ownerUid: 1000 });
  });

  test("still refuses when a PARENT directory (not just the leaf) is a symlink", async () => {
    // The relaxation only applies to the final path segment; a symlinked
    // parent directory is exactly the "attacker swapped a path component"
    // vector the guard exists to stop, so it must still be rejected.
    const parentSymlinked = safeFs()
      .add("/safe/link-bin", {
        type: "symlink",
        mode: 0o777,
        uid: 1000,
        realpath: "/safe/bin",
      })
      .add("/safe/link-bin/claude", { type: "file", mode: 0o755, uid: 1000 });
    await expect(
      resolveClaudeExecutable({
        executable: "/safe/link-bin/claude",
        repoRoot: "/repo",
        uid: 1000,
        fsModule: parentSymlinked,
      }),
    ).rejects.toHaveProperty("reason", "claude_executable_unsafe_symlink");
  });

  test("still refuses a world-writable resolved target reached through a trailing symlink", async () => {
    const worldWritableTarget = safeFs()
      .add("/safe/bin/claude", {
        type: "symlink",
        mode: 0o777,
        uid: 1000,
        realpath: "/safe/versions/2.1.201",
      })
      .add("/safe/versions", { type: "dir", mode: 0o777, uid: 1000 })
      .add("/safe/versions/2.1.201", { type: "file", mode: 0o755, uid: 1000 });
    await expect(
      resolveClaudeExecutable({
        executable: "/safe/bin/claude",
        repoRoot: "/repo",
        uid: 1000,
        fsModule: worldWritableTarget,
      }),
    ).rejects.toHaveProperty("reason", "claude_executable_world_writable_component");
  });

  test("still refuses a foreign-owned resolved target reached through a trailing symlink", async () => {
    const foreignOwnedTarget = safeFs()
      .add("/safe/bin/claude", {
        type: "symlink",
        mode: 0o777,
        uid: 1000,
        realpath: "/safe/versions/2.1.201",
      })
      .add("/safe/versions", { type: "dir", mode: 0o755, uid: 1000 })
      .add("/safe/versions/2.1.201", { type: "file", mode: 0o755, uid: 4242 });
    await expect(
      resolveClaudeExecutable({
        executable: "/safe/bin/claude",
        repoRoot: "/repo",
        uid: 1000,
        fsModule: foreignOwnedTarget,
      }),
    ).rejects.toHaveProperty("reason", "not_owned_by_current_user_or_root");
  });

  test("still refuses a native-installer symlink pointing inside the reviewed repo", async () => {
    const insideRepo = safeFs()
      .add("/safe/bin/claude", {
        type: "symlink",
        mode: 0o777,
        uid: 1000,
        realpath: "/repo/claude",
      })
      .add("/repo/claude", { type: "file", mode: 0o755, uid: 1000 });
    await expect(
      resolveClaudeExecutable({
        executable: "/safe/bin/claude",
        repoRoot: "/repo",
        uid: 1000,
        fsModule: insideRepo,
      }),
    ).rejects.toHaveProperty("reason", "inside_reviewed_repo");
  });

  test("honors ORACLE_CLAUDE_CODE_EXECUTABLE as an explicit, still-hardened override", async () => {
    await expect(
      resolveClaudeExecutable({
        repoRoot: "/repo",
        uid: 1000,
        env: { ORACLE_CLAUDE_CODE_EXECUTABLE: "/safe/bin/claude" },
        fsModule: nativeInstallerFs(),
      }),
    ).resolves.toMatchObject({ path: "/safe/versions/2.1.201" });

    // The explicit `executable` option still wins over the env var.
    await expect(
      resolveClaudeExecutable({
        executable: "/safe/bin/claude",
        repoRoot: "/repo",
        uid: 1000,
        env: { ORACLE_CLAUDE_CODE_EXECUTABLE: "/does/not/exist" },
        fsModule: nativeInstallerFs(),
      }),
    ).resolves.toMatchObject({ path: "/safe/versions/2.1.201" });

    // The override is still fully hardened — a world-writable resolved
    // target reached via the override path still fails.
    const worldWritableOverride = safeFs()
      .add("/safe/bin/claude", {
        type: "symlink",
        mode: 0o777,
        uid: 1000,
        realpath: "/safe/versions/2.1.201",
      })
      .add("/safe/versions", { type: "dir", mode: 0o777, uid: 1000 })
      .add("/safe/versions/2.1.201", { type: "file", mode: 0o755, uid: 1000 });
    await expect(
      resolveClaudeExecutable({
        repoRoot: "/repo",
        uid: 1000,
        env: { ORACLE_CLAUDE_CODE_EXECUTABLE: "/safe/bin/claude" },
        fsModule: worldWritableOverride,
      }),
    ).rejects.toHaveProperty("reason", "claude_executable_world_writable_component");
  });

  test("re-resolving the already-resolved real path (TOCTOU re-check) catches a swapped target", async () => {
    // Mirrors sessionRunner.ts's re-check immediately before spawn: after
    // the first resolution, re-run resolveClaudeExecutable against the
    // returned absolute `path`. If an attacker swaps the target in
    // between (simulated here by mutating the fake fs), the re-check must
    // fail even though the first resolution passed.
    const fsModule = nativeInstallerFs();
    const first = await resolveClaudeExecutable({
      executable: "/safe/bin/claude",
      repoRoot: "/repo",
      uid: 1000,
      fsModule,
    });
    expect(first.path).toBe("/safe/versions/2.1.201");

    // Attacker (or a race) makes the resolved binary world-writable before
    // spawn.
    fsModule.add("/safe/versions/2.1.201", { type: "file", mode: 0o777, uid: 1000 });

    await expect(
      resolveClaudeExecutable({
        executable: first.path,
        repoRoot: "/repo",
        uid: 1000,
        fsModule,
      }),
    ).rejects.toHaveProperty("reason", "claude_executable_world_writable_component");
  });
});

describe("error-teaches: guard errors name the exact fix command", () => {
  // Agent-ergonomics Axiom 6 (error-teaches): every guard error here must
  // name what failed, where, and the exact copy-pasteable corrected
  // command/flag — not just a bare reason code. These pin the message
  // content (not just `.reason`) so a future edit can't silently regress
  // back to a vague message.
  test("running as root names the exact non-root retry command", async () => {
    await expect(
      assertClaudeCodeLocalOwner({
        oracleHome: "/safe/oracle",
        uid: 0,
        platform: "linux",
        fsModule: safeFs(),
        env: {},
      }),
    ).rejects.toThrow(/--lane fable-local/);
  });

  test("remote/network transport names the two browser-lane alternatives", async () => {
    await expect(
      assertClaudeCodeLocalOwner({
        oracleHome: "/safe/oracle",
        uid: 1000,
        platform: "linux",
        fsModule: safeFs(),
        env: {},
        transport: "network",
      }),
    ).rejects.toThrow(/--lane chatgpt-pro.*--lane gemini-deep-think/s);
  });

  test("world-writable oracle_home names the exact chmod fix", async () => {
    const worldWritable = safeFs().add("/safe/oracle", { type: "dir", mode: 0o777, uid: 1000 });
    await expect(
      assertClaudeCodeLocalOwner({
        oracleHome: "/safe/oracle",
        uid: 1000,
        platform: "linux",
        fsModule: worldWritable,
        env: {},
      }),
    ).rejects.toThrow(/chmod o-w "\/safe\/oracle"/);
  });

  test("unsafe symlink names the exact path and refuses silently guessing", async () => {
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
    ).rejects.toThrow(/is a symlink, which fable-local refuses to follow/);
  });

  test("relative executable path names an absolute-path fix with ORACLE_CLAUDE_CODE_EXECUTABLE", async () => {
    await expect(
      resolveClaudeExecutable({ executable: "bin/claude", fsModule: safeFs() }),
    ).rejects.toThrow(/ORACLE_CLAUDE_CODE_EXECUTABLE=\/usr\/local\/bin\/claude/);
  });

  test("inside-reviewed-repo executable names the exact fix", async () => {
    await expect(
      resolveClaudeExecutable({
        executable: "/repo/claude",
        repoRoot: "/repo",
        uid: 1000,
        fsModule: safeFs(),
      }),
    ).rejects.toThrow(/ORACLE_CLAUDE_CODE_EXECUTABLE/);
  });

  test("foreign-owned executable names the exact chown fix", async () => {
    const foreignOwnedTarget = safeFs()
      .add("/safe/bin/claude", {
        type: "symlink",
        mode: 0o777,
        uid: 1000,
        realpath: "/safe/versions/2.1.201",
      })
      .add("/safe/versions", { type: "dir", mode: 0o755, uid: 1000 })
      .add("/safe/versions/2.1.201", { type: "file", mode: 0o755, uid: 4242 });
    await expect(
      resolveClaudeExecutable({
        executable: "/safe/bin/claude",
        repoRoot: "/repo",
        uid: 1000,
        fsModule: foreignOwnedTarget,
      }),
    ).rejects.toThrow(/chown \$\(whoami\)/);
  });
});

describe("Claude Code executable resolver — TOCTOU symlink-swap regression (oracle-router-oracle-newcode-1-oup)", () => {
  // Regression for the bug where the ownership/is-file/executable-bit
  // checks were performed against a `stat()` captured from `candidate`
  // BEFORE `realpath()` resolved the (allowed) trailing symlink, while the
  // path actually returned/spawned (`real`) came from realpath() called
  // afterward. An attacker who can rewrite the trailing symlink could point
  // it at a legitimate, current-user-owned binary just long enough for the
  // early check to capture a passing stat, then swap it to their own
  // binary before realpath() resolved — smuggling an unvalidated binary
  // through with a stale-but-passing ownerUid. The fix stats the fully
  // resolved `real` path and validates against THAT stat, so the swap is
  // caught: the attacker's binary fails the ownership check on its own
  // (foreign) uid, not the stale, legitimate one.
  class SwapOnFirstStatFs extends FakeFs {
    private calls = 0;

    override async stat(targetPath: string) {
      this.calls += 1;
      const result = await super.stat(targetPath);
      if (this.calls === 1) {
        // Simulate the attacker rewriting the trailing symlink at the
        // exact moment between this initial existence-check stat() and
        // the later realpath()/stat(real) calls further down
        // verifyExecutable().
        this.add("/safe/bin/claude", {
          type: "symlink",
          mode: 0o777,
          uid: 1000,
          realpath: "/attacker/evil",
        });
      }
      return result;
    }
  }

  function swapFs(): SwapOnFirstStatFs {
    return new SwapOnFirstStatFs()
      .add("/", { type: "dir", mode: 0o755, uid: 0 })
      .add("/safe", { type: "dir", mode: 0o755, uid: 1000 })
      .add("/safe/bin", { type: "dir", mode: 0o755, uid: 1000 })
      .add("/safe/bin/claude", {
        type: "symlink",
        mode: 0o777,
        uid: 1000,
        realpath: "/safe/versions/legit",
      })
      .add("/safe/versions", { type: "dir", mode: 0o755, uid: 1000 })
      .add("/safe/versions/legit", { type: "file", mode: 0o755, uid: 1000 })
      .add("/attacker", { type: "dir", mode: 0o755, uid: 4242 })
      .add("/attacker/evil", { type: "file", mode: 0o755, uid: 4242 });
  }

  test("a trailing-symlink swap between the initial stat and realpath() is caught, not smuggled through", async () => {
    const fsModule = swapFs();
    await expect(
      resolveClaudeExecutable({
        executable: "/safe/bin/claude",
        repoRoot: "/repo",
        uid: 1000,
        fsModule,
      }),
    ).rejects.toHaveProperty("reason", "not_owned_by_current_user_or_root");
  });

  test("sanity check: without the swap, the same layout resolves the legitimate target", async () => {
    // Confirms the regression test's fixture is otherwise valid (i.e. the
    // rejection above is caused by the swap, not by some unrelated fixture
    // mistake) by resolving the identical layout through plain FakeFs
    // (no swap-on-stat behavior).
    const fsModule = new FakeFs()
      .add("/", { type: "dir", mode: 0o755, uid: 0 })
      .add("/safe", { type: "dir", mode: 0o755, uid: 1000 })
      .add("/safe/bin", { type: "dir", mode: 0o755, uid: 1000 })
      .add("/safe/bin/claude", {
        type: "symlink",
        mode: 0o777,
        uid: 1000,
        realpath: "/safe/versions/legit",
      })
      .add("/safe/versions", { type: "dir", mode: 0o755, uid: 1000 })
      .add("/safe/versions/legit", { type: "file", mode: 0o755, uid: 1000 });
    await expect(
      resolveClaudeExecutable({
        executable: "/safe/bin/claude",
        repoRoot: "/repo",
        uid: 1000,
        fsModule,
      }),
    ).resolves.toMatchObject({ path: "/safe/versions/legit", ownerUid: 1000 });
  });
});

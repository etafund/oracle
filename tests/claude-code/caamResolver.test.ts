import path from "node:path";
import type { Stats } from "node:fs";

import { describe, expect, test } from "vitest";

import {
  CaamExecutableError,
  ORACLE_CAAM_EXECUTABLE_ENV_VAR,
  resolveCaamExecutable,
} from "../../src/claude-code/caamResolver.js";
import type { LocalOwnerFsModule } from "../../src/claude-code/localOwnerGuard.js";

// This mirrors tests/claude-code/localOwnerExecutable.test.ts's FakeFs
// exactly, proving `resolveCaamExecutable` reuses the SAME hardening as
// `resolveClaudeExecutable` (caam-map.md §4a: "resolve the `caam` binary
// with the SAME hardening as claude").

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
    .add("/safe/bin", { type: "dir", mode: 0o755, uid: 1000 })
    .add("/safe/bin/caam", { type: "file", mode: 0o755, uid: 1000 })
    .add("/repo", { type: "dir", mode: 0o755, uid: 1000 })
    .add("/repo/caam", { type: "file", mode: 0o755, uid: 1000 });
}

describe("caam executable resolver", () => {
  test("resolves a safe absolute executable", async () => {
    await expect(
      resolveCaamExecutable({
        executable: "/safe/bin/caam",
        repoRoot: "/repo",
        uid: 1000,
        fsModule: safeFs(),
      }),
    ).resolves.toMatchObject({ path: "/safe/bin/caam", ownerUid: 1000 });
  });

  test("searches PATH for a bare caam command", async () => {
    await expect(
      resolveCaamExecutable({
        executable: "caam",
        repoRoot: "/repo",
        uid: 1000,
        env: { PATH: "/missing:/safe/bin" },
        fsModule: safeFs(),
      }),
    ).resolves.toMatchObject({ path: "/safe/bin/caam" });
  });

  test("refuses relative and repo-local executables", async () => {
    await expect(
      resolveCaamExecutable({ executable: "bin/caam", fsModule: safeFs() }),
    ).rejects.toHaveProperty("reason", "relative_path");

    await expect(
      resolveCaamExecutable({
        executable: "/repo/caam",
        repoRoot: "/repo",
        uid: 1000,
        fsModule: safeFs(),
      }),
    ).rejects.toHaveProperty("reason", "inside_reviewed_repo");
  });

  test("refuses an unsafe symlink component, exactly like the claude resolver", async () => {
    // Symlink/world-writable-component violations are raised by
    // `assertNoSymlinkOrWorldWritableComponents` itself (shared with the
    // claude resolver), so they surface as `ClaudeCodeLocalOwnerError` with
    // a `caam_executable_*` reason (via the `label` passed through to it) —
    // not `CaamExecutableError`. This exactly mirrors how
    // `resolveClaudeExecutable` behaves for the same failure class.
    const fsModule = safeFs()
      .add("/safe/link-bin", { type: "symlink", mode: 0o777, uid: 1000, realpath: "/safe/bin" })
      .add("/safe/link-bin/caam", { type: "file", mode: 0o755, uid: 1000 });
    await expect(
      resolveCaamExecutable({
        executable: "/safe/link-bin/caam",
        repoRoot: "/repo",
        uid: 1000,
        fsModule,
      }),
    ).rejects.toHaveProperty("reason", "caam_executable_unsafe_symlink");
  });

  test("refuses a foreign-owned resolved target, raised as caam's own error type", async () => {
    const fsModule = safeFs().add("/safe/bin/caam", { type: "file", mode: 0o755, uid: 4242 });
    await expect(
      resolveCaamExecutable({
        executable: "/safe/bin/caam",
        repoRoot: "/repo",
        uid: 1000,
        fsModule,
      }),
    ).rejects.toThrow(CaamExecutableError);
    await expect(
      resolveCaamExecutable({
        executable: "/safe/bin/caam",
        repoRoot: "/repo",
        uid: 1000,
        fsModule,
      }),
    ).rejects.toHaveProperty("reason", "not_owned_by_current_user_or_root");
  });

  test("honors ORACLE_CAAM_EXECUTABLE as an explicit, still-hardened override", async () => {
    await expect(
      resolveCaamExecutable({
        repoRoot: "/repo",
        uid: 1000,
        env: { [ORACLE_CAAM_EXECUTABLE_ENV_VAR]: "/safe/bin/caam" },
        fsModule: safeFs(),
      }),
    ).resolves.toMatchObject({ path: "/safe/bin/caam" });

    const worldWritableOverride = safeFs().add("/safe/bin/caam", {
      type: "file",
      mode: 0o777,
      uid: 1000,
    });
    await expect(
      resolveCaamExecutable({
        repoRoot: "/repo",
        uid: 1000,
        env: { [ORACLE_CAAM_EXECUTABLE_ENV_VAR]: "/safe/bin/caam" },
        fsModule: worldWritableOverride,
      }),
    ).rejects.toHaveProperty("reason", "caam_executable_world_writable_component");
  });

  test("not_found when caam is absent from PATH — the caller falls back gracefully", async () => {
    await expect(
      resolveCaamExecutable({
        env: { PATH: "/missing" },
        fsModule: safeFs(),
      }),
    ).rejects.toHaveProperty("reason", "not_found");
  });
});

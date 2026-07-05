import path from "node:path";
import type { Stats } from "node:fs";

import { describe, expect, test } from "vitest";

import { runClaudeCodePreflight } from "../../src/claude-code/preflight.js";
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
    .add("/safe/bin", { type: "dir", mode: 0o755, uid: 1000 })
    .add("/safe/bin/claude", {
      type: "symlink",
      mode: 0o777,
      uid: 1000,
      realpath: "/safe/versions/2.1.201",
    })
    .add("/safe/versions", { type: "dir", mode: 0o755, uid: 1000 })
    .add("/safe/versions/2.1.201", { type: "file", mode: 0o755, uid: 1000 });
}

describe("runClaudeCodePreflight", () => {
  test("reports all-pass for a healthy native-installer-style layout", async () => {
    const result = await runClaudeCodePreflight({
      executable: "/safe/bin/claude",
      oracleHome: "/safe/oracle",
      uid: 1000,
      env: {},
      fsModule: safeFs(),
    });
    expect(result.ok).toBe(true);
    expect(result.checks.map((check) => [check.code, check.status])).toEqual([
      ["anthropic_api_key_absent", "pass"],
      ["claude_executable_resolved", "pass"],
      ["local_owner_verified", "pass"],
    ]);
    const executableCheck = result.checks.find(
      (check) => check.code === "claude_executable_resolved",
    );
    expect(executableCheck?.details).toMatchObject({ path: "/safe/versions/2.1.201" });
  });

  test("reports a failing env-guard check without throwing", async () => {
    const result = await runClaudeCodePreflight({
      executable: "/safe/bin/claude",
      oracleHome: "/safe/oracle",
      uid: 1000,
      env: { ANTHROPIC_API_KEY: "sk-test" },
      fsModule: safeFs(),
    });
    expect(result.ok).toBe(false);
    const envCheck = result.checks.find((check) => check.code === "anthropic_api_key_absent");
    expect(envCheck).toMatchObject({ status: "fail" });
    expect(envCheck?.details).toMatchObject({ blocked_sources: ["ANTHROPIC_API_KEY"] });
  });

  test("reports a failing executable-resolution check without throwing", async () => {
    const result = await runClaudeCodePreflight({
      executable: "/does/not/exist/claude",
      oracleHome: "/safe/oracle",
      uid: 1000,
      env: {},
      fsModule: safeFs(),
    });
    expect(result.ok).toBe(false);
    const executableCheck = result.checks.find(
      (check) => check.code === "claude_executable_resolved",
    );
    expect(executableCheck).toMatchObject({ status: "fail" });
    expect(executableCheck?.details).toMatchObject({ reason: "not_found" });
  });

  test("reports a failing local-owner check (world-writable oracle home) without throwing", async () => {
    const worldWritableHome = safeFs().add("/safe/oracle", {
      type: "dir",
      mode: 0o777,
      uid: 1000,
    });
    const result = await runClaudeCodePreflight({
      executable: "/safe/bin/claude",
      oracleHome: "/safe/oracle",
      uid: 1000,
      env: {},
      fsModule: worldWritableHome,
    });
    expect(result.ok).toBe(false);
    const ownerCheck = result.checks.find((check) => check.code === "local_owner_verified");
    expect(ownerCheck).toMatchObject({ status: "fail" });
    expect(ownerCheck?.details).toMatchObject({ reason: "oracle_home_world_writable_component" });
  });

  test("still fails a foreign-owned or world-writable native-installer symlink target", async () => {
    const foreignOwned = safeFs().add("/safe/versions/2.1.201", {
      type: "file",
      mode: 0o755,
      uid: 4242,
    });
    const result = await runClaudeCodePreflight({
      executable: "/safe/bin/claude",
      oracleHome: "/safe/oracle",
      uid: 1000,
      env: {},
      fsModule: foreignOwned,
    });
    expect(result.ok).toBe(false);
    const executableCheck = result.checks.find(
      (check) => check.code === "claude_executable_resolved",
    );
    expect(executableCheck).toMatchObject({ status: "fail" });
    expect(executableCheck?.details).toMatchObject({
      reason: "not_owned_by_current_user_or_root",
    });
  });
});

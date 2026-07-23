import { describe, expect, test, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import * as profileState from "../../src/browser/profileState.js";

describe("profileState", () => {
  test("writes DevToolsActivePort to both root and Default", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-profile-"));
    try {
      await profileState.writeDevToolsActivePort(dir, 12345);
      const root = path.join(dir, "DevToolsActivePort");
      const nested = path.join(dir, "Default", "DevToolsActivePort");
      expect(existsSync(root)).toBe(true);
      expect(existsSync(nested)).toBe(true);
      expect((await readFile(root, "utf8")).split("\n")[0]?.trim()).toBe("12345");
      expect((await readFile(nested, "utf8")).split("\n")[0]?.trim()).toBe("12345");
      await expect(profileState.readDevToolsPort(dir)).resolves.toBe(12345);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("cleans DevToolsActivePort, but only removes locks when oracle pid is dead", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-profile-"));
    const lockFiles = [
      path.join(dir, "lockfile"),
      path.join(dir, "SingletonLock"),
      path.join(dir, "SingletonSocket"),
      path.join(dir, "SingletonCookie"),
    ];
    try {
      await profileState.writeDevToolsActivePort(dir, 12345);
      for (const lock of lockFiles) {
        await writeFile(lock, "x");
      }

      // Alive pid => keep locks
      await profileState.writeChromePid(dir, process.pid);
      await profileState.cleanupStaleProfileState(dir, undefined, {
        lockRemovalMode: "if_oracle_pid_dead",
      });
      expect(existsSync(path.join(dir, "DevToolsActivePort"))).toBe(false);
      for (const lock of lockFiles) {
        expect(existsSync(lock)).toBe(true);
      }

      // Dead pid => remove locks
      for (const lock of lockFiles) {
        await writeFile(lock, "x");
      }
      const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
      await once(child, "exit");
      await profileState.writeChromePid(dir, child.pid ?? 0);
      await profileState.cleanupStaleProfileState(dir, undefined, {
        lockRemovalMode: "if_oracle_pid_dead",
      });
      expect(existsSync(path.join(dir, "chrome.pid"))).toBe(false);
      for (const lock of lockFiles) {
        expect(existsSync(lock)).toBe(false);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("removes only a confirmed-dead pid hint when lock cleanup is disabled", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-profile-"));
    const lockFiles = ["lockfile", "SingletonLock", "SingletonSocket", "SingletonCookie"].map(
      (name) => path.join(dir, name),
    );
    try {
      for (const [index, lock] of lockFiles.entries()) {
        await writeFile(lock, `lock-${index}`);
      }
      const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
      await once(child, "exit");
      await profileState.writeChromePid(dir, child.pid ?? 0);

      await profileState.cleanupStaleProfileState(dir, undefined, { lockRemovalMode: "never" });
      expect(existsSync(path.join(dir, "chrome.pid"))).toBe(false);
      await expect(Promise.all(lockFiles.map((lock) => readFile(lock, "utf8")))).resolves.toEqual([
        "lock-0",
        "lock-1",
        "lock-2",
        "lock-3",
      ]);

      // Repeated cleanup is idempotent and still cannot touch profile locks.
      await profileState.cleanupStaleProfileState(dir, undefined, { lockRemovalMode: "never" });
      await expect(Promise.all(lockFiles.map((lock) => readFile(lock, "utf8")))).resolves.toEqual([
        "lock-0",
        "lock-1",
        "lock-2",
        "lock-3",
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("retains live and malformed pid hints when death cannot be proved", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-profile-"));
    const pidPath = path.join(dir, "chrome.pid");
    try {
      await profileState.writeChromePid(dir, process.pid);
      await profileState.cleanupStaleProfileState(dir, undefined, { lockRemovalMode: "never" });
      await expect(readFile(pidPath, "utf8")).resolves.toBe(`${process.pid}\n`);

      await writeFile(pidPath, "not-a-pid\n");
      await profileState.cleanupStaleProfileState(dir, undefined, { lockRemovalMode: "never" });
      await expect(readFile(pidPath, "utf8")).resolves.toBe("not-a-pid\n");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("uses node:http for DevTools reachability and retries a transient status", async () => {
    let requests = 0;
    const server = createServer((_request, response) => {
      requests += 1;
      response.statusCode = requests === 1 ? 503 : 204;
      response.end();
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing test server address");
    const fetchMock = vi.fn(() => {
      throw new Error("global fetch must not be used");
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      await expect(
        profileState.verifyDevToolsReachable({
          host: "127.0.0.1",
          port: address.port,
          attempts: 2,
          timeoutMs: 500,
        }),
      ).resolves.toEqual({ ok: true });
      expect(requests).toBe(2);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("reports non-2xx DevTools status and closes a timed-out socket", async () => {
    const statusServer = createServer((_request, response) => {
      response.statusCode = 503;
      response.end();
    });
    await new Promise<void>((resolve, reject) => {
      statusServer.once("error", reject);
      statusServer.listen(0, "127.0.0.1", resolve);
    });
    const statusAddress = statusServer.address();
    if (!statusAddress || typeof statusAddress === "string") {
      throw new Error("missing status server address");
    }
    try {
      await expect(
        profileState.verifyDevToolsReachable({
          host: "127.0.0.1",
          port: statusAddress.port,
          attempts: 1,
          timeoutMs: 500,
        }),
      ).resolves.toEqual({ ok: false, error: "HTTP 503" });
    } finally {
      await new Promise<void>((resolve) => statusServer.close(() => resolve()));
    }

    let socketClosed = false;
    const timeoutServer = createServer((request) => {
      request.socket.once("close", () => {
        socketClosed = true;
      });
      // Intentionally never send response headers.
    });
    await new Promise<void>((resolve, reject) => {
      timeoutServer.once("error", reject);
      timeoutServer.listen(0, "127.0.0.1", resolve);
    });
    const timeoutAddress = timeoutServer.address();
    if (!timeoutAddress || typeof timeoutAddress === "string") {
      throw new Error("missing timeout server address");
    }
    try {
      const result = await profileState.verifyDevToolsReachable({
        host: "127.0.0.1",
        port: timeoutAddress.port,
        attempts: 1,
        timeoutMs: 30,
      });
      expect(result).toMatchObject({ ok: false });
      if (!result.ok) expect(result.error).toMatch(/timed out after 30ms/i);
      for (let attempt = 0; attempt < 20 && !socketClosed; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(socketClosed).toBe(true);
    } finally {
      await new Promise<void>((resolve) => timeoutServer.close(() => resolve()));
    }
  });

  test("bounds a 2xx DevTools response whose body never finishes", async () => {
    let socketClosed = false;
    const server = createServer((_request, response) => {
      response.socket?.once("close", () => {
        socketClosed = true;
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.write("{");
      // Deliberately never finish the body.
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing test server address");
    try {
      await expect(
        profileState.verifyDevToolsReachable({
          host: "127.0.0.1",
          port: address.port,
          attempts: 1,
          timeoutMs: 30,
        }),
      ).resolves.toEqual({ ok: false, error: "timed out after 30ms" });
      for (let attempt = 0; attempt < 20 && !socketClosed; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(socketClosed).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("supports an IPv6 loopback DevTools endpoint when the host provides one", async () => {
    const server = createServer((_request, response) => {
      response.statusCode = 200;
      response.end("{}");
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "::1", resolve);
      });
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === "EADDRNOTAVAIL" || code === "EAFNOSUPPORT") return;
      throw error;
    }
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing IPv6 server address");
    try {
      await expect(
        profileState.verifyDevToolsReachable({
          host: "::1",
          port: address.port,
          attempts: 1,
          timeoutMs: 500,
        }),
      ).resolves.toEqual({ ok: true });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("skips manual-login cleanup when DevTools port is still reachable", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-profile-"));
    try {
      await profileState.writeDevToolsActivePort(dir, 12345);
      await expect(
        profileState.shouldCleanupManualLoginProfileState(dir, undefined, {
          connectionClosedUnexpectedly: true,
          probe: async () => ({ ok: true }),
        }),
      ).resolves.toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("skips normal manual-login cleanup when reused Chrome is still reachable", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-profile-"));
    try {
      await profileState.writeDevToolsActivePort(dir, 12345);
      await expect(
        profileState.shouldCleanupManualLoginProfileState(dir, undefined, {
          connectionClosedUnexpectedly: false,
          probe: async () => ({ ok: true }),
        }),
      ).resolves.toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("runs manual-login cleanup when DevTools port is unreachable", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-profile-"));
    try {
      await profileState.writeDevToolsActivePort(dir, 12345);
      await expect(
        profileState.shouldCleanupManualLoginProfileState(dir, undefined, {
          connectionClosedUnexpectedly: true,
          probe: async () => ({ ok: false, error: "offline" }),
        }),
      ).resolves.toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("acquires and releases the manual-login profile lock", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-profile-"));
    try {
      const lock = await profileState.acquireProfileRunLock(dir, { timeoutMs: 500, pollMs: 50 });
      expect(lock).not.toBeNull();
      const lockPath = path.join(dir, "oracle-automation.lock");
      expect(existsSync(lockPath)).toBe(true);
      await lock?.release();
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("waits for profile lock and errors on timeout", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-profile-"));
    try {
      const lock = await profileState.acquireProfileRunLock(dir, { timeoutMs: 500, pollMs: 50 });
      await expect(
        profileState.acquireProfileRunLock(dir, { timeoutMs: 150, pollMs: 50 }),
      ).rejects.toThrow(/profile lock/i);
      await lock?.release();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("clears stale profile lock when pid is dead", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-profile-"));
    try {
      const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
      await once(child, "exit");
      if (!child.pid) {
        throw new Error("Missing child pid");
      }
      const lockPath = path.join(dir, "oracle-automation.lock");
      await writeFile(
        lockPath,
        JSON.stringify({ pid: child.pid, lockId: "stale", createdAt: new Date().toISOString() }),
      );
      const lock = await profileState.acquireProfileRunLock(dir, { timeoutMs: 500, pollMs: 50 });
      expect(lock).not.toBeNull();
      await lock?.release();
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("deletes unreadable profile lock and continues", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-profile-"));
    try {
      const lockPath = path.join(dir, "oracle-automation.lock");
      await writeFile(lockPath, "not-json");
      const lock = await profileState.acquireProfileRunLock(dir, { timeoutMs: 2000, pollMs: 50 });
      expect(lock).not.toBeNull();
      expect(existsSync(lockPath)).toBe(true);
      await lock?.release();
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("matches recorded Chrome commands to the expected profile", () => {
    const dir = "/Users/example/.oracle/browser-profile";
    expect(
      profileState.isChromeCommandForUserDataDirForTest(
        `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=${dir}`,
        dir,
      ),
    ).toBe(true);
    expect(
      profileState.isChromeCommandForUserDataDirForTest(
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/tmp/other",
        dir,
      ),
    ).toBe(false);
    expect(
      profileState.isChromeCommandForUserDataDirForTest(
        `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=${dir}-old`,
        dir,
      ),
    ).toBe(false);
    expect(
      profileState.isChromeCommandForUserDataDirForTest(
        `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir="${dir}"`,
        dir,
      ),
    ).toBe(true);
    expect(profileState.isChromeCommandForUserDataDirForTest("node worker.js", dir)).toBe(false);
  });

  test("discovers running Chrome DevTools port from process list", () => {
    const dir = "/Users/example/.oracle/browser-profile";
    const processList = `
      123 node worker.js
      456 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --remote-debugging-port=64305 --user-data-dir=${dir} about:blank
      789 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --remote-debugging-port=9222 --user-data-dir=/tmp/other
    `;

    expect(
      profileState.findChromeDebugTargetForProfileFromProcessListForTest(processList, dir),
    ).toEqual({
      pid: 456,
      port: 64305,
    });
  });

  test("does not discover a prefix-colliding profile or malformed debug port", () => {
    const dir = "/home/oracle/profile";
    const processList = `
      456 /usr/bin/google-chrome --remote-debugging-port=9222 --user-data-dir=${dir}-old
      789 /usr/bin/google-chrome --remote-debugging-port=9222junk --user-data-dir=${dir}
    `;
    expect(
      profileState.findChromeDebugTargetForProfileFromProcessListForTest(processList, dir),
    ).toBeNull();
  });

  test("binds owner verification to profile, port, process, and PID generation", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-profile-owner-"));
    const pidPath = path.join(dir, "chrome.pid");
    try {
      await profileState.writeChromePid(dir, process.pid, 9222);
      const record = JSON.parse(await readFile(pidPath, "utf8")) as {
        schema: string;
        processStartToken: string;
      };
      expect(record.schema).toBe("oracle.chrome-owner.v1");

      const verified = await profileState.verifyChromeDebugTargetOwner(dir, 9222, {
        processAlive: () => true,
        readCommand: async () =>
          `/usr/bin/google-chrome --remote-debugging-port=9222 --user-data-dir=${dir}`,
        readStartToken: async () => record.processStartToken,
      });
      expect(verified).toMatchObject({ ok: true, pid: process.pid, source: "record" });

      await expect(
        profileState.verifyChromeDebugTargetOwner(dir, 9222, {
          processAlive: () => true,
          readCommand: async () =>
            `/usr/bin/google-chrome\0--remote-debugging-port=9222\0--user-data-dir=${dir}\0`,
          readStartToken: async () => record.processStartToken,
        }),
      ).resolves.toMatchObject({ ok: true, pid: process.pid, source: "record" });

      await expect(
        profileState.verifyChromeDebugTargetOwner(dir, 9223, {
          processAlive: () => true,
          readCommand: async () =>
            `/usr/bin/google-chrome --remote-debugging-port=9223 --user-data-dir=${dir}`,
          readStartToken: async () => record.processStartToken,
        }),
      ).resolves.toEqual({ ok: false, reason: "owner-record-port-mismatch" });

      await expect(
        profileState.verifyChromeDebugTargetOwner(dir, 9222, {
          processAlive: () => true,
          readCommand: async () =>
            `/usr/bin/google-chrome --remote-debugging-port=9222 --user-data-dir=${dir}`,
          readStartToken: async () => `${record.processStartToken}-reused`,
        }),
      ).resolves.toEqual({ ok: false, reason: "owner-process-generation-mismatch" });

      await expect(
        profileState.verifyChromeDebugTargetOwner(dir, 9222, {
          processAlive: () => true,
          readCommand: async () =>
            `/usr/bin/google-chrome --remote-debugging-port=9222 --user-data-dir=${dir}-old`,
          readStartToken: async () => record.processStartToken,
        }),
      ).resolves.toEqual({ ok: false, reason: "owner-process-command-mismatch" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("never trusts a legacy numeric pid record for attachment or termination", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-profile-owner-legacy-"));
    try {
      await writeFile(path.join(dir, "chrome.pid"), `${process.pid}\n`);
      await expect(profileState.verifyChromeDebugTargetOwner(dir, 9222)).resolves.toEqual({
        ok: false,
        reason: "owner-record-missing-or-legacy",
      });
      await expect(profileState.terminateRecordedChromeForProfile(dir)).resolves.toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

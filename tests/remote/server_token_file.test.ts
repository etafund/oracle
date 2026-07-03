import { afterEach, describe, expect, test } from "vitest";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createRemoteServer, resolveServeAuthToken } from "../../src/remote/server.js";

// F8: the serve access token must never need to travel through argv (argv is
// world-visible via /proc/<pid>/cmdline, ps, and crash reports). Token-file
// mode reads the secret from disk at startup, fails loud on missing/empty/
// world-readable files, and composes with systemd LoadCredential.

const CAN_LISTEN_LOCALHOST =
  spawnSync(
    process.execPath,
    [
      "-e",
      `
      const net = require('net');
      const s = net.createServer();
      s.on('error', () => process.exit(1));
      s.listen(0, '127.0.0.1', () => s.close(() => process.exit(0)));
    `,
    ],
    { stdio: "ignore" },
  ).status === 0;

const ENV_KEYS = ["ORACLE_REMOTE_TOKEN", "ORACLE_REMOTE_TOKEN_FILE"] as const;
const savedEnv: Record<string, string | undefined> = {};
for (const key of ENV_KEYS) {
  savedEnv[key] = process.env[key];
}

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

function clearTokenEnv(): void {
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
}

describe("resolveServeAuthToken precedence and file handling", () => {
  test("precedence: token-file flag > env token-file > env token > token flag > generated", async () => {
    clearTokenEnv();
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-token-precedence-"));
    try {
      const flagFile = path.join(dir, "flag-file");
      const envFile = path.join(dir, "env-file");
      await writeFile(flagFile, "from-flag-file\n", { mode: 0o600 });
      await writeFile(envFile, "from-env-file\n", { mode: 0o600 });

      process.env.ORACLE_REMOTE_TOKEN_FILE = envFile;
      process.env.ORACLE_REMOTE_TOKEN = "from-env-value";

      await expect(
        resolveServeAuthToken({ tokenFile: flagFile, token: "from-flag" }),
      ).resolves.toEqual({ token: "from-flag-file", source: "token-file" });

      await expect(resolveServeAuthToken({ token: "from-flag" })).resolves.toEqual({
        token: "from-env-file",
        source: "env-token-file",
      });

      delete process.env.ORACLE_REMOTE_TOKEN_FILE;
      await expect(resolveServeAuthToken({ token: "from-flag" })).resolves.toEqual({
        token: "from-env-value",
        source: "env",
      });

      delete process.env.ORACLE_REMOTE_TOKEN;
      await expect(resolveServeAuthToken({ token: "from-flag" })).resolves.toEqual({
        token: "from-flag",
        source: "flag",
      });

      const generated = await resolveServeAuthToken({});
      expect(generated.source).toBe("generated");
      expect(generated.token).toMatch(/^[0-9a-f]{32}$/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("missing, empty, and world-readable token files fail loud", async () => {
    clearTokenEnv();
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-token-failures-"));
    try {
      await expect(
        resolveServeAuthToken({ tokenFile: path.join(dir, "does-not-exist") }),
      ).rejects.toThrow(/Unable to read token file/);

      const emptyFile = path.join(dir, "empty");
      await writeFile(emptyFile, "   \n", { mode: 0o600 });
      await expect(resolveServeAuthToken({ tokenFile: emptyFile })).rejects.toThrow(/is empty/);

      if (process.platform !== "win32") {
        const openFile = path.join(dir, "world-readable");
        await writeFile(openFile, "secret\n");
        await chmod(openFile, 0o644);
        await expect(resolveServeAuthToken({ tokenFile: openFile })).rejects.toThrow(
          /world-readable/,
        );
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("trailing newline and surrounding whitespace are trimmed", async () => {
    clearTokenEnv();
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-token-trim-"));
    try {
      const file = path.join(dir, "token");
      await writeFile(file, "trimmed-token-value\n", { mode: 0o600 });
      await expect(resolveServeAuthToken({ tokenFile: file })).resolves.toMatchObject({
        token: "trimmed-token-value",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("serve token-file mode end-to-end", () => {
  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "a server started with tokenFile authenticates clients holding the file's token",
    async () => {
      clearTokenEnv();
      const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-token-e2e-"));
      try {
        const file = path.join(dir, "token");
        await writeFile(file, "e2e-file-token\n", { mode: 0o600 });
        const server = await createRemoteServer({
          host: "127.0.0.1",
          port: 0,
          tokenFile: file,
          logger: () => {},
        });
        try {
          expect(server.token).toBe("e2e-file-token");
          const ok = await getStatus(server.port, "/health", "e2e-file-token");
          expect(ok).toBe(200);
          const bad = await getStatus(server.port, "/health", "wrong-token");
          expect(bad).toBe(401);
        } finally {
          await server.close();
        }
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "createRemoteServer refuses to start when the token file is missing",
    async () => {
      clearTokenEnv();
      await expect(
        createRemoteServer({
          host: "127.0.0.1",
          port: 0,
          tokenFile: "/nonexistent/oracle-token-file",
          logger: () => {},
        }),
      ).rejects.toThrow(/Unable to read token file/);
    },
  );

  test.skipIf(!CAN_LISTEN_LOCALHOST || process.platform === "win32")(
    "a spawned server resolves its token from ORACLE_REMOTE_TOKEN_FILE with no token in argv",
    async () => {
      const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-token-argv-"));
      const secret = "spawned-server-file-secret-a1b2c3d4";
      const child = { proc: null as ReturnType<typeof spawn> | null };
      try {
        const file = path.join(dir, "token");
        await writeFile(file, `${secret}\n`, { mode: 0o600 });

        const fixture = fileURLToPath(
          new URL("./fixtures/token_file_serve_fixture.ts", import.meta.url),
        );
        const childEnv: NodeJS.ProcessEnv = { ...process.env, ORACLE_REMOTE_TOKEN_FILE: file };
        delete childEnv.ORACLE_REMOTE_TOKEN;
        const proc = spawn(process.execPath, ["--import", "tsx", fixture], {
          env: childEnv,
          stdio: ["ignore", "pipe", "pipe"],
        });
        child.proc = proc;

        const port = await new Promise<number>((resolve, reject) => {
          let output = "";
          const timeout = setTimeout(
            () => reject(new Error(`fixture did not report a port; output: ${output}`)),
            30_000,
          );
          proc.stdout?.setEncoding("utf8");
          proc.stdout?.on("data", (chunk: string) => {
            output += chunk;
            const match = /PORT=(\d+)/.exec(output);
            if (match) {
              clearTimeout(timeout);
              resolve(Number(match[1]));
            }
          });
          proc.stderr?.setEncoding("utf8");
          proc.stderr?.on("data", (chunk: string) => {
            output += chunk;
          });
          proc.on("exit", (code) => {
            clearTimeout(timeout);
            reject(new Error(`fixture exited early (code ${code}); output: ${output}`));
          });
        });

        // The process's world-visible command line must not contain the token.
        const cmdline = await readFile(`/proc/${proc.pid}/cmdline`, "utf8");
        expect(cmdline).not.toContain(secret);
        // And the environment path travels by reference, not by value.
        expect(cmdline).not.toContain("ORACLE_REMOTE_TOKEN=");

        // The server still authenticates callers holding the file's token.
        const ok = await getStatus(port, "/health", secret);
        expect(ok).toBe(200);
        const bad = await getStatus(port, "/health", "not-the-secret");
        expect(bad).toBe(401);
      } finally {
        child.proc?.kill("SIGKILL");
        await rm(dir, { recursive: true, force: true });
      }
    },
    45_000,
  );
});

async function getStatus(port: number, requestPath: string, token: string): Promise<number> {
  return await new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: requestPath,
        method: "GET",
        headers: { authorization: `Bearer ${token}` },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

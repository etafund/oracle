import { afterEach, describe, expect, test } from "vitest";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createRemoteServer, tokenIdForLog } from "../../src/remote/server.js";

// Startup-log secret hygiene: a supplied bearer token must never be echoed
// into logs (service journals outlive file permissions and survive token
// rotation). Operators get a short sha256-prefix token id instead, which
// identifies the token generation without exposing secret material.

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

const savedPrintToken = process.env.ORACLE_SERVE_PRINT_TOKEN;
const savedIsTTY = process.stdout.isTTY;

afterEach(() => {
  if (savedPrintToken === undefined) {
    delete process.env.ORACLE_SERVE_PRINT_TOKEN;
  } else {
    process.env.ORACLE_SERVE_PRINT_TOKEN = savedPrintToken;
  }
  process.stdout.isTTY = savedIsTTY;
});

describe("serve startup token redaction", () => {
  test("tokenIdForLog is a stable 8-hex-char sha256 prefix", () => {
    const id = tokenIdForLog("some-token-value");
    expect(id).toMatch(/^[0-9a-f]{8}$/);
    expect(id).toBe(createHash("sha256").update("some-token-value").digest("hex").slice(0, 8));
    expect(tokenIdForLog("some-token-value")).toBe(id);
    expect(tokenIdForLog("other-token-value")).not.toBe(id);
  });

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "a supplied token never appears in startup logs; its token id does",
    async () => {
      delete process.env.ORACLE_SERVE_PRINT_TOKEN;
      const fixedToken = "fleet-shared-bearer-secret-0123456789abcdef";
      const logs: string[] = [];
      const server = await createRemoteServer({
        host: "127.0.0.1",
        port: 0,
        token: fixedToken,
        logger: (message) => logs.push(message),
      });

      try {
        const joined = logs.join("\n");
        expect(joined).not.toContain(fixedToken);
        expect(joined).toContain("<redacted>");
        expect(joined).toContain(`token id ${tokenIdForLog(fixedToken)}`);
      } finally {
        await server.close();
      }
    },
  );

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "auto-generated tokens are not printed in non-interactive sessions",
    async () => {
      delete process.env.ORACLE_SERVE_PRINT_TOKEN;
      process.stdout.isTTY = false as never;
      const logs: string[] = [];
      const server = await createRemoteServer({
        host: "127.0.0.1",
        port: 0,
        logger: (message) => logs.push(message),
      });

      try {
        const joined = logs.join("\n");
        expect(joined).not.toContain(server.token);
        expect(joined).toContain("<redacted>");
        expect(joined).toContain(`token id ${tokenIdForLog(server.token)}`);
        expect(joined).toContain("ORACLE_SERVE_PRINT_TOKEN=1");
      } finally {
        await server.close();
      }
    },
  );

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "ORACLE_SERVE_PRINT_TOKEN=1 opts in to printing a freshly generated token once",
    async () => {
      process.env.ORACLE_SERVE_PRINT_TOKEN = "1";
      process.stdout.isTTY = false as never;
      const logs: string[] = [];
      const server = await createRemoteServer({
        host: "127.0.0.1",
        port: 0,
        logger: (message) => logs.push(message),
      });

      try {
        expect(logs.join("\n")).toContain(server.token);
      } finally {
        await server.close();
      }
    },
  );

  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "the opt-in never applies to a supplied token",
    async () => {
      process.env.ORACLE_SERVE_PRINT_TOKEN = "1";
      process.stdout.isTTY = true as never;
      const fixedToken = "fleet-shared-bearer-secret-fedcba9876543210";
      const logs: string[] = [];
      const server = await createRemoteServer({
        host: "127.0.0.1",
        port: 0,
        token: fixedToken,
        logger: (message) => logs.push(message),
      });

      try {
        const joined = logs.join("\n");
        expect(joined).not.toContain(fixedToken);
        expect(joined).toContain(`token id ${tokenIdForLog(fixedToken)}`);
      } finally {
        await server.close();
      }
    },
  );
});

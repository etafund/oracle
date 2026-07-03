// Fixture for the F8 token-out-of-argv test: starts a remote server whose
// token comes exclusively from ORACLE_REMOTE_TOKEN_FILE (no token in argv),
// prints the bound port, and stays alive until killed by the test.
import { createRemoteServer } from "../../../src/remote/server.js";

const server = await createRemoteServer({
  host: "127.0.0.1",
  port: 0,
  logger: () => {},
});
process.stdout.write(`PORT=${server.port}\n`);
setInterval(() => {
  // keep the event loop alive; the parent test kills this process
}, 60_000);

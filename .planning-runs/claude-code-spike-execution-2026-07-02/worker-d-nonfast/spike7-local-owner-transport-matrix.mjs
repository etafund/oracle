#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const outJson = path.join(here, "spike7-transport-matrix.json");
const outMd = path.join(here, "spike7-transport-matrix.md");

function uid() {
  return typeof process.getuid === "function" ? process.getuid() : null;
}

async function pathOwner(target) {
  try {
    const stat = await fs.stat(target);
    return {
      path: target,
      exists: true,
      uid: stat.uid,
      gid: stat.gid,
      mode: `0${(stat.mode & 0o777).toString(8)}`,
      sameUid: uid() === null ? null : stat.uid === uid(),
    };
  } catch (error) {
    return {
      path: target,
      exists: false,
      error: error && typeof error === "object" && "code" in error ? error.code : String(error),
    };
  }
}

function decide(context, facts) {
  const reasons = [];
  if (facts.uid === null) reasons.push("uid_unavailable");
  if (facts.sudoUser) reasons.push("sudo_user_present");
  if (context.remoteHost) reasons.push("remote_host_configured");
  if (context.remoteChrome) reasons.push("remote_chrome_configured");
  if (context.remoteBrowser) reasons.push("remote_browser_configured");
  if (context.surface === "serve" || context.transportKind === "network-http") {
    reasons.push("network_service_context");
  }
  if (context.surface === "router") reasons.push("router_context");
  if (context.surface === "bridge") reasons.push("bridge_context");
  if (context.sessionWorker) reasons.push("session_worker_context");
  if (context.detached) reasons.push("detached_context");
  if (context.transportKind === "mcp-network") reasons.push("network_mcp_transport");
  if (context.transportKind === "mcp-local-socket-no-peercred") {
    reasons.push("local_socket_without_peer_credentials");
  }
  if (context.transportKind === "remote-browser-cdp") reasons.push("remote_browser_cdp");
  if (facts.cwdOwner.exists && facts.cwdOwner.sameUid === false) reasons.push("cwd_not_same_user");
  if (facts.oracleHomeOwner.exists && facts.oracleHomeOwner.sameUid === false) {
    reasons.push("oracle_home_not_same_user");
  }
  if (context.requiresPeerCred && !context.peerCredSameUid) reasons.push("peer_credentials_not_verified");

  const allowedTransports = new Set([
    "cli-local-tty",
    "cli-local-nontty",
    "mcp-stdio",
    "mcp-local-socket-peercred",
  ]);
  const transportAllowed = allowedTransports.has(context.transportKind);
  if (!transportAllowed) reasons.push("transport_not_allowlisted");

  const allowed =
    transportAllowed &&
    reasons.length === 0 &&
    (context.surface === "cli" || context.surface === "mcp") &&
    !context.sessionWorker &&
    !context.detached;

  return {
    outcome: allowed ? "allow" : "refuse",
    reasonCodes: allowed ? [] : Array.from(new Set(reasons)),
  };
}

const matrix = [
  {
    id: "cli-foreground-local",
    surface: "cli",
    transportKind: "cli-local-tty",
    sessionWorker: false,
    detached: false,
  },
  {
    id: "cli-foreground-piped",
    surface: "cli",
    transportKind: "cli-local-nontty",
    sessionWorker: false,
    detached: false,
  },
  {
    id: "cli-detached-background-worker",
    surface: "cli",
    transportKind: "cli-local-nontty",
    sessionWorker: true,
    detached: true,
  },
  {
    id: "restart-attached-local",
    surface: "cli",
    transportKind: "cli-local-tty",
    sessionWorker: false,
    detached: false,
    restart: true,
  },
  {
    id: "mcp-stdio-local",
    surface: "mcp",
    transportKind: "mcp-stdio",
    sessionWorker: false,
    detached: false,
  },
  {
    id: "mcp-local-socket-peercred",
    surface: "mcp",
    transportKind: "mcp-local-socket-peercred",
    requiresPeerCred: true,
    peerCredSameUid: true,
    sessionWorker: false,
    detached: false,
  },
  {
    id: "mcp-local-socket-no-peercred",
    surface: "mcp",
    transportKind: "mcp-local-socket-no-peercred",
    requiresPeerCred: true,
    peerCredSameUid: false,
    sessionWorker: false,
    detached: false,
  },
  {
    id: "mcp-network",
    surface: "mcp",
    transportKind: "mcp-network",
    remoteHost: "127.0.0.1:9473",
    sessionWorker: false,
    detached: false,
  },
  {
    id: "oracle-serve",
    surface: "serve",
    transportKind: "network-http",
    remoteHost: "0.0.0.0:9473",
    sessionWorker: false,
    detached: false,
  },
  {
    id: "oracle-router",
    surface: "router",
    transportKind: "network-http",
    remoteHost: "router",
    sessionWorker: false,
    detached: false,
  },
  {
    id: "oracle-bridge",
    surface: "bridge",
    transportKind: "network-http",
    remoteHost: "bridge",
    sessionWorker: false,
    detached: false,
  },
  {
    id: "browser-remote-host",
    surface: "cli",
    transportKind: "remote-browser-cdp",
    remoteBrowser: true,
    sessionWorker: false,
    detached: false,
  },
  {
    id: "remote-chrome-devtools",
    surface: "cli",
    transportKind: "remote-browser-cdp",
    remoteChrome: true,
    sessionWorker: false,
    detached: false,
  },
];

const oracleHome = process.env.ORACLE_HOME_DIR || path.join(os.homedir(), ".oracle");
const facts = {
  platform: process.platform,
  uid: uid(),
  gid: typeof process.getgid === "function" ? process.getgid() : null,
  user: (() => {
    try {
      return os.userInfo().username;
    } catch {
      return null;
    }
  })(),
  sudoUser: process.env.SUDO_USER || null,
  cwd: process.cwd(),
  repoRoot,
  oracleHome,
  cwdOwner: await pathOwner(process.cwd()),
  repoOwner: await pathOwner(repoRoot),
  oracleHomeOwner: await pathOwner(oracleHome),
  sessionsOwner: await pathOwner(path.join(oracleHome, "sessions")),
};

const decisions = matrix.map((context) => ({
  ...context,
  ...decide(context, facts),
}));

const result = {
  generatedAt: new Date().toISOString(),
  spike: 7,
  facts,
  decisions,
  blockedOsSpecificChecks:
    process.platform === "win32"
      ? ["POSIX uid/gid and peer-credential checks are unavailable on Windows in this harness."]
      : [],
  recommendedGuardApi: {
    name: "assertFableLocalLaunchEligible",
    earliestHooks: [
      "CLI root route/lane resolver before sessionStore.createSession",
      "restartSession before cloned session creation",
      "MCP consult before sessionStore.createSession",
      "detached --exec-session before performSessionRun",
      "doctor/probe before executable resolution",
    ],
    requiredServerSideInputs: [
      "surface",
      "transportKind",
      "process uid/gid",
      "SUDO_USER",
      "cwd owner",
      "ORACLE_HOME_DIR owner",
      "session dir owner",
      "remote host/browser/chrome settings",
      "MCP peer credentials when using sockets",
    ],
  },
};

await fs.writeFile(outJson, `${JSON.stringify(result, null, 2)}\n`, "utf8");

const rows = decisions
  .map(
    (d) =>
      `| ${d.id} | ${d.surface} | ${d.transportKind} | ${d.outcome} | ${
        d.reasonCodes.length ? d.reasonCodes.join(", ") : "none"
      } |`,
  )
  .join("\n");

await fs.writeFile(
  outMd,
  `# Spike 7 Transport Matrix\n\n` +
    `Generated: ${result.generatedAt}\n\n` +
    `Current uid: ${facts.uid ?? "unavailable"} (${facts.user ?? "unknown"})\n\n` +
    `| Case | Surface | Transport | Outcome | Reason Codes |\n` +
    `| --- | --- | --- | --- | --- |\n` +
    `${rows}\n\n` +
    `## Recommended Guard Hooks\n\n` +
    result.recommendedGuardApi.earliestHooks.map((entry) => `- ${entry}`).join("\n") +
    `\n`,
  "utf8",
);

console.log(JSON.stringify({ outJson, outMd, cases: decisions.length }, null, 2));

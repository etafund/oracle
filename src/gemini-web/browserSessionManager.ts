import path from "node:path";
import os from "node:os";
import { mkdir } from "node:fs/promises";
import type { BrowserRunOptions, BrowserLogger, ChromeClient } from "../browser/types.js";
import { launchChrome, connectWithNewTab, closeTab } from "../browser/chromeLifecycle.js";
import {
  readDevToolsPort,
  resolveChromeDebugTargetOwner,
  writeDevToolsActivePort,
  writeChromePid,
  cleanupStaleProfileState,
  verifyDevToolsReachable,
} from "../browser/profileState.js";
import { resolveGeminiBrowserConfig } from "./config.js";

export interface GeminiBrowserSession {
  profileDir: string;
  port: number;
  client: ChromeClient;
  targetId?: string;
  close: () => Promise<void>;
}

export interface OpenGeminiBrowserSessionInput {
  browserConfig: BrowserRunOptions["config"];
  keepBrowserDefault: boolean;
  purpose: string;
  log?: BrowserLogger;
}

export async function openGeminiBrowserSession(
  input: OpenGeminiBrowserSessionInput,
): Promise<GeminiBrowserSession> {
  const { browserConfig, keepBrowserDefault, purpose, log } = input;
  const resolvedConfig = resolveGeminiBrowserConfig({
    ...browserConfig,
    manualLogin: true,
    keepBrowser: browserConfig?.keepBrowser ?? keepBrowserDefault,
  });
  const profileDir =
    resolvedConfig.manualLoginProfileDir ?? path.join(os.homedir(), ".oracle", "browser-profile");
  await mkdir(profileDir, { recursive: true });
  const keepBrowser = Boolean(resolvedConfig.keepBrowser);

  let port = await readDevToolsPort(profileDir);
  let launchedChrome: Awaited<ReturnType<typeof launchChrome>> | null = null;
  let chromeWasLaunched = false;

  if (port) {
    const recordedPort = port;
    const owner = await resolveChromeDebugTargetOwner(profileDir, port, {
      allowProcessDiscovery: true,
    });
    if (owner.ok) port = owner.port;
    const probe = owner.ok
      ? await verifyDevToolsReachable({ port })
      : ({ ok: false, error: `owner verification failed (${owner.reason})` } as const);
    if (!probe.ok) {
      log?.(
        `[gemini-web] Unusable DevTools port ${port} (${probe.error}); launching fresh Chrome for ${purpose}.`,
      );
      await cleanupStaleProfileState(profileDir, log, { lockRemovalMode: "if_oracle_pid_dead" });
      port = null;
    } else if (owner.ok && (owner.source === "process-discovery" || owner.port !== recordedPort)) {
      await writeDevToolsActivePort(profileDir, owner.port);
      await writeChromePid(profileDir, owner.pid, port);
    }
  }

  if (!port) {
    log?.(`[gemini-web] Launching Chrome for ${purpose}.`);
    launchedChrome = await launchChrome(resolvedConfig, profileDir, log ?? (() => {}));
    port = launchedChrome.port;
    chromeWasLaunched = true;
    await writeDevToolsActivePort(profileDir, port);
    if (launchedChrome.pid) {
      await writeChromePid(profileDir, launchedChrome.pid, port);
    }
  } else {
    log?.(`[gemini-web] Reusing Chrome on port ${port} for ${purpose}.`);
  }

  const connection = await connectWithNewTab(port, log ?? (() => {}), undefined);
  const client = connection.client;
  const targetId = connection.targetId;

  const close = async (): Promise<void> => {
    if (keepBrowser) {
      try {
        await client.close();
      } catch {
        /* ignore */
      }
      return;
    }

    if (targetId && port) {
      await closeTab(port, targetId, log ?? (() => {})).catch(() => undefined);
    }
    try {
      await client.close();
    } catch {
      /* ignore */
    }

    if (chromeWasLaunched && launchedChrome) {
      try {
        launchedChrome.kill();
      } catch {
        /* ignore */
      }
      await cleanupStaleProfileState(profileDir, log, { lockRemovalMode: "never" }).catch(
        () => undefined,
      );
    }
  };

  return {
    profileDir,
    port,
    client,
    targetId: targetId ?? undefined,
    close,
  };
}

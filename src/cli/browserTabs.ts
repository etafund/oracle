import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import chalk from "chalk";
import { sessionStore } from "../sessionStore.js";
import type { BrowserHarvestState, SessionMetadata } from "../sessionStore.js";
import {
  collectChatGptTabs,
  DEFAULT_REMOTE_CHROME_HOST,
  DEFAULT_REMOTE_CHROME_PORT,
  extractConversationIdFromUrl,
  formatBrowserTabState,
  harvestChatGptTab,
  sessionMatchesTab,
  type ChatGptTabSummary,
} from "../browser/liveTabs.js";
import {
  isRecoveredConversationHarvestReady,
  recoverConversationTab,
} from "../browser/recoverConversation.js";
import { normalizeChatGptConversationId } from "../browser/conversationIdentity.js";
import { hasImportedChatgptConversationClaim } from "../browser/importedConversation.js";
import { resolveOutputPath } from "./writeOutputPath.js";

const LIVE_POLL_MS = 2000;
const DEFAULT_STALL_THRESHOLD_MS = 60_000;

function isRecoverableMissingTabError(message: string): boolean {
  return (
    message.includes("No ChatGPT tab matched") ||
    message.includes("No live ChatGPT tabs found") ||
    message.includes("ECONNREFUSED") ||
    message.includes("Could not connect")
  );
}

function finishRecoveredChrome(
  recoveredChrome: { kill: () => void; process?: { unref?: () => void } } | null,
  closeAfterRecover: boolean | undefined,
): void {
  if (!recoveredChrome) {
    return;
  }
  try {
    if (closeAfterRecover) {
      recoveredChrome.kill();
    } else {
      recoveredChrome.process?.unref?.();
    }
  } catch {
    // best-effort cleanup
  }
}

export interface BrowserHarvestOptions {
  writeOutputPath?: string;
  browserTabRef?: string;
  stallWindowMs?: number;
  quietOutput?: boolean;
  /**
   * When the live tab cannot be found, relaunch Chrome with the session's
   * persistent profile and navigate to the saved tab URL, then retry harvest.
   * Default: true.
   */
  recoverIfMissing?: boolean;
  /**
   * After a successful recovery harvest, close the relaunched Chrome.
   * Default: false (leave the recovered tab visible for the user).
   */
  closeAfterRecover?: boolean;
}

export interface BrowserLiveTailOptions {
  writeOutputPath?: string;
  browserTabRef?: string;
  stallThresholdMs?: number;
  /**
   * When no live tab matches the session's stored target, relaunch Chrome with
   * the persistent profile and navigate to the saved tab URL before tailing.
   * Default: true.
   */
  recoverIfMissing?: boolean;
  /**
   * After completion, close the relaunched Chrome.
   * Default: false (leave the recovered tab visible).
   */
  closeAfterRecover?: boolean;
}

function sessionBrowserEndpoint(
  meta: SessionMetadata | null | undefined,
): { host: string; port: number } | null {
  const runtime = meta?.browser?.runtime ?? {};
  const remote: { host?: string; port?: number } = meta?.browser?.config?.remoteChrome ?? {};
  const host = runtime.chromeHost ?? remote.host;
  const port = runtime.chromePort ?? remote.port;
  if (!host || !port) {
    return null;
  }
  return { host, port };
}

function collectUniqueEndpoints(metas: SessionMetadata[]): Array<{ host: string; port: number }> {
  const entries = new Map<string, { host: string; port: number }>();
  entries.set(`${DEFAULT_REMOTE_CHROME_HOST}:${DEFAULT_REMOTE_CHROME_PORT}`, {
    host: DEFAULT_REMOTE_CHROME_HOST,
    port: DEFAULT_REMOTE_CHROME_PORT,
  });
  for (const meta of metas) {
    const endpoint = sessionBrowserEndpoint(meta);
    if (!endpoint) {
      continue;
    }
    entries.set(`${endpoint.host}:${endpoint.port}`, endpoint);
  }
  return Array.from(entries.values());
}

function buildSessionIndex(metas: SessionMetadata[]): SessionMetadata[] {
  return metas
    .filter((meta) => meta?.mode === "browser")
    .sort((left, right) =>
      String(right.createdAt ?? "").localeCompare(String(left.createdAt ?? "")),
    );
}

function resolveLinkedSession(
  tab: ChatGptTabSummary,
  metas: SessionMetadata[],
): SessionMetadata | null {
  return buildSessionIndex(metas).find((meta) => sessionMatchesTab(meta, tab)) ?? null;
}

function snippet(text: string, max = 120): string {
  const normalized = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (normalized.length <= max) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function resolveSessionTabRef(meta: SessionMetadata): string {
  const runtime = meta?.browser?.runtime ?? {};
  const harvest = meta?.browser?.harvest ?? {};
  for (const candidate of [harvest.url, runtime.tabUrl]) {
    if (typeof candidate === "string" && extractConversationIdFromUrl(candidate)) {
      return candidate;
    }
  }
  for (const candidate of [harvest.conversationId, runtime.conversationId]) {
    const conversationId = normalizeChatGptConversationId(candidate);
    if (conversationId) {
      return conversationId;
    }
  }
  return harvest.targetId ?? runtime.chromeTargetId ?? "current";
}

export function resolveSessionTabRefForTest(meta: SessionMetadata): string {
  return resolveSessionTabRef(meta);
}

async function persistHarvest(
  sessionId: string,
  meta: SessionMetadata,
  harvested: ChatGptTabSummary,
): Promise<void> {
  const hash = createHash("sha1")
    .update(harvested.lastAssistantMarkdown ?? harvested.lastAssistantText ?? "")
    .digest("hex");
  const harvest = {
    targetId: harvested.targetId,
    url: harvested.url,
    conversationId:
      normalizeChatGptConversationId(harvested.conversationId) ??
      extractConversationIdFromUrl(harvested.url),
    harvestedAt: new Date().toISOString(),
    assistantHash: hash,
    state: harvested.state,
    stopExists: harvested.stopExists,
    sendExists: harvested.sendExists,
    assistantCount: harvested.assistantCount,
    currentModelLabel: harvested.currentModelLabel,
    lastAssistantSnippet: harvested.lastAssistantSnippet,
  };
  // The session's runner process may still be updating this session
  // (status transitions, runtime fields, artifacts) while we harvest
  // from a second process. Merge the harvest into the FRESH on-disk
  // `browser` value inside the store's serialized update — never into
  // the `meta` snapshot captured when tailing started — so this write
  // only ever owns the `harvest` key and cannot revert newer state.
  await sessionStore.updateSession(sessionId, (current) => ({
    browser: {
      ...(current.browser ?? meta.browser ?? {}),
      harvest,
    },
  }));
}

/** Test-only export: exercises the concurrent-writer persistence path. */
export const persistHarvestForTest = persistHarvest;

function printHarvestSummary(sessionId: string, harvested: ChatGptTabSummary): void {
  console.log(chalk.bold(`Session: ${sessionId}`));
  console.log(`Target: ${harvested.targetId}`);
  console.log(`State: ${formatBrowserTabState(harvested)}`);
  console.log(`Model: ${harvested.currentModelLabel || "(unknown)"}`);
  console.log(`URL: ${harvested.url}`);
  console.log(`Assistant turns: ${harvested.assistantCount}`);
  console.log(
    `Signals: stop=${harvested.stopExists ? "yes" : "no"} send=${harvested.sendExists ? "yes" : "no"}`,
  );
  if (harvested.lastUserSnippet) {
    console.log(`Last user: ${harvested.lastUserSnippet}`);
  }
  console.log(chalk.dim("---"));
}

function deriveLiveTailState(
  harvested: ChatGptTabSummary,
  unchangedForMs: number,
  stallThresholdMs: number,
): BrowserHarvestState {
  const observedState = formatBrowserTabState(harvested);
  if (observedState !== "running") {
    return observedState;
  }
  return unchangedForMs >= stallThresholdMs ? "stalled" : "running";
}

export const deriveLiveTailStateForTest = deriveLiveTailState;

async function maybeWriteHarvestOutput(
  pathInput: string | undefined,
  cwd: string,
  content: string,
): Promise<void> {
  const resolved = resolveOutputPath(pathInput, cwd);
  if (!resolved) {
    return;
  }
  const payload = content ?? "";
  if (resolved === "-" || resolved === "/dev/stdout") {
    process.stdout.write(`${payload}${payload.endsWith("\n") ? "" : "\n"}`);
    return;
  }
  await fs.writeFile(resolved, payload, "utf8");
  console.log(chalk.dim(`Wrote harvested assistant output to ${resolved}`));
}

export async function showBrowserTabsStatus(): Promise<void> {
  const metas = await sessionStore.listSessions().catch(() => [] as SessionMetadata[]);
  const endpoints = collectUniqueEndpoints(metas);
  let printedAny = false;
  for (const endpoint of endpoints) {
    let tabs: ChatGptTabSummary[];
    try {
      tabs = await collectChatGptTabs(endpoint);
    } catch {
      continue;
    }
    if (tabs.length === 0) {
      continue;
    }
    printedAny = true;
    console.log(chalk.bold(`Browser Tabs ${endpoint.host}:${endpoint.port}`));
    for (const tab of tabs) {
      const linkedSession = resolveLinkedSession(
        { ...tab, host: endpoint.host, port: endpoint.port },
        metas,
      );
      console.log(
        `- ${tab.targetId} ${formatBrowserTabState(tab)} model=${tab.currentModelLabel || "(unknown)"} turns=${tab.assistantCount} stop=${tab.stopExists ? "yes" : "no"} send=${tab.sendExists ? "yes" : "no"}`,
      );
      console.log(`  title=${tab.title || "(untitled)"}`);
      console.log(`  url=${tab.url}`);
      if (linkedSession) {
        console.log(`  session=${linkedSession.id}`);
      }
      if (tab.lastAssistantSnippet) {
        console.log(`  last=${snippet(tab.lastAssistantSnippet)}`);
      }
    }
  }
  if (!printedAny) {
    console.log("No live ChatGPT tabs found on known Chrome DevTools endpoints.");
  }
}

export async function harvestSessionBrowserOutput(
  sessionId: string,
  options: BrowserHarvestOptions = {},
): Promise<ChatGptTabSummary> {
  const meta = await sessionStore.readSession(sessionId);
  if (!meta) {
    throw new Error(`No session found with ID ${sessionId}.`);
  }
  if (hasImportedChatgptConversationClaim(meta)) {
    throw new Error(
      `Session ${sessionId} is an untrusted manual conversation import. Refusing --harvest because Oracle did not submit or bind an answer in that thread.`,
    );
  }
  if (meta.browser?.remoteRun || meta.browser?.remoteRecovery) {
    throw new Error(
      meta.browser.remoteRecovery
        ? `Session ${sessionId} belongs to a remote browser account. Refusing --harvest local/default-CDP fallback; use \`oracle session ${sessionId} --render\` for account-affine capture-only recovery.`
        : `Session ${sessionId} belongs to a remote browser account. Refusing --harvest local/default-CDP fallback; inspect the conversation in the originating ChatGPT account's history.`,
    );
  }
  const recordedEndpoint = sessionBrowserEndpoint(meta);
  const initialEndpoint = recordedEndpoint ?? {
    host: DEFAULT_REMOTE_CHROME_HOST,
    port: DEFAULT_REMOTE_CHROME_PORT,
  };
  const ref = options.browserTabRef ?? resolveSessionTabRef(meta);
  const recoverIfMissing = options.recoverIfMissing !== false && !options.browserTabRef;

  let recoveredChrome: { kill: () => void; process?: { unref?: () => void } } | null = null;
  try {
    let harvested: ChatGptTabSummary;
    try {
      harvested = await harvestChatGptTab({
        host: initialEndpoint.host,
        port: initialEndpoint.port,
        ref,
        stallWindowMs: options.stallWindowMs,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!isRecoverableMissingTabError(message) || !recoverIfMissing) {
        throw error;
      }
      console.log(
        chalk.yellow(
          `No live ChatGPT tab matched session "${sessionId}". Attempting recovery by reopening the saved conversation URL.`,
        ),
      );
      const recovered = await recoverConversationTab(meta, (line) => console.log(line), {
        existingEndpoint: recordedEndpoint ?? undefined,
      });
      recoveredChrome = recovered.chrome;
      harvested = await harvestChatGptTab({
        host: recovered.host,
        port: recovered.port,
        ref: recovered.ref,
        stallWindowMs: options.stallWindowMs,
      });
    }

    await persistHarvest(sessionId, meta, harvested);
    printHarvestSummary(sessionId, harvested);
    const output = harvested.lastAssistantMarkdown ?? harvested.lastAssistantText ?? "";
    if (options.writeOutputPath) {
      await maybeWriteHarvestOutput(options.writeOutputPath, meta.cwd ?? process.cwd(), output);
    }
    if (!options.quietOutput && output) {
      process.stdout.write(`${output}${output.endsWith("\n") ? "" : "\n"}`);
    }
    return harvested;
  } finally {
    finishRecoveredChrome(recoveredChrome, options.closeAfterRecover);
  }
}

export async function liveTailSessionBrowserOutput(
  sessionId: string,
  options: BrowserLiveTailOptions = {},
): Promise<ChatGptTabSummary> {
  const meta = await sessionStore.readSession(sessionId);
  if (!meta) {
    throw new Error(`No session found with ID ${sessionId}.`);
  }
  if (hasImportedChatgptConversationClaim(meta)) {
    throw new Error(
      `Session ${sessionId} is an untrusted manual conversation import. Refusing --live because Oracle did not submit or bind an answer in that thread.`,
    );
  }
  if (meta.browser?.remoteRun || meta.browser?.remoteRecovery) {
    throw new Error(
      meta.browser.remoteRecovery
        ? `Session ${sessionId} belongs to a remote browser account. Refusing --live local/default-CDP fallback; use \`oracle session ${sessionId} --render\` for account-affine capture-only recovery.`
        : `Session ${sessionId} belongs to a remote browser account. Refusing --live local/default-CDP fallback; inspect the conversation in the originating ChatGPT account's history.`,
    );
  }
  const recordedEndpoint = sessionBrowserEndpoint(meta);
  let endpoint = recordedEndpoint ?? {
    host: DEFAULT_REMOTE_CHROME_HOST,
    port: DEFAULT_REMOTE_CHROME_PORT,
  };
  let browserTabRef = options.browserTabRef ?? resolveSessionTabRef(meta);
  const recoverIfMissing = options.recoverIfMissing !== false && !options.browserTabRef;
  let recoveredChrome: { kill: () => void; process?: { unref?: () => void } } | null = null;
  const stallThresholdMs = options.stallThresholdMs ?? DEFAULT_STALL_THRESHOLD_MS;
  let lastHash: string | null = null;
  let unchangedSince = Date.now();
  let requireRecoveredContent = false;
  let recoveredContentDeadlineMs = 0;

  try {
    // Probe once to see if the live tab is still alive; recover if not.
    try {
      await harvestChatGptTab({
        host: endpoint.host,
        port: endpoint.port,
        ref: browserTabRef,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!isRecoverableMissingTabError(message) || !recoverIfMissing) {
        throw error;
      }
      console.log(
        chalk.yellow(
          `No live ChatGPT tab matched session "${sessionId}". Attempting recovery by reopening the saved conversation URL.`,
        ),
      );
      const recovered = await recoverConversationTab(meta, (line) => console.log(line), {
        existingEndpoint: recordedEndpoint ?? undefined,
        waitForReady: false,
      });
      recoveredChrome = recovered.chrome;
      endpoint = { host: recovered.host, port: recovered.port };
      browserTabRef = recovered.ref;
      requireRecoveredContent = true;
      recoveredContentDeadlineMs = Date.now() + stallThresholdMs;
    }

    while (true) {
      const harvested = await harvestChatGptTab({
        host: endpoint.host,
        port: endpoint.port,
        ref: browserTabRef,
      });
      const fullText = harvested.lastAssistantMarkdown ?? harvested.lastAssistantText ?? "";
      if (requireRecoveredContent && !isRecoveredConversationHarvestReady(harvested)) {
        if (Date.now() < recoveredContentDeadlineMs) {
          await new Promise((resolve) => setTimeout(resolve, LIVE_POLL_MS));
          continue;
        }
        throw new Error("Recovered ChatGPT conversation did not become ready in time.");
      }
      requireRecoveredContent = false;
      const hash = createHash("sha1").update(fullText).digest("hex");
      if (hash !== lastHash) {
        lastHash = hash;
        unchangedSince = Date.now();
        const statusLine =
          `[${new Date().toISOString()}] state=${harvested.state} stop=${harvested.stopExists ? "yes" : "no"} ` +
          `send=${harvested.sendExists ? "yes" : "no"} model=${harvested.currentModelLabel || "(unknown)"} ` +
          `snippet=${snippet(harvested.lastAssistantSnippet || fullText, 160)}`;
        console.log(statusLine);
        await persistHarvest(sessionId, meta, harvested);
      }

      const derivedState = deriveLiveTailState(
        harvested,
        Date.now() - unchangedSince,
        stallThresholdMs,
      );

      if (
        derivedState === "completed" ||
        derivedState === "stalled" ||
        derivedState === "detached"
      ) {
        const finalHarvest: ChatGptTabSummary = {
          ...harvested,
          state: derivedState,
        };
        await persistHarvest(sessionId, meta, finalHarvest);
        printHarvestSummary(sessionId, finalHarvest);
        const output = finalHarvest.lastAssistantMarkdown ?? finalHarvest.lastAssistantText ?? "";
        if (options.writeOutputPath) {
          await maybeWriteHarvestOutput(options.writeOutputPath, meta.cwd ?? process.cwd(), output);
        }
        if (output) {
          process.stdout.write(`${output}${output.endsWith("\n") ? "" : "\n"}`);
        }
        return finalHarvest;
      }

      await new Promise((resolve) => setTimeout(resolve, LIVE_POLL_MS));
    }
  } finally {
    finishRecoveredChrome(recoveredChrome, options.closeAfterRecover);
  }
}

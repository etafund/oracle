import type CDP from "chrome-remote-interface";
import type Protocol from "devtools-protocol";
import type {
  BrowserModelSelectionEvidence,
  BrowserRemoteRunEvidence,
  BrowserRunWarning,
  BrowserRuntimeMetadata,
} from "../sessionStore.js";
import type { SessionArtifact } from "../sessionStore.js";
import type { ThinkingTimeLevel } from "../oracle/types.js";

export type ChromeClient = Awaited<ReturnType<typeof CDP>>;
export type CookieParam = Protocol.Network.CookieParam;
export type BrowserModelStrategy = "select" | "current" | "ignore";
export type BrowserResearchMode = "off" | "deep";
/** Policy for closing the run's owned target (tab) during cleanup. */
export type BrowserCloseOwnedRunTargetPolicy = "auto" | "always";
export type BrowserArchiveMode = "auto" | "always" | "never";

export type BrowserLogger = ((message: string) => void) & {
  verbose?: boolean;
  sessionLog?: (message: string) => void;
};

export interface BrowserAttachment {
  path: string;
  displayPath: string;
  sizeBytes?: number;
  generatedBundle?: boolean;
}

export interface BrowserGeneratedImage {
  url: string;
  alt?: string;
  width?: number;
  height?: number;
  fileId?: string;
}

export interface BrowserDownloadableFile {
  url: string;
  downloadUrl?: string;
  sandboxUrl?: string;
  filename?: string;
  label?: string;
  mimeType?: string;
}

export interface SavedBrowserImage extends SessionArtifact {
  kind: "image";
  url: string;
  finalUrl?: string;
  alt?: string;
  width?: number;
  height?: number;
  fileId?: string;
}

export interface SavedBrowserFile extends SessionArtifact {
  kind: "file";
  url: string;
  finalUrl?: string;
  sandboxUrl?: string;
  filename?: string;
}

export interface BrowserAutomationConfig {
  chromeProfile?: string | null;
  chromePath?: string | null;
  chromeCookiePath?: string | null;
  attachRunning?: boolean;
  browserTabRef?: string | null;
  url?: string;
  chatgptUrl?: string | null;
  timeoutMs?: number;
  debugPort?: number | null;
  inputTimeoutMs?: number;
  /** Time budget for attachment upload/readiness before clicking send. */
  attachmentTimeoutMs?: number;
  /** Delay before rechecking the conversation after an assistant timeout. */
  assistantRecheckDelayMs?: number;
  /** Time budget for the delayed recheck attempt. */
  assistantRecheckTimeoutMs?: number;
  /** Wait for an existing shared Chrome to appear before launching a new one. */
  reuseChromeWaitMs?: number;
  /** Max time to wait for a shared manual-login profile lock (serializes parallel runs). */
  profileLockTimeoutMs?: number;
  /** Soft limit for concurrent ChatGPT tabs sharing one manual-login profile. */
  maxConcurrentTabs?: number;
  /** Delay before starting periodic auto-reattach attempts after a timeout. */
  autoReattachDelayMs?: number;
  /** Interval between auto-reattach attempts (0 disables). */
  autoReattachIntervalMs?: number;
  /** Time budget for each auto-reattach attempt. */
  autoReattachTimeoutMs?: number;
  cookieSync?: boolean;
  cookieNames?: string[] | null;
  cookieSyncWaitMs?: number;
  inlineCookies?: CookieParam[] | null;
  inlineCookiesSource?: string | null;
  headless?: boolean;
  keepBrowser?: boolean;
  hideWindow?: boolean;
  desiredModel?: string | null;
  modelStrategy?: BrowserModelStrategy;
  debug?: boolean;
  allowCookieErrors?: boolean;
  remoteChrome?: { host: string; port: number } | null;
  remoteChromeBrowserWSEndpoint?: string | null;
  remoteChromeProfileRoot?: string | null;
  manualLogin?: boolean;
  manualLoginProfileDir?: string | null;
  manualLoginCookieSync?: boolean;
  /**
   * Policy for closing the run's OWNED target (tab) during cleanup.
   * - "auto" (default): close only after complete runs when keepBrowser is off.
   * - "always": keep the browser alive but close this run's owned target on
   *   success AND failure (serve/manual-login topology, where keepBrowser is
   *   forced on and leaked per-run tabs accumulate in the shared Chrome).
   * When unset, manual-login runs with keepBrowser enabled derive "always".
   */
  closeOwnedRunTargetAfterRun?: BrowserCloseOwnedRunTargetPolicy | null;
  /** Copy this signed-in Chrome user-data dir to a throwaway profile and run against it (login-free). */
  copyProfileSource?: string | null;
  /** Thinking time intensity level for Thinking/Pro models: light, standard, extended, heavy */
  thinkingTime?: ThinkingTimeLevel;
  /** Browser-only research mode. "deep" activates ChatGPT Deep Research. */
  researchMode?: BrowserResearchMode;
  /** Archive completed ChatGPT conversations after local artifacts are saved. */
  archiveConversations?: BrowserArchiveMode;
  /** Existing ChatGPT conversation URL to open before submitting the prompt. */
  resumeConversationUrl?: string | null;
}

export interface BrowserRunOptions {
  prompt: string;
  attachments?: BrowserAttachment[];
  /**
   * Optional secondary submission to try if the initial prompt is rejected by ChatGPT
   * (e.g. inline file paste exceeds composer limits). Intended for auto inline->upload fallback.
   */
  fallbackSubmission?: { prompt: string; attachments: BrowserAttachment[] };
  config?: BrowserAutomationConfig;
  log?: BrowserLogger;
  heartbeatIntervalMs?: number;
  verbose?: boolean;
  /**
   * Force `run_progress.v1` NDJSON emission for this browser run (the same knob
   * the CLI `--run-progress` flag sets). When true, the thinking-status monitor
   * and lifecycle phase markers emit even if `ORACLE_RUN_PROGRESS_JSON` is
   * unset; the env flag still enables emission on its own when this is omitted.
   */
  runProgress?: boolean;
  /** Session id used for cross-process browser slot diagnostics. */
  sessionId?: string;
  /** Browser-only image generation output path. */
  generateImagePath?: string;
  /** Optional output path for image operations. */
  outputPath?: string;
  /** Additional prompts to submit in the same browser conversation after the initial answer. */
  followUpPrompts?: string[];
  /** Optional hook to persist runtime info and current model evidence as soon as Chrome is ready. */
  runtimeHintCb?: (
    hint: BrowserRuntimeMetadata,
    modelSelection?: BrowserModelSelectionEvidence,
  ) => void | Promise<void>;
  /** Worker-internal hook carrying only the exact submitted prompt prefix. */
  submittedPromptPreviewCb?: (promptPreview: string) => void | Promise<void>;
  /**
   * Caller-gone abort. When the signal fires, the run stops waiting at the
   * next raced wait point and unwinds through the normal cleanup path
   * (close owned target before lease release). Post-submit aborts never
   * attempt any ChatGPT-side cancellation — the run is simply abandoned and
   * reported with a typed post-submit transport class.
   */
  signal?: AbortSignal;
  /**
   * Authoritative worker account id, matching the serve layer's own
   * resolution (`options.accountId ?? ORACLE_ACCOUNT_ID env ?? "acct1"`, see
   * src/remote/server.ts). Threaded through to the browser-side quarantine
   * gates (challengeDetection.ts pre-run/pre-result) so a trip is always
   * keyed on the SAME account id the serve layer's /ready and /runs
   * admission checks use — otherwise a caller-supplied accountId that
   * diverges from env can make the latch trip under one identity while
   * admission keeps checking another. Left undefined for non-server callers
   * (CLI, direct SDK use); the quarantine layer falls back to resolving from
   * env in that case, unchanged from prior behavior.
   */
  accountId?: string;
}

export interface BrowserArchiveResult {
  mode: BrowserArchiveMode;
  attempted: boolean;
  archived: boolean;
  reason?: string;
  conversationUrl?: string;
  error?: string;
}

export interface BrowserRunResult {
  answerText: string;
  answerMarkdown: string;
  answerHtml?: string;
  artifacts?: SessionArtifact[];
  generatedImages?: BrowserGeneratedImage[];
  savedImages?: SavedBrowserImage[];
  downloadableFiles?: BrowserDownloadableFile[];
  savedFiles?: SavedBrowserFile[];
  archive?: BrowserArchiveResult;
  modelSelection?: BrowserModelSelectionEvidence;
  remoteRun?: BrowserRemoteRunEvidence;
  warnings?: BrowserRunWarning[];
  tookMs: number;
  answerTokens: number;
  answerChars: number;
  browserTransport?: "cdp";
  chromePid?: number;
  chromePort?: number;
  chromeHost?: string;
  chromeBrowserWSEndpoint?: string;
  chromeProfileRoot?: string;
  userDataDir?: string;
  chromeTargetId?: string;
  tabUrl?: string;
  conversationId?: string;
  promptSubmitted?: boolean;
  controllerPid?: number;
}

export type ResolvedBrowserConfig = Required<
  Omit<
    BrowserAutomationConfig,
    | "chromeProfile"
    | "chromePath"
    | "chromeCookiePath"
    | "desiredModel"
    | "remoteChrome"
    | "remoteChromeBrowserWSEndpoint"
    | "remoteChromeProfileRoot"
    | "thinkingTime"
    | "modelStrategy"
    | "maxConcurrentTabs"
    | "researchMode"
    | "copyProfileSource"
    | "closeOwnedRunTargetAfterRun"
  >
> & {
  chromeProfile?: string | null;
  chromePath?: string | null;
  chromeCookiePath?: string | null;
  attachRunning?: boolean;
  browserTabRef?: string | null;
  desiredModel?: string | null;
  modelStrategy?: BrowserModelStrategy;
  thinkingTime?: ThinkingTimeLevel;
  debugPort?: number | null;
  inlineCookiesSource?: string | null;
  remoteChrome?: { host: string; port: number } | null;
  remoteChromeBrowserWSEndpoint?: string | null;
  remoteChromeProfileRoot?: string | null;
  manualLogin?: boolean;
  manualLoginProfileDir?: string | null;
  manualLoginCookieSync?: boolean;
  closeOwnedRunTargetAfterRun?: BrowserCloseOwnedRunTargetPolicy | null;
  copyProfileSource?: string | null;
  maxConcurrentTabs: number;
  researchMode: BrowserResearchMode;
  archiveConversations: BrowserArchiveMode;
};

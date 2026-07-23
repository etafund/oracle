export interface BrowserReattachGuidanceOptions {
  /** The failed run belongs to a router-managed browser account. */
  remoteOrigin?: boolean;
  /** A private, account-affine recovery capability was persisted locally. */
  remoteRecoveryAvailable?: boolean;
}

export function formatBrowserReattachGuidance(
  sessionId: string,
  options: BrowserReattachGuidanceOptions = {},
): string {
  if (options.remoteOrigin) {
    if (!options.remoteRecoveryAvailable) {
      return [
        "This run belongs to a remote browser account, but automatic recovery is unavailable.",
        "Open the conversation in the originating ChatGPT account's history.",
        "Local --live/--harvest access is intentionally refused because it cannot prove account affinity.",
      ].join("\n");
    }
    return [
      "This remote run did not return cleanly, but its originating account may still hold the answer. Recover without resubmitting:",
      `  oracle session ${sessionId} --render    # account-affine capture-only recovery`,
      "If recovery remains unavailable, inspect the originating ChatGPT account's history.",
      "Local --live/--harvest access is intentionally refused because it cannot prove account affinity.",
    ].join("\n");
  }
  return [
    "This run did not return cleanly, but it may still be alive. Reattach:",
    `  oracle session ${sessionId} --render    # final markdown when complete`,
    `  oracle session ${sessionId} --live      # tail until done`,
    `  oracle session ${sessionId} --harvest   # snapshot the current answer now`,
  ].join("\n");
}

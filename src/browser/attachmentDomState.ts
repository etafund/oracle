export interface AttachmentDomEvidence {
  attachmentState: boolean;
  labelledGroup: boolean;
  removeControl: boolean;
  uploadState: boolean;
  testId: string;
  ariaLabel: string;
  state: string;
  text: string;
}

/**
 * Classify one composer node using attachment-specific evidence.
 *
 * Keep this closure-free: its source is embedded in CDP page expressions.
 * A generic accessible control group is not an attachment. Current ChatGPT
 * file tiles are instead identified by a remove/upload signal, an
 * attachment/chip test id, a filename-like group label, or a file-kind tile
 * label such as "Document".
 */
export function readAttachmentDomEvidence(node: unknown): AttachmentDomEvidence {
  const empty: AttachmentDomEvidence = {
    attachmentState: false,
    labelledGroup: false,
    removeControl: false,
    uploadState: false,
    testId: "",
    ariaLabel: "",
    state: "",
    text: "",
  };
  if (!node || typeof node !== "object") return empty;
  const element = node as {
    getAttribute?: (name: string) => string | null;
    querySelector?: (selector: string) => unknown;
    matches?: (selector: string) => boolean;
    textContent?: unknown;
  };
  const readAttribute = (name: string): string =>
    typeof element.getAttribute === "function"
      ? String(element.getAttribute(name) ?? "").toLowerCase()
      : "";
  const testId = readAttribute("data-testid");
  const ariaLabel = readAttribute("aria-label");
  const state = readAttribute("data-state");
  const text = String(element.textContent ?? "").trim();
  let nestedRemoveControl = false;
  try {
    nestedRemoveControl = Boolean(
      element.querySelector?.(
        '[aria-label*="Remove file"],[aria-label*="remove file"],' +
          '[aria-label*="Remove attachment"],[aria-label*="remove attachment"],' +
          '[data-testid*="remove-attachment"],[data-testid*="attachment-remove"]',
      ),
    );
  } catch {
    nestedRemoveControl = false;
  }
  const removeControl =
    /remove[-_ ]?(?:file|attachment)/.test(`${testId} ${ariaLabel}`) || nestedRemoveControl;
  const rawUploadState =
    readAttribute("aria-busy") === "true" ||
    ["loading", "uploading", "pending"].includes(state) ||
    /\b(?:uploading|processing)\b/i.test(text);
  let controlLike = false;
  let labelledGroup = false;
  try {
    controlLike = element.matches?.('button,[role="button"]') === true;
    labelledGroup = element.matches?.('[role="group"][aria-label]') === true;
  } catch {
    return empty;
  }
  const trimmedLabel = ariaLabel.trim();
  const genericGroupLabel =
    /^(?:add|attach|attachment|choose|delete|download|open|preview|remove|select|upload|view)\b/i.test(
      trimmedLabel,
    ) || /\b(?:controls?|menus?|mode|options?|tools?)$/i.test(trimmedLabel);
  const attachmentBundleLabel =
    /^attachments?-bundle(?:\(\d+\))?(?:\.[a-z0-9][a-z0-9+_-]{0,14})?$/i.test(trimmedLabel);
  const filenameWithExtension =
    !genericGroupLabel &&
    /^[^/\\<>:"|?*\r\n]{1,255}\.[a-z0-9][a-z0-9+_-]{0,14}$/i.test(trimmedLabel);
  const fileKindText = /^(?:archive|audio|document|image|presentation|spreadsheet|video)$/i.test(
    text,
  );
  const extensionlessFileLabel =
    !genericGroupLabel &&
    trimmedLabel.length > 0 &&
    trimmedLabel.length <= 255 &&
    !/[\\/<>\r\n]/.test(trimmedLabel);
  const explicitTileTestId =
    /(?:attachment|file|upload)[-_]?(?:chip|item|preview|tile)|(?:chip|item|preview|tile)[-_]?(?:attachment|file|upload)/i.test(
      testId,
    );
  const attachmentTestId = /(?:^|[-_])(?:attachment|file|upload|chip)(?:[-_]|$)/i.test(testId);
  const attachmentNamedGroup = labelledGroup && attachmentBundleLabel;
  const filenameLabelledGroup = labelledGroup && filenameWithExtension;
  const fileKindGroup = labelledGroup && fileKindText && extensionlessFileLabel;
  // Busy/loading state is common to unrelated composer controls. It is upload
  // evidence only when the same node independently identifies itself as an
  // attachment. Consumers may additionally match a hidden labelled group
  // against the exact expected filename.
  const uploadState =
    rawUploadState &&
    (removeControl ||
      attachmentTestId ||
      attachmentNamedGroup ||
      filenameLabelledGroup ||
      fileKindGroup);
  const controlHasAttachmentEvidence =
    controlLike &&
    (removeControl ||
      uploadState ||
      (explicitTileTestId &&
        (attachmentBundleLabel ||
          filenameWithExtension ||
          (fileKindText && extensionlessFileLabel))));
  if (controlLike && !controlHasAttachmentEvidence) {
    return {
      ...empty,
      labelledGroup,
      removeControl,
      uploadState,
      testId,
      ariaLabel,
      state,
      text,
    };
  }
  const labelledGroupHasAttachmentEvidence =
    labelledGroup &&
    (removeControl ||
      uploadState ||
      attachmentNamedGroup ||
      filenameLabelledGroup ||
      fileKindGroup);
  const attachmentState =
    labelledGroupHasAttachmentEvidence || removeControl || uploadState || explicitTileTestId;
  return {
    attachmentState,
    labelledGroup,
    removeControl,
    uploadState,
    testId,
    ariaLabel,
    state,
    text,
  };
}

export const ATTACHMENT_DOM_EVIDENCE_READER_DECLARATION = `const readAttachmentDomEvidence = ${readAttachmentDomEvidence.toString()};`;

import { describe, expect, test } from "vitest";

import { readAttachmentDomEvidence } from "../../src/browser/attachmentDomState.js";

function node(options: {
  role?: string;
  ariaLabel?: string;
  testId?: string;
  state?: string;
  busy?: boolean;
  text?: string;
  button?: boolean;
  nestedRemove?: boolean;
}) {
  const attributes: Record<string, string> = {
    ...(options.role ? { role: options.role } : {}),
    ...(options.ariaLabel ? { "aria-label": options.ariaLabel } : {}),
    ...(options.testId ? { "data-testid": options.testId } : {}),
    ...(options.state ? { "data-state": options.state } : {}),
    ...(options.busy ? { "aria-busy": "true" } : {}),
  };
  return {
    textContent: options.text ?? "",
    getAttribute: (name: string) => attributes[name] ?? null,
    matches: (selector: string) => {
      if (selector === '[role="group"][aria-label]') {
        return options.role === "group" && Boolean(options.ariaLabel);
      }
      if (selector === 'button,[role="button"]') {
        return options.button === true || options.role === "button";
      }
      return false;
    },
    querySelector: () => (options.nestedRemove ? {} : null),
  };
}

describe("attachment-specific DOM evidence", () => {
  test("ignores an unrelated labelled composer control group", () => {
    expect(
      readAttachmentDomEvidence(
        node({ role: "group", ariaLabel: "Voice mode controls", text: "Voice" }),
      ).attachmentState,
    ).toBe(false);
  });

  test.each([
    {
      name: "generated bundle semantics",
      value: node({ role: "group", ariaLabel: "attachments-bundle", text: "Document" }),
    },
    {
      name: "numeric filename extension",
      value: node({ role: "group", ariaLabel: "archive.7z" }),
    },
    {
      name: "extensionless document tile",
      value: node({ role: "group", ariaLabel: "README", text: "Document" }),
    },
    {
      name: "nested remove affordance",
      value: node({ role: "group", ariaLabel: "README", nestedRemove: true }),
    },
    {
      name: "upload state",
      value: node({
        role: "group",
        ariaLabel: "README",
        testId: "attachment-upload",
        text: "Uploading",
      }),
    },
  ])("recognizes $name", ({ value }) => {
    expect(readAttachmentDomEvidence(value).attachmentState).toBe(true);
  });

  test("does not turn a generic button into attachment state", () => {
    expect(
      readAttachmentDomEvidence(
        node({ role: "button", ariaLabel: "Open example.com", text: "example.com" }),
      ).attachmentState,
    ).toBe(false);
  });

  test.each([
    node({ busy: true, text: "Loading model" }),
    node({ state: "loading", text: "Voice mode" }),
    node({ role: "group", ariaLabel: "Voice mode controls", busy: true, text: "Audio" }),
  ])("does not turn generic composer loading state into attachment state", (value) => {
    const evidence = readAttachmentDomEvidence(value);
    expect(evidence.uploadState).toBe(false);
    expect(evidence.attachmentState).toBe(false);
  });

  test.each([
    node({ testId: "attachment-upload", busy: true }),
    node({ testId: "file-upload-progress", state: "uploading" }),
  ])("recognizes attachment-anchored upload state", (value) => {
    const evidence = readAttachmentDomEvidence(value);
    expect(evidence.uploadState).toBe(true);
    expect(evidence.attachmentState).toBe(true);
  });

  test.each([
    node({ role: "group", ariaLabel: "Attachment controls", text: "Add files" }),
    node({ role: "group", ariaLabel: "Voice mode controls", text: "Audio" }),
    node({ role: "group", ariaLabel: "Open example.com", text: "example.com" }),
  ])("does not turn generic labelled groups into attachment state", (value) => {
    expect(readAttachmentDomEvidence(value).attachmentState).toBe(false);
  });

  test("recognizes an interactive stale attachment tile from combined evidence", () => {
    expect(
      readAttachmentDomEvidence(
        node({
          role: "button",
          testId: "attachment-chip",
          ariaLabel: "README",
          text: "Document",
        }),
      ).attachmentState,
    ).toBe(true);
  });
});

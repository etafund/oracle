// Regression test for oracle-router-j0d (fix d6c615bf): the Pro-probe
// model_picker_button fallback selector must keep its
// `:not([aria-label*="conversation" i])` exclusion.
//
// Why: sidebar conversation-options buttons carry aria-labels like
// "Open conversation options for <chat title>". When a chat title contains
// the word "model" (e.g. "Coordination model critique"), the bare
// `[aria-label*="model" i]` fallback matches that sidebar button; the sidebar
// precedes the composer in DOM order, so the Pro probe's firstText() returns
// the bogus label and the run fails with chatgpt_pro_unverified.
//
// No DOM library ships with this repo, so the behavioral half of the test
// uses a micro-matcher covering exactly the CSS features these selectors use
// (type selector, [attr="v"], [attr*="v" i], :not(...) of attribute tests).
// If the exclusion is removed from the manifest, the sidebar button matches
// again and this test fails.

import { describe, expect, test } from "vitest";

import {
  chatgptSelector,
  chatgptSelectorList,
} from "../../../src/browser/selectors/chatgpt/index.js";

interface FakeElement {
  tag: string;
  attrs: Record<string, string>;
}

interface AttributeTest {
  name: string;
  op: "" | "*=";
  value: string | null;
  caseInsensitive: boolean;
}

const ATTRIBUTE_PATTERN = /\[([a-zA-Z-]+)(?:(\*?)=("([^"]*)"))?(\s+[iI])?\]/g;

function parseAttributeTests(fragment: string): AttributeTest[] {
  const tests: AttributeTest[] = [];
  for (const match of fragment.matchAll(ATTRIBUTE_PATTERN)) {
    tests.push({
      name: match[1] ?? "",
      op: match[2] === "*" ? "*=" : "",
      value: match[4] ?? null,
      caseInsensitive: Boolean(match[5]),
    });
  }
  return tests;
}

function attributeTestMatches(test: AttributeTest, element: FakeElement): boolean {
  const raw = element.attrs[test.name];
  if (raw === undefined) return false;
  if (test.value === null) return true;
  const actual = test.caseInsensitive ? raw.toLowerCase() : raw;
  const expected = test.caseInsensitive ? test.value.toLowerCase() : test.value;
  if (test.op === "*=") return actual.includes(expected);
  return actual === expected;
}

/**
 * Matches a compound selector (no combinators) of the shape the manifest's
 * model_picker_button entries use: `tag[attr="v"][attr*="v" i]:not([...])*`.
 * Throws on shapes it does not understand so selector drift cannot silently
 * turn this regression test into a no-op.
 */
function matchesCompoundSelector(selector: string, element: FakeElement): boolean {
  let rest = selector;
  const notGroups: string[] = [];
  rest = rest.replace(/:not\(([^)]*)\)/g, (_match, inner: string) => {
    notGroups.push(inner);
    return "";
  });
  if (rest.includes(":")) {
    throw new Error(`selector uses unsupported pseudo-class: ${selector}`);
  }
  const tagMatch = rest.match(/^[a-zA-Z][a-zA-Z0-9-]*/);
  if (tagMatch && tagMatch[0].toLowerCase() !== element.tag.toLowerCase()) {
    return false;
  }
  const positiveRemainder = tagMatch ? rest.slice(tagMatch[0].length) : rest;
  // After stripping attribute tests nothing may remain: leftover characters
  // mean combinators or syntax this micro-matcher does not understand, and
  // silently ignoring them would turn the regression test into a no-op.
  const consumed = positiveRemainder.replace(ATTRIBUTE_PATTERN, "");
  if (consumed.trim().length > 0) {
    throw new Error(`selector has unsupported syntax "${consumed.trim()}" in: ${selector}`);
  }
  for (const attributeTest of parseAttributeTests(positiveRemainder)) {
    if (!attributeTestMatches(attributeTest, element)) return false;
  }
  for (const group of notGroups) {
    const groupTests = parseAttributeTests(group);
    if (groupTests.length === 0) {
      throw new Error(`:not() group without attribute tests in: ${selector}`);
    }
    if (groupTests.every((attributeTest) => attributeTestMatches(attributeTest, element))) {
      return false;
    }
  }
  return true;
}

// The exact regression scenario from the incident: a sidebar
// conversation-options button for a chat whose title contains "model".
const SIDEBAR_CONVERSATION_BUTTON: FakeElement = {
  tag: "button",
  attrs: {
    "aria-haspopup": "menu",
    "aria-label": "Open conversation options for Coordination model critique",
  },
};

// A real model-picker button that only the aria-label fallback can find
// (data-testid drifted away).
const MODEL_PICKER_BUTTON_FALLBACK_ONLY: FakeElement = {
  tag: "button",
  attrs: {
    "aria-haspopup": "menu",
    "aria-label": "Model selector, current model is GPT-5 Pro",
  },
};

const CONVERSATION_EXCLUSION = ':not([aria-label*="conversation" i])';

describe("model_picker_button Pro-probe selector exclusion (oracle-x3cd regression)", () => {
  test("the fallback keeps the :not(conversation) exclusion", () => {
    const entry = chatgptSelector("model_picker_button");
    expect(entry).not.toBeNull();
    expect(entry?.fallback.some((selector) => selector.includes(CONVERSATION_EXCLUSION))).toBe(
      true,
    );
  });

  test("every aria-label*=model fallback carries the conversation exclusion", () => {
    const entry = chatgptSelector("model_picker_button");
    for (const selector of entry?.fallback ?? []) {
      if (/aria-label\*="model"/i.test(selector)) {
        expect(selector, `fallback lost the conversation exclusion: ${selector}`).toContain(
          CONVERSATION_EXCLUSION,
        );
      }
    }
  });

  test("the probe's selector list does not match sidebar conversation buttons", () => {
    const selectors = chatgptSelectorList("model_picker_button");
    expect(selectors.length).toBeGreaterThan(0);
    for (const selector of selectors) {
      expect(
        matchesCompoundSelector(selector, SIDEBAR_CONVERSATION_BUTTON),
        `sidebar conversation button must not match: ${selector}`,
      ).toBe(false);
    }
  });

  test("the fallback still matches a real model-picker button", () => {
    const selectors = chatgptSelectorList("model_picker_button");
    expect(
      selectors.some((selector) =>
        matchesCompoundSelector(selector, MODEL_PICKER_BUTTON_FALLBACK_ONLY),
      ),
    ).toBe(true);
  });

  test("without the exclusion the sidebar button WOULD match (the exclusion is load-bearing)", () => {
    const entry = chatgptSelector("model_picker_button");
    const guarded = entry?.fallback.find((selector) => selector.includes(CONVERSATION_EXCLUSION));
    expect(guarded).toBeDefined();
    const unguarded = (guarded ?? "").replace(CONVERSATION_EXCLUSION, "");
    expect(matchesCompoundSelector(unguarded, SIDEBAR_CONVERSATION_BUTTON)).toBe(true);
  });
});

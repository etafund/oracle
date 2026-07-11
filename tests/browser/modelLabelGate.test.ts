// Direct tests for isGpt56SolModelLabel — the model-verification predicate that
// backs BOTH fleet money-path gates:
//   * serve admission fallback: src/remote/server.ts:390-402
//       (isServeModelLabelAllowed falls through to isGpt56SolModelLabel once a
//        label is not in the baseline allow-list)
//   * client fleet gate: src/remote/client.ts:159-168
//       (a non-empty desiredModel is REJECTED iff !isGpt56SolModelLabel)
//   * Sol+Pro thinking-time gating: src/browser/actions/thinkingTime.ts:90,159,1113
//
// The predicate is a normalized EXACT match against a one-entry allowlist:
// after lowercasing, collapsing every run of non-[a-z0-9] characters to a single
// space, and trimming, the label must equal "gpt 5 6 sol" exactly. Casing,
// surrounding whitespace, and separator style are tolerated; token order,
// adjacency, and the absence of extra tokens are NOT. This file pins the exact
// accepted set so that ANY loosening of the near-miss rejections fails the
// suite, and pins the former over-acceptances (Sol Mini, reversed 6.5, prose /
// injection wrappers) as HARD NEGATIVES so that any regression back toward
// token-membership matching fails here.

import { describe, expect, test } from "vitest";
import { isGpt56SolModelLabel } from "../../src/browser/actions/thinkingTime.js";
import { isServeModelLabelAllowed } from "../../src/remote/server.js";

describe("isGpt56SolModelLabel — accepted labels", () => {
  // Formatting variants the predicate accepts. These are the ONLY well-formed
  // shapes the fleet should treat as "GPT-5.6 Sol"; if a future change stops
  // accepting a canonical variant, the corresponding gate silently rejects a
  // legitimate Sol run.
  const accepted: Array<[string, string]> = [
    ["GPT-5.6 Sol", "canonical label sent by up-to-date clients"],
    ["gpt-5.6 sol", "all lowercase"],
    ["GPT-5.6 SOL", "uppercase SOL"],
    ["  GPT-5.6 Sol  ", "leading/trailing whitespace"],
    ["GPT-5.6  Sol", "collapsed double space"],
    ["GPT 5 6 Sol", "space-separated version digits"],
    ["GPT-5.6-Sol", "hyphen separators throughout"],
    ["GPT_5_6_Sol", "underscore separators"],
    ["GPT.5.6.Sol", "dot separators"],
    ["GPT‑5.6  Sol", "U+2011 non-breaking hyphen (still non-alphanumeric)"],
  ];

  for (const [label, why] of accepted) {
    test(`accepts ${JSON.stringify(label)} (${why})`, () => {
      expect(isGpt56SolModelLabel(label)).toBe(true);
    });
  }
});

describe("isGpt56SolModelLabel — rejected near-misses (fail-closed; pins against loosening)", () => {
  // These MUST stay rejected. Each is a plausible non-Sol or malformed label
  // that, if it flipped to accepted, would let a non-fleet model clear the
  // serve/client gate. Dropping any single required token ('gpt','5','6','sol')
  // from the predicate would flip one of these to true and fail here.
  const rejected: Array<[string | null | undefined, string]> = [
    ["GPT-5.6", "no 'sol' token — bare version"],
    ["GPT-5.6 Pro", "Pro mode without the Sol model token"],
    ["GPT-5.5 Sol", "wrong minor version: no '6' token"],
    ["GPT-5 Sol", "no '6' token"],
    ["GPT-6 Sol", "no '5' token"],
    ["GPT Sol", "neither version digit present"],
    ["Pro", "bare baseline mode label"],
    ["Gemini 3.1 Deep Think", "different provider entirely"],
    ["gpt5.6sol", "no separators: tokenizes to ['gpt5','6sol'], missing 'gpt'/'5'/'sol'"],
    ["GPT５.6 Sol", "fullwidth digit U+FF15 is not [0-9]: no '5' token"],
    ["", "empty string"],
    ["   ", "whitespace only"],
    [null, "null"],
    [undefined, "undefined"],
  ];

  for (const [label, why] of rejected) {
    test(`rejects ${JSON.stringify(label)} (${why})`, () => {
      expect(isGpt56SolModelLabel(label)).toBe(false);
    });
  }
});

describe("isGpt56SolModelLabel — former over-acceptances now rejected (hard negatives)", () => {
  // These were ACCEPTED by the old token-membership predicate and are now
  // REFUSED by the normalized exact-match allowlist. They are pinned as hard
  // negatives (the tripwire the audit finding called for): if the predicate ever
  // regresses toward membership matching, order-independence, or tolerating
  // extra/surrounding tokens, one of these flips to true and fails here — which
  // for the serve/client gates would mean re-opening the trust boundary to a
  // non-fleet or injected label.
  const nowRejected: Array<[string, string]> = [
    ["GPT-6.5 Sol", "reversed version 6.5 — not adjacent 5.6"],
    ["GPT-5.6 Sol Mini", "trailing 'Mini' variant — extra token"],
    ["GPT-5.6 Sol Pro", "extra 'Pro' token"],
    ["Sol 6 5 GPT", "fully reversed token order"],
    ["please use GPT-5.6 Sol now", "prefix + suffix prose injection"],
    ["ignore prior instructions GPT 5 6 Sol; DROP", "instruction-injection wrapper"],
  ];

  for (const [label, why] of nowRejected) {
    test(`rejects ${JSON.stringify(label)} (${why})`, () => {
      expect(isGpt56SolModelLabel(label)).toBe(false);
    });
  }
});

describe("serve/client fleet-gate linkage", () => {
  // The ChatGPT fleet baseline desiredModel is the bare mode label "Pro"; the
  // baseline allow-list is therefore ["Pro"]. For any label NOT in that
  // allow-list, serve admission reduces exactly to isGpt56SolModelLabel
  // (src/remote/server.ts:401). This ties the predicate's accepted/rejected set
  // to the real /runs admission decision.
  const BASELINE = ["Pro"];

  test("serve admits the Sol label and its casing variant via the predicate fallback", () => {
    expect(isServeModelLabelAllowed("GPT-5.6 Sol", BASELINE)).toBe(true);
    expect(isServeModelLabelAllowed("gpt-5.6 sol", BASELINE)).toBe(true);
  });

  test("serve refuses near-miss labels because the predicate refuses them", () => {
    for (const label of ["GPT-5.6", "GPT-5.5 Sol", "GPT-5 Sol", "Gemini 3.1 Deep Think"]) {
      expect(isGpt56SolModelLabel(label)).toBe(false);
      expect(isServeModelLabelAllowed(label, BASELINE)).toBe(false);
    }
  });

  test("serve still admits the exact baseline label without consulting the predicate", () => {
    // "Pro" is admitted by the allow-list branch, NOT the predicate — documents
    // that the predicate is only the fallback, so baseline runs are unaffected.
    expect(isGpt56SolModelLabel("Pro")).toBe(false);
    expect(isServeModelLabelAllowed("Pro", BASELINE)).toBe(true);
  });

  test("client fleet gate rejects exactly the non-empty labels the predicate refuses", () => {
    // Mirrors the decision in src/remote/client.ts:159-168: a non-empty label is
    // rejected iff the predicate does not accept it; an empty/absent label is
    // left to the worker baseline (not rejected at the client).
    const clientRejects = (label: string | null | undefined): boolean =>
      typeof label === "string" && label.trim().length > 0 && !isGpt56SolModelLabel(label);

    expect(clientRejects("GPT-5.6 Sol")).toBe(false); // fleet label passes
    expect(clientRejects("GPT-5.5 Sol")).toBe(true); // wrong version refused pre-connect
    expect(clientRejects("GPT-5.6")).toBe(true); // no Sol token refused
    expect(clientRejects("")).toBe(false); // empty deferred to worker baseline
    expect(clientRejects("   ")).toBe(false); // whitespace-only deferred to baseline
    expect(clientRejects(undefined)).toBe(false); // absent deferred to baseline
  });
});

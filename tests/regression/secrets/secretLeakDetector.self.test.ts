// Self-tests for the secret-leak detector helper. These are the
// foundation of the regression suite — if the detector is broken, the
// downstream tests can pass while leaking secrets.

import { describe, expect, test } from "vitest";

import {
  FORBIDDEN_PROPERTY_KEYS,
  SECRET_PATTERNS,
  assertNoLeaks,
  detectLeaks,
  isForbiddenKey,
} from "../../_helpers/secretLeakDetector.js";

const FAKES = [
  { name: "remote-token", value: "fake-remote-token-D4nGer0us" },
  { name: "openai-key", value: "sk-fake1234567890abcdefghij" },
] as const;

describe("detectLeaks — literal scan", () => {
  test("flags a known fake echoed in a string", () => {
    const leaks = detectLeaks(`status: ${FAKES[0].value} ok`, { fakes: FAKES });
    expect(leaks).toHaveLength(1);
    expect(leaks[0].kind).toBe("literal");
    expect(leaks[0].name).toBe("remote-token");
    expect(leaks[0].excerpt).toContain(FAKES[0].value);
  });

  test("no leak when the fake never appears", () => {
    expect(detectLeaks("status: healthy", { fakes: FAKES })).toEqual([]);
  });

  test("flags multiple distinct fakes", () => {
    const leaks = detectLeaks(`${FAKES[0].value} and ${FAKES[1].value}`, { fakes: FAKES });
    // openai-key pattern *also* fires because the second fake matches
    // /sk-[A-Za-z0-9_-]{20,}/. That's intentional; the literal-name
    // version is still reported.
    expect(leaks.some((l) => l.kind === "literal" && l.name === "remote-token")).toBe(true);
    expect(leaks.some((l) => l.kind === "literal" && l.name === "openai-key")).toBe(true);
  });

  test("ignores empty fake values (caller passed an undefined token)", () => {
    expect(detectLeaks("anything", { fakes: [{ name: "x", value: "" }] })).toEqual([]);
  });
});

describe("detectLeaks — pattern scan", () => {
  test.each([
    ["openai-sk-key", "your key is sk-AbCdEf012345Gh67890ij"],
    ["openai-proj-key", "key=sk-proj-AbCdEf012345Gh67890ij"],
    ["anthropic-api-key", "anth=sk-ant-abCdEf012345Gh67890ij"],
    ["aws-access-key-id", "id=AKIAIOSFODNN7EXAMPLE"],
    ["stripe-secret-key", "stripe=sk_live_0123456789abcdef012345"],
    ["github-personal-token", "gh=ghp_abcdef01234567890123456789012345"],
    ["github-app-token", "gh=ghs_abcdef01234567890123456789012345"],
    ["authorization-bearer", "Authorization: Bearer abcdef0123456789"],
    ["authorization-basic", "Authorization: Basic YWxhZGRpbjpvcGVuc2VzYW1l"],
    ["cookie-header", "Cookie: session=abc123def456"],
    ["jwt-token", "tok=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdef0123"],
  ])("flags %s shape", (name, sample) => {
    const leaks = detectLeaks(sample, { fakes: [] });
    expect(leaks.some((l) => l.kind === "pattern" && l.name === name)).toBe(true);
  });

  test("flags PEM private key blocks", () => {
    const pem =
      "-----BEGIN RSA PRIVATE KEY-----\nABCDEFG\nHIJKLMNOP\n-----END RSA PRIVATE KEY-----";
    const leaks = detectLeaks(pem, { fakes: [] });
    expect(leaks.some((l) => l.name === "pem-private-key")).toBe(true);
  });

  test("does NOT flag innocuous text that looks vaguely token-like", () => {
    expect(detectLeaks("session opened", { fakes: [] })).toEqual([]);
    expect(detectLeaks("auth: ok", { fakes: [] })).toEqual([]);
    expect(detectLeaks("token_env: ORACLE_REMOTE_TOKEN", { fakes: [] })).toEqual([]);
  });

  test("allowPatternNames lets a test opt out of a noisy pattern", () => {
    const sample = "Authorization: Bearer abcdef0123456789";
    expect(detectLeaks(sample, { allowPatternNames: ["authorization-bearer"] })).toEqual([]);
  });

  test("SECRET_PATTERNS catalog stays non-empty (guard against accidental deletion)", () => {
    expect(SECRET_PATTERNS.length).toBeGreaterThanOrEqual(10);
  });
});

describe("detectLeaks — forbidden-key recursion", () => {
  test("flags cookies / raw_dom / account_email at top level", () => {
    const leaks = detectLeaks(
      { cookies: ["a"], account_email: "u@x", raw_dom: "<html>" },
      { fakes: [] },
    );
    expect(leaks.some((l) => l.kind === "forbidden-key" && l.name === "cookies")).toBe(true);
    expect(leaks.some((l) => l.name === "account_email")).toBe(true);
    expect(leaks.some((l) => l.name === "raw_dom")).toBe(true);
  });

  test("flags nested forbidden keys with structural pointers", () => {
    const leaks = detectLeaks(
      { evidence: { browser: { auth_headers: { Authorization: "Bearer xyz" } } } },
      { fakes: [] },
    );
    expect(leaks.some((l) => l.kind === "forbidden-key" && l.name === "auth_headers")).toBe(true);
    expect(leaks.find((l) => l.name === "auth_headers")?.pointer).toBe(
      "/evidence/browser/auth_headers",
    );
  });

  test("flags forbidden keys inside arrays", () => {
    const leaks = detectLeaks(
      { provider_locks: [{ provider: "chatgpt", cookie: "x" }] },
      { fakes: [] },
    );
    expect(leaks.some((l) => l.name === "cookie")).toBe(true);
    expect(leaks.find((l) => l.name === "cookie")?.pointer).toBe("/provider_locks/0/cookie");
  });

  test("respects the stores_ carve-out for privacy declarations", () => {
    const leaks = detectLeaks(
      {
        evidence_privacy: {
          stores_cookies: false,
          stores_raw_dom: false,
          stores_raw_screenshots: false,
          stores_account_identifiers: false,
        },
      },
      { fakes: [] },
    );
    expect(leaks).toEqual([]);
  });

  test("respects the _sha256 / _hash carve-out for content-addressed digests", () => {
    const leaks = detectLeaks(
      { prompt_sha256: `sha256:${"a".repeat(64)}`, output_text_hash: "sha256:..." },
      { fakes: [] },
    );
    expect(leaks).toEqual([]);
  });

  test("substring attack: debug_session_token is still flagged", () => {
    const leaks = detectLeaks({ debug_session_token: "abc" }, { fakes: [] });
    expect(leaks.some((l) => l.kind === "forbidden-key")).toBe(true);
  });

  test("isForbiddenKey direct table coverage", () => {
    for (const key of FORBIDDEN_PROPERTY_KEYS) {
      expect(isForbiddenKey(key)).toBe(true);
    }
    // Carve-outs.
    expect(isForbiddenKey("stores_cookies")).toBe(false);
    expect(isForbiddenKey("prompt_sha256")).toBe(false);
    expect(isForbiddenKey("session_id_hash")).toBe(false);
    // Innocuous.
    expect(isForbiddenKey("status")).toBe(false);
    expect(isForbiddenKey("provider_locks")).toBe(false);
  });
});

describe("assertNoLeaks", () => {
  test("returns silently on a clean target", () => {
    expect(() => assertNoLeaks({ status: "healthy" }, { fakes: FAKES })).not.toThrow();
  });

  test("throws when a literal fake appears", () => {
    expect(() => assertNoLeaks(FAKES[0].value, { fakes: FAKES })).toThrow(/leak/);
  });

  test("throws when a forbidden key appears", () => {
    expect(() => assertNoLeaks({ cookies: ["a"] })).toThrow(/forbidden|leak/i);
  });

  test("summary lists multiple leaks but caps the visible count", () => {
    const target = {
      cookies: "a",
      account_email: "u@x",
      raw_dom: "<x>",
      screenshot: "s",
      auth_headers: "h",
      raw_prompt: "p",
      session_token: "t",
    };
    expect(() => assertNoLeaks(target)).toThrow(/Detected \d+ secret leak/);
  });
});

describe("detectLeaks — input formats", () => {
  test("accepts a Buffer/Uint8Array containing JSON", () => {
    const buf = Buffer.from(JSON.stringify({ cookies: ["a"] }), "utf8");
    const leaks = detectLeaks(buf);
    expect(leaks.some((l) => l.name === "cookies")).toBe(true);
  });

  test("accepts a structured object directly", () => {
    const leaks = detectLeaks({ token: "sk-abcdef0123456789abcdef" }, { fakes: [] });
    expect(leaks.some((l) => l.kind === "pattern")).toBe(true);
  });
});

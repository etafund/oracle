// Reusable secret-leak detection for the regression suite under
// tests/regression/secrets/. The detector takes a target — usually the
// stringified output of a CLI surface, a serialized envelope, or the
// raw bytes of an on-disk artifact — plus a set of caller-supplied fake
// secrets, and returns a structured list of leaks.
//
// Three orthogonal checks:
//
//   1. KNOWN FAKE VALUES — the test scaffolding labels each fake
//      secret with a stable name. If the literal value appears anywhere
//      in the target, the detector reports a leak for that name. This
//      catches the obvious "raw token went into the output" failure
//      mode.
//
//   2. GENERIC PATTERNS — regex for shapes that look like real
//      credentials in the wild (`sk-...`, `AKIA...`, `Bearer ...`,
//      PEM blocks, cookie headers). If the test seeds a real-looking
//      fake and the surface forgets to redact it, the pattern check
//      catches the slip even when the literal-name list misses it.
//
//   3. FORBIDDEN PROPERTY KEYS — when the target is a JSON-parseable
//      object, recurse and flag any property whose key matches the v18
//      evidence forbidden list (cookie, raw_dom, account_email, etc.).
//      Mirrors `FORBIDDEN_KEY_TEST` from src/oracle/v18/evidence.ts
//      without importing it (so the regression suite can compile even
//      while pane 6 evolves the surface).

export interface FakeSecret {
  /** Human-readable identifier for the leak report (`oracle-remote-token`). */
  readonly name: string;
  /** The literal value the surface MUST NOT echo back. */
  readonly value: string;
}

export interface LeakReport {
  /** Which check fired: "literal", "pattern", or "forbidden-key". */
  kind: "literal" | "pattern" | "forbidden-key";
  /** Human-readable name of the leak. */
  name: string;
  /** Pointer into the structure (`/foo/bar/0`) or "" for raw-string scans. */
  pointer: string;
  /** Excerpt around the match; trimmed to ~120 chars to keep test output short. */
  excerpt: string;
}

/** Built-in catalog of patterns that should never appear in user-visible output. */
export const SECRET_PATTERNS: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  { name: "openai-sk-key", pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { name: "openai-proj-key", pattern: /\bsk-proj-[A-Za-z0-9_-]{20,}\b/g },
  { name: "anthropic-api-key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { name: "aws-access-key-id", pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: "stripe-secret-key", pattern: /\bsk_(?:live|test)_[A-Za-z0-9]{20,}\b/g },
  { name: "github-personal-token", pattern: /\bghp_[A-Za-z0-9]{30,}\b/g },
  { name: "github-app-token", pattern: /\bghs_[A-Za-z0-9]{30,}\b/g },
  {
    name: "authorization-bearer",
    // Match `Bearer <opaque>` even when buried inside a JSON-encoded string.
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/g,
  },
  {
    name: "authorization-basic",
    pattern: /\bBasic\s+[A-Za-z0-9+/]{12,}={0,2}/g,
  },
  {
    name: "pem-private-key",
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+?-----END [A-Z ]*PRIVATE KEY-----/g,
  },
  {
    name: "cookie-header",
    // Common cookie header shape: `name=value; name2=value2`. We require at
    // least one `=` after a credential-shaped name so we do not over-flag
    // ordinary `key=value` URLs.
    pattern:
      /\b(?:session|sid|sessionid|auth|token|jwt|csrf|access_token|refresh_token)=[A-Za-z0-9._~+/=-]{4,}/gi,
  },
  {
    name: "jwt-token",
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  },
];

/** Property keys that the v18 evidence redactor strips. */
export const FORBIDDEN_PROPERTY_KEYS: ReadonlyArray<string> = [
  "cookie",
  "cookies",
  "set-cookie",
  "account_email",
  "user_email",
  "email",
  "raw_dom",
  "dom_html",
  "dom_snapshot",
  "html_snapshot",
  "screenshot",
  "screenshots",
  "auth",
  "auth_header",
  "auth_headers",
  "authorization",
  "bearer_token",
  "access_token",
  "session_token",
  "api_key",
  "raw_prompt",
  "prompt_text",
  "raw_output",
  "output_text",
  "assistant_text",
  "response_text",
  "raw_profile_path",
  "user_data_dir",
];

const FORBIDDEN_KEY_SET: ReadonlySet<string> = new Set(
  FORBIDDEN_PROPERTY_KEYS.map((k) => k.toLowerCase()),
);

/**
 * Mirror of `src/oracle/v18/evidence.ts#isForbiddenKey`, kept in-tree so
 * the detector compiles without depending on the implementation it is
 * meant to police. Carve-outs: keys starting with `stores_` are privacy
 * declarations (e.g. `stores_cookies: false`), keys ending in `_sha256`
 * / `_hash` are content-addressed digests.
 */
export function isForbiddenKey(key: string): boolean {
  const lower = key.toLowerCase();
  if (lower.startsWith("stores_")) return false;
  if (lower.endsWith("_sha256") || lower.endsWith("_hash")) return false;
  if (FORBIDDEN_KEY_SET.has(lower)) return true;
  // Substring match for prefix attacks (debug_session_token, etc.).
  for (const needle of [
    "cookie",
    "account_email",
    "raw_dom",
    "dom_html",
    "dom_snapshot",
    "html_snapshot",
    "screenshot",
    "auth_header",
    "authorization",
    "bearer_token",
    "access_token",
    "session_token",
    "api_key",
    "raw_prompt",
    "prompt_text",
    "raw_output",
    "output_text",
    "assistant_text",
    "response_text",
    "raw_profile_path",
  ]) {
    if (lower.includes(needle)) return true;
  }
  return false;
}

export interface DetectLeaksOptions {
  /** Caller-supplied fakes — literal values that must never appear. */
  readonly fakes?: ReadonlyArray<FakeSecret>;
  /** Skip the generic-pattern check (rarely useful; defaults to false). */
  readonly skipPatterns?: boolean;
  /** Skip the forbidden-key recursion (defaults to false). */
  readonly skipForbiddenKeys?: boolean;
  /**
   * Pattern names to explicitly allow even when they fire. Tests should
   * keep this empty in normal use; the option exists so individual cases
   * can opt out of a noisy pattern (e.g. literal `sk-` substrings inside
   * an unrelated reasoning_effort field).
   */
  readonly allowPatternNames?: ReadonlyArray<string>;
}

const EXCERPT_RADIUS = 40;

function excerptAround(haystack: string, index: number, length: number): string {
  const start = Math.max(0, index - EXCERPT_RADIUS);
  const end = Math.min(haystack.length, index + length + EXCERPT_RADIUS);
  return `${start === 0 ? "" : "…"}${haystack.slice(start, end)}${end === haystack.length ? "" : "…"}`;
}

function scanLiterals(haystack: string, fakes: ReadonlyArray<FakeSecret>): LeakReport[] {
  const out: LeakReport[] = [];
  for (const fake of fakes) {
    if (fake.value.length === 0) continue;
    const idx = haystack.indexOf(fake.value);
    if (idx >= 0) {
      out.push({
        kind: "literal",
        name: fake.name,
        pointer: "",
        excerpt: excerptAround(haystack, idx, fake.value.length),
      });
    }
  }
  return out;
}

function scanPatterns(haystack: string, allow: ReadonlySet<string>): LeakReport[] {
  const out: LeakReport[] = [];
  for (const { name, pattern } of SECRET_PATTERNS) {
    if (allow.has(name)) continue;
    // Each regex is `g` — reset lastIndex for safety across calls.
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(haystack)) !== null) {
      out.push({
        kind: "pattern",
        name,
        pointer: "",
        excerpt: excerptAround(haystack, match.index, match[0].length),
      });
      if (match.index === pattern.lastIndex) pattern.lastIndex += 1;
    }
  }
  return out;
}

function scanForbiddenKeys(value: unknown, pointer: string): LeakReport[] {
  if (value === null || typeof value !== "object") return [];
  if (Array.isArray(value)) {
    return value.flatMap((entry, idx) => scanForbiddenKeys(entry, `${pointer}/${idx}`));
  }
  const out: LeakReport[] = [];
  for (const [key, child] of Object.entries(value)) {
    const childPointer = `${pointer}/${key}`;
    if (isForbiddenKey(key)) {
      out.push({
        kind: "forbidden-key",
        name: key,
        pointer: childPointer,
        excerpt: `(forbidden property "${key}")`,
      });
    }
    out.push(...scanForbiddenKeys(child, childPointer));
  }
  return out;
}

/**
 * Scan an arbitrary target for secret leaks. The target can be a
 * string, a buffer-like with `toString`, or a structured object — the
 * detector handles all three uniformly.
 */
export function detectLeaks(target: unknown, options: DetectLeaksOptions = {}): LeakReport[] {
  const allow = new Set(options.allowPatternNames ?? []);
  const fakes = options.fakes ?? [];

  let asString: string;
  let asObject: unknown;
  if (typeof target === "string") {
    asString = target;
    try {
      asObject = JSON.parse(target);
    } catch {
      asObject = undefined;
    }
  } else if (target instanceof Uint8Array || Buffer.isBuffer(target)) {
    asString = target.toString();
    try {
      asObject = JSON.parse(asString);
    } catch {
      asObject = undefined;
    }
  } else {
    asObject = target;
    asString = JSON.stringify(target);
  }

  const out: LeakReport[] = [];
  out.push(...scanLiterals(asString, fakes));
  if (!options.skipPatterns) out.push(...scanPatterns(asString, allow));
  if (!options.skipForbiddenKeys && asObject !== undefined) {
    out.push(...scanForbiddenKeys(asObject, ""));
  }
  return out;
}

/**
 * Assert that `target` contains no detected leaks. Throws on the first
 * leak so the test failure points at the offending surface, not at a
 * generic "leak found" message.
 */
export function assertNoLeaks(target: unknown, options: DetectLeaksOptions = {}): void {
  const leaks = detectLeaks(target, options);
  if (leaks.length === 0) return;
  const summary = leaks
    .slice(0, 5)
    .map((leak) => `  - [${leak.kind}] ${leak.name}@${leak.pointer || "(string)"}: ${leak.excerpt}`)
    .join("\n");
  const overflow = leaks.length > 5 ? `\n  …and ${leaks.length - 5} more` : "";
  throw new Error(`Detected ${leaks.length} secret leak(s):\n${summary}${overflow}`);
}

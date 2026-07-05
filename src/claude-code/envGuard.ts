export type AnthropicModelEnvPolicy = "warn-and-scrub" | "refuse";

export interface ClaudeCodeEnvWarning {
  source: string;
  action: "omitted_from_child_env";
  reason: string;
}

export interface ClaudeCodePreparedEnvironment {
  childEnv: Record<string, string>;
  warnings: ClaudeCodeEnvWarning[];
  scrubbedSources: string[];
}

export interface PrepareClaudeCodeEnvironmentOptions {
  anthropicModelPolicy?: AnthropicModelEnvPolicy;
  extraAllowedKeys?: string[];
}

export class ClaudeCodeEnvGuardError extends Error {
  readonly sources: string[];

  constructor(sources: string[]) {
    super(formatEnvGuardMessage(sources));
    this.name = "ClaudeCodeEnvGuardError";
    this.sources = [...sources];
  }
}

const BLOCKED_EXACT_ENV_NAMES = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_ANTHROPIC_AWS",
] as const;

const BLOCKED_PREFIXES = ["ANTHROPIC_DEFAULT_"] as const;
const MODEL_DEFAULT_ENV_NAMES = ["ANTHROPIC_MODEL"] as const;

const DEFAULT_CHILD_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "USER",
  "USERNAME",
  "SHELL",
  "TERM",
  "COLORTERM",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  "TEMP",
  "TMP",
  "NO_COLOR",
  "FORCE_COLOR",
  "CI",
  "ORACLE_HOME_DIR",
  // Aggregate inline-bytes budget for this lane (claude-provider-map.md
  // finding #1); a size threshold, not a secret. Now actually read on the
  // parent side by `resolveClaudeCodeMaxInlineBytes`
  // (`claude-code/inlineBudget.ts`), which gates both the pre-spawn
  // aggregate input check and the existing post-spawn output-flood
  // detector — previously allowlisted here but never consumed anywhere.
  "ORACLE_CLAUDE_CODE_MAX_INLINE_BYTES",
  // Opt-in `caam shallow-spawn` profile name (caam-map.md §4a/§4b). This is
  // an argv-derived selector, not a secret — the same value is also passed
  // as a `caam shallow-spawn <profile>` argv token, never as a credential —
  // so allowlisting it here is consistent with `ORACLE_HOME_DIR` above.
  "ORACLE_CLAUDE_CODE_CAAM_PROFILE",
] as const;

export function prepareClaudeCodeEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  options: PrepareClaudeCodeEnvironmentOptions = {},
): ClaudeCodePreparedEnvironment {
  const blockedSources = findBlockedClaudeCodeEnvironmentSources(env, options);
  if (blockedSources.length > 0) {
    throw new ClaudeCodeEnvGuardError(blockedSources);
  }

  const warnings: ClaudeCodeEnvWarning[] = [];
  const scrubbedSources: string[] = [];
  const policy = options.anthropicModelPolicy ?? "warn-and-scrub";
  for (const modelKey of findCaseInsensitiveMatches(env, MODEL_DEFAULT_ENV_NAMES)) {
    if (policy === "warn-and-scrub") {
      warnings.push({
        source: modelKey,
        action: "omitted_from_child_env",
        reason:
          "Claude Code argv model precedence is verified for the hidden-alpha contract; the model-default env var is omitted from the child environment defensively.",
      });
      scrubbedSources.push(modelKey);
    }
  }

  return {
    childEnv: buildAllowedChildEnvironment(env, options.extraAllowedKeys ?? []),
    warnings,
    scrubbedSources,
  };
}

export function findBlockedClaudeCodeEnvironmentSources(
  env: NodeJS.ProcessEnv,
  options: PrepareClaudeCodeEnvironmentOptions = {},
): string[] {
  const blocked = new Set<string>();
  for (const key of findCaseInsensitiveMatches(env, BLOCKED_EXACT_ENV_NAMES)) {
    blocked.add(key);
  }

  for (const key of Object.keys(env)) {
    const upper = key.toUpperCase();
    if (BLOCKED_PREFIXES.some((prefix) => upper.startsWith(prefix))) {
      blocked.add(key);
    }
  }

  const policy = options.anthropicModelPolicy ?? "warn-and-scrub";
  if (policy === "refuse") {
    for (const key of findCaseInsensitiveMatches(env, MODEL_DEFAULT_ENV_NAMES)) {
      blocked.add(key);
    }
  }

  return [...blocked].sort((a, b) => a.localeCompare(b));
}

function buildAllowedChildEnvironment(
  env: NodeJS.ProcessEnv,
  extraAllowedKeys: string[],
): Record<string, string> {
  const allowed = new Set(
    [...DEFAULT_CHILD_ENV_ALLOWLIST, ...extraAllowedKeys].map((key) => key.toUpperCase()),
  );
  const childEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      continue;
    }
    const upper = key.toUpperCase();
    if (!allowed.has(upper)) {
      continue;
    }
    if (upper.startsWith("ANTHROPIC_") || upper.startsWith("CLAUDE_CODE_USE_")) {
      continue;
    }
    childEnv[canonicalEnvKey(key)] = value;
  }
  return childEnv;
}

function findCaseInsensitiveMatches(
  env: NodeJS.ProcessEnv,
  expectedNames: readonly string[],
): string[] {
  const expected = new Set(expectedNames.map((name) => name.toUpperCase()));
  return Object.keys(env).filter((key) => expected.has(key.toUpperCase()));
}

function canonicalEnvKey(key: string): string {
  const upper = key.toUpperCase();
  const known = DEFAULT_CHILD_ENV_ALLOWLIST.find((name) => name === upper);
  return known ?? key;
}

function formatEnvGuardMessage(sources: readonly string[]): string {
  if (sources.some((source) => source.toUpperCase() === "ANTHROPIC_API_KEY")) {
    return [
      "Claude Code subscription mode refused because ANTHROPIC_API_KEY is set.",
      "Claude Code would use API billing instead of subscription usage.",
      'Fix: unset ANTHROPIC_API_KEY, then retry: oracle -p "<prompt>" --lane fable-local',
      "(or choose one of the other reviewed lanes: --lane chatgpt-pro / --lane gemini-deep-think, which never read this variable).",
    ].join("\n");
  }

  const listedSources = sources.join(", ");
  return [
    `Claude Code subscription mode refused because ${listedSources} could route this run through API/provider billing.`,
    `Fix: unset ${sources.join(" ")}, then retry: oracle -p "<prompt>" --lane fable-local`,
  ].join("\n");
}

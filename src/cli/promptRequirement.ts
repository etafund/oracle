import { PromptValidationError } from "../oracle/errors.js";

/**
 * A bare single-token positional was refused (fail-closed) because it looks
 * like a mistyped command rather than a prompt. Carries `exitCode = 2` (usage
 * refusal; no backend started) and a `fix_command` telling the caller how to
 * force it as a literal prompt, so the top-level `--json` envelope and human
 * output both teach the exact recovery.
 */
export class BarePositionalPromptError extends PromptValidationError {
  readonly exitCode = 2;

  constructor(message: string, details?: Record<string, unknown>) {
    super(message, { stage: "prompt_looks_like_command", ...details });
    this.name = "BarePositionalPromptError";
  }
}

interface PromptCheckOptions {
  prompt?: string;
  session?: string;
  execSession?: string;
  finalizeSession?: string;
  status?: boolean;
  debugHelp?: boolean;
  route?: boolean;
  preflight?: boolean;
  renderMarkdown?: boolean;
  preview?: boolean | string;
  dryRun?: boolean;
}

/**
 * Determine whether the CLI should enforce a prompt requirement based on raw args and options.
 */
export function shouldRequirePrompt(rawArgs: string[], options: PromptCheckOptions): boolean {
  if (rawArgs.length === 0) {
    return !options.prompt;
  }
  const firstArg = rawArgs[0];
  const bypassPrompt = Boolean(
    options.session ||
    options.execSession ||
    options.finalizeSession ||
    options.status ||
    options.debugHelp ||
    options.route ||
    options.preflight ||
    firstArg === "follow-up" ||
    firstArg === "status" ||
    firstArg === "session",
  );

  const requiresPrompt =
    options.renderMarkdown || Boolean(options.preview) || Boolean(options.dryRun) || !bypassPrompt;
  return requiresPrompt && !options.prompt;
}

/**
 * Fail-CLOSED guard against a bare positional that is almost certainly a
 * mistyped command rather than a prompt. Every documented run passes its prompt
 * via `-p`/`--prompt`/`--prompt-file`/stdin, and real prompts are effectively
 * always multi-word. A prompt taken from a *bare positional* that is a single
 * whitespace-free token (`oracle lanes`, `oracle models`, `oracle login`,
 * `oracle statuss`) is therefore treated as suspicious and refused, so it can
 * never silently launch a paid reviewed-lane run (the `oracle lanes` incident).
 *
 * The caller is responsible for only passing a token that genuinely originated
 * from a bare positional (not `-p`/`--prompt`/`--prompt-file`, and not the `-`
 * stdin sentinel); this predicate only decides whether such a token looks like
 * a prompt or a command.
 */
export function isSuspiciousBarePositionalPrompt(token: string | undefined): token is string {
  if (typeof token !== "string") return false;
  const trimmed = token.trim();
  if (trimmed.length === 0) return false;
  // A token starting with "-" is never a mistyped command name (commands never
  // start with a dash) — it is a flag-shaped literal operand (e.g. passed after
  // a `--` delimiter), so it is not suspicious.
  if (trimmed.startsWith("-")) return false;
  // Single whitespace-free token only. Multi-word text (contains whitespace) is
  // a real prompt; `-p`/`--prompt` prompts never reach this guard.
  return !/\s/.test(trimmed);
}

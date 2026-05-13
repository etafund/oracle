export type EvidenceLedgerAppendMetadata = Record<string, unknown>;

export const EVIDENCE_LEDGER_APPEND_REDACTED = "[redacted]" as const;

const SENSITIVE_KEY_PATTERN =
  /(?:authorization|auth[_-]?token|cookie|cookies|password|passphrase|raw[_-]?(?:dom|prompt|output)|secret|screenshot|token|api[_-]?key|hidden[_-]?reasoning|prompt[_-]?text|output[_-]?text|private[_-]?key)/i;

const HASH_KEY_PATTERN = /(?:^|_)(?:hash|sha256|checksum|digest)$/i;
const SHA256_VALUE_PATTERN = /^(?:sha256:)?[a-f0-9]{64}$/i;

const BEARER_TOKEN_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const SECRET_TOKEN_PATTERN =
  /\b(?:sk|pk|rk|xox[baprs]?|gh[pousr]|glpat|AKIA)[-_]?[A-Za-z0-9_=-]{8,}\b/g;
const JWT_PATTERN = /\b[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\b/g;
const SECRET_ASSIGNMENT_PATTERN =
  /\b([A-Za-z0-9_.-]*(?:authorization|auth[_-]?token|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|token|secret|session|cookie|raw[_-]?(?:prompt|output)|prompt[_-]?text|output[_-]?text|hidden[_-]?reasoning|screenshot|password|passphrase)[A-Za-z0-9_.-]*)=([^;&\s]+)/gi;
const DATA_IMAGE_PATTERN = /data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]{8,}/gi;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function sanitizeEvidenceLedgerAppendMetadata<T extends EvidenceLedgerAppendMetadata>(
  metadata: T,
): T {
  return sanitizeStructuredValue(metadata) as T;
}

export function sanitizeEvidenceLedgerAppendValue(value: unknown, key?: string): unknown {
  return sanitizeStructuredValue(value, key);
}

function sanitizeStructuredValue(value: unknown, key?: string): unknown {
  if (key && shouldRedactKey(key, value)) {
    return EVIDENCE_LEDGER_APPEND_REDACTED;
  }

  if (typeof value === "string") {
    return maskSensitiveString(value);
  }

  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeStructuredValue(entry));
  }

  if (isPlainObject(value)) {
    const sanitized: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      sanitized[childKey] = sanitizeStructuredValue(childValue, childKey);
    }
    return sanitized;
  }

  return value;
}

function shouldRedactKey(key: string, value: unknown): boolean {
  if (typeof value === "string" && HASH_KEY_PATTERN.test(key) && SHA256_VALUE_PATTERN.test(value)) {
    return false;
  }
  return SENSITIVE_KEY_PATTERN.test(key);
}

function maskSensitiveString(value: string): string {
  return value
    .replace(BEARER_TOKEN_PATTERN, "Bearer [redacted]")
    .replace(SECRET_TOKEN_PATTERN, EVIDENCE_LEDGER_APPEND_REDACTED)
    .replace(JWT_PATTERN, EVIDENCE_LEDGER_APPEND_REDACTED)
    .replace(DATA_IMAGE_PATTERN, "data:image/[redacted]")
    .replace(SECRET_ASSIGNMENT_PATTERN, "$1=[redacted]");
}

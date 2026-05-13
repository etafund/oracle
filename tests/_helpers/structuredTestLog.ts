import fs from "node:fs/promises";
import path from "node:path";

export interface StructuredTestLogRecord {
  timestamp: string;
  test_name: string;
  phase: string;
  evidence_pointer: string;
  metadata?: Record<string, unknown>;
}

export interface StructuredTestLogOptions {
  testName: string;
  evidencePointer: string;
  emit?: (line: string) => void;
  now?: () => Date | string;
}

const SENSITIVE_KEY_PATTERN =
  /(^|_)(authorization|cookie|cookies|password|raw_dom|raw_prompt|raw_output|secret|screenshot|token)(_|$)|api[_-]?key|hidden[_-]?reasoning|prompt[_-]?text|output[_-]?text/i;
const SENSITIVE_VALUE_PATTERN = /\b(Bearer\s+\S+|sk-[A-Za-z0-9_-]{8,}|xox[baprs]-\S+)\b/i;

export function createStructuredTestLog(options: StructuredTestLogOptions) {
  const records: StructuredTestLogRecord[] = [];

  const record = (
    phase: string,
    metadata?: Record<string, unknown>,
    evidencePointer = options.evidencePointer,
  ): StructuredTestLogRecord => {
    if (!options.testName.trim()) {
      throw new Error("structured test logs require a test name.");
    }
    if (!phase.trim()) {
      throw new Error("structured test logs require a phase.");
    }
    if (!evidencePointer.trim()) {
      throw new Error("structured test logs require an evidence pointer.");
    }
    const timestampValue = options.now ? options.now() : new Date();
    const entry: StructuredTestLogRecord = {
      timestamp:
        timestampValue instanceof Date ? timestampValue.toISOString() : String(timestampValue),
      test_name: options.testName,
      phase,
      evidence_pointer: evidencePointer,
      ...(metadata ? { metadata: redactStructuredTestMetadata(metadata) } : {}),
    };
    records.push(entry);
    options.emit?.(JSON.stringify(entry));
    return entry;
  };

  return {
    record,
    records: () => records.slice(),
    jsonLines: () => records.map((entry) => JSON.stringify(entry)),
    async writeJsonl(filePath: string): Promise<void> {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      const contents = records.map((entry) => JSON.stringify(entry)).join("\n");
      await fs.writeFile(filePath, contents.length ? `${contents}\n` : "", "utf8");
    },
  };
}

export function assertStructuredTestLogRecords(records: StructuredTestLogRecord[]): void {
  if (records.length === 0) {
    throw new Error("structured test log must contain at least one record.");
  }
  for (const record of records) {
    if (!record.timestamp || Number.isNaN(Date.parse(record.timestamp))) {
      throw new Error("structured test log record has an invalid timestamp.");
    }
    if (!record.test_name.trim()) {
      throw new Error("structured test log record is missing test_name.");
    }
    if (!record.phase.trim()) {
      throw new Error("structured test log record is missing phase.");
    }
    if (!record.evidence_pointer.trim()) {
      throw new Error("structured test log record is missing evidence_pointer.");
    }
  }
}

export function redactStructuredTestMetadata<T>(value: T): T {
  return redactValue(value, undefined) as T;
}

function redactValue(value: unknown, key: string | undefined): unknown {
  if (key && SENSITIVE_KEY_PATTERN.test(key)) {
    return "[redacted]";
  }
  if (typeof value === "string") {
    return SENSITIVE_VALUE_PATTERN.test(value) ? "[redacted]" : value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactValue(entry, key));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        redactValue(entryValue, entryKey),
      ]),
    );
  }
  return value;
}

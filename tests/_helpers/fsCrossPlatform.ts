import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  ARTIFACT_INDEX_SCHEMA_VERSION,
  BROWSER_EVIDENCE_SCHEMA_VERSION,
  V18_BUNDLE_VERSION,
  type ArtifactIndex,
} from "@src/oracle/v18/index.ts";

export type RequirementLevel = "MUST" | "SHOULD";

export interface FsSafetyRequirement {
  readonly id: string;
  readonly level: RequirementLevel;
  readonly surface: "lease" | "evidence" | "filesystem";
  readonly requirement: string;
}

export const FS_SAFETY_REQUIREMENTS: readonly FsSafetyRequirement[] = [
  {
    id: "fs-path-segments",
    level: "MUST",
    surface: "filesystem",
    requirement:
      "Path helpers preserve the sessions, evidence, quarantine, and provider-lock segments across POSIX, macOS, WSL, and Windows-style roots.",
  },
  {
    id: "safe-relative-artifact-index",
    level: "MUST",
    surface: "evidence",
    requirement:
      "Evidence artifact indexes store relative artifact paths only; no absolute paths, drive letters, UNC roots, NUL bytes, or parent traversal entries.",
  },
  {
    id: "lease-stale-lock-preservation",
    level: "MUST",
    surface: "lease",
    requirement:
      "Stale browser leases are surfaced to callers and acquisition failures do not mutate the existing lock file.",
  },
  {
    id: "same-directory-commit",
    level: "SHOULD",
    surface: "lease",
    requirement:
      "Lease writes commit through a same-directory file so successful writes do not leave temporary lock artifacts behind.",
  },
  {
    id: "fsync-probe",
    level: "SHOULD",
    surface: "filesystem",
    requirement:
      "The test harness records whether the active filesystem supports file and directory fsync calls used by durable-write implementations.",
  },
] as const;

export interface RepresentativePathCase {
  readonly name: string;
  readonly flavor: "posix" | "win32";
  readonly root: string;
}

export const REPRESENTATIVE_HOME_PATHS: readonly RepresentativePathCase[] = [
  {
    name: "linux-posix-with-space",
    flavor: "posix",
    root: "/var/tmp/oracle home",
  },
  {
    name: "macos-application-support",
    flavor: "posix",
    root: "/Users/Ada Lovelace/Library/Application Support/oracle",
  },
  {
    name: "wsl-mounted-windows-home",
    flavor: "posix",
    root: "/mnt/c/Users/Ada Lovelace/.oracle",
  },
  {
    name: "windows-drive-letter",
    flavor: "win32",
    root: String.raw`C:\Users\Ada Lovelace\AppData\Roaming\oracle`,
  },
  {
    name: "windows-unc-share",
    flavor: "win32",
    root: String.raw`\\server\share\Oracle Home`,
  },
] as const;

export function representativeJoin(
  entry: RepresentativePathCase,
  ...segments: readonly string[]
): string {
  const pathApi = entry.flavor === "win32" ? path.win32 : path.posix;
  return pathApi.join(entry.root, ...segments);
}

export function pathParts(value: string): string[] {
  return value.split(/[\\/]+/).filter((part) => part.length > 0);
}

export function isSafePortableFilename(value: string): boolean {
  return (
    value.length > 0 &&
    value !== "." &&
    value !== ".." &&
    !value.includes("/") &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    !/[<>:"|?*]/.test(value)
  );
}

export function isSafeRelativeArtifactPath(value: string): boolean {
  if (value.length === 0 || value.includes("\0")) return false;
  if (path.isAbsolute(value) || path.win32.isAbsolute(value)) return false;
  const parts = pathParts(value);
  return parts.length > 0 && parts.every((part) => part !== "." && part !== "..");
}

export function isPathUnderRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

export interface FsSafetyTempDir {
  readonly root: string;
  readonly homeDir: string;
  readonly leaseDir: string;
}

export async function withFsSafetyTempDir<T>(
  prefix: string,
  fn: (dirs: FsSafetyTempDir) => Promise<T>,
): Promise<T> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const homeDir = path.join(root, "Oracle Home With Spaces");
  const leaseDir = path.join(root, "Browser Leases With Spaces");
  try {
    await fs.mkdir(homeDir, { recursive: true });
    await fs.mkdir(leaseDir, { recursive: true });
    return await fn({ root, homeDir, leaseDir });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

export async function makeLongButPortableDir(
  root: string,
  leaf = "Portable Long Path With Spaces",
): Promise<string> {
  let current = path.join(root, leaf);
  const targetLength = Math.min(Math.max(root.length + 96, 150), 220);
  let index = 0;
  while (current.length < targetLength) {
    current = path.join(current, `segment-${String(index).padStart(2, "0")}`);
    index += 1;
  }
  await fs.mkdir(current, { recursive: true });
  return current;
}

export interface FsyncProbeResult {
  readonly file: "synced";
  readonly directory: "synced" | "unsupported";
}

export async function probeFsyncSemantics(dir: string): Promise<FsyncProbeResult> {
  await fs.mkdir(dir, { recursive: true });
  const probeFile = path.join(dir, "fsync-probe.json");
  const fileHandle = await fs.open(probeFile, "w");
  try {
    await fileHandle.writeFile('{"ok":true}\n', "utf8");
    await fileHandle.sync();
  } finally {
    await fileHandle.close();
  }

  let directory: FsyncProbeResult["directory"] = "unsupported";
  if (process.platform !== "win32") {
    try {
      const dirHandle = await fs.open(dir, "r");
      try {
        await dirHandle.sync();
        directory = "synced";
      } finally {
        await dirHandle.close();
      }
    } catch {
      directory = "unsupported";
    }
  }

  return { file: "synced", directory };
}

export async function readJsonFile<T>(file: string): Promise<T> {
  return JSON.parse(await fs.readFile(file, "utf8")) as T;
}

export function buildArtifactIndex(
  artifacts: ArtifactIndex["artifacts"],
  runId = "run-fs-safety",
): ArtifactIndex {
  return {
    schema_version: ARTIFACT_INDEX_SCHEMA_VERSION,
    bundle_version: V18_BUNDLE_VERSION,
    run_id: runId,
    artifacts,
  };
}

export function buildBrowserEvidenceFixture(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    available_effort_labels_hash: `sha256:${"a".repeat(64)}`,
    browser_effort_strategy: "select_highest_visible",
    bundle_version: V18_BUNDLE_VERSION,
    capture_confidence: "high",
    created_at: "2026-05-12T00:00:10Z",
    effort_rank: "highest_visible",
    evidence_id: "evidence-fs-safety",
    evidence_privacy: {
      stores_account_identifiers: false,
      stores_cookies: false,
      stores_raw_dom: false,
      stores_raw_screenshots: false,
    },
    failure_code: null,
    fix_command: null,
    mode_verified: true,
    next_command: null,
    observed_reasoning_effort_label: "Heavy",
    output_text_sha256: `sha256:${"b".repeat(64)}`,
    prompt_sha256: `sha256:${"c".repeat(64)}`,
    prompt_submitted_at: "2026-05-12T00:00:05Z",
    provider: "chatgpt",
    provider_result_id: "provider-result-fs-safety",
    provider_slot: "chatgpt_pro_first_plan",
    reasoning_effort_verified: true,
    redaction_policy: "redacted",
    requested_mode: "pro_extended_reasoning",
    requested_reasoning_effort: "max_browser_available",
    run_id: "run-fs-safety",
    schema_version: BROWSER_EVIDENCE_SCHEMA_VERSION,
    selected_effort_is_highest_visible: true,
    selector_manifest_version: "chatgpt-pro-v1",
    session_id_hash: `sha256:${"d".repeat(64)}`,
    transition_log_sha256: `sha256:${"e".repeat(64)}`,
    unsafe_artifacts_quarantined: true,
    verification_method: "same_session_ui_observation_plus_selector_trace",
    verification_scope: "same_browser_session_before_prompt_submit",
    verified_at: "2026-05-12T00:00:00Z",
    verified_before_prompt_submit: true,
    ...overrides,
  };
}

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";

import {
  ARTIFACT_INDEX_SCHEMA_VERSION,
  canonicalJSON,
  evidenceDir,
  evidenceFilePath,
  evidenceIndexPath,
  listIndexedEvidence,
  listQuarantinedEvidence,
  quarantineDir,
  quarantineFilePath,
  quarantineIndexPath,
  readArtifactIndex,
  sha256OfBytes,
  writeArtifactIndex,
  writeEvidence,
} from "@src/oracle/v18/index.ts";

import {
  FS_SAFETY_REQUIREMENTS,
  REPRESENTATIVE_HOME_PATHS,
  buildArtifactIndex,
  buildBrowserEvidenceFixture,
  isPathUnderRoot,
  isSafeRelativeArtifactPath,
  makeLongButPortableDir,
  pathParts,
  probeFsyncSemantics,
  readJsonFile,
  representativeJoin,
  withFsSafetyTempDir,
} from "../_helpers/fsCrossPlatform.js";

describe("evidence filesystem safety conformance", () => {
  test("coverage matrix includes evidence and filesystem requirements", () => {
    const bySurface = new Set(FS_SAFETY_REQUIREMENTS.map((entry) => entry.surface));
    expect(bySurface).toEqual(new Set(["lease", "evidence", "filesystem"]));
    expect(FS_SAFETY_REQUIREMENTS.filter((entry) => entry.level === "MUST")).toHaveLength(3);
  });

  test.each(REPRESENTATIVE_HOME_PATHS)(
    "path helpers preserve evidence layout segments for $name",
    (entry) => {
      const homeDir = representativeJoin(entry, "Nested Oracle Home");
      const sessionId = "session with spaces-01";
      const evidenceId = "evidence-edge_01.abc";

      expect(pathParts(evidenceDir(sessionId, homeDir)).slice(-3)).toEqual([
        "sessions",
        sessionId,
        "evidence",
      ]);
      expect(pathParts(evidenceFilePath(sessionId, evidenceId, homeDir)).slice(-4)).toEqual([
        "sessions",
        sessionId,
        "evidence",
        `${evidenceId}.json`,
      ]);
      expect(pathParts(evidenceIndexPath(sessionId, homeDir)).slice(-4)).toEqual([
        "sessions",
        sessionId,
        "evidence",
        "index.json",
      ]);
      expect(pathParts(quarantineDir(sessionId, homeDir)).slice(-4)).toEqual([
        "sessions",
        sessionId,
        "evidence",
        "quarantine",
      ]);
      expect(pathParts(quarantineFilePath(sessionId, evidenceId, homeDir)).slice(-5)).toEqual([
        "sessions",
        sessionId,
        "evidence",
        "quarantine",
        `${evidenceId}.json`,
      ]);
      expect(pathParts(quarantineIndexPath(sessionId, homeDir)).slice(-5)).toEqual([
        "sessions",
        sessionId,
        "evidence",
        "quarantine",
        "index.json",
      ]);
    },
  );

  test("rejects traversal and path separator edge cases before evidence paths are built", () => {
    for (const unsafeSessionId of ["", ".", "..", "nested/session", "nested\\session", "bad\0id"]) {
      expect(() => evidenceDir(unsafeSessionId, "/tmp/oracle")).toThrow(/Invalid session id/);
    }

    for (const unsafeEvidenceId of [
      "",
      ".hidden",
      "../escape",
      "..\\escape",
      "safe..unsafe",
      "bad/id",
      "bad\\id",
      `a${"b".repeat(128)}`,
    ]) {
      expect(() => evidenceFilePath("session-safe", unsafeEvidenceId, "/tmp/oracle")).toThrow(
        /Invalid evidence id/,
      );
    }
  });

  test("writes redacted evidence under a long portable home and stores only relative artifact references", async () => {
    await withFsSafetyTempDir("oracle-evidence-fs-", async ({ root }) => {
      const homeDir = await makeLongButPortableDir(root, "Oracle Home With Spaces");
      const sessionId = "session with spaces-01";
      const evidenceId = `evidence-${"a".repeat(119)}`;
      const evidence = buildBrowserEvidenceFixture({
        evidence_id: evidenceId,
        run_id: "run-fs-safety-long-path",
        provider_result_id: "provider result with spaces",
      });

      const written = await writeEvidence(sessionId, evidence, {
        homeDir,
        runId: "run-fs-safety-long-path",
      });

      expect(written.quarantined).toBe(false);
      expect(written.indexed).toBe(true);
      expect(isPathUnderRoot(homeDir, written.path)).toBe(true);
      expect(pathParts(written.path).slice(-4)).toEqual([
        "sessions",
        sessionId,
        "evidence",
        `${evidenceId}.json`,
      ]);

      const onDisk = await readJsonFile<Record<string, unknown>>(written.path);
      expect(onDisk.evidence_id).toBe(evidenceId);
      expect(onDisk.provider_result_id).toBe("provider result with spaces");

      const rawEvidenceBytes = await readFile(written.path, "utf8");
      const index = await readArtifactIndex(evidenceIndexPath(sessionId, homeDir));
      expect(index).not.toBeNull();
      expect(index!.schema_version).toBe(ARTIFACT_INDEX_SCHEMA_VERSION);
      expect(index!.run_id).toBe("run-fs-safety-long-path");
      expect(index!.artifacts).toHaveLength(1);

      const entry = index!.artifacts[0];
      expect(entry.artifact_id).toBe(evidenceId);
      expect(entry.kind).toBe("browser_evidence");
      expect(entry.path).toBe(`${evidenceId}.json`);
      expect(isSafeRelativeArtifactPath(entry.path)).toBe(true);
      expect(sha256OfBytes(rawEvidenceBytes.trimEnd())).toBe(entry.sha256);
      expect(await listIndexedEvidence(sessionId, homeDir)).toEqual([entry]);
    });
  });

  test("quarantined unsafe evidence keeps a separate relative artifact index", async () => {
    await withFsSafetyTempDir("oracle-evidence-quarantine-", async ({ homeDir }) => {
      const sessionId = "session quarantine with spaces";
      const evidenceId = "unsafe-debug-01";
      const unsafeEvidence = buildBrowserEvidenceFixture({
        evidence_id: evidenceId,
        redaction_policy: "unsafe_debug",
        run_id: "run-fs-safety-quarantine",
      });

      const written = await writeEvidence(sessionId, unsafeEvidence, {
        homeDir,
        runId: "run-fs-safety-quarantine",
      });

      expect(written.quarantined).toBe(true);
      expect(written.indexed).toBe(false);
      expect(isPathUnderRoot(quarantineDir(sessionId, homeDir), written.path)).toBe(true);
      expect(await readArtifactIndex(evidenceIndexPath(sessionId, homeDir))).toBeNull();
      expect(await listIndexedEvidence(sessionId, homeDir)).toEqual([]);

      const quarantineIndex = await readArtifactIndex(quarantineIndexPath(sessionId, homeDir));
      expect(quarantineIndex).not.toBeNull();
      expect(quarantineIndex!.run_id).toBe("run-fs-safety-quarantine");
      expect(quarantineIndex!.artifacts).toHaveLength(1);
      expect(quarantineIndex!.artifacts[0]).toMatchObject({
        artifact_id: evidenceId,
        kind: "browser_evidence",
        path: `${evidenceId}.json`,
      });
      expect(isSafeRelativeArtifactPath(quarantineIndex!.artifacts[0].path)).toBe(true);
      expect(await listQuarantinedEvidence(sessionId, homeDir)).toEqual(
        quarantineIndex!.artifacts,
      );
    });
  });

  test("artifact index rewrites remain parseable and the active filesystem supports file sync probes", async () => {
    await withFsSafetyTempDir("oracle-evidence-index-", async ({ homeDir }) => {
      const indexFile = evidenceIndexPath("session index with spaces", homeDir);
      const first = buildArtifactIndex(
        [
          {
            artifact_id: "first",
            kind: "browser_evidence",
            path: "first.json",
            sha256: `sha256:${"1".repeat(64)}`,
          },
        ],
        "run-first",
      );
      const second = buildArtifactIndex(
        [
          {
            artifact_id: "second",
            kind: "browser_evidence",
            path: "second.json",
            sha256: `sha256:${"2".repeat(64)}`,
          },
        ],
        "run-second",
      );

      await writeArtifactIndex(indexFile, first);
      await writeArtifactIndex(indexFile, second);

      const raw = await readFile(indexFile, "utf8");
      expect(raw.endsWith("\n")).toBe(true);
      expect(raw.trimEnd()).toBe(canonicalJSON(second));
      expect(await readArtifactIndex(indexFile)).toEqual(second);
      expect((await readdir(path.dirname(indexFile))).filter((name) => name.includes(".tmp"))).toEqual(
        [],
      );

      const fsync = await probeFsyncSemantics(path.join(homeDir, "fsync probe"));
      expect(fsync.file).toBe("synced");
      expect(["synced", "unsupported"]).toContain(fsync.directory);
    });
  });
});

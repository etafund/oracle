import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { buildMarkdownBundle } from "../../../src/cli/markdownBundle.ts";
import { readFiles } from "../../../src/oracle/files.ts";

type Result = Record<string, unknown>;

const rel = (root: string, filePath: string) =>
  path.relative(root, filePath).split(path.sep).join("/");

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-bundle-harness-"));
  const results: Result = {};

  try {
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await fs.mkdir(path.join(root, "docs"), { recursive: true });
    await fs.mkdir(path.join(root, "node_modules", "pkg"), { recursive: true });

    await fs.writeFile(path.join(root, ".gitignore"), "secret.txt\n", "utf8");
    await fs.writeFile(path.join(root, ".env"), "OPENAI_API_KEY=should-not-leak\n", "utf8");
    await fs.writeFile(path.join(root, "secret.txt"), "ignored-by-gitignore\n", "utf8");
    await fs.writeFile(path.join(root, "src", "app.ts"), "export const answer = 42;\n", "utf8");
    await fs.writeFile(path.join(root, "docs", "readme.md"), "# docs\n", "utf8");
    await fs.writeFile(path.join(root, "node_modules", "pkg", "index.js"), "module.exports = 1;\n", "utf8");
    await fs.writeFile(path.join(root, "binary.bin"), Buffer.from([0, 159, 146, 150, 255]));

    const filtered = await readFiles(["**/*", "!docs/**"], {
      cwd: root,
      maxFileSizeBytes: 1024,
    });
    results.filteredPaths = filtered.map((file) => rel(root, file.path)).sort();
    results.filteredIncludesBinary = filtered.some((file) => rel(root, file.path) === "binary.bin");
    results.filteredBinaryPreview = filtered.find((file) => rel(root, file.path) === "binary.bin")
      ?.content;

    const explicitEnv = await readFiles([".env"], {
      cwd: root,
      maxFileSizeBytes: 1024,
    });
    results.explicitEnvPaths = explicitEnv.map((file) => rel(root, file.path)).sort();
    results.explicitEnvContentLength = explicitEnv[0]?.content.length ?? 0;

    try {
      await readFiles(["src/app.ts"], { cwd: root, maxFileSizeBytes: 2 });
      results.oversizeError = "missing";
    } catch (error) {
      results.oversizeError = error instanceof Error ? error.message : String(error);
    }

    const bundle = await buildMarkdownBundle(
      {
        prompt: "Review only supplied context.",
        file: ["src/app.ts"],
        system: "System contract.",
      },
      { cwd: root },
    );
    results.bundleFiles = bundle.files.map((file) => rel(root, file.path));
    results.bundleHasSystem = bundle.markdown.includes("[SYSTEM]");
    results.bundleHasUser = bundle.markdown.includes("[USER]");
    results.bundleHasFileFence = bundle.markdown.includes("## File: src/app.ts");
    results.promptWithFilesHasFile = bundle.promptWithFiles.includes("## File: src/app.ts");
    results.promptWithFilesHasLegacyFile = bundle.promptWithFiles.includes("### File 1: src/app.ts");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }

  console.log(JSON.stringify(results, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

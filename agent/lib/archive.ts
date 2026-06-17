import { mkdtempSync, rmSync, type Stats, writeFileSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import * as tar from "tar";

import type { SandboxSession } from "eve/sandbox";

const MAX_ARCHIVE_ENTRIES = 50000;

export async function extractTarGzToSandbox(input: {
  archive: Buffer;
  sandbox: SandboxSession;
  targetDir: string;
  maxBytes: number;
}): Promise<{ files: number; bytes: number }> {
  const tempRoot = mkdtempSync(join(tmpdir(), "hootline-archive-"));
  try {
    const archivePath = join(tempRoot, "repo.tar.gz");
    const extractRoot = join(tempRoot, "repo");
    writeFileSync(archivePath, input.archive);
    await tar.x({
      cwd: tempRoot,
      file: archivePath,
      strict: true,
      filter: isSafeArchiveEntry,
    });
    const entries = await readdir(tempRoot, { withFileTypes: true });
    const rootEntry = entries.find((entry) => entry.isDirectory() && entry.name !== "repo");
    const sourceRoot = rootEntry === undefined ? extractRoot : join(tempRoot, rootEntry.name);
    await input.sandbox.removePath({ path: input.targetDir, recursive: true, force: true });
    await input.sandbox.run({ command: `mkdir -p ${shellQuote(input.targetDir)}` });
    const result = await copyDirectoryToSandbox(
      sourceRoot,
      input.sandbox,
      input.targetDir,
      input.maxBytes,
    );
    await input.sandbox.run({
      command: [
        `cd ${shellQuote(input.targetDir)}`,
        "git init >/dev/null 2>&1 || exit 0",
        "git config user.email hootline@example.invalid",
        "git config user.name Hootline",
        "git add .",
        "git commit -m baseline >/dev/null 2>&1 || true",
      ].join(" && "),
    });
    return result;
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

async function copyDirectoryToSandbox(
  sourceRoot: string,
  sandbox: SandboxSession,
  targetDir: string,
  maxBytes: number,
): Promise<{ files: number; bytes: number }> {
  let files = 0;
  let bytes = 0;
  let entryCount = 0;
  const visit = async (directory: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const absolute = join(directory, entry.name);
      const rel = relative(sourceRoot, absolute).replaceAll("\\", "/");
      if (!rel || rel === ".") continue;
      if (rel.startsWith("../") || rel.includes("/../")) {
        throw new Error(`Archive entry escapes snapshot boundaries: ${JSON.stringify(rel)}`);
      }
      entryCount += 1;
      if (entryCount > MAX_ARCHIVE_ENTRIES) {
        throw new Error(
          `Repository archive contains more than ${MAX_ARCHIVE_ENTRIES} entries, above policy limit.`,
        );
      }
      if (entry.isDirectory()) {
        await sandbox.run({ command: `mkdir -p ${shellQuote(`${targetDir}/${rel}`)}` });
        await visit(absolute);
      } else if (entry.isFile()) {
        const info = await stat(absolute);
        bytes += info.size;
        if (bytes > maxBytes) {
          throw new Error(
            `Decompressed repository archive is ${bytes} bytes, above policy limit ${maxBytes}.`,
          );
        }
        const content = await readFile(absolute);
        await sandbox.writeBinaryFile({ path: `${targetDir}/${rel}`, content });
        files += 1;
      }
    }
  };
  await visit(sourceRoot);
  return { files, bytes };
}

function isSafeArchiveEntry(path: string, entry: Stats | tar.ReadEntry): boolean {
  if ("type" in entry) {
    if (entry.type === "SymbolicLink" || entry.type === "Link") return false;
  } else if (entry.isSymbolicLink()) {
    return false;
  }
  const normalized = path.replaceAll("\\", "/");
  if (normalized.startsWith("/")) return false;
  if (normalized.split("/").includes("..")) return false;
  return true;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

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
    const archiveLimits = createArchiveLimitFilter(input.maxBytes);
    writeFileSync(archivePath, input.archive);
    await tar.x({
      cwd: tempRoot,
      file: archivePath,
      strict: true,
      filter: archiveLimits.filter,
    });
    archiveLimits.assertWithinLimits();
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
    await initializeGitBaseline(input.sandbox, input.targetDir);
    return result;
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

async function initializeGitBaseline(sandbox: SandboxSession, targetDir: string): Promise<void> {
  const result = await sandbox.run({
    command: [
      `cd ${shellQuote(targetDir)}`,
      "git init >/dev/null",
      "git config user.email hootline@example.invalid",
      "git config user.name Hootline",
      "git add .",
      "if git diff --cached --quiet; then git commit --allow-empty -m baseline >/dev/null; else git commit -m baseline >/dev/null; fi",
      "git rev-parse --verify HEAD >/dev/null",
    ].join(" && "),
  });
  const exitCode = typeof result.exitCode === "number" ? result.exitCode : 0;
  if (exitCode !== 0) {
    throw new Error(`Unable to initialize staged repository baseline: ${String(result.stderr ?? "")}`);
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

function createArchiveLimitFilter(maxBytes: number): {
  filter: (path: string, entry: Stats | tar.ReadEntry) => boolean;
  assertWithinLimits: () => void;
} {
  let entries = 0;
  let bytes = 0;
  let limitError: Error | undefined;
  return {
    filter(path, entry) {
      if (limitError !== undefined) return false;
      if (!isSafeArchiveEntry(path, entry)) return false;
      if (!isArchiveFile(entry) && !isArchiveDirectory(entry)) return false;
      entries += 1;
      if (entries > MAX_ARCHIVE_ENTRIES) {
        limitError = new Error(`Repository archive contains more than ${MAX_ARCHIVE_ENTRIES} entries, above policy limit.`);
        return false;
      }
      if (isArchiveFile(entry)) {
        bytes += archiveEntrySize(entry);
        if (bytes > maxBytes) {
          limitError = new Error(`Decompressed repository archive is ${bytes} bytes, above policy limit ${maxBytes}.`);
          return false;
        }
      }
      return true;
    },
    assertWithinLimits() {
      if (limitError !== undefined) throw limitError;
    },
  };
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

function isArchiveFile(entry: Stats | tar.ReadEntry): boolean {
  return "type" in entry ? entry.type === "File" : entry.isFile();
}

function isArchiveDirectory(entry: Stats | tar.ReadEntry): boolean {
  return "type" in entry ? entry.type === "Directory" : entry.isDirectory();
}

function archiveEntrySize(entry: Stats | tar.ReadEntry): number {
  return typeof entry.size === "number" && Number.isFinite(entry.size) ? entry.size : 0;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

#!/usr/bin/env node
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const SKIP_DIRS = new Set([
  ".eve",
  ".git",
  ".output",
  ".workflow-data",
  "coverage",
  "node_modules",
  "var",
]);

const TEXT_EXTENSIONS = new Set([
  ".js",
  ".json",
  ".md",
  ".mjs",
  ".ts",
  ".tsx",
  ".yml",
  ".yaml",
]);

const EXACT_TEXT_FILES = new Set([
  ".dockerignore",
  ".env.example",
  ".gitignore",
  "Dockerfile",
]);

const SKIP_FILES = new Set(["scripts/lint-repo.mjs"]);

const checks = [
  {
    pattern: /@ts-ignore/g,
    message: "Use a typed boundary or @ts-expect-error with a specific reason instead of @ts-ignore.",
  },
];

const failures = [];
for (const file of walk(".")) {
  const text = readFileSync(file, "utf8");
  for (const check of checks) {
    for (const match of text.matchAll(check.pattern)) {
      failures.push(`${file}:${lineNumber(text, match.index ?? 0)} ${check.message}`);
    }
  }
}

if (failures.length > 0) {
  console.error("Repository lint failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

function* walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "." || entry.name === "..") continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* walk(path);
      continue;
    }
    if (!entry.isFile() || !isTextFile(path)) continue;
    // Skip unreadable or unexpectedly huge generated-like files even when the
    // extension looks textual; tracked source/docs/config should stay small.
    if (statSync(path).size > 1024 * 1024) continue;
    yield path;
  }
}

function isTextFile(path) {
  const normalized = path.replace(/^\.\//, "");
  if (SKIP_FILES.has(normalized)) return false;
  if (EXACT_TEXT_FILES.has(normalized)) return true;
  const dotIndex = path.lastIndexOf(".");
  return dotIndex !== -1 && TEXT_EXTENSIONS.has(path.slice(dotIndex));
}

function lineNumber(text, index) {
  return text.slice(0, index).split("\n").length;
}

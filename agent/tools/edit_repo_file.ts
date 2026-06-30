import { createHash } from "node:crypto";

import { defineTool } from "eve/tools";

import { resolveStagedAttempt } from "../lib/current.ts";
import { createLogger, logError } from "../lib/logger.ts";
import { redact } from "../lib/redact.ts";
import { replaceSandboxTextWithCandidates } from "../lib/sandbox.ts";
import {
  readAliasedTextCandidates,
  looseObjectSchema,
  normalizeToolInput,
  readRequiredAliasedString,
  readRequiredAliasedText,
} from "../lib/tool-input.ts";

const log = createLogger("tools.edit_repo_file");

const editRepoFileSchema = looseObjectSchema({
  path: { type: "string", minLength: 1, maxLength: 500 },
  filePath: { type: "string", minLength: 1, maxLength: 500 },
  file: { type: "string", minLength: 1, maxLength: 500 },
  expected: { type: "string", minLength: 1, maxLength: 50_000 },
  oldText: { type: "string", minLength: 1, maxLength: 50_000 },
  old_text: { type: "string", minLength: 1, maxLength: 50_000 },
  searchText: { type: "string", minLength: 1, maxLength: 50_000 },
  search: { type: "string", minLength: 1, maxLength: 50_000 },
  replacement: { type: "string", maxLength: 50_000 },
  newText: { type: "string", maxLength: 50_000 },
  new_text: { type: "string", maxLength: 50_000 },
  replace: { type: "string", maxLength: 50_000 },
});

const MAX_DIAGNOSTIC_LINES = 5;
const MAX_DIAGNOSTIC_CHARS = 2_000;
const MAX_EDIT_MISS_HISTORY = 1_000;
const editMissCounts = new Map<string, number>();

export default defineTool({
  description:
    "Edit one policy-allowed file in the staged repository by replacing exact text that occurs exactly once. Use after stage_repository_snapshot and before run_repo_checks. If the tool reports edited=false, do not retry the same input; read the diagnostics and call it again with exact current text or report a blocker.",
  inputSchema: editRepoFileSchema,
  async execute(input, ctx) {
    const normalizedInput = normalizeToolInput(input);
    const { attempt, policy, sandbox } = await resolveStagedAttempt(ctx, normalizedInput);
    const tlog = log.child({ attemptKey: attempt.key, provider: attempt.event.provider });
    tlog.debug("edit_repo_file invoked");
    const path = readRequiredAliasedString(normalizedInput, "path", ["filePath", "file"]);
    const expected = readRequiredAliasedText(normalizedInput, "expected", [
      "oldText",
      "old_text",
      "searchText",
      "search",
      "find",
    ]);
    const replacementCandidates = readAliasedTextCandidates(
      normalizedInput,
      "replacement",
      ["newText", "new_text", "replace", "replacementText"],
      { allowEmpty: true },
    ).map((candidate) => ({ key: candidate.key, text: candidate.value }));
    if (replacementCandidates.length === 0) {
      throw new Error("Missing required text input: replacement. Accepted keys: replacement, newText, new_text, replace, replacementText.");
    }
    try {
      const result = await replaceSandboxTextWithCandidates(sandbox, policy, {
        path,
        expected,
        replacements: replacementCandidates,
      });
      tlog.info({ path: result.path, beforeBytes: result.beforeBytes, afterBytes: result.afterBytes }, "file edited");
      forgetEditMissesForPath(attempt.key, result.path);
      return { ...result, edited: true };
    } catch (error) {
      if (isAmbiguousReplacementAliasError(error)) {
        const diagnostics = await buildEditMissDiagnostics(sandbox, path, expected, {
          reason: "ambiguous_replacement_aliases",
          message: error instanceof Error ? error.message : String(error),
        });
        tlog.info({ path: diagnostics.path, reason: diagnostics.reason }, "edit_repo_file did not edit: replacement aliases were ambiguous");
        return diagnostics;
      }
      if (isRecoverableTextMatchError(error)) {
        const diagnostics = await buildEditMissDiagnostics(sandbox, path, expected, {
          matchCount: readRecoverableMatchCount(error),
        });
        const missCount = recordEditMiss(
          attempt.key,
          String(diagnostics.path ?? path),
          expected,
          replacementCandidates.map((candidate) => candidate.text),
          typeof diagnostics.currentFileHash === "string" ? diagnostics.currentFileHash : undefined,
        );
        const reason = missCount > 1 ? "duplicate_expected_text_miss" : "expected_text_not_uniquely_matched";
        if (missCount > 1) {
          tlog.warn(
            { path: diagnostics.path, reason, missCount },
            "edit_repo_file returned duplicate missed edit diagnostics",
          );
        }
        tlog.info(
          { path: diagnostics.path, reason },
          "edit_repo_file did not edit: expected text was not uniquely matched",
        );
        return {
          ...diagnostics,
          reason,
          missCount,
        };
      }
      logError(tlog, "edit_repo_file failed", error);
      throw error;
    }
  },
  toModelOutput(output) {
    return { type: "json", value: output };
  },
});

function isRecoverableTextMatchError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /^expected text must occur exactly once in .+; found \d+\.$/.test(error.message);
}

function isAmbiguousReplacementAliasError(error: unknown): boolean {
  return error instanceof Error && /^Replacement aliases produced multiple valid edits for .+\.$/.test(error.message);
}

function readRecoverableMatchCount(error: unknown): number | undefined {
  if (!(error instanceof Error)) return undefined;
  const match = /; found (\d+)\.$/u.exec(error.message);
  return match?.[1] === undefined ? undefined : Number.parseInt(match[1], 10);
}

function recordEditMiss(
  attemptKey: string,
  path: string,
  expected: string,
  replacements: readonly string[],
  currentFileHash: string | undefined,
): number {
  const signature = editMissSignature(attemptKey, path, expected, replacements, currentFileHash);
  const count = (editMissCounts.get(signature) ?? 0) + 1;
  editMissCounts.set(signature, count);
  pruneEditMissHistory();
  return count;
}

function forgetEditMissesForPath(attemptKey: string, path: string): void {
  const prefix = `${attemptKey}\0${compactRepoPath(path)}\0`;
  for (const signature of [...editMissCounts.keys()]) {
    if (signature.startsWith(prefix)) editMissCounts.delete(signature);
  }
}

function editMissSignature(
  attemptKey: string,
  path: string,
  expected: string,
  replacements: readonly string[],
  currentFileHash: string | undefined,
): string {
  const hash = createHash("sha256")
    .update(expected)
    .update("\0")
    .update(replacements.join("\0"))
    .digest("hex")
    .slice(0, 24);
  return `${attemptKey}\0${compactRepoPath(path)}\0${currentFileHash ?? "unreadable"}\0${hash}`;
}

function pruneEditMissHistory(): void {
  if (editMissCounts.size <= MAX_EDIT_MISS_HISTORY) return;
  const oldest = editMissCounts.keys().next().value;
  if (typeof oldest === "string") editMissCounts.delete(oldest);
}

async function buildEditMissDiagnostics(
  sandbox: { readTextFile(input: { path: string }): PromiseLike<string | null> },
  rawPath: string,
  expected: string,
  options: {
    matchCount?: number | undefined;
    message?: string | undefined;
    reason?: string | undefined;
  } = {},
): Promise<Record<string, unknown>> {
  const path = compactRepoPath(rawPath);
  const base = {
    edited: false,
    path,
    replacements: 0,
    reason: options.reason ?? "expected_text_not_uniquely_matched",
    matchCount: options.matchCount,
    message: options.message === undefined ? undefined : redact(options.message, MAX_DIAGNOSTIC_CHARS),
    recoveryNextTool: "read_file",
    fallbackTool: "replace_repo_lines",
    recovery:
      "Do not retry the same edit_repo_file input. Read the target file and use exact current text, or use replace_repo_lines with a reviewed line range if no safe unique text edit exists.",
  };
  if (!isSafeCompactRepoPath(path)) return base;
  let current: string | null;
  try {
    current = await sandbox.readTextFile({ path: `repo/${path}` });
  } catch {
    current = null;
  }
  if (typeof current !== "string") return base;
  const nearbyLines = findDiagnosticLines(current, expected);
  return {
    ...base,
    currentFileHash: hashText(current),
    nearbyLines,
    currentSnippet: findDiagnosticSnippet(current, nearbyLines),
  };
}

function findDiagnosticLines(current: string, expected: string): Array<{ line: number; text: string }> {
  const terms = diagnosticTerms(expected);
  if (terms.length === 0) return [];
  const lines = current.split(/\r\n|\n|\r/);
  const matches: Array<{ line: number; text: string }> = [];
  for (const [index, line] of lines.entries()) {
    const normalized = line.toLowerCase();
    if (!terms.some((term) => normalized.includes(term))) continue;
    matches.push({ line: index + 1, text: capDiagnosticText(line) });
    if (matches.length >= MAX_DIAGNOSTIC_LINES) break;
  }
  return matches;
}

function diagnosticTerms(expected: string): string[] {
  const terms = new Set<string>();
  for (const match of expected.matchAll(/[A-Za-z_$][\w$]{3,}/g)) {
    terms.add(match[0].toLowerCase());
  }
  return [...terms].slice(0, 8);
}

function capDiagnosticText(value: string): string {
  return redact(value, MAX_DIAGNOSTIC_CHARS);
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function findDiagnosticSnippet(current: string, nearbyLines: Array<{ line: number; text: string }>): string | undefined {
  if (nearbyLines.length === 0) return undefined;
  const lines = current.split(/\r\n|\n|\r/);
  const center = nearbyLines[0]!.line - 1;
  const start = Math.max(0, center - 2);
  const end = Math.min(lines.length, center + 3);
  const snippet = lines
    .slice(start, end)
    .map((line, index) => `${start + index + 1}: ${line}`)
    .join("\n");
  return capDiagnosticText(snippet);
}

function compactRepoPath(path: string): string {
  if (path.startsWith("/workspace/repo/")) return path.slice("/workspace/repo/".length);
  if (path.startsWith("repo/")) return path.slice("repo/".length);
  return path;
}

function isSafeCompactRepoPath(path: string): boolean {
  return (
    path.length > 0 &&
    !path.startsWith("/") &&
    !path.includes("\0") &&
    !path.includes("\\") &&
    !path.split("/").includes("..") &&
    !path.split("/").includes(".git")
  );
}

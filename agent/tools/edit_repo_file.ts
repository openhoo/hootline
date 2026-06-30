import { defineTool } from "eve/tools";

import { resolveStagedAttempt } from "../lib/current.ts";
import { createLogger, logError } from "../lib/logger.ts";
import { redact } from "../lib/redact.ts";
import { replaceSandboxText } from "../lib/sandbox.ts";

const log = createLogger("tools.edit_repo_file");

const editRepoFileSchema = {
  type: "object",
  properties: {
    path: { type: "string", minLength: 1, maxLength: 500 },
    expected: { type: "string", minLength: 1, maxLength: 50_000 },
    replacement: { type: "string", maxLength: 50_000 },
  },
  required: ["path", "expected", "replacement"],
  additionalProperties: false,
} as const;

const MAX_DIAGNOSTIC_LINES = 5;
const MAX_DIAGNOSTIC_CHARS = 2_000;

export default defineTool({
  description:
    "Edit one policy-allowed file in the staged repository by replacing exact text that occurs exactly once. Use after stage_repository_snapshot and before run_repo_checks. If the tool reports edited=false, do not retry the same input; read the diagnostics and call it again with exact current text or report a blocker.",
  inputSchema: editRepoFileSchema,
  async execute(input, ctx) {
    const { attempt, policy, sandbox } = await resolveStagedAttempt(ctx, input);
    const tlog = log.child({ attemptKey: attempt.key, provider: attempt.event.provider });
    tlog.debug("edit_repo_file invoked");
    const path = String(input.path);
    const expected = String(input.expected);
    const replacement = String(input.replacement);
    try {
      const result = await replaceSandboxText(sandbox, policy, {
        path,
        expected,
        replacement,
      });
      tlog.info({ path: result.path, beforeBytes: result.beforeBytes, afterBytes: result.afterBytes }, "file edited");
      return { ...result, edited: true };
    } catch (error) {
      if (isRecoverableTextMatchError(error)) {
        const diagnostics = await buildEditMissDiagnostics(sandbox, path, expected);
        tlog.info(
          { path: diagnostics.path, reason: diagnostics.reason },
          "edit_repo_file did not edit: expected text was not uniquely matched",
        );
        return diagnostics;
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

async function buildEditMissDiagnostics(
  sandbox: { readTextFile(input: { path: string }): PromiseLike<string | null> },
  rawPath: string,
  expected: string,
): Promise<Record<string, unknown>> {
  const path = compactRepoPath(rawPath);
  const base = {
    edited: false,
    path,
    replacements: 0,
    reason: "expected_text_not_uniquely_matched",
    recovery:
      "Do not retry the same edit_repo_file input. Read the target file and use exact current text, including punctuation and indentation, or post a blocker comment if no safe unique edit exists.",
  };
  if (!isSafeCompactRepoPath(path)) return base;
  let current: string | null;
  try {
    current = await sandbox.readTextFile({ path: `repo/${path}` });
  } catch {
    current = null;
  }
  if (typeof current !== "string") return base;
  return {
    ...base,
    nearbyLines: findDiagnosticLines(current, expected),
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

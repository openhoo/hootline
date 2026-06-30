import { defineTool } from "eve/tools";

import { resolveStagedAttempt } from "../lib/current.ts";
import { createLogger, logError } from "../lib/logger.ts";
import { replaceSandboxLines } from "../lib/sandbox.ts";
import {
  looseObjectSchema,
  normalizeToolInput,
  readOptionalAliasedText,
  readRequiredAliasedInteger,
  readRequiredAliasedString,
  readRequiredAliasedText,
} from "../lib/tool-input.ts";

const log = createLogger("tools.replace_repo_lines");

const replaceRepoLinesSchema = looseObjectSchema({
  path: { type: "string", minLength: 1, maxLength: 500 },
  filePath: { type: "string", minLength: 1, maxLength: 500 },
  file: { type: "string", minLength: 1, maxLength: 500 },
  startLine: { type: "integer", minimum: 1 },
  start: { type: "integer", minimum: 1 },
  lineStart: { type: "integer", minimum: 1 },
  fromLine: { type: "integer", minimum: 1 },
  endLine: { type: "integer", minimum: 1 },
  end: { type: "integer", minimum: 1 },
  lineEnd: { type: "integer", minimum: 1 },
  toLine: { type: "integer", minimum: 1 },
  replacement: { type: "string", maxLength: 50_000 },
  newText: { type: "string", maxLength: 50_000 },
  new_text: { type: "string", maxLength: 50_000 },
  replace: { type: "string", maxLength: 50_000 },
  expected: { type: "string", maxLength: 50_000 },
  oldText: { type: "string", maxLength: 50_000 },
  old_text: { type: "string", maxLength: 50_000 },
});

export default defineTool({
  description:
    "Replace a 1-based inclusive line range in one policy-allowed staged repository file. Use only after reading the current file when edit_repo_file cannot find a safe unique text match. Include complete replacement lines.",
  inputSchema: replaceRepoLinesSchema,
  async execute(input, ctx) {
    const normalizedInput = normalizeToolInput(input);
    const { attempt, policy, sandbox } = await resolveStagedAttempt(ctx, normalizedInput);
    const tlog = log.child({ attemptKey: attempt.key, provider: attempt.event.provider });
    const path = readRequiredAliasedString(normalizedInput, "path", ["filePath", "file"]);
    const startLine = readRequiredAliasedInteger(normalizedInput, "startLine", [
      "start",
      "lineStart",
      "fromLine",
    ]);
    const endLine = readRequiredAliasedInteger(normalizedInput, "endLine", ["end", "lineEnd", "toLine"]);
    const replacement = readRequiredAliasedText(
      normalizedInput,
      "replacement",
      ["newText", "new_text", "replace", "replacementText"],
      { allowEmpty: true },
    );
    const expected = readOptionalAliasedText(normalizedInput, "expected", ["oldText", "old_text", "searchText", "search"]);

    try {
      const result = await replaceSandboxLines(sandbox, policy, {
        path,
        startLine,
        endLine,
        replacement,
        expected,
      });
      tlog.info(
        { path: result.path, startLine, endLine, beforeBytes: result.beforeBytes, afterBytes: result.afterBytes },
        "file lines replaced",
      );
      return {
        ...result,
        edited: true,
        startLine,
        endLine,
      };
    } catch (error) {
      logError(tlog, "replace_repo_lines failed", error);
      throw error;
    }
  },
  toModelOutput(output) {
    return { type: "json", value: output };
  },
});

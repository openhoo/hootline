import { defineTool } from "eve/tools";
import { glob } from "eve/tools/defaults";

import { resolveStagedAttempt } from "../lib/current.ts";
import { normalizeWorkspaceRepoPath } from "../lib/sandbox.ts";
import {
  looseObjectSchema,
  normalizeToolInput,
  readOptionalAliasedString,
  readRequiredAliasedString,
} from "../lib/tool-input.ts";

const globInputSchema = looseObjectSchema({
  pattern: { type: "string" },
  glob: { type: "string" },
  path: { type: "string" },
  directory: { type: "string" },
  limit: { type: "integer", minimum: 1, maximum: 1000 },
});

export default defineTool({
  ...glob,
  description: `${glob.description ?? ""}\nHootline also accepts repo-relative search directories and common aliases like glob for pattern.`,
  inputSchema: globInputSchema,
  async execute(input, ctx) {
    const normalizedInput = normalizeToolInput(input);
    await resolveStagedAttempt(ctx, normalizedInput);
    return glob.execute(normalizeGlobInput(normalizedInput), ctx);
  },
});

export function normalizeGlobInput(input: unknown): Record<string, unknown> {
  const normalizedInput = normalizeToolInput(input);
  const pattern = readRequiredAliasedString(normalizedInput, "pattern", ["glob"]);
  const rawPath = readOptionalAliasedString(normalizedInput, "path", ["directory", "dir"]);
  return {
    ...normalizedInput,
    pattern,
    path: rawPath === undefined ? "/workspace/repo" : normalizeWorkspaceRepoPath(rawPath).path,
  };
}

import { defineTool } from "eve/tools";
import { grep } from "eve/tools/defaults";

import { normalizeWorkspaceRepoPath, resolveSandboxRepoPath } from "../lib/sandbox.ts";
import {
  looseObjectSchema,
  normalizeToolInput,
  readOptionalAliasedString,
  readRequiredAliasedString,
} from "../lib/tool-input.ts";

const grepInputSchema = looseObjectSchema({
  pattern: { type: "string" },
  query: { type: "string" },
  search: { type: "string" },
  path: { type: "string" },
  filePath: { type: "string" },
  glob: { type: "string" },
  literal: { type: "boolean" },
  ignoreCase: { type: "boolean" },
  context: { type: "integer", minimum: 0 },
  limit: { type: "integer", minimum: 1, maximum: 1000 },
});

export default defineTool({
  ...grep,
  description: `${grep.description ?? ""}\nHootline also accepts repo-relative search paths and common aliases like query/search for pattern.`,
  inputSchema: grepInputSchema,
  async execute(input, ctx) {
    return grep.execute(await normalizeGrepInput(input, await ctx.getSandbox()), ctx);
  },
});

export async function normalizeGrepInput(
  input: unknown,
  sandbox: Parameters<typeof resolveSandboxRepoPath>[0],
): Promise<Record<string, unknown>> {
  const normalizedInput = normalizeToolInput(input);
  const pattern = readRequiredAliasedString(normalizedInput, "pattern", ["query", "search"]);
  const rawPath = readOptionalAliasedString(normalizedInput, "path", ["filePath", "file"]);
  let path = rawPath === undefined ? undefined : normalizeWorkspaceRepoPath(rawPath).path;
  if (rawPath !== undefined && looksLikeFilePath(rawPath)) {
    const resolved = await resolveSandboxRepoPath(sandbox, rawPath);
    path = normalizeWorkspaceRepoPath(resolved.path).path;
  }
  return {
    ...normalizedInput,
    pattern,
    ...(path === undefined ? {} : { path }),
  };
}

function looksLikeFilePath(path: string): boolean {
  return /\.[A-Za-z0-9]+(?::\d+(?::\d+)?)?$/u.test(path.trim());
}

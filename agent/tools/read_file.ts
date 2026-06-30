import { defineTool } from "eve/tools";
import { readFile } from "eve/tools/defaults";

import { normalizeWorkspaceRepoPath, resolveSandboxRepoPath } from "../lib/sandbox.ts";
import { looseObjectSchema, normalizeToolInput, readOptionalAliasedString } from "../lib/tool-input.ts";

const readFileInputSchema = looseObjectSchema({
  filePath: { type: "string" },
  path: { type: "string" },
  file: { type: "string" },
  limit: { type: "integer", minimum: 1 },
  offset: { type: "integer", minimum: 1 },
});

export default defineTool({
  ...readFile,
  description: `${readFile.description ?? ""}\nHootline also accepts repo-relative paths, /workspace/repo paths, and high-confidence small path typos inside the staged repository.`,
  inputSchema: readFileInputSchema,
  async execute(input, ctx) {
    const sandbox = await ctx.getSandbox();
    return readFile.execute(await normalizeReadFileInput(input, sandbox), ctx);
  },
});

export async function normalizeReadFileInput(
  input: unknown,
  sandbox: Parameters<typeof resolveSandboxRepoPath>[0],
): Promise<Record<string, unknown>> {
  const normalizedInput = normalizeToolInput(input);
  const rawPath = readOptionalAliasedString(normalizedInput, "filePath", ["path", "file"]);
  if (rawPath === undefined) throw new Error("Missing required string input: filePath.");
  const resolved = await resolveSandboxRepoPath(sandbox, rawPath);
  return {
    ...normalizedInput,
    filePath: normalizeWorkspaceRepoPath(resolved.path).path,
  };
}

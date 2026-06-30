import { defineTool } from "eve/tools";

import { resolveStagedAttempt } from "../lib/current.ts";
import { createLogger, logError } from "../lib/logger.ts";
import { replaceSandboxText } from "../lib/sandbox.ts";

const log = createLogger("tools.edit_repo_file");

const editRepoFileSchema = {
  type: "object",
  properties: {
    attemptKey: { type: "string", minLength: 1, maxLength: 512 },
    path: { type: "string", minLength: 1, maxLength: 500 },
    expected: { type: "string", minLength: 1, maxLength: 50_000 },
    replacement: { type: "string", maxLength: 50_000 },
  },
  required: ["path", "expected", "replacement"],
  additionalProperties: false,
} as const;

export default defineTool({
  description:
    "Edit one policy-allowed file in the staged repository by replacing exact text that occurs exactly once. Use after stage_repository_snapshot and before run_repo_checks.",
  inputSchema: editRepoFileSchema,
  async execute(input, ctx) {
    const { attempt, policy, sandbox } = await resolveStagedAttempt(ctx, input);
    const tlog = log.child({ attemptKey: attempt.key, provider: attempt.event.provider });
    tlog.debug("edit_repo_file invoked");
    try {
      const result = await replaceSandboxText(sandbox, policy, {
        path: String(input.path),
        expected: String(input.expected),
        replacement: String(input.replacement),
      });
      tlog.info({ path: result.path, beforeBytes: result.beforeBytes, afterBytes: result.afterBytes }, "file edited");
      return result;
    } catch (error) {
      logError(tlog, "edit_repo_file failed", error);
      throw error;
    }
  },
  toModelOutput(output) {
    return { type: "json", value: output };
  },
});

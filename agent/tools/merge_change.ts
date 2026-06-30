import { defineTool } from "eve/tools";

import { resolveCurrentAttempt } from "../lib/current.ts";
import { createLogger, logError } from "../lib/logger.ts";
import { getProviderClient } from "../lib/providers/index.ts";
import { clearSessionOutcomePatch, updateAttempt } from "../lib/state.ts";
import { mergeSchema, normalizeToolInput, readOptionalString } from "../lib/tool-input.ts";

const log = createLogger("tools.merge_change");

export default defineTool({
  description:
    "Merge the published fix change only when repo policy is auto_merge. Normally success webhooks handle this deterministically.",
  inputSchema: mergeSchema,
  async execute(input, ctx) {
    const normalizedInput = normalizeToolInput(input);
    const { config, attempt, policy } = resolveCurrentAttempt(ctx, readOptionalString(normalizedInput, "attemptKey"));
    const tlog = log.child({ attemptKey: attempt.key, provider: attempt.event.provider });
    if (policy.mode !== "auto_merge") {
      throw new Error("merge_change is only allowed when policy mode is auto_merge.");
    }
    if (policy.autoMerge.requireSuccessfulPipeline) {
      throw new Error("Policy requires a successful fixer pipeline webhook before merge.");
    }
    if (attempt.changeNumber === undefined || attempt.publishedBranch === undefined) {
      throw new Error("No published PR/MR is recorded for this attempt.");
    }
    tlog.debug({ changeNumber: attempt.changeNumber }, "merge_change invoked");
    try {
      const result = await getProviderClient(attempt.event.provider).mergeChange({
        event: attempt.event,
        changeNumber: attempt.changeNumber,
        branch: attempt.publishedBranch,
        deleteSourceBranch: policy.autoMerge.deleteSourceBranch,
      });
      updateAttempt(config.statePath, attempt.key, {
        ...clearSessionOutcomePatch(),
        lastPublishResult: result,
        lastSessionStatus: "completed",
        lastTerminalAction: "merged",
        pendingAutoMerge: false,
      });
      tlog.info({ merged: result.merged, changeNumber: attempt.changeNumber }, "change merged via tool");
      return result;
    } catch (error) {
      logError(tlog, "merge_change failed", error);
      throw error;
    }
  },
  toModelOutput(output) {
    return { type: "json", value: output };
  },
});

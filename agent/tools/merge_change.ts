import { defineTool } from "eve/tools";

import { resolveCurrentAttempt } from "../lib/current.ts";
import { getProviderClient } from "../lib/providers/index.ts";
import { updateAttempt } from "../lib/state.ts";
import { mergeSchema, readBoolean, readOptionalString } from "../lib/tool-input.ts";

export default defineTool({
  description:
    "Merge the published fix change only when repo policy is auto_merge. Normally success webhooks handle this deterministically.",
  inputSchema: mergeSchema,
  async execute(input, ctx) {
    const { config, attempt, policy } = resolveCurrentAttempt(ctx, readOptionalString(input, "attemptKey"));
    if (policy.mode !== "auto_merge") {
      throw new Error("merge_change is only allowed when policy mode is auto_merge.");
    }
    if (policy.autoMerge.requireSuccessfulPipeline && !readBoolean(input, "confirmedSuccessfulPipeline", false)) {
      throw new Error("Policy requires a successful fixer pipeline webhook before merge.");
    }
    if (attempt.changeNumber === undefined || attempt.publishedBranch === undefined) {
      throw new Error("No published PR/MR is recorded for this attempt.");
    }
    const result = await getProviderClient(attempt.event.provider).mergeChange({
      event: attempt.event,
      changeNumber: attempt.changeNumber,
      branch: attempt.publishedBranch,
      deleteSourceBranch: policy.autoMerge.deleteSourceBranch,
    });
    updateAttempt(config.statePath, attempt.key, {
      lastPublishResult: result,
      pendingAutoMerge: false,
    });
    return result;
  },
});

import { defineTool } from "eve/tools";

import { resolveCurrentAttempt } from "../lib/current.ts";
import { getProviderClient } from "../lib/providers/index.ts";
import { claimRerunRequest, recordRerunFailure, recordRerunResult } from "../lib/state.ts";
import { readOptionalString, readRequiredString, rerunSchema } from "../lib/tool-input.ts";

export default defineTool({
  description:
    "Rerun failed jobs/pipeline when the failure is likely transient and no code change is appropriate.",
  inputSchema: rerunSchema,
  async execute(input, ctx) {
    const { config, attempt } = resolveCurrentAttempt(ctx, readOptionalString(input, "attemptKey"));
    const reason = readRequiredString(input, "reason");
    const claim = claimRerunRequest(config.statePath, attempt.key, reason);
    if (!claim.claimed) {
      throw new Error("rerun_pipeline already requested for this attempt; limit is one rerun.");
    }
    try {
      const result = await getProviderClient(attempt.event.provider).rerunPipeline(attempt.event);
      recordRerunResult(config.statePath, attempt.key, claim.request.id, result);
      return { ...result, reason };
    } catch (error) {
      recordRerunFailure(
        config.statePath,
        attempt.key,
        claim.request.id,
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }
  },
});

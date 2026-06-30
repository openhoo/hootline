import { defineTool } from "eve/tools";

import { resolveCurrentAttempt } from "../lib/current.ts";
import { createLogger, logError } from "../lib/logger.ts";
import { getProviderClient } from "../lib/providers/index.ts";
import {
  claimRerunRequest,
  clearSessionOutcomePatch,
  recordRerunFailure,
  recordRerunResult,
  updateAttempt,
} from "../lib/state.ts";
import {
  normalizeToolInput,
  readOptionalString,
  readRequiredAliasedString,
  rerunSchema,
} from "../lib/tool-input.ts";

const log = createLogger("tools.rerun_pipeline");

export default defineTool({
  description:
    "Rerun failed jobs/pipeline when the failure is likely transient and no code change is appropriate.",
  inputSchema: rerunSchema,
  async execute(input, ctx) {
    const normalizedInput = normalizeToolInput(input);
    const { config, attempt } = resolveCurrentAttempt(ctx, readOptionalString(normalizedInput, "attemptKey"));
    const reason = readRequiredAliasedString(normalizedInput, "reason", ["message", "summary"]);
    const tlog = log.child({ attemptKey: attempt.key, provider: attempt.event.provider });
    const claim = claimRerunRequest(config.statePath, attempt.key, reason);
    if (!claim.claimed) {
      throw new Error("rerun_pipeline already requested for this attempt; limit is one rerun.");
    }
    tlog.debug("rerun_pipeline invoked");
    try {
      const result = await getProviderClient(attempt.event.provider).rerunPipeline(attempt.event);
      recordRerunResult(config.statePath, attempt.key, claim.request.id, result);
      updateAttempt(config.statePath, attempt.key, {
        ...clearSessionOutcomePatch(),
        lastSessionStatus: "completed",
        lastTerminalAction: "rerun_requested",
      });
      tlog.info("pipeline rerun requested");
      return { ...result, reason };
    } catch (error) {
      recordRerunFailure(
        config.statePath,
        attempt.key,
        claim.request.id,
        error instanceof Error ? error.message : String(error),
      );
      logError(tlog, "rerun_pipeline failed", error);
      throw error;
    }
  },
  toModelOutput(output) {
    return { type: "json", value: output };
  },
});

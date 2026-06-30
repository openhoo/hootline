import { defineTool } from "eve/tools";

import { resolveCurrentAttempt } from "../lib/current.ts";
import { createLogger, logError } from "../lib/logger.ts";
import { failureContextModelOutput } from "../lib/model-output.ts";
import { getProviderClient } from "../lib/providers/index.ts";
import { updateAttempt } from "../lib/state.ts";
import { normalizeToolInput, optionalAttemptKeySchema, readOptionalString } from "../lib/tool-input.ts";

const log = createLogger("tools.get_failure_context");

export default defineTool({
  description:
    "Refresh failed job metadata and redacted logs for the current pipeline attempt. Usually unnecessary because initial failure context is already seeded.",
  inputSchema: optionalAttemptKeySchema,
  async execute(input, ctx) {
    const normalizedInput = normalizeToolInput(input);
    const { config, attempt } = resolveCurrentAttempt(ctx, readOptionalString(normalizedInput, "attemptKey"));
    const tlog = log.child({ attemptKey: attempt.key, provider: attempt.event.provider });
    tlog.debug("get_failure_context invoked");
    try {
      const failureContext = await getProviderClient(attempt.event.provider).getFailureContext(attempt.event);
      updateAttempt(config.statePath, attempt.key, { lastFailureContext: failureContext });
      tlog.info("failure context refreshed");
      return failureContext;
    } catch (error) {
      logError(tlog, "get_failure_context failed", error);
      throw error;
    }
  },
  toModelOutput(output) {
    return failureContextModelOutput(output);
  },
});

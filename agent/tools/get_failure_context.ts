import { defineTool } from "eve/tools";

import { resolveCurrentAttempt } from "../lib/current.ts";
import { getProviderClient } from "../lib/providers/index.ts";
import { updateAttempt } from "../lib/state.ts";
import { optionalAttemptKeySchema, readOptionalString } from "../lib/tool-input.ts";

export default defineTool({
  description:
    "Refresh failed job metadata and redacted logs for the current pipeline attempt. Usually unnecessary because initial failure context is already seeded.",
  inputSchema: optionalAttemptKeySchema,
  async execute(input, ctx) {
    const { config, attempt } = resolveCurrentAttempt(ctx, readOptionalString(input, "attemptKey"));
    const failureContext = await getProviderClient(attempt.event.provider).getFailureContext(attempt.event);
    updateAttempt(config.statePath, attempt.key, { lastFailureContext: failureContext });
    return failureContext;
  },
});

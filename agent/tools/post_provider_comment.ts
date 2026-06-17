import { defineTool } from "eve/tools";

import { resolveCurrentAttempt } from "../lib/current.ts";
import { getProviderClient } from "../lib/providers/index.ts";
import { commentSchema, readOptionalString, readRequiredString } from "../lib/tool-input.ts";

export default defineTool({
  description:
    "Post a concise status or blocker comment back to the provider surface for the current pipeline attempt.",
  inputSchema: commentSchema,
  async execute(input, ctx) {
    const { attempt } = resolveCurrentAttempt(ctx, readOptionalString(input, "attemptKey"));
    await getProviderClient(attempt.event.provider).postComment(attempt.event, readRequiredString(input, "body"));
    return { posted: true };
  },
});

import { defineTool } from "eve/tools";

import { resolveCurrentAttempt } from "../lib/current.ts";
import { createLogger, logError } from "../lib/logger.ts";
import { getProviderClient } from "../lib/providers/index.ts";
import { redact } from "../lib/redact.ts";
import { clearSessionOutcomePatch, updateAttempt } from "../lib/state.ts";
import {
  commentSchema,
  normalizeToolInput,
  readOptionalString,
  readRequiredAliasedString,
} from "../lib/tool-input.ts";

const log = createLogger("tools.post_provider_comment");

export default defineTool({
  description:
    "Post a concise status or blocker comment back to the provider surface for the current pipeline attempt.",
  inputSchema: commentSchema,
  async execute(input, ctx) {
    const normalizedInput = normalizeToolInput(input);
    const { config, attempt } = resolveCurrentAttempt(ctx, readOptionalString(normalizedInput, "attemptKey"));
    const tlog = log.child({ attemptKey: attempt.key, provider: attempt.event.provider });
    tlog.debug("post_provider_comment invoked");
    try {
      // The comment body is model-authored; do not log it.
      await getProviderClient(attempt.event.provider).postComment(
        attempt.event,
        redact(readRequiredAliasedString(normalizedInput, "body", ["message", "comment", "summary"]), 4_000),
      );
      updateAttempt(config.statePath, attempt.key, {
        ...clearSessionOutcomePatch(),
        lastSessionStatus: "completed",
        lastTerminalAction: "comment_posted",
      });
      tlog.info("provider comment posted");
      return { posted: true };
    } catch (error) {
      logError(tlog, "post_provider_comment failed", error);
      throw error;
    }
  },
  toModelOutput(output) {
    return { type: "json", value: output };
  },
});

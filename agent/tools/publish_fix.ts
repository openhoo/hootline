import { defineTool } from "eve/tools";

import { resolveStagedAttempt } from "../lib/current.ts";
import { createLogger, logError } from "../lib/logger.ts";
import { publishModelOutput } from "../lib/model-output.ts";
import { getProviderClient } from "../lib/providers/index.ts";
import { redact } from "../lib/redact.ts";
import { collectSandboxChanges, runVerificationCommandsWithPolicy } from "../lib/sandbox.ts";
import { clearSessionOutcomePatch, updateAttempt } from "../lib/state.ts";
import { normalizeToolInput, readRequiredAliasedString, summarySchema } from "../lib/tool-input.ts";

const log = createLogger("tools.publish_fix");

export default defineTool({
  description:
    "Publish verified sandbox changes according to repository policy. This tool reruns configured checks before publishing and rejects disallowed file paths.",
  inputSchema: summarySchema,
  async execute(input, ctx) {
    const normalizedInput = normalizeToolInput(input);
    const { config, attempt, policy, sandbox } = await resolveStagedAttempt(ctx, normalizedInput);
    const tlog = log.child({ attemptKey: attempt.key, provider: attempt.event.provider });
    tlog.debug("publish_fix invoked");
    try {
      const verification = await runVerificationCommandsWithPolicy(sandbox, policy);
      updateAttempt(config.statePath, attempt.key, { lastVerification: verification });
      if (!verification.ok) {
        tlog.info("publish skipped: verification failed");
        return {
          published: false,
          reason: "verification_failed",
          verification,
        };
      }
      const changes = await collectSandboxChanges(sandbox, policy);
      if (changes.length === 0) {
        tlog.info("publish skipped: no sandbox changes");
        return {
          published: false,
          reason: "no_changes",
          verification,
        };
      }
      const result = await getProviderClient(attempt.event.provider).publishFix({
        event: attempt.event,
        policy,
        changes,
        summary: redact(readRequiredAliasedString(normalizedInput, "summary", ["message", "body"]), 4_000),
      });
      updateAttempt(config.statePath, attempt.key, {
        ...clearSessionOutcomePatch(),
        lastPublishResult: result,
        lastSessionStatus: "completed",
        lastTerminalAction: "published",
        publishedBranch: result.branch,
        changeNumber: result.changeNumber,
        changeUrl: result.changeUrl,
        pendingAutoMerge: result.mode === "auto_merge" && result.changeNumber !== undefined,
      });
      // File paths/counts are safe to log; file contents are never logged.
      tlog.info(
        {
          branch: result.branch,
          changeNumber: result.changeNumber,
          changeUrl: result.changeUrl,
          mode: result.mode,
          fileCount: changes.length,
        },
        "fix published",
      );
      return {
        published: true,
        result,
        changes: changes.map((change) => ({ path: change.path, status: change.status })),
        verification,
      };
    } catch (error) {
      logError(tlog, "publish_fix failed", error);
      throw error;
    }
  },
  toModelOutput(output) {
    return publishModelOutput(output);
  },
});

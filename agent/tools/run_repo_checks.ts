import { defineTool } from "eve/tools";

import { resolveStagedAttempt } from "../lib/current.ts";
import { createLogger, logError } from "../lib/logger.ts";
import { verificationModelOutput } from "../lib/model-output.ts";
import { runVerificationCommandsWithPolicy } from "../lib/sandbox.ts";
import { updateAttempt } from "../lib/state.ts";
import { normalizeToolInput, optionalAttemptKeySchema } from "../lib/tool-input.ts";

const log = createLogger("tools.run_repo_checks");

export default defineTool({
  description:
    "Run the repository verification commands configured by policy in /workspace/repo. Applies the configured sandbox network allowlist before running.",
  inputSchema: optionalAttemptKeySchema,
  async execute(input, ctx) {
    const normalizedInput = normalizeToolInput(input);
    const { config, attempt, policy, sandbox } = await resolveStagedAttempt(ctx, normalizedInput);
    const tlog = log.child({ attemptKey: attempt.key, provider: attempt.event.provider });
    tlog.debug("run_repo_checks invoked");
    try {
      const result = await runVerificationCommandsWithPolicy(sandbox, policy);
      updateAttempt(config.statePath, attempt.key, { lastVerification: result });
      tlog.info({ ok: result.ok }, "verification commands completed");
      return result;
    } catch (error) {
      logError(tlog, "run_repo_checks failed", error);
      throw error;
    }
  },
  toModelOutput(output) {
    return verificationModelOutput(output);
  },
});

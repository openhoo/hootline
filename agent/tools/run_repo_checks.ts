import { defineTool } from "eve/tools";

import { resolveStagedAttempt } from "../lib/current.ts";
import { runVerificationCommandsWithPolicy } from "../lib/sandbox.ts";
import { updateAttempt } from "../lib/state.ts";
import { optionalAttemptKeySchema } from "../lib/tool-input.ts";

export default defineTool({
  description:
    "Run the repository verification commands configured by policy in /workspace/repo. Applies the configured sandbox network allowlist before running.",
  inputSchema: optionalAttemptKeySchema,
  async execute(input, ctx) {
    const { config, attempt, policy, sandbox } = await resolveStagedAttempt(ctx, input);
    const result = await runVerificationCommandsWithPolicy(sandbox, policy);
    updateAttempt(config.statePath, attempt.key, { lastVerification: result });
    return result;
  },
});

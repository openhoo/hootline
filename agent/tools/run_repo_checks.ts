import { defineTool } from "eve/tools";

import { assertSnapshotStaged, resolveCurrentAttempt } from "../lib/current.ts";
import { assertSandboxSnapshotReady, runVerificationCommandsWithPolicy } from "../lib/sandbox.ts";
import { updateAttempt } from "../lib/state.ts";
import { optionalAttemptKeySchema, readOptionalString } from "../lib/tool-input.ts";

export default defineTool({
  description:
    "Run the repository verification commands configured by policy in /workspace/repo. Applies the configured sandbox network allowlist before running.",
  inputSchema: optionalAttemptKeySchema,
  async execute(input, ctx) {
    const { config, attempt, policy } = resolveCurrentAttempt(ctx, readOptionalString(input, "attemptKey"));
    assertSnapshotStaged(attempt);
    const sandbox = await ctx.getSandbox();
    await assertSandboxSnapshotReady(sandbox, attempt);
    const result = await runVerificationCommandsWithPolicy(sandbox, policy);
    updateAttempt(config.statePath, attempt.key, { lastVerification: result });
    return result;
  },
});

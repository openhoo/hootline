import { defineTool } from "eve/tools";

import { assertSnapshotStaged, resolveCurrentAttempt } from "../lib/current.ts";
import { getProviderClient } from "../lib/providers/index.ts";
import { redact } from "../lib/redact.ts";
import {
  assertSandboxSnapshotReady,
  collectSandboxChanges,
  runVerificationCommandsWithPolicy,
} from "../lib/sandbox.ts";
import { updateAttempt } from "../lib/state.ts";
import { readOptionalString, readRequiredString, summarySchema } from "../lib/tool-input.ts";

export default defineTool({
  description:
    "Publish verified sandbox changes according to repository policy. This tool reruns configured checks before publishing and rejects disallowed file paths.",
  inputSchema: summarySchema,
  async execute(input, ctx) {
    const { config, attempt, policy } = resolveCurrentAttempt(ctx, readOptionalString(input, "attemptKey"));
    assertSnapshotStaged(attempt);
    const sandbox = await ctx.getSandbox();
    await assertSandboxSnapshotReady(sandbox, attempt);
    const verification = await runVerificationCommandsWithPolicy(sandbox, policy);
    updateAttempt(config.statePath, attempt.key, { lastVerification: verification });
    if (!verification.ok) {
      return {
        published: false,
        reason: "verification_failed",
        verification,
      };
    }
    const changes = await collectSandboxChanges(sandbox, policy);
    if (changes.length === 0) {
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
      summary: redact(readRequiredString(input, "summary"), 4_000),
    });
    updateAttempt(config.statePath, attempt.key, {
      lastPublishResult: result,
      publishedBranch: result.branch,
      changeNumber: result.changeNumber,
      changeUrl: result.changeUrl,
      pendingAutoMerge: result.mode === "auto_merge" && result.changeNumber !== undefined,
    });
    return {
      published: true,
      result,
      changes: changes.map((change) => ({ path: change.path, status: change.status })),
      verification,
    };
  },
});

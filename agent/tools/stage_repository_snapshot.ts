import { defineTool } from "eve/tools";

import { extractTarGzToSandbox } from "../lib/archive.ts";
import { resolveCurrentAttempt } from "../lib/current.ts";
import { getProviderClient } from "../lib/providers/index.ts";
import { writeSnapshotMarker } from "../lib/sandbox.ts";
import { updateAttempt } from "../lib/state.ts";
import { optionalAttemptKeySchema, readOptionalString } from "../lib/tool-input.ts";

export default defineTool({
  description:
    "Stage the failed repository snapshot into /workspace/repo from provider APIs without exposing provider credentials to the sandbox.",
  inputSchema: optionalAttemptKeySchema,
  async execute(input, ctx) {
    const { config, attempt, policy } = resolveCurrentAttempt(ctx, readOptionalString(input, "attemptKey"));
    const archive = await getProviderClient(attempt.event.provider).downloadArchive(
      attempt.event,
      policy.maxSnapshotBytes,
    );
    if (archive.byteLength > policy.maxSnapshotBytes) {
      throw new Error(
        `Repository archive is ${archive.byteLength} bytes, above policy limit ${policy.maxSnapshotBytes}.`,
      );
    }
    const sandbox = await ctx.getSandbox();
    const staged = await extractTarGzToSandbox({
      archive,
      sandbox,
      targetDir: "repo",
      maxBytes: policy.maxSnapshotBytes,
    });
    await writeSnapshotMarker(sandbox, attempt);
    updateAttempt(config.statePath, attempt.key, {
      repoStagedAt: new Date().toISOString(),
      repoStagedFiles: staged.files,
      repoStagedBytes: staged.bytes,
    });
    return {
      repoPath: "/workspace/repo",
      files: staged.files,
      bytes: staged.bytes,
      event: attempt.event,
      policy: {
        mode: policy.mode,
        allowedFileGlobs: policy.allowedFileGlobs,
        verificationCommands: policy.verificationCommands,
      },
    };
  },
});

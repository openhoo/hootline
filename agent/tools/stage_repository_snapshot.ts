import { defineTool } from "eve/tools";

import { extractTarGzToSandbox } from "../lib/archive.ts";
import { resolveCurrentAttempt } from "../lib/current.ts";
import { createLogger, logError } from "../lib/logger.ts";
import { getProviderClient } from "../lib/providers/index.ts";
import { writeSnapshotMarker } from "../lib/sandbox.ts";
import { updateAttempt } from "../lib/state.ts";
import { optionalAttemptKeySchema, readOptionalString } from "../lib/tool-input.ts";

const log = createLogger("tools.stage_repository_snapshot");

export default defineTool({
  description:
    "Stage the failed repository snapshot into /workspace/repo from provider APIs without exposing provider credentials to the sandbox.",
  inputSchema: optionalAttemptKeySchema,
  async execute(input, ctx) {
    const { config, attempt, policy } = resolveCurrentAttempt(ctx, readOptionalString(input, "attemptKey"));
    const tlog = log.child({ attemptKey: attempt.key, provider: attempt.event.provider });
    tlog.debug("stage_repository_snapshot invoked");
    try {
      // The provider client fetches a credentialed archive URL internally; never log it.
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
      tlog.info({ files: staged.files, bytes: staged.bytes }, "repository snapshot staged");
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
    } catch (error) {
      logError(tlog, "stage_repository_snapshot failed", error);
      throw error;
    }
  },
  toModelOutput(output) {
    return { type: "json", value: output };
  },
});

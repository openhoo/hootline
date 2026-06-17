import { findRepoPolicy, loadConfig } from "./config.ts";
import { getAttempt } from "./state.ts";
import type { AttemptRecord, PipelineFixerConfig, RepoPolicy } from "./types.ts";
import type { UnknownRecord } from "./unknown.ts";

type RuntimeContext = {
  readonly session?: {
    readonly auth?: {
      readonly current?: {
        readonly attributes?: UnknownRecord;
      } | null;
    };
  };
};

export interface CurrentAttemptContext {
  config: PipelineFixerConfig;
  attempt: AttemptRecord;
  policy: RepoPolicy;
}

export function resolveCurrentAttempt(
  ctx: RuntimeContext,
  attemptKey?: string,
): CurrentAttemptContext {
  const config = loadConfig();
  const key = attemptKey ?? readAttemptKey(ctx);
  if (key === undefined) {
    throw new Error("No attemptKey was supplied and none was available in session auth.");
  }
  const attempt = getAttempt(config.statePath, key);
  if (attempt === undefined) {
    throw new Error(`No pipeline fixer attempt exists for key ${key}.`);
  }
  const policy = findRepoPolicy(config, attempt.event.provider, attempt.event.repoSlug);
  if (policy === undefined) {
    throw new Error(`No policy configured for ${attempt.event.provider}:${attempt.event.repoSlug}.`);
  }
  return { config, attempt, policy };
}

export function assertSnapshotStaged(attempt: AttemptRecord): void {
  if (attempt.repoStagedAt === undefined) {
    throw new Error(
      "Repository snapshot has not been staged for this attempt. Call stage_repository_snapshot first.",
    );
  }
}

function readAttemptKey(ctx: RuntimeContext): string | undefined {
  const value = ctx.session?.auth?.current?.attributes?.attemptKey;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

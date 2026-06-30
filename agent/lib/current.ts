import { loadServiceConfig } from "./config.ts";
import { assertSandboxSnapshotReady } from "./sandbox.ts";
import { getAttempt } from "./state.ts";
import { readOptionalString } from "./tool-input.ts";
import type { AttemptRecord, HootlineServiceConfig, RepoPolicy } from "./types.ts";
import type { UnknownRecord } from "./unknown.ts";

/**
 * Minimal sandbox shape required to verify the staged-repository marker. It mirrors the
 * `SandboxMarkerReader` pick that {@link assertSandboxSnapshotReady} accepts so callers can stay
 * strictly typed without depending on the full sandbox session surface.
 */
type SnapshotReadySandbox = Parameters<typeof assertSandboxSnapshotReady>[0];

type RuntimeContext<S extends SnapshotReadySandbox = SnapshotReadySandbox> = {
  readonly session?: {
    readonly auth?: {
      readonly current?: {
        readonly attributes?: UnknownRecord;
      } | null;
    };
  };
  readonly getSandbox: () => Promise<S>;
};

export interface CurrentAttemptContext {
  config: HootlineServiceConfig;
  attempt: AttemptRecord;
  policy: RepoPolicy;
}

export interface StagedAttemptContext<S extends SnapshotReadySandbox = SnapshotReadySandbox>
  extends CurrentAttemptContext {
  sandbox: S;
}

export function resolveCurrentAttempt(
  ctx: RuntimeContext,
  attemptKey?: string,
): CurrentAttemptContext {
  const config = loadServiceConfig();
  const key = readAttemptKey(ctx);
  if (key === undefined) {
    throw new Error("No attemptKey was available in session auth.");
  }
  const explicitKey = normalizeAttemptKey(attemptKey);
  if (explicitKey !== undefined && explicitKey !== key) {
    throw new Error("Tool attemptKey input does not match the authenticated session attempt.");
  }
  const attempt = getAttempt(config.statePath, key);
  if (attempt === undefined) {
    throw new Error(`No pipeline fixer attempt exists for key ${key}.`);
  }
  return { config, attempt, policy: attempt.policy };
}

export function assertSnapshotStaged(attempt: AttemptRecord): void {
  if (attempt.repoStagedAt === undefined) {
    throw new Error(
      "Repository snapshot has not been staged for this attempt. Call stage_repository_snapshot first.",
    );
  }
}

/**
 * Resolve the current attempt and guarantee the repository snapshot is ready before any
 * repo read/edit/check/publish runs.
 *
 * Two complementary guards back this invariant:
 *   - {@link assertSnapshotStaged} is a cheap state-flag pre-check against the persisted attempt
 *     record (did stage_repository_snapshot ever run for this attempt?).
 *   - {@link assertSandboxSnapshotReady} reads the on-disk snapshot marker and is the authoritative
 *     cross-attempt guard: it proves the sandbox actually holds this attempt's staged work tree
 *     (right sandbox id, sha, pipeline) and not a stale or mismatched snapshot.
 *
 * Centralizing the sequence here means a new repo-touching tool cannot silently bypass a step by
 * forgetting to hand-copy the preamble.
 */
export async function resolveStagedAttempt<S extends SnapshotReadySandbox>(
  ctx: RuntimeContext<S>,
  input: UnknownRecord,
): Promise<StagedAttemptContext<S>> {
  const { config, attempt, policy } = resolveCurrentAttempt(ctx, readOptionalString(input, "attemptKey"));
  assertSnapshotStaged(attempt);
  const sandbox = await ctx.getSandbox();
  await assertSandboxSnapshotReady(sandbox, attempt);
  return { config, attempt, policy, sandbox };
}

function readAttemptKey(ctx: RuntimeContext): string | undefined {
  const value = ctx.session?.auth?.current?.attributes?.attemptKey;
  return normalizeAttemptKey(value);
}

function normalizeAttemptKey(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

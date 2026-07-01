import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";

import { z } from "zod";

import { repoPolicySchema } from "./config.ts";
import type {
  AttemptRecord,
  NormalizedPipelineEvent,
  PipelineFixerState,
  Provider,
  RepoPolicy,
  RerunRequestRecord,
} from "./types.ts";
import { isRecord } from "./unknown.ts";

export type { RerunRequestRecord } from "./types.ts";

// Returns a brand-new empty state. Must build fresh inner objects on every call:
// loadState/normalizeState hand this value to mutating helpers (recordAttempt,
// markDeliveryProcessed, ...), so a shared constant would alias processedDeliveries /
// attempts across unrelated state paths and leak entries between them.
function emptyState(): PipelineFixerState {
  return {
    processedDeliveries: {},
    attempts: {},
  };
}

const MAX_RERUN_REQUESTS_PER_ATTEMPT = 1;

export type RerunRequestClaim =
  | { claimed: true; request: RerunRequestRecord }
  | { claimed: false; request: RerunRequestRecord | undefined };

export type RepairSlotClaim =
  | { decision: "accepted"; attempt: AttemptRecord }
  | { decision: "in_progress"; attempt: AttemptRecord }
  | { decision: "max_attempts" };

// NOTE: These claim guards (claimRepairSlot, claimRerunRequest, claimAutoMerge,
// markDeliveryProcessed, releaseDelivery) serialize via an in-process promise-chain
// mutex and therefore assume a SINGLE Node instance. They prevent interleaving
// between concurrent requests in the same process, but provide no cross-process
// protection: two separate processes sharing the same state file could still race.
// A true cross-process guard would require an O_EXCL lockfile (or equivalent),
// which is explicitly out of scope here.

export type AttemptPatch = Partial<
  Pick<
    AttemptRecord,
    | "dispatchedAt"
    | "lastSessionId"
    | "lastSessionStatus"
    | "lastSessionFinishReason"
    | "lastSessionFailureKind"
    | "lastSessionFailure"
    | "lastSessionEndedAt"
    | "lastToolSequence"
    | "lastFailedTools"
    | "lastTerminalAction"
    | "lastInputTokens"
    | "lastOutputTokens"
    | "lastCacheReadTokens"
    | "lastCacheWriteTokens"
    | "lastTotalTokens"
    | "lastStepUsage"
    | "lastToolCallCount"
    | "lastToolErrorCount"
    | "lastEventsSeen"
    | "lastTelemetryRecords"
    | "telemetryPath"
    | "continuationsUsed"
    | "providerErrorRetriesUsed"
    | "repoStagedAt"
    | "repoStagedFiles"
    | "repoStagedBytes"
    | "lastFailureContext"
    | "lastVerification"
    | "lastPublishResult"
    | "publishedBranch"
    | "changeUrl"
    | "changeNumber"
    | "pendingAutoMerge"
  >
>;

export function clearSessionOutcomePatch(): AttemptPatch {
  return {
    lastSessionFinishReason: undefined,
    lastSessionFailureKind: undefined,
    lastSessionFailure: undefined,
    lastSessionEndedAt: undefined,
    lastTerminalAction: undefined,
    lastInputTokens: undefined,
    lastOutputTokens: undefined,
    lastCacheReadTokens: undefined,
    lastCacheWriteTokens: undefined,
    lastTotalTokens: undefined,
    lastStepUsage: undefined,
    lastToolCallCount: undefined,
    lastToolErrorCount: undefined,
    lastEventsSeen: undefined,
    lastTelemetryRecords: undefined,
    telemetryPath: undefined,
  };
}

const providerSchema = z.enum(["github", "gitlab"]);
const publishModeSchema = z.enum(["pr_mr", "push_branch", "auto_merge"]);

const normalizedPipelineEventSchema = z
  .object({
    provider: providerSchema,
    id: z.string(),
    deliveryId: z.string(),
    repoSlug: z.string(),
    projectId: z.string().optional(),
    installationId: z.number().optional(),
    pipelineId: z.string(),
    pipelineUrl: z.string().optional(),
    runId: z.string().optional(),
    checkSuiteId: z.string().optional(),
    ref: z.string(),
    sha: z.string(),
    source: z.string(),
    status: z.string(),
    conclusion: z.string(),
    actor: z.string().optional(),
    pullRequestNumber: z.number().optional(),
    mergeRequestIid: z.number().optional(),
    sourceBranch: z.string().optional(),
    targetBranch: z.string().optional(),
    eventName: z.string(),
    receivedAt: z.string(),
  })
  .passthrough();

const failedJobLogSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    url: z.string().optional(),
    conclusion: z.string().optional(),
    status: z.string().optional(),
    log: z.string(),
  })
  .passthrough();

const failureContextSchema = z
  .object({
    event: normalizedPipelineEventSchema,
    jobs: z.array(failedJobLogSchema),
    summary: z.string(),
  })
  .passthrough();

const publishResultSchema = z
  .object({
    provider: providerSchema,
    mode: publishModeSchema,
    branch: z.string(),
    commitSha: z.string().optional(),
    changeNumber: z.number().optional(),
    changeUrl: z.string().optional(),
    merged: z.boolean().optional(),
    message: z.string(),
  })
  .passthrough();

const rerunRequestRecordSchema = z
  .object({
    id: z.string(),
    requestedAt: z.string(),
    reason: z.string(),
    completedAt: z.string().optional(),
    result: z.unknown().optional(),
    failedAt: z.string().optional(),
    error: z.string().optional(),
  })
  .passthrough();

const repairSessionStepUsageSchema = z
  .object({
    stepIndex: z.number().int().nonnegative().optional(),
    finishReason: z.string().optional(),
    at: z.string().optional(),
    inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
    cacheReadTokens: z.number().int().nonnegative().optional(),
    cacheWriteTokens: z.number().int().nonnegative().optional(),
    totalTokens: z.number().int().nonnegative().optional(),
  })
  .passthrough();

const attemptRecordSchema = z
  .object({
    key: z.string(),
    provider: providerSchema,
    repoSlug: z.string(),
    sha: z.string(),
    pipelineId: z.string(),
    event: normalizedPipelineEventSchema,
    policy: repoPolicySchema,
    attempts: z.number().int().nonnegative(),
    firstSeenAt: z.string(),
    lastSeenAt: z.string(),
    dispatchedAt: z.string().optional(),
    lastSessionId: z.string().optional(),
    lastSessionStatus: z.enum(["running", "completed", "waiting", "failed", "abandoned"]).optional(),
    lastSessionFinishReason: z.string().optional(),
    lastSessionFailureKind: z
      .enum([
        "length",
        "no_terminal_action",
        "human_input_requested",
        "provider_error",
        "stream_error",
        "timeout",
      ])
      .optional(),
    lastSessionFailure: z.string().optional(),
    lastSessionEndedAt: z.string().optional(),
    lastToolSequence: z.array(z.string()).optional(),
    lastFailedTools: z.array(z.string()).optional(),
    lastTerminalAction: z.string().optional(),
    lastInputTokens: z.number().int().nonnegative().optional(),
    lastOutputTokens: z.number().int().nonnegative().optional(),
    lastCacheReadTokens: z.number().int().nonnegative().optional(),
    lastCacheWriteTokens: z.number().int().nonnegative().optional(),
    lastTotalTokens: z.number().int().nonnegative().optional(),
    lastStepUsage: z.array(repairSessionStepUsageSchema).optional(),
    lastToolCallCount: z.number().int().nonnegative().optional(),
    lastToolErrorCount: z.number().int().nonnegative().optional(),
    lastEventsSeen: z.number().int().nonnegative().optional(),
    lastTelemetryRecords: z.number().int().nonnegative().optional(),
    telemetryPath: z.string().optional(),
    continuationsUsed: z.number().int().nonnegative().optional(),
    providerErrorRetriesUsed: z.number().int().nonnegative().optional(),
    repoStagedAt: z.string().optional(),
    repoStagedFiles: z.number().int().nonnegative().optional(),
    repoStagedBytes: z.number().int().nonnegative().optional(),
    lastFailureContext: z.union([failureContextSchema, z.object({ error: z.string() })]).optional(),
    lastVerification: z.unknown().optional(),
    lastPublishResult: publishResultSchema.optional(),
    publishedBranch: z.string().optional(),
    changeUrl: z.string().optional(),
    changeNumber: z.number().optional(),
    pendingAutoMerge: z.boolean().optional(),
    rerunRequests: z.array(rerunRequestRecordSchema).optional(),
  })
  .passthrough();

const stateShapeSchema = z
  .object({
    processedDeliveries: z.unknown().optional(),
    attempts: z.unknown().optional(),
  })
  .passthrough();

export function loadState(path: string): PipelineFixerState {
  const statePath = resolve(path);
  try {
    return normalizeState(JSON.parse(readFileSync(statePath, "utf8")));
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return emptyState();
    throw error;
  }
}

export function saveState(path: string, state: PipelineFixerState): void {
  const statePath = resolve(path);
  mkdirSync(dirname(statePath), { recursive: true });
  // Unique per write so two interleaved writes never share a temp file (PID alone
  // is not unique within a single process). Write-temp-then-rename keeps atomicity.
  const tempPath = `${statePath}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tempPath, statePath);
}

// In-process serialization wrapper: a promise-chain mutex. Each call chains onto
// the previous, so critical sections that span an async boundary (or simply must
// not interleave) run one at a time within this Node process. See the cross-process
// caveat documented near the top of this module.
let mutexChain: Promise<unknown> = Promise.resolve();

function withStateLock<T>(critical: () => T | Promise<T>): Promise<T> {
  const result = mutexChain.then(() => critical());
  // Keep the chain alive even if a critical section rejects, so later callers run.
  mutexChain = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

export function eventAttemptKey(event: NormalizedPipelineEvent): string {
  return `${event.provider}:${event.repoSlug}:${event.sha}:${event.pipelineId}`;
}

export function markDeliveryProcessed(
  path: string,
  deliveryKey: string,
  sessionId: string,
): boolean {
  const state = loadState(path);
  if (state.processedDeliveries[deliveryKey] !== undefined) return false;
  state.processedDeliveries[deliveryKey] = sessionId;
  saveState(path, state);
  return true;
}

// Removes a previously marked delivery so a provider redelivery can retry it
// instead of being dropped as a duplicate. Serialized like the other claim guards.
export function releaseDelivery(path: string, deliveryKey: string): Promise<void> {
  return withStateLock(() => {
    const state = loadState(path);
    if (state.processedDeliveries[deliveryKey] === undefined) return;
    delete state.processedDeliveries[deliveryKey];
    saveState(path, state);
  });
}

export function recordAttempt(
  path: string,
  event: NormalizedPipelineEvent,
  policy: RepoPolicy,
): AttemptRecord {
  const state = loadState(path);
  const key = eventAttemptKey(event);
  const now = new Date().toISOString();
  const existing = state.attempts[key];
  const next: AttemptRecord =
    existing === undefined
      ? {
          key,
          provider: event.provider,
          repoSlug: event.repoSlug,
          sha: event.sha,
          pipelineId: event.pipelineId,
          event,
          policy,
          attempts: 1,
          firstSeenAt: now,
          lastSeenAt: now,
        }
      : resetAttemptForRetry(existing, event, policy, now);
  state.attempts[key] = next;
  saveState(path, state);
  return next;
}

function resetAttemptForRetry(
  existing: AttemptRecord,
  event: NormalizedPipelineEvent,
  policy: RepoPolicy,
  now: string,
): AttemptRecord {
  return {
    ...existing,
    event,
    policy,
    attempts: existing.attempts + 1,
    lastSeenAt: now,
    dispatchedAt: undefined,
    lastSessionId: undefined,
    lastSessionStatus: undefined,
    lastSessionFinishReason: undefined,
    lastSessionFailureKind: undefined,
    lastSessionFailure: undefined,
    lastSessionEndedAt: undefined,
    lastToolSequence: undefined,
    lastFailedTools: undefined,
    lastTerminalAction: undefined,
    lastInputTokens: undefined,
    lastOutputTokens: undefined,
    lastCacheReadTokens: undefined,
    lastCacheWriteTokens: undefined,
    lastTotalTokens: undefined,
    lastStepUsage: undefined,
    lastToolCallCount: undefined,
    lastToolErrorCount: undefined,
    lastEventsSeen: undefined,
    lastTelemetryRecords: undefined,
    telemetryPath: undefined,
    continuationsUsed: undefined,
    providerErrorRetriesUsed: undefined,
    repoStagedAt: undefined,
    repoStagedFiles: undefined,
    repoStagedBytes: undefined,
    lastFailureContext: undefined,
    lastVerification: undefined,
    lastPublishResult: undefined,
    publishedBranch: undefined,
    changeUrl: undefined,
    changeNumber: undefined,
    pendingAutoMerge: undefined,
    rerunRequests: undefined,
  };
}

// Atomically claims a repair slot for an event as one critical section so the
// in-progress check and the per-sha cap can never race with a concurrent claim:
//   - if an active repair already exists -> { decision: "in_progress", attempt }
//   - else if recording one more attempt would exceed policy.maxAttemptsPerSha ->
//     { decision: "max_attempts" } WITHOUT recording (cap is evaluated BEFORE record)
//   - else record the attempt -> { decision: "accepted", attempt }
export function claimRepairSlot(
  path: string,
  event: NormalizedPipelineEvent,
  policy: RepoPolicy,
): Promise<RepairSlotClaim> {
  return withStateLock(() => {
    const active = findActiveRepairAttemptForSha(path, {
      provider: event.provider,
      repoSlug: event.repoSlug,
      sha: event.sha,
    });
    if (active !== undefined) return { decision: "in_progress", attempt: active };

    const existingCount = countAttemptsForSha(path, {
      provider: event.provider,
      repoSlug: event.repoSlug,
      sha: event.sha,
    });
    // Mirror the legacy boundary: recording one more must not exceed the cap.
    if (existingCount + 1 > policy.maxAttemptsPerSha) return { decision: "max_attempts" };

    const attempt = recordAttempt(path, event, policy);
    // Mark the slot dispatched in the same critical section so a concurrent event for
    // the same sha (e.g. GitHub's paired workflow_run + check_suite, which carry the
    // same sha under different pipeline ids) immediately sees the repair as in
    // progress and does not double-start it. The marker is cleared if the launch
    // fails (see startRepairSession) and ages out with the recent window.
    const dispatchedAt = new Date().toISOString();
    updateAttempt(path, attempt.key, { dispatchedAt });
    return { decision: "accepted", attempt: { ...attempt, dispatchedAt } };
  });
}

// Atomically flips pendingAutoMerge from true to false for a single attempt and
// reports whether this caller won the claim. Use restoreAutoMergeClaim to put the
// flag back if the downstream merge fails and should be retried by a later event.
export function claimAutoMerge(path: string, key: string): Promise<boolean> {
  return withStateLock(() => {
    const state = loadState(path);
    const existing = state.attempts[key];
    if (existing === undefined || existing.pendingAutoMerge !== true) return false;
    state.attempts[key] = { ...existing, pendingAutoMerge: false };
    saveState(path, state);
    return true;
  });
}

export function restoreAutoMergeClaim(path: string, key: string): Promise<void> {
  return withStateLock(() => {
    updateAttempt(path, key, { pendingAutoMerge: true });
  });
}

export function getAttempt(path: string, key: string): AttemptRecord | undefined {
  return loadState(path).attempts[key];
}

export function countAttemptsForSha(path: string, input: {
  provider: Provider;
  repoSlug: string;
  sha: string;
}): number {
  const state = loadState(path);
  return Object.values(state.attempts).reduce(
    (count, attempt) =>
      attempt.provider === input.provider &&
      attempt.repoSlug === input.repoSlug &&
      attempt.sha === input.sha
        ? count + attempt.attempts
        : count,
    0,
  );
}

export function findActiveRepairAttemptForSha(path: string, input: {
  provider: Provider;
  repoSlug: string;
  sha: string;
  now?: Date;
  recentWindowMs?: number;
}): AttemptRecord | undefined {
  const nowMs = input.now?.getTime() ?? Date.now();
  const recentWindowMs = input.recentWindowMs ?? 15 * 60 * 1000;
  return Object.values(loadState(path).attempts)
    .filter(
      (attempt) =>
        attempt.provider === input.provider &&
        attempt.repoSlug === input.repoSlug &&
        attempt.sha === input.sha &&
        isActiveRepairAttempt(attempt, nowMs, recentWindowMs),
    )
    .sort((left, right) => Date.parse(right.lastSeenAt) - Date.parse(left.lastSeenAt))[0];
}

export function getRerunRequests(path: string, key: string): RerunRequestRecord[] {
  const attempt = getAttempt(path, key);
  return attempt === undefined ? [] : readRerunRequests(attempt);
}

export function claimRerunRequest(path: string, key: string, reason: string): RerunRequestClaim {
  const state = loadState(path);
  const existing = state.attempts[key];
  if (existing === undefined) return { claimed: false, request: undefined };

  const requests = readRerunRequests(existing);
  if (requests.length >= MAX_RERUN_REQUESTS_PER_ATTEMPT) {
    return { claimed: false, request: requests[requests.length - 1] };
  }

  const requestedAt = new Date().toISOString();
  const request: RerunRequestRecord = {
    // Unique id source so two interleaved claims can never collide on requests.length.
    id: `${key}:rerun:${randomUUID()}`,
    requestedAt,
    reason,
  };
  state.attempts[key] = withRerunRequests(existing, [...requests, request]);
  saveState(path, state);
  return { claimed: true, request };
}

export function recordRerunResult(
  path: string,
  key: string,
  requestId: string,
  result: unknown,
): void {
  updateRerunRequest(path, key, requestId, {
    completedAt: new Date().toISOString(),
    result,
  });
}

export function recordRerunFailure(
  path: string,
  key: string,
  requestId: string,
  error: string,
): void {
  updateRerunRequest(path, key, requestId, {
    failedAt: new Date().toISOString(),
    error,
  });
}

export function updateAttempt(path: string, key: string, patch: AttemptPatch): void {
  const state = loadState(path);
  const existing = state.attempts[key];
  if (existing === undefined) return;
  state.attempts[key] = { ...existing, ...patch };
  saveState(path, state);
}

export function findPendingAutoMergeAttempt(path: string, input: {
  provider: Provider;
  repoSlug: string;
  branch: string;
  sha?: string;
}): AttemptRecord | undefined {
  const state = loadState(path);
  return Object.values(state.attempts).find(
    (attempt) =>
      attempt.provider === input.provider &&
      attempt.repoSlug === input.repoSlug &&
      attempt.pendingAutoMerge === true &&
      attempt.publishedBranch === input.branch &&
      attempt.changeNumber !== undefined &&
      publishedCommitMatches(attempt, input.sha),
  );
}

function publishedCommitMatches(attempt: AttemptRecord, successSha: string | undefined): boolean {
  const publishedCommitSha = attempt.lastPublishResult?.commitSha;
  return publishedCommitSha === undefined || successSha === publishedCommitSha;
}

function isActiveRepairAttempt(attempt: AttemptRecord, nowMs: number, recentWindowMs: number): boolean {
  if (
    attempt.lastPublishResult !== undefined ||
    attempt.publishedBranch !== undefined ||
    attempt.changeNumber !== undefined ||
    attempt.pendingAutoMerge === true
  ) {
    return true;
  }
  if (attempt.lastSessionStatus === "failed" || attempt.lastSessionStatus === "abandoned") {
    return false;
  }
  const lastSeenMs = Date.parse(attempt.lastSeenAt);
  const isRecent = Number.isFinite(lastSeenMs) && nowMs - lastSeenMs <= recentWindowMs;
  if (!isRecent) return false;
  // A recent attempt is "in progress" once it has been dispatched (claimRepairSlot
  // marks dispatchedAt inside its critical section) or once a session actually started
  // doing work. A bare recordAttempt with none of these markers is NOT active, so a
  // slot that failed to launch (dispatchedAt cleared) can be reclaimed by a redelivery.
  return (
    attempt.dispatchedAt !== undefined ||
    attempt.lastSessionId !== undefined ||
    attempt.repoStagedAt !== undefined ||
    attempt.lastFailureContext !== undefined ||
    attempt.lastVerification !== undefined
  );
}

function updateRerunRequest(
  path: string,
  key: string,
  requestId: string,
  patch: Partial<Pick<RerunRequestRecord, "completedAt" | "result" | "failedAt" | "error">>,
): void {
  const state = loadState(path);
  const existing = state.attempts[key];
  if (existing === undefined) return;
  const requests = readRerunRequests(existing);
  const index = requests.findIndex((request) => request.id === requestId);
  if (index === -1) return;
  const nextRequests = [...requests];
  const current = nextRequests[index];
  if (current === undefined) return;
  nextRequests[index] = { ...current, ...patch };
  state.attempts[key] = withRerunRequests(existing, nextRequests);
  saveState(path, state);
}

function readRerunRequests(attempt: AttemptRecord): RerunRequestRecord[] {
  const requests = attempt.rerunRequests;
  return Array.isArray(requests) ? requests.filter(isRerunRequestRecord) : [];
}

function withRerunRequests(
  attempt: AttemptRecord,
  rerunRequests: RerunRequestRecord[],
): AttemptRecord {
  return { ...attempt, rerunRequests };
}

function isRerunRequestRecord(value: unknown): value is RerunRequestRecord {
  return rerunRequestRecordSchema.safeParse(value).success;
}

function normalizeState(value: unknown): PipelineFixerState {
  const parsed = stateShapeSchema.safeParse(value);
  if (!parsed.success) return emptyState();
  return {
    processedDeliveries: readStringRecord(parsed.data.processedDeliveries),
    attempts: readAttemptRecordMap(parsed.data.attempts),
  };
}

function readStringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

function readAttemptRecordMap(value: unknown): Record<string, AttemptRecord> {
  if (!isRecord(value)) return {};
  const attempts: Record<string, AttemptRecord> = {};
  for (const [key, attempt] of Object.entries(value)) {
    const parsed = attemptRecordSchema.safeParse(normalizeAttemptInput(attempt));
    if (parsed.success && isConsistentAttemptKey(key, parsed.data)) attempts[key] = parsed.data;
  }
  return attempts;
}

function isConsistentAttemptKey(key: string, attempt: AttemptRecord): boolean {
  return attempt.key === key && eventAttemptKey(attempt.event) === key;
}

function normalizeAttemptInput(value: unknown): unknown {
  if (!isRecord(value)) return value;
  return {
    ...value,
    rerunRequests: readRerunRequestRecords(value.rerunRequests),
  };
}

function readRerunRequestRecords(value: unknown): RerunRequestRecord[] {
  return Array.isArray(value) ? value.filter(isRerunRequestRecord) : [];
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}

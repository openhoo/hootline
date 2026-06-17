import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { z } from "zod";

import type {
  AttemptRecord,
  NormalizedPipelineEvent,
  PipelineFixerState,
  Provider,
  RerunRequestRecord,
} from "./types.ts";
import { isRecord } from "./unknown.ts";

export type { RerunRequestRecord } from "./types.ts";

const EMPTY_STATE: PipelineFixerState = {
  processedDeliveries: {},
  attempts: {},
};

const MAX_RERUN_REQUESTS_PER_ATTEMPT = 1;

export type RerunRequestClaim =
  | { claimed: true; request: RerunRequestRecord }
  | { claimed: false; request: RerunRequestRecord | undefined };

export type AttemptPatch = Partial<
  Pick<
    AttemptRecord,
    | "lastSessionId"
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

const attemptRecordSchema = z
  .object({
    key: z.string(),
    provider: providerSchema,
    repoSlug: z.string(),
    sha: z.string(),
    pipelineId: z.string(),
    event: normalizedPipelineEventSchema,
    attempts: z.number().int().nonnegative(),
    firstSeenAt: z.string(),
    lastSeenAt: z.string(),
    lastSessionId: z.string().optional(),
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
    if (isNodeError(error) && error.code === "ENOENT") return { ...EMPTY_STATE };
    throw error;
  }
}

export function saveState(path: string, state: PipelineFixerState): void {
  const statePath = resolve(path);
  mkdirSync(dirname(statePath), { recursive: true });
  const tempPath = `${statePath}.${process.pid}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tempPath, statePath);
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

export function recordAttempt(path: string, event: NormalizedPipelineEvent): AttemptRecord {
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
          attempts: 1,
          firstSeenAt: now,
          lastSeenAt: now,
        }
      : { ...existing, event, attempts: existing.attempts + 1, lastSeenAt: now };
  state.attempts[key] = next;
  saveState(path, state);
  return next;
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
    id: `${key}:rerun:${requests.length + 1}`,
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
  const lastSeenMs = Date.parse(attempt.lastSeenAt);
  const isRecent = Number.isFinite(lastSeenMs) && nowMs - lastSeenMs <= recentWindowMs;
  if (!isRecent) return false;
  if (
    attempt.lastSessionId !== undefined ||
    attempt.repoStagedAt !== undefined ||
    attempt.lastFailureContext !== undefined ||
    attempt.lastVerification !== undefined
  ) {
    return true;
  }
  return true;
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
  if (!parsed.success) return { ...EMPTY_STATE };
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

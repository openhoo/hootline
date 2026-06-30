import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";

import { assertSnapshotStaged } from "../agent/lib/current.ts";
import {
  claimAutoMerge,
  claimRepairSlot,
  claimRerunRequest,
  countAttemptsForSha,
  eventAttemptKey,
  findActiveRepairAttemptForSha,
  findPendingAutoMergeAttempt,
  getAttempt,
  getRerunRequests,
  loadState,
  markDeliveryProcessed,
  recordAttempt,
  recordRerunResult,
  releaseDelivery,
  restoreAutoMergeClaim,
  updateAttempt,
} from "../agent/lib/state.ts";
import type { NormalizedPipelineEvent, RepoPolicy } from "../agent/lib/types.ts";

test("records attempts, dedupes deliveries, and finds pending auto-merge changes", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "hootline-state-"));
  const statePath = join(tempRoot, "state.json");
  try {
    const event = makeEvent();
    const key = eventAttemptKey(event);

    assert.equal(markDeliveryProcessed(statePath, "github:delivery-1", "pending"), true);
    assert.equal(markDeliveryProcessed(statePath, "github:delivery-1", "pending"), false);

    const first = recordAttempt(statePath, event, makePolicy());
    const second = recordAttempt(statePath, { ...event, deliveryId: "delivery-2" }, makePolicy());
    assert.equal(first.key, key);
    assert.equal(second.attempts, 2);
    assert.equal(getAttempt(statePath, key)?.event.deliveryId, "delivery-2");
    updateAttempt(statePath, key, {
      lastFailedTools: ["edit_repo_file"],
      lastTerminalAction: "published",
      lastInputTokens: 123,
      lastOutputTokens: 456,
      lastEventsSeen: 12,
    });
    assert.deepEqual(getAttempt(statePath, key)?.lastFailedTools, ["edit_repo_file"]);
    assert.equal(getAttempt(statePath, key)?.lastTerminalAction, "published");
    assert.equal(getAttempt(statePath, key)?.lastInputTokens, 123);
    assert.equal(getAttempt(statePath, key)?.lastOutputTokens, 456);
    assert.equal(getAttempt(statePath, key)?.lastEventsSeen, 12);

    assert.throws(() => assertSnapshotStaged(second), /stage_repository_snapshot/);
    updateAttempt(statePath, key, {
      repoStagedAt: "2026-06-17T00:00:00.000Z",
      repoStagedFiles: 10,
      repoStagedBytes: 2048,
      publishedBranch: "hootline/fix/main/abc123def456",
      changeNumber: 42,
      pendingAutoMerge: true,
    });
    const updated = getAttempt(statePath, key);
    assert.ok(updated);
    assert.doesNotThrow(() => assertSnapshotStaged(updated));
    assert.equal(
      findPendingAutoMergeAttempt(statePath, {
        provider: "github",
        repoSlug: "owner/repo",
        branch: "hootline/fix/main/abc123def456",
      })?.changeNumber,
      42,
    );
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("counts attempts for a sha across pipeline ids", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "hootline-state-"));
  const statePath = join(tempRoot, "state.json");
  try {
    const firstPipeline = makeEvent();
    const secondPipeline = makeEvent({
      id: "github:owner/repo:1002:abc123def456",
      deliveryId: "delivery-2",
      pipelineId: "1002",
      pipelineUrl: "https://github.com/owner/repo/actions/runs/1002",
      runId: "1002",
    });

    recordAttempt(statePath, firstPipeline, makePolicy());
    recordAttempt(statePath, { ...firstPipeline, deliveryId: "delivery-3" }, makePolicy());
    recordAttempt(statePath, secondPipeline, makePolicy());

    assert.equal(
      countAttemptsForSha(statePath, {
        provider: "github",
        repoSlug: "owner/repo",
        sha: "abc123def456",
      }),
      3,
    );
    assert.equal(
      countAttemptsForSha(statePath, {
        provider: "github",
        repoSlug: "owner/repo",
        sha: "unrelated-sha",
      }),
      0,
    );
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("repeat attempts refresh policy and clear prior repair state", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "hootline-state-"));
  const statePath = join(tempRoot, "state.json");
  try {
    const event = makeEvent();
    const key = eventAttemptKey(event);
    recordAttempt(statePath, event, makePolicy({ allowedFileGlobs: ["src/**"] }));
    updateAttempt(statePath, key, {
      lastSessionId: "session-old",
      lastSessionStatus: "abandoned",
      lastTerminalAction: "published",
      repoStagedAt: event.receivedAt,
      lastVerification: { ok: true },
      lastPublishResult: {
        provider: "github",
        mode: "pr_mr",
        branch: "hootline/fix/main/abc123def456",
        commitSha: "old-fix",
        changeNumber: 42,
        message: "Published old PR.",
      },
      publishedBranch: "hootline/fix/main/abc123def456",
      changeNumber: 42,
      pendingAutoMerge: true,
    });

    const nextPolicy = makePolicy({
      allowedFileGlobs: ["src/**", "package.json"],
      verificationCommands: ["npm test", "npm run lint"],
    });
    const repeated = recordAttempt(statePath, { ...event, deliveryId: "delivery-2" }, nextPolicy);

    assert.equal(repeated.attempts, 2);
    assert.deepEqual(repeated.policy.allowedFileGlobs, ["src/**", "package.json"]);
    assert.deepEqual(repeated.policy.verificationCommands, ["npm test", "npm run lint"]);
    assert.equal(repeated.lastSessionId, undefined);
    assert.equal(repeated.lastSessionStatus, undefined);
    assert.equal(repeated.lastTerminalAction, undefined);
    assert.equal(repeated.repoStagedAt, undefined);
    assert.equal(repeated.lastVerification, undefined);
    assert.equal(repeated.lastPublishResult, undefined);
    assert.equal(repeated.publishedBranch, undefined);
    assert.equal(repeated.changeNumber, undefined);
    assert.equal(repeated.pendingAutoMerge, undefined);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("finds active repair attempts for duplicate pipeline events without pinning stale empty attempts", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "hootline-state-"));
  const statePath = join(tempRoot, "state.json");
  try {
    const event = makeEvent();
    const key = eventAttemptKey(event);
    const now = new Date();
    const afterRecentWindow = new Date(now.getTime() + 1000);
    recordAttempt(statePath, event, makePolicy());

    // A freshly recorded attempt with none of the started-work markers
    // (lastSessionId / repoStagedAt / lastFailureContext / lastVerification) is NOT
    // in progress, even within the recent window. The previous assertion expected the
    // bare attempt to be returned here; that encoded the dead always-true branch in
    // isActiveRepairAttempt and is corrected below to assert the never-started case is
    // not active. Once a repair session actually starts (lastSessionId set), the
    // attempt is reported active again within the window.
    assert.equal(
      findActiveRepairAttemptForSha(statePath, {
        provider: "github",
        repoSlug: "owner/repo",
        sha: "abc123def456",
        now,
      }),
      undefined,
    );

    updateAttempt(statePath, key, { lastSessionId: "session-active" });
    assert.equal(
      findActiveRepairAttemptForSha(statePath, {
        provider: "github",
        repoSlug: "owner/repo",
        sha: "abc123def456",
        now,
      })?.key,
      key,
    );
    assert.equal(
      findActiveRepairAttemptForSha(statePath, {
        provider: "github",
        repoSlug: "owner/repo",
        sha: "abc123def456",
        now: afterRecentWindow,
        recentWindowMs: 1,
      }),
      undefined,
    );

    updateAttempt(statePath, key, {
      lastPublishResult: {
        provider: "github",
        mode: "pr_mr",
        branch: "hootline/fix/main/abc123def456",
        commitSha: "fix123456789",
        changeNumber: 42,
        message: "Published fix PR #42.",
      },
      publishedBranch: "hootline/fix/main/abc123def456",
      changeNumber: 42,
    });
    assert.equal(
      findActiveRepairAttemptForSha(statePath, {
        provider: "github",
        repoSlug: "owner/repo",
        sha: "abc123def456",
        now: afterRecentWindow,
        recentWindowMs: 1,
      })?.key,
      key,
    );
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("claims only one rerun request per attempt", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "hootline-state-"));
  const statePath = join(tempRoot, "state.json");
  try {
    const event = makeEvent();
    const key = eventAttemptKey(event);
    recordAttempt(statePath, event, makePolicy());

    const first = claimRerunRequest(statePath, key, "runner lost network");
    assert.ok(first.claimed);
    assert.equal(first.request.reason, "runner lost network");

    const second = claimRerunRequest(statePath, key, "try again");
    assert.equal(second.claimed, false);
    assert.equal(second.request?.id, first.request.id);

    recordRerunResult(statePath, key, first.request.id, {
      message: "Requested rerun of failed jobs.",
    });

    const requests = getRerunRequests(statePath, key);
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0]?.result, {
      message: "Requested rerun of failed jobs.",
    });
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("pending auto-merge lookup requires matching success sha when publish commit is known", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "hootline-state-"));
  const statePath = join(tempRoot, "state.json");
  try {
    const event = makeEvent();
    const key = eventAttemptKey(event);
    recordAttempt(statePath, event, makePolicy());

    updateAttempt(statePath, key, {
      publishedBranch: "hootline/fix/main/abc123def456",
      changeNumber: 42,
      pendingAutoMerge: true,
      lastPublishResult: {
        provider: "github",
        mode: "auto_merge",
        branch: "hootline/fix/main/abc123def456",
        commitSha: "fix123456789",
        changeNumber: 42,
        message: "Published fix branch.",
      },
    });

    assert.equal(
      findPendingAutoMergeAttempt(statePath, {
        provider: "github",
        repoSlug: "owner/repo",
        branch: "hootline/fix/main/abc123def456",
        sha: "different123456",
      }),
      undefined,
    );
    assert.equal(
      findPendingAutoMergeAttempt(statePath, {
        provider: "github",
        repoSlug: "owner/repo",
        branch: "hootline/fix/main/abc123def456",
      }),
      undefined,
    );
    assert.equal(
      findPendingAutoMergeAttempt(statePath, {
        provider: "github",
        repoSlug: "owner/repo",
        branch: "hootline/fix/main/abc123def456",
        sha: "fix123456789",
      })?.changeNumber,
      42,
    );
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("normalizes persisted state without trusting malformed JSON fields", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "hootline-state-"));
  const statePath = join(tempRoot, "state.json");
  try {
    const event = makeEvent();
    const key = eventAttemptKey(event);
    writeFileSync(
      statePath,
      `${JSON.stringify(
        {
          processedDeliveries: {
            "github:delivery-1": "session-1",
            "github:bad-delivery": 123,
          },
          attempts: {
            [key]: {
              key,
              provider: "github",
              repoSlug: "owner/repo",
              sha: "abc123def456",
              pipelineId: "1001",
              event,
              policy: makePolicy(),
              attempts: 1,
              firstSeenAt: "2026-06-17T00:00:00.000Z",
              lastSeenAt: "2026-06-17T00:00:00.000Z",
              rerunRequests: [
                {
                  id: `${key}:rerun:1`,
                  requestedAt: "2026-06-17T00:01:00.000Z",
                  reason: "runner outage",
                },
                {
                  id: `${key}:rerun:bad`,
                  requestedAt: 123,
                  reason: "bad entry",
                },
              ],
            },
            malformed: {
              key: "malformed",
              provider: "github",
            },
            mismatchedKey: {
              key,
              provider: "github",
              repoSlug: "owner/repo",
              sha: "abc123def456",
              pipelineId: "1001",
              event,
              policy: makePolicy(),
              attempts: 1,
              firstSeenAt: "2026-06-17T00:00:00.000Z",
              lastSeenAt: "2026-06-17T00:00:00.000Z",
            },
            [eventAttemptKey({ ...event, pipelineId: "9999" })]: {
              key: eventAttemptKey({ ...event, pipelineId: "9999" }),
              provider: "github",
              repoSlug: "owner/repo",
              sha: "abc123def456",
              pipelineId: "9999",
              event,
              policy: makePolicy(),
              attempts: 1,
              firstSeenAt: "2026-06-17T00:00:00.000Z",
              lastSeenAt: "2026-06-17T00:00:00.000Z",
            },
            missingGuardrails: {
              key: eventAttemptKey({ ...event, pipelineId: "8888", id: "github:owner/repo:8888:abc123def456" }),
              provider: "github",
              repoSlug: "owner/repo",
              sha: "abc123def456",
              pipelineId: "8888",
              event: { ...event, pipelineId: "8888", id: "github:owner/repo:8888:abc123def456" },
              policy: {
                provider: "github",
                slug: "owner/repo",
              },
              attempts: 1,
              firstSeenAt: "2026-06-17T00:00:00.000Z",
              lastSeenAt: "2026-06-17T00:00:00.000Z",
            },
          },
        },
        null,
        2,
      )}\n`,
    );

    const state = loadState(statePath);
    assert.deepEqual(state.processedDeliveries, { "github:delivery-1": "session-1" });
    assert.deepEqual(Object.keys(state.attempts), [key]);
    assert.equal(getRerunRequests(statePath, key).length, 1);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("does not report a freshly recorded attempt with no started-work markers as active", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "hootline-state-"));
  const statePath = join(tempRoot, "state.json");
  try {
    const event = makeEvent();
    recordAttempt(statePath, event, makePolicy());

    // A recorded-but-never-started attempt (no lastSessionId / repoStagedAt /
    // lastFailureContext / lastVerification and no publish fields) must not count
    // as an in-progress repair, even immediately after recording.
    assert.equal(
      findActiveRepairAttemptForSha(statePath, {
        provider: "github",
        repoSlug: "owner/repo",
        sha: "abc123def456",
        now: new Date(event.receivedAt),
      }),
      undefined,
    );
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("claimRepairSlot records the first attempt and reports in_progress once started", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "hootline-state-"));
  const statePath = join(tempRoot, "state.json");
  try {
    const event = makeEvent();
    const key = eventAttemptKey(event);
    const policy = makePolicy({ maxAttemptsPerSha: 3 });

    const first = await claimRepairSlot(statePath, event, policy);
    assert.equal(first.decision, "accepted");
    assert.equal(first.decision === "accepted" ? first.attempt.key : undefined, key);
    assert.equal(getAttempt(statePath, key)?.attempts, 1);

    // claimRepairSlot marks the slot dispatched in its critical section, so a second
    // event for the same sha is immediately deduped as in_progress and records nothing.
    const second = await claimRepairSlot(statePath, event, policy);
    assert.equal(second.decision, "in_progress");
    assert.equal(second.decision === "in_progress" ? second.attempt.key : undefined, key);
    assert.equal(getAttempt(statePath, key)?.attempts, 1);

    // Still in progress once the repair session has actually started.
    updateAttempt(statePath, key, { lastSessionId: "session-1" });
    const third = await claimRepairSlot(statePath, event, policy);
    assert.equal(third.decision, "in_progress");
    assert.equal(third.decision === "in_progress" ? third.attempt.key : undefined, key);
    assert.equal(getAttempt(statePath, key)?.attempts, 1);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("failed or abandoned repair sessions do not pin a sha as active", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "hootline-state-"));
  const statePath = join(tempRoot, "state.json");
  try {
    const event = makeEvent();
    const key = eventAttemptKey(event);
    recordAttempt(statePath, event, makePolicy());
    updateAttempt(statePath, key, {
      lastSessionId: "session-failed",
      repoStagedAt: event.receivedAt,
      lastSessionStatus: "failed",
      lastSessionFailureKind: "provider_error",
      lastSessionFailure: "provider failed",
    });

    assert.equal(
      findActiveRepairAttemptForSha(statePath, {
        provider: "github",
        repoSlug: "owner/repo",
        sha: "abc123def456",
        now: new Date(event.receivedAt),
      }),
      undefined,
    );

    updateAttempt(statePath, key, {
      lastSessionStatus: "abandoned",
      lastSessionFailureKind: "no_terminal_action",
      lastSessionFailure: "stopped without terminal action",
    });
    assert.equal(
      findActiveRepairAttemptForSha(statePath, {
        provider: "github",
        repoSlug: "owner/repo",
        sha: "abc123def456",
        now: new Date(event.receivedAt),
      }),
      undefined,
    );
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("claimRepairSlot rejects with max_attempts BEFORE recording past the cap", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "hootline-state-"));
  const statePath = join(tempRoot, "state.json");
  try {
    const event = makeEvent();
    const key = eventAttemptKey(event);
    const policy = makePolicy({ maxAttemptsPerSha: 2 });

    // Each accepted claim marks the slot dispatched; clear it between claims to model a
    // prior repair that finished or aged out of the active window, which is the only way
    // the same sha legitimately accrues more than one attempt.
    assert.equal((await claimRepairSlot(statePath, event, policy)).decision, "accepted");
    updateAttempt(statePath, key, { dispatchedAt: undefined });
    assert.equal((await claimRepairSlot(statePath, event, policy)).decision, "accepted");
    updateAttempt(statePath, key, { dispatchedAt: undefined });
    assert.equal(getAttempt(statePath, key)?.attempts, 2);

    // The third claim would push the count to 3 (> cap of 2); it must be rejected
    // WITHOUT recording, so the stored count stays at the cap.
    const rejected = await claimRepairSlot(statePath, event, policy);
    assert.equal(rejected.decision, "max_attempts");
    assert.equal(getAttempt(statePath, key)?.attempts, 2);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("claimRepairSlot dedupes a second pipeline on the same sha once the first is dispatched", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "hootline-state-"));
  const statePath = join(tempRoot, "state.json");
  try {
    const policy = makePolicy();
    // GitHub fires workflow_run and check_suite for the same commit: same sha, but
    // different pipeline ids (hence different attempt keys). Only one repair should run.
    const workflowRun = makeEvent({ pipelineId: "1001", runId: "1001", deliveryId: "delivery-wr" });
    const checkSuite = makeEvent({
      pipelineId: "2002",
      runId: undefined,
      checkSuiteId: "2002",
      deliveryId: "delivery-cs",
    });

    const first = await claimRepairSlot(statePath, workflowRun, policy);
    assert.equal(first.decision, "accepted");

    const second = await claimRepairSlot(statePath, checkSuite, policy);
    assert.equal(second.decision, "in_progress");
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("claimAutoMerge wins once and restoreAutoMergeClaim re-arms it", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "hootline-state-"));
  const statePath = join(tempRoot, "state.json");
  try {
    const event = makeEvent();
    const key = eventAttemptKey(event);
    recordAttempt(statePath, event, makePolicy());
    updateAttempt(statePath, key, { pendingAutoMerge: true });

    assert.equal(await claimAutoMerge(statePath, key), true);
    assert.equal(getAttempt(statePath, key)?.pendingAutoMerge, false);
    // A second concurrent claim loses because the flag is already consumed.
    assert.equal(await claimAutoMerge(statePath, key), false);

    await restoreAutoMergeClaim(statePath, key);
    assert.equal(getAttempt(statePath, key)?.pendingAutoMerge, true);
    assert.equal(await claimAutoMerge(statePath, key), true);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("releaseDelivery lets a redelivery be processed again", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "hootline-state-"));
  const statePath = join(tempRoot, "state.json");
  try {
    assert.equal(markDeliveryProcessed(statePath, "github:delivery-1", "pending"), true);
    assert.equal(markDeliveryProcessed(statePath, "github:delivery-1", "pending"), false);

    await releaseDelivery(statePath, "github:delivery-1");
    assert.equal(markDeliveryProcessed(statePath, "github:delivery-1", "pending"), true);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("claimRerunRequest ids are unique and not derived from request count", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "hootline-state-"));
  const statePath = join(tempRoot, "state.json");
  try {
    const event = makeEvent();
    const key = eventAttemptKey(event);
    recordAttempt(statePath, event, makePolicy());

    const claim = claimRerunRequest(statePath, key, "runner lost network");
    assert.ok(claim.claimed);
    // Id no longer encodes requests.length + 1 (which was collision-prone).
    assert.notEqual(claim.request.id, `${key}:rerun:1`);
    assert.match(claim.request.id, new RegExp(`^${key}:rerun:`));
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

function makePolicy(overrides: Partial<RepoPolicy> = {}): RepoPolicy {
  const policy: RepoPolicy = {
    provider: "github",
    slug: "owner/repo",
    mode: "pr_mr",
    allowedBranches: ["main"],
    allowedFileGlobs: ["**/*"],
    verificationCommands: ["npm test"],
    sandboxNetworkAllow: [],
    fixBranchPrefix: "hootline/fix",
    maxAttemptsPerSha: 3,
    maxSnapshotBytes: 1024,
    autoMerge: { deleteSourceBranch: false, requireSuccessfulPipeline: true },
    allowGitlabSecretTokenFallback: false,
  };
  return { ...policy, ...overrides };
}

function makeEvent(overrides: Partial<NormalizedPipelineEvent> = {}): NormalizedPipelineEvent {
  const event: NormalizedPipelineEvent = {
    provider: "github",
    id: "github:owner/repo:1001:abc123def456",
    deliveryId: "delivery-1",
    repoSlug: "owner/repo",
    installationId: 123,
    pipelineId: "1001",
    pipelineUrl: "https://github.com/owner/repo/actions/runs/1001",
    runId: "1001",
    ref: "main",
    sha: "abc123def456",
    source: "push",
    status: "completed",
    conclusion: "failure",
    eventName: "workflow_run",
    receivedAt: "2026-06-17T00:00:00.000Z",
  };
  return { ...event, ...overrides };
}

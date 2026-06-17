import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";

import { assertSnapshotStaged } from "../agent/lib/current.ts";
import {
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
  updateAttempt,
} from "../agent/lib/state.ts";
import type { NormalizedPipelineEvent } from "../agent/lib/types.ts";

test("records attempts, dedupes deliveries, and finds pending auto-merge changes", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "hootline-state-"));
  const statePath = join(tempRoot, "state.json");
  try {
    const event = makeEvent();
    const key = eventAttemptKey(event);

    assert.equal(markDeliveryProcessed(statePath, "github:delivery-1", "pending"), true);
    assert.equal(markDeliveryProcessed(statePath, "github:delivery-1", "pending"), false);

    const first = recordAttempt(statePath, event);
    const second = recordAttempt(statePath, { ...event, deliveryId: "delivery-2" });
    assert.equal(first.key, key);
    assert.equal(second.attempts, 2);
    assert.equal(getAttempt(statePath, key)?.event.deliveryId, "delivery-2");

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

    recordAttempt(statePath, firstPipeline);
    recordAttempt(statePath, { ...firstPipeline, deliveryId: "delivery-3" });
    recordAttempt(statePath, secondPipeline);

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

test("finds active repair attempts for duplicate pipeline events without pinning stale empty attempts", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "hootline-state-"));
  const statePath = join(tempRoot, "state.json");
  try {
    const event = makeEvent();
    const key = eventAttemptKey(event);
    const now = new Date();
    const afterRecentWindow = new Date(now.getTime() + 1000);
    recordAttempt(statePath, event);

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
    recordAttempt(statePath, event);

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
    recordAttempt(statePath, event);

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

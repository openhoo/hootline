import assert from "node:assert/strict";
import test from "node:test";

import { assertEventAllowedByPolicy } from "../agent/lib/policy.ts";
import type { NormalizedPipelineEvent, RepoPolicy } from "../agent/lib/types.ts";

test("throws for a ref not in allowedBranches", () => {
  const event = makeEvent({ ref: "feature/experiment" });
  const policy = makePolicy({ allowedBranches: ["main"] });
  assert.throws(
    () => assertEventAllowedByPolicy(event, policy),
    /Ref feature\/experiment is not allowed for github:owner\/repo\./,
  );
});

test("is a no-op for an allowed ref", () => {
  const event = makeEvent({ ref: "main" });
  const policy = makePolicy({ allowedBranches: ["main"] });
  assert.doesNotThrow(() => assertEventAllowedByPolicy(event, policy));
});

test("allows a ref matching a glob pattern like feature/**", () => {
  const event = makeEvent({ ref: "feature/x" });
  const policy = makePolicy({ allowedBranches: ["feature/**"] });
  assert.doesNotThrow(() => assertEventAllowedByPolicy(event, policy));
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

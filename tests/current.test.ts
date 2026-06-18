import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";

import { resolveCurrentAttempt } from "../agent/lib/current.ts";
import { eventAttemptKey, recordAttempt } from "../agent/lib/state.ts";
import type { NormalizedPipelineEvent, RepoPolicy } from "../agent/lib/types.ts";
import type { UnknownRecord } from "../agent/lib/unknown.ts";

test("resolveCurrentAttempt reads the attemptKey from session auth attributes", () => {
  withFixture(({ statePath }) => {
    const event = makeEvent();
    const key = eventAttemptKey(event);
    recordAttempt(statePath, event, makePolicy());

    const ctx = makeContext(key);
    const resolved = resolveCurrentAttempt(ctx);
    assert.equal(resolved.attempt.key, key);
    assert.equal(resolved.policy.provider, "github");
    assert.equal(resolved.policy.slug, "owner/repo");
    assert.equal(resolved.config.statePath, statePath);
  });
});

test("resolveCurrentAttempt prefers an explicit attemptKey over the session value", () => {
  withFixture(({ statePath }) => {
    const sessionEvent = makeEvent();
    const sessionKey = eventAttemptKey(sessionEvent);
    recordAttempt(statePath, sessionEvent, makePolicy());

    const explicitEvent = makeEvent({
      id: "github:owner/repo:2002:def456abc123",
      deliveryId: "delivery-2",
      pipelineId: "2002",
      pipelineUrl: "https://github.com/owner/repo/actions/runs/2002",
      runId: "2002",
      sha: "def456abc123",
    });
    const explicitKey = eventAttemptKey(explicitEvent);
    recordAttempt(statePath, explicitEvent, makePolicy());
    assert.notEqual(explicitKey, sessionKey);

    const ctx = makeContext(sessionKey);
    const resolved = resolveCurrentAttempt(ctx, explicitKey);
    assert.equal(resolved.attempt.key, explicitKey);
  });
});

test("resolveCurrentAttempt throws when no key is available anywhere", () => {
  withFixture(() => {
    const ctx = makeContext(undefined);
    assert.throws(
      () => resolveCurrentAttempt(ctx),
      /No attemptKey was supplied and none was available in session auth\./,
    );
  });
});

test("resolveCurrentAttempt treats a whitespace-only attribute as absent", () => {
  withFixture(() => {
    const ctx = makeContext("   ");
    assert.throws(
      () => resolveCurrentAttempt(ctx),
      /No attemptKey was supplied and none was available in session auth\./,
    );
  });
});

test("resolveCurrentAttempt throws when the key has no attempt record", () => {
  withFixture(() => {
    const ctx = makeContext("github:owner/repo:1001:missingsha");
    assert.throws(
      () => resolveCurrentAttempt(ctx),
      /No pipeline fixer attempt exists for key github:owner\/repo:1001:missingsha\./,
    );
  });
});

test("resolveCurrentAttempt returns the stored policy snapshot", () => {
  withFixture(({ statePath }) => {
    const event = makeEvent({
      id: "github:other/repo:1001:abc123def456",
      repoSlug: "other/repo",
    });
    const key = eventAttemptKey(event);
    recordAttempt(statePath, event, makePolicy({ slug: "other/repo", allowedBranches: ["release/**"] }));

    const ctx = makeContext(key);
    const resolved = resolveCurrentAttempt(ctx);
    assert.equal(resolved.policy.slug, "other/repo");
    assert.deepEqual(resolved.policy.allowedBranches, ["release/**"]);
  });
});

type Fixture = { statePath: string };

function withFixture(run: (fixture: Fixture) => void): void {
  const tempRoot = mkdtempSync(join(tmpdir(), "hootline-current-"));
  const statePath = join(tempRoot, "state.json");

  const previousState = process.env.HOOTLINE_STATE_PATH;
  process.env.HOOTLINE_STATE_PATH = statePath;
  try {
    run({ statePath });
  } finally {
    restoreEnv("HOOTLINE_STATE_PATH", previousState);
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

function restoreEnv(name: string, previous: string | undefined): void {
  if (previous === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = previous;
  }
}

function makeContext(attemptKey: string | undefined): Parameters<typeof resolveCurrentAttempt>[0] {
  const attributes: UnknownRecord = attemptKey === undefined ? {} : { attemptKey };
  return {
    session: { auth: { current: { attributes } } },
    getSandbox: () => {
      throw new Error("getSandbox must not be called by resolveCurrentAttempt.");
    },
  };
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

function makePolicy(overrides: Partial<RepoPolicy> = {}): RepoPolicy {
  const policy: RepoPolicy = {
    provider: "github",
    slug: "owner/repo",
    mode: "pr_mr",
    allowedBranches: ["main"],
    allowedFileGlobs: ["**/*"],
    verificationCommands: [],
    sandboxNetworkAllow: [],
    fixBranchPrefix: "hootline/fix",
    maxAttemptsPerSha: 3,
    maxSnapshotBytes: 1024,
    autoMerge: { deleteSourceBranch: false, requireSuccessfulPipeline: true },
    allowGitlabSecretTokenFallback: false,
  };
  return { ...policy, ...overrides };
}

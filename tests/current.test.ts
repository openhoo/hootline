import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";

import { resolveCurrentAttempt } from "../agent/lib/current.ts";
import { eventAttemptKey, recordAttempt } from "../agent/lib/state.ts";
import type { NormalizedPipelineEvent } from "../agent/lib/types.ts";
import type { UnknownRecord } from "../agent/lib/unknown.ts";

test("resolveCurrentAttempt reads the attemptKey from session auth attributes", () => {
  withFixture(({ statePath }) => {
    const event = makeEvent();
    const key = eventAttemptKey(event);
    recordAttempt(statePath, event);

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
    recordAttempt(statePath, sessionEvent);

    const explicitEvent = makeEvent({
      id: "github:owner/repo:2002:def456abc123",
      deliveryId: "delivery-2",
      pipelineId: "2002",
      pipelineUrl: "https://github.com/owner/repo/actions/runs/2002",
      runId: "2002",
      sha: "def456abc123",
    });
    const explicitKey = eventAttemptKey(explicitEvent);
    recordAttempt(statePath, explicitEvent);
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

test("resolveCurrentAttempt throws when the attempt's repo has no policy", () => {
  withFixture(({ statePath }) => {
    const event = makeEvent({
      id: "github:other/repo:1001:abc123def456",
      repoSlug: "other/repo",
    });
    const key = eventAttemptKey(event);
    recordAttempt(statePath, event);

    const ctx = makeContext(key);
    assert.throws(
      () => resolveCurrentAttempt(ctx),
      /No policy configured for github:other\/repo\./,
    );
  });
});

type Fixture = { configPath: string; statePath: string };

function withFixture(run: (fixture: Fixture) => void): void {
  const tempRoot = mkdtempSync(join(tmpdir(), "hootline-current-"));
  const configPath = join(tempRoot, "pipeline-fixer.yaml");
  const statePath = join(tempRoot, "state.json");
  writeFileSync(
    configPath,
    [
      "version: 1",
      `statePath: ${statePath}`,
      "defaults:",
      "  allowedBranches: [main]",
      "repositories:",
      "  - provider: github",
      "    slug: owner/repo",
      "",
    ].join("\n"),
  );

  const previousConfig = process.env.PIPELINE_FIXER_CONFIG;
  const previousState = process.env.PIPELINE_FIXER_STATE;
  process.env.PIPELINE_FIXER_CONFIG = configPath;
  process.env.PIPELINE_FIXER_STATE = statePath;
  try {
    run({ configPath, statePath });
  } finally {
    restoreEnv("PIPELINE_FIXER_CONFIG", previousConfig);
    restoreEnv("PIPELINE_FIXER_STATE", previousState);
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

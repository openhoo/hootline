import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import type { SendFn } from "eve/channels";

import { dispatchPipelineEvent } from "../agent/lib/repair-service.ts";
import { registerProviderClient } from "../agent/lib/providers/index.ts";
import type { FailureContext, NormalizedPipelineEvent, RepoPolicy } from "../agent/lib/types.ts";
import { eventAttemptKey, loadState, recordAttempt, updateAttempt } from "../agent/lib/state.ts";
import type { ProviderClient } from "../agent/lib/providers/common.ts";

test("repair service claims a failed event and records a terminal published session", async () => {
  const previousStatePath = process.env.HOOTLINE_STATE_PATH;
  const root = mkdtempSync(join(tmpdir(), "hootline-repair-service-"));
  const statePath = join(root, "state.json");
  process.env.HOOTLINE_STATE_PATH = statePath;
  const event = makeEvent();
  const provider = makeProvider(event);
  const restoreProvider = registerProviderClient("github", provider);
  const waitTasks: Promise<unknown>[] = [];
  const sent: unknown[] = [];
  const fakeSend = async (message: unknown): Promise<unknown> => {
    sent.push(message);
    return {
      id: "session-1",
      continuationToken: "github:session-1:next",
      async getEventStream(): Promise<ReadableStream<unknown>> {
        return new ReadableStream<unknown>({
          start(controller) {
            controller.enqueue({
              type: "action.result",
              data: {
                status: "completed",
                result: {
                  toolName: "publish_fix",
                  output: { published: true },
                },
              },
              meta: { at: "2026-06-30T10:00:00.000Z" },
            });
            controller.enqueue({
              type: "session.completed",
              data: {},
              meta: { at: "2026-06-30T10:00:01.000Z" },
            });
            controller.close();
          },
        });
      },
    };
  };

  const response = await dispatchPipelineEvent(
    event,
    fakeSend as SendFn,
    (task) => waitTasks.push(task),
  );

  try {
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, accepted: true, attempt: 1 });
    await Promise.all(waitTasks);

    assert.equal(sent.length, 1);
    const attempts = Object.values(loadState(statePath).attempts);
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0]?.lastTerminalAction, "published");
    assert.equal(attempts[0]?.lastSessionStatus, "completed");
    const failureContext = attempts[0]?.lastFailureContext;
    assert.ok(failureContext !== undefined && "summary" in failureContext);
    assert.equal(failureContext.summary, "failed");
  } finally {
    restoreProvider();
    restoreEnv("HOOTLINE_STATE_PATH", previousStatePath);
    rmSync(root, { recursive: true, force: true });
  }
});

test("repair service retries retryable model provider failures inside the same repair attempt", async () => {
  const previousStatePath = process.env.HOOTLINE_STATE_PATH;
  const previousRetries = process.env.HOOTLINE_PROVIDER_ERROR_RETRIES;
  const previousRetryBase = process.env.HOOTLINE_PROVIDER_ERROR_RETRY_BASE_MS;
  const previousRetryMax = process.env.HOOTLINE_PROVIDER_ERROR_RETRY_MAX_MS;
  const root = mkdtempSync(join(tmpdir(), "hootline-repair-service-retry-"));
  const statePath = join(root, "state.json");
  process.env.HOOTLINE_STATE_PATH = statePath;
  process.env.HOOTLINE_PROVIDER_ERROR_RETRIES = "1";
  process.env.HOOTLINE_PROVIDER_ERROR_RETRY_BASE_MS = "0";
  process.env.HOOTLINE_PROVIDER_ERROR_RETRY_MAX_MS = "0";
  const event = makeEvent();
  const provider = makeProvider(event);
  const restoreProvider = registerProviderClient("github", provider);
  const waitTasks: Promise<unknown>[] = [];
  const sent: Array<{ message: unknown; options: unknown }> = [];
  const sessions = [
    makeSession("session-provider-error", [
      {
        type: "actions.requested",
        data: {
          actions: [
            { toolName: "stage_repository_snapshot" },
            { toolName: "edit_repo_file" },
            { toolName: "run_repo_checks" },
          ],
        },
      },
      {
        type: "action.result",
        data: {
          status: "completed",
          result: { toolName: "run_repo_checks", output: { ok: true } },
        },
      },
      {
        type: "step.failed",
        data: { message: "Failed after 3 attempts. Last error: AI_APICallError" },
        meta: { at: "2026-06-30T10:00:01.000Z" },
      },
    ]),
    makeSession("session-published", [
      {
        type: "action.result",
        data: {
          status: "completed",
          result: {
            toolName: "publish_fix",
            output: { published: true },
          },
        },
        meta: { at: "2026-06-30T10:00:02.000Z" },
      },
      {
        type: "session.completed",
        data: {},
        meta: { at: "2026-06-30T10:00:03.000Z" },
      },
    ]),
  ];
  const fakeSend = async (message: unknown, options: unknown): Promise<unknown> => {
    sent.push({ message, options });
    if (sent.length === 2) {
      const [attempt] = Object.values(loadState(statePath).attempts);
      assert.equal(attempt?.lastSessionStatus, "running");
      assert.equal(attempt?.lastSessionId, undefined);
      assert.equal(attempt?.lastSessionEndedAt, undefined);
      assert.equal(attempt?.providerErrorRetriesUsed, 1);
      assert.equal(attempt?.lastSessionFailureKind, "provider_error");
      assert.match(attempt?.lastSessionFailure ?? "", /Retrying after provider error \(1\)/);
      assert.deepEqual(attempt?.lastToolSequence, [
        "stage_repository_snapshot",
        "edit_repo_file",
        "run_repo_checks",
      ]);
    }
    const session = sessions.shift();
    assert.ok(session !== undefined, "unexpected extra session retry");
    return session;
  };

  const response = await dispatchPipelineEvent(
    event,
    fakeSend as SendFn,
    (task) => waitTasks.push(task),
  );

  try {
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, accepted: true, attempt: 1 });
    await Promise.all(waitTasks);

    assert.equal(sent.length, 2);
    assert.equal(readContinuationToken(sent[0]?.options), `${eventAttemptKey(event)}:attempt-1`);
    assert.equal(
      readContinuationToken(sent[1]?.options),
      `${eventAttemptKey(event)}:attempt-1:provider-error-retry-1`,
    );
    assert.match(readMessage(sent[1]?.message), /automatic provider-error retry 1/);

    const state = loadState(statePath);
    const attempts = Object.values(state.attempts);
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0]?.attempts, 1);
    assert.equal(attempts[0]?.providerErrorRetriesUsed, 1);
    assert.equal(attempts[0]?.lastTerminalAction, "published");
    assert.equal(attempts[0]?.lastSessionStatus, "completed");
    assert.equal(attempts[0]?.lastSessionFailureKind, undefined);
    assert.equal(attempts[0]?.lastSessionFailure, undefined);
    assert.equal(state.processedDeliveries["github:delivery-1"], "pending");
  } finally {
    restoreProvider();
    restoreEnv("HOOTLINE_STATE_PATH", previousStatePath);
    restoreEnv("HOOTLINE_PROVIDER_ERROR_RETRIES", previousRetries);
    restoreEnv("HOOTLINE_PROVIDER_ERROR_RETRY_BASE_MS", previousRetryBase);
    restoreEnv("HOOTLINE_PROVIDER_ERROR_RETRY_MAX_MS", previousRetryMax);
    rmSync(root, { recursive: true, force: true });
  }
});

test("repair service releases delivery for provider redelivery after provider retries are exhausted", async () => {
  const previousStatePath = process.env.HOOTLINE_STATE_PATH;
  const previousRetries = process.env.HOOTLINE_PROVIDER_ERROR_RETRIES;
  const previousRetryBase = process.env.HOOTLINE_PROVIDER_ERROR_RETRY_BASE_MS;
  const previousRetryMax = process.env.HOOTLINE_PROVIDER_ERROR_RETRY_MAX_MS;
  const root = mkdtempSync(join(tmpdir(), "hootline-repair-service-retry-exhausted-"));
  const statePath = join(root, "state.json");
  process.env.HOOTLINE_STATE_PATH = statePath;
  process.env.HOOTLINE_PROVIDER_ERROR_RETRIES = "1";
  process.env.HOOTLINE_PROVIDER_ERROR_RETRY_BASE_MS = "0";
  process.env.HOOTLINE_PROVIDER_ERROR_RETRY_MAX_MS = "0";
  const event = makeEvent();
  const provider = makeProvider(event);
  const restoreProvider = registerProviderClient("github", provider);
  const waitTasks: Promise<unknown>[] = [];
  const sent: unknown[] = [];
  const providerErrorEvents = [
    {
      type: "step.failed",
      data: { message: "Failed after 3 attempts. Last error: AI_APICallError" },
      meta: { at: "2026-06-30T10:00:01.000Z" },
    },
  ];
  const sessions = [
    makeSession("session-provider-error-1", providerErrorEvents),
    makeSession("session-provider-error-2", providerErrorEvents),
  ];
  const fakeSend = async (message: unknown): Promise<unknown> => {
    sent.push(message);
    const session = sessions.shift();
    assert.ok(session !== undefined, "unexpected extra session retry");
    return session;
  };

  const response = await dispatchPipelineEvent(
    event,
    fakeSend as SendFn,
    (task) => waitTasks.push(task),
  );

  try {
    assert.equal(response.status, 200);
    await Promise.all(waitTasks);

    assert.equal(sent.length, 2);
    const state = loadState(statePath);
    const attempts = Object.values(state.attempts);
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0]?.attempts, 1);
    assert.equal(attempts[0]?.providerErrorRetriesUsed, 1);
    assert.equal(attempts[0]?.lastSessionStatus, "failed");
    assert.equal(attempts[0]?.lastSessionFailureKind, "provider_error");
    assert.equal(attempts[0]?.lastSessionFailure, "Failed after 3 attempts. Last error: AI_APICallError");
    assert.equal(state.processedDeliveries["github:delivery-1"], undefined);
  } finally {
    restoreProvider();
    restoreEnv("HOOTLINE_STATE_PATH", previousStatePath);
    restoreEnv("HOOTLINE_PROVIDER_ERROR_RETRIES", previousRetries);
    restoreEnv("HOOTLINE_PROVIDER_ERROR_RETRY_BASE_MS", previousRetryBase);
    restoreEnv("HOOTLINE_PROVIDER_ERROR_RETRY_MAX_MS", previousRetryMax);
    rmSync(root, { recursive: true, force: true });
  }
});

test("repair service releases delivery when a session completes without terminal action", async () => {
  const previousStatePath = process.env.HOOTLINE_STATE_PATH;
  const root = mkdtempSync(join(tmpdir(), "hootline-repair-service-no-terminal-"));
  const statePath = join(root, "state.json");
  process.env.HOOTLINE_STATE_PATH = statePath;
  const event = makeEvent();
  const provider = makeProvider(event);
  const restoreProvider = registerProviderClient("github", provider);
  const waitTasks: Promise<unknown>[] = [];
  const fakeSend = async (): Promise<unknown> =>
    makeSession("session-no-terminal", [
      {
        type: "action.result",
        data: {
          status: "completed",
          result: { toolName: "publish_fix", output: { published: false, reason: "verification_failed" } },
        },
      },
      { type: "session.completed", data: {} },
    ]);

  const response = await dispatchPipelineEvent(
    event,
    fakeSend as SendFn,
    (task) => waitTasks.push(task),
  );

  try {
    assert.equal(response.status, 200);
    await Promise.all(waitTasks);

    const state = loadState(statePath);
    const attempts = Object.values(state.attempts);
    assert.equal(attempts[0]?.lastSessionStatus, "abandoned");
    assert.equal(attempts[0]?.lastSessionFailureKind, "no_terminal_action");
    assert.equal(state.processedDeliveries["github:delivery-1"], undefined);
  } finally {
    restoreProvider();
    restoreEnv("HOOTLINE_STATE_PATH", previousStatePath);
    rmSync(root, { recursive: true, force: true });
  }
});

test("repair service retries retryable provider errors thrown before a session stream exists", async () => {
  const previousStatePath = process.env.HOOTLINE_STATE_PATH;
  const previousRetries = process.env.HOOTLINE_PROVIDER_ERROR_RETRIES;
  const previousRetryBase = process.env.HOOTLINE_PROVIDER_ERROR_RETRY_BASE_MS;
  const previousRetryMax = process.env.HOOTLINE_PROVIDER_ERROR_RETRY_MAX_MS;
  const root = mkdtempSync(join(tmpdir(), "hootline-repair-service-send-retry-"));
  const statePath = join(root, "state.json");
  process.env.HOOTLINE_STATE_PATH = statePath;
  process.env.HOOTLINE_PROVIDER_ERROR_RETRIES = "1";
  process.env.HOOTLINE_PROVIDER_ERROR_RETRY_BASE_MS = "0";
  process.env.HOOTLINE_PROVIDER_ERROR_RETRY_MAX_MS = "0";
  const event = makeEvent();
  const provider = makeProvider(event);
  const restoreProvider = registerProviderClient("github", provider);
  const waitTasks: Promise<unknown>[] = [];
  const sent: unknown[] = [];
  const fakeSend = async (message: unknown): Promise<unknown> => {
    sent.push(message);
    if (sent.length === 1) throw new Error("Failed after 3 attempts. Last error: AI_APICallError");
    return makeSession("session-published-after-send-error", [
      {
        type: "action.result",
        data: {
          status: "completed",
          result: {
            toolName: "publish_fix",
            output: { published: true },
          },
        },
      },
      { type: "session.completed", data: {} },
    ]);
  };

  const response = await dispatchPipelineEvent(
    event,
    fakeSend as SendFn,
    (task) => waitTasks.push(task),
  );

  try {
    assert.equal(response.status, 200);
    await Promise.all(waitTasks);

    assert.equal(sent.length, 2);
    const attempts = Object.values(loadState(statePath).attempts);
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0]?.attempts, 1);
    assert.equal(attempts[0]?.providerErrorRetriesUsed, 1);
    assert.equal(attempts[0]?.lastTerminalAction, "published");
    assert.equal(attempts[0]?.lastSessionStatus, "completed");
    assert.equal(attempts[0]?.lastSessionFailureKind, undefined);
    assert.equal(attempts[0]?.lastSessionFailure, undefined);
  } finally {
    restoreProvider();
    restoreEnv("HOOTLINE_STATE_PATH", previousStatePath);
    restoreEnv("HOOTLINE_PROVIDER_ERROR_RETRIES", previousRetries);
    restoreEnv("HOOTLINE_PROVIDER_ERROR_RETRY_BASE_MS", previousRetryBase);
    restoreEnv("HOOTLINE_PROVIDER_ERROR_RETRY_MAX_MS", previousRetryMax);
    rmSync(root, { recursive: true, force: true });
  }
});

test("gitlab secret-token success webhook cannot bypass pending auto-merge policy", async () => {
  const previousStatePath = process.env.HOOTLINE_STATE_PATH;
  const root = mkdtempSync(join(tmpdir(), "hootline-repair-service-gitlab-success-"));
  const statePath = join(root, "state.json");
  process.env.HOOTLINE_STATE_PATH = statePath;
  const branch = "hootline/fix/main/fixsha";
  const commitSha = "fixsha1234567890";
  const failureEvent = makeEvent({
    provider: "gitlab",
    id: "gitlab:owner/repo:2002:abc123def4567890",
    pipelineId: "2002",
    runId: undefined,
    installationId: undefined,
    eventName: "Pipeline Hook",
  });
  const key = eventAttemptKey(failureEvent);
  recordAttempt(
    statePath,
    failureEvent,
    makePolicy({ provider: "gitlab", mode: "auto_merge", allowGitlabSecretTokenFallback: false }),
  );
  updateAttempt(statePath, key, {
    pendingAutoMerge: true,
    publishedBranch: branch,
    changeNumber: 7,
    lastPublishResult: {
      provider: "gitlab",
      mode: "auto_merge",
      branch,
      commitSha,
      changeNumber: 7,
      message: "Published fix MR !7.",
    },
  });

  let mergeCalls = 0;
  const restoreProvider = registerProviderClient("gitlab", {
    ...makeProvider(failureEvent),
    async mergeChange() {
      mergeCalls += 1;
      throw new Error("merge must not be called");
    },
  });
  const waitTasks: Promise<unknown>[] = [];

  try {
    const response = await dispatchPipelineEvent(
      {
        ...failureEvent,
        id: "gitlab:owner/repo:3003:fixsha1234567890",
        deliveryId: "delivery-success-secret-token",
        pipelineId: "3003",
        ref: branch,
        sha: commitSha,
        status: "success",
        conclusion: "success",
      },
      (() => {
        throw new Error("send must not be called for success webhooks");
      }) as SendFn,
      (task) => waitTasks.push(task),
      "secret_token",
    );

    assert.equal(response.status, 200);
    await Promise.all(waitTasks);
    assert.equal(mergeCalls, 0);
    const state = loadState(statePath);
    assert.equal(state.attempts[key]?.pendingAutoMerge, true);
    assert.equal(state.processedDeliveries["gitlab:delivery-success-secret-token"], undefined);
  } finally {
    restoreProvider();
    restoreEnv("HOOTLINE_STATE_PATH", previousStatePath);
    rmSync(root, { recursive: true, force: true });
  }
});

test("successful auto-merge followup records merged terminal state", async () => {
  const previousStatePath = process.env.HOOTLINE_STATE_PATH;
  const root = mkdtempSync(join(tmpdir(), "hootline-repair-service-merge-success-"));
  const statePath = join(root, "state.json");
  process.env.HOOTLINE_STATE_PATH = statePath;
  const branch = "hootline/fix/main/fixsha";
  const commitSha = "fixsha1234567890";
  const failureEvent = makeEvent();
  const key = eventAttemptKey(failureEvent);
  recordAttempt(statePath, failureEvent, makePolicy({ mode: "auto_merge" }));
  updateAttempt(statePath, key, {
    lastSessionStatus: "completed",
    lastTerminalAction: "published",
    pendingAutoMerge: true,
    publishedBranch: branch,
    changeNumber: 42,
    lastPublishResult: {
      provider: "github",
      mode: "auto_merge",
      branch,
      commitSha,
      changeNumber: 42,
      changeUrl: "https://github.com/owner/repo/pull/42",
      message: "Published fix PR #42.",
    },
  });

  const restoreProvider = registerProviderClient("github", {
    ...makeProvider(failureEvent),
    async mergeChange(input) {
      assert.equal(input.expectedCommitSha, commitSha);
      return {
        provider: "github",
        mode: "auto_merge",
        branch: input.branch,
        commitSha: "mergesha1234567890",
        changeNumber: input.changeNumber,
        changeUrl: "https://github.com/owner/repo/pull/42",
        merged: true,
        message: "Merged GitHub PR #42.",
      };
    },
  });
  const waitTasks: Promise<unknown>[] = [];

  try {
    const response = await dispatchPipelineEvent(
      {
        ...failureEvent,
        id: "github:owner/repo:3003:fixsha1234567890",
        deliveryId: "delivery-success-merge-ok",
        pipelineId: "3003",
        runId: "3003",
        ref: branch,
        sha: commitSha,
        status: "completed",
        conclusion: "success",
      },
      (() => {
        throw new Error("send must not be called for success webhooks");
      }) as SendFn,
      (task) => waitTasks.push(task),
    );

    assert.equal(response.status, 200);
    await Promise.all(waitTasks);
    const state = loadState(statePath);
    assert.equal(state.attempts[key]?.pendingAutoMerge, false);
    assert.equal(state.attempts[key]?.lastTerminalAction, "merged");
    assert.equal(state.attempts[key]?.lastSessionStatus, "completed");
    assert.equal(state.attempts[key]?.lastPublishResult?.commitSha, "mergesha1234567890");
    assert.equal(state.attempts[key]?.publishedBranch, branch);
    assert.equal(state.attempts[key]?.changeNumber, 42);
  } finally {
    restoreProvider();
    restoreEnv("HOOTLINE_STATE_PATH", previousStatePath);
    rmSync(root, { recursive: true, force: true });
  }
});

test("auto-merge followup failure restores claim and releases success delivery", async () => {
  const previousStatePath = process.env.HOOTLINE_STATE_PATH;
  const root = mkdtempSync(join(tmpdir(), "hootline-repair-service-merge-fail-"));
  const statePath = join(root, "state.json");
  process.env.HOOTLINE_STATE_PATH = statePath;
  const branch = "hootline/fix/main/fixsha";
  const commitSha = "fixsha1234567890";
  const failureEvent = makeEvent();
  const key = eventAttemptKey(failureEvent);
  recordAttempt(statePath, failureEvent, makePolicy({ mode: "auto_merge" }));
  updateAttempt(statePath, key, {
    pendingAutoMerge: true,
    publishedBranch: branch,
    changeNumber: 42,
    lastPublishResult: {
      provider: "github",
      mode: "auto_merge",
      branch,
      commitSha,
      changeNumber: 42,
      message: "Published fix PR #42.",
    },
  });

  const restoreProvider = registerProviderClient("github", {
    ...makeProvider(failureEvent),
    async mergeChange(input) {
      assert.equal(input.expectedCommitSha, commitSha);
      throw new Error("temporary merge API outage");
    },
  });
  const waitTasks: Promise<unknown>[] = [];

  try {
    const response = await dispatchPipelineEvent(
      {
        ...failureEvent,
        id: "github:owner/repo:3003:fixsha1234567890",
        deliveryId: "delivery-success-merge-fail",
        pipelineId: "3003",
        runId: "3003",
        ref: branch,
        sha: commitSha,
        status: "completed",
        conclusion: "success",
      },
      (() => {
        throw new Error("send must not be called for success webhooks");
      }) as SendFn,
      (task) => waitTasks.push(task),
    );

    assert.equal(response.status, 200);
    await Promise.all(waitTasks);
    const state = loadState(statePath);
    assert.equal(state.attempts[key]?.pendingAutoMerge, true);
    assert.equal(state.processedDeliveries["github:delivery-success-merge-fail"], undefined);
  } finally {
    restoreProvider();
    restoreEnv("HOOTLINE_STATE_PATH", previousStatePath);
    rmSync(root, { recursive: true, force: true });
  }
});

test("unmatched successful pipeline followup releases delivery for later redelivery", async () => {
  const previousStatePath = process.env.HOOTLINE_STATE_PATH;
  const root = mkdtempSync(join(tmpdir(), "hootline-repair-service-success-miss-"));
  const statePath = join(root, "state.json");
  process.env.HOOTLINE_STATE_PATH = statePath;
  const waitTasks: Promise<unknown>[] = [];

  try {
    const response = await dispatchPipelineEvent(
      makeEvent({
        id: "github:owner/repo:3003:fixsha1234567890",
        deliveryId: "delivery-success-unmatched",
        pipelineId: "3003",
        runId: "3003",
        ref: "hootline/fix/main/fixsha",
        sha: "fixsha1234567890",
        status: "completed",
        conclusion: "success",
      }),
      (() => {
        throw new Error("send must not be called for success webhooks");
      }) as SendFn,
      (task) => waitTasks.push(task),
    );

    assert.equal(response.status, 200);
    await Promise.all(waitTasks);
    assert.equal(loadState(statePath).processedDeliveries["github:delivery-success-unmatched"], undefined);
  } finally {
    restoreEnv("HOOTLINE_STATE_PATH", previousStatePath);
    rmSync(root, { recursive: true, force: true });
  }
});

function makeProvider(event: NormalizedPipelineEvent): ProviderClient {
  const failureContext: FailureContext = {
    event,
    jobs: [{ id: "job-1", name: "test", status: "completed", conclusion: "failure", log: "failed" }],
    summary: "failed",
  };
  return {
    async readRepositoryFileFromDefaultBranch() {
      return [
        "version: 1",
        "allowedBranches: [main]",
        "allowedFileGlobs: [src/**]",
        "verificationCommands: [npm test]",
        "",
      ].join("\n");
    },
    async getFailureContext() {
      return failureContext;
    },
    async downloadArchive() {
      throw new Error("not used");
    },
    async publishFix() {
      throw new Error("not used");
    },
    async postComment() {
      throw new Error("not used");
    },
    async rerunPipeline() {
      throw new Error("not used");
    },
    async mergeChange() {
      throw new Error("not used");
    },
  };
}

function makeEvent(overrides: Partial<NormalizedPipelineEvent> = {}): NormalizedPipelineEvent {
  return {
    provider: "github",
    id: "github:owner/repo:1001:abc123def456",
    deliveryId: "delivery-1",
    repoSlug: "owner/repo",
    installationId: 123,
    pipelineId: "1001",
    pipelineUrl: "https://github.com/owner/repo/actions/runs/1001",
    runId: "1001",
    ref: "main",
    sha: "abc123def4567890",
    source: "push",
    status: "completed",
    conclusion: "failure",
    eventName: "workflow_run",
    receivedAt: "2026-06-30T10:00:00.000Z",
    ...overrides,
  };
}

function makePolicy(overrides: Partial<RepoPolicy> = {}): RepoPolicy {
  return {
    provider: "github",
    slug: "owner/repo",
    mode: "pr_mr",
    allowedBranches: ["main"],
    allowedFileGlobs: ["src/**"],
    verificationCommands: ["npm test"],
    sandboxNetworkAllow: [],
    fixBranchPrefix: "hootline/fix",
    maxAttemptsPerSha: 2,
    maxSnapshotBytes: 1024 * 1024,
    autoMerge: { deleteSourceBranch: false, requireSuccessfulPipeline: true },
    allowGitlabSecretTokenFallback: false,
    ...overrides,
  };
}

function makeSession(id: string, events: unknown[]) {
  return {
    id,
    continuationToken: `github:${id}:next`,
    async getEventStream(): Promise<ReadableStream<unknown>> {
      return new ReadableStream<unknown>({
        start(controller) {
          for (const event of events) controller.enqueue(event);
          controller.close();
        },
      });
    },
  };
}

function readContinuationToken(options: unknown): string | undefined {
  return isRecord(options) && typeof options.continuationToken === "string"
    ? options.continuationToken
    : undefined;
}

function readMessage(message: unknown): string {
  return isRecord(message) && typeof message.message === "string" ? message.message : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function restoreEnv(name: string, previous: string | undefined): void {
  if (previous === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = previous;
  }
}

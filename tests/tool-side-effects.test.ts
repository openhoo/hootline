import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";

import mergeChangeTool from "../agent/tools/merge_change.ts";
import postProviderCommentTool from "../agent/tools/post_provider_comment.ts";
import publishFixTool from "../agent/tools/publish_fix.ts";
import { registerProviderClient } from "../agent/lib/providers/index.ts";
import { eventAttemptKey, loadState, recordAttempt, updateAttempt } from "../agent/lib/state.ts";
import type {
  FailureContext,
  MergeChangeInput,
  NormalizedPipelineEvent,
  PublishInput,
  PublishResult,
  RepoPolicy,
} from "../agent/lib/types.ts";
import type { ProviderClient } from "../agent/lib/providers/common.ts";

test("merge_change ignores model confirmation when policy requires a successful pipeline webhook", async () => {
  await withAttempt(async ({ attemptKey, event, statePath }) => {
    updateAttempt(statePath, attemptKey, {
      changeNumber: 42,
      pendingAutoMerge: true,
      publishedBranch: "hootline/fix/main/abc123def456",
    });
    let mergeCalls = 0;
    const restoreProvider = registerProviderClient("github", makeProvider({
      async mergeChange() {
        mergeCalls += 1;
        throw new Error("merge must not be called");
      },
    }));
    try {
      await assert.rejects(
        async () => {
          await mergeChangeTool.execute({ confirmed: true }, makeContext(attemptKey));
        },
        /Policy requires a successful fixer pipeline webhook before merge\./,
      );
      assert.equal(mergeCalls, 0);
      assert.equal(event.repoSlug, "owner/repo");
    } finally {
      restoreProvider();
    }
  }, { mode: "auto_merge", autoMerge: { deleteSourceBranch: false, requireSuccessfulPipeline: true } });
});

test("post_provider_comment redacts model-authored secrets before provider posting", async () => {
  await withAttempt(async ({ attemptKey }) => {
    let postedBody = "";
    const restoreProvider = registerProviderClient("github", makeProvider({
      async postComment(_event, body) {
        postedBody = body;
      },
    }));
    try {
      await postProviderCommentTool.execute(
        { body: "Blocked by authorization: Bearer ghp_supersecret and glpat-secret." },
        makeContext(attemptKey),
      );
      assert.doesNotMatch(postedBody, /ghp_supersecret|glpat-secret/);
      assert.match(postedBody, /\[REDACTED\]/);
    } finally {
      restoreProvider();
    }
  });
});

test("publish_fix uses canonical summary even when extra alias-like fields are present", async () => {
  await withAttempt(async ({ attemptKey, event, statePath }) => {
    updateAttempt(statePath, attemptKey, {
      repoStagedAt: event.receivedAt,
      repoStagedFiles: 1,
      repoStagedBytes: 32,
    });
    const sandbox = new FakePublishSandbox(attemptKey, event);
    let publishedSummary = "";
    const restoreProvider = registerProviderClient("github", makeProvider({
      async publishFix(input) {
        publishedSummary = input.summary;
        return {
          provider: "github",
          mode: input.policy.mode,
          branch: "hootline/fix/main/abc123def456",
          message: "published",
        };
      },
    }));
    try {
      const output = await publishFixTool.execute(
        {
          summary: "Use the canonical summary.",
          body: "Do not publish this body alias.",
          message: "Do not publish this message alias.",
        },
        makeContext(attemptKey, sandbox),
      ) as { published: boolean };

      assert.equal(output.published, true);
      assert.equal(publishedSummary, "Use the canonical summary.");
    } finally {
      restoreProvider();
    }
  });
});

test("publish_fix immediately merges auto_merge changes when follow-up pipeline is not required", async () => {
  await withAttempt(async ({ attemptKey, event, statePath }) => {
    updateAttempt(statePath, attemptKey, {
      repoStagedAt: event.receivedAt,
      repoStagedFiles: 1,
      repoStagedBytes: 32,
    });
    const sandbox = new FakePublishSandbox(attemptKey, event);
    let publishCalls = 0;
    let mergeCalls = 0;
    const restoreProvider = registerProviderClient("github", makeProvider({
      async publishFix(input) {
        publishCalls += 1;
        assert.equal(input.policy.mode, "auto_merge");
        return {
          provider: "github",
          mode: "auto_merge",
          branch: "hootline/fix/main/abc123def456",
          commitSha: "fix1234567890",
          changeNumber: 42,
          changeUrl: "https://github.com/owner/repo/pull/42",
          message: "published",
        };
      },
      async mergeChange(input) {
        mergeCalls += 1;
        assert.equal(input.expectedCommitSha, "fix1234567890");
        return {
          provider: "github",
          mode: "auto_merge",
          branch: input.branch,
          commitSha: "merge1234567890",
          changeNumber: input.changeNumber,
          merged: true,
          message: "merged",
        };
      },
    }));
    try {
      const output = await publishFixTool.execute(
        { summary: "Verified fix." },
        makeContext(attemptKey, sandbox),
      ) as { published: boolean; result?: PublishResult };

      assert.equal(output.published, true);
      assert.equal(output.result?.merged, true);
      assert.equal(publishCalls, 1);
      assert.equal(mergeCalls, 1);
      const attempt = loadState(statePath).attempts[attemptKey];
      assert.equal(attempt?.lastTerminalAction, "merged");
      assert.equal(attempt?.pendingAutoMerge, false);
      assert.equal(attempt?.lastPublishResult?.commitSha, "merge1234567890");
    } finally {
      restoreProvider();
    }
  }, { mode: "auto_merge", autoMerge: { deleteSourceBranch: false, requireSuccessfulPipeline: false } });
});

test("publish_fix records published change when immediate auto_merge fails after publish", async () => {
  await withAttempt(async ({ attemptKey, event, statePath }) => {
    updateAttempt(statePath, attemptKey, {
      repoStagedAt: event.receivedAt,
      repoStagedFiles: 1,
      repoStagedBytes: 32,
    });
    const sandbox = new FakePublishSandbox(attemptKey, event);
    let mergeCalls = 0;
    const restoreProvider = registerProviderClient("github", makeProvider({
      async publishFix(input) {
        assert.equal(input.policy.mode, "auto_merge");
        return {
          provider: "github",
          mode: "auto_merge",
          branch: "hootline/fix/main/abc123def456",
          commitSha: "fix1234567890",
          changeNumber: 42,
          changeUrl: "https://github.com/owner/repo/pull/42",
          message: "published",
        };
      },
      async mergeChange(input) {
        mergeCalls += 1;
        assert.equal(input.expectedCommitSha, "fix1234567890");
        throw new Error("temporary merge outage");
      },
    }));
    try {
      const output = await publishFixTool.execute(
        { summary: "Verified fix." },
        makeContext(attemptKey, sandbox),
      ) as { published: boolean; reason?: string; result?: PublishResult };

      assert.equal(output.published, true);
      assert.equal(output.reason, "merge_failed_after_publish");
      assert.equal(output.result?.commitSha, "fix1234567890");
      assert.equal(mergeCalls, 1);
      const attempt = loadState(statePath).attempts[attemptKey];
      assert.equal(attempt?.lastTerminalAction, "published");
      assert.equal(attempt?.lastSessionStatus, "completed");
      assert.equal(attempt?.pendingAutoMerge, false);
      assert.equal(attempt?.lastPublishResult?.commitSha, "fix1234567890");
    } finally {
      restoreProvider();
    }
  }, { mode: "auto_merge", autoMerge: { deleteSourceBranch: false, requireSuccessfulPipeline: false } });
});

async function withAttempt(
  run: (fixture: { attemptKey: string; event: NormalizedPipelineEvent; statePath: string }) => Promise<void>,
  policyOverrides: Partial<RepoPolicy> = {},
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "hootline-tool-side-effects-"));
  const statePath = join(root, "state.json");
  const previousStatePath = process.env.HOOTLINE_STATE_PATH;
  process.env.HOOTLINE_STATE_PATH = statePath;
  try {
    const event = makeEvent();
    const attemptKey = eventAttemptKey(event);
    recordAttempt(statePath, event, makePolicy(policyOverrides));
    await run({ attemptKey, event, statePath });
  } finally {
    restoreEnv("HOOTLINE_STATE_PATH", previousStatePath);
    rmSync(root, { recursive: true, force: true });
  }
}

function makeContext(
  attemptKey: string,
  sandbox?: unknown,
): Parameters<typeof mergeChangeTool.execute>[1] {
  return {
    session: { auth: { current: { attributes: { attemptKey } } } },
    getSandbox: async () => {
      if (sandbox === undefined) throw new Error("sandbox not used");
      return sandbox;
    },
  } as unknown as Parameters<typeof mergeChangeTool.execute>[1];
}

class FakePublishSandbox {
  readonly id = "sandbox-1";
  constructor(
    private readonly attemptKey: string,
    private readonly event: NormalizedPipelineEvent,
  ) {}

  async readTextFile(input: { path: string }) {
    if (input.path !== ".hootline/staged-repository.json") return null;
    return `${JSON.stringify({
      attemptKey: this.attemptKey,
      provider: this.event.provider,
      repoSlug: this.event.repoSlug,
      sha: this.event.sha,
      pipelineId: this.event.pipelineId,
      sandboxId: this.id,
    })}\n`;
  }

  async readBinaryFile(input: { path: string }) {
    if (input.path === "repo/src/value.js") return Buffer.from("export const value = 2;\n");
    return null;
  }

  async run(input: { command: string }) {
    if (input.command === "git -C repo rev-parse --is-inside-work-tree >/dev/null 2>&1") {
      return { exitCode: 0, stdout: "true\n", stderr: "" };
    }
    if (input.command === "git -C repo status --porcelain=v1 -z --untracked-files=all") {
      return { exitCode: 0, stdout: " M src/value.js\0", stderr: "" };
    }
    return { exitCode: 0, stdout: "ok\n", stderr: "" };
  }

  async setNetworkPolicy() {
    return undefined;
  }
}

function makeProvider(overrides: Partial<ProviderClient> = {}): ProviderClient {
  return {
    async readRepositoryFileFromDefaultBranch() {
      return null;
    },
    async getFailureContext(event: NormalizedPipelineEvent): Promise<FailureContext> {
      return { event, jobs: [], summary: "failed" };
    },
    async downloadArchive() {
      return Buffer.from("");
    },
    async publishFix(input: PublishInput): Promise<PublishResult> {
      return {
        provider: input.event.provider,
        mode: input.policy.mode,
        branch: "hootline/fix/main/abc123def456",
        message: "published",
      };
    },
    async postComment() {
      return undefined;
    },
    async rerunPipeline() {
      return { message: "rerun" };
    },
    async mergeChange(input: MergeChangeInput): Promise<PublishResult> {
      return {
        provider: input.event.provider,
        mode: "auto_merge",
        branch: input.branch,
        changeNumber: input.changeNumber,
        merged: true,
        message: "merged",
      };
    },
    ...overrides,
  };
}

function makeEvent(): NormalizedPipelineEvent {
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
    sha: "abc123def456",
    source: "push",
    status: "completed",
    conclusion: "failure",
    eventName: "workflow_run",
    receivedAt: "2026-06-30T10:00:00.000Z",
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

function restoreEnv(name: string, previous: string | undefined): void {
  if (previous === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = previous;
  }
}

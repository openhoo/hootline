import assert from "node:assert/strict";
import test from "node:test";

import { redact } from "../agent/lib/redact.ts";
import { collectSandboxChanges, runVerificationCommandsWithPolicy } from "../agent/lib/sandbox.ts";
import type {
  NormalizedPipelineEvent,
  PublishInput,
  PublishResult,
  RepoPolicy,
} from "../agent/lib/types.ts";

/**
 * Exercises the publish_fix gate sequence end to end with a fake sandbox and a fake provider
 * client. The harness mirrors agent/tools/publish_fix.ts exactly: verify first, then collect
 * changes, then publish a redacted summary — so the gate ordering, the short-circuit reasons,
 * and the "provider.publishFix is never reached on a blocked publish" invariant are all asserted
 * against the real sandbox helpers rather than a re-implementation of them.
 */
async function runPublishGate(
  sandbox: FakeSandbox,
  policy: RepoPolicy,
  provider: FakeProviderClient,
  summary: string,
): Promise<{ published: boolean; reason?: string; result?: PublishResult }> {
  const verification = await runVerificationCommandsWithPolicy(sandbox, policy);
  if (!verification.ok) {
    return { published: false, reason: "verification_failed" };
  }
  const changes = await collectSandboxChanges(sandbox, policy);
  if (changes.length === 0) {
    return { published: false, reason: "no_changes" };
  }
  const result = await provider.publishFix({
    event: makeEvent(),
    policy,
    changes,
    summary: redact(summary, 4_000),
  });
  return { published: true, result };
}

test("publish gate returns verification_failed and never calls publishFix", async () => {
  const sandbox = new FakeSandbox();
  sandbox.commandResults.push({ exitCode: 1, stdout: "boom", stderr: "" });
  const provider = new FakeProviderClient();

  const outcome = await runPublishGate(
    sandbox,
    makePolicy({ verificationCommands: ["npm test"] }),
    provider,
    "summary",
  );

  assert.deepEqual(outcome, { published: false, reason: "verification_failed" });
  assert.equal(provider.publishFixCalls.length, 0);
});

test("publish gate returns no_changes when verification passes but nothing changed", async () => {
  const sandbox = new FakeSandbox();
  sandbox.commandResults.push({ exitCode: 0, stdout: "ok", stderr: "" });
  sandbox.statusStdout = "";
  const provider = new FakeProviderClient();

  const outcome = await runPublishGate(
    sandbox,
    makePolicy({ verificationCommands: ["npm test"] }),
    provider,
    "summary",
  );

  assert.deepEqual(outcome, { published: false, reason: "no_changes" });
  assert.equal(provider.publishFixCalls.length, 0);
});

test("publish gate redacts the summary before it reaches the provider", async () => {
  const sandbox = new FakeSandbox();
  sandbox.commandResults.push({ exitCode: 0, stdout: "ok", stderr: "" });
  sandbox.statusStdout = "?? docs/new file.md\0";
  sandbox.binaryFiles.set("repo/docs/new file.md", Buffer.from("new"));
  const provider = new FakeProviderClient();

  const outcome = await runPublishGate(
    sandbox,
    makePolicy({ verificationCommands: ["npm test"] }),
    provider,
    "ship it: authorization: Bearer ghp_supersecret token",
  );

  assert.equal(outcome.published, true);
  assert.equal(provider.publishFixCalls.length, 1);
  const published = provider.publishFixCalls[0];
  assert.equal(published?.summary.includes("ghp_supersecret"), false);
  assert.match(published?.summary ?? "", /\[REDACTED\]/);
});

class FakeSandbox {
  readonly id = "sandbox-1";
  readonly binaryFiles = new Map<string, Uint8Array>();
  readonly commandResults: Array<{ exitCode: number; stdout: string; stderr: string }> = [];
  readonly networkPolicies: unknown[] = [];
  statusStdout = "";

  async run(input: { command: string }) {
    if (input.command === "git -C repo status --porcelain=v1 -z --untracked-files=all") {
      return { exitCode: 0, stdout: this.statusStdout, stderr: "" };
    }
    return this.commandResults.shift() ?? { exitCode: 0, stdout: "", stderr: "" };
  }

  async readBinaryFile(input: { path: string }) {
    return this.binaryFiles.get(input.path) ?? null;
  }

  async setNetworkPolicy(policy: unknown) {
    this.networkPolicies.push(policy);
  }
}

class FakeProviderClient {
  readonly publishFixCalls: PublishInput[] = [];

  async publishFix(input: PublishInput): Promise<PublishResult> {
    this.publishFixCalls.push(input);
    return {
      provider: "github",
      mode: "pr_mr",
      branch: "hootline/fix/main/abc123",
      message: "opened",
    };
  }
}

function makePolicy(overrides: Partial<RepoPolicy> = {}): RepoPolicy {
  return {
    provider: "github",
    slug: "owner/repo",
    mode: "pr_mr",
    allowedBranches: ["main"],
    allowedFileGlobs: ["src/**", "docs/**"],
    verificationCommands: ["npm test"],
    sandboxNetworkAllow: [],
    fixBranchPrefix: "hootline/fix",
    maxAttemptsPerSha: 2,
    maxSnapshotBytes: 1024 * 1024,
    autoMerge: {
      deleteSourceBranch: false,
      requireSuccessfulPipeline: true,
    },
    allowGitlabSecretTokenFallback: false,
    ...overrides,
  };
}

function makeEvent(): NormalizedPipelineEvent {
  return {
    provider: "github",
    id: "github:owner/repo:1001:abc123",
    deliveryId: "delivery-1",
    repoSlug: "owner/repo",
    installationId: 123,
    pipelineId: "1001",
    runId: "1001",
    ref: "main",
    sha: "abc123",
    source: "push",
    status: "completed",
    conclusion: "failure",
    eventName: "workflow_run",
    receivedAt: "2026-06-17T00:00:00.000Z",
  };
}

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";

import editRepoFileTool from "../agent/tools/edit_repo_file.ts";
import { eventAttemptKey, recordAttempt, updateAttempt } from "../agent/lib/state.ts";
import { writeSnapshotMarker } from "../agent/lib/sandbox.ts";
import type { NormalizedPipelineEvent, RepoPolicy } from "../agent/lib/types.ts";

test("edit_repo_file rejects a repeated identical missed edit", async () => {
  const previousStatePath = process.env.HOOTLINE_STATE_PATH;
  const root = mkdtempSync(join(tmpdir(), "hootline-edit-tool-"));
  const statePath = join(root, "state.json");
  process.env.HOOTLINE_STATE_PATH = statePath;
  const event = makeEvent();
  const policy = makePolicy();
  const attempt = recordAttempt(statePath, event, policy);
  updateAttempt(statePath, attempt.key, { repoStagedAt: "2026-06-30T10:00:00.000Z" });
  const sandbox = new FakeSandbox();
  sandbox.textFiles.set("repo/src/catalog.js", "export const catalog = [];\n");
  await writeSnapshotMarker(sandbox, attempt);
  const ctx = {
    session: {
      auth: {
        current: {
          attributes: { attemptKey: eventAttemptKey(event) },
        },
      },
    },
    async getSandbox() {
      return sandbox;
    },
    async getSkill() {
      throw new Error("not used");
    },
  } as unknown as Parameters<typeof editRepoFileTool.execute>[1];
  const input = {
    path: "src/catalog.js",
    expected: "catalog.push(item);",
    replacement: "catalog.push(normalize(item));",
  };

  try {
    const first = await editRepoFileTool.execute(input, ctx);
    assert.equal(first.edited, false);
    assert.equal(first.reason, "expected_text_not_uniquely_matched");

    await assert.rejects(
      async () => {
        await editRepoFileTool.execute(input, ctx);
      },
      /Repeated edit_repo_file miss for src\/catalog\.js/,
    );
  } finally {
    restoreEnv("HOOTLINE_STATE_PATH", previousStatePath);
    rmSync(root, { recursive: true, force: true });
  }
});

class FakeSandbox {
  readonly id = "sandbox-edit-tool";
  readonly textFiles = new Map<string, string>();

  async run(input: { command: string }) {
    if (input.command === "git -C repo rev-parse --is-inside-work-tree >/dev/null 2>&1") {
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (input.command === "mkdir -p .hootline") {
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  }

  async readTextFile(input: { path: string }) {
    return this.textFiles.get(input.path) ?? null;
  }

  async writeTextFile(input: { path: string; content: string }) {
    this.textFiles.set(input.path, input.content);
  }
}

function makeEvent(): NormalizedPipelineEvent {
  return {
    provider: "github",
    id: "github:owner/repo:1001:abc123def456",
    deliveryId: "delivery-edit-tool",
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
  };
}

function makePolicy(): RepoPolicy {
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
    autoMerge: {
      deleteSourceBranch: false,
      requireSuccessfulPipeline: true,
    },
    allowGitlabSecretTokenFallback: false,
  };
}

function restoreEnv(name: string, previous: string | undefined): void {
  if (previous === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = previous;
  }
}

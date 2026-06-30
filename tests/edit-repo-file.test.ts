import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";

import editRepoFileTool from "../agent/tools/edit_repo_file.ts";
import { eventAttemptKey, recordAttempt, updateAttempt } from "../agent/lib/state.ts";
import { writeSnapshotMarker } from "../agent/lib/sandbox.ts";
import type { NormalizedPipelineEvent, RepoPolicy } from "../agent/lib/types.ts";

test("edit_repo_file returns recoverable diagnostics for repeated identical missed edits", async () => {
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
    const first = (await editRepoFileTool.execute(input, ctx)) as Record<string, unknown>;
    assert.equal(first.edited, false);
    assert.equal(first.reason, "expected_text_not_uniquely_matched");

    const second = (await editRepoFileTool.execute(input, ctx)) as Record<string, unknown>;
    assert.equal(second.edited, false);
    assert.equal(second.reason, "duplicate_expected_text_miss");
    assert.equal(second.recoveryNextTool, "read_file");
    assert.equal(second.fallbackTool, "replace_repo_lines");
    assert.equal(second.currentFileHash, first.currentFileHash);

    sandbox.textFiles.set("repo/src/catalog.js", "export const catalog = [item];\n");
    const third = (await editRepoFileTool.execute(input, ctx)) as Record<string, unknown>;
    assert.equal(third.edited, false);
    assert.equal(third.reason, "expected_text_not_uniquely_matched");
    assert.notEqual(third.currentFileHash, first.currentFileHash);
  } finally {
    restoreEnv("HOOTLINE_STATE_PATH", previousStatePath);
    rmSync(root, { recursive: true, force: true });
  }
});

test("edit_repo_file selects the only replacement alias that yields a valid edit", async () => {
  const previousStatePath = process.env.HOOTLINE_STATE_PATH;
  const root = mkdtempSync(join(tmpdir(), "hootline-edit-tool-"));
  const statePath = join(root, "state.json");
  process.env.HOOTLINE_STATE_PATH = statePath;
  const event = makeEvent();
  const policy = makePolicy();
  const attempt = recordAttempt(statePath, event, policy);
  updateAttempt(statePath, attempt.key, { repoStagedAt: "2026-06-30T10:00:00.000Z" });
  const sandbox = new FakeSandbox();
  sandbox.textFiles.set("repo/src/catalog.js", "export const value = 1;\n");
  await writeSnapshotMarker(sandbox, attempt);
  const ctx = makeCtx(event, sandbox);

  try {
    const output = (await editRepoFileTool.execute(
      {
        path: "src/catalog.js",
        expected: "value = 1",
        new_text: "value = 1",
        replace: "value = 2",
      },
      ctx,
    )) as Record<string, unknown>;

    assert.equal(output.edited, true);
    assert.equal(output.replacementKey, "replace");
    assert.equal(sandbox.textFiles.get("repo/src/catalog.js"), "export const value = 2;\n");
  } finally {
    restoreEnv("HOOTLINE_STATE_PATH", previousStatePath);
    rmSync(root, { recursive: true, force: true });
  }
});

test("edit_repo_file writes replacement text with dollar signs literally", async () => {
  const previousStatePath = process.env.HOOTLINE_STATE_PATH;
  const root = mkdtempSync(join(tmpdir(), "hootline-edit-tool-"));
  const statePath = join(root, "state.json");
  process.env.HOOTLINE_STATE_PATH = statePath;
  const event = makeEvent();
  const policy = makePolicy();
  const attempt = recordAttempt(statePath, event, policy);
  updateAttempt(statePath, attempt.key, { repoStagedAt: "2026-06-30T10:00:00.000Z" });
  const sandbox = new FakeSandbox();
  const expected = "  return `$${cents / 100}`;";
  const replacement = "  return `$${(cents / 100).toFixed(2)}`;";
  sandbox.textFiles.set("repo/src/money.js", `export function formatCents(cents) {\n${expected}\n}\n`);
  await writeSnapshotMarker(sandbox, attempt);
  const ctx = makeCtx(event, sandbox);

  try {
    const output = (await editRepoFileTool.execute(
      {
        path: "src/money.js",
        expected,
        replacement,
      },
      ctx,
    )) as Record<string, unknown>;

    assert.equal(output.edited, true);
    assert.equal(
      sandbox.textFiles.get("repo/src/money.js"),
      `export function formatCents(cents) {\n${replacement}\n}\n`,
    );
  } finally {
    restoreEnv("HOOTLINE_STATE_PATH", previousStatePath);
    rmSync(root, { recursive: true, force: true });
  }
});

test("edit_repo_file returns diagnostics when replacement aliases are ambiguous", async () => {
  const previousStatePath = process.env.HOOTLINE_STATE_PATH;
  const root = mkdtempSync(join(tmpdir(), "hootline-edit-tool-"));
  const statePath = join(root, "state.json");
  process.env.HOOTLINE_STATE_PATH = statePath;
  const event = makeEvent();
  const policy = makePolicy();
  const attempt = recordAttempt(statePath, event, policy);
  updateAttempt(statePath, attempt.key, { repoStagedAt: "2026-06-30T10:00:00.000Z" });
  const sandbox = new FakeSandbox();
  sandbox.textFiles.set("repo/src/catalog.js", "export const value = 1;\n");
  await writeSnapshotMarker(sandbox, attempt);
  const ctx = makeCtx(event, sandbox);

  try {
    const output = (await editRepoFileTool.execute(
      {
        path: "src/catalog.js",
        expected: "value = 1",
        new_text: "value = 2",
        replace: "value = 3",
      },
      ctx,
    )) as Record<string, unknown>;

    assert.equal(output.edited, false);
    assert.equal(output.reason, "ambiguous_replacement_aliases");
    assert.match(String(output.message), /multiple valid edits/);
    assert.equal(sandbox.textFiles.get("repo/src/catalog.js"), "export const value = 1;\n");
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

function makeCtx(
  event: NormalizedPipelineEvent,
  sandbox: FakeSandbox,
): Parameters<typeof editRepoFileTool.execute>[1] {
  return {
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

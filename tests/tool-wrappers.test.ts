import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";

import globTool from "../agent/tools/glob.ts";
import { normalizeGlobInput } from "../agent/tools/glob.ts";
import grepTool from "../agent/tools/grep.ts";
import { normalizeGrepInput } from "../agent/tools/grep.ts";
import readFileTool from "../agent/tools/read_file.ts";
import { normalizeReadFileInput } from "../agent/tools/read_file.ts";
import { eventAttemptKey, recordAttempt, updateAttempt } from "../agent/lib/state.ts";
import type { NormalizedPipelineEvent, RepoPolicy } from "../agent/lib/types.ts";

test("read_file wrapper normalizes aliases and corrects small repo path typos", async () => {
  const sandbox = new FakePathSandbox(["repo/src/app.ts"]);

  const input = await normalizeReadFileInput({ path: "src/ap.ts", limit: 20 }, sandbox);

  assert.equal(input.filePath, "/workspace/repo/src/app.ts");
  assert.equal(input.limit, 20);
});

test("grep wrapper normalizes pattern aliases and file paths", async () => {
  const sandbox = new FakePathSandbox(["repo/src/app.ts"]);

  const input = await normalizeGrepInput({ query: "value", filePath: "src/ap.ts" }, sandbox);

  assert.equal(input.pattern, "value");
  assert.equal(input.path, "/workspace/repo/src/app.ts");
});

test("grep wrapper defaults searches to the staged repo root", async () => {
  const input = await normalizeGrepInput({ query: "value" }, new FakePathSandbox(["repo/src/app.ts"]));

  assert.equal(input.pattern, "value");
  assert.equal(input.path, "/workspace/repo");
});

test("glob wrapper normalizes pattern and directory aliases", () => {
  const input = normalizeGlobInput({ glob: "**/*.ts", directory: "repo/src" });

  assert.equal(input.pattern, "**/*.ts");
  assert.equal(input.path, "/workspace/repo/src");
});

test("glob wrapper preserves the staged repo root as a search directory", () => {
  const input = normalizeGlobInput({ glob: "**/*.ts", directory: "/workspace/repo/" });

  assert.equal(input.pattern, "**/*.ts");
  assert.equal(input.path, "/workspace/repo");
});

test("glob wrapper defaults searches to the staged repo root", () => {
  const input = normalizeGlobInput({ glob: "**/*.ts" });

  assert.equal(input.pattern, "**/*.ts");
  assert.equal(input.path, "/workspace/repo");
});

test("repo inspection tools require a staged matching snapshot", async () => {
  const root = mkdtempSync(join(tmpdir(), "hootline-tool-wrapper-"));
  const statePath = join(root, "state.json");
  const previousStatePath = process.env.HOOTLINE_STATE_PATH;
  process.env.HOOTLINE_STATE_PATH = statePath;
  try {
    const event = makeEvent();
    const attemptKey = eventAttemptKey(event);
    recordAttempt(statePath, event, makePolicy());
    const ctx = makeContext(attemptKey, new FakePathSandbox(["repo/src/app.ts"]));

    await assert.rejects(
      async () => {
        await readFileTool.execute({ path: "src/app.ts" }, ctx);
      },
      /Repository snapshot has not been staged/,
    );

    updateAttempt(statePath, attemptKey, { repoStagedAt: "2026-06-30T10:00:00.000Z" });
    await assert.rejects(
      async () => {
        await grepTool.execute({ query: "value" }, ctx);
      },
      /Repository snapshot marker is missing/,
    );

    const mismatched = new FakePathSandbox(["repo/src/app.ts"]);
    mismatched.textFiles.set(
      ".hootline/staged-repository.json",
      `${JSON.stringify({
        attemptKey: "other",
        provider: "github",
        repoSlug: "owner/repo",
        sha: "abc123def456",
        pipelineId: "1001",
        sandboxId: "sandbox-1",
      })}\n`,
    );
    await assert.rejects(
      async () => {
        await globTool.execute({ glob: "**/*.ts" }, makeContext(attemptKey, mismatched));
      },
      /Repository snapshot marker does not match the current attempt/,
    );
  } finally {
    restoreEnv("HOOTLINE_STATE_PATH", previousStatePath);
    rmSync(root, { recursive: true, force: true });
  }
});

class FakePathSandbox {
  readonly id = "sandbox-1";
  readonly textFiles = new Map<string, string>();

  constructor(private readonly files: readonly string[]) {}

  async run(input: { command: string }) {
    if (input.command === "find repo -type f -not -path 'repo/.git/*' -print0") {
      return { exitCode: 0, stdout: `${this.files.join("\0")}\0`, stderr: "" };
    }
    if (input.command === "git -C repo rev-parse --is-inside-work-tree >/dev/null 2>&1") {
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  }

  async readTextFile(input: { path: string }) {
    const stored = this.textFiles.get(input.path);
    if (stored !== undefined) return stored;
    return this.files.includes(input.path) ? "content\n" : null;
  }
}

function makeContext(attemptKey: string, sandbox: FakePathSandbox): Parameters<typeof readFileTool.execute>[1] {
  return {
    session: { auth: { current: { attributes: { attemptKey } } } },
    getSandbox: async () => sandbox,
  } as unknown as Parameters<typeof readFileTool.execute>[1];
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
    autoMerge: { deleteSourceBranch: false, requireSuccessfulPipeline: true },
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

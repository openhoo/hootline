import assert from "node:assert/strict";
import test from "node:test";

import {
  assertSandboxSnapshotReady,
  collectSandboxChanges,
  replaceSandboxText,
  runVerificationCommands,
  runVerificationCommandsWithPolicy,
  validateChangesAgainstPolicy,
  writeSnapshotMarker,
} from "../agent/lib/sandbox.ts";
import type { AttemptRecord, RepoPolicy } from "../agent/lib/types.ts";

test("collects NUL-delimited porcelain status with spaces and rename destinations", async () => {
  const sandbox = new FakeSandbox();
  sandbox.statusStdout = [
    " M src/file with spaces.ts",
    "R  src/new name.ts",
    "src/old name.ts",
    "?? docs/new file.md",
    "",
  ].join("\0");
  sandbox.binaryFiles.set("repo/src/file with spaces.ts", Buffer.from("modified"));
  sandbox.binaryFiles.set("repo/src/new name.ts", Buffer.from("renamed"));
  sandbox.binaryFiles.set("repo/docs/new file.md", Buffer.from("new"));

  const changes = await collectSandboxChanges(sandbox, makePolicy());

  assert.deepEqual(
    changes.map((change) => ({ status: change.status, path: change.path })),
    [
      { status: "modified", path: "src/file with spaces.ts" },
      { status: "modified", path: "src/new name.ts" },
      { status: "added", path: "docs/new file.md" },
    ],
  );
});

test("rejects changed paths that escape repository policy boundaries", async () => {
  const sandbox = new FakeSandbox();
  sandbox.statusStdout = "?? ../outside.txt\0";

  await assert.rejects(
    collectSandboxChanges(sandbox, makePolicy({ allowedFileGlobs: ["**"] })),
    /escapes repository policy boundaries/,
  );
});

test("rejects a changed path under .git as escaping repository policy boundaries", async () => {
  const sandbox = new FakeSandbox();
  sandbox.statusStdout = "?? .git/config\0";

  await assert.rejects(
    collectSandboxChanges(sandbox, makePolicy({ allowedFileGlobs: ["**"] })),
    /escapes repository policy boundaries: "\.git\/config"/,
  );
});

test("rejects an absolute changed path as invalid sandbox git status", async () => {
  const sandbox = new FakeSandbox();
  sandbox.statusStdout = "?? /etc/passwd\0";

  await assert.rejects(
    collectSandboxChanges(sandbox, makePolicy({ allowedFileGlobs: ["**"] })),
    /Invalid changed path from sandbox git status: "\/etc\/passwd"/,
  );
});

test("rejects a changed path containing a backslash as not portable", async () => {
  const sandbox = new FakeSandbox();
  sandbox.statusStdout = "?? src\\file.ts\0";

  await assert.rejects(
    collectSandboxChanges(sandbox, makePolicy({ allowedFileGlobs: ["**"] })),
    /contains a backslash and is not portable/,
  );
});

test("rejects a changed path containing a NUL byte as invalid sandbox git status", async () => {
  // The -z porcelain split strips NUL delimiters, so the NUL vector is asserted at the
  // shared path-validation entry point that the publish gate funnels every change through.
  assert.throws(
    () => validateChangesAgainstPolicy([{ status: "added", path: "src/a\0b.ts" }], makePolicy()),
    /Invalid changed path from sandbox git status/,
  );
});

test("rejects a changed path outside allowedFileGlobs as not allowed by policy", async () => {
  const sandbox = new FakeSandbox();
  sandbox.statusStdout = "?? other/file.ts\0";
  sandbox.binaryFiles.set("repo/other/file.ts", Buffer.from("x"));

  await assert.rejects(
    collectSandboxChanges(sandbox, makePolicy()),
    /Changed path is not allowed by policy: other\/file\.ts/,
  );
});

test("replaces exact text in a policy-allowed repository file", async () => {
  const sandbox = new FakeSandbox();
  sandbox.textFiles.set("repo/src/app.ts", "export const value = 1;\n");

  const result = await replaceSandboxText(sandbox, makePolicy(), {
    path: "src/app.ts",
    expected: "value = 1",
    replacement: "value = 2",
  });

  assert.equal(result.path, "src/app.ts");
  assert.equal(result.replacements, 1);
  assert.equal(sandbox.textFiles.get("repo/src/app.ts"), "export const value = 2;\n");
});

test("normalizes documented workspace paths for repository edits", async () => {
  const sandbox = new FakeSandbox();
  sandbox.textFiles.set("repo/src/app.ts", "export const value = 1;\n");

  const result = await replaceSandboxText(sandbox, makePolicy(), {
    path: "/workspace/repo/src/app.ts",
    expected: "value = 1",
    replacement: "value = 2",
  });

  assert.equal(result.path, "src/app.ts");
  assert.equal(sandbox.textFiles.get("repo/src/app.ts"), "export const value = 2;\n");
});

test("replaces a uniquely matching line when only indentation differs", async () => {
  const sandbox = new FakeSandbox();
  sandbox.textFiles.set(
    "repo/src/app.ts",
    [
      "export function classify(lines) {",
      "  const allDigital = lines.some((line) => line.weightOunces === 0);",
      "  return allDigital;",
      "}",
      "",
    ].join("\n"),
  );

  const result = await replaceSandboxText(sandbox, makePolicy(), {
    path: "src/app.ts",
    expected: "    const allDigital = lines.some((line) => line.weightOunces === 0);",
    replacement: "    const allDigital = lines.every((line) => line.weightOunces === 0);",
  });

  assert.equal(result.matchStrategy, "indentation_insensitive");
  assert.equal(
    sandbox.textFiles.get("repo/src/app.ts"),
    [
      "export function classify(lines) {",
      "  const allDigital = lines.every((line) => line.weightOunces === 0);",
      "  return allDigital;",
      "}",
      "",
    ].join("\n"),
  );
});

test("rejects indentation-insensitive edits when the trimmed block is ambiguous", async () => {
  const sandbox = new FakeSandbox();
  sandbox.textFiles.set(
    "repo/src/app.ts",
    [
      "export function first(lines) {",
      "  const allDigital = lines.some((line) => line.weightOunces === 0);",
      "}",
      "export function second(lines) {",
      "    const allDigital = lines.some((line) => line.weightOunces === 0);",
      "}",
      "",
    ].join("\n"),
  );

  await assert.rejects(
    replaceSandboxText(sandbox, makePolicy(), {
      path: "src/app.ts",
      expected: "     const allDigital = lines.some((line) => line.weightOunces === 0);",
      replacement: "     const allDigital = lines.every((line) => line.weightOunces === 0);",
    }),
    /expected text must occur exactly once in src\/app\.ts; found 0/,
  );
});

test("rejects edit paths outside policy and ambiguous replacements", async () => {
  const sandbox = new FakeSandbox();
  sandbox.textFiles.set("repo/src/app.ts", "same\nsame\n");

  await assert.rejects(
    replaceSandboxText(sandbox, makePolicy(), {
      path: "README.md",
      expected: "anything",
      replacement: "other",
    }),
    /Edit path is not allowed by policy: README\.md/,
  );

  await assert.rejects(
    replaceSandboxText(sandbox, makePolicy(), {
      path: "src/app.ts",
      expected: "same",
      replacement: "different",
    }),
    /expected text must occur exactly once in src\/app\.ts; found 2/,
  );
});

test("caps and redacts verification stdout and stderr before returning to model/state", async () => {
  const sandbox = new FakeSandbox();
  sandbox.commandResults.push({
    exitCode: 0,
    stdout: `token=supersecret ${"x".repeat(7_000)}`,
    stderr: "authorization: Bearer ghp_supersecret",
  });

  const result = await runVerificationCommands(sandbox, ["npm test"]);

  assert.equal(result.ok, true);
  assert.equal(result.results[0]?.stdout.includes("supersecret"), false);
  assert.equal(result.results[0]?.stderr.includes("ghp_supersecret"), false);
  assert.equal(result.results[0]?.stdoutTruncated, true);
  assert.match(result.results[0]?.stdout ?? "", /\[truncated \d+ bytes\]/);
});

test("verification network allowlist is restored to deny-all and restore failures are reported", async () => {
  const sandbox = new FakeSandbox();
  sandbox.failNetworkPolicyCall = 2;
  sandbox.commandResults.push({ exitCode: 0, stdout: "ok", stderr: "" });

  const result = await runVerificationCommandsWithPolicy(
    sandbox,
    makePolicy({ sandboxNetworkAllow: ["registry.npmjs.org"], verificationCommands: ["npm test"] }),
  );

  assert.equal(result.ok, false);
  assert.equal(result.networkPolicy?.verificationPolicy, "allowlist");
  assert.equal(result.networkPolicy?.applied, true);
  assert.equal(result.networkPolicy?.restoredDenyAll, false);
  assert.match(result.networkPolicy?.restoreError ?? "", /restore deny-all network policy/);
  assert.deepEqual(sandbox.networkPolicies, [{ allow: ["registry.npmjs.org"] }, "deny-all"]);
});

test("snapshot marker ties staged repository to the current attempt and sandbox", async () => {
  const sandbox = new FakeSandbox();
  const attempt = makeAttempt();

  await writeSnapshotMarker(sandbox, attempt);
  await assert.doesNotReject(assertSandboxSnapshotReady(sandbox, attempt));
  await assert.rejects(
    assertSandboxSnapshotReady(sandbox, { ...attempt, key: "other-key" }),
    /does not match the current attempt/,
  );
});

class FakeSandbox {
  readonly id = "sandbox-1";
  readonly binaryFiles = new Map<string, Uint8Array>();
  readonly textFiles = new Map<string, string>();
  readonly commandResults: Array<{ exitCode: number; stdout: string; stderr: string }> = [];
  readonly networkPolicies: unknown[] = [];
  statusStdout = "";
  failNetworkPolicyCall: number | undefined;

  async run(input: { command: string }) {
    if (input.command === "git -C repo status --porcelain=v1 -z --untracked-files=all") {
      return { exitCode: 0, stdout: this.statusStdout, stderr: "" };
    }
    if (input.command === "git -C repo rev-parse --is-inside-work-tree >/dev/null 2>&1") {
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (input.command === "mkdir -p .hootline") {
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    return this.commandResults.shift() ?? { exitCode: 0, stdout: "", stderr: "" };
  }

  async readBinaryFile(input: { path: string }) {
    return this.binaryFiles.get(input.path) ?? null;
  }

  async writeTextFile(input: { path: string; content: string }) {
    this.textFiles.set(input.path, input.content);
  }

  async readTextFile(input: { path: string }) {
    const content = this.textFiles.get(input.path);
    if (content === undefined) throw new Error("missing file");
    return content;
  }

  async setNetworkPolicy(policy: unknown) {
    this.networkPolicies.push(policy);
    if (this.failNetworkPolicyCall === this.networkPolicies.length) {
      throw new Error("network backend refused policy");
    }
  }

  resolvePath(path: string) {
    return `/workspace/${path}`;
  }

  async removePath() {
    return undefined;
  }
}

function makePolicy(overrides: Partial<RepoPolicy> = {}): RepoPolicy {
  return {
    provider: "github",
    slug: "owner/repo",
    mode: "pr_mr",
    allowedBranches: ["main"],
    allowedFileGlobs: ["src/**", "docs/**"],
    verificationCommands: [],
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

function makeAttempt(): AttemptRecord {
  return {
    key: "github:owner/repo:abc123:1001",
    provider: "github",
    repoSlug: "owner/repo",
    sha: "abc123",
    pipelineId: "1001",
    attempts: 1,
    firstSeenAt: "2026-06-17T00:00:00.000Z",
    lastSeenAt: "2026-06-17T00:00:00.000Z",
    repoStagedAt: "2026-06-17T00:00:00.000Z",
    policy: makePolicy(),
    event: {
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
    },
  };
}

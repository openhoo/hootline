import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";

import { assertResponseOk } from "../agent/lib/providers/common.ts";
import { GitHubProvider } from "../agent/lib/providers/github.ts";
import { GitLabProvider } from "../agent/lib/providers/gitlab.ts";
import { getProviderClient } from "../agent/lib/providers/index.ts";
import { SimulatedGitHubProvider } from "../agent/lib/providers/simulated-github.ts";
import type { NormalizedPipelineEvent, PublishInput, RepoPolicy, SandboxChange } from "../agent/lib/types.ts";
import { requireArray, requireRecord, type UnknownRecord } from "../agent/lib/unknown.ts";

function childMarkerCommand(markerPath: string): string {
  const childScript = [
    `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(markerPath)}, "alive"), 250);`,
    "setTimeout(() => {}, 2000);",
  ].join("\n");
  const parentScript = [
    'const { spawn } = require("node:child_process");',
    `const child = spawn(process.execPath, ["-e", ${JSON.stringify(childScript)}], { stdio: "ignore" });`,
    "child.unref();",
    "setTimeout(() => {}, 2000);",
  ].join("\n");
  return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(parentScript)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("provider API errors redact token-shaped response bodies", () => {
  assert.throws(
    () =>
      assertResponseOk(
        new Response(null, { status: 500 }),
        {
          message: "token=ghp_secret123 glpat-secret private-token: ghs_secret456",
        },
        "Provider GET /example",
      ),
    (error) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /\[REDACTED\]/);
      assert.doesNotMatch(error.message, /ghp_secret123/);
      assert.doesNotMatch(error.message, /glpat-secret/);
      assert.doesNotMatch(error.message, /ghs_secret456/);
      return true;
    },
  );
});

test("GitHub reads repo config from the default branch and returns null for missing files", async () => {
  const previousFetch = globalThis.fetch;
  const previousAppId = process.env.GITHUB_APP_ID;
  const previousPrivateKey = process.env.GITHUB_APP_PRIVATE_KEY;
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const calls: ProviderCall[] = [];

  process.env.GITHUB_APP_ID = "config-fetch-test";
  process.env.GITHUB_APP_PRIVATE_KEY = privateKey
    .export({ format: "pem", type: "pkcs8" })
    .toString();
  const repoConfig = [
    "version: 1",
    "allowedBranches: [main]",
    "allowedFileGlobs: [src/**]",
    "verificationCommands: [npm test]",
    "",
  ].join("\n");
  globalThis.fetch = async (input, init = {}) => {
    const call = readCall(input, init);
    calls.push(call);
    if (call.path === "/app/installations/123/access_tokens") {
      return jsonResponse({ token: "ghs_installation_secret", expires_at: futureIso() });
    }
    if (call.path === "/repos/owner/repo") {
      return jsonResponse({ default_branch: "trunk" });
    }
    if (call.path === "/repos/owner/repo/contents/.hootline.yaml?ref=trunk") {
      return jsonResponse({
        type: "file",
        encoding: "base64",
        content: Buffer.from(repoConfig).toString("base64"),
      });
    }
    if (call.path === "/repos/owner/repo/contents/missing.yaml?ref=trunk") {
      return jsonResponse({ message: "Not Found" }, 404);
    }
    throw new Error(`Unexpected GitHub request: ${call.method} ${call.path}`);
  };

  try {
    const provider = new GitHubProvider();
    assert.equal(
      await provider.readRepositoryFileFromDefaultBranch(makeGitHubEvent(), ".hootline.yaml"),
      repoConfig,
    );
    assert.equal(await provider.readRepositoryFileFromDefaultBranch(makeGitHubEvent(), "missing.yaml"), null);
    assert.equal(calls.some((call) => call.path === "/repos/owner/repo"), true);
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv("GITHUB_APP_ID", previousAppId);
    restoreEnv("GITHUB_APP_PRIVATE_KEY", previousPrivateKey);
  }
});

test("GitLab reads repo config from the default branch and returns null for missing files", async () => {
  const previousFetch = globalThis.fetch;
  const previousToken = process.env.GITLAB_TOKEN;
  const previousBaseUrl = process.env.GITLAB_BASE_URL;

  process.env.GITLAB_TOKEN = "glpat-secret";
  process.env.GITLAB_BASE_URL = "https://gitlab.example.test";
  const repoConfig = [
    "version: 1",
    "allowedBranches: [main]",
    "allowedFileGlobs: [src/**]",
    "verificationCommands: [npm test]",
    "",
  ].join("\n");
  globalThis.fetch = async (input, init = {}) => {
    const call = readCall(input, init);
    if (call.path === "/api/v4/projects/55") {
      return jsonResponse({ default_branch: "main" });
    }
    if (call.path === "/api/v4/projects/55/repository/files/.hootline.yaml?ref=main") {
      return jsonResponse({
        encoding: "base64",
        content: Buffer.from(repoConfig).toString("base64"),
      });
    }
    if (call.path === "/api/v4/projects/55/repository/files/missing.yaml?ref=main") {
      return jsonResponse({ message: "Not Found" }, 404);
    }
    throw new Error(`Unexpected GitLab request: ${call.method} ${call.path}`);
  };

  try {
    const provider = new GitLabProvider();
    assert.equal(
      await provider.readRepositoryFileFromDefaultBranch(makeGitLabEvent(), ".hootline.yaml"),
      repoConfig,
    );
    assert.equal(await provider.readRepositoryFileFromDefaultBranch(makeGitLabEvent(), "missing.yaml"), null);
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv("GITLAB_TOKEN", previousToken);
    restoreEnv("GITLAB_BASE_URL", previousBaseUrl);
  }
});

test("GitLab archive downloads do not forward private-token across redirected origins", async () => {
  const previousToken = process.env.GITLAB_TOKEN;
  const previousBaseUrl = process.env.GITLAB_BASE_URL;
  let redirectedPrivateToken: string | string[] | undefined;
  let targetUrl = "";

  const target = await listenTestServer((req, res) => {
    redirectedPrivateToken = req.headers["private-token"];
    res.writeHead(200, {
      "content-length": "7",
      "content-type": "application/octet-stream",
    });
    res.end("archive");
  });
  const source = await listenTestServer((_req, res) => {
    res.writeHead(302, { location: targetUrl });
    res.end();
  });

  targetUrl = `${target.url}/archive.tar.gz`;
  process.env.GITLAB_TOKEN = "glpat-secret";
  process.env.GITLAB_BASE_URL = source.url;

  try {
    const archive = await new GitLabProvider().downloadArchive(makeGitLabEvent(), 1024);
    assert.equal(archive.toString("utf8"), "archive");
    assert.equal(redirectedPrivateToken, undefined);
  } finally {
    await source.close();
    await target.close();
    restoreEnv("GITLAB_TOKEN", previousToken);
    restoreEnv("GITLAB_BASE_URL", previousBaseUrl);
  }
});

test("GitHub publish creates base64 blobs instead of UTF-8 tree content", async () => {
  const previousFetch = globalThis.fetch;
  const previousAppId = process.env.GITHUB_APP_ID;
  const previousPrivateKey = process.env.GITHUB_APP_PRIVATE_KEY;
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const binaryContent = Buffer.from([0, 255, 1, 2, 128]).toString("base64");
  const calls: ProviderCall[] = [];

  process.env.GITHUB_APP_ID = "binary-publish-test";
  process.env.GITHUB_APP_PRIVATE_KEY = privateKey
    .export({ format: "pem", type: "pkcs8" })
    .toString();
  const fetchMock: typeof fetch = async (input, init = {}) => {
    const call = readCall(input, init);
    calls.push(call);
    if (call.path === "/app/installations/123/access_tokens") {
      return jsonResponse({ token: "ghs_installation_secret", expires_at: futureIso() });
    }
    if (call.path === "/repos/owner/repo/git/ref/heads/hootline/fix/main/abc123def456") {
      return jsonResponse({ message: "Not Found" }, 404);
    }
    if (call.path === "/repos/owner/repo/git/refs") {
      const body = requireRecord(call.body, "GitHub create ref request body");
      assert.equal(body.ref, "refs/heads/hootline/fix/main/abc123def456");
      assert.equal(body.sha, "abc123def4567890");
      return jsonResponse({ ref: body.ref });
    }
    if (call.path === "/repos/owner/repo/git/commits/abc123def4567890") {
      return jsonResponse({ tree: { sha: "base-tree-sha" } });
    }
    if (call.path === "/repos/owner/repo/git/blobs") {
      assert.deepEqual(call.body, { content: binaryContent, encoding: "base64" });
      return jsonResponse({ sha: "blob-sha" });
    }
    if (call.path === "/repos/owner/repo/git/trees") {
      const body = requireRecord(call.body, "GitHub create tree request body");
      const tree = requireArray(body.tree, "GitHub create tree entries");
      const firstEntry = requireRecord(tree[0], "GitHub tree entry");
      assert.equal(firstEntry.sha, "blob-sha");
      assert.equal("content" in firstEntry, false);
      return jsonResponse({ sha: "new-tree-sha" });
    }
    if (call.path === "/repos/owner/repo/git/commits") {
      return jsonResponse({ sha: "commit-sha" });
    }
    if (call.path === "/repos/owner/repo/git/refs/heads/hootline/fix/main/abc123def456") {
      const body = requireRecord(call.body, "GitHub update ref request body");
      assert.equal(body.sha, "commit-sha");
      assert.equal(body.force, true);
      return jsonResponse({ object: { sha: "commit-sha" } });
    }
    throw new Error(`Unexpected GitHub request: ${call.method} ${call.path}`);
  };
  globalThis.fetch = fetchMock;

  try {
    const result = await new GitHubProvider().publishFix({
      event: makeGitHubEvent(),
      policy: makePolicy("github", "owner/repo", "push_branch"),
      changes: [{ status: "modified", path: "assets/image.bin", contentBase64: binaryContent }],
      summary: "Preserve binary content.",
    });

    assert.equal(result.commitSha, "commit-sha");
    assert.equal(calls.some((call) => call.path === "/repos/owner/repo/git/blobs"), true);
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv("GITHUB_APP_ID", previousAppId);
    restoreEnv("GITHUB_APP_PRIVATE_KEY", previousPrivateKey);
  }
});

test("GitHub posts a commit comment even when pipeline URL is absent", async () => {
  const previousFetch = globalThis.fetch;
  const previousAppId = process.env.GITHUB_APP_ID;
  const previousPrivateKey = process.env.GITHUB_APP_PRIVATE_KEY;
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const calls: ProviderCall[] = [];

  process.env.GITHUB_APP_ID = "comment-fallback-test";
  process.env.GITHUB_APP_PRIVATE_KEY = privateKey
    .export({ format: "pem", type: "pkcs8" })
    .toString();
  globalThis.fetch = async (input, init = {}) => {
    const call = readCall(input, init);
    calls.push(call);
    if (call.path === "/app/installations/123/access_tokens") {
      return jsonResponse({ token: "ghs_installation_secret", expires_at: futureIso() });
    }
    if (call.path === "/repos/owner/repo/commits/abc123def4567890/comments") {
      assert.deepEqual(call.body, { body: "Blocked by policy." });
      return jsonResponse({ id: 1 });
    }
    throw new Error(`Unexpected GitHub request: ${call.method} ${call.path}`);
  };

  try {
    await new GitHubProvider().postComment(
      { ...makeGitHubEvent(), pipelineUrl: undefined },
      "Blocked by policy.",
    );
    assert.equal(calls.some((call) => call.path === "/repos/owner/repo/commits/abc123def4567890/comments"), true);
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv("GITHUB_APP_ID", previousAppId);
    restoreEnv("GITHUB_APP_PRIVATE_KEY", previousPrivateKey);
  }
});

test("GitHub merge pins the checked pull request head", async () => {
  const previousFetch = globalThis.fetch;
  const previousAppId = process.env.GITHUB_APP_ID;
  const previousPrivateKey = process.env.GITHUB_APP_PRIVATE_KEY;
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });

  process.env.GITHUB_APP_ID = "merge-pin-test";
  process.env.GITHUB_APP_PRIVATE_KEY = privateKey
    .export({ format: "pem", type: "pkcs8" })
    .toString();
  globalThis.fetch = async (input, init = {}) => {
    const call = readCall(input, init);
    if (call.path === "/app/installations/123/access_tokens") {
      return jsonResponse({ token: "ghs_installation_secret", expires_at: futureIso() });
    }
    if (call.path === "/repos/owner/repo/pulls/42/merge") {
      const body = requireRecord(call.body, "GitHub merge request body");
      assert.equal(body.sha, "fix1234567890");
      assert.equal(body.merge_method, "squash");
      return jsonResponse({ sha: "merge-sha", merged: true });
    }
    throw new Error(`Unexpected GitHub request: ${call.method} ${call.path}`);
  };

  try {
    const result = await new GitHubProvider().mergeChange({
      event: makeGitHubEvent(),
      changeNumber: 42,
      branch: "hootline/fix/main/abc123def456",
      deleteSourceBranch: false,
      expectedCommitSha: "fix1234567890",
    });
    assert.equal(result.commitSha, "merge-sha");
    assert.equal(result.merged, true);
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv("GITHUB_APP_ID", previousAppId);
    restoreEnv("GITHUB_APP_PRIVATE_KEY", previousPrivateKey);
  }
});

test("GitLab publish updates existing files and creates absent files on a reused fixer branch", async () => {
  const previousFetch = globalThis.fetch;
  const previousToken = process.env.GITLAB_TOKEN;
  const previousBaseUrl = process.env.GITLAB_BASE_URL;
  const calls: ProviderCall[] = [];
  const expectedBranch = "hootline/fix/feature-fix-ci/fedcba987654";

  process.env.GITLAB_TOKEN = "glpat-secret";
  process.env.GITLAB_BASE_URL = "https://gitlab.example.test";
  const fetchMock: typeof fetch = async (input, init = {}) => {
    const call = readCall(input, init);
    calls.push(call);
    if (call.method === "POST" && call.path === "/api/v4/projects/55/repository/commits") {
      const body = requireRecord(call.body, "GitLab create commit request body");
      assert.equal(body.branch, expectedBranch);
      assert.equal(body.start_sha, "fedcba9876543210");
      assert.equal(body.force, true);
      assert.deepEqual(
        requireArray(body.actions, "GitLab commit actions").map((action) => {
          const record = requireRecord(action, "GitLab commit action");
          return {
            action: record.action,
            filePath: record.file_path,
          };
        }),
        [
          { action: "update", filePath: "src/existing.bin" },
          { action: "create", filePath: "src/new.bin" },
          { action: "delete", filePath: "src/already-deleted.bin" },
        ],
      );
      return jsonResponse({ id: "commit-sha" });
    }
    if (
      call.method === "GET" &&
      call.path ===
        `/api/v4/projects/55/merge_requests?state=opened&source_branch=${encodeURIComponent(expectedBranch)}`
    ) {
      return jsonResponse([]);
    }
    if (call.method === "POST" && call.path === "/api/v4/projects/55/merge_requests") {
      const body = requireRecord(call.body, "GitLab create merge request body");
      assert.equal(body.source_branch, expectedBranch);
      assert.equal(body.target_branch, "feature/fix ci");
      assert.equal(body.remove_source_branch, false);
      return jsonResponse({ iid: 7, web_url: "https://gitlab.example.test/group/project/-/merge_requests/7" });
    }
    throw new Error(`Unexpected GitLab request: ${call.method} ${call.path}`);
  };
  globalThis.fetch = fetchMock;

  try {
    const result = await new GitLabProvider().publishFix({
      event: makeGitLabEvent({ ref: "feature/fix ci" }),
      policy: makePolicy("gitlab", "group/project", "pr_mr", {
        autoMerge: { deleteSourceBranch: false, requireSuccessfulPipeline: true },
      }),
      changes: [
        { status: "modified", path: "src/existing.bin", contentBase64: "ZXhpc3Rpbmc=" },
        { status: "added", path: "src/new.bin", contentBase64: "bmV3" },
        { status: "deleted", path: "src/already-deleted.bin" },
      ],
      summary: "Reuse the fixer branch safely.",
    });

    assert.equal(result.branch, expectedBranch);
    assert.equal(result.commitSha, "commit-sha");
    assert.equal(result.changeNumber, 7);
    assert.equal(calls.some((call) => call.method === "HEAD"), false);
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv("GITLAB_TOKEN", previousToken);
    restoreEnv("GITLAB_BASE_URL", previousBaseUrl);
  }
});

test("GitLab merge pins the checked merge request head", async () => {
  const previousFetch = globalThis.fetch;
  const previousToken = process.env.GITLAB_TOKEN;
  const previousBaseUrl = process.env.GITLAB_BASE_URL;

  process.env.GITLAB_TOKEN = "glpat-secret";
  process.env.GITLAB_BASE_URL = "https://gitlab.example.test";
  globalThis.fetch = async (input, init = {}) => {
    const call = readCall(input, init);
    if (call.path === "/api/v4/projects/55/merge_requests/7/merge") {
      const body = requireRecord(call.body, "GitLab merge request body");
      assert.equal(body.sha, "fix1234567890");
      assert.equal(body.squash, true);
      return jsonResponse({ merge_commit_sha: "merge-sha" });
    }
    throw new Error(`Unexpected GitLab request: ${call.method} ${call.path}`);
  };

  try {
    const result = await new GitLabProvider().mergeChange({
      event: makeGitLabEvent(),
      changeNumber: 7,
      branch: "hootline/fix/main/fedcba987654",
      deleteSourceBranch: true,
      expectedCommitSha: "fix1234567890",
    });
    assert.equal(result.commitSha, "merge-sha");
    assert.equal(result.merged, true);
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv("GITLAB_TOKEN", previousToken);
    restoreEnv("GITLAB_BASE_URL", previousBaseUrl);
  }
});

test("provider registry can route GitHub calls to the simulated backend", () => {
  const previousBackend = process.env.HOOTLINE_GITHUB_PROVIDER_BACKEND;
  try {
    process.env.HOOTLINE_GITHUB_PROVIDER_BACKEND = "simulated";
    assert.equal(getProviderClient("github") instanceof SimulatedGitHubProvider, true);

    process.env.HOOTLINE_GITHUB_PROVIDER_BACKEND = "api";
    assert.equal(getProviderClient("github") instanceof GitHubProvider, true);
  } finally {
    restoreEnv("HOOTLINE_GITHUB_PROVIDER_BACKEND", previousBackend);
  }
});

test("simulated GitHub provider reads policy, archives, publishes, and records checks", async () => {
  const previousStatePath = process.env.HOOTLINE_SIMULATOR_STATE_PATH;
  const root = mkdtempSync(join(tmpdir(), "hootline-sim-provider-"));
  const repoRoot = join(root, "repo");
  const statePath = join(root, "simulator-state.json");
  const event = {
    ...makeGitHubEvent(),
    repoSlug: "owner/simulated",
    ref: "feature/fix-ci",
    sourceBranch: "feature/fix-ci",
    targetBranch: "main",
    sha: "simulatedsha123",
  };
  mkdirSync(join(repoRoot, "src"), { recursive: true });
  writeFileSync(
    join(repoRoot, ".hootline.yaml"),
    [
      "version: 1",
      "allowedBranches: [main]",
      "allowedFileGlobs: [src/**]",
      "verificationCommands: [node test.js]",
      "",
    ].join("\n"),
  );
  writeFileSync(join(repoRoot, "package.json"), `{"type":"module"}\n`);
  writeFileSync(join(repoRoot, "src/value.js"), "export const value = 1;\n");
  writeFileSync(
    join(repoRoot, "test.js"),
    "import { value } from './src/value.js'; if (value !== 2) process.exit(1);\n",
  );
  writeFileSync(
    statePath,
    `${JSON.stringify(
      {
        samples: {
          "owner/simulated@simulatedsha123": {
            repoSlug: "owner/simulated",
            sha: "simulatedsha123",
            worktreePath: repoRoot,
            failureContext: { summary: "failed", jobs: [] },
          },
        },
        pullRequests: {},
        nextPullRequestNumber: 1,
      },
      null,
      2,
    )}\n`,
  );
  process.env.HOOTLINE_SIMULATOR_STATE_PATH = statePath;

  try {
    const provider = new SimulatedGitHubProvider();
    assert.match(
      await provider.readRepositoryFileFromDefaultBranch(event, ".hootline.yaml") ?? "",
      /version: 1/,
    );
    assert.equal((await provider.downloadArchive(event, 1024 * 1024)).byteLength > 0, true);

    const result = await provider.publishFix({
      event,
      policy: makePolicy("github", "owner/simulated", "pr_mr", {
        allowedFileGlobs: ["src/**"],
        verificationCommands: ["node test.js"],
      }),
      changes: [
        {
          status: "modified",
          path: "src/value.js",
          contentBase64: Buffer.from("export const value = 2;\n").toString("base64"),
        },
      ],
      summary: "Fix simulated value.",
    });

    assert.equal(result.changeNumber, 1);
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    const pr = requireRecord(state.pullRequests["owner/simulated#1"], "simulated pull request");
    assert.equal(pr.baseRef, "feature/fix-ci");
    assert.equal(pr.checkConclusion, "success");
    const firstCheck = requireRecord(requireArray(pr.checks, "simulated checks")[0], "simulated check");
    assert.equal(firstCheck.conclusion, "SUCCESS");
  } finally {
    restoreEnv("HOOTLINE_SIMULATOR_STATE_PATH", previousStatePath);
    rmSync(root, { recursive: true, force: true });
  }
});

test("simulated GitHub provider cleans up child processes after check timeout", async () => {
  const previousStatePath = process.env.HOOTLINE_SIMULATOR_STATE_PATH;
  const previousTimeout = process.env.HOOTLINE_SIMULATED_FIXTURE_COMMAND_TIMEOUT_MS;
  const root = mkdtempSync(join(tmpdir(), "hootline-sim-provider-timeout-"));
  const repoRoot = join(root, "repo");
  const statePath = join(root, "simulator-state.json");
  const markerPath = join(root, "child-lived");
  const event = { ...makeGitHubEvent(), repoSlug: "owner/simulated", sha: "timeoutsha123" };
  mkdirSync(join(repoRoot, "src"), { recursive: true });
  writeFileSync(join(repoRoot, "src/value.js"), "export const value = 1;\n");
  writeFileSync(
    statePath,
    `${JSON.stringify(
      {
        samples: {
          "owner/simulated@timeoutsha123": {
            repoSlug: "owner/simulated",
            sha: "timeoutsha123",
            worktreePath: repoRoot,
            failureContext: { summary: "failed", jobs: [] },
          },
        },
        pullRequests: {},
        nextPullRequestNumber: 1,
      },
      null,
      2,
    )}\n`,
  );
  process.env.HOOTLINE_SIMULATOR_STATE_PATH = statePath;
  process.env.HOOTLINE_SIMULATED_FIXTURE_COMMAND_TIMEOUT_MS = "75";

  try {
    const provider = new SimulatedGitHubProvider();
    const result = await provider.publishFix({
      event,
      policy: makePolicy("github", "owner/simulated", "pr_mr", {
        allowedFileGlobs: ["src/**"],
        verificationCommands: [childMarkerCommand(markerPath)],
      }),
      changes: [
        {
          status: "modified",
          path: "src/value.js",
          contentBase64: Buffer.from("export const value = 2;\n").toString("base64"),
        },
      ],
      summary: "Fix simulated value.",
    });

    assert.equal(result.changeNumber, 1);
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    const pr = requireRecord(state.pullRequests["owner/simulated#1"], "simulated pull request");
    assert.equal(pr.checkConclusion, "failure");
    const firstCheck = requireRecord(requireArray(pr.checks, "simulated checks")[0], "simulated check");
    assert.equal(firstCheck.timedOut, true);
    assert.equal(firstCheck.exitCode, 124);
    await sleep(500);
    assert.equal(existsSync(markerPath), false);
  } finally {
    restoreEnv("HOOTLINE_SIMULATOR_STATE_PATH", previousStatePath);
    restoreEnv("HOOTLINE_SIMULATED_FIXTURE_COMMAND_TIMEOUT_MS", previousTimeout);
    rmSync(root, { recursive: true, force: true });
  }
});

interface ProviderCall {
  body: UnknownRecord | undefined;
  method: string;
  path: string;
  url: string;
}

function readCall(input: RequestInfo | URL, init: RequestInit): ProviderCall {
  const url = new URL(input.toString());
  return {
    body: parseRequestBody(init.body),
    method: init.method ?? "GET",
    path: `${url.pathname}${url.search}`,
    url: url.toString(),
  };
}

function parseRequestBody(body: BodyInit | null | undefined): UnknownRecord | undefined {
  if (typeof body !== "string") return undefined;
  const parsed: unknown = JSON.parse(body);
  return requireRecord(parsed, "provider request body");
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });
}

async function listenTestServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ close: () => Promise<void>; url: string }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      }),
  };
}

function makeGitHubEvent(): NormalizedPipelineEvent {
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
    receivedAt: "2026-06-17T00:00:00.000Z",
  };
}

function makeGitLabEvent(overrides: Partial<NormalizedPipelineEvent> = {}): NormalizedPipelineEvent {
  return {
    provider: "gitlab",
    id: "gitlab:group/project:2002:fedcba987654",
    deliveryId: "delivery-2",
    repoSlug: "group/project",
    projectId: "55",
    pipelineId: "2002",
    pipelineUrl: "https://gitlab.example.test/group/project/-/pipelines/2002",
    ref: "main",
    sha: "fedcba9876543210",
    source: "push",
    status: "failed",
    conclusion: "failed",
    targetBranch: "main",
    eventName: "Pipeline Hook",
    receivedAt: "2026-06-17T00:00:00.000Z",
    ...overrides,
  };
}

function makePolicy(
  provider: "github" | "gitlab",
  slug: string,
  mode: RepoPolicy["mode"],
  overrides: Partial<RepoPolicy> = {},
): RepoPolicy {
  return {
    provider,
    slug,
    mode,
    allowedBranches: ["main", "feature/**"],
    allowedFileGlobs: ["**"],
    verificationCommands: ["npm test"],
    sandboxNetworkAllow: [],
    fixBranchPrefix: "hootline/fix",
    maxAttemptsPerSha: 2,
    maxSnapshotBytes: 1024 * 1024,
    allowGitlabSecretTokenFallback: false,
    autoMerge: { deleteSourceBranch: true, requireSuccessfulPipeline: true },
    ...overrides,
  };
}

function futureIso(): string {
  return new Date(Date.now() + 60 * 60 * 1000).toISOString();
}

function restoreEnv(name: string, previous: string | undefined): void {
  if (previous === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = previous;
  }
}

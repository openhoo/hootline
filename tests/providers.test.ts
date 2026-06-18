import { generateKeyPairSync } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";

import { assertResponseOk } from "../agent/lib/providers/common.ts";
import { GitHubProvider } from "../agent/lib/providers/github.ts";
import { GitLabProvider } from "../agent/lib/providers/gitlab.ts";
import type { NormalizedPipelineEvent, PublishInput, RepoPolicy, SandboxChange } from "../agent/lib/types.ts";
import { requireArray, requireRecord, type UnknownRecord } from "../agent/lib/unknown.ts";

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
        content: Buffer.from("version: 1\nallowedBranches: [main]\n").toString("base64"),
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
      "version: 1\nallowedBranches: [main]\n",
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
  globalThis.fetch = async (input, init = {}) => {
    const call = readCall(input, init);
    if (call.path === "/api/v4/projects/55") {
      return jsonResponse({ default_branch: "main" });
    }
    if (call.path === "/api/v4/projects/55/repository/files/.hootline.yaml?ref=main") {
      return jsonResponse({
        encoding: "base64",
        content: Buffer.from("version: 1\nallowedBranches: [main]\n").toString("base64"),
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
      "version: 1\nallowedBranches: [main]\n",
    );
    assert.equal(await provider.readRepositoryFileFromDefaultBranch(makeGitLabEvent(), "missing.yaml"), null);
  } finally {
    globalThis.fetch = previousFetch;
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
    if (call.path === "/repos/owner/repo/git/ref/heads/main") {
      return jsonResponse({ object: { sha: "base-sha" } });
    }
    if (call.path === "/repos/owner/repo/git/ref/heads/hootline/fix/main/abc123def456") {
      return jsonResponse({ message: "Not Found" }, 404);
    }
    if (call.path === "/repos/owner/repo/git/refs") {
      const body = requireRecord(call.body, "GitHub create ref request body");
      assert.equal(body.ref, "refs/heads/hootline/fix/main/abc123def456");
      assert.equal(body.sha, "base-sha");
      return jsonResponse({ ref: body.ref });
    }
    if (call.path === "/repos/owner/repo/git/commits/base-sha") {
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
    const url = new URL(call.url);
    if (
      call.method === "GET" &&
      call.path === `/api/v4/projects/55/repository/branches/${encodeURIComponent(expectedBranch)}`
    ) {
      return jsonResponse({ name: expectedBranch });
    }
    if (call.method === "HEAD" && call.path.startsWith("/api/v4/projects/55/repository/files/")) {
      assert.equal(url.searchParams.get("ref"), expectedBranch);
      return call.path.includes("src%2Fexisting.bin")
        ? new Response(null, { status: 200 })
        : new Response(null, { status: 404 });
    }
    if (call.method === "POST" && call.path === "/api/v4/projects/55/repository/commits") {
      const body = requireRecord(call.body, "GitLab create commit request body");
      assert.equal(body.branch, expectedBranch);
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
      assert.equal(body.target_branch, "main");
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
        { status: "added", path: "src/existing.bin", contentBase64: "ZXhpc3Rpbmc=" },
        { status: "modified", path: "src/new.bin", contentBase64: "bmV3" },
        { status: "deleted", path: "src/already-deleted.bin" },
      ],
      summary: "Reuse the fixer branch safely.",
    });

    assert.equal(result.branch, expectedBranch);
    assert.equal(result.commitSha, "commit-sha");
    assert.equal(result.changeNumber, 7);
    assert.equal(
      calls.filter((call) => call.method === "HEAD" && call.path.startsWith("/api/v4/projects/55/repository/files/"))
        .length,
      3,
    );
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv("GITLAB_TOKEN", previousToken);
    restoreEnv("GITLAB_BASE_URL", previousBaseUrl);
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

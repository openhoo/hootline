import { createSign } from "node:crypto";

import { createLogger } from "../logger.ts";
import { redact } from "../redact.ts";
import { validateChangesAgainstPolicy } from "../sandbox.ts";
import { isFailureStatus } from "../webhooks.ts";
import type {
  FailedJobLog,
  FailureContext,
  MergeChangeInput,
  NormalizedPipelineEvent,
  PublishInput,
  PublishResult,
  SandboxChange,
} from "../types.ts";
import {
  assertResponseOk,
  buildFixBranchName,
  isRecord,
  MAX_LOG_BYTES,
  parseJsonResponse,
  PROVIDER_DOWNLOAD_TIMEOUT_MS,
  PROVIDER_REQUEST_TIMEOUT_MS,
  readBodyWithCap,
  readCappedText,
  readNumber,
  readString,
  requireRecord,
  type UnknownRecord,
  type ProviderClient,
} from "./common.ts";

interface CachedToken {
  expiresAt: number;
  token: string;
}

interface GitHubTreeEntry {
  path: string;
  mode: "100644";
  type: "blob";
  sha: string | null;
}

const tokenCache = new Map<string, CachedToken>();

const log = createLogger("providers.github");

export class GitHubProvider implements ProviderClient {
  async readRepositoryFileFromDefaultBranch(
    event: NormalizedPipelineEvent,
    path: string,
  ): Promise<string | null> {
    const repo = await this.requestRecord(event, "GET", `/repos/${event.repoSlug}`);
    const defaultBranch = readString(repo.default_branch);
    if (defaultBranch === undefined) {
      throw new Error(`GitHub repository ${event.repoSlug} did not return a default branch.`);
    }

    const response = await this.requestRaw(
      event,
      "GET",
      `/repos/${event.repoSlug}/contents/${encodeGitHubPath(path)}?ref=${encodeURIComponent(defaultBranch)}`,
    );
    if (response.status === 404) return null;
    const body = await parseJsonResponse(response);
    assertResponseOk(response, body, `GitHub GET repository file ${path}`);
    const record = requireRecord(body, `GitHub repository file ${path}`);
    if (readString(record.type) !== "file") return null;
    const encoding = readString(record.encoding);
    const content = readString(record.content);
    if (encoding !== "base64" || content === undefined) {
      throw new Error(`GitHub repository file ${path} was not returned as base64 content.`);
    }
    return Buffer.from(content.replace(/\s/g, ""), "base64").toString("utf8");
  }

  async getFailureContext(event: NormalizedPipelineEvent): Promise<FailureContext> {
    const jobs =
      event.runId !== undefined
        ? await this.listFailedWorkflowJobs(event)
        : event.checkSuiteId !== undefined
          ? await this.listFailedCheckRuns(event)
          : [];
    const summary =
      jobs.length === 0
        ? `GitHub ${event.eventName} failed for ${event.repoSlug}@${event.sha}.`
        : `GitHub workflow failed with ${jobs.length} failed job(s): ${jobs
            .map((job) => job.name)
            .join(", ")}.`;
    return { event, jobs, summary };
  }

  async downloadArchive(event: NormalizedPipelineEvent, maxSnapshotBytes: number): Promise<Buffer> {
    const response = await this.requestRaw(
      event,
      "GET",
      `/repos/${event.repoSlug}/tarball/${event.sha}`,
      undefined,
      { accept: "application/vnd.github+json" },
      PROVIDER_DOWNLOAD_TIMEOUT_MS,
    );
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`GitHub archive download failed with HTTP ${response.status}: ${redact(body, 4000)}`);
    }
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > maxSnapshotBytes) {
      throw new Error(
        redact(
          `GitHub archive is ${contentLength} bytes, above policy limit ${maxSnapshotBytes}.`,
        ),
      );
    }
    return readBodyWithCap(response, maxSnapshotBytes);
  }

  async publishFix(input: PublishInput): Promise<PublishResult> {
    validateChangesAgainstPolicy(input.changes, input.policy);
    const branch = buildFixBranchName(input.policy.fixBranchPrefix, input.event);
    const baseSha = input.event.sha;
    await this.ensureBranch(input.event, branch, baseSha);
    const commitSha = await this.createCommit(input.event, branch, baseSha, input.changes, input.summary);

    if (input.policy.mode === "push_branch") {
      return {
        provider: "github",
        mode: input.policy.mode,
        branch,
        commitSha,
        message: `Pushed fix commit ${commitSha} to ${branch}.`,
      };
    }

    const pr = await this.createOrUpdatePullRequest(input.event, branch, input.summary);
    return {
      provider: "github",
      mode: input.policy.mode,
      branch,
      commitSha,
      changeNumber: pr.number,
      changeUrl: pr.url,
      message: `Published fix PR #${pr.number}: ${pr.url}`,
    };
  }

  async postComment(event: NormalizedPipelineEvent, body: string): Promise<void> {
    if (event.pullRequestNumber !== undefined) {
      await this.request(event, "POST", `/repos/${event.repoSlug}/issues/${event.pullRequestNumber}/comments`, {
        body,
      });
      return;
    }
    await this.request(event, "POST", `/repos/${event.repoSlug}/commits/${event.sha}/comments`, {
      body: event.pipelineUrl === undefined ? body : `${body}\n\nPipeline: ${event.pipelineUrl}`,
    });
  }

  async rerunPipeline(event: NormalizedPipelineEvent): Promise<{ message: string }> {
    if (event.runId === undefined) {
      throw new Error("GitHub rerun requires workflow_run.runId.");
    }
    await this.request(event, "POST", `/repos/${event.repoSlug}/actions/runs/${event.runId}/rerun-failed-jobs`);
    return { message: `Requested rerun of failed jobs for workflow run ${event.runId}.` };
  }

  async mergeChange(input: MergeChangeInput): Promise<PublishResult> {
    const merged = await this.requestRecord(
      input.event,
      "PUT",
      `/repos/${input.event.repoSlug}/pulls/${input.changeNumber}/merge`,
      {
        merge_method: "squash",
        commit_title: `Fix failing pipeline for ${input.event.sha.slice(0, 12)}`,
        ...(input.expectedCommitSha === undefined ? {} : { sha: input.expectedCommitSha }),
      },
    );
    if (input.deleteSourceBranch) {
      await this.request(
        input.event,
        "DELETE",
        `/repos/${input.event.repoSlug}/git/refs/heads/${encodeGitHubRefName(input.branch)}`,
      ).catch(() => undefined);
    }
    return {
      provider: "github",
      mode: "auto_merge",
      branch: input.branch,
      commitSha: readString(merged.sha),
      changeNumber: input.changeNumber,
      merged: true,
      message: `Merged GitHub PR #${input.changeNumber}.`,
    };
  }

  private async listFailedWorkflowJobs(event: NormalizedPipelineEvent): Promise<FailedJobLog[]> {
    const jobsResponse = await this.requestRecord(
      event,
      "GET",
      `/repos/${event.repoSlug}/actions/runs/${event.runId}/jobs?filter=latest&per_page=100`,
    );
    const jobs = Array.isArray(jobsResponse.jobs) ? jobsResponse.jobs.filter(isRecord) : [];
    const failedJobs = jobs.filter((job) => isFailureStatus(readString(job.conclusion) ?? readString(job.status) ?? ""));
    const logs: FailedJobLog[] = [];
    for (const job of failedJobs.slice(0, 8)) {
      const id = readNumber(job.id)?.toString();
      if (id === undefined) continue;
      const log = await this.fetchJobLog(event, id).catch((error: unknown) =>
        `Failed to fetch log: ${error instanceof Error ? error.message : String(error)}`,
      );
      logs.push({
        id,
        name: readString(job.name) ?? id,
        url: readString(job.html_url),
        conclusion: readString(job.conclusion),
        status: readString(job.status),
        log: redact(log),
      });
    }
    return logs;
  }

  private async listFailedCheckRuns(event: NormalizedPipelineEvent): Promise<FailedJobLog[]> {
    const runsResponse = await this.requestRecord(
      event,
      "GET",
      `/repos/${event.repoSlug}/check-suites/${event.checkSuiteId}/check-runs?filter=latest&per_page=100`,
    );
    const checkRuns = Array.isArray(runsResponse.check_runs)
      ? runsResponse.check_runs.filter(isRecord)
      : [];
    return checkRuns
      .filter((run) => isFailureStatus(readString(run.conclusion) ?? readString(run.status) ?? ""))
      .slice(0, 8)
      .map((run) => {
        const output = isRecord(run.output) ? run.output : undefined;
        const log = [
          readString(output?.title),
          readString(output?.summary),
          readString(output?.text),
        ].filter((value): value is string => value !== undefined);
        const id = readNumber(run.id)?.toString() ?? readString(run.name) ?? "check-run";
        return {
          id,
          name: readString(run.name) ?? id,
          url: readString(run.html_url) ?? readString(run.details_url),
          conclusion: readString(run.conclusion),
          status: readString(run.status),
          log: redact(log.length === 0 ? "No check run output returned." : log.join("\n\n")),
        };
      });
  }

  private async fetchJobLog(event: NormalizedPipelineEvent, jobId: string): Promise<string> {
    const response = await this.requestRaw(
      event,
      "GET",
      `/repos/${event.repoSlug}/actions/jobs/${jobId}/logs`,
      undefined,
      {},
      PROVIDER_DOWNLOAD_TIMEOUT_MS,
    );
    if (!response.ok) return `GitHub log fetch failed with HTTP ${response.status}.`;
    return readCappedText(response, MAX_LOG_BYTES);
  }

  private async ensureBranch(
    event: NormalizedPipelineEvent,
    branch: string,
    baseSha: string,
  ): Promise<void> {
    const encodedBranch = encodeGitHubRefName(branch);
    const exists = await this.request(
      event,
      "GET",
      `/repos/${event.repoSlug}/git/ref/heads/${encodedBranch}`,
    ).then(
      () => true,
      () => false,
    );
    if (exists) return;
    await this.request(event, "POST", `/repos/${event.repoSlug}/git/refs`, {
      ref: `refs/heads/${branch}`,
      sha: baseSha,
    });
  }

  private async createCommit(
    event: NormalizedPipelineEvent,
    branch: string,
    baseSha: string,
    changes: readonly SandboxChange[],
    summary: string,
  ): Promise<string> {
    const baseCommit = await this.requestRecord(
      event,
      "GET",
      `/repos/${event.repoSlug}/git/commits/${baseSha}`,
    );
    const baseTree = isRecord(baseCommit.tree) ? baseCommit.tree : undefined;
    const tree = await this.requestRecord(
      event,
      "POST",
      `/repos/${event.repoSlug}/git/trees`,
      {
        base_tree: readString(baseTree?.sha),
        tree: await Promise.all(changes.map((change) => this.toGitHubTreeEntry(event, change))),
      },
    );
    const commit = await this.requestRecord(
      event,
      "POST",
      `/repos/${event.repoSlug}/git/commits`,
      {
        message: `Fix failing pipeline\n\n${summary}`,
        tree: readString(tree.sha),
        parents: [baseSha],
      },
    );
    const commitSha = readString(commit.sha);
    if (commitSha === undefined) throw new Error("GitHub did not return a commit SHA.");
    await this.request(
      event,
      "PATCH",
      `/repos/${event.repoSlug}/git/refs/heads/${encodeGitHubRefName(branch)}`,
      { sha: commitSha, force: true },
    );
    return commitSha;
  }

  private async toGitHubTreeEntry(
    event: NormalizedPipelineEvent,
    change: SandboxChange,
  ): Promise<GitHubTreeEntry> {
    if (change.status === "deleted") {
      return { path: change.path, mode: "100644", type: "blob", sha: null };
    }
    const blob = await this.requestRecord(
      event,
      "POST",
      `/repos/${event.repoSlug}/git/blobs`,
      {
        content: change.contentBase64 ?? "",
        encoding: "base64",
      },
    );
    const sha = readString(blob.sha);
    if (sha === undefined) throw new Error(`GitHub did not return a blob SHA for ${change.path}.`);
    return { path: change.path, mode: "100644", type: "blob", sha };
  }

  private async createOrUpdatePullRequest(
    event: NormalizedPipelineEvent,
    branch: string,
    summary: string,
  ): Promise<{ number: number; url: string | undefined }> {
    const existing = await this.requestRecord(
      event,
      "GET",
      `/search/issues?q=${encodeURIComponent(
        `repo:${event.repoSlug} type:pr state:open head:${branch}`,
      )}`,
    );
    const match = Array.isArray(existing.items) ? existing.items.find(isRecord) : undefined;
    const number = readNumber(match?.number);
    if (number !== undefined) {
      await this.request(event, "PATCH", `/repos/${event.repoSlug}/pulls/${number}`, {
        body: buildChangeBody(event, summary),
      });
      return { number, url: readString(match?.html_url) };
    }

    const created = await this.requestRecord(
      event,
      "POST",
      `/repos/${event.repoSlug}/pulls`,
      {
        title: `Fix failing pipeline for ${event.sha.slice(0, 12)}`,
        head: branch,
        base: event.sourceBranch ?? event.ref,
        body: buildChangeBody(event, summary),
        maintainer_can_modify: true,
      },
    );
    const createdNumber = readNumber(created.number);
    if (createdNumber === undefined) throw new Error("GitHub did not return a PR number.");
    return { number: createdNumber, url: readString(created.html_url) };
  }

  private async request(
    event: NormalizedPipelineEvent,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    const response = await this.requestRaw(event, method, path, body);
    const parsed = await parseJsonResponse(response);
    assertResponseOk(response, parsed, `GitHub ${method} ${path}`);
    return parsed;
  }

  private async requestRecord(
    event: NormalizedPipelineEvent,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<UnknownRecord> {
    return requireRecord(await this.request(event, method, path, body), `GitHub ${method} ${path}`);
  }

  private async requestRaw(
    event: NormalizedPipelineEvent,
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
    timeoutMs: number = PROVIDER_REQUEST_TIMEOUT_MS,
  ): Promise<Response> {
    // The path carries no credentials (the token is in the Authorization header).
    log.debug({ repoSlug: event.repoSlug, method, path }, "github api request");
    const token = await getInstallationToken(event);
    const init: RequestInit = {
      method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-github-api-version": "2022-11-28",
        ...headers,
      },
      signal: AbortSignal.timeout(timeoutMs),
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    return fetchWithTimeout(`https://api.github.com${path}`, init, timeoutMs);
  }
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (error) {
    if (isTimeoutError(error)) {
      throw new Error(redact(`GitHub request timed out after ${timeoutMs}ms`));
    }
    throw error;
  }
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}

async function getInstallationToken(event: NormalizedPipelineEvent): Promise<string> {
  if (event.installationId === undefined) {
    throw new Error("GitHub event did not include installation.id.");
  }
  const appId = process.env.GITHUB_APP_ID;
  const privateKey = process.env.GITHUB_APP_PRIVATE_KEY?.replace(/\\n/g, "\n");
  if (!appId || !privateKey) throw new Error("GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY are required.");
  const cacheKey = `${appId}:${event.installationId}`;
  const cached = tokenCache.get(cacheKey);
  if (cached !== undefined && Date.now() < cached.expiresAt - 60_000) return cached.token;
  const jwt = createGitHubJwt(appId, privateKey);
  const response = await fetchWithTimeout(
    `https://api.github.com/app/installations/${event.installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${jwt}`,
        "x-github-api-version": "2022-11-28",
      },
      signal: AbortSignal.timeout(PROVIDER_REQUEST_TIMEOUT_MS),
    },
    PROVIDER_REQUEST_TIMEOUT_MS,
  );
  const body = await parseJsonResponse(response);
  assertResponseOk(response, body, "GitHub installation token");
  if (!isRecord(body) || typeof body.token !== "string") {
    throw new Error("GitHub installation token response did not include token.");
  }
  const expiresAt = typeof body.expires_at === "string" ? Date.parse(body.expires_at) : Date.now() + 3600_000;
  tokenCache.set(cacheKey, { token: body.token, expiresAt });
  return body.token;
}

function createGitHubJwt(appId: string, privateKey: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({ iat: now - 60, exp: now + 600, iss: appId }),
  ).toString("base64url");
  const unsigned = `${header}.${payload}`;
  const signature = createSign("RSA-SHA256").update(unsigned).sign(privateKey, "base64url");
  return `${unsigned}.${signature}`;
}

function encodeGitHubRefName(ref: string): string {
  return ref.split("/").map(encodeURIComponent).join("/");
}

function encodeGitHubPath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

function buildChangeBody(event: NormalizedPipelineEvent, summary: string): string {
  return [
    "Automated fix for a failing GitHub pipeline.",
    "",
    `Pipeline: ${event.pipelineUrl ?? event.pipelineId}`,
    `Source ref: ${event.ref}`,
    `Source SHA: ${event.sha}`,
    "",
    summary,
  ].join("\n");
}

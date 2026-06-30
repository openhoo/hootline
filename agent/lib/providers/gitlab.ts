import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";

import { createLogger } from "../logger.ts";
import { redact } from "../redact.ts";
import { validateChangesAgainstPolicy } from "../sandbox.ts";
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
  readCappedText,
  readNumber,
  readString,
  requireArray,
  requireRecord,
  type UnknownRecord,
  type ProviderClient,
} from "./common.ts";

interface GitLabCommitAction {
  action: "create" | "update" | "delete";
  file_path: string;
  content?: string;
  encoding?: "base64";
}

const log = createLogger("providers.gitlab");

export class GitLabProvider implements ProviderClient {
  async readRepositoryFileFromDefaultBranch(
    event: NormalizedPipelineEvent,
    path: string,
  ): Promise<string | null> {
    const project = await this.requestRecord(event, "GET", `/projects/${encodeProject(event)}`);
    const defaultBranch = readString(project.default_branch);
    if (defaultBranch === undefined) {
      throw new Error(`GitLab project ${event.repoSlug} did not return a default branch.`);
    }

    const response = await this.requestRaw(
      event,
      "GET",
      `/projects/${encodeProject(event)}/repository/files/${encodeURIComponent(path)}?ref=${encodeURIComponent(
        defaultBranch,
      )}`,
    );
    if (response.status === 404) return null;
    const body = await parseJsonResponse(response);
    assertResponseOk(response, body, `GitLab GET repository file ${path}`);
    const record = requireRecord(body, `GitLab repository file ${path}`);
    const encoding = readString(record.encoding);
    const content = readString(record.content);
    if (encoding !== "base64" || content === undefined) {
      throw new Error(`GitLab repository file ${path} was not returned as base64 content.`);
    }
    return Buffer.from(content.replace(/\s/g, ""), "base64").toString("utf8");
  }

  async getFailureContext(event: NormalizedPipelineEvent): Promise<FailureContext> {
    const jobs = await this.listFailedJobs(event);
    const summary =
      jobs.length === 0
        ? `GitLab pipeline failed for ${event.repoSlug}@${event.sha}.`
        : `GitLab pipeline failed with ${jobs.length} failed job(s): ${jobs
            .map((job) => job.name)
            .join(", ")}.`;
    return { event, jobs, summary };
  }

  async downloadArchive(event: NormalizedPipelineEvent, maxSnapshotBytes: number): Promise<Buffer> {
    const path = `/projects/${encodeProject(event)}/repository/archive.tar.gz?sha=${encodeURIComponent(event.sha)}`;
    log.debug({ repoSlug: event.repoSlug, method: "GET", path }, "gitlab api request");
    const token = process.env.GITLAB_TOKEN;
    if (!token) throw new Error("GITLAB_TOKEN is required.");
    const baseUrl = process.env.GITLAB_BASE_URL ?? "https://gitlab.com";
    const response = await requestBinaryWithCap(
      `${baseUrl.replace(/\/$/, "")}/api/v4${path}`,
      {
        accept: "application/octet-stream",
        "private-token": token,
        "user-agent": "hootline",
      },
      PROVIDER_DOWNLOAD_TIMEOUT_MS,
      maxSnapshotBytes,
    );
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new Error(
        `GitLab archive download failed with HTTP ${response.statusCode}: ${redact(
          response.body.toString("utf8"),
          4000,
        )}`,
      );
    }
    const contentLength = Number(response.headers["content-length"]);
    if (Number.isFinite(contentLength) && contentLength > maxSnapshotBytes) {
      throw new Error(
        redact(
          `GitLab archive is ${contentLength} bytes, above policy limit ${maxSnapshotBytes}.`,
        ),
      );
    }
    return response.body;
  }

  async publishFix(input: PublishInput): Promise<PublishResult> {
    validateChangesAgainstPolicy(input.changes, input.policy);
    const branch = buildFixBranchName(input.policy.fixBranchPrefix, input.event);
    await this.ensureBranch(input.event, branch, input.event.sha);
    const commit = await this.createCommit(input.event, branch, input.changes, input.summary);

    if (input.policy.mode === "push_branch") {
      return {
        provider: "gitlab",
        mode: input.policy.mode,
        branch,
        commitSha: commit.id,
        message: `Pushed fix commit ${commit.id} to ${branch}.`,
      };
    }

    const mr = await this.createOrUpdateMergeRequest(
      input.event,
      branch,
      input.summary,
      input.policy.autoMerge.deleteSourceBranch,
    );
    return {
      provider: "gitlab",
      mode: input.policy.mode,
      branch,
      commitSha: commit.id,
      changeNumber: mr.iid,
      changeUrl: mr.webUrl,
      message: `Published fix MR !${mr.iid}: ${mr.webUrl}`,
    };
  }

  async postComment(event: NormalizedPipelineEvent, body: string): Promise<void> {
    if (event.mergeRequestIid !== undefined) {
      await this.request(
        event,
        "POST",
        `/projects/${encodeProject(event)}/merge_requests/${event.mergeRequestIid}/notes`,
        { body },
      );
      return;
    }
    await this.request(event, "POST", `/projects/${encodeProject(event)}/repository/commits/${event.sha}/comments`, {
      note: event.pipelineUrl === undefined ? body : `${body}\n\nPipeline: ${event.pipelineUrl}`,
    });
  }

  async rerunPipeline(event: NormalizedPipelineEvent): Promise<{ message: string }> {
    await this.request(
      event,
      "POST",
      `/projects/${encodeProject(event)}/pipelines/${event.pipelineId}/retry`,
    );
    return { message: `Requested retry for GitLab pipeline ${event.pipelineId}.` };
  }

  async mergeChange(input: MergeChangeInput): Promise<PublishResult> {
    const body = await this.requestRecord(
      input.event,
      "PUT",
      `/projects/${encodeProject(input.event)}/merge_requests/${input.changeNumber}/merge`,
      {
        squash: true,
        should_remove_source_branch: input.deleteSourceBranch,
      },
    );
    return {
      provider: "gitlab",
      mode: "auto_merge",
      branch: input.branch,
      commitSha: readString(body.merge_commit_sha),
      changeNumber: input.changeNumber,
      merged: true,
      message: `Merged GitLab MR !${input.changeNumber}.`,
    };
  }

  private async listFailedJobs(event: NormalizedPipelineEvent): Promise<FailedJobLog[]> {
    const jobs = await this.requestArray(
      event,
      "GET",
      `/projects/${encodeProject(event)}/pipelines/${event.pipelineId}/jobs?per_page=100`,
    );
    const output: FailedJobLog[] = [];
    for (const job of jobs.filter(isRecord).filter(isFailedJob).slice(0, 8)) {
      const id = readNumber(job.id)?.toString();
      if (id === undefined) continue;
      const log = await this.fetchJobTrace(event, id).catch((error: unknown) =>
        `Failed to fetch trace: ${error instanceof Error ? error.message : String(error)}`,
      );
      output.push({
        id,
        name: readString(job.name) ?? id,
        url: readString(job.web_url),
        conclusion: readString(job.status),
        status: readString(job.status),
        log: redact(log),
      });
    }
    return output;
  }

  private async fetchJobTrace(event: NormalizedPipelineEvent, jobId: string): Promise<string> {
    const response = await this.requestRaw(
      event,
      "GET",
      `/projects/${encodeProject(event)}/jobs/${jobId}/trace`,
      undefined,
      PROVIDER_DOWNLOAD_TIMEOUT_MS,
    );
    if (!response.ok) return `GitLab trace fetch failed with HTTP ${response.status}.`;
    return readCappedText(response, MAX_LOG_BYTES);
  }

  private async ensureBranch(
    event: NormalizedPipelineEvent,
    branch: string,
    ref: string,
  ): Promise<void> {
    const exists = await this.request(
      event,
      "GET",
      `/projects/${encodeProject(event)}/repository/branches/${encodeURIComponent(branch)}`,
    ).then(
      () => true,
      () => false,
    );
    if (exists) return;
    await this.request(event, "POST", `/projects/${encodeProject(event)}/repository/branches`, {
      branch,
      ref,
    });
  }

  private async createCommit(
    event: NormalizedPipelineEvent,
    branch: string,
    changes: readonly SandboxChange[],
    summary: string,
  ): Promise<{ id: string }> {
    const actions = (
      await Promise.all(
        changes.map(async (change) =>
          toGitLabCommitAction(change, await this.fileExistsOnBranch(event, branch, change.path)),
        ),
      )
    ).filter((action): action is GitLabCommitAction => action !== null);
    if (actions.length === 0) {
      throw new Error(`No publishable GitLab file actions remain on fixer branch ${branch}.`);
    }
    const response = await this.requestRecord(
      event,
      "POST",
      `/projects/${encodeProject(event)}/repository/commits`,
      {
        branch,
        commit_message: `Fix failing pipeline\n\n${summary}`,
        actions,
      },
    );
    const id = readString(response.id);
    if (id === undefined) throw new Error("GitLab did not return a commit id.");
    return { id };
  }

  private async createOrUpdateMergeRequest(
    event: NormalizedPipelineEvent,
    branch: string,
    summary: string,
    deleteSourceBranch: boolean,
  ): Promise<{ iid: number; webUrl: string | undefined }> {
    const existing = await this.requestArray(
      event,
      "GET",
      `/projects/${encodeProject(event)}/merge_requests?state=opened&source_branch=${encodeURIComponent(
        branch,
      )}`,
    );
    const match = existing.find(isRecord);
    const iid = readNumber(match?.iid);
    if (iid !== undefined) {
      await this.request(event, "PUT", `/projects/${encodeProject(event)}/merge_requests/${iid}`, {
        description: buildChangeBody(event, summary),
        remove_source_branch: deleteSourceBranch,
      });
      return { iid, webUrl: readString(match?.web_url) };
    }

    const created = await this.requestRecord(
      event,
      "POST",
      `/projects/${encodeProject(event)}/merge_requests`,
      {
        source_branch: branch,
        target_branch: event.targetBranch ?? event.ref,
        title: `Fix failing pipeline for ${event.sha.slice(0, 12)}`,
        description: buildChangeBody(event, summary),
        remove_source_branch: deleteSourceBranch,
      },
    );
    const createdIid = readNumber(created.iid);
    if (createdIid === undefined) throw new Error("GitLab did not return an MR iid.");
    return { iid: createdIid, webUrl: readString(created.web_url) };
  }

  private async request(
    event: NormalizedPipelineEvent,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    const response = await this.requestRaw(event, method, path, body);
    const parsed = await parseJsonResponse(response);
    assertResponseOk(response, parsed, `GitLab ${method} ${path}`);
    return parsed;
  }

  private async requestRecord(
    event: NormalizedPipelineEvent,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<UnknownRecord> {
    return requireRecord(await this.request(event, method, path, body), `GitLab ${method} ${path}`);
  }

  private async requestArray(
    event: NormalizedPipelineEvent,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<unknown[]> {
    return requireArray(await this.request(event, method, path, body), `GitLab ${method} ${path}`);
  }

  private async fileExistsOnBranch(
    event: NormalizedPipelineEvent,
    branch: string,
    path: string,
  ): Promise<boolean> {
    if (path.length === 0) return false;
    const response = await this.requestRaw(
      event,
      "HEAD",
      `/projects/${encodeProject(event)}/repository/files/${encodeURIComponent(path)}?ref=${encodeURIComponent(
        branch,
      )}`,
    );
    if (response.status === 404) return false;
    const parsed = await parseJsonResponse(response);
    assertResponseOk(response, parsed, `GitLab HEAD repository file ${path}`);
    return true;
  }

  private async requestRaw(
    event: NormalizedPipelineEvent,
    method: string,
    path: string,
    body?: unknown,
    timeoutMs: number = PROVIDER_REQUEST_TIMEOUT_MS,
  ): Promise<Response> {
    // The path carries no credentials (the token is in the private-token header).
    log.debug({ repoSlug: event.repoSlug, method, path }, "gitlab api request");
    const token = process.env.GITLAB_TOKEN;
    if (!token) throw new Error("GITLAB_TOKEN is required.");
    const baseUrl = process.env.GITLAB_BASE_URL ?? "https://gitlab.com";
    const init: RequestInit = {
      method,
      headers: {
        "content-type": "application/json",
        "private-token": token,
      },
      signal: AbortSignal.timeout(timeoutMs),
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    return fetchWithTimeout(`${baseUrl.replace(/\/$/, "")}/api/v4${path}`, init, timeoutMs);
  }
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (error) {
    if (isTimeoutError(error)) {
      throw new Error(redact(`GitLab request timed out after ${timeoutMs}ms`));
    }
    throw error;
  }
}

interface BinaryResponse {
  statusCode: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

function requestBinaryWithCap(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
  maxBytes: number,
  redirectsRemaining = 3,
): Promise<BinaryResponse> {
  const parsed = new URL(url);
  const request = parsed.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = request(parsed, { headers, method: "GET", timeout: timeoutMs }, (res) => {
      const statusCode = res.statusCode ?? 0;
      const location = res.headers.location;
      if (location && isRedirectStatus(statusCode) && redirectsRemaining > 0) {
        res.resume();
        const next = new URL(location, parsed);
        const nextHeaders = redirectHeaders(parsed, next, headers);
        requestBinaryWithCap(next.toString(), nextHeaders, timeoutMs, maxBytes, redirectsRemaining - 1).then(
          resolve,
          reject,
        );
        return;
      }

      const chunks: Buffer[] = [];
      let bytes = 0;
      res.on("data", (chunk: Buffer) => {
        bytes += chunk.byteLength;
        if (bytes > maxBytes) {
          req.destroy(new Error(redact(`GitLab archive exceeded policy limit ${maxBytes} bytes.`)));
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", () => {
        resolve({ statusCode, headers: res.headers, body: Buffer.concat(chunks) });
      });
    });
    req.on("timeout", () => {
      req.destroy(new Error(redact(`GitLab request timed out after ${timeoutMs}ms`)));
    });
    req.on("error", reject);
    req.end();
  });
}

function isRedirectStatus(statusCode: number): boolean {
  return statusCode === 301 || statusCode === 302 || statusCode === 303 || statusCode === 307 || statusCode === 308;
}

function redirectHeaders(
  current: URL,
  next: URL,
  headers: Record<string, string>,
): Record<string, string> {
  if (current.origin === next.origin) return headers;
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => !isSensitiveRedirectHeader(name)),
  );
}

function isSensitiveRedirectHeader(name: string): boolean {
  const normalized = name.toLowerCase();
  return normalized === "authorization" || normalized === "private-token" || normalized === "cookie";
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}

function toGitLabCommitAction(change: SandboxChange, fileExists: boolean): GitLabCommitAction | null {
  if (change.status === "deleted") {
    return fileExists ? { action: "delete", file_path: change.path } : null;
  }
  return {
    action: fileExists ? "update" : "create",
    file_path: change.path,
    content: change.contentBase64 ?? "",
    encoding: "base64",
  };
}

function encodeProject(event: NormalizedPipelineEvent): string {
  const project = event.projectId ?? event.repoSlug;
  if (/^\d+$/.test(project)) return project;
  try {
    return encodeURIComponent(decodeURIComponent(project));
  } catch {
    return encodeURIComponent(project);
  }
}

function buildChangeBody(event: NormalizedPipelineEvent, summary: string): string {
  return [
    "Automated fix for a failing GitLab pipeline.",
    "",
    `Pipeline: ${event.pipelineUrl ?? event.pipelineId}`,
    `Source ref: ${event.ref}`,
    `Source SHA: ${event.sha}`,
    "",
    summary,
  ].join("\n");
}

// Intentional SUBSET of the canonical FAILURE_STATUSES (see webhooks.ts): GitLab job
// statuses do not include "failure"/"action_required", so we deliberately do not widen
// this to the shared isFailureStatus helper. Keep this list explicit.
const GITLAB_FAILED_JOB_STATUSES = ["failed", "timed_out", "cancelled", "canceled"];

function isFailedJob(job: UnknownRecord): boolean {
  const status = readString(job.status) ?? "";
  return GITLAB_FAILED_JOB_STATUSES.includes(status.toLowerCase());
}

import { redact } from "../redact.ts";
import type {
  FailedJobLog,
  FailureContext,
  NormalizedPipelineEvent,
  PublishInput,
  PublishResult,
  SandboxChange,
} from "../types.ts";
import {
  assertResponseOk,
  buildFixBranchName,
  isRecord,
  parseJsonResponse,
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

export class GitLabProvider implements ProviderClient {
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

  async downloadArchive(event: NormalizedPipelineEvent): Promise<Buffer> {
    const response = await this.requestRaw(
      event,
      "GET",
      `/projects/${encodeProject(event)}/repository/archive.tar.gz?sha=${encodeURIComponent(event.sha)}`,
    );
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`GitLab archive download failed with HTTP ${response.status}: ${redact(body, 4000)}`);
    }
    return Buffer.from(await response.arrayBuffer());
  }

  async publishFix(input: PublishInput): Promise<PublishResult> {
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

  async mergeChange(input: {
    event: NormalizedPipelineEvent;
    changeNumber: number;
    branch: string;
    deleteSourceBranch: boolean;
  }): Promise<PublishResult> {
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
    );
    if (!response.ok) return `GitLab trace fetch failed with HTTP ${response.status}.`;
    return response.text();
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
    _event: NormalizedPipelineEvent,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Response> {
    const token = process.env.GITLAB_TOKEN;
    if (!token) throw new Error("GITLAB_TOKEN is required.");
    const baseUrl = process.env.GITLAB_BASE_URL ?? "https://gitlab.com";
    const init: RequestInit = {
      method,
      headers: {
        "content-type": "application/json",
        "private-token": token,
      },
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    return fetch(`${baseUrl.replace(/\/$/, "")}/api/v4${path}`, init);
  }
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

function isFailedJob(job: UnknownRecord): boolean {
  const status = readString(job.status) ?? "";
  return ["failed", "timed_out", "cancelled", "canceled"].includes(status.toLowerCase());
}

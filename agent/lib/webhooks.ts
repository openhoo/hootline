import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import type { NormalizedPipelineEvent, RepoPolicy } from "./types.ts";
import { isRecord, readNumber, readString, type UnknownRecord } from "./unknown.ts";

export type GitLabWebhookVerification = "standard" | "secret_token" | "none";

const GITLAB_WEBHOOK_TOLERANCE_SECONDS = 300;

export function verifyGitHubWebhook(body: string, headers: Headers): boolean {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) throw new Error("GITHUB_WEBHOOK_SECRET is required.");
  const received = headers.get("x-hub-signature-256") ?? "";
  const expected = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  return constantTimeEqual(expected, received);
}

export function verifyGitLabWebhook(
  body: string,
  headers: Headers,
  policy: Pick<RepoPolicy, "allowGitlabSecretTokenFallback">,
): boolean {
  const verification = verifyGitLabWebhookRequest(body, headers);
  return verification === "standard" || (verification === "secret_token" && policy.allowGitlabSecretTokenFallback);
}

export function verifyGitLabWebhookRequest(body: string, headers: Headers): GitLabWebhookVerification {
  const signingToken = process.env.GITLAB_SIGNING_TOKEN;
  const signature = headers.get("webhook-signature");
  const messageId = headers.get("webhook-id");
  const timestamp = headers.get("webhook-timestamp");
  if (signingToken && signature && messageId && timestamp) {
    if (verifyGitLabStandardWebhook(body, signingToken, messageId, timestamp, signature)) {
      return "standard";
    }
  }

  const fallbackToken = process.env.GITLAB_SECRET_TOKEN;
  if (fallbackToken && constantTimeEqual(fallbackToken, headers.get("x-gitlab-token") ?? "")) {
    return "secret_token";
  }
  return "none";
}

export function verifyGitLabStandardWebhook(
  body: string,
  signingToken: string,
  messageId: string,
  timestamp: string,
  receivedSignatures: string,
): boolean {
  if (!/^\d+$/.test(timestamp)) return false;
  const timestampSeconds = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(timestampSeconds)) return false;
  if (Math.abs(Date.now() / 1000 - timestampSeconds) > GITLAB_WEBHOOK_TOLERANCE_SECONDS) return false;
  const rawKey = Buffer.from(signingToken.replace(/^whsec_/, ""), "base64");
  const message = `${messageId}.${timestamp}.${body}`;
  const expected = `v1,${createHmac("sha256", rawKey).update(message).digest("base64")}`;
  return receivedSignatures.split(" ").some((signature) => constantTimeEqual(expected, signature));
}

export function normalizeGitHubEvent(body: unknown, headers: Headers): NormalizedPipelineEvent | null {
  if (!isRecord(body)) return null;
  const eventName = headers.get("x-github-event") ?? "unknown";
  const deliveryId = headers.get("x-github-delivery") ?? randomUUID();
  if (eventName === "workflow_run") return normalizeGitHubWorkflowRun(body, deliveryId, eventName);
  if (eventName === "check_suite") return normalizeGitHubCheckSuite(body, deliveryId, eventName);
  return null;
}

export function normalizeGitLabEvent(body: unknown, headers: Headers): NormalizedPipelineEvent | null {
  if (!isRecord(body)) return null;
  if (body.object_kind !== "pipeline") return null;
  const attrs = isRecord(body.object_attributes) ? body.object_attributes : null;
  const project = isRecord(body.project) ? body.project : null;
  if (!attrs || !project) return null;
  const status = readString(attrs.status) ?? "";
  const projectPath = readString(project.path_with_namespace) ?? readString(project.web_url)?.replace(/^https?:\/\/[^/]+\//, "");
  const sha = readString(attrs.sha);
  const ref = readString(attrs.ref);
  const pipelineId = readNumber(attrs.id)?.toString();
  if (!projectPath || !sha || !ref || !pipelineId) return null;
  const mergeRequest = Array.isArray(body.merge_requests) ? body.merge_requests[0] : undefined;

  return {
    provider: "gitlab",
    id: `gitlab:${projectPath}:${pipelineId}:${sha}`,
    deliveryId:
      headers.get("webhook-id") ??
      headers.get("x-gitlab-event-uuid") ??
      headers.get("x-gitlab-webhook-uuid") ??
      randomUUID(),
    repoSlug: projectPath,
    projectId: readNumber(project.id)?.toString(),
    pipelineId,
    pipelineUrl: readString(attrs.url),
    ref,
    sha,
    source: readString(attrs.source) ?? "unknown",
    status,
    conclusion: status,
    actor: isRecord(body.user) ? readString(body.user.username) : undefined,
    mergeRequestIid: isRecord(mergeRequest) ? readNumber(mergeRequest.iid) : undefined,
    sourceBranch: isRecord(mergeRequest) ? readString(mergeRequest.source_branch) ?? ref : undefined,
    targetBranch: isRecord(mergeRequest) ? readString(mergeRequest.target_branch) : undefined,
    eventName: headers.get("x-gitlab-event") ?? "Pipeline Hook",
    receivedAt: new Date().toISOString(),
  };
}

function normalizeGitHubWorkflowRun(
  body: UnknownRecord,
  deliveryId: string,
  eventName: string,
): NormalizedPipelineEvent | null {
  if (body.action !== "completed") return null;
  const workflowRun = isRecord(body.workflow_run) ? body.workflow_run : null;
  const repository = isRecord(body.repository) ? body.repository : null;
  if (!workflowRun || !repository) return null;
  const conclusion = readString(workflowRun.conclusion) ?? "";
  const repoSlug = readString(repository.full_name);
  const sha = readString(workflowRun.head_sha);
  const ref = readString(workflowRun.head_branch);
  const runId = readNumber(workflowRun.id)?.toString();
  if (!repoSlug || !sha || !ref || !runId) return null;
  const pullRequests = Array.isArray(workflowRun.pull_requests)
    ? workflowRun.pull_requests
    : [];
  const pullRequest = pullRequests.find(isRecord);
  const pullRequestBase = isRecord(pullRequest?.base) ? pullRequest.base : undefined;
  const pullRequestHead = isRecord(pullRequest?.head) ? pullRequest.head : undefined;
  const sourceBranch = readString(pullRequestHead?.ref) ?? ref;
  return {
    provider: "github",
    id: `github:${repoSlug}:${runId}:${sha}`,
    deliveryId,
    repoSlug,
    installationId: isRecord(body.installation) ? readNumber(body.installation.id) : undefined,
    pipelineId: runId,
    pipelineUrl: readString(workflowRun.html_url),
    runId,
    ref,
    sha,
    source: readString(workflowRun.event) ?? "workflow_run",
    status: readString(workflowRun.status) ?? "completed",
    conclusion,
    actor: isRecord(body.sender) ? readString(body.sender.login) : undefined,
    pullRequestNumber: isRecord(pullRequest) ? readNumber(pullRequest.number) : undefined,
    sourceBranch,
    targetBranch: readString(pullRequestBase?.ref),
    eventName,
    receivedAt: new Date().toISOString(),
  };
}

function normalizeGitHubCheckSuite(
  body: UnknownRecord,
  deliveryId: string,
  eventName: string,
): NormalizedPipelineEvent | null {
  if (body.action !== "completed") return null;
  const checkSuite = isRecord(body.check_suite) ? body.check_suite : null;
  const repository = isRecord(body.repository) ? body.repository : null;
  if (!checkSuite || !repository) return null;
  const conclusion = readString(checkSuite.conclusion) ?? "";
  const repoSlug = readString(repository.full_name);
  const sha = readString(checkSuite.head_sha);
  const ref = readString(checkSuite.head_branch);
  const suiteId = readNumber(checkSuite.id)?.toString();
  if (!repoSlug || !sha || !ref || !suiteId) return null;
  const pullRequests = Array.isArray(checkSuite.pull_requests)
    ? checkSuite.pull_requests
    : [];
  const pullRequest = pullRequests.find(isRecord);
  const pullRequestBase = isRecord(pullRequest?.base) ? pullRequest.base : undefined;
  const pullRequestHead = isRecord(pullRequest?.head) ? pullRequest.head : undefined;
  const sourceBranch = readString(pullRequestHead?.ref) ?? ref;
  return {
    provider: "github",
    id: `github:${repoSlug}:${suiteId}:${sha}`,
    deliveryId,
    repoSlug,
    installationId: isRecord(body.installation) ? readNumber(body.installation.id) : undefined,
    pipelineId: suiteId,
    pipelineUrl: readString(checkSuite.url),
    checkSuiteId: suiteId,
    ref,
    sha,
    source: "check_suite",
    status: readString(checkSuite.status) ?? "completed",
    conclusion,
    actor: isRecord(body.sender) ? readString(body.sender.login) : undefined,
    pullRequestNumber: isRecord(pullRequest) ? readNumber(pullRequest.number) : undefined,
    sourceBranch,
    targetBranch: readString(pullRequestBase?.ref),
    eventName,
    receivedAt: new Date().toISOString(),
  };
}

export const FAILURE_STATUSES: ReadonlySet<string> = new Set([
  "failure",
  "failed",
  "timed_out",
  "cancelled",
  "canceled",
  "action_required",
]);

export const SUCCESS_STATUSES: ReadonlySet<string> = new Set(["success", "passed"]);

export function isFailureStatus(value: string): boolean {
  return FAILURE_STATUSES.has(value.toLowerCase());
}

export function isSuccessStatus(value: string): boolean {
  return SUCCESS_STATUSES.has(value.toLowerCase());
}

export function isFailedConclusion(value: string): boolean {
  return isFailureStatus(value);
}

export function isSuccessfulConclusion(value: string): boolean {
  return isSuccessStatus(value);
}

function constantTimeEqual(expected: string, received: string): boolean {
  const left = Buffer.from(expected);
  const right = Buffer.from(received);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

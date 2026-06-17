import { defineChannel, POST, type SendFn } from "eve/channels";

import { findRepoPolicy, loadConfig } from "../lib/config.ts";
import { assertEventAllowedByPolicy } from "../lib/policy.ts";
import { getProviderClient } from "../lib/providers/index.ts";
import {
  countAttemptsForSha,
  eventAttemptKey,
  findActiveRepairAttemptForSha,
  findPendingAutoMergeAttempt,
  markDeliveryProcessed,
  recordAttempt,
  updateAttempt,
} from "../lib/state.ts";
import type { FailureContext, NormalizedPipelineEvent, RepoPolicy } from "../lib/types.ts";
import {
  normalizeGitHubEvent,
  normalizeGitLabEvent,
  isFailedConclusion,
  isSuccessfulConclusion,
  verifyGitHubWebhook,
  verifyGitLabWebhookRequest,
} from "../lib/webhooks.ts";

export default defineChannel({
  routes: [
    POST("/eve/v1/ci/github", async (req, { send, waitUntil }) => {
      const body = await req.text();
      if (!verifyGitHubWebhook(body, req.headers)) {
        return Response.json({ ok: false, error: "invalid_signature" }, { status: 401 });
      }
      const event = normalizeGitHubEvent(parseJson(body), req.headers);
      return dispatchPipelineEvent(event, send, waitUntil);
    }),
    POST("/eve/v1/ci/gitlab", async (req, { send, waitUntil }) => {
      const body = await req.text();
      const verification = verifyGitLabWebhookRequest(body, req.headers);
      if (verification === "none") {
        return Response.json({ ok: false, error: "invalid_signature" }, { status: 401 });
      }
      const payload = parseJson(body);
      const event = normalizeGitLabEvent(payload, req.headers);
      if (event === null) return Response.json({ ok: true, ignored: true });
      const config = loadConfig();
      const policy = findRepoPolicy(config, event.provider, event.repoSlug);
      if (policy === undefined) {
        return Response.json({ ok: true, ignored: true, reason: "repo_not_configured" });
      }
      if (verification === "secret_token" && !policy.allowGitlabSecretTokenFallback) {
        return Response.json({ ok: false, error: "invalid_signature" }, { status: 401 });
      }
      return dispatchPipelineEvent(event, send, waitUntil);
    }),
  ],
});

async function dispatchPipelineEvent(
  event: NormalizedPipelineEvent | null,
  send: SendFn,
  waitUntil: (task: Promise<unknown>) => void,
): Promise<Response> {
  if (event === null) return Response.json({ ok: true, ignored: true });
  const config = loadConfig();
  const policy = findRepoPolicy(config, event.provider, event.repoSlug);
  if (policy === undefined) {
    return Response.json({ ok: true, ignored: true, reason: "repo_not_configured" });
  }

  const deliveryKey = `${event.provider}:${event.deliveryId}`;
  if (!markDeliveryProcessed(config.statePath, deliveryKey, "pending")) {
    return Response.json({ ok: true, ignored: true, reason: "duplicate_delivery" });
  }

  if (isSuccessfulConclusion(event.conclusion)) {
    waitUntil(handleSuccessfulPipeline(event, policy));
    return Response.json({ ok: true, accepted: true, action: "success_followup" });
  }

  if (!isFailedConclusion(event.conclusion)) {
    return Response.json({ ok: true, ignored: true, reason: "non_failure_completion" });
  }

  try {
    assertEventAllowedByPolicy(event, policy);
  } catch (error) {
    return Response.json(
      { ok: true, ignored: true, reason: error instanceof Error ? error.message : String(error) },
      { status: 202 },
    );
  }

  const activeRepair = findActiveRepairAttemptForSha(config.statePath, {
    provider: event.provider,
    repoSlug: event.repoSlug,
    sha: event.sha,
  });
  if (activeRepair !== undefined) {
    return Response.json(
      { ok: true, ignored: true, reason: "repair_already_in_progress", attemptKey: activeRepair.key },
      { status: 202 },
    );
  }

  const attempt = recordAttempt(config.statePath, event);
  const attemptsForSha = countAttemptsForSha(config.statePath, {
    provider: event.provider,
    repoSlug: event.repoSlug,
    sha: event.sha,
  });
  if (attemptsForSha > policy.maxAttemptsPerSha) {
    return Response.json({ ok: true, ignored: true, reason: "max_attempts_exceeded" }, { status: 202 });
  }

  const continuationToken = eventAttemptKey(event);
  waitUntil(startRepairSession({ event, policy, attemptKey: attempt.key, continuationToken, send }));

  return Response.json({ ok: true, accepted: true, attempt: attempt.attempts });
}

async function startRepairSession(input: {
  event: NormalizedPipelineEvent;
  policy: RepoPolicy;
  attemptKey: string;
  continuationToken: string;
  send: SendFn;
}): Promise<void> {
  const config = loadConfig();
  const failureContext = await loadFailureContext(input.event);
  updateAttempt(config.statePath, input.attemptKey, { lastFailureContext: failureContext });
  const session = await input.send(
    {
      message: buildPrompt(input.policy.mode),
      context: buildSeedContext(input.event, input.policy, input.attemptKey, failureContext),
    },
    {
      auth: {
        authenticator: input.event.provider,
        principalId: input.event.actor ?? "pipeline-webhook",
        principalType: "service",
        attributes: {
          provider: input.event.provider,
          repo: input.event.repoSlug,
          pipelineId: input.event.pipelineId,
          attemptKey: input.attemptKey,
        },
      },
      continuationToken: input.continuationToken,
    },
  );
  updateAttempt(config.statePath, input.attemptKey, { lastSessionId: session.id });
}

async function handleSuccessfulPipeline(event: NormalizedPipelineEvent, policy: RepoPolicy): Promise<void> {
  if (policy.mode !== "auto_merge" || !policy.autoMerge.requireSuccessfulPipeline) return;
  const config = loadConfig();
  const attempt = findPendingAutoMergeAttempt(config.statePath, {
    provider: event.provider,
    repoSlug: event.repoSlug,
    branch: event.ref,
    sha: event.sha,
  });
  if (attempt?.changeNumber === undefined || attempt.publishedBranch === undefined) return;
  const result = await getProviderClient(event.provider).mergeChange({
    event,
    changeNumber: attempt.changeNumber,
    branch: attempt.publishedBranch,
    deleteSourceBranch: policy.autoMerge.deleteSourceBranch,
  });
  updateAttempt(config.statePath, attempt.key, {
    lastPublishResult: result,
    pendingAutoMerge: false,
  });
}

async function loadFailureContext(event: NormalizedPipelineEvent): Promise<FailureContext | { error: string }> {
  try {
    return await getProviderClient(event.provider).getFailureContext(event);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function buildPrompt(mode: string): string {
  return [
    "Repair the failed CI pipeline using the seeded event, policy, and failure context.",
    "",
    `Configured publish mode: ${mode}`,
    "",
    "Start by staging the repository snapshot, then inspect source files and make the smallest safe fix.",
  ].join("\n");
}

function buildSeedContext(
  event: NormalizedPipelineEvent,
  policy: RepoPolicy,
  attemptKey: string,
  failureContext: FailureContext | { error: string },
): string[] {
  return [
    toContextBlock("Pipeline fixer state", { attemptKey }),
    toContextBlock("Normalized pipeline event", event),
    toContextBlock("Repository policy", {
      mode: policy.mode,
      allowedBranches: policy.allowedBranches,
      allowedFileGlobs: policy.allowedFileGlobs,
      verificationCommands: policy.verificationCommands,
      sandboxNetworkAllow: policy.sandboxNetworkAllow,
      maxAttemptsPerSha: policy.maxAttemptsPerSha,
      autoMerge: policy.autoMerge,
    }),
    toContextBlock("Initial failure context collected by trusted runtime code", failureContext),
  ];
}

function toContextBlock(title: string, value: unknown): string {
  return [title, "", "```json", JSON.stringify(value, null, 2), "```"].join("\n");
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

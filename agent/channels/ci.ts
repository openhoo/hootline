import { defineChannel, POST, type SendFn } from "eve/channels";

import { loadServiceConfig, parseRepoPolicyConfig, RepoPolicyConfigError } from "../lib/config.ts";
import { createLogger, logError, type Logger } from "../lib/logger.ts";
import { assertEventAllowedByPolicy } from "../lib/policy.ts";
import { getProviderClient } from "../lib/providers/index.ts";
import {
  claimAutoMerge,
  claimRepairSlot,
  eventAttemptKey,
  findPendingAutoMergeAttempt,
  markDeliveryProcessed,
  releaseDelivery,
  restoreAutoMergeClaim,
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

const log = createLogger("channels.ci");

export default defineChannel({
  routes: [
    POST("/eve/v1/ci/github", async (req, { send, waitUntil }) => {
      const body = await req.text();
      if (!verifyGitHubWebhook(body, req.headers)) {
        // Never log the raw signature header or body — only that verification failed.
        log.warn(
          { provider: "github", deliveryId: req.headers.get("x-github-delivery") },
          "github webhook signature verification failed",
        );
        return Response.json({ ok: false, error: "invalid_signature" }, { status: 401 });
      }
      const event = normalizeGitHubEvent(parseJson(body), req.headers);
      return dispatchPipelineEvent(event, send, waitUntil);
    }),
    POST("/eve/v1/ci/gitlab", async (req, { send, waitUntil }) => {
      const body = await req.text();
      const verification = verifyGitLabWebhookRequest(body, req.headers);
      if (verification === "none") {
        log.warn(
          { provider: "gitlab", deliveryId: req.headers.get("x-gitlab-event-uuid") },
          "gitlab webhook signature verification failed",
        );
        return Response.json({ ok: false, error: "invalid_signature" }, { status: 401 });
      }
      const payload = parseJson(body);
      const event = normalizeGitLabEvent(payload, req.headers);
      if (event === null) return Response.json({ ok: true, ignored: true });
      return dispatchPipelineEvent(event, send, waitUntil, verification);
    }),
  ],
});

async function dispatchPipelineEvent(
  event: NormalizedPipelineEvent | null,
  send: SendFn,
  waitUntil: (task: Promise<unknown>) => void,
  gitlabVerification?: "standard" | "secret_token",
): Promise<Response> {
  if (event === null) return Response.json({ ok: true, ignored: true });
  const config = loadServiceConfig();

  const deliveryKey = `${event.provider}:${event.deliveryId}`;
  // Correlate every line for this delivery; attemptKey is added below once a slot is claimed.
  const dlog = log.child({
    provider: event.provider,
    repoSlug: event.repoSlug,
    deliveryKey,
    ref: event.ref,
    sha: event.sha,
    pipelineId: event.pipelineId,
  });
  dlog.debug({ conclusion: event.conclusion }, "pipeline webhook received");

  if (isSuccessfulConclusion(event.conclusion)) {
    if (!markDeliveryProcessed(config.statePath, deliveryKey, "pending")) {
      dlog.debug("delivery ignored: duplicate delivery already processed");
      return Response.json({ ok: true, ignored: true, reason: "duplicate_delivery" });
    }
    dlog.info("successful pipeline: queuing auto-merge followup");
    waitUntil(
      handleSuccessfulPipeline(event, dlog).catch((error: unknown) => {
        logError(dlog, "auto-merge followup failed; pendingAutoMerge restored for retry", error);
      }),
    );
    return Response.json({ ok: true, accepted: true, action: "success_followup" });
  }

  if (!isFailedConclusion(event.conclusion)) {
    dlog.debug({ conclusion: event.conclusion }, "event ignored: non-failure completion");
    return Response.json({ ok: true, ignored: true, reason: "non_failure_completion" });
  }

  const policyResolution = await resolveRepoPolicy(event, dlog);
  if (policyResolution.kind === "missing") {
    dlog.debug("event ignored: repo not configured");
    return Response.json({ ok: true, ignored: true, reason: "repo_not_configured" });
  }
  if (policyResolution.kind === "invalid") {
    dlog.info({ error: policyResolution.error.message }, "event ignored: invalid repository config");
    return Response.json({ ok: true, ignored: true, reason: "invalid_repo_config" }, { status: 202 });
  }
  const policy = policyResolution.policy;

  if (
    event.provider === "gitlab" &&
    gitlabVerification === "secret_token" &&
    !policy.allowGitlabSecretTokenFallback
  ) {
    dlog.warn("gitlab secret-token fallback rejected by policy (allowGitlabSecretTokenFallback=false)");
    return Response.json({ ok: false, error: "invalid_signature" }, { status: 401 });
  }
  if (event.provider === "gitlab" && gitlabVerification === "secret_token") {
    dlog.debug("gitlab webhook accepted via secret-token fallback (weaker than signature)");
  }

  if (!markDeliveryProcessed(config.statePath, deliveryKey, "pending")) {
    dlog.debug("delivery ignored: duplicate delivery already processed");
    return Response.json({ ok: true, ignored: true, reason: "duplicate_delivery" });
  }

  try {
    assertEventAllowedByPolicy(event, policy);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    // Intentionally info (not debug like repo_not_configured/duplicate): this is a
    // configured repo whose failing pipeline we declined to fix, which operators may
    // want to act on (e.g. widen allowedBranches).
    dlog.info({ reason }, "event rejected by repository policy");
    return Response.json({ ok: true, ignored: true, reason }, { status: 202 });
  }

  const claim = await claimRepairSlot(config.statePath, event, policy);
  if (claim.decision === "in_progress") {
    dlog.info(
      { attemptKey: claim.attempt.key },
      "repair slot not claimed: a repair is already in progress",
    );
    return Response.json(
      { ok: true, ignored: true, reason: "repair_already_in_progress", attemptKey: claim.attempt.key },
      { status: 202 },
    );
  }
  if (claim.decision === "max_attempts") {
    dlog.info("repair slot not claimed: max attempts per sha exceeded");
    return Response.json({ ok: true, ignored: true, reason: "max_attempts_exceeded" }, { status: 202 });
  }

  const attempt = claim.attempt;
  const continuationToken = eventAttemptKey(event);
  const alog = dlog.child({ attemptKey: attempt.key });
  alog.info({ attempt: attempt.attempts }, "repair slot claimed: dispatching repair session");
  waitUntil(
    startRepairSession({
      event,
      policy: attempt.policy,
      attemptKey: attempt.key,
      continuationToken,
      deliveryKey,
      send,
    }).catch((error: unknown) => {
      logError(alog, "repair session start failed; delivery released for retry", error);
    }),
  );

  return Response.json({ ok: true, accepted: true, attempt: attempt.attempts });
}

async function startRepairSession(input: {
  event: NormalizedPipelineEvent;
  policy: RepoPolicy;
  attemptKey: string;
  continuationToken: string;
  deliveryKey: string;
  send: SendFn;
}): Promise<void> {
  const config = loadServiceConfig();
  const slog = log.child({
    provider: input.event.provider,
    repoSlug: input.event.repoSlug,
    deliveryKey: input.deliveryKey,
    attemptKey: input.attemptKey,
  });
  try {
    const failureContext = await loadFailureContext(input.event, slog);
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
    slog.info({ sessionId: session.id }, "repair session seeded; model turn started");
  } catch (error) {
    // Clear the dispatch marker so the slot is no longer treated as in progress, then
    // release the delivery so a provider redelivery can retry instead of being dropped
    // as a duplicate_delivery; otherwise the event is black-holed. The error itself is
    // logged once by the dispatch-level catch with full correlation context.
    updateAttempt(config.statePath, input.attemptKey, { dispatchedAt: undefined });
    await releaseDelivery(config.statePath, input.deliveryKey);
    throw error;
  }
}

async function handleSuccessfulPipeline(
  event: NormalizedPipelineEvent,
  parentLog: Logger,
): Promise<void> {
  const config = loadServiceConfig();
  const attempt = findPendingAutoMergeAttempt(config.statePath, {
    provider: event.provider,
    repoSlug: event.repoSlug,
    branch: event.ref,
    sha: event.sha,
  });
  if (attempt?.changeNumber === undefined || attempt.publishedBranch === undefined) {
    parentLog.debug("no pending auto-merge attempt matches this successful pipeline");
    return;
  }
  const policy = attempt.policy;
  if (policy.mode !== "auto_merge" || !policy.autoMerge.requireSuccessfulPipeline) return;
  const changeNumber = attempt.changeNumber;
  const branch = attempt.publishedBranch;
  const mlog = parentLog.child({ attemptKey: attempt.key, changeNumber });
  // Claim the auto-merge before calling the provider so a concurrent success event
  // cannot merge the same change twice; restore the flag if the merge throws.
  if (!(await claimAutoMerge(config.statePath, attempt.key))) {
    mlog.debug("auto-merge already claimed by a concurrent event; skipping");
    return;
  }
  try {
    const result = await getProviderClient(event.provider).mergeChange({
      event,
      changeNumber,
      branch,
      deleteSourceBranch: policy.autoMerge.deleteSourceBranch,
    });
    updateAttempt(config.statePath, attempt.key, {
      lastPublishResult: result,
    });
    mlog.info({ merged: result.merged }, "auto-merge completed");
  } catch (error) {
    // Restore the claim so a later successful pipeline event can retry the merge.
    // The error is logged once by the dispatch-level catch with full correlation context.
    await restoreAutoMergeClaim(config.statePath, attempt.key);
    throw error;
  }
}

async function loadFailureContext(
  event: NormalizedPipelineEvent,
  log: Logger,
): Promise<FailureContext | { error: string }> {
  try {
    return await getProviderClient(event.provider).getFailureContext(event);
  } catch (error) {
    // The provider error is redacted by the logger; surface it so operators see why
    // the model was seeded with an error block instead of failure logs.
    log.warn(
      { err: error instanceof Error ? error : String(error) },
      "failed to collect initial failure context; seeding model with error block",
    );
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
    toContextBlock("Hootline state", { attemptKey }),
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

type RepoPolicyResolution =
  | { kind: "found"; policy: RepoPolicy }
  | { kind: "missing" }
  | { kind: "invalid"; error: Error };

async function resolveRepoPolicy(
  event: NormalizedPipelineEvent,
  parentLog: Logger,
): Promise<RepoPolicyResolution> {
  const config = loadServiceConfig();
  const text = await getProviderClient(event.provider).readRepositoryFileFromDefaultBranch(
    event,
    config.repoConfigPath,
  );
  if (text === null) return { kind: "missing" };
  try {
    return {
      kind: "found",
      policy: parseRepoPolicyConfig(text, { provider: event.provider, slug: event.repoSlug }),
    };
  } catch (error) {
    const normalized =
      error instanceof Error ? error : new RepoPolicyConfigError(String(error));
    parentLog.debug({ error: normalized.message }, "repository config validation failed");
    return { kind: "invalid", error: normalized };
  }
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

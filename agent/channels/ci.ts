import { defineChannel, POST, type SendFn } from "eve/channels";

import { loadServiceConfig, parseRepoPolicyConfig, RepoPolicyConfigError } from "../lib/config.ts";
import { createLogger, logError, type Logger } from "../lib/logger.ts";
import { assertEventAllowedByPolicy } from "../lib/policy.ts";
import { getProviderClient } from "../lib/providers/index.ts";
import {
  observeRepairSession,
  shouldSendRepairContinuation,
  toLocalContinuationToken,
  type RepairSessionObservation,
  type StreamSession,
} from "../lib/session-monitor.ts";
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
const MAX_REPAIR_CONTINUATIONS = 1;

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
  const continuationToken = repairContinuationToken(event, attempt.attempts);
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
    const auth = buildRepairAuth(input.event, input.attemptKey);
    const session = await input.send(
      {
        message: buildPrompt(input.policy.mode),
        context: buildSeedContext(input.event, input.policy, input.attemptKey, failureContext),
      },
      {
        auth,
        continuationToken: input.continuationToken,
      },
    );
    updateAttempt(config.statePath, input.attemptKey, {
      lastSessionId: session.id,
      lastSessionStatus: "running",
    });
    slog.info({ sessionId: session.id }, "repair session seeded; model turn started");
    await monitorRepairLoop({
      auth,
      config,
      deliveryKey: input.deliveryKey,
      initialContinuationToken: input.continuationToken,
      send: input.send,
      session,
      slog,
      attemptKey: input.attemptKey,
    });
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

async function monitorRepairLoop(input: {
  auth: NonNullable<Parameters<SendFn>[1]["auth"]>;
  config: ReturnType<typeof loadServiceConfig>;
  deliveryKey: string;
  initialContinuationToken: string;
  send: SendFn;
  session: StreamSession;
  slog: Logger;
  attemptKey: string;
}): Promise<void> {
  let session = input.session;
  let continuationToken = input.initialContinuationToken;
  let continuationsUsed = 0;

  for (;;) {
    const observation = await observeRepairSession(session);
    recordSessionObservation(input.config.statePath, input.attemptKey, observation, continuationsUsed);
    input.slog.info(
      {
        sessionId: session.id,
        status: observation.status,
        finishReason: observation.finishReason,
        failureKind: observation.failureKind,
        terminalAction: observation.terminalAction,
        toolSequence: observation.toolSequence,
      },
      "repair session reached monitored boundary",
    );

    if (!shouldSendRepairContinuation(observation, continuationsUsed, MAX_REPAIR_CONTINUATIONS)) {
      if (shouldReleaseForRetry(observation)) {
        updateAttempt(input.config.statePath, input.attemptKey, {
          dispatchedAt: undefined,
          lastSessionStatus: observation.status === "failed" ? "failed" : "abandoned",
          lastSessionFailureKind: observation.failureKind ?? "no_terminal_action",
          lastSessionFailure:
            observation.failureMessage ?? "Repair session ended without a terminal Hootline action.",
        });
        await releaseDelivery(input.config.statePath, input.deliveryKey);
        input.slog.info("repair session did not complete; delivery released for provider redelivery retry");
      }
      return;
    }

    continuationsUsed += 1;
    continuationToken = toLocalContinuationToken(session.continuationToken, continuationToken);
    updateAttempt(input.config.statePath, input.attemptKey, {
      continuationsUsed,
      lastSessionStatus: "running",
    });
    input.slog.info(
      { sessionId: session.id, failureKind: observation.failureKind, continuationsUsed },
      "repair session needs one bounded continuation",
    );
    session = await input.send(
      {
        message: buildContinuationPrompt(observation),
        context: [
          toContextBlock("Hootline loop monitor", {
            status: observation.status,
            finishReason: observation.finishReason,
            failureKind: observation.failureKind,
            failureMessage: observation.failureMessage,
            toolSequence: observation.toolSequence,
            requiredNextTools: ["edit_repo_file", "run_repo_checks", "publish_fix"],
          }),
        ],
      },
      {
        auth: input.auth,
        continuationToken,
      },
    );
    updateAttempt(input.config.statePath, input.attemptKey, {
      lastSessionId: session.id,
      lastSessionStatus: "running",
    });
  }
}

function recordSessionObservation(
  statePath: string,
  attemptKey: string,
  observation: RepairSessionObservation,
  continuationsUsed: number,
): void {
  updateAttempt(statePath, attemptKey, {
    lastSessionStatus: observation.status,
    lastSessionFinishReason: observation.finishReason,
    lastSessionFailureKind: observation.failureKind,
    lastSessionFailure: observation.failureMessage,
    lastSessionEndedAt: observation.endedAt,
    lastToolSequence: observation.toolSequence,
    lastFailedTools: observation.failedTools,
    lastTerminalAction: observation.terminalAction,
    lastInputTokens: observation.inputTokens,
    lastOutputTokens: observation.outputTokens,
    lastEventsSeen: observation.eventsSeen,
    continuationsUsed,
  });
}

function shouldReleaseForRetry(observation: RepairSessionObservation): boolean {
  if (observation.terminalAction !== undefined) return false;
  return observation.status === "failed" || observation.status === "waiting" || observation.status === "abandoned";
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

function buildContinuationPrompt(observation: RepairSessionObservation): string {
  if (observation.failureKind === "length") {
    return [
      "Continue the same CI repair from the current repository snapshot.",
      "You stopped because the prior model step hit the output limit before a terminal action completed.",
      "Do not restate the diagnosis. Apply the smallest safe edit with edit_repo_file, run run_repo_checks, then publish_fix if checks pass.",
      "If policy blocks the fix, post_provider_comment with the blocker and evidence.",
    ].join("\n");
  }
  return [
    "Continue the same CI repair from the current repository snapshot.",
    "The prior turn stopped without a terminal Hootline action.",
    "Use the next tool call to move the repair forward: edit_repo_file, run_repo_checks, publish_fix, rerun_pipeline, or post_provider_comment.",
  ].join("\n");
}

function buildRepairAuth(event: NormalizedPipelineEvent, attemptKey: string): NonNullable<Parameters<SendFn>[1]["auth"]> {
  return {
    authenticator: event.provider,
    principalId: event.actor ?? "pipeline-webhook",
    principalType: "service",
    attributes: {
      provider: event.provider,
      repo: event.repoSlug,
      pipelineId: event.pipelineId,
      attemptKey,
    },
  };
}

function repairContinuationToken(event: NormalizedPipelineEvent, attempt: number): string {
  return `${eventAttemptKey(event)}:attempt-${attempt}`;
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

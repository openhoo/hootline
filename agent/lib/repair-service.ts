import type { SendFn } from "eve/channels";

import { loadServiceConfig, parseRepoPolicyConfig, RepoPolicyConfigError } from "./config.ts";
import { createLogger, logError, type Logger } from "./logger.ts";
import { assertEventAllowedByPolicy } from "./policy.ts";
import { getProviderClient } from "./providers/index.ts";
import {
  observeRepairSession,
  shouldSendRepairContinuation,
  toLocalContinuationToken,
  type RepairSessionObservation,
  type StreamSession,
} from "./session-monitor.ts";
import {
  claimAutoMerge,
  claimRepairSlot,
  clearSessionOutcomePatch,
  eventAttemptKey,
  findPendingAutoMergeAttempt,
  markDeliveryProcessed,
  releaseDelivery,
  restoreAutoMergeClaim,
  updateAttempt,
} from "./state.ts";
import { recordTelemetry, type TelemetryIdentity } from "./telemetry.ts";
import type { FailureContext, NormalizedPipelineEvent, RepoPolicy } from "./types.ts";
import { isFailedConclusion, isSuccessfulConclusion } from "./webhooks.ts";

const log = createLogger("lib.repair-service");
const MAX_REPAIR_CONTINUATIONS = 1;
const SUCCESS_FOLLOWUP_LOOKUP_RETRIES = 5;
const SUCCESS_FOLLOWUP_LOOKUP_RETRY_DELAY_MS = 100;

export async function dispatchPipelineEvent(
  event: NormalizedPipelineEvent | null,
  send: SendFn,
  waitUntil: (task: Promise<unknown>) => void,
  gitlabVerification?: "standard" | "secret_token",
): Promise<Response> {
  if (event === null) return Response.json({ ok: true, ignored: true });
  const config = loadServiceConfig();

  const deliveryKey = `${event.provider}:${event.deliveryId}`;
  const dlog = log.child({
    provider: event.provider,
    repoSlug: event.repoSlug,
    deliveryKey,
    ref: event.ref,
    sha: event.sha,
    pipelineId: event.pipelineId,
  });
  dlog.debug({ conclusion: event.conclusion }, "pipeline webhook received");
  recordRepairTelemetry(config, "webhook.received", eventTelemetryIdentity(event, deliveryKey), {
    conclusion: event.conclusion,
    eventName: event.eventName,
    ref: event.ref,
  });

  if (isSuccessfulConclusion(event.conclusion)) {
    if (!markDeliveryProcessed(config.statePath, deliveryKey, "pending")) {
      dlog.debug("delivery ignored: duplicate delivery already processed");
      recordRepairTelemetry(config, "webhook.ignored", eventTelemetryIdentity(event, deliveryKey), {
        reason: "duplicate_delivery",
      });
      return Response.json({ ok: true, ignored: true, reason: "duplicate_delivery" });
    }
    dlog.info("successful pipeline: queuing auto-merge followup");
    recordRepairTelemetry(config, "auto_merge.followup.queued", eventTelemetryIdentity(event, deliveryKey), {});
    waitUntil(
      handleSuccessfulPipeline(event, dlog, deliveryKey, gitlabVerification).catch((error: unknown) => {
        logError(dlog, "auto-merge followup failed; pendingAutoMerge restored for retry", error);
      }),
    );
    return Response.json({ ok: true, accepted: true, action: "success_followup" });
  }

  if (!isFailedConclusion(event.conclusion)) {
    dlog.debug({ conclusion: event.conclusion }, "event ignored: non-failure completion");
    recordRepairTelemetry(config, "webhook.ignored", eventTelemetryIdentity(event, deliveryKey), {
      reason: "non_failure_completion",
      conclusion: event.conclusion,
    });
    return Response.json({ ok: true, ignored: true, reason: "non_failure_completion" });
  }

  const policyResolution = await resolveRepoPolicy(event, dlog);
  if (policyResolution.kind === "missing") {
    dlog.debug("event ignored: repo not configured");
    recordRepairTelemetry(config, "webhook.ignored", eventTelemetryIdentity(event, deliveryKey), {
      reason: "repo_not_configured",
    });
    return Response.json({ ok: true, ignored: true, reason: "repo_not_configured" });
  }
  if (policyResolution.kind === "invalid") {
    dlog.info({ error: policyResolution.error.message }, "event ignored: invalid repository config");
    recordRepairTelemetry(config, "webhook.ignored", eventTelemetryIdentity(event, deliveryKey), {
      reason: "invalid_repo_config",
      error: policyResolution.error.message,
    });
    return Response.json({ ok: true, ignored: true, reason: "invalid_repo_config" }, { status: 202 });
  }
  const policy = policyResolution.policy;

  if (
    event.provider === "gitlab" &&
    gitlabVerification === "secret_token" &&
    !policy.allowGitlabSecretTokenFallback
  ) {
    dlog.warn("gitlab secret-token fallback rejected by policy (allowGitlabSecretTokenFallback=false)");
    recordRepairTelemetry(config, "webhook.rejected", eventTelemetryIdentity(event, deliveryKey), {
      reason: "invalid_signature",
      gitlabVerification,
    });
    return Response.json({ ok: false, error: "invalid_signature" }, { status: 401 });
  }
  if (event.provider === "gitlab" && gitlabVerification === "secret_token") {
    dlog.debug("gitlab webhook accepted via secret-token fallback (weaker than signature)");
  }

  if (!markDeliveryProcessed(config.statePath, deliveryKey, "pending")) {
    dlog.debug("delivery ignored: duplicate delivery already processed");
    recordRepairTelemetry(config, "webhook.ignored", eventTelemetryIdentity(event, deliveryKey), {
      reason: "duplicate_delivery",
    });
    return Response.json({ ok: true, ignored: true, reason: "duplicate_delivery" });
  }

  try {
    assertEventAllowedByPolicy(event, policy);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    dlog.info({ reason }, "event rejected by repository policy");
    recordRepairTelemetry(config, "webhook.rejected", eventTelemetryIdentity(event, deliveryKey), { reason });
    return Response.json({ ok: true, ignored: true, reason }, { status: 202 });
  }

  const claim = await claimRepairSlot(config.statePath, event, policy);
  if (claim.decision === "in_progress") {
    dlog.info(
      { attemptKey: claim.attempt.key },
      "repair slot not claimed: a repair is already in progress",
    );
    recordRepairTelemetry(config, "repair.slot.not_claimed", eventTelemetryIdentity(event, deliveryKey, claim.attempt.key), {
      reason: "repair_already_in_progress",
    });
    return Response.json(
      { ok: true, ignored: true, reason: "repair_already_in_progress", attemptKey: claim.attempt.key },
      { status: 202 },
    );
  }
  if (claim.decision === "max_attempts") {
    dlog.info("repair slot not claimed: max attempts per sha exceeded");
    recordRepairTelemetry(config, "repair.slot.not_claimed", eventTelemetryIdentity(event, deliveryKey), {
      reason: "max_attempts_exceeded",
    });
    return Response.json({ ok: true, ignored: true, reason: "max_attempts_exceeded" }, { status: 202 });
  }

  const attempt = claim.attempt;
  const continuationToken = repairContinuationToken(event, attempt.attempts);
  const alog = dlog.child({ attemptKey: attempt.key });
  alog.info({ attempt: attempt.attempts }, "repair slot claimed: dispatching repair session");
  recordRepairTelemetry(config, "repair.slot.claimed", eventTelemetryIdentity(event, deliveryKey, attempt.key), {
    attempt: attempt.attempts,
    mode: attempt.policy.mode,
  });
  waitUntil(
    startRepairSession({
      event,
      policy: attempt.policy,
      attemptKey: attempt.key,
      repairAttempt: attempt.attempts,
      initialContinuationToken: continuationToken,
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
  repairAttempt: number;
  initialContinuationToken: string;
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
    let providerErrorRetriesUsed = 0;
    let previousFailure: RepairSessionObservation | undefined;
    for (;;) {
      const continuationToken =
        providerErrorRetriesUsed === 0
          ? input.initialContinuationToken
          : repairContinuationToken(input.event, input.repairAttempt, providerErrorRetriesUsed);
      let session: StreamSession;
      try {
        session = await input.send(
          {
            message: buildPrompt(input.policy.mode, providerErrorRetriesUsed),
            context: buildSeedContext(
              input.event,
              input.policy,
              input.attemptKey,
              failureContext,
              previousFailure,
            ),
          },
          {
            auth,
            continuationToken,
          },
        );
      } catch (error) {
        const observation = providerErrorObservationFromError(error);
        if (!shouldRetryProviderError(observation, providerErrorRetriesUsed, config.providerErrorRetries)) {
          updateAttempt(config.statePath, input.attemptKey, {
            lastSessionStatus: "failed",
            lastSessionFailureKind: observation.failureKind,
            lastSessionFailure: observation.failureMessage,
            providerErrorRetriesUsed,
            telemetryPath: config.telemetryPath,
          });
          recordRepairTelemetry(
            config,
            "repair.session.start_failed",
            eventTelemetryIdentity(input.event, input.deliveryKey, input.attemptKey),
            { providerErrorRetriesUsed, failureKind: observation.failureKind },
            error,
          );
          throw error;
        }
        providerErrorRetriesUsed += 1;
        previousFailure = observation;
        await prepareProviderErrorRetry({
          config,
          attemptKey: input.attemptKey,
          observation,
          providerErrorRetriesUsed,
          slog,
        });
        continue;
      }
      updateAttempt(config.statePath, input.attemptKey, {
        ...clearSessionOutcomePatch(),
        lastSessionId: session.id,
        lastSessionStatus: "running",
        providerErrorRetriesUsed,
        telemetryPath: config.telemetryPath,
      });
      recordRepairTelemetry(
        config,
        "repair.session.started",
        {
          ...eventTelemetryIdentity(input.event, input.deliveryKey, input.attemptKey),
          sessionId: session.id,
        },
        {
          providerErrorRetriesUsed,
          continuationTokenKind: providerErrorRetriesUsed === 0 ? "initial" : "provider_error_retry",
        },
      );
      slog.info(
        { sessionId: session.id, providerErrorRetriesUsed },
        "repair session seeded; model turn started",
      );
      const observation = await monitorRepairLoop({
        auth,
        config,
        deliveryKey: input.deliveryKey,
        initialContinuationToken: continuationToken,
        send: input.send,
        session,
        slog,
        attemptKey: input.attemptKey,
      });
      if (!shouldRetryProviderError(observation, providerErrorRetriesUsed, config.providerErrorRetries)) {
        await releaseForExternalRetryIfNeeded({
          config,
          attemptKey: input.attemptKey,
          deliveryKey: input.deliveryKey,
          observation,
          slog,
        });
        return;
      }

      providerErrorRetriesUsed += 1;
      previousFailure = observation;
      await prepareProviderErrorRetry({
        config,
        attemptKey: input.attemptKey,
        observation,
        providerErrorRetriesUsed,
        slog,
      });
    }
  } catch (error) {
    updateAttempt(config.statePath, input.attemptKey, { dispatchedAt: undefined });
    await releaseDelivery(config.statePath, input.deliveryKey);
    throw error;
  }
}

async function prepareProviderErrorRetry(input: {
  config: ReturnType<typeof loadServiceConfig>;
  attemptKey: string;
  observation: RepairSessionObservation;
  providerErrorRetriesUsed: number;
  slog: Logger;
}): Promise<void> {
  const delayMs = providerErrorRetryDelayMs(input.config, input.providerErrorRetriesUsed);
  updateAttempt(input.config.statePath, input.attemptKey, {
    ...clearSessionOutcomePatch(),
    lastSessionId: undefined,
    lastSessionStatus: "running",
    lastSessionFailureKind: input.observation.failureKind,
    lastSessionFailure: formatRetryStatusMessage(input.observation, input.providerErrorRetriesUsed, delayMs),
    lastToolSequence: input.observation.toolSequence,
    lastFailedTools: input.observation.failedTools,
    lastInputTokens: input.observation.inputTokens,
    lastOutputTokens: input.observation.outputTokens,
    lastCacheReadTokens: input.observation.cacheReadTokens,
    lastCacheWriteTokens: input.observation.cacheWriteTokens,
    lastTotalTokens: input.observation.totalTokens,
    lastStepUsage: input.observation.stepUsage,
    lastToolCallCount: input.observation.toolCallCount,
    lastToolErrorCount: input.observation.toolErrorCount,
    lastEventsSeen: input.observation.eventsSeen,
    lastTelemetryRecords: input.observation.eventsSeen,
    telemetryPath: input.config.telemetryPath,
    providerErrorRetriesUsed: input.providerErrorRetriesUsed,
  });
  recordRepairTelemetry(
    input.config,
    "repair.provider_retry.scheduled",
    { attemptKey: input.attemptKey },
    {
      delayMs,
      providerErrorRetriesUsed: input.providerErrorRetriesUsed,
      failureKind: input.observation.failureKind,
      failureMessage: input.observation.failureMessage,
      eventsSeen: input.observation.eventsSeen,
    },
  );
  input.slog.warn(
    {
      failureKind: input.observation.failureKind,
      providerErrorRetriesUsed: input.providerErrorRetriesUsed,
      delayMs,
      maxProviderErrorRetries: input.config.providerErrorRetries,
    },
    "retrying repair session after retryable provider error",
  );
  await sleep(delayMs);
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
}): Promise<RepairSessionObservation> {
  let session = input.session;
  let continuationToken = input.initialContinuationToken;
  let continuationsUsed = 0;

  for (;;) {
    const observation = await observeRepairSession(session);
    recordSessionObservation(input.config, input.attemptKey, observation, continuationsUsed);
    recordRepairTelemetry(
      input.config,
      "repair.session.boundary",
      { attemptKey: input.attemptKey, sessionId: session.id },
      {
        status: observation.status,
        finishReason: observation.finishReason,
        failureKind: observation.failureKind,
        failureMessage: observation.failureMessage,
        terminalAction: observation.terminalAction,
        toolSequence: observation.toolSequence,
        failedTools: observation.failedTools,
        eventsSeen: observation.eventsSeen,
        usage: {
          inputTokens: observation.inputTokens,
          outputTokens: observation.outputTokens,
          cacheReadTokens: observation.cacheReadTokens,
          cacheWriteTokens: observation.cacheWriteTokens,
          totalTokens: observation.totalTokens,
        },
        toolCallCount: observation.toolCallCount,
        toolErrorCount: observation.toolErrorCount,
        continuationsUsed,
      },
    );
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
      return observation;
    }

    continuationsUsed += 1;
    continuationToken = toLocalContinuationToken(session.continuationToken, continuationToken);
    updateAttempt(input.config.statePath, input.attemptKey, {
      ...clearSessionOutcomePatch(),
      continuationsUsed,
      lastSessionStatus: "running",
    });
    input.slog.info(
      { sessionId: session.id, failureKind: observation.failureKind, continuationsUsed },
      "repair session needs one bounded continuation",
    );
    recordRepairTelemetry(
      input.config,
      "repair.session.continuation",
      { attemptKey: input.attemptKey, sessionId: session.id },
      {
        failureKind: observation.failureKind,
        continuationsUsed,
        previousEventsSeen: observation.eventsSeen,
      },
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
      ...clearSessionOutcomePatch(),
      lastSessionId: session.id,
      lastSessionStatus: "running",
      telemetryPath: input.config.telemetryPath,
    });
  }
}

async function releaseForExternalRetryIfNeeded(input: {
  config: ReturnType<typeof loadServiceConfig>;
  attemptKey: string;
  deliveryKey: string;
  observation: RepairSessionObservation;
  slog: Logger;
}): Promise<void> {
  if (!shouldReleaseForRetry(input.observation)) return;
  updateAttempt(input.config.statePath, input.attemptKey, {
    dispatchedAt: undefined,
    lastSessionStatus: input.observation.status === "failed" ? "failed" : "abandoned",
    lastSessionFailureKind: input.observation.failureKind ?? "no_terminal_action",
    lastSessionFailure:
      input.observation.failureMessage ?? "Repair session ended without a terminal Hootline action.",
  });
  await releaseDelivery(input.config.statePath, input.deliveryKey);
  input.slog.info("repair session did not complete; delivery released for provider redelivery retry");
  recordRepairTelemetry(input.config, "repair.delivery.released", { attemptKey: input.attemptKey }, {
    deliveryKey: input.deliveryKey,
    status: input.observation.status,
    failureKind: input.observation.failureKind ?? "no_terminal_action",
  });
}

function recordSessionObservation(
  config: ReturnType<typeof loadServiceConfig>,
  attemptKey: string,
  observation: RepairSessionObservation,
  continuationsUsed: number,
): void {
  updateAttempt(config.statePath, attemptKey, {
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
    lastCacheReadTokens: observation.cacheReadTokens,
    lastCacheWriteTokens: observation.cacheWriteTokens,
    lastTotalTokens: observation.totalTokens,
    lastStepUsage: observation.stepUsage,
    lastToolCallCount: observation.toolCallCount,
    lastToolErrorCount: observation.toolErrorCount,
    lastEventsSeen: observation.eventsSeen,
    lastTelemetryRecords: observation.eventsSeen,
    telemetryPath: config.telemetryPath,
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
  deliveryKey: string,
  gitlabVerification?: "standard" | "secret_token",
): Promise<void> {
  const config = loadServiceConfig();
  const attempt = await findPendingAutoMergeAttemptAfterSettle(config.statePath, {
    provider: event.provider,
    repoSlug: event.repoSlug,
    branch: event.ref,
    sha: event.sha,
  });
  if (attempt?.changeNumber === undefined || attempt.publishedBranch === undefined) {
    parentLog.debug("no pending auto-merge attempt matches this successful pipeline");
    await releaseDelivery(config.statePath, deliveryKey);
    return;
  }
  const policy = attempt.policy;
  if (policy.mode !== "auto_merge" || !policy.autoMerge.requireSuccessfulPipeline) return;
  if (
    event.provider === "gitlab" &&
    gitlabVerification === "secret_token" &&
    !policy.allowGitlabSecretTokenFallback
  ) {
    parentLog.warn(
      { attemptKey: attempt.key },
      "gitlab secret-token fallback rejected by pending auto-merge policy",
    );
    await releaseDelivery(config.statePath, deliveryKey);
    return;
  }
  const changeNumber = attempt.changeNumber;
  const branch = attempt.publishedBranch;
  const mlog = parentLog.child({ attemptKey: attempt.key, changeNumber });
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
      expectedCommitSha: attempt.lastPublishResult?.commitSha,
    });
    updateAttempt(config.statePath, attempt.key, {
      ...clearSessionOutcomePatch(),
      lastPublishResult: result,
      lastSessionStatus: "completed",
      lastTerminalAction: "merged",
      publishedBranch: result.branch,
      changeNumber: result.changeNumber,
      changeUrl: result.changeUrl,
      pendingAutoMerge: false,
    });
    mlog.info({ merged: result.merged }, "auto-merge completed");
    recordRepairTelemetry(config, "auto_merge.completed", eventTelemetryIdentity(event, deliveryKey, attempt.key), {
      merged: result.merged,
      changeNumber: result.changeNumber,
      branch: result.branch,
      changeUrl: result.changeUrl,
    });
  } catch (error) {
    await restoreAutoMergeClaim(config.statePath, attempt.key);
    await releaseDelivery(config.statePath, deliveryKey);
    throw error;
  }
}

async function findPendingAutoMergeAttemptAfterSettle(
  statePath: string,
  input: Parameters<typeof findPendingAutoMergeAttempt>[1],
) {
  for (let attempt = 0; attempt <= SUCCESS_FOLLOWUP_LOOKUP_RETRIES; attempt += 1) {
    const match = findPendingAutoMergeAttempt(statePath, input);
    if (match !== undefined) return match;
    if (attempt < SUCCESS_FOLLOWUP_LOOKUP_RETRIES) {
      await sleep(SUCCESS_FOLLOWUP_LOOKUP_RETRY_DELAY_MS);
    }
  }
  return undefined;
}

async function loadFailureContext(
  event: NormalizedPipelineEvent,
  logger: Logger,
): Promise<FailureContext | { error: string }> {
  try {
    return await getProviderClient(event.provider).getFailureContext(event);
  } catch (error) {
    logger.warn(
      { err: error instanceof Error ? error : String(error) },
      "failed to collect initial failure context; seeding model with error block",
    );
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function buildPrompt(mode: string, providerErrorRetriesUsed = 0): string {
  const lines = [
    "Repair the failed CI pipeline using the seeded event, policy, and failure context.",
    "",
    `Configured publish mode: ${mode}`,
    "",
    "Start by staging the repository snapshot, then inspect source files and make the smallest safe fix.",
  ];
  if (providerErrorRetriesUsed > 0) {
    lines.push(
      "",
      `This is automatic provider-error retry ${providerErrorRetriesUsed}.`,
      "A prior Eve session failed because the model provider API failed before a terminal Hootline action completed.",
      "Do not wait for provider redelivery. Restage the repository, reapply the smallest safe fix, run checks, then call publish_fix if checks pass.",
    );
  }
  return lines.join("\n");
}

function buildContinuationPrompt(observation: RepairSessionObservation): string {
  if (observation.failureKind === "length") {
    return [
      "Continue the same CI repair from the current repository snapshot.",
      "You stopped because the prior model step hit the output limit before a terminal action completed.",
      "Do not restate the diagnosis. Apply the smallest safe edit with edit_repo_file, or replace_repo_lines after reading the current file if exact text matching is not safe. Then run run_repo_checks and publish_fix if checks pass.",
      "If policy blocks the fix, post_provider_comment with the blocker and evidence.",
    ].join("\n");
  }
  return [
    "Continue the same CI repair from the current repository snapshot.",
    "The prior turn stopped without a terminal Hootline action.",
    "Use the next tool call to move the repair forward: edit_repo_file, replace_repo_lines, run_repo_checks, publish_fix, rerun_pipeline, or post_provider_comment.",
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

function repairContinuationToken(
  event: NormalizedPipelineEvent,
  attempt: number,
  providerErrorRetry = 0,
): string {
  const base = `${eventAttemptKey(event)}:attempt-${attempt}`;
  return providerErrorRetry === 0 ? base : `${base}:provider-error-retry-${providerErrorRetry}`;
}

function buildSeedContext(
  event: NormalizedPipelineEvent,
  policy: RepoPolicy,
  attemptKey: string,
  failureContext: FailureContext | { error: string },
  previousFailure?: RepairSessionObservation | undefined,
): string[] {
  const context = [
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
  if (previousFailure !== undefined) {
    context.push(
      toContextBlock("Previous retryable provider failure", {
        status: previousFailure.status,
        finishReason: previousFailure.finishReason,
        failureKind: previousFailure.failureKind,
        failureMessage: previousFailure.failureMessage,
        toolSequence: previousFailure.toolSequence,
        failedTools: previousFailure.failedTools,
        terminalAction: previousFailure.terminalAction,
        eventsSeen: previousFailure.eventsSeen,
      }),
    );
  }
  return context;
}

function shouldRetryProviderError(
  observation: RepairSessionObservation,
  providerErrorRetriesUsed: number,
  maxProviderErrorRetries: number,
): boolean {
  return (
    observation.status === "failed" &&
    observation.failureKind === "provider_error" &&
    observation.terminalAction === undefined &&
    providerErrorRetriesUsed < maxProviderErrorRetries &&
    isRetryableProviderErrorMessage(observation.failureMessage)
  );
}

function providerErrorObservationFromError(error: unknown): RepairSessionObservation {
  return {
    status: "failed",
    failureKind: "provider_error",
    failureMessage: error instanceof Error ? error.message : String(error),
    eventsSeen: 0,
    toolSequence: [],
    failedTools: [],
    stepUsage: [],
    toolCallCount: 0,
    toolErrorCount: 0,
    humanInputRequested: false,
  };
}

function isRetryableProviderErrorMessage(message: string | undefined): boolean {
  if (message === undefined) return true;
  const normalized = message.toLowerCase();
  if (
    /\b(401|403)\b/.test(normalized) ||
    normalized.includes("invalid api key") ||
    normalized.includes("api key is invalid") ||
    normalized.includes("authentication") ||
    normalized.includes("unauthorized") ||
    normalized.includes("permission denied")
  ) {
    return false;
  }
  return (
    normalized.includes("ai_apicallerror") ||
    normalized.includes("ai_retryerror") ||
    normalized.includes("api call") ||
    normalized.includes("rate limit") ||
    normalized.includes("429") ||
    normalized.includes("timeout") ||
    normalized.includes("timed out") ||
    normalized.includes("econnreset") ||
    normalized.includes("etimedout") ||
    normalized.includes("fetch failed") ||
    normalized.includes("network") ||
    normalized.includes("overloaded") ||
    normalized.includes("temporarily unavailable") ||
    normalized.includes("service unavailable") ||
    normalized.includes("internal server error") ||
    /\b5\d\d\b/.test(normalized)
  );
}

function providerErrorRetryDelayMs(
  config: ReturnType<typeof loadServiceConfig>,
  providerErrorRetriesUsed: number,
): number {
  if (config.providerErrorRetryBaseMs === 0) return 0;
  const exponential = config.providerErrorRetryBaseMs * 2 ** Math.max(0, providerErrorRetriesUsed - 1);
  const capped = Math.min(exponential, config.providerErrorRetryMaxMs);
  const jitter = 0.8 + Math.random() * 0.4;
  return Math.min(config.providerErrorRetryMaxMs, Math.max(0, Math.round(capped * jitter)));
}

function formatRetryStatusMessage(
  observation: RepairSessionObservation,
  providerErrorRetriesUsed: number,
  delayMs: number,
): string {
  const message = observation.failureMessage ?? "The model provider API failed.";
  return `Retrying after provider error (${providerErrorRetriesUsed}) in ${delayMs}ms: ${message}`;
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function eventTelemetryIdentity(
  event: NormalizedPipelineEvent,
  deliveryKey: string,
  attemptKey?: string | undefined,
): TelemetryIdentity {
  return {
    attemptKey,
    provider: event.provider,
    repoSlug: event.repoSlug,
    deliveryKey,
    sha: event.sha,
    pipelineId: event.pipelineId,
  };
}

function recordRepairTelemetry(
  config: ReturnType<typeof loadServiceConfig>,
  type: string,
  identity: TelemetryIdentity,
  payload: unknown,
  error?: unknown,
): void {
  recordTelemetry(config, {
    source: "repair-service",
    type,
    identity,
    payload,
    error,
  });
}

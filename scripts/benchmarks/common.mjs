import {
  scenarioExpectedRepairFiles,
  scenarioMutations,
} from "../fixture-scenarios.mjs";

export function buildBenchmarkRow({ inspector, prChecks, repairResult, sample, sampleStartedAt, scenario, workflowRun }) {
  const attempt = repairResult.attempt;
  const publish = attempt?.lastPublishResult;
  return {
    projectId: scenario.projectId,
    projectName: scenario.projectName,
    scenarioId: scenario.id,
    scenarioTitle: scenario.title,
    scenarioComplexity: scenario.complexity,
    scenarioTags: scenario.tags ?? [],
    scenarioMutationCount: scenarioMutations(scenario).length,
    sample,
    status: classifyBenchmarkStatus({ attempt, prChecks, repairResult }),
    startedAt: sampleStartedAt,
    completedAt: new Date().toISOString(),
    expectedRepairFile: scenario.expectedRepairFile,
    expectedRepairFiles: scenarioExpectedRepairFiles(scenario),
    expectedFailure: scenario.expectedFailure,
    failingSha: workflowRun.headSha,
    workflowRunId: workflowRun.databaseId,
    workflowRunUrl: workflowRun.url,
    workflowConclusion: workflowRun.conclusion,
    attemptKey: attempt?.key,
    attemptCount: attempt?.attempts ?? 0,
    sessionId: attempt?.lastSessionId,
    sessionStatus: attempt?.lastSessionStatus,
    sessionFailureKind: attempt?.lastSessionFailureKind,
    sessionFailure: attempt?.lastSessionFailure,
    terminalAction: attempt?.lastTerminalAction,
    toolSequence: attempt?.lastToolSequence ?? [],
    failedTools: attempt?.lastFailedTools ?? [],
    continuationsUsed: attempt?.continuationsUsed ?? 0,
    providerErrorRetriesUsed: attempt?.providerErrorRetriesUsed ?? 0,
    eventsSeen: attempt?.lastEventsSeen,
    inputTokens: attempt?.lastInputTokens,
    outputTokens: attempt?.lastOutputTokens,
    redeliveries: repairResult.redeliveries,
    modelProvider: process.env.HOOTLINE_MODEL_PROVIDER,
    model: process.env.HOOTLINE_MODEL,
    prNumber: attempt?.changeNumber,
    prUrl: attempt?.changeUrl ?? publish?.changeUrl,
    publishedBranch: attempt?.publishedBranch ?? publish?.branch,
    publishedCommitSha: publish?.commitSha,
    prCheckConclusion: prChecks?.conclusion,
    prChecks: prChecks?.checks ?? [],
    finalMessageExcerpt: inspector?.terminal?.finalMessageExcerpt,
  };
}

export function classifyBenchmarkStatus({ attempt, prChecks, repairResult }) {
  if (repairResult.status === "no_webhook_attempt") return "no_webhook_attempt";
  if (attempt === undefined) return "no_attempt";
  if (attempt.lastPublishResult !== undefined || attempt.changeNumber !== undefined) {
    if (prChecks === undefined) return "published";
    if (prChecks.conclusion === "success") return "published_green";
    if (prChecks.conclusion === "failure") return "published_check_failed";
    return "published_check_unknown";
  }
  if (attempt.lastTerminalAction === "rerun_requested") return "rerun_requested";
  if (attempt.lastTerminalAction === "comment_posted") return "comment_posted";
  if (attempt.lastTerminalAction === "merged") return "merged_without_publish_record";
  if (attempt.lastSessionStatus === "failed") return "agent_failed";
  if (attempt.lastSessionStatus === "abandoned") return "agent_abandoned";
  if (attempt.lastSessionStatus === "waiting") return "agent_waiting";
  if (attempt.lastSessionStatus === "completed") return "agent_completed_without_publish";
  return "incomplete";
}

export function findAttemptForSha(state, { repoSlug, sha }) {
  const attempts = Object.values(state?.attempts ?? {}).filter(
    (attempt) => attempt?.repoSlug === repoSlug && attempt?.sha === sha,
  );
  return attempts.sort((left, right) => Date.parse(right.lastSeenAt) - Date.parse(left.lastSeenAt))[0];
}

export function isTerminalRepairAttempt(attempt) {
  if (attempt.lastPublishResult !== undefined || attempt.changeNumber !== undefined) return true;
  return ["failed", "abandoned", "waiting", "completed"].includes(attempt.lastSessionStatus);
}

export function shouldRedeliverRepairAttempt(attempt) {
  if (attempt.provider !== "github") return false;
  if (attempt.lastPublishResult !== undefined || attempt.changeNumber !== undefined) return false;
  return ["failed", "abandoned", "waiting"].includes(attempt.lastSessionStatus);
}

export function summarizeRows(rows) {
  const counts = {};
  const byProject = {};
  const byComplexity = {};
  const byTag = {};
  const byMutationCount = {};
  const failureKinds = {};
  const failedTools = {};
  for (const row of rows) {
    counts[row.status] = (counts[row.status] ?? 0) + 1;
    recordSummaryGroup(byProject, row.projectId ?? "unknown", row);
    recordSummaryGroup(byComplexity, row.scenarioComplexity ?? "unknown", row);
    for (const tag of row.scenarioTags ?? []) {
      recordSummaryGroup(byTag, tag, row);
    }
    recordSummaryGroup(byMutationCount, String(row.scenarioMutationCount ?? 1), row);
    if (row.status !== "published_green" && row.status !== "dry_run" && row.sessionFailureKind !== undefined) {
      failureKinds[row.sessionFailureKind] = (failureKinds[row.sessionFailureKind] ?? 0) + 1;
    }
    for (const tool of row.failedTools ?? []) {
      failedTools[tool] = (failedTools[tool] ?? 0) + 1;
    }
  }
  finalizeSummaryGroups(byProject);
  finalizeSummaryGroups(byComplexity);
  finalizeSummaryGroups(byTag);
  finalizeSummaryGroups(byMutationCount);
  const publishedGreen = rows.filter((row) => row.status === "published_green").length;
  return {
    total: rows.length,
    counts,
    publishedGreen,
    publishedGreenRate: rows.length === 0 ? 0 : publishedGreen / rows.length,
    averageAttempts:
      rows.length === 0
        ? 0
        : rows.reduce((total, row) => total + (row.attemptCount ?? 0), 0) / rows.length,
    averageContinuations:
      rows.length === 0
        ? 0
        : rows.reduce((total, row) => total + (row.continuationsUsed ?? 0), 0) / rows.length,
    averageProviderErrorRetries:
      rows.length === 0
        ? 0
        : rows.reduce((total, row) => total + (row.providerErrorRetriesUsed ?? 0), 0) / rows.length,
    byProject,
    byComplexity,
    byTag,
    byMutationCount,
    failureKinds,
    failedTools,
  };
}

export function summarizeImprovementSignals(rows) {
  const actionableRows = rows.filter((row) => row.status !== "published_green" && row.status !== "dry_run");
  if (actionableRows.length === 0) {
    return ["No non-green benchmark samples were recorded."];
  }

  const signals = [];
  const noPublish = actionableRows.filter((row) => !String(row.status).startsWith("published")).length;
  const checkFailed = actionableRows.filter((row) => row.status === "published_check_failed").length;
  const complexNonGreen = actionableRows.filter((row) => row.scenarioComplexity === "complex").length;
  const noTerminalAction = actionableRows.filter(
    (row) => row.sessionFailureKind === "no_terminal_action" || row.status === "agent_completed_without_publish",
  ).length;
  const toolFailures = countValues(actionableRows.flatMap((row) => row.failedTools ?? []));

  if (noPublish > 0) {
    signals.push(`${noPublish} sample(s) ended without a published fix; inspect final messages and terminal actions first.`);
  }
  if (checkFailed > 0) {
    signals.push(`${checkFailed} published fix sample(s) still had failing PR checks; compare changed files with expected repair files.`);
  }
  if (complexNonGreen > 0) {
    signals.push(`${complexNonGreen} non-green sample(s) were complex scenarios; review multi-file diagnosis and verification coverage.`);
  }
  if (noTerminalAction > 0) {
    signals.push(`${noTerminalAction} sample(s) stopped without a terminal Hootline action; tighten continuation prompts or max continuation policy.`);
  }

  const topFailedTool = Object.entries(toolFailures).sort((left, right) => right[1] - left[1])[0];
  if (topFailedTool !== undefined) {
    signals.push(`Most common failed tool: ${topFailedTool[0]} (${topFailedTool[1]} occurrence(s)).`);
  }

  return signals;
}

function countValues(values) {
  const counts = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

function recordSummaryGroup(groups, key, row) {
  const group = groups[key] ?? { total: 0, publishedGreen: 0, counts: {} };
  group.total += 1;
  group.counts[row.status] = (group.counts[row.status] ?? 0) + 1;
  if (row.status === "published_green") group.publishedGreen += 1;
  groups[key] = group;
}

function finalizeSummaryGroups(groups) {
  for (const group of Object.values(groups)) {
    group.publishedGreenRate = group.total === 0 ? 0 : group.publishedGreen / group.total;
  }
}

#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { createSign } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { resolveScenarios, scenarioIds } from "./fixture-scenarios.mjs";

const DEFAULTS = {
  baselineRef:
    process.env.HOOTLINE_FIXTURE_BASELINE_REF ??
    "hootline-fixture-baseline-v3",
  fixturePath:
    process.env.HOOTLINE_FIXTURE_PATH ??
    "../hootline-pipeline-fixture",
  fixBranchPrefix:
    process.env.HOOTLINE_FIXTURE_FIX_BRANCH_PREFIX ??
    "hootline/fix/",
  mainBranch:
    process.env.HOOTLINE_FIXTURE_MAIN_BRANCH ??
    "main",
  repo:
    process.env.HOOTLINE_FIXTURE_REPO ??
    "openhoo/hootline-pipeline-fixture",
  serverUrl: process.env.HOOTLINE_FIXTURE_SERVER_URL ?? "http://127.0.0.1:3000",
  statePath: process.env.HOOTLINE_STATE_PATH ?? "var/hootline-state.json",
  workflowTimeoutMs: readEnvInteger("HOOTLINE_FIXTURE_WORKFLOW_TIMEOUT_MS", 10 * 60 * 1000),
  repairTimeoutMs: readEnvInteger("HOOTLINE_FIXTURE_REPAIR_TIMEOUT_MS", 20 * 60 * 1000),
  prCheckTimeoutMs: readEnvInteger("HOOTLINE_FIXTURE_PR_CHECK_TIMEOUT_MS", 10 * 60 * 1000),
  pollIntervalMs: readEnvInteger("HOOTLINE_FIXTURE_POLL_INTERVAL_MS", 10 * 1000),
  workflowData: process.env.HOOTLINE_WORKFLOW_DATA ?? ".workflow-data",
};

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    process.exit(0);
  }
  if (!options.yes && !options.dryRun) {
    printHelp();
    fail("Refusing to mutate the fixture repo without --yes. Use --dry-run to preview.");
  }
  main(options).catch((error) => {
    fail(error instanceof Error ? error.message : String(error));
  });
}

export async function main(options) {
  const scenarios = resolveScenarios(options.scenarios);
  const fixturePath = resolve(process.cwd(), options.fixturePath);
  const statePath = resolve(process.cwd(), options.statePath);
  const startedAt = new Date();
  const runId = startedAt.toISOString().replace(/[:.]/g, "-");
  const artifactDir = resolve(process.cwd(), "var", "fixture-benchmarks", runId);

  console.log(`Fixture benchmark: ${runId}`);
  console.log(`Fixture repo: ${options.repo}`);
  console.log(`Fixture path: ${fixturePath}`);
  console.log(`State path: ${statePath}`);
  console.log(`Server URL: ${options.serverUrl}`);
  console.log(`Scenarios: ${scenarios.map((scenario) => scenario.id).join(", ")}`);
  console.log(`Samples per scenario: ${options.samples}`);
  if (options.dryRun) console.log("Mode: dry run");

  if (!options.dryRun) {
    await assertServerReady(options.serverUrl);
    assertGitHubAppInstalled(options.repo);
    mkdirSync(artifactDir, { recursive: true });
  }

  const rows = [];
  for (const scenario of scenarios) {
    for (let sample = 1; sample <= options.samples; sample += 1) {
      const row = await runScenarioSample({
        artifactDir,
        fixturePath,
        options,
        sample,
        scenario,
        statePath,
      });
      rows.push(row);
      if (!options.dryRun) writeArtifacts({ artifactDir, options, rows, scenarios, startedAt });
    }
  }

  if (!options.dryRun) writeArtifacts({ artifactDir, options, rows, scenarios, startedAt });
  printSummary(rows, artifactDir, options.dryRun);
}

async function runScenarioSample({ artifactDir, fixturePath, options, sample, scenario, statePath }) {
  const sampleStartedAt = new Date().toISOString();
  console.log("");
  console.log(`== ${scenario.id} sample ${sample}/${options.samples} ==`);

  const resetArgs = [
    "scripts/reset-pipeline-fixture.mjs",
    options.dryRun ? "--dry-run" : "--yes",
    "--scenario",
    scenario.id,
    "--baseline-ref",
    options.baselineRef,
    "--fixture-path",
    options.fixturePath,
    "--fix-branch-prefix",
    options.fixBranchPrefix,
    "--main-branch",
    options.mainBranch,
    "--repo",
    options.repo,
  ];
  runNode(resetArgs, { dryRun: false });

  if (options.dryRun) {
    return {
      scenarioId: scenario.id,
      sample,
      status: "dry_run",
      startedAt: sampleStartedAt,
      completedAt: new Date().toISOString(),
    };
  }

  const failingSha = readGit(["rev-parse", "HEAD"], fixturePath).trim();
  const workflowRun = await waitForWorkflowRun({
    conclusion: "failure",
    options,
    sha: failingSha,
  });
  const repairResult = await waitForRepairResult({
    options,
    scenario,
    sha: failingSha,
    statePath,
  });
  const prChecks =
    repairResult.attempt?.changeNumber === undefined
      ? undefined
      : await waitForPullRequestChecks({
          changeNumber: repairResult.attempt.changeNumber,
          options,
        });
  const inspector =
    options.includeMessages && repairResult.attempt?.lastSessionId !== undefined
      ? readInspectorReport({
          attemptKey: repairResult.attempt.key,
          options,
          sessionId: repairResult.attempt.lastSessionId,
          statePath,
        })
      : undefined;

  const row = buildBenchmarkRow({
    inspector,
    prChecks,
    repairResult,
    sample,
    sampleStartedAt,
    scenario,
    workflowRun,
  });
  writeFileSync(
    resolve(artifactDir, `${scenario.id}-${sample}.json`),
    `${JSON.stringify(row, null, 2)}\n`,
  );
  return row;
}

export function buildBenchmarkRow({ inspector, prChecks, repairResult, sample, sampleStartedAt, scenario, workflowRun }) {
  const attempt = repairResult.attempt;
  const publish = attempt?.lastPublishResult;
  return {
    scenarioId: scenario.id,
    scenarioTitle: scenario.title,
    sample,
    status: classifyBenchmarkStatus({ attempt, prChecks, repairResult }),
    startedAt: sampleStartedAt,
    completedAt: new Date().toISOString(),
    expectedRepairFile: scenario.expectedRepairFile,
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
  if (attempt.lastSessionStatus === "failed") return "agent_failed";
  if (attempt.lastSessionStatus === "abandoned") return "agent_abandoned";
  if (attempt.lastSessionStatus === "waiting") return "agent_waiting";
  return "incomplete";
}

async function waitForRepairResult({ options, scenario, sha, statePath }) {
  const startedAt = Date.now();
  let redeliveries = 0;
  let lastAttempt;

  for (;;) {
    const attempt = await waitForTerminalAttempt({
      options,
      sha,
      statePath,
      startMs: startedAt,
    });
    if (attempt === undefined) {
      return { status: "no_webhook_attempt", redeliveries };
    }
    lastAttempt = attempt;
    if (attempt.lastPublishResult !== undefined || attempt.changeNumber !== undefined) {
      return { status: "published", attempt, redeliveries };
    }
    if (!shouldRedeliverAttempt(attempt) || redeliveries + attempt.attempts >= attempt.policy.maxAttemptsPerSha) {
      return { status: "terminal_without_publish", attempt, redeliveries };
    }
    await redeliverGitHubWebhook(attempt.event.deliveryId);
    redeliveries += 1;
    console.log(
      `Redelivered webhook for ${scenario.id}; waiting for attempt ${attempt.attempts + 1}.`,
    );
    await sleep(options.pollIntervalMs);
  }

  return { status: "terminal_without_publish", attempt: lastAttempt, redeliveries };
}

async function waitForTerminalAttempt({ options, sha, statePath, startMs }) {
  const deadline = Date.now() + options.repairTimeoutMs;
  while (Date.now() <= deadline) {
    const attempt = findAttemptForSha(readState(statePath), {
      repoSlug: options.repo,
      sha,
    });
    if (attempt !== undefined && isTerminalEnough(attempt)) return attempt;
    await sleep(options.pollIntervalMs);
  }
  const attempt = findAttemptForSha(readState(statePath), { repoSlug: options.repo, sha });
  if (attempt !== undefined) return attempt;
  if (Date.now() - startMs >= options.repairTimeoutMs) return undefined;
  return undefined;
}

export function findAttemptForSha(state, { repoSlug, sha }) {
  const attempts = Object.values(state?.attempts ?? {}).filter(
    (attempt) => attempt?.repoSlug === repoSlug && attempt?.sha === sha,
  );
  return attempts.sort((left, right) => Date.parse(right.lastSeenAt) - Date.parse(left.lastSeenAt))[0];
}

function isTerminalEnough(attempt) {
  if (attempt.lastPublishResult !== undefined || attempt.changeNumber !== undefined) return true;
  return ["failed", "abandoned", "waiting", "completed"].includes(attempt.lastSessionStatus);
}

function shouldRedeliverAttempt(attempt) {
  if (attempt.provider !== "github") return false;
  if (attempt.lastPublishResult !== undefined || attempt.changeNumber !== undefined) return false;
  return ["failed", "abandoned", "waiting"].includes(attempt.lastSessionStatus);
}

async function waitForWorkflowRun({ conclusion, options, sha }) {
  const deadline = Date.now() + options.workflowTimeoutMs;
  while (Date.now() <= deadline) {
    const runs = ghJson([
      "run",
      "list",
      "--repo",
      options.repo,
      "--commit",
      sha,
      "--branch",
      options.mainBranch,
      "--limit",
      "20",
      "--json",
      "databaseId,status,conclusion,headSha,displayTitle,url,name,createdAt",
    ]);
    const run = runs.find((candidate) => candidate.headSha === sha);
    if (run?.status === "completed") {
      if (run.conclusion !== conclusion) {
        throw new Error(
          `Workflow for ${sha.slice(0, 12)} completed with ${run.conclusion}; expected ${conclusion}.`,
        );
      }
      console.log(`Workflow failed as expected: ${run.url}`);
      return run;
    }
    await sleep(options.pollIntervalMs);
  }
  throw new Error(`Timed out waiting for GitHub Actions failure for ${sha}.`);
}

async function waitForPullRequestChecks({ changeNumber, options }) {
  const deadline = Date.now() + options.prCheckTimeoutMs;
  while (Date.now() <= deadline) {
    const view = ghJson([
      "pr",
      "view",
      String(changeNumber),
      "--repo",
      options.repo,
      "--json",
      "number,state,headRefName,headRefOid,statusCheckRollup,url,title",
    ]);
    const summary = summarizeStatusCheckRollup(view.statusCheckRollup ?? []);
    if (summary.conclusion !== "pending") return summary;
    await sleep(options.pollIntervalMs);
  }
  const view = ghJson([
    "pr",
    "view",
    String(changeNumber),
    "--repo",
    options.repo,
    "--json",
    "statusCheckRollup",
  ]);
  return summarizeStatusCheckRollup(view.statusCheckRollup ?? []);
}

export function summarizeStatusCheckRollup(rollup) {
  const checks = rollup.map((check) => ({
    name: check.name,
    status: check.status ?? check.state,
    conclusion: check.conclusion ?? check.state,
    url: check.detailsUrl ?? check.targetUrl,
  }));
  if (checks.length === 0) return { conclusion: "pending", checks };
  if (
    checks.some((check) =>
      ["FAILURE", "ERROR", "TIMED_OUT", "ACTION_REQUIRED", "CANCELLED", "failure", "error"].includes(
        String(check.conclusion),
      ),
    )
  ) {
    return { conclusion: "failure", checks };
  }
  if (
    checks.every(
      (check) =>
        ["COMPLETED", "SUCCESS", "success", "SUCCESSFUL"].includes(String(check.status)) ||
        ["SUCCESS", "success"].includes(String(check.conclusion)),
    )
  ) {
    return { conclusion: "success", checks };
  }
  return { conclusion: "pending", checks };
}

async function redeliverGitHubWebhook(deliveryId) {
  const appId = readRequiredEnv("GITHUB_APP_ID");
  const privateKey = readRequiredEnv("GITHUB_APP_PRIVATE_KEY").replace(/\\n/g, "\n");
  const response = await fetch(
    `https://api.github.com/app/hook/deliveries/${encodeURIComponent(deliveryId)}/attempts`,
    {
      method: "POST",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${createGitHubJwt(appId, privateKey)}`,
        "x-github-api-version": "2022-11-28",
      },
    },
  );
  if (response.status !== 202) {
    const body = await response.text();
    throw new Error(`GitHub webhook redelivery failed: HTTP ${response.status} ${body}`);
  }
}

async function assertServerReady(serverUrl) {
  const response = await fetch(`${serverUrl.replace(/\/+$/, "")}/eve/v1/info`);
  if (!response.ok) {
    throw new Error(`Hootline server is not ready: GET /eve/v1/info returned HTTP ${response.status}.`);
  }
}

function assertGitHubAppInstalled(repo) {
  runNode(["scripts/github-app-check-installation.mjs", repo], { dryRun: false });
}

function writeArtifacts({ artifactDir, options, rows, scenarios, startedAt }) {
  mkdirSync(artifactDir, { recursive: true });
  const report = {
    startedAt: startedAt.toISOString(),
    completedAt: new Date().toISOString(),
    repo: options.repo,
    baselineRef: options.baselineRef,
    scenarios: scenarios.map((scenario) => scenario.id),
    samples: options.samples,
    rows,
    summary: summarizeRows(rows),
  };
  writeFileSync(resolve(artifactDir, "results.json"), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(
    resolve(artifactDir, "results.jsonl"),
    `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
  );
  writeFileSync(resolve(artifactDir, "summary.md"), renderMarkdownSummary(report));
}

function readInspectorReport({ attemptKey, options, sessionId, statePath }) {
  const result = spawnNode([
    "scripts/inspect-eve-session.mjs",
    sessionId,
    "--workflow-data",
    options.workflowData,
    "--state",
    statePath,
    "--attempt-key",
    attemptKey,
    "--json",
  ]);
  if (result.status !== 0) return undefined;
  try {
    return JSON.parse(result.stdout);
  } catch {
    return undefined;
  }
}

export function summarizeRows(rows) {
  const counts = {};
  for (const row of rows) counts[row.status] = (counts[row.status] ?? 0) + 1;
  return {
    total: rows.length,
    counts,
    publishedGreen: rows.filter((row) => row.status === "published_green").length,
    averageAttempts:
      rows.length === 0
        ? 0
        : rows.reduce((total, row) => total + (row.attemptCount ?? 0), 0) / rows.length,
    averageContinuations:
      rows.length === 0
        ? 0
        : rows.reduce((total, row) => total + (row.continuationsUsed ?? 0), 0) / rows.length,
  };
}

function renderMarkdownSummary(report) {
  const lines = [
    "# Fixture Benchmark",
    "",
    `Started: ${report.startedAt}`,
    `Completed: ${report.completedAt}`,
    `Repo: ${report.repo}`,
    `Baseline: ${report.baselineRef}`,
    "",
    "## Summary",
    "",
    `Total samples: ${report.summary.total}`,
    `Published green: ${report.summary.publishedGreen}`,
    `Average attempts: ${report.summary.averageAttempts.toFixed(2)}`,
    `Average continuations: ${report.summary.averageContinuations.toFixed(2)}`,
    "",
    "## Samples",
    "",
    "| Scenario | Sample | Status | Attempts | Continuations | PR | Session |",
    "| --- | ---: | --- | ---: | ---: | --- | --- |",
  ];
  for (const row of report.rows) {
    lines.push(
      `| ${row.scenarioId} | ${row.sample} | ${row.status} | ${row.attemptCount ?? 0} | ${
        row.continuationsUsed ?? 0
      } | ${row.prUrl ?? ""} | ${row.sessionId ?? ""} |`,
    );
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function printSummary(rows, artifactDir, dryRun) {
  const summary = summarizeRows(rows);
  console.log("");
  console.log("Benchmark summary:");
  console.log(`- total samples: ${summary.total}`);
  for (const [status, count] of Object.entries(summary.counts)) {
    console.log(`- ${status}: ${count}`);
  }
  if (!dryRun) console.log(`Artifacts: ${artifactDir}`);
}

function readState(path) {
  if (!existsSync(path)) return { processedDeliveries: {}, attempts: {} };
  return JSON.parse(readFileSync(path, "utf8"));
}

function ghJson(args) {
  return JSON.parse(execFileSync("gh", args, { encoding: "utf8" }));
}

function runNode(args, { dryRun }) {
  console.log(`$ node ${args.map(shellQuote).join(" ")}`);
  if (dryRun) return "";
  execFileSync(process.execPath, args, {
    cwd: dirname(fileURLToPath(import.meta.url)) + "/..",
    encoding: "utf8",
    stdio: "inherit",
  });
}

function spawnNode(args) {
  return spawnSync(process.execPath, args, {
    cwd: dirname(fileURLToPath(import.meta.url)) + "/..",
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function readGit(args, fixturePath) {
  return execFileSync("git", args, {
    cwd: fixturePath,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function createGitHubJwt(issuer, privateKeyPem) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ iat: now - 60, exp: now + 600, iss: issuer })).toString(
    "base64url",
  );
  const unsigned = `${header}.${payload}`;
  const signature = createSign("RSA-SHA256").update(unsigned).sign(privateKeyPem, "base64url");
  return `${unsigned}.${signature}`;
}

function readRequiredEnv(name) {
  const value = process.env[name]?.trim();
  if (value === undefined || value === "") throw new Error(`${name} is required.`);
  return value;
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function parseArgs(argv) {
  const parsed = {
    ...DEFAULTS,
    dryRun: false,
    help: false,
    includeMessages: false,
    samples: 1,
    scenarios: "all",
    yes: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") {
      parsed.dryRun = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }
    if (arg === "--include-messages") {
      parsed.includeMessages = true;
      continue;
    }
    if (arg === "--yes" || arg === "-y") {
      parsed.yes = true;
      continue;
    }

    const [name, inlineValue] = arg.split("=", 2);
    const value = inlineValue ?? argv[++index];
    if (value === undefined) fail(`Missing value for ${arg}`);

    switch (name) {
      case "--baseline-ref":
        parsed.baselineRef = value;
        break;
      case "--fixture-path":
        parsed.fixturePath = value;
        break;
      case "--fix-branch-prefix":
        parsed.fixBranchPrefix = value;
        break;
      case "--main-branch":
        parsed.mainBranch = value;
        break;
      case "--repo":
        parsed.repo = value;
        break;
      case "--scenarios":
        parsed.scenarios = value;
        break;
      case "--samples":
        parsed.samples = readInteger(value, name);
        break;
      case "--server-url":
        parsed.serverUrl = value;
        break;
      case "--state-path":
        parsed.statePath = value;
        break;
      case "--workflow-data":
        parsed.workflowData = value;
        break;
      case "--workflow-timeout-ms":
        parsed.workflowTimeoutMs = readInteger(value, name);
        break;
      case "--repair-timeout-ms":
        parsed.repairTimeoutMs = readInteger(value, name);
        break;
      case "--pr-check-timeout-ms":
        parsed.prCheckTimeoutMs = readInteger(value, name);
        break;
      case "--poll-interval-ms":
        parsed.pollIntervalMs = readInteger(value, name);
        break;
      default:
        fail(`Unknown argument: ${arg}`);
    }
  }

  return parsed;
}

function readEnvInteger(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") return fallback;
  return readInteger(value, name);
}

function readInteger(value, label) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${label} must be a positive integer.`);
  return parsed;
}

function shellQuote(value) {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function printHelp() {
  console.log(`Run live Hootline fixture benchmark scenarios.

Usage:
  npm run fixture:benchmark -- --dry-run
  npm run fixture:benchmark -- --scenarios all --samples 1 --state-path var/fixture-state.json --yes

Options:
  --baseline-ref <ref>          Fixed passing baseline commit/tag.
  --fixture-path <path>         Local fixture checkout path.
  --fix-branch-prefix <pfx>     Remote fixer branch prefix to delete.
  --main-branch <branch>        Fixture default branch.
  --repo <owner/name>           GitHub fixture repository.
  --scenarios <ids|all>         Comma-separated scenario ids, or all. Default: all.
  --samples <n>                 Samples per scenario. Default: 1.
  --server-url <url>            Local Hootline server URL. Default: ${DEFAULTS.serverUrl}.
  --state-path <path>           Hootline state path used by the running server.
  --workflow-data <path>        Local Eve workflow data directory for --include-messages.
  --workflow-timeout-ms <n>     Timeout waiting for scenario CI failure.
  --repair-timeout-ms <n>       Timeout waiting for Hootline repair result.
  --pr-check-timeout-ms <n>     Timeout waiting for fixer PR checks.
  --poll-interval-ms <n>        Poll interval.
  --include-messages            Include redacted final assistant message excerpts.
  --dry-run                     Print the benchmark plan without live writes.
  --yes, -y                     Actually reset/push fixture scenarios.

Available scenarios:
  ${scenarioIds().join("\n  ")}
`);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

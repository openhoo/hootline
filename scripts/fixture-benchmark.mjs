#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { createSign } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  resolveScenarios,
  scenarioExpectedRepairFiles,
  scenarioIds,
  scenarioMutations,
} from "./fixture-scenarios.mjs";
import {
  buildBenchmarkRow,
  findAttemptForSha,
  isTerminalRepairAttempt,
  shouldRedeliverRepairAttempt,
  summarizeImprovementSignals,
  summarizeRows,
} from "./benchmarks/common.mjs";

export {
  buildBenchmarkRow,
  classifyBenchmarkStatus,
  findAttemptForSha,
  summarizeImprovementSignals,
  summarizeRows,
} from "./benchmarks/common.mjs";

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
      scenarioTitle: scenario.title,
      scenarioComplexity: scenario.complexity,
      scenarioTags: scenario.tags ?? [],
      scenarioMutationCount: scenarioMutations(scenario).length,
      sample,
      status: "dry_run",
      startedAt: sampleStartedAt,
      completedAt: new Date().toISOString(),
      expectedRepairFile: scenario.expectedRepairFile,
      expectedRepairFiles: scenarioExpectedRepairFiles(scenario),
      expectedFailure: scenario.expectedFailure,
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
    if (!shouldRedeliverRepairAttempt(attempt) || redeliveries + attempt.attempts >= attempt.policy.maxAttemptsPerSha) {
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
    if (attempt !== undefined && isTerminalRepairAttempt(attempt)) return attempt;
    await sleep(options.pollIntervalMs);
  }
  const attempt = findAttemptForSha(readState(statePath), { repoSlug: options.repo, sha });
  if (attempt !== undefined) return attempt;
  if (Date.now() - startMs >= options.repairTimeoutMs) return undefined;
  return undefined;
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
  const headers = {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${createGitHubJwt(appId, privateKey)}`,
    "x-github-api-version": "2022-11-28",
  };
  const redeliveryId = await resolveGitHubDeliveryDatabaseId(deliveryId, headers);
  const response = await fetch(
    `https://api.github.com/app/hook/deliveries/${encodeURIComponent(redeliveryId)}/attempts`,
    {
      method: "POST",
      headers,
    },
  );
  if (response.status !== 202) {
    const body = await response.text();
    throw new Error(`GitHub webhook redelivery failed: HTTP ${response.status} ${body}`);
  }
}

async function resolveGitHubDeliveryDatabaseId(deliveryId, headers) {
  if (/^\d+$/.test(deliveryId)) return deliveryId;

  let nextUrl = "https://api.github.com/app/hook/deliveries?per_page=100";
  for (let page = 1; page <= 5 && nextUrl !== undefined; page += 1) {
    const response = await fetch(nextUrl, { headers });
    const body = await response.text();
    if (!response.ok) {
      throw new Error(`GitHub webhook delivery lookup failed: HTTP ${response.status} ${body}`);
    }
    const resolved = extractGitHubDeliveryDatabaseId(body, deliveryId);
    if (resolved !== undefined) return resolved;
    nextUrl = parseNextLink(response.headers.get("link"));
  }

  throw new Error(`GitHub webhook delivery ${deliveryId} was not found in recent App deliveries.`);
}

export function extractGitHubDeliveryDatabaseId(deliveriesJson, deliveryGuid) {
  const safeJson = deliveriesJson.replace(/"id"\s*:\s*(\d{15,})/g, '"id":"$1"');
  let deliveries;
  try {
    deliveries = JSON.parse(safeJson);
  } catch {
    return undefined;
  }
  if (!Array.isArray(deliveries)) return undefined;
  for (const delivery of deliveries) {
    if (!isRecord(delivery) || delivery.guid !== deliveryGuid) continue;
    if (typeof delivery.id === "string") return delivery.id;
    if (Number.isSafeInteger(delivery.id)) return String(delivery.id);
  }
  return undefined;
}

function parseNextLink(linkHeader) {
  if (linkHeader === null || linkHeader.trim() === "") return undefined;
  for (const part of linkHeader.split(",")) {
    const match = part.match(/^\s*<([^>]+)>;\s*rel="([^"]+)"\s*$/);
    if (match?.[2] === "next") return match[1];
  }
  return undefined;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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
  report.improvementSignals = summarizeImprovementSignals(rows);
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
    `Published green rate: ${(report.summary.publishedGreenRate * 100).toFixed(1)}%`,
    `Average attempts: ${report.summary.averageAttempts.toFixed(2)}`,
    `Average continuations: ${report.summary.averageContinuations.toFixed(2)}`,
    `Average provider-error retries: ${report.summary.averageProviderErrorRetries.toFixed(2)}`,
    "",
    "## By Complexity",
    "",
    "| Complexity | Samples | Published Green | Green Rate |",
    "| --- | ---: | ---: | ---: |",
    ...Object.entries(report.summary.byComplexity).map(
      ([complexity, group]) =>
        `| ${markdownCell(complexity)} | ${group.total} | ${group.publishedGreen} | ${(
          group.publishedGreenRate * 100
        ).toFixed(1)}% |`,
    ),
    "",
    "## By Tag",
    "",
    "| Tag | Samples | Published Green | Green Rate | Status Counts |",
    "| --- | ---: | ---: | ---: | --- |",
    ...Object.entries(report.summary.byTag)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(
        ([tag, group]) =>
          `| ${markdownCell(tag)} | ${group.total} | ${group.publishedGreen} | ${(
            group.publishedGreenRate * 100
          ).toFixed(1)}% | ${markdownCell(formatCounts(group.counts))} |`,
      ),
    "",
    "## By Mutation Count",
    "",
    "| Mutations | Samples | Published Green | Green Rate | Status Counts |",
    "| ---: | ---: | ---: | ---: | --- |",
    ...Object.entries(report.summary.byMutationCount)
      .sort(([left], [right]) => Number(left) - Number(right))
      .map(
        ([mutationCount, group]) =>
          `| ${mutationCount} | ${group.total} | ${group.publishedGreen} | ${(
            group.publishedGreenRate * 100
          ).toFixed(1)}% | ${markdownCell(formatCounts(group.counts))} |`,
      ),
    "",
    "## Areas To Improve",
    "",
    ...report.improvementSignals.map((signal) => `- ${signal}`),
    "",
    "## Samples",
    "",
    "| Scenario | Complexity | Mutations | Expected Files | Sample | Status | Checks | Attempts | Continuations | Provider Retries | Failed Tools | PR | Session |",
    "| --- | --- | ---: | --- | ---: | --- | --- | ---: | ---: | ---: | --- | --- | --- |",
  ];
  for (const row of report.rows) {
    lines.push(
      `| ${markdownCell(row.scenarioId)} | ${markdownCell(row.scenarioComplexity ?? "")} | ${
        row.scenarioMutationCount ?? 1
      } | ${markdownCell((row.expectedRepairFiles ?? []).join(", "))} | ${row.sample} | ${markdownCell(
        row.status,
      )} | ${markdownCell(row.prCheckConclusion ?? "")} | ${row.attemptCount ?? 0} | ${
        row.continuationsUsed ?? 0
      } | ${row.providerErrorRetriesUsed ?? 0} | ${markdownCell((row.failedTools ?? []).join(", "))} | ${markdownCell(row.prUrl ?? "")} | ${markdownCell(
        row.sessionId ?? "",
      )} |`,
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
  console.log(`- published green rate: ${(summary.publishedGreenRate * 100).toFixed(1)}%`);
  console.log(`- average provider-error retries: ${summary.averageProviderErrorRetries.toFixed(2)}`);
  for (const [complexity, group] of Object.entries(summary.byComplexity)) {
    console.log(`- ${complexity}: ${group.publishedGreen}/${group.total} published green`);
  }
  for (const [tag, group] of Object.entries(summary.byTag).sort(([left], [right]) => left.localeCompare(right))) {
    console.log(`- tag ${tag}: ${group.publishedGreen}/${group.total} published green`);
  }
  for (const [mutationCount, group] of Object.entries(summary.byMutationCount).sort(
    ([left], [right]) => Number(left) - Number(right),
  )) {
    console.log(`- ${mutationCount} mutation(s): ${group.publishedGreen}/${group.total} published green`);
  }
  for (const signal of summarizeImprovementSignals(rows)) {
    console.log(`- signal: ${signal}`);
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

function markdownCell(value) {
  return String(value).replace(/\r?\n/g, " ").replaceAll("|", "\\|");
}

function formatCounts(counts) {
  return Object.entries(counts)
    .map(([status, count]) => `${status}: ${count}`)
    .join(", ");
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

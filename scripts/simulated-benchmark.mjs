#!/usr/bin/env node
import { createHash, createHmac, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  cpSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { dirname, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import {
  applyScenarioMutation,
  assertScenarioBaseline,
  resolveScenarios,
  scenarioExpectedRepairFiles,
  scenarioMutations,
  scenarioSourcePaths,
  scenarioIds,
} from "./fixture-scenarios.mjs";
import {
  buildBenchmarkRow,
  findAttemptForSha,
  summarizeImprovementSignals,
  summarizeRows,
} from "./fixture-benchmark.mjs";

const DEFAULTS = {
  fixtureTemplatePath:
    process.env.HOOTLINE_SIMULATED_FIXTURE_TEMPLATE_PATH ??
    "benchmarks/fixtures/pipeline-repo",
  mainBranch: process.env.HOOTLINE_SIMULATED_MAIN_BRANCH ?? "main",
  pollIntervalMs: readEnvInteger("HOOTLINE_SIMULATED_POLL_INTERVAL_MS", 2_000),
  repairTimeoutMs: readEnvInteger("HOOTLINE_SIMULATED_REPAIR_TIMEOUT_MS", 20 * 60 * 1000),
  repo:
    process.env.HOOTLINE_SIMULATED_REPO ??
    "openhoo/hootline-simulated-pipeline-fixture",
  samples: readEnvInteger("HOOTLINE_SIMULATED_SAMPLES", 1),
  scenarios: process.env.HOOTLINE_SIMULATED_SCENARIOS ?? "all",
  serverUrl: process.env.HOOTLINE_SIMULATED_SERVER_URL,
  webhookSecret:
    process.env.GITHUB_WEBHOOK_SECRET ??
    process.env.HOOTLINE_SIMULATED_WEBHOOK_SECRET ??
    "hootline-simulated-webhook-secret",
};

const APP_WORKSPACE_PATHS = [
  "agent",
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "instrumentation.ts",
];

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    process.exit(0);
  }
  main(options).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}

export async function main(options) {
  const sourceRoot = process.cwd();
  const scenarios = resolveScenarios(options.scenarios);
  const startedAt = new Date();
  const runId = `${startedAt.toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const artifactDir = resolve(sourceRoot, "var", "simulated-benchmarks", runId);
  const statePath = resolve(artifactDir, "hootline-state.json");
  const simulatorStatePath = resolve(artifactDir, "simulator-state.json");
  const fixtureTemplatePath = resolve(sourceRoot, options.fixtureTemplatePath);

  console.log(`Simulated benchmark: ${runId}`);
  console.log(`Simulated repo: ${options.repo}`);
  console.log(`Fixture template: ${fixtureTemplatePath}`);
  console.log(`State path: ${statePath}`);
  console.log(`Simulator state path: ${simulatorStatePath}`);
  console.log(`Scenarios: ${scenarios.map((scenario) => scenario.id).join(", ")}`);
  console.log(`Samples per scenario: ${options.samples}`);
  if (options.dryRun) console.log("Mode: dry run");
  if (options.mockModel) console.log("Model mode: deterministic mock");

  if (!existsSync(fixtureTemplatePath)) {
    throw new Error(`Fixture template path does not exist: ${fixtureTemplatePath}`);
  }
  mkdirSync(artifactDir, { recursive: true });
  writeSimulatorState(simulatorStatePath, {
    samples: {},
    pullRequests: {},
    nextPullRequestNumber: 1,
    comments: [],
    reruns: [],
    merges: [],
  });

  let server;
  const serverUrl = options.serverUrl ?? (options.dryRun ? undefined : await startBenchmarkServer({
    artifactDir,
    mockModel: options.mockModel,
    simulatorStatePath,
    sourceRoot,
    statePath,
    webhookSecret: options.webhookSecret,
  }).then((started) => {
    server = started;
    return started.url;
  }));

  const rows = [];
  try {
    for (const scenario of scenarios) {
      for (let sample = 1; sample <= options.samples; sample += 1) {
        const row = await runScenarioSample({
          artifactDir,
          fixtureTemplatePath,
          options,
          runId,
          sample,
          scenario,
          serverUrl,
          simulatorStatePath,
          statePath,
        });
        rows.push(row);
        writeArtifacts({ artifactDir, options, rows, scenarios, startedAt });
      }
    }
  } finally {
    if (server !== undefined) await stopBenchmarkServer(server);
  }

  writeArtifacts({ artifactDir, options, rows, scenarios, startedAt });
  printSummary(rows, artifactDir, options.dryRun);
}

async function runScenarioSample({
  artifactDir,
  fixtureTemplatePath,
  options,
  runId,
  sample,
  scenario,
  serverUrl,
  simulatorStatePath,
  statePath,
}) {
  const sampleStartedAt = new Date().toISOString();
  console.log("");
  console.log(`== ${scenario.id} sample ${sample}/${options.samples} ==`);

  const sampleDir = resolve(artifactDir, "samples", `${scenario.id}-${sample}`);
  const repoPath = resolve(sampleDir, "repo");
  materializeFixtureTemplate(fixtureTemplatePath, repoPath);
  assertScenarioBaseline(repoPath, scenario);

  if (options.dryRun) {
    return dryRunRow({ sample, sampleStartedAt, scenario });
  }

  const baseline = runFixtureCommand(repoPath);
  if (baseline.status !== 0) {
    writeCommandArtifact(sampleDir, "baseline", baseline);
    throw new Error(`Baseline verification failed for ${scenario.id}.`);
  }

  applyScenarioMutation(repoPath, scenario);
  const failure = runFixtureCommand(repoPath);
  writeCommandArtifact(sampleDir, "failure", failure);
  if (failure.status === 0) {
    throw new Error(`Scenario ${scenario.id} did not produce a failing fixture test.`);
  }

  const sha = simulatedSha(scenario, sample, repoPath, runId);
  const pipelineId = simulatedPipelineId(runId, scenario, sample);
  const deliveryId = `${scenario.id}-${sample}-${sha.slice(0, 12)}`;
  appendSimulatorSample(simulatorStatePath, {
    repoSlug: options.repo,
    sha,
    defaultBranch: options.mainBranch,
    worktreePath: repoPath,
    policyPath: ".hootline.yaml",
    scenarioId: scenario.id,
    failureContext: {
      summary: `Simulated GitHub workflow failed for ${scenario.title}. Expected repair files: ${scenarioExpectedRepairFiles(scenario).join(", ")}.`,
      jobs: [
        {
          id: String(pipelineId),
          name: "simulated npm test",
          url: `https://simulated.github.local/${options.repo}/actions/runs/${pipelineId}`,
          conclusion: "failure",
          status: "completed",
          log: buildFailureLog(scenario, failure),
        },
      ],
    },
    mockRepairPlan: scenarioMutations(scenario),
  });

  const workflowRun = {
    conclusion: "failure",
    databaseId: pipelineId,
    headSha: sha,
    url: `https://simulated.github.local/${options.repo}/actions/runs/${pipelineId}`,
  };

  await deliverGitHubWorkflowRun({
    deliveryId,
    options,
    pipelineId,
    serverUrl: requireServerUrl(serverUrl),
    sha,
  });
  const repairResult = await waitForRepairResult({
    deliveryId,
    options,
    pipelineId,
    serverUrl: requireServerUrl(serverUrl),
    sha,
    statePath,
  });
  const prChecks =
    repairResult.attempt?.changeNumber === undefined
      ? undefined
      : readSimulatedPullRequestChecks(simulatorStatePath, options.repo, repairResult.attempt.changeNumber);
  const simulatedPullRequest =
    repairResult.attempt?.changeNumber === undefined
      ? undefined
      : readSimulatedPullRequest(simulatorStatePath, options.repo, repairResult.attempt.changeNumber);

  const row = {
    ...buildBenchmarkRow({
      inspector: undefined,
      prChecks,
      repairResult,
      sample,
      sampleStartedAt,
      scenario,
      workflowRun,
    }),
    simulated: true,
    actualRepairFiles: simulatedPullRequest?.changes.map((change) => change.path) ?? [],
    expectedRepairFilesMatch: sameStringSet(
      simulatedPullRequest?.changes.map((change) => change.path) ?? [],
      scenarioExpectedRepairFiles(scenario),
    ),
    simulatedCheckConclusion: simulatedPullRequest?.checkConclusion,
  };
  writeFileSync(resolve(sampleDir, "row.json"), `${JSON.stringify(row, null, 2)}\n`);
  return row;
}

function dryRunRow({ sample, sampleStartedAt, scenario }) {
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
    simulated: true,
    scenarioSourcePaths: scenarioSourcePaths(scenario),
  };
}

async function waitForRepairResult({ deliveryId, options, pipelineId, serverUrl, sha, statePath }) {
  const deadline = Date.now() + options.repairTimeoutMs;
  let redeliveries = 0;
  let lastAttempt;
  while (Date.now() <= deadline) {
    const attempt = findAttemptForSha(readJsonFile(statePath, { attempts: {} }), {
      repoSlug: options.repo,
      sha,
    });
    if (attempt !== undefined && isTerminalEnough(attempt)) {
      lastAttempt = attempt;
      if (attempt.lastPublishResult !== undefined || attempt.changeNumber !== undefined) {
        return { status: "published", attempt, redeliveries };
      }
      if (!shouldRedeliverAttempt(attempt) || redeliveries + attempt.attempts >= attempt.policy.maxAttemptsPerSha) {
        return { status: "terminal_without_publish", attempt, redeliveries };
      }
      await deliverGitHubWorkflowRun({
        deliveryId,
        options,
        pipelineId,
        serverUrl,
        sha,
      });
      redeliveries += 1;
    }
    await sleep(options.pollIntervalMs);
  }
  return lastAttempt === undefined
    ? { status: "no_webhook_attempt", redeliveries }
    : { status: "terminal_without_publish", attempt: lastAttempt, redeliveries };
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

async function deliverGitHubWorkflowRun({ deliveryId, options, pipelineId, serverUrl, sha }) {
  const body = JSON.stringify({
    action: "completed",
    workflow_run: {
      id: pipelineId,
      html_url: `https://simulated.github.local/${options.repo}/actions/runs/${pipelineId}`,
      head_sha: sha,
      head_branch: options.mainBranch,
      event: "push",
      status: "completed",
      conclusion: "failure",
      pull_requests: [],
    },
    repository: {
      full_name: options.repo,
    },
    installation: {
      id: 1,
    },
    sender: {
      login: "hootline-simulated-benchmark",
    },
  });
  const response = await fetch(`${serverUrl.replace(/\/+$/, "")}/eve/v1/ci/github`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-delivery": deliveryId,
      "x-github-event": "workflow_run",
      "x-hub-signature-256": githubSignature(body, options.webhookSecret),
    },
    body,
  });
  if (!response.ok) {
    throw new Error(`Simulated webhook delivery failed with HTTP ${response.status}: ${await response.text()}`);
  }
  const result = await response.json().catch(() => ({}));
  if (result?.accepted !== true) {
    throw new Error(`Simulated webhook delivery was not accepted: ${JSON.stringify(result)}`);
  }
}

async function startBenchmarkServer({
  artifactDir,
  mockModel,
  simulatorStatePath,
  sourceRoot,
  statePath,
  webhookSecret,
}) {
  const port = await findFreePort();
  const env = {
    ...loadBenchmarkEnvFiles(sourceRoot),
    GITHUB_WEBHOOK_SECRET: webhookSecret,
    HOOTLINE_GITHUB_PROVIDER_BACKEND: "simulated",
    HOOTLINE_SIMULATOR_STATE_PATH: simulatorStatePath,
    HOOTLINE_STATE_PATH: statePath,
  };
  if (mockModel) {
    env.HOOTLINE_MODEL_PROVIDER = "mock";
    env.HOOTLINE_MODEL = "hootline-simulated-script";
  }

  const appRoot = prepareBenchmarkAppWorkspace({ artifactDir, sourceRoot });
  writeFileSync(
    resolve(artifactDir, "app-workspace.json"),
    `${JSON.stringify({ appRoot, sourceRoot }, null, 2)}\n`,
  );
  console.log(`Isolated app workspace: ${appRoot}`);
  console.log("Building Eve app for simulated benchmark...");
  const build = spawnSync("npm", ["run", "build"], {
    cwd: appRoot,
    env,
    encoding: "utf8",
    stdio: "pipe",
  });
  writeFileSync(resolve(artifactDir, "build.stdout.log"), build.stdout ?? "");
  writeFileSync(resolve(artifactDir, "build.stderr.log"), build.stderr ?? "");
  if (build.status !== 0) {
    process.stdout.write(build.stdout ?? "");
    process.stderr.write(build.stderr ?? "");
    throw new Error("Eve build failed for simulated benchmark.");
  }

  const logStream = createWriteStream(resolve(artifactDir, "server.log"), { flags: "a" });
  const child = spawn("npm", ["run", "start", "--", "--host", "127.0.0.1", "--port", String(port)], {
    cwd: appRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.pipe(logStream, { end: false });
  child.stderr.pipe(logStream, { end: false });
  const url = `http://127.0.0.1:${port}`;
  try {
    await waitForServerReady(url, child);
  } catch (error) {
    child.kill("SIGTERM");
    logStream.end();
    throw error;
  }
  console.log(`Started simulated benchmark server: ${url}`);
  return { child, logStream, url };
}

async function stopBenchmarkServer(server) {
  if (server.child.exitCode !== null) {
    server.logStream.end();
    return;
  }
  server.child.kill("SIGTERM");
  await new Promise((resolve) => {
    const timeout = setTimeout(() => {
      if (server.child.exitCode === null) server.child.kill("SIGKILL");
      resolve();
    }, 5_000);
    server.child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
  server.logStream.end();
}

async function waitForServerReady(url, child) {
  const deadline = Date.now() + 60_000;
  while (Date.now() <= deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Benchmark server exited before becoming ready with code ${child.exitCode}.`);
    }
    try {
      const response = await fetch(`${url}/eve/v1/info`);
      if (response.ok) return;
    } catch {
      // Retry until the server binds.
    }
    await sleep(1_000);
  }
  throw new Error("Timed out waiting for simulated benchmark server.");
}

function materializeFixtureTemplate(templatePath, repoPath) {
  rmSync(dirname(repoPath), { recursive: true, force: true });
  mkdirSync(dirname(repoPath), { recursive: true });
  cpSync(templatePath, repoPath, {
    recursive: true,
    filter: (source) => !source.split(sep).includes("node_modules") && !source.split(sep).includes(".git"),
  });
}

function runFixtureCommand(repoPath) {
  const result = spawnSync("npm", ["test"], {
    cwd: repoPath,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    stdio: "pipe",
  });
  return {
    command: "npm test",
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function writeCommandArtifact(sampleDir, label, result) {
  mkdirSync(sampleDir, { recursive: true });
  writeFileSync(resolve(sampleDir, `${label}.stdout.log`), result.stdout);
  writeFileSync(resolve(sampleDir, `${label}.stderr.log`), result.stderr);
}

function appendSimulatorSample(simulatorStatePath, sample) {
  const state = readJsonFile(simulatorStatePath, {
    samples: {},
    pullRequests: {},
    nextPullRequestNumber: 1,
    comments: [],
    reruns: [],
    merges: [],
  });
  state.samples = {
    ...(state.samples ?? {}),
    [`${sample.repoSlug}@${sample.sha}`]: sample,
  };
  writeSimulatorState(simulatorStatePath, state);
}

function writeSimulatorState(simulatorStatePath, state) {
  mkdirSync(dirname(simulatorStatePath), { recursive: true });
  writeFileSync(simulatorStatePath, `${JSON.stringify(state, null, 2)}\n`);
}

function readSimulatedPullRequestChecks(simulatorStatePath, repoSlug, number) {
  const pr = readSimulatedPullRequest(simulatorStatePath, repoSlug, number);
  if (pr === undefined) return { conclusion: "pending", checks: [] };
  return {
    conclusion: pr.checkConclusion,
    checks: pr.checks.map((check) => ({
      name: check.name,
      status: check.status,
      conclusion: check.conclusion,
      url: pr.url,
    })),
  };
}

function readSimulatedPullRequest(simulatorStatePath, repoSlug, number) {
  const state = readJsonFile(simulatorStatePath, {});
  return state.pullRequests?.[`${repoSlug}#${number}`];
}

function buildFailureLog(scenario, failure) {
  return [
    `Scenario: ${scenario.id}`,
    `Expected failure: ${scenario.expectedFailure}`,
    `Expected repair files: ${scenarioExpectedRepairFiles(scenario).join(", ")}`,
    "",
    failure.stdout,
    failure.stderr,
  ].join("\n").slice(0, 24_000);
}

function simulatedSha(scenario, sample, repoPath, runId) {
  const hash = createHash("sha1");
  hash.update(runId);
  hash.update(scenario.id);
  hash.update(String(sample));
  for (const mutation of scenarioMutations(scenario)) {
    hash.update(mutation.sourcePath);
    hash.update(readFileSync(resolve(repoPath, mutation.sourcePath)));
  }
  return hash.digest("hex");
}

function simulatedPipelineId(runId, scenario, sample) {
  const hash = createHash("sha1");
  hash.update(runId);
  hash.update(scenario.id);
  hash.update(String(sample));
  return Number.parseInt(hash.digest("hex").slice(0, 12), 16);
}

export function prepareBenchmarkAppWorkspace({ artifactDir, sourceRoot }) {
  const appRoot = resolve(artifactDir, "app");
  rmSync(appRoot, { recursive: true, force: true });
  mkdirSync(appRoot, { recursive: true });

  for (const relativePath of APP_WORKSPACE_PATHS) {
    const sourcePath = resolve(sourceRoot, relativePath);
    if (!existsSync(sourcePath)) continue;
    const destinationPath = resolve(appRoot, relativePath);
    mkdirSync(dirname(destinationPath), { recursive: true });
    cpSync(sourcePath, destinationPath, { recursive: true });
  }

  const sourceNodeModules = resolve(sourceRoot, "node_modules");
  if (!existsSync(sourceNodeModules)) {
    throw new Error(`node_modules is required to build the simulated benchmark app: ${sourceNodeModules}`);
  }
  symlinkSync(sourceNodeModules, resolve(appRoot, "node_modules"), "dir");
  return appRoot;
}

export function loadBenchmarkEnvFiles(sourceRoot, baseEnv = process.env) {
  const env = { ...baseEnv };
  const baseKeys = new Set(Object.keys(baseEnv));
  for (const fileName of [".env", ".env.local"]) {
    const envPath = resolve(sourceRoot, fileName);
    if (!existsSync(envPath)) continue;
    const values = parseDotEnv(readFileSync(envPath, "utf8"));
    for (const [key, value] of Object.entries(values)) {
      if (!baseKeys.has(key)) env[key] = value;
    }
  }
  return env;
}

export function parseDotEnv(text) {
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    let trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    if (trimmed.startsWith("export ")) trimmed = trimmed.slice("export ".length).trimStart();

    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;

    const key = trimmed.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    values[key] = parseDotEnvValue(trimmed.slice(separator + 1));
  }
  return values;
}

function parseDotEnvValue(rawValue) {
  const value = rawValue.trimStart();
  if (value.startsWith('"')) {
    const end = findClosingQuote(value, '"');
    const quoted = end === -1 ? value.slice(1) : value.slice(1, end);
    return quoted
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\r")
      .replace(/\\t/g, "\t")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");
  }
  if (value.startsWith("'")) {
    const end = findClosingQuote(value, "'");
    return end === -1 ? value.slice(1) : value.slice(1, end);
  }
  return value.replace(/\s+#.*$/, "").trimEnd();
}

function findClosingQuote(value, quote) {
  for (let index = 1; index < value.length; index += 1) {
    if (value[index] !== quote) continue;
    if (quote === "'" || value[index - 1] !== "\\") return index;
  }
  return -1;
}

function writeArtifacts({ artifactDir, options, rows, scenarios, startedAt }) {
  mkdirSync(artifactDir, { recursive: true });
  const report = {
    startedAt: startedAt.toISOString(),
    completedAt: new Date().toISOString(),
    repo: options.repo,
    scenarios: scenarios.map((scenario) => scenario.id),
    samples: options.samples,
    simulated: true,
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

function renderMarkdownSummary(report) {
  const lines = [
    "# Simulated Benchmark",
    "",
    `Started: ${report.startedAt}`,
    `Completed: ${report.completedAt}`,
    `Repo: ${report.repo}`,
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
    "| Complexity | Samples | Published green | Rate | Status counts |",
    "| --- | ---: | ---: | ---: | --- |",
  ];
  for (const [complexity, group] of Object.entries(report.summary.byComplexity)) {
    lines.push(
      `| ${complexity} | ${group.total} | ${group.publishedGreen} | ${(group.publishedGreenRate * 100).toFixed(1)}% | ${formatCounts(group.counts)} |`,
    );
  }
  lines.push("", "## Areas To Improve", "");
  for (const signal of report.improvementSignals) lines.push(`- ${signal}`);
  lines.push("", "## Samples", "");
  lines.push("| Scenario | Complexity | Sample | Status | Provider Retries | Expected files | Actual files | Checks |");
  lines.push("| --- | --- | ---: | --- | ---: | --- | --- | --- |");
  for (const row of report.rows) {
    lines.push(
      `| ${row.scenarioId} | ${row.scenarioComplexity ?? ""} | ${row.sample} | ${row.status} | ${row.providerErrorRetriesUsed ?? 0} | ${(row.expectedRepairFiles ?? []).join(", ")} | ${(row.actualRepairFiles ?? []).join(", ")} | ${row.simulatedCheckConclusion ?? row.prCheckConclusion ?? ""} |`,
    );
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function printSummary(rows, artifactDir, dryRun) {
  const summary = summarizeRows(rows);
  console.log("");
  console.log("Summary");
  console.log(`- total samples: ${summary.total}`);
  console.log(`- published green: ${summary.publishedGreen}`);
  console.log(`- published green rate: ${(summary.publishedGreenRate * 100).toFixed(1)}%`);
  console.log(`- average provider-error retries: ${summary.averageProviderErrorRetries.toFixed(2)}`);
  for (const [status, count] of Object.entries(summary.counts)) {
    console.log(`- ${status}: ${count}`);
  }
  for (const [complexity, group] of Object.entries(summary.byComplexity)) {
    console.log(
      `- ${complexity}: ${group.publishedGreen}/${group.total} published green (${(group.publishedGreenRate * 100).toFixed(1)}%)`,
    );
  }
  for (const signal of summarizeImprovementSignals(rows)) {
    console.log(`- signal: ${signal}`);
  }
  if (!dryRun) console.log(`Artifacts: ${artifactDir}`);
}

function sameStringSet(left, right) {
  if (left.length !== right.length) return false;
  const expected = new Set(right);
  return left.every((value) => expected.has(value));
}

function formatCounts(counts) {
  return Object.entries(counts)
    .map(([status, count]) => `${status}: ${count}`)
    .join(", ");
}

function readJsonFile(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

function githubSignature(body, secret) {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

function requireServerUrl(serverUrl) {
  if (serverUrl === undefined) throw new Error("A server URL is required outside dry-run mode.");
  return serverUrl;
}

function findFreePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (address === null || typeof address === "string") {
          reject(new Error("Unable to allocate a local TCP port."));
          return;
        }
        resolvePort(address.port);
      });
    });
  });
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function parseArgs(argv) {
  const parsed = {
    ...DEFAULTS,
    dryRun: false,
    help: false,
    mockModel: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") {
      parsed.dryRun = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }
    if (arg === "--mock-model") {
      parsed.mockModel = true;
      continue;
    }

    const [name, inlineValue] = arg.split("=", 2);
    const value = inlineValue ?? argv[++i];
    if (value === undefined) fail(`Missing value for ${arg}`);

    switch (name) {
      case "--fixture-template-path":
        parsed.fixtureTemplatePath = value;
        break;
      case "--main-branch":
        parsed.mainBranch = value;
        break;
      case "--poll-interval-ms":
        parsed.pollIntervalMs = readPositiveInteger(value, name);
        break;
      case "--repair-timeout-ms":
        parsed.repairTimeoutMs = readPositiveInteger(value, name);
        break;
      case "--repo":
        parsed.repo = value;
        break;
      case "--samples":
        parsed.samples = readPositiveInteger(value, name);
        break;
      case "--scenarios":
        parsed.scenarios = value;
        break;
      case "--server-url":
        parsed.serverUrl = value;
        break;
      case "--webhook-secret":
        parsed.webhookSecret = value;
        break;
      default:
        fail(`Unknown option: ${arg}`);
    }
  }

  return parsed;
}

function printHelp() {
  console.log(`Usage: node scripts/simulated-benchmark.mjs [options]

Run Hootline's full Eve repair loop against a local simulated GitHub provider.

Options:
  --dry-run                       Print scenario metadata without starting a server
  --mock-model                    Use the deterministic Hootline mock model
  --scenarios <ids|all>           Comma-separated scenario ids (default: ${DEFAULTS.scenarios})
  --samples <n>                   Samples per scenario (default: ${DEFAULTS.samples})
  --repo <owner/name>             Simulated repository slug (default: ${DEFAULTS.repo})
  --server-url <url>              Use an already-running Hootline server
  --fixture-template-path <path>  Fixture template path (default: ${DEFAULTS.fixtureTemplatePath})
  --repair-timeout-ms <ms>        Repair timeout per sample (default: ${DEFAULTS.repairTimeoutMs})
  --poll-interval-ms <ms>         State polling interval (default: ${DEFAULTS.pollIntervalMs})
  --webhook-secret <secret>       Synthetic GitHub webhook secret
  --help                          Show this help

Available scenarios:
  ${scenarioIds().join(", ")}
`);
}

function readEnvInteger(name, fallback) {
  const value = process.env[name];
  return value === undefined || value.trim() === "" ? fallback : readPositiveInteger(value, name);
}

function readPositiveInteger(value, label) {
  if (!/^\d+$/.test(value)) fail(`${label} must be a positive integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) fail(`${label} must be a positive integer.`);
  return parsed;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

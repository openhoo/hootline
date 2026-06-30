#!/usr/bin/env node
import { createHash, createHmac, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  cpSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { dirname, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import YAML from "yaml";

import {
  applyScenarioMutation,
  assertScenarioBaseline,
  projectIds,
  resolveProjects,
  resolveScenarios,
  scenarioExpectedRepairFiles,
  scenarioMutations,
  scenarioSourcePaths,
  scenarioIds,
} from "./fixture-scenarios.mjs";
import {
  buildBenchmarkRow,
  findAttemptForSha,
  isTerminalRepairAttempt,
  shouldRedeliverRepairAttempt,
  summarizeImprovementSignals,
  summarizeRows,
} from "./benchmarks/common.mjs";
import {
  loadBenchmarkEnvFiles,
  prepareBenchmarkAppWorkspace,
} from "./benchmarks/simulated-app.mjs";

const DEFAULTS = {
  concurrency: readEnvInteger("HOOTLINE_SIMULATED_CONCURRENCY", 1),
  fixtureTemplatePath: process.env.HOOTLINE_SIMULATED_FIXTURE_TEMPLATE_PATH,
  mainBranch: process.env.HOOTLINE_SIMULATED_MAIN_BRANCH ?? "main",
  pollIntervalMs: readEnvInteger("HOOTLINE_SIMULATED_POLL_INTERVAL_MS", 2_000),
  repairTimeoutMs: readEnvInteger("HOOTLINE_SIMULATED_REPAIR_TIMEOUT_MS", 20 * 60 * 1000),
  repo:
    process.env.HOOTLINE_SIMULATED_REPO ??
    "openhoo/hootline-simulated-pipeline-fixture",
  projects: process.env.HOOTLINE_SIMULATED_PROJECTS ?? "all",
  samples: readEnvInteger("HOOTLINE_SIMULATED_SAMPLES", 1),
  scenarios: process.env.HOOTLINE_SIMULATED_SCENARIOS ?? "all",
  serverUrl: process.env.HOOTLINE_SIMULATED_SERVER_URL,
  webhookSecret:
    process.env.GITHUB_WEBHOOK_SECRET ??
    process.env.HOOTLINE_SIMULATED_WEBHOOK_SECRET ??
    "hootline-simulated-webhook-secret",
};

export {
  loadBenchmarkEnvFiles,
  parseDotEnv,
  prepareBenchmarkAppWorkspace,
} from "./benchmarks/simulated-app.mjs";

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
  const projects = resolveProjects(options.projects);
  const scenarios = resolveScenarios(options.scenarios, { projects: options.projects });
  const startedAt = new Date();
  const runId = `${startedAt.toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const artifactDir = resolve(sourceRoot, "var", "simulated-benchmarks", runId);
  const statePath = resolve(artifactDir, "hootline-state.json");
  const simulatorStatePath = resolve(artifactDir, "simulator-state.json");

  console.log(`Simulated benchmark: ${runId}`);
  console.log(`Simulated repo: ${options.repo}`);
  console.log(`Projects: ${projects.map((project) => project.id).join(", ")}`);
  if (options.fixtureTemplatePath !== undefined) {
    console.log(`Fixture template override: ${resolve(sourceRoot, options.fixtureTemplatePath)}`);
  }
  console.log(`State path: ${statePath}`);
  console.log(`Simulator state path: ${simulatorStatePath}`);
  console.log(`Scenarios: ${scenarios.map((scenario) => scenario.id).join(", ")}`);
  console.log(`Samples per scenario: ${options.samples}`);
  console.log(`Concurrency: ${options.concurrency}`);
  if (options.dryRun) console.log("Mode: dry run");
  if (options.mockModel) console.log("Model mode: deterministic mock");

  for (const scenario of scenarios) {
    const fixtureTemplatePath = resolve(sourceRoot, options.fixtureTemplatePath ?? scenario.templatePath);
    if (!existsSync(fixtureTemplatePath)) {
      throw new Error(`Fixture template path does not exist for ${scenario.id}: ${fixtureTemplatePath}`);
    }
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

  const jobs = [];
  for (const scenario of scenarios) {
    for (let sample = 1; sample <= options.samples; sample += 1) {
      jobs.push({ sample, scenario });
    }
  }
  const rows = new Array(jobs.length);
  try {
    await runWithConcurrency(jobs, options.concurrency, async ({ sample, scenario }, index) => {
      const row = await runScenarioSample({
        artifactDir,
        options,
        runId,
        sample,
        scenario,
        serverUrl,
        simulatorStatePath,
        statePath,
      });
      rows[index] = row;
      writeArtifacts({ artifactDir, options, rows: compactRows(rows), scenarios, startedAt });
    });
  } finally {
    if (server !== undefined) await stopBenchmarkServer(server);
  }

  const completedRows = compactRows(rows);
  writeArtifacts({ artifactDir, options, rows: completedRows, scenarios, startedAt });
  printSummary(completedRows, artifactDir, options.dryRun);
}

async function runScenarioSample({
  artifactDir,
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
  console.log(`== ${scenario.projectId}/${scenario.id} sample ${sample}/${options.samples} ==`);

  const sampleDir = resolve(artifactDir, "samples", `${scenario.id}-${sample}`);
  const repoPath = resolve(sampleDir, "repo");
  const fixtureTemplatePath = resolve(process.cwd(), options.fixtureTemplatePath ?? scenario.templatePath);
  materializeFixtureTemplate(fixtureTemplatePath, repoPath);
  assertScenarioBaseline(repoPath, scenario);
  const policy = loadFixturePolicy(repoPath, scenario);

  if (options.dryRun) {
    return dryRunRow({ policy, sample, sampleStartedAt, scenario });
  }

  const baseline = runFixtureCommand(repoPath, policy.verificationCommands);
  if (baseline.status !== 0) {
    writeCommandArtifact(sampleDir, "baseline", baseline);
    throw new Error(`Baseline verification failed for ${scenario.id}.`);
  }

  applyScenarioMutation(repoPath, scenario);
  const failure = runFixtureCommand(repoPath, policy.verificationCommands);
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
    projectId: scenario.projectId,
    failureContext: {
      summary: `Simulated GitHub workflow failed for ${scenario.projectName}: ${scenario.title}. Expected repair files: ${scenarioExpectedRepairFiles(scenario).join(", ")}.`,
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
    verificationCommands: policy.verificationCommands,
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

function dryRunRow({ policy, sample, sampleStartedAt, scenario }) {
  return {
    projectId: scenario.projectId,
    projectName: scenario.projectName,
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
    verificationCommands: policy.verificationCommands,
  };
}

async function runWithConcurrency(items, concurrency, worker) {
  let nextIndex = 0;
  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      for (;;) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= items.length) return;
        await worker(items[index], index);
      }
    }),
  );
}

function compactRows(rows) {
  return rows.filter((row) => row !== undefined);
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
    if (attempt !== undefined && isTerminalRepairAttempt(attempt)) {
      lastAttempt = attempt;
      if (attempt.lastPublishResult !== undefined || attempt.changeNumber !== undefined) {
        return { status: "published", attempt, redeliveries };
      }
      if (!shouldRedeliverRepairAttempt(attempt) || redeliveries + attempt.attempts >= attempt.policy.maxAttemptsPerSha) {
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

function loadFixturePolicy(repoPath, scenario) {
  const policyPath = resolve(repoPath, ".hootline.yaml");
  const fallback = scenario.verificationCommands ?? ["npm test"];
  if (!existsSync(policyPath)) return { verificationCommands: fallback };
  const parsed = YAML.parse(readFileSync(policyPath, "utf8"));
  const commands = Array.isArray(parsed?.verificationCommands)
    ? parsed.verificationCommands.filter((command) => typeof command === "string" && command.trim() !== "")
    : [];
  return {
    verificationCommands: commands.length > 0 ? commands : fallback,
  };
}

function runFixtureCommand(repoPath, verificationCommands) {
  const outputs = [];
  for (const command of verificationCommands) {
    const result = spawnSync("bash", ["-lc", `set -euo pipefail; ${command}`], {
      cwd: repoPath,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      stdio: "pipe",
    });
    outputs.push({
      command,
      status: result.status ?? 1,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    });
    if ((result.status ?? 1) !== 0) break;
  }
  return {
    command: verificationCommands.join(" && "),
    commands: outputs,
    status: outputs.every((output) => output.status === 0) ? 0 : 1,
    stdout: outputs.map((output) => output.stdout).join("\n"),
    stderr: outputs.map((output) => output.stderr).join("\n"),
  };
}

function writeCommandArtifact(sampleDir, label, result) {
  mkdirSync(sampleDir, { recursive: true });
  writeFileSync(resolve(sampleDir, `${label}.stdout.log`), result.stdout);
  writeFileSync(resolve(sampleDir, `${label}.stderr.log`), result.stderr);
}

function appendSimulatorSample(simulatorStatePath, sample) {
  updateSimulatorState(simulatorStatePath, (state) => {
    state.samples = {
      ...(state.samples ?? {}),
      [`${sample.repoSlug}@${sample.sha}`]: sample,
    };
  });
}

function writeSimulatorState(simulatorStatePath, state) {
  withSimulatorStateLock(simulatorStatePath, () => {
    writeSimulatorStateUnlocked(simulatorStatePath, state);
  });
}

function updateSimulatorState(simulatorStatePath, mutator) {
  withSimulatorStateLock(simulatorStatePath, () => {
    const state = readJsonFile(simulatorStatePath, {
      samples: {},
      pullRequests: {},
      nextPullRequestNumber: 1,
      comments: [],
      reruns: [],
      merges: [],
    });
    mutator(state);
    writeSimulatorStateUnlocked(simulatorStatePath, state);
  });
}

function writeSimulatorStateUnlocked(simulatorStatePath, state) {
  mkdirSync(dirname(simulatorStatePath), { recursive: true });
  const tempPath = `${simulatorStatePath}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tempPath, simulatorStatePath);
}

function withSimulatorStateLock(simulatorStatePath, callback) {
  const lockPath = `${simulatorStatePath}.lock`;
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      mkdirSync(lockPath);
      break;
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST" || Date.now() > deadline) {
        throw error;
      }
      sleepSync(25);
    }
  }
  try {
    return callback();
  } finally {
    rmSync(lockPath, { recursive: true, force: true });
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isNodeError(error) {
  return error instanceof Error && "code" in error;
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

function writeArtifacts({ artifactDir, options, rows, scenarios, startedAt }) {
  mkdirSync(artifactDir, { recursive: true });
  const report = {
    startedAt: startedAt.toISOString(),
    completedAt: new Date().toISOString(),
    repo: options.repo,
    projects: [...new Set(scenarios.map((scenario) => scenario.projectId))],
    scenarios: scenarios.map((scenario) => scenario.id),
    samples: options.samples,
    concurrency: options.concurrency,
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
    `Concurrency: ${report.concurrency}`,
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
    "## By Project",
    "",
    "| Project | Samples | Published green | Rate | Status counts |",
    "| --- | ---: | ---: | ---: | --- |",
  ];
  for (const [project, group] of Object.entries(report.summary.byProject)) {
    lines.push(
      `| ${project} | ${group.total} | ${group.publishedGreen} | ${(group.publishedGreenRate * 100).toFixed(1)}% | ${formatCounts(group.counts)} |`,
    );
  }
  lines.push(
    "",
    "## By Complexity",
    "",
    "| Complexity | Samples | Published green | Rate | Status counts |",
    "| --- | ---: | ---: | ---: | --- |",
  );
  for (const [complexity, group] of Object.entries(report.summary.byComplexity)) {
    lines.push(
      `| ${complexity} | ${group.total} | ${group.publishedGreen} | ${(group.publishedGreenRate * 100).toFixed(1)}% | ${formatCounts(group.counts)} |`,
    );
  }
  lines.push(
    "",
    "## By Tag",
    "",
    "| Tag | Samples | Published green | Rate | Status counts |",
    "| --- | ---: | ---: | ---: | --- |",
  );
  for (const [tag, group] of Object.entries(report.summary.byTag).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    lines.push(
      `| ${tag} | ${group.total} | ${group.publishedGreen} | ${(group.publishedGreenRate * 100).toFixed(1)}% | ${formatCounts(group.counts)} |`,
    );
  }
  lines.push(
    "",
    "## By Mutation Count",
    "",
    "| Mutations | Samples | Published green | Rate | Status counts |",
    "| ---: | ---: | ---: | ---: | --- |",
  );
  for (const [mutationCount, group] of Object.entries(report.summary.byMutationCount).sort(
    ([left], [right]) => Number(left) - Number(right),
  )) {
    lines.push(
      `| ${mutationCount} | ${group.total} | ${group.publishedGreen} | ${(group.publishedGreenRate * 100).toFixed(1)}% | ${formatCounts(group.counts)} |`,
    );
  }
  lines.push("", "## Areas To Improve", "");
  for (const signal of report.improvementSignals) lines.push(`- ${signal}`);
  lines.push("", "## Samples", "");
  lines.push("| Project | Scenario | Complexity | Sample | Status | Provider Retries | Expected files | Actual files | Checks |");
  lines.push("| --- | --- | --- | ---: | --- | ---: | --- | --- | --- |");
  for (const row of report.rows) {
    lines.push(
      `| ${row.projectId ?? ""} | ${row.scenarioId} | ${row.scenarioComplexity ?? ""} | ${row.sample} | ${row.status} | ${row.providerErrorRetriesUsed ?? 0} | ${(row.expectedRepairFiles ?? []).join(", ")} | ${(row.actualRepairFiles ?? []).join(", ")} | ${row.simulatedCheckConclusion ?? row.prCheckConclusion ?? ""} |`,
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
  for (const [project, group] of Object.entries(summary.byProject)) {
    console.log(
      `- project ${project}: ${group.publishedGreen}/${group.total} published green (${(group.publishedGreenRate * 100).toFixed(1)}%)`,
    );
  }
  for (const [complexity, group] of Object.entries(summary.byComplexity)) {
    console.log(
      `- ${complexity}: ${group.publishedGreen}/${group.total} published green (${(group.publishedGreenRate * 100).toFixed(1)}%)`,
    );
  }
  for (const [tag, group] of Object.entries(summary.byTag).sort(([left], [right]) => left.localeCompare(right))) {
    console.log(
      `- tag ${tag}: ${group.publishedGreen}/${group.total} published green (${(group.publishedGreenRate * 100).toFixed(1)}%)`,
    );
  }
  for (const [mutationCount, group] of Object.entries(summary.byMutationCount).sort(
    ([left], [right]) => Number(left) - Number(right),
  )) {
    console.log(
      `- ${mutationCount} mutation(s): ${group.publishedGreen}/${group.total} published green (${(group.publishedGreenRate * 100).toFixed(1)}%)`,
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
      case "--concurrency":
        parsed.concurrency = readPositiveInteger(value, name);
        break;
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
      case "--projects":
        parsed.projects = value;
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
  --concurrency <n>               Scenario samples to run concurrently (default: ${DEFAULTS.concurrency})
  --projects <ids|all>            Comma-separated fixture project ids (default: ${DEFAULTS.projects})
  --repo <owner/name>             Simulated repository slug (default: ${DEFAULTS.repo})
  --server-url <url>              Use an already-running Hootline server
  --fixture-template-path <path>  Override fixture template path for single-template debugging
  --repair-timeout-ms <ms>        Repair timeout per sample (default: ${DEFAULTS.repairTimeoutMs})
  --poll-interval-ms <ms>         State polling interval (default: ${DEFAULTS.pollIntervalMs})
  --webhook-secret <secret>       Synthetic GitHub webhook secret
  --help                          Show this help

Available projects:
  ${projectIds().join(", ")}

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

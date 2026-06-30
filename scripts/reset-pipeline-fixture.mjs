#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import {
  DEFAULT_SCENARIO_ID,
  applyScenarioMutation,
  assertScenarioBaseline,
  expectedFixtureFiles,
  resolveScenario,
  scenarioIds,
} from "./fixture-scenarios.mjs";

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
    "wakemeup0/hootline-pipeline-fixture",
  scenario:
    process.env.HOOTLINE_FIXTURE_SCENARIO ??
    DEFAULT_SCENARIO_ID,
};

const FIXTURE_VERIFY_COMMAND = ["npm", "run", "verify"];

const options = parseArgs(process.argv.slice(2));
const scenario = resolveScenario(options.scenario);

if (options.help) {
  printHelp();
  process.exit(0);
}

if (!options.yes && !options.dryRun) {
  printHelp();
  fail("Refusing to mutate the fixture repo without --yes. Use --dry-run to preview.");
}

const fixturePath = resolve(process.cwd(), options.fixturePath);

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});

async function main() {
  assertCleanFixtureWorktree();

  console.log(`Fixture repo: ${options.repo}`);
  console.log(`Fixture path: ${fixturePath}`);
  console.log(`Baseline ref: ${options.baselineRef}`);
  console.log(`Main branch: ${options.mainBranch}`);
  console.log(`Fix branch prefix: ${options.fixBranchPrefix}`);
  console.log(`Scenario: ${scenario.id} (${scenario.title})`);
  if (options.dryRun) console.log("Mode: dry run");

  runGit(["fetch", "origin", "--prune", "--tags"], { write: false });
  const baselineSha = readGit(["rev-parse", `${options.baselineRef}^{commit}`]).trim();

  const openPullRequests = listOpenPullRequests();
  if (openPullRequests.length === 0) {
    console.log("Open pull requests: none");
  } else {
    console.log(`Open pull requests: ${openPullRequests.length}`);
    for (const pr of openPullRequests) {
      console.log(`- #${pr.number} ${pr.headRefName}: ${pr.title}`);
    }
  }

  closePullRequests(openPullRequests);

  const fixtureBranches = listRemoteFixtureBranches();
  if (fixtureBranches.length === 0) {
    console.log("Remote fixture fix branches: none");
  } else {
    console.log(`Remote fixture fix branches: ${fixtureBranches.length}`);
    for (const branch of fixtureBranches) console.log(`- ${branch}`);
  }
  deleteRemoteBranches(fixtureBranches);

  runGit(["checkout", "-B", options.mainBranch, baselineSha], { write: true });
  assertBaselineIsRepairable();
  runFixtureTests({ expectSuccess: true });
  runGit(["push", "--force-with-lease", "origin", `${options.mainBranch}:${options.mainBranch}`], {
    write: true,
  });

  injectFailure();
  runFixtureTests({ expectSuccess: false });
  runGit(["add", scenario.sourcePath], { write: true });
  runGit(["commit", "-m", scenario.commitMessage], { write: true });
  const failingSha = options.dryRun ? "<dry-run>" : readGit(["rev-parse", "HEAD"]).trim();
  runGit(["push", "origin", `${options.mainBranch}:${options.mainBranch}`], { write: true });

  console.log("");
  console.log(`Pushed failing fixture commit: ${failingSha}`);
  console.log(`Actions: https://github.com/${options.repo}/actions`);
}

function assertCleanFixtureWorktree() {
  if (!existsSync(fixturePath)) {
    fail(`Fixture path does not exist: ${fixturePath}`);
  }
  const status = readGit(["status", "--porcelain=v1"]).trim();
  if (status !== "") {
    fail(`Fixture worktree is dirty. Commit, stash, or reset it first:\n${status}`);
  }
}

function assertBaselineIsRepairable() {
  const policyPath = `${fixturePath}/.hootline.yaml`;
  if (options.dryRun) return;
  if (!existsSync(policyPath)) {
    fail(
      `Baseline ${options.baselineRef} does not contain .hootline.yaml. ` +
        "Use a policy-backed baseline ref.",
    );
  }
  for (const file of expectedFixtureFiles()) {
    if (!existsSync(`${fixturePath}/${file}`)) {
      fail(`Baseline ${options.baselineRef} is missing expected fixture file: ${file}`);
    }
  }

  assertScenarioBaseline(fixturePath, scenario);
}

function closePullRequests(pullRequests) {
  for (const pr of pullRequests) {
    runGh(
      [
        "pr",
        "close",
        String(pr.number),
        "--repo",
        options.repo,
        "--comment",
        "Closing during Hootline fixture reset for a fresh failing pipeline run.",
      ],
      { write: true },
    );
  }
}

function deleteRemoteBranches(branches) {
  for (const branch of branches) {
    runGit(["push", "origin", `:refs/heads/${branch}`], { write: true });
  }
}

function injectFailure() {
  if (options.dryRun) {
    console.log(`would inject fixture scenario ${scenario.id} in ${scenario.sourcePath}`);
    return;
  }
  applyScenarioMutation(fixturePath, scenario);
}

function runFixtureTests({ expectSuccess }) {
  if (options.dryRun) {
    console.log(
      `would run ${FIXTURE_VERIFY_COMMAND.join(" ")} and expect ${
        expectSuccess ? "success" : "failure"
      }`,
    );
    return;
  }

  const result = spawnSync(FIXTURE_VERIFY_COMMAND[0], FIXTURE_VERIFY_COMMAND.slice(1), {
    cwd: fixturePath,
    encoding: "utf8",
    stdio: "pipe",
  });

  if (expectSuccess && result.status !== 0) {
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    fail("Baseline fixture tests failed.");
  }

  if (!expectSuccess && result.status === 0) {
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    fail("Intentional fixture failure did not fail tests.");
  }

  console.log(expectSuccess ? "Baseline tests pass." : "Intentional failure is reproducible.");
}

function listOpenPullRequests() {
  const raw = runGh(
    [
      "pr",
      "list",
      "--repo",
      options.repo,
      "--state",
      "open",
      "--limit",
      "100",
      "--json",
      "number,headRefName,title,url",
    ],
    { write: false },
  );
  return JSON.parse(raw);
}

function listRemoteFixtureBranches() {
  const raw = readGit(["ls-remote", "--heads", "origin", `${options.fixBranchPrefix}*`]).trim();
  if (raw === "") return [];
  return raw
    .split("\n")
    .map((line) => line.split(/\s+/)[1])
    .filter(Boolean)
    .map((ref) => ref.replace(/^refs\/heads\//, ""))
    .filter((branch) => branch !== options.mainBranch);
}

function readGit(args) {
  return execFileSync("git", args, {
    cwd: fixturePath,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function runGit(args, { write }) {
  return runCommand("git", args, { cwd: fixturePath, write });
}

function runGh(args, { write }) {
  return runCommand("gh", args, { cwd: process.cwd(), write });
}

function runCommand(command, args, { cwd, write }) {
  console.log(`$ ${command} ${args.map(shellQuote).join(" ")}`);
  if (write && options.dryRun) return "";
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
}

function parseArgs(argv) {
  const parsed = {
    ...DEFAULTS,
    dryRun: false,
    help: false,
    yes: false,
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
    if (arg === "--yes" || arg === "-y") {
      parsed.yes = true;
      continue;
    }

    const [name, inlineValue] = arg.split("=", 2);
    const value = inlineValue ?? argv[++i];
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
      case "--scenario":
        parsed.scenario = value;
        break;
      default:
        fail(`Unknown argument: ${arg}`);
    }
  }

  return parsed;
}

function shellQuote(value) {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function printHelp() {
  console.log(`Reset the Hootline pipeline fixture and push a fresh failing commit.

Usage:
  npm run fixture:reset -- --dry-run
  npm run fixture:reset -- --yes

Options:
  --baseline-ref <ref>       Fixed passing baseline commit/tag.
  --fixture-path <path>      Local fixture checkout path.
  --fix-branch-prefix <pfx>  Remote fixer branch prefix to delete.
  --main-branch <branch>     Fixture default branch.
  --repo <owner/name>        GitHub fixture repository.
  --scenario <id>            Scenario to inject. Default: ${DEFAULT_SCENARIO_ID}.
  --dry-run                  Print the reset plan without writes.
  --yes, -y                  Actually close PRs, force-push main, and push the failing commit.

Available scenarios:
  ${scenarioIds().join("\n  ")}

Defaults can also be set with HOOTLINE_FIXTURE_* environment variables.`);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

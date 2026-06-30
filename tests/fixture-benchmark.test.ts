import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import test from "node:test";

const scenarioModule = await import(new URL("../scripts/fixture-scenarios.mjs", import.meta.url).href);
const benchmarkModule = await import(new URL("../scripts/fixture-benchmark.mjs", import.meta.url).href);

const {
  SCENARIOS,
  applyScenarioMutation,
  assertScenarioBaseline,
  scenarioExpectedRepairFiles,
  scenarioMutations,
  scenarioSourcePaths,
  resolveScenario,
  resolveScenarios,
} = scenarioModule;
const {
  buildBenchmarkRow,
  classifyBenchmarkStatus,
  extractGitHubDeliveryDatabaseId,
  findAttemptForSha,
  summarizeImprovementSignals,
  summarizeRows,
  summarizeStatusCheckRollup,
} = benchmarkModule;

test("fixture scenarios replace exactly one passing source region", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "hootline-fixture-scenarios-"));
  try {
    for (const scenario of SCENARIOS) {
      const sourceByPath = new Map<string, string[]>();
      for (const mutation of scenarioMutations(scenario)) {
        const chunks = sourceByPath.get(mutation.sourcePath) ?? [];
        chunks.push(mutation.passingText);
        sourceByPath.set(mutation.sourcePath, chunks);
      }
      for (const [relativePath, chunks] of sourceByPath) {
        const sourcePath = join(tempRoot, relativePath);
        mkdirSync(dirname(sourcePath), { recursive: true });
        writeFileSync(sourcePath, `before\n${chunks.join("\n")}\nafter\n`);
      }

      assert.doesNotThrow(() => assertScenarioBaseline(tempRoot, scenario));
      applyScenarioMutation(tempRoot, scenario);

      for (const mutation of scenarioMutations(scenario)) {
        const mutated = readFileSync(join(tempRoot, mutation.sourcePath), "utf8");
        assert.equal(mutated.includes(mutation.failingText), true);
        assert.equal(mutated.includes(mutation.passingText), false);
      }
      assert.throws(() => assertScenarioBaseline(tempRoot, scenario), /passing text exactly once/);
    }
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("fixture scenario selection supports all and rejects unknown ids", () => {
  assert.equal(resolveScenario("shipping-threshold-basis").sourcePath, "src/shipping.js");
  assert.equal(resolveScenarios("all").length, SCENARIOS.length);
  assert.equal(SCENARIOS.length > 4, true);
  assert.deepEqual(
    resolveScenarios("shipping-threshold-basis,percentage-rounding").map(
      (scenario: { id: string }) => scenario.id,
    ),
    ["shipping-threshold-basis", "percentage-rounding"],
  );
  assert.throws(() => resolveScenario("missing"), /Unknown fixture scenario/);
});

test("complex fixture scenarios expose all mutated and expected repair files", () => {
  const scenario = resolveScenario("checkout-money-shipping-tax-cascade");

  assert.equal(scenario.complexity, "complex");
  assert.deepEqual(scenarioSourcePaths(scenario), ["src/money.js", "src/shipping.js", "src/tax.js"]);
  assert.deepEqual(scenarioExpectedRepairFiles(scenario), [
    "src/money.js",
    "src/shipping.js",
    "src/tax.js",
  ]);
});

test("fixture reset dry-run does not require a live fixture repository", () => {
  const scriptPath = fileURLToPath(new URL("../scripts/reset-pipeline-fixture.mjs", import.meta.url));
  const repoRoot = fileURLToPath(new URL("..", import.meta.url));
  const output = execFileSync(
    process.execPath,
    [
      scriptPath,
      "--dry-run",
      "--scenario",
      "checkout-money-shipping-tax-cascade",
      "--fixture-path",
      "/tmp/hootline-missing-fixture",
      "--repo",
      "owner/missing",
    ],
    { cwd: repoRoot, encoding: "utf8" },
  );

  assert.match(output, /Mode: dry run/);
  assert.match(output, /src\/money.js, src\/shipping.js, src\/tax.js/);
});

test("benchmark helpers classify attempt and PR check outcomes", () => {
  assert.equal(
    classifyBenchmarkStatus({
      attempt: undefined,
      prChecks: undefined,
      repairResult: { status: "no_webhook_attempt" },
    }),
    "no_webhook_attempt",
  );
  assert.equal(
    classifyBenchmarkStatus({
      attempt: { changeNumber: 4 },
      prChecks: { conclusion: "success", checks: [] },
      repairResult: { status: "published" },
    }),
    "published_green",
  );
  assert.equal(
    classifyBenchmarkStatus({
      attempt: { lastSessionStatus: "abandoned" },
      prChecks: undefined,
      repairResult: { status: "terminal_without_publish" },
    }),
    "agent_abandoned",
  );
  assert.equal(
    classifyBenchmarkStatus({
      attempt: { lastSessionStatus: "completed" },
      prChecks: undefined,
      repairResult: { status: "terminal_without_publish" },
    }),
    "agent_completed_without_publish",
  );
  assert.equal(
    classifyBenchmarkStatus({
      attempt: { lastTerminalAction: "rerun_requested" },
      prChecks: undefined,
      repairResult: { status: "terminal_without_publish" },
    }),
    "rerun_requested",
  );
  assert.equal(
    classifyBenchmarkStatus({
      attempt: { lastTerminalAction: "comment_posted" },
      prChecks: undefined,
      repairResult: { status: "terminal_without_publish" },
    }),
    "comment_posted",
  );

  assert.equal(
    summarizeStatusCheckRollup([
      { name: "Node test", status: "COMPLETED", conclusion: "SUCCESS" },
    ]).conclusion,
    "success",
  );
  assert.equal(
    summarizeStatusCheckRollup([
      { name: "Node test", status: "COMPLETED", conclusion: "FAILURE" },
    ]).conclusion,
    "failure",
  );
  assert.equal(summarizeStatusCheckRollup([]).conclusion, "pending");
});

test("benchmark redelivery lookup preserves large GitHub delivery ids", () => {
  const deliveriesJson = `[
    {"id":3828572433743355904,"guid":"9f032d90-7474-11f1-911f-3201a21d8018","event":"workflow_run"},
    {"id":3828572433988747264,"guid":"9efa2ce0-7474-11f1-882b-42f326fa07ca","event":"check_suite"}
  ]`;

  assert.equal(
    extractGitHubDeliveryDatabaseId(deliveriesJson, "9f032d90-7474-11f1-911f-3201a21d8018"),
    "3828572433743355904",
  );
  assert.equal(
    extractGitHubDeliveryDatabaseId(
      `[{"id":3828572433743355904,"guid":"nested-guid","request":{"headers":{"id":1}}}]`,
      "nested-guid",
    ),
    "3828572433743355904",
  );
  assert.equal(extractGitHubDeliveryDatabaseId(deliveriesJson, "missing"), undefined);
  assert.equal(extractGitHubDeliveryDatabaseId("not json", "nested-guid"), undefined);
});

test("benchmark rows retain complex scenario metadata", () => {
  const scenario = resolveScenario("checkout-money-shipping-tax-cascade");
  const row = buildBenchmarkRow({
    inspector: undefined,
    prChecks: undefined,
    repairResult: { attempt: { attempts: 1 }, redeliveries: 0, status: "terminal_without_publish" },
    sample: 1,
    sampleStartedAt: "2026-06-30T10:00:00.000Z",
    scenario,
    workflowRun: {
      conclusion: "failure",
      databaseId: 123,
      headSha: "abc123",
      url: "https://example.test/actions/runs/123",
    },
  });

  assert.equal(row.scenarioComplexity, "complex");
  assert.equal(row.scenarioMutationCount, 3);
  assert.deepEqual(row.expectedRepairFiles, ["src/money.js", "src/shipping.js", "src/tax.js"]);
});

test("benchmark summarizer finds latest attempt for a sha", () => {
  const state = {
    attempts: {
      older: {
        repoSlug: "owner/repo",
        sha: "abc",
        lastSeenAt: "2026-06-30T10:00:00.000Z",
        attempts: 1,
      },
      newer: {
        repoSlug: "owner/repo",
        sha: "abc",
        lastSeenAt: "2026-06-30T10:01:00.000Z",
        attempts: 2,
      },
      other: {
        repoSlug: "owner/repo",
        sha: "def",
        lastSeenAt: "2026-06-30T10:02:00.000Z",
        attempts: 1,
      },
    },
  };

  assert.equal(findAttemptForSha(state, { repoSlug: "owner/repo", sha: "abc" }).attempts, 2);
  assert.equal(findAttemptForSha(state, { repoSlug: "owner/repo", sha: "missing" }), undefined);
  const summary = summarizeRows([
    {
      status: "published_green",
      attemptCount: 2,
      continuationsUsed: 1,
      scenarioComplexity: "complex",
      failedTools: ["edit_repo_file"],
    },
  ]);
  assert.equal(summary.total, 1);
  assert.deepEqual(summary.counts, { published_green: 1 });
  assert.equal(summary.publishedGreen, 1);
  assert.equal(summary.publishedGreenRate, 1);
  assert.equal(summary.averageAttempts, 2);
  assert.equal(summary.averageContinuations, 1);
  assert.deepEqual(summary.byComplexity.complex, {
    total: 1,
    publishedGreen: 1,
    counts: { published_green: 1 },
    publishedGreenRate: 1,
  });
  assert.deepEqual(summary.failedTools, { edit_repo_file: 1 });
});

test("benchmark improvement signals surface non-green patterns", () => {
  assert.deepEqual(summarizeImprovementSignals([{ status: "published_green" }]), [
    "No non-green benchmark samples were recorded.",
  ]);

  const signals = summarizeImprovementSignals([
    {
      status: "agent_completed_without_publish",
      scenarioComplexity: "complex",
      sessionFailureKind: "no_terminal_action",
      failedTools: ["edit_repo_file"],
    },
    {
      status: "published_check_failed",
      scenarioComplexity: "intermediate",
      failedTools: ["edit_repo_file"],
    },
  ]).join("\n");

  assert.match(signals, /ended without a published fix/);
  assert.match(signals, /published fix sample/);
  assert.match(signals, /complex scenarios/);
  assert.match(signals, /stopped without a terminal Hootline action/);
  assert.match(signals, /Most common failed tool: edit_repo_file \(2 occurrence\(s\)\)/);
});

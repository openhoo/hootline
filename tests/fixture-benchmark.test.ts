import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";

// The fixture harness is an executable .mjs script, intentionally outside the
// TypeScript agent build. Import it dynamically for behavioral tests.
// @ts-ignore no declaration file for script module
const scenarioModule = await import("../scripts/fixture-scenarios.mjs");
// @ts-ignore no declaration file for script module
const benchmarkModule = await import("../scripts/fixture-benchmark.mjs");

const {
  SCENARIOS,
  applyScenarioMutation,
  assertScenarioBaseline,
  resolveScenario,
  resolveScenarios,
} = scenarioModule;
const {
  classifyBenchmarkStatus,
  findAttemptForSha,
  summarizeRows,
  summarizeStatusCheckRollup,
} = benchmarkModule;

test("fixture scenarios replace exactly one passing source region", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "hootline-fixture-scenarios-"));
  try {
    for (const scenario of SCENARIOS) {
      const sourcePath = join(tempRoot, scenario.sourcePath);
      mkdirSync(dirname(sourcePath), { recursive: true });
      writeFileSync(sourcePath, `before\n${scenario.passingText}\nafter\n`);

      assert.doesNotThrow(() => assertScenarioBaseline(tempRoot, scenario));
      applyScenarioMutation(tempRoot, scenario);

      const mutated = readFileSync(sourcePath, "utf8");
      assert.equal(mutated.includes(scenario.failingText), true);
      assert.equal(mutated.includes(scenario.passingText), false);
      assert.throws(() => assertScenarioBaseline(tempRoot, scenario), /passing text exactly once/);
    }
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("fixture scenario selection supports all and rejects unknown ids", () => {
  assert.equal(resolveScenario("shipping-threshold-basis").sourcePath, "src/shipping.js");
  assert.equal(resolveScenarios("all").length, SCENARIOS.length);
  assert.deepEqual(
    resolveScenarios("shipping-threshold-basis,percentage-rounding").map(
      (scenario: { id: string }) => scenario.id,
    ),
    ["shipping-threshold-basis", "percentage-rounding"],
  );
  assert.throws(() => resolveScenario("missing"), /Unknown fixture scenario/);
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
  assert.deepEqual(summarizeRows([{ status: "published_green", attemptCount: 2, continuationsUsed: 1 }]), {
    total: 1,
    counts: { published_green: 1 },
    publishedGreen: 1,
    averageAttempts: 2,
    averageContinuations: 1,
  });
});

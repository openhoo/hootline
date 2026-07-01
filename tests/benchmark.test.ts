import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import test from "node:test";

const scenarioModule = await import(new URL("../scripts/fixture-scenarios.mjs", import.meta.url).href);
const benchmarkModule = await import(new URL("../scripts/benchmarks/common.mjs", import.meta.url).href);
const simulatedAppModule = await import(new URL("../scripts/benchmarks/simulated-app.mjs", import.meta.url).href);
const simulatedBenchmarkModule = await import(new URL("../scripts/simulated-benchmark.mjs", import.meta.url).href);
const configModule = await import(new URL("../agent/lib/config.ts", import.meta.url).href);

const {
  SCENARIOS,
  applyScenarioMutation,
  assertScenarioBaseline,
  expectedFixtureFiles,
  scenarioExpectedRepairFiles,
  scenarioMutations,
  scenarioSourcePaths,
  projectIds,
  resolveProjects,
  resolveScenario,
  resolveScenarios,
} = scenarioModule;
const {
  buildBenchmarkRow,
  classifyBenchmarkStatus,
  findAttemptForSha,
  summarizeImprovementSignals,
  summarizeRows,
} = benchmarkModule;
const {
  loadBenchmarkEnvFiles,
  parseDotEnv,
  prepareBenchmarkAppWorkspace,
} = simulatedAppModule;
const {
  buildBenchmarkServerEnv,
  buildFailureLog,
  parseArgs,
  runFixtureCommand,
} = simulatedBenchmarkModule;
const { parseRepoPolicyConfig } = configModule;

function childMarkerCommand(markerPath: string): string {
  const childScript = [
    `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(markerPath)}, "alive"), 250);`,
    "setTimeout(() => {}, 2000);",
  ].join("\n");
  const parentScript = [
    'const { spawn } = require("node:child_process");',
    `const child = spawn(process.execPath, ["-e", ${JSON.stringify(childScript)}], { stdio: "ignore" });`,
    "child.unref();",
    "setTimeout(() => {}, 2000);",
  ].join("\n");
  return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(parentScript)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function restoreScenarioMutation(fixturePath: string, scenario: { id: string }) {
  for (const mutation of scenarioMutations(scenario)) {
    const sourcePath = join(fixturePath, mutation.sourcePath);
    const source = readFileSync(sourcePath, "utf8");
    const count = source.split(mutation.failingText).length - 1;
    assert.equal(count, 1, `${scenario.id} should contain failing text exactly once before restore`);
    writeFileSync(sourcePath, source.replace(mutation.failingText, mutation.passingText));
  }
}

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
  assert.equal(resolveScenario("commerce-domain-shipping-threshold").sourcePath, "packages/domain/src/shipping.ts");
  assert.deepEqual(projectIds(), ["commerce-platform", "support-desk"]);
  assert.deepEqual(
    resolveProjects("support-desk").map((project: { id: string }) => project.id),
    ["support-desk"],
  );
  assert.equal(resolveScenarios("all").length, SCENARIOS.length);
  assert.equal(SCENARIOS.length, 20);
  assert.deepEqual(
    resolveScenarios("commerce-domain-shipping-threshold,commerce-domain-payment-idempotency").map(
      (scenario: { id: string }) => scenario.id,
    ),
    ["commerce-domain-shipping-threshold", "commerce-domain-payment-idempotency"],
  );
  assert.deepEqual(
    resolveScenarios("all", { projects: "support-desk" }).map((scenario: { projectId: string }) => scenario.projectId),
    Array(10).fill("support-desk"),
  );
  assert.throws(() => resolveScenario("missing"), /Unknown fixture scenario/);
  assert.throws(() => resolveProjects("missing"), /Unknown fixture project/);
});

test("complex fixture scenarios expose all mutated and expected repair files", () => {
  const scenario = resolveScenario("commerce-checkout-cascade");
  const support = resolveScenario("support-triage-cascade");

  assert.equal(scenario.projectId, "commerce-platform");
  assert.equal(scenario.complexity, "complex");
  assert.deepEqual(scenarioSourcePaths(scenario), [
    "packages/domain/src/pricing.ts",
    "packages/domain/src/shipping.ts",
    "packages/domain/src/tax.ts",
  ]);
  assert.deepEqual(scenarioExpectedRepairFiles(scenario), [
    "packages/domain/src/pricing.ts",
    "packages/domain/src/shipping.ts",
    "packages/domain/src/tax.ts",
  ]);
  assert.equal(support.projectId, "support-desk");
  assert.equal(support.complexity, "complex");
  assert.equal(scenarioMutations(support).length, 3);
  assert.deepEqual(scenarioSourcePaths(support), [
    "packages/domain/src/workflow.ts",
    "packages/domain/src/routing.ts",
    "packages/domain/src/notifications.ts",
  ]);
  assert.deepEqual(scenarioExpectedRepairFiles(support), [
    "packages/domain/src/workflow.ts",
    "packages/domain/src/routing.ts",
    "packages/domain/src/notifications.ts",
  ]);
});

test("tracked fixture policies and expected files exist and parse", () => {
  const repoRoot = fileURLToPath(new URL("..", import.meta.url));
  for (const relativePath of expectedFixtureFiles()) {
    assert.equal(existsSync(join(repoRoot, relativePath)), true, `${relativePath} should exist`);
  }

  for (const project of resolveProjects("all")) {
    const policyPath = join(repoRoot, project.templatePath, ".hootline.yaml");
    const policy = parseRepoPolicyConfig(readFileSync(policyPath, "utf8"), {
      provider: "github",
      slug: `openhoo/${project.id}`,
    });
    assert.equal(policy.verificationCommands.length > 0, true);
    assert.equal(policy.allowedFileGlobs.length > 0, true);
    assert.deepEqual(policy.sandboxNetworkAllow, ["registry.npmjs.org"]);
  }
});

test("audit redaction fixture keeps the redacted audit event shape explicit", () => {
  const repoRoot = fileURLToPath(new URL("..", import.meta.url));
  const source = readFileSync(
    join(repoRoot, "benchmarks/fixtures/projects/support-desk/packages/domain/src/audit.ts"),
    "utf8",
  );

  assert.match(source, /export interface AuditEvent/u);
  assert.match(source, /internalNote: string \| undefined;/u);
  assert.match(source, /export function recordAuditEvent\(event: AuditInput\): AuditEvent/u);
});

test("simulated benchmark dry-run does not require a server or provider credentials", () => {
  const scriptPath = fileURLToPath(new URL("../scripts/simulated-benchmark.mjs", import.meta.url));
  const repoRoot = fileURLToPath(new URL("..", import.meta.url));
  const tempRoot = mkdtempSync(join(tmpdir(), "hootline-benchmark-dry-run-"));
  const artifactDir = join(tempRoot, "artifacts");
  const output = execFileSync(
    process.execPath,
    [
      scriptPath,
      "--dry-run",
      "--artifact-dir",
      artifactDir,
      "--projects",
      "commerce-platform",
      "--scenarios",
      "commerce-checkout-cascade",
      "--concurrency",
      "2",
      "--repo",
      "owner/simulated",
    ],
    { cwd: repoRoot, encoding: "utf8" },
  );

  assert.match(output, /Mode: dry run/);
  assert.match(output, /Concurrency: 2/);
  assert.match(output, /Projects: commerce-platform/);
  assert.match(output, /commerce-checkout-cascade/);
  assert.match(output, /dry_run: 1/);
  assert.equal(existsSync(artifactDir), false);
  rmSync(tempRoot, { recursive: true, force: true });
});

test("simulated benchmark stages an isolated Eve app workspace without env files", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "hootline-simulated-app-"));
  try {
    const sourceRoot = join(tempRoot, "source");
    const artifactDir = join(tempRoot, "artifacts", "run");
    mkdirSync(join(sourceRoot, "agent"), { recursive: true });
    mkdirSync(join(sourceRoot, "node_modules"), { recursive: true });
    writeFileSync(join(sourceRoot, "agent", "instructions.md"), "Fix the pipeline.\n");
    writeFileSync(join(sourceRoot, "package.json"), JSON.stringify({ scripts: { build: "eve build" } }));
    writeFileSync(join(sourceRoot, "package-lock.json"), "{}\n");
    writeFileSync(join(sourceRoot, "tsconfig.json"), "{}\n");
    writeFileSync(join(sourceRoot, ".env.local"), "HOOTLINE_MODEL_API_KEY=secret\n");
    writeFileSync(join(sourceRoot, "var"), "not copied\n");

    const appRoot = prepareBenchmarkAppWorkspace({ artifactDir, sourceRoot });

    assert.equal(readFileSync(join(appRoot, "agent", "instructions.md"), "utf8"), "Fix the pipeline.\n");
    assert.equal(existsSync(join(appRoot, ".env.local")), false);
    assert.equal(existsSync(join(appRoot, "var")), false);
    assert.equal(lstatSync(join(appRoot, "node_modules")).isSymbolicLink(), true);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("simulated benchmark loads repo env files without overriding caller env", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "hootline-simulated-env-"));
  try {
    writeFileSync(
      join(tempRoot, ".env"),
      [
        "HOOTLINE_MODEL_PROVIDER=anthropic",
        "HOOTLINE_MODEL=from-env",
        "SHELL_DEFINED=from-env-file",
      ].join("\n"),
    );
    writeFileSync(
      join(tempRoot, ".env.local"),
      [
        "HOOTLINE_MODEL=openai-compatible/from-local",
        'QUOTED="line\\nnext"',
        "export SINGLE='literal # value'",
      ].join("\n"),
    );

    const env = loadBenchmarkEnvFiles(tempRoot, { SHELL_DEFINED: "from-shell" });

    assert.equal(env.HOOTLINE_MODEL_PROVIDER, "anthropic");
    assert.equal(env.HOOTLINE_MODEL, "openai-compatible/from-local");
    assert.equal(env.SHELL_DEFINED, "from-shell");
    assert.equal(env.QUOTED, "line\nnext");
    assert.equal(env.SINGLE, "literal # value");
    assert.deepEqual(parseDotEnv("INVALID-LINE\nA=1 # comment\nB=two#kept\n"), {
      A: "1",
      B: "two#kept",
    });
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("tracked simulated fixture is green before each scenario mutation and red after it", () => {
  const repoRoot = fileURLToPath(new URL("..", import.meta.url));
  const tempRoot = mkdtempSync(join(tmpdir(), "hootline-simulated-fixture-"));
  const childEnv = { ...process.env };
  delete childEnv.NODE_TEST_CONTEXT;
  try {
    for (const project of resolveProjects("all")) {
      const repoPath = join(tempRoot, project.id);
      const templatePath = join(repoRoot, project.templatePath);
      cpSync(templatePath, repoPath, { recursive: true });
      const install = spawnSync("bun", ["ci"], {
        cwd: repoPath,
        encoding: "utf8",
        env: childEnv,
        stdio: "pipe",
      });
      assert.equal(
        install.status,
        0,
        `${project.id} install should succeed.\nstdout:\n${install.stdout}\nstderr:\n${install.stderr}`,
      );
      const baseline = spawnSync("bun", ["run", "test"], {
        cwd: repoPath,
        encoding: "utf8",
        env: childEnv,
        stdio: "pipe",
      });
      assert.equal(
        baseline.status,
        0,
        `${project.id} baseline tests should pass.\nstdout:\n${baseline.stdout}\nstderr:\n${baseline.stderr}`,
      );

      for (const scenario of resolveScenarios("all", { projects: project.id })) {
        assertScenarioBaseline(repoPath, scenario);
        applyScenarioMutation(repoPath, scenario);
        const mutated = spawnSync("bun", ["run", "test"], {
          cwd: repoPath,
          encoding: "utf8",
          env: childEnv,
          stdio: "pipe",
        });
        assert.notEqual(
          mutated.status,
          0,
          `${scenario.id} mutation should fail tests.\nstdout:\n${mutated.stdout}\nstderr:\n${mutated.stderr}`,
        );
        restoreScenarioMutation(repoPath, scenario);
      }
    }
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
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
      attempt: { changeNumber: 4 },
      expectedRepairFilesMatch: false,
      prChecks: { conclusion: "success", checks: [] },
      repairResult: { status: "published" },
    }),
    "published_unexpected_files",
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
});

test("simulated failure context does not expose expected repair file oracle", () => {
  const scenario = resolveScenario("commerce-domain-shipping-threshold");
  const log = buildFailureLog(scenario, {
    stdout: "AssertionError: shipping threshold should use subtotal basis",
    stderr: "",
  });

  assert.doesNotMatch(log, /Expected repair files/);
  assert.doesNotMatch(log, /packages\/domain\/src\/shipping\.ts/);
});

test("fixture command runner times out hanging commands", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "hootline-fixture-timeout-"));
  try {
    const result = runFixtureCommand(
      tempRoot,
      [`${JSON.stringify(process.execPath)} -e "setTimeout(() => {}, 1000)"`],
      { timeoutMs: 50 },
    );

    assert.equal(result.status, 1);
    assert.equal(result.timedOut, true);
    assert.equal(result.commands[0]?.status, 124);
    assert.equal(result.commands[0]?.timedOut, true);
    assert.match(result.stderr, /timed out after 50ms/);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("fixture command runner cleans up child processes after timeout", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "hootline-fixture-timeout-tree-"));
  try {
    const markerPath = join(tempRoot, "child-lived");
    const result = runFixtureCommand(tempRoot, [childMarkerCommand(markerPath)], { timeoutMs: 75 });

    assert.equal(result.status, 1);
    assert.equal(result.timedOut, true);
    await sleep(500);
    assert.equal(existsSync(markerPath), false);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("fixture command runner does not classify ordinary SIGTERM exits as timeouts", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "hootline-fixture-signal-"));
  try {
    const result = runFixtureCommand(tempRoot, ["kill -TERM $$"], { timeoutMs: 1_000 });

    assert.equal(result.status, 1);
    assert.equal(result.timedOut, false);
    assert.equal(result.commands[0]?.status, 1);
    assert.equal(result.commands[0]?.timedOut, false);
    assert.doesNotMatch(result.stderr, /timed out/);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("simulated benchmark server env receives fixture command timeout option", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "hootline-benchmark-env-"));
  try {
    const env = buildBenchmarkServerEnv({
      fixtureCommandTimeoutMs: 1234,
      mockModel: true,
      simulatorStatePath: join(tempRoot, "simulator-state.json"),
      sourceRoot: tempRoot,
      statePath: join(tempRoot, "hootline-state.json"),
      webhookSecret: "secret",
    });

    assert.equal(env.HOOTLINE_ALLOW_UNSUPPORTED_SANDBOX_ALLOWLIST_FALLBACK, "allow-all");
    assert.equal(env.HOOTLINE_SIMULATED_FIXTURE_COMMAND_TIMEOUT_MS, "1234");
    assert.equal(env.HOOTLINE_GITHUB_PROVIDER_BACKEND, "simulated");
    assert.equal(env.HOOTLINE_MODEL_PROVIDER, "mock");
    assert.equal(env.HOOTLINE_MODEL, "hootline-simulated-script");
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("simulated benchmark CLI preserves inline values containing equals", () => {
  const parsed = parseArgs([
    "--webhook-secret=a=b==",
    "--server-url",
    "http://127.0.0.1:3000/eve?token=a=b",
  ]);

  assert.equal(parsed.webhookSecret, "a=b==");
  assert.equal(parsed.serverUrl, "http://127.0.0.1:3000/eve?token=a=b");
});

test("benchmark rows retain complex scenario metadata", () => {
  const scenario = resolveScenario("commerce-checkout-cascade");
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
  assert.equal(row.projectId, "commerce-platform");
  assert.equal(row.projectName, "Commerce Platform");
  assert.equal(row.scenarioMutationCount, 3);
  assert.deepEqual(row.expectedRepairFiles, [
    "packages/domain/src/pricing.ts",
    "packages/domain/src/shipping.ts",
    "packages/domain/src/tax.ts",
  ]);
});

test("benchmark rows record the effective model environment", () => {
  const scenario = resolveScenario("commerce-domain-shipping-threshold");
  const row = buildBenchmarkRow({
    inspector: undefined,
    modelEnv: {
      HOOTLINE_MODEL_PROVIDER: "mock",
      HOOTLINE_MODEL: "hootline-simulated-script",
    },
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

  assert.equal(row.modelProvider, "mock");
  assert.equal(row.model, "hootline-simulated-script");
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
      providerErrorRetriesUsed: 1,
      projectId: "commerce-platform",
      scenarioComplexity: "complex",
      scenarioTags: ["shipping", "tax"],
      scenarioMutationCount: 3,
      sessionFailureKind: "provider_error",
      failedTools: ["edit_repo_file"],
    },
  ]);
  assert.equal(summary.total, 1);
  assert.deepEqual(summary.counts, { published_green: 1 });
  assert.equal(summary.publishedGreen, 1);
  assert.equal(summary.publishedGreenRate, 1);
  assert.equal(summary.averageAttempts, 2);
  assert.equal(summary.averageContinuations, 1);
  assert.equal(summary.averageProviderErrorRetries, 1);
  assert.deepEqual(summary.failureKinds, {});
  assert.equal(summary.rowsWithFailedTools, 1);
  assert.deepEqual(summary.byComplexity.complex, {
    total: 1,
    publishedGreen: 1,
    counts: { published_green: 1 },
    publishedGreenRate: 1,
  });
  assert.deepEqual(summary.byProject["commerce-platform"], {
    total: 1,
    publishedGreen: 1,
    counts: { published_green: 1 },
    publishedGreenRate: 1,
  });
  assert.deepEqual(summary.byTag.shipping, {
    total: 1,
    publishedGreen: 1,
    counts: { published_green: 1 },
    publishedGreenRate: 1,
  });
  assert.deepEqual(summary.byTag.tax, {
    total: 1,
    publishedGreen: 1,
    counts: { published_green: 1 },
    publishedGreenRate: 1,
  });
  assert.deepEqual(summary.byMutationCount["3"], {
    total: 1,
    publishedGreen: 1,
    counts: { published_green: 1 },
    publishedGreenRate: 1,
  });
  assert.deepEqual(summary.failedTools, { edit_repo_file: 1 });
  assert.deepEqual(summary.recoveredFailedTools, { edit_repo_file: 1 });
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

  const greenSignals = summarizeImprovementSignals([
    { status: "published_green", failedTools: ["publish_fix", "publish_fix"] },
  ]).join("\n");
  assert.match(greenSignals, /No non-green benchmark samples were recorded/);
  assert.match(greenSignals, /2 recovered tool failure\(s\).*publish_fix \(2 occurrence\(s\)\)/);
});

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";

import { findRepoPolicy, loadConfig } from "../agent/lib/config.ts";

test("loads config defaults and repository overrides", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "hootline-config-"));
  const configPath = join(tempRoot, "pipeline-fixer.yaml");
  const previousState = process.env.PIPELINE_FIXER_STATE;
  process.env.PIPELINE_FIXER_STATE = join(tempRoot, "state.json");
  try {
    writeFileSync(
      configPath,
      [
        "version: 1",
        "statePath: ignored-state.json",
        "defaults:",
        "  mode: pr_mr",
        "  allowedBranches: [main]",
        "  allowedFileGlobs: [src/**]",
        "  verificationCommands: [npm test]",
        "  fixBranchPrefix: hootline/fix",
        "  maxAttemptsPerSha: 2",
        "  maxSnapshotBytes: 1000",
        "  autoMerge:",
        "    requireSuccessfulPipeline: true",
        "    deleteSourceBranch: false",
        "repositories:",
        "  - provider: github",
        "    slug: owner/repo",
        "    mode: auto_merge",
        "    allowedFileGlobs: [src/**, tests/**]",
        "    autoMerge:",
        "      deleteSourceBranch: true",
        "  - provider: gitlab",
        "    slug: group/project",
        "    gitlabProjectId: 123",
        "",
      ].join("\n"),
    );

    const config = loadConfig(configPath);
    const github = findRepoPolicy(config, "github", "owner/repo");
    const gitlab = findRepoPolicy(config, "gitlab", "group/project");

    assert.equal(config.statePath, process.env.PIPELINE_FIXER_STATE);
    assert.equal(github?.mode, "auto_merge");
    assert.deepEqual(github?.allowedFileGlobs, ["src/**", "tests/**"]);
    assert.equal(github?.autoMerge.requireSuccessfulPipeline, true);
    assert.equal(github?.autoMerge.deleteSourceBranch, true);
    assert.equal(gitlab?.mode, "pr_mr");
    assert.equal(gitlab?.gitlabProjectId, "123");
  } finally {
    if (previousState === undefined) {
      delete process.env.PIPELINE_FIXER_STATE;
    } else {
      process.env.PIPELINE_FIXER_STATE = previousState;
    }
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

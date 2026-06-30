import assert from "node:assert/strict";
import test from "node:test";

import {
  loadServiceConfig,
  parseRepoPolicyConfig,
  RepoPolicyConfigError,
} from "../agent/lib/config.ts";

test("loads Hootline service config from HOOTLINE_* env with defaults", () => {
  assert.deepEqual(loadServiceConfig({}), {
    statePath: "var/hootline-state.json",
    repoConfigPath: ".hootline.yaml",
    providerErrorRetries: 2,
    providerErrorRetryBaseMs: 1000,
    providerErrorRetryMaxMs: 15000,
  });

  assert.deepEqual(
    loadServiceConfig({
      HOOTLINE_STATE_PATH: "var/custom-state.json",
      HOOTLINE_REPO_CONFIG_PATH: ".config/hootline.yaml",
      HOOTLINE_PROVIDER_ERROR_RETRIES: "4",
      HOOTLINE_PROVIDER_ERROR_RETRY_BASE_MS: "250",
      HOOTLINE_PROVIDER_ERROR_RETRY_MAX_MS: "5000",
    }),
    {
      statePath: "var/custom-state.json",
      repoConfigPath: ".config/hootline.yaml",
      providerErrorRetries: 4,
      providerErrorRetryBaseMs: 250,
      providerErrorRetryMaxMs: 5000,
    },
  );
  assert.throws(
    () =>
      loadServiceConfig({
        HOOTLINE_PROVIDER_ERROR_RETRY_BASE_MS: "1000",
        HOOTLINE_PROVIDER_ERROR_RETRY_MAX_MS: "500",
      }),
    /HOOTLINE_PROVIDER_ERROR_RETRY_MAX_MS/,
  );
});

test("parses repo-local policy defaults after required guardrails are explicit", () => {
  const policy = parseRepoPolicyConfig(
    [
      "version: 1",
      "allowedBranches: [main]",
      "allowedFileGlobs: [src/**, tests/**]",
      "verificationCommands: [npm test]",
      "autoMerge:",
      "  deleteSourceBranch: true",
      "",
    ].join("\n"),
    { provider: "github", slug: "owner/repo" },
  );

  assert.equal(policy.provider, "github");
  assert.equal(policy.slug, "owner/repo");
  assert.equal(policy.mode, "pr_mr");
  assert.deepEqual(policy.allowedBranches, ["main"]);
  assert.deepEqual(policy.allowedFileGlobs, ["src/**", "tests/**"]);
  assert.deepEqual(policy.verificationCommands, ["npm test"]);
  assert.deepEqual(policy.sandboxNetworkAllow, []);
  assert.equal(policy.fixBranchPrefix, "hootline/fix");
  assert.equal(policy.maxAttemptsPerSha, 2);
  assert.equal(policy.maxSnapshotBytes, 50 * 1024 * 1024);
  assert.equal(policy.autoMerge.requireSuccessfulPipeline, true);
  assert.equal(policy.autoMerge.deleteSourceBranch, true);
});

test("rejects invalid repo-local policy config", () => {
  assert.throws(
    () => parseRepoPolicyConfig("version: 2\n", { provider: "github", slug: "owner/repo" }),
    RepoPolicyConfigError,
  );
  assert.throws(
    () =>
      parseRepoPolicyConfig("version: 1\nmaxAttemptsPerSha: 0\n", {
        provider: "gitlab",
        slug: "group/project",
      }),
    /Repository Hootline config is invalid/,
  );
  assert.throws(
    () => parseRepoPolicyConfig("version: [", { provider: "github", slug: "owner/repo" }),
    /not valid YAML/,
  );
});

test("rejects repo-local policy that omits explicit branch, file, or verification guardrails", () => {
  const identity = { provider: "github" as const, slug: "owner/repo" };

  assert.throws(
    () =>
      parseRepoPolicyConfig(
        [
          "version: 1",
          "allowedFileGlobs: [src/**]",
          "verificationCommands: [npm test]",
          "",
        ].join("\n"),
        identity,
      ),
    /Repository Hootline config is invalid/,
  );
  assert.throws(
    () =>
      parseRepoPolicyConfig(
        [
          "version: 1",
          "allowedBranches: [main]",
          "verificationCommands: [npm test]",
          "",
        ].join("\n"),
        identity,
      ),
    /Repository Hootline config is invalid/,
  );
  assert.throws(
    () =>
      parseRepoPolicyConfig(
        [
          "version: 1",
          "allowedBranches: [main]",
          "allowedFileGlobs: [src/**]",
          "",
        ].join("\n"),
        identity,
      ),
    /Repository Hootline config is invalid/,
  );
});

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";

import type { PipelineFixerConfig, Provider, RepoPolicy } from "./types.ts";

const publishModeSchema = z.enum(["pr_mr", "push_branch", "auto_merge"]);

const autoMergeSchema = z
  .object({
    deleteSourceBranch: z.boolean().default(false),
    requireSuccessfulPipeline: z.boolean().default(true),
  })
  .default({});

const defaultsSchema = z.object({
  mode: publishModeSchema.default("pr_mr"),
  allowedBranches: z.array(z.string().min(1)).default(["*"]),
  allowedFileGlobs: z.array(z.string().min(1)).default(["**"]),
  verificationCommands: z.array(z.string().min(1)).default([]),
  sandboxNetworkAllow: z.array(z.string().min(1)).default([]),
  fixBranchPrefix: z.string().min(1).default("hootline/fix"),
  maxAttemptsPerSha: z.number().int().positive().default(2),
  maxSnapshotBytes: z.number().int().positive().default(50 * 1024 * 1024),
  autoMerge: autoMergeSchema,
  allowGitlabSecretTokenFallback: z.boolean().default(false),
});

const repoSchema = z.object({
  provider: z.enum(["github", "gitlab"]),
  slug: z.string().min(1),
  mode: publishModeSchema.optional(),
  allowedBranches: z.array(z.string().min(1)).optional(),
  allowedFileGlobs: z.array(z.string().min(1)).optional(),
  verificationCommands: z.array(z.string().min(1)).optional(),
  sandboxNetworkAllow: z.array(z.string().min(1)).optional(),
  fixBranchPrefix: z.string().min(1).optional(),
  maxAttemptsPerSha: z.number().int().positive().optional(),
  maxSnapshotBytes: z.number().int().positive().optional(),
  autoMerge: autoMergeSchema.optional(),
  gitlabProjectId: z.union([z.string(), z.number()]).optional(),
  allowGitlabSecretTokenFallback: z.boolean().optional(),
});

const configSchema = z.object({
  version: z.literal(1),
  statePath: z.string().min(1).default("var/pipeline-fixer-state.json"),
  defaults: defaultsSchema.default({}),
  repositories: z.array(repoSchema).default([]),
});

type ConfigDefaults = z.infer<typeof defaultsSchema>;
type RepoInput = z.infer<typeof repoSchema>;

export function loadConfig(path = process.env.PIPELINE_FIXER_CONFIG): PipelineFixerConfig {
  const configPath = resolve(path ?? "config/pipeline-fixer.yaml");
  const parsed = configSchema.parse(parse(readFileSync(configPath, "utf8")) ?? {});
  const repositories = parsed.repositories.map((repo) => buildRepoPolicy(parsed.defaults, repo));

  return {
    version: parsed.version,
    statePath: process.env.PIPELINE_FIXER_STATE ?? parsed.statePath,
    defaults: parsed.defaults,
    repositories,
  };
}

export function findRepoPolicy(config: PipelineFixerConfig, provider: Provider, slug: string): RepoPolicy | undefined {
  return config.repositories.find((repo) => repo.provider === provider && repo.slug === slug);
}

function buildRepoPolicy(defaults: ConfigDefaults, repo: RepoInput): RepoPolicy {
  const policy: RepoPolicy = {
    provider: repo.provider,
    slug: repo.slug,
    mode: repo.mode ?? defaults.mode,
    allowedBranches: repo.allowedBranches ?? defaults.allowedBranches,
    allowedFileGlobs: repo.allowedFileGlobs ?? defaults.allowedFileGlobs,
    verificationCommands: repo.verificationCommands ?? defaults.verificationCommands,
    sandboxNetworkAllow: repo.sandboxNetworkAllow ?? defaults.sandboxNetworkAllow,
    fixBranchPrefix: repo.fixBranchPrefix ?? defaults.fixBranchPrefix,
    maxAttemptsPerSha: repo.maxAttemptsPerSha ?? defaults.maxAttemptsPerSha,
    maxSnapshotBytes: repo.maxSnapshotBytes ?? defaults.maxSnapshotBytes,
    autoMerge: { ...defaults.autoMerge, ...(repo.autoMerge ?? {}) },
    allowGitlabSecretTokenFallback:
      repo.allowGitlabSecretTokenFallback ?? defaults.allowGitlabSecretTokenFallback,
  };
  if (repo.gitlabProjectId !== undefined) policy.gitlabProjectId = String(repo.gitlabProjectId);
  return policy;
}

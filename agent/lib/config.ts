import { parse } from "yaml";
import { z } from "zod";

import type { HootlineServiceConfig, Provider, RepoPolicy } from "./types.ts";

const publishModeSchema = z.enum(["pr_mr", "push_branch", "auto_merge"]);
const nonEmptyStringArraySchema = z.array(z.string().min(1)).min(1);

const autoMergeSchema = z
  .object({
    deleteSourceBranch: z.boolean().default(false),
    requireSuccessfulPipeline: z.boolean().default(true),
  })
  .default({ deleteSourceBranch: false, requireSuccessfulPipeline: true });

const repoPolicyFieldsSchema = z.object({
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

const repoPolicyConfigSchema = repoPolicyFieldsSchema.extend({
  version: z.literal(1),
  allowedBranches: nonEmptyStringArraySchema,
  allowedFileGlobs: nonEmptyStringArraySchema,
  verificationCommands: nonEmptyStringArraySchema,
});

export const repoPolicySchema = repoPolicyFieldsSchema.extend({
  provider: z.enum(["github", "gitlab"]),
  slug: z.string().min(1),
});

export class RepoPolicyConfigError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RepoPolicyConfigError";
  }
}

export function loadServiceConfig(env: NodeJS.ProcessEnv = process.env): HootlineServiceConfig {
  return {
    statePath: readNonEmpty(env.HOOTLINE_STATE_PATH) ?? "var/hootline-state.json",
    repoConfigPath: readNonEmpty(env.HOOTLINE_REPO_CONFIG_PATH) ?? ".hootline.yaml",
  };
}

export function parseRepoPolicyConfig(
  text: string,
  input: { provider: Provider; slug: string },
): RepoPolicy {
  let value: unknown;
  try {
    value = parse(text) ?? {};
  } catch (error) {
    throw new RepoPolicyConfigError("Repository Hootline config is not valid YAML.", { cause: error });
  }

  const parsed = repoPolicyConfigSchema.safeParse(value);
  if (!parsed.success) {
    throw new RepoPolicyConfigError(`Repository Hootline config is invalid: ${parsed.error.message}`, {
      cause: parsed.error,
    });
  }

  return {
    provider: input.provider,
    slug: input.slug,
    mode: parsed.data.mode,
    allowedBranches: parsed.data.allowedBranches,
    allowedFileGlobs: parsed.data.allowedFileGlobs,
    verificationCommands: parsed.data.verificationCommands,
    sandboxNetworkAllow: parsed.data.sandboxNetworkAllow,
    fixBranchPrefix: parsed.data.fixBranchPrefix,
    maxAttemptsPerSha: parsed.data.maxAttemptsPerSha,
    maxSnapshotBytes: parsed.data.maxSnapshotBytes,
    autoMerge: parsed.data.autoMerge,
    allowGitlabSecretTokenFallback: parsed.data.allowGitlabSecretTokenFallback,
  };
}

function readNonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === "" ? undefined : trimmed;
}

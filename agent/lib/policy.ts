import { findRepoPolicy, loadConfig } from "./config.ts";
import { matchesAnyPattern } from "./glob.ts";
import type { NormalizedPipelineEvent, RepoPolicy } from "./types.ts";

export function requirePolicy(event: NormalizedPipelineEvent): RepoPolicy {
  const config = loadConfig();
  const policy = findRepoPolicy(config, event.provider, event.repoSlug);
  if (policy === undefined) {
    throw new Error(`No policy configured for ${event.provider}:${event.repoSlug}.`);
  }
  return policy;
}

export function assertEventAllowedByPolicy(event: NormalizedPipelineEvent, policy: RepoPolicy): void {
  if (!matchesAnyPattern(event.ref, policy.allowedBranches)) {
    throw new Error(`Ref ${event.ref} is not allowed for ${event.provider}:${event.repoSlug}.`);
  }
}

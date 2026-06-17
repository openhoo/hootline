import { matchesAnyPattern } from "./glob.ts";
import type { NormalizedPipelineEvent, RepoPolicy } from "./types.ts";

export function assertEventAllowedByPolicy(event: NormalizedPipelineEvent, policy: RepoPolicy): void {
  if (!matchesAnyPattern(event.ref, policy.allowedBranches)) {
    throw new Error(`Ref ${event.ref} is not allowed for ${event.provider}:${event.repoSlug}.`);
  }
}

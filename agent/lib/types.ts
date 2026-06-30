export type Provider = "github" | "gitlab";

export type PublishMode = "pr_mr" | "push_branch" | "auto_merge";

export interface AutoMergePolicy {
  deleteSourceBranch: boolean;
  requireSuccessfulPipeline: boolean;
}

export interface RepoPolicy {
  provider: Provider;
  slug: string;
  mode: PublishMode;
  allowedBranches: readonly string[];
  allowedFileGlobs: readonly string[];
  verificationCommands: readonly string[];
  sandboxNetworkAllow: readonly string[];
  fixBranchPrefix: string;
  maxAttemptsPerSha: number;
  maxSnapshotBytes: number;
  autoMerge: AutoMergePolicy;
  allowGitlabSecretTokenFallback: boolean;
}

export interface HootlineServiceConfig {
  statePath: string;
  repoConfigPath: string;
  providerErrorRetries: number;
  providerErrorRetryBaseMs: number;
  providerErrorRetryMaxMs: number;
}

export interface NormalizedPipelineEvent {
  provider: Provider;
  id: string;
  deliveryId: string;
  repoSlug: string;
  projectId?: string | undefined;
  installationId?: number | undefined;
  pipelineId: string;
  pipelineUrl?: string | undefined;
  runId?: string | undefined;
  checkSuiteId?: string | undefined;
  ref: string;
  sha: string;
  source: string;
  status: string;
  conclusion: string;
  actor?: string | undefined;
  pullRequestNumber?: number | undefined;
  mergeRequestIid?: number | undefined;
  sourceBranch?: string | undefined;
  targetBranch?: string | undefined;
  eventName: string;
  receivedAt: string;
}

export interface FailedJobLog {
  id: string;
  name: string;
  url?: string | undefined;
  conclusion?: string | undefined;
  status?: string | undefined;
  log: string;
}

export interface FailureContext {
  event: NormalizedPipelineEvent;
  jobs: readonly FailedJobLog[];
  summary: string;
}

export interface SandboxChange {
  status: "added" | "modified" | "deleted";
  path: string;
  contentBase64?: string;
}

export interface PublishInput {
  event: NormalizedPipelineEvent;
  policy: RepoPolicy;
  changes: readonly SandboxChange[];
  summary: string;
}

export interface MergeChangeInput {
  event: NormalizedPipelineEvent;
  changeNumber: number;
  branch: string;
  deleteSourceBranch: boolean;
  expectedCommitSha?: string | undefined;
}

export interface PublishResult {
  provider: Provider;
  mode: PublishMode;
  branch: string;
  commitSha?: string | undefined;
  changeNumber?: number | undefined;
  changeUrl?: string | undefined;
  merged?: boolean | undefined;
  message: string;
}

export interface RerunRequestRecord {
  id: string;
  requestedAt: string;
  reason: string;
  completedAt?: string | undefined;
  result?: unknown;
  failedAt?: string | undefined;
  error?: string | undefined;
}

export type RepairSessionStatus = "running" | "completed" | "waiting" | "failed" | "abandoned";

export type RepairSessionFailureKind =
  | "length"
  | "no_terminal_action"
  | "human_input_requested"
  | "provider_error"
  | "stream_error"
  | "timeout";

export interface AttemptRecord {
  key: string;
  provider: Provider;
  repoSlug: string;
  sha: string;
  pipelineId: string;
  event: NormalizedPipelineEvent;
  policy: RepoPolicy;
  attempts: number;
  firstSeenAt: string;
  lastSeenAt: string;
  dispatchedAt?: string | undefined;
  lastSessionId?: string | undefined;
  lastSessionStatus?: RepairSessionStatus | undefined;
  lastSessionFinishReason?: string | undefined;
  lastSessionFailureKind?: RepairSessionFailureKind | undefined;
  lastSessionFailure?: string | undefined;
  lastSessionEndedAt?: string | undefined;
  lastToolSequence?: string[] | undefined;
  lastFailedTools?: string[] | undefined;
  lastTerminalAction?: string | undefined;
  lastInputTokens?: number | undefined;
  lastOutputTokens?: number | undefined;
  lastEventsSeen?: number | undefined;
  continuationsUsed?: number | undefined;
  providerErrorRetriesUsed?: number | undefined;
  repoStagedAt?: string | undefined;
  repoStagedFiles?: number | undefined;
  repoStagedBytes?: number | undefined;
  lastFailureContext?: FailureContext | { error: string } | undefined;
  lastVerification?: unknown;
  lastPublishResult?: PublishResult | undefined;
  publishedBranch?: string | undefined;
  changeUrl?: string | undefined;
  changeNumber?: number | undefined;
  pendingAutoMerge?: boolean | undefined;
  rerunRequests?: RerunRequestRecord[] | undefined;
}

export interface PipelineFixerState {
  processedDeliveries: Record<string, string>;
  attempts: Record<string, AttemptRecord>;
}

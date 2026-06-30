import { createHash, randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import * as tar from "tar";

import { validateChangesAgainstPolicy } from "../sandbox.ts";
import type {
  FailedJobLog,
  FailureContext,
  MergeChangeInput,
  NormalizedPipelineEvent,
  PublishInput,
  PublishResult,
  SandboxChange,
} from "../types.ts";
import { buildFixBranchName, type ProviderClient } from "./common.ts";

interface SimulatedBenchmarkState {
  samples?: Record<string, SimulatedSampleRecord> | undefined;
  pullRequests?: Record<string, SimulatedPullRequestRecord> | undefined;
  nextPullRequestNumber?: number | undefined;
  comments?: SimulatedCommentRecord[] | undefined;
  reruns?: SimulatedRerunRecord[] | undefined;
  merges?: SimulatedMergeRecord[] | undefined;
}

interface SimulatedSampleRecord {
  repoSlug: string;
  sha: string;
  defaultBranch?: string | undefined;
  worktreePath: string;
  policyPath?: string | undefined;
  scenarioId?: string | undefined;
  failureContext?: {
    summary?: string | undefined;
    jobs?: FailedJobLog[] | undefined;
  } | undefined;
  mockRepairPlan?: SimulatedTextMutation[] | undefined;
}

interface SimulatedTextMutation {
  sourcePath: string;
  passingText: string;
  failingText: string;
}

interface SimulatedPullRequestRecord {
  provider: "github";
  repoSlug: string;
  scenarioId?: string | undefined;
  number: number;
  url: string;
  branch: string;
  baseRef: string;
  headSha: string;
  sourceSha: string;
  summary: string;
  state: "open" | "merged";
  merged: boolean;
  createdAt: string;
  updatedAt: string;
  changes: Array<{ path: string; status: SandboxChange["status"] }>;
  checks: SimulatedCheckRecord[];
  checkConclusion: "success" | "failure";
}

interface SimulatedCheckRecord {
  name: string;
  status: "COMPLETED";
  conclusion: "SUCCESS" | "FAILURE";
  exitCode: number;
  timedOut?: boolean | undefined;
  stdout: string;
  stderr: string;
}

interface SimulatedCommentRecord {
  repoSlug: string;
  sha: string;
  body: string;
  postedAt: string;
}

interface SimulatedRerunRecord {
  repoSlug: string;
  sha: string;
  requestedAt: string;
}

interface SimulatedMergeRecord {
  repoSlug: string;
  number: number;
  branch: string;
  mergedAt: string;
}

const MAX_CHECK_OUTPUT_CHARS = 6_000;
const DEFAULT_SIMULATED_CHECK_TIMEOUT_MS = 60_000;

export class SimulatedGitHubProvider implements ProviderClient {
  async readRepositoryFileFromDefaultBranch(
    event: NormalizedPipelineEvent,
    path: string,
  ): Promise<string | null> {
    const sample = readSample(event);
    const absolute = resolveSafePath(sample.worktreePath, path);
    if (!existsSync(absolute)) return null;
    return readFileSync(absolute, "utf8");
  }

  async getFailureContext(event: NormalizedPipelineEvent): Promise<FailureContext> {
    const sample = readSample(event);
    const jobs = sample.failureContext?.jobs ?? [
      {
        id: event.runId ?? event.pipelineId,
        name: "simulated-test",
        conclusion: "failure",
        status: "completed",
        log: `Simulated GitHub Actions failure for ${event.repoSlug}@${event.sha}.`,
      },
    ];
    return {
      event,
      jobs,
      summary:
        sample.failureContext?.summary ??
        `Simulated GitHub workflow failed with ${jobs.length} failed job(s).`,
    };
  }

  async downloadArchive(event: NormalizedPipelineEvent, maxSnapshotBytes: number): Promise<Buffer> {
    const sample = readSample(event);
    const archive = await createArchive(sample.worktreePath);
    if (archive.byteLength > maxSnapshotBytes) {
      throw new Error(
        `Simulated archive is ${archive.byteLength} bytes, above policy limit ${maxSnapshotBytes}.`,
      );
    }
    return archive;
  }

  async publishFix(input: PublishInput): Promise<PublishResult> {
    validateChangesAgainstPolicy(input.changes, input.policy);
    const sample = readSample(input.event);
    const branch = buildFixBranchName(input.policy.fixBranchPrefix, input.event);
    const checkRoot = materializeCheckRoot(sample);
    try {
      applyChanges(checkRoot, input.changes);
      const checks = runVerificationCommands(checkRoot, input.policy.verificationCommands);
      const checkConclusion = checks.every((check) => check.conclusion === "SUCCESS")
        ? "success"
        : "failure";
      const commitSha = simulatedCommitSha(input.event, input.changes, input.summary);
      const now = new Date().toISOString();

      if (input.policy.mode !== "push_branch") {
        const record = updateSimulatorState((state) => {
          const number = state.nextPullRequestNumber ?? 1;
          const nextRecord: SimulatedPullRequestRecord = {
            provider: "github",
            repoSlug: input.event.repoSlug,
            scenarioId: sample.scenarioId,
            number,
            url: `https://simulated.github.local/${input.event.repoSlug}/pull/${number}`,
            branch,
            baseRef: input.event.sourceBranch ?? input.event.ref,
            headSha: commitSha,
            sourceSha: input.event.sha,
            summary: input.summary,
            state: "open",
            merged: false,
            createdAt: now,
            updatedAt: now,
            changes: input.changes.map((change) => ({ path: change.path, status: change.status })),
            checks,
            checkConclusion,
          };
          state.pullRequests = {
            ...(state.pullRequests ?? {}),
            [pullRequestKey(input.event.repoSlug, number)]: nextRecord,
          };
          state.nextPullRequestNumber = number + 1;
          return nextRecord;
        });
        return {
          provider: "github",
          mode: input.policy.mode,
          branch,
          commitSha,
          changeNumber: record.number,
          changeUrl: record.url,
          message: `Published simulated fix PR #${record.number}: ${record.url}`,
        };
      }

      return {
        provider: "github",
        mode: input.policy.mode,
        branch,
        commitSha,
        message: `Pushed simulated fix commit ${commitSha} to ${branch}.`,
      };
    } finally {
      rmSync(checkRoot, { recursive: true, force: true });
    }
  }

  async postComment(event: NormalizedPipelineEvent, body: string): Promise<void> {
    updateSimulatorState((state) => {
      state.comments = [
        ...(state.comments ?? []),
        { repoSlug: event.repoSlug, sha: event.sha, body, postedAt: new Date().toISOString() },
      ];
    });
  }

  async rerunPipeline(event: NormalizedPipelineEvent): Promise<{ message: string }> {
    updateSimulatorState((state) => {
      state.reruns = [
        ...(state.reruns ?? []),
        { repoSlug: event.repoSlug, sha: event.sha, requestedAt: new Date().toISOString() },
      ];
    });
    return { message: `Requested simulated rerun of workflow run ${event.runId ?? event.pipelineId}.` };
  }

  async mergeChange(input: MergeChangeInput): Promise<PublishResult> {
    const now = new Date().toISOString();
    const merged = updateSimulatorState((state) => {
      const key = pullRequestKey(input.event.repoSlug, input.changeNumber);
      const existing = state.pullRequests?.[key];
      if (existing === undefined) {
        throw new Error(`Simulated PR #${input.changeNumber} does not exist.`);
      }
      const nextRecord: SimulatedPullRequestRecord = {
        ...existing,
        state: "merged",
        merged: true,
        updatedAt: now,
      };
      state.pullRequests = { ...(state.pullRequests ?? {}), [key]: nextRecord };
      state.merges = [
        ...(state.merges ?? []),
        { repoSlug: input.event.repoSlug, number: input.changeNumber, branch: input.branch, mergedAt: now },
      ];
      return nextRecord;
    });
    return {
      provider: "github",
      mode: "auto_merge",
      branch: input.branch,
      commitSha: merged.headSha,
      changeNumber: input.changeNumber,
      changeUrl: merged.url,
      merged: true,
      message: `Merged simulated GitHub PR #${input.changeNumber}.`,
    };
  }
}

function readSample(event: NormalizedPipelineEvent): SimulatedSampleRecord {
  const state = loadSimulatorState();
  const sample = state.samples?.[sampleKey(event.repoSlug, event.sha)];
  if (sample === undefined) {
    throw new Error(`No simulated benchmark sample exists for ${event.repoSlug}@${event.sha}.`);
  }
  return sample;
}

function loadSimulatorState(): SimulatedBenchmarkState {
  return loadSimulatorStateUnlocked();
}

function updateSimulatorState<T>(mutator: (state: SimulatedBenchmarkState) => T): T {
  return withSimulatorStateLock(() => {
    const state = loadSimulatorStateUnlocked();
    const result = mutator(state);
    saveSimulatorStateUnlocked(state);
    return result;
  });
}

function loadSimulatorStateUnlocked(): SimulatedBenchmarkState {
  const statePath = readSimulatorStatePath();
  try {
    const parsed = JSON.parse(readFileSync(statePath, "utf8")) as unknown;
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as SimulatedBenchmarkState;
    }
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return { samples: {}, pullRequests: {}, nextPullRequestNumber: 1 };
    }
    throw error;
  }
  throw new Error(`Simulated benchmark state is not a JSON object: ${statePath}`);
}

function saveSimulatorStateUnlocked(state: SimulatedBenchmarkState): void {
  const statePath = readSimulatorStatePath();
  mkdirSync(dirname(statePath), { recursive: true });
  const tempPath = `${statePath}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tempPath, statePath);
}

function withSimulatorStateLock<T>(callback: () => T): T {
  const lockPath = `${readSimulatorStatePath()}.lock`;
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      mkdirSync(lockPath);
      break;
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST" || Date.now() > deadline) {
        throw error;
      }
      sleepSync(25);
    }
  }
  try {
    return callback();
  } finally {
    rmSync(lockPath, { recursive: true, force: true });
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function readSimulatorStatePath(): string {
  const value = process.env.HOOTLINE_SIMULATOR_STATE_PATH?.trim();
  if (value === undefined || value === "") {
    throw new Error(
      "HOOTLINE_SIMULATOR_STATE_PATH is required when HOOTLINE_GITHUB_PROVIDER_BACKEND=simulated.",
    );
  }
  return resolve(value);
}

async function createArchive(repoRoot: string): Promise<Buffer> {
  const tempRoot = mkdtempSync(join(tmpdir(), "hootline-simulated-archive-"));
  try {
    const archiveRootName = "snapshot";
    const archiveRoot = join(tempRoot, archiveRootName);
    const archivePath = join(tempRoot, "repo.tar.gz");
    cpSync(repoRoot, archiveRoot, {
      recursive: true,
      filter: (source) => !source.split(sep).includes("node_modules") && !source.split(sep).includes(".git"),
    });
    await tar.c(
      {
        cwd: tempRoot,
        file: archivePath,
        gzip: true,
        portable: true,
      },
      [archiveRootName],
    );
    return readFileSync(archivePath);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

function materializeCheckRoot(sample: SimulatedSampleRecord): string {
  const root = mkdtempSync(join(tmpdir(), "hootline-simulated-check-"));
  cpSync(sample.worktreePath, root, {
    recursive: true,
    filter: (source) => !source.split(sep).includes("node_modules") && !source.split(sep).includes(".git"),
  });
  return root;
}

function applyChanges(root: string, changes: readonly SandboxChange[]): void {
  for (const change of changes) {
    const target = resolveSafePath(root, change.path);
    if (change.status === "deleted") {
      rmSync(target, { force: true });
      continue;
    }
    if (change.contentBase64 === undefined) {
      throw new Error(`Simulated publish received a non-deleted change without content: ${change.path}`);
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, Buffer.from(change.contentBase64, "base64"));
  }
}

function runVerificationCommands(root: string, commands: readonly string[]): SimulatedCheckRecord[] {
  return commands.map((command) => {
    const timeoutMs = readSimulatedCheckTimeoutMs();
    const result = spawnSync("bash", ["-lc", `set -euo pipefail; ${command}`], {
      cwd: root,
      detached: true,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      stdio: "pipe",
      timeout: timeoutMs,
    } as SpawnSyncOptionsWithStringEncoding & { detached: boolean });
    const timedOut = isSpawnTimeout(result.error);
    if (timedOut) terminateProcessGroup(result.pid);
    const exitCode = timedOut ? 124 : typeof result.status === "number" ? result.status : 1;
    const stderr = [
      result.stderr ?? "",
      timedOut ? `Command timed out after ${timeoutMs}ms.` : "",
    ].filter(Boolean).join("\n");
    return {
      name: command,
      status: "COMPLETED",
      conclusion: exitCode === 0 ? "SUCCESS" : "FAILURE",
      exitCode,
      timedOut,
      stdout: capText(result.stdout),
      stderr: capText(stderr),
    };
  });
}

function isSpawnTimeout(error: Error | undefined): boolean {
  return error !== undefined && "code" in error && error.code === "ETIMEDOUT";
}

function terminateProcessGroup(pid: number | undefined): void {
  if (pid === undefined || !Number.isSafeInteger(pid) || pid <= 0) return;
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    return;
  }
  sleepSync(100);
  try {
    process.kill(-pid, 0);
    process.kill(-pid, "SIGKILL");
  } catch {
    // The process group already exited after SIGTERM.
  }
}

function readSimulatedCheckTimeoutMs(): number {
  const configured = process.env.HOOTLINE_SIMULATED_FIXTURE_COMMAND_TIMEOUT_MS;
  if (configured === undefined || configured.trim() === "") return DEFAULT_SIMULATED_CHECK_TIMEOUT_MS;
  const parsed = Number(configured);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_SIMULATED_CHECK_TIMEOUT_MS;
}

function simulatedCommitSha(
  event: NormalizedPipelineEvent,
  changes: readonly SandboxChange[],
  summary: string,
): string {
  const hash = createHash("sha1");
  hash.update(event.sha);
  hash.update(summary);
  for (const change of changes) {
    hash.update(change.status);
    hash.update(change.path);
    hash.update(change.contentBase64 ?? "");
  }
  return hash.digest("hex");
}

function resolveSafePath(root: string, relativePath: string): string {
  if (relativePath.startsWith("/") || relativePath.includes("\0") || relativePath.includes("\\")) {
    throw new Error(`Unsafe simulated repository path: ${JSON.stringify(relativePath)}`);
  }
  const rootPath = resolve(root);
  const absolute = resolve(rootPath, relativePath);
  if (absolute !== rootPath && !absolute.startsWith(`${rootPath}${sep}`)) {
    throw new Error(`Simulated repository path escapes the worktree: ${JSON.stringify(relativePath)}`);
  }
  return absolute;
}

function sampleKey(repoSlug: string, sha: string): string {
  return `${repoSlug}@${sha}`;
}

function pullRequestKey(repoSlug: string, number: number): string {
  return `${repoSlug}#${number}`;
}

function capText(value: string | undefined): string {
  const text = value ?? "";
  return text.length > MAX_CHECK_OUTPUT_CHARS
    ? `${text.slice(0, MAX_CHECK_OUTPUT_CHARS)}\n[truncated]`
    : text;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

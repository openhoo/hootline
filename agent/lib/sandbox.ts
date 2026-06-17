import { posix as pathPosix } from "node:path";

import type { SandboxSession } from "eve/sandbox";

import { matchesAnyPattern } from "./glob.ts";
import { redact } from "./redact.ts";
import type { AttemptRecord, RepoPolicy, SandboxChange } from "./types.ts";
import { isRecord } from "./unknown.ts";

const SNAPSHOT_MARKER_PATH = ".hootline/staged-repository.json";
const MAX_COMMAND_LENGTH = 500;
const MAX_VERIFICATION_STREAM_CHARS = 6_000;

interface VerificationCommandResult {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

interface VerificationResult {
  ok: boolean;
  results: VerificationCommandResult[];
  networkPolicy?: {
    verificationPolicy: "deny-all" | "allowlist";
    applied: boolean;
    restoredDenyAll: boolean;
    error?: string;
    restoreError?: string;
  };
}

type NetworkPolicyStatus = NonNullable<VerificationResult["networkPolicy"]>;

type SandboxChangeSession = Pick<SandboxSession, "run" | "readBinaryFile">;
type SandboxVerificationSession = Pick<SandboxSession, "run" | "setNetworkPolicy">;
type SandboxMarkerWriter = Pick<SandboxSession, "id" | "run" | "writeTextFile">;
type SandboxMarkerReader = Pick<SandboxSession, "id" | "run" | "readTextFile">;
type SandboxNetworkPolicySession = Pick<SandboxSession, "setNetworkPolicy">;

export function validateChangesAgainstPolicy(
  changes: readonly SandboxChange[],
  policy: RepoPolicy,
): void {
  for (const change of changes) {
    const path = normalizeRepoPath(change.path);
    if (!matchesAnyPattern(path, policy.allowedFileGlobs)) {
      throw new Error(`Changed path is not allowed by policy: ${path}`);
    }
  }
}

export async function collectSandboxChanges(
  sandbox: SandboxChangeSession,
  policy: RepoPolicy,
): Promise<SandboxChange[]> {
  const status = await sandbox.run({
    command: "git -C repo status --porcelain=v1 -z --untracked-files=all",
  });
  const exitCode = typeof status.exitCode === "number" ? status.exitCode : 0;
  if (exitCode !== 0) {
    throw new Error(`Unable to inspect staged repository changes: ${redact(String(status.stderr ?? ""))}`);
  }
  const changes: SandboxChange[] = [];
  let changedBytes = 0;
  for (const parsed of parseGitStatusEntries(String(status.stdout ?? ""))) {
    const path = normalizeRepoPath(parsed.path);
    if (!matchesAnyPattern(path, policy.allowedFileGlobs)) {
      throw new Error(`Changed path is not allowed by policy: ${path}`);
    }
    if (parsed.status === "deleted") {
      changes.push({ status: "deleted", path });
      continue;
    }
    const content = await sandbox.readBinaryFile({ path: `repo/${path}` });
    if (content === null) {
      throw new Error(`Changed file could not be read from sandbox: ${path}`);
    }
    changedBytes += content.byteLength;
    if (changedBytes > policy.maxSnapshotBytes) {
      throw new Error(
        `Changed file payload is ${changedBytes} bytes, above policy limit ${policy.maxSnapshotBytes}.`,
      );
    }
    changes.push({
      status: parsed.status,
      path,
      contentBase64: Buffer.from(content).toString("base64"),
    });
  }
  return changes;
}

export async function runVerificationCommands(
  sandbox: Pick<SandboxSession, "run">,
  commands: readonly string[],
): Promise<VerificationResult> {
  const results: VerificationCommandResult[] = [];
  for (const command of commands) {
    assertSafeVerificationCommand(command);
    const result = await sandbox.run({ command: buildRepoCommand(command) });
    const exitCode = typeof result.exitCode === "number" ? result.exitCode : 0;
    const stdout = capModelVisibleText(String(result.stdout ?? ""));
    const stderr = capModelVisibleText(String(result.stderr ?? ""));
    results.push({
      command: redact(command, MAX_COMMAND_LENGTH),
      exitCode,
      stdout: stdout.value,
      stderr: stderr.value,
      stdoutTruncated: stdout.truncated,
      stderrTruncated: stderr.truncated,
    });
    if (exitCode !== 0) return { ok: false, results };
  }
  return { ok: true, results };
}

export async function runVerificationCommandsWithPolicy(
  sandbox: SandboxVerificationSession,
  policy: RepoPolicy,
): Promise<VerificationResult> {
  const networkPolicy: NetworkPolicyStatus = {
    verificationPolicy: policy.sandboxNetworkAllow.length === 0 ? "deny-all" : "allowlist",
    applied: false,
    restoredDenyAll: false,
  };
  try {
    await applySandboxNetworkPolicy(sandbox, policy);
    networkPolicy.applied = true;
  } catch (error) {
    return {
      ok: false,
      results: [],
      networkPolicy: {
        ...networkPolicy,
        error: formatNetworkPolicyError("apply", error),
      },
    };
  }

  let result: VerificationResult;
  try {
    result = await runVerificationCommands(sandbox, policy.verificationCommands);
  } catch (error) {
    result = {
      ok: false,
      results: [
        {
          command: "[harness]",
          exitCode: 1,
          stdout: "",
          stderr: redact(error instanceof Error ? error.message : String(error), MAX_VERIFICATION_STREAM_CHARS),
          stdoutTruncated: false,
          stderrTruncated: false,
        },
      ],
    };
  } finally {
    try {
      await sandbox.setNetworkPolicy("deny-all");
      networkPolicy.restoredDenyAll = true;
    } catch (error) {
      networkPolicy.restoreError = formatNetworkPolicyError("restore deny-all", error);
    }
  }

  return {
    ...result,
    ok: result.ok && networkPolicy.restoredDenyAll,
    networkPolicy,
  };
}

export async function writeSnapshotMarker(sandbox: SandboxMarkerWriter, attempt: AttemptRecord): Promise<void> {
  await sandbox.run({ command: "mkdir -p .hootline" });
  await sandbox.writeTextFile({
    path: SNAPSHOT_MARKER_PATH,
    content: `${JSON.stringify(snapshotMarker(attempt, sandbox.id))}\n`,
  });
}

export async function assertSandboxSnapshotReady(
  sandbox: SandboxMarkerReader,
  attempt: AttemptRecord,
): Promise<void> {
  let markerText: string | null | undefined;
  try {
    markerText = await sandbox.readTextFile({ path: SNAPSHOT_MARKER_PATH });
  } catch {
    markerText = undefined;
  }
  if (typeof markerText !== "string") {
    throw new Error("Repository snapshot marker is missing. Call stage_repository_snapshot first.");
  }
  let marker: unknown;
  try {
    marker = JSON.parse(markerText);
  } catch {
    throw new Error("Repository snapshot marker is invalid. Call stage_repository_snapshot again.");
  }
  const expected = snapshotMarker(attempt, sandbox.id);
  if (!isMatchingSnapshotMarker(marker, expected)) {
    throw new Error("Repository snapshot marker does not match the current attempt. Restage the repository.");
  }
  const gitCheck = await sandbox.run({
    command: "git -C repo rev-parse --is-inside-work-tree >/dev/null 2>&1",
  });
  const exitCode = typeof gitCheck.exitCode === "number" ? gitCheck.exitCode : 0;
  if (exitCode !== 0) {
    throw new Error("Staged repository is missing or is not a git work tree. Restage the repository.");
  }
}

export async function applySandboxNetworkPolicy(
  sandbox: SandboxNetworkPolicySession,
  policy: RepoPolicy,
): Promise<void> {
  if (policy.sandboxNetworkAllow.length === 0) {
    await sandbox.setNetworkPolicy("deny-all");
    return;
  }
  await sandbox.setNetworkPolicy({ allow: [...policy.sandboxNetworkAllow] });
}

function parseGitStatusEntries(output: string): Array<{ status: "added" | "modified" | "deleted"; path: string }> {
  const records = output.split("\0").filter((record) => record.length > 0);
  const entries: Array<{ status: "added" | "modified" | "deleted"; path: string }> = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index] ?? "";
    if (record.length < 4) continue;
    const code = record.slice(0, 2);
    const rawPath = record.slice(3);
    const status = statusFromPorcelainCode(code);
    if (status === null) continue;
    if (code.startsWith("R") || code.startsWith("C")) {
      index += 1;
      entries.push({ status, path: rawPath });
      continue;
    }
    entries.push({ status, path: rawPath });
  }
  return entries;
}

function statusFromPorcelainCode(code: string): "added" | "modified" | "deleted" | null {
  if (code.includes("D")) return "deleted";
  if (code.includes("A") || code.includes("?")) return "added";
  if (code.trim().length > 0) return "modified";
  return null;
}

function normalizeRepoPath(path: string): string {
  if (path.length === 0 || path.startsWith("/") || path.includes("\0")) {
    throw new Error(`Invalid changed path from sandbox git status: ${JSON.stringify(path)}`);
  }
  if (path.includes("\\")) {
    throw new Error(`Changed path contains a backslash and is not portable: ${JSON.stringify(path)}`);
  }
  const normalized = pathPosix.normalize(path);
  if (
    normalized === "." ||
    normalized !== path ||
    normalized.startsWith("../") ||
    normalized.includes("/../") ||
    normalized.split("/").includes(".git")
  ) {
    throw new Error(`Changed path escapes repository policy boundaries: ${JSON.stringify(path)}`);
  }
  return normalized;
}

function assertSafeVerificationCommand(command: string): void {
  if (command.length === 0 || command.length > MAX_COMMAND_LENGTH) {
    throw new Error(`Verification command length must be between 1 and ${MAX_COMMAND_LENGTH} characters.`);
  }
  if (/[\0\r\n]/.test(command)) {
    throw new Error("Verification command must be a single-line command without NUL bytes.");
  }
}

function buildRepoCommand(command: string): string {
  return `bash -lc ${shellQuote(`set -euo pipefail; cd "$1"; shift; ${command}`)} -- /workspace/repo`;
}

function capModelVisibleText(value: string): { value: string; truncated: boolean } {
  const redacted = redact(value, MAX_VERIFICATION_STREAM_CHARS);
  return {
    value: redacted,
    truncated: value.length > MAX_VERIFICATION_STREAM_CHARS,
  };
}

function snapshotMarker(attempt: AttemptRecord, sandboxId: string): Record<string, string> {
  return {
    attemptKey: attempt.key,
    provider: attempt.provider,
    repoSlug: attempt.repoSlug,
    sha: attempt.sha,
    pipelineId: attempt.pipelineId,
    sandboxId,
  };
}

function isMatchingSnapshotMarker(marker: unknown, expected: Record<string, string>): boolean {
  if (!isRecord(marker)) return false;
  return Object.entries(expected).every(([key, value]) => marker[key] === value);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function formatNetworkPolicyError(action: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redact(`Sandbox backend could not ${action} network policy: ${message}`);
}

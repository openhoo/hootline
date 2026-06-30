import { posix as pathPosix } from "node:path";

import type { SandboxSession } from "eve/sandbox";

import { matchesAnyPattern } from "./glob.ts";
import { createLogger } from "./logger.ts";
import { redact } from "./redact.ts";
import type { AttemptRecord, RepoPolicy, SandboxChange } from "./types.ts";
import { isRecord } from "./unknown.ts";

const log = createLogger("lib.sandbox");

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
type SandboxTextEditSession = Pick<SandboxSession, "readTextFile" | "writeTextFile">;
type SandboxVerificationSession = Pick<SandboxSession, "run" | "setNetworkPolicy">;
type SandboxMarkerWriter = Pick<SandboxSession, "id" | "run" | "writeTextFile">;
type SandboxMarkerReader = Pick<SandboxSession, "id" | "run" | "readTextFile">;
type SandboxNetworkPolicySession = Pick<SandboxSession, "setNetworkPolicy">;

export interface SandboxTextReplacement {
  path: string;
  expected: string;
  replacement: string;
}

export interface SandboxTextReplacementResult {
  path: string;
  replacements: number;
  beforeBytes: number;
  afterBytes: number;
  matchStrategy: "exact" | "indentation_insensitive";
}

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

export async function replaceSandboxText(
  sandbox: SandboxTextEditSession,
  policy: RepoPolicy,
  edit: SandboxTextReplacement,
): Promise<SandboxTextReplacementResult> {
  const path = normalizeRepoEditPath(edit.path);
  if (!matchesAnyPattern(path, policy.allowedFileGlobs)) {
    throw new Error(`Edit path is not allowed by policy: ${path}`);
  }
  if (edit.expected.length === 0) {
    throw new Error("expected text must not be empty.");
  }
  if (edit.expected === edit.replacement) {
    throw new Error("replacement text must differ from expected text.");
  }

  let current: string | null | undefined;
  try {
    current = await sandbox.readTextFile({ path: `repo/${path}` });
  } catch {
    current = undefined;
  }
  if (typeof current !== "string") {
    throw new Error(`Repository file does not exist or is not readable as text: ${path}`);
  }

  const matches = countOccurrences(current, edit.expected);
  let next: string;
  let matchStrategy: SandboxTextReplacementResult["matchStrategy"] = "exact";
  if (matches === 1) {
    next = current.replace(edit.expected, edit.replacement);
  } else if (matches === 0) {
    const fallback = replaceIndentationInsensitiveBlock(current, edit.expected, edit.replacement);
    if (fallback === undefined) {
      throw new Error(`expected text must occur exactly once in ${path}; found ${matches}.`);
    }
    next = fallback.content;
    matchStrategy = "indentation_insensitive";
  } else {
    throw new Error(`expected text must occur exactly once in ${path}; found ${matches}.`);
  }
  const beforeBytes = Buffer.byteLength(current, "utf8");
  const afterBytes = Buffer.byteLength(next, "utf8");
  if (afterBytes > policy.maxSnapshotBytes) {
    throw new Error(`Edited file is ${afterBytes} bytes, above policy limit ${policy.maxSnapshotBytes}.`);
  }

  await sandbox.writeTextFile({ path: `repo/${path}`, content: next });
  return { path, replacements: 1, beforeBytes, afterBytes, matchStrategy };
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
    // Trace which command ran and its exit code; never log captured stdout/stderr.
    log.debug({ command: redact(command, MAX_COMMAND_LENGTH), exitCode }, "verification command finished");
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
    const message = formatNetworkPolicyError("apply", error);
    log.warn(
      { verificationPolicy: networkPolicy.verificationPolicy, detail: message },
      "sandbox network policy apply failed; skipping verification",
    );
    return {
      ok: false,
      results: [],
      networkPolicy: {
        ...networkPolicy,
        error: message,
      },
    };
  }

  let result: VerificationResult;
  try {
    result = await runVerificationCommands(sandbox, policy.verificationCommands);
  } catch (error) {
    log.warn({ err: error }, "verification command runner threw before completion");
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
      const message = formatNetworkPolicyError("restore deny-all", error);
      // Security-relevant: the sandbox may retain network access if this fails.
      log.warn({ detail: message }, "failed to restore deny-all sandbox network policy after verification");
      networkPolicy.restoreError = message;
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

function normalizeRepoEditPath(path: string): string {
  const candidate = stripRepoEditPrefix(path);
  if (candidate.length === 0 || candidate.startsWith("/") || candidate.includes("\0")) {
    throw new Error(`Invalid repository edit path: ${JSON.stringify(path)}`);
  }
  if (candidate.includes("\\")) {
    throw new Error(`Repository edit path contains a backslash and is not portable: ${JSON.stringify(path)}`);
  }
  const normalized = pathPosix.normalize(candidate);
  if (
    normalized === "." ||
    normalized !== candidate ||
    normalized.startsWith("../") ||
    normalized.includes("/../") ||
    normalized.split("/").includes(".git")
  ) {
    throw new Error(`Repository edit path escapes policy boundaries: ${JSON.stringify(path)}`);
  }
  return normalized;
}

function stripRepoEditPrefix(path: string): string {
  if (path === "/workspace/repo" || path === "repo") return "";
  if (path.startsWith("/workspace/repo/")) return path.slice("/workspace/repo/".length);
  if (path.startsWith("repo/")) return path.slice("repo/".length);
  return path;
}

function countOccurrences(value: string, needle: string): number {
  let count = 0;
  let index = value.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = value.indexOf(needle, index + needle.length);
  }
  return count;
}

function replaceIndentationInsensitiveBlock(
  current: string,
  expected: string,
  replacement: string,
): { content: string } | undefined {
  const expectedLines = splitLogicalLines(expected);
  const replacementLines = splitLogicalLines(replacement);
  if (
    expectedLines.length === 0 ||
    replacementLines.length !== expectedLines.length ||
    expectedLines.some((line) => line.text.trim().length === 0)
  ) {
    return undefined;
  }

  const currentLines = splitLogicalLines(current);
  const candidates: Array<{ start: number; end: number }> = [];
  for (let index = 0; index <= currentLines.length - expectedLines.length; index += 1) {
    const matches = expectedLines.every((expectedLine, offset) => {
      const currentLine = currentLines[index + offset];
      return currentLine !== undefined && currentLine.text.trim() === expectedLine.text.trim();
    });
    if (matches) candidates.push({ start: index, end: index + expectedLines.length });
  }
  if (candidates.length !== 1) return undefined;

  const candidate = candidates[0];
  if (candidate === undefined) return undefined;
  const adjustedReplacement = replacementLines.map((replacementLine, offset) => {
    const currentLine = currentLines[candidate.start + offset];
    const expectedLine = expectedLines[offset];
    if (currentLine === undefined || expectedLine === undefined) return replacementLine.raw;
    return `${adjustIndentation(replacementLine.text, expectedLine.text, currentLine.text)}${currentLine.eol}`;
  });

  const before = currentLines.slice(0, candidate.start).map((line) => line.raw).join("");
  const after = currentLines.slice(candidate.end).map((line) => line.raw).join("");
  return { content: `${before}${adjustedReplacement.join("")}${after}` };
}

interface LogicalLine {
  raw: string;
  text: string;
  eol: string;
}

function splitLogicalLines(value: string): LogicalLine[] {
  if (value.length === 0) return [];
  const lines: LogicalLine[] = [];
  const pattern = /([^\r\n]*)(\r\n|\n|\r|$)/g;
  for (;;) {
    const match = pattern.exec(value);
    if (match === null) break;
    const text = match[1] ?? "";
    const eol = match[2] ?? "";
    if (text.length === 0 && eol.length === 0 && pattern.lastIndex >= value.length) break;
    lines.push({ raw: `${text}${eol}`, text, eol });
    if (eol.length === 0) break;
  }
  return lines;
}

function adjustIndentation(replacementLine: string, expectedLine: string, currentLine: string): string {
  const expectedIndent = leadingWhitespace(expectedLine);
  const replacementIndent = leadingWhitespace(replacementLine);
  const currentIndent = leadingWhitespace(currentLine);
  const replacementBody = replacementLine.slice(replacementIndent.length);
  if (replacementIndent.startsWith(expectedIndent)) {
    return `${currentIndent}${replacementIndent.slice(expectedIndent.length)}${replacementBody}`;
  }
  return `${currentIndent}${replacementLine.trimStart()}`;
}

function leadingWhitespace(value: string): string {
  return value.match(/^\s*/)?.[0] ?? "";
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

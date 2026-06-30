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
type SandboxTextEditSession = Pick<SandboxSession, "readTextFile" | "writeTextFile" | "run">;
type SandboxPathResolutionSession = Pick<SandboxSession, "run" | "readTextFile">;
type SandboxVerificationSession = Pick<SandboxSession, "run" | "setNetworkPolicy">;
type SandboxMarkerWriter = Pick<SandboxSession, "id" | "run" | "writeTextFile">;
type SandboxMarkerReader = Pick<SandboxSession, "id" | "run" | "readTextFile">;
type SandboxNetworkPolicySession = Pick<SandboxSession, "setNetworkPolicy">;

export interface SandboxTextReplacement {
  path: string;
  expected: string;
  replacement: string;
}

export interface SandboxTextReplacementCandidate {
  key?: string | undefined;
  text: string;
}

export interface SandboxTextReplacementWithCandidates {
  path: string;
  expected: string;
  replacements: readonly SandboxTextReplacementCandidate[];
}

export interface SandboxLineReplacement {
  path: string;
  startLine: number;
  endLine: number;
  replacement: string;
  expected?: string | undefined;
}

export interface SandboxTextReplacementResult {
  path: string;
  replacements: number;
  beforeBytes: number;
  afterBytes: number;
  matchStrategy:
    | "exact"
    | "fenced_code_block"
    | "line_number_prefix_stripped"
    | "line_endings_normalized"
    | "escaped_sequences_decoded"
    | "indentation_insensitive"
    | "line_range";
  replacementKey?: string | undefined;
  pathCorrection?: SandboxRepoPathCorrection | undefined;
}

export interface SandboxRepoPathResolution {
  path: string;
  correction?: SandboxRepoPathCorrection | undefined;
}

export interface SandboxRepoPathCorrection {
  originalPath: string;
  correctedPath: string;
  strategy: "normalized" | "case_insensitive" | "unique_suffix" | "fuzzy";
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
  return replaceSandboxTextWithCandidates(sandbox, policy, {
    path: edit.path,
    expected: edit.expected,
    replacements: [{ text: edit.replacement }],
  });
}

export async function replaceSandboxTextWithCandidates(
  sandbox: SandboxTextEditSession,
  policy: RepoPolicy,
  edit: SandboxTextReplacementWithCandidates,
): Promise<SandboxTextReplacementResult> {
  const resolvedPath = await resolveSandboxRepoPath(sandbox, edit.path);
  const path = resolvedPath.path;
  if (!matchesAnyPattern(path, policy.allowedFileGlobs)) {
    throw new Error(`Edit path is not allowed by policy: ${path}`);
  }
  if (edit.expected.length === 0) {
    throw new Error("expected text must not be empty.");
  }
  if (edit.replacements.length === 0) {
    throw new Error("replacement text is required.");
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

  const replacement = buildTextReplacementFromCandidates(current, edit.expected, edit.replacements, path);
  const next = replacement.content;
  const matchStrategy = replacement.strategy;
  if (next === current) {
    throw new Error("replacement text must differ from expected text.");
  }
  const beforeBytes = Buffer.byteLength(current, "utf8");
  const afterBytes = Buffer.byteLength(next, "utf8");
  if (afterBytes > policy.maxSnapshotBytes) {
    throw new Error(`Edited file is ${afterBytes} bytes, above policy limit ${policy.maxSnapshotBytes}.`);
  }

  await sandbox.writeTextFile({ path: `repo/${path}`, content: next });
  return {
    path,
    replacements: 1,
    beforeBytes,
    afterBytes,
    matchStrategy,
    replacementKey: replacement.replacementKey,
    pathCorrection: resolvedPath.correction,
  };
}

export async function replaceSandboxLines(
  sandbox: SandboxTextEditSession,
  policy: RepoPolicy,
  edit: SandboxLineReplacement,
): Promise<SandboxTextReplacementResult> {
  const resolvedPath = await resolveSandboxRepoPath(sandbox, edit.path);
  const path = resolvedPath.path;
  if (!matchesAnyPattern(path, policy.allowedFileGlobs)) {
    throw new Error(`Edit path is not allowed by policy: ${path}`);
  }
  if (!Number.isInteger(edit.startLine) || !Number.isInteger(edit.endLine)) {
    throw new Error("startLine and endLine must be integers.");
  }
  if (edit.startLine < 1 || edit.endLine < edit.startLine) {
    throw new Error("Line range must be 1-based and startLine must be <= endLine.");
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

  const currentLines = splitLogicalLines(current);
  if (edit.endLine > currentLines.length) {
    throw new Error(`Line range ${edit.startLine}-${edit.endLine} is outside ${path}; file has ${currentLines.length} lines.`);
  }
  const startIndex = edit.startLine - 1;
  const selected = currentLines.slice(startIndex, edit.endLine).map((line) => line.raw).join("");
  if (edit.expected !== undefined && selected !== normalizeLineEndings(edit.expected, dominantEol(current))) {
    throw new Error(`Expected text did not match current ${path} lines ${edit.startLine}-${edit.endLine}.`);
  }

  const eol = dominantEol(current);
  const replacement = normalizeLineEndings(decodeEscapedText(edit.replacement) ?? edit.replacement, eol);
  const before = currentLines.slice(0, startIndex).map((line) => line.raw).join("");
  const after = currentLines.slice(edit.endLine).map((line) => line.raw).join("");
  const next = `${before}${replacement}${after}`;
  if (next === current) {
    throw new Error("replacement text must change the selected line range.");
  }

  const beforeBytes = Buffer.byteLength(current, "utf8");
  const afterBytes = Buffer.byteLength(next, "utf8");
  if (afterBytes > policy.maxSnapshotBytes) {
    throw new Error(`Edited file is ${afterBytes} bytes, above policy limit ${policy.maxSnapshotBytes}.`);
  }

  await sandbox.writeTextFile({ path: `repo/${path}`, content: next });
  return {
    path,
    replacements: 1,
    beforeBytes,
    afterBytes,
    matchStrategy: "line_range",
    pathCorrection: resolvedPath.correction,
  };
}

export async function resolveSandboxRepoPath(
  sandbox: SandboxPathResolutionSession,
  rawPath: string,
): Promise<SandboxRepoPathResolution> {
  const normalized = normalizeRepoEditPathForgiving(rawPath);
  if (await sandboxRepoTextFileExists(sandbox, normalized.path)) return normalized;

  const files = await listSandboxRepoFiles(sandbox);
  const corrected = chooseRepoPathCorrection(normalized.path, files);
  if (corrected === undefined) {
    throw new Error(`Repository file does not exist or is not readable as text: ${normalized.path}`);
  }
  return {
    path: corrected.path,
    correction: {
      originalPath: rawPath,
      correctedPath: corrected.path,
      strategy: corrected.strategy,
    },
  };
}

export function normalizeWorkspaceRepoPath(rawPath: string): SandboxRepoPathResolution {
  const original = rawPath;
  let candidate = stripMatchingQuotes(rawPath.trim());
  rejectWindowsAbsoluteRepoPath(candidate);
  candidate = candidate.replaceAll("\\", "/").replace(/\/+/g, "/").replace(/\/+$/u, "");
  if (candidate === "." || candidate === "./" || candidate === "repo" || candidate === "/workspace/repo") {
    return {
      path: "/workspace/repo",
      correction:
        candidate === original
          ? undefined
          : { originalPath: original, correctedPath: "/workspace/repo", strategy: "normalized" },
    };
  }
  const normalized = normalizeRepoEditPathForgiving(rawPath);
  return {
    path: `/workspace/repo/${normalized.path}`,
    correction:
      normalized.correction === undefined
        ? undefined
        : {
            ...normalized.correction,
            correctedPath: `/workspace/repo/${normalized.path}`,
          },
  };
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

function normalizeRepoEditPathForgiving(path: string): SandboxRepoPathResolution {
  const original = path;
  let candidate = stripMatchingQuotes(path.trim());
  rejectWindowsAbsoluteRepoPath(candidate);
  candidate = candidate.replaceAll("\\", "/");
  candidate = stripLineSuffix(candidate);
  candidate = candidate.replace(/\/+/g, "/");
  candidate = stripRepoEditPrefix(candidate);
  while (candidate.startsWith("./")) candidate = candidate.slice(2);
  const normalized = normalizeRepoEditPath(candidate);
  if (normalized === original) return { path: normalized };
  return {
    path: normalized,
    correction: {
      originalPath: original,
      correctedPath: normalized,
      strategy: "normalized",
    },
  };
}

function rejectWindowsAbsoluteRepoPath(path: string): void {
  if (/^[A-Za-z]:[\\/]/u.test(path)) {
    throw new Error(`Invalid repository edit path: ${JSON.stringify(path)}`);
  }
}

function stripMatchingQuotes(value: string): string {
  if (value.length < 2) return value;
  const first = value[0];
  const last = value[value.length - 1];
  if ((first === `"` && last === `"`) || (first === "'" && last === "'") || (first === "`" && last === "`")) {
    return value.slice(1, -1).trim();
  }
  return value;
}

function stripLineSuffix(value: string): string {
  return value.replace(/:(?:\d+)(?::\d+)?$/u, "");
}

async function sandboxRepoTextFileExists(sandbox: SandboxPathResolutionSession, path: string): Promise<boolean> {
  try {
    return typeof (await sandbox.readTextFile({ path: `repo/${path}` })) === "string";
  } catch {
    return false;
  }
}

async function listSandboxRepoFiles(sandbox: SandboxPathResolutionSession): Promise<string[]> {
  const result = await sandbox.run({
    command: "find repo -type f -not -path 'repo/.git/*' -print0",
  });
  const exitCode = typeof result.exitCode === "number" ? result.exitCode : 0;
  if (exitCode !== 0) return [];
  return String(result.stdout ?? "")
    .split("\0")
    .filter((path) => path.startsWith("repo/"))
    .map((path) => path.slice("repo/".length))
    .filter((path) => path.length > 0 && !path.split("/").includes(".git"));
}

function chooseRepoPathCorrection(
  targetPath: string,
  files: readonly string[],
): { path: string; strategy: SandboxRepoPathCorrection["strategy"] } | undefined {
  const targetLower = targetPath.toLowerCase();
  const targetBase = pathPosix.basename(targetPath).toLowerCase();
  const targetDir = pathPosix.dirname(targetPath).toLowerCase();
  const targetExt = pathPosix.extname(targetPath).toLowerCase();
  const scored = files
    .map((file) => {
      const lower = file.toLowerCase();
      const base = pathPosix.basename(file).toLowerCase();
      const dir = pathPosix.dirname(file).toLowerCase();
      if (lower === targetLower) return { path: file, score: 100, strategy: "case_insensitive" as const };
      if (lower.endsWith(`/${targetLower}`)) return { path: file, score: 96, strategy: "unique_suffix" as const };
      if (base === targetBase) {
        const dirDistance = levenshteinDistance(dir, targetDir);
        return { path: file, score: 90 - Math.min(dirDistance, 10), strategy: "unique_suffix" as const };
      }
      const fullDistance = levenshteinDistance(lower, targetLower);
      const fullLimit = Math.max(2, Math.floor(targetLower.length * 0.1));
      if (fullDistance <= fullLimit) {
        return { path: file, score: 86 - fullDistance, strategy: "fuzzy" as const };
      }
      const baseDistance = levenshteinDistance(base, targetBase);
      if (targetExt.length > 0 && pathPosix.extname(file).toLowerCase() === targetExt && baseDistance <= 2) {
        const dirMatches = dir === targetDir || dir.endsWith(`/${targetDir}`) || targetDir.endsWith(`/${dir}`);
        if (dirMatches) return { path: file, score: 82 - baseDistance, strategy: "fuzzy" as const };
      }
      return { path: file, score: 0, strategy: "fuzzy" as const };
    })
    .filter((candidate) => candidate.score >= 80)
    .sort((left, right) => right.score - left.score);

  const best = scored[0];
  if (best === undefined) return undefined;
  const second = scored[1];
  if (second !== undefined && best.score - second.score < 5) return undefined;
  return { path: best.path, strategy: best.strategy };
}

function levenshteinDistance(left: string, right: string): number {
  if (left === right) return 0;
  if (left.length === 0) return right.length;
  if (right.length === 0) return left.length;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 0; leftIndex < left.length; leftIndex += 1) {
    const current = [leftIndex + 1];
    for (let rightIndex = 0; rightIndex < right.length; rightIndex += 1) {
      const cost = left[leftIndex] === right[rightIndex] ? 0 : 1;
      const insertion = (current[rightIndex] ?? Number.MAX_SAFE_INTEGER) + 1;
      const deletion = (previous[rightIndex + 1] ?? Number.MAX_SAFE_INTEGER) + 1;
      const substitution = (previous[rightIndex] ?? Number.MAX_SAFE_INTEGER) + cost;
      current[rightIndex + 1] = Math.min(
        insertion,
        deletion,
        substitution,
      );
    }
    previous = current;
  }
  return previous[right.length] ?? Number.MAX_SAFE_INTEGER;
}

function buildTextReplacement(
  current: string,
  expected: string,
  replacement: string,
  path: string,
): {
  content: string;
  strategy: SandboxTextReplacementResult["matchStrategy"];
} {
  for (const variant of buildTextReplacementVariants(current, expected, replacement)) {
    if (variant.expected.length === 0) continue;
    if (variant.expected === variant.replacement) continue;
    const matches = countOccurrences(current, variant.expected);
    if (matches === 1) {
      return {
        content: current.replace(variant.expected, variant.replacement),
        strategy: variant.strategy,
      };
    }
    if (matches > 1) {
      throw new Error(`expected text must occur exactly once in ${path}; found ${matches}.`);
    }
  }

  for (const variant of buildTextReplacementVariants(current, expected, replacement)) {
    if (variant.expected.length === 0) continue;
    if (variant.expected === variant.replacement) continue;
    const fallback = replaceIndentationInsensitiveBlock(current, variant.expected, variant.replacement);
    if (fallback !== undefined) {
      return { content: fallback.content, strategy: "indentation_insensitive" };
    }
  }

  throw new Error(`expected text must occur exactly once in ${path}; found 0.`);
}

function buildTextReplacementFromCandidates(
  current: string,
  expected: string,
  replacements: readonly SandboxTextReplacementCandidate[],
  path: string,
): {
  content: string;
  strategy: SandboxTextReplacementResult["matchStrategy"];
  replacementKey?: string | undefined;
} {
  const candidates = dedupeReplacementCandidates(replacements);
  if (candidates.length === 0) throw new Error("replacement text is required.");

  const matches: Array<{
    content: string;
    strategy: SandboxTextReplacementResult["matchStrategy"];
    replacementKey?: string | undefined;
  }> = [];
  let firstRecoverableError: Error | undefined;
  let firstError: Error | undefined;

  for (const candidate of candidates) {
    try {
      const planned = buildTextReplacement(current, expected, candidate.text, path);
      if (planned.content === current) {
        firstError ??= new Error("replacement text must differ from expected text.");
        continue;
      }
      matches.push({
        ...planned,
        replacementKey: candidate.key,
      });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      firstError ??= err;
      if (isTextMatchError(err)) firstRecoverableError ??= err;
    }
  }

  const distinctMatches = dedupeTextReplacementMatches(matches);
  if (distinctMatches.length === 1) return distinctMatches[0]!;
  if (distinctMatches.length > 1) {
    const keys = distinctMatches.map((match) => match.replacementKey ?? "replacement").join(", ");
    throw new Error(`Replacement aliases produced multiple valid edits for ${path}: ${keys}.`);
  }
  throw firstRecoverableError ?? firstError ?? new Error("replacement text is required.");
}

function dedupeReplacementCandidates(
  candidates: readonly SandboxTextReplacementCandidate[],
): SandboxTextReplacementCandidate[] {
  const deduped: SandboxTextReplacementCandidate[] = [];
  for (const candidate of candidates) {
    if (deduped.some((existing) => existing.text === candidate.text)) continue;
    deduped.push(candidate);
  }
  return deduped;
}

function dedupeTextReplacementMatches(
  matches: Array<{
    content: string;
    strategy: SandboxTextReplacementResult["matchStrategy"];
    replacementKey?: string | undefined;
  }>,
): Array<{
  content: string;
  strategy: SandboxTextReplacementResult["matchStrategy"];
  replacementKey?: string | undefined;
}> {
  const distinct: typeof matches = [];
  for (const match of matches) {
    if (distinct.some((existing) => existing.content === match.content)) continue;
    distinct.push(match);
  }
  return distinct;
}

function isTextMatchError(error: Error): boolean {
  return /^expected text must occur exactly once in .+; found \d+\.$/.test(error.message);
}

function buildTextReplacementVariants(
  current: string,
  expected: string,
  replacement: string,
): Array<{
  expected: string;
  replacement: string;
  strategy: SandboxTextReplacementResult["matchStrategy"];
}> {
  const variants: Array<{
    expected: string;
    replacement: string;
    strategy: SandboxTextReplacementResult["matchStrategy"];
  }> = [];
  const addVariant = (
    nextExpected: string,
    nextReplacement: string,
    strategy: SandboxTextReplacementResult["matchStrategy"],
  ) => {
    if (
      variants.some(
        (variant) =>
          variant.expected === nextExpected &&
          variant.replacement === nextReplacement &&
          variant.strategy === strategy,
      )
    ) {
      return;
    }
    variants.push({ expected: nextExpected, replacement: nextReplacement, strategy });
  };

  const decodedExpected = decodeEscapedText(expected);
  const decodedReplacement = decodeEscapedText(replacement);
  if (decodedReplacement !== undefined && shouldPreferDecodedReplacement(current, expected, replacement)) {
    addVariant(expected, decodedReplacement, "escaped_sequences_decoded");
  }
  if (decodedExpected !== undefined || decodedReplacement !== undefined) {
    addVariant(
      decodedExpected ?? expected,
      decodedReplacement ?? replacement,
      "escaped_sequences_decoded",
    );
  }

  addVariant(expected, replacement, "exact");
  for (const transformed of [
    { values: stripMarkdownFencePair(expected, replacement), strategy: "fenced_code_block" as const },
    {
      values: stripNumberedLinePrefixPair(expected, replacement),
      strategy: "line_number_prefix_stripped" as const,
    },
    {
      values: stripNumberedLinePrefixPair(...stripMarkdownFencePair(expected, replacement)),
      strategy: "line_number_prefix_stripped" as const,
    },
  ]) {
    const [nextExpected, nextReplacement] = transformed.values;
    addVariant(nextExpected, nextReplacement, transformed.strategy);
  }

  const eol = dominantEol(current);
  for (const variant of [...variants]) {
    const eolExpected = normalizeLineEndings(variant.expected, eol);
    const eolReplacement = normalizeLineEndings(variant.replacement, eol);
    if (eolExpected !== variant.expected || eolReplacement !== variant.replacement) {
      addVariant(eolExpected, eolReplacement, "line_endings_normalized");
    }
  }
  return variants;
}

function decodeEscapedText(value: string): string | undefined {
  if (!hasEscapedLineBreak(value)) return undefined;
  const decoded = value
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\"/g, '"')
    .replace(/\\'/g, "'");
  return decoded === value ? undefined : decoded;
}

function hasEscapedLineBreak(value: string): boolean {
  return /\\(?:r\\n|n|r)/u.test(value);
}

function shouldPreferDecodedReplacement(current: string, expected: string, replacement: string): boolean {
  if (!hasEscapedLineBreak(replacement)) return false;
  if (countOccurrences(current, expected) !== 1) return false;
  if (/[\r\n]/u.test(replacement)) return false;
  return /[\r\n]/u.test(expected) || /\\(?:r\\n|n|r)[ \t]*(?:[A-Za-z_$()[\]{}./"'`]|$)/u.test(replacement);
}

function stripMarkdownFencePair(expected: string, replacement: string): [string, string] {
  return [stripMarkdownFence(expected), stripMarkdownFence(replacement)];
}

function stripMarkdownFence(value: string): string {
  const trimmed = value.trim();
  const match = /^```[^\r\n]*\r?\n([\s\S]*?)\r?\n```$/u.exec(trimmed);
  return match?.[1] ?? value;
}

function stripNumberedLinePrefixPair(expected: string, replacement: string): [string, string] {
  return [stripNumberedLinePrefixes(expected), stripNumberedLinePrefixes(replacement)];
}

function stripNumberedLinePrefixes(value: string): string {
  const lines = splitLogicalLines(value);
  if (lines.length === 0) return value;
  const nonBlank = lines.filter((line) => line.text.trim().length > 0);
  if (nonBlank.length === 0 || !nonBlank.every((line) => /^\s*\d+:\s?/u.test(line.text))) return value;
  return lines.map((line) => `${line.text.replace(/^\s*\d+:\s?/u, "")}${line.eol}`).join("");
}

function dominantEol(value: string): "\r\n" | "\n" {
  const crlf = (value.match(/\r\n/g) ?? []).length;
  const lf = (value.match(/(?<!\r)\n/g) ?? []).length;
  return crlf > lf ? "\r\n" : "\n";
}

function normalizeLineEndings(value: string, eol: "\r\n" | "\n"): string {
  return value.replace(/\r\n|\r|\n/g, eol);
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

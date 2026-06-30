import { redact } from "./redact.ts";
import { isRecord, readNumber, readString } from "./unknown.ts";

const MODEL_TEXT_CHARS = 1_200;

export function verificationModelOutput(output: unknown): { type: "json"; value: unknown } {
  if (!isRecord(output)) return { type: "json", value: output ?? null };
  const results = Array.isArray(output.results) ? output.results : [];
  return {
    type: "json",
    value: {
      ok: output.ok === true,
      results: results.map((entry) => summarizeVerificationCommand(entry)),
      networkPolicy: output.networkPolicy,
    },
  };
}

export function publishModelOutput(output: unknown): { type: "json"; value: unknown } {
  if (!isRecord(output)) return { type: "json", value: output ?? null };
  return {
    type: "json",
    value: {
      published: output.published === true,
      reason: readString(output.reason),
      result: output.result,
      changes: output.changes,
      verification: verificationModelOutput(output.verification).value,
    },
  };
}

export function failureContextModelOutput(output: unknown): { type: "json"; value: unknown } {
  if (!isRecord(output)) return { type: "json", value: output ?? null };
  const jobs = Array.isArray(output.jobs) ? output.jobs : [];
  return {
    type: "json",
    value: {
      summary: compactText(readString(output.summary) ?? ""),
      jobs: jobs.map((job) => summarizeJob(job)),
    },
  };
}

export function compactText(value: string, maxChars = MODEL_TEXT_CHARS): string {
  const redacted = redact(value, maxChars * 2);
  if (redacted.length <= maxChars) return redacted;
  const omitted = redacted.length - maxChars;
  return `[truncated ${omitted} chars]\n${redacted.slice(-maxChars)}`;
}

function summarizeVerificationCommand(entry: unknown): unknown {
  if (!isRecord(entry)) return entry;
  return {
    command: readString(entry.command),
    exitCode: readNumber(entry.exitCode),
    stdout: compactText(readString(entry.stdout) ?? ""),
    stderr: compactText(readString(entry.stderr) ?? ""),
    stdoutTruncated: entry.stdoutTruncated === true,
    stderrTruncated: entry.stderrTruncated === true,
  };
}

function summarizeJob(job: unknown): unknown {
  if (!isRecord(job)) return job;
  return {
    id: readString(job.id),
    name: readString(job.name),
    conclusion: readString(job.conclusion),
    status: readString(job.status),
    log: compactText(readString(job.log) ?? ""),
  };
}

#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const SECRET_PATTERNS = [
  /(authorization:\s*(?:bearer|token|basic)\s+)[^\s"']+/gi,
  /(private-token:\s*)[^\s"']+/gi,
  /(x-gitlab-token:\s*)[^\s"']+/gi,
  /(x-hub-signature-256:\s*sha256=)[a-f0-9]+/gi,
  /("?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|token|secret|password)"?\s*[:=]\s*"?)[^"',\s}]+/gi,
  /csk-[A-Za-z0-9]+/g,
  /gh[opsu]_[A-Za-z0-9_]+/g,
  /ghs_[A-Za-z0-9_]+/g,
  /glpat-[A-Za-z0-9_-]+/g,
  /github_pat_[A-Za-z0-9_]+/g,
  /gl(?:cbt|rt|ptt|soat|deploy)-[A-Za-z0-9_-]+/g,
  /A(?:KIA|SIA)[A-Z0-9]{16}/g,
  /xox[baprs]-[A-Za-z0-9-]+/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

const DEFAULT_STATE_PATHS = [
  "var/hootline-state.json",
  "var/pipeline-fixer-state.json",
  "var/pipeline-fixer-fixture-state.json",
];

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  printHelp();
  process.exit(0);
}

const workflowDataDir = resolve(args.workflowData ?? ".workflow-data");
const sessionId = args.sessionId === undefined ? undefined : resolveSessionId(args.sessionId, workflowDataDir);

if (sessionId === undefined) {
  listRecentSessions(workflowDataDir);
  process.exit(0);
}

const streamSummary = readSessionStream(workflowDataDir, sessionId);
const runRecord = readOptionalJson(join(workflowDataDir, "runs", `${sessionId}.json`));
const statePath = args.state === undefined ? detectStatePath() : args.state;
const attempt = statePath === undefined ? undefined : findAttempt(readOptionalJson(statePath), sessionId, args.attemptKey);
const report = buildReport({
  sessionId,
  workflowDataDir,
  streamSummary,
  runRecord,
  attempt,
  statePath,
  messageChars: args.messageChars,
});

if (args.json) {
  console.log(JSON.stringify(redactValue(report), null, 2));
} else {
  printReport(report);
}

function parseArgs(argv) {
  const parsed = {
    attemptKey: undefined,
    help: false,
    json: false,
    messageChars: 1600,
    sessionId: undefined,
    state: undefined,
    workflowData: undefined,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
    } else if (arg === "--json") {
      parsed.json = true;
    } else if (arg === "--workflow-data") {
      parsed.workflowData = requireValue(argv, ++index, arg);
    } else if (arg === "--state") {
      parsed.state = requireValue(argv, ++index, arg);
    } else if (arg === "--attempt-key") {
      parsed.attemptKey = requireValue(argv, ++index, arg);
    } else if (arg === "--message-chars") {
      parsed.messageChars = parsePositiveInt(requireValue(argv, ++index, arg), arg);
    } else if (arg.startsWith("--")) {
      fail(`Unknown option: ${arg}`);
    } else if (parsed.sessionId === undefined) {
      parsed.sessionId = arg;
    } else {
      fail(`Unexpected positional argument: ${arg}`);
    }
  }

  return parsed;
}

function requireValue(argv, index, flag) {
  if (index >= argv.length || argv[index]?.startsWith("--")) {
    fail(`${flag} requires a value.`);
  }
  return argv[index];
}

function parsePositiveInt(value, flag) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    fail(`${flag} must be a positive integer.`);
  }
  return parsed;
}

function printHelp() {
  console.log(`Inspect a local Eve session stream.

Usage:
  npm run session:inspect -- <session-id> [options]
  npm run session:inspect -- --help

Options:
  --workflow-data <path>   Eve workflow data directory. Default: .workflow-data
  --state <path>           Hootline state file. Auto-detected from var/*state*.json
  --attempt-key <key>      Prefer this Hootline attempt when reading state
  --message-chars <n>      Characters to show from the final assistant message. Default: 1600
  --json                   Print the parsed summary as JSON

With no session id, the command lists recent local sessions.`);
}

function listRecentSessions(baseDir) {
  const runsDir = join(baseDir, "streams", "runs");
  if (!existsSync(runsDir)) {
    fail(`No Eve stream run directory found at ${runsDir}`);
  }
  const sessions = readdirSync(runsDir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => {
      const path = join(runsDir, name);
      return {
        id: basename(name, ".json"),
        modifiedMs: statSync(path).mtimeMs,
      };
    })
    .sort((a, b) => b.modifiedMs - a.modifiedMs)
    .slice(0, 20);

  console.log("Recent Eve sessions:");
  for (const session of sessions) {
    console.log(`- ${session.id}`);
  }
}

function resolveSessionId(input, baseDir) {
  const direct = input.startsWith("wrun_") ? input : `wrun_${input}`;
  if (existsSync(join(baseDir, "streams", "runs", `${direct}.json`))) return direct;
  if (existsSync(join(baseDir, "runs", `${direct}.json`))) return direct;
  if (existsSync(join(baseDir, "streams", "runs", `${input}.json`))) return input;
  if (existsSync(join(baseDir, "runs", `${input}.json`))) return input;
  fail(`Could not find local Eve session ${input} under ${baseDir}`);
}

function readSessionStream(baseDir, id) {
  const streamRunPath = join(baseDir, "streams", "runs", `${id}.json`);
  const streamRun = readJson(streamRunPath);
  const streams = Array.isArray(streamRun.streams) ? streamRun.streams : [];
  if (streams.length === 0) fail(`No streams recorded in ${streamRunPath}`);

  const chunksDir = join(baseDir, "streams", "chunks");
  const allChunkNames = existsSync(chunksDir) ? readdirSync(chunksDir) : [];
  const events = [];
  const warnings = [];
  let chunkCount = 0;

  for (const streamId of streams) {
    const chunkNames = allChunkNames
      .filter((name) => name.startsWith(`${streamId}-chnk_`))
      .sort();
    chunkCount += chunkNames.length;
    for (const name of chunkNames) {
      const path = join(chunksDir, name);
      try {
        events.push(...decodeChunk(path));
      } catch (error) {
        warnings.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  const counts = {};
  const steps = [];
  const toolCalls = [];
  const toolResults = new Map();
  let runtime;
  let finalMessage;
  let finalWait;
  let turnCompletedAt;

  for (const event of events) {
    const type = event.type ?? event.event ?? "unknown";
    counts[type] = (counts[type] ?? 0) + 1;
    if (type === "session.started") runtime = event.data?.runtime;
    if (type === "session.waiting") finalWait = { at: event.meta?.at, wait: event.data?.wait };
    if (type === "turn.completed") turnCompletedAt = event.meta?.at;
    if (type === "step.completed") {
      steps.push({
        at: event.meta?.at,
        finishReason: event.data?.finishReason,
        inputTokens: event.data?.usage?.inputTokens,
        outputTokens: event.data?.usage?.outputTokens,
        stepIndex: event.data?.stepIndex,
      });
    }
    if (type === "message.completed") {
      finalMessage = {
        at: event.meta?.at,
        finishReason: event.data?.finishReason,
        message: event.data?.message ?? "",
      };
    }
    if (type === "actions.requested") {
      for (const action of event.data?.actions ?? []) {
        toolCalls.push({
          at: event.meta?.at,
          callId: action.callId,
          input: action.input,
          stepIndex: event.data?.stepIndex,
          toolName: action.toolName,
        });
      }
    }
    if (type === "action.result") {
      const result = event.data?.result;
      if (result?.callId !== undefined) {
        toolResults.set(result.callId, {
          at: event.meta?.at,
          status: event.data?.status,
          output: result.output,
          toolName: result.toolName,
        });
      }
    }
  }

  return {
    chunkCount,
    counts,
    eventsCount: events.length,
    finalMessage,
    finalWait,
    runtime,
    steps,
    streams,
    toolCalls: toolCalls.map((call) => ({
      ...call,
      result: toolResults.get(call.callId),
    })),
    turnCompletedAt,
    warnings,
  };
}

function decodeChunk(path) {
  const buffer = readFileSync(path);
  const marker = buffer.indexOf(Buffer.from("devl"));
  const encodedEnvelope = marker >= 0 ? buffer.subarray(marker + 4).toString("utf8") : buffer.toString("utf8");
  const envelope = JSON.parse(encodedEnvelope);
  const encoded = findBase64Payload(envelope);
  if (encoded === undefined) return [];

  const decoded = Buffer.from(normalizeBase64(encoded), "base64").toString("utf8");
  return decoded
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

function findBase64Payload(value) {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return undefined;
  for (const item of value) {
    if (typeof item === "string" && item.length > 20) return item;
  }
  return undefined;
}

function normalizeBase64(value) {
  return value.replace(/-/g, "+").replace(/_/g, "/");
}

function buildReport({ sessionId, workflowDataDir, streamSummary, runRecord, attempt, statePath, messageChars }) {
  const toolCalls = streamSummary.toolCalls.map((call) => ({
    at: call.at,
    result: summarizeToolResult(call.result),
    stepIndex: call.stepIndex,
    toolName: call.toolName,
    input: summarizeToolInput(call.toolName, call.input),
  }));

  return {
    sessionId,
    workflowDataDir,
    runStatus: runRecord?.status,
    startedAt: runRecord?.startedAt,
    updatedAt: runRecord?.updatedAt,
    runtime: streamSummary.runtime,
    stream: {
      streams: streamSummary.streams,
      chunks: streamSummary.chunkCount,
      events: streamSummary.eventsCount,
      counts: streamSummary.counts,
      warnings: streamSummary.warnings,
    },
    steps: streamSummary.steps,
    tools: toolCalls,
    terminal: {
      messageFinishReason: streamSummary.finalMessage?.finishReason,
      messageAt: streamSummary.finalMessage?.at,
      turnCompletedAt: streamSummary.turnCompletedAt,
      wait: streamSummary.finalWait,
      finalMessageExcerpt: summarizeFinalMessage(streamSummary.finalMessage?.message ?? "", messageChars),
    },
    attempt: summarizeAttempt(attempt, statePath),
  };
}

function summarizeToolInput(toolName, input) {
  if (toolName === "read_file" && typeof input?.filePath === "string") return input.filePath;
  if (toolName === "stage_repository_snapshot") return "{}";
  if (toolName === "run_repo_checks") return "{}";
  if (toolName === "publish_fix") return summarizeJson(input, 300);
  if (toolName === "todo") {
    const todos = Array.isArray(input?.todos) ? input.todos : [];
    const counts = {};
    for (const todo of todos) counts[todo.status] = (counts[todo.status] ?? 0) + 1;
    return `todos ${summarizeJson(counts, 200)}`;
  }
  return summarizeJson(input, 300);
}

function summarizeToolResult(result) {
  if (result === undefined) return "no result";
  if (result.output?.repoPath !== undefined) {
    return `completed: staged ${result.output.files} files, ${result.output.bytes} bytes`;
  }
  if (result.output?.counts !== undefined) {
    return `completed: todo ${summarizeJson(result.output.counts, 200)}`;
  }
  if (result.output?.path !== undefined) {
    return `completed: read ${result.output.path} (${result.output.totalLines} lines)`;
  }
  if (result.output?.ok !== undefined && Array.isArray(result.output.results)) {
    const checks = result.output.results
      .map((item) => `${item.command}: exit ${item.exitCode}`)
      .join("; ");
    return `${result.output.ok ? "passed" : "failed"}: ${checks}`;
  }
  if (result.output?.changeUrl !== undefined) {
    return `published: ${result.output.changeUrl}`;
  }
  if (result.output?.posted === true) return "comment posted";
  if (result.output?.message !== undefined) return summarizeText(String(result.output.message), 300);
  return `${result.status ?? "completed"}: ${summarizeJson(result.output, 300)}`;
}

function summarizeFinalMessage(message, messageChars) {
  if (message.length <= messageChars * 2) return redact(message);
  return [
    redact(message.slice(0, messageChars)),
    `[omitted ${message.length - messageChars * 2} characters]`,
    redact(message.slice(-messageChars)),
  ].join("\n");
}

function summarizeAttempt(attempt, statePath) {
  if (attempt === undefined) return statePath === undefined ? undefined : { statePath, found: false };
  return {
    statePath,
    found: true,
    key: attempt.key,
    attempts: attempt.attempts,
    provider: attempt.provider,
    repoSlug: attempt.repoSlug,
    sha: attempt.sha,
    pipelineId: attempt.pipelineId,
    lastSessionId: attempt.lastSessionId,
    lastSessionStatus: attempt.lastSessionStatus,
    lastSessionFailureKind: attempt.lastSessionFailureKind,
    lastTerminalAction: attempt.lastTerminalAction,
    lastToolSequence: attempt.lastToolSequence,
    lastFailedTools: attempt.lastFailedTools,
    continuationsUsed: attempt.continuationsUsed,
    lastInputTokens: attempt.lastInputTokens,
    lastOutputTokens: attempt.lastOutputTokens,
    lastEventsSeen: attempt.lastEventsSeen,
    repoStagedAt: attempt.repoStagedAt,
    hasLastVerification: attempt.lastVerification !== undefined,
    hasLastPublishResult: attempt.lastPublishResult !== undefined,
    rerunRequests: Array.isArray(attempt.rerunRequests) ? attempt.rerunRequests.length : 0,
    publishedBranch: attempt.publishedBranch,
    changeUrl: attempt.changeUrl,
  };
}

function printReport(report) {
  console.log(`Session: ${report.sessionId}`);
  if (report.runtime !== undefined) {
    console.log(
      `Runtime: ${report.runtime.agentName ?? report.runtime.agentId ?? "unknown"} / ${
        report.runtime.modelId ?? "unknown model"
      } / Eve ${report.runtime.eveVersion ?? "unknown"}`,
    );
  }
  console.log(`Eve run record status: ${report.runStatus ?? "unknown"}`);
  console.log(`Stream: ${report.stream.chunks} chunks, ${report.stream.events} events`);
  console.log("Event counts:");
  for (const [type, count] of Object.entries(report.stream.counts)) {
    console.log(`- ${type}: ${count}`);
  }

  if (report.steps.length > 0) {
    console.log("\nSteps:");
    for (const step of report.steps) {
      const usage = [step.inputTokens, step.outputTokens].every((value) => value !== undefined)
        ? `, tokens ${step.inputTokens}/${step.outputTokens}`
        : "";
      console.log(`- step ${step.stepIndex}: ${step.finishReason ?? "unknown"}${usage}`);
    }
  }

  if (report.tools.length > 0) {
    console.log("\nTool calls:");
    for (const tool of report.tools) {
      console.log(`- step ${tool.stepIndex} ${tool.toolName}: ${tool.input} -> ${tool.result}`);
    }
  }

  console.log("\nTerminal:");
  console.log(`- message finish reason: ${report.terminal.messageFinishReason ?? "unknown"}`);
  console.log(`- turn completed at: ${report.terminal.turnCompletedAt ?? "unknown"}`);
  console.log(
    `- session wait: ${report.terminal.wait?.wait ?? "unknown"} at ${report.terminal.wait?.at ?? "unknown"}`,
  );

  if (report.attempt !== undefined) {
    console.log("\nHootline attempt:");
    if (!report.attempt.found) {
      console.log(`- no matching attempt found in ${report.attempt.statePath}`);
    } else {
      console.log(`- key: ${report.attempt.key}`);
      console.log(`- repo: ${report.attempt.repoSlug}@${report.attempt.sha}`);
      console.log(`- pipeline: ${report.attempt.pipelineId}`);
      console.log(`- session status: ${report.attempt.lastSessionStatus ?? "unknown"}`);
      if (report.attempt.lastSessionFailureKind !== undefined) {
        console.log(`- failure kind: ${report.attempt.lastSessionFailureKind}`);
      }
      if (report.attempt.lastTerminalAction !== undefined) {
        console.log(`- terminal action: ${report.attempt.lastTerminalAction}`);
      }
      if (Array.isArray(report.attempt.lastToolSequence)) {
        console.log(`- tools: ${report.attempt.lastToolSequence.join(" -> ") || "none"}`);
      }
      if (Array.isArray(report.attempt.lastFailedTools) && report.attempt.lastFailedTools.length > 0) {
        console.log(`- failed tools: ${report.attempt.lastFailedTools.join(", ")}`);
      }
      if (report.attempt.continuationsUsed !== undefined) {
        console.log(`- continuations: ${report.attempt.continuationsUsed}`);
      }
      if (report.attempt.lastInputTokens !== undefined || report.attempt.lastOutputTokens !== undefined) {
        console.log(
          `- tokens: input=${report.attempt.lastInputTokens ?? "?"} output=${
            report.attempt.lastOutputTokens ?? "?"
          }`,
        );
      }
      if (report.attempt.lastEventsSeen !== undefined) {
        console.log(`- stream events seen: ${report.attempt.lastEventsSeen}`);
      }
      console.log(`- staged: ${report.attempt.repoStagedAt ?? "no"}`);
      console.log(`- verification recorded: ${report.attempt.hasLastVerification ? "yes" : "no"}`);
      console.log(`- publish recorded: ${report.attempt.hasLastPublishResult ? "yes" : "no"}`);
      console.log(`- reruns requested: ${report.attempt.rerunRequests}`);
      if (report.attempt.changeUrl !== undefined) console.log(`- change: ${report.attempt.changeUrl}`);
    }
  }

  if (report.stream.warnings.length > 0) {
    console.log("\nWarnings:");
    for (const warning of report.stream.warnings) console.log(`- ${warning}`);
  }

  if (report.terminal.finalMessageExcerpt.length > 0) {
    console.log("\nFinal assistant message excerpt:");
    console.log(report.terminal.finalMessageExcerpt);
  }
}

function findAttempt(state, sessionId, attemptKey) {
  if (!state || typeof state !== "object" || !state.attempts || typeof state.attempts !== "object") {
    return undefined;
  }
  if (attemptKey !== undefined) return state.attempts[attemptKey];
  return Object.values(state.attempts).find((attempt) => attempt?.lastSessionId === sessionId);
}

function detectStatePath() {
  const envPath = process.env.HOOTLINE_STATE_PATH;
  if (envPath !== undefined && existsSync(envPath)) return envPath;
  for (const path of DEFAULT_STATE_PATHS) {
    if (existsSync(path)) return path;
  }
  if (!existsSync("var")) return undefined;
  const candidates = readdirSync("var")
    .filter((name) => name.endsWith(".json") && name.includes("state"))
    .map((name) => join("var", name));
  if (candidates.length === 1) return candidates[0];
  return undefined;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function readOptionalJson(path) {
  if (path === undefined || !existsSync(path)) return undefined;
  return readJson(path);
}

function summarizeJson(value, maxLength) {
  return summarizeText(JSON.stringify(redactValue(value)), maxLength);
}

function summarizeText(value, maxLength) {
  const redacted = redact(value.replace(/\s+/g, " ").trim());
  if (redacted.length <= maxLength) return redacted;
  return `${redacted.slice(0, maxLength)}...`;
}

function redactValue(value) {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map((item) => redactValue(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactValue(item)]));
  }
  return value;
}

function redact(value) {
  let output = value;
  for (const pattern of SECRET_PATTERNS) {
    output = output.replace(pattern, (_match, prefix) =>
      typeof prefix === "string" ? `${prefix}[REDACTED]` : "[REDACTED]",
    );
  }
  return output;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

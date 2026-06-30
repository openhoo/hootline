import type { RepairSessionFailureKind, RepairSessionStatus } from "./types.ts";
import { isRecord, readNumber, readString, type UnknownRecord } from "./unknown.ts";

export interface StreamSession {
  id: string;
  continuationToken: string;
  getEventStream(options?: { startIndex?: number }): Promise<ReadableStream<unknown>>;
}

export type TerminalRepairAction = "published" | "rerun_requested" | "comment_posted" | "merged";

export interface RepairSessionObservation {
  status: RepairSessionStatus;
  finishReason?: string | undefined;
  failureKind?: RepairSessionFailureKind | undefined;
  failureMessage?: string | undefined;
  endedAt?: string | undefined;
  eventsSeen: number;
  toolSequence: string[];
  failedTools: string[];
  terminalAction?: TerminalRepairAction | undefined;
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  humanInputRequested: boolean;
}

export interface ObservationState {
  eventsSeen: number;
  toolSequence: string[];
  failedTools: string[];
  terminalAction?: TerminalRepairAction | undefined;
  finishReason?: string | undefined;
  failureKind?: RepairSessionFailureKind | undefined;
  failureMessage?: string | undefined;
  endedAt?: string | undefined;
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  humanInputRequested: boolean;
  boundary?: "waiting" | "completed" | "failed" | undefined;
}

const DEFAULT_MONITOR_TIMEOUT_MS = 15 * 60 * 1000;

export async function observeRepairSession(
  session: StreamSession,
  options: { timeoutMs?: number; startIndex?: number } = {},
): Promise<RepairSessionObservation> {
  const state = createObservationState();
  let reader: ReadableStreamDefaultReader<unknown> | undefined;
  try {
    const stream = await session.getEventStream({ startIndex: options.startIndex ?? 0 });
    reader = stream.getReader();
    const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_MONITOR_TIMEOUT_MS);
    for (;;) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        state.boundary = "failed";
        state.failureKind = "timeout";
        state.failureMessage = "Timed out while waiting for the Eve session stream to reach a boundary.";
        return finalizeObservation(state);
      }
      const result = await readWithTimeout(reader, remainingMs);
      if (result === "timeout") {
        state.boundary = "failed";
        state.failureKind = "timeout";
        state.failureMessage = "Timed out while waiting for the Eve session stream to reach a boundary.";
        return finalizeObservation(state);
      }
      if (result.done === true) return finalizeObservation(state);
      observeStreamEvent(state, result.value);
      if (state.boundary !== undefined) return finalizeObservation(state);
    }
  } catch (error) {
    state.boundary = "failed";
    state.failureKind = "stream_error";
    state.failureMessage = error instanceof Error ? error.message : String(error);
    return finalizeObservation(state);
  } finally {
    try {
      await reader?.cancel();
    } catch {
      // Best-effort stream cleanup only.
    }
  }
}

export function createObservationState(): ObservationState {
  return {
    eventsSeen: 0,
    toolSequence: [],
    failedTools: [],
    humanInputRequested: false,
  };
}

export function observeStreamEvent(state: ObservationState, event: unknown): void {
  if (!isRecord(event)) return;
  state.eventsSeen += 1;
  state.endedAt = readMetaAt(event) ?? state.endedAt;
  const type = readString(event.type);
  const data = isRecord(event.data) ? event.data : {};

  if (type === "actions.requested") {
    for (const action of readArray(data.actions)) {
      const toolName = readToolName(action);
      if (toolName !== undefined) state.toolSequence.push(toolName);
    }
    return;
  }

  if (type === "action.result") {
    observeActionResult(state, data);
    return;
  }

  if (type === "input.requested") {
    state.humanInputRequested = true;
    state.failureKind = "human_input_requested";
    state.failureMessage = "The model requested human input instead of completing the CI repair workflow.";
    return;
  }

  if (type === "message.completed" || type === "step.completed") {
    state.finishReason = readString(data.finishReason) ?? state.finishReason;
    const usage = isRecord(data.usage) ? data.usage : undefined;
    state.inputTokens = readNumber(usage?.inputTokens) ?? state.inputTokens;
    state.outputTokens = readNumber(usage?.outputTokens) ?? state.outputTokens;
    return;
  }

  if (type === "step.failed" || type === "turn.failed") {
    state.boundary = "failed";
    state.failureKind = "provider_error";
    state.failureMessage = readString(data.message) ?? `${type} emitted without a message.`;
    return;
  }

  if (type === "session.failed") {
    state.boundary = "failed";
    state.failureKind = "provider_error";
    state.failureMessage = readString(data.message) ?? "Session failed.";
    return;
  }

  if (type === "session.completed") {
    state.boundary = "completed";
    return;
  }

  if (type === "session.waiting") {
    state.boundary = "waiting";
  }
}

export function finalizeObservation(state: ObservationState): RepairSessionObservation {
  const failure = classifyFailure(state);
  const status = classifyStatus(state, failure);
  return {
    status,
    finishReason: state.finishReason,
    failureKind: failure.kind,
    failureMessage: failure.message,
    endedAt: state.endedAt,
    eventsSeen: state.eventsSeen,
    toolSequence: state.toolSequence,
    failedTools: state.failedTools,
    terminalAction: state.terminalAction,
    inputTokens: state.inputTokens,
    outputTokens: state.outputTokens,
    humanInputRequested: state.humanInputRequested,
  };
}

export function shouldSendRepairContinuation(
  observation: RepairSessionObservation,
  continuationsUsed: number,
  maxContinuations: number,
): boolean {
  return (
    observation.status === "waiting" &&
    observation.terminalAction === undefined &&
    !observation.humanInputRequested &&
    continuationsUsed < maxContinuations
  );
}

export function toLocalContinuationToken(namespacedToken: string, fallback: string): string {
  const separator = namespacedToken.indexOf(":");
  return separator > 0 ? namespacedToken.slice(separator + 1) : fallback;
}

function observeActionResult(state: ObservationState, data: UnknownRecord): void {
  const status = readString(data.status);
  const result = isRecord(data.result) ? data.result : {};
  const toolName = readString(result.toolName);
  if (toolName === undefined) return;
  if (status === "failed" || status === "rejected") {
    state.failedTools.push(toolName);
    return;
  }
  if (status !== "completed") return;
  const output = result.output;
  const terminalAction = terminalActionFromToolResult(toolName, output);
  if (terminalAction !== undefined) state.terminalAction = terminalAction;
}

function terminalActionFromToolResult(
  toolName: string,
  output: unknown,
): TerminalRepairAction | undefined {
  if (toolName === "rerun_pipeline") return "rerun_requested";
  if (toolName === "post_provider_comment" && isRecord(output) && output.posted === true) {
    return "comment_posted";
  }
  if (toolName === "merge_change" && isRecord(output) && output.merged === true) return "merged";
  if (toolName === "publish_fix" && isRecord(output) && output.published === true) return "published";
  return undefined;
}

function classifyStatus(
  state: ObservationState,
  failure: { kind?: RepairSessionFailureKind | undefined },
): RepairSessionStatus {
  if (state.boundary === "failed") return "failed";
  if (state.terminalAction !== undefined) return "completed";
  if (state.boundary === "completed") return "completed";
  if (failure.kind !== undefined) return "waiting";
  return "running";
}

function classifyFailure(
  state: ObservationState,
): { kind?: RepairSessionFailureKind | undefined; message?: string | undefined } {
  if (state.failureKind !== undefined) {
    return { kind: state.failureKind, message: state.failureMessage };
  }
  if (state.terminalAction !== undefined) return {};
  if (state.finishReason === "length") {
    return {
      kind: "length",
      message: "The model reached the output limit before a terminal Hootline action completed.",
    };
  }
  if (state.boundary === "waiting" || state.boundary === "completed") {
    return {
      kind: "no_terminal_action",
      message: "The model stopped without publishing a fix, requesting a rerun, or posting a blocker comment.",
    };
  }
  return {};
}

function readMetaAt(event: UnknownRecord): string | undefined {
  return isRecord(event.meta) ? readString(event.meta.at) : undefined;
}

function readToolName(action: unknown): string | undefined {
  if (!isRecord(action)) return undefined;
  return readString(action.toolName) ?? readString(action.name);
}

function readArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readWithTimeout(
  reader: ReadableStreamDefaultReader<unknown>,
  timeoutMs: number,
): Promise<ReadableStreamReadResult<unknown> | "timeout"> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => resolve("timeout"), timeoutMs);
    reader.read().then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

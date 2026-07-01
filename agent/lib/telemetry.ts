import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { metrics, SpanStatusCode, trace, type Attributes } from "@opentelemetry/api";

import { redact } from "./redact.ts";
import type { HootlineServiceConfig, TelemetryDetail, TelemetryMode } from "./types.ts";
import { isRecord, readNumber, readString, type UnknownRecord } from "./unknown.ts";

export type TelemetrySource = "repair-service" | "eve-stream" | "instrumentation";

export interface TelemetryIdentity {
  attemptKey?: string | undefined;
  provider?: string | undefined;
  repoSlug?: string | undefined;
  deliveryKey?: string | undefined;
  sha?: string | undefined;
  pipelineId?: string | undefined;
  sessionId?: string | undefined;
  turnId?: string | undefined;
  stepIndex?: number | undefined;
  toolName?: string | undefined;
}

export interface TelemetryRecordInput {
  source: TelemetrySource;
  type: string;
  at?: string | undefined;
  identity?: TelemetryIdentity | undefined;
  payload?: unknown;
  error?: unknown;
}

export interface HootlineTelemetryRecord {
  schemaVersion: 1;
  id: string;
  at: string;
  source: TelemetrySource;
  type: string;
  identity?: TelemetryIdentity | undefined;
  otel?: {
    traceId: string;
    spanId: string;
  } | undefined;
  payload?: unknown;
  error?: unknown;
}

interface TelemetryMetricHandles {
  eventCounter: ReturnType<ReturnType<typeof metrics.getMeter>["createCounter"]>;
  toolErrorCounter: ReturnType<ReturnType<typeof metrics.getMeter>["createCounter"]>;
  tokenCounter: ReturnType<ReturnType<typeof metrics.getMeter>["createCounter"]>;
}

let metricHandles: TelemetryMetricHandles | undefined;

export function telemetryWritesLocal(mode: TelemetryMode): boolean {
  return mode === "local" || mode === "local+otlp";
}

export function telemetryExportsOtlp(mode: TelemetryMode): boolean {
  return mode === "otlp" || mode === "local+otlp";
}

export function hasConfiguredOtlpEndpoint(env: NodeJS.ProcessEnv = process.env): boolean {
  return hasConfiguredOtlpTraceEndpoint(env) || hasConfiguredOtlpMetricsEndpoint(env);
}

export function hasConfiguredOtlpTraceEndpoint(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    readNonEmpty(env.OTEL_EXPORTER_OTLP_ENDPOINT) !== undefined ||
    readNonEmpty(env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT) !== undefined
  );
}

export function hasConfiguredOtlpMetricsEndpoint(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    readNonEmpty(env.OTEL_EXPORTER_OTLP_ENDPOINT) !== undefined ||
    readNonEmpty(env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT) !== undefined
  );
}

export function recordTelemetry(
  config: HootlineServiceConfig,
  input: TelemetryRecordInput,
): HootlineTelemetryRecord | undefined {
  if (config.telemetryMode === "off") return undefined;
  const record = buildTelemetryRecord(config, input);

  if (telemetryWritesLocal(config.telemetryMode)) {
    try {
      appendTelemetryRecord(config.telemetryPath, record);
    } catch {
      // Telemetry must not affect the repair loop.
    }
  }

  if (telemetryExportsOtlp(config.telemetryMode)) {
    emitOpenTelemetryRecord(record);
  }

  return record;
}

export function buildTelemetryRecord(
  config: Pick<HootlineServiceConfig, "telemetryDetail" | "telemetryMaxTextChars">,
  input: TelemetryRecordInput,
): HootlineTelemetryRecord {
  return {
    schemaVersion: 1,
    id: randomUUID(),
    at: input.at ?? new Date().toISOString(),
    source: input.source,
    type: input.type,
    identity: input.identity,
    otel: activeSpanContext(),
    payload:
      input.payload === undefined
        ? undefined
        : shapeTelemetryValue(input.payload, config.telemetryDetail, config.telemetryMaxTextChars),
    error:
      input.error === undefined
        ? undefined
        : shapeTelemetryValue(normalizeError(input.error), config.telemetryDetail, config.telemetryMaxTextChars),
  };
}

function activeSpanContext(): HootlineTelemetryRecord["otel"] {
  const context = trace.getActiveSpan()?.spanContext();
  if (context === undefined) return undefined;
  return { traceId: context.traceId, spanId: context.spanId };
}

export function streamEventTelemetryPayload(
  event: unknown,
  detail: TelemetryDetail,
  maxTextChars: number,
): { type: string; at?: string | undefined; identity: TelemetryIdentity; payload: unknown } | undefined {
  if (!isRecord(event)) return undefined;
  const type = readString(event.type);
  if (type === undefined) return undefined;
  const data = isRecord(event.data) ? event.data : {};
  const meta = isRecord(event.meta) ? event.meta : {};
  const base = {
    eventType: type,
    sequence: readNumber(data.sequence),
    turnId: readString(data.turnId),
    stepIndex: readNumber(data.stepIndex),
  };

  if (type === "reasoning.appended" || type === "reasoning.completed") {
    return {
      type,
      at: readString(meta.at),
      identity: readStreamIdentity(data),
      payload: {
        ...base,
        reasoningChars: readReasoningLength(data),
      },
    };
  }

  return {
    type,
    at: readString(meta.at),
    identity: readStreamIdentity(data),
    payload: {
      ...base,
      ...streamEventDataPayload(type, data, detail, maxTextChars),
    },
  };
}

function streamEventDataPayload(
  type: string,
  data: UnknownRecord,
  detail: TelemetryDetail,
  maxTextChars: number,
): UnknownRecord {
  if (type === "actions.requested") {
    return {
      actions: readArray(data.actions).map((action) => shapeActionRequest(action, detail, maxTextChars)),
    };
  }
  if (type === "action.result") {
    const result = isRecord(data.result) ? data.result : {};
    return {
      status: readString(data.status),
      error: shapeTelemetryValue(data.error, detail, maxTextChars),
      result: shapeActionResult(result, detail, maxTextChars),
    };
  }
  if (type === "message.received") {
    return shapeTextPayload("message", data.message, detail, maxTextChars);
  }
  if (type === "message.appended") {
    return {
      ...shapeTextPayload("messageDelta", data.messageDelta, detail, maxTextChars),
      messageSoFarChars: typeof data.messageSoFar === "string" ? data.messageSoFar.length : undefined,
    };
  }
  if (type === "message.completed") {
    return {
      finishReason: readString(data.finishReason),
      ...shapeTextPayload("message", data.message, detail, maxTextChars),
    };
  }
  if (type === "step.completed") {
    const usage = readUsage(data.usage);
    return {
      finishReason: readString(data.finishReason),
      ...usage,
      usage,
    };
  }
  if (type === "step.failed" || type === "turn.failed" || type === "session.failed") {
    return {
      code: readString(data.code),
      message: redactString(readString(data.message), detail, maxTextChars),
      details: shapeTelemetryValue(data.details, detail, maxTextChars),
    };
  }
  if (type === "input.requested") {
    return {
      requestCount: readArray(data.requests).length,
      requests: detail === "metadata" ? undefined : shapeTelemetryValue(data.requests, detail, maxTextChars),
    };
  }
  if (type === "compaction.requested") {
    return {
      modelId: readString(data.modelId),
      sessionId: readString(data.sessionId),
      usageInputTokens: readNumber(data.usageInputTokens),
    };
  }
  if (type === "session.started") {
    return {
      runtime: shapeTelemetryValue(data.runtime, detail, maxTextChars),
      invocation: shapeTelemetryValue(data.invocation, detail, maxTextChars),
    };
  }
  return detail === "metadata" ? {} : { data: shapeTelemetryValue(data, detail, maxTextChars) };
}

function shapeActionRequest(action: unknown, detail: TelemetryDetail, maxTextChars: number): UnknownRecord {
  if (!isRecord(action)) return { value: shapeTelemetryValue(action, detail, maxTextChars) };
  return {
    callId: readString(action.callId),
    toolName: readString(action.toolName) ?? readString(action.name),
    name: readString(action.name),
    input: shapeIoValue(action.input, detail, maxTextChars),
  };
}

function shapeActionResult(result: UnknownRecord, detail: TelemetryDetail, maxTextChars: number): UnknownRecord {
  return {
    callId: readString(result.callId),
    toolName: readString(result.toolName),
    output: shapeIoValue(result.output, detail, maxTextChars),
  };
}

function shapeIoValue(value: unknown, detail: TelemetryDetail, maxTextChars: number): unknown {
  if (detail !== "metadata") return shapeTelemetryValue(value, detail, maxTextChars);
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === "string") return { kind: "string", length: value.length };
  if (Array.isArray(value)) return { kind: "array", length: value.length };
  if (isRecord(value)) return { kind: "object", keys: Object.keys(value).slice(0, 50) };
  return value;
}

function shapeTextPayload(
  key: string,
  value: unknown,
  detail: TelemetryDetail,
  maxTextChars: number,
): UnknownRecord {
  if (typeof value !== "string") return { [`${key}Chars`]: undefined };
  if (detail === "metadata") return { [`${key}Chars`]: value.length };
  return {
    [`${key}Chars`]: value.length,
    [key]: redactString(value, detail, maxTextChars),
  };
}

function readStreamIdentity(data: UnknownRecord): TelemetryIdentity {
  return {
    turnId: readString(data.turnId),
    stepIndex: readNumber(data.stepIndex),
    toolName: readToolNameFromStreamData(data),
  };
}

function readToolNameFromStreamData(data: UnknownRecord): string | undefined {
  if (Array.isArray(data.actions)) {
    const first = data.actions.find(isRecord);
    return first === undefined ? undefined : readString(first.toolName) ?? readString(first.name);
  }
  const result = isRecord(data.result) ? data.result : undefined;
  return result === undefined ? undefined : readString(result.toolName);
}

function readReasoningLength(data: UnknownRecord): number | undefined {
  const reasoning =
    readString(data.reasoning) ?? readString(data.reasoningSoFar) ?? readString(data.reasoningDelta);
  return reasoning?.length;
}

function shapeTelemetryValue(
  value: unknown,
  detail: TelemetryDetail,
  maxTextChars: number,
  seen: WeakSet<object> = new WeakSet(),
): unknown {
  if (value === undefined) return undefined;
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") return redactString(value, detail, maxTextChars);
  if (Array.isArray(value)) {
    const items = value
      .slice(0, detail === "metadata" ? 50 : value.length)
      .map((item) => shapeTelemetryValue(item, detail, maxTextChars, seen));
    if (detail === "metadata" && value.length > items.length) {
      items.push({ omitted: value.length - items.length });
    }
    return items;
  }
  if (!isRecord(value)) return describeUnknownValue(value);
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      detail === "metadata" && (key === "input" || key === "output")
        ? shapeIoValue(item, detail, maxTextChars)
        : shapeTelemetryValue(item, detail, maxTextChars, seen),
    ]),
  );
}

function redactString(value: string | undefined, detail: TelemetryDetail, maxTextChars: number): string | undefined {
  if (value === undefined) return undefined;
  const cap = detail === "full" ? maxTextChars : Math.min(maxTextChars, 1_000);
  return redact(value, cap);
}

function normalizeError(error: unknown): UnknownRecord {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }
  return { value: error };
}

function appendTelemetryRecord(path: string, record: HootlineTelemetryRecord): void {
  const telemetryPath = resolve(path);
  mkdirSync(dirname(telemetryPath), { recursive: true });
  appendFileSync(telemetryPath, `${JSON.stringify(record)}\n`);
}

function emitOpenTelemetryRecord(record: HootlineTelemetryRecord): void {
  const attributes = telemetryAttributes(record);
  const activeSpan = trace.getActiveSpan();
  activeSpan?.addEvent(`hootline.${record.type}`, attributes);

  const span = trace.getTracer("hootline.telemetry").startSpan(`hootline.${record.type}`, {
    attributes,
  });
  if (record.error !== undefined || attributes["hootline.status"] === "failed") {
    span.setStatus({ code: SpanStatusCode.ERROR, message: String(attributes["error.message"] ?? record.type) });
  }
  span.end();

  const metricAttributes = lowCardinalityAttributes(attributes);
  const handles = getMetricHandles();
  handles.eventCounter.add(1, metricAttributes);
  if (record.type === "action.result" && attributes["hootline.status"] !== "completed") {
    handles.toolErrorCounter.add(1, metricAttributes);
  }
  recordTokenUsage(record, metricAttributes, handles);
}

function telemetryAttributes(record: HootlineTelemetryRecord): Attributes {
  const payload = isRecord(record.payload) ? record.payload : {};
  return compactAttributes({
    "hootline.schema_version": record.schemaVersion,
    "hootline.source": record.source,
    "hootline.type": record.type,
    "hootline.attempt_key": record.identity?.attemptKey,
    "hootline.provider": record.identity?.provider,
    "hootline.repo_slug": record.identity?.repoSlug,
    "hootline.delivery_key": record.identity?.deliveryKey,
    "hootline.sha": record.identity?.sha,
    "hootline.pipeline_id": record.identity?.pipelineId,
    "hootline.session_id": record.identity?.sessionId,
    "hootline.turn_id": record.identity?.turnId,
    "hootline.step_index": record.identity?.stepIndex,
    "hootline.tool_name": record.identity?.toolName,
    "hootline.status": readString(payload.status),
    "hootline.finish_reason": readString(payload.finishReason),
    "error.message": readTelemetryErrorMessage(record.error),
  });
}

function lowCardinalityAttributes(attributes: Attributes): Attributes {
  return compactAttributes({
    "hootline.source": attributes["hootline.source"],
    "hootline.type": attributes["hootline.type"],
    "hootline.provider": attributes["hootline.provider"],
    "hootline.tool_name": attributes["hootline.tool_name"],
    "hootline.status": attributes["hootline.status"],
  });
}

function recordTokenUsage(
  record: HootlineTelemetryRecord,
  attributes: Attributes,
  handles: TelemetryMetricHandles,
): void {
  if (!telemetryRecordContributesTokenMetrics(record)) return;
  const payload = isRecord(record.payload) ? record.payload : undefined;
  const usage = isRecord(payload?.usage) ? payload.usage : undefined;
  for (const [type, value] of [
    ["input", readNumber(payload?.inputTokens) ?? readNumber(usage?.inputTokens)],
    ["output", readNumber(payload?.outputTokens) ?? readNumber(usage?.outputTokens)],
    ["cache_read", readNumber(payload?.cacheReadTokens) ?? readNumber(usage?.cacheReadTokens)],
    ["cache_write", readNumber(payload?.cacheWriteTokens) ?? readNumber(usage?.cacheWriteTokens)],
  ] as const) {
    if (value !== undefined) handles.tokenCounter.add(value, { ...attributes, "token.type": type });
  }
}

export function telemetryRecordContributesTokenMetrics(
  record: Pick<HootlineTelemetryRecord, "source" | "type">,
): boolean {
  return record.source === "eve-stream" && record.type === "step.completed";
}

function getMetricHandles(): TelemetryMetricHandles {
  if (metricHandles !== undefined) return metricHandles;
  const meter = metrics.getMeter("hootline.telemetry");
  metricHandles = {
    eventCounter: meter.createCounter("hootline.telemetry.events", {
      description: "Hootline telemetry events emitted.",
    }),
    toolErrorCounter: meter.createCounter("hootline.telemetry.tool_errors", {
      description: "Hootline tool results with failed or rejected status.",
    }),
    tokenCounter: meter.createCounter("hootline.telemetry.tokens", {
      description: "Hootline model token usage observed from Eve step events.",
    }),
  };
  return metricHandles;
}

function compactAttributes(input: Record<string, unknown>): Attributes {
  return Object.fromEntries(
    Object.entries(input).filter((entry): entry is [string, string | number | boolean] => {
      const value = entry[1];
      return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
    }),
  );
}

function readTelemetryErrorMessage(error: unknown): string | undefined {
  if (!isRecord(error)) return undefined;
  if (typeof error.message === "string") return error.message;
  if (isRecord(error.value) && typeof error.value.message === "string") return error.value.message;
  return undefined;
}

function readArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readUsage(value: unknown): UnknownRecord {
  if (!isRecord(value)) return {};
  return {
    inputTokens: readNumber(value.inputTokens),
    outputTokens: readNumber(value.outputTokens),
    cacheReadTokens: readNumber(value.cacheReadTokens),
    cacheWriteTokens: readNumber(value.cacheWriteTokens),
  };
}

function readNonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === "" ? undefined : trimmed;
}

function describeUnknownValue(value: unknown): string {
  if (typeof value === "function") return "[Function]";
  if (typeof value === "symbol") return value.toString();
  return String(value);
}

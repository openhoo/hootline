import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildTelemetryRecord,
  hasConfiguredOtlpEndpoint,
  hasConfiguredOtlpMetricsEndpoint,
  hasConfiguredOtlpTraceEndpoint,
  recordTelemetry,
  streamEventTelemetryPayload,
  telemetryRecordContributesTokenMetrics,
} from "../agent/lib/telemetry.ts";
import type { HootlineServiceConfig } from "../agent/lib/types.ts";

test("writes local telemetry with redacted full payloads", () => {
  const root = mkdtempSync(join(tmpdir(), "hootline-telemetry-"));
  const telemetryPath = join(root, "telemetry.jsonl");
  try {
    const config = makeConfig({ telemetryPath });
    const record = recordTelemetry(config, {
      source: "repair-service",
      type: "repair.session.boundary",
      identity: { attemptKey: "github:owner/repo:abc:1001", sessionId: "session-1" },
      payload: {
        status: "failed",
        message: "authorization: Bearer abc123secretvalue",
      },
    });

    assert.ok(record !== undefined);
    const text = readFileSync(telemetryPath, "utf8");
    assert.ok(!text.includes("abc123secretvalue"));
    assert.ok(text.includes("[REDACTED]"));
    const parsed = JSON.parse(text.trim());
    assert.equal(parsed.source, "repair-service");
    assert.equal(parsed.identity.sessionId, "session-1");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("metadata detail omits tool IO while keeping routing fields", () => {
  const record = buildTelemetryRecord(makeConfig({ telemetryDetail: "metadata" }), {
    source: "eve-stream",
    type: "actions.requested",
    payload: {
      actions: [{ toolName: "edit_repo_file", input: { filePath: "src/index.ts", replacement: "secret" } }],
    },
  });

  const action = (record.payload as { actions: Array<{ input: unknown }> }).actions[0];
  assert.deepEqual(action?.input, { kind: "object", keys: ["filePath", "replacement"] });
});

test("stream shaping suppresses reasoning text even in full detail", () => {
  const shaped = streamEventTelemetryPayload(
    {
      type: "reasoning.completed",
      meta: { at: "2026-07-01T00:00:00.000Z" },
      data: {
        turnId: "turn_0",
        stepIndex: 0,
        reasoning: "private chain of thought",
      },
    },
    "full",
    12000,
  );

  assert.ok(shaped !== undefined);
  assert.deepEqual(shaped.payload, {
    eventType: "reasoning.completed",
    sequence: undefined,
    turnId: "turn_0",
    stepIndex: 0,
    reasoningChars: "private chain of thought".length,
  });
});

test("detects OTLP trace and metric endpoints independently", () => {
  assert.equal(hasConfiguredOtlpEndpoint({}), false);
  assert.equal(hasConfiguredOtlpTraceEndpoint({ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://otel/v1/traces" }), true);
  assert.equal(hasConfiguredOtlpMetricsEndpoint({ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://otel/v1/traces" }), false);
  assert.equal(hasConfiguredOtlpTraceEndpoint({ OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "http://otel/v1/metrics" }), false);
  assert.equal(hasConfiguredOtlpMetricsEndpoint({ OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "http://otel/v1/metrics" }), true);
  assert.equal(hasConfiguredOtlpTraceEndpoint({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://otel" }), true);
  assert.equal(hasConfiguredOtlpMetricsEndpoint({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://otel" }), true);
});

test("counts token metrics only from Eve step completion records", () => {
  assert.equal(telemetryRecordContributesTokenMetrics({ source: "eve-stream", type: "step.completed" }), true);
  assert.equal(
    telemetryRecordContributesTokenMetrics({ source: "repair-service", type: "repair.session.boundary" }),
    false,
  );
  assert.equal(telemetryRecordContributesTokenMetrics({ source: "eve-stream", type: "turn.completed" }), false);
});

function makeConfig(overrides: Partial<HootlineServiceConfig> = {}): HootlineServiceConfig {
  return {
    statePath: "var/hootline-state.json",
    repoConfigPath: ".hootline.yaml",
    providerErrorRetries: 2,
    providerErrorRetryBaseMs: 1000,
    providerErrorRetryMaxMs: 15000,
    telemetryMode: "local",
    telemetryDetail: "full",
    telemetryPath: "var/hootline-telemetry.jsonl",
    telemetryMaxTextChars: 12000,
    ...overrides,
  };
}

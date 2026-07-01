import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";

import { loadServiceConfig } from "./config.ts";
import { createLogger, logError } from "./logger.ts";
import {
  hasConfiguredOtlpEndpoint,
  hasConfiguredOtlpMetricsEndpoint,
  hasConfiguredOtlpTraceEndpoint,
  telemetryExportsOtlp,
} from "./telemetry.ts";

const log = createLogger("lib.otel");

let sdk: NodeSDK | undefined;
let shutdownRegistered = false;

export function setupOpenTelemetry(input: { agentName: string }): void {
  const config = loadServiceConfig();
  if (!telemetryExportsOtlp(config.telemetryMode)) {
    log.debug({ telemetryMode: config.telemetryMode }, "otel export disabled by telemetry mode");
    return;
  }
  if (!hasConfiguredOtlpEndpoint()) {
    log.debug("otel export disabled: no OTLP endpoint env var configured");
    return;
  }
  if (sdk !== undefined) return;

  const traceExporter = hasConfiguredOtlpTraceEndpoint() ? new OTLPTraceExporter() : undefined;
  const metricReaders = hasConfiguredOtlpMetricsEndpoint()
    ? [
        new PeriodicExportingMetricReader({
          exporter: new OTLPMetricExporter(),
        }),
      ]
    : [];
  sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: input.agentName,
      [ATTR_SERVICE_VERSION]: process.env.npm_package_version ?? "0.0.0",
    }),
    logRecordProcessors: [],
    metricReaders,
    ...(traceExporter === undefined ? { spanProcessors: [] } : { traceExporter }),
  });
  sdk.start();
  registerShutdown();
  log.info(
    { traces: traceExporter !== undefined, metrics: metricReaders.length > 0 },
    "otel exporter started",
  );
}

function registerShutdown(): void {
  if (shutdownRegistered) return;
  shutdownRegistered = true;
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      void shutdownOpenTelemetry().finally(() => process.exit(0));
    });
  }
}

async function shutdownOpenTelemetry(): Promise<void> {
  if (sdk === undefined) return;
  try {
    await sdk.shutdown();
    log.info("otel exporter shut down");
  } catch (error) {
    logError(log, "otel exporter shutdown failed", error);
  } finally {
    sdk = undefined;
  }
}

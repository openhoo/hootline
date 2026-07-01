import { defineInstrumentation } from "eve/instrumentation";

import { loadServiceConfig } from "./lib/config.ts";
import { setupOpenTelemetry } from "./lib/otel.ts";

export default defineInstrumentation({
  functionId: "hootline.repair",
  recordInputs: false,
  recordOutputs: false,
  setup: ({ agentName }) => setupOpenTelemetry({ agentName }),
  events: {
    "step.started"(input) {
      const config = loadServiceConfig();
      if (config.telemetryMode === "off") return undefined;
      const attributes = input.session.auth.current?.attributes ?? input.session.auth.initiator?.attributes ?? {};
      return {
        runtimeContext: {
          "hootline.attempt_key": readAttribute(attributes.attemptKey),
          "hootline.provider": readAttribute(attributes.provider),
          "hootline.repo_slug": readAttribute(attributes.repo),
          "hootline.pipeline_id": readAttribute(attributes.pipelineId),
          "hootline.channel_kind": input.channel.kind,
          "hootline.telemetry_detail": config.telemetryDetail,
        },
      };
    },
  },
});

function readAttribute(value: string | readonly string[] | undefined): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.join(",");
  return "";
}

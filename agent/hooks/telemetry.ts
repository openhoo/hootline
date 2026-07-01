import { defineHook } from "eve/hooks";

import { loadServiceConfig } from "../lib/config.ts";
import { createLogger, logError } from "../lib/logger.ts";
import {
  recordTelemetry,
  streamEventTelemetryPayload,
  type TelemetryIdentity,
} from "../lib/telemetry.ts";

const log = createLogger("hooks.telemetry");

export default defineHook({
  events: {
    "*"(event, ctx) {
      try {
        const config = loadServiceConfig();
        const shaped = streamEventTelemetryPayload(
          event,
          config.telemetryDetail,
          config.telemetryMaxTextChars,
        );
        if (shaped === undefined) return;
        const authIdentity = identityFromAuthAttributes(
          ctx.session.auth.current?.attributes ?? ctx.session.auth.initiator?.attributes ?? {},
        );
        recordTelemetry(config, {
          source: "eve-stream",
          type: shaped.type,
          at: shaped.at,
          identity: {
            ...authIdentity,
            ...shaped.identity,
            sessionId: ctx.session.id,
            turnId: shaped.identity.turnId ?? ctx.session.turn.id,
            stepIndex: shaped.identity.stepIndex,
          },
          payload: shaped.payload,
        });
      } catch (error) {
        logError(log, "telemetry hook failed; event ignored", error);
      }
    },
  },
});

function identityFromAuthAttributes(
  attributes: Readonly<Record<string, string | readonly string[]>>,
): TelemetryIdentity {
  return {
    attemptKey: readAttribute(attributes.attemptKey),
    provider: readAttribute(attributes.provider),
    repoSlug: readAttribute(attributes.repo),
    pipelineId: readAttribute(attributes.pipelineId),
  };
}

function readAttribute(value: string | readonly string[] | undefined): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  if (Array.isArray(value) && value.length > 0) return value.join(",");
  return undefined;
}

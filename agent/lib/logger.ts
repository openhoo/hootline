/**
 * Structured logging for Hootline.
 *
 * A thin wrapper over pino that guarantees secret redaction. Eve does not expose
 * a reusable logger (`eve/internal/logging` is not part of its package `exports`,
 * and its own header says "authors should use their own logger"), so we build our
 * own and borrow the shape of Eve's internal logger: a namespaced handle with
 * four levels, structured fields, and a `logError` helper that returns a stable
 * `errorId`.
 *
 * SECURITY: every serialized line passes through {@link redact} via pino's v10
 * `streamWrite` hook before it reaches any sink — JSON destination or the
 * `pino-pretty` transport alike — so a caller cannot leak a token by forgetting
 * to redact a field. Redaction here only replaces secret patterns (never
 * truncates) so the line stays valid JSON.
 *
 * @example
 * ```ts
 * import { createLogger, logError } from "../lib/logger.ts";
 * const log = createLogger("channels.ci");
 * log.info({ provider, deliveryKey }, "webhook received");
 * const errorId = logError(log, "repair session start failed", error, { attemptKey });
 * ```
 */
import { randomUUID } from "node:crypto";
import type { Writable } from "node:stream";

import pino from "pino";

import { redact } from "./redact.ts";

/** Extra structured key/value context attached to a log line. */
export type LogFields = Record<string, unknown>;

/**
 * One namespaced logger handle. Mirrors pino's method shape: each level takes
 * an optional fields object followed by the message. Use {@link Logger.child}
 * to pin correlation fields (e.g. `attemptKey`) onto every subsequent line.
 */
export type Logger = pino.Logger;

// redact() truncates at its `maxLength` and appends a "[truncated]" suffix; that
// would corrupt the stringified JSON the streamWrite hook must return, so we run
// pattern replacement only and never truncate at this stage. Oversized field
// values are expected to be capped by callers (provider clients already do).
const NO_TRUNCATE = Number.MAX_SAFE_INTEGER;

const LOG_LEVELS = new Set(["trace", "debug", "info", "warn", "error", "fatal", "silent"]);

/**
 * Resolve the log level from `PIPELINE_FIXER_LOG_LEVEL` (consistent with the
 * other `PIPELINE_FIXER_*` env vars), defaulting to `info`. `EVE_LOG_LEVEL`
 * separately controls Eve's own framework logs. The `env` argument is injectable
 * for testability, mirroring `resolvePipelineFixerModel`.
 */
export function resolveLogLevel(env: NodeJS.ProcessEnv = process.env): string {
  const level = env.PIPELINE_FIXER_LOG_LEVEL?.toLowerCase();
  return level !== undefined && LOG_LEVELS.has(level) ? level : "info";
}

interface BuildOptions {
  /** Explicit sink (used by tests to capture output without a worker transport). */
  destination?: Writable;
  /** Override the resolved level. */
  level?: string;
  /** Force pretty/JSON instead of auto-detecting a TTY. */
  pretty?: boolean;
  env?: NodeJS.ProcessEnv;
}

function buildBaseLogger(options: BuildOptions = {}): pino.Logger {
  const level = options.level ?? resolveLogLevel(options.env);
  const base: pino.LoggerOptions = {
    level,
    timestamp: pino.stdTimeFunctions.isoTime,
    serializers: { err: pino.stdSerializers.err },
    // Final-line redaction chokepoint: runs in the main thread before the line is
    // handed to any destination or transport (verified for both JSON and pino-pretty).
    hooks: { streamWrite: (line: string) => redact(line, NO_TRUNCATE) },
  };

  if (options.destination !== undefined) {
    return pino(base, options.destination);
  }

  const pretty = options.pretty ?? Boolean(process.stdout.isTTY);
  if (pretty) {
    return pino({
      ...base,
      transport: {
        target: "pino-pretty",
        options: { colorize: true, translateTime: "SYS:standard", ignore: "pid,hostname" },
      },
    });
  }

  // Non-TTY (production/CI): newline-delimited JSON to stdout.
  return pino(base);
}

let baseLogger: pino.Logger | undefined;

function getBaseLogger(): pino.Logger {
  if (baseLogger === undefined) {
    baseLogger = buildBaseLogger();
  }
  return baseLogger;
}

/**
 * Create a logger bound to a stable namespace (e.g. `"channels.ci"`,
 * `"tools.publish_fix"`, `"providers.github"`). The namespace is emitted as `ns`
 * on every line for grep-ability. Attach per-repair correlation with `.child()`:
 * `createLogger("tools.publish_fix").child({ attemptKey, provider })`.
 */
export function createLogger(namespace: string): Logger {
  return getBaseLogger().child({ ns: namespace });
}

/**
 * Create a namespaced logger that writes to an explicit destination stream,
 * bypassing TTY detection and worker transports. Intended for tests that need to
 * capture and assert on output.
 */
export function createLoggerWithDestination(
  namespace: string,
  destination: Writable,
  options: { level?: string } = {},
): Logger {
  const built: BuildOptions = { destination };
  if (options.level !== undefined) built.level = options.level;
  return buildBaseLogger(built).child({ ns: namespace });
}

function toError(value: unknown): Error {
  if (value instanceof Error) return value;
  if (typeof value === "string") return new Error(value);
  try {
    return new Error(JSON.stringify(value));
  } catch {
    return new Error(String(value));
  }
}

/**
 * Log any throwable at `error` severity with a stable, opaque `errorId` and
 * return that id. Normalizes non-`Error` throwables so the pino `err` serializer
 * always renders `name`/`message`/`stack` (then redacted by the streamWrite
 * hook). Include the returned id in user-visible error text so a support ticket
 * quoting it can be grepped back to one incident.
 */
export function logError(
  logger: Logger,
  message: string,
  error: unknown,
  fields: LogFields = {},
): string {
  const errorId = randomUUID();
  logger.error({ ...fields, errorId, err: toError(error) }, message);
  return errorId;
}

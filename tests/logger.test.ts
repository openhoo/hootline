import { test } from "node:test";
import assert from "node:assert/strict";
import { Writable } from "node:stream";

import { createLoggerWithDestination, logError, resolveLogLevel } from "../agent/lib/logger.ts";

// Capture sink: pino writes synchronously to a passed Writable, so tests can read
// `lines` immediately after a log call. Each line is one newline-delimited JSON record.
function makeCapture() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(chunk.toString());
      callback();
    },
  });
  return {
    stream,
    lines,
    get text() {
      return lines.join("");
    },
    records() {
      return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    },
  };
}

test("redacts secrets in the message", () => {
  const cap = makeCapture();
  const log = createLoggerWithDestination("test.redaction", cap.stream, { level: "debug" });
  const secret = "ghp_16ABcdEFghIJklMNopQRstUVwxYZ0123456789";
  log.info(`build failed with token ${secret} oops`);
  assert.ok(!cap.text.includes(secret), "raw token leaked into output");
  assert.ok(cap.text.includes("[REDACTED]"));
});

test("redacts secrets in flat and nested fields, output stays valid JSON", () => {
  const cap = makeCapture();
  const log = createLoggerWithDestination("test.redaction", cap.stream, { level: "debug" });
  log.info(
    {
      password: "hunter2",
      header: "authorization: Bearer abc123secretvalue",
      nested: { pat: "glpat-aB3dE6fG9hI0jK1lM2nO" },
    },
    "publishing",
  );
  assert.ok(!cap.text.includes("hunter2"));
  assert.ok(!cap.text.includes("abc123secretvalue"));
  assert.ok(!cap.text.includes("glpat-aB3dE6fG9hI0jK1lM2nO"));
  assert.ok(cap.text.includes("[REDACTED]"));
  // streamWrite must return valid JSON.
  const record = cap.records()[0];
  assert.equal(record?.["password"], "[REDACTED]");
});

test("redacts AWS and Slack credential patterns through the logger", () => {
  const cap = makeCapture();
  const log = createLoggerWithDestination("test.redaction", cap.stream, { level: "debug" });
  log.info(
    { awsKey: "AKIAIOSFODNN7EXAMPLE", stsKey: "ASIAIOSFODNN7EXAMPLE", slackToken: "xoxb-2345678901-AbCdEfGhIjKl" },
    "provider env dump",
  );
  assert.ok(!cap.text.includes("AKIAIOSFODNN7EXAMPLE"));
  assert.ok(!cap.text.includes("ASIAIOSFODNN7EXAMPLE"));
  assert.ok(!cap.text.includes("xoxb-2345678901-AbCdEfGhIjKl"));
  assert.ok(cap.text.includes("[REDACTED]"));
  // streamWrite must keep the line valid JSON even after replacing every secret.
  assert.doesNotThrow(() => cap.records());
});

test("level filtering suppresses lines below the configured level", () => {
  const cap = makeCapture();
  const log = createLoggerWithDestination("test.level", cap.stream, { level: "info" });
  log.debug("should be hidden");
  assert.equal(cap.lines.length, 0, "debug line emitted at info level");
  log.info("should appear");
  assert.equal(cap.lines.length, 1);
});

test("namespace and correlation fields appear on every line", () => {
  const cap = makeCapture();
  const log = createLoggerWithDestination("channels.ci", cap.stream, { level: "debug" }).child({
    attemptKey: "github:org/repo:abc123:99",
    provider: "github",
  });
  log.info("repair slot accepted");
  const record = cap.records()[0];
  assert.equal(record?.["ns"], "channels.ci");
  assert.equal(record?.["attemptKey"], "github:org/repo:abc123:99");
  assert.equal(record?.["provider"], "github");
  assert.equal(record?.["msg"], "repair slot accepted");
});

test("separate loggers maintain distinct namespaces", () => {
  const cap = makeCapture();
  const a = createLoggerWithDestination("channels.ci", cap.stream, { level: "debug" });
  const b = createLoggerWithDestination("tools.publish_fix", cap.stream, { level: "debug" });
  a.info("first");
  b.info("second");
  const records = cap.records();
  assert.equal(records[0]?.["ns"], "channels.ci");
  assert.equal(records[1]?.["ns"], "tools.publish_fix");
});

test("clean text with no secrets passes through unchanged", () => {
  const cap = makeCapture();
  const log = createLoggerWithDestination("test.clean", cap.stream, { level: "debug" });
  const message = "Build failed: expected 2 arguments but got 3 in main.ts line 42.";
  log.info(message);
  assert.equal(cap.records()[0]?.["msg"], message);
});

test("logError returns a UUID errorId and records the error", () => {
  const cap = makeCapture();
  const log = createLoggerWithDestination("test.error", cap.stream, { level: "debug" });
  const errorId = logError(log, "repair session start failed", new Error("boom"), {
    attemptKey: "k",
  });
  assert.match(errorId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  const record = cap.records()[0];
  assert.equal(record?.["level"], 50); // pino numeric level for "error"
  assert.equal(record?.["errorId"], errorId);
  assert.equal(record?.["attemptKey"], "k");
  assert.equal((record?.["err"] as Record<string, unknown>)?.["message"], "boom");
});

test("logError normalizes non-Error throwables and redacts them", () => {
  const cap = makeCapture();
  const log = createLoggerWithDestination("test.error", cap.stream, { level: "debug" });
  // A plain object that crossed a boundary, carrying a secret.
  logError(log, "provider call failed", { detail: "token glpat-aB3dE6fG9hI0jK1lM2nO" });
  assert.ok(!cap.text.includes("glpat-aB3dE6fG9hI0jK1lM2nO"));
  assert.ok(cap.text.includes("[REDACTED]"));
  const err = cap.records()[0]?.["err"] as Record<string, unknown>;
  assert.ok(typeof err?.["message"] === "string");
});

test("resolveLogLevel honors PIPELINE_FIXER_LOG_LEVEL and defaults to info", () => {
  assert.equal(resolveLogLevel({}), "info");
  assert.equal(resolveLogLevel({ PIPELINE_FIXER_LOG_LEVEL: "DEBUG" }), "debug");
  assert.equal(resolveLogLevel({ PIPELINE_FIXER_LOG_LEVEL: "bogus" }), "info");
});

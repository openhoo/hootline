import assert from "node:assert/strict";
import test from "node:test";

import {
  createObservationState,
  finalizeObservation,
  observeStreamEvent,
  shouldSendRepairContinuation,
  toLocalContinuationToken,
} from "../agent/lib/session-monitor.ts";

test("classifies output-limit waits as continuation candidates", () => {
  const state = createObservationState();
  observeStreamEvent(state, {
    type: "actions.requested",
    data: {
      actions: [{ toolName: "stage_repository_snapshot" }, { toolName: "read_file" }],
    },
  });
  observeStreamEvent(state, {
    type: "step.completed",
    meta: { at: "2026-06-30T10:00:00.000Z" },
    data: {
      finishReason: "length",
      usage: { inputTokens: 1000, outputTokens: 40000 },
    },
  });
  observeStreamEvent(state, {
    type: "session.waiting",
    meta: { at: "2026-06-30T10:00:01.000Z" },
    data: {},
  });

  const observation = finalizeObservation(state);

  assert.equal(observation.status, "waiting");
  assert.equal(observation.failureKind, "length");
  assert.equal(observation.outputTokens, 40000);
  assert.deepEqual(observation.toolSequence, ["stage_repository_snapshot", "read_file"]);
  assert.equal(shouldSendRepairContinuation(observation, 0, 1), true);
  assert.equal(shouldSendRepairContinuation(observation, 1, 1), false);
});

test("recognizes successful publish_fix as terminal completion", () => {
  const state = createObservationState();
  observeStreamEvent(state, {
    type: "action.result",
    data: {
      status: "completed",
      result: {
        toolName: "publish_fix",
        output: { published: true, result: { branch: "hootline/fix/main/abc123" } },
      },
    },
  });
  observeStreamEvent(state, { type: "session.waiting", data: {} });

  const observation = finalizeObservation(state);

  assert.equal(observation.status, "completed");
  assert.equal(observation.terminalAction, "published");
  assert.equal(observation.eventsSeen, 2);
  assert.equal(observation.failureKind, undefined);
  assert.equal(shouldSendRepairContinuation(observation, 0, 1), false);
});

test("does not auto-continue when the model requested human input", () => {
  const state = createObservationState();
  observeStreamEvent(state, { type: "input.requested", data: { requests: [] } });
  observeStreamEvent(state, { type: "session.waiting", data: {} });

  const observation = finalizeObservation(state);

  assert.equal(observation.humanInputRequested, true);
  assert.equal(observation.failureKind, "human_input_requested");
  assert.equal(shouldSendRepairContinuation(observation, 0, 1), false);
});

test("extracts channel-local continuation tokens from namespaced Eve tokens", () => {
  assert.equal(
    toLocalContinuationToken("ci:github:openhoo/fixture:abc123:1001", "fallback"),
    "github:openhoo/fixture:abc123:1001",
  );
  assert.equal(toLocalContinuationToken("not-namespaced", "fallback"), "fallback");
});

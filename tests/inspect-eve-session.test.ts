import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const SESSION_ID = "wrun_test";

test("session inspector does not double count telemetry step and boundary usage", () => {
  const root = mkdtempSync(join(tmpdir(), "hootline-inspect-"));
  try {
    const workflowData = writeWorkflowData(root);
    const telemetryPath = join(root, "telemetry.jsonl");
    writeFileSync(
      telemetryPath,
      [
        JSON.stringify({
          source: "eve-stream",
          type: "step.completed",
          identity: { sessionId: SESSION_ID },
          payload: { usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 3, cacheWriteTokens: 4 } },
        }),
        JSON.stringify({
          source: "repair-service",
          type: "repair.session.boundary",
          identity: { sessionId: SESSION_ID },
          payload: { usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 3, cacheWriteTokens: 4 } },
        }),
      ].join("\n"),
    );

    const report = runInspector(root, workflowData, telemetryPath);

    assert.equal(report.telemetry.records, 2);
    assert.deepEqual(report.telemetry.tokens, {
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 3,
      cacheWriteTokens: 4,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("session inspector uses boundary telemetry usage as fallback", () => {
  const root = mkdtempSync(join(tmpdir(), "hootline-inspect-"));
  try {
    const workflowData = writeWorkflowData(root);
    const telemetryPath = join(root, "telemetry.jsonl");
    writeFileSync(
      telemetryPath,
      `${JSON.stringify({
        source: "repair-service",
        type: "repair.session.boundary",
        identity: { sessionId: SESSION_ID },
        payload: { usage: { inputTokens: 30, outputTokens: 40, cacheReadTokens: 5, cacheWriteTokens: 6 } },
      })}\n`,
    );

    const report = runInspector(root, workflowData, telemetryPath);

    assert.deepEqual(report.telemetry.tokens, {
      inputTokens: 30,
      outputTokens: 40,
      cacheReadTokens: 5,
      cacheWriteTokens: 6,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function writeWorkflowData(root: string): string {
  const workflowData = join(root, ".workflow-data");
  const runsDir = join(workflowData, "streams", "runs");
  const chunksDir = join(workflowData, "streams", "chunks");
  mkdirSync(runsDir, { recursive: true });
  mkdirSync(chunksDir, { recursive: true });
  writeFileSync(join(runsDir, `${SESSION_ID}.json`), JSON.stringify({ streams: ["strm_1"] }));

  const events = [
    { type: "session.started", data: { runtime: { agentName: "hootline.repair" } } },
    {
      type: "step.completed",
      meta: { at: "2026-07-01T00:00:00.000Z" },
      data: { stepIndex: 0, finishReason: "stop", usage: { inputTokens: 10, outputTokens: 20 } },
    },
    { type: "session.waiting", data: {} },
  ];
  const body = `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
  const encoded = Buffer.from(body, "utf8").toString("base64");
  writeFileSync(join(chunksDir, "strm_1-chnk_000.json"), JSON.stringify([encoded]));
  return workflowData;
}

function runInspector(root: string, workflowData: string, telemetryPath: string): {
  telemetry: {
    records: number;
    tokens: {
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
    };
  };
} {
  const output = execFileSync(
    process.execPath,
    [
      join(process.cwd(), "scripts", "inspect-eve-session.mjs"),
      SESSION_ID,
      "--workflow-data",
      workflowData,
      "--state",
      join(root, "missing-state.json"),
      "--telemetry",
      telemetryPath,
      "--json",
    ],
    { encoding: "utf8" },
  );
  return JSON.parse(output);
}

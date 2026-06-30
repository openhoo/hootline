import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import type { SendFn } from "eve/channels";

import { dispatchPipelineEvent } from "../agent/lib/repair-service.ts";
import { registerProviderClient } from "../agent/lib/providers/index.ts";
import type { FailureContext, NormalizedPipelineEvent } from "../agent/lib/types.ts";
import { loadState } from "../agent/lib/state.ts";
import type { ProviderClient } from "../agent/lib/providers/common.ts";

test("repair service claims a failed event and records a terminal published session", async () => {
  const previousStatePath = process.env.HOOTLINE_STATE_PATH;
  const root = mkdtempSync(join(tmpdir(), "hootline-repair-service-"));
  const statePath = join(root, "state.json");
  process.env.HOOTLINE_STATE_PATH = statePath;
  const event = makeEvent();
  const provider = makeProvider(event);
  const restoreProvider = registerProviderClient("github", provider);
  const waitTasks: Promise<unknown>[] = [];
  const sent: unknown[] = [];
  const fakeSend = async (message: unknown): Promise<unknown> => {
    sent.push(message);
    return {
      id: "session-1",
      continuationToken: "github:session-1:next",
      async getEventStream(): Promise<ReadableStream<unknown>> {
        return new ReadableStream<unknown>({
          start(controller) {
            controller.enqueue({
              type: "action.result",
              data: {
                status: "completed",
                result: {
                  toolName: "publish_fix",
                  output: { published: true },
                },
              },
              meta: { at: "2026-06-30T10:00:00.000Z" },
            });
            controller.enqueue({
              type: "session.completed",
              data: {},
              meta: { at: "2026-06-30T10:00:01.000Z" },
            });
            controller.close();
          },
        });
      },
    };
  };

  const response = await dispatchPipelineEvent(
    event,
    fakeSend as SendFn,
    (task) => waitTasks.push(task),
  );

  try {
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, accepted: true, attempt: 1 });
    await Promise.all(waitTasks);

    assert.equal(sent.length, 1);
    const attempts = Object.values(loadState(statePath).attempts);
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0]?.lastTerminalAction, "published");
    assert.equal(attempts[0]?.lastSessionStatus, "completed");
    const failureContext = attempts[0]?.lastFailureContext;
    assert.ok(failureContext !== undefined && "summary" in failureContext);
    assert.equal(failureContext.summary, "failed");
  } finally {
    restoreProvider();
    restoreEnv("HOOTLINE_STATE_PATH", previousStatePath);
    rmSync(root, { recursive: true, force: true });
  }
});

function makeProvider(event: NormalizedPipelineEvent): ProviderClient {
  const failureContext: FailureContext = {
    event,
    jobs: [{ id: "job-1", name: "test", status: "completed", conclusion: "failure", log: "failed" }],
    summary: "failed",
  };
  return {
    async readRepositoryFileFromDefaultBranch() {
      return [
        "version: 1",
        "allowedBranches: [main]",
        "allowedFileGlobs: [src/**]",
        "verificationCommands: [npm test]",
        "",
      ].join("\n");
    },
    async getFailureContext() {
      return failureContext;
    },
    async downloadArchive() {
      throw new Error("not used");
    },
    async publishFix() {
      throw new Error("not used");
    },
    async postComment() {
      throw new Error("not used");
    },
    async rerunPipeline() {
      throw new Error("not used");
    },
    async mergeChange() {
      throw new Error("not used");
    },
  };
}

function makeEvent(): NormalizedPipelineEvent {
  return {
    provider: "github",
    id: "github:owner/repo:1001:abc123def456",
    deliveryId: "delivery-1",
    repoSlug: "owner/repo",
    installationId: 123,
    pipelineId: "1001",
    pipelineUrl: "https://github.com/owner/repo/actions/runs/1001",
    runId: "1001",
    ref: "main",
    sha: "abc123def4567890",
    source: "push",
    status: "completed",
    conclusion: "failure",
    eventName: "workflow_run",
    receivedAt: "2026-06-30T10:00:00.000Z",
  };
}

function restoreEnv(name: string, previous: string | undefined): void {
  if (previous === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = previous;
  }
}

import { defineChannel, POST } from "eve/channels";

import { createLogger } from "../lib/logger.ts";
import { dispatchPipelineEvent } from "../lib/repair-service.ts";
import { normalizeGitHubEvent, normalizeGitLabEvent, verifyGitHubWebhook, verifyGitLabWebhookRequest } from "../lib/webhooks.ts";
import type { NormalizedPipelineEvent } from "../lib/types.ts";

const log = createLogger("channels.ci");
const MAX_WEBHOOK_BODY_BYTES = 1024 * 1024;

export default defineChannel({
  routes: [
    POST("/eve/v1/ci/github", async (req, { send, waitUntil }) => {
      const bodyResult = await readWebhookBody(req, "github");
      if (!bodyResult.ok) return bodyResult.response;
      const body = bodyResult.body;
      if (!verifyGitHubWebhook(body, req.headers)) {
        log.warn(
          { provider: "github", deliveryId: req.headers.get("x-github-delivery") },
          "github webhook signature verification failed",
        );
        return Response.json({ ok: false, error: "invalid_signature" }, { status: 401 });
      }
      const event = normalizeGitHubEvent(parseJson(body), req.headers);
      return dispatchPipelineEvent(event, send, waitUntil);
    }),
    POST("/eve/v1/ci/gitlab", async (req, { send, waitUntil }) => {
      const bodyResult = await readWebhookBody(req, "gitlab");
      if (!bodyResult.ok) return bodyResult.response;
      const body = bodyResult.body;
      const verification = verifyGitLabWebhookRequest(body, req.headers);
      if (verification === "none") {
        log.warn(
          { provider: "gitlab", deliveryId: req.headers.get("x-gitlab-event-uuid") },
          "gitlab webhook signature verification failed",
        );
        return Response.json({ ok: false, error: "invalid_signature" }, { status: 401 });
      }
      const payload = parseJson(body);
      const event = normalizeGitLabEvent(payload, req.headers);
      if (event === null) return Response.json({ ok: true, ignored: true });
      return dispatchPipelineEvent(event, send, waitUntil, verification);
    }),
  ],
});

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

type WebhookBodyReadResult =
  | { ok: true; body: string }
  | { ok: false; response: Response };

async function readWebhookBody(
  req: Request,
  provider: NormalizedPipelineEvent["provider"],
): Promise<WebhookBodyReadResult> {
  const contentLength = readContentLength(req.headers.get("content-length"));
  if (contentLength !== undefined && contentLength > MAX_WEBHOOK_BODY_BYTES) {
    log.warn({ provider, contentLength }, "webhook body rejected before read: content-length too large");
    return { ok: false, response: webhookBodyTooLargeResponse() };
  }
  if (req.body === null) return { ok: true, body: "" };

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      bytes += value.byteLength;
      if (bytes > MAX_WEBHOOK_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        log.warn({ provider, bytes }, "webhook body rejected while reading: body too large");
        return { ok: false, response: webhookBodyTooLargeResponse() };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  return { ok: true, body: new TextDecoder().decode(Buffer.concat(chunks)) };
}

function webhookBodyTooLargeResponse(): Response {
  return Response.json(
    { ok: false, error: "webhook_body_too_large", maxBytes: MAX_WEBHOOK_BODY_BYTES },
    { status: 413 },
  );
}

function readContentLength(value: string | null): number | undefined {
  if (value === null) return undefined;
  if (!/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

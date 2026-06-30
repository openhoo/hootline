import { createHmac } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";

import {
  isFailedConclusion,
  isSuccessfulConclusion,
  normalizeGitHubEvent,
  normalizeGitLabEvent,
  verifyGitHubWebhook,
  verifyGitLabStandardWebhook,
  verifyGitLabWebhook,
  verifyGitLabWebhookRequest,
} from "../agent/lib/webhooks.ts";

test("verifies and normalizes a failed GitHub workflow_run webhook", () => {
  const previousSecret = process.env.GITHUB_WEBHOOK_SECRET;
  process.env.GITHUB_WEBHOOK_SECRET = "github-secret";
  try {
    const payload = {
      action: "completed",
      workflow_run: {
        conclusion: "failure",
        event: "pull_request",
        head_branch: "feature/fix-ci",
        head_sha: "abc123def456",
        html_url: "https://github.com/owner/repo/actions/runs/1001",
        id: 1001,
        pull_requests: [{ number: 42, base: { ref: "main" } }],
        status: "completed",
      },
      repository: { full_name: "owner/repo" },
      installation: { id: 12345 },
      sender: { login: "octocat" },
    };
    const body = JSON.stringify(payload);
    const signature = `sha256=${createHmac("sha256", "github-secret").update(body).digest("hex")}`;
    const headers = new Headers({
      "x-github-delivery": "delivery-1",
      "x-github-event": "workflow_run",
      "x-hub-signature-256": signature,
    });

    assert.equal(verifyGitHubWebhook(body, headers), true);
    const event = normalizeGitHubEvent(payload, headers);

    assert.equal(event?.provider, "github");
    assert.equal(event?.deliveryId, "delivery-1");
    assert.equal(event?.repoSlug, "owner/repo");
    assert.equal(event?.ref, "feature/fix-ci");
    assert.equal(event?.targetBranch, "main");
    assert.equal(event?.pullRequestNumber, 42);
    assert.equal(event?.installationId, 12345);
    assert.equal(isFailedConclusion(event?.conclusion ?? ""), true);
    assert.equal(isSuccessfulConclusion(event?.conclusion ?? ""), false);
  } finally {
    if (previousSecret === undefined) {
      delete process.env.GITHUB_WEBHOOK_SECRET;
    } else {
      process.env.GITHUB_WEBHOOK_SECRET = previousSecret;
    }
  }
});

test("verifies and normalizes a GitLab Standard Webhooks pipeline event", () => {
  const body = JSON.stringify({
    object_kind: "pipeline",
    object_attributes: {
      id: 2002,
      ref: "main",
      sha: "fedcba987654",
      source: "push",
      status: "failed",
      url: "https://gitlab.com/group/project/-/pipelines/2002",
    },
    project: {
      id: 55,
      path_with_namespace: "group/project",
      web_url: "https://gitlab.com/group/project",
    },
    merge_requests: [{ iid: 7, target_branch: "main" }],
    user: { username: "gitlab-user" },
  });
  const rawSecret = Buffer.from("standard-webhook-secret").toString("base64");
  const signingToken = `whsec_${rawSecret}`;
  const messageId = "msg-1";
  // Use a fresh timestamp: verifyGitLabStandardWebhook now enforces a replay window
  // (GITLAB_WEBHOOK_TOLERANCE_SECONDS), so a hardcoded stale timestamp would be rejected.
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = `v1,${createHmac("sha256", Buffer.from(rawSecret, "base64"))
    .update(`${messageId}.${timestamp}.${body}`)
    .digest("base64")}`;
  const headers = new Headers({
    "webhook-id": messageId,
    "webhook-signature": signature,
    "webhook-timestamp": timestamp,
    "x-gitlab-event": "Pipeline Hook",
  });

  assert.equal(verifyGitLabStandardWebhook(body, signingToken, messageId, timestamp, signature), true);

  const previousToken = process.env.GITLAB_SIGNING_TOKEN;
  process.env.GITLAB_SIGNING_TOKEN = signingToken;
  try {
    assert.equal(verifyGitLabWebhook(body, headers, { allowGitlabSecretTokenFallback: false }), true);
  } finally {
    if (previousToken === undefined) {
      delete process.env.GITLAB_SIGNING_TOKEN;
    } else {
      process.env.GITLAB_SIGNING_TOKEN = previousToken;
    }
  }

  const payload: unknown = JSON.parse(body);
  const event = normalizeGitLabEvent(payload, headers);
  assert.equal(event?.provider, "gitlab");
  assert.equal(event?.deliveryId, messageId);
  assert.equal(event?.repoSlug, "group/project");
  assert.equal(event?.projectId, "55");
  assert.equal(event?.pipelineId, "2002");
  assert.equal(event?.mergeRequestIid, 7);
  assert.equal(event?.targetBranch, "main");
  assert.equal(isFailedConclusion(event?.conclusion ?? ""), true);
});

test("rejects GitHub webhooks with a tampered body, wrong secret, or missing signature", () => {
  const previousSecret = process.env.GITHUB_WEBHOOK_SECRET;
  process.env.GITHUB_WEBHOOK_SECRET = "github-secret";
  try {
    const body = JSON.stringify({ action: "completed", workflow_run: { id: 1001 } });
    const signature = `sha256=${createHmac("sha256", "github-secret").update(body).digest("hex")}`;

    // Mutate a single byte of the body so the signature no longer matches.
    const tamperedBody = `${body.slice(0, -1)} `;
    assert.notEqual(tamperedBody, body);
    assert.equal(tamperedBody.length, body.length);
    assert.equal(
      verifyGitHubWebhook(
        tamperedBody,
        new Headers({ "x-hub-signature-256": signature }),
      ),
      false,
    );

    // A signature computed with a different secret must not verify.
    const wrongSignature = `sha256=${createHmac("sha256", "different-secret").update(body).digest("hex")}`;
    assert.equal(
      verifyGitHubWebhook(body, new Headers({ "x-hub-signature-256": wrongSignature })),
      false,
    );

    // A missing x-hub-signature-256 header must not verify.
    assert.equal(verifyGitHubWebhook(body, new Headers()), false);
  } finally {
    if (previousSecret === undefined) {
      delete process.env.GITHUB_WEBHOOK_SECRET;
    } else {
      process.env.GITHUB_WEBHOOK_SECRET = previousSecret;
    }
  }
});

test("verifyGitHubWebhook throws when GITHUB_WEBHOOK_SECRET is unset", () => {
  const previousSecret = process.env.GITHUB_WEBHOOK_SECRET;
  delete process.env.GITHUB_WEBHOOK_SECRET;
  try {
    assert.throws(
      () => verifyGitHubWebhook("{}", new Headers({ "x-hub-signature-256": "sha256=deadbeef" })),
      /GITHUB_WEBHOOK_SECRET is required\./,
    );
  } finally {
    if (previousSecret === undefined) {
      delete process.env.GITHUB_WEBHOOK_SECRET;
    } else {
      process.env.GITHUB_WEBHOOK_SECRET = previousSecret;
    }
  }
});

test("rejects GitLab Standard Webhooks with a wrong token or tampered fields", () => {
  const body = JSON.stringify({ object_kind: "pipeline", object_attributes: { id: 2002 } });
  const rawSecret = Buffer.from("standard-webhook-secret").toString("base64");
  const signingToken = `whsec_${rawSecret}`;
  const messageId = "msg-1";
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const sign = (id: string, ts: string, payload: string): string =>
    `v1,${createHmac("sha256", Buffer.from(rawSecret, "base64"))
      .update(`${id}.${ts}.${payload}`)
      .digest("base64")}`;
  const signature = sign(messageId, timestamp, body);

  // Sanity check: the well-formed signature verifies.
  assert.equal(verifyGitLabStandardWebhook(body, signingToken, messageId, timestamp, signature), true);

  // A different signing token must not verify.
  const wrongRawSecret = Buffer.from("other-webhook-secret").toString("base64");
  assert.equal(
    verifyGitLabStandardWebhook(body, `whsec_${wrongRawSecret}`, messageId, timestamp, signature),
    false,
  );

  // A tampered messageId, timestamp, or body must not verify against the original signature.
  assert.equal(
    verifyGitLabStandardWebhook(body, signingToken, "msg-2", timestamp, signature),
    false,
  );
  const newerTimestamp = (Number.parseInt(timestamp, 10) + 1).toString();
  assert.equal(
    verifyGitLabStandardWebhook(body, signingToken, messageId, newerTimestamp, signature),
    false,
  );
  const tamperedBody = JSON.stringify({ object_kind: "pipeline", object_attributes: { id: 9999 } });
  // The original signature does not cover the tampered body.
  assert.equal(
    verifyGitLabStandardWebhook(tamperedBody, signingToken, messageId, timestamp, signature),
    false,
  );

  // A space-delimited multi-signature header verifies when ANY token is valid.
  const multiValidSecond = `${sign(messageId, timestamp, tamperedBody)} ${signature}`;
  assert.equal(
    verifyGitLabStandardWebhook(body, signingToken, messageId, timestamp, multiValidSecond),
    true,
  );
  const multiAllBad = `${sign(messageId, timestamp, tamperedBody)} ${sign("msg-2", timestamp, body)}`;
  assert.equal(
    verifyGitLabStandardWebhook(body, signingToken, messageId, timestamp, multiAllBad),
    false,
  );
});

test("rejects a GitLab Standard Webhook with a stale timestamp beyond the replay window", () => {
  const body = JSON.stringify({ object_kind: "pipeline", object_attributes: { id: 2002 } });
  const rawSecret = Buffer.from("standard-webhook-secret").toString("base64");
  const signingToken = `whsec_${rawSecret}`;
  const messageId = "msg-1";
  // ~10 minutes old, well beyond the 300s tolerance, but otherwise a valid signature.
  const staleTimestamp = (Math.floor(Date.now() / 1000) - 600).toString();
  const signature = `v1,${createHmac("sha256", Buffer.from(rawSecret, "base64"))
    .update(`${messageId}.${staleTimestamp}.${body}`)
    .digest("base64")}`;

  assert.equal(
    verifyGitLabStandardWebhook(body, signingToken, messageId, staleTimestamp, signature),
    false,
  );
});

test("rejects a GitLab Standard Webhook timestamp with trailing junk", () => {
  const body = JSON.stringify({ object_kind: "pipeline", object_attributes: { id: 2002 } });
  const rawSecret = Buffer.from("standard-webhook-secret").toString("base64");
  const signingToken = `whsec_${rawSecret}`;
  const messageId = "msg-1";
  const timestamp = `${Math.floor(Date.now() / 1000)}junk`;
  const signature = `v1,${createHmac("sha256", Buffer.from(rawSecret, "base64"))
    .update(`${messageId}.${timestamp}.${body}`)
    .digest("base64")}`;

  assert.equal(
    verifyGitLabStandardWebhook(body, signingToken, messageId, timestamp, signature),
    false,
  );
});

test("verifyGitLabWebhookRequest returns none without standard headers or x-gitlab-token", () => {
  const previousSigningToken = process.env.GITLAB_SIGNING_TOKEN;
  const previousSecretToken = process.env.GITLAB_SECRET_TOKEN;
  delete process.env.GITLAB_SIGNING_TOKEN;
  delete process.env.GITLAB_SECRET_TOKEN;
  try {
    const body = JSON.stringify({ object_kind: "pipeline" });
    assert.equal(
      verifyGitLabWebhookRequest(body, new Headers({ "x-gitlab-event": "Pipeline Hook" })),
      "none",
    );
  } finally {
    if (previousSigningToken === undefined) {
      delete process.env.GITLAB_SIGNING_TOKEN;
    } else {
      process.env.GITLAB_SIGNING_TOKEN = previousSigningToken;
    }
    if (previousSecretToken === undefined) {
      delete process.env.GITLAB_SECRET_TOKEN;
    } else {
      process.env.GITLAB_SECRET_TOKEN = previousSecretToken;
    }
  }
});

test("classifies GitLab legacy token verification without trusting payload policy first", () => {
  const previousSigningToken = process.env.GITLAB_SIGNING_TOKEN;
  const previousSecretToken = process.env.GITLAB_SECRET_TOKEN;
  delete process.env.GITLAB_SIGNING_TOKEN;
  process.env.GITLAB_SECRET_TOKEN = "legacy-secret";
  try {
    const body = JSON.stringify({
      object_kind: "pipeline",
      object_attributes: {
        id: 2003,
        ref: "main",
        sha: "fedcba987654",
        status: "failed",
      },
      project: {
        id: 56,
        path_with_namespace: "group/project",
      },
    });
    const headers = new Headers({
      "x-gitlab-token": "legacy-secret",
      "x-gitlab-event": "Pipeline Hook",
    });

    assert.equal(verifyGitLabWebhookRequest(body, headers), "secret_token");
    assert.equal(verifyGitLabWebhook(body, headers, { allowGitlabSecretTokenFallback: false }), false);
    assert.equal(verifyGitLabWebhook(body, headers, { allowGitlabSecretTokenFallback: true }), true);
  } finally {
    if (previousSigningToken === undefined) {
      delete process.env.GITLAB_SIGNING_TOKEN;
    } else {
      process.env.GITLAB_SIGNING_TOKEN = previousSigningToken;
    }
    if (previousSecretToken === undefined) {
      delete process.env.GITLAB_SECRET_TOKEN;
    } else {
      process.env.GITLAB_SECRET_TOKEN = previousSecretToken;
    }
  }
});

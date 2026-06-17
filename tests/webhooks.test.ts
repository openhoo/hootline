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
  const timestamp = "1710000000";
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

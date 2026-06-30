import assert from "node:assert/strict";
import test from "node:test";

import { resolvePipelineFixerModel, resolvePipelineFixerModelContextWindowTokens } from "../agent/lib/model.ts";

test("defaults to direct Anthropic instead of AI Gateway", () => {
  const model = readModelMetadata(resolvePipelineFixerModel({ ANTHROPIC_API_KEY: "test-key" }));

  assert.equal(model.modelId, "claude-sonnet-4-6");
  assert.equal(model.provider, "anthropic.messages");
});

test("normalizes legacy prefixed Anthropic model ids for direct provider mode", () => {
  const model = readModelMetadata(
    resolvePipelineFixerModel({
      HOOTLINE_MODEL_PROVIDER: "anthropic",
      HOOTLINE_MODEL: "anthropic/claude-sonnet-4.6",
      ANTHROPIC_API_KEY: "test-key",
    }),
  );

  assert.equal(model.modelId, "claude-sonnet-4-6");
  assert.equal(model.provider, "anthropic.messages");
});

test("passes Anthropic auth tokens to the provider headers", () => {
  const model = resolvePipelineFixerModel({
    HOOTLINE_MODEL_PROVIDER: "anthropic",
    ANTHROPIC_AUTH_TOKEN: "test-auth-token",
  }) as { config?: { headers?: () => Record<string, string> } };

  assert.equal(model.config?.headers?.().authorization, "Bearer test-auth-token");
});

test("resolves direct OpenAI models", () => {
  const model = readModelMetadata(
    resolvePipelineFixerModel({
      HOOTLINE_MODEL_PROVIDER: "openai",
      HOOTLINE_MODEL: "gpt-5.1",
      OPENAI_API_KEY: "test-key",
    }),
  );

  assert.equal(model.modelId, "gpt-5.1");
  assert.equal(model.provider, "openai.responses");
});

test("resolves OpenAI-compatible models with a configured base URL", () => {
  const model = readModelMetadata(
    resolvePipelineFixerModel({
      HOOTLINE_MODEL_PROVIDER: "openai-compatible",
      HOOTLINE_MODEL: "local-coder",
      HOOTLINE_MODEL_BASE_URL: "http://127.0.0.1:11434/v1",
      HOOTLINE_MODEL_CONTEXT_WINDOW_TOKENS: "4096",
      HOOTLINE_MODEL_PROVIDER_NAME: "local-test",
    }),
  );

  assert.equal(model.modelId, "local-coder");
  assert.equal(model.provider, "local-test.chat");
  assert.equal(
      resolvePipelineFixerModelContextWindowTokens({
        HOOTLINE_MODEL_PROVIDER: "openai-compatible",
        HOOTLINE_MODEL_CONTEXT_WINDOW_TOKENS: "4096",
    }),
    4096,
  );
});

test("resolves the documented Cerebras OpenAI-compatible model id without a provider prefix", () => {
  const model = readModelMetadata(
    resolvePipelineFixerModel({
      HOOTLINE_MODEL_PROVIDER: "openai-compatible",
      HOOTLINE_MODEL: "gemma-4-31b",
      HOOTLINE_MODEL_BASE_URL: "https://api.cerebras.ai/v1",
      HOOTLINE_MODEL_CONTEXT_WINDOW_TOKENS: "65536",
      HOOTLINE_MODEL_PROVIDER_NAME: "cerebras",
    }),
  );

  assert.equal(model.modelId, "gemma-4-31b");
  assert.equal(model.provider, "cerebras.chat");
});

test("keeps AI Gateway available only as an explicit provider mode", () => {
  assert.equal(
    resolvePipelineFixerModel({
      HOOTLINE_MODEL_PROVIDER: "gateway",
      HOOTLINE_MODEL: "anthropic/claude-sonnet-4.6",
      AI_GATEWAY_API_KEY: "test-key",
    }),
    "anthropic/claude-sonnet-4.6",
  );
});

test("resolves deterministic mock model without external credentials", () => {
  const model = readModelMetadata(
    resolvePipelineFixerModel({
      HOOTLINE_MODEL_PROVIDER: "mock",
      HOOTLINE_MODEL: "hootline-test-script",
    }),
  );

  assert.equal(model.modelId, "hootline-test-script");
  assert.equal(model.provider, "hootline.mock");
  assert.equal(resolvePipelineFixerModelContextWindowTokens({ HOOTLINE_MODEL_PROVIDER: "mock" }), undefined);
});

test("rejects unsupported and incomplete model provider configuration", () => {
  assert.throws(
    () => resolvePipelineFixerModel({ HOOTLINE_MODEL_PROVIDER: "made-up" }),
    /Unsupported HOOTLINE_MODEL_PROVIDER/,
  );
  assert.throws(
    () => resolvePipelineFixerModel({ HOOTLINE_MODEL_PROVIDER: "anthropic" }),
    /Missing model credential/,
  );
  assert.throws(
    () => resolvePipelineFixerModel({ HOOTLINE_MODEL_PROVIDER: "openai" }),
    /Missing model credential/,
  );
  assert.throws(
    () => resolvePipelineFixerModel({ HOOTLINE_MODEL_PROVIDER: "gateway" }),
    /Missing model credential/,
  );
  assert.throws(
    () => resolvePipelineFixerModel({ HOOTLINE_MODEL_PROVIDER: "openai-compatible" }),
    /HOOTLINE_MODEL_BASE_URL is required/,
  );
  assert.throws(
    () => resolvePipelineFixerModelContextWindowTokens({ HOOTLINE_MODEL_PROVIDER: "openai-compatible" }),
    /HOOTLINE_MODEL_CONTEXT_WINDOW_TOKENS is required/,
  );
  assert.throws(
    () =>
      resolvePipelineFixerModelContextWindowTokens({
        HOOTLINE_MODEL_CONTEXT_WINDOW_TOKENS: "10",
      }),
    /HOOTLINE_MODEL_CONTEXT_WINDOW_TOKENS must be between/,
  );
});

function readModelMetadata(model: unknown): { modelId: string; provider: string } {
  assert.equal(typeof model, "object");
  assert.notEqual(model, null);
  const record = model as Record<string, unknown>;
  return {
    modelId: requireString(record.modelId, "modelId"),
    provider: requireString(record.provider, "provider"),
  };
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    assert.fail(`Expected ${field} to be a string.`);
  }
  return value;
}

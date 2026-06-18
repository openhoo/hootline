#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const cases = [
  {
    name: "direct Anthropic",
    expectedRouting: { kind: "external", provider: "anthropic" },
    env: {
      ANTHROPIC_API_KEY: "test-anthropic-key",
      HOOTLINE_MODEL: "claude-sonnet-4-6",
      HOOTLINE_MODEL_CONTEXT_WINDOW_TOKENS: "1000000",
      HOOTLINE_MODEL_PROVIDER: "anthropic",
    },
  },
  {
    name: "direct OpenAI",
    expectedRouting: { kind: "external", provider: "openai" },
    env: {
      OPENAI_API_KEY: "test-openai-key",
      HOOTLINE_MODEL: "gpt-5.1",
      HOOTLINE_MODEL_CONTEXT_WINDOW_TOKENS: "400000",
      HOOTLINE_MODEL_PROVIDER: "openai",
    },
  },
  {
    name: "OpenAI-compatible",
    expectedRouting: { kind: "external", provider: "openai-compatible" },
    env: {
      HOOTLINE_MODEL: "local-coder",
      HOOTLINE_MODEL_BASE_URL: "http://127.0.0.1:11434/v1",
      HOOTLINE_MODEL_CONTEXT_WINDOW_TOKENS: "131072",
      HOOTLINE_MODEL_PROVIDER: "openai-compatible",
    },
  },
  {
    name: "explicit AI Gateway",
    expectedRouting: { kind: "gateway", target: "anthropic" },
    env: {
      AI_GATEWAY_API_KEY: "test-gateway-key",
      HOOTLINE_MODEL: "anthropic/claude-sonnet-4.6",
      HOOTLINE_MODEL_CONTEXT_WINDOW_TOKENS: "1000000",
      HOOTLINE_MODEL_PROVIDER: "gateway",
    },
  },
];

for (const testCase of cases) {
  execFileSync("npm", ["run", "info"], {
    env: { ...process.env, ...testCase.env },
    stdio: "ignore",
  });
  const manifest = JSON.parse(readFileSync(".eve/compile/compiled-agent-manifest.json", "utf8"));
  const model = manifest.config.model;
  assertObjectIncludes(model.routing, testCase.expectedRouting, `${testCase.name} routing`);
  if (Number(model.contextWindowTokens) !== Number(testCase.env.HOOTLINE_MODEL_CONTEXT_WINDOW_TOKENS)) {
    throw new Error(`${testCase.name} did not preserve modelContextWindowTokens.`);
  }
  if (manifest.config.compaction?.model !== undefined) {
    assertObjectIncludes(
      manifest.config.compaction.model.routing,
      testCase.expectedRouting,
      `${testCase.name} compaction routing`,
    );
  }
  console.log(`ok - ${testCase.name}`);
}

// Leave local Eve artifacts in the normal direct-provider development mode.
execFileSync("npm", ["run", "info"], {
  env: {
    ...process.env,
    ANTHROPIC_API_KEY: "test-anthropic-key",
    HOOTLINE_MODEL: "claude-sonnet-4-6",
    HOOTLINE_MODEL_CONTEXT_WINDOW_TOKENS: "1000000",
    HOOTLINE_MODEL_PROVIDER: "anthropic",
  },
  stdio: "ignore",
});

function assertObjectIncludes(actual, expected, label) {
  for (const [key, value] of Object.entries(expected)) {
    if (actual?.[key] !== value) {
      throw new Error(`${label} expected ${key}=${value}, got ${actual?.[key]}.`);
    }
  }
}

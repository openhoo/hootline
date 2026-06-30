import { readFileSync } from "node:fs";

import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { mockModel } from "eve/evals";

const supportedProviders = ["anthropic", "openai", "openai-compatible", "gateway", "mock"] as const;

type PipelineFixerModelProvider = (typeof supportedProviders)[number];

const defaultModels: Record<PipelineFixerModelProvider, string> = {
  anthropic: "claude-sonnet-4-6",
  openai: "gpt-5.1",
  "openai-compatible": "gpt-oss-120b",
  gateway: "anthropic/claude-sonnet-4.6",
  mock: "hootline-simulated-script",
};

const maxContextWindowTokens = 2_000_000;
const minContextWindowTokens = 4_096;

export function resolvePipelineFixerModel(env: NodeJS.ProcessEnv = process.env) {
  const provider = readProvider(env.HOOTLINE_MODEL_PROVIDER);
  const configuredModel = readNonEmpty(env.HOOTLINE_MODEL);
  const model = configuredModel ?? defaultModels[provider];
  const apiKey = readNonEmpty(env.HOOTLINE_MODEL_API_KEY);
  const baseURL = readNonEmpty(env.HOOTLINE_MODEL_BASE_URL);

  if (provider === "gateway") {
    requireAnyCredential(env, ["AI_GATEWAY_API_KEY", "VERCEL_OIDC_TOKEN"], provider);
    return model;
  }

  if (provider === "mock") {
    return createHootlineMockModel(env, model);
  }

  if (provider === "anthropic") {
    requireAnyCredential(env, ["HOOTLINE_MODEL_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"], provider);
    const authToken = apiKey === undefined ? readNonEmpty(env.ANTHROPIC_AUTH_TOKEN) : undefined;
    const anthropic = createAnthropic({
      ...(apiKey !== undefined ? { apiKey } : {}),
      ...(authToken !== undefined ? { authToken } : {}),
      ...(baseURL !== undefined ? { baseURL } : {}),
    });
    return anthropic(normalizeDirectModelId(provider, model));
  }

  if (provider === "openai") {
    requireAnyCredential(env, ["HOOTLINE_MODEL_API_KEY", "OPENAI_API_KEY"], provider);
    const openai = createOpenAI({
      ...(apiKey !== undefined ? { apiKey } : {}),
      ...(baseURL !== undefined ? { baseURL } : {}),
    });
    return openai(normalizeDirectModelId(provider, model));
  }

  if (baseURL === undefined) {
    throw new Error(
      "HOOTLINE_MODEL_BASE_URL is required when HOOTLINE_MODEL_PROVIDER=openai-compatible.",
    );
  }

  const compatible = createOpenAICompatible({
    name: readNonEmpty(env.HOOTLINE_MODEL_PROVIDER_NAME) ?? "openai-compatible",
    baseURL,
    ...(apiKey !== undefined ? { apiKey } : {}),
  });
  return compatible(normalizeDirectModelId(provider, model));
}

export function resolvePipelineFixerModelContextWindowTokens(
  env: NodeJS.ProcessEnv = process.env,
): number | undefined {
  const configured = readPositiveInteger(env.HOOTLINE_MODEL_CONTEXT_WINDOW_TOKENS);
  if (configured !== undefined) return configured;
  const provider = readProvider(env.HOOTLINE_MODEL_PROVIDER);
  if (provider === "mock") return undefined;
  if (provider === "openai-compatible") {
    throw new Error(
      "HOOTLINE_MODEL_CONTEXT_WINDOW_TOKENS is required when HOOTLINE_MODEL_PROVIDER=openai-compatible.",
    );
  }
  return undefined;
}

function readProvider(value: string | undefined): PipelineFixerModelProvider {
  const provider = readNonEmpty(value) ?? "anthropic";
  if (isSupportedProvider(provider)) return provider;
  throw new Error(
    `Unsupported HOOTLINE_MODEL_PROVIDER "${provider}". Expected one of: ${supportedProviders.join(", ")}.`,
  );
}

function isSupportedProvider(value: string): value is PipelineFixerModelProvider {
  return supportedProviders.includes(value as PipelineFixerModelProvider);
}

function createHootlineMockModel(env: NodeJS.ProcessEnv, model: string) {
  return mockModel({
    modelId: model,
    provider: "hootline.mock",
    respond(input: unknown) {
      const toolResults = readToolResults(input);
      if (toolResults.length === 0) {
        return { toolCalls: [{ name: "stage_repository_snapshot", input: {} }] };
      }

      if (toolResults.some((result) => result.output?.published === true)) {
        return "Published the simulated repair.";
      }

      const stageOutput = toolResults.find((result) => isRecord(result.output) && isRecord(result.output.event))?.output;
      const event = isRecord(stageOutput?.event) ? stageOutput.event : undefined;
      const plan = readMockRepairPlan(env, event);
      if (plan.length === 0) {
        return {
          toolCalls: [
            {
              name: "post_provider_comment",
              input: { body: "The deterministic benchmark model could not resolve a repair plan." },
            },
          ],
        };
      }

      const editsCompleted = toolResults.filter(
        (result) => typeof result.output?.replacements === "number",
      ).length;
      const nextEdit = plan[editsCompleted];
      if (nextEdit !== undefined) {
        return {
          toolCalls: [
            {
              name: "edit_repo_file",
              input: {
                path: nextEdit.sourcePath,
                expected: nextEdit.failingText,
                replacement: nextEdit.passingText,
              },
            },
          ],
        };
      }

      const checkResult = [...toolResults]
        .reverse()
        .find((result) => typeof result.output?.ok === "boolean")?.output;
      if (checkResult === undefined) {
        return { toolCalls: [{ name: "run_repo_checks", input: {} }] };
      }
      if (checkResult.ok !== true) {
        return {
          toolCalls: [
            {
              name: "post_provider_comment",
              input: { body: "The deterministic benchmark repair did not pass verification." },
            },
          ],
        };
      }

      return {
        toolCalls: [
          {
            name: "publish_fix",
            input: { summary: "Restore the fixture's expected CI behavior." },
          },
        ],
      };
    },
  });
}

function readToolResults(input: unknown): Array<{ output: Record<string, unknown> | undefined }> {
  if (!isRecord(input) || !Array.isArray(input.toolResults)) return [];
  return input.toolResults.map((entry) => {
    if (!isRecord(entry)) return { output: undefined };
    const output = isRecord(entry.output)
      ? entry.output
      : isRecord(entry.result) && isRecord(entry.result.output)
        ? entry.result.output
        : undefined;
    return { output };
  });
}

function readMockRepairPlan(
  env: NodeJS.ProcessEnv,
  event: Record<string, unknown> | undefined,
): Array<{ sourcePath: string; passingText: string; failingText: string }> {
  const statePath = readNonEmpty(env.HOOTLINE_SIMULATOR_STATE_PATH);
  const repoSlug = typeof event?.repoSlug === "string" ? event.repoSlug : undefined;
  const sha = typeof event?.sha === "string" ? event.sha : undefined;
  if (statePath === undefined || repoSlug === undefined || sha === undefined) return [];
  try {
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    const sample = isRecord(state?.samples) ? state.samples[`${repoSlug}@${sha}`] : undefined;
    if (!isRecord(sample) || !Array.isArray(sample.mockRepairPlan)) return [];
    return sample.mockRepairPlan.filter(isTextMutation);
  } catch {
    return [];
  }
}

function isTextMutation(value: unknown): value is { sourcePath: string; passingText: string; failingText: string } {
  return (
    isRecord(value) &&
    typeof value.sourcePath === "string" &&
    typeof value.passingText === "string" &&
    typeof value.failingText === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeDirectModelId(provider: Exclude<PipelineFixerModelProvider, "gateway" | "mock">, model: string): string {
  const withoutProviderPrefix = model.startsWith(`${provider}/`) ? model.slice(provider.length + 1) : model;
  if (provider !== "anthropic") return withoutProviderPrefix;
  return withoutProviderPrefix.replace(/^(claude-(?:sonnet|opus)-4)\.(\d+)$/, "$1-$2");
}

function readNonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === "" ? undefined : trimmed;
}

function readPositiveInteger(value: string | undefined): number | undefined {
  const trimmed = readNonEmpty(value);
  if (trimmed === undefined) return undefined;
  if (!/^\d+$/.test(trimmed)) {
    throw new Error("HOOTLINE_MODEL_CONTEXT_WINDOW_TOKENS must be a positive integer.");
  }
  const parsed = Number(trimmed);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < minContextWindowTokens ||
    parsed > maxContextWindowTokens
  ) {
    throw new Error(
      `HOOTLINE_MODEL_CONTEXT_WINDOW_TOKENS must be between ${minContextWindowTokens} and ${maxContextWindowTokens}.`,
    );
  }
  return parsed;
}

function requireAnyCredential(
  env: NodeJS.ProcessEnv,
  names: readonly string[],
  provider: PipelineFixerModelProvider,
): void {
  if (names.some((name) => readNonEmpty(env[name]) !== undefined)) return;
  throw new Error(
    `Missing model credential for HOOTLINE_MODEL_PROVIDER=${provider}. Set one of: ${names.join(", ")}.`,
  );
}

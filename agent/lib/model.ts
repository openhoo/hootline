import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

const supportedProviders = ["anthropic", "openai", "openai-compatible", "gateway"] as const;

type PipelineFixerModelProvider = (typeof supportedProviders)[number];

const defaultModels: Record<PipelineFixerModelProvider, string> = {
  anthropic: "claude-sonnet-4-6",
  openai: "gpt-5.1",
  "openai-compatible": "gpt-oss-120b",
  gateway: "anthropic/claude-sonnet-4.6",
};

const maxContextWindowTokens = 2_000_000;
const minContextWindowTokens = 4_096;

export function resolvePipelineFixerModel(env: NodeJS.ProcessEnv = process.env) {
  const provider = readProvider(env.PIPELINE_FIXER_MODEL_PROVIDER);
  const configuredModel = readNonEmpty(env.PIPELINE_FIXER_MODEL);
  const model = configuredModel ?? defaultModels[provider];
  const apiKey = readNonEmpty(env.PIPELINE_FIXER_MODEL_API_KEY);
  const baseURL = readNonEmpty(env.PIPELINE_FIXER_MODEL_BASE_URL);

  if (provider === "gateway") {
    requireAnyCredential(env, ["AI_GATEWAY_API_KEY", "VERCEL_OIDC_TOKEN"], provider);
    return model;
  }

  if (provider === "anthropic") {
    requireAnyCredential(env, ["PIPELINE_FIXER_MODEL_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"], provider);
    const anthropic = createAnthropic({
      ...(apiKey !== undefined ? { apiKey } : {}),
      ...(baseURL !== undefined ? { baseURL } : {}),
    });
    return anthropic(normalizeDirectModelId(provider, model));
  }

  if (provider === "openai") {
    requireAnyCredential(env, ["PIPELINE_FIXER_MODEL_API_KEY", "OPENAI_API_KEY"], provider);
    const openai = createOpenAI({
      ...(apiKey !== undefined ? { apiKey } : {}),
      ...(baseURL !== undefined ? { baseURL } : {}),
    });
    return openai(normalizeDirectModelId(provider, model));
  }

  if (baseURL === undefined) {
    throw new Error(
      "PIPELINE_FIXER_MODEL_BASE_URL is required when PIPELINE_FIXER_MODEL_PROVIDER=openai-compatible.",
    );
  }

  const compatible = createOpenAICompatible({
    name: readNonEmpty(env.PIPELINE_FIXER_MODEL_PROVIDER_NAME) ?? "openai-compatible",
    baseURL,
    ...(apiKey !== undefined ? { apiKey } : {}),
  });
  return compatible(normalizeDirectModelId(provider, model));
}

export function resolvePipelineFixerModelContextWindowTokens(
  env: NodeJS.ProcessEnv = process.env,
): number | undefined {
  const configured = readPositiveInteger(env.PIPELINE_FIXER_MODEL_CONTEXT_WINDOW_TOKENS);
  if (configured !== undefined) return configured;
  const provider = readProvider(env.PIPELINE_FIXER_MODEL_PROVIDER);
  if (provider === "openai-compatible") {
    throw new Error(
      "PIPELINE_FIXER_MODEL_CONTEXT_WINDOW_TOKENS is required when PIPELINE_FIXER_MODEL_PROVIDER=openai-compatible.",
    );
  }
  return undefined;
}

function readProvider(value: string | undefined): PipelineFixerModelProvider {
  const provider = readNonEmpty(value) ?? "anthropic";
  if (isSupportedProvider(provider)) return provider;
  throw new Error(
    `Unsupported PIPELINE_FIXER_MODEL_PROVIDER "${provider}". Expected one of: ${supportedProviders.join(", ")}.`,
  );
}

function isSupportedProvider(value: string): value is PipelineFixerModelProvider {
  return supportedProviders.includes(value as PipelineFixerModelProvider);
}

function normalizeDirectModelId(provider: Exclude<PipelineFixerModelProvider, "gateway">, model: string): string {
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
    throw new Error("PIPELINE_FIXER_MODEL_CONTEXT_WINDOW_TOKENS must be a positive integer.");
  }
  const parsed = Number(trimmed);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < minContextWindowTokens ||
    parsed > maxContextWindowTokens
  ) {
    throw new Error(
      `PIPELINE_FIXER_MODEL_CONTEXT_WINDOW_TOKENS must be between ${minContextWindowTokens} and ${maxContextWindowTokens}.`,
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
    `Missing model credential for PIPELINE_FIXER_MODEL_PROVIDER=${provider}. Set one of: ${names.join(", ")}.`,
  );
}

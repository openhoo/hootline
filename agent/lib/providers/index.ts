import type { Provider } from "../types.ts";
import type { ProviderClient } from "./common.ts";
import { GitHubProvider } from "./github.ts";
import { GitLabProvider } from "./gitlab.ts";
import { SimulatedGitHubProvider } from "./simulated-github.ts";

const clients: Record<Provider, ProviderClient> = {
  github: new GitHubProvider(),
  gitlab: new GitLabProvider(),
};

const simulatedGitHubClient = new SimulatedGitHubProvider();
const overrides: Partial<Record<Provider, ProviderClient>> = {};

export function getProviderClient(provider: Provider): ProviderClient {
  const override = overrides[provider];
  if (override !== undefined) return override;
  if (provider === "github" && readGitHubProviderBackend() === "simulated") {
    return simulatedGitHubClient;
  }
  return clients[provider];
}

export function registerProviderClient(provider: Provider, client: ProviderClient): () => void {
  const previous = overrides[provider];
  overrides[provider] = client;
  return () => {
    if (previous === undefined) {
      delete overrides[provider];
      return;
    }
    overrides[provider] = previous;
  };
}

function readGitHubProviderBackend(): "api" | "simulated" {
  const value = process.env.HOOTLINE_GITHUB_PROVIDER_BACKEND?.trim() || "api";
  if (value === "api" || value === "simulated") return value;
  throw new Error(
    `Unsupported HOOTLINE_GITHUB_PROVIDER_BACKEND "${value}". Expected api or simulated.`,
  );
}

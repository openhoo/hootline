import type { Provider } from "../types.ts";
import type { ProviderClient } from "./common.ts";
import { GitHubProvider } from "./github.ts";
import { GitLabProvider } from "./gitlab.ts";

const clients: Record<Provider, ProviderClient> = {
  github: new GitHubProvider(),
  gitlab: new GitLabProvider(),
};

export function getProviderClient(provider: Provider): ProviderClient {
  return clients[provider];
}

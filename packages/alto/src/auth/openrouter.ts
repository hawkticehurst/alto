import { defaultCredentialStore, type CredentialStore } from "./credential-store.js";

export type OpenRouterAuthProvider = "openrouter";

export interface OpenRouterAuthStatus {
  provider: OpenRouterAuthProvider;
  authenticated: boolean;
}

const CREDENTIAL_SERVICE = "alto";
const OPENROUTER_ACCOUNT = "openrouter";

export async function getOpenRouterApiKey(
  options: { env?: Record<string, string>; credentialStore?: CredentialStore } = {},
): Promise<string> {
  const envKey = options.env?.OPENROUTER_API_KEY ?? process.env.OPENROUTER_API_KEY;
  if (envKey?.trim()) {
    return envKey.trim();
  }

  const apiKey = await (options.credentialStore ?? defaultCredentialStore).get(CREDENTIAL_SERVICE, OPENROUTER_ACCOUNT);
  if (apiKey?.trim()) {
    return apiKey.trim();
  }

  throw new Error("No OpenRouter API key found. Run `alto auth login --provider openrouter --api-key <key>` or set OPENROUTER_API_KEY.");
}

export async function getOpenRouterAuthStatus(
  credentialStore: CredentialStore = defaultCredentialStore,
): Promise<OpenRouterAuthStatus> {
  const apiKey = await credentialStore.get(CREDENTIAL_SERVICE, OPENROUTER_ACCOUNT);
  return { provider: "openrouter", authenticated: Boolean(apiKey?.trim()) };
}

export async function saveOpenRouterApiKey(apiKey: string, credentialStore: CredentialStore = defaultCredentialStore): Promise<void> {
  const value = apiKey.trim();
  if (!value) {
    throw new Error("OpenRouter API key must not be empty.");
  }
  await credentialStore.set(CREDENTIAL_SERVICE, OPENROUTER_ACCOUNT, value);
}

export async function deleteOpenRouterApiKey(credentialStore: CredentialStore = defaultCredentialStore): Promise<void> {
  await credentialStore.delete(CREDENTIAL_SERVICE, OPENROUTER_ACCOUNT);
}
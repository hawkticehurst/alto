import { OpenAIModel } from "./openai.js";
import type { ModelConfig } from "../core/config.js";
import { getGitHubCopilotBaseUrl } from "../auth/github.js";

export interface GitHubCopilotConfig extends Partial<Omit<ModelConfig, "apiKey" | "baseURL" | "defaultHeaders">> {
  modelName?: string;
  token?: string;
  tokenProvider?: () => Promise<string>;
  baseURL?: string;
}

export const GITHUB_COPILOT_HEADERS = {
  "User-Agent": "GitHubCopilotChat/0.35.0",
  "Editor-Version": "vscode/1.107.0",
  "Editor-Plugin-Version": "copilot-chat/0.35.0",
  "Copilot-Integration-Id": "vscode-chat",
  "X-Initiator": "user",
  "Openai-Intent": "conversation-edits",
};

export class GitHubCopilotModel extends OpenAIModel {
  constructor(config: GitHubCopilotConfig = {}) {
    const { token, tokenProvider, modelName = "gpt-5.4", baseURL = "https://api.individual.githubcopilot.com", ...rest } = config;
    const resolveToken = tokenProvider ?? (token ? async () => token : undefined);
    super({
      ...rest,
      modelName,
      baseURL: resolveToken ? async () => getGitHubCopilotBaseUrl(await resolveToken()) : baseURL,
      apiKey: resolveToken ?? token,
      defaultHeaders: GITHUB_COPILOT_HEADERS,
    });
  }
}

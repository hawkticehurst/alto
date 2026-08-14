import type { ModelConfig } from "../core/config.js";
import { OpenAIModel } from "./openai.js";

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

export interface OpenRouterConfig extends Partial<Omit<ModelConfig, "apiKey" | "baseURL">> {
  modelName: string;
  apiKey?: string | (() => Promise<string>);
  baseURL?: string;
}

export class OpenRouterModel extends OpenAIModel {
  constructor(config: OpenRouterConfig) {
    super({
      ...config,
      baseURL: config.baseURL ?? OPENROUTER_BASE_URL,
    });
  }
}
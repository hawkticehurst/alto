import OpenAI from "openai";
import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions";

import { defaultEnvironmentConfig, type ModelConfig } from "../core/config.js";
import { FormatError } from "../core/errors.js";
import type { Action, ExecutionOutput, Message, Model } from "../core/types.js";
import { asArray } from "../utils/index.js";

export const BASH_TOOL: ChatCompletionTool = {
  type: "function",
  function: {
    name: "bash",
    description: "Execute a bash command in a fresh local shell",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "The bash command to execute",
        },
      },
      required: ["command"],
    },
  },
};

export class OpenAIModel implements Model {
  readonly config: ModelConfig;
  private client?: OpenAI;

  constructor(config: Partial<ModelConfig> & Pick<ModelConfig, "modelName">) {
    this.config = {
      maxObservationChars: 10_000,
      modelKwargs: {},
      ...config,
    };
  }

  async query(messages: Message[]): Promise<Message> {
    const client = await this.getClient();
    const response = await client.chat.completions.create({
      model: this.config.modelName,
      messages: this.prepareMessages(messages),
      tools: [BASH_TOOL],
      ...this.config.modelKwargs,
    });

    const choice = response.choices[0];
    if (!choice) {
      throw new FormatError({
        role: "user",
        content: "Model returned no choices. Please return one assistant message with a bash tool call.",
        extra: { interrupt_type: "FormatError", response },
      });
    }

    const actions = this.parseActions(choice.message.tool_calls ?? []);
    return {
      role: "assistant",
      content: choice.message.content ?? "",
      tool_calls: choice.message.tool_calls,
      extra: {
        actions,
        response,
        usage: response.usage,
        timestamp: Date.now() / 1000,
      },
    };
  }

  formatMessage(message: Message): Message {
    return message;
  }

  formatObservationMessages(message: Message, outputs: ExecutionOutput[]): Message[] {
    const actions = asArray<Action>(message.extra?.actions);
    const notExecuted: ExecutionOutput = {
      output: "",
      returncode: -1,
      exception_info: "action was not executed",
    };

    return actions.map((action, index) => {
      const output = outputs[index] ?? notExecuted;
      const content = JSON.stringify(formatOutput(output, this.config.maxObservationChars), null, 2);
      const result: Message = {
        role: action.toolCallId ? "tool" : "user",
        content,
        extra: {
          raw_output: output.output,
          returncode: output.returncode,
          timestamp: Date.now() / 1000,
          exception_info: output.exception_info,
          ...output.extra,
        },
      };

      if (action.toolCallId) {
        result.tool_call_id = action.toolCallId;
      }

      return result;
    });
  }

  getTemplateVars(): Record<string, unknown> {
    return {
      model_name: this.config.modelName,
      max_observation_chars: this.config.maxObservationChars,
      environment_defaults: defaultEnvironmentConfig,
    };
  }

  serialize(): Record<string, unknown> {
    return {
      info: {
        config: {
          model: {
            ...this.config,
            apiKey: this.config.apiKey ? "[redacted]" : undefined,
          },
          model_type: "OpenAIModel",
        },
      },
    };
  }

  private prepareMessages(messages: Message[]): ChatCompletionMessageParam[] {
    return messages.map((message) => {
      const { extra: _extra, ...rest } = message;
      return rest as unknown as ChatCompletionMessageParam;
    });
  }

  private async getClient(): Promise<OpenAI> {
    const apiKey = await this.resolveApiKey();
    const baseURL = await this.resolveBaseURL();
    if (typeof this.config.apiKey === "function" || typeof this.config.baseURL === "function") {
      return new OpenAI({
        apiKey,
        baseURL,
        defaultHeaders: this.config.defaultHeaders,
      });
    }

    this.client ??= new OpenAI({
      apiKey,
      baseURL,
      defaultHeaders: this.config.defaultHeaders,
    });
    return this.client;
  }

  private async resolveApiKey(): Promise<string> {
    if (typeof this.config.apiKey === "function") {
      return this.config.apiKey();
    }
    return this.config.apiKey ?? process.env.OPENAI_API_KEY ?? "not-needed";
  }

  private async resolveBaseURL(): Promise<string | undefined> {
    if (typeof this.config.baseURL === "function") {
      return this.config.baseURL();
    }
    return this.config.baseURL ?? process.env.OPENAI_BASE_URL;
  }

  private parseActions(toolCalls: NonNullable<OpenAI.Chat.Completions.ChatCompletionMessage["tool_calls"]>): Action[] {
    if (toolCalls.length === 0) {
      throw new FormatError({
        role: "user",
        content: "Tool call error: every assistant response must include at least one bash tool call.",
        extra: { interrupt_type: "FormatError" },
      });
    }

    return toolCalls.map((toolCall) => {
      let args: unknown;
      try {
        args = JSON.parse(toolCall.function.arguments);
      } catch (error) {
        throw new FormatError({
          role: "user",
          content: `Tool call error: could not parse bash arguments: ${String(error)}`,
          extra: { interrupt_type: "FormatError" },
        });
      }

      if (toolCall.function.name !== "bash") {
        throw new FormatError({
          role: "user",
          content: `Tool call error: unknown tool '${toolCall.function.name}'. Use only bash.`,
          extra: { interrupt_type: "FormatError" },
        });
      }

      if (!args || typeof args !== "object" || !("command" in args) || typeof args.command !== "string") {
        throw new FormatError({
          role: "user",
          content: "Tool call error: bash arguments must be an object with a string 'command'.",
          extra: { interrupt_type: "FormatError" },
        });
      }

      return { command: args.command, toolCallId: toolCall.id };
    });
  }
}

export function formatOutput(output: ExecutionOutput, maxChars: number): Record<string, unknown> {
  if (output.output.length <= maxChars) {
    return {
      returncode: output.returncode,
      output: output.output,
      ...(output.exception_info ? { exception_info: output.exception_info } : {}),
    };
  }

  const half = Math.floor(maxChars / 2);
  return {
    returncode: output.returncode,
    output_head: output.output.slice(0, half),
    output_tail: output.output.slice(-half),
    elided_chars: output.output.length - maxChars,
    warning: "Output too long.",
    ...(output.exception_info ? { exception_info: output.exception_info } : {}),
  };
}

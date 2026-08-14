export type MessageRole = "system" | "user" | "assistant" | "tool" | "exit";

export interface Action {
  command: string;
  toolCallId?: string;
}

export interface ExecutionOutput {
  output: string;
  returncode: number;
  exception_info?: string;
  extra?: Record<string, unknown>;
}

export interface AgentRunRequest {
  task: string;
  context?: Record<string, unknown>;
  model?: {
    provider?: "github-copilot" | "openai";
    name?: string;
    baseUrl?: string;
  };
  limits?: {
    timeoutMs?: number;
  };
  environment?: {
    agentEnvFile?: string;
    agentEnv?: string[];
  };
  workspace?: {
    sourcePath?: string;
    root?: string;
    preserve?: boolean;
  };
}

export interface Message {
  role: MessageRole | string;
  content?: string | null;
  tool_call_id?: string;
  tool_calls?: unknown;
  extra?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface Model {
  query(messages: Message[]): Promise<Message>;
  formatMessage(message: Message): Message;
  formatObservationMessages(message: Message, outputs: ExecutionOutput[], templateVars?: Record<string, unknown>): Message[];
  getTemplateVars(): Record<string, unknown>;
  serialize(): Record<string, unknown>;
}

export interface Environment {
  prepare?(request: AgentRunRequest): Promise<void>;
  execute(action: Action): Promise<ExecutionOutput>;
  cleanup?(): Promise<void>;
  getTemplateVars(): Record<string, unknown>;
  serialize(): Record<string, unknown>;
}

export interface AgentRunResult {
  exit_status?: string;
  submission?: string;
  [key: string]: unknown;
}

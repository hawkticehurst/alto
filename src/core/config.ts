import os from "node:os";

import type { EventSink } from "../runs/events.js";
import type { TranscriptStore } from "../runs/transcript-store.js";

export interface AgentConfig {
  systemTemplate: string;
  stepLimit: number;
  costLimit: number;
  wallTimeLimitSeconds: number;
  outputPath?: string;
  eventSink?: EventSink;
  transcriptStore?: TranscriptStore;
}

export interface InteractiveAgentConfig extends AgentConfig {
  confirmExit: boolean;
}

export interface EnvironmentConfig {
  cwd?: string;
  env: Record<string, string>;
  agentEnv: Record<string, string>;
  inheritEnv: string[];
  timeoutMs: number;
}

export interface ModelConfig {
  modelName: string;
  apiKey?: string | (() => Promise<string>);
  baseURL?: string | (() => Promise<string | undefined>);
  defaultHeaders?: Record<string, string>;
  maxObservationChars: number;
  modelKwargs: Record<string, unknown>;
}

const systemTemplate = `You are an expert coding assistant operating inside Alto, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.

Available tools:
- bash: execute a bash command in a fresh local shell

Guidelines:
- Every assistant response must include at least one bash tool call.
- Use concise reasoning in assistant messages.
- Show file paths clearly when working with files.
- Directory and environment variable changes are not persistent. Every action runs in a fresh subshell.
- Prefix commands with cd /path/to/repo && ... when needed.
- Keep command output focused; use head, tail, sed, or targeted searches for large files.
- Verify your changes before finishing.
- Finish your work by issuing exactly this command:
  echo COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT
- Do not combine the final command with any other command. After this command, you cannot continue working on this task.

Current date: {{current_date}}
Current working directory: {{cwd}}
System: {{system}} {{release}} {{version}} {{machine}}
`;

export const defaultAgentConfig: AgentConfig = {
  systemTemplate,
  stepLimit: 0,
  costLimit: 0,
  wallTimeLimitSeconds: 0,
};

export const defaultInteractiveAgentConfig: InteractiveAgentConfig = {
  ...defaultAgentConfig,
  confirmExit: true,
};

export const defaultEnvironmentConfig: EnvironmentConfig = {
  env: {
    PAGER: "cat",
    MANPAGER: "cat",
    LESS: "-R",
    PIP_PROGRESS_BAR: "off",
    TQDM_DISABLE: "1",
  },
  agentEnv: {},
  inheritEnv: ["PATH", "HOME", "USER", "SHELL", "TMPDIR", "LANG", "LC_ALL"],
  timeoutMs: 30_000,
};

export function getSystemTemplateVars(): Record<string, string> {
  const now = new Date();
  return {
    current_date: now.toISOString().slice(0, 10),
    system: os.type(),
    release: os.release(),
    version: os.version(),
    machine: typeof os.machine === "function" ? os.machine() : os.arch(),
  };
}

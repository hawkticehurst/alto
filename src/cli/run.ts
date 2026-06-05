import { AltoAgent } from "../core/agent.js";
import { defaultAgentConfig, defaultInteractiveAgentConfig } from "../core/config.js";
import type { AgentRunRequest, AgentRunResult, Environment, Model } from "../core/types.js";
import { loadAgentEnv, parseEnvKeyList, pickEnv } from "../utils/agent-env.js";
import { ConsoleEventSink, JsonLineFileEventSink, TeeEventSink, type AgentEvent, type EventSink } from "../runs/events.js";
import { LocalEnvironment } from "../environments/local.js";
import { WorkspaceEnvironment } from "../environments/workspace.js";
import { getGitHubCopilotToken } from "../auth/github.js";
import { GitHubCopilotModel } from "../models/github-copilot.js";
import { OpenAIModel } from "../models/openai.js";
import { getRunPaths, writeRunMetadata, type RunMetadata } from "../runs/metadata.js";
import { InteractiveAgent } from "./terminal-agent.js";

export type ModelProvider = "openai" | "github-copilot";

export interface CliOptions {
  task?: string;
  model?: string;
  provider?: ModelProvider;
  cwd?: string;
  output?: string;
  runId?: string;
  stepLimit?: string;
  costLimit?: string;
  wallTimeLimitSeconds?: string;
  timeout?: string;
  baseUrl?: string;
  exitImmediately?: boolean;
  setupCommand?: string;
  verifyCommand?: string;
  workspace?: boolean;
  workspaceRoot?: string;
  preserveWorkspace?: boolean;
  agentEnvFile?: string;
  agentEnv?: string;
  events?: boolean;
}

export interface RunExecution {
  result: AgentRunResult;
  metadata: RunMetadata;
}

export async function executeRun(
  options: CliOptions,
  request: AgentRunRequest,
  settings: { interactive: boolean; eventSink?: EventSink } = { interactive: false },
): Promise<RunExecution> {
  const envFile = await loadAgentEnv(request.environment?.agentEnvFile ?? options.agentEnvFile);
  const shellAgentEnv = pickEnv(envFile, request.environment?.agentEnv ?? parseEnvKeyList(options.agentEnv));
  const provider = resolveProvider(options, request);
  const modelName = resolveModelName(options, request, provider);
  const runPaths = getRunPaths(options.runId);
  const transcriptPath = options.output ?? runPaths.transcriptPath;
  const startedAt = new Date().toISOString();
  const tracker = new RunTrackingEventSink();
  const sinks: EventSink[] = [tracker, new JsonLineFileEventSink(runPaths.eventsPath)];

  if (settings.interactive) {
    sinks.push(new HumanRunEventSink());
  }
  if (options.events) {
    sinks.push(new ConsoleEventSink());
  }
  if (settings.eventSink) {
    sinks.push(settings.eventSink);
  }

  const metadata: RunMetadata = {
    runId: runPaths.runId,
    status: "running",
    task: request.task,
    provider,
    model: modelName,
    startedAt,
    transcriptPath,
    eventsPath: runPaths.eventsPath,
    stepLimit: request.limits?.stepLimit ?? Number(options.stepLimit ?? 0),
  };
  await writeRunMetadata(runPaths, metadata);

  if (settings.interactive) {
    console.log(`Run ID: ${runPaths.runId}`);
    console.log(`Transcript: ${transcriptPath}`);
    console.log(`Events: ${runPaths.eventsPath}`);
    console.log(`Provider/model: ${provider}/${modelName}`);
  }

  const model = createModel(options, envFile, request, provider, modelName);
  const env = createEnvironment(options, shellAgentEnv, request);
  const AgentClass = settings.interactive ? InteractiveAgent : AltoAgent;
  const agent = new AgentClass(model, env, {
    ...(settings.interactive ? defaultInteractiveAgentConfig : defaultAgentConfig),
    outputPath: transcriptPath,
    stepLimit: metadata.stepLimit,
    costLimit: request.limits?.costLimit ?? Number(options.costLimit ?? 0),
    wallTimeLimitSeconds: request.limits?.wallTimeLimitSeconds ?? Number(options.wallTimeLimitSeconds ?? 0),
    ...(settings.interactive ? { confirmExit: !options.exitImmediately } : {}),
    eventSink: new TeeEventSink(sinks),
  });

  try {
    const result = await agent.run(request);
    const finished: RunMetadata = {
      ...metadata,
      status: "succeeded",
      endedAt: new Date().toISOString(),
      workspacePath: tracker.workspacePath,
      exitStatus: typeof result.exit_status === "string" ? result.exit_status : undefined,
    };
    await writeRunMetadata(runPaths, finished);
    if (settings.interactive) {
      if (result.exit_status) {
        console.log(`\nExited: ${result.exit_status}`);
      }
      console.log(`Run metadata: ${runPaths.metadataPath}`);
    }
    return { result, metadata: finished };
  } catch (error) {
    const failed: RunMetadata = {
      ...metadata,
      status: "failed",
      endedAt: new Date().toISOString(),
      workspacePath: tracker.workspacePath,
      error: error instanceof Error ? error.message : String(error),
    };
    await writeRunMetadata(runPaths, failed);
    throw error;
  } finally {
    if (agent instanceof InteractiveAgent) {
      agent.close();
    }
  }
}

export function buildCliRunRequest(task: string, options: CliOptions): AgentRunRequest {
  const provider = options.provider ?? "github-copilot";
  return {
    task,
    setupCommand: options.setupCommand,
    verifyCommand: options.verifyCommand,
    model: {
      provider,
      name: options.model,
      baseUrl: options.baseUrl,
    },
    limits: {
      stepLimit: Number(options.stepLimit ?? 0),
      costLimit: Number(options.costLimit ?? 0),
      wallTimeLimitSeconds: Number(options.wallTimeLimitSeconds ?? 0),
      timeoutMs: Number(options.timeout ?? 30_000),
    },
    environment: {
      agentEnvFile: options.agentEnvFile,
      agentEnv: parseEnvKeyList(options.agentEnv),
    },
    workspace:
      options.workspace === false
        ? undefined
        : {
            sourcePath: options.cwd ?? process.cwd(),
            root: options.workspaceRoot,
            preserve: options.preserveWorkspace,
          },
  };
}

function createModel(
  options: CliOptions,
  envFile: Record<string, string>,
  request: AgentRunRequest,
  provider: ModelProvider,
  modelName: string,
): Model {
  if (provider === "github-copilot") {
    return new GitHubCopilotModel({
      modelName,
      tokenProvider: () => getGitHubCopilotToken({ env: envFile }),
    });
  }

  return new OpenAIModel({
    modelName,
    apiKey: envFile.OPENAI_API_KEY,
    baseURL: request.model?.baseUrl ?? options.baseUrl ?? envFile.OPENAI_BASE_URL,
  });
}

function createEnvironment(options: CliOptions, agentEnv: Record<string, string>, request: AgentRunRequest): Environment {
  const common = {
    timeoutMs: request.limits?.timeoutMs ?? Number(options.timeout ?? 30_000),
    agentEnv,
  };

  if (!request.workspace) {
    return new LocalEnvironment({
      ...common,
      cwd: options.cwd,
    });
  }

  return new WorkspaceEnvironment({
    ...common,
    sourcePath: request.workspace.sourcePath ?? options.cwd ?? process.cwd(),
    workspaceRoot: request.workspace.root ?? options.workspaceRoot,
    preserveWorkspace: request.workspace.preserve ?? options.preserveWorkspace ?? false,
    setupCommand: request.setupCommand ?? options.setupCommand,
  });
}

function resolveProvider(options: CliOptions, request: AgentRunRequest): ModelProvider {
  const provider = request.model?.provider ?? options.provider ?? "github-copilot";
  if (provider !== "github-copilot" && provider !== "openai") {
    throw new Error(`Unknown provider '${provider}'. Expected 'github-copilot' or 'openai'.`);
  }
  return provider;
}

function resolveModelName(options: CliOptions, request: AgentRunRequest, provider: ModelProvider): string {
  if (provider === "github-copilot") {
    return request.model?.name ?? options.model ?? process.env.ALTO_MODEL ?? process.env.GITHUB_COPILOT_MODEL ?? "gpt-5.4";
  }

  const modelName = request.model?.name ?? options.model ?? process.env.ALTO_MODEL ?? process.env.OPENAI_MODEL;
  if (!modelName) {
    throw new Error("No model set. Pass --model or set ALTO_MODEL or OPENAI_MODEL.");
  }
  return modelName;
}

class RunTrackingEventSink implements EventSink {
  workspacePath?: string;

  emit(event: AgentEvent & { timestamp: number }): void {
    if (event.type === "workspace_prepared") {
      this.workspacePath = event.path;
    }
  }
}

class HumanRunEventSink implements EventSink {
  emit(event: AgentEvent & { timestamp: number }): void {
    if (event.type === "workspace_prepared") {
      console.log(`Workspace: ${event.path}`);
    } else if (event.type === "workspace_deleted") {
      console.log(`Workspace deleted: ${event.path}`);
    } else if (event.type === "workspace_preserved") {
      console.log(`Workspace preserved: ${event.path}`);
    }
  }
}

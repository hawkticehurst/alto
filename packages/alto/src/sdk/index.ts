import process from "node:process";

import { AltoAgent } from "../core/agent.js";
import { defaultAgentConfig, type AgentConfig, type EnvironmentConfig, type ModelConfig } from "../core/config.js";
import type { AgentRunRequest, AgentRunResult, Environment, Model } from "../core/types.js";
import { LocalEnvironment } from "../environments/local.js";
import { WorkspaceEnvironment } from "../environments/workspace.js";
import { getGitHubCopilotToken } from "../auth/github.js";
import { GitHubCopilotModel, type GitHubCopilotConfig } from "../models/github-copilot.js";
import { OpenAIModel } from "../models/openai.js";
import { ConsoleEventSink, JsonLineFileEventSink, TeeEventSink, type AgentEvent, type EventSink } from "../runs/events.js";
import { getRunPaths, writeRunMetadata, type RunMetadata, type RunPaths } from "../runs/metadata.js";
import { loadAgentEnv, parseEnvKeyList, pickEnv } from "../utils/agent-env.js";

export type AltoModelProvider = "github-copilot" | "openai";
export type AltoEvent = AgentEvent & { timestamp: number };
export type AltoRunStatus = "submitted" | "failed" | "completed";

export interface AltoModelOptions {
  provider?: AltoModelProvider;
  name?: string;
  baseUrl?: string;
  apiKey?: string | (() => Promise<string>);
  token?: string;
  tokenProvider?: () => Promise<string>;
  maxObservationChars?: number;
  modelKwargs?: Record<string, unknown>;
}

export interface AltoWorkspaceOptions {
  sourcePath?: string;
  root?: string;
  preserve?: boolean;
}

export interface AltoEnvironmentOptions {
  cwd?: string;
  env?: Record<string, string>;
  agentEnvFile?: string;
  agentEnv?: string[] | string;
  inheritEnv?: string[];
  timeoutMs?: number;
}

export interface AltoLimits {
  timeoutMs?: number;
}

export interface AltoOutputOptions {
  runId?: string;
  runsRoot?: string;
  transcriptPath?: string;
  eventsPath?: string;
  writeEvents?: boolean;
}

export interface AltoEventOptions {
  onEvent?: (event: AltoEvent) => void | Promise<void>;
  sink?: EventSink;
  sinks?: EventSink[];
  console?: boolean;
}

export interface AltoRunRequest {
  task: string;
  context?: Record<string, unknown>;
  model?: AltoModelOptions | Model;
  workspace?: AltoWorkspaceOptions | false;
  environment?: AltoEnvironmentOptions | Environment;
  limits?: AltoLimits;
  output?: AltoOutputOptions;
  events?: AltoEventOptions;
  systemTemplate?: string;
}

export type AltoAgentOptions = Omit<AltoRunRequest, "task"> & { task?: string };
export type AltoRunInput = string | AltoRunRequest;

export interface AltoRunResult {
  status: AltoRunStatus;
  submission?: string;
  exitStatus?: string;
  error?: string;
  transcriptPath: string;
  eventsPath: string;
  workspacePath?: string;
  metadata: RunMetadata;
  result?: AgentRunResult;
}

export class Alto {
  constructor(readonly defaults: AltoAgentOptions = {}) {}

  async run(input: AltoRunInput): Promise<AltoRunResult> {
    return runAlto(mergeRunOptions(this.defaults, normalizeRunInput(input)));
  }

  async createAgent(options: AltoAgentOptions = {}): Promise<AltoAgent> {
    return createAgent(mergeRunOptions(this.defaults, options));
  }
}

export async function runAlto(input: AltoRunInput): Promise<AltoRunResult> {
  const request = normalizeRunInput(input);
  const prepared = await prepareAgent(request);
  const startedAt = new Date().toISOString();
  const metadata: RunMetadata = {
    runId: prepared.runPaths.runId,
    status: "running",
    task: request.task,
    provider: prepared.provider,
    model: prepared.modelName,
    startedAt,
    transcriptPath: prepared.transcriptPath,
    eventsPath: prepared.eventsPath,
  };
  await writeRunMetadata(prepared.runPaths, metadata);

  try {
    const result = await prepared.agent.run(toAgentRunRequest(request));
    const finished: RunMetadata = {
      ...metadata,
      status: "succeeded",
      endedAt: new Date().toISOString(),
      workspacePath: prepared.tracker.workspacePath,
      exitStatus: typeof result.exit_status === "string" ? result.exit_status : undefined,
    };
    await writeRunMetadata(prepared.runPaths, finished);
    return {
      status: normalizeRunStatus(result.exit_status),
      submission: typeof result.submission === "string" ? result.submission : undefined,
      exitStatus: typeof result.exit_status === "string" ? result.exit_status : undefined,
      transcriptPath: prepared.transcriptPath,
      eventsPath: prepared.eventsPath,
      workspacePath: prepared.tracker.workspacePath,
      metadata: finished,
      result,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failed: RunMetadata = {
      ...metadata,
      status: "failed",
      endedAt: new Date().toISOString(),
      workspacePath: prepared.tracker.workspacePath,
      error: message,
    };
    await writeRunMetadata(prepared.runPaths, failed);
    return {
      status: "failed",
      error: message,
      transcriptPath: prepared.transcriptPath,
      eventsPath: prepared.eventsPath,
      workspacePath: prepared.tracker.workspacePath,
      metadata: failed,
    };
  }
}

export async function createAgent(options: AltoAgentOptions = {}): Promise<AltoAgent> {
  return (await prepareAgent(options)).agent;
}

interface PreparedAgent {
  agent: AltoAgent;
  runPaths: RunPaths;
  transcriptPath: string;
  eventsPath: string;
  provider: string;
  modelName: string;
  tracker: RunTrackingEventSink;
}

async function prepareAgent(options: AltoAgentOptions): Promise<PreparedAgent> {
  const envOptions = getEnvironmentOptions(options.environment);
  const envFile = await loadAgentEnv(envOptions.agentEnvFile);
  const agentEnv = pickEnv(envFile, normalizeEnvKeyList(envOptions.agentEnv));
  const model = createModel(options.model, envFile);
  const environment = createEnvironment(options, envOptions, agentEnv);
  const runPaths = getRunPaths(options.output?.runId, options.output?.runsRoot);
  const transcriptPath = options.output?.transcriptPath ?? runPaths.transcriptPath;
  const eventsPath = options.output?.eventsPath ?? runPaths.eventsPath;
  const tracker = new RunTrackingEventSink();
  const eventSink = createEventSink(options.events, tracker, eventsPath, options.output?.writeEvents !== false);
  const config: Partial<AgentConfig> = {
    ...defaultAgentConfig,
    outputPath: transcriptPath,
    eventSink,
    ...(options.systemTemplate ? { systemTemplate: options.systemTemplate } : {}),
  };

  return {
    agent: new AltoAgent(model.adapter, environment, config),
    runPaths,
    transcriptPath,
    eventsPath,
    provider: model.provider,
    modelName: model.name,
    tracker,
  };
}

function createModel(model: AltoModelOptions | Model | undefined, envFile: Record<string, string>): {
  adapter: Model;
  provider: string;
  name: string;
} {
  if (isModel(model)) {
    return { adapter: model, provider: "custom", name: getModelName(model) };
  }

  const options = model ?? {};
  const provider = options.provider ?? "github-copilot";
  if (provider === "github-copilot") {
    const name = options.name ?? process.env.ALTO_MODEL ?? process.env.GITHUB_COPILOT_MODEL ?? "gpt-5.4";
    const config: GitHubCopilotConfig = {
      modelName: name,
      token: options.token,
      tokenProvider: options.tokenProvider ?? (options.token ? undefined : () => getGitHubCopilotToken({ env: envFile })),
      baseURL: options.baseUrl,
      maxObservationChars: options.maxObservationChars,
      modelKwargs: options.modelKwargs,
    };
    return { adapter: new GitHubCopilotModel(config), provider, name };
  }

  const name = options.name ?? process.env.ALTO_MODEL ?? process.env.OPENAI_MODEL;
  if (!name) {
    throw new Error("No OpenAI model set. Pass model.name or set ALTO_MODEL or OPENAI_MODEL.");
  }
  const config: Partial<ModelConfig> & Pick<ModelConfig, "modelName"> = {
    modelName: name,
    apiKey: options.apiKey ?? envFile.OPENAI_API_KEY,
    baseURL: options.baseUrl ?? envFile.OPENAI_BASE_URL,
    maxObservationChars: options.maxObservationChars,
    modelKwargs: options.modelKwargs ?? {},
  };
  return { adapter: new OpenAIModel(config), provider, name };
}

function createEnvironment(
  options: AltoAgentOptions,
  envOptions: AltoEnvironmentOptions,
  agentEnv: Record<string, string>,
): Environment {
  if (isEnvironment(options.environment)) {
    return options.environment;
  }

  const common: Partial<EnvironmentConfig> = {
    timeoutMs: options.limits?.timeoutMs ?? envOptions.timeoutMs ?? 30_000,
    env: envOptions.env,
    agentEnv,
    inheritEnv: envOptions.inheritEnv,
  };

  if (options.workspace === false) {
    return new LocalEnvironment({
      ...common,
      cwd: envOptions.cwd,
    });
  }

  return new WorkspaceEnvironment({
    ...common,
    sourcePath: options.workspace?.sourcePath ?? envOptions.cwd ?? process.cwd(),
    workspaceRoot: options.workspace?.root,
    preserveWorkspace: options.workspace?.preserve ?? false,
  });
}

function createEventSink(
  options: AltoEventOptions | undefined,
  tracker: RunTrackingEventSink,
  eventsPath: string,
  writeEvents: boolean,
): EventSink {
  const sinks: EventSink[] = [tracker];
  if (writeEvents) {
    sinks.push(new JsonLineFileEventSink(eventsPath));
  }
  if (options?.console) {
    sinks.push(new ConsoleEventSink());
  }
  if (options?.sink) {
    sinks.push(options.sink);
  }
  if (options?.sinks) {
    sinks.push(...options.sinks);
  }
  if (options?.onEvent) {
    sinks.push(new FunctionEventSink(options.onEvent));
  }
  return new TeeEventSink(sinks);
}

function toAgentRunRequest(request: AltoRunRequest): AgentRunRequest {
  return {
    task: request.task,
    context: request.context,
    model: isModel(request.model)
      ? undefined
      : {
          provider: request.model?.provider,
          name: request.model?.name,
          baseUrl: request.model?.baseUrl,
        },
    limits: request.limits,
    environment: isEnvironment(request.environment)
      ? undefined
      : {
          agentEnvFile: request.environment?.agentEnvFile,
          agentEnv: normalizeEnvKeyList(request.environment?.agentEnv),
        },
    workspace: request.workspace === false ? undefined : request.workspace,
  };
}

function normalizeRunInput(input: AltoRunInput): AltoRunRequest {
  return typeof input === "string" ? { task: input } : input;
}

function mergeRunOptions(defaults: AltoAgentOptions, options: AltoAgentOptions): AltoRunRequest;
function mergeRunOptions(defaults: AltoAgentOptions, options: AltoRunRequest): AltoRunRequest;
function mergeRunOptions(defaults: AltoAgentOptions, options: AltoAgentOptions | AltoRunRequest): AltoRunRequest {
  return {
    ...defaults,
    ...options,
    task: options.task ?? defaults.task ?? "",
    model: mergeOption(defaults.model, options.model),
    workspace: mergeWorkspace(defaults.workspace, options.workspace),
    environment: mergeOption(defaults.environment, options.environment),
    limits: { ...defaults.limits, ...options.limits },
    output: { ...defaults.output, ...options.output },
    events: mergeEvents(defaults.events, options.events),
  };
}

function mergeOption<T>(defaults: T | undefined, options: T | undefined): T | undefined {
  if (isPlainRecord(defaults) && isPlainRecord(options)) {
    return { ...defaults, ...options } as T;
  }
  return options ?? defaults;
}

function mergeWorkspace(
  defaults: AltoWorkspaceOptions | false | undefined,
  options: AltoWorkspaceOptions | false | undefined,
): AltoWorkspaceOptions | false | undefined {
  if (options === false || defaults === false) {
    return options ?? defaults;
  }
  return mergeOption(defaults, options);
}

function mergeEvents(defaults: AltoEventOptions | undefined, options: AltoEventOptions | undefined): AltoEventOptions | undefined {
  if (!defaults) {
    return options;
  }
  if (!options) {
    return defaults;
  }
  return {
    ...defaults,
    ...options,
    sinks: [...(defaults.sinks ?? []), ...(options.sinks ?? [])],
  };
}

function getEnvironmentOptions(environment: AltoEnvironmentOptions | Environment | undefined): AltoEnvironmentOptions {
  return isEnvironment(environment) ? {} : (environment ?? {});
}

function normalizeEnvKeyList(value: string[] | string | undefined): string[] {
  return typeof value === "string" ? parseEnvKeyList(value) : (value ?? []);
}

function normalizeRunStatus(exitStatus: unknown): AltoRunStatus {
  if (exitStatus === "Submitted") {
    return "submitted";
  }
  return "completed";
}

function getModelName(model: Model): string {
  const value = model.getTemplateVars().model_name;
  return typeof value === "string" ? value : model.constructor.name || "custom";
}

function isModel(value: unknown): value is Model {
  return Boolean(
    value &&
      typeof value === "object" &&
      "query" in value &&
      typeof value.query === "function" &&
      "formatMessage" in value &&
      typeof value.formatMessage === "function",
  );
}

function isEnvironment(value: unknown): value is Environment {
  return Boolean(value && typeof value === "object" && "execute" in value && typeof value.execute === "function");
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}

class RunTrackingEventSink implements EventSink {
  workspacePath?: string;

  emit(event: AltoEvent): void {
    if (event.type === "workspace_prepared") {
      this.workspacePath = event.path;
    }
  }
}

class FunctionEventSink implements EventSink {
  constructor(readonly onEvent: (event: AltoEvent) => void | Promise<void>) {}

  emit(event: AltoEvent): void | Promise<void> {
    return this.onEvent(event);
  }
}

export type {
  Action,
  AgentRunRequest,
  AgentRunResult,
  Environment,
  ExecutionOutput,
  Message,
  Model,
} from "../core/types.js";
export type { EventSink } from "../runs/events.js";
export type { RunMetadata, RunPaths } from "../runs/metadata.js";

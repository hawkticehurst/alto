import { defaultAgentConfig, type AgentConfig } from "./config.js";
import { NoopEventSink, type AgentEvent, type EventSink } from "../runs/events.js";
import { InterruptAgentFlow } from "./errors.js";
import { FileTranscriptStore, type TranscriptStore } from "../runs/transcript-store.js";
import type { Action, AgentRunRequest, AgentRunResult, Environment, ExecutionOutput, Message, Model } from "./types.js";
import { asArray, recursiveMerge, renderTemplate } from "../utils/index.js";

export class AltoAgent {
  readonly model: Model;
  readonly env: Environment;
  readonly config: AgentConfig;
  readonly eventSink: EventSink;
  readonly transcriptStore?: TranscriptStore;
  messages: Message[] = [];
  extraTemplateVars: Record<string, unknown> = {};
  nCalls = 0;

  constructor(model: Model, env: Environment, config: Partial<AgentConfig> = {}) {
    this.model = model;
    this.env = env;
    this.config = { ...defaultAgentConfig, ...config };
    this.eventSink = this.config.eventSink ?? new NoopEventSink();
    this.transcriptStore = this.config.transcriptStore ?? (this.config.outputPath ? new FileTranscriptStore(this.config.outputPath) : undefined);
  }

  async run(input: string | AgentRunRequest = "", templateVars: Record<string, unknown> = {}): Promise<AgentRunResult> {
    const request = this.normalizeRunRequest(input, templateVars);
    this.nCalls = 0;
    this.messages = [];
    this.extraTemplateVars = { task: request.task, request, ...request.context, ...templateVars };

    await this.emit({ type: "run_started", request });

    try {
      await this.env.prepare?.(request);
      const preparedWorkspace = this.getWorkspacePath();
      if (preparedWorkspace) {
        await this.emit({ type: "workspace_prepared", path: preparedWorkspace });
      }
      this.addMessages(
        this.model.formatMessage({ role: "system", content: this.render(this.config.systemTemplate) }),
        this.model.formatMessage({ role: "user", content: this.formatInitialUserMessage(request) }),
      );

      while (true) {
        try {
          await this.step();
        } catch (error) {
          if (error instanceof InterruptAgentFlow) {
            this.addMessages(...error.messages);
          } else {
            this.handleUncaughtException(error);
            throw error;
          }
        } finally {
          await this.save(this.config.outputPath);
        }

        if (this.messages.at(-1)?.role === "exit") {
          break;
        }
      }

      const result = this.messages.at(-1)?.extra ?? {};
      await this.emit({ type: "run_finished", result });
      return result;
    } catch (error) {
      await this.emit({ type: "run_failed", error: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally {
      await this.save(this.config.outputPath);
      const workspacePath = this.getWorkspacePath();
      const preserveWorkspace = this.getTemplateVars().preserve_workspace === true;
      await this.env.cleanup?.();
      if (workspacePath) {
        await this.emit({ type: preserveWorkspace ? "workspace_preserved" : "workspace_deleted", path: workspacePath });
      }
    }
  }

  async step(): Promise<Message[]> {
    return this.executeActions(await this.query());
  }

  async query(): Promise<Message> {
    const step = this.nCalls + 1;
    await this.emit({ type: "model_call_started", step });
    this.nCalls = step;
    const message = await this.model.query(this.messages);
    this.addMessages(message);
    await this.emit({ type: "model_call_finished", step });
    return message;
  }

  async executeActions(message: Message): Promise<Message[]> {
    const actions = asArray<Action>(message.extra?.actions);
    const outputs: ExecutionOutput[] = [];
    for (const [index, action] of actions.entries()) {
      outputs.push(await this.executeAction(action, index));
    }
    return this.addMessages(...this.model.formatObservationMessages(message, outputs, this.getTemplateVars()));
  }

  addMessages(...messages: Message[]): Message[] {
    this.messages.push(...messages);
    return messages;
  }

  getTemplateVars(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return recursiveMerge(
      this.config as unknown as Record<string, unknown>,
      this.env.getTemplateVars(),
      this.model.getTemplateVars(),
      {
        n_model_calls: this.nCalls,
      },
      this.extraTemplateVars,
      extra,
    );
  }

  serialize(...extraDicts: Array<Record<string, unknown>>): Record<string, unknown> {
    const lastExtra = this.messages.at(-1)?.extra ?? {};
    const { eventSink: _eventSink, transcriptStore: _transcriptStore, ...agentConfig } = this.config;
    return recursiveMerge(
      {
        info: {
          model_stats: {
            api_calls: this.nCalls,
          },
          config: {
            agent: agentConfig,
            agent_type: this.constructor.name,
          },
          alto_version: "0.1.0",
          exit_status: lastExtra.exit_status ?? "",
          submission: lastExtra.submission ?? "",
        },
        messages: this.messages,
        transcript_format: "alto-1.0",
      },
      this.model.serialize(),
      this.env.serialize(),
      ...extraDicts,
    );
  }

  async save(path?: string, ...extraDicts: Array<Record<string, unknown>>): Promise<Record<string, unknown>> {
    const data = this.serialize(...extraDicts);
    const store = path ? new FileTranscriptStore(path) : this.transcriptStore;
    await store?.save(data);
    return data;
  }

  protected async executeAction(action: Action, index: number): Promise<ExecutionOutput> {
    await this.emit({ type: "action_started", action, index });
    try {
      const output = await this.env.execute(action);
      await this.emit({ type: "action_finished", action, index, output });
      return output;
    } catch (error) {
      await this.emit({ type: "action_failed", action, index, error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  protected async emit(event: AgentEvent): Promise<void> {
    await this.eventSink.emit({ ...event, timestamp: Date.now() / 1000 });
  }

  protected render(template: string): string {
    return renderTemplate(template, this.getTemplateVars());
  }

  protected handleUncaughtException(error: unknown): Message[] {
    const message = error instanceof Error ? error.message : String(error);
    return this.addMessages(
      this.model.formatMessage({
        role: "exit",
        content: message,
        extra: {
          exit_status: error instanceof Error ? error.name : "Error",
          submission: "",
          exception_str: message,
          stack: error instanceof Error ? error.stack : undefined,
        },
      }),
    );
  }

  private getWorkspacePath(): string | undefined {
    const workspacePath = this.getTemplateVars().workspace_cwd;
    return typeof workspacePath === "string" ? workspacePath : undefined;
  }

  private normalizeRunRequest(input: string | AgentRunRequest, templateVars: Record<string, unknown>): AgentRunRequest {
    if (typeof input === "string") {
      return { task: input, context: templateVars };
    }
    return input;
  }

  private formatInitialUserMessage(request: AgentRunRequest): string {
    const sections = [`Task: ${request.task}`];
    if (request.context && Object.keys(request.context).length > 0) {
      sections.push(`Context:\n${JSON.stringify(request.context, null, 2)}`);
    }
    return sections.join("\n\n");
  }
}

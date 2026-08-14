import type { AgentEvent, EventSink } from "../runs/events.js";
import type { ExecutionOutput, Message, Model } from "../core/types.js";

export class DeterministicModel implements Model {
  private index = 0;

  constructor(
    readonly messages: Message[] = [
      {
        role: "assistant",
        content: "Submitting.",
        extra: {
          actions: [{ command: "printf 'COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT\\nall done\\n'" }],
        },
      },
    ],
  ) {}

  async query(): Promise<Message> {
    const message = this.messages[Math.min(this.index, this.messages.length - 1)];
    this.index += 1;
    return message;
  }

  formatMessage(message: Message): Message {
    return message;
  }

  formatObservationMessages(_message: Message, outputs: ExecutionOutput[]): Message[] {
    return outputs.map((output) => ({
      role: "user",
      content: output.output,
      extra: { ...output },
    }));
  }

  getTemplateVars(): Record<string, unknown> {
    return { model_name: "deterministic" };
  }

  serialize(): Record<string, unknown> {
    return { info: { config: { model_type: "DeterministicModel" } } };
  }
}

export class InMemoryEventSink implements EventSink {
  readonly events: Array<AgentEvent & { timestamp: number }> = [];

  emit(event: AgentEvent & { timestamp: number }): void {
    this.events.push(event);
  }
}

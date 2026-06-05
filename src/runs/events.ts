import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import type { Action, AgentRunRequest, ExecutionOutput } from "../core/types.js";

export type AgentEvent =
  | { type: "run_started"; request: AgentRunRequest }
  | { type: "run_finished"; result: Record<string, unknown> }
  | { type: "run_failed"; error: string }
  | { type: "workspace_prepared"; path: string }
  | { type: "workspace_deleted"; path: string }
  | { type: "workspace_preserved"; path: string }
  | { type: "model_call_started"; step: number }
  | { type: "model_call_finished"; step: number }
  | { type: "action_started"; action: Action; index: number }
  | { type: "action_finished"; action: Action; index: number; output: ExecutionOutput }
  | { type: "action_failed"; action: Action; index: number; error: string };

export interface EventSink {
  emit(event: AgentEvent & { timestamp: number }): void | Promise<void>;
}

export class NoopEventSink implements EventSink {
  emit(): void {}
}

export class ConsoleEventSink implements EventSink {
  emit(event: AgentEvent & { timestamp: number }): void {
    console.log(JSON.stringify(event));
  }
}

export class TeeEventSink implements EventSink {
  constructor(readonly sinks: EventSink[]) {}

  async emit(event: AgentEvent & { timestamp: number }): Promise<void> {
    await Promise.all(this.sinks.map((sink) => sink.emit(event)));
  }
}

export class JsonLineFileEventSink implements EventSink {
  constructor(readonly path: string) {}

  async emit(event: AgentEvent & { timestamp: number }): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, `${JSON.stringify(event)}\n`, "utf8");
  }
}

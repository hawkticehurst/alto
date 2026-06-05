import { join } from "node:path";

import { runAlto, type AltoRunRequest } from "alto";

import type { CirroConfig } from "../config/index.js";
import type { RunQueue } from "../queue/in-memory.js";
import { normalizeStatusForResult, type RunStore } from "../store/file-store.js";
import { prepareAltoRunRequest } from "./source.js";

export interface CirroWorkerOptions {
  store: RunStore;
  queue: RunQueue;
  config: CirroConfig;
  altoDefaults?: Partial<AltoRunRequest>;
}

export class CirroWorker {
  private running = false;
  private loops: Promise<void>[] = [];

  constructor(readonly options: CirroWorkerOptions) {}

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.loops = Array.from({ length: Math.max(1, this.options.config.workerConcurrency) }, () => this.workLoop());
  }

  async stop(): Promise<void> {
    this.running = false;
    this.options.queue.close();
    await Promise.all(this.loops);
  }

  private async workLoop(): Promise<void> {
    while (this.running) {
      const runId = await this.options.queue.next();
      if (!runId) {
        continue;
      }
      await this.processRun(runId);
    }
  }

  private async processRun(runId: string): Promise<void> {
    const record = await this.options.store.getRun(runId);
    if (!record || record.status !== "queued") {
      return;
    }

    await this.options.store.updateRun(runId, {
      status: "running",
      startedAt: new Date().toISOString(),
    });

    try {
      const paths = this.options.store.pathsFor(runId);
      const request = await prepareAltoRunRequest(record, this.options.config, this.options.altoDefaults);
      const result = await runAlto({
        ...request,
        model: request.model ?? defaultModelConfig(this.options.config),
        output: {
          runId,
          runsRoot: join(this.options.config.dataDir, "runs"),
          transcriptPath: paths.transcriptPath,
          eventsPath: paths.eventsPath,
          writeEvents: true,
          ...request.output,
        },
        events: {
          ...request.events,
          onEvent: async (event) => {
            if (event.type === "workspace_prepared") {
              await this.options.store.updateRun(runId, { workspacePath: event.path });
            }
            await request.events?.onEvent?.(event);
          },
        },
      });

      const latest = await this.options.store.getRun(runId);
      const status = latest?.status === "cancel_requested" ? "cancelled" : normalizeStatusForResult(result.status);
      await this.options.store.updateRun(runId, {
        status,
        endedAt: new Date().toISOString(),
        result,
        error: result.error,
        workspacePath: result.workspacePath ?? latest?.workspacePath,
      });
    } catch (error) {
      const latest = await this.options.store.getRun(runId);
      const status = latest?.status === "cancel_requested" ? "cancelled" : "failed";
      await this.options.store.updateRun(runId, {
        status,
        endedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

function defaultModelConfig(config: CirroConfig): AltoRunRequest["model"] | undefined {
  if (!config.defaultProvider && !config.defaultModel) {
    return undefined;
  }
  return {
    provider: config.defaultProvider,
    name: config.defaultModel,
  };
}

import type { CirroRunRecord, CirroRunRequest, CirroSubmitRunResponse, CirroTriggerMetadata } from "./api/types.js";
import type { CirroConfig } from "./config/index.js";
import type { RunQueue } from "./queue/in-memory.js";
import type { RunStore } from "./store/file-store.js";

export interface CirroServiceOptions {
  config: CirroConfig;
  store: RunStore;
  queue: RunQueue;
}

export class CirroService {
  constructor(readonly options: CirroServiceOptions) {}

  async submitRun(request: CirroRunRequest, trigger?: CirroTriggerMetadata): Promise<CirroSubmitRunResponse> {
    this.validateRunRequest(request);
    if (this.options.queue.size() >= this.options.config.maxQueuedRuns) {
      throw new Error("Run queue is full.");
    }
    const record = await this.options.store.createRun(request, trigger);
    await this.options.queue.enqueue(record.runId);
    return { runId: record.runId, status: record.status };
  }

  async getRun(runId: string): Promise<CirroRunRecord | undefined> {
    return this.options.store.getRun(runId);
  }

  async listRuns(limit?: number): Promise<CirroRunRecord[]> {
    return this.options.store.listRuns(limit);
  }

  async cancelRun(runId: string): Promise<CirroRunRecord> {
    const record = await this.options.store.getRun(runId);
    if (!record) {
      throw new Error(`Run '${runId}' not found.`);
    }

    if (record.status === "queued") {
      await this.options.queue.cancelQueued(runId);
      return this.options.store.updateRun(runId, {
        status: "cancelled",
        endedAt: new Date().toISOString(),
      });
    }

    if (record.status === "running") {
      return this.options.store.updateRun(runId, { status: "cancel_requested" });
    }

    return record;
  }

  private validateRunRequest(request: CirroRunRequest): void {
    if (!request || typeof request !== "object") {
      throw new Error("Run request must be a JSON object.");
    }
    if (typeof request.task !== "string" || request.task.trim().length === 0) {
      throw new Error("Run request must include a non-empty task string.");
    }
  }
}

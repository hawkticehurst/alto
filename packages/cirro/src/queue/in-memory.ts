export interface RunQueue {
  enqueue(runId: string): Promise<void>;
  next(): Promise<string | undefined>;
  cancelQueued(runId: string): Promise<boolean>;
  size(): number;
  close(): void;
}

export class InMemoryRunQueue implements RunQueue {
  private queued: string[] = [];
  private waiters: Array<(runId: string | undefined) => void> = [];
  private closed = false;

  async enqueue(runId: string): Promise<void> {
    if (this.closed) {
      throw new Error("Run queue is closed.");
    }
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(runId);
      return;
    }
    this.queued.push(runId);
  }

  async next(): Promise<string | undefined> {
    const runId = this.queued.shift();
    if (runId || this.closed) {
      return runId;
    }
    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }

  async cancelQueued(runId: string): Promise<boolean> {
    const index = this.queued.indexOf(runId);
    if (index === -1) {
      return false;
    }
    this.queued.splice(index, 1);
    return true;
  }

  size(): number {
    return this.queued.length;
  }

  close(): void {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter(undefined);
    }
  }
}

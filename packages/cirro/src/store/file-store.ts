import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { CirroEvent, CirroRunRecord, CirroRunRequest, CirroRunStatus, CirroTriggerMetadata } from "../api/types.js";

export interface RunStore {
  createRun(request: CirroRunRequest, trigger?: CirroTriggerMetadata): Promise<CirroRunRecord>;
  getRun(runId: string): Promise<CirroRunRecord | undefined>;
  updateRun(runId: string, updates: Partial<Omit<CirroRunRecord, "runId" | "createdAt">>): Promise<CirroRunRecord>;
  listRuns(limit?: number): Promise<CirroRunRecord[]>;
  readEvents(runId: string): Promise<CirroEvent[]>;
  readTranscript(runId: string): Promise<string | undefined>;
  pathsFor(runId: string): CirroRunPaths;
}

export interface CirroRunPaths {
  runDir: string;
  recordPath: string;
  transcriptPath: string;
  eventsPath: string;
}

export class FileRunStore implements RunStore {
  constructor(readonly dataDir: string) {}

  async createRun(request: CirroRunRequest, trigger?: CirroTriggerMetadata): Promise<CirroRunRecord> {
    const runId = createRunId();
    const paths = this.pathsFor(runId);
    const now = new Date().toISOString();
    const record: CirroRunRecord = {
      runId,
      status: "queued",
      request,
      trigger,
      createdAt: now,
      updatedAt: now,
      transcriptPath: paths.transcriptPath,
      eventsPath: paths.eventsPath,
    };
    await this.writeRecord(record);
    return record;
  }

  async getRun(runId: string): Promise<CirroRunRecord | undefined> {
    try {
      return JSON.parse(await readFile(this.pathsFor(runId).recordPath, "utf8")) as CirroRunRecord;
    } catch (error) {
      if (isNotFoundError(error)) {
        return undefined;
      }
      throw error;
    }
  }

  async updateRun(runId: string, updates: Partial<Omit<CirroRunRecord, "runId" | "createdAt">>): Promise<CirroRunRecord> {
    const existing = await this.getRun(runId);
    if (!existing) {
      throw new Error(`Run '${runId}' not found.`);
    }
    const updated: CirroRunRecord = {
      ...existing,
      ...updates,
      updatedAt: new Date().toISOString(),
    };
    await this.writeRecord(updated);
    return updated;
  }

  async listRuns(limit = 50): Promise<CirroRunRecord[]> {
    let entries;
    try {
      entries = await readdir(this.runsDir(), { withFileTypes: true });
    } catch (error) {
      if (isNotFoundError(error)) {
        return [];
      }
      throw error;
    }

    const runs = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => this.getRun(entry.name)),
    );
    return runs
      .filter((run): run is CirroRunRecord => run !== undefined)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }

  async readEvents(runId: string): Promise<CirroEvent[]> {
    try {
      const body = await readFile(this.pathsFor(runId).eventsPath, "utf8");
      return body
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line) as CirroEvent);
    } catch (error) {
      if (isNotFoundError(error)) {
        return [];
      }
      throw error;
    }
  }

  async readTranscript(runId: string): Promise<string | undefined> {
    try {
      return await readFile(this.pathsFor(runId).transcriptPath, "utf8");
    } catch (error) {
      if (isNotFoundError(error)) {
        return undefined;
      }
      throw error;
    }
  }

  pathsFor(runId: string): CirroRunPaths {
    const runDir = join(this.runsDir(), runId);
    return {
      runDir,
      recordPath: join(runDir, "record.json"),
      transcriptPath: join(runDir, "transcript.json"),
      eventsPath: join(runDir, "events.jsonl"),
    };
  }

  private runsDir(): string {
    return join(this.dataDir, "runs");
  }

  private async writeRecord(record: CirroRunRecord): Promise<void> {
    const path = this.pathsFor(record.runId).recordPath;
    await mkdir(dirname(path), { recursive: true });
    const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    await rename(tempPath, path);
  }
}

export function normalizeStatusForResult(status: string): CirroRunStatus {
  if (status === "time_exceeded") {
    return "timed_out";
  }
  if (status === "failed") {
    return "failed";
  }
  return "succeeded";
}

function createRunId(date = new Date()): string {
  const timestamp = date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `${timestamp}-${randomUUID().slice(0, 8)}`;
}

function isNotFoundError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

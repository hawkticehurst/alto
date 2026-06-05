import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { defaultRunsRoot } from "../utils/paths.js";

export interface RunPaths {
  runId: string;
  runDir: string;
  transcriptPath: string;
  metadataPath: string;
  eventsPath: string;
}

export interface RunMetadata {
  runId: string;
  status: "running" | "succeeded" | "failed";
  task: string;
  provider: string;
  model: string;
  startedAt: string;
  endedAt?: string;
  workspacePath?: string;
  transcriptPath: string;
  eventsPath: string;
  stepLimit: number;
  exitStatus?: string;
  error?: string;
}

export function createRunId(date = new Date()): string {
  const timestamp = date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `${timestamp}-${randomUUID().slice(0, 8)}`;
}

export function getRunPaths(runId = createRunId(), root = defaultRunsRoot()): RunPaths {
  const runDir = join(root, runId);
  return {
    runId,
    runDir,
    transcriptPath: join(runDir, "transcript.json"),
    metadataPath: join(runDir, "metadata.json"),
    eventsPath: join(runDir, "events.jsonl"),
  };
}

export async function ensureRunDir(paths: RunPaths): Promise<void> {
  await mkdir(paths.runDir, { recursive: true });
}

export async function writeRunMetadata(paths: RunPaths, metadata: RunMetadata): Promise<void> {
  await ensureRunDir(paths);
  await writeFile(paths.metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
}

export async function readRunMetadata(runId: string, root = defaultRunsRoot()): Promise<RunMetadata | undefined> {
  try {
    return JSON.parse(await readFile(getRunPaths(runId, root).metadataPath, "utf8")) as RunMetadata;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

export async function listRuns(root = defaultRunsRoot()): Promise<RunMetadata[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const runs = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => readRunMetadata(entry.name, root)),
  );
  return runs
    .filter((run): run is RunMetadata => run !== undefined)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

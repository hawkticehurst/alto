import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface CirroConfig {
  host: string;
  port: number;
  dataDir: string;
  apiToken?: string;
  readToken?: string;
  workerConcurrency: number;
  maxQueuedRuns: number;
  allowLocalSources: boolean;
  allowedLocalSourceRoots: string[];
  allowedGitHosts: string[];
  defaultProvider?: "github-copilot" | "openai" | "openrouter";
  defaultModel?: string;
  defaultWorkspaceRoot: string;
  defaultTimeoutMs: number;
}

export function loadCirroConfig(env: NodeJS.ProcessEnv = process.env): CirroConfig {
  const dataDir = resolve(env.CIRRO_DATA_DIR ?? join(homedir(), ".cirro"));
  return {
    host: env.CIRRO_HOST ?? "127.0.0.1",
    port: parseInteger(env.CIRRO_PORT, 3977, "CIRRO_PORT"),
    dataDir,
    apiToken: nonEmpty(env.CIRRO_API_TOKEN),
    readToken: nonEmpty(env.CIRRO_READ_TOKEN),
    workerConcurrency: parseInteger(env.CIRRO_WORKER_CONCURRENCY, 1, "CIRRO_WORKER_CONCURRENCY"),
    maxQueuedRuns: parseInteger(env.CIRRO_MAX_QUEUED_RUNS, 100, "CIRRO_MAX_QUEUED_RUNS"),
    allowLocalSources: env.CIRRO_ALLOW_LOCAL_SOURCES === "true",
    allowedLocalSourceRoots: parseList(env.CIRRO_ALLOWED_LOCAL_SOURCE_ROOTS).map((path) => resolve(path)),
    allowedGitHosts: parseList(env.CIRRO_ALLOWED_GIT_HOSTS).map((host) => host.toLowerCase()),
    defaultProvider: parseProvider(env.CIRRO_ALTO_PROVIDER),
    defaultModel: nonEmpty(env.CIRRO_ALTO_MODEL),
    defaultWorkspaceRoot: resolve(env.CIRRO_WORKSPACE_ROOT ?? join(dataDir, "workspaces")),
    defaultTimeoutMs: parseInteger(env.CIRRO_DEFAULT_TIMEOUT_MS, 30_000, "CIRRO_DEFAULT_TIMEOUT_MS"),
  };
}

function parseInteger(value: string | undefined, fallback: number, name: string): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
  return parsed;
}

function parseProvider(value: string | undefined): "github-copilot" | "openai" | "openrouter" | undefined {
  if (!value) {
    return undefined;
  }
  if (value === "github-copilot" || value === "openai" || value === "openrouter") {
    return value;
  }
  throw new Error("CIRRO_ALTO_PROVIDER must be 'github-copilot', 'openai', or 'openrouter'.");
}

function parseList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

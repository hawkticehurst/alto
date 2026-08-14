import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

import type { AltoRunRequest } from "alto";

import type { CirroRunRecord, CirroSource } from "../api/types.js";
import type { CirroConfig } from "../config/index.js";

export async function prepareAltoRunRequest(
  record: CirroRunRecord,
  config: CirroConfig,
  defaults: Partial<AltoRunRequest> = {},
): Promise<AltoRunRequest> {
  const { source, ...request } = record.request;
  const merged: AltoRunRequest = {
    ...defaults,
    ...request,
    task: request.task,
    context: { ...defaults.context, ...request.context },
    model: mergeOption(defaults.model, request.model),
    limits: {
      timeoutMs: config.defaultTimeoutMs,
      ...defaults.limits,
      ...request.limits,
    },
    environment: mergeOption(defaults.environment, request.environment),
  };

  if (source) {
    const requestWorkspace = plainRecord(request.workspace);
    merged.workspace = {
      ...plainRecord(defaults.workspace),
      ...requestWorkspace,
      sourcePath: await prepareSource(record.runId, source, config),
      root: typeof requestWorkspace?.root === "string" ? requestWorkspace.root : config.defaultWorkspaceRoot,
    };
    return merged;
  }

  const requestWorkspace = plainRecord(request.workspace);
  if (typeof requestWorkspace?.sourcePath === "string") {
    assertAllowedLocalSource(requestWorkspace.sourcePath, config);
    merged.workspace = {
      ...plainRecord(defaults.workspace),
      ...requestWorkspace,
      root: typeof requestWorkspace.root === "string" ? requestWorkspace.root : config.defaultWorkspaceRoot,
    };
    return merged;
  }

  merged.workspace = request.workspace ?? defaults.workspace ?? false;
  return merged;
}

async function prepareSource(runId: string, source: CirroSource, config: CirroConfig): Promise<string> {
  if (source.type === "local") {
    if (!source.path) {
      throw new Error("Local source requires 'path'.");
    }
    assertAllowedLocalSource(source.path, config);
    return resolve(source.path);
  }

  if (!source.repoUrl) {
    throw new Error("Git source requires 'repoUrl'.");
  }
  assertAllowedGitSource(source.repoUrl, config);
  const target = join(config.dataDir, "sources", runId);
  await mkdir(target, { recursive: true });
  await runGit(["clone", "--depth", String(source.checkoutDepth ?? 1), source.repoUrl, target]);
  if (source.ref) {
    await runGit(["-C", target, "checkout", source.ref]);
  }
  return target;
}

function assertAllowedLocalSource(path: string, config: CirroConfig): void {
  if (!config.allowLocalSources) {
    throw new Error("Local sources are disabled. Set CIRRO_ALLOW_LOCAL_SOURCES=true to enable them.");
  }

  const resolved = resolve(path);
  if (config.allowedLocalSourceRoots.length === 0) {
    return;
  }

  const allowed = config.allowedLocalSourceRoots.some((root) => {
    const resolvedRoot = resolve(root);
    return resolved === resolvedRoot || resolved.startsWith(`${resolvedRoot}${sep}`);
  });
  if (!allowed) {
    throw new Error(`Local source '${path}' is outside CIRRO_ALLOWED_LOCAL_SOURCE_ROOTS.`);
  }
}

function assertAllowedGitSource(repoUrl: string, config: CirroConfig): void {
  const url = new URL(repoUrl);
  if (url.protocol !== "https:" && url.protocol !== "ssh:") {
    throw new Error("Git sources must use https:// or ssh:// URLs.");
  }
  if (config.allowedGitHosts.length === 0) {
    return;
  }
  if (!config.allowedGitHosts.includes(url.hostname.toLowerCase())) {
    throw new Error(`Git host '${url.hostname}' is not allowed.`);
  }
}

function runGit(args: string[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("git", args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      output += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolvePromise();
      } else {
        reject(new Error(`git ${args.join(" ")} failed with exit code ${code}:\n${output}`));
      }
    });
  });
}

function mergeOption<T>(defaults: T | undefined, override: T | undefined): T | undefined {
  if (isPlainRecord(defaults) && isPlainRecord(override)) {
    return { ...defaults, ...override } as T;
  }
  return override ?? defaults;
}

function plainRecord(value: unknown): Record<string, unknown> | undefined {
  return isPlainRecord(value) ? value : undefined;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}

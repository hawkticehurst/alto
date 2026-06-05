import { cp, mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import { type EnvironmentConfig } from "../core/config.js";
import { LocalEnvironment } from "./local.js";
import { defaultWorkspaceRoot } from "../utils/paths.js";
import type { AgentRunRequest } from "../core/types.js";

export interface WorkspaceInfo {
  path: string;
  createdAt: string;
  modifiedAt: string;
}

export interface WorkspaceEnvironmentConfig extends EnvironmentConfig {
  sourcePath?: string;
  workspaceRoot?: string;
  preserveWorkspace: boolean;
  setupCommand?: string;
}

export class WorkspaceEnvironment extends LocalEnvironment {
  declare readonly config: WorkspaceEnvironmentConfig;
  private workspacePath?: string;

  constructor(config: Partial<WorkspaceEnvironmentConfig> = {}) {
    super({
      ...config,
      preserveWorkspace: undefined,
      workspaceRoot: undefined,
      sourcePath: undefined,
      setupCommand: undefined,
    } as Partial<EnvironmentConfig>);
    this.config = {
      ...this.config,
      preserveWorkspace: config.preserveWorkspace ?? false,
      workspaceRoot: config.workspaceRoot,
      sourcePath: config.sourcePath,
      setupCommand: config.setupCommand,
    };
  }

  async prepare(request: AgentRunRequest): Promise<void> {
    if (this.workspacePath) {
      return;
    }

    const workspaceRoot = request.workspace?.root
      ? resolve(request.workspace.root)
      : this.config.workspaceRoot
        ? resolve(this.config.workspaceRoot)
        : defaultWorkspaceRoot();
    await mkdir(workspaceRoot, { recursive: true });
    const root = await mkdtemp(join(workspaceRoot, "alto-workspace-"));
    const sourcePath = request.workspace?.sourcePath ?? this.config.sourcePath;
    if (sourcePath) {
      await cp(resolve(sourcePath), root, {
        recursive: true,
        filter: (source) => ![".git", "node_modules", "dist"].includes(basename(source)),
      });
    }

    this.workspacePath = root;
    this.config.cwd = root;
    this.config.preserveWorkspace = request.workspace?.preserve ?? this.config.preserveWorkspace;

    const setupCommand = request.setupCommand ?? this.config.setupCommand;
    if (setupCommand) {
      const output = await super.execute({ command: setupCommand });
      if (output.returncode !== 0) {
        throw new Error(`Workspace setup failed with exit code ${output.returncode}:\n${output.output}`);
      }
    }
  }

  async cleanup(): Promise<void> {
    if (!this.workspacePath || this.config.preserveWorkspace) {
      return;
    }
    await rm(this.workspacePath, { recursive: true, force: true });
  }

  override getTemplateVars(): Record<string, unknown> {
    return {
      ...super.getTemplateVars(),
      workspace_cwd: this.workspacePath,
      source_path: this.config.sourcePath,
      preserve_workspace: this.config.preserveWorkspace,
    };
  }

  override serialize(): Record<string, unknown> {
    const redactedAgentEnv = Object.fromEntries(Object.keys(this.config.agentEnv).map((key) => [key, "[redacted]"]));
    return {
      info: {
        config: {
          environment: {
            ...this.config,
            agentEnv: redactedAgentEnv,
            workspace_cwd: this.workspacePath,
            source_path: this.config.sourcePath,
            preserve_workspace: this.config.preserveWorkspace,
          },
          environment_type: "WorkspaceEnvironment",
        },
      },
    };
  }
}

export async function listWorkspaces(root = defaultWorkspaceRoot()): Promise<WorkspaceInfo[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const workspaces = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("alto-workspace-"))
      .map(async (entry) => {
        const path = join(root, entry.name);
        const info = await stat(path);
        return {
          path,
          createdAt: info.birthtime.toISOString(),
          modifiedAt: info.mtime.toISOString(),
        };
      }),
  );
  return workspaces.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function cleanWorkspaces(root = defaultWorkspaceRoot()): Promise<WorkspaceInfo[]> {
  const workspaces = await listWorkspaces(root);
  await Promise.all(workspaces.map((workspace) => rm(workspace.path, { recursive: true, force: true })));
  return workspaces;
}

import { homedir } from "node:os";
import { join } from "node:path";

export function altoHome(): string {
  return join(homedir(), ".alto");
}

export function defaultWorkspaceRoot(): string {
  return join(altoHome(), "workspaces");
}

export function defaultCredentialsRoot(): string {
  return join(altoHome(), "credentials");
}

export function defaultRunsRoot(): string {
  return join(altoHome(), "runs");
}

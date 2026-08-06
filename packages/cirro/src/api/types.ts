import type { AltoEvent, AltoRunRequest, AltoRunResult } from "alto";

export type CirroRunStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancel_requested"
  | "cancelled"
  | "timed_out";

export interface CirroSource {
  type: "local" | "git";
  path?: string;
  repoUrl?: string;
  ref?: string;
  checkoutDepth?: number;
}

export interface CirroRunRequest extends AltoRunRequest {
  source?: CirroSource;
}

export interface CirroRunRecord {
  runId: string;
  status: CirroRunStatus;
  request: CirroRunRequest;
  trigger?: CirroTriggerMetadata;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  endedAt?: string;
  error?: string;
  result?: AltoRunResult;
  workspacePath?: string;
  transcriptPath: string;
  eventsPath: string;
}

export interface CirroTriggerMetadata {
  type: "manual";
  actor?: string;
  source?: string;
  raw?: Record<string, unknown>;
}

export interface CirroSubmitRunResponse {
  runId: string;
  status: CirroRunStatus;
}

export type CirroEvent = AltoEvent & { timestamp: number };

export function isTerminalRunStatus(status: CirroRunStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled" || status === "timed_out";
}

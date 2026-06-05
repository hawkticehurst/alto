import type { CirroRunRequest, CirroTriggerMetadata } from "../api/types.js";

export interface TriggerSubmission {
  request: CirroRunRequest;
  trigger: CirroTriggerMetadata;
}

export interface CronTriggerConfig {
  name: string;
  task: string;
  schedule: string;
  source?: CirroRunRequest["source"];
  context?: Record<string, unknown>;
}

export function submissionFromCron(config: CronTriggerConfig): TriggerSubmission {
  return {
    request: {
      task: config.task,
      source: config.source,
      context: {
        ...config.context,
        cron: { name: config.name, schedule: config.schedule },
      },
    },
    trigger: {
      type: "cron",
      source: config.name,
      raw: { schedule: config.schedule },
    },
  };
}

export function submissionFromGitHubIssueComment(payload: Record<string, unknown>, commandPrefix = "/alto"): TriggerSubmission | undefined {
  const comment = payload.comment;
  const repository = payload.repository;
  if (!isRecord(comment) || !isRecord(repository)) {
    return undefined;
  }

  const body = typeof comment.body === "string" ? comment.body.trim() : "";
  if (!body.startsWith(commandPrefix)) {
    return undefined;
  }

  const task = body.slice(commandPrefix.length).trim();
  if (!task) {
    return undefined;
  }

  const cloneUrl = typeof repository.clone_url === "string" ? repository.clone_url : undefined;
  const fullName = typeof repository.full_name === "string" ? repository.full_name : undefined;
  const actor = isRecord(comment.user) && typeof comment.user.login === "string" ? comment.user.login : undefined;

  return {
    request: {
      task,
      source: cloneUrl ? { type: "git", repoUrl: cloneUrl } : undefined,
      context: {
        github: {
          repository: fullName,
          commentUrl: comment.html_url,
        },
      },
    },
    trigger: {
      type: "webhook",
      actor,
      source: "github.issue_comment",
      raw: { repository: fullName },
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

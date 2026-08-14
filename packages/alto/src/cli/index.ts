#!/usr/bin/env node
import { Command } from "commander";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import { deleteGitHubCopilotCredentials, getGitHubAuthStatus, loginWithGitHubCopilot } from "../auth/github.js";
import { listRuns } from "../runs/metadata.js";
import { cleanWorkspaces, listWorkspaces } from "../environments/workspace.js";
import { buildCliRunRequest, executeRun, type CliOptions } from "./run.js";

const program = new Command();

program
  .name("alto")
  .description("A tiny coding agent meant for the cloud.")
  .option("-t, --task <task>", "Task/problem statement")
  .option("-m, --model <model>", "OpenAI-compatible model name")
  .option("--provider <provider>", "Model provider: github-copilot or openai", process.env.ALTO_PROVIDER ?? "github-copilot")
  .option("--cwd <path>", "Source directory for the workspace")
  .option("-o, --output <path>", "Path to save the transcript JSON")
  .option("--run-id <id>", "Run ID; defaults to a generated timestamp ID")
  .option("--timeout <ms>", "Shell command timeout in milliseconds", "30000")
  .option("--base-url <url>", "OpenAI-compatible base URL; defaults to OPENAI_BASE_URL")
  .option("--exit-immediately", "Do not confirm when the agent submits")
  .option("--no-workspace", "Run directly in --cwd instead of creating an isolated local workspace")
  .option("--workspace-root <path>", "Directory where temporary Alto workspaces are created")
  .option("--preserve-workspace", "Do not delete the temporary workspace after the run")
  .option("--agent-env-file <path>", "Agent-scoped env file", ".env.alto.agent")
  .option("--agent-env <keys>", "Comma-separated env keys from --agent-env-file to expose to shell commands")
  .option("--events", "Emit structured lifecycle events as JSON")
  .action(async (options: CliOptions) => {
    const task = options.task ?? (await promptTask());
    await executeRun(options, buildCliRunRequest(task, options), { interactive: true });
  });

program
  .command("auth <action>")
  .description("Manage Alto authentication")
  .option("--enterprise-url <url>", "GitHub Enterprise URL/domain for Copilot auth")
  .option("--no-open-browser", "Print the GitHub login URL instead of opening it")
  .action(
    async (
      action: string,
      options: {
        enterpriseUrl?: string;
        openBrowser?: boolean;
      },
    ) => {
      await handleAuthAction(action, options);
    },
  );

program
  .command("workspaces <action>")
  .description("Manage Alto workspaces")
  .option("--workspace-root <path>", "Workspace root to inspect or clean")
  .action(async (action: string, options: { workspaceRoot?: string }) => {
    if (action === "list") {
      const workspaces = await listWorkspaces(options.workspaceRoot);
      if (workspaces.length === 0) {
        console.log("No Alto workspaces found.");
        return;
      }
      for (const workspace of workspaces) {
        console.log(`${workspace.path}\tcreated=${workspace.createdAt}\tmodified=${workspace.modifiedAt}`);
      }
      return;
    }
    if (action === "clean") {
      const workspaces = await cleanWorkspaces(options.workspaceRoot);
      console.log(`Deleted ${workspaces.length} Alto workspace${workspaces.length === 1 ? "" : "s"}.`);
      return;
    }
    throw new Error(`Unknown workspaces action '${action}'. Expected 'list' or 'clean'.`);
  });

program
  .command("runs <action> [runId]")
  .description("Inspect Alto runs")
  .action(async (action: string, runId?: string) => {
    if (action === "list") {
      const runs = await listRuns();
      if (runs.length === 0) {
        console.log("No Alto runs found.");
        return;
      }
      for (const run of runs) {
        console.log(`${run.runId}\t${run.status}\t${run.provider}/${run.model}\t${run.startedAt}\t${run.task}`);
      }
      return;
    }
    if (action === "show") {
      if (!runId) {
        throw new Error("Missing run ID.");
      }
      const run = (await listRuns()).find((candidate) => candidate.runId === runId);
      if (!run) {
        throw new Error(`Run '${runId}' not found.`);
      }
      console.log(JSON.stringify(run, null, 2));
      return;
    }
    throw new Error(`Unknown runs action '${action}'. Expected 'list' or 'show'.`);
  });

async function handleAuthAction(
  action: string,
  options: {
    enterpriseUrl?: string;
    openBrowser?: boolean;
  },
): Promise<void> {
  if (action === "status") {
    const status = await getGitHubAuthStatus("github-copilot");
    console.log(`${status.provider}: ${status.authenticated ? "authenticated" : "not authenticated"}`);
    return;
  }

  if (action === "logout") {
    await deleteGitHubCopilotCredentials();
    console.log("Removed github-copilot credentials.");
    return;
  }

  if (action !== "login") {
    throw new Error(`Unknown auth action '${action}'. Expected 'login', 'status', or 'logout'.`);
  }

  await loginWithGitHubCopilot({
    enterpriseUrl: options.enterpriseUrl,
    openBrowser: options.openBrowser,
  });
  console.log("Saved GitHub Copilot credentials.");
}

async function promptTask(): Promise<string> {
  const rl = createInterface({ input, output });
  try {
    return await rl.question("What do you want to do?\n> ");
  } finally {
    rl.close();
  }
}

program.parseAsync().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

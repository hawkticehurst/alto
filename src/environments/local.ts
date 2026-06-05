import { spawn } from "node:child_process";
import os from "node:os";
import process from "node:process";

import { defaultEnvironmentConfig, getSystemTemplateVars, type EnvironmentConfig } from "../core/config.js";
import { Submitted } from "../core/errors.js";
import type { Action, Environment, ExecutionOutput } from "../core/types.js";

export class LocalEnvironment implements Environment {
  readonly config: EnvironmentConfig;

  constructor(config: Partial<EnvironmentConfig> = {}) {
    this.config = {
      ...defaultEnvironmentConfig,
      ...config,
      env: { ...defaultEnvironmentConfig.env, ...config.env },
      agentEnv: { ...defaultEnvironmentConfig.agentEnv, ...config.agentEnv },
      inheritEnv: config.inheritEnv ?? defaultEnvironmentConfig.inheritEnv,
    };
  }

  async execute(action: Action): Promise<ExecutionOutput> {
    const command = action.command ?? "";
    const cwd = this.config.cwd || process.cwd();
    const env = this.buildEnv();

    const output = await new Promise<ExecutionOutput>((resolve) => {
      const child = spawn("/bin/bash", ["-lc", command], {
        cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let combined = "";
      let settled = false;
      const timer = setTimeout(() => {
        settled = true;
        child.kill("SIGTERM");
        resolve({
          output: combined,
          returncode: -1,
          exception_info: `Command timed out after ${this.config.timeoutMs}ms`,
          extra: { exception_type: "Timeout" },
        });
      }, this.config.timeoutMs);

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        combined += chunk;
      });
      child.stderr.on("data", (chunk: string) => {
        combined += chunk;
      });

      child.on("error", (error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve({
          output: combined,
          returncode: -1,
          exception_info: `An error occurred while executing the command: ${error.message}`,
          extra: { exception_type: error.name, exception: error.message },
        });
      });

      child.on("close", (code, signal) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve({
          output: combined,
          returncode: code ?? -1,
          exception_info: signal ? `Command terminated by signal ${signal}` : "",
        });
      });
    });

    this.checkFinished(output);
    return output;
  }

  getTemplateVars(): Record<string, unknown> {
    return {
      ...this.config,
      cwd: this.config.cwd || process.cwd(),
      ...getSystemTemplateVars(),
      platform: os.platform(),
      arch: os.arch(),
      agent_env_keys: Object.keys(this.config.agentEnv),
    };
  }

  serialize(): Record<string, unknown> {
    const redactedAgentEnv = Object.fromEntries(Object.keys(this.config.agentEnv).map((key) => [key, "[redacted]"]));
    return {
      info: {
        config: {
          environment: {
            ...this.config,
            agentEnv: redactedAgentEnv,
          },
          environment_type: "LocalEnvironment",
        },
      },
    };
  }

  protected buildEnv(): NodeJS.ProcessEnv {
    const inherited = Object.fromEntries(
      this.config.inheritEnv.flatMap((key) => {
        const value = process.env[key];
        return value === undefined ? [] : [[key, value]];
      }),
    );
    return { ...inherited, ...this.config.env, ...this.config.agentEnv };
  }

  protected checkFinished(output: ExecutionOutput): void {
    const lines = output.output.trimStart().split(/\r?\n/);
    if (output.returncode === 0 && lines[0]?.trim() === "COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT") {
      const submission = lines.slice(1).join("\n");
      throw new Submitted({
        role: "exit",
        content: submission,
        extra: { exit_status: "Submitted", submission },
      });
    }
  }
}

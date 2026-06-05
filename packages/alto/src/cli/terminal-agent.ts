import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import { AltoAgent } from "../core/agent.js";
import { defaultInteractiveAgentConfig, type InteractiveAgentConfig } from "../core/config.js";
import { Submitted, UserInterruption } from "../core/errors.js";
import type { Action, Environment, ExecutionOutput, Message, Model } from "../core/types.js";
import { asArray } from "../utils/index.js";

export class InteractiveAgent extends AltoAgent {
  declare readonly config: InteractiveAgentConfig;
  private readonly rl = createInterface({ input, output });

  constructor(model: Model, env: Environment, config: Partial<InteractiveAgentConfig> = {}) {
    super(model, env, { ...defaultInteractiveAgentConfig, ...config });
  }

  override async query(): Promise<Message> {
    console.log("\nWaiting for the model...");
    return super.query();
  }

  override async executeActions(message: Message): Promise<Message[]> {
    const actions = asArray<Action>(message.extra?.actions);
    const outputs: ExecutionOutput[] = [];
    try {
      for (const [index, action] of actions.entries()) {
        outputs.push(await this.executeAction(action, index));
      }
    } catch (error) {
      if (error instanceof Submitted) {
        await this.checkForNewTaskOrSubmit(error);
      }
      throw error;
    } finally {
      if (outputs.length > 0 || actions.length > 0) {
        this.addMessages(...this.model.formatObservationMessages(message, outputs, this.getTemplateVars()));
      }
    }

    return [];
  }

  override addMessages(...messages: Message[]): Message[] {
    for (const message of messages) {
      if (message.role === "assistant") {
        console.log(`\nalto (step ${this.nCalls}, $${this.cost.toFixed(2)}):`);
      } else {
        console.log(`\n${String(message.role).toUpperCase()}:`);
      }
      if (message.content) {
        console.log(message.content);
      }
      const actions = asArray<Action>(message.extra?.actions);
      for (const action of actions) {
        console.log(`\n$ ${action.command}`);
      }
    }

    return super.addMessages(...messages);
  }

  close(): void {
    this.rl.close();
  }

  private async checkForNewTaskOrSubmit(error: Submitted): Promise<never> {
    if (this.config.confirmExit) {
      const answer = await this.prompt("Agent wants to finish. Enter to quit, or type a new task/comment\n> ");
      if (answer) {
        throw new UserInterruption({
          role: "user",
          content: `The user added a new task: ${answer}`,
          extra: { interrupt_type: "UserNewTask" },
        });
      }
    }
    throw error;
  }

  private prompt(query: string): Promise<string> {
    return this.rl.question(query);
  }
}

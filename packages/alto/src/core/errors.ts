import type { Message } from "./types.js";

export class InterruptAgentFlow extends Error {
  readonly messages: Message[];

  constructor(...messages: Message[]) {
    super("Agent flow interrupted");
    this.name = new.target.name;
    this.messages = messages;
  }
}

export class Submitted extends InterruptAgentFlow {}

export class LimitsExceeded extends InterruptAgentFlow {}

export class TimeExceeded extends LimitsExceeded {}

export class UserInterruption extends InterruptAgentFlow {}

export class FormatError extends InterruptAgentFlow {}

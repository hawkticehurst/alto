import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { parse } from "dotenv";

const SECRET_KEY_PATTERN = /(key|token|secret|password|credential)/i;

export async function loadAgentEnv(path = ".env.alto.agent"): Promise<Record<string, string>> {
  try {
    return parse(await readFile(resolve(path), "utf8"));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

export function pickEnv(env: Record<string, string>, keys: string[]): Record<string, string> {
  return Object.fromEntries(keys.flatMap((key) => (key in env ? [[key, env[key]]] : [])));
}

export function parseEnvKeyList(value?: string): string[] {
  return value
    ? value
        .split(",")
        .map((key) => key.trim())
        .filter(Boolean)
    : [];
}

export function redactEnv(env: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(env).map(([key, value]) => [key, SECRET_KEY_PATTERN.test(key) ? "[redacted]" : value]));
}
